// A SEMANTICA DO "O QUE FALTA", FIXADA CASO POR CASO.
//
// Este arquivo existe por uma razao declarada no topo de obrigatorias.ts: a regra
// de obrigatoriedade vive em DOIS lugares (a tela autenticada, que nao foi tocada,
// e este modulo, usado pelo formulario publico nos dois lados). Enquanto for
// assim, o que impede os dois de divergirem em silencio e este teste, que fixa
// cada ramo -- inclusive os dois que surpreendem: `min_chars` vale sem `required`,
// e ranking obrigatorio exige a ordenacao inteira.
//
// A segunda coisa provada aqui e o TEXTO. A regra firme do projeto e que a recusa
// diga QUAL pergunta falta; um teste que so checasse "recusou" deixaria passar um
// "preencha os campos obrigatorios", que e exatamente o texto que esta proibido.

import { describe, expect, it } from "vitest";
import type { QuizQuestion } from "../../types/database";
import {
  obrigatoriasEmFalta,
  perguntaRespondida,
  resumoDoQueFalta,
  textoDaFalta,
  type FaltaNaEtapa,
} from "./obrigatorias";

function pergunta(parcial: Partial<QuizQuestion> & Pick<QuizQuestion, "id" | "type">): QuizQuestion {
  return { text: `Enunciado de ${parcial.id}`, ...parcial } as QuizQuestion;
}

describe("select, short_text e dilemma", () => {
  for (const tipo of ["select", "short_text", "dilemma"] as const) {
    it(`${tipo}: obrigatoria em branco falta; respondida nao falta`, () => {
      const q = pergunta({ id: "q1", type: tipo, required: true });
      expect(perguntaRespondida(q, undefined)).toBe(false);
      expect(perguntaRespondida(q, "")).toBe(false);
      expect(perguntaRespondida(q, "A. Alguma coisa")).toBe(true);
    });

    it(`${tipo}: NAO obrigatoria em branco nao falta`, () => {
      const q = pergunta({ id: "q1", type: tipo });
      expect(perguntaRespondida(q, undefined)).toBe(true);
    });
  }
});

describe("text", () => {
  it("min_chars vale MESMO SEM required (igual a tela autenticada)", () => {
    const q = pergunta({ id: "q1", type: "text", min_chars: 20 });
    expect(perguntaRespondida(q, "curta")).toBe(false);
    expect(perguntaRespondida(q, "x".repeat(20))).toBe(true);
  });

  it("texto que e so espaco conta como em branco", () => {
    const q = pergunta({ id: "q1", type: "text", required: true });
    expect(perguntaRespondida(q, "    ")).toBe(false);
  });

  it("sem min_chars, quem exige e required", () => {
    const comExigencia = pergunta({ id: "q1", type: "text", required: true });
    const semExigencia = pergunta({ id: "q2", type: "text" });
    expect(perguntaRespondida(comExigencia, "")).toBe(false);
    expect(perguntaRespondida(comExigencia, "ok")).toBe(true);
    expect(perguntaRespondida(semExigencia, "")).toBe(true);
  });

  it("distingue 'em branco' de 'curta' -- sao instrucoes diferentes", () => {
    const q = pergunta({ id: "q1", type: "text", min_chars: 30 });
    const [vazia] = obrigatoriasEmFalta([q], {});
    const [curta] = obrigatoriasEmFalta([q], { q1: "pouco texto" });
    expect(vazia.motivo).toBe("em_branco");
    expect(curta.motivo).toBe("curta");
    expect(textoDaFalta(curta)).toContain("30 caracteres");
  });
});

describe("scale", () => {
  it("zero e uma resposta valida, nao ausencia", () => {
    // O ramo da tela autenticada e `typeof val === "number"`, nao `!!val`: numa
    // regua 0..10 o zero e uma escolha legitima, e tratar 0 como vazio obrigaria
    // a pessoa a mentir para conseguir enviar.
    const q = pergunta({ id: "q1", type: "scale", required: true, min: 0, max: 10 });
    expect(perguntaRespondida(q, 0)).toBe(true);
  });

  it("texto no lugar de numero nao conta como resposta", () => {
    const q = pergunta({ id: "q1", type: "scale", required: true });
    expect(perguntaRespondida(q, "7")).toBe(false);
  });
});

describe("multi_select", () => {
  it("obrigatoria exige ao menos uma escolha", () => {
    const q = pergunta({ id: "q1", type: "multi_select", required: true, options: ["a", "b"] });
    expect(perguntaRespondida(q, [])).toBe(false);
    expect(perguntaRespondida(q, ["a"])).toBe(true);
  });
});

