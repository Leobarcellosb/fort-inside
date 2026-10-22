import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EIXOS,
  ELEMENTOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  MAPA_SITUACIONAL,
  SITUACIONAIS,
  type Alternativa,
  type Eixo,
  type Elemento,
  type RespostasAchatadas,
} from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import { renderizarOnePager } from "../../../lib/pdf/render-one-pager-pdf";
import {
  CATALOGO_DIMENSOES,
  ROTULOS_DIMENSAO,
  ROTULOS_EIXOS_MARCO_ZERO,
  assertPublicavel,
  type RotuloDimensao,
} from "./catalogo-dimensoes";
import {
  TEXTOS_MOLDURA,
  montarModeloOnePager,
  textosDoOnePager,
  verificarModelo,
} from "./one-pager-modelo";
import { OnePagerPdfDocument } from "./OnePagerPdfDocument";
import { calcularMarcoZero } from "../../../lib/scoring/marco-zero";
import {
  FRASE_ELEMENTO_MAIOR,
  FRASE_ELEMENTO_MENOR,
  TEXTO_SITUACIONAL_SEM_DESTAQUE,
} from "../../../lib/scoring/briefing-marco-zero";
import {
  validarTextoDeSaida,
  validarTextosDeSaida,
} from "./validacao-saida";

// ---------------------------------------------------------------------------
// Participantes sinteticos
// ---------------------------------------------------------------------------

const ALTS: Alternativa[] = ["A", "B", "C", "D"];
const alt = (q: (typeof SITUACIONAIS)[number], eixo: Eixo): Alternativa =>
  ALTS.find((a) => MAPA_SITUACIONAL[q][a] === eixo) as Alternativa;

interface Perfil {
  likert: Record<Eixo, number[]>; // 6 notas por eixo; undefined = sem resposta
  situacional: (Eixo | null)[];
  elementos: Partial<Record<Elemento, number>>;
}

function montar(p: Perfil): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  for (const e of EIXOS) {
    ITENS_LIKERT[e].forEach((id, i) => {
      const v = p.likert[e][i];
      if (v !== undefined) r[id] = v;
    });
  }
  SITUACIONAIS.forEach((q, i) => {
    const e = p.situacional[i];
    if (e) r[q] = alt(q, e);
  });
  for (const el of ELEMENTOS) {
    const v = p.elementos[el];
    if (v !== undefined) r[ITENS_ELEMENTOS[el]] = v;
  }
  return r;
}

const fixo = (n: number) => [n, n, n, n, n, n];
const ELEM_COMPLETOS: Record<Elemento, number> = {
  desenvolvimento_intelectual: 8,
  saude_energia: 6,
  equilibrio_emocional: 5,
  recursos_financeiros: 7,
  contribuicao_social: 4,
  realizacao_proposito: 9,
  hobbies_diversao: 6,
};

