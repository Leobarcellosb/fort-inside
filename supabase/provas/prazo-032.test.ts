// PROVA DO PRAZO RIGIDO v2 (migration 032) contra Postgres DESCARTAVEL.
//
// Como rodar (container proprio, criado e removido pelo script):
//   bash supabase/provas/rodar-032.sh
// Ou, com um banco local ja preparado (001..031 sem a 028, mais a 032):
//   PRAZO_PROVA_URL="postgresql://postgres:SENHA@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config supabase/provas/vitest.prova.config.ts --reporter=verbose
//
// Sem PRAZO_PROVA_URL o arquivo e PULADO, para `npx vitest run` continuar verde
// em maquina sem banco. GUARDA DE ALVO: so 127.0.0.1, localhost ou [::1], e
// nunca a porta 54732 (banco local compartilhado do projeto).
//
// COMO O RELOGIO E CONTROLADO. As policies usam `now()`, que no Postgres e o
// instante de INICIO da transacao e fica constante ate o fim dela. Cada cenario
// roda numa transacao so, desfeita no fim (rollback), e move `form_closes_at`
// RELATIVO a esse now(): `now() + 1 microssegundo` e exatamente "um
// microssegundo antes do prazo"; `now()` e exatamente "no prazo". Nao ha
// sleep nem relogio do Node na decisao. Os cenarios de processamento (023)
// usam clock_timestamp() e pg_stat_activity, entao esses gravam de verdade
// (ids aleatorios por execucao) e nao dependem de transacao aberta.
//
// QUEM BATE NA PORTA. O participante e `authenticated` com o claim que o
// PostgREST poria (`request.jwt.claims` com `sub`), o servidor e `service_role`
// com `{"role":"service_role"}`. Nunca superusuario: uma prova feita como
// postgres mediria outra coisa.
//
// ANTES E DEPOIS NO MESMO BANCO. Para provar que a janela de 15 minutos existia
// (e que e a 032 que a fecha), alguns cenarios rodam a reversao
// (docs/aplicar/032-reverter.sql) DENTRO da transacao, medem, e o rollback
// devolve a 032. Sem essa metade a prova nao distinguiria "a trava funciona" de
// "isto nunca foi possivel".

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { prazoDoFormulario } from "../../app/api/formulario-publico/receber-formulario";

const executar = promisify(execFile);
const URL_ALVO = process.env.PRAZO_PROVA_URL;
const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-prazo-032-")) : "";

function exigirLocal(url: string): void {
  const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(`PRAZO_PROVA_URL nao e local (host=${u.hostname}). A prova escreve: abortando.`);
  }
  if (u.port === "54732") {
    throw new Error("PRAZO_PROVA_URL aponta para a porta 54732, o banco local compartilhado. Use um container proprio.");
  }
}
if (URL_ALVO) exigirLocal(URL_ALVO);

// ---------------------------------------------------------------------------
// SQL dos arquivos de verdade: a migration e a reversao, sem begin/commit para
// poderem rodar DENTRO da transacao do cenario (um `commit` ali comitaria o
// cenario inteiro).
// ---------------------------------------------------------------------------
const semTransacao = (texto: string) =>
  texto
    .split("\n")
    .filter((l) => !/^\s*(begin|commit);\s*$/i.test(l))
    .join("\n");
const MIGRATION_032 = semTransacao(
  readFileSync(new URL("../migrations/032_prazo_rigido_v2.sql", import.meta.url), "utf8"),
);
const REVERTER_032 = semTransacao(
  readFileSync(new URL("../../docs/aplicar/032-reverter.sql", import.meta.url), "utf8"),
);

// ---------------------------------------------------------------------------
// psql
// ---------------------------------------------------------------------------
async function psqlArquivo(texto: string): Promise<string> {
  const arquivo = join(TRABALHO, `c-${randomUUID()}.sql`);
  writeFileSync(arquivo, texto, "utf8");
  const { stdout } = await executar(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo],
    {
      env: { ...process.env, PGCONNECT_TIMEOUT: "30", LC_ALL: "C", LANG: "C" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90_000,
      killSignal: "SIGKILL",
    },
  );
  return stdout.trim();
}

interface Resultado {
  rotulo: string;
  estado: "OK" | "ERRO" | "VALOR";
  n: number | null;
  cod: string | null;
  msg: string | null;
}

// Harness: cada sonda roda num sub-bloco com excecao (savepoint), entao um erro
// NUNCA aborta o cenario. Sonda que deu certo PERSISTE dentro da transacao
// (fluxos em varias etapas), e o rollback final desfaz tudo.
const PRELUDIO = String.raw`
begin;
\o /dev/null
create temp table r (ordem serial, rotulo text, estado text, n bigint, cod text, msg text) on commit drop;

create function pg_temp.como(p_rotulo text, p_papel text, p_claims text, p_sql text)
returns void language plpgsql as $f$
declare v_n bigint; v_cod text; v_msg text; v_estado text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  -- A imagem descartavel traz o auth.uid() antigo, que le request.jwt.claim.sub;
  -- o Supabase de hoje le request.jwt.claims->>'sub' (com fallback para o antigo).
  -- Os dois ajustes juntos valem para as duas definicoes.
  perform set_config('request.jwt.claim.sub', coalesce(nullif(p_claims, '')::jsonb ->> 'sub', ''), true);
  execute format('set local role %I', p_papel);
  begin
    execute p_sql;
    get diagnostics v_n = row_count;
    v_estado := 'OK';
  exception when others then
    get stacked diagnostics v_cod = returned_sqlstate, v_msg = message_text;
    v_estado := 'ERRO';
    v_n := null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  insert into r (rotulo, estado, n, cod, msg) values (p_rotulo, v_estado, v_n, v_cod, v_msg);
end $f$;

create function pg_temp.valor(p_rotulo text, p_sql text)
returns void language plpgsql as $f$
declare v text;
begin
  execute p_sql into v;
  insert into r (rotulo, estado, msg) values (p_rotulo, 'VALOR', v);
end $f$;
`;

const FINAL = String.raw`
\o
select coalesce(json_agg(json_build_object('rotulo', rotulo, 'estado', estado, 'n', n, 'cod', cod, 'msg', msg) order by ordem), '[]')::text from r;
rollback;
`;

