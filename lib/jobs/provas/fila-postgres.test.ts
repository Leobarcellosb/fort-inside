// PROVA da fila contra Postgres de verdade, com a migration 018 aplicada.
//
// Como rodar (banco descartável, nunca produção):
//   nome=prova018
//   url=$(bash scripts/drift/reference-db.sh up --name "$nome" | cut -f2)
//   JOBS_PROVA_URL="$url" npx vitest run lib/jobs/provas/fila-postgres.test.ts
//   docker rm -f "$nome"
//
// Sem JOBS_PROVA_URL o arquivo é PULADO, para que `npx vitest run` continue
// verde em máquina sem docker. Pular é explícito: um teste de banco que se
// disfarça de verde sem banco seria pior que não existir.
//
// O TRABALHO CARO É SIMULADO com espera (`await dormir(...)`). Isto é
// deliberado e declarado: chamar a Anthropic aqui gastaria crédito e tornaria a
// prova dependente de rede e de latência de terceiro. O que está sendo provado
// é a FILA -- reivindicação exclusiva, lease, fencing, recuperação, preservação
// de desfecho e fechamento de evento -- e nada disso depende de qual trabalho
// roda dentro do slot. O adaptador real (`trabalho-prognostico.ts`) é só a
// tradução de `generatePrognostic` para o vocabulário de desfecho.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { consultarJson, criarClientePsql, psql, psqlArquivo } from "./cliente-psql";
import {
  concluirJob,
  enfileirarJob,
  falharJob,
  liberarOrcamento,
  recuperarExpirados,
  reenfileirarJob,
  reivindicarJobs,
  renovarLease,
  resumoConsumo,
  resumoEvento,
  verificarOrcamento,
  type ClienteFila,
} from "../fila";
import { rodarTick, type ClienteWorker } from "../worker";
import { lerSaudeDaFila } from "../saude";
import type { Trabalho } from "../executor";
import type { ConfigFila } from "../config";

const ALVO = process.env.JOBS_PROVA_URL;
const descreve = ALVO ? describe : describe.skip;
const url = ALVO ?? "";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = (over: Partial<ConfigFila> = {}): ConfigFila => ({
  concorrencia: 3,
  leaseSegundos: 60,
  // Zero = sem heartbeat nesta prova: o lease de 60s cobre o trabalho
  // simulado, e o heartbeat tem prova própria (executor.test.ts) e aparece
  // explicitamente no critério do lease expirado.
  renovarCadaMs: 0,
  backoffSegundos: 0,
  orcamentoTickMs: 120_000,
  maxJobsPorTick: 200,
  maxRecuperarPorTick: 100,
  alertaSemProgressoSegundos: 180,
  janelaFalhasHoras: 24,
  timeoutTentativaMs: 120_000,
  orcamentoChamadasPorTick: 200,
  orcamentoTentativasPorEvento: 0,
  orcamentoTentativasPorParticipante: 0,
  intervaloDoAgendadorSegundos: 60,
  ...over,
});

interface Semeado {
  eventId: string;
  participantIds: string[];
}

/**
 * Envolve o cliente para que a n-ésima chamada de `funcao` devolva erro. Serve
 * para cortar um tick NO MEIO: ele faz trabalho de verdade e estoura depois.
 */
function clienteQueFalhaNaEnesima(
  base: ReturnType<typeof criarClientePsql>,
  funcao: string,
  n: number
): ClienteWorker {
  let vezes = 0;
  return {
    rpc(nome, args) {
      if (nome === funcao && ++vezes >= n) {
        return Promise.resolve({
          data: null,
          error: { message: `falha injetada na ${n}a chamada de ${nome}` },
        });
      }
      return base.rpc(nome, args);
    },
    from: base.from.bind(base),
  };
}

let contador = 0;

// ---------------------------------------------------------------------------
// Provedor FALSO, local. Existe porque é PROIBIDO gastar token de verdade aqui
// e porque o livro-razão da 021 só conta tentativa que DESPACHOU requisição --
// um trabalho que não faz fetch nenhum registraria 0 e o teto nunca morderia.
// ---------------------------------------------------------------------------
let provedor: Server;
let urlDoProvedor = "";
let requisicoesRecebidas = 0;

beforeAll(async () => {
  provedor = createServer((_req, res) => {
    requisicoesRecebidas++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => provedor.listen(0, "127.0.0.1", resolve));
  const e = provedor.address();
  if (e == null || typeof e === "string") throw new Error("sem endereço");
  urlDoProvedor = `http://127.0.0.1:${e.port}/v1/messages`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => provedor.close(() => resolve()));
});

/** Reconhece o provedor falso, no lugar de api.anthropic.com. */
const ehProvedor = (u: string) => u.includes("/v1/messages");

/**
 * Trabalho que CHEGA ao provedor antes de decidir o desfecho. `erro` null =
 * sucesso. A requisição é despachada de verdade, então `chamadasAoProvedor`
 * fica 1 e a tentativa conta no teto -- inclusive quando o desfecho é falha.
 */
function trabalhoQueChamaOProvedor(erro: string | null): Trabalho {
  return async () => {
    const r = await fetch(urlDoProvedor);
    await r.json();
    if (erro) return { desfecho: "failed", erro, codigo: "simulado" };
    return { desfecho: "succeeded", resultado: { prognostic_id: "pg-falso" } };
  };
}

/** Cria um evento em 'processing' com N participantes que concluíram o quiz. */
async function semear(n: number): Promise<Semeado> {
  const marca = `${Date.now()}-${contador++}`;
  const saida = await psql(
    url,
    `
    with e as (
      insert into public.events (name, event_code, event_date, status, current_stage)
      values ('prova fila ${marca}', 'PROVA-${marca}', now(), 'processing', 6)
      returning id
    ), p as (
      insert into public.participants (event_id, full_name, email, completed_at)
      select e.id, 'Participante ' || g, 'p' || lpad(g::text, 3, '0') || '-${marca}@prova.test', now()
      from e, generate_series(1, ${n}) g
      returning id, email
    )
    select json_build_object(
      'eventId', (select id from e),
      'participantIds', (select json_agg(id order by email) from p)
    )::text`
  );
  return JSON.parse(saida) as Semeado;
}

interface LinhaJob {
  id: string;
  participant_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_token: string | null;
  lease_expires_at: string | null;
  claimed_by: string | null;
  first_attempt_at: string | null;
  finished_at: string | null;
  last_duration_ms: number | null;
  total_duration_ms: number;
  last_error: string | null;
  last_error_code: string | null;
  result: Record<string, unknown> | null;
}

const COLUNAS =
  "id, participant_id, status, attempts, max_attempts, run_token, lease_expires_at, claimed_by, first_attempt_at, finished_at, last_duration_ms, total_duration_ms, last_error, last_error_code, result";

async function jobsDoEvento(eventId: string): Promise<LinhaJob[]> {
  return (
    (await consultarJson<LinhaJob[] | null>(
      url,
      `select json_agg(t order by t.participant_id) from (select ${COLUNAS} from public.jobs where event_id = '${eventId}' and kind = 'prognostico') t`
    )) ?? []
  );
}

async function jobDoParticipante(participantId: string): Promise<LinhaJob> {
  const linhas =
    (await consultarJson<LinhaJob[] | null>(
      url,
      `select json_agg(t) from (select ${COLUNAS} from public.jobs where participant_id = '${participantId}' and kind = 'prognostico') t`
    )) ?? [];
  expect(linhas.length).toBe(1);
  return linhas[0];
}

async function statusDoEvento(eventId: string): Promise<string> {
  return psql(url, `select status from public.events where id = '${eventId}'`);
}

/** Trabalho simulado: espera e devolve o desfecho pedido por participante. */
function trabalhoSimulado(
  plano: (participantId: string) => "succeeded" | "skipped" | "failed" | "excecao",
  esperaMs = 20
): Trabalho {
  return async (job) => {
    await dormir(esperaMs);
    const d = plano(job.participantId);
    if (d === "excecao") throw new Error("estouro simulado dentro do trabalho");
    if (d === "failed") {
      return { desfecho: "failed", erro: "falha simulada do trabalho", codigo: "simulado" };
    }
    if (d === "skipped") {
      return { desfecho: "skipped", motivo: "documento já em delivered (409 simulado)" };
    }
    return {
      desfecho: "succeeded",
      resultado: { prognostic_id: `pg-${job.participantId.slice(0, 8)}`, trail: "Direção" },
    };
  };
}

