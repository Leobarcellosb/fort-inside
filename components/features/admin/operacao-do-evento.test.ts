import { describe, expect, it } from "vitest";
import { passosDaOperacao, prazoNaTela, rotuloDoEstado, tipoDaOperacao } from "./operacao-do-evento";

describe("tipo da operacao", () => {
  it("pelo modo e pela versao, nunca por adivinhacao", () => {
    expect(tipoDaOperacao({ mode: "async", quiz_version: 2 })).toBe("assincrona");
    expect(tipoDaOperacao({ mode: "live", quiz_version: 1 })).toBe("ao_vivo");
    expect(tipoDaOperacao({ mode: "live", quiz_version: 2 })).toBe("ao_vivo");
  });

  it("dado ausente ou contraditorio: nao verificado", () => {
    expect(tipoDaOperacao({ mode: null, quiz_version: 2 })).toBe("nao_verificado");
    expect(tipoDaOperacao({ mode: "async", quiz_version: 1 })).toBe("nao_verificado");
    expect(tipoDaOperacao({ mode: "async", quiz_version: null })).toBe("nao_verificado");
    expect(tipoDaOperacao({})).toBe("nao_verificado");
  });
});

describe("estado em portugues", () => {
  it("nenhuma palavra crua do banco", () => {
    expect(rotuloDoEstado("live", null)).toBe("Em andamento");
    expect(rotuloDoEstado("processing", null)).toBe("Gerando documentos");
    expect(rotuloDoEstado("draft", null)).toBe("Rascunho");
    expect(rotuloDoEstado("active", null)).toBe("Estado não reconhecido");
    expect(rotuloDoEstado("completed", { comDocumento: 50, falharam: 0 })).toBe("Concluído");
  });
});

describe("prazo na tela", () => {
  it("mostra o ultimo minuto aberto, em Brasilia", () => {
    const p = prazoNaTela("2026-10-24T03:00:00.000Z", new Date("2026-10-23T15:00:00.000Z"));
    expect(p.texto).toContain("23/10");
    expect(p.texto).toContain("23h59");
    expect(p.passou).toBe(false);
    expect(prazoNaTela("2026-10-24T03:00:00.000Z", new Date("2026-10-24T03:00:00.000Z")).passou).toBe(true);
  });

  it("sem prazo ou ilegivel: diz e nao afirma nada", () => {
    expect(prazoNaTela(null, new Date())).toEqual({ texto: "Prazo não cadastrado", passou: null });
    expect(prazoNaTela("x", new Date()).passou).toBeNull();
  });
});

describe("passos da operacao", () => {
  it("antes do prazo: coleta e o passo de agora", () => {
    expect(passosDaOperacao({ status: "live", prazoPassou: false, resumo: null, concluidos: 50 })).toEqual({
      coleta: "agora",
      testarIA: "depois",
      gerar: "depois",
      revisar: "depois",
    });
  });

  it("depois do prazo, sem documentos: testar a IA e gerar", () => {
    const p = passosDaOperacao({ status: "live", prazoPassou: true, resumo: { comDocumento: 0, falharam: 0 }, concluidos: 50 });
    expect(p.coleta).toBe("feito");
    expect(p.testarIA).toBe("agora");
    expect(p.gerar).toBe("agora");
  });

  it("documentos prontos: revisar e o passo de agora; o teste da IA nunca aparece como feito", () => {
    const p = passosDaOperacao({ status: "completed", prazoPassou: true, resumo: { comDocumento: 50, falharam: 0 }, concluidos: 50 });
    expect(p).toEqual({ coleta: "feito", testarIA: "se_precisar", gerar: "feito", revisar: "agora" });
  });

  it("todos com documento conta como feito mesmo antes do banco fechar o evento", () => {
    expect(passosDaOperacao({ status: "live", prazoPassou: true, resumo: { comDocumento: 50, falharam: 0 }, concluidos: 50 }).gerar).toBe("feito");
    expect(passosDaOperacao({ status: "live", prazoPassou: true, resumo: { comDocumento: 30, falharam: 0 }, concluidos: 50 }).gerar).toBe("agora");
  });

  it("falhas na geracao pedem atencao", () => {
    expect(passosDaOperacao({ status: "completed", prazoPassou: true, resumo: { comDocumento: 40, falharam: 10 }, concluidos: 50 }).gerar).toBe(
      "atencao",
    );
  });

  it("sem prazo cadastrado: a coleta pede atencao", () => {
    expect(passosDaOperacao({ status: "live", prazoPassou: null, resumo: null, concluidos: 50 }).coleta).toBe("atencao");
  });
});