describe("ranking", () => {
  const opcoes = ["a", "b", "c"];

  it("obrigatoria exige a ordenacao COMPLETA", () => {
    const q = pergunta({ id: "q1", type: "ranking", required: true, options: opcoes });
    expect(perguntaRespondida(q, [])).toBe(false);
    expect(perguntaRespondida(q, ["a", "b"])).toBe(false);
    expect(perguntaRespondida(q, ["c", "a", "b"])).toBe(true);
  });

  it("NAO obrigatoria: tudo ou nada, nunca pela metade", () => {
    const q = pergunta({ id: "q1", type: "ranking", options: opcoes });
    expect(perguntaRespondida(q, [])).toBe(true);
    expect(perguntaRespondida(q, ["a"])).toBe(false);
    expect(perguntaRespondida(q, ["a", "b", "c"])).toBe(true);
  });

  it("ranking pela metade diz que falta ORDENAR, nao que esta em branco", () => {
    const q = pergunta({ id: "q1", type: "ranking", required: true, options: opcoes });
    const [falta] = obrigatoriasEmFalta([q], { q1: ["a"] });
    expect(falta.motivo).toBe("ranking_incompleto");
    expect(textoDaFalta(falta)).toContain("todas as 3");
  });
});

describe("tipo desconhecido", () => {
  it("nao inventa exigencia", () => {
    // Igual ao `default: return true` da tela autenticada: uma versao futura do
    // questionario com um tipo novo nao pode travar o envio de quem usa o codigo
    // de hoje.
    const q = pergunta({ id: "q1", type: "coisa_nova" as QuizQuestion["type"], required: true });
    expect(perguntaRespondida(q, undefined)).toBe(true);
  });
});

describe("a lista do que falta", () => {
  const perguntas = [
    pergunta({ id: "a", type: "select", required: true, text: "Primeira" }),
    pergunta({ id: "b", type: "text", text: "Segunda, opcional" }),
    pergunta({ id: "c", type: "scale", required: true, text: "Terceira" }),
  ];

  it("vem na ordem da TELA, com o numero que a tela mostra", () => {
    const faltando = obrigatoriasEmFalta(perguntas, {});
    expect(faltando.map((f) => f.id)).toEqual(["a", "c"]);
    // `numero` e a posicao na etapa (base 1), nao o indice do array nem o id.
    expect(faltando.map((f) => f.numero)).toEqual([1, 3]);
  });

  it("fica vazia quando tudo o que e exigido esta respondido", () => {
    expect(obrigatoriasEmFalta(perguntas, { a: "x", c: 4 })).toEqual([]);
  });

  it("carrega o enunciado, para o aviso poder cita-lo", () => {
    const [primeira] = obrigatoriasEmFalta(perguntas, {});
    expect(primeira.texto).toBe("Primeira");
  });
});

describe("o resumo que a pessoa le", () => {
  const umaFalta: FaltaNaEtapa[] = [
    {
      etapa: 2,
      titulo: "Os 7 Elementos",
      faltando: [{ id: "x", numero: 4, texto: "Quanto você cuida do corpo?", motivo: "em_branco" }],
    },
  ];

  it("cita a etapa, o numero e o enunciado -- nunca 'campos obrigatorios'", () => {
    const texto = resumoDoQueFalta(umaFalta);
    expect(texto).toContain("etapa 2");
    expect(texto).toContain("pergunta 4");
    expect(texto).toContain("Quanto você cuida do corpo?");
    // O texto proibido por este projeto: generico, manda a pessoa procurar.
    expect(texto.toLowerCase()).not.toContain("preencha os campos");
  });

  it("com muitas pendencias, cita as primeiras e CONTA o resto", () => {
    const muitas: FaltaNaEtapa[] = [
      {
        etapa: 3,
        titulo: "Perfil",
        faltando: Array.from({ length: 7 }, (_, i) => ({
          id: `p${i}`,
          numero: i + 1,
          texto: `Pergunta ${i + 1}`,
          motivo: "em_branco" as const,
        })),
      },
    ];
    const texto = resumoDoQueFalta(muitas);
    expect(texto).toContain("Faltam 7 perguntas");
    expect(texto).toContain("e outras 4");
  });

  it("sem pendencia nenhuma, nao ha texto", () => {
    expect(resumoDoQueFalta([])).toBe("");
    expect(resumoDoQueFalta([{ etapa: 1, titulo: "x", faltando: [] }])).toBe("");
  });

  it("enunciado comprido e encurtado, nao jogado inteiro na frase", () => {
    const longa: FaltaNaEtapa[] = [
      {
        etapa: 1,
        titulo: "x",
        faltando: [{ id: "y", numero: 1, texto: "N".repeat(200), motivo: "em_branco" }],
      },
    ];
    expect(resumoDoQueFalta(longa).length).toBeLessThan(140);
  });
});
