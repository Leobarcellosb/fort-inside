import { describe, expect, it } from "vitest";
import type { QuizQuestion } from "../../../../types/database";
import {
  contarRespondidas,
  estimarMinutos,
  indiceDaPergunta,
  montarRoteiro,
  primeiraTelaIncompleta,
  respondida,
  rotulosDaEscala,
  separarLetra,
  separarPerguntaDoNome,
  type EtapaImersiva,
} from "./roteiro";
import {
  PRAZO_DO_RASCUNHO_MS,
  apagarRascunho,
  chaveDoRascunhoImersivo,
  chaveDoRascunhoSimples,
  gravarRascunho,
  lerEnvio,
  lerRascunho,
  registrarEnvio,
} from "./rascunho";

// Um questionario com a MESMA forma do v2 (5 etapas, 52 perguntas, tipos e
// faixas iguais), sem copiar os enunciados -- o teste e de estrutura.
function q(id: string, extra: Partial<QuizQuestion>): QuizQuestion {
  return { id, type: "short_text", text: `Pergunta ${id}`, required: true, ...extra };
}
const n = (de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => de + i);
const ETAPAS: EtapaImersiva[] = [
  { id: 101, numero: 1, titulo: "E1", descricao: null, questions: [...n(1, 5).map((i) => q(`q${i}`, {})), q("q6", { type: "text", min_chars: 0 })] },
  {
    id: 102, numero: 2, titulo: "E2", descricao: "instrucao",
    questions: [
      ...n(7, 13).map((i) => q(`q${i}`, { type: "scale", min: 0, max: 10, min_label: "Totalmente insatisfeito", max_label: "Plenamente satisfeito" })),
      q("q14", { type: "text", min_chars: 0 }), q("q15", { type: "text", min_chars: 0 }),
    ],
  },
  { id: 103, numero: 3, titulo: "E3", descricao: "instrucao", questions: n(16, 39).map((i) => q(`q${i}`, { type: "scale", min: 1, max: 5 })) },
  { id: 104, numero: 4, titulo: "E4", descricao: "instrucao", questions: n(40, 45).map((i) => q(`q${i}`, { type: "select", options: ["A. um", "B. dois", "C. tres", "D. quatro"] })) },
  { id: 105, numero: 5, titulo: "E5", descricao: null, questions: [q("q46", { max_chars: 80 }), ...n(47, 52).map((i) => q(`q${i}`, { type: "text", min_chars: 0 }))] },
];

function memoria() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("roteiro", () => {
  const roteiro = montarRoteiro(ETAPAS);

  it("uma pergunta por tela, na ordem do banco, com 5 aberturas, 3 dados, boas-vindas e revisao", () => {
    const perguntas = roteiro.filter((t) => t.tipo === "perguntas");
    expect(perguntas).toHaveLength(52);
    expect(perguntas.every((t) => t.tipo === "perguntas" && t.perguntas.length === 1)).toBe(true);
    const ordem = perguntas.map((t) => (t.tipo === "perguntas" ? t.perguntas[0].id : ""));
    expect(ordem).toEqual(n(1, 52).map((i) => `q${i}`));
    expect(roteiro.filter((t) => t.tipo === "abertura")).toHaveLength(5);
    expect(roteiro).toHaveLength(1 + 3 + 5 + 52 + 1);
    expect(roteiro[0].tipo).toBe("boas-vindas");
    expect(roteiro[roteiro.length - 1].tipo).toBe("revisao");
  });

  it("avanca sozinha so A-D e 0-10; Likert e texto pedem Continuar", () => {
    const de = (id: string) => roteiro[indiceDaPergunta(roteiro, id)];
    const auto = (id: string) => {
      const t = de(id);
      return t.tipo === "perguntas" && t.avancaSozinha;
    };
    expect(auto("q40")).toBe(true);
    expect(auto("q7")).toBe(true);
    expect(auto("q16")).toBe(false);
    expect(auto("q6")).toBe(false);
    expect(auto("q1")).toBe(false);
  });

  it("escala comeca vazia: so numero conta, e zero conta quando escolhido", () => {
    const e = ETAPAS[1].questions[0];
    expect(respondida(e, undefined)).toBe(false);
    expect(respondida(e, 0)).toBe(true);
  });

  it("texto so de espacos nao conta como resposta", () => {
    expect(respondida(ETAPAS[0].questions[0], "   ")).toBe(false);
    expect(respondida(ETAPAS[0].questions[5], "  \n ")).toBe(false);
  });

  it("progresso conta perguntas respondidas de 52, nao telas", () => {
    expect(contarRespondidas(ETAPAS, {})).toEqual({ respondidas: 0, total: 52 });
    expect(contarRespondidas(ETAPAS, { q7: 0, q16: 3, q1: "x" }).respondidas).toBe(3);
  });

  it("ancoras vem da pergunta; a reserva canonica so cobre a falta delas", () => {
    expect(rotulosDaEscala(ETAPAS[1].questions[0])).toEqual(["Totalmente insatisfeito", "Plenamente satisfeito"]);
    expect(rotulosDaEscala(ETAPAS[2].questions[0])).toEqual(["Discordo totalmente", "Concordo totalmente"]);
  });

  it("a letra destacada reconstitui a alternativa exata", () => {
    const op = "A. Organizar o problema e definir a prioridade antes de avançar.";
    const p = separarLetra(op)!;
    expect(`${p.letra} ${p.resto}`).toBe(op);
    expect(separarLetra("Sem letra")).toBeNull();
  });

  it("estimativa honesta de tempo para o v2", () => {
    expect(estimarMinutos(ETAPAS)).toEqual({ de: 15, ate: 20 });
  });
});

