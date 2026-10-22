import { describe, expect, it } from "vitest";
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
  type Elemento,
  type RespostasAchatadas,
} from "./marco-zero";
import {
  EXPRESSOES_VETADAS,
  FRASE_ELEMENTO_MAIOR,
  ROTULOS_ELEMENTOS_PADRAO,
  TEXTO_SITUACIONAL_SEM_DESTAQUE,
  TITULO_SITUACIONAL,
  briefingParaPrompt,
  encontrarChavesVazadas,
  encontrarExpressoesVetadas,
  montarBriefingMarcoZero,
  textoDoParticipante,
  textosDoParticipante,
  type BriefingMarcoZero,
  type OpcoesBriefing,
} from "./briefing-marco-zero";

// ---------------------------------------------------------------------------
// Montagem de respostas
// ---------------------------------------------------------------------------

const ALTS: Alternativa[] = ["A", "B", "C", "D"];

function alternativaPara(q: (typeof SITUACIONAIS)[number], eixo: Eixo): Alternativa {
  const alt = ALTS.find((a) => MAPA_SITUACIONAL[q][a] === eixo);
  if (!alt) throw new Error(`sem ${eixo} em ${q}`);
  return alt;
}

interface Montagem {
  /** nota Likert fixa por eixo (1 a 5), aplicada aos 6 itens */
  likert: Record<Eixo, number>;
  /** eixo escolhido em cada situacional; null = sem resposta */
  situacional: (Eixo | null)[];
  /** nota 0 a 10 por elemento; undefined = sem resposta */
  elementos: Partial<Record<Elemento, number>>;
  /** ids de Likert a omitir */
  semLikert?: string[];
}

const NOTAS_NEUTRAS: Record<Elemento, number> = {
  desenvolvimento_intelectual: 5,
  saude_energia: 6,
  equilibrio_emocional: 7,
  recursos_financeiros: 8,
  contribuicao_social: 4,
  realizacao_proposito: 3,
  hobbies_diversao: 9,
};

function respostas(m: Partial<Montagem> = {}): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  const likert = m.likert ?? { visao: 3, execucao: 3, relacao: 3, integridade: 3 };
  for (const eixo of EIXOS) {
    for (const id of ITENS_LIKERT[eixo]) {
      if (!m.semLikert?.includes(id)) r[id] = likert[eixo];
    }
  }
  const sit = m.situacional ?? ["visao", "execucao", "relacao", "integridade", "visao", "execucao"];
  SITUACIONAIS.forEach((q, i) => {
    const eixo = sit[i];
    if (eixo) r[q] = alternativaPara(q, eixo);
  });
  const elementos = m.elementos ?? NOTAS_NEUTRAS;
  for (const el of ELEMENTOS) {
    const nota = elementos[el];
    if (nota !== undefined) r[ITENS_ELEMENTOS[el]] = nota;
  }
  return r;
}

// Cenarios nomeados
const LIKERT_EXECUCAO = { visao: 3, execucao: 5, relacao: 3, integridade: 3 };
const LIKERT_PLANO = { visao: 3, execucao: 3, relacao: 3, integridade: 3 };
const SIT_RELACAO: (Eixo | null)[] = ["relacao", "relacao", "relacao", "relacao", "visao", "execucao"]; // 4-1-1-0
const SIT_EXECUCAO: (Eixo | null)[] = ["execucao", "execucao", "execucao", "execucao", "visao", "relacao"];
const SIT_EMPATE: (Eixo | null)[] = ["visao", "visao", "execucao", "execucao", "relacao", "integridade"]; // 2-2-1-1
const SIT_MARGEM_1: (Eixo | null)[] = ["visao", "visao", "visao", "execucao", "execucao", "relacao"]; // 3-2-1-0
const SIT_INCOMPLETA: (Eixo | null)[] = ["visao", "visao", "visao", "visao", null, null];

const ROTULOS_TESTE: OpcoesBriefing = {
  rotulosEixos: {
    visao: "Alfa",
    execucao: "Beta",
    relacao: "Gama",
    integridade: "Delta",
  },
};

const CHAVES_CRUAS = ["visao", "execucao", "relacao", "integridade"] as const;

function briefing(m: Partial<Montagem> = {}, opcoes?: OpcoesBriefing): BriefingMarcoZero {
  return montarBriefingMarcoZero(calcularMarcoZero(respostas(m)), opcoes);
}

function tudo(b: BriefingMarcoZero): string {
  return textoDoParticipante(b);
}

// ---------------------------------------------------------------------------
// 1. Sem destaque situacional
// ---------------------------------------------------------------------------

