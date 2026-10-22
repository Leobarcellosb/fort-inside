import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calcularMarcoZero } from "../scoring/marco-zero";
import { montarManifesto, type EtapaCanonica, type LinhaDeEtapa } from "./manifesto-questionario";
import { ehPontuada, letraDeclarada, mapearResposta, mapearSubmissao } from "./mapear-resposta";

const CANONICO: EtapaCanonica[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "docs", "questionario-v2-canonico.json"), "utf8"),
);

function linhas(): LinhaDeEtapa[] {
  return CANONICO.map((e) => ({ id: 100 + e.n, stage_number: e.n, title: e.t, questions: e.q }));
}

const MANIFESTO = (() => {
  const r = montarManifesto(linhas(), 2);
  if (!r.ok) throw new Error(`fixture quebrada: ${r.motivo}`);
  return r.manifesto;
})();

const Q = (id: string) => MANIFESTO.porId[id];

/** O texto EXATO da alternativa `letra` de uma situacional, como esta no manifesto. */
function alternativa(id: string, letra: string): string {
  const opcao = Q(id).options?.find((o) => letraDeclarada(o) === letra);
  if (opcao === undefined) throw new Error(`fixture quebrada: ${id} sem alternativa ${letra}`);
  return opcao;
}

/** Uma submissao completa e correta, para servir de CONTROLE POSITIVO. */
function submissaoCompleta(): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const p of MANIFESTO.perguntas) {
    if (p.type === "scale") r[p.id] = p.min === 0 ? 7 : 4;
    else if (p.type === "select") r[p.id] = p.options![0];
    else if (p.max_chars !== null) r[p.id] = "ok".slice(0, p.max_chars);
    else r[p.id] = "resposta escrita pela pessoa";
  }
  // Variacao nas situacionais, para o eixo destacado nao ser artefato do "sempre A".
  r.q40 = alternativa("q40", "A");
  r.q41 = alternativa("q41", "C");
  r.q42 = alternativa("q42", "B");
  r.q43 = alternativa("q43", "D");
  r.q44 = alternativa("q44", "A");
  r.q45 = alternativa("q45", "D");
  return r;
}

describe("ehPontuada -- quais perguntas o motor consome", () => {
  it("as 6 situacionais, os 24 Likert e os 7 elementos sao pontuadas", () => {
    for (const id of ["q40", "q45", "q16", "q39", "q7", "q13"]) {
      expect(ehPontuada(id)).toBe(true);
    }
  });
  it("as abertas nao sao", () => {
    for (const id of ["q1", "q6", "q14", "q46", "q52"]) expect(ehPontuada(id)).toBe(false);
  });
});