descreve("fila de jobs contra Postgres real (migration 018)", () => {
  // Isolamento entre provas. Não é higiene opcional: o teto de concorrência da
  // 018 é GLOBAL POR KIND, então um job deixado 'running' com lease vivo por
  // uma prova anterior (a de concorrência deixa 3 de propósito) consome as
  // vagas da prova seguinte e ela mediria zero. Apagar os eventos de prova
  // cascateia para participants e jobs.
  // Uma chamada só: cada invocação de psql é um processo, e sob máquina
  // carregada cada spawn custa centenas de ms. O timeout explícito existe
  // porque o padrão de 10s do vitest estourava aqui -- e um hook que estoura
  // deixa lixo que faz a prova seguinte medir a coisa errada.
  beforeEach(async () => {
    await psql(
      url,
      `delete from public.events where event_code like 'PROVA-%'; delete from public.jobs;`
    );
  }, 60_000);

  it("CRITÉRIO 1 -- controle positivo: reivindica, executa, conclui, com duração e tentativas persistidas", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);

    const enfileirado = await enfileirarJob(cliente, {
      kind: "prognostico",
      eventId,
      participantId: participantIds[0],
    });
    expect(enfileirado.criado).toBe(true);
    expect(enfileirado.status).toBe("pending");

    const relatorio = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "prova-1",
      trabalho: trabalhoSimulado(() => "succeeded", 120),
      config: config({ concorrencia: 1 }),
    });

    expect(relatorio.reivindicados).toBe(1);
    expect(relatorio.sucesso).toBe(1);
    expect(relatorio.jobs[0].gravado).toBe(true);
    expect(relatorio.jobs[0].descartado).toBe(false);

    const linha = await jobDoParticipante(participantIds[0]);
    console.log("[C1] linha persistida:", {
      status: linha.status,
      attempts: linha.attempts,
      last_duration_ms: linha.last_duration_ms,
      total_duration_ms: linha.total_duration_ms,
      claimed_by: linha.claimed_by,
      first_attempt_at: linha.first_attempt_at,
      finished_at: linha.finished_at,
      result: linha.result,
    });

    expect(linha.status).toBe("succeeded");
    expect(linha.attempts).toBe(1);
    expect(linha.last_duration_ms).toBeGreaterThanOrEqual(100);
    expect(linha.total_duration_ms).toBeGreaterThanOrEqual(100);
    expect(linha.first_attempt_at).not.toBeNull();
    expect(linha.finished_at).not.toBeNull();
    expect(linha.lease_expires_at).toBeNull();
    expect(linha.claimed_by).toBe("prova-1");
    expect(linha.result).toMatchObject({ trail: "Direção" });

    // O evento sai de 'processing' por conta do tick, não da última linha de
    // uma requisição longa.
    expect(relatorio.eventosFechados).toContain(eventId);
    expect(await statusDoEvento(eventId)).toBe("completed");

    const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
    console.log("[C1] resumo do evento:", resumo);
    expect(resumo).toMatchObject({ total: 1, succeeded: 1, pendentes: 0 });
  }, 90_000);

  it("CRITÉRIO 2 -- dois (seis) workers simultâneos: cada job é reivindicado por apenas um", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(3);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    // Seis reivindicações DE VERDADE simultâneas: cada uma é um processo psql,
    // logo uma conexão e uma transação próprias, disputando o mesmo advisory
    // lock e o mesmo `for update skip locked`.
    const workers = ["w1", "w2", "w3", "w4", "w5", "w6"];
    const resultados = await Promise.all(
      workers.map((w) =>
        reivindicarJobs(cliente, {
          kind: "prognostico",
          worker: w,
          leaseSegundos: 60,
          limite: 1,
          concorrenciaMax: 3,
        })
      )
    );

    const ganhos = resultados.flatMap((r, i) => r.map((j) => ({ worker: workers[i], job: j.id })));
    console.log("[C2] 6 workers simultâneos, 3 jobs, teto 3 -> quem pegou o quê:", ganhos);

    expect(ganhos.length).toBe(3);
    expect(new Set(ganhos.map((g) => g.job)).size).toBe(3);
    expect(new Set(ganhos.map((g) => g.worker)).size).toBe(3);

    const linhas = await jobsDoEvento(eventId);
    // Cada job foi reivindicado UMA vez: attempts = 1 em todos.
    expect(linhas.map((l) => l.attempts)).toEqual([1, 1, 1]);
    expect(new Set(linhas.map((l) => l.run_token)).size).toBe(3);
  }, 90_000);

  it("CRITÉRIO 2b -- o teto global de concorrência é somado, não multiplicado, por ticks sobrepostos", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(20);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    // Oito reivindicadores simultâneos pedindo CINCO cada, com teto 3.
    // Sem o advisory lock da 018, cada um leria "0 em execução" e levaria 5:
    // 40 jobs em voo com teto 3.
    const resultados = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reivindicarJobs(cliente, {
          kind: "prognostico",
          worker: `sobreposto-${i}`,
          leaseSegundos: 60,
          limite: 5,
          concorrenciaMax: 3,
        })
      )
    );
    const total = resultados.reduce((s, r) => s + r.length, 0);
    console.log(
      "[C2b] 8 reivindicadores x limite 5, teto 3, 20 jobs pendentes -> reivindicados:",
      total,
      "| por worker:",
      resultados.map((r) => r.length)
    );
    expect(total).toBe(3);

    const emExecucao = await psql(
      url,
      `select count(*) from public.jobs where event_id = '${eventId}' and status = 'running' and lease_expires_at > now()`
    );
    expect(Number(emExecucao)).toBe(3);
  }, 90_000);

  it("CRITÉRIO 3 (CENTRAL) -- lease expirado vai para outro worker, e o worker antigo NÃO sobrescreve o resultado da tentativa mais recente", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);
    const pid = participantIds[0];
    await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });

    // --- tentativa 1: worker A pega com lease curto e "desaparece" ---
    const [a] = await reivindicarJobs(cliente, {
      kind: "prognostico",
      worker: "worker-A",
      leaseSegundos: 5, // mínimo que a 018 aceita
      limite: 1,
      concorrenciaMax: 3,
    });
    expect(a).toBeTruthy();
    console.log("[C3] A reivindicou:", {
      job: a.id,
      tentativa: a.attempts,
      run_token: a.runToken,
      lease_ate: a.leaseExpiresAt,
    });

    // O lease vence de verdade: espera o relógio passar. Nada é forçado no banco.
    await dormir(6000);

    const expirado = await psql(
      url,
      `select status || ' lease_vencido=' || (lease_expires_at <= now())::text from public.jobs where id = '${a.id}'`
    );
    console.log("[C3] estado da linha depois de 6s:", expirado);
    expect(expirado).toBe("running lease_vencido=true");

    // --- tentativa 2: worker B reivindica o MESMO job, lease vencido ---
    const [b] = await reivindicarJobs(cliente, {
      kind: "prognostico",
      worker: "worker-B",
      leaseSegundos: 60,
      limite: 1,
      concorrenciaMax: 3,
    });
    expect(b).toBeTruthy();
    expect(b.id).toBe(a.id);
    expect(b.attempts).toBe(2);
    expect(b.runToken).not.toBe(a.runToken);
    console.log("[C3] B reivindicou o MESMO job:", {
      job: b.id,
      tentativa: b.attempts,
      run_token: b.runToken,
    });

    // --- o zumbi volta do limbo com o token velho ---
    const renovouA = await renovarLease(cliente, {
      id: a.id,
      runToken: a.runToken,
      leaseSegundos: 60,
    });
    const concluiuA = await concluirJob(cliente, {
      id: a.id,
      runToken: a.runToken,
      status: "succeeded",
      resultado: { origem: "worker-A-ZUMBI", prognostic_id: "pg-do-A" },
    });
    const falhouA = await falharJob(cliente, {
      id: a.id,
      runToken: a.runToken,
      erro: "A tentando marcar falha com token velho",
      codigo: "zumbi",
      backoffSegundos: 0,
    });
    console.log("[C3] zumbi A com token velho:", {
      renovar_lease: renovouA,
      concluir: concluiuA,
      falhar_aplicado: falhouA.aplicado,
    });
    expect(renovouA).toBe(false);
    expect(concluiuA).toBe(false);
    expect(falhouA.aplicado).toBe(false);

    // --- B grava o resultado DELE ---
    const concluiuB = await concluirJob(cliente, {
      id: b.id,
      runToken: b.runToken,
      status: "succeeded",
      resultado: { origem: "worker-B", prognostic_id: "pg-do-B" },
    });
    expect(concluiuB).toBe(true);

    // --- o zumbi insiste DEPOIS de B ter gravado ---
    const concluiuADepois = await concluirJob(cliente, {
      id: a.id,
      runToken: a.runToken,
      status: "succeeded",
      resultado: { origem: "worker-A-ZUMBI-DEPOIS" },
    });
    expect(concluiuADepois).toBe(false);

    const linha = await jobDoParticipante(pid);
    console.log("[C3] linha final (deve ser o resultado de B, tentativa 2):", {
      status: linha.status,
      attempts: linha.attempts,
      claimed_by: linha.claimed_by,
      result: linha.result,
      total_duration_ms: linha.total_duration_ms,
    });
    expect(linha.status).toBe("succeeded");
    expect(linha.attempts).toBe(2);
    expect(linha.claimed_by).toBe("worker-B");
    expect(linha.result).toMatchObject({ origem: "worker-B" });

    // ACHADO sobre a 018, medido aqui e NÃO corrigido (exigiria mudar o
    // schema/função, e a 018 está fechada): quando `jobs_reivindicar` retoma
    // DIRETAMENTE uma linha de lease vencido, ele reescreve
    // `attempt_started_at` sem somar o tempo da tentativa abandonada em
    // `total_duration_ms`. Resultado: a duração da tentativa que sumiu é
    // PERDIDA nesse caminho -- aqui, ~6s viraram os ~0,1s só de B.
    // `attempts` continua honesto (incrementa na reivindicação), então o proxy
    // de CUSTO não é afetado; o que fica subestimado é o tempo.
    // O caminho por `jobs_recuperar_expirados` soma corretamente -- ver C3b --
    // e é por isso que `rodarTick` chama a recuperação ANTES de reivindicar.
    expect(linha.total_duration_ms).toBeGreaterThan(0);
    expect(linha.total_duration_ms).toBeLessThan(6000);
  }, 90_000);

  it("CRITÉRIO 3b -- jobs_recuperar_expirados devolve o job à fila e zera o token do worker sumido", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);
    const pid = participantIds[0];
    await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });

    const [a] = await reivindicarJobs(cliente, {
      kind: "prognostico",
      worker: "worker-que-morre",
      leaseSegundos: 5,
      limite: 1,
      concorrenciaMax: 3,
    });
    await dormir(6000);

    const recuperados = await recuperarExpirados(cliente, { kind: "prognostico", limite: 10 });
    const meu = recuperados.find((r) => r.id === a.id);
    console.log("[C3b] recuperados:", recuperados);
    expect(meu).toMatchObject({ novoStatus: "pending", attempts: 1 });

    const linha = await jobDoParticipante(pid);
    console.log("[C3b] linha depois da recuperação:", {
      status: linha.status,
      run_token: linha.run_token,
      last_error_code: linha.last_error_code,
      last_error: linha.last_error,
      last_duration_ms: linha.last_duration_ms,
      total_duration_ms: linha.total_duration_ms,
    });
    expect(linha.status).toBe("pending");
    expect(linha.run_token).toBeNull();
    expect(linha.last_error_code).toBe("lease_expirado");
    // Por ESTE caminho a duração da tentativa perdida É contabilizada: ~6s de
    // trabalho que ninguém viu aparecem no custo somado. É a diferença em
    // relação ao retomar direto do C3, e a razão de o tick recuperar primeiro.
    expect(linha.total_duration_ms).toBeGreaterThanOrEqual(5000);

    // Token zerado: o worker sumido não grava mais nada, nem falha.
    const tentativaZumbi = await concluirJob(cliente, {
      id: a.id,
      runToken: a.runToken,
      status: "succeeded",
      resultado: { origem: "zumbi" },
    });
    expect(tentativaZumbi).toBe(false);
  }, 90_000);

  it("CRITÉRIO 4 -- a falha de um participante não impede nem refaz o job de outro", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(4);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }
    const [quemFalha, quemEstoura, ok1, ok2] = participantIds;

    const plano = (pid: string) =>
      pid === quemFalha ? "failed" : pid === quemEstoura ? "excecao" : "succeeded";

    // Ticks repetidos, como o agendador faria.
    let ticks = 0;
    for (;;) {
      const r = await rodarTick(cliente, {
        kind: "prognostico",
        worker: `prova-4-tick-${ticks}`,
        trabalho: trabalhoSimulado(plano as (p: string) => "succeeded" | "failed" | "excecao", 10),
        config: config(),
      });
      ticks++;
      const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
      if (resumo.pendentes === 0 || ticks > 12) break;
      if (r.reivindicados === 0) break;
    }

    const linhas = await jobsDoEvento(eventId);
    const porId = new Map(linhas.map((l) => [l.participant_id, l]));
    console.log(
      "[C4] desfecho por participante:",
      linhas.map((l) => ({
        p: l.participant_id.slice(0, 8),
        status: l.status,
        attempts: `${l.attempts}/${l.max_attempts}`,
        codigo: l.last_error_code,
        erro: l.last_error?.slice(0, 60),
        total_duration_ms: l.total_duration_ms,
      }))
    );

    // Os que falharam: terminais, com motivo e contagem de tentativas.
    expect(porId.get(quemFalha)!.status).toBe("failed");
    expect(porId.get(quemFalha)!.attempts).toBe(3);
    expect(porId.get(quemFalha)!.last_error_code).toBe("simulado");
    expect(porId.get(quemEstoura)!.status).toBe("failed");
    expect(porId.get(quemEstoura)!.last_error_code).toBe("excecao");

    // Os que deram certo: UMA tentativa cada. Não foram refeitos por causa da
    // falha dos outros, nem ficaram presos esperando por eles.
    expect(porId.get(ok1)!.status).toBe("succeeded");
    expect(porId.get(ok1)!.attempts).toBe(1);
    expect(porId.get(ok2)!.status).toBe("succeeded");
    expect(porId.get(ok2)!.attempts).toBe(1);

    // Evento NÃO fica indefinido mesmo com falha: todos os jobs são terminais.
    const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
    console.log("[C4] resumo:", resumo, "| status do evento:", await statusDoEvento(eventId));
    expect(resumo.pendentes).toBe(0);
    expect(await statusDoEvento(eventId)).toBe("completed");
  }, 120_000);

  it("CRITÉRIO 5 -- job já finalizado não é refeito (nem por novo enfileiramento, nem por tick, nem por reprocessamento sem força)", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);
    const pid = participantIds[0];
    await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });

    await rodarTick(cliente, {
      kind: "prognostico",
      worker: "prova-5-primeiro",
      trabalho: trabalhoSimulado(() => "succeeded", 10),
      config: config(),
    });
    const depoisDoSucesso = await jobDoParticipante(pid);
    expect(depoisDoSucesso.status).toBe("succeeded");
    expect(depoisDoSucesso.attempts).toBe(1);

    // 1. enfileirar de novo (clique duplo em "Processar") NÃO ressuscita.
    const reenfileiramentoIngenuo = await enfileirarJob(cliente, {
      kind: "prognostico",
      eventId,
      participantId: pid,
    });
    console.log("[C5] enfileirar de novo:", reenfileiramentoIngenuo);
    expect(reenfileiramentoIngenuo.criado).toBe(false);
    expect(reenfileiramentoIngenuo.status).toBe("succeeded");

    // 2. novo tick não reivindica o que já terminou.
    const tick2 = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "prova-5-segundo",
      trabalho: trabalhoSimulado(() => "succeeded", 10),
      config: config(),
    });
    console.log("[C5] tick depois do sucesso -> reivindicados:", tick2.reivindicados);
    expect(tick2.reivindicados).toBe(0);

    // 3. reprocessar sem força é RECUSADO pelo banco.
    const semForca = await reenfileirarJob(cliente, { id: depoisDoSucesso.id });
    console.log("[C5] reenfileirar sem força:", semForca);
    expect(semForca.aplicado).toBe(false);
    expect(semForca.statusAnterior).toBe("succeeded");

    const inalterado = await jobDoParticipante(pid);
    expect(inalterado.status).toBe("succeeded");
    expect(inalterado.attempts).toBe(1);

    // 4. com força, volta à fila -- explicitamente, por decisão humana.
    const comForca = await reenfileirarJob(cliente, { id: depoisDoSucesso.id, forcar: true });
    console.log("[C5] reenfileirar COM força:", comForca);
    expect(comForca.aplicado).toBe(true);
    const voltou = await jobDoParticipante(pid);
    expect(voltou.status).toBe("pending");
    expect(voltou.attempts).toBe(0);
  }, 90_000);

  it("CRITÉRIO 7 -- 50 jobs com concorrência 3: todos terminam, nenhum fica preso, o evento fecha", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(50);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    // Mistura realista: a maioria passa, alguns falham sempre (vão a 'failed'
    // depois de 3 tentativas), alguns são pulados (409 da 015), um estoura.
    const falhamSempre = new Set([participantIds[7], participantIds[23]]);
    const pulados = new Set([participantIds[3], participantIds[41]]);
    const estoura = new Set([participantIds[30]]);
    const plano = (pid: string) =>
      falhamSempre.has(pid)
        ? ("failed" as const)
        : pulados.has(pid)
          ? ("skipped" as const)
          : estoura.has(pid)
            ? ("excecao" as const)
            : ("succeeded" as const);

    const comeco = Date.now();
    let ticks = 0;
    let maiorConcorrenciaObservada = 0;

    for (;;) {
      // Observa a concorrência real em voo durante o tick.
      const observador = setInterval(() => {
        void psql(
          url,
          `select count(*) from public.jobs where event_id = '${eventId}' and status = 'running' and lease_expires_at > now()`
        ).then((n) => {
          maiorConcorrenciaObservada = Math.max(maiorConcorrenciaObservada, Number(n));
        }, () => {});
      }, 120);

      const r = await rodarTick(cliente, {
        kind: "prognostico",
        worker: `prova-7-tick-${ticks}`,
        trabalho: trabalhoSimulado(plano, 25),
        // maxJobsPorTick = 9 de propósito: força o tick a DEVOLVER antes de
        // drenar a fila, que é a forma real do problema em produção (teto de
        // função, não fila curta). Vários ticks seguidos têm de terminar o
        // serviço sem perder nem repetir nada -- é o que o cron faz.
        // Disjuntor DESLIGADO nesta prova de propósito: ela mede a FILA (50
        // jobs, teto de concorrência, nada preso), e o disjuntor tem provas
        // próprias. Ligado aqui, custaria duas chamadas de banco a mais por
        // job -- 100 processos psql extras só para medir outra coisa.
        config: config({
          concorrencia: 3,
          maxJobsPorTick: 9,
          orcamentoTentativasPorEvento: 0,
          orcamentoTentativasPorParticipante: 0,
        }),
      });
      clearInterval(observador);
      ticks++;

      const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
      if (resumo.pendentes === 0) break;
      if (ticks > 30) break;
      if (r.reivindicados === 0) await dormir(50);
    }

    const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
    const linhas = await jobsDoEvento(eventId);
    console.log("[C7] trabalho caro SIMULADO com espera de 25ms por job (declarado).");
    console.log("[C7] resumo:", resumo);
    console.log("[C7] ticks:", ticks, "| duração total(ms):", Date.now() - comeco);
    console.log("[C7] maior concorrência observada em voo:", maiorConcorrenciaObservada);
    console.log("[C7] status do evento:", await statusDoEvento(eventId));
    console.log(
      "[C7] rastro das falhas:",
      linhas
        .filter((l) => l.status === "failed")
        .map((l) => ({
          p: l.participant_id.slice(0, 8),
          attempts: `${l.attempts}/${l.max_attempts}`,
          codigo: l.last_error_code,
          erro: l.last_error?.slice(0, 50),
          total_duration_ms: l.total_duration_ms,
        }))
    );

    // Mais de um tick: o serviço foi terminado por ticks SUCESSIVOS, nenhum
    // deles precisando sobreviver até o fim.
    expect(ticks).toBeGreaterThan(1);
    expect(resumo.total).toBe(50);
    expect(resumo.pending).toBe(0);
    expect(resumo.running).toBe(0);
    expect(resumo.pendentes).toBe(0);
    expect(resumo.succeeded).toBe(45);
    expect(resumo.skipped).toBe(2);
    expect(resumo.failed).toBe(3);
    expect(resumo.succeeded + resumo.skipped + resumo.failed + resumo.canceled).toBe(50);
    // Nenhum job sem desfecho e nenhum sem rastro de duração.
    expect(linhas.every((l) => l.finished_at !== null)).toBe(true);
    expect(linhas.every((l) => l.total_duration_ms > 0)).toBe(true);
    expect(linhas.every((l) => l.lease_expires_at === null)).toBe(true);
    // Toda falha é rastreável: tem código e mensagem.
    expect(
      linhas.filter((l) => l.status === "failed").every((l) => l.last_error_code && l.last_error)
    ).toBe(true);
    // O teto de concorrência não foi furado.
    expect(maiorConcorrenciaObservada).toBeLessThanOrEqual(3);
    // O evento não fica em estado indefinido.
    expect(await statusDoEvento(eventId)).toBe("completed");
  }, 300_000);

  it("INDICADORES DE SAÚDE -- o alerta dispara e deixa de disparar, com limiar configurável", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(3);

    // Limiar de 2s em vez de 180s: é o mesmo código, só o valor configurado.
    //
    // Os dados no banco são sempre REAIS (nada é backdateado); o que algumas
    // leituras controlam é o relógio DO LEITOR, porque a regra de alerta é
    // aritmética sobre timestamps persistidos e, numa máquina carregada, um
    // `sleep` de 2s competindo com processos psql lentos media o ambiente em
    // vez da regra. Onde a espera é o próprio objeto do teste -- o vencimento
    // do lease -- a espera de relógio real continua lá (C3, C3b e o passo 6).
    // concorrencia 1 + maxJobsPorTick 1 para o tick processar EXATAMENTE um job
    // e deixar fila para trás: é com fila pendente que "o alerta deixou de
    // disparar" significa algo. (Com concorrencia 3 as três vagas reivindicam
    // antes de qualquer uma contar, e o teto por tick é mole -- ver doc.)
    const cfg = config({ alertaSemProgressoSegundos: 2, concorrencia: 1, maxJobsPorTick: 1 });

    // Duas formas de ler a saúde, e a distinção importa:
    //   `saude()`        -> relógio REAL. Usada quando o que se mede é o estado
    //                       de agora (há fila? houve progresso?).
    //   `saudeDaquiA(s)` -> relógio ADIANTADO. A regra de alerta é aritmética
    //                       sobre timestamps PERSISTIDOS; adiantar o relógio do
    //                       leitor mede exatamente a mesma conta sem depender de
    //                       a máquina responder dentro de 2s. Numa máquina
    //                       carregada, `sleep` + psql lento fazia a prova medir
    //                       a lentidão do ambiente em vez da regra.
    //                       A espera de relógio real continua provada onde é o
    //                       objeto do teste: o vencimento de lease (C3/C3b).
    const saude = () => lerSaudeDaFila(cliente, { kind: "prognostico", config: cfg });
    const saudeDaquiA = (segundos: number) =>
      lerSaudeDaFila(cliente, {
        kind: "prognostico",
        config: cfg,
        agora: () => Date.now() + segundos * 1000,
      });

    // --- 1. nada enfileirado: sem trabalho, sem alerta (e sem número inventado)
    const vazio = await saude();
    console.log("[SAUDE-1] fila vazia:", {
      pendentes: vazio.pendentes,
      ultimo_progresso: vazio.ultimoProgressoDoWorker.em,
      alerta: vazio.alerta.ativo,
      motivo: vazio.alerta.motivo,
    });
    expect(vazio.pendentes).toBe(0);
    expect(vazio.alerta.ativo).toBe(false);

    // --- 2. recém-enfileirado: dentro da carência, NÃO alerta
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }
    // Dentro da carência, fixado pelo instante de CRIAÇÃO do job mais antigo:
    // enfileirar 3 jobs são 3 processos psql, e sob carga isso já passava dos
    // 2s da carência -- a prova media o ambiente, não a regra.
    const cruRecem = await saude();
    const criadoEm = Date.parse(cruRecem.jobMaisAntigoNaFila!.criadoEm);
    const recem = await lerSaudeDaFila(cliente, {
      kind: "prognostico",
      config: cfg,
      agora: () => criadoEm + 1000,
    });
    console.log("[SAUDE-2] recém-enfileirado (carência):", {
      pendentes: recem.pendentes,
      mais_antigo_s: recem.jobMaisAntigoNaFila?.idadeSegundos,
      ultimo_progresso: recem.ultimoProgressoDoWorker.em,
      alerta: recem.alerta.ativo,
      motivo: recem.alerta.motivo,
    });
    expect(recem.pendentes).toBe(3);
    // O INSERT do enfileiramento NÃO conta como progresso de worker.
    expect(recem.ultimoProgressoDoWorker.em).toBeNull();
    expect(recem.alerta.ativo).toBe(false);
    expect(recem.alerta.motivo).toMatch(/carência/);

    // --- 3. agendador indisponível: ninguém roda tick nenhum -> ALERTA
    const semAgendador = await saudeDaquiA(10);
    console.log("[SAUDE-3] agendador indisponível:", {
      mais_antigo_s: semAgendador.jobMaisAntigoNaFila?.idadeSegundos,
      alerta: semAgendador.alerta.ativo,
      condicoes: semAgendador.alerta.condicoes,
      motivo: semAgendador.alerta.motivo,
    });
    expect(semAgendador.alerta.ativo).toBe(true);
    expect(semAgendador.alerta.motivo).toMatch(/NENHUM worker jamais reivindicou/);
    expect(semAgendador.alerta.condicoes).toEqual({
      temJobPendente: true,
      maisAntigoPassouDaCarencia: true,
      progressoDoWorkerVelhoOuAusente: true,
    });

    // --- 4. um tick roda (processa 1 de 3): sobra trabalho, mas há progresso -> PARA de alertar
    // A espera garante uma distância MENSURÁVEL entre a criação dos jobs e o
    // progresso do worker. As idades são comparadas em segundos inteiros, e com
    // os dois instantes a menos de meio segundo de distância o arredondamento
    // igualava "mais antigo" e "progresso" -- a prova deixava de distinguir
    // "cessou por progresso" de "cessou por carência".
    await dormir(1500);
    await rodarTick(cliente, {
      kind: "prognostico",
      worker: "saude-tick-1",
      trabalho: trabalhoSimulado(() => "succeeded", 10),
      config: cfg,
    });
    // Lido EXATAMENTE no limiar depois do progresso: nessa hora o job mais
    // antigo já passou da carência (ele é mais velho que o progresso) e o
    // progresso ainda está dentro do limiar. É a janela em que o alerta tem de
    // estar DESLIGADO por causa do progresso -- e não por carência nem por
    // fila vazia. Fixar o instante pelo timestamp persistido torna isso
    // determinístico em vez de uma corrida de 2 segundos.
    const leituraCrua = await saude();
    const instanteDoProgresso = Date.parse(leituraCrua.ultimoProgressoDoWorker.em!);
    const comProgresso = await lerSaudeDaFila(cliente, {
      kind: "prognostico",
      config: cfg,
      agora: () => instanteDoProgresso + cfg.alertaSemProgressoSegundos * 1000,
    });
    console.log("[SAUDE-4] depois de um tick (ainda há fila):", {
      pendentes: comProgresso.pendentes,
      mais_antigo_s: comProgresso.jobMaisAntigoNaFila?.idadeSegundos,
      progresso_s: comProgresso.ultimoProgressoDoWorker.idadeSegundos,
      alerta: comProgresso.alerta.ativo,
      motivo: comProgresso.alerta.motivo,
    });
    expect(comProgresso.pendentes).toBeGreaterThan(0); // o alerta cessou COM fila, não por fila vazia
    expect(comProgresso.ultimoProgressoDoWorker.idadeSegundos).not.toBeNull();
    expect(comProgresso.alerta.ativo).toBe(false);
    // Cessou pelo PROGRESSO, não por carência nem por fila vazia: as três
    // condições, separadas, provam qual delas derrubou o alerta.
    expect(comProgresso.alerta.condicoes.temJobPendente).toBe(true);
    expect(comProgresso.alerta.condicoes.maisAntigoPassouDaCarencia).toBe(true);
    expect(comProgresso.alerta.condicoes.progressoDoWorkerVelhoOuAusente).toBe(false);
    expect(comProgresso.alerta.motivo).toMatch(/com progresso de worker há/);

    // --- 5. o agendador para de novo: o alerta RE-ARMA
    const parouDeNovo = await saudeDaquiA(10);
    console.log("[SAUDE-5] agendador parou de novo:", {
      progresso_s: parouDeNovo.ultimoProgressoDoWorker.idadeSegundos,
      alerta: parouDeNovo.alerta.ativo,
      motivo: parouDeNovo.alerta.motivo,
    });
    expect(parouDeNovo.alerta.ativo).toBe(true);
    expect(parouDeNovo.alerta.motivo).toMatch(/nenhum progresso de worker há \d+s/);

    // --- 6. INDICADOR 3: tick cortado no meio (job reivindicado e abandonado)
    const [abandonado] = await reivindicarJobs(cliente, {
      kind: "prognostico",
      worker: "tick-que-foi-cortado",
      leaseSegundos: 5,
      limite: 1,
      concorrenciaMax: 3,
    });
    // Os dois instantes são fixados PELO LEASE da própria tentativa, não pelo
    // relógio de parede: com a máquina carregada, os 5s do lease venciam antes
    // de a leitura acontecer e a prova media a lentidão do ambiente.
    const venceEm = Date.parse(abandonado.leaseExpiresAt);
    const lerEm = (ms: number) =>
      lerSaudeDaFila(cliente, { kind: "prognostico", config: cfg, agora: () => ms });

    const logoDepois = await lerEm(venceEm - 1000); // lease ainda vivo
    await dormir(6000); // e o lease vence no relógio DE VERDADE também
    const depoisDoLease = await lerEm(venceEm + 5000); // lease vencido

    console.log("[SAUDE-6] tick cortado segurando um job:", {
      job: abandonado.id,
      logo_depois: {
        progresso_s: logoDepois.ultimoProgressoDoWorker.idadeSegundos,
        em_voo: logoDepois.recuperacao.emVoo,
        expirados: logoDepois.recuperacao.expirados,
        alerta: logoDepois.alerta.ativo,
      },
      depois_do_lease_vencer: {
        expirados: depoisDoLease.recuperacao.expirados,
        alerta: depoisDoLease.alerta.ativo,
        jobs_em_atencao: depoisDoLease.recuperacao.jobs.map((j) => ({
          p: j.participantId.slice(0, 8),
          status: j.status,
          tentativas: j.tentativas,
          claimed_by: j.claimedBy,
        })),
      },
    });

    // GAP MEDIDO: logo depois do corte, o indicador 1 DERIVADO parece saudável
    // (a reivindicação é escrita de worker e é recente). É exatamente o que um
    // registro literal de tick resolveria. Quem cobre esse intervalo é o
    // INDICADOR 3: assim que o lease vence, o job aparece em `expirados`.
    expect(logoDepois.recuperacao.emVoo).toBe(1);
    expect(logoDepois.recuperacao.expirados).toBe(0);
    expect(depoisDoLease.recuperacao.expirados).toBe(1);
    expect(depoisDoLease.recuperacao.jobs.some((j) => j.jobId === abandonado.id)).toBe(true);
    expect(depoisDoLease.alerta.ativo).toBe(true);
  }, 180_000);

  it("CONCORRÊNCIA ENTRE TICKS -- dois ticks sobrepostos, com leases vencendo e recuperação, não elevam o teto global", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(14);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    // Dois participantes trabalham MAIS que o lease, sem heartbeat: o lease
    // vence no meio do trabalho deles. É o que produz, no mesmo cenário,
    // expiração de lease + retomada + zumbi voltando do limbo.
    const lentos = new Set([participantIds[1], participantIds[2]]);

    let emProcesso = 0;
    let maxEmProcesso = 0;
    const trabalho: Trabalho = async (job) => {
      emProcesso++;
      maxEmProcesso = Math.max(maxEmProcesso, emProcesso);
      await dormir(lentos.has(job.participantId) ? 7000 : 60);
      emProcesso--;
      return { desfecho: "succeeded", resultado: { prognostic_id: `pg-${job.id.slice(0, 8)}` } };
    };

    // Observador INDEPENDENTE, medindo no banco (não em memória do processo):
    //   - jobs 'running' com lease VIVO  -> é o que o mecanismo de
    //     reivindicação limita, somando TODAS as invocações;
    //   - jobs 'running' no total -> pode passar de 3, porque uma linha de
    //     lease vencido continua 'running' até ser retomada.
    let maxLeaseVivo = 0;
    let maxRunning = 0;
    let amostras = 0;
    let lendo = false;
    const observador = setInterval(() => {
      if (lendo) return;
      lendo = true;
      void psql(
        url,
        `select count(*) filter (where lease_expires_at > now()) || '|' || count(*)
           from public.jobs where kind = 'prognostico' and status = 'running'`
      ).then(
        (saida) => {
          const [vivo, total] = saida.split("|").map(Number);
          maxLeaseVivo = Math.max(maxLeaseVivo, vivo);
          maxRunning = Math.max(maxRunning, total);
          amostras++;
          lendo = false;
        },
        () => {
          lendo = false;
        }
      );
    }, 120);

    const cfg = config({
      concorrencia: 3,
      leaseSegundos: 5, // mínimo que a 018 aceita
      renovarCadaMs: 0, // sem heartbeat: o lease do job lento VAI vencer
      maxJobsPorTick: 100,
      orcamentoTickMs: 60_000,
    });

    const marcas: { tick: string; inicio: number; fim: number; reivindicados: number }[] = [];
    const correr = async (nome: string, atrasoMs: number) => {
      await dormir(atrasoMs);
      const inicio = Date.now();
      const r = await rodarTick(cliente, {
        kind: "prognostico",
        worker: nome,
        trabalho,
        config: cfg,
      });
      marcas.push({ tick: nome, inicio, fim: Date.now(), reivindicados: r.reivindicados });
      return r;
    };

    // A começa; B começa 900ms DEPOIS, com A ainda rodando (é o caso real: o
    // agendador dispara de minuto em minuto e o tick anterior não terminou).
    // C começa depois de os leases dos lentos já terem vencido, para que a
    // `jobs_recuperar_expirados` dele encontre trabalho de verdade.
    const [a, b, c] = await Promise.all([
      correr("tick-A", 0),
      correr("tick-B", 900),
      correr("tick-C", 5500),
    ]);

    // Depois da sobreposição, o cron continua: ticks até drenar. É isto que
    // garante que nada fica preso (um lento na 3a tentativa pode terminar
    // 'running' com lease vencido e só a recuperação o encerra).
    let ticksDeDrenagem = 0;
    for (;;) {
      const resumoParcial = await resumoEvento(cliente, { eventId, kind: "prognostico" });
      if (resumoParcial.pendentes === 0 || ticksDeDrenagem > 15) break;
      await rodarTick(cliente, {
        kind: "prognostico",
        worker: `tick-drenagem-${ticksDeDrenagem}`,
        trabalho: trabalhoSimulado(() => "succeeded", 20),
        config: cfg,
      });
      ticksDeDrenagem++;
    }

    clearInterval(observador);
    await dormir(100);

    const marcaA = marcas.find((m) => m.tick === "tick-A")!;
    const marcaB = marcas.find((m) => m.tick === "tick-B")!;
    const marcaC = marcas.find((m) => m.tick === "tick-C")!;
    const sobreposicaoABms = Math.min(marcaA.fim, marcaB.fim) - Math.max(marcaA.inicio, marcaB.inicio);

    const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
    const linhas = await jobsDoEvento(eventId);
    const descartados = [...a.jobs, ...b.jobs, ...c.jobs].filter((j) => j.descartado);
    const recuperados = [...a.recuperados, ...b.recuperados, ...c.recuperados];

    console.log("[TICKS] janelas (ms desde o início):", {
      A: { inicio: 0, fim: marcaA.fim - marcaA.inicio, reivindicados: marcaA.reivindicados },
      B: { inicio: marcaB.inicio - marcaA.inicio, fim: marcaB.fim - marcaA.inicio, reivindicados: marcaB.reivindicados },
      C: { inicio: marcaC.inicio - marcaA.inicio, fim: marcaC.fim - marcaA.inicio, reivindicados: marcaC.reivindicados },
      sobreposicao_A_B_ms: sobreposicaoABms,
    });
    console.log("[TICKS] amostras do banco:", amostras, "| MAIOR número de jobs com LEASE VIVO:", maxLeaseVivo);
    console.log("[TICKS] maior número de linhas 'running' (inclui lease vencido):", maxRunning);
    console.log("[TICKS] maior número de trabalhos rodando DENTRO dos processos:", maxEmProcesso);
    console.log("[TICKS] recuperados por jobs_recuperar_expirados:", recuperados);
    console.log("[TICKS] desfechos DESCARTADOS pelo fencing:", descartados.map((j) => ({
      p: j.participantId.slice(0, 8), tentativa: j.tentativa, desfecho: j.desfecho,
    })));
    console.log("[TICKS] resumo final:", resumo, "| ticks de drenagem:", ticksDeDrenagem);
    console.log("[TICKS] tentativas por job (lentos são os que passam de 1):",
      linhas.map((l) => `${l.participant_id.slice(0, 8)}:${l.status}:${l.attempts}`).join(" "));

    // --- A propriedade exigida -----------------------------------------------
    // Dois ticks sobrepostos no tempo, cada um com seu pool de 3 vagas.
    expect(sobreposicaoABms).toBeGreaterThan(0);
    expect(amostras).toBeGreaterThan(5);
    // O teto é do MECANISMO DE REIVINDICAÇÃO, contado no banco sobre todas as
    // invocações -- não de um contador em memória dentro de uma função.
    expect(maxLeaseVivo).toBeLessThanOrEqual(3);
    expect(maxLeaseVivo).toBeGreaterThan(0);

    // --- Expiração e recuperação no MESMO cenário ----------------------------
    const comRetentativa = linhas.filter((l) => l.attempts > 1);
    expect(comRetentativa.length).toBeGreaterThan(0); // lease venceu e o job foi retomado
    expect(descartados.length).toBeGreaterThan(0); // zumbi voltou e foi recusado

    // --- Nada fica preso -----------------------------------------------------
    expect(resumo.total).toBe(14);
    expect(resumo.pendentes).toBe(0);
    expect(linhas.every((l) => l.finished_at !== null)).toBe(true);
    expect(linhas.every((l) => l.lease_expires_at === null)).toBe(true);
    expect(await statusDoEvento(eventId)).toBe("completed");
  }, 300_000);

  it("MIGRATION 019 -- o tick bem-sucedido é REGISTRADO; um tick cortado no meio não registra", async () => {
    const cliente = criarClientePsql(url);
    await psql(url, "delete from public.jobs_worker_heartbeat");
    const { eventId, participantIds } = await semear(3);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    const cfg = config({ concorrencia: 1, maxJobsPorTick: 1, alertaSemProgressoSegundos: 2 });
    const saude = () => lerSaudeDaFila(cliente, { kind: "prognostico", config: cfg });

    // --- antes de qualquer tick: 019 aplicada, tabela vazia -> ALERTA
    const antes = await saude();
    console.log("[019-1] antes de qualquer tick:", {
      veredito: antes.saudeDoAgendador.veredito,
      ultimo_tick_ok_em: antes.saudeDoAgendador.ultimoTickOkEm,
      ticks_ok: antes.saudeDoAgendador.ticksOk,
      nao_verificavel: antes.naoVerificavel,
      motivo: antes.saudeDoAgendador.motivo,
    });
    expect(antes.saudeDoAgendador.veredito).toBe("alerta");
    expect(antes.saudeDoAgendador.ultimoTickOkEm).toBeNull();
    expect(antes.naoVerificavel).toBe(false); // a 019 ESTÁ aplicada: é verificável

    // --- um tick inteiro: registra
    const t1 = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "agendador-1",
      trabalho: trabalhoSimulado(() => "succeeded", 10),
      config: cfg,
    });
    expect(t1.heartbeatRegistrado).toBe(true);

    const depois = await saude();
    console.log("[019-2] depois de um tick inteiro:", {
      veredito: depois.saudeDoAgendador.veredito,
      ultimo_tick_ok_em: depois.saudeDoAgendador.ultimoTickOkEm,
      idade_s: depois.saudeDoAgendador.idadeSegundos,
      ticks_ok: depois.saudeDoAgendador.ticksOk,
      worker: depois.saudeDoAgendador.worker,
      duracao_ms: depois.saudeDoAgendador.duracaoDoUltimoTickMs,
      resumo: depois.saudeDoAgendador.resumoDoUltimoTick,
      fonte: depois.saudeDoAgendador.fonte,
    });
    expect(depois.saudeDoAgendador.veredito).toBe("ok");
    expect(depois.saudeDoAgendador.ultimoTickOkEm).not.toBeNull();
    expect(depois.saudeDoAgendador.ticksOk).toBe(1);
    expect(depois.saudeDoAgendador.worker).toBe("agendador-1");
    // O derivado coexiste e continua se declarando derivado.
    expect(depois.ultimoProgressoDoWorker.tickRegistrado).toBe(false);
    expect(depois.ultimoProgressoDoWorker.fonte).toMatch(/derivado/);

    // --- segundo tick: o contador sobe (é o que diz "as execuções continuam chegando")
    await rodarTick(cliente, {
      kind: "prognostico",
      worker: "agendador-2",
      trabalho: trabalhoSimulado(() => "succeeded", 10),
      config: cfg,
    });
    const dois = await saude();
    expect(dois.saudeDoAgendador.ticksOk).toBe(2);
    const marcaAntesDoCorte = dois.saudeDoAgendador.ultimoTickOkEm;

    // --- TICK CORTADO NO MEIO: faz trabalho de verdade, mas estoura antes do fim
    const cortado = clienteQueFalhaNaEnesima(cliente, "jobs_reivindicar", 2);
    await expect(
      rodarTick(cortado, {
        kind: "prognostico",
        worker: "agendador-que-morreu",
        trabalho: trabalhoSimulado(() => "succeeded", 10),
        config: config({ concorrencia: 1, maxJobsPorTick: 5, alertaSemProgressoSegundos: 2 }),
      })
    ).rejects.toThrow();

    const depoisDoCorte = await saude();
    console.log("[019-3] depois de um tick CORTADO no meio:", {
      ticks_ok: depoisDoCorte.saudeDoAgendador.ticksOk,
      marcador_mudou: depoisDoCorte.saudeDoAgendador.ultimoTickOkEm !== marcaAntesDoCorte,
      worker_no_marcador: depoisDoCorte.saudeDoAgendador.worker,
      jobs_succeeded: (await resumoEvento(cliente, { eventId, kind: "prognostico" })).succeeded,
    });
    // O marcador NÃO andou: o tick cortado não se passa por sinal de saúde.
    expect(depoisDoCorte.saudeDoAgendador.ticksOk).toBe(2);
    expect(depoisDoCorte.saudeDoAgendador.ultimoTickOkEm).toBe(marcaAntesDoCorte);
    expect(depoisDoCorte.saudeDoAgendador.worker).toBe("agendador-2");
    // ...e ainda assim o trabalho que ele fez FOI persistido. As três
    // propriedades são distintas: trabalho persistido, trabalho executado e
    // tick concluído.
    const resumo = await resumoEvento(cliente, { eventId, kind: "prognostico" });
    expect(resumo.succeeded).toBe(3);

    // --- o agendador para: o alerta do AGENDADOR acende, com a fila VAZIA
    await dormir(3000);
    const parado = await saude();
    console.log("[019-4] agendador parado, fila vazia:", {
      pendentes: parado.pendentes,
      alerta_do_processamento: parado.alerta.ativo,
      veredito_do_agendador: parado.saudeDoAgendador.veredito,
      disparos_perdidos: parado.saudeDoAgendador.disparosEsperadosPerdidos,
      alerta_ativo: parado.alertaAtivo,
      motivo: parado.saudeDoAgendador.motivo,
    });
    expect(parado.pendentes).toBe(0);
    expect(parado.alerta.ativo).toBe(false); // processamento: nada a processar
    expect(parado.saudeDoAgendador.veredito).toBe("alerta"); // agendador: morto
    expect(parado.alertaAtivo).toBe(true);
  }, 180_000);

  it("CONSUMO -- timeout da tentativa aborta e fica PERSISTIDO com código próprio", async () => {
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);
    const pid = participantIds[0];
    await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });

    const rel = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "worker-com-teto",
      // Trabalho que ignora o sinal e duraria 5s; o teto é 200ms.
      trabalho: async () => {
        await dormir(5000);
        return { desfecho: "succeeded" };
      },
      config: config({ concorrencia: 1, timeoutTentativaMs: 200, leaseSegundos: 60 }),
    });

    const linha = await jobDoParticipante(pid);
    console.log("[CONSUMO] tentativa cortada pelo teto:", {
      abortadas_no_tick: rel.abortadas,
      status: linha.status,
      attempts: linha.attempts,
      codigo: linha.last_error_code,
      erro: linha.last_error,
      duracao_ms: linha.last_duration_ms,
    });

    // Três tentativas, TODAS cortadas pelo teto: com backoff 0 o job volta à
    // fila e é retomado no mesmo tick até esgotar `max_attempts`. Cada uma
    // teve a chamada externa ABORTADA, em vez de rodar até o fim para o
    // resultado ser descartado depois -- é exatamente o consumo que o teto
    // existe para cortar.
    expect(rel.reivindicados).toBe(3);
    expect(rel.abortadas).toBe(3);
    expect(rel.jobs.every((j) => j.codigo === "timeout_da_tentativa")).toBe(true);
    expect(rel.jobs.every((j) => j.abortada)).toBe(true);
    // E termina como falha terminal e rastreável, não como job preso.
    expect(linha.status).toBe("failed");
    expect(linha.attempts).toBe(3);
    // O rastro fica no banco: é falha RASTREÁVEL, não desaparecimento.
    expect(linha.last_error_code).toBe("timeout_da_tentativa");
    expect(linha.last_error).toMatch(/chamada externa foi encerrada/);
    // E o executor não esperou os 5s do trabalho que ignorou o sinal.
    expect(linha.last_duration_ms).toBeLessThan(2000);
  }, 120_000);

  it("ORÇAMENTO -- teto por PARTICIPANTE morde, e sobrevive ao reenfileirar FORÇADO que zera attempts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(1);
    const pid = participantIds[0];
    await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });

    const cfg = config({
      concorrencia: 1,
      orcamentoTentativasPorEvento: 100, // o teto do CTO
      orcamentoTentativasPorParticipante: 3, // o teto do CTO
      maxJobsPorTick: 10,
    });

    // Trabalho que CHEGA ao provedor (servidor local) e falha: cada tentativa
    // gasta uma tentativa externa, que é o que o livro-razão conta.
    const trabalho = trabalhoQueChamaOProvedor("falha simulada após chegar ao provedor");

    await rodarTick(cliente, {
      kind: "prognostico",
      worker: "orc-1",
      trabalho,
      config: cfg,
      ehProvedor,
    });

    const consumo1 = await resumoConsumo(cliente, { eventId, kind: "prognostico" });
    const job1 = await jobDoParticipante(pid);
    console.log("[ORC-1] depois de esgotar max_attempts:", {
      job_status: job1.status,
      job_attempts: job1.attempts,
      tentativas_externas: consumo1.tentativasExternas,
      requisicoes_despachadas: consumo1.requisicoesDespachadas,
      participantes_no_teto: consumo1.participantesNoTeto,
    });
    expect(job1.status).toBe("failed");
    expect(job1.attempts).toBe(3);
    expect(consumo1.tentativasExternas).toBe(3);

    // --- O MOMENTO DA VERDADE: reenfileirar À FORÇA, que ZERA jobs.attempts
    const forcado = await reenfileirarJob(cliente, { id: job1.id, forcar: true });
    const job2 = await jobDoParticipante(pid);
    console.log("[ORC-2] depois do reenfileirar FORÇADO:", {
      aplicado: forcado.aplicado,
      job_status: job2.status,
      job_attempts_ZERADO: job2.attempts,
      tentativas_no_livro_razao: (await resumoConsumo(cliente, { eventId, kind: "prognostico" }))
        .tentativasExternas,
    });
    expect(forcado.aplicado).toBe(true);
    expect(job2.attempts).toBe(0); // o contador do job foi zerado...
    // ...mas o livro-razão não, porque o que foi gasto não deixou de ter sido.
    const consumo2 = await resumoConsumo(cliente, { eventId, kind: "prognostico" });
    expect(consumo2.tentativasExternas).toBe(3);

    const veredito = await verificarOrcamento(cliente, {
      kind: "prognostico",
      eventId,
      participantId: pid,
      tetoEventoPadrao: 100,
      tetoParticipantePadrao: 3,
    });
    console.log("[ORC-3] veredito do disjuntor com attempts zerado:", veredito);
    expect(veredito.permitido).toBe(false);
    expect(veredito.motivo).toMatch(/participante já consumiu 3 de 3/);

    // E o tick seguinte RECUSA o job sem chamar o provedor.
    const tick = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "orc-2",
      trabalho,
      config: cfg,
      ehProvedor,
    });
    const job3 = await jobDoParticipante(pid);
    const consumo3 = await resumoConsumo(cliente, { eventId, kind: "prognostico" });
    console.log("[ORC-4] tick depois do forçado:", {
      recusados_por_orcamento: tick.recusadosPorOrcamento,
      tentativas_externas_do_tick: tick.tentativasExternas,
      job_status: job3.status,
      motivo_gravado: (job3.result as { motivo?: string } | null)?.motivo,
      tentativas_externas_totais: consumo3.tentativasExternas,
    });
    expect(tick.recusadosPorOrcamento).toBe(1);
    expect(tick.tentativasExternas).toBe(0); // NADA foi mandado ao provedor
    expect(job3.status).toBe("canceled");
    expect(consumo3.tentativasExternas).toBe(3); // o consumo não subiu
  }, 180_000);

  it("ORÇAMENTO -- teto por EVENTO morde, e a liberação excepcional AUDITADA destrava deixando rastro", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(5);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    // Teto do EVENTO em 3 para morder dentro da prova; o de participante alto,
    // para isolar qual dos dois mordeu.
    const cfg = config({
      concorrencia: 1,
      orcamentoTentativasPorEvento: 3,
      orcamentoTentativasPorParticipante: 10,
      maxJobsPorTick: 10,
    });
    const trabalho = trabalhoQueChamaOProvedor(null); // sucesso

    const tick1 = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "orc-evento-1",
      trabalho,
      config: cfg,
      ehProvedor,
    });
    const consumo1 = await resumoConsumo(cliente, { eventId, kind: "prognostico" });
    const linhas1 = await jobsDoEvento(eventId);
    console.log("[ORC-EV-1] teto do evento = 3, com 5 jobs na fila:", {
      sucesso: tick1.sucesso,
      recusados_por_orcamento: tick1.recusadosPorOrcamento,
      tentativas_externas: consumo1.tentativasExternas,
      status_dos_jobs: linhas1.map((l) => l.status).sort().join(","),
    });
    // Três passaram (gastaram), os outros foram recusados sem gastar.
    expect(consumo1.tentativasExternas).toBe(3);
    expect(tick1.sucesso).toBe(3);
    expect(tick1.recusadosPorOrcamento).toBe(2);
    expect(linhas1.filter((l) => l.status === "canceled")).toHaveLength(2);

    // --- motivo curto é RECUSADO pelo banco: sem motivo não há auditoria
    await expect(
      liberarOrcamento(cliente, {
        eventId,
        tetoEvento: 10,
        tetoParticipante: 10,
        liberadoPor: "cto@fort.test",
        motivo: "curto",
      })
    ).rejects.toThrow();

    // --- liberação excepcional AUDITADA
    const lib = await liberarOrcamento(cliente, {
      eventId,
      tetoEvento: 10,
      tetoParticipante: 10,
      liberadoPor: "cto@fort.test",
      motivo: "Evento 24/10 com 50 elegiveis: liberado ate 10 para concluir os 2 restantes.",
    });
    const trilha = await consultarJson<
      {
        liberado_por: string;
        motivo: string;
        teto_anterior_evento: number | null;
        teto_novo_evento: number;
        usado_no_momento: number;
        liberado_em: string;
      }[]
    >(
      url,
      `select json_agg(t) from (select liberado_por, motivo, teto_anterior_evento, teto_novo_evento, usado_no_momento, liberado_em from public.jobs_orcamento_liberacoes where event_id = '${eventId}') t`
    );
    console.log("[ORC-EV-2] liberação auditada:", { retorno: lib, trilha });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].liberado_por).toBe("cto@fort.test");
    expect(trilha[0].motivo).toMatch(/24\/10/);
    expect(trilha[0].teto_anterior_evento).toBeNull(); // antes era o padrão da config
    expect(trilha[0].teto_novo_evento).toBe(10);
    expect(trilha[0].usado_no_momento).toBe(3);

    // --- o teto agora é PERSISTIDO (não depende mais da variável de ambiente)
    const veredito = await verificarOrcamento(cliente, {
      kind: "prognostico",
      eventId,
      participantId: participantIds[0],
      tetoEventoPadrao: 3, // o padrão continua 3...
      tetoParticipantePadrao: 10,
    });
    console.log("[ORC-EV-3] veredito após liberação:", veredito);
    expect(veredito.tetoPersistido).toBe(true);
    expect(veredito.tetoEvento).toBe(10); // ...mas o persistido manda
    expect(veredito.permitido).toBe(true);

    // --- e o trabalho destrava: os 2 cancelados voltam e passam
    for (const l of linhas1.filter((x) => x.status === "canceled")) {
      await reenfileirarJob(cliente, { id: l.id, forcar: true });
    }
    const tick2 = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "orc-evento-2",
      trabalho,
      config: cfg,
      ehProvedor,
    });
    const consumo2 = await resumoConsumo(cliente, { eventId, kind: "prognostico" });
    console.log("[ORC-EV-4] depois da liberação:", {
      sucesso: tick2.sucesso,
      recusados: tick2.recusadosPorOrcamento,
      tentativas_externas: consumo2.tentativasExternas,
      requisicoes: consumo2.requisicoesDespachadas,
    });
    expect(tick2.sucesso).toBe(2);
    expect(tick2.recusadosPorOrcamento).toBe(0);
    expect(consumo2.tentativasExternas).toBe(5);

    // --- APPEND-ONLY, sondado como SERVICE_ROLE (o papel da aplicação).
    // Sondar como `postgres` não provaria nada: o dono da tabela pode tudo, em
    // qualquer banco relacional. Quem precisa estar barrado é o papel com que o
    // worker e as rotas escrevem.
    const adulteracao = await psql(
      url,
      `create function pg_temp.sonda(p_sql text) returns text language plpgsql as $f$
         begin
           perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
           set local role service_role;
           begin
             execute p_sql; reset role; return 'PERMITIDO';
           exception when others then reset role; return 'NEGADO:' || sqlstate;
           end;
         end $f$;
       select pg_temp.sonda($q$update public.jobs_orcamento_liberacoes set motivo = 'adulterado'$q$)
         || ' | ' || pg_temp.sonda($q$delete from public.jobs_orcamento_liberacoes$q$)
         || ' | ' || pg_temp.sonda($q$update public.jobs_consumo_externo set chamadas = 0$q$)
         || ' | ' || pg_temp.sonda($q$delete from public.jobs_consumo_externo$q$)
         || ' | INSERT(controle)=' || pg_temp.sonda(
              $q$insert into public.jobs_consumo_externo (kind, event_id, participant_id, chamadas)
                 values ('prognostico', '${eventId}', '${participantIds[0]}', 0)$q$)`
    );
    const trilhaDepois = await psql(
      url,
      `select count(*) || '|' || max(motivo) from public.jobs_orcamento_liberacoes where event_id = '${eventId}'`
    );
    console.log("[ORC-EV-5] tentativas de adulteração como service_role:", adulteracao);
    console.log("[ORC-EV-5] trilha intacta depois:", trilhaDepois);
    // Quatro negativas e UM controle positivo: se o INSERT também falhasse, a
    // prova seria "service_role não escreve nada", que não é o que se afirma.
    expect(adulteracao).toMatch(/^NEGADO:42501 \| NEGADO:42501 \| NEGADO:42501 \| NEGADO:42501 \| INSERT\(controle\)=PERMITIDO$/);
    expect(trilhaDepois).toMatch(/^1\|Evento 24\/10/);
  }, 180_000);

  it("FALHA FECHADA -- 021 ausente: o tick RECUSA sem gastar, nomeando a causa; com a 021, processa", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cliente = criarClientePsql(url);
    const { eventId, participantIds } = await semear(2);
    for (const pid of participantIds) {
      await enfileirarJob(cliente, { kind: "prognostico", eventId, participantId: pid });
    }

    const cfg = config({
      concorrencia: 1,
      orcamentoTentativasPorEvento: 100, // tetos do CTO, ligados
      orcamentoTentativasPorParticipante: 3,
      maxJobsPorTick: 5,
    });
    const trabalho = trabalhoQueChamaOProvedor(null);
    const requisicoesAntes = requisicoesRecebidas;

    // --- 021 AUSENTE. Simulada derrubando as funções que o worker chama; é
    // exatamente o que o app vê num ambiente onde a migration não foi aplicada.
    await psql(
      url,
      `drop function if exists public.jobs_consumo_resumo(uuid,text);
       drop function if exists public.jobs_orcamento_verificar(text,uuid,uuid,int,int);
       drop function if exists public.jobs_consumo_registrar(text,uuid,uuid,int,boolean,text,uuid,uuid);`
    );

    const bloqueado = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "worker-sem-021",
      trabalho,
      config: cfg,
      ehProvedor,
    });
    const saudeBloqueada = await lerSaudeDaFila(cliente, { kind: "prognostico", config: cfg });
    const linhasBloqueado = await jobsDoEvento(eventId);

    console.log("[FECHADO-1] tick com a 021 AUSENTE:", {
      reivindicados: bloqueado.reivindicados,
      tentativas_externas: bloqueado.tentativasExternas,
      requisicoes_ao_provedor: bloqueado.requisicoesAoProvedor,
      requisicoes_que_o_provedor_recebeu: requisicoesRecebidas - requisicoesAntes,
      motivo_de_parada: bloqueado.motivoDeParada,
      codigo: bloqueado.bloqueioDeOrcamento?.codigo,
      heartbeat_registrado: bloqueado.heartbeatRegistrado,
      jobs_intactos: linhasBloqueado.map((l) => `${l.status}:attempts=${l.attempts}`).join(" "),
    });
    console.log(
      "[FECHADO-2] mensagem que o HOST lê:\n  " + bloqueado.bloqueioDeOrcamento?.mensagemParaOperacao
    );
    console.log("[FECHADO-3] painel de saúde nomeando a causa:", {
      processamento_bloqueado: saudeBloqueada.processamentoBloqueado,
      alerta_ativo: saudeBloqueada.alertaAtivo,
      orcamento_veredito: saudeBloqueada.saudeDoOrcamento.veredito,
      orcamento_codigo: saudeBloqueada.saudeDoOrcamento.codigo,
      orcamento_motivo: saudeBloqueada.saudeDoOrcamento.motivo,
      pendentes: saudeBloqueada.pendentes,
    });

    // NADA foi gasto, e o provedor nem foi procurado.
    expect(bloqueado.reivindicados).toBe(0);
    expect(bloqueado.tentativasExternas).toBe(0);
    expect(bloqueado.requisicoesAoProvedor).toBe(0);
    expect(requisicoesRecebidas - requisicoesAntes).toBe(0);
    // A causa é NOMEADA e diz o que fazer.
    expect(bloqueado.motivoDeParada).toBe("bloqueio_de_orcamento");
    expect(bloqueado.bloqueioDeOrcamento?.codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    expect(bloqueado.bloqueioDeOrcamento?.mensagemParaOperacao).toMatch(/migration 021/);
    expect(bloqueado.bloqueioDeOrcamento?.mensagemParaOperacao).toMatch(/BLOQUEADO/);
    expect(bloqueado.bloqueioDeOrcamento?.mensagemParaOperacao).toMatch(/NÃO é fila vazia/);
    // Nenhum job foi tocado: tentativa nenhuma foi queimada por falta de migration.
    expect(linhasBloqueado.every((l) => l.status === "pending" && l.attempts === 0)).toBe(true);
    // Um tick que se recusou a trabalhar não vale como agendador saudável.
    expect(bloqueado.heartbeatRegistrado).toBe(false);
    // E o painel distingue bloqueio de fila vazia: há 2 pendentes.
    expect(saudeBloqueada.processamentoBloqueado).toBe(true);
    expect(saudeBloqueada.alertaAtivo).toBe(true);
    expect(saudeBloqueada.saudeDoOrcamento.veredito).toBe("bloqueado");
    expect(saudeBloqueada.saudeDoOrcamento.codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    expect(saudeBloqueada.saudeDoOrcamento.motivo).toMatch(/não por fila vazia/);
    expect(saudeBloqueada.pendentes).toBe(2);

    // --- 021 PRESENTE: CONTROLE POSITIVO. Sem isto, a prova acima seria só
    // "não processa nada", que um bug qualquer também produziria.
    await psqlArquivo(url, "supabase/migrations/021_orcamento_consumo_externo.sql");

    const normal = await rodarTick(cliente, {
      kind: "prognostico",
      worker: "worker-com-021",
      trabalho,
      config: cfg,
      ehProvedor,
    });
    const saudeNormal = await lerSaudeDaFila(cliente, { kind: "prognostico", config: cfg });
    const consumo = await resumoConsumo(cliente, { eventId, kind: "prognostico" });

    console.log("[FECHADO-4] mesmo tick com a 021 APLICADA (controle positivo):", {
      sucesso: normal.sucesso,
      tentativas_externas: normal.tentativasExternas,
      requisicoes_ao_provedor: normal.requisicoesAoProvedor,
      requisicoes_que_o_provedor_recebeu: requisicoesRecebidas - requisicoesAntes,
      bloqueio: normal.bloqueioDeOrcamento,
      heartbeat_registrado: normal.heartbeatRegistrado,
      consumo_no_livro_razao: consumo.tentativasExternas,
      orcamento_veredito: saudeNormal.saudeDoOrcamento.veredito,
      processamento_bloqueado: saudeNormal.processamentoBloqueado,
    });

    expect(normal.bloqueioDeOrcamento).toBeNull();
    expect(normal.sucesso).toBe(2);
    expect(normal.tentativasExternas).toBe(2);
    expect(requisicoesRecebidas - requisicoesAntes).toBe(2);
    expect(consumo.tentativasExternas).toBe(2);
    expect(normal.heartbeatRegistrado).toBe(true);
    expect(saudeNormal.saudeDoOrcamento.veredito).toBe("ok");
    expect(saudeNormal.processamentoBloqueado).toBe(false);
    vi.restoreAllMocks();
  }, 180_000);

  it("CRITÉRIO 6 -- participante não enxerga job nenhum; admin enxerga; só service_role escreve", async () => {
    const saida = await psqlArquivo(url, new globalThis.URL("./rls-jobs.sql", import.meta.url).pathname);
    console.log(saida);
    const linhas = saida.split("\n").filter((l) => l.trim().length > 0);
    const falhas = linhas.filter((l) => l.startsWith("[FALHA]"));
    const oks = linhas.filter((l) => l.startsWith("[ok  ]"));
    expect(oks.length).toBeGreaterThan(0);
    expect(falhas).toEqual([]);
  }, 60_000);
});