describe("criterio 1: situacional sem destaque nao afirma eixo predominante", () => {
  const casos: [string, (Eixo | null)[], string][] = [
    ["empate", SIT_EMPATE, "empate"],
    ["margem insuficiente", SIT_MARGEM_1, "margem_insuficiente"],
    ["incompleto", SIT_INCOMPLETA, "respostas_incompletas"],
  ];

  for (const [nome, sit, motivo] of casos) {
    it(`${nome}: destaque vem indeterminado, sem eixo, com texto de indeterminacao`, () => {
      const b = briefing({ likert: LIKERT_EXECUCAO, situacional: sit }, ROTULOS_TESTE);
      const d = b.eixos.situacional;
      expect(d.classificacao).toBe("indeterminado");
      if (d.classificacao !== "indeterminado") throw new Error("tipo");
      expect(d.motivo).toBe(motivo);
      expect(d).not.toHaveProperty("eixoInterno");
      expect(d).not.toHaveProperty("escolhas");
      expect(d.titulo).toBe(TITULO_SITUACIONAL);
      // Nenhuma afirmacao de eixo destacado nas situacionais.
      for (const a of b.afirmacoes) {
        if (a.id === "eixos.situacional.destaque") {
          expect(a.classificacao).toBe("indeterminado");
        }
      }
      // Sem destaque situacional nao existe cruzamento.
      expect(b.eixos.cruzamento).toHaveLength(1);
      expect(b.eixos.cruzamento[0].classificacao).toBe("indeterminado");
      const contrasteOuConvergencia = b.afirmacoes.filter(
        (a) =>
          a.id === "eixos.cruzamento.contraste" ||
          a.id === "eixos.cruzamento.convergencia",
      );
      expect(contrasteOuConvergencia).toHaveLength(0);
    });
  }

  it("empate e margem insuficiente trazem o texto aprovado, literalmente", () => {
    for (const sit of [SIT_EMPATE, SIT_MARGEM_1]) {
      const b = briefing({ situacional: sit }, ROTULOS_TESTE);
      const texto = tudo(b);
      expect(texto).toContain(TITULO_SITUACIONAL);
      for (const paragrafo of TEXTO_SITUACIONAL_SEM_DESTAQUE) {
        expect(texto).toContain(paragrafo);
      }
    }
    // Conferencia contra o texto do brief, escrito por extenso.
    const texto = tudo(briefing({ situacional: SIT_EMPATE }, ROTULOS_TESTE));
    expect(texto).toContain(
      "Nas seis situações apresentadas, suas escolhas se distribuíram entre diferentes dimensões, sem uma predominância suficientemente clara para destacar um único eixo.",
    );
    expect(texto).toContain(
      "Isso não significa ausência de características marcantes. Significa apenas que esse conjunto de respostas não permite identificar uma preferência consistente entre os quatro eixos.",
    );
    expect(texto).toContain(
      "Para refletir: o que costuma fazer você priorizar uma dimensão em vez de outra quando precisa tomar uma decisão?",
    );
  });

  it("incompleto: nao diz 'seis situacoes' como se todas tivessem sido respondidas, mas mantem o texto de indeterminacao", () => {
    const texto = tudo(briefing({ situacional: SIT_INCOMPLETA }, ROTULOS_TESTE));
    expect(texto).toContain("Você respondeu 4 das seis situações apresentadas.");
    expect(texto).toContain(TEXTO_SITUACIONAL_SEM_DESTAQUE[1]);
    expect(texto).toContain(TEXTO_SITUACIONAL_SEM_DESTAQUE[2]);
    expect(texto).not.toContain(TEXTO_SITUACIONAL_SEM_DESTAQUE[0]);
  });

  it("a distribuicao e mostrada, em ordem fixa (nunca ordenada por valor)", () => {
    const b = briefing({ situacional: SIT_EMPATE }, ROTULOS_TESTE);
    const dist = b.eixos.distribuicaoSituacional;
    expect(dist.classificacao).toBe("fato_medido");
    if (dist.classificacao !== "fato_medido") throw new Error("tipo");
    expect(dist.itens.map((i) => i.eixoInterno)).toEqual([...EIXOS]);
    expect(dist.itens.map((i) => i.contagem)).toEqual([2, 2, 1, 1]);
    expect(dist.respondidas).toBe(6);
    expect(dist.texto).toBe(
      "Nas situações respondidas, suas escolhas se distribuíram assim: “Alfa”, 2 de 6; “Beta”, 2 de 6; “Gama”, 1 de 6; “Delta”, 1 de 6.",
    );
  });

  it("Likert sem destaque tambem nao forca eixo", () => {
    const b = briefing({ likert: LIKERT_PLANO, situacional: SIT_RELACAO }, ROTULOS_TESTE);
    expect(b.eixos.likert.classificacao).toBe("indeterminado");
    expect(b.eixos.likert).not.toHaveProperty("eixoInterno");
    expect(b.eixos.cruzamento.map((a) => a.id)).toEqual(["eixos.cruzamento.indeterminado"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Contraste como pergunta
// ---------------------------------------------------------------------------

describe("criterio 2: contraste entre instrumentos e emitido como pergunta", () => {
  const b = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO }, ROTULOS_TESTE);

  it("emite hipotese a validar, em forma de pergunta, com a base dos dois instrumentos", () => {
    expect(b.eixos.cruzamento).toHaveLength(1);
    const c = b.eixos.cruzamento[0];
    expect(c.id).toBe("eixos.cruzamento.contraste");
    expect(c.classificacao).toBe("hipotese_a_validar");
    expect(c.fontes.map((f) => f.instrumento)).toEqual(["likert", "situacional"]);
    expect(c.fontes.find((f) => f.instrumento === "situacional")?.natureza).toBe(
      "escolha_declarada_hipotetica",
    );
    expect(c.texto).toBe(
      "Você se descreve com forte orientação à dimensão “Beta”. Nas situações hipotéticas, porém, suas escolhas favoreceram a dimensão “Gama”. O que essa diferença pode revelar sobre suas prioridades?",
    );
    expect(c.texto?.trimEnd().endsWith("?")).toBe(true);
  });

  it("nao contem forma alguma de 'voce age', 'seu comportamento e' ou 'perfil dominante'", () => {
    const texto = normalizado(tudo(b));
    expect(texto).not.toMatch(/voce (age|reage|se comporta)/);
    expect(texto).not.toMatch(/seu comportamento/);
    expect(texto).not.toMatch(/perfil (dominante|predominante)/);
    expect(encontrarExpressoesVetadas(tudo(b))).toEqual([]);
  });

  it("o destaque situacional isolado tambem fala em escolhas declaradas, nao em acao", () => {
    const s = b.eixos.situacional;
    expect(s.classificacao).toBe("fato_medido");
    expect(s.texto).toBe(
      "Nas seis situações hipotéticas, o maior número das suas escolhas declaradas (4 de 6) favoreceu a dimensão “Gama”. São escolhas feitas sobre situações imaginadas; elas não descrevem o que ocorre na prática.",
    );
  });

  it("sem rotulos, o contraste continua sendo pergunta e nao nomeia eixo", () => {
    const sem = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO });
    const c = sem.eixos.cruzamento[0];
    expect(c.texto).toBe(
      "Você se descreve com forte orientação a uma das dimensões avaliadas. Nas situações hipotéticas, porém, suas escolhas favoreceram outra dimensão. O que essa diferença pode revelar sobre suas prioridades?",
    );
    expect(sem.avisos.map((a) => a.codigo)).toContain("rotulos_eixos_ausentes");
  });
});

// ---------------------------------------------------------------------------
// 3. Convergencia
// ---------------------------------------------------------------------------

describe("criterio 3: mesmo eixo nos dois instrumentos e convergencia, nao comportamento", () => {
  const b = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_EXECUCAO }, ROTULOS_TESTE);

  it("ha convergencia (fato) e uma reflexao separada (hipotese)", () => {
    expect(b.eixos.cruzamento.map((a) => [a.id, a.classificacao])).toEqual([
      ["eixos.cruzamento.convergencia", "fato_medido"],
      ["eixos.cruzamento.reflexao", "hipotese_a_validar"],
    ]);
    const conv = b.eixos.cruzamento[0];
    expect(conv.texto).toContain("a dimensão “Beta” teve o maior destaque");
    expect(conv.texto).toContain("autorrelato");
    expect(b.eixos.cruzamento[1].texto?.trimEnd().endsWith("?")).toBe(true);
  });

  it("nao vira afirmacao de comportamento observado", () => {
    expect(encontrarExpressoesVetadas(tudo(b))).toEqual([]);
    const texto = normalizado(tudo(b));
    expect(texto).not.toMatch(/voce (age|reage|se comporta)|seu comportamento|perfil (dominante|predominante)|comportamento observado/);
    // O unico verbo sobre a pratica aparece negado, como limite do instrumento.
    expect(texto).toContain("nenhuma delas observa o que voce faz na pratica");
  });
});

