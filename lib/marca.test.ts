import { describe, expect, it } from "vitest";
import { MARCA, assinaturaDoAnfitriao } from "./marca";

describe("assinatura do app", () => {
  it("o Yuri sempre aparece com o movimento", () => {
    expect(MARCA).toBe("Yuri Fortes · Geração Preparada");
    expect(assinaturaDoAnfitriao("Yuri Fortes")).toBe(MARCA);
    expect(assinaturaDoAnfitriao("  yuri fortes ")).toBe(MARCA);
  });

  it("sem nome cadastrado, a marca", () => {
    expect(assinaturaDoAnfitriao(null)).toBe(MARCA);
    expect(assinaturaDoAnfitriao("")).toBe(MARCA);
  });

  it("outro anfitriao aparece como foi cadastrado", () => {
    expect(assinaturaDoAnfitriao("Outra Pessoa")).toBe("Outra Pessoa");
  });

  it("sem travessao", () => {
    expect(MARCA).not.toMatch(/[—–-]/);
  });
});
