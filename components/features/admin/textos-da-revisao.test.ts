import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pdfPermitido } from "@/lib/pdf/politica-do-pdf";
import { textosDaRevisao } from "./textos-da-revisao";

const TRAVESSAO = /[—–]/;

describe("textos da revisao por tipo de evento", () => {
  it("v1 (com PDF): os textos do produto antigo continuam exatamente os mesmos", () => {
    const t = textosDaRevisao(pdfPermitido({ quiz_version: 1 }));
    expect(t.aoSalvar).toBe("Edição salva. PDF será regenerado ao entregar.");
    expect(t.negrito).toBe(" vira negrito no PDF e na web.");
  });

  it("v2 (Marco Zero, sem PDF): nenhum texto fala de PDF", () => {
    const t = textosDaRevisao(pdfPermitido({ quiz_version: 2 }));
    expect(t.aoSalvar).toBe(
      "Edição salva. Após a aprovação, o documento poderá ser disponibilizado ao participante.",
    );
    expect(t.negrito).toContain("ficará em negrito no documento apresentado ao participante");
    expect(`${t.aoSalvar}${t.negrito}`).not.toMatch(/PDF/i);
  });

  it("evento sem versao legivel cai no lado sem PDF, como a politica do PDF", () => {
    expect(textosDaRevisao(pdfPermitido(null)).aoSalvar).not.toMatch(/PDF/);
  });

  it("nenhum texto tem travessao", () => {
    for (const pdf of [true, false]) {
      const t = textosDaRevisao(pdf);
      expect(`${t.aoSalvar}${t.negrito}`).not.toMatch(TRAVESSAO);
    }
  });

  it("o cartao do Caderno no painel nao tem travessao no texto (comentario pode ter)", () => {
    const fonte = readFileSync(
      new URL("../marco-zero/CadernoDeConducaoCard.tsx", import.meta.url),
      "utf8",
    );
    const linhas = fonte
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
      .filter((l) => TRAVESSAO.test(l));
    expect(linhas).toEqual([]);
  });
});
