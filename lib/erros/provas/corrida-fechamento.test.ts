// A CORRIDA DO FECHAMENTO, contra Postgres DESCARTAVEL de verdade.
//
// Exigencia do responsavel tecnico: "Uma submissao valida sendo gravada no limite
// da janela nao pode gerar um documento baseado numa fotografia desatualizada.
// Quero a transicao de encerramento e a captura da versao dos dados protegidas
// contra essa corrida."
//
// O que se exercita aqui, com transacoes concorrentes REAIS (cada psql e uma
// conexao e uma transacao proprias):
//   - o relogio vem do banco;
//   - coleta aberta recusa; o MESMO evento, fechado, libera;
//   - SUBMISSAO EM VOO NO LIMITE: uma transacao que COMECOU antes do limite e ainda
//     nao comitou. O inicio RECUSA (snapshot_instavel) e nao cria job nenhum; quando
//     a transacao comita, o inicio seguinte processa a pessoa com TODAS as respostas;
//   - COMMIT NO MEIO DO INICIO (via dblink, em outra conexao): a funcao levanta
//     excecao e a transacao inteira desfaz -- nenhum job fica criado;
//   - controles: sem transacao em voo libera; transacao que comecou DEPOIS do limite
//     nao bloqueia (a policy ja a recusaria); sem o gatilho de commit no meio libera.
//
// Como rodar (container proprio, descartavel, removido no fim):
//   bash lib/erros/provas/rodar-banco.sh
// Sem ERROS_PG_URL o arquivo e PULADO.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.ERROS_PG_URL;
const descreve = URL ? describe : describe.skip;
const executar = promisify(execFile);
const RUN = Date.now().toString(36);

if (URL && !/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) throw new Error("ABORTADO: o banco da prova nao e local");

async function sql(consulta: string): Promise<string> {
  try {
    const { stdout } = await executar("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL!, "-c", consulta], {
      env: { ...process.env, PGCONNECT_TIMEOUT: "30", LC_ALL: "C", LANG: "C" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    // A mensagem do banco (stderr) faz parte do erro: e ela que os testes conferem.
    throw new Error(`${(e as { stderr?: string }).stderr ?? ""}\n${e instanceof Error ? e.message : String(e)}`);
  }
}
/** Como o superusuario do container descartavel (o dblink do gatilho de teste exige). */
async function sqlSuper(consulta: string): Promise<string> {
  const u = new globalThis.URL(URL!);
  u.username = "supabase_admin";
  const { stdout } = await executar("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", u.toString(), "-c", consulta], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "30" },
  });
  return stdout.trim();
}
async function json<T = Record<string, any>>(consulta: string): Promise<T> {
  return JSON.parse(await sql(consulta)) as T;
}
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sessao de longa duracao: roda um script (uma transacao) em outra conexao. */
function sessao(script: string) {
  const p = spawn("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL!, "-f", "-"], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "30" },
  });
  let saida = "";
  let erro = "";
  p.stdout.on("data", (d) => (saida += d));
  p.stderr.on("data", (d) => (erro += d));
  p.stdin.write(script);
  p.stdin.end();
  const fim = new Promise<{ codigo: number | null; saida: string; erro: string }>((res) =>
    p.on("close", (codigo) => res({ codigo, saida, erro }))
  );
  return { fim };
}

const ETAPAS = [101, 102, 103, 104, 105];
let contador = 0;

/** Evento assincrono + n participantes concluidos, cada um com as 5 etapas respondidas. */
async function evento(o: { fechaEmSegundos: number; modo?: "live" | "async"; concluidos?: number; semPrazo?: boolean }) {
  const modo = o.modo ?? "async";
  const closes = o.semPrazo ? "null" : `now() + interval '${o.fechaEmSegundos} seconds'`;
  const id = await sql(
    `insert into events (name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
     values ('corrida ${RUN}', 'CF${RUN}${++contador}', now(), 'live', 0, 2, '${modo}', now() - interval '1 day', ${closes}) returning id`
  );
  const eventId = id.split("\n")[0];
  const ids: string[] = [];
  for (let i = 0; i < (o.concluidos ?? 1); i++) {
    const p = (
      await sql(
        `insert into participants (event_id, full_name, email, completed_at) values ('${eventId}', 'Pessoa ${i}', 'p${i}-${RUN}-${contador}@corrida.test', now()) returning id`
      )
    ).split("\n")[0];
    ids.push(p);
    for (const e of ETAPAS) {
      await sql(`insert into quiz_responses (participant_id, stage_id, answers) values ('${p}', ${e}, '{"v": ${e}}')`);
    }
  }
  return { eventId, ids };
}