// ---------------------------------------------------------------------------
// 4. 6 de 7 elementos
// ---------------------------------------------------------------------------

describe("criterio 4: 6 de 7 elementos", () => {
  const { hobbies_diversao: _omitido, ...seis } = NOTAS_NEUTRAS;
  const b = briefing({ elementos: seis }, ROTULOS_TESTE);

  it("nao existe elemento de menor pontuacao e o de maior nao e apresentavel", () => {
    const menor = b.elementos.menor;
    const maior = b.elementos.maior;
    expect(menor.classificacao).toBe("indeterminado");
    expect(maior.classificacao).toBe("indeterminado");
    expect(menor).not.toHaveProperty("elementoInterno");
    expect(maior).not.toHaveProperty("elementoInterno");
    expect(menor.texto).toBeNull();
    expect(maior.texto).toBeNull();
    if (menor.classificacao === "indeterminado") expect(menor.motivo).toBe("elementos_incompletos");
    if (maior.classificacao === "indeterminado") expect(maior.motivo).toBe("elementos_incompletos");
  });

  it("nenhum nome de elemento aparece em texto, e o nao respondido nao tem valor", () => {
    const texto = tudo(b);
    for (const rotulo of Object.values(ROTULOS_ELEMENTOS_PADRAO)) {
      expect(texto).not.toContain(rotulo);
    }
    expect(texto).not.toContain(FRASE_ELEMENTO_MAIOR);
    const notas = b.elementos.notas;
    if (notas.classificacao !== "fato_medido") throw new Error("tipo");
    const faltante = notas.itens.find((i) => i.elementoInterno === "hobbies_diversao");
    expect(faltante?.resposta).toEqual({ estado: "nao_respondido" });
    expect(faltante?.resposta).not.toHaveProperty("nota");
    expect(notas.texto).toBeNull();
  });

  it("o prompt tambem nao carrega elemento algum nem trata o faltante como baixo", () => {
    const prompt = briefingParaPrompt(b);
    for (const rotulo of Object.values(ROTULOS_ELEMENTOS_PADRAO)) {
      expect(prompt).not.toContain(rotulo);
    }
    expect(prompt).toContain("[INDETERMINADO] elemento de maior pontuação");
    expect(prompt).toContain("[INDETERMINADO] elemento de menor pontuação");
  });
});

