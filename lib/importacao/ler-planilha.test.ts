import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { montarManifesto, type EtapaCanonica, type LinhaDeEtapa } from "./manifesto-questionario";
import { casarColunas, lerPlanilha, type ResultadoDoCasamento } from "./ler-planilha";

const CANONICO: EtapaCanonica[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "docs", "questionario-v2-canonico.json"), "utf8"),
);

function linhas(): LinhaDeEtapa[] {
  return CANONICO.map((e) => ({ id: 100 + e.n, stage_number: e.n, title: e.t, questions: e.q }));
}

const MANIFESTO = (() => {
  const r = montarManifesto(linhas(), 2);
  if (!r.ok) throw new Error(r.motivo);
  return r.manifesto;
})();

/** O cabecalho que o Google Forms geraria para este questionario. */
function cabecalhoDoForms(): string[] {
  return [
    "Carimbo de data/hora",
    "Endereço de e-mail",
    ...MANIFESTO.perguntas.map((p) => p.text),
  ];
}

function casamentoOk(cabecalhos: string[] = cabecalhoDoForms()): ResultadoDoCasamento {
  const r = casarColunas(MANIFESTO, cabecalhos);
  if (!r.ok) throw new Error(`${r.codigo}: ${r.motivo}`);
  return r.casamento;
}

describe("CONTROLE POSITIVO: a planilha como o Forms a entrega", () => {
  it("casa as 52 colunas de pergunta mais carimbo e e-mail", () => {
    const r = casarColunas(MANIFESTO, cabecalhoDoForms());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.casamento.porPerguntaId)).toHaveLength(52);
    expect(r.casamento.desconhecidos).toHaveLength(0);
    expect(r.casamento.perguntasSemColuna).toHaveLength(0);
    expect(r.casamento.indiceDoEmail).toBe(1);
    expect(r.casamento.indiceDoCarimbo).toBe(0);
    expect(r.casamento.porPerguntaId.q1).toBe(2);
    expect(r.casamento.porPerguntaId.q52).toBe(53);
  });

  it("espaco sobrando no cabecalho e aparado (permitido)", () => {
    const cabecalhos = cabecalhoDoForms().map((c) => `  ${c} `);
    expect(casarColunas(MANIFESTO, cabecalhos).ok).toBe(true);
  });

  it("a ORDEM das colunas nao precisa ser a canonica", () => {
    const [carimbo, email, ...perguntas] = cabecalhoDoForms();
    const r = casarColunas(MANIFESTO, [...perguntas.reverse(), email, carimbo]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.casamento.porPerguntaId)).toHaveLength(52);
  });

  it("e-mail em ingles tambem e reconhecido", () => {
    const c = cabecalhoDoForms();
    c[1] = "Email Address";
    expect(casarColunas(MANIFESTO, c).ok).toBe(true);
  });
});

describe("UMA PALAVRA TROCADA NO CABECALHO: relatada, nunca adivinhada", () => {
  it("enunciado reescrito vira COLUNA_DESCONHECIDA e o id fica sem coluna", () => {
    const c = cabecalhoDoForms();
    const alvo = c.findIndex((x) => x === MANIFESTO.porId.q16.text);
    c[alvo] = c[alvo].replace("prioridades", "prioridade");

    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("COLUNA_DESCONHECIDA");
    expect(r.motivo).toContain("nao se atribui a pergunta mais parecida");
    expect(r.casamento.desconhecidos.map((d) => d.cabecalho)).toEqual([c[alvo]]);
    // A pergunta q16 NAO recebeu a coluna parecida.
    expect(r.casamento.porPerguntaId.q16).toBeUndefined();
    expect(r.casamento.perguntasSemColuna).toEqual(["q16"]);
  });

  it("nao casa por caixa, acento, pontuacao ou prefixo", () => {
    // q7 tem acento ("você está", "repertório"), caixa mista e pontuacao final:
    // da para variar cada uma das coisas separadamente.
    const base = MANIFESTO.porId.q7.text;
    expect(base).toMatch(/[áàâãéêíóôõúç]/i);

    const variacoes: [string, string][] = [
      ["caixa", base.toUpperCase()],
      ["sem acento", base.normalize("NFD").replace(/[̀-ͯ]/g, "")],
      ["sem pontuacao final", base.slice(0, -1)],
      ["prefixo", base.slice(0, 25)],
      ["sufixo acrescentado", `${base} (obrigatória)`],
    ];

    for (const [nome, v] of variacoes) {
      expect(v, nome).not.toBe(base); // a variacao e de fato diferente
      const c = cabecalhoDoForms();
      const alvo = c.findIndex((x) => x === base);
      expect(alvo, nome).toBeGreaterThan(0);
      c[alvo] = v;

      const r = casarColunas(MANIFESTO, c);
      expect(r.ok, nome).toBe(false);
      if (r.ok) continue;
      expect(r.casamento.porPerguntaId.q7, nome).toBeUndefined();
      expect(r.casamento.perguntasSemColuna, nome).toEqual(["q7"]);
    }
  });

  it("NAO casa pela POSICAO: a coluna 3 nao e automaticamente q1", () => {
    const c = cabecalhoDoForms();
    c[2] = "Coluna que alguem renomeou";
    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.casamento.porPerguntaId.q1).toBeUndefined();
  });

  it("NAO casa 'a unica que sobrou'", () => {
    const c = cabecalhoDoForms();
    // Remove a coluna de q52 e adiciona uma coluna estranha.
    const i = c.findIndex((x) => x === MANIFESTO.porId.q52.text);
    c[i] = "Alguma outra pergunta que a equipe adicionou";
    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.casamento.perguntasSemColuna).toEqual(["q52"]);
    expect(r.casamento.desconhecidos).toHaveLength(1);
  });
});

