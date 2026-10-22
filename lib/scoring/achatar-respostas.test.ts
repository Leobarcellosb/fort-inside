import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ErroNormalizacaoResposta,
  achatarRespostas,
  extrairLetraAlternativa,
  type LinhaDeRespostas,
} from "./achatar-respostas";
import {
  EIXOS,
  ELEMENTOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  MAPA_SITUACIONAL,
  SITUACIONAIS,
  calcularMarcoZero,
  type Alternativa,
  type Eixo,
} from "./marco-zero";
import {
  montarBriefingMarcoZero,
  textoDoParticipante,
} from "./briefing-marco-zero";

// ---------------------------------------------------------------------------
// Fixture REAL: as perguntas saem da propria migration 017, nao de uma copia
// escrita a mao. Se o seed mudar de formato (ex.: perder o prefixo "A. "), estes
// testes quebram, e e isso que se quer.
// ---------------------------------------------------------------------------

interface Pergunta {
  id: string;
  type: string;
  options?: string[];
  min?: number;
  max?: number;
}
interface Etapa {
  id: number;
  stageNumber: number;
  questions: Pergunta[];
}

function lerSeedV2(): Etapa[] {
  const sql = readFileSync(
    join(__dirname, "../../supabase/migrations/017_quiz_v2_seed.sql"),
    "utf8",
  );
  const etapas: Etapa[] = [];
  const re = /\n\((\d+),\s*'[^']*',\s*'[^']*',\s*(?:null|'(?:[^']|'')*'),\s*2,\s*(\d+),\s*\$json\$([\s\S]*?)\$json\$::jsonb\)/g;
  for (const m of sql.matchAll(re)) {
    etapas.push({
      id: Number(m[1]),
      stageNumber: Number(m[2]),
      questions: JSON.parse(m[3]) as Pergunta[],
    });
  }
  return etapas;
}

const ETAPAS = lerSeedV2();
const PERGUNTAS = new Map(ETAPAS.flatMap((e) => e.questions).map((q) => [q.id, q]));

const ALTS: Alternativa[] = ["A", "B", "C", "D"];

// Texto da opcao exatamente como a interface o grava no tipo `select`.
function textoDaOpcao(id: string, letra: Alternativa): string {
  const opcao = PERGUNTAS.get(id)?.options?.find((o) => o.startsWith(`${letra}. `));
  if (!opcao) throw new Error(`seed sem opcao ${letra} em ${id}`);
  return opcao;
}

function letraDoEixo(id: (typeof SITUACIONAIS)[number], eixo: Eixo): Alternativa {
  const alt = ALTS.find((a) => MAPA_SITUACIONAL[id][a] === eixo);
  if (!alt) throw new Error(`sem ${eixo} em ${id}`);
  return alt;
}

// Respostas no formato REAL da interface, uma linha por etapa. `escolhas`
// define o eixo de cada situacional; `likert` o valor de cada item por eixo.
function linhasDaInterface(opts: {
  escolhas: Eixo[];
  likert: Record<Eixo, number>;
  elemento?: (i: number) => number;
}): LinhaDeRespostas[] {
  const porId: Record<string, string | number> = {};
  for (const q of PERGUNTAS.values()) {
    if (q.type === "short_text" || q.type === "text") porId[q.id] = `resposta de ${q.id}`;
  }
  ELEMENTOS.forEach((el, i) => {
    porId[ITENS_ELEMENTOS[el]] = (opts.elemento ?? ((k) => 3 + k))(i);
  });
  for (const eixo of EIXOS) {
    for (const id of ITENS_LIKERT[eixo]) porId[id] = opts.likert[eixo];
  }
  SITUACIONAIS.forEach((id, i) => {
    porId[id] = textoDaOpcao(id, letraDoEixo(id, opts.escolhas[i]));
  });

  return ETAPAS.map((etapa) => ({
    stage_id: etapa.id,
    answers: Object.fromEntries(
      etapa.questions.filter((q) => q.id in porId).map((q) => [q.id, porId[q.id]]),
    ),
  }));
}

describe("fixture: seed da v2", () => {
  it("le 5 etapas (101..105) e 52 perguntas q1..q52 do proprio SQL", () => {
    expect(ETAPAS.map((e) => [e.id, e.stageNumber])).toEqual([
      [101, 1],
      [102, 2],
      [103, 3],
      [104, 4],
      [105, 5],
    ]);
    expect(ETAPAS.map((e) => e.questions.length)).toEqual([6, 9, 24, 6, 7]);
    expect(PERGUNTAS.size).toBe(52);
  });

  it("toda situacional do seed tem 4 opcoes com prefixo A. B. C. D.", () => {
    for (const id of SITUACIONAIS) {
      const opcoes = PERGUNTAS.get(id)?.options ?? [];
      expect(opcoes.map((o) => o.slice(0, 3))).toEqual(["A. ", "B. ", "C. ", "D. "]);
    }
  });
});