describe("elementos completos: maior e menor so como nota atribuida", () => {
  it("emite as frases aceitas, com a ressalva de que e nota autorrelatada", () => {
    const b = briefing({}, ROTULOS_TESTE);
    const maior = b.elementos.maior;
    const menor = b.elementos.menor;
    if (maior.classificacao !== "fato_medido" || menor.classificacao !== "fato_medido") {
      throw new Error("tipo");
    }
    expect(maior.elementoInterno).toBe("hobbies_diversao"); // 9
    expect(menor.elementoInterno).toBe("realizacao_proposito"); // 3
    expect(maior.texto).toBe(
      "Entre os sete elementos avaliados, este foi aquele ao qual você atribuiu a maior pontuação: “Hobbies e diversão”. É a nota que você atribuiu, e não uma medição externa.",
    );
    expect(menor.texto).toBe(
      "Entre os sete elementos avaliados, este foi aquele ao qual você atribuiu a menor pontuação: “Realização e propósito”. É a nota que você atribuiu, e não uma medição externa.",
    );
    expect(maior.fontes[0]).toMatchObject({ instrumento: "elementos", respondidas: 7, total: 7, completo: true });
  });

  it("empate no topo ou na base: nenhum elemento e nomeado", () => {
    const topo = briefing({ elementos: { ...NOTAS_NEUTRAS, saude_energia: 9 } });
    expect(topo.elementos.maior.classificacao).toBe("indeterminado");
    expect(topo.elementos.menor.classificacao).toBe("fato_medido");
    const base = briefing({ elementos: { ...NOTAS_NEUTRAS, saude_energia: 3 } });
    expect(base.elementos.menor.classificacao).toBe("indeterminado");
    expect(base.elementos.maior.classificacao).toBe("fato_medido");
  });
});

// ---------------------------------------------------------------------------
// 5. 4 de 7 elementos
// ---------------------------------------------------------------------------

describe("criterio 5: 4 de 7 elementos nao tem interpretacao comparativa", () => {
  const quatro: Partial<Record<Elemento, number>> = {
    desenvolvimento_intelectual: 5,
    saude_energia: 6,
    equilibrio_emocional: 7,
    recursos_financeiros: 8,
  };
  const b = briefing({ elementos: quatro }, ROTULOS_TESTE);

  it("maior, menor, media e notas ficam indeterminados, sem valor algum", () => {
    for (const a of [b.elementos.maior, b.elementos.menor, b.elementos.media, b.elementos.notas]) {
      expect(a.classificacao).toBe("indeterminado");
      expect(a).not.toHaveProperty("elementoInterno");
      expect(a).not.toHaveProperty("media");
      expect(a).not.toHaveProperty("itens");
    }
    if (b.elementos.maior.classificacao === "indeterminado") {
      expect(b.elementos.maior.motivo).toBe("elementos_insuficientes");
    }
  });

  it("o texto so informa quantos foram respondidos, sem comparar nada", () => {
    expect(tudo(b)).toContain(
      "Você respondeu 4 dos sete elementos. Com poucas respostas, não apresentamos média nem comparação entre eles.",
    );
    for (const rotulo of Object.values(ROTULOS_ELEMENTOS_PADRAO)) {
      expect(tudo(b)).not.toContain(rotulo);
    }
  });

  it("no piso (5 de 7) ja ha media com denominador, mas ainda nenhum comparativo", () => {
    const cinco = briefing({ elementos: { ...quatro, contribuicao_social: 4 } });
    expect(cinco.elementos.media.classificacao).toBe("fato_medido");
    expect(cinco.elementos.maior.classificacao).toBe("indeterminado");
    expect(cinco.elementos.menor.classificacao).toBe("indeterminado");
  });
});

// ---------------------------------------------------------------------------
// 6. Media com denominador
// ---------------------------------------------------------------------------

