import { describe, expect, it } from "vitest";
import {
  faseDaJanela,
  fasePermiteResponder,
  formatarMomento,
  formatarRestante,
  janelaDeIso,
  limitesDaJanela,
  proximaMudanca,
} from "./janela-da-etapa";

const MIN = 60_000;
// T = meia-noite de Brasilia (UTC-3): 22/10 00:00 BRT = 21/10 03:00Z.
const T = Date.parse("2026-10-22T03:00:00Z");
const abre = T - 3 * 24 * 60 * MIN;
const janela = { abre, fecha: T };
const hora = (h: number, m: number) => T + ((h - 24) * 60 + m) * MIN; // 23h40 => T-20min

describe("faseDaJanela -- regras da 010", () => {
  it("caso canonico: abriu as 23h40 envia as 00h05; tentar abrir as 23h50 e recusado", () => {
    // Abrir as 23h40 (T-20): permitido.
    expect(faseDaJanela(hora(23, 40), janela, false)).toBe("aberta");
    // Com a etapa iniciada, as 00h05 (T+5): tolerancia, pode enviar.
    const as0005 = T + 5 * MIN;
    expect(faseDaJanela(as0005, janela, true)).toBe("tolerancia");
    expect(fasePermiteResponder("tolerancia")).toBe(true);
    // Tentar abrir as 23h50 (T-10): recusado.
    expect(faseDaJanela(hora(23, 50), janela, false)).toBe("nao_inicia_mais");
    expect(fasePermiteResponder("nao_inicia_mais")).toBe(false);
  });

  it("limites inclusivos, como no banco", () => {
    expect(faseDaJanela(T - 15 * MIN, janela, false)).toBe("aberta"); // now <= T-15
    expect(faseDaJanela(T - 15 * MIN + 1, janela, false)).toBe("nao_inicia_mais");
    expect(faseDaJanela(T - 15 * MIN + 1, janela, true)).toBe("reta_final");
    expect(faseDaJanela(T, janela, true)).toBe("reta_final");
    expect(faseDaJanela(T + 1, janela, true)).toBe("tolerancia");
    expect(faseDaJanela(T + 15 * MIN, janela, true)).toBe("tolerancia"); // now <= T+15
    expect(faseDaJanela(T + 15 * MIN + 1, janela, true)).toBe("encerrada");
    expect(faseDaJanela(T + 15 * MIN + 1, janela, false)).toBe("encerrada");
  });

  it("antes de form_opens_at nada vale; sem fechamento a janela nunca fecha", () => {
    expect(faseDaJanela(abre - 1, janela, false)).toBe("ainda_nao_abriu");
    expect(faseDaJanela(abre, janela, false)).toBe("aberta");
    const sem = { abre: null, fecha: null };
    expect(faseDaJanela(Date.parse("2099-01-01T00:00:00Z"), sem, false)).toBe("aberta");
  });

  it("so as fases com etapa iniciada ou aberta deixam responder", () => {
    expect(fasePermiteResponder("aberta")).toBe(true);
    expect(fasePermiteResponder("reta_final")).toBe(true);
    expect(fasePermiteResponder("tolerancia")).toBe(true);
    expect(fasePermiteResponder("ainda_nao_abriu")).toBe(false);
    expect(fasePermiteResponder("nao_inicia_mais")).toBe(false);
    expect(fasePermiteResponder("encerrada")).toBe(false);
  });
});

describe("limites e proximaMudanca", () => {
  it("T-15 e T+15", () => {
    const l = limitesDaJanela(janela);
    expect(l.ultimoInicio).toBe(T - 15 * MIN);
    expect(l.ultimoEnvio).toBe(T + 15 * MIN);
  });
  it("devolve o proximo marco, ou null depois do ultimo", () => {
    expect(proximaMudanca(T - 20 * MIN, janela)).toBe(T - 15 * MIN);
    expect(proximaMudanca(T - 1 * MIN, janela)).toBe(T);
    expect(proximaMudanca(T + 16 * MIN, janela)).toBeNull();
  });
  it("data ilegivel e erro, nao 'sem limite'", () => {
    expect(() => janelaDeIso("amanha", null)).toThrow();
    expect(janelaDeIso(null, null)).toEqual({ abre: null, fecha: null });
  });
});

describe("apresentacao", () => {
  it("horario de Brasilia, com dia so quando muda", () => {
    expect(formatarMomento(T - 15 * MIN, T - 20 * MIN)).toBe("às 23h45");
    expect(formatarMomento(T + 15 * MIN, T - 20 * MIN)).toBe("em 22/10 às 00h15");
    expect(formatarMomento(T + 15 * MIN, T - 20 * MIN, "até")).toBe("até 22/10 às 00h15");
    expect(formatarMomento(T - 15 * MIN, T - 20 * MIN, "até")).toBe("até às 23h45");
    // Mesmo instante, independente do fuso do aparelho (o calculo usa fuso fixo).
    expect(formatarMomento(Date.parse("2026-10-21T15:30:00Z"), Date.parse("2026-10-21T14:00:00Z"))).toBe(
      "às 12h30",
    );
  });
  it("tempo restante legivel e nunca negativo", () => {
    expect(formatarRestante(12 * MIN + 5000)).toBe("12 min 05 s");
    expect(formatarRestante(45_000)).toBe("45 s");
    expect(formatarRestante(3_900_000)).toBe("1 h 05 min");
    expect(formatarRestante(-5000)).toBe("0 s");
  });
});
