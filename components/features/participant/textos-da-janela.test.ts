import { describe, expect, it } from "vitest";
import type { FaseDaJanela } from "./janela-da-etapa";
import {
  MSG_ENVIO_AINDA_NAO_ABRIU,
  MSG_ENVIO_ENCERRADO,
  MSG_ENVIO_FALHA_GENERICA,
  MSG_ENVIO_NAO_INICIA_MAIS,
  MSG_ENVIO_SEM_CONEXAO,
  mensagemDeRecusa,
  montarAviso,
  textoParaCopiar,
} from "./textos-da-janela";

const MIN = 60_000;
const T = Date.parse("2026-10-22T03:00:00Z"); // 00h00 de 22/10 em Brasilia
const janela = { abre: T - 5 * 24 * 60 * MIN, fecha: T };

function aviso(fase: FaseDaJanela, agora: number, extra: Partial<Parameters<typeof montarAviso>[0]> = {}) {
  return montarAviso({
    fase,
    agora,
    janela,
    etapasNaoIniciadas: [],
    temTexto: false,
    jaEnviou: false,
    ...extra,
  });
}
const tudo = (a: ReturnType<typeof aviso>) => [a?.titulo ?? "", ...(a?.corpo ?? [])].join(" ");

const JARGAO = /42501|permiss|rls|policy|postgres|sess[aã]o de etapa|constraint|violat|row-level|erro de banco|null/i;
const CULPA = /voc[eê] (n[aã]o |deveria|esqueceu|demorou|perdeu|atrasou)|sua culpa|tarde demais/i;

describe("avisos de prazo", () => {
  const casos: [string, FaseDaJanela, number, Partial<Parameters<typeof montarAviso>[0]>][] = [
    ["ainda_nao_abriu", "ainda_nao_abriu", janela.abre! - MIN, {}],
    ["aberta (>30 min)", "aberta", T - 3 * 60 * MIN, { etapasNaoIniciadas: [2, 3] }],
    ["aberta (<=30 min)", "aberta", T - 40 * MIN, { etapasNaoIniciadas: [3] }],
    ["reta_final", "reta_final", T - 10 * MIN, { etapasNaoIniciadas: [3, 4, 5] }],
    ["tolerancia", "tolerancia", T + 5 * MIN, { etapasNaoIniciadas: [4] }],
    ["nao_inicia_mais antes de T", "nao_inicia_mais", T - 10 * MIN, {}],
    ["nao_inicia_mais depois de T", "nao_inicia_mais", T + 5 * MIN, {}],
    ["encerrada com texto", "encerrada", T + 20 * MIN, { temTexto: true }],
    ["encerrada sem texto", "encerrada", T + 20 * MIN, {}],
    ["encerrada ja enviou", "encerrada", T + 20 * MIN, { jaEnviou: true }],
  ];

  it.each(casos)("%s: sem jargao tecnico e sem culpar", (_n, fase, agora, extra) => {
    const a = aviso(fase, agora, extra);
    if (a) {
      const t = tudo(a);
      expect(t).not.toMatch(JARGAO);
      expect(t).not.toMatch(CULPA);
    }
  });

  it("faltando menos de 15 min: avisa ANTES que nao da para comecar etapa nova e que a atual pode ser concluida", () => {
    const a = aviso("reta_final", T - 10 * MIN, { etapasNaoIniciadas: [3, 4, 5] })!;
    const t = tudo(a);
    expect(a.titulo).toMatch(/menos de 15 minutos/);
    expect(t).toMatch(/pode terminar e enviar normalmente até 22\/10 às 00h00/);
    expect(t).toMatch(/Não dá mais para começar etapas novas/);
    expect(t).toMatch(/etapas 3, 4 e 5 não foram começadas antes do limite/);
    expect(t).toMatch(/ainda aceitamos o envio desta etapa até 22\/10 às 00h15/);
    expect(t).not.toMatch(/até em/);
    expect(a.contagem?.restante).toBe("10 min 00 s");
  });

  it("tolerancia: o texto diz que serve SO para concluir etapa ja iniciada, nunca para abrir etapa nova", () => {
    const reta = tudo(aviso("reta_final", T - 10 * MIN));
    expect(reta).toMatch(/serve só para concluir uma etapa que você já começou/);
    expect(reta).toMatch(/nunca para começar uma etapa nova/);
    const tol = tudo(aviso("tolerancia", T + 5 * MIN));
    expect(tol).toMatch(/serve só para concluir uma etapa que você já começou/);
    expect(tol).toMatch(/Não dá para começar nenhuma etapa nova/);
    const perto = tudo(aviso("aberta", T - 40 * MIN));
    expect(perto).toMatch(/só dá para terminar e enviar etapas que você já começou/);
  });

  it("depois de T, dentro da tolerancia: diz ate quando e o que acontece depois", () => {
    const a = aviso("tolerancia", T + 5 * MIN)!;
    expect(a.titulo).toMatch(/ainda pode enviar/);
    expect(tudo(a)).toMatch(/00h15/);
    expect(tudo(a)).toMatch(/não recebe mais respostas/);
    expect(a.contagem?.restante).toBe("10 min 00 s");
  });

  it("janela fechada: mensagem honesta; com texto na tela avisa que continua la", () => {
    const com = tudo(aviso("encerrada", T + 20 * MIN, { temTexto: true }));
    expect(com).toMatch(/foi encerrado/);
    expect(com).toMatch(/continua aqui na tela/);
    const sem = tudo(aviso("encerrada", T + 20 * MIN));
    expect(sem).not.toMatch(/continua aqui na tela/);
    expect(tudo(aviso("encerrada", T + 20 * MIN, { jaEnviou: true }))).toMatch(/respostas dela foram recebidas/);
  });

  it("aberta com muito tempo: so uma linha discreta; sem fechamento: nada", () => {
    const a = aviso("aberta", T - 5 * 60 * MIN)!;
    expect(a.tom).toBe("discreto");
    expect(a.titulo).toBeNull();
    expect(montarAviso({ fase: "aberta", agora: T, janela: { abre: null, fecha: null }, etapasNaoIniciadas: [], temTexto: false, jaEnviou: false })).toBeNull();
  });
});

