import { describe, expect, it, vi } from "vitest";
import { criarClienteDeFilaFalso, type Manipulador } from "./cliente-falso";
import { executarJob, type SinalDeLease } from "./executor";
import type { ClienteFila, JobReivindicado } from "./fila";

const job: JobReivindicado = {
  id: "job-1",
  participantId: "p-1",
  eventId: "e-1",
  runToken: "tok-1",
  attempts: 1,
  maxAttempts: 3,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const opcoes = { leaseSegundos: 60, renovarCadaMs: 0, backoffSegundos: 30 };

function cliente(m: Record<string, Manipulador>) {
  return criarClienteDeFilaFalso(m) as unknown as ClienteFila & {
    chamadas: { funcao: string; args: Record<string, unknown> }[];
    ordem: string[];
  };
}

const ok: Record<string, Manipulador> = {
  jobs_concluir: () => ({ data: true, error: null }),
  jobs_falhar: () => ({ data: [{ aplicado: true, status: "pending", attempts: 1 }], error: null }),
  jobs_renovar_lease: () => ({ data: true, error: null }),
};

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("executor: desfecho, fencing e heartbeat", () => {
  it("sucesso grava jobs_concluir com status succeeded e o resultado", async () => {
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => ({ desfecho: "succeeded", resultado: { prognostic_id: "pg-1" } }),
      opcoes
    );

    expect(rel.desfecho).toBe("succeeded");
    expect(rel.gravado).toBe(true);
    expect(rel.descartado).toBe(false);
    expect(rel.statusFinal).toBe("succeeded");
    expect(c.chamadas[0].args).toMatchObject({
      p_id: "job-1",
      p_run_token: "tok-1",
      p_status: "succeeded",
      p_result: { prognostic_id: "pg-1" },
    });
  });

  it("pulado vai por jobs_concluir com status skipped, NÃO por jobs_falhar", async () => {
    // O 409 da 015 não é falha. Mandá-lo para jobs_falhar inflaria o número de
    // falhas em todo reprocessamento e esconderia as falhas reais.
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => ({ desfecho: "skipped", motivo: "já está em delivered" }),
      opcoes
    );

    expect(rel.desfecho).toBe("skipped");
    expect(rel.gravado).toBe(true);
    expect(c.ordem).toEqual(["jobs_concluir"]);
    expect(c.chamadas[0].args).toMatchObject({
      p_status: "skipped",
      p_result: { motivo: "já está em delivered" },
    });
  });

  it("falha vai por jobs_falhar com código e backoff", async () => {
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => ({ desfecho: "failed", erro: "IA recusou", codigo: "http_502" }),
      opcoes
    );

    expect(rel.desfecho).toBe("failed");
    expect(rel.gravado).toBe(true);
    expect(rel.statusFinal).toBe("pending"); // reagendado: ainda há tentativa
    expect(c.chamadas[0].args).toMatchObject({
      p_erro: "IA recusou",
      p_codigo: "http_502",
      p_backoff_seconds: 30,
    });
  });

  it("exceção não tratada do trabalho vira falha REGISTRADA, não desaparecimento", async () => {
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => {
        throw new Error("socket hang up");
      },
      opcoes
    );

    expect(rel.desfecho).toBe("failed");
    expect(rel.gravado).toBe(true);
    expect(rel.codigo).toBe("excecao");
    expect(c.chamadas[0].args).toMatchObject({ p_codigo: "excecao", p_erro: "socket hang up" });
  });

  it("FENCING: concluir recusado (token velho) é relatado como DESCARTADO, não como sucesso", async () => {
    const c = cliente({ ...ok, jobs_concluir: () => ({ data: false, error: null }) });
    const rel = await executarJob(
      c,
      job,
      async () => ({ desfecho: "succeeded", resultado: { prognostic_id: "pg-do-zumbi" } }),
      opcoes
    );

    expect(rel.gravado).toBe(false);
    expect(rel.descartado).toBe(true);
    expect(rel.statusFinal).toBeNull();
  });

  it("FENCING: falha recusada também é relatada como descartada", async () => {
    const c = cliente({
      ...ok,
      jobs_falhar: () => ({ data: [{ aplicado: false, status: null, attempts: null }], error: null }),
    });
    const rel = await executarJob(
      c,
      job,
      async () => ({ desfecho: "failed", erro: "qualquer" }),
      opcoes
    );

    expect(rel.gravado).toBe(false);
    expect(rel.descartado).toBe(true);
  });

  it("lease recusado pelo banco ABORTA a tentativa e não espera o trabalho perceber", async () => {
    // Antes, `perdido` era só uma flag que o trabalho PODIA consultar -- e uma
    // chamada de streaming de ~63s não tem ponto de checagem nenhum entre o
    // pedido e a resposta. Agora o executor aborta o signal da tentativa (que
    // está amarrado ao fetch) e decide o desfecho na hora. É isso que corta o
    // consumo de tokens, em vez de deixá-lo rodar até o fim para o fencing
    // recusar o resultado depois.
    const c = cliente({ ...ok, jobs_renovar_lease: () => ({ data: false, error: null }) });

    let capturado: SinalDeLease | null = null;
    const comeco = Date.now();
    const rel = await executarJob(
      c,
      job,
      async (_j, sinal) => {
        capturado = sinal;
        await dormir(3000); // trabalho que IGNORA o sinal, de propósito
        return { desfecho: "succeeded" };
      },
      { ...opcoes, renovarCadaMs: 10 }
    );
    const decorrido = Date.now() - comeco;

    expect(rel.leasePerdido).toBe(true);
    expect(rel.abortada).toBe(true);
    expect(rel.desfecho).toBe("failed");
    expect(rel.codigo).toBe("lease_perdido_abortado");
    expect(rel.erro).toMatch(/chamada externa foi encerrada/);
    // O signal entregue ao trabalho foi realmente abortado.
    expect(capturado!.signal.aborted).toBe(true);
    expect(capturado!.perdido).toBe(true);
    // E o executor NÃO ficou preso os 3s do trabalho que ignorou o sinal.
    expect(decorrido).toBeLessThan(1500);
    // Uma recusa basta: depois dela o heartbeat para de reagendar.
    expect(c.ordem.filter((f) => f === "jobs_renovar_lease")).toHaveLength(1);
  });

  it("timeout da tentativa aborta e vira falha com código próprio", async () => {
    const c = cliente(ok);
    let capturado: SinalDeLease | null = null;
    const rel = await executarJob(
      c,
      job,
      async (_j, sinal) => {
        capturado = sinal;
        await dormir(3000);
        return { desfecho: "succeeded" };
      },
      { ...opcoes, timeoutTentativaMs: 80 }
    );

    expect(rel.desfecho).toBe("failed");
    expect(rel.abortada).toBe(true);
    expect(rel.codigo).toBe("timeout_da_tentativa");
    expect(rel.erro).toMatch(/80ms/);
    expect(capturado!.signal.aborted).toBe(true);
    // A falha é GRAVADA: timeout não é desaparecimento.
    expect(rel.gravado).toBe(true);
  });

  it("trabalho que termina dentro do timeout não é afetado", async () => {
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => {
        await dormir(20);
        return { desfecho: "succeeded" };
      },
      { ...opcoes, timeoutTentativaMs: 2000 }
    );
    expect(rel.desfecho).toBe("succeeded");
    expect(rel.abortada).toBe(false);
    expect(rel.gravado).toBe(true);
  });

  it("heartbeat: falha de REDE na renovação não aborta trabalho bom (tenta de novo)", async () => {
    // Marcar 'perdido' por um soluço de conexão jogaria fora uma geração que
    // custou ~63s e um crédito de modelo. Se o lease realmente venceu, o
    // fencing recusa a gravação no fim -- e aí sim aparece como descartado.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = cliente({
      ...ok,
      jobs_renovar_lease: () => ({ data: null, error: { message: "ECONNRESET" } }),
    });

    let viuPerdido: boolean | null = null;
    const rel = await executarJob(
      c,
      job,
      async (_j, sinal) => {
        await dormir(60);
        viuPerdido = sinal.perdido;
        return { desfecho: "succeeded" };
      },
      { ...opcoes, renovarCadaMs: 10 }
    );

    expect(viuPerdido).toBe(false);
    expect(rel.leasePerdido).toBe(false);
    expect(rel.gravado).toBe(true);
    // Tentou renovar mais de uma vez: não desistiu no primeiro erro de rede.
    expect(c.ordem.filter((f) => f === "jobs_renovar_lease").length).toBeGreaterThan(1);
    vi.restoreAllMocks();
  });

  it("heartbeat para quando o trabalho termina (não vaza timer)", async () => {
    const c = cliente(ok);
    await executarJob(c, job, async () => ({ desfecho: "succeeded" }), {
      ...opcoes,
      renovarCadaMs: 10,
    });
    const antes = c.ordem.filter((f) => f === "jobs_renovar_lease").length;
    await dormir(60);
    expect(c.ordem.filter((f) => f === "jobs_renovar_lease").length).toBe(antes);
  });

  it("erro ao GRAVAR o desfecho é relatado (gravado=false) e deixado para o lease recuperar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = cliente({
      ...ok,
      jobs_concluir: () => ({ data: null, error: { message: "timeout no banco" } }),
    });
    const rel = await executarJob(c, job, async () => ({ desfecho: "succeeded" }), opcoes);

    expect(rel.gravado).toBe(false);
    // Não é descarte por fencing: é tentativa SEM desfecho, que o lease retoma.
    expect(rel.descartado).toBe(false);
    expect(rel.codigo).toBe("gravacao_do_desfecho");
    expect(rel.erro).toMatch(/timeout no banco/);
    vi.restoreAllMocks();
  });

  it("o relatório carrega participante, tentativa e duração", async () => {
    const c = cliente(ok);
    const rel = await executarJob(
      c,
      job,
      async () => {
        await dormir(30);
        return { desfecho: "succeeded" };
      },
      opcoes
    );
    expect(rel.participantId).toBe("p-1");
    expect(rel.eventId).toBe("e-1");
    expect(rel.tentativa).toBe(1);
    expect(rel.duracaoMs).toBeGreaterThanOrEqual(25);
  });
});
