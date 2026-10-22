import { describe, expect, it } from "vitest";
import { pdfPermitido } from "./politica-do-pdf";

describe("politica do PDF", () => {
  it("Marco Zero (questionario v2) nao tem PDF; o produto antigo (v1) continua com PDF", () => {
    expect(pdfPermitido({ quiz_version: 2 })).toBe(false);
    expect(pdfPermitido({ quiz_version: 1 })).toBe(true);
  });
  it("sem evento legivel, nao arrisca", () => {
    expect(pdfPermitido(null)).toBe(false);
    expect(pdfPermitido({})).toBe(false);
  });
});