describe("extrairLetraAlternativa", () => {
  it("aceita a letra isolada, com trim e em qualquer caixa", () => {
    expect(extrairLetraAlternativa("A")).toBe("A");
    expect(extrairLetraAlternativa("  b ")).toBe("B");
  });

  it("extrai a letra do texto da opcao com prefixo", () => {
    expect(
      extrairLetraAlternativa(
        "C. Reunir as pessoas envolvidas e alinhar expectativas e compromissos.",
      ),
    ).toBe("C");
  });

  it("nao adivinha: prosa que apenas comeca com A nao e alternativa", () => {
    expect(extrairLetraAlternativa("A casa e grande")).toBeNull();
    expect(extrairLetraAlternativa("E. Outra coisa")).toBeNull();
    expect(extrairLetraAlternativa("a. minuscula com ponto")).toBeNull();
    expect(extrairLetraAlternativa("A.")).toBeNull();
    expect(extrairLetraAlternativa("")).toBeNull();
    expect(extrairLetraAlternativa(3)).toBeNull();
  });
});

describe("achatarRespostas: situacionais no formato real da interface", () => {
  const escolhas: Eixo[] = ["visao", "visao", "visao", "visao", "visao", "execucao"];
  const linhas = linhasDaInterface({
    escolhas,
    likert: { visao: 4, execucao: 3, relacao: 3, integridade: 3 },
  });

  it("CONTROLE DO DEFEITO: sem a camada, o motor descarta as 6 situacionais em silencio", () => {
    const cru = Object.assign({}, ...linhas.map((l) => l.answers)) as Record<string, string | number>;
    expect(typeof cru.q40).toBe("string");
    expect((cru.q40 as string).startsWith("A. ")).toBe(true);
    const r = calcularMarcoZero(cru);
    expect(r.analiseSituacional.contagens).toEqual({
      visao: 0,
      execucao: 0,
      relacao: 0,
      integridade: 0,
    });
    expect(r.analiseSituacional.status).toBe("incompleto");
    expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
  });

  it("com a camada, as contagens ficam corretas e o eixo e destacado", () => {
    const r = calcularMarcoZero(achatarRespostas(linhas));
    expect(r.analiseSituacional.contagens).toEqual({
      visao: 5,
      execucao: 1,
      relacao: 0,
      integridade: 0,
    });
    expect(r.analiseSituacional.status).toBe("destacado");
    expect(r.analiseSituacional.eixoDestacado).toBe("visao");
    expect(r.analiseSituacional.margem).toBe(4);
    expect(r.incompleto).toEqual([]);
  });

  it("sem margem suficiente nao destaca (3-3-0-0 e empate), mas conta certo", () => {
    const l = linhasDaInterface({
      escolhas: ["visao", "visao", "visao", "execucao", "execucao", "execucao"],
      likert: { visao: 3, execucao: 3, relacao: 3, integridade: 3 },
    });
    const r = calcularMarcoZero(achatarRespostas(l));
    expect(r.analiseSituacional.contagens.visao).toBe(3);
    expect(r.analiseSituacional.contagens.execucao).toBe(3);
    expect(r.analiseSituacional.status).toBe("empate");
    expect(r.analiseSituacional.eixoDestacado).toBeNull();
  });

  it("converge com o Likert quando os dois autorrelatos apontam o mesmo eixo", () => {
    const l = linhasDaInterface({
      escolhas,
      likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 },
    });
    const r = calcularMarcoZero(achatarRespostas(l));
    expect(r.analiseLikert.eixoDestacado).toBe("visao");
    expect(r.relacaoEntreAutorrelatos).toBe("convergencia");
  });

  it("repassa as perguntas abertas sem alterar", () => {
    const achatado = achatarRespostas(linhas);
    expect(achatado.q1).toBe("resposta de q1");
    expect(achatado.q52).toBe("resposta de q52");
  });
});

describe("achatarRespostas: pergunta ausente nao e erro", () => {
  it("situacional nao respondida fica fora do mapa e o motor a lista em incompleto", () => {
    const linhas = linhasDaInterface({
      escolhas: ["visao", "visao", "visao", "visao", "visao", "visao"],
      likert: { visao: 4, execucao: 3, relacao: 3, integridade: 3 },
    });
    const etapa4 = linhas.find((l) => l.stage_id === 104)!;
    delete (etapa4.answers as Record<string, unknown>).q45;
    const achatado = achatarRespostas(linhas);
    expect("q45" in achatado).toBe(false);
    const r = calcularMarcoZero(achatado);
    expect(r.incompleto).toEqual(["q45"]);
    expect(r.analiseSituacional.status).toBe("incompleto");
  });
});

