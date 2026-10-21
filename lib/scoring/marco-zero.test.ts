import { describe, expect, it } from "vitest";
import {
  EIXOS,
  ELEMENTOS,
  calcularMarcoZero,
  type Alternativa,
  type Eixo,
  type RespostasAchatadas,
} from "./marco-zero";

const LIKERT_IDS: Record<Eixo, string[]> = {
  visao: ["q16", "q17", "q18", "q19", "q20", "q21"],
  execucao: ["q22", "q23", "q24", "q25", "q26", "q27"],
  relacao: ["q28", "q29", "q30", "q31", "q32", "q33"],
  integridade: ["q34", "q35", "q36", "q37", "q38", "q39"],
};
const SIT_IDS = ["q40", "q41", "q42", "q43", "q44", "q45"] as const;

// Mapa escrito por extenso aqui, de forma independente do modulo.
const MAPA: Record<(typeof SIT_IDS)[number], Record<Alternativa, Eixo>> = {
  q40: { A: "visao", B: "execucao", C: "relacao", D: "integridade" },
  q41: { A: "relacao", B: "integridade", C: "visao", D: "execucao" },
  q42: { A: "execucao", B: "visao", C: "integridade", D: "relacao" },
  q43: { A: "integridade", B: "execucao", C: "relacao", D: "visao" },
  q44: { A: "visao", B: "relacao", C: "execucao", D: "integridade" },
  q45: { A: "relacao", B: "execucao", C: "integridade", D: "visao" },
};
const ALTS: Alternativa[] = ["A", "B", "C", "D"];

function alternativaPara(q: (typeof SIT_IDS)[number], eixo: Eixo): Alternativa {
  const alt = ALTS.find((a) => MAPA[q][a] === eixo);
  if (!alt) throw new Error(`mapa sem ${eixo} em ${q}`);
  return alt;
}

interface Montagem {
  /** nota fixa por eixo (aplicada aos 6 itens) */
  likert?: Partial<Record<Eixo, number>>;
  /** eixo escolhido em cada situacional, na ordem q40..q45 */
  situacional?: Eixo[];
  elementos?: number[];
}

function montar({ likert = {}, situacional, elementos }: Montagem): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  for (const eixo of EIXOS) {
    for (const id of LIKERT_IDS[eixo]) r[id] = likert[eixo] ?? 3;
  }
  const escolhas: Eixo[] =
    situacional ?? ["visao", "execucao", "relacao", "integridade", "visao", "execucao"];
  SIT_IDS.forEach((q, i) => {
    r[q] = alternativaPara(q, escolhas[i]);
  });
  const el = elementos ?? [5, 5, 5, 5, 5, 5, 5];
  el.forEach((v, i) => {
    r[`q${7 + i}`] = v;
  });
  return r;
}