describe("mensagens de envio", () => {
  it("nenhuma carrega texto de banco", () => {
    for (const m of [
      MSG_ENVIO_AINDA_NAO_ABRIU,
      MSG_ENVIO_ENCERRADO,
      MSG_ENVIO_FALHA_GENERICA,
      MSG_ENVIO_NAO_INICIA_MAIS,
      MSG_ENVIO_SEM_CONEXAO,
    ]) {
      expect(m).not.toMatch(JARGAO);
      expect(m).not.toMatch(CULPA);
    }
  });
  it("recusa por fase", () => {
    expect(mensagemDeRecusa("encerrada")).toBe(MSG_ENVIO_ENCERRADO);
    expect(mensagemDeRecusa("nao_inicia_mais")).toBe(MSG_ENVIO_NAO_INICIA_MAIS);
    expect(mensagemDeRecusa("aberta")).toBeNull();
  });
});

describe("textoParaCopiar", () => {
  it("junta so o que foi respondido, preservando o texto inteiro", () => {
    const texto = textoParaCopiar(
      "Etapa X",
      [
        { id: "a", text: "Pergunta A", type: "text" },
        { id: "b", text: "Pergunta B", type: "text" },
        { id: "c", text: "Ordem", type: "ranking" },
        { id: "d", text: "Nota", type: "scale" },
      ],
      { a: "  Meu texto\ncom quebra  ", c: ["Z", "Y"], d: 7 },
    );
    expect(texto).toContain("1. Pergunta A\nMeu texto\ncom quebra");
    expect(texto).not.toContain("Pergunta B");
    expect(texto).toContain("3. Ordem\n1. Z\n2. Y");
    expect(texto).toContain("4. Nota\n7");
  });
  it("nada respondido = vazio", () => {
    expect(textoParaCopiar("E", [{ id: "a", text: "P" }], {})).toBe("");
  });
});