const iniciar = (eventId: string, toleranciaSegundos = 900) =>
  json(`select public.jobs_iniciar_assincrono('${eventId}', 'prognostico', 3, ${toleranciaSegundos})`);
const jobs = async (eventId: string) => Number(await sql(`select count(*) from jobs where event_id = '${eventId}'`));

async function esperaLimite(eventId: string, toleranciaSegundos: number) {
  for (let i = 0; i < 120; i++) {
    const passou = await sql(
      `select clock_timestamp() >= form_closes_at + interval '${toleranciaSegundos} seconds' from events where id = '${eventId}'`
    );
    if (passou === "t") return;
    await dorme(250);
  }
  throw new Error("o limite nao chegou");
}

beforeAll(async () => {
  if (!URL) return;
  // O banco precisa ter a funcao (a proposta de migration foi aplicada pelo runner).
  const existe = await sql("select to_regprocedure('public.jobs_iniciar_assincrono(uuid,text,int,int,boolean)') is not null");
  expect(existe).toBe("t");
}, 60_000);

afterAll(async () => {
  if (!URL) return;
  await sqlSuper(`drop trigger if exists t_commit_no_meio on public.jobs`).catch(() => {});
}, 30_000);

descreve("referencia temporal do banco", () => {
  it("o relogio devolvido e o do PROPRIO banco: fica entre duas leituras de clock_timestamp()", async () => {
    const r = await json<{ a: string; ref: string; b: string }>(
      `select json_build_object('a', clock_timestamp(), 'ref', public.referencia_temporal_do_banco(), 'b', clock_timestamp())`
    );
    expect(new Date(r.a).getTime()).toBeLessThanOrEqual(new Date(r.ref).getTime());
    expect(new Date(r.ref).getTime()).toBeLessThanOrEqual(new Date(r.b).getTime());
  });
});