describe("criterio 6: media sempre sai com o denominador", () => {
  it("7 de 7", () => {
    const b = briefing({}, ROTULOS_TESTE);
    const m = b.elementos.media;
    if (m.classificacao !== "fato_medido") throw new Error("tipo");
    expect(m.media).toEqual({ valor: 6, denominador: 7, de: 7 });
    expect(m.texto).toBe(
      "A média das notas que você atribuiu aos elementos foi 6,0 (em uma escala de 0 a 10), calculada sobre 7 de 7 elementos respondidos.",
    );
  });

  it("6 de 7: o denominador e dito e o ausente nao entra como zero", () => {
    const { hobbies_diversao: _x, ...seis } = NOTAS_NEUTRAS; // soma 33 / 6 = 5,5
    const m = briefing({ elementos: seis }).elementos.media;
    if (m.classificacao !== "fato_medido") throw new Error("tipo");
    expect(m.media.denominador).toBe(6);
    expect(m.media.valor).toBe(5.5);
    expect(m.texto).toContain("5,5");
    expect(m.texto).toContain("calculada sobre 6 de 7 elementos respondidos");
    expect(m.texto).toContain("Os demais ficaram sem resposta e não entram na conta.");
  });

  it("toda afirmacao que traz media tem denominador (varredura estrutural e textual)", () => {
    for (const faltando of [0, 1, 2, 3]) {
      const el = { ...NOTAS_NEUTRAS } as Partial<Record<Elemento, number>>;
      ELEMENTOS.slice(0, faltando).forEach((e) => delete el[e]);
      const b = briefing({ elementos: el });
      const m = b.elementos.media;
      if (m.classificacao === "fato_medido") {
        expect(m.media.denominador).toBe(7 - faltando);
        expect(m.texto).toMatch(new RegExp(`${7 - faltando} de 7 elementos respondidos`));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Sem mapa de rotulos
// ---------------------------------------------------------------------------

describe("criterio 7: sem mapa de rotulos nenhuma chave crua aparece", () => {
  const cenarios: [string, Partial<Montagem>][] = [
    ["contraste", { likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO }],
    ["convergencia", { likert: LIKERT_EXECUCAO, situacional: SIT_EXECUCAO }],
    ["so situacional destacado", { likert: LIKERT_PLANO, situacional: SIT_RELACAO }],
    ["so likert destacado", { likert: LIKERT_EXECUCAO, situacional: SIT_EMPATE }],
    ["empate", { situacional: SIT_EMPATE }],
    ["incompleto", { situacional: SIT_INCOMPLETA, semLikert: ["q16"] }],
  ];

  for (const [nome, m] of cenarios) {
    it(`${nome}: texto, prompt e titulos livres de chave`, () => {
      const b = briefing(m);
      const texto = tudo(b);
      const prompt = briefingParaPrompt(b);
      for (const chave of CHAVES_CRUAS) {
        expect(texto.toLowerCase()).not.toContain(chave);
        expect(prompt.toLowerCase()).not.toContain(chave);
      }
      expect(encontrarChavesVazadas(texto)).toEqual([]);
      expect(encontrarChavesVazadas(prompt)).toEqual([]);
      expect(texto).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(texto).not.toMatch(/\bq\d{2}\b/);
    });
  }

  it("a distribuicao nao tem texto sem rotulos (sem nome nao ha o que mostrar), e isso e avisado", () => {
    const b = briefing({ situacional: SIT_EMPATE });
    expect(b.eixos.distribuicaoSituacional.texto).toBeNull();
    expect(b.avisos[0].codigo).toBe("rotulos_eixos_ausentes");
  });

  it("rotulo invalido e descartado: chave, sublinhado, aspas, vazio e expressao vetada", () => {
    const b = briefing(
      { likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO },
      {
        rotulosEixos: {
          visao: "visao",
          execucao: "exec_ucao",
          relacao: "   ",
          integridade: "Perfil dominante",
        },
      },
    );
    expect(b.avisos.map((a) => a.codigo)).toContain("rotulo_invalido_descartado");
    const texto = tudo(b);
    expect(texto).not.toContain("exec_ucao");
    expect(texto).not.toMatch(/perfil dominante/i);
    expect(texto).toContain("uma das dimensões avaliadas");
    const comAspas = briefing(
      { likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO },
      { rotulosEixos: { execucao: 'Be"ta', relacao: "Ga\nma" } },
    );
    expect(tudo(comAspas)).not.toContain('Be"ta');
  });

  it("rotulo valido e usado entre aspas e nao dispara a checagem de chave", () => {
    const b = briefing(
      { likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO },
      { rotulosEixos: { execucao: "Integridade e entrega", relacao: "Visão" } },
    );
    expect(tudo(b)).toContain("“Integridade e entrega”");
    expect(tudo(b)).toContain("“Visão”");
  });
});

// ---------------------------------------------------------------------------
// 8. Varredura: lista de proibicoes sobre TODO texto gerado
// ---------------------------------------------------------------------------

function mulberry32(semente: number) {
  let a = semente;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function respostasAleatorias(rand: () => number): RespostasAchatadas {
  const taxaFalta = [0, 0, 0.04, 0.2, 0.5, 0.95][Math.floor(rand() * 6)];
  const falta = () => rand() < taxaFalta;
  const r: RespostasAchatadas = {};
  // Likert por eixo: base propria + ruido, para gerar destaque, empate e margem curta.
  for (const eixo of EIXOS) {
    const base = 1 + Math.floor(rand() * 5);
    for (const id of ITENS_LIKERT[eixo]) {
      if (falta()) continue;
      const ruido = rand() < 0.3 ? Math.floor(rand() * 5) - 2 : 0;
      r[id] = Math.min(5, Math.max(1, base + ruido));
    }
  }
  const eixoFavorito = EIXOS[Math.floor(rand() * 4)];
  for (const q of SITUACIONAIS) {
    if (falta()) continue;
    const eixo = rand() < 0.55 ? eixoFavorito : EIXOS[Math.floor(rand() * 4)];
    r[q] = alternativaPara(q, eixo);
  }
  const repetido = Math.floor(rand() * 11);
  for (const el of ELEMENTOS) {
    if (falta()) continue;
    r[ITENS_ELEMENTOS[el]] = rand() < 0.3 ? repetido : Math.floor(rand() * 11);
  }
  return r;
}

const CONFIGURACOES_DE_ROTULO: [string, OpcoesBriefing | undefined][] = [
  ["sem rotulos", undefined],
  ["rotulos completos", ROTULOS_TESTE],
  [
    "rotulos parciais e palavras comuns",
    { rotulosEixos: { visao: "Integridade", relacao: "Visão" }, rotulosElementos: { saude_energia: "Energia" } },
  ],
  ["rotulos invalidos", { rotulosEixos: { visao: "visao", execucao: "", relacao: "perfil dominante" } }],
];

describe("criterio 8: varredura de expressoes vetadas sobre todo texto gerado", () => {
  // Fixtures nomeadas (incompletas, empatadas, completas) + sorteio deterministico.
  const fixtures: RespostasAchatadas[] = [
    respostas(),
    respostas({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO }),
    respostas({ likert: LIKERT_EXECUCAO, situacional: SIT_EXECUCAO }),
    respostas({ situacional: SIT_EMPATE }),
    respostas({ situacional: SIT_MARGEM_1 }),
    respostas({ situacional: SIT_INCOMPLETA }),
    respostas({ elementos: {} }),
    respostas({ elementos: { saude_energia: 0 } }),
    respostas({ elementos: { ...NOTAS_NEUTRAS, saude_energia: 9 } }),
    {},
  ];
  const rand = mulberry32(20260101);
  const sorteadas = Array.from({ length: 1500 }, () => respostasAleatorias(rand));
  const todas = [...fixtures, ...sorteadas];

  it("o proprio varredor reconhece as frases vetadas (anti-vacuidade)", () => {
    const vetadas = [
      "Seu perfil dominante é execução.",
      "Sua maior força comprovada é equilíbrio emocional.",
      "Seu ponto mais forte é a saúde.",
      "Seu ponto forte é a relação.",
      "Você age com foco em resultado.",
      "Sob pressão você se comporta de forma organizada.",
      "Seu comportamento é consistente.",
      "Esse elemento é a sua maior fragilidade.",
      "Eixo predominante: Alfa.",
      "O elemento não respondido é o seu ponto fraco.",
      "VOCÊ AGE rápido",
      "Você é uma pessoa de execução.",
      "O resultado comprova que você decide rápido.",
      "O elemento não respondido ficou com o menor valor.",
      "Sua forma de agir é prática.",
    ];
    for (const frase of vetadas) {
      expect(encontrarExpressoesVetadas(frase), frase).not.toEqual([]);
    }
    // E nao ha falso positivo nos textos aprovados.
    for (const aprovado of [
      ...TEXTO_SITUACIONAL_SEM_DESTAQUE,
      FRASE_ELEMENTO_MAIOR,
      "O que essa diferença pode revelar sobre suas prioridades?",
      "Você se descreve com forte orientação à execução.",
    ]) {
      expect(encontrarExpressoesVetadas(aprovado), aprovado).toEqual([]);
    }
    expect(EXPRESSOES_VETADAS.length).toBeGreaterThan(5);
  });

  for (const [nomeConfig, opcoes] of CONFIGURACOES_DE_ROTULO) {
    it(`${nomeConfig}: nenhuma saida contem expressao vetada nem chave crua (${todas.length} entradas)`, () => {
      const permitidos: string[] = [];
      let maiorApresentavel = 0;
      let semMenor = 0;
      for (const r of todas) {
        const scores = calcularMarcoZero(r);
        const b = montarBriefingMarcoZero(scores, opcoes);
        const prompt = briefingParaPrompt(b);

        const rotulos = Object.values(opcoes?.rotulosEixos ?? {}).filter(
          (x) => b.afirmacoes.some((a) => a.texto?.includes(`“${x}”`)),
        );
        permitidos.splice(0, permitidos.length, ...rotulos, ...Object.values(ROTULOS_ELEMENTOS_PADRAO), "Energia");

        for (const t of textosDoParticipante(b)) {
          expect(encontrarExpressoesVetadas(t), t).toEqual([]);
          expect(encontrarChavesVazadas(t, permitidos), t).toEqual([]);
        }
        // O prompt carrega os mesmos fragmentos e nao pode ser porta dos fundos.
        const linhasDeFragmento = prompt
          .split("\n")
          .filter((l) => l.startsWith("[") || l.startsWith("  "));
        for (const l of linhasDeFragmento) {
          expect(encontrarExpressoesVetadas(l), l).toEqual([]);
          expect(encontrarChavesVazadas(l, permitidos), l).toEqual([]);
        }

        invariantes(scores, b);
        if (b.elementos.maior.classificacao === "fato_medido") maiorApresentavel += 1;
        if (b.elementos.menor.classificacao === "indeterminado") semMenor += 1;
      }
      expect(maiorApresentavel).toBeGreaterThan(0);
      expect(semMenor).toBeGreaterThan(0);
    });
  }

  it("a varredura cobre todos os ramos relevantes (nao e vacua)", () => {
    const vistos = new Set<string>();
    for (const r of todas) {
      const b = montarBriefingMarcoZero(calcularMarcoZero(r), ROTULOS_TESTE);
      for (const a of b.afirmacoes) {
        vistos.add(
          a.classificacao === "indeterminado"
            ? `${a.id}:indeterminado:${a.motivo}`
            : `${a.id}:${a.classificacao}`,
        );
      }
    }
    for (const esperado of [
      "eixos.likert.destaque:fato_medido",
      "eixos.likert.destaque:indeterminado:empate",
      "eixos.likert.destaque:indeterminado:margem_insuficiente",
      "eixos.likert.destaque:indeterminado:respostas_incompletas",
      "eixos.situacional.destaque:fato_medido",
      "eixos.situacional.destaque:indeterminado:empate",
      "eixos.situacional.destaque:indeterminado:margem_insuficiente",
      "eixos.situacional.destaque:indeterminado:respostas_incompletas",
      "eixos.situacional.distribuicao:fato_medido",
      "eixos.cruzamento.contraste:hipotese_a_validar",
      "eixos.cruzamento.convergencia:fato_medido",
      "eixos.cruzamento.reflexao:hipotese_a_validar",
      "eixos.cruzamento.indeterminado:indeterminado:algum_instrumento_sem_destaque",
      "elementos.media:fato_medido",
      "elementos.media:indeterminado:elementos_insuficientes",
      "elementos.maior:fato_medido",
      "elementos.maior:indeterminado:empate_no_topo",
      "elementos.maior:indeterminado:elementos_incompletos",
      "elementos.maior:indeterminado:elementos_insuficientes",
      "elementos.menor:fato_medido",
      "elementos.menor:indeterminado:empate_na_base",
      "elementos.menor:indeterminado:elementos_incompletos",
      "elementos.notas:fato_medido",
    ]) {
      expect(vistos.has(esperado), `ramo nao coberto: ${esperado}`).toBe(true);
    }
    // Nenhuma inconsistencia nas entradas geradas pelo proprio motor.
    expect([...vistos].some((v) => v.includes("dados_inconsistentes"))).toBe(false);
  });
});

// Invariantes estruturais, validadas em cada entrada da varredura.
function invariantes(scores: ReturnType<typeof calcularMarcoZero>, b: BriefingMarcoZero) {
  expect(b.avisos.filter((a) => a.codigo === "dados_inconsistentes")).toEqual([]);

  for (const a of b.afirmacoes) {
    expect(a.fontes.length).toBeGreaterThan(0);
    for (const f of a.fontes) {
      expect(f.respondidas).toBeLessThanOrEqual(f.total);
      expect(f.completo).toBe(f.respondidas === f.total);
    }
    if (a.classificacao === "indeterminado") {
      for (const campo of [
        "eixoInterno",
        "elementoInterno",
        "escolhas",
        "media",
        "itens",
        "eixoAutodescricaoInterno",
        "eixoEscolhasInterno",
      ]) {
        expect(a, `${a.id} indeterminado carrega ${campo}`).not.toHaveProperty(campo);
      }
    }
  }

  // Regra 1/2: eixo destacado so com status destacado dos instrumentos.
  if (scores.analiseSituacional.status !== "destacado") {
    expect(b.eixos.situacional.classificacao).toBe("indeterminado");
    expect(b.eixos.cruzamento.every((a) => a.classificacao === "indeterminado")).toBe(true);
  }
  if (scores.analiseLikert.status !== "destacado") {
    expect(b.eixos.likert.classificacao).toBe("indeterminado");
    expect(b.eixos.cruzamento.every((a) => a.classificacao === "indeterminado")).toBe(true);
  }
  // O contraste e sempre hipotese; nunca fato.
  for (const a of b.eixos.cruzamento) {
    if (a.id === "eixos.cruzamento.contraste") {
      expect(a.classificacao).toBe("hipotese_a_validar");
      expect(a.texto.endsWith("?")).toBe(true);
    }
  }
  // Regra 3/4: elemento so com 7 de 7.
  const faltaElemento = ELEMENTOS.some((el) => scores.elementos[el].valor === null);
  if (faltaElemento) {
    expect(b.elementos.menor.classificacao).toBe("indeterminado");
    expect(b.elementos.maior.classificacao).toBe("indeterminado");
  }
  if (b.elementos.maior.classificacao === "fato_medido") {
    expect(scores.elementoDeMaiorPontuacao.status).toBe("apresentavel");
    expect(b.elementos.maior.texto).toContain(FRASE_ELEMENTO_MAIOR);
  }
  // Regra 3: media sempre com denominador.
  const media = b.elementos.media;
  if (media.classificacao === "fato_medido") {
    expect(media.media.denominador).toBe(scores.analiseElementos.elementosRespondidos);
    expect(media.texto).toContain(`${media.media.denominador} de 7 elementos respondidos`);
  }
}

// ---------------------------------------------------------------------------
// Garantias estruturais gerais
// ---------------------------------------------------------------------------

describe("garantias estruturais", () => {
  it("toda afirmacao carrega fonte (instrumento + completude) e classificacao", () => {
    const b = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO }, ROTULOS_TESTE);
    for (const a of b.afirmacoes) {
      expect(["fato_medido", "hipotese_a_validar", "indeterminado"]).toContain(a.classificacao);
      expect(a.fontes.length).toBeGreaterThan(0);
      for (const f of a.fontes) {
        expect(["likert", "situacional", "elementos"]).toContain(f.instrumento);
        expect(typeof f.completo).toBe("boolean");
        expect(f.statusDoMotor).toBeTruthy();
      }
    }
    const likert = b.eixos.likert.fontes[0];
    expect(likert).toMatchObject({ instrumento: "likert", respondidas: 24, total: 24, statusDoMotor: "destacado" });
  });

  it("a fonte reflete itens faltantes (23 de 24) e rebaixa o destaque", () => {
    const b = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO, semLikert: ["q22"] }, ROTULOS_TESTE);
    expect(b.eixos.likert.fontes[0]).toMatchObject({ respondidas: 23, total: 24, completo: false, statusDoMotor: "incompleto" });
    expect(b.eixos.likert.classificacao).toBe("indeterminado");
    expect(tudo(b)).toContain("23 de 24 respondidas");
  });

  it("o briefing e imutavel", () => {
    const b = briefing({}, ROTULOS_TESTE);
    expect(() => {
      (b as unknown as { versao: number }).versao = 2;
    }).toThrow();
    expect(() => {
      (b.afirmacoes as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("e deterministico", () => {
    const m = { likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO };
    expect(briefing(m, ROTULOS_TESTE)).toEqual(briefing(m, ROTULOS_TESTE));
  });

  it("dados incoerentes do motor sao descartados, nao repassados", () => {
    const scores = calcularMarcoZero(respostas({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO }));
    const adulterado = {
      ...scores,
      analiseSituacional: { ...scores.analiseSituacional, eixoDestacado: null },
    };
    const b = montarBriefingMarcoZero(adulterado, ROTULOS_TESTE);
    expect(b.eixos.situacional.classificacao).toBe("indeterminado");
    expect(b.avisos.map((a) => a.codigo)).toContain("dados_inconsistentes");

    const maiorForjado = {
      ...calcularMarcoZero(respostas()),
      elementoDeMaiorPontuacao: { elemento: "saude_energia" as const, status: "apresentavel" as const },
    };
    const b2 = montarBriefingMarcoZero(maiorForjado);
    expect(b2.elementos.maior.classificacao).toBe("indeterminado");
    expect(b2.avisos.map((a) => a.codigo)).toContain("dados_inconsistentes");
  });

  it("o prompt separa fato, hipotese e indeterminado e nao vaza valores de indeterminados", () => {
    const b = briefing({ likert: LIKERT_EXECUCAO, situacional: SIT_RELACAO, elementos: { saude_energia: 5 } }, ROTULOS_TESTE);
    const prompt = briefingParaPrompt(b);
    expect(prompt).toContain("[FATO MEDIDO]");
    expect(prompt).toContain("[HIPÓTESE A VALIDAR]");
    expect(prompt).toContain("[INDETERMINADO]");
    expect(prompt).toContain("AUTORRELATO");
    expect(prompt).not.toContain("Saúde e energia");
  });
});

function normalizado(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