async function cenario(corpo: string): Promise<Map<string, Resultado>> {
  const saida = await psqlArquivo(`${PRELUDIO}\n${SEMENTE}\n${corpo}\n${FINAL}`);
  const linhas = JSON.parse(saida.split("\n").pop() || "[]") as Resultado[];
  const mapa = new Map<string, Resultado>();
  for (const l of linhas) {
    if (mapa.has(l.rotulo)) throw new Error(`rotulo repetido no cenario: ${l.rotulo}`);
    mapa.set(l.rotulo, l);
  }
  return mapa;
}

function pega(m: Map<string, Resultado>, rotulo: string): Resultado {
  const r = m.get(rotulo);
  if (!r) throw new Error(`sonda ausente: ${rotulo}`);
  return r;
}
/** A escrita PASSOU e afetou exatamente n linhas. */
function exigeGravou(m: Map<string, Resultado>, rotulo: string, n = 1): void {
  const r = pega(m, rotulo);
  expect(r, `${rotulo}: ${r.estado} ${r.cod ?? ""} ${r.msg ?? ""}`).toMatchObject({ estado: "OK", n });
}
/** Recusa de AUTORIZACAO (42501: RLS ou privilegio). Outro erro nao prova nada. */
function exigeNegado42501(m: Map<string, Resultado>, rotulo: string): void {
  const r = pega(m, rotulo);
  expect(r, `${rotulo}: ${r.estado} n=${r.n} ${r.cod ?? ""} ${r.msg ?? ""}`).toMatchObject({ estado: "ERRO", cod: "42501" });
}
/** A RLS filtrou a linha: o comando rodou e afetou ZERO linhas. */
function exigeZeroLinhas(m: Map<string, Resultado>, rotulo: string): void {
  const r = pega(m, rotulo);
  expect(r, `${rotulo}: ${r.estado} ${r.cod ?? ""} ${r.msg ?? ""}`).toMatchObject({ estado: "OK", n: 0 });
}
function valor(m: Map<string, Resultado>, rotulo: string): string | null {
  const r = pega(m, rotulo);
  expect(r.estado).toBe("VALOR");
  return r.msg;
}

// ---------------------------------------------------------------------------
// Massa fixa, inserida como postgres DENTRO da transacao do cenario.
// ---------------------------------------------------------------------------
const id = (sufixo: string) => `00000000-0000-4000-8000-${sufixo.padStart(12, "0")}`;

const U = { A: id("a1"), B: id("b1"), C: id("c1"), D: id("d1"), ADM: id("ad") };
const EV = {
  V2: id("e21"), // async v2, o caso Marco Zero: prazo movido por cenario
  V2B: id("e22"), // async v2 ABERTO (prazo amanha): o "outro evento"
  V2N: id("e2a"), // async v2 SEM form_closes_at
  V1: id("e11"), // live v1, etapa 2 liberada
  A1: id("ea1"), // async v1 (tolerancia legada)
  L2: id("e12"), // live v2, etapa 1 liberada
};
const P = {
  A: id("a21"), // A no V2
  A2B: id("a22"), // A no V2B (mesma conta, outro evento)
  AN: id("a2a"), // A no V2N
  B: id("b21"), // B no V2
  B2B: id("b22"), // B no V2B
  C: id("c11"), // C no V1 (live v1)
  CL: id("c12"), // C no L2 (live v2)
  D: id("d11"), // D no A1 (async v1)
};

const SEMENTE = `
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('${U.A}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@prazo-032.test', '{}', '{}', now(), now()),
  ('${U.B}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@prazo-032.test', '{}', '{}', now(), now()),
  ('${U.C}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@prazo-032.test', '{}', '{}', now(), now()),
  ('${U.D}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'd@prazo-032.test', '{}', '{}', now(), now()),
  ('${U.ADM}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'adm@prazo-032.test', '{"role":"admin"}', '{}', now(), now());

insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at) values
  ('${EV.V2}',  'Prazo 032 v2',        'P032-V2',  now(), 'live', 0, 2, 'async', now() - interval '7 days', now() + interval '1 hour'),
  ('${EV.V2B}', 'Prazo 032 v2 aberto', 'P032-V2B', now(), 'live', 0, 2, 'async', now() - interval '7 days', now() + interval '1 day'),
  ('${EV.V2N}', 'Prazo 032 v2 sem T',  'P032-V2N', now(), 'live', 0, 2, 'async', now() - interval '7 days', null),
  ('${EV.V1}',  'Prazo 032 live v1',   'P032-V1',  now(), 'live', 2, 1, 'live',  null, null),
  ('${EV.A1}',  'Prazo 032 async v1',  'P032-A1',  now(), 'live', 0, 1, 'async', now() - interval '7 days', now() + interval '1 hour'),
  ('${EV.L2}',  'Prazo 032 live v2',   'P032-L2',  now(), 'live', 1, 2, 'live',  null, null);

insert into public.participants (id, event_id, user_id, full_name, email) values
  ('${P.A}',   '${EV.V2}',  '${U.A}', 'Participante A',    'a@prazo-032.test'),
  ('${P.A2B}', '${EV.V2B}', '${U.A}', 'Participante A',    'a@prazo-032.test'),
  ('${P.AN}',  '${EV.V2N}', '${U.A}', 'Participante A',    'a@prazo-032.test'),
  ('${P.B}',   '${EV.V2}',  '${U.B}', 'Participante B',    'b@prazo-032.test'),
  ('${P.B2B}', '${EV.V2B}', '${U.B}', 'Participante B',    'b@prazo-032.test'),
  ('${P.C}',   '${EV.V1}',  '${U.C}', 'Participante C',    'c@prazo-032.test'),
  ('${P.CL}',  '${EV.L2}',  '${U.C}', 'Participante C',    'c@prazo-032.test'),
  ('${P.D}',   '${EV.A1}',  '${U.D}', 'Participante D',    'd@prazo-032.test');

-- B ja respondeu a etapa 101 do evento aberto (segredo que A nao pode tocar).
insert into public.quiz_responses (participant_id, stage_id, answers)
values ('${P.B2B}', 101, '{"q1":"segredo-de-B"}');
`;

const claims = (uid: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    role: "authenticated",
    aud: "authenticated",
    sub: uid,
    app_metadata: {},
    user_metadata: {},
    ...extra,
  });
const SERVICO = JSON.stringify({ role: "service_role" });

/** Fora do harness: os mesmos dois ajustes de claim que pg_temp.como faz (ver la). */
const claimsLocais = (uid: string) =>
  `select (set_config('request.jwt.claims', '${claims(uid)}', true) || set_config('request.jwt.claim.sub', '${uid}', true)) is not null as claims_ok \\gset`;