descreve("jobs_iniciar_assincrono -- recusas esperadas, cada uma com o controle positivo", () => {
  it("coleta ABERTA recusa; o MESMO evento depois de fechar libera", async () => {
    const { eventId } = await evento({ fechaEmSegundos: 3600 });
    const aberta = await iniciar(eventId);
    expect(aberta).toMatchObject({ ok: false, motivo: "coleta_aberta" });
    expect(await jobs(eventId)).toBe(0);
    // CONTROLE POSITIVO: o mesmo evento, prazo + tolerancia vencidos.
    await sql(`update events set form_closes_at = now() - interval '16 minutes' where id = '${eventId}'`);
    const fechada = await iniciar(eventId);
    expect(fechada).toMatchObject({ ok: true, total: 1, criados: 1 });
    expect(await jobs(eventId)).toBe(1);
  });

  it("dentro da tolerancia (prazo vencido ha 5 min, tolerancia de 15) ainda recusa", async () => {
    const { eventId } = await evento({ fechaEmSegundos: -300 });
    expect(await iniciar(eventId)).toMatchObject({ ok: false, motivo: "coleta_aberta" });
    expect(await jobs(eventId)).toBe(0);
  });

  it("evento live recusa (modo_nao_assincrono); o assincrono equivalente libera", async () => {
    const live = await evento({ fechaEmSegundos: -3600, modo: "live" });
    expect(await iniciar(live.eventId)).toMatchObject({ ok: false, motivo: "modo_nao_assincrono" });
    const as = await evento({ fechaEmSegundos: -3600 });
    expect(await iniciar(as.eventId)).toMatchObject({ ok: true });
  });

  it("assincrono sem prazo e indeterminado (nunca libera); definir o prazo libera", async () => {
    const { eventId } = await evento({ fechaEmSegundos: 0, semPrazo: true });
    expect(await iniciar(eventId)).toMatchObject({ ok: false, motivo: "janela_indeterminada" });
    await sql(`update events set form_closes_at = now() - interval '1 hour' where id = '${eventId}'`);
    expect(await iniciar(eventId)).toMatchObject({ ok: true });
  });

  it("evento inexistente e sem elegiveis sao recusas proprias", async () => {
    expect(await iniciar("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, motivo: "evento_inexistente" });
    const { eventId } = await evento({ fechaEmSegundos: -3600, concluidos: 0 });
    expect(await iniciar(eventId)).toMatchObject({ ok: false, motivo: "sem_elegiveis" });
  });

  it("reenviar e idempotente: segundo inicio reaproveita, nao duplica", async () => {
    const { eventId } = await evento({ fechaEmSegundos: -3600, concluidos: 2 });
    expect(await iniciar(eventId)).toMatchObject({ ok: true, criados: 2, reaproveitados: 0 });
    expect(await iniciar(eventId)).toMatchObject({ ok: true, criados: 0, reaproveitados: 2 });
    expect(await jobs(eventId)).toBe(2);
  });
});

descreve("quem pode chamar -- e a quiescencia funciona COMO O POSTGREST CHAMA (papel service_role)", () => {
  const chamaComoServico = async (eventId: string, tol: number) =>
    JSON.parse(
      (await sql(`begin; set local role service_role; select public.jobs_iniciar_assincrono('${eventId}', 'prognostico', 3, ${tol}); commit;`))
        .split("\n")
        .find((l) => l.startsWith("{"))!
    );

  it("service_role executa e a quiescencia ENXERGA as outras transacoes (security definer)", async () => {
    const TOL = 1;
    const { eventId } = await evento({ fechaEmSegundos: 4, concluidos: 1 });
    const escritor = sessao(`begin; select count(*) from participants; select pg_sleep(9); commit;`); // aberta antes do limite
    await esperaLimite(eventId, TOL);
    expect(await chamaComoServico(eventId, TOL)).toMatchObject({ ok: false, motivo: "snapshot_instavel" });
    await escritor.fim;
    // CONTROLE POSITIVO: o mesmo papel, sem transacao em voo.
    expect(await chamaComoServico(eventId, TOL)).toMatchObject({ ok: true, total: 1 });
  }, 60_000);

  // Observacao de ambiente: chamar uma funcao SEM privilegio como anon/authenticated
  // derruba o backend (SIGSEGV) na imagem postgres do Supabase usada no container --
  // inclusive as funcoes da 018, que nao sao desta unidade. Por isso o privilegio e
  // conferido por catalogo (has_function_privilege), sem executar a chamada negada.
  it("so service_role executa as duas funcoes (anon, authenticated e public NAO)", async () => {
    for (const f of ["public.jobs_iniciar_assincrono(uuid,text,int,int,boolean)", "public.referencia_temporal_do_banco()"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(await sql(`select has_function_privilege('${papel}', '${f}', 'execute')`), `${papel} ${f}`).toBe("f");
      }
      expect(await sql(`select has_function_privilege('service_role', '${f}', 'execute')`), f).toBe("t");
      // PUBLIC: nenhuma entrada em proacl para o publico (aclexplode.grantee = 0)
      expect(await sql(`select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = '${f}'::regprocedure and a.grantee = 0`), `public ${f}`).toBe("0");
    }
  });
});

descreve("A CORRIDA: submissao em voo no limite da janela", () => {
  it("transacao que COMECOU antes do limite e nao comitou: o inicio RECUSA e nada e criado; depois do commit, processa a pessoa COMPLETA", async () => {
    const TOL = 1;
    const { eventId, ids } = await evento({ fechaEmSegundos: 6, concluidos: 1 });

    // A pessoa que esta terminando de enviar: transacao aberta ANTES do limite
    // (xact_start ~ agora, limite = agora + ~7s), que so comita depois do limite.
    const nova = (
      await sql(`insert into participants (event_id, full_name, email) values ('${eventId}', 'No limite', 'limite-${RUN}-${contador}@corrida.test') returning id`)
    ).split("\n")[0];
    const escritor = sessao(`
      begin;
      ${ETAPAS.map((e) => `insert into quiz_responses (participant_id, stage_id, answers) values ('${nova}', ${e}, '{"v": ${e}}');`).join("\n")}
      update participants set completed_at = now() where id = '${nova}';
      select pg_sleep(13);
      commit;
    `);

    await esperaLimite(eventId, TOL);
    // Estamos DEPOIS do limite; o escritor segue em voo (iniciou antes dele).
    const emVoo = await iniciar(eventId, TOL);
    expect(emVoo).toMatchObject({ ok: false, motivo: "snapshot_instavel" });
    expect(emVoo.transacoes_abertas).toBeGreaterThanOrEqual(1);
    expect(await jobs(eventId)).toBe(0); // NADA foi processado sobre fotografia incompleta

    // O escritor comita (as respostas da pessoa ficam visiveis).
    const r = await escritor.fim;
    expect(r.codigo, r.erro).toBe(0);

    // CONTROLE POSITIVO: a MESMA chamada, agora sem transacao em voo.
    const depois = await iniciar(eventId, TOL);
    expect(depois).toMatchObject({ ok: true, total: 2, criados: 2 });
    const incluidos = (await sql(`select string_agg(participant_id::text, ',' order by participant_id) from jobs where event_id = '${eventId}'`)).split(",");
    expect(incluidos.sort()).toEqual([...ids, nova].sort());
    // E a pessoa do limite entrou com TODAS as respostas, nao com uma fotografia parcial.
    const respostas = Number(await sql(`select count(*) from quiz_responses where participant_id = '${nova}'`));
    expect(respostas).toBe(ETAPAS.length);
  }, 90_000);

  it("CONTROLE: transacao que comecou DEPOIS do limite nao bloqueia (a policy ja a recusaria)", async () => {
    const TOL = 1;
    const { eventId } = await evento({ fechaEmSegundos: 2, concluidos: 1 });
    await esperaLimite(eventId, TOL);
    const tardia = sessao(`begin; select pg_sleep(4); commit;`); // xact_start > limite
    await dorme(800);
    const r = await iniciar(eventId, TOL);
    expect(r).toMatchObject({ ok: true, total: 1 });
    await tardia.fim;
  }, 60_000);

  it("COMMIT NO MEIO do inicio (outra conexao altera uma resposta enquanto enfileira): excecao e NENHUM job fica criado", async () => {
    const TOL = 1;
    const { eventId, ids } = await evento({ fechaEmSegundos: -3600, concluidos: 2 });
    const senha = new globalThis.URL(URL!).password;
    const porta = "5432";
    await sqlSuper("create extension if not exists dblink with schema extensions");
    // Gatilho de TESTE (so neste banco descartavel): ao criar o job do segundo
    // participante, uma CONEXAO SEPARADA grava e comita uma mudanca de resposta do primeiro.
    await sqlSuper(`
      create table if not exists public.t_commit_no_meio_flag (evento uuid primary key);
      create or replace function public.t_commit_no_meio() returns trigger language plpgsql security definer as $f$
      begin
        if new.event_id = '${eventId}' and not exists (select 1 from public.t_commit_no_meio_flag where evento = new.event_id)
           and new.participant_id = '${ids[1]}' then
          insert into public.t_commit_no_meio_flag values (new.event_id);
          perform extensions.dblink_exec('host=127.0.0.1 port=${porta} dbname=postgres user=supabase_admin password=${senha}',
            $q$update public.quiz_responses set answers = '{"v": 999}' where participant_id = '${ids[0]}' and stage_id = 101$q$);
        end if;
        return new;
      end $f$;
      drop trigger if exists t_commit_no_meio on public.jobs;
      create trigger t_commit_no_meio after insert on public.jobs for each row execute function public.t_commit_no_meio();
    `);
    let erro = "";
    try {
      await iniciar(eventId, TOL);
    } catch (e) {
      erro = e instanceof Error ? e.message : String(e);
    }
    expect(erro).toMatch(/SNAPSHOT_INSTAVEL/);
    expect(await jobs(eventId)).toBe(0); // a transacao inteira desfez
    // A mudanca da outra conexao SIM foi confirmada (e por isso a fotografia mudou).
    expect(await sql(`select answers->>'v' from quiz_responses where participant_id = '${ids[0]}' and stage_id = 101`)).toBe("999");

    // CONTROLE POSITIVO: sem o gatilho, o mesmo evento libera.
    await sqlSuper(`drop trigger t_commit_no_meio on public.jobs`);
    const ok = await iniciar(eventId, TOL);
    expect(ok).toMatchObject({ ok: true, total: 2, criados: 2 });
    expect(await jobs(eventId)).toBe(2);
  }, 60_000);

  it("a impressao digital muda quando UMA resposta muda (a validacao do fim enxerga o commit no meio)", async () => {
    const { eventId, ids } = await evento({ fechaEmSegundos: -3600, concluidos: 1 });
    const a = await iniciar(eventId);
    await sql(`update quiz_responses set answers = '{"v": 1000}' where participant_id = '${ids[0]}' and stage_id = 102`);
    const b = await iniciar(eventId);
    expect(a.digest).toBeTruthy();
    expect(b.digest).not.toBe(a.digest);
    // sem mudar nada, igual (determinismo)
    expect((await iniciar(eventId)).digest).toBe(b.digest);
  });
});