describe("calcularMarcoZero", () => {
  it("5 em tudo: todos os eixos em 100", () => {
    const r = calcularMarcoZero(
      montar({ likert: { visao: 5, execucao: 5, relacao: 5, integridade: 5 } }),
    );
    for (const eixo of EIXOS) {
      expect(r.eixos[eixo].likert0a100).toBe(100);
      expect(r.eixos[eixo].likertBruto).toBe(30);
    }
    expect(r.incompleto).toEqual([]);
  });

  it("1 em tudo: todos os eixos em 0", () => {
    const r = calcularMarcoZero(
      montar({ likert: { visao: 1, execucao: 1, relacao: 1, integridade: 1 } }),
    );
    for (const eixo of EIXOS) {
      expect(r.eixos[eixo].likert0a100).toBe(0);
      expect(r.eixos[eixo].likertBruto).toBe(6);
    }
  });

  it("normaliza e arredonda para inteiro", () => {
    const r = calcularMarcoZero(montar({ likert: { visao: 4 } })); // soma 24 -> 75
    expect(r.eixos.visao.likert0a100).toBe(75);
    const dados = montar({});
    dados.q16 = 4; // soma 19 -> 13/24*100 = 54.17 -> 54
    expect(calcularMarcoZero(dados).eixos.visao.likert0a100).toBe(54);
  });

  it("perfil declarado diferente do dominante gera divergencia", () => {
    // Declara-se visao (likert alto) mas responde situacionais como relacao.
    const r = calcularMarcoZero(
      montar({
        likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 },
        situacional: ["relacao", "relacao", "relacao", "relacao", "relacao", "relacao"],
      }),
    );
    expect(r.perfilDeclarado).toBe("visao");
    expect(r.perfilDominante).toBe("relacao");
    expect(r.divergencia).toBe(true);
  });

  it("perfil declarado igual ao dominante nao gera divergencia", () => {
    const r = calcularMarcoZero(
      montar({
        likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 },
        situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
      }),
    );
    expect(r.perfilDeclarado).toBe("visao");
    expect(r.perfilDominante).toBe("visao");
    expect(r.divergencia).toBe(false);
  });

  describe("mapa das situacionais", () => {
    for (const q of SIT_IDS) {
      for (const alt of ALTS) {
        it(`${q}=${alt} soma 1 ao eixo ${MAPA[q][alt]} e a nenhum outro`, () => {
          const dados = montar({});
          for (const outra of SIT_IDS) delete dados[outra];
          dados[q] = alt;
          const r = calcularMarcoZero(dados);
          for (const eixo of EIXOS) {
            expect(r.eixos[eixo].situacional).toBe(eixo === MAPA[q][alt] ? 1 : 0);
          }
          expect(r.incompleto).toEqual(SIT_IDS.filter((o) => o !== q));
        });
      }
    }

    it("cada questao cobre os 4 eixos exatamente uma vez", () => {
      for (const q of SIT_IDS) {
        expect(new Set(Object.values(MAPA[q]))).toEqual(new Set(EIXOS));
      }
    });

    it("6 respostas A distribuem conforme o mapa", () => {
      const dados = montar({});
      for (const q of SIT_IDS) dados[q] = "A";
      const r = calcularMarcoZero(dados);
      // A: visao(q40,q44) relacao(q41,q45) execucao(q42) integridade(q43)
      expect(r.eixos.visao.situacional).toBe(2);
      expect(r.eixos.relacao.situacional).toBe(2);
      expect(r.eixos.execucao.situacional).toBe(1);
      expect(r.eixos.integridade.situacional).toBe(1);
    });
  });

  describe("respostas faltando", () => {
    it("registra em incompleto, nao lanca e calcula o resto", () => {
      const dados = montar({ likert: { visao: 5, execucao: 5, relacao: 5, integridade: 5 } });
      delete dados.q16;
      dados.q22 = "abc"; // invalido
      dados.q28 = 9; // fora da escala
      delete dados.q40;
      delete dados.q9;
      dados.q10 = 11; // fora de 0..10

      let r!: ReturnType<typeof calcularMarcoZero>;
      expect(() => {
        r = calcularMarcoZero(dados);
      }).not.toThrow();

      expect(r.incompleto).toEqual(["q16", "q22", "q28", "q40", "q9", "q10"]);
      // ausentes contam 0: 4 itens de 5 = 25 no eixo de 6 itens
      expect(r.eixos.visao.likertBruto).toBe(25);
      expect(r.eixos.execucao.likertBruto).toBe(25);
      expect(r.eixos.relacao.likertBruto).toBe(25);
      expect(r.eixos.integridade.likertBruto).toBe(30);
      expect(r.eixos.integridade.likert0a100).toBe(100);
      // 5 situacionais seguem contadas (q40 ausente)
      const total = EIXOS.reduce((s, e) => s + r.eixos[e].situacional, 0);
      expect(total).toBe(5);
      expect(r.elementos.equilibrio_emocional).toBe(0);
      expect(r.elementos.recursos_financeiros).toBe(0);
      expect(r.elementos.desenvolvimento_intelectual).toBe(5);
    });

    it("objeto vazio nao lanca e lista todas as perguntas", () => {
      const r = calcularMarcoZero({});
      expect(r.incompleto).toHaveLength(24 + 6 + 7);
      for (const eixo of EIXOS) expect(r.eixos[eixo].likert0a100).toBe(0);
    });

    it("tipos errados (array, alternativa invalida) sao tratados como ausentes", () => {
      const dados = montar({});
      dados.q17 = ["5"];
      dados.q41 = "Z";
      dados.q42 = 3;
      const r = calcularMarcoZero(dados);
      expect(r.incompleto).toEqual(["q17", "q41", "q42"]);
    });

    it("aceita numero em string e alternativa minuscula", () => {
      const dados = montar({});
      dados.q16 = "5";
      dados.q40 = "a";
      const r = calcularMarcoZero(dados);
      expect(r.incompleto).toEqual([]);
    });
  });

  describe("desempates", () => {
    it("likert empatado: vence o maior situacional", () => {
      const base = {
        likert: { visao: 5, execucao: 5, relacao: 2, integridade: 2 },
      };
      const a = calcularMarcoZero(
        montar({
          ...base,
          situacional: ["execucao", "execucao", "execucao", "visao", "visao", "relacao"],
        }),
      );
      expect(a.eixos.visao.likert0a100).toBe(a.eixos.execucao.likert0a100);
      expect(a.perfilDeclarado).toBe("execucao"); // 3 x 2, contra a ordem fixa

      const b = calcularMarcoZero(
        montar({
          ...base,
          situacional: ["visao", "visao", "visao", "execucao", "execucao", "relacao"],
        }),
      );
      expect(b.perfilDeclarado).toBe("visao");
    });

    it("likert e situacional empatados: vale a ordem visao > execucao > relacao > integridade", () => {
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 2, execucao: 2, relacao: 5, integridade: 5 },
          situacional: ["relacao", "relacao", "relacao", "integridade", "integridade", "integridade"],
        }),
      );
      expect(r.perfilDeclarado).toBe("relacao");
      expect(r.perfilDominante).toBe("relacao");

      const todos = calcularMarcoZero(
        montar({
          likert: { visao: 4, execucao: 4, relacao: 4, integridade: 4 },
          situacional: ["visao", "execucao", "relacao", "integridade", "visao", "execucao"],
        }),
      );
      // situacional: visao 2, execucao 2, relacao 1, integridade 1
      expect(todos.perfilDeclarado).toBe("visao");
      expect(todos.perfilDominante).toBe("visao");

      // Sem nenhuma situacional respondida, tudo empata em 0.
      const semSituacional = montar({
        likert: { visao: 3, execucao: 3, relacao: 3, integridade: 3 },
      });
      for (const q of SIT_IDS) delete semSituacional[q];
      const totalmenteIgual = calcularMarcoZero(semSituacional);
      expect(totalmenteIgual.perfilDeclarado).toBe("visao");
      expect(totalmenteIgual.perfilDominante).toBe("visao");
    });

    it("situacional empatado: vence o maior likert", () => {
      const sit: Eixo[] = ["visao", "visao", "visao", "execucao", "execucao", "execucao"];
      const a = calcularMarcoZero(
        montar({ likert: { visao: 3, execucao: 4, relacao: 1, integridade: 1 }, situacional: sit }),
      );
      expect(a.eixos.visao.situacional).toBe(a.eixos.execucao.situacional);
      expect(a.perfilDominante).toBe("execucao"); // contra a ordem fixa

      const b = calcularMarcoZero(
        montar({ likert: { visao: 4, execucao: 3, relacao: 1, integridade: 1 }, situacional: sit }),
      );
      expect(b.perfilDominante).toBe("visao");
    });

    it("situacional empatado e likert empatado: ordem fixa", () => {
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 1, execucao: 1, relacao: 4, integridade: 4 },
          situacional: ["relacao", "relacao", "relacao", "integridade", "integridade", "integridade"],
        }),
      );
      expect(r.perfilDominante).toBe("relacao");
    });
  });

  describe("elementos", () => {
    it("calcula media (1 casa), mais baixo e mais alto", () => {
      const r = calcularMarcoZero(montar({ elementos: [7, 3, 9, 4, 8, 6, 5] }));
      expect(r.elementos).toEqual({
        desenvolvimento_intelectual: 7,
        saude_energia: 3,
        equilibrio_emocional: 9,
        recursos_financeiros: 4,
        contribuicao_social: 8,
        realizacao_proposito: 6,
        hobbies_diversao: 5,
      });
      expect(r.elementosMedia).toBe(6); // 42/7
      expect(r.elementoMaisBaixo).toBe("saude_energia");
      expect(r.elementoMaisAlto).toBe("equilibrio_emocional");
    });

    it("arredonda a media para 1 casa", () => {
      const r = calcularMarcoZero(montar({ elementos: [7, 3, 9, 4, 8, 6, 6] })); // 43/7 = 6.142...
      expect(r.elementosMedia).toBe(6.1);
    });

    it("aceita 0 e 10 como valores validos", () => {
      const r = calcularMarcoZero(montar({ elementos: [0, 10, 5, 5, 5, 5, 5] }));
      expect(r.incompleto).toEqual([]);
      expect(r.elementoMaisBaixo).toBe("desenvolvimento_intelectual");
      expect(r.elementoMaisAlto).toBe("saude_energia");
    });

    it("empate em baixo/alto: vence o primeiro na ordem canonica", () => {
      const r = calcularMarcoZero(montar({ elementos: [5, 2, 9, 2, 9, 5, 5] }));
      expect(r.elementoMaisBaixo).toBe("saude_energia");
      expect(r.elementoMaisAlto).toBe("equilibrio_emocional");
    });

    it("exporta os 7 elementos na ordem especificada", () => {
      expect(ELEMENTOS).toHaveLength(7);
    });
  });

  it("e deterministica: mesmo input, mesmo output", () => {
    const dados = montar({ likert: { visao: 4, execucao: 2, relacao: 5, integridade: 3 } });
    expect(calcularMarcoZero(dados)).toEqual(calcularMarcoZero(dados));
  });
});
