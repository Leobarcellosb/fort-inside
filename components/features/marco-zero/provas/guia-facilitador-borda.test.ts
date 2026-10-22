// PROVA DA BORDA do Guia de Preparacao do Facilitador: a ROTA DE VERDADE
// (app/api/marco-zero/guia-facilitador), com a funcao `marco_zero_cobertura` de
// verdade, contra Postgres de verdade.
//
// Como rodar:
//   PROVA_GUIA_URL="postgresql://postgres:SENHA@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config components/features/marco-zero/provas/vitest.prova.config.ts \
//       --reporter=verbose
//
// Sem PROVA_GUIA_URL o arquivo e PULADO, para `npx vitest run` continuar verde
// em maquina sem banco. GUARDA DE ALVO: a URL tem de ser 127.0.0.1, localhost ou
// [::1]. A semente ESCREVE: use um container descartavel proprio.
//
// A SEMENTE esta NESTE arquivo (`SEMENTE`, aplicada no `beforeAll`): a prova e
// autocontida, e so exige um Postgres com as migrations 001..023 aplicadas e o
// seed do questionario (quiz_version 2, Marco Zero). Sao seis eventos, cada um
// isolando um desfecho:
//
//   GUIA-E1  36 respondentes completos, NENHUM ato de disponibilizacao     -> guia SAI
//   GUIA-E2  identico a E1, com `dna_coletivo_disponibilizado` registrado  -> guia RECUSADO
//   GUIA-E3  disponibilizado E com invalidacao nao reconhecida (caducou)   -> guia SAI
//   GUIA-E4  12 respondentes (volume abaixo do minimo do banco)            -> guia SAI
//   GUIA-E5/E6  populacoes iguais, conteudo de resposta OPOSTO, MESMO nome -> guia IDENTICO
//
// O QUE E REAL AQUI: o handler `POST` da rota; `verificarAdmin()`;
// `lib/marco-zero/entrada-do-guia.ts` inteiro; o gerador puro; a funcao
// `marco_zero_cobertura` e as tabelas da 020; e as leituras de events,
// event_logs, participants, event_people, event_checkins, quiz_stages e
// quiz_responses, que saem do banco por psql.
// SIMULADO: so o SERVICO DE LOGIN (`auth.getUser`), que e justamente o que se
// quer variar para dizer quem esta batendo na porta.
//
// A INDISPONIBILIDADE NAO E SIMULADA. Ela e produzida por PRIVILEGIO DE VERDADE:
// dois papeis de banco, `prova_sem_logs` (le tudo, menos `event_logs`) e
// `prova_sem_cobertura` (le tudo e NAO pode executar `marco_zero_cobertura`).
// A falha vem do Postgres, com a mensagem do Postgres, e e ela que a rota tem de
// classificar como "nao consegui verificar" -- nunca como "nao ha DNA publicado".

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const URL_ALVO = process.env.PROVA_GUIA_URL;

function exigirLocal(url: string): void {
  let host: string;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    host = u.hostname;
  } catch {
    throw new Error("PROVA_GUIA_URL nao e uma URL postgres valida");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`PROVA_GUIA_URL nao e local (host=${host}). A prova escreve: abortando.`);
  }
}

