import { afterEach, describe, expect, it } from "vitest";
import { lerConfigFila } from "./config";

const originais = { ...process.env };

afterEach(() => {
  for (const chave of Object.keys(process.env)) {
    if (chave.startsWith("JOBS_")) delete process.env[chave];
  }
  Object.assign(process.env, originais);
});

describe("config da fila", () => {
  it("o padrão é concorrência 3, a decidida antes de medir", () => {
    const c = lerConfigFila();
    expect(c.concorrencia).toBe(3);
    expect(c.leaseSegundos).toBe(180);
  });

  it("o heartbeat é um terço do lease, nunca perto do vencimento", () => {
    // Renovar perto do vencimento deixaria uma pausa de GC ou um pico de
    // latência vencer o lease com o worker vivo -- e outro worker refaria um
    // trabalho que está em andamento (crédito de IA gasto duas vezes).
    process.env.JOBS_LEASE_SECONDS = "90";
    const c = lerConfigFila();
    expect(c.renovarCadaMs).toBe(30_000);
    expect(c.renovarCadaMs * 2).toBeLessThan(c.leaseSegundos * 1000);
  });

  it("o orçamento do tick cabe com folga no maxDuration de 300s da rota", () => {
    const c = lerConfigFila();
    expect(c.orcamentoTickMs).toBeLessThanOrEqual(280_000);
  });

  it("valor inválido ESTOURA em vez de virar padrão silencioso", () => {
    // Um teto de concorrência que ninguém escolheu é exatamente o tipo de
    // configuração invisível que esta unidade existe para eliminar.
    process.env.JOBS_CONCURRENCY = "abacaxi";
    expect(() => lerConfigFila()).toThrow(/JOBS_CONCURRENCY/);

    process.env.JOBS_CONCURRENCY = "0";
    expect(() => lerConfigFila()).toThrow(/entre 1 e 50/);

    process.env.JOBS_CONCURRENCY = "999";
    expect(() => lerConfigFila()).toThrow(/entre 1 e 50/);
  });

  it("lease curto demais é recusado aqui, antes de o banco recusar", () => {
    process.env.JOBS_LEASE_SECONDS = "5";
    expect(() => lerConfigFila()).toThrow(/JOBS_LEASE_SECONDS/);
  });

  it("o limiar do alerta é configurável, com o padrão nos 3 minutos da regra inicial", () => {
    expect(lerConfigFila().alertaSemProgressoSegundos).toBe(180);
    process.env.JOBS_ALERT_NO_PROGRESS_SECONDS = "90";
    expect(lerConfigFila().alertaSemProgressoSegundos).toBe(90);
  });

  it("limiar menor ou igual ao backoff é RECUSADO: a espera normal viraria alerta", () => {
    // Uma fila esperando legitimamente o backoff não escreve nada no banco. Com
    // limiar abaixo do backoff, todo reprocessamento normal acenderia o alerta,
    // e um alerta que grita sem motivo deixa de ser lido.
    process.env.JOBS_BACKOFF_SECONDS = "120";
    process.env.JOBS_ALERT_NO_PROGRESS_SECONDS = "60";
    expect(() => lerConfigFila()).toThrow(/tem de ser maior que/);
  });

  it("a janela de falhas do painel é configurável (total histórico não é sinal)", () => {
    expect(lerConfigFila().janelaFalhasHoras).toBe(24);
    process.env.JOBS_HEALTH_FAILURE_WINDOW_HOURS = "6";
    expect(lerConfigFila().janelaFalhasHoras).toBe(6);
  });

  it("o disjuntor nasce LIGADO nos números decididos: 100 por evento, 3 por participante", () => {
    // Antes eu deixei em 0 (desligado) dizendo que qualquer número seria um
    // teto que ninguém mediu. O responsável técnico decidiu: 100 por evento
    // (50 elegíveis) e 3 por participante, para o evento de 24/10/2026. É
    // limite OPERACIONAL inicial, não teto monetário.
    const c = lerConfigFila();
    expect(c.orcamentoTentativasPorEvento).toBe(100);
    expect(c.orcamentoTentativasPorParticipante).toBe(3);
  });

  it("os dois tetos do disjuntor são configuráveis, e 0 desliga cada um", () => {
    process.env.JOBS_BUDGET_ATTEMPTS_PER_EVENT = "250";
    process.env.JOBS_BUDGET_ATTEMPTS_PER_PARTICIPANT = "0";
    const c = lerConfigFila();
    expect(c.orcamentoTentativasPorEvento).toBe(250);
    expect(c.orcamentoTentativasPorParticipante).toBe(0);
  });

  it("o timeout da tentativa nasce ABAIXO do horizonte seguro do lease", () => {
    const c = lerConfigFila();
    expect(c.timeoutTentativaMs).toBe(c.leaseSegundos * 1000 - c.renovarCadaMs);
    expect(c.timeoutTentativaMs).toBeLessThan(c.leaseSegundos * 1000);
  });

  it("timeout acima do horizonte seguro do lease é RECUSADO", () => {
    // Acima disso o lease pode vencer com a chamada ao modelo ainda viva --
    // exatamente o consumo que o teto existe para cortar.
    process.env.JOBS_ATTEMPT_TIMEOUT_MS = "175000"; // lease 180s, renovação 60s
    expect(() => lerConfigFila()).toThrow(/horizonte seguro do lease/);
  });

  it("o orçamento de chamadas do tick acompanha o teto de jobs por padrão", () => {
    const c = lerConfigFila();
    expect(c.orcamentoChamadasPorTick).toBe(c.maxJobsPorTick);
    process.env.JOBS_BUDGET_CALLS_PER_TICK = "5";
    expect(lerConfigFila().orcamentoChamadasPorTick).toBe(5);
  });

  it("concorrência configurável (é para ser calibrada depois de medir)", () => {
    process.env.JOBS_CONCURRENCY = "6";
    expect(lerConfigFila().concorrencia).toBe(6);
  });
});
