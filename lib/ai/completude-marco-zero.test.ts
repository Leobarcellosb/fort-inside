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
import { readFileSync } from "node:fs";
import { ehPerguntaPontuada } from "./prognostic-prompt";

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

  // ASSERCAO REESCRITA. O que ela afirmava antes: "o piso dos Elementos e o DO
  // MOTOR, nao um numero escrito aqui" -- e amarrava
  // `EXIGENCIA_DE_COMPLETUDE.elementos.minimo` a
  // `MINIMO_ELEMENTOS_ANALISE_PARCIAL` (5). A revisao recusou a tolerancia, e
  // com isso o proprio laco deixou de ser desejavel: o piso do motor decide
  // "parcial" contra "insuficiente" DENTRO da analise, nao se o documento pode
  // existir. A evidencia nova sao os dois fatos juntos -- o portao exige 7 de 7
  // E nao esta mais amarrado ao piso do motor --, porque afirmar so o primeiro
  // deixaria passar alguem reatando os dois com o valor 7.
  it("Elementos: 7 de 7, e o limiar NAO e mais o piso do motor", () => {
    expect(EXIGENCIA_DE_COMPLETUDE.elementos).toEqual({ total: 7, minimo: 7 });
    expect(EXIGENCIA_DE_COMPLETUDE.elementos.minimo).not.toBe(
      MINIMO_ELEMENTOS_ANALISE_PARCIAL,
    );
    // O piso do motor segue existindo e segue valendo onde ele vale: o motor
    // continua declarando leitura "parcial" com 5 ou 6 Elementos respondidos.
    // O que mudou e quem decide a EXISTENCIA do documento.
    expect(MINIMO_ELEMENTOS_ANALISE_PARCIAL).toBe(5);
    expect(calcularMarcoZero(sem("q12", "q13")).analiseElementos.status).toBe("parcial");
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

  // ASSERCAO REESCRITA. O que ela afirmava antes: "Elementos, o lado que PASSA:
  // 5 de 7 respondidos (duas ausentes)" -- isto e, AFIRMAVA a tolerancia que a
  // revisao recusou. A fronteira nao desapareceu, ela MUDOU DE LUGAR: o unico
  // lado que passa agora e 7 de 7, e UMA ausente ja recusa. A evidencia nova e
  // o 6 de 7 recusado, que e a mudanca de comportamento desta correcao.
  it("Elementos: zero tolerancia -- UMA de 7 em branco (6 de 7) ja RECUSA", () => {
    const c = avaliar(sem("q13"));
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["elementos"]);
    expect(c.faltando).toEqual(["q13"]);
    // A mensagem diz O QUE falta, em quantidade e em qual bloco.
    expect(mensagemDeCompletude(c)).toContain("6 de 7 respondidas (mínimo 7)");
    // E o motor, no MESMO estado, segue declarando leitura "parcial": e esse o
    // ponto da correcao -- "parcial" e um veredito sobre a ANALISE, e nunca foi
    // permissao para o documento existir.
    expect(calcularMarcoZero(sem("q13")).analiseElementos.status).toBe("parcial");
  });

  it("Elementos: 5 de 7 (duas ausentes) -- o caso que GERAVA e agora RECUSA", () => {
    // Este e exatamente o caso que a versao anterior deixava passar. Ele fica
    // medido em teste proprio para que a mudanca de comportamento nao dependa
    // de ninguem lembrar dela.
    const c = avaliar(sem("q12", "q13"));
    expect(c.suficiente).toBe(false);
    if (c.suficiente) return;
    expect(c.insuficientes).toEqual(["elementos"]);
    expect(c.faltando).toEqual(["q12", "q13"]);
  });

  it("Elementos: 4 de 7 respondidos (tres ausentes) segue RECUSADO", () => {
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

// ===========================================================================
// AUDITORIA: "conferir todas as demais obrigatorias"
// ===========================================================================
// A segunda metade da ordem da revisao e trabalho de auditoria, nao de mudar um
// numero: existe pergunta OBRIGATORIA do questionario que este portao NAO
// cobre? Existe -- 15 delas. A decisao declarada em completude-marco-zero.ts e
// NAO bloquear por elas, com a razao escrita la (resposta aberta ausente nao
// vira numero errado; vira documento mais curto, desfecho que este repositorio
// ja decidiu aceitar em lib/ai/prognostic-schema.ts).
//
// Uma decisao declarada em comentario envelhece em silencio. Este bloco e o que
// a mantem viva: ele le o QUESTIONARIO CANONICO publicado e afirma a lista
// EXATA das obrigatorias nao cobertas. Pergunta obrigatoria nova no
// questionario, ou mudanca no que o motor consome, QUEBRA este teste -- e a
// auditoria e refeita por decisao de produto, em vez de a divergencia crescer
// sem ninguem olhar.
interface PerguntaCanonica {
  id: string;
  required: boolean;
  type: string;
}
interface EtapaCanonica {
  n: number;
  t: string;
  q: PerguntaCanonica[];
}

const ETAPAS_CANONICAS: EtapaCanonica[] = JSON.parse(
  readFileSync(new URL("../../docs/questionario-v2-canonico.json", import.meta.url), "utf8"),
);
const PERGUNTAS_CANONICAS = ETAPAS_CANONICAS.flatMap((e) =>
  e.q.map((q) => ({ ...q, etapa: e.n })),
);

describe("auditoria das perguntas obrigatorias que o portao nao cobre", () => {
  it("o questionario canonico tem 52 perguntas e TODAS sao obrigatorias", () => {
    // Este e o fato que torna a exigencia de 7 de 7 barata: nao existe pergunta
    // nao-obrigatoria entre as que o motor consome, porque nao existe pergunta
    // nao-obrigatoria no questionario.
    expect(PERGUNTAS_CANONICAS).toHaveLength(52);
    expect(PERGUNTAS_CANONICAS.filter((q) => !q.required)).toEqual([]);
  });

  it("o portao cobre 37 das 52, e as 15 obrigatorias NAO cobertas sao estas", () => {
    const cobertas = PERGUNTAS_CANONICAS.filter((q) => ehPerguntaPontuada(q.id));
    const naoCobertas = PERGUNTAS_CANONICAS.filter(
      (q) => q.required && !ehPerguntaPontuada(q.id),
    );
    expect(cobertas).toHaveLength(PERGUNTAS_QUE_O_MOTOR_CONSOME);
    // A lista EXATA, nomeada e nao contada: e ela que a revisao pediu.
    expect(naoCobertas.map((q) => q.id)).toEqual([
      // Grupo 1 -- contexto (etapa 1 "Sobre voce"): nome, idade, cidade,
      // organizacao, papel e ambientes de influencia.
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
      "q6",
      // Grupo 2 -- as duas abertas da etapa dos Elementos: qual elemento pede
      // atencao, e qual mudanca concreta em 90 dias.
      "q14",
      "q15",
      // Grupo 3 -- etapa 5 "Sua preparacao para o Marco Zero", inteira.
      "q46",
      "q47",
      "q48",
      "q49",
      "q50",
      "q51",
      "q52",
    ]);
  });

  it("as 15 nao cobertas sao TODAS de texto livre -- nenhuma entra em pontuacao", () => {
    // O que sustenta o veredito de nao bloquear: nenhuma delas alimenta soma,
    // contagem ou ranking. Se uma pergunta de ESCALA aparecesse fora da
    // cobertura do portao, o veredito nao se sustentaria -- ausente viraria zero
    // -- e este teste e quem avisa.
    const naoCobertas = PERGUNTAS_CANONICAS.filter(
      (q) => q.required && !ehPerguntaPontuada(q.id),
    );
    expect([...new Set(naoCobertas.map((q) => q.type))].sort()).toEqual([
      "short_text",
      "text",
    ]);
  });
});
