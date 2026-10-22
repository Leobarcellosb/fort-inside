import { describe, expect, it } from "vitest";
import {
  EIXOS,
  ELEMENTOS,
  MARGEM_MINIMA_LIKERT_BRUTA,
  MARGEM_MINIMA_SITUACIONAL,
  MINIMO_ELEMENTOS_ANALISE_PARCIAL,
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

  describe("relacao entre autorrelatos", () => {
    it("destaques diferentes nos dois instrumentos: contraste", () => {
      // Likert destaca visao, situacionais destacam relacao.
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 },
          situacional: ["relacao", "relacao", "relacao", "relacao", "relacao", "relacao"],
        }),
      );
      expect(r.analiseLikert.eixoDestacado).toBe("visao");
      expect(r.analiseSituacional.eixoDestacado).toBe("relacao");
      expect(r.relacaoEntreAutorrelatos).toBe("contraste");
    });

    it("mesmo destaque nos dois instrumentos: convergencia", () => {
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 },
          situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
        }),
      );
      expect(r.analiseLikert.eixoDestacado).toBe("visao");
      expect(r.analiseSituacional.eixoDestacado).toBe("visao");
      expect(r.relacaoEntreAutorrelatos).toBe("convergencia");
    });

    it("situacional sem destaque (3-2-1-0) torna a relacao inconclusiva", () => {
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 },
          situacional: ["visao", "visao", "visao", "execucao", "execucao", "relacao"],
        }),
      );
      expect(r.analiseLikert.status).toBe("destacado");
      expect(r.analiseSituacional.status).toBe("margem_insuficiente");
      expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
    });

    it("likert sem destaque torna a relacao inconclusiva", () => {
      const r = calcularMarcoZero(
        montar({
          likert: { visao: 4, execucao: 4, relacao: 2, integridade: 2 },
          situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
        }),
      );
      expect(r.analiseLikert.status).toBe("empate");
      expect(r.analiseSituacional.status).toBe("destacado");
      expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
    });

    it("instrumento incompleto torna a relacao inconclusiva mesmo com margem grande", () => {
      const dados = montar({
        likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 },
        situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
      });
      delete dados.q45;
      const r = calcularMarcoZero(dados);
      expect(r.analiseSituacional.margem).toBe(5);
      expect(r.analiseSituacional.status).toBe("incompleto");
      expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
    });

    it("o contrato antigo nao existe mais", () => {
      const r = calcularMarcoZero(montar({})) as unknown as Record<string, unknown>;
      expect(r).not.toHaveProperty("perfilDominante");
      expect(r).not.toHaveProperty("divergencia");
    });
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
      // elemento ausente e null, nunca 0
      expect(r.elementos.equilibrio_emocional).toEqual({ valor: null, status: "incompleto" });
      expect(r.elementos.recursos_financeiros).toEqual({ valor: null, status: "incompleto" });
      expect(r.elementos.desenvolvimento_intelectual).toEqual({ valor: 5, status: "respondido" });
      expect(r.analiseElementos.elementosRespondidos).toBe(5);
    });

    it("objeto vazio nao lanca e lista todas as perguntas", () => {
      const r = calcularMarcoZero({});
      expect(r.incompleto).toHaveLength(24 + 6 + 7);
      for (const eixo of EIXOS) expect(r.eixos[eixo].likert0a100).toBe(0);
      expect(r.analiseLikert.status).toBe("incompleto");
      expect(r.analiseSituacional.status).toBe("incompleto");
      expect(r.analiseSituacional.eixoDestacado).toBeNull();
      expect(r.analiseElementos).toEqual({
        elementosRespondidos: 0,
        status: "insuficiente",
        elementoDeMenorPontuacao: null,
      });
      expect(r.elementosMedia).toEqual({ valor: null, denominador: 0 });
      expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
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

  describe("analise situacional", () => {
    const sit = (...e: Eixo[]) => calcularMarcoZero(montar({ situacional: e }));

    it("3-2-1-0 (margem 1) NAO produz eixo destacado", () => {
      const r = sit("visao", "visao", "visao", "execucao", "execucao", "relacao");
      expect(r.analiseSituacional.contagens).toEqual({
        visao: 3,
        execucao: 2,
        relacao: 1,
        integridade: 0,
      });
      expect(r.analiseSituacional.margem).toBe(1);
      expect(r.analiseSituacional.status).toBe("margem_insuficiente");
      expect(r.analiseSituacional.eixoDestacado).toBeNull();
    });

    it("4-2-0-0 (margem 2) produz eixo destacado", () => {
      const r = sit("relacao", "relacao", "relacao", "relacao", "execucao", "execucao");
      expect(r.analiseSituacional.margem).toBe(2);
      expect(r.analiseSituacional.status).toBe("destacado");
      expect(r.analiseSituacional.eixoDestacado).toBe("relacao");
    });

    it("margem maior que o minimo tambem destaca (3-1-1-1 e 6-0-0-0)", () => {
      const a = sit("integridade", "integridade", "integridade", "visao", "execucao", "relacao");
      expect(a.analiseSituacional.margem).toBe(2);
      expect(a.analiseSituacional.eixoDestacado).toBe("integridade");
      const b = sit("execucao", "execucao", "execucao", "execucao", "execucao", "execucao");
      expect(b.analiseSituacional.margem).toBe(6);
      expect(b.analiseSituacional.eixoDestacado).toBe("execucao");
    });

    it("a margem minima e a constante nomeada", () => {
      expect(MARGEM_MINIMA_SITUACIONAL).toBe(2);
    });

    it("empate no topo: status empate e nenhum eixo destacado", () => {
      const r = sit("visao", "visao", "visao", "execucao", "execucao", "execucao");
      expect(r.analiseSituacional.margem).toBe(0);
      expect(r.analiseSituacional.status).toBe("empate");
      expect(r.analiseSituacional.eixoDestacado).toBeNull();
    });

    it("empate em eixos diferentes nao depende da ordem de EIXOS", () => {
      // Duas permutacoes que empatam em pares distintos: ambas sem vencedor.
      // Se a ordem do array decidisse, a 1a daria visao e a 2a daria relacao.
      const p1 = sit("visao", "execucao", "visao", "execucao", "visao", "execucao");
      const p2 = sit("integridade", "relacao", "integridade", "relacao", "relacao", "integridade");
      expect(p1.analiseSituacional.contagens).toMatchObject({ visao: 3, execucao: 3 });
      expect(p2.analiseSituacional.contagens).toMatchObject({ relacao: 3, integridade: 3 });
      for (const r of [p1, p2]) {
        expect(r.analiseSituacional.status).toBe("empate");
        expect(r.analiseSituacional.eixoDestacado).toBeNull();
      }
    });

    it("todos os 6 pares de eixos empatados em 3-3 dao empate sem vencedor", () => {
      for (let i = 0; i < EIXOS.length; i++) {
        for (let j = i + 1; j < EIXOS.length; j++) {
          const r = sit(
            EIXOS[i], EIXOS[j], EIXOS[i], EIXOS[j], EIXOS[i], EIXOS[j],
          );
          expect(r.analiseSituacional.status).toBe("empate");
          expect(r.analiseSituacional.eixoDestacado).toBeNull();
        }
      }
    });

    it("a ordem das respostas nao muda a analise (so as contagens importam)", () => {
      const a = sit("visao", "visao", "visao", "visao", "execucao", "execucao");
      const b = sit("execucao", "visao", "execucao", "visao", "visao", "visao");
      expect(a.analiseSituacional).toEqual(b.analiseSituacional);
    });

    it("o likert nao desempata a situacional", () => {
      const dados = { situacional: ["visao", "visao", "visao", "execucao", "execucao", "execucao"] as Eixo[] };
      const a = calcularMarcoZero(montar({ ...dados, likert: { visao: 5, execucao: 1 } }));
      const b = calcularMarcoZero(montar({ ...dados, likert: { visao: 1, execucao: 5 } }));
      expect(a.analiseSituacional).toEqual(b.analiseSituacional);
      expect(a.analiseSituacional.status).toBe("empate");
    });

    it("sem as seis respondidas: incompleto, mesmo com margem >= 2", () => {
      const dados = montar({
        situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
      });
      delete dados.q45;
      const r = calcularMarcoZero(dados);
      expect(r.analiseSituacional.margem).toBe(5);
      expect(r.analiseSituacional.status).toBe("incompleto");
      expect(r.analiseSituacional.eixoDestacado).toBeNull();
    });
  });

  describe("analise do likert", () => {
    it("margem >= minimo destaca o eixo", () => {
      const r = calcularMarcoZero(montar({ likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 } }));
      expect(r.analiseLikert.margem).toBe(12); // 30 - 18 brutos
      expect(r.analiseLikert.status).toBe("destacado");
      expect(r.analiseLikert.eixoDestacado).toBe("visao");
    });

    it("empate no topo nao e resolvido por situacional nem pela ordem de EIXOS", () => {
      const dados = { likert: { visao: 2, execucao: 2, relacao: 5, integridade: 5 } };
      const a = calcularMarcoZero(montar({ ...dados, situacional: ["relacao", "relacao", "relacao", "relacao", "relacao", "relacao"] }));
      const b = calcularMarcoZero(montar({ ...dados, situacional: ["integridade", "integridade", "integridade", "integridade", "integridade", "integridade"] }));
      for (const r of [a, b]) {
        expect(r.analiseLikert.status).toBe("empate");
        expect(r.analiseLikert.eixoDestacado).toBeNull();
      }
    });

    it("diferenca bruta 2 produz eixo destacado", () => {
      const dados = montar({ likert: { visao: 4, execucao: 4, relacao: 4, integridade: 4 } });
      dados.q16 = 5;
      dados.q17 = 5; // visao 26 contra 24
      const r = calcularMarcoZero(dados);
      expect(r.analiseLikert.pontuacoesBrutas.visao).toBe(26);
      expect(r.analiseLikert.margem).toBe(2);
      expect(r.analiseLikert.status).toBe("destacado");
      expect(r.analiseLikert.eixoDestacado).toBe("visao");
    });

    it("diferenca bruta 1 nao produz eixo destacado", () => {
      const dados = montar({ likert: { visao: 4, execucao: 4, relacao: 4, integridade: 4 } });
      dados.q16 = 5; // visao 25 contra 24
      const r = calcularMarcoZero(dados);
      expect(r.analiseLikert.margem).toBe(1);
      expect(r.analiseLikert.status).toBe("margem_insuficiente");
      expect(r.analiseLikert.eixoDestacado).toBeNull();
    });

    it("a decisao usa o bruto, nao o normalizado arredondado", () => {
      // bruto 2 = 8,33 normalizados: destaca mesmo abaixo de 10 normalizados
      const dados = montar({ likert: { visao: 4, execucao: 4, relacao: 4, integridade: 4 } });
      dados.q16 = 5;
      dados.q17 = 5;
      const r = calcularMarcoZero(dados);
      expect(r.analiseLikert.pontuacoes0a100.visao - r.analiseLikert.pontuacoes0a100.execucao).toBeLessThan(10);
      expect(r.analiseLikert.eixoDestacado).toBe("visao");
      expect(MARGEM_MINIMA_LIKERT_BRUTA).toBe(2);
    });

    it("diferenca bruta 0 e empate", () => {
      const r = calcularMarcoZero(montar({ likert: { visao: 4, execucao: 4, relacao: 2, integridade: 2 } }));
      expect(r.analiseLikert.margem).toBe(0);
      expect(r.analiseLikert.status).toBe("empate");
    });

    it("item likert ausente torna a analise incompleta", () => {
      const dados = montar({ likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 } });
      delete dados.q30;
      const r = calcularMarcoZero(dados);
      expect(r.analiseLikert.status).toBe("incompleto");
      expect(r.analiseLikert.eixoDestacado).toBeNull();
    });

    it("faltando 1 dos 24 itens: incompleto, sem destaque e relacao inconclusiva mesmo com situacional clara", () => {
      const dados = montar({
        likert: { visao: 5, execucao: 2, relacao: 2, integridade: 2 },
        situacional: ["visao", "visao", "visao", "visao", "visao", "visao"],
      });
      delete dados.q39;
      const r = calcularMarcoZero(dados);
      expect(r.analiseSituacional.status).toBe("destacado");
      expect(r.analiseLikert.status).toBe("incompleto");
      expect(r.analiseLikert.eixoDestacado).toBeNull();
      expect(r.relacaoEntreAutorrelatos).toBe("inconclusivo");
    });
  });

  describe("elementos", () => {
    const valores = (r: ReturnType<typeof calcularMarcoZero>) =>
      ELEMENTOS.map((e) => r.elementos[e].valor);

    it("calcula media (1 casa), menor e maior com os 7 respondidos", () => {
      const r = calcularMarcoZero(montar({ elementos: [7, 3, 9, 4, 8, 6, 5] }));
      expect(valores(r)).toEqual([7, 3, 9, 4, 8, 6, 5]);
      for (const e of ELEMENTOS) expect(r.elementos[e].status).toBe("respondido");
      expect(r.elementosMedia).toEqual({ valor: 6, denominador: 7 }); // 42/7
      expect(r.analiseElementos).toEqual({
        elementosRespondidos: 7,
        status: "completo",
        elementoDeMenorPontuacao: "saude_energia",
      });
      expect(r.elementoDeMaiorPontuacao).toEqual({
        elemento: "equilibrio_emocional",
        status: "apresentavel",
      });
    });

    it("arredonda a media para 1 casa", () => {
      const r = calcularMarcoZero(montar({ elementos: [7, 3, 9, 4, 8, 6, 6] })); // 43/7 = 6.142...
      expect(r.elementosMedia.valor).toBe(6.1);
    });

    it("aceita 0 e 10 como valores validos (0 respondido nao e ausente)", () => {
      const r = calcularMarcoZero(montar({ elementos: [0, 10, 5, 5, 5, 5, 5] }));
      expect(r.incompleto).toEqual([]);
      expect(r.elementos.desenvolvimento_intelectual).toEqual({ valor: 0, status: "respondido" });
      expect(r.analiseElementos.elementoDeMenorPontuacao).toBe("desenvolvimento_intelectual");
      expect(r.elementoDeMaiorPontuacao.elemento).toBe("saude_energia");
    });

    it("empate no menor valor com 7 respondidos: null, sem usar a ordem do array", () => {
      const r = calcularMarcoZero(montar({ elementos: [5, 2, 9, 2, 9, 5, 5] }));
      expect(r.analiseElementos.status).toBe("completo");
      expect(r.analiseElementos.elementoDeMenorPontuacao).toBeNull();
      expect(r.elementoDeMaiorPontuacao).toEqual({ elemento: null, status: "empate" });
      // valores originais seguem acessiveis
      expect(valores(r)).toEqual([5, 2, 9, 2, 9, 5, 5]);
    });

    it("empate no menor em outra posicao tambem da null (nao favorece o 1o do array)", () => {
      const r = calcularMarcoZero(montar({ elementos: [8, 8, 8, 8, 8, 1, 1] }));
      expect(r.analiseElementos.elementoDeMenorPontuacao).toBeNull();
    });

    it("elemento nao respondido NAO vira o de menor pontuacao", () => {
      const dados = montar({ elementos: [7, 3, 9, 4, 8, 6, 5] });
      delete dados.q8; // saude_energia: seria o menor se virasse 0
      const r = calcularMarcoZero(dados);
      expect(r.elementos.saude_energia).toEqual({ valor: null, status: "incompleto" });
      expect(r.analiseElementos.elementoDeMenorPontuacao).toBeNull();
      expect(r.incompleto).toEqual(["q8"]);
    });

    it("media ignora o ausente e informa o denominador", () => {
      const dados = montar({ elementos: [7, 3, 9, 4, 8, 6, 5] });
      delete dados.q8;
      const r = calcularMarcoZero(dados);
      // (7+9+4+8+6+5)/6 = 6.5; com 0 no lugar seria 5.4
      expect(r.elementosMedia).toEqual({ valor: 6.5, denominador: 6 });
    });

    it("ausente nao participa do ranking do maior", () => {
      const dados = montar({ elementos: [7, 3, 10, 4, 8, 6, 5] });
      delete dados.q9; // o 10 sai do ranking
      const r = calcularMarcoZero(dados);
      expect(r.elementoDeMaiorPontuacao.elemento).toBe("contribuicao_social");
    });

    it("6 de 7 respondidos: maior calculado, mas somente interno (nao apresentavel)", () => {
      const dados = montar({ elementos: [7, 3, 10, 4, 8, 6, 5] });
      delete dados.q9;
      const r = calcularMarcoZero(dados);
      expect(r.analiseElementos.status).toBe("parcial");
      expect(r.elementoDeMaiorPontuacao).toEqual({
        elemento: "contribuicao_social",
        status: "somente_interno",
      });
    });

    it("5 de 7 respondidos: tambem somente interno", () => {
      const dados = montar({ elementos: [7, 3, 10, 4, 8, 6, 5] });
      delete dados.q9;
      delete dados.q13;
      expect(calcularMarcoZero(dados).elementoDeMaiorPontuacao.status).toBe("somente_interno");
    });

    it("4 de 7 respondidos: nenhuma interpretacao comparativa (nem maior nem menor)", () => {
      const dados = montar({ elementos: [7, 3, 9, 4, 8, 6, 5] });
      for (const q of [10, 11, 12]) delete dados[`q${q}`];
      const r = calcularMarcoZero(dados);
      expect(r.analiseElementos.elementoDeMenorPontuacao).toBeNull();
      expect(r.elementoDeMaiorPontuacao).toEqual({ elemento: null, status: "indisponivel" });
    });

    it("empate no topo com 6 respondidos: null e valores preservados", () => {
      const dados = montar({ elementos: [9, 3, 9, 4, 8, 6, 5] });
      delete dados.q13;
      const r = calcularMarcoZero(dados);
      expect(r.elementoDeMaiorPontuacao).toEqual({ elemento: null, status: "empate" });
      expect(r.elementos.desenvolvimento_intelectual.valor).toBe(9);
      expect(r.elementos.equilibrio_emocional.valor).toBe(9);
    });

    it("status: 7 completo, 6 e 5 parcial, 4 insuficiente", () => {
      const comAusentes = (ausentes: number[]) => {
        const dados = montar({ elementos: [7, 3, 9, 4, 8, 6, 5] });
        for (const q of ausentes) delete dados[`q${q}`];
        return calcularMarcoZero(dados).analiseElementos;
      };
      expect(comAusentes([]).status).toBe("completo");
      expect(comAusentes([7]).status).toBe("parcial"); // 6
      expect(comAusentes([7, 8]).status).toBe("parcial"); // 5
      const quatro = comAusentes([7, 8, 9]);
      expect(quatro.elementosRespondidos).toBe(4);
      expect(quatro.status).toBe("insuficiente");
      expect(quatro.elementoDeMenorPontuacao).toBeNull();
    });

    it("com 4 respondidos a media continua informando o denominador, sem diagnostico", () => {
      const dados = montar({ elementos: [7, 3, 9, 4, 8, 6, 5] });
      for (const q of [10, 11, 12]) delete dados[`q${q}`];
      const r = calcularMarcoZero(dados);
      expect(r.analiseElementos.status).toBe("insuficiente");
      expect(r.elementosMedia).toEqual({ valor: 6, denominador: 4 }); // (7+3+9+5)/4
    });

    it("o piso de 5 em 7 esta numa constante nomeada", () => {
      expect(MINIMO_ELEMENTOS_ANALISE_PARCIAL).toBe(5);
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
