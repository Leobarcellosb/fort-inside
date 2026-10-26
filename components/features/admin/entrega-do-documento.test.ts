import { describe, expect, it } from "vitest";
import {
  TEXTO_SEM_REVISAO_SALVA,
  idDaRazao,
  situacaoDaEntrega,
} from "./entrega-do-documento";

describe("situacaoDaEntrega: o botão desligado tem de ter uma razão", () => {
  it("sem selo de aprovação: bloqueada, com o texto da razão", () => {
    const s = situacaoDaEntrega({ conteudo_aprovado_hash: null });
    expect(s.liberada).toBe(false);
    if (s.liberada) throw new Error("inalcançável");
    expect(s.motivo).toBe("sem_revisao_salva");
    expect(s.texto).toBe(TEXTO_SEM_REVISAO_SALVA);
  });

  it("selo ausente da linha (undefined) conta como sem revisão", () => {
    expect(situacaoDaEntrega({}).liberada).toBe(false);
  });

  it("selo em branco não é selo: string vazia e só-espaços bloqueiam", () => {
    expect(situacaoDaEntrega({ conteudo_aprovado_hash: "" }).liberada).toBe(false);
    expect(situacaoDaEntrega({ conteudo_aprovado_hash: "   " }).liberada).toBe(false);
  });

  it("COM selo: liberada, e não sobra razão nenhuma para a tela mostrar", () => {
    const s = situacaoDaEntrega({ conteudo_aprovado_hash: "a3f9c1" });
    expect(s).toEqual({ liberada: true });
    // O tipo não tem `texto` no caso liberado: é impossível a tela renderizar
    // o aviso num documento liberado, porque não existe texto para renderizar.
    expect("texto" in s).toBe(false);
  });
});

describe("o texto INSTRUI: diz o caminho, não só que não dá", () => {
  it("nomeia a ação, a tela e o passo que libera a entrega", () => {
    // Estes três são o caminho. Se alguém reescrever a frase para "entrega
    // bloqueada" e nada mais, este teste cai -- de propósito.
    expect(TEXTO_SEM_REVISAO_SALVA).toContain("Revisar");
    expect(TEXTO_SEM_REVISAO_SALVA).toContain("leia");
    expect(TEXTO_SEM_REVISAO_SALVA).toContain("salve");
    expect(TEXTO_SEM_REVISAO_SALVA).toContain("envio é liberado");
  });

  it("é uma frase de verdade, não um rótulo de três palavras", () => {
    expect(TEXTO_SEM_REVISAO_SALVA.length).toBeGreaterThan(80);
  });
});

describe("idDaRazao: a razão é POR DOCUMENTO, não um aviso único da tela", () => {
  it("documentos diferentes têm identificadores diferentes", () => {
    expect(idDaRazao("doc-a")).not.toBe(idDaRazao("doc-b"));
  });

  it("o mesmo documento sempre leva ao mesmo identificador (o botão amarra nele)", () => {
    expect(idDaRazao("doc-a")).toBe(idDaRazao("doc-a"));
  });
});

describe("a tela com vários documentos: o aviso aparece só em quem está bloqueado", () => {
  it("3 documentos, 1 sem revisão: exatamente 1 razão para exibir", () => {
    const documentos = [
      { id: "1", conteudo_aprovado_hash: "aa" },
      { id: "2", conteudo_aprovado_hash: null },
      { id: "3", conteudo_aprovado_hash: "cc" },
    ];
    const bloqueados = documentos.filter((d) => !situacaoDaEntrega(d).liberada).map((d) => d.id);
    expect(bloqueados).toEqual(["2"]);
  });

  it("quando o documento ganha revisão salva, a razão SOME (não vira outro texto)", () => {
    const antes = situacaoDaEntrega({ conteudo_aprovado_hash: null });
    const depois = situacaoDaEntrega({ conteudo_aprovado_hash: "a3f9c1" });
    expect(antes.liberada).toBe(false);
    expect(depois.liberada).toBe(true);
  });
});