describe("achatarRespostas: falha alto", () => {
  function comValor(id: string, stage: number, valor: unknown): LinhaDeRespostas[] {
    return [{ stage_id: stage, answers: { [id]: valor } }];
  }

  function capturar(fn: () => unknown): ErroNormalizacaoResposta {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ErroNormalizacaoResposta);
      return e as ErroNormalizacaoResposta;
    }
    throw new Error("esperava que lancasse");
  }

  it("situacional em prosa: diz qual pergunta e qual valor", () => {
    const e = capturar(() =>
      achatarRespostas(comValor("q41", 104, "Eu escutaria todo mundo antes")),
    );
    expect(e.perguntaId).toBe("q41");
    expect(e.etapaId).toBe(104);
    expect(e.valor).toBe("Eu escutaria todo mundo antes");
    expect(e.message).toContain("q41");
    expect(e.message).toContain("Eu escutaria todo mundo antes");
  });

  it("situacional com letra fora de A-D", () => {
    const e = capturar(() => achatarRespostas(comValor("q40", 104, "E. Algo")));
    expect(e.message).toContain("q40");
    expect(e.message).toContain("E. Algo");
  });

  it("situacional vazia, nula ou numerica", () => {
    for (const v of ["", null, 2, ["A"]]) {
      expect(() => achatarRespostas(comValor("q42", 104, v))).toThrow(/q42/);
    }
  });

  it("Likert fora de 1..5 ou nao inteiro", () => {
    for (const v of [0, 6, 2.5, "muito", null, true]) {
      const e = capturar(() => achatarRespostas(comValor("q16", 103, v)));
      expect(e.message).toContain("q16");
      expect(e.message).toContain("1 a 5");
    }
  });

  it("elemento fora de 0..10", () => {
    const e = capturar(() => achatarRespostas(comValor("q7", 102, 11)));
    expect(e.message).toContain("q7");
    expect(e.message).toContain("11");
    expect(() => achatarRespostas(comValor("q7", 102, -1))).toThrow(/q7/);
  });

  it("numero em texto e normalizado para numero (nao e erro)", () => {
    expect(achatarRespostas(comValor("q16", 103, "4")).q16).toBe(4);
    expect(achatarRespostas(comValor("q7", 102, 0)).q7).toBe(0);
  });

  it("tipo nao suportado em pergunta comum", () => {
    expect(() => achatarRespostas(comValor("q1", 101, { a: 1 }))).toThrow(/q1/);
    expect(() => achatarRespostas(comValor("q1", 101, null))).toThrow(/q1/);
    expect(() => achatarRespostas(comValor("q1", 101, [1, 2]))).toThrow(/q1/);
  });

  it("pergunta repetida em duas etapas", () => {
    const e = capturar(() =>
      achatarRespostas([
        { stage_id: 101, answers: { q1: "a" } },
        { stage_id: 102, answers: { q1: "b" } },
      ]),
    );
    expect(e.message).toContain("q1");
    expect(e.message).toContain("etapa 101");
  });

  it("mesma etapa em duas linhas e answers que nao e objeto", () => {
    expect(() =>
      achatarRespostas([
        { stage_id: 101, answers: {} },
        { stage_id: 101, answers: {} },
      ]),
    ).toThrow(/Etapa 101/);
    expect(() => achatarRespostas([{ stage_id: 101, answers: null }])).toThrow(/Etapa 101/);
    expect(() => achatarRespostas([{ stage_id: 101, answers: ["x"] }])).toThrow(/Etapa 101/);
  });

  it("um valor ruim no meio nao e engolido: a funcao inteira falha", () => {
    const linhas = linhasDaInterface({
      escolhas: ["visao", "visao", "visao", "visao", "visao", "visao"],
      likert: { visao: 4, execucao: 3, relacao: 3, integridade: 3 },
    });
    (linhas.find((l) => l.stage_id === 104)!.answers as Record<string, unknown>).q43 =
      "tanto faz";
    expect(() => achatarRespostas(linhas)).toThrow(/q43.*tanto faz/);
  });
});

describe("participante da v2 com as 5 etapas: briefing completo", () => {
  const linhas = linhasDaInterface({
    escolhas: ["visao", "visao", "visao", "visao", "visao", "execucao"],
    likert: { visao: 5, execucao: 3, relacao: 3, integridade: 2 },
    elemento: (i) => [8, 5, 6, 4, 7, 9, 3][i],
  });

  it("monta o briefing sem avisos de dados inconsistentes e com todas as afirmacoes", () => {
    const scores = calcularMarcoZero(achatarRespostas(linhas));
    expect(scores.incompleto).toEqual([]);
    expect(scores.analiseElementos.status).toBe("completo");
    const briefing = montarBriefingMarcoZero(scores);
    expect(briefing.avisos.map((a) => a.codigo)).not.toContain("dados_inconsistentes");
    expect(briefing.eixos.situacional.classificacao).toBe("fato_medido");
    expect(briefing.eixos.likert.classificacao).toBe("fato_medido");
    const texto = textoDoParticipante(briefing);
    expect(texto.length).toBeGreaterThan(200);
  });
});
