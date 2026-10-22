import { describe, expect, it } from "vitest";
import { criarClienteDeFilaFalso } from "./cliente-falso";
import {
  ErroDeFila,
  concluirJob,
  enfileirarJob,
  falharJob,
  recuperarExpirados,
  reivindicarJobs,
  renovarLease,
  resumoEvento,
  type ClienteFila,
} from "./fila";

const cliente = (m: Parameters<typeof criarClienteDeFilaFalso>[0]) =>
  criarClienteDeFilaFalso(m) as unknown as ClienteFila & {
    chamadas: { funcao: string; args: Record<string, unknown> }[];
  };

describe("fila: tradução do contrato das funções da 018", () => {
  it("erro de RPC vira exceção com o nome da função, nunca silêncio", async () => {
    const c = cliente({
      jobs_reivindicar: () => ({ data: null, error: { message: "permission denied" } }),
    });

    // Engolir este erro recriaria o defeito que a fila existe para remover:
    // falha que não aparece em lugar nenhum.
    await expect(
      reivindicarJobs(c, {
        kind: "prognostico",
        worker: "w",
        leaseSegundos: 60,
        limite: 1,
        concorrenciaMax: 3,
      })
    ).rejects.toThrow(ErroDeFila);
    await expect(
      reivindicarJobs(c, {
        kind: "prognostico",
        worker: "w",
        leaseSegundos: 60,
        limite: 1,
        concorrenciaMax: 3,
      })
    ).rejects.toThrow(/jobs_reivindicar: permission denied/);
  });

  it("reivindicar mapeia as colunas do banco e passa os parâmetros com os nomes da 018", async () => {
    const c = cliente({
      jobs_reivindicar: () => ({
        data: [
          {
            id: "job-1",
            participant_id: "p-1",
            event_id: "e-1",
            run_token: "tok-1",
            attempts: 2,
            max_attempts: 3,
            lease_expires_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      }),
    });

    const jobs = await reivindicarJobs(c, {
      kind: "prognostico",
      worker: "worker-x",
      leaseSegundos: 90,
      limite: 2,
      concorrenciaMax: 3,
    });

    expect(jobs).toEqual([
      {
        id: "job-1",
        participantId: "p-1",
        eventId: "e-1",
        runToken: "tok-1",
        attempts: 2,
        maxAttempts: 3,
        leaseExpiresAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(c.chamadas[0].args).toEqual({
      p_kind: "prognostico",
      p_worker: "worker-x",
      p_lease_seconds: 90,
      p_limit: 2,
      p_concorrencia_max: 3,
    });
  });

  it("fila vazia é array vazio, não erro", async () => {
    const c = cliente({ jobs_reivindicar: () => ({ data: [], error: null }) });
    await expect(
      reivindicarJobs(c, {
        kind: "prognostico",
        worker: "w",
        leaseSegundos: 60,
        limite: 1,
        concorrenciaMax: 3,
      })
    ).resolves.toEqual([]);
  });

  it("concluir devolve o booleano do fencing e manda null explícito quando não há resultado", async () => {
    const c = cliente({ jobs_concluir: () => ({ data: false, error: null }) });

    // false = o banco recusou porque o run_token já não é o vigente. Tem de
    // chegar ao chamador como false, não como sucesso.
    await expect(
      concluirJob(c, { id: "j", runToken: "t", status: "succeeded" })
    ).resolves.toBe(false);
    expect(c.chamadas[0].args).toEqual({
      p_id: "j",
      p_run_token: "t",
      p_status: "succeeded",
      p_result: null,
      p_ai_usage: null,
    });
  });

  it("resposta fora do contrato (não-booleano onde a 018 devolve boolean) é ERRO, não 'false'", async () => {
    // Tratar lixo como false faria o worker achar que foi descartado quando o
    // problema é outro -- e mandaria o diagnóstico para o lado errado.
    const c = cliente({ jobs_renovar_lease: () => ({ data: "sim", error: null }) });
    await expect(
      renovarLease(c, { id: "j", runToken: "t", leaseSegundos: 60 })
    ).rejects.toThrow(/esperava boolean/);
  });

  it("falhar mapeia aplicado/status/attempts, inclusive a recusa do fencing", async () => {
    const aplicado = cliente({
      jobs_falhar: () => ({ data: [{ aplicado: true, status: "pending", attempts: 2 }], error: null }),
    });
    await expect(
      falharJob(aplicado, { id: "j", runToken: "t", erro: "x", backoffSegundos: 30 })
    ).resolves.toEqual({ aplicado: true, status: "pending", attempts: 2 });

    const recusado = cliente({
      jobs_falhar: () => ({ data: [{ aplicado: false, status: null, attempts: null }], error: null }),
    });
    await expect(
      falharJob(recusado, { id: "j", runToken: "t", erro: "x", backoffSegundos: 30 })
    ).resolves.toEqual({ aplicado: false, status: null, attempts: null });
  });

  it("enfileirar distingue job criado de job reaproveitado", async () => {
    const criado = cliente({
      jobs_enfileirar: () => ({ data: [{ id: "j1", status: "pending", criado: true }], error: null }),
    });
    await expect(
      enfileirarJob(criado, { kind: "prognostico", eventId: "e", participantId: "p" })
    ).resolves.toEqual({ id: "j1", status: "pending", criado: true });

    // Reaproveitado com status terminal: é o que impede clique duplo em
    // "Processar" de refazer trabalho pago.
    const existente = cliente({
      jobs_enfileirar: () => ({
        data: [{ id: "j1", status: "succeeded", criado: false }],
        error: null,
      }),
    });
    await expect(
      enfileirarJob(existente, { kind: "prognostico", eventId: "e", participantId: "p" })
    ).resolves.toEqual({ id: "j1", status: "succeeded", criado: false });
  });

  it("recuperar expirados mapeia novo_status", async () => {
    const c = cliente({
      jobs_recuperar_expirados: () => ({
        data: [
          { id: "j1", novo_status: "pending", attempts: 1 },
          { id: "j2", novo_status: "failed", attempts: 3 },
        ],
        error: null,
      }),
    });
    await expect(recuperarExpirados(c, { kind: "prognostico", limite: 100 })).resolves.toEqual([
      { id: "j1", novoStatus: "pending", attempts: 1 },
      { id: "j2", novoStatus: "failed", attempts: 3 },
    ]);
  });

  it("resumo de evento sem job nenhum devolve zeros em vez de estourar", async () => {
    const c = cliente({ jobs_resumo_evento: () => ({ data: [], error: null }) });
    await expect(resumoEvento(c, { eventId: "e", kind: "prognostico" })).resolves.toEqual({
      total: 0,
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
      pendentes: 0,
      totalDuracaoMs: 0,
      tentativasTotal: 0,
    });
  });
});
