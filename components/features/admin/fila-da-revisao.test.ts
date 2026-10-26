import { describe, expect, it } from "vitest";
import { contarPorEtapa, etapaDaRevisao, ordenarParaRevisao } from "./fila-da-revisao";

describe("fila da revisao", () => {
  it("cada estado do documento vira o que o operador faz com ele", () => {
    expect(etapaDaRevisao("generated")).toBe("revisar");
    expect(etapaDaRevisao("in_review")).toBe("revisar");
    expect(etapaDaRevisao("reviewed")).toBe("enviar");
    expect(etapaDaRevisao("delivered")).toBe("enviado");
    expect(etapaDaRevisao("suspended")).toBe("fora_do_ar");
    expect(etapaDaRevisao(null)).toBe("sem_documento");
  });

  it("o que da para fazer agora vem primeiro; empate por nome", () => {
    const lista = ordenarParaRevisao([
      { nome: "Zeca", etapa: "enviado" as const },
      { nome: "Bia", etapa: "enviar" as const },
      { nome: "Ana", etapa: "revisar" as const },
      { nome: "Caio", etapa: "revisar" as const },
      { nome: "Davi", etapa: "sem_documento" as const },
    ]);
    expect(lista.map((x) => x.nome)).toEqual(["Ana", "Caio", "Bia", "Davi", "Zeca"]);
  });

  it("a contagem soma o total", () => {
    const c = contarPorEtapa(["revisar", "revisar", "enviar", "enviado"]);
    expect(c).toEqual({ revisar: 2, enviar: 1, sem_documento: 0, fora_do_ar: 0, enviado: 1 });
  });
});
