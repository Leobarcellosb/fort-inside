import { describe, expect, it } from "vitest";
import {
  ROTULO_CONTAGEM_DESCONHECIDA,
  coletaDeEtapasConcluida,
  contagemNaEtapaAtual,
  leituraDoPainel,
  pendentesDaEtapaAtual,
  proximaEtapa,
  situacaoDaPessoa,
  textoDeEtapaLiberada,
  textoDeRespostaRecebida,
  trilhaDaPessoa,
  type EtapaRecebida,
} from "./etapas-do-painel";

// As duas versões REAIS do banco (conferidas no stack local, 26 migrations):
//   v1 Fort Inside : ids 1..6,     stage_number 1..6, ambientes da casa
//   v2 Marco Zero  : ids 101..105, stage_number 1..5, ambiente "Marco Zero"
const V1: EtapaRecebida[] = [
  { id: 1, title: "Seu Ponto de Partida", ambient_name: "Portão" },
  { id: 2, title: "A Chegada", ambient_name: "Entrada" },
  { id: 3, title: "A Força que Sustenta", ambient_name: "Sala" },
  { id: 4, title: "A Fricção Invisível", ambient_name: "Cozinha" },
  { id: 5, title: "O Horizonte Visível", ambient_name: "Varanda" },
  { id: 6, title: "A Decisão que Arrisca", ambient_name: "Suíte" },
];

const V2: EtapaRecebida[] = [
  { id: 101, title: "Sobre você", ambient_name: "Marco Zero" },
  { id: 102, title: "Os 7 Elementos da Vida Plena", ambient_name: "Marco Zero" },
  { id: 103, title: "Perfil comportamental", ambient_name: "Marco Zero" },
  { id: 104, title: "Como você reage na prática", ambient_name: "Marco Zero" },
  { id: 105, title: "Sua preparação para o Marco Zero", ambient_name: "Marco Zero" },
];

const PESSOAS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

/** O cenário que o dono viu na tela: 3 de 4 pessoas com as cinco etapas da v2. */
const RESPOSTAS_V2 = ["a", "b", "c"].flatMap((p) =>
  [101, 102, 103, 104, 105].map((stage_id) => ({ participant_id: p, stage_id }))
);