describe("outros desfechos do casamento", () => {
  it("coluna duplicada e COLUNA_AMBIGUA, nao 'a primeira vale'", () => {
    const c = cabecalhoDoForms();
    c.push(MANIFESTO.porId.q7.text);
    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("COLUNA_AMBIGUA");
    expect(r.casamento.porPerguntaId.q7).toBeUndefined();
  });

  it("pergunta faltando recusa por padrao e nomeia quais", () => {
    const c = cabecalhoDoForms().filter((x) => x !== MANIFESTO.porId.q40.text);
    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("COLUNA_FALTANDO");
    expect(r.casamento.perguntasSemColuna).toEqual(["q40"]);
    expect(r.motivo).toContain("TODA a turma");
  });

  it("pergunta faltando so passa com decisao explicita", () => {
    const c = cabecalhoDoForms().filter((x) => x !== MANIFESTO.porId.q40.text);
    const r = casarColunas(MANIFESTO, c, { tolerarPerguntaFaltando: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.casamento.perguntasSemColuna).toEqual(["q40"]);
  });

  it("sem coluna de e-mail recusa: nao ha reconciliacao sem e-mail", () => {
    const c = cabecalhoDoForms().filter((x) => x !== "Endereço de e-mail");
    const r = casarColunas(MANIFESTO, c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("EMAIL_SEM_COLUNA");
  });

  it("coluna extra so e ignorada quando DECLARADA, uma por uma", () => {
    const c = [...cabecalhoDoForms(), "Controle interno da equipe"];
    expect(casarColunas(MANIFESTO, c).ok).toBe(false);
    expect(casarColunas(MANIFESTO, c, { ignorar: ["Controle interno da equipe"] }).ok).toBe(true);
  });

  it("cabecalho de e-mail proprio pode ser declarado", () => {
    const c = cabecalhoDoForms();
    c[1] = "Seu e-mail institucional";
    expect(casarColunas(MANIFESTO, c).ok).toBe(false);
    expect(
      casarColunas(MANIFESTO, c, { cabecalhoDoEmail: "Seu e-mail institucional" }).ok,
    ).toBe(true);
  });
});

describe("lerPlanilha", () => {
  const casamento = casamentoOk();

  function celulas(over: Record<string, unknown> = {}): unknown[] {
    const linha: unknown[] = new Array(54).fill("");
    linha[0] = "22/10/2026 09:14:02";
    linha[1] = "maria@example.org";
    for (const [id, indice] of Object.entries(casamento.porPerguntaId)) {
      const p = MANIFESTO.porId[id];
      linha[indice] = p.type === "scale" ? "4" : p.type === "select" ? p.options![0] : "texto";
    }
    for (const [id, v] of Object.entries(over)) linha[casamento.porPerguntaId[id]] = v;
    return linha;
  }

  it("CONTROLE POSITIVO: uma linha vira uma submissao com as 52 respostas", () => {
    const r = lerPlanilha(casamento, [{ celulas: celulas(), submissao_id: "linha-2" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.submissoes[0];
    expect(s.submissao_id).toBe("linha-2");
    expect(s.email).toBe("maria@example.org");
    expect(Object.keys(s.respostas)).toHaveLength(52);
    expect(s.respostas.q7).toBe("4");
  });

  it("email_verificado e FALSE por padrao: nao se presume configuracao do formulario", () => {
    const r = lerPlanilha(casamento, [{ celulas: celulas(), submissao_id: "l2" }]);
    expect(r.ok && r.submissoes[0].email_verificado).toBe(false);
  });

  it("email_verificado so fica true por declaracao de quem opera", () => {
    const r = lerPlanilha(casamento, [{ celulas: celulas(), submissao_id: "l2" }], {
      emailVerificado: true,
    });
    expect(r.ok && r.submissoes[0].email_verificado).toBe(true);
  });

  it("linha sem identificador de submissao recusa (sem proveniencia nao se importa)", () => {
    const r = lerPlanilha(casamento, [{ celulas: celulas(), submissao_id: "  " }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("SUBMISSAO_SEM_ID");
    expect(r.linha).toBe(0);
  });

  it("linha truncada recusa em vez de virar respostas ausentes", () => {
    const curta = celulas().slice(0, 10);
    const r = lerPlanilha(casamento, [{ celulas: curta, submissao_id: "l2" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("LINHA_CURTA");
    expect(r.motivo).toContain("respostas ausentes");
  });

  it("celula vazia continua chegando como vazia (ausencia, nao invencao)", () => {
    const r = lerPlanilha(casamento, [
      { celulas: celulas({ q30: "" }), submissao_id: "l2" },
    ]);
    expect(r.ok && r.submissoes[0].respostas.q30).toBe("");
  });

  it("o nome declarado vem da pergunta que quem opera indicar", () => {
    const r = lerPlanilha(
      casamento,
      [{ celulas: celulas({ q1: "Maria Souza" }), submissao_id: "l2" }],
      { colunaDoNome: "q1" },
    );
    expect(r.ok && r.submissoes[0].nome_declarado).toBe("Maria Souza");
  });
});