export const PARTICIPANTES: {
  id: string;
  descricao: string;
  nome: string;
  respostas: RespostasAchatadas;
}[] = [
  {
    id: "1-destaque-nos-dois",
    descricao: "destaque claro nos dois instrumentos (mesma dimensao)",
    nome: "Marina Albuquerque",
    respostas: montar({
      likert: { visao: fixo(5), execucao: fixo(3), relacao: fixo(3), integridade: fixo(4) },
      situacional: ["visao", "visao", "visao", "visao", "execucao", "relacao"],
      elementos: ELEM_COMPLETOS,
    }),
  },
  {
    id: "2-contraste",
    descricao: "destaque nos dois, em dimensoes diferentes (contraste)",
    nome: "Rafael Tavares Nogueira",
    respostas: montar({
      likert: { visao: fixo(3), execucao: fixo(5), relacao: fixo(3), integridade: fixo(3) },
      situacional: ["relacao", "relacao", "relacao", "relacao", "integridade", "visao"],
      elementos: ELEM_COMPLETOS,
    }),
  },
  {
    id: "3-indeterminacao-situacional",
    descricao: "Likert com destaque; situacional sem margem (2-2-1-1)",
    nome: "Camila Duarte",
    respostas: montar({
      likert: { visao: fixo(3), execucao: fixo(3), relacao: fixo(5), integridade: fixo(3) },
      situacional: ["visao", "visao", "execucao", "execucao", "relacao", "integridade"],
      elementos: ELEM_COMPLETOS,
    }),
  },
  {
    id: "3b-indeterminacao-total",
    descricao: "caso mais comum: nenhum dos dois instrumentos atinge a margem",
    nome: "Bruno Siqueira",
    respostas: montar({
      likert: {
        visao: [4, 4, 4, 4, 4, 4],
        execucao: [4, 4, 4, 4, 4, 3],
        relacao: [4, 4, 4, 4, 3, 3],
        integridade: [4, 4, 4, 4, 4, 4],
      },
      situacional: ["visao", "execucao", "relacao", "integridade", "visao", "execucao"],
      elementos: { ...ELEM_COMPLETOS, saude_energia: 9 },
    }),
  },
  {
    id: "4-elementos-incompletos",
    descricao: "5 de 7 elementos respondidos; destaque nos dois instrumentos",
    nome: "Helena Prado Vasconcelos",
    respostas: montar({
      likert: { visao: fixo(3), execucao: fixo(3), relacao: fixo(3), integridade: fixo(5) },
      situacional: ["integridade", "integridade", "integridade", "execucao", "visao", "integridade"],
      elementos: {
        desenvolvimento_intelectual: 7,
        saude_energia: 3,
        equilibrio_emocional: 6,
        realizacao_proposito: 8,
        hobbies_diversao: 5,
      },
    }),
  },
  {
    id: "5-muito-incompleto",
    descricao: "itens Likert e situacionais faltando, so 3 elementos",
    nome: "Tiago",
    respostas: montar({
      likert: {
        visao: [4, 4, 4, undefined as unknown as number, 4, 4],
        execucao: fixo(3),
        relacao: fixo(3),
        integridade: fixo(3),
      },
      situacional: ["visao", "visao", null, null, "relacao", null],
      elementos: { saude_energia: 0, equilibrio_emocional: 4, hobbies_diversao: 10 },
    }),
  },
];

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const META = {
  nomeEvento: "Marco Zero | Geração Preparada",
  dataEvento: "2026-11-14",
};

const APROVADOS = new Set<string>([
  ...EIXOS.map((e) => ROTULOS_EIXOS_MARCO_ZERO[e]),
  ...ELEMENTOS.map((el) => ROTULOS_ELEMENTOS_PADRAO[el]),
]);