describe("pergunta que repete o nome", () => {
  const comNome: EtapaImersiva[] = ETAPAS.map((e, i) =>
    i === 0
      ? { ...e, questions: e.questions.map((x, j) => (j === 0 ? { ...x, text: "Qual é seu nome completo?" } : x)) }
      : e,
  );

  it("sai da tela, e so ela", () => {
    const { etapas, idDoNome } = separarPerguntaDoNome(comNome);
    expect(idDoNome).toBe("q1");
    expect(etapas[0].questions.map((x) => x.id)).not.toContain("q1");
    expect(etapas[0].questions).toHaveLength(comNome[0].questions.length - 1);
    expect(etapas.slice(1)).toEqual(comNome.slice(1));
    expect(montarRoteiro(etapas).some((t) => t.id === "perguntas:q1")).toBe(false);
  });

  it("nao mexe em nada quando o questionario nao pergunta o nome", () => {
    const { etapas, idDoNome } = separarPerguntaDoNome(ETAPAS);
    expect(idDoNome).toBeNull();
    expect(etapas).toEqual(ETAPAS);
  });

  it("nao esvazia etapa nem tira pergunta que nao e de texto", () => {
    const soNome: EtapaImersiva[] = [{ ...ETAPAS[0], questions: [q("q1", { text: "Seu nome completo" })] }];
    expect(separarPerguntaDoNome(soNome).idDoNome).toBeNull();
    const escala: EtapaImersiva[] = [
      { ...ETAPAS[0], questions: [q("q1", { type: "scale", min: 0, max: 10, text: "Gosta do seu nome completo?" }), q("q2", {})] },
    ];
    expect(separarPerguntaDoNome(escala).idDoNome).toBeNull();
  });
});

