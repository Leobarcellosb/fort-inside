// O LIMIAR, nos dois lados de cada bloco -- sem banco, sem SDK, sem Docker.
//
// A prova de ponta a ponta (gerador de producao, Postgres pelas migrations,
// PostgREST, canario no lugar do modelo) esta em
// `tests/jornada-individual/cadeia-pos-coleta.test.ts`. Esta aqui mede o
// NUMERO: qual combinacao de perguntas ausentes passa e qual recusa, e que o
// piso dos Elementos e o do motor, nao um segundo numero escrito a mao.

import { describe, expect, it } from "vitest";
import {
  EXIGENCIA_DE_COMPLETUDE,
  PERGUNTAS_QUE_O_MOTOR_CONSOME,
  avaliarCompletude,
  mensagemDeCompletude,
} from "./completude-marco-zero";
import { calcularMarcoZero, MINIMO_ELEMENTOS_ANALISE_PARCIAL } from "../scoring/marco-zero";
import type { RespostasAchatadas } from "../scoring/marco-zero";

/** Um questionario COMPLETO, no formato que o motor consome. */
function completo(): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  for (let i = 7; i <= 13; i++) r[`q${i}`] = 7; // Elementos (0..10)
  for (let i = 16; i <= 39; i++) r[`q${i}`] = 4; // Likert (1..5)
  for (let i = 40; i <= 45; i++) r[`q${i}`] = "A"; // situacionais
  return r;
}

function sem(...ids: string[]): RespostasAchatadas {
  const r = completo();
  for (const id of ids) delete r[id];
  return r;
}

const avaliar = (respostas: RespostasAchatadas) =>
  avaliarCompletude(calcularMarcoZero(respostas));

describe("limiar de completude do Marco Zero", () => {
  it("o motor consome 37 perguntas, em tres blocos de 24, 6 e 7", () => {
    expect(PERGUNTAS_QUE_O_MOTOR_CONSOME).toBe(37);
    expect(EXIGENCIA_DE_COMPLETUDE.likert).toEqual({ total: 24, minimo: 24 });
    expect(EXIGENCIA_DE_COMPLETUDE.situacional).toEqual({ total: 6, minimo: 6 });
    expect(EXIGENCIA_DE_COMPLETUDE.elementos.total).toBe(7);
  });

  it("o piso dos Elementos e o DO MOTOR, nao um numero escrito aqui", () => {
    // Se alguem recalibrar MINIMO_ELEMENTOS_ANALISE_PARCIAL em
    // lib/scoring/marco-zero.ts, o portao acompanha. Um segundo numero escrito
    // a mao aqui seria duas regras dizendo a mesma coisa e divergindo depois.
    expect(EXIGENCIA_DE_COMPLETUDE.elementos.minimo).toBe(MINIMO_ELEMENTOS_ANALISE_PARCIAL);
  });

  it("CONTROLE POSITIVO: questionario completo passa", () => {
    const c = avaliar(completo());
    expect(c.suficiente).toBe(true);
    expect(mensagemDeCompletude(c)).toBe("");
  });

  it("Likert: zero tolerancia -- UMA de 24 em branco ja recusa", () => {
    const c = avaliar(sem("q31"));
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["likert"]);
    expect(c.faltando).toEqual(["q31"]);
    // A mensagem diz O QUE falta, em quantidade e em qual bloco.
    expect(mensagemDeCompletude(c)).toContain("23 de 24");
  });

  it("situacionais: zero tolerancia -- UMA de 6 em branco ja recusa", () => {
    const c = avaliar(sem("q44"));
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["situacional"]);
    expect(c.faltando).toEqual(["q44"]);
  });

  it("Elementos, o lado que PASSA: 5 de 7 respondidos (duas ausentes)", () => {
    const c = avaliar(sem("q12", "q13"));
    expect(c.suficiente).toBe(true);
    // E o motor, no mesmo estado, declara a leitura "parcial" -- que e
    // justamente o estado que a camada de briefing sabe dizer em voz alta.
    expect(calcularMarcoZero(sem("q12", "q13")).analiseElementos.status).toBe("parcial");
  });

  it("Elementos, o lado que RECUSA: 4 de 7 respondidos (tres ausentes)", () => {
    const c = avaliar(sem("q11", "q12", "q13"));
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["elementos"]);
    expect(c.faltando).toEqual(["q11", "q12", "q13"]);
    expect(calcularMarcoZero(sem("q11", "q12", "q13")).analiseElementos.status).toBe(
      "insuficiente",
    );
  });

  it("o defeito medido: as 30 perguntas do motor ausentes, com os quatro eixos em ZERO", () => {
    const vazio: RespostasAchatadas = {};
    for (let i = 7; i <= 13; i++) vazio[`q${i}`] = 7; // so os Elementos
    const scores = calcularMarcoZero(vazio);
    // Isto e o que o gerador aceitava: eixos em zero e nada estourando.
    expect(Object.values(scores.eixos).map((e) => e.likert0a100)).toEqual([0, 0, 0, 0]);
    const c = avaliarCompletude(scores);
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["likert", "situacional"]);
    expect(c.faltando.length).toBe(30);
  });

  it("valor PRESENTE e fora do dominio conta como ausente para o portao (o motor o reporta em `incompleto`)", () => {
    // q16 e Likert 1..5; 9 esta fora. O motor nao soma e lista o id em
    // `incompleto` -- entao o portao recusa, em vez de pontuar sobre lixo.
    const r = completo();
    r.q16 = 9;
    const c = avaliar(r);
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.faltando).toEqual(["q16"]);
  });
});