function citados(texto: string): string[] {
  return [...texto.matchAll(/“([^”]+)”/g)].map((m) => m[1]);
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("catalogo de dimensoes", () => {
  it("tem exatamente os quatro rotulos aprovados, nas chaves do motor", () => {
    expect(Object.keys(CATALOGO_DIMENSOES.dimensoes).sort()).toEqual([...EIXOS].sort());
    expect(ROTULOS_EIXOS_MARCO_ZERO).toEqual({
      visao: "Visão e Direção",
      execucao: "Execução e Consistência",
      relacao: "Relacionamento e Colaboração",
      integridade: "Integridade e Responsabilidade",
    });
  });

  it("e fechado: congelado e toda definicao e de capacidade autodeclarada", () => {
    expect(Object.isFrozen(CATALOGO_DIMENSOES)).toBe(true);
    expect(Object.isFrozen(CATALOGO_DIMENSOES.dimensoes)).toBe(true);
    expect(() => {
      (CATALOGO_DIMENSOES.dimensoes as unknown as Record<string, unknown>).quinta = {};
    }).toThrow();
    for (const e of EIXOS) {
      expect(CATALOGO_DIMENSOES.dimensoes[e].definicao.startsWith("Capacidade autodeclarada")).toBe(true);
    }
    expect(CATALOGO_DIMENSOES.estado).toBe("funcional_pendente_de_ratificacao");
  });

  it("e fechado no tipo: um quinto nome nao e expressavel", () => {
    const ok: RotuloDimensao = "Visão e Direção";
    expect(ROTULOS_DIMENSAO).toContain(ok);
    // @ts-expect-error quinto nome nao pertence a RotuloDimensao
    const quinto: RotuloDimensao = "Estratégia e Foco";
    expect(ROTULOS_DIMENSAO).not.toContain(quinto);
    // @ts-expect-error variacao de um dos quatro tambem nao
    const variacao: RotuloDimensao = "Visão";
    expect(ROTULOS_DIMENSAO).not.toContain(variacao);
  });

  it("publicacao oficial e barrada enquanto o catalogo nao for ratificado", async () => {
    expect(() => assertPublicavel()).toThrow(/ratifica/);
    await expect(
      renderizarOnePager(PARTICIPANTES[0].respostas, { nomeParticipante: "X" }, { paraPublicacao: true }),
    ).rejects.toThrow(/ratifica/);
    // desenvolvimento e teste seguem liberados
    const r = await renderizarOnePager(PARTICIPANTES[0].respostas, { nomeParticipante: "X" });
    expect(r.modelo.catalogoEstado).toBe("funcional_pendente_de_ratificacao");
    expect(r.modelo.cabecalho.selo).toMatch(/pendentes de ratificação/);
  });
});

describe("validacao de saida (catalogo fechado)", () => {
  const recusadas: [string, string][] = [
    ["quinto nome entre aspas", "Você se descreve com forte orientação à dimensão “Estratégia e Foco”."],
    ["renomear uma dimensao", "A dimensão “Visão e Direção” agora se chama “Visão Estratégica”."],
    ["rotulo abreviado", "Suas escolhas favoreceram Execução."],
    ["so metade do rotulo", "Você se destaca em Colaboração."],
    ["radical solto", "Integridade foi o que mais apareceu."],
    ["nome proprio apos dimensao", "A dimensão Inovação favoreceu suas escolhas."],
    ["nome proprio apos eixo", "O eixo Liderança teve destaque."],
    ["perfil", "Seu perfil é Execução e Consistência."],
    ["perfil com rotulo aprovado", "Seu perfil é “Execução e Consistência”."],
    ["identidade pela dimensao", "Você é “Visão e Direção”."],
    ["identidade com artigo", "Você é uma pessoa de “Visão e Direção”."],
    ["do tipo", "Você é do tipo executor."],
    ["dimensao principal", "Sua dimensão principal é “Visão e Direção”."],
    ["personalidade", "A dimensão “Visão e Direção” descreve sua personalidade."],
    ["tipologia", "Trata-se de uma tipologia de quatro dimensões."],
    ["expressao vetada da camada", "Você age com foco em “Visão e Direção”."],
    ["chave interna vazada", "Seu eixo é visao."],
  ];

  it("o varredor recusa cada frase proibida (anti-vacuidade)", () => {
    for (const [, frase] of recusadas) {
      expect(validarTextoDeSaida(frase), frase).not.toEqual([]);
    }
  });

  it("e nao ha falso positivo nos textos aprovados", () => {
    const aprovados = [
      ...ROTULOS_DIMENSAO,
      ...Object.values(CATALOGO_DIMENSOES.dimensoes).map((d) => d.definicao),
      ...TEXTO_SITUACIONAL_SEM_DESTAQUE,
      FRASE_ELEMENTO_MAIOR,
      FRASE_ELEMENTO_MENOR,
      "Você se descreve com forte orientação à dimensão “Visão e Direção”.",
      "Nas situações hipotéticas, porém, suas escolhas favoreceram a dimensão “Relacionamento e Colaboração”.",
      "O que essa diferença pode revelar sobre suas prioridades?",
      ...Object.values(TEXTOS_MOLDURA),
    ];
    for (const a of aprovados) expect(validarTextoDeSaida(a), a).toEqual([]);
  });

  it("um modelo com quinto nome plantado nao vira texto nem documento", () => {
    const p = PARTICIPANTES[1];
    const modelo = montarModeloOnePager(calcularMarcoZero(p.respostas), { nomeParticipante: p.nome });
    expect(() => verificarModelo(modelo)).not.toThrow();
    const adulterado = {
      ...modelo,
      paraRefletir: {
        ...modelo.paraRefletir,
        fechamento: "Sua dimensão é “Inovação e Futuro”.",
      },
    };
    expect(() => verificarModelo(adulterado)).toThrow(/nome_fora_do_catalogo/);
    // O componente tambem se recusa a renderizar (ultima barreira).
    expect(() => OnePagerPdfDocument({ modelo: adulterado })).toThrow(/nome_fora_do_catalogo/);
  });
});

describe("one-pager do Marco Zero", () => {
  const saida = process.env.ONE_PAGER_SAIDA;
  if (saida) mkdirSync(saida, { recursive: true });

  for (const p of PARTICIPANTES) {
    describe(p.id, () => {
      it("renderiza em UMA pagina, sem texto vetado e so com rotulos aprovados", async () => {
        const { pdf, paginas, modelo } = await renderizarOnePager(p.respostas, {
          nomeParticipante: p.nome,
          ...META,
        });
        const textos = textosDoOnePager(modelo);
        if (saida) {
          writeFileSync(join(saida, `${p.id}.pdf`), pdf);
          writeFileSync(
            join(saida, `${p.id}.txt`),
            `${p.descricao}\n\n${textos.join("\n\n")}\n`,
          );
        }
        expect(validarTextosDeSaida(textos)).toEqual([]);
        for (const t of textos) {
          for (const c of citados(t)) expect(APROVADOS.has(c), `rotulo fora do catalogo: ${c}`).toBe(true);
        }
        expect(paginas).toBe(1);
      });
    });
  }

  it("nunca ordena nem desenha elemento ausente como zero", async () => {
    const p = PARTICIPANTES.find((x) => x.id === "5-muito-incompleto")!;
    const { modelo } = await renderizarOnePager(p.respostas, { nomeParticipante: p.nome });
    // 3 de 7 respondidos: abaixo do piso, sem tabela e sem comparacao.
    expect(modelo.elementos.notas).toBeNull();
    expect(modelo.elementos.textoAviso).toMatch(/3 dos sete elementos/);
    expect(modelo.elementos.maior).toBeNull();
    expect(modelo.elementos.menor).toBeNull();
    const parcial = PARTICIPANTES.find((x) => x.id === "4-elementos-incompletos")!;
    const r = await renderizarOnePager(parcial.respostas, { nomeParticipante: parcial.nome });
    const ausentes = r.modelo.elementos.notas!.filter((n) => n.nota === null);
    expect(ausentes).toHaveLength(2);
    expect(r.modelo.elementos.maior).toBeNull();
    expect(r.modelo.elementos.menor).toBeNull();
    // ordem do questionario, nao por valor
    expect(r.modelo.elementos.notas!.map((n) => n.rotulo)).toEqual(
      ELEMENTOS.map((el) => ROTULOS_ELEMENTOS_PADRAO[el]),
    );
  });

  it("indeterminacao: mostra as quatro dimensoes, a distribuicao e nenhum destaque", async () => {
    const p = PARTICIPANTES.find((x) => x.id === "3b-indeterminacao-total")!;
    const { modelo } = await renderizarOnePager(p.respostas, { nomeParticipante: p.nome });
    expect(modelo.autodescricao.destaque).toBeNull();
    expect(modelo.cruzamento).toBeNull();
    expect(modelo.situacional.pontos!.eixos.some((e) => e.destacado)).toBe(false);
    expect(modelo.situacional.pontos!.eixos).toHaveLength(4);
    expect(modelo.dimensoes.itens.map((d) => d.rotulo)).toEqual(
      EIXOS.map((e) => ROTULOS_EIXOS_MARCO_ZERO[e]),
    );
  });

  it("fuzz: 300 conjuntos aleatorios (com dados faltando) cabem em uma pagina", async () => {
    const rnd = mulberry32(20261021);
    const falta = (v: number | string, chance: number) => (rnd() < chance ? undefined : v);
    let comCruzamento = 0;
    let comMaiorMenor = 0;
    for (let i = 0; i < 300; i++) {
      const chance = i % 3 === 0 ? 0 : i % 3 === 1 ? 0.08 : 0.3;
      const r: RespostasAchatadas = {};
      for (const e of EIXOS) {
        for (const id of ITENS_LIKERT[e]) {
          // vies para destaque em parte dos casos
          const base = i % 4 === 0 && e === "visao" ? 4 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 5);
          const v = falta(base, chance);
          if (v !== undefined) r[id] = v;
        }
      }
      for (const q of SITUACIONAIS) {
        const e = EIXOS[Math.floor(rnd() * 4)];
        const v = falta(alt(q, i % 5 === 0 ? "relacao" : e), chance);
        if (v !== undefined) r[q] = v;
      }
      for (const el of ELEMENTOS) {
        const v = falta(Math.floor(rnd() * 11), chance);
        if (v !== undefined) r[ITENS_ELEMENTOS[el]] = v;
      }
      const nome = i % 7 === 0 ? "Maria Fernanda de Albuquerque Cavalcanti Rodrigues" : "Ana";
      const out = await renderizarOnePager(r, { nomeParticipante: nome, ...META });
      expect(out.paginas, `caso ${i}`).toBe(1);
      expect(validarTextosDeSaida(textosDoOnePager(out.modelo)), `caso ${i}`).toEqual([]);
      if (out.modelo.cruzamento) comCruzamento++;
      if (out.modelo.elementos.maior && out.modelo.elementos.menor) comMaiorMenor++;
    }
    // garante que o fuzz exercitou os casos pesados
    expect(comCruzamento).toBeGreaterThan(5);
    expect(comMaiorMenor).toBeGreaterThan(5);
  }, 240_000);
});
