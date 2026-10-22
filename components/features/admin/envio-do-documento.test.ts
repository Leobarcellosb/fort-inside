import { describe, expect, it } from "vitest";
import {
  linkDoDocumento,
  linkDoWhatsApp,
  mensagemDeEnvio,
  origemDoLink,
  primeiroNomeDoDestinatario,
  textoDaConferencia,
} from "./envio-do-documento";

describe("envio do documento", () => {
  it("o link sai com o dominio do Marco Zero, mesmo com o painel no endereco antigo", () => {
    expect(origemDoLink("https://fort-inside.vercel.app")).toBe("https://marcozero-gp.vercel.app");
    expect(origemDoLink("https://marcozero-gp.vercel.app")).toBe("https://marcozero-gp.vercel.app");
    expect(origemDoLink("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(linkDoDocumento("https://fort-inside.vercel.app", "abc")).toBe(
      "https://marcozero-gp.vercel.app/prognostic/abc",
    );
  });

  it("a mensagem leva so o primeiro nome", () => {
    const m = mensagemDeEnvio("  Ana Clara Souza ", "https://x/prognostic/t");
    expect(m).toBe("Ana, seu direcionamento individual do Marco Zero está disponível: https://x/prognostic/t");
    expect(m).not.toContain("Souza");
    expect(primeiroNomeDoDestinatario("")).toBe("");
    expect(mensagemDeEnvio("", "L")).toBe("Seu direcionamento individual do Marco Zero está disponível: L");
  });

  it("nenhum travessao no que o participante recebe", () => {
    expect(mensagemDeEnvio("Ana Souza", "L")).not.toMatch(/[—–]/);
  });

  it("o WhatsApp abre sem numero, com a mensagem inteira codificada", () => {
    const w = linkDoWhatsApp("Ana, seu link: https://x/p?a=1&b=2");
    expect(w.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(w.slice("https://wa.me/?text=".length))).toBe(
      "Ana, seu link: https://x/p?a=1&b=2",
    );
  });

  it("a conferencia nomeia a pessoa inteira", () => {
    expect(textoDaConferencia("Ana Clara Souza")).toBe(
      "Conferi no contato oficial que esta conversa é de Ana Clara Souza.",
    );
    expect(textoDaConferencia("  ")).toContain("a pessoa indicada");
  });
});

describe("QR do evento", () => {
  it("assincrono leva ao formulario publico no dominio do Marco Zero; ao vivo continua em /join", async () => {
    const { linkDoQrDoEvento } = await import("./envio-do-documento");
    expect(linkDoQrDoEvento("https://fort-inside.vercel.app", { event_code: "MARCOZERO", mode: "async" })).toBe(
      "https://marcozero-gp.vercel.app/formulario/MARCOZERO",
    );
    expect(linkDoQrDoEvento("https://fort-inside.vercel.app", { event_code: "FORT1", mode: "live" })).toBe(
      "https://fort-inside.vercel.app/join/FORT1",
    );
  });
});