describe("rascunho", () => {
  const ID = { nome: "Ana Lima", email: "ana@exemplo.com", telefone: "" };

  it("grava e le de volta, com a tela atual", () => {
    const s = memoria();
    gravarRascunho(s, "MZ", { identificacao: ID, respostas: { q1: "Ana" }, telaId: "perguntas:q2" }, 1000);
    const r = lerRascunho(s, "MZ", 2000)!;
    expect(r.origem).toBe("imersivo");
    expect(r.telaId).toBe("perguntas:q2");
    expect(r.respostas).toEqual({ q1: "Ana" });
  });

  it("expira em 7 dias e, vencido, e apagado (nos dois formatos)", () => {
    const s = memoria();
    gravarRascunho(s, "MZ", { identificacao: ID, respostas: { q1: "Ana" }, telaId: null }, 0);
    s.setItem(chaveDoRascunhoSimples("MZ"), JSON.stringify({ identificacao: ID, respostas: { q1: "x" }, passo: 1 }));
    expect(lerRascunho(s, "MZ", PRAZO_DO_RASCUNHO_MS - 1)).not.toBeNull();
    expect(lerRascunho(s, "MZ", PRAZO_DO_RASCUNHO_MS + 1)).toBeNull();
    expect(s.m.size).toBe(0);
  });

  it("apagar remove os dois formatos (senao o simples ressuscitaria)", () => {
    const s = memoria();
    gravarRascunho(s, "MZ", { identificacao: ID, respostas: { q1: "Ana" }, telaId: null }, 0);
    s.setItem(chaveDoRascunhoSimples("MZ"), JSON.stringify({ identificacao: ID, respostas: {}, passo: 0 }));
    apagarRascunho(s, "MZ");
    expect(lerRascunho(s, "MZ", 1)).toBeNull();
  });

  it("IMPORTA o rascunho da versao simples e retoma na primeira pergunta sem resposta", () => {
    const s = memoria();
    // Exatamente o que FormularioPublico.tsx grava: { identificacao, respostas, passo }.
    const respostas: Record<string, string | number> = {};
    for (const i of n(1, 5)) respostas[`q${i}`] = `r${i}`;
    respostas.q6 = "ambientes";
    for (const i of n(7, 13)) respostas[`q${i}`] = i === 7 ? 0 : 8;
    respostas.q14 = "a";
    respostas.q15 = "b";
    for (const i of n(16, 38)) respostas[`q${i}`] = 4;
    s.setItem(chaveDoRascunhoSimples("MZ"), JSON.stringify({ identificacao: ID, respostas, passo: 3 }));

    const r = lerRascunho(s, "MZ", 5)!;
    expect(r.origem).toBe("simples");
    expect(r.identificacao).toEqual(ID);
    expect(r.respostas).toEqual(respostas); // nada perdido, zero incluido
    expect(r.passoSimples).toBe(3);

    const roteiro = montarRoteiro(ETAPAS);
    const i = primeiraTelaIncompleta(roteiro, r.respostas, r.identificacao);
    const t = roteiro[i];
    expect(t.tipo === "perguntas" && t.perguntas[0].id).toBe("q39");
    expect(contarRespondidas(ETAPAS, r.respostas).respondidas).toBe(38);
  });

  it("o formato proprio tem prioridade sobre o simples", () => {
    const s = memoria();
    s.setItem(chaveDoRascunhoSimples("MZ"), JSON.stringify({ identificacao: ID, respostas: { q1: "velho" }, passo: 1 }));
    gravarRascunho(s, "MZ", { identificacao: ID, respostas: { q1: "novo" }, telaId: null }, 0);
    expect(lerRascunho(s, "MZ", 1)!.respostas.q1).toBe("novo");
  });

  it("rascunho corrompido nao quebra e valores de formato estranho sao descartados", () => {
    const s = memoria();
    s.setItem(chaveDoRascunhoImersivo("MZ"), "{nao e json");
    expect(lerRascunho(s, "MZ", 0)).toBeNull();
    s.setItem(chaveDoRascunhoImersivo("MZ"), JSON.stringify({ identificacao: ID, respostas: { q1: "ok", q2: { x: 1 } }, salvoEm: 0 }));
    expect(lerRascunho(s, "MZ", 1)!.respostas).toEqual({ q1: "ok" });
  });

  it("enviado: sai o rascunho, fica so a data, que tambem expira", () => {
    const s = memoria();
    gravarRascunho(s, "MZ", { identificacao: ID, respostas: { q1: "Ana" }, telaId: null }, 0);
    registrarEnvio(s, "MZ", 10);
    expect(lerRascunho(s, "MZ", 11)).toBeNull();
    expect(lerEnvio(s, "MZ", 11)).toBe(10);
    expect([...s.m.values()].join("")).not.toContain("ana@exemplo.com");
    expect(lerEnvio(s, "MZ", 10 + PRAZO_DO_RASCUNHO_MS + 1)).toBeNull();
  });
});