/** A mesma URL com outro papel de banco: e assim que a prova tira privilegio. */
function comPapel(papel: string): string {
  const u = new URL((URL_ALVO as string).replace(/^postgres(ql)?:\/\//, "http://"));
  return `postgresql://${papel}:prova@${u.host}${u.pathname}`;
}

const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-guia-")) : "";

// ---------------------------------------------------------------------------
// O CLIENTE DO BANCO, por psql. Implementa o pouco que a camada de leitura usa
// -- as sete leituras e o rpc -- e NADA MAIS. Tabela que a rota consultar sem
// estar aqui faz a prova LANCAR, em vez de passar por omissao.
// ---------------------------------------------------------------------------

const COLUNAS: Record<string, string[]> = {
  events: ["id", "name", "event_date", "quiz_version"],
  event_logs: ["action", "created_at", "event_id"],
  participants: ["id", "full_name", "event_id"],
  event_people: ["id", "participant_id", "event_id"],
  event_checkins: ["person_id", "estado", "event_id"],
  quiz_stages: ["id"],
  quiz_responses: ["participant_id", "stage_id", "answers"],
};

function lit(v: unknown): string {
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function rodarPsql(url: string, texto: string): { saida: string; erro: string | null } {
  const arquivo = join(TRABALHO, `q-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(arquivo, texto, "utf8");
  try {
    const saida = execFileSync(
      "psql",
      ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-f", arquivo],
      { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
    );
    return { saida: saida.trim(), erro: null };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { saida: "", erro: (err.stderr ?? err.message ?? String(e)).trim() };
  }
}

interface Resposta {
  data: unknown;
  error: { message: string } | null;
}

function clienteViaPsql(url: string) {
  function consulta(tabela: string) {
    const condicoes: string[] = [];
    const cols = COLUNAS[tabela];
    if (cols === undefined) {
      throw new Error(`a rota consultou uma tabela que esta prova nao serve: ${tabela}`);
    }

    const rodar = (): Resposta => {
      const onde = condicoes.length > 0 ? `where ${condicoes.join(" and ")}` : "";
      const campos = cols.map((c) => `'${c}', ${c}`).join(", ");
      const { saida, erro } = rodarPsql(
        url,
        `select coalesce(json_agg(json_build_object(${campos}))::text, '[]')
           from public.${tabela} ${onde}`,
      );
      if (erro !== null) return { data: null, error: { message: erro } };
      return { data: JSON.parse(saida === "" ? "[]" : saida), error: null };
    };

    const q: Record<string, unknown> = {
      eq(coluna: string, valor: unknown) {
        condicoes.push(`${coluna} = ${lit(valor)}`);
        return q;
      },
      in(coluna: string, valores: readonly unknown[]) {
        condicoes.push(
          valores.length === 0 ? "false" : `${coluna} in (${valores.map(lit).join(", ")})`,
        );
        return q;
      },
      maybeSingle(): Promise<Resposta> {
        const r = rodar();
        if (r.error) return Promise.resolve(r);
        const linhas = r.data as unknown[];
        return Promise.resolve({ data: linhas[0] ?? null, error: null });
      },
      then<R>(ok: (v: Resposta) => R) {
        return Promise.resolve(rodar()).then(ok);
      },
    };
    return q;
  }

  return {
    from(tabela: string) {
      return { select: () => consulta(tabela) };
    },
    rpc(nome: string, args: Record<string, unknown>): Promise<Resposta> {
      const { saida, erro } = rodarPsql(
        url,
        `select coalesce(json_agg(row_to_json(c))::text, '[]')
           from public.${nome}(${lit(args.p_event_id)}::uuid) c`,
      );
      if (erro !== null) return Promise.resolve({ data: null, error: { message: erro } });
      return Promise.resolve({ data: JSON.parse(saida === "" ? "[]" : saida), error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// O que e simulado: SO o servico de login e a fabrica do cliente.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  cliente: { atual: null as unknown },
}));

vi.mock("../../../../lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: h.getUser } }),
}));
vi.mock("../../../../lib/supabase/admin", () => ({
  createAdminClient: () => h.cliente.atual,
}));

import { NextRequest } from "next/server";
import { agregar } from "../dna-coletivo-agregacao";
import { prepararEntradaDoGuia, type ClienteDoGuia } from "../../../../lib/marco-zero/entrada-do-guia";

type Handler = (r: NextRequest) => Promise<Response>;
const rota: { post?: Handler } = {};

async function carregarRota(): Promise<void> {
  const m = await import("../../../../app/api/marco-zero/guia-facilitador/route");
  rota.post = m.POST as Handler;
}

const E = {
  rascunho: "e1000000-0000-4000-8000-000000000001",
  publicado: "e2000000-0000-4000-8000-000000000002",
  invalidado: "e3000000-0000-4000-8000-000000000003",
  doze: "e4000000-0000-4000-8000-000000000004",
  parA: "e5000000-0000-4000-8000-000000000005",
  parB: "e6000000-0000-4000-8000-000000000006",
};

const ADMIN = {
  id: "0ca0ca0c-0000-4000-8000-0ca0ca0c0ca0",
  email: "host@fortinside.test",
  app_metadata: { role: "admin" },
};
const PARTICIPANTE = {
  id: "9f9f9f9f-0000-4000-8000-9f9f9f9f9f9f",
  email: "jovem@example.org",
  app_metadata: {},
};

function comoAdmin() {
  h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });
}

async function pedir(eventId: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const req = new NextRequest("http://localhost/api/marco-zero/guia-facilitador", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: eventId }),
  });
  const res = await (rota.post as Handler)(req);
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

function sha256(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

// ---------------------------------------------------------------------------
// A SEMENTE. Idempotente: apaga os seis eventos desta prova (cascata) e refaz.
// Nao toca em nada fora deles.
// ---------------------------------------------------------------------------

const SEMENTE = `
set client_min_messages = warning;

delete from public.events where event_code like 'GUIA-E%';

create or replace function pg_temp.resp_visao(p_stage int) returns jsonb language sql immutable as $f$
  select case p_stage
    when 101 then '{"q1":"x","q2":"x","q3":"x","q4":"x","q5":"x","q6":"x"}'::jsonb
    when 102 then '{"q7":10,"q8":9,"q9":8,"q10":7,"q11":6,"q12":5,"q13":4,"q14":"x","q15":"x"}'::jsonb
    when 103 then '{"q16":5,"q17":5,"q18":5,"q19":5,"q20":5,"q21":5,
                    "q22":1,"q23":1,"q24":1,"q25":1,"q26":1,"q27":1,
                    "q28":1,"q29":1,"q30":1,"q31":1,"q32":1,"q33":1,
                    "q34":1,"q35":1,"q36":1,"q37":1,"q38":1,"q39":1}'::jsonb
    when 104 then '{"q40":"A","q41":"C","q42":"B","q43":"D","q44":"A","q45":"D"}'::jsonb
    when 105 then '{"q46":"x","q47":"x","q48":"x","q49":"x","q50":"x","q51":"x","q52":"x"}'::jsonb
  end
$f$;

create or replace function pg_temp.resp_integridade(p_stage int) returns jsonb language sql immutable as $f$
  select case p_stage
    when 101 then '{"q1":"y","q2":"y","q3":"y","q4":"y","q5":"y","q6":"y"}'::jsonb
    when 102 then '{"q7":4,"q8":5,"q9":6,"q10":7,"q11":8,"q12":9,"q13":10,"q14":"y","q15":"y"}'::jsonb
    when 103 then '{"q16":1,"q17":1,"q18":1,"q19":1,"q20":1,"q21":1,
                    "q22":1,"q23":1,"q24":1,"q25":1,"q26":1,"q27":1,
                    "q28":1,"q29":1,"q30":1,"q31":1,"q32":1,"q33":1,
                    "q34":5,"q35":5,"q36":5,"q37":5,"q38":5,"q39":5}'::jsonb
    when 104 then '{"q40":"D","q41":"B","q42":"C","q43":"A","q44":"D","q45":"C"}'::jsonb
    when 105 then '{"q46":"y","q47":"y","q48":"y","q49":"y","q50":"y","q51":"y","q52":"y"}'::jsonb
  end
$f$;

create or replace function pg_temp.semear(
  p_event uuid, p_nome text, p_codigo text, p_n int, p_especie text
) returns void language plpgsql as $f$
declare
  v_snap uuid := gen_random_uuid();
begin
  insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
  values (p_event, p_nome, p_codigo, '2026-11-14T13:00:00Z', 'live', 5, 2);

  insert into public.participants (id, event_id, full_name, email, completed_at)
  select
    ('00000000-0000-4000-8000-' || lpad(abs(hashtext(p_codigo || i::text))::text, 12, '0'))::uuid,
    p_event, 'Pessoa ' || i, lower(p_codigo) || i || '@example.org', now()
  from generate_series(1, p_n) i;

  insert into public.event_people (id, event_id, participant_id, full_name, email)
  select gen_random_uuid(), p_event, p.id, p.full_name, p.email
  from public.participants p where p.event_id = p_event;

  insert into public.event_invite_snapshots (id, event_id, versao, total_convidados, encerrado_por)
  values (v_snap, p_event, 1, p_n, 'prova');
  insert into public.event_invite_snapshot_people (snapshot_id, person_id)
  select v_snap, ep.id from public.event_people ep where ep.event_id = p_event;

  -- Check-ins ANTES do fechamento: gravar depois dispararia a invalidacao.
  insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
  select p_event, ep.id, 'Prova', 'operacao' from public.event_people ep where ep.event_id = p_event;

  insert into public.event_checkin_closures (event_id, versao, fechado_por, total_presentes_no_fechamento)
  values (p_event, 1, 'prova', p_n);

  insert into public.quiz_responses (participant_id, stage_id, answers)
  select p.id, s.id,
    case when p_especie = 'visao' then pg_temp.resp_visao(s.id) else pg_temp.resp_integridade(s.id) end
  from public.participants p
  cross join public.quiz_stages s
  where p.event_id = p_event and s.quiz_version = 2;
end;
$f$;

select pg_temp.semear('e1000000-0000-4000-8000-000000000001','Marco Zero | Rascunho','GUIA-E1',36,'visao');
select pg_temp.semear('e2000000-0000-4000-8000-000000000002','Marco Zero | Publicado','GUIA-E2',36,'visao');
select pg_temp.semear('e3000000-0000-4000-8000-000000000003','Marco Zero | Invalidado','GUIA-E3',36,'visao');
select pg_temp.semear('e4000000-0000-4000-8000-000000000004','Marco Zero | Doze','GUIA-E4',12,'visao');
-- O PAR DA INVARIANCIA: populacoes iguais, conteudo de resposta OPOSTO e o
-- MESMO nome de evento (o nome entra no cabecalho do guia por desenho).
select pg_temp.semear('e5000000-0000-4000-8000-000000000005','Marco Zero | Par','GUIA-E5',36,'visao');
select pg_temp.semear('e6000000-0000-4000-8000-000000000006','Marco Zero | Par','GUIA-E6',36,'integridade');

-- E2: o DNA foi disponibilizado.
insert into public.event_logs (event_id, action, payload)
values ('e2000000-0000-4000-8000-000000000002','dna_coletivo_disponibilizado','{"revisor":"prova"}');
-- E3: foi disponibilizado E a aprovacao caducou (invalidacao nao reconhecida).
insert into public.event_logs (event_id, action, payload)
values ('e3000000-0000-4000-8000-000000000003','dna_coletivo_disponibilizado','{"revisor":"prova"}');
insert into public.event_dna_invalidations (event_id, origem, detalhe)
values ('e3000000-0000-4000-8000-000000000003','elegibilidade','prova: elegibilidade mudou');

-- Os dois papeis da INDISPONIBILIDADE REAL (ver o cabecalho deste arquivo).
drop role if exists prova_sem_logs;
create role prova_sem_logs login password 'prova';
grant usage on schema public to prova_sem_logs;
grant select on public.events, public.participants, public.quiz_responses,
      public.quiz_stages, public.event_people, public.event_checkins to prova_sem_logs;
grant execute on function public.marco_zero_cobertura(uuid) to prova_sem_logs;
revoke all on public.event_logs from prova_sem_logs;

drop role if exists prova_sem_cobertura;
create role prova_sem_cobertura login password 'prova';
grant usage on schema public to prova_sem_cobertura;
grant select on public.events, public.participants, public.quiz_responses,
      public.quiz_stages, public.event_people, public.event_checkins, public.event_logs
  to prova_sem_cobertura;
revoke all on function public.marco_zero_cobertura(uuid) from prova_sem_cobertura, public;
`;

function semear(): void {
  const { erro } = rodarPsql(URL_ALVO as string, SEMENTE);
  if (erro !== null) throw new Error(`a semente da prova falhou:\n${erro}`);
}

descreve("borda do Guia de Preparacao do Facilitador", () => {
  beforeAll(async () => {
    exigirLocal(URL_ALVO as string);
    semear();
    await carregarRota();
    h.cliente.atual = clienteViaPsql(URL_ALVO as string);
  });

  // -------------------------------------------------------------------------
  // 1. QUEM PEDE
  // -------------------------------------------------------------------------

  it("1a. NEGATIVA: anonimo (o login responde que nao ha sessao) -> 401 AUTH_REQUIRED", async () => {
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", status: 400 },
    });
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(401);
    expect(r.corpo.code).toBe("AUTH_REQUIRED");
    expect(r.corpo.texto).toBeUndefined();
  });

  it("1b. NEGATIVA: participante (sessao valida SEM papel) -> 403 ADMIN_FORBIDDEN e nenhum guia", async () => {
    h.getUser.mockResolvedValue({ data: { user: PARTICIPANTE }, error: null });
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(403);
    expect(r.corpo.code).toBe("ADMIN_FORBIDDEN");
    expect(r.corpo.texto).toBeUndefined();
    expect(r.corpo.populacoes).toBeUndefined();
  });

  it("1c. NEGATIVA PAREADA: login fora do ar -> 503 AUTH_UNAVAILABLE, NUNCA 403", async () => {
    h.getUser.mockResolvedValue({
      data: null,
      error: { name: "AuthRetryableFetchError", status: 503 },
    });
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(503);
    expect(r.corpo.code).toBe("AUTH_UNAVAILABLE");
  });

  it("1d. CONTROLE POSITIVO: o MESMO pedido, como admin, passa e entrega o guia", async () => {
    comoAdmin();
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(typeof r.corpo.texto).toBe("string");
    expect((r.corpo.texto as string).length).toBeGreaterThan(2000);
  });

  // -------------------------------------------------------------------------
  // 2. O DEFEITO CORRIGIDO: rascunho nao bloqueia; publicado bloqueia
  // -------------------------------------------------------------------------

  it("2a. DNA em RASCUNHO (geravel, sem ato de disponibilizacao) -> o guia SAI", async () => {
    comoAdmin();
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(200);
    expect(r.corpo.motivo_sem_dna).toBe("dna_nao_publicado");
    // A base e grande: o DNA Coletivo deste evento E geravel, e o guia saiu
    // ASSIM MESMO -- e isso que a revisao mandou corrigir.
    expect(r.corpo.populacoes).toMatchObject({
      convidados: 36,
      presentes: 36,
      respostasCompletas: 36,
      respostasCompletasDePresentes: 36,
    });
    expect(r.corpo.texto).toContain("gerado e ainda não disponibilizado");
    expect(r.corpo.texto).toContain("MARCO ZERO: MATERIAL RESTRITO AO FACILITADOR");
  });

  it("2b. DNA PUBLICADO e revisado -> 400 GUIDE_DNA_PUBLISHED, e NENHUM texto de guia", async () => {
    comoAdmin();
    const r = await pedir(E.publicado);
    expect(r.status).toBe(400);
    expect(r.corpo.code).toBe("GUIDE_DNA_PUBLISHED");
    expect(r.corpo.texto).toBeUndefined();
    // O corpo nao carrega texto interno de banco.
    expect(JSON.stringify(r.corpo)).not.toMatch(/PGRST|SQLSTATE|permission denied/i);
  });

  it("2c. disponibilizado e INVALIDADO depois -> o guia SAI (invalidado nao e publicado)", async () => {
    comoAdmin();
    const r = await pedir(E.invalidado);
    expect(r.status).toBe(200);
    expect(r.corpo.motivo_sem_dna).toBe("dna_nao_publicado");
  });

  it("2d. volume abaixo do minimo do banco -> o guia SAI, com o motivo do limiar", async () => {
    comoAdmin();
    const r = await pedir(E.doze);
    expect(r.status).toBe(200);
    expect(r.corpo.motivo_sem_dna).toBe("volume_insuficiente");
    expect(r.corpo.populacoes).toMatchObject({ convidados: 12, presentes: 12 });
  });

  // -------------------------------------------------------------------------
  // 3. INDISPONIBILIDADE, por privilegio de verdade. NAO libera o guia.
  // -------------------------------------------------------------------------

  it("3a. sem poder LER o registro de disponibilizacao -> 503 GUIDE_DNA_STATE_UNVERIFIABLE", async () => {
    comoAdmin();
    h.cliente.atual = clienteViaPsql(comPapel("prova_sem_logs"));
    try {
      const r = await pedir(E.rascunho);
      // O MESMO evento que acabou de entregar o guia agora e RECUSADO: o que
      // mudou foi so a capacidade de saber o estado do DNA.
      expect(r.status).toBe(503);
      expect(r.corpo.code).toBe("GUIDE_DNA_STATE_UNVERIFIABLE");
      expect(r.corpo.texto).toBeUndefined();
      expect(r.corpo.ok).toBeUndefined();
      // E NAO virou "nao ha DNA publicado".
      expect(r.corpo.code).not.toBe("GUIDE_DNA_PUBLISHED");
    } finally {
      h.cliente.atual = clienteViaPsql(URL_ALVO as string);
    }
  });

  it("3b. sem poder EXECUTAR a cobertura oficial -> 503 COVERAGE_UNAVAILABLE", async () => {
    comoAdmin();
    h.cliente.atual = clienteViaPsql(comPapel("prova_sem_cobertura"));
    try {
      const r = await pedir(E.rascunho);
      expect(r.status).toBe(503);
      expect(r.corpo.code).toBe("COVERAGE_UNAVAILABLE");
      expect(r.corpo.texto).toBeUndefined();
      expect(JSON.stringify(r.corpo)).not.toMatch(/permission denied|SQLSTATE/i);
    } finally {
      h.cliente.atual = clienteViaPsql(URL_ALVO as string);
    }
  });

  it("3c. CONTROLE POSITIVO: com os privilegios de volta, o mesmo evento entrega o guia", async () => {
    comoAdmin();
    const r = await pedir(E.rascunho);
    expect(r.status).toBe(200);
    expect(r.corpo.motivo_sem_dna).toBe("dna_nao_publicado");
  });

  // -------------------------------------------------------------------------
  // 4. O CANAL CONTINUA ESTREITO depois da mudanca
  // -------------------------------------------------------------------------

  it("4. dois grupos com conteudo de resposta OPOSTO: guia identico byte a byte e mesmo hash", async () => {
    comoAdmin();
    const cliente = clienteViaPsql(URL_ALVO as string) as unknown as ClienteDoGuia;

    // Primeiro, a prova de que o conteudo das respostas e de fato OPOSTO. As
    // duas agregacoes saem dos MESMOS dados que a rota leu do banco.
    const a = await prepararEntradaDoGuia(cliente, E.parA);
    const b = await prepararEntradaDoGuia(cliente, E.parB);
    if (!a.ok || !b.ok) throw new Error("a semente dos dois grupos nao foi lida");
    // A semente encerra a lista de convites dos dois eventos: o total e conhecido.
    if (a.entrada.dna.convidados === null || b.entrada.dna.convidados === null) {
      throw new Error("a semente dos dois grupos perdeu a lista de convites");
    }
    const agA = agregar(a.entrada.dna.convidados, a.entrada.dna.participantes);
    const agB = agregar(b.entrada.dna.convidados, b.entrada.dna.participantes);
    expect(agA.respondentes).toBe(36);
    expect(agB.respondentes).toBe(36);
    // Opostos na autodescricao (o eixo destacado) e nos elementos.
    expect(agA.autodescricao.porDimensao.visao).toBe(36);
    expect(agA.autodescricao.porDimensao.integridade).toBe(0);
    expect(agB.autodescricao.porDimensao.integridade).toBe(36);
    expect(agB.autodescricao.porDimensao.visao).toBe(0);
    expect(agA.situacional.porDimensao.visao).toBe(36);
    expect(agB.situacional.porDimensao.integridade).toBe(36);
    expect(agA.elementos.soma.desenvolvimento_intelectual).not.toBe(
      agB.elementos.soma.desenvolvimento_intelectual,
    );

    // ...e o guia que a ROTA entrega para os dois e o MESMO.
    const ra = await pedir(E.parA);
    const rb = await pedir(E.parB);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.corpo.texto).toBe(rb.corpo.texto);
    expect(sha256(ra.corpo.texto as string)).toBe(sha256(rb.corpo.texto as string));
    expect(ra.corpo.conteudo_sha256).toBe(rb.corpo.conteudo_sha256);
    // E nenhum dos dois textos traz identificador de participante.
    for (const p of a.entrada.dna.participantes) {
      expect(ra.corpo.texto).not.toContain(p.id);
    }
  });
});