describe("leituraDoPainel: a tela sabe ler este evento?", () => {
  it("v1 (ids 1..6): sabe ler, e os nomes vêm das linhas do banco", () => {
    const l = leituraDoPainel(V1);
    expect(l.suportado).toBe(true);
    if (!l.suportado) throw new Error("inalcançável");
    expect(l.total).toBe(6);
    expect(l.etapas.map((e) => e.numero)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(l.etapas.map((e) => e.ambiente)).toEqual([
      "Portão",
      "Entrada",
      "Sala",
      "Cozinha",
      "Varanda",
      "Suíte",
    ]);
    expect(l.etapas[0].titulo).toBe("Seu Ponto de Partida");
  });

  it("v2 (ids 101..105): NÃO sabe ler, e informa os ids que recebeu", () => {
    const l = leituraDoPainel(V2);
    expect(l.suportado).toBe(false);
    if (l.suportado) throw new Error("inalcançável");
    expect(l.motivo).toBe("ids_nao_sao_ordinais");
    expect(l.idsEncontrados).toEqual([101, 102, 103, 104, 105]);
    expect(l.texto.length).toBeGreaterThan(80);
  });

  it("sem etapas: NÃO sabe ler, com motivo próprio", () => {
    const l = leituraDoPainel([]);
    expect(l.suportado).toBe(false);
    if (l.suportado) throw new Error("inalcançável");
    expect(l.motivo).toBe("sem_etapas");
  });

  it("o critério é a FORMA dos ids, não o número da versão", () => {
    // Uma versão futura com ids 1..N seria lida; uma v1 remendada com um buraco
    // não seria. Nenhum `quiz_version` entra nesta função.
    expect(leituraDoPainel([{ id: 1, title: "a", ambient_name: "x" }]).suportado).toBe(true);
    expect(
      leituraDoPainel([
        { id: 1, title: "a", ambient_name: "x" },
        { id: 3, title: "c", ambient_name: "z" },
      ]).suportado
    ).toBe(false);
  });

  it("ordem de chegada não importa: ids 1..N fora de ordem continuam legíveis", () => {
    const l = leituraDoPainel([
      { id: 2, title: "b", ambient_name: "y" },
      { id: 1, title: "a", ambient_name: "x" },
    ]);
    expect(l.suportado).toBe(true);
    if (!l.suportado) throw new Error("inalcançável");
    expect(l.etapas.map((e) => e.numero)).toEqual([1, 2]);
  });
});

describe("a casa do Fort Inside não aparece em evento que não é dela", () => {
  it("nenhum nome de ambiente da casa sai desta função para um evento da v2", () => {
    const l = leituraDoPainel(V2);
    const serializado = JSON.stringify(l);
    for (const nome of ["Portão", "Entrada", "Sala Principal", "Cozinha", "Varanda", "Suíte"]) {
      expect(serializado).not.toContain(nome);
    }
  });

  it("os nomes da v1 só aparecem porque estão nas linhas da v1", () => {
    const l = leituraDoPainel(V1.map((e) => ({ ...e, ambient_name: null })));
    expect(l.suportado).toBe(true);
    if (!l.suportado) throw new Error("inalcançável");
    // Sem `ambient_name` no banco, a tela não tem nome de ambiente para mostrar
    // -- e não inventa um de um vetor fixo.
    expect(l.etapas.every((e) => e.ambiente === "")).toBe(true);
  });
});

describe("proximaEtapa: não se oferece operação que não existe", () => {
  it("v1 na etapa 5: oferece a etapa 6, com o nome dela", () => {
    const p = proximaEtapa(leituraDoPainel(V1), 5);
    expect(p.oferecer).toBe(true);
    if (!p.oferecer) throw new Error("inalcançável");
    expect(p.numero).toBe(6);
    expect(p.etapa.titulo).toBe("A Decisão que Arrisca");
  });

  it("v1 na última etapa: NÃO oferece etapa 7", () => {
    const p = proximaEtapa(leituraDoPainel(V1), 6);
    expect(p.oferecer).toBe(false);
    if (p.oferecer) throw new Error("inalcançável");
    expect(p.motivo).toBe("ultima_etapa");
  });

  it("DEFEITO VISTO: evento da v2 na etapa 5 NÃO oferece 'liberar etapa 6'", () => {
    const p = proximaEtapa(leituraDoPainel(V2), 5);
    expect(p.oferecer).toBe(false);
    if (p.oferecer) throw new Error("inalcançável");
    expect(p.motivo).toBe("nao_sei_ler");
    expect(p.texto.length).toBeGreaterThan(40);
  });

  it("em NENHUMA etapa atual um evento da v2 ganha uma próxima etapa", () => {
    const l = leituraDoPainel(V2);
    for (let atual = 0; atual <= 8; atual++) {
      expect(proximaEtapa(l, atual).oferecer).toBe(false);
    }
  });
});

describe("contagemNaEtapaAtual: 'não sei' nunca é zero", () => {
  it("v1: conta de verdade quem enviou a etapa atual", () => {
    const c = contagemNaEtapaAtual({
      leitura: leituraDoPainel(V1),
      etapaAtual: 2,
      participantes: PESSOAS,
      respostas: [
        { participant_id: "a", stage_id: 1 },
        { participant_id: "a", stage_id: 2 },
        { participant_id: "b", stage_id: 2 },
      ],
    });
    expect(c).toEqual({ estado: "conhecida", feitos: 2, total: 4, etapa: 2 });
  });

  it("DEFEITO VISTO: evento da v2 com todos respondendo não produz '0/4 na etapa 5'", () => {
    const c = contagemNaEtapaAtual({
      leitura: leituraDoPainel(V2),
      etapaAtual: 5,
      participantes: PESSOAS,
      respostas: RESPOSTAS_V2,
    });
    expect(c.estado).toBe("nao_sei");
    // A prova do que importa: não existe o número 0 neste resultado. A tela não
    // tem como exibir "0/4" porque não recebe contagem nenhuma.
    expect(JSON.stringify(c)).not.toContain("0");
    if (c.estado !== "nao_sei") throw new Error("inalcançável");
    expect(c.texto).toContain("Não é zero");
    expect(ROTULO_CONTAGEM_DESCONHECIDA).not.toContain("0");
  });

  it("evento que ainda não liberou etapa: 'não começou' é diferente de 'não sei'", () => {
    const c = contagemNaEtapaAtual({
      leitura: leituraDoPainel(V1),
      etapaAtual: 0,
      participantes: PESSOAS,
      respostas: [],
    });
    expect(c.estado).toBe("nao_comecou");
  });

  it("v1 com current_stage apontando para etapa inexistente: não sei (não zero)", () => {
    const c = contagemNaEtapaAtual({
      leitura: leituraDoPainel(V1),
      etapaAtual: 9,
      participantes: PESSOAS,
      respostas: [],
    });
    expect(c.estado).toBe("nao_sei");
  });

  it("v1 com ninguém respondendo: aí ZERO é a verdade, e é exibido", () => {
    // A contrapartida do teste acima: a tela não perdeu a capacidade de dizer
    // zero quando zero é um fato verificado.
    const c = contagemNaEtapaAtual({
      leitura: leituraDoPainel(V1),
      etapaAtual: 3,
      participantes: PESSOAS,
      respostas: [],
    });
    expect(c).toEqual({ estado: "conhecida", feitos: 0, total: 4, etapa: 3 });
  });
});

describe("pendentesDaEtapaAtual: não se acusa ninguém por ignorância da tela", () => {
  it("v1: lista quem realmente não enviou", () => {
    const pend = pendentesDaEtapaAtual({
      leitura: leituraDoPainel(V1),
      etapaAtual: 1,
      participantes: PESSOAS,
      respostas: [{ participant_id: "a", stage_id: 1 }],
    });
    expect(pend.map((p) => p.id)).toEqual(["b", "c", "d"]);
  });

  it("v2: não lista as 4 pessoas como pendentes de uma etapa que a tela não lê", () => {
    const pend = pendentesDaEtapaAtual({
      leitura: leituraDoPainel(V2),
      etapaAtual: 5,
      participantes: PESSOAS,
      respostas: RESPOSTAS_V2,
    });
    expect(pend).toEqual([]);
  });
});

describe("trilhaDaPessoa: barrinhas apagadas afirmariam 'não respondeu nada'", () => {
  it("v1: marca as etapas respondidas", () => {
    const t = trilhaDaPessoa({ leitura: leituraDoPainel(V1), respondidas: [1, 2, 3] });
    expect(t.estado).toBe("conhecida");
    if (t.estado !== "conhecida") throw new Error("inalcançável");
    expect(t.marcas.map((m) => m.respondida)).toEqual([true, true, true, false, false, false]);
  });

  it("v2: a tela não desenha trilha em vez de desenhar seis barras apagadas", () => {
    const t = trilhaDaPessoa({ leitura: leituraDoPainel(V2), respondidas: [101, 102, 103, 104, 105] });
    expect(t).toEqual({ estado: "nao_sei" });
  });
});

describe("situacaoDaPessoa: 'Respondendo' aparecia para quem já tinha acabado", () => {
  it("quem concluiu o quiz: 'completo', e isso vale mesmo sem leitura das etapas", () => {
    // `completed_at` é fato do banco e não depende de etapa nenhuma.
    for (const etapas of [V1, V2]) {
      const s = situacaoDaPessoa({
        leitura: leituraDoPainel(etapas),
        etapaAtual: 5,
        concluiuQuiz: true,
        respondidas: [],
      });
      expect(s).toEqual({ tipo: "completo" });
    }
  });

  it("v1, enviou a etapa atual: 'na etapa atual'", () => {
    const s = situacaoDaPessoa({
      leitura: leituraDoPainel(V1),
      etapaAtual: 3,
      concluiuQuiz: false,
      respondidas: [1, 2, 3],
    });
    expect(s).toEqual({ tipo: "na_etapa_atual", etapa: 3 });
  });

  it("v1, não enviou: 'respondendo'", () => {
    const s = situacaoDaPessoa({
      leitura: leituraDoPainel(V1),
      etapaAtual: 3,
      concluiuQuiz: false,
      respondidas: [1, 2],
    });
    expect(s).toEqual({ tipo: "respondendo" });
  });

  it("v2, não concluiu: a tela diz que não sabe, não diz 'Respondendo'", () => {
    const s = situacaoDaPessoa({
      leitura: leituraDoPainel(V2),
      etapaAtual: 5,
      concluiuQuiz: false,
      respondidas: [101, 102],
    });
    expect(s).toEqual({ tipo: "nao_sei" });
  });
});

describe("textos que citam número de etapa", () => {
  it("v1: cita o número da etapa", () => {
    expect(textoDeRespostaRecebida(leituraDoPainel(V1), "Ana", 3)).toBe("Ana completou etapa 3");
    expect(textoDeEtapaLiberada(leituraDoPainel(V1), 4)).toBe("Etapa 4 liberada");
  });

  it("v2: NÃO escreve 'completou etapa 103' -- 103 é id de linha, não etapa", () => {
    const t = textoDeRespostaRecebida(leituraDoPainel(V2), "Ana", 103);
    expect(t).not.toContain("103");
    expect(t).toContain("Ana");
    expect(t).toContain("não identificada");
  });

  it("v2: a timeline não inventa número de etapa liberada", () => {
    expect(textoDeEtapaLiberada(leituraDoPainel(V2), 6)).not.toContain("6");
  });

  it("registro antigo sem stage_id no payload: texto sem número, sem 'undefined'", () => {
    const t = textoDeEtapaLiberada(leituraDoPainel(V1), undefined);
    expect(t).toBe("Etapa liberada");
    expect(t).not.toContain("undefined");
  });
});

describe("coletaDeEtapasConcluida: o '=== 6' escrito a mão saiu", () => {
  it("v1: verdadeiro só a partir da última etapa", () => {
    const l = leituraDoPainel(V1);
    expect(coletaDeEtapasConcluida(l, 5)).toBe(false);
    expect(coletaDeEtapasConcluida(l, 6)).toBe(true);
  });

  it("v2: a tela não afirma que a coleta terminou, porque não sabe", () => {
    const l = leituraDoPainel(V2);
    for (let atual = 0; atual <= 8; atual++) {
      expect(coletaDeEtapasConcluida(l, atual)).toBe(false);
    }
  });
});