const q = (s: string) => `$q$${s}$q$`;
const como = (rotulo: string, papel: string, cl: string, sql: string) =>
  `select pg_temp.como('${rotulo}', '${papel}', '${cl}', ${q(sql)});`;
const comoUsuario = (rotulo: string, uid: string, sql: string) => como(rotulo, "authenticated", claims(uid), sql);
const comoServico = (rotulo: string, sql: string) => como(rotulo, "service_role", SERVICO, sql);
const ler = (rotulo: string, sql: string) => `select pg_temp.valor('${rotulo}', ${q(sql)});`;

/** Muda o prazo (como postgres, que e o painel do admin) relativo ao now() da transacao. */
const prazo = (ev: string, expr: string) => `update public.events set form_closes_at = ${expr} where id = '${ev}';`;

/** Abre a etapa PELO CAMINHO DE VERDADE: INSERT do participante, julgado pela policy da 010. */
const abrir = (rotulo: string, uid: string, pid: string, ev: string, stage: number, versao: number) =>
  comoUsuario(
    rotulo,
    uid,
    `insert into public.participant_stage_sessions (event_id, participant_id, stage_id, quiz_version) values ('${ev}', '${pid}', ${stage}, ${versao})`,
  );

const inserir = (pid: string, stage: number, resposta: string) =>
  `insert into public.quiz_responses (participant_id, stage_id, answers) values ('${pid}', ${stage}, '{"q":"${resposta}"}')`;
/** O upsert do aplicativo (app/(participant)/quiz/[stageId]/page.tsx): onConflict participant_id,stage_id. */
const upsert = (pid: string, stage: number, resposta: string) =>
  `${inserir(pid, stage, resposta)} on conflict (participant_id, stage_id) do update set answers = excluded.answers`;
const reescrever = (pid: string, stage: number, resposta: string) =>
  `update public.quiz_responses set answers = '{"q":"${resposta}"}' where participant_id = '${pid}' and stage_id = ${stage}`;

/** Recua o started_at da sessao (como postgres): a sessao foi aberta 2 horas antes de agora. */
const sessaoAntesDoPrazo = (pid: string, stage: number) =>
  `update public.participant_stage_sessions set started_at = now() - interval '2 hours' where participant_id = '${pid}' and stage_id = ${stage};`;

// ---------------------------------------------------------------------------
// Execucao com AUTOCOMMIT, para o que usa clock_timestamp()/pg_stat_activity.
// ---------------------------------------------------------------------------
async function sql(texto: string): Promise<string> {
  return psqlArquivo(texto);
}