describe("SITUACIONAIS: correspondencia EXATA, e nada de adivinhar", () => {
  it("CONTROLE POSITIVO: o texto exato da alternativa vira a LETRA que o motor le", () => {
    const item = mapearResposta(Q("q40"), alternativa("q40", "C"));
    expect(item.estado).toBe("compativel");
    if (item.estado !== "compativel") return;
    expect(item.valor).toBe("C");
    expect(item.forma).toBe("texto_exato");
  });

  it("CONTROLE POSITIVO: espaco em branco nas pontas e aparado (permitido)", () => {
    const item = mapearResposta(Q("q41"), `  ${alternativa("q41", "B")}  \n`);
    expect(item.estado === "compativel" && item.valor).toBe("B");
  });

  it("CONTROLE POSITIVO: a letra isolada e identificador exato, conferido no manifesto", () => {
    const item = mapearResposta(Q("q42"), "d");
    expect(item.estado).toBe("compativel");
    if (item.estado !== "compativel") return;
    expect(item.valor).toBe("D");
    expect(item.forma).toBe("letra");
  });

  it("UMA PALAVRA TROCADA => DADO INCOMPATIVEL, nunca pontuacao zero, nunca ausente", () => {
    const original = alternativa("q40", "A");
    expect(original).toContain("prioridade");
    const mexida = original.replace("prioridade", "urgência");

    const item = mapearResposta(Q("q40"), mexida);

    expect(item.estado).toBe("incompativel");
    if (item.estado !== "incompativel") return;
    expect(item.causa).toBe("alternativa_desconhecida");
    expect(item.pontuada).toBe(true);
    // O que a pessoa respondeu fica guardado, intacto.
    expect(item.bruto).toBe(mexida);
    // E NAO existe valor canonico: nao ha 0, nao ha "A", nao ha null disfarcado.
    expect("valor" in item).toBe(false);
  });

  it("nao casa por prefixo: a letra certa com o texto errado NAO passa", () => {
    const item = mapearResposta(Q("q40"), "A. Organizar");
    expect(item.estado).toBe("incompativel");
  });

  it("nao casa ignorando caixa", () => {
    const item = mapearResposta(Q("q40"), alternativa("q40", "A").toUpperCase());
    expect(item.estado).toBe("incompativel");
  });

  it("nao casa ignorando acento", () => {
    const semAcento = alternativa("q40", "B").normalize("NFD").replace(/[̀-ͯ]/g, "");
    const item = mapearResposta(Q("q40"), semAcento);
    expect(item.estado).toBe("incompativel");
  });

  it("nao casa ignorando pontuacao final", () => {
    const item = mapearResposta(Q("q40"), alternativa("q40", "A").replace(/\.$/, ""));
    expect(item.estado).toBe("incompativel");
  });

  it("nao casa por semelhanca: NAO escolhe a alternativa mais parecida", () => {
    const item = mapearResposta(Q("q43"), "Revisar criterios e riscos");
    expect(item.estado).toBe("incompativel");
    if (item.estado !== "incompativel") return;
    expect(item.motivo).toContain("nao se adivinha a mais parecida");
  });

  it("letra fora de A..D e incompativel, nao ausente", () => {
    const item = mapearResposta(Q("q40"), "E");
    expect(item.estado).toBe("incompativel");
  });

  it('"A casa e grande" comeca com A e NAO e a alternativa A', () => {
    const item = mapearResposta(Q("q40"), "A casa e grande");
    expect(item.estado).toBe("incompativel");
  });

  it("a alternativa de OUTRA pergunta nao casa nesta", () => {
    const item = mapearResposta(Q("q40"), alternativa("q41", "A"));
    expect(item.estado).toBe("incompativel");
  });

  it("lista onde se espera uma alternativa e incompativel por tipo", () => {
    const item = mapearResposta(Q("q40"), [alternativa("q40", "A")]);
    expect(item.estado).toBe("incompativel");
    if (item.estado !== "incompativel") return;
    expect(item.causa).toBe("tipo_invalido");
  });

  it("vazio e AUSENTE, nao incompativel (nao respondeu e diferente de nao casou)", () => {
    for (const vazio of [undefined, null, "", "   "]) {
      const item = mapearResposta(Q("q40"), vazio);
      expect(item.estado).toBe("ausente");
    }
  });
});

describe("ESCALAS", () => {
  it("CONTROLE POSITIVO: inteiro na faixa, como numero e como texto", () => {
    expect(mapearResposta(Q("q16"), 4).estado).toBe("compativel");
    const texto = mapearResposta(Q("q16"), " 4 ");
    expect(texto.estado === "compativel" && texto.valor).toBe(4);
  });

  it("CONTROLE POSITIVO: os extremos da faixa declarada entram", () => {
    expect(mapearResposta(Q("q7"), 0).estado).toBe("compativel");
    expect(mapearResposta(Q("q7"), 10).estado).toBe("compativel");
    expect(mapearResposta(Q("q16"), 1).estado).toBe("compativel");
    expect(mapearResposta(Q("q16"), 5).estado).toBe("compativel");
  });

  it("fora da faixa e INCOMPATIVEL, nao zero e nao ausente", () => {
    const item = mapearResposta(Q("q16"), 7); // Likert e 1..5
    expect(item.estado).toBe("incompativel");
    if (item.estado !== "incompativel") return;
    expect(item.causa).toBe("fora_da_escala");
    expect(item.motivo).toContain("1 a 5");
    expect(item.pontuada).toBe(true);
  });

  it("escala de elemento (0..10) nao aceita 11, e 0 e resposta valida", () => {
    expect(mapearResposta(Q("q7"), 11).estado).toBe("incompativel");
    const zero = mapearResposta(Q("q7"), 0);
    expect(zero.estado === "compativel" && zero.valor).toBe(0);
  });

  it("nao inteiro e incompativel", () => {
    for (const lixo of [3.5, "quatro", "4,5", true]) {
      expect(mapearResposta(Q("q16"), lixo).estado).toBe("incompativel");
    }
  });
});

describe("TEXTO", () => {
  it("CONTROLE POSITIVO: texto dentro do limite declarado passa, aparado", () => {
    const item = mapearResposta(Q("q1"), "  Maria Souza  ");
    expect(item.estado === "compativel" && item.valor).toBe("Maria Souza");
  });

  it("texto acima do limite declarado e INCOMPATIVEL -- nao se corta o texto de ninguem", () => {
    const limite = Q("q1").max_chars!;
    const item = mapearResposta(Q("q1"), "x".repeat(limite + 1));
    expect(item.estado).toBe("incompativel");
    if (item.estado !== "incompativel") return;
    expect(item.causa).toBe("acima_do_limite_de_caracteres");
    expect(item.pontuada).toBe(false); // nao apaga instrumento: e pergunta aberta
  });

  it("paragrafo sem limite aceita texto longo", () => {
    expect(Q("q6").max_chars).toBeNull();
    expect(mapearResposta(Q("q6"), "x".repeat(5000)).estado).toBe("compativel");
  });
});