descreve("032: prazo rigido do formulario v2 no banco", () => {
  beforeAll(async () => {
    const ok = await sql(
      `select count(*) from pg_policies where schemaname = 'public' and policyname like '%prazo_rigido%';`,
    );
    if (ok !== "3") {
      throw new Error(`o banco da prova nao tem a 032 aplicada (policies prazo_rigido = ${ok}). Rode supabase/provas/rodar-032.sh.`);
    }
  });

  // =========================================================================
  // CRITERIO 1: inventario, medido no catalogo (o que existe e o que a 032 pos)
  // =========================================================================
  describe("criterio 1: inventario das escritas autorizadas", () => {
    it("as policies de escrita vigentes sao exatamente as do inventario (permissivas da 002..029 + 3 restritivas da 032)", async () => {
      const saida = await sql(`
        select string_agg(tablename || ':' || policyname || ':' || permissive || ':' || cmd, E'\\n' order by tablename, policyname)
          from pg_policies
         where schemaname = 'public' and cmd <> 'SELECT'
           and tablename in ('quiz_responses', 'participants', 'participant_stage_sessions', 'events', 'participant_scores', 'prognostics', 'event_logs');`);
      expect(saida.split("\n")).toEqual([
        "event_logs:event_logs_admin:PERMISSIVE:ALL",
        "events:events_admin_write:PERMISSIVE:ALL",
        "participant_scores:participant_scores_admin:PERMISSIVE:ALL",
        "participant_stage_sessions:participant_stage_sessions_admin:PERMISSIVE:ALL",
        "participant_stage_sessions:participant_stage_sessions_own_open:PERMISSIVE:INSERT",
        "participants:participants_admin_delete:PERMISSIVE:DELETE",
        "participants:participants_own_insert:PERMISSIVE:INSERT",
        "participants:participants_own_update:PERMISSIVE:UPDATE",
        "participants:participants_prazo_rigido_insert:RESTRICTIVE:INSERT",
        "prognostics:prognostics_admin_write:PERMISSIVE:ALL",
        "quiz_responses:quiz_responses_own_insert:PERMISSIVE:INSERT",
        "quiz_responses:quiz_responses_own_update:PERMISSIVE:UPDATE",
        "quiz_responses:quiz_responses_prazo_rigido_insert:RESTRICTIVE:INSERT",
        "quiz_responses:quiz_responses_prazo_rigido_update:RESTRICTIVE:UPDATE",
      ]);
    });

    it("a 032 so ACRESCENTA policies restritivas: nenhuma permissiva nova, nenhuma permissiva alterada", async () => {
      const saida = await sql(`
        select count(*) filter (where permissive = 'RESTRICTIVE') || '|' ||
               count(*) filter (where permissive = 'RESTRICTIVE' and policyname like '%prazo_rigido%') || '|' ||
               (select with_check like '%00:15:00%' from pg_policies where policyname = 'quiz_responses_own_insert') || '|' ||
               (select with_check like '%00:15:00%' from pg_policies where policyname = 'quiz_responses_own_update')
          from pg_policies where schemaname = 'public';`);
      // 3 restritivas no banco inteiro, as 3 da 032; e as permissivas da 010
      // continuam com a tolerancia de 15 minutos no texto (v1 intocado).
      expect(saida).toBe("3|3|true|true");
    });

    it("privilegios de escrita do participante (authenticated) por coluna: sessao sem started_at, cadastro sem event_id no UPDATE", async () => {
      const saida = await sql(`
        select string_agg(table_name || '.' || privilege_type || '=' || cols, ' ; ' order by table_name, privilege_type) from (
          select table_name, privilege_type, string_agg(column_name, ',' order by column_name) as cols
            from information_schema.column_privileges
           where grantee = 'authenticated' and table_schema = 'public'
             and table_name in ('participants', 'participant_stage_sessions')
             and privilege_type in ('INSERT', 'UPDATE')
           group by 1, 2) x;`);
      expect(saida).toBe(
        "participant_stage_sessions.INSERT=event_id,participant_id,quiz_version,stage_id ; " +
          "participants.INSERT=completed_at,course_or_moment,email,event_id,full_name,id,joined_at,phone,user_id ; " +
          "participants.UPDATE=course_or_moment,full_name,phone",
      );
    });

    it("a migration e idempotente: reaplicar dentro de uma transacao nao falha e nao duplica nada", async () => {
      const m = await cenario(`
        ${MIGRATION_032}
        ${MIGRATION_032}
        ${ler("n", "select count(*)::text from pg_policies where policyname like '%prazo_rigido%'")}
      `);
      expect(valor(m, "n")).toBe("3");
    });
  });

  // =========================================================================
  // CRITERIO 2 e 4: o instante exato, a janela antiga, a sessao aberta antes
  // =========================================================================
  describe("criterio 2 e 4: o prazo e o primeiro instante recusado, pelo relogio do banco", () => {
    it("um microssegundo ANTES do prazo grava; NO prazo recusa (INSERT, UPDATE e upsert)", async () => {
      const m = await cenario(`
        ${abrir("abre-101", U.A, P.A, EV.V2, 101, 2)}
        ${abrir("abre-102", U.A, P.A, EV.V2, 102, 2)}
        ${abrir("abre-103", U.A, P.A, EV.V2, 103, 2)}
        ${prazo(EV.V2, "now() + interval '1 microsecond'")}
        ${comoUsuario("antes-insert", U.A, inserir(P.A, 101, "um-us-antes"))}
        ${comoUsuario("antes-update", U.A, reescrever(P.A, 101, "um-us-antes-2"))}
        ${comoUsuario("antes-upsert", U.A, upsert(P.A, 102, "um-us-antes-upsert"))}
        ${prazo(EV.V2, "now()")}
        ${comoUsuario("no-prazo-insert", U.A, inserir(P.A, 103, "no-prazo"))}
        ${comoUsuario("no-prazo-update", U.A, reescrever(P.A, 101, "no-prazo"))}
        ${comoUsuario("no-prazo-upsert", U.A, upsert(P.A, 102, "no-prazo"))}
        ${ler("final-101", `select answers->>'q' from public.quiz_responses where participant_id = '${P.A}' and stage_id = 101`)}
        ${ler("final-102", `select answers->>'q' from public.quiz_responses where participant_id = '${P.A}' and stage_id = 102`)}
        ${ler("final-103", `select count(*)::text from public.quiz_responses where participant_id = '${P.A}' and stage_id = 103`)}
      `);
      for (const r of ["abre-101", "abre-102", "abre-103", "antes-insert", "antes-update", "antes-upsert"]) exigeGravou(m, r);
      exigeNegado42501(m, "no-prazo-insert");
      exigeZeroLinhas(m, "no-prazo-update");
      exigeNegado42501(m, "no-prazo-upsert");
      expect(valor(m, "final-101")).toBe("um-us-antes-2");
      expect(valor(m, "final-102")).toBe("um-us-antes-upsert");
      expect(valor(m, "final-103")).toBe("0");
    });

    it("a fronteira e a mesma do formulario publico: prazoDoFormulario recusa no prazo e aceita 1 ms antes", () => {
      const fecha = "2026-10-24T03:00:00.000Z";
      const t = Date.parse(fecha);
      expect(prazoDoFormulario(fecha, new Date(t - 1))).toBe("aberto");
      expect(prazoDoFormulario(fecha, new Date(t))).toBe("encerrado");
    });

    it("a antiga janela de 15 minutos: ANTES da 032 gravava ate T+15; DEPOIS da 032 recusa ja em T+1us, T+5min, T+14min59s e T+15min", async () => {
      const passos: [string, string][] = [
        ["t1us", "now() - interval '1 microsecond'"],
        ["t5min", "now() - interval '5 minutes'"],
        ["t14m59s", "now() - interval '14 minutes 59 seconds'"],
        ["t15min", "now() - interval '15 minutes'"],
      ];
      const etapas = [101, 102, 103, 104];
      const corpo = (fase: "antes" | "depois") =>
        passos
          .map(
            ([rot, expr], i) => `
          ${prazo(EV.V2, expr)}
          ${comoUsuario(`${fase}-${rot}`, U.A, inserir(P.A, etapas[i], `${fase}-${rot}`))}`,
          )
          .join("\n");

      const m = await cenario(`
        ${[101, 102, 103, 104, 105].map((s) => abrir(`abre-${s}`, U.A, P.A, EV.V2, s, 2)).join("\n")}
        ${[101, 102, 103, 104, 105].map((s) => sessaoAntesDoPrazo(P.A, s)).join("\n")}

        -- DEPOIS da 032 (estado do banco da prova)
        ${corpo("depois")}

        -- ANTES da 032: reverte DENTRO da transacao e mede a janela antiga.
        ${REVERTER_032}
        ${corpo("antes")}
        ${prazo(EV.V2, "now() - interval '15 minutes 1 microsecond'")}
        ${comoUsuario("antes-t15min1us", U.A, inserir(P.A, 105, "antes-t15min1us"))}
      `);
      for (const [rot] of passos) {
        exigeNegado42501(m, `depois-${rot}`);
        exigeGravou(m, `antes-${rot}`);
      }
      // A fronteira antiga era inclusiva em T+15 e fechava 1 us depois.
      exigeNegado42501(m, "antes-t15min1us");
    });

    it("sessao autenticada aberta ANTES do prazo (pela policy, 2h antes): conclui na reta final, e a partir de T nao grava, nao reescreve e nao reabre", async () => {
      const m = await cenario(`
        ${abrir("abre-101", U.A, P.A, EV.V2, 101, 2)}
        ${abrir("abre-102", U.A, P.A, EV.V2, 102, 2)}
        ${sessaoAntesDoPrazo(P.A, 101)}
        ${sessaoAntesDoPrazo(P.A, 102)}

        -- Reta final (T-10min): nao abre etapa nova, mas conclui a que abriu.
        ${prazo(EV.V2, "now() + interval '10 minutes'")}
        ${abrir("reta-final-abre-103", U.A, P.A, EV.V2, 103, 2)}
        ${comoUsuario("reta-final-envia-101", U.A, upsert(P.A, 101, "reta-final"))}

        -- Prazo passou ha 1 minuto: a sessao existe, foi aberta antes, e nao basta mais.
        ${prazo(EV.V2, "now() - interval '1 minute'")}
        ${ler("sessao-102-existe", `select count(*)::text from public.participant_stage_sessions where participant_id = '${P.A}' and stage_id = 102 and started_at < (select form_closes_at from public.events where id = '${EV.V2}')`)}
        ${comoUsuario("pos-prazo-envia-102", U.A, upsert(P.A, 102, "pos-prazo"))}
        ${comoUsuario("pos-prazo-reescreve-101", U.A, reescrever(P.A, 101, "pos-prazo"))}
        ${comoUsuario("pos-prazo-upsert-101", U.A, upsert(P.A, 101, "pos-prazo"))}
        ${abrir("pos-prazo-abre-104", U.A, P.A, EV.V2, 104, 2)}
        ${ler("final-101", `select answers->>'q' from public.quiz_responses where participant_id = '${P.A}' and stage_id = 101`)}
        ${ler("final-102", `select count(*)::text from public.quiz_responses where participant_id = '${P.A}' and stage_id = 102`)}
      `);
      exigeGravou(m, "abre-101");
      exigeGravou(m, "abre-102");
      exigeNegado42501(m, "reta-final-abre-103");
      exigeGravou(m, "reta-final-envia-101");
      expect(valor(m, "sessao-102-existe")).toBe("1");
      exigeNegado42501(m, "pos-prazo-envia-102");
      exigeZeroLinhas(m, "pos-prazo-reescreve-101");
      exigeNegado42501(m, "pos-prazo-upsert-101");
      exigeNegado42501(m, "pos-prazo-abre-104");
      expect(valor(m, "final-101")).toBe("reta-final");
      expect(valor(m, "final-102")).toBe("0");
    });

    it("horarios enviados pelo cliente nao mudam nada: submitted_at, started_at, prazo do evento, claims inventados e fuso", async () => {
      const m = await cenario(`
        ${abrir("abre-101", U.A, P.A, EV.V2, 101, 2)}
        ${prazo(EV.V2, "now() - interval '1 minute'")}

        -- submitted_at no passado: a policy nao le essa coluna.
        ${comoUsuario("submitted-at-passado", U.A, `insert into public.quiz_responses (participant_id, stage_id, answers, submitted_at) values ('${P.A}', 101, '{"q":"x"}', now() - interval '1 day')`)}
        -- started_at informado na abertura: sem privilegio de coluna.
        ${comoUsuario("started-at-no-insert", U.A, `insert into public.participant_stage_sessions (event_id, participant_id, stage_id, quiz_version, started_at) values ('${EV.V2}', '${P.A}', 105, 2, now() - interval '1 day')`)}
        -- recuar o started_at da propria sessao: sem UPDATE.
        ${comoUsuario("started-at-no-update", U.A, `update public.participant_stage_sessions set started_at = now() - interval '1 day' where participant_id = '${P.A}'`)}
        -- apagar a sessao para abrir outra: sem DELETE.
        ${comoUsuario("apaga-sessao", U.A, `delete from public.participant_stage_sessions where participant_id = '${P.A}'`)}
        -- empurrar o prazo do proprio evento: RLS de events (so admin escreve).
        ${comoUsuario("adia-prazo", U.A, `update public.events set form_closes_at = now() + interval '1 day' where id = '${EV.V2}'`)}
        -- claims com horarios e papel inventados (iat/exp no futuro, "now", role de admin em user_metadata).
        ${como("claims-inventados", "authenticated", claims(U.A, { iat: 4102444800, exp: 4102444800, now: "2000-01-01T00:00:00Z", user_metadata: { role: "admin" } }), inserir(P.A, 101, "claims"))}
        -- fuso da sessao: timestamptz e absoluto.
        set local timezone = 'Pacific/Kiritimati';
        ${comoUsuario("fuso-trocado", U.A, inserir(P.A, 101, "fuso"))}
        reset timezone;

        ${ler("prazo-intacto", `select (form_closes_at < now())::text from public.events where id = '${EV.V2}'`)}
        ${ler("respostas-101", `select count(*)::text from public.quiz_responses where participant_id = '${P.A}'`)}
      `);
      exigeGravou(m, "abre-101");
      exigeNegado42501(m, "submitted-at-passado");
      exigeNegado42501(m, "started-at-no-insert");
      exigeNegado42501(m, "started-at-no-update");
      exigeNegado42501(m, "apaga-sessao");
      exigeZeroLinhas(m, "adia-prazo");
      exigeNegado42501(m, "claims-inventados");
      exigeNegado42501(m, "fuso-trocado");
      expect(valor(m, "prazo-intacto")).toBe("true");
      expect(valor(m, "respostas-101")).toBe("0");
    });

    it("relogio real (sem transacao do cenario): prazo comitado 5 min atras, o participante recusado numa transacao nova", async () => {
      const run = randomUUID().slice(0, 8);
      const ev = randomUUID();
      const uid = randomUUID();
      const pid = randomUUID();
      await sql(`
        insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values ('${uid}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r-${run}@prazo-032.test', '{}', '{}', now(), now());
        insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
        values ('${ev}', 'Prazo 032 relogio real', 'P032-R-${run}', now(), 'live', 0, 2, 'async', now() - interval '1 day', now() + interval '1 hour');
        insert into public.participants (id, event_id, user_id, full_name, email) values ('${pid}', '${ev}', '${uid}', 'R', 'r-${run}@prazo-032.test');
      `);
      // Abre a etapa de verdade, com o prazo 1h a frente, numa transacao comitada.
      await sql(`
        begin;
        set local role authenticated;
        ${claimsLocais(uid)}
        insert into public.participant_stage_sessions (event_id, participant_id, stage_id, quiz_version) values ('${ev}', '${pid}', 101, 2);
        commit;`);
      await sql(`update public.events set form_closes_at = clock_timestamp() - interval '5 minutes' where id = '${ev}';`);
      const tentativa = await sql(`
        \\set VERBOSITY verbose
        begin;
        set local role authenticated;
        ${claimsLocais(uid)}
        insert into public.quiz_responses (participant_id, stage_id, answers) values ('${pid}', 101, '{"q":"tarde"}');
        commit;`).then(
        () => "gravou",
        (e: { stderr?: string }) => e.stderr ?? "erro",
      );
      // 42501 = insufficient_privilege: a recusa e de AUTORIZACAO (RLS), nao outro erro.
      expect(tentativa).toMatch(/ERROR:\s+42501/);
      expect(await sql(`select count(*) from public.quiz_responses where participant_id = '${pid}';`)).toBe("0");
    });
  });

  // =========================================================================
  // CRITERIO 3: v1 e live intocados; v2 nao reabre nada
  // =========================================================================
  describe("criterio 3: comportamento legitimo do v1 preservado", () => {
    it("live v1: etapa liberada grava, etapa nao liberada nao, e form_closes_at no passado NAO afeta o ao vivo", async () => {
      const m = await cenario(`
        ${comoUsuario("v1-etapa-1", U.C, inserir(P.C, 1, "v1"))}
        ${comoUsuario("v1-etapa-3-nao-liberada", U.C, inserir(P.C, 3, "v1"))}
        ${prazo(EV.V1, "now() - interval '1 day'")}
        ${comoUsuario("v1-etapa-2-com-prazo-vencido", U.C, inserir(P.C, 2, "v1"))}
        ${comoUsuario("v1-reenvia-etapa-1", U.C, upsert(P.C, 1, "v1-corrigida"))}
      `);
      exigeGravou(m, "v1-etapa-1");
      exigeNegado42501(m, "v1-etapa-3-nao-liberada");
      exigeGravou(m, "v1-etapa-2-com-prazo-vencido");
      exigeGravou(m, "v1-reenvia-etapa-1");
    });

    it("async v1: a tolerancia legada da 010 continua (grava em T+5min e em T+15min, recusa em T+15min+1us)", async () => {
      const m = await cenario(`
        ${[1, 2, 3].map((s) => abrir(`abre-${s}`, U.D, P.D, EV.A1, s, 1)).join("\n")}
        ${prazo(EV.A1, "now() - interval '5 minutes'")}
        ${comoUsuario("a1-t5min", U.D, inserir(P.D, 1, "a1"))}
        ${prazo(EV.A1, "now() - interval '15 minutes'")}
        ${comoUsuario("a1-t15min", U.D, inserir(P.D, 2, "a1"))}
        ${prazo(EV.A1, "now() - interval '15 minutes 1 microsecond'")}
        ${comoUsuario("a1-t15min1us", U.D, inserir(P.D, 3, "a1"))}
      `);
      for (const s of [1, 2, 3]) exigeGravou(m, `abre-${s}`);
      exigeGravou(m, "a1-t5min");
      exigeGravou(m, "a1-t15min");
      exigeNegado42501(m, "a1-t15min1us");
    });

    it("live v2 segue current_stage (prazo nao se aplica ao ao vivo) e async v2 SEM prazo segue como na 010", async () => {
      const m = await cenario(`
        ${prazo(EV.L2, "now() - interval '1 day'")}
        ${comoUsuario("l2-etapa-1", U.C, inserir(P.CL, 101, "l2"))}
        ${comoUsuario("l2-etapa-2-nao-liberada", U.C, inserir(P.CL, 102, "l2"))}
        ${abrir("v2n-abre", U.A, P.AN, EV.V2N, 101, 2)}
        ${comoUsuario("v2n-envia", U.A, inserir(P.AN, 101, "v2n"))}
      `);
      exigeGravou(m, "l2-etapa-1");
      exigeNegado42501(m, "l2-etapa-2-nao-liberada");
      exigeGravou(m, "v2n-abre");
      exigeGravou(m, "v2n-envia");
    });

    it("v2 dentro do prazo continua funcionando (abre, envia, corrige)", async () => {
      const m = await cenario(`
        ${abrir("abre", U.A, P.A, EV.V2, 101, 2)}
        ${comoUsuario("envia", U.A, upsert(P.A, 101, "v1"))}
        ${comoUsuario("corrige", U.A, upsert(P.A, 101, "v2"))}
      `);
      exigeGravou(m, "abre");
      exigeGravou(m, "envia");
      exigeGravou(m, "corrige");
    });
  });

  // =========================================================================
  // CRITERIO 5: resposta alheia e outro evento
  // =========================================================================
  describe("criterio 5: ninguem altera resposta alheia nem usa a policy para gravar em outro evento", () => {
    it("A nao insere, nao reescreve, nao faz upsert e nao apaga a resposta de B", async () => {
      const m = await cenario(`
        ${abrir("a-abre-v2b-102", U.A, P.A2B, EV.V2B, 102, 2)}
        ${comoUsuario("a-grava-propria", U.A, inserir(P.A2B, 102, "propria"))}
        ${comoUsuario("insere-como-b", U.A, inserir(P.B2B, 102, "forjada"))}
        ${comoUsuario("reescreve-b", U.A, reescrever(P.B2B, 101, "forjada"))}
        ${comoUsuario("upsert-em-b", U.A, upsert(P.B2B, 101, "forjada"))}
        ${comoUsuario("apaga-b", U.A, `delete from public.quiz_responses where participant_id = '${P.B2B}'`)}
        ${comoUsuario("apaga-propria", U.A, `delete from public.quiz_responses where participant_id = '${P.A2B}'`)}
        ${comoUsuario("rouba-linha-de-b", U.A, `update public.quiz_responses set participant_id = '${P.A2B}' where participant_id = '${P.B2B}'`)}
        ${ler("b-intacta", `select answers->>'q1' from public.quiz_responses where participant_id = '${P.B2B}' and stage_id = 101`)}
        ${comoServico("controle-servico-apaga-b", `delete from public.quiz_responses where participant_id = '${P.B2B}'`)}
      `);
      exigeGravou(m, "a-abre-v2b-102");
      exigeGravou(m, "a-grava-propria");
      exigeNegado42501(m, "insere-como-b");
      exigeZeroLinhas(m, "reescreve-b");
      exigeNegado42501(m, "upsert-em-b");
      exigeZeroLinhas(m, "apaga-b");
      exigeZeroLinhas(m, "apaga-propria");
      exigeZeroLinhas(m, "rouba-linha-de-b");
      expect(valor(m, "b-intacta")).toBe("segredo-de-B");
      // Controle positivo: a linha existe e e apagavel por quem pode (o zero acima nao e tabela vazia).
      exigeGravou(m, "controle-servico-apaga-b");
    });

    it("A nao abre etapa em evento alheio, nao muda o proprio event_id e nao abre sessao em nome de B", async () => {
      const m = await cenario(`
        ${abrir("sessao-evento-trocado", U.A, P.A2B, EV.V2, 101, 2)}
        ${abrir("sessao-em-nome-de-b", U.A, P.B2B, EV.V2B, 103, 2)}
        ${comoUsuario("muda-event-id", U.A, `update public.participants set event_id = '${EV.V2B}' where id = '${P.A}'`)}
        ${comoUsuario("versao-errada", U.A, `insert into public.participant_stage_sessions (event_id, participant_id, stage_id, quiz_version) values ('${EV.V2B}', '${P.A2B}', 1, 1)`)}
      `);
      exigeNegado42501(m, "sessao-evento-trocado");
      exigeNegado42501(m, "sessao-em-nome-de-b");
      exigeNegado42501(m, "muda-event-id");
      exigeNegado42501(m, "versao-errada");
    });

    it("tirar uma resposta do evento ENCERRADO para o cadastro de outro evento: antes da 032 passava, depois nao", async () => {
      const m = await cenario(`
        ${abrir("abre-v2-101", U.A, P.A, EV.V2, 101, 2)}
        ${comoUsuario("grava-v2-101", U.A, inserir(P.A, 101, "do-evento-encerrado"))}
        ${abrir("abre-v2b-101", U.A, P.A2B, EV.V2B, 101, 2)}
        ${prazo(EV.V2, "now() - interval '1 minute'")}
        ${comoUsuario("depois-move", U.A, `update public.quiz_responses set participant_id = '${P.A2B}' where participant_id = '${P.A}' and stage_id = 101`)}
        ${ler("depois-continua-no-v2", `select count(*)::text from public.quiz_responses where participant_id = '${P.A}' and stage_id = 101`)}
        ${REVERTER_032}
        ${comoUsuario("antes-move", U.A, `update public.quiz_responses set participant_id = '${P.A2B}' where participant_id = '${P.A}' and stage_id = 101`)}
      `);
      exigeGravou(m, "grava-v2-101");
      exigeGravou(m, "abre-v2b-101");
      exigeZeroLinhas(m, "depois-move");
      expect(valor(m, "depois-continua-no-v2")).toBe("1");
      exigeGravou(m, "antes-move");
    });

    it("autocadastro no evento v2 ENCERRADO (participants_own_insert): antes da 032 passava, inclusive com completed_at; depois nao", async () => {
      const novo = (email: string) =>
        `insert into public.participants (event_id, user_id, full_name, email, completed_at) values ('${EV.V2}', '${U.A}', 'Intruso', '${email}', now())`;
      const m = await cenario(`
        ${prazo(EV.V2, "now() - interval '1 minute'")}
        ${comoUsuario("depois-autocadastro", U.A, novo("x1@prazo-032.test"))}
        ${comoServico("servico-cadastra-depois", `insert into public.participants (event_id, full_name, email) values ('${EV.V2}', 'Regularizado', 'x2@prazo-032.test')`)}
        ${REVERTER_032}
        ${comoUsuario("antes-autocadastro", U.A, novo("x3@prazo-032.test"))}
      `);
      exigeNegado42501(m, "depois-autocadastro");
      exigeGravou(m, "servico-cadastra-depois");
      exigeGravou(m, "antes-autocadastro");
    });

    it("ACHADO (fora do escopo da 032): ANTES do prazo, um usuario autenticado ainda se cadastra sozinho em evento alheio, com completed_at", async () => {
      // Registra o estado medido. Se alguem fechar isto (ver docs/PRAZO-RIGIDO-032.md,
      // achados), este teste passa a falhar e o plano deve ser atualizado.
      const m = await cenario(`
        ${comoUsuario("autocadastro-evento-aberto", U.C, `insert into public.participants (event_id, user_id, full_name, email, completed_at) values ('${EV.V2B}', '${U.C}', 'C de fora', 'c@prazo-032.test', now())`)}
      `);
      exigeGravou(m, "autocadastro-evento-aberto");
    });

    it("as funcoes de importacao executaveis por authenticated falham FECHADAS para o participante (privilegio das tabelas externas)", async () => {
      const plano = JSON.stringify({
        ok: true,
        evento_id: EV.V2B,
        quiz_version: 2,
        questionario_impressao: "a".repeat(64),
        operador: { id: U.A, email: "a@prazo-032.test" },
        origem: { formulario_id: "f", formulario_nome: "f" },
        submissoes: [{ submissao_id: "s1", estado: "importavel", participant_id: P.A2B, apto_para_pontuar: true, itens: [] }],
      });
      const m = await cenario(`
        ${comoUsuario("aplicar", U.A, `select public.importacao_externa_aplicar('${plano}'::jsonb)`)}
        ${comoUsuario("revogar", U.A, `select public.importacao_externa_revogar('${randomUUID()}', '${U.A}', 'tentativa do participante')`)}
      `);
      exigeNegado42501(m, "aplicar");
      exigeNegado42501(m, "revogar");
    });
  });

  // =========================================================================
  // CRITERIO 6: service_role e processamento nao sao afetados
  // =========================================================================
  describe("criterio 6: escrita interna autorizada (service_role) e processamento", () => {
    it("catalogo: service_role e o dono das tabelas ignoram RLS; sem FORCE; definers que escrevem sao do dono", async () => {
      const saida = await sql(`
        select
          (select rolbypassrls from pg_roles where rolname = 'service_role')::text || '|' ||
          (select relforcerowsecurity from pg_class where oid = 'public.quiz_responses'::regclass)::text || '|' ||
          (select relforcerowsecurity from pg_class where oid = 'public.participants'::regclass)::text || '|' ||
          (select pg_get_userbyid(relowner) from pg_class where oid = 'public.quiz_responses'::regclass) || '|' ||
          (select rolbypassrls from pg_roles where rolname = (select pg_get_userbyid(relowner) from pg_class where oid = 'public.quiz_responses'::regclass))::text || '|' ||
          (select string_agg(distinct pg_get_userbyid(p.proowner), ',') from pg_proc p
             where p.proname in ('marcar_sessao_de_etapa_enviada', 'jobs_iniciar_assincrono', 'formulario_publico_regularizar',
                                 'formulario_publico_desconsiderar', 'formulario_publico_confirmar_destinatario') and p.prosecdef);`);
      expect(saida).toBe("true|false|false|postgres|true|postgres");
    });

    it("depois do prazo, service_role grava e corrige resposta, cadastra e conclui (formulario publico, importacao, regularizacao, /api/complete-quiz)", async () => {
      const m = await cenario(`
        ${abrir("abre-101", U.A, P.A, EV.V2, 101, 2)}
        ${prazo(EV.V2, "now() - interval '1 minute'")}
        ${comoServico("servico-insere", inserir(P.A, 101, "servidor"))}
        ${comoServico("servico-upsert", upsert(P.A, 101, "servidor-2"))}
        ${comoServico("servico-update", reescrever(P.A, 101, "servidor-3"))}
        ${comoServico("servico-conclui", `update public.participants set completed_at = now() where id = '${P.A}'`)}
        ${comoServico("servico-cadastra", `insert into public.participants (event_id, full_name, email) values ('${EV.V2}', 'Novo pelo servidor', 'n@prazo-032.test')`)}
        ${ler("sessao-marcada", `select status from public.participant_stage_sessions where participant_id = '${P.A}' and stage_id = 101`)}
        ${como("admin-le", "authenticated", claims(U.ADM, { app_metadata: { role: "admin" } }), `select * from public.quiz_responses where participant_id = '${P.A}'`)}
        ${comoServico("servico-le", `select * from public.quiz_responses where participant_id = '${P.A}'`)}
        ${ler("final", `select answers->>'q' from public.quiz_responses where participant_id = '${P.A}' and stage_id = 101`)}
      `);
      for (const r of ["abre-101", "servico-insere", "servico-upsert", "servico-update", "servico-conclui", "servico-cadastra", "admin-le", "servico-le"]) {
        exigeGravou(m, r);
      }
      // O gatilho SECURITY DEFINER da 010 continua fechando a sessao.
      expect(valor(m, "sessao-marcada")).toBe("submitted");
      expect(valor(m, "final")).toBe("servidor-3");
    });

    it("as tres policies da 032 ficam so em quiz_responses e participants (prognostics, participant_scores, jobs e cia. intocados)", async () => {
      const saida = await sql(`
        select string_agg(tablename || ':' || policyname, ',' order by policyname)
          from pg_policies where schemaname = 'public' and policyname like '%prazo_rigido%';`);
      expect(saida).toBe(
        "participants:participants_prazo_rigido_insert,quiz_responses:quiz_responses_prazo_rigido_insert,quiz_responses:quiz_responses_prazo_rigido_update",
      );
    });
  });

  // =========================================================================
  // CRITERIO 6 e 7: o inicio do processamento (023) com o relogio real
  // =========================================================================
  describe("criterio 6 e 7: o inicio do processamento continua esperando T+15 e processa", () => {
    it("T+5min: escrita do participante ja recusada, mas jobs_iniciar_assincrono ainda diz coleta_aberta ate T+15; depois de T+15 enfileira todos", async () => {
      const run = randomUUID().slice(0, 8);
      const ev = randomUUID();
      const uid = randomUUID();
      const pids = [randomUUID(), randomUUID()];
      const respostas = pids
        .flatMap((p) => [101, 102, 103, 104, 105].map((s) => `('${p}', ${s}, '{"q":"ok"}')`))
        .join(", ");
      await sql(`
        insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values ('${uid}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'j-${run}@prazo-032.test', '{}', '{}', now(), now());
        insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
        values ('${ev}', 'Prazo 032 processamento', 'P032-J-${run}', now(), 'live', 0, 2, 'async', now() - interval '1 day', clock_timestamp() - interval '5 minutes');
        insert into public.participants (id, event_id, user_id, full_name, email, completed_at) values
          ('${pids[0]}', '${ev}', '${uid}', 'J0', 'j-${run}@prazo-032.test', now() - interval '10 minutes'),
          ('${pids[1]}', '${ev}', null, 'J1', 'j1-${run}@prazo-032.test', now() - interval '10 minutes');
        insert into public.quiz_responses (participant_id, stage_id, answers) values ${respostas};
        insert into public.participant_stage_sessions (event_id, participant_id, stage_id, quiz_version, started_at)
        values ('${ev}', '${pids[0]}', 101, 2, now() - interval '1 hour');
      `);

      const comoServicoSql = (chamada: string) => `
        begin;
        set local role service_role;
        select set_config('request.jwt.claims', '${SERVICO}', true);
        ${chamada}
        commit;`;
      const iniciar = async () => {
        const saida = await sql(comoServicoSql(`select public.jobs_iniciar_assincrono('${ev}'::uuid)::text;`));
        return JSON.parse(saida.split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}") as Record<string, unknown>;
      };

      // T+5min: a escrita do participante (relogio real, transacao nova, com sessao
      // aberta 1h antes) ja e recusada pela 032. Na 010 sozinha ela passaria.
      expect(await sql(`select count(*) from public.quiz_responses where participant_id = '${pids[0]}';`)).toBe("5");
      const contagem = await sql(`
        begin;
        set local role authenticated;
        ${claimsLocais(uid)}
        with u as (
          update public.quiz_responses set answers = '{"q":"tarde"}'
           where participant_id = '${pids[0]}' and stage_id = 101
          returning 1)
        select 'linhas=' || count(*) from u;
        commit;`);
      expect(contagem).toBe("linhas=0");
      expect(await sql(`select answers->>'q' from public.quiz_responses where participant_id = '${pids[0]}' and stage_id = 101;`)).toBe("ok");

      // ...e mesmo assim o inicio do processamento ESPERA: a 032 nao mexe na espera de 15 min.
      const cedo = await iniciar();
      expect(cedo.ok).toBe(false);
      expect(cedo.motivo).toBe("coleta_aberta");
      const limite = Date.parse(String(cedo.limite));
      const encerra = Date.parse(String(cedo.encerra_em));
      expect(limite - encerra).toBe(15 * 60 * 1000);

      // A assinatura da 023 continua com o default de 900 s.
      expect(
        await sql(`select pg_get_function_arguments('public.jobs_iniciar_assincrono(uuid, text, int, int, boolean)'::regprocedure) like '%p_tolerancia_segundos integer DEFAULT 900%';`),
      ).toBe("t");

      // Depois de T+15 (prazo movido para 16 min atras): processa os dois, sem perder ninguem.
      await sql(`update public.events set form_closes_at = clock_timestamp() - interval '16 minutes' where id = '${ev}';`);
      let pronto: Record<string, unknown> = {};
      for (let i = 0; i < 5; i++) {
        pronto = await iniciar();
        if (pronto.motivo !== "snapshot_instavel") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(pronto).toMatchObject({ ok: true, total: 2, criados: 2 });
      expect(await sql(`select count(*) from public.jobs where event_id = '${ev}';`)).toBe("2");
    });
  });
});