describe("mapearSubmissao -- o lote inteiro contra o manifesto", () => {
  it("CONTROLE POSITIVO: submissao completa e correta nao tem um unico incompativel", () => {
    const m = mapearSubmissao(MANIFESTO, submissaoCompleta());
    expect(m.incompativeis).toHaveLength(0);
    expect(m.ausentes).toHaveLength(0);
    expect(m.compativeis).toBe(52);
  });

  it("pergunta sem resposta vira AUSENTE, nao desaparece do relatorio", () => {
    const r = submissaoCompleta();
    delete r.q30;
    const m = mapearSubmissao(MANIFESTO, r);
    expect(m.ausentes).toEqual(["q30"]);
    expect(m.incompativeis).toHaveLength(0);
    expect(m.itens).toHaveLength(52);
  });

  it("resposta para pergunta que o sistema nao conhece e INCOMPATIVEL, nunca descartada", () => {
    const r = submissaoCompleta();
    r.q99 = "pergunta que alguem adicionou no formulario";
    const m = mapearSubmissao(MANIFESTO, r);
    expect(m.desconhecidas).toHaveLength(1);
    expect(m.desconhecidas[0].pergunta_id).toBe("q99");
    if (m.desconhecidas[0].estado !== "incompativel") throw new Error("estado errado");
    expect(m.desconhecidas[0].causa).toBe("pergunta_desconhecida");
  });

  it("coluna vazia de planilha para pergunta desconhecida nao gera ruido", () => {
    const r = submissaoCompleta();
    r.carimbo_de_data_hora = "";
    expect(mapearSubmissao(MANIFESTO, r).desconhecidas).toHaveLength(0);
  });
});

describe("O ACIDENTE QUE NAO PODE SE REPETIR: 73% de cobertura virando zero", () => {
  it("as 6 situacionais em texto exato pontuam de verdade (controle positivo)", () => {
    const m = mapearSubmissao(MANIFESTO, submissaoCompleta());
    const achatado: Record<string, string | number | string[]> = {};
    for (const i of m.itens) if (i.estado === "compativel") achatado[i.pergunta_id] = i.valor;

    const scores = calcularMarcoZero(achatado);
    const total = Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0);
    expect(total).toBe(6); // o instrumento situacional INTEIRO entrou
    expect(scores.analiseSituacional.status).not.toBe("incompleto");
    expect(scores.incompleto).toHaveLength(0);
  });

  it("UMA alternativa reescrita: o motor veria 5 de 6, e e por isso que o estado incompativel tem de existir", () => {
    const r = submissaoCompleta();
    r.q43 = alternativa("q43", "D").replace("prioridades", "prioridade");
    const m = mapearSubmissao(MANIFESTO, r);

    // 1. A incompatibilidade EXISTE e esta nomeada.
    expect(m.incompativeisPontuadas.map((i) => i.pergunta_id)).toEqual(["q43"]);

    // 2. Nenhum valor canonico foi inventado para ela.
    const achatado: Record<string, string | number | string[]> = {};
    for (const i of m.itens) if (i.estado === "compativel") achatado[i.pergunta_id] = i.valor;
    expect(achatado.q43).toBeUndefined();

    // 3. O MOTOR, sozinho, nao distingue isso de "nao respondeu": conta 5 e diz
    //    "incompleto", exatamente como diria para uma pergunta em branco. E por
    //    isso que a aptidao e decidida FORA do motor, com o estado deste modulo.
    const scores = calcularMarcoZero(achatado);
    const total = Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0);
    expect(total).toBe(5);
    expect(scores.analiseSituacional.status).toBe("incompleto");
    expect(scores.incompleto).toContain("q43");
  });

  it("as 6 situacionais reescritas NAO viram quatro eixos com zero: viram 6 incompativeis", () => {
    const r = submissaoCompleta();
    for (const id of ["q40", "q41", "q42", "q43", "q44", "q45"]) {
      r[id] = `${String(r[id])} (texto editado por quem montou o formulario)`;
    }
    const m = mapearSubmissao(MANIFESTO, r);
    expect(m.incompativeisPontuadas).toHaveLength(6);
    for (const i of m.incompativeisPontuadas) {
      expect(i.estado).toBe("incompativel");
      if (i.estado !== "incompativel") continue;
      expect(i.causa).toBe("alternativa_desconhecida");
      expect(i.bruto).toBeTruthy();
    }
  });
});
