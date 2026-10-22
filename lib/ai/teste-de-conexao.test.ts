import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  MODELO_DOS_DOCUMENTOS,
  classificarFalhaDaIA,
  destinoDaChamada,
  testarConexaoComIA,
} from "./teste-de-conexao";

function erroDaApi(status: number, tipo: string) {
  return Anthropic.APIError.generate(status, { type: "error", error: { type: tipo, message: "x" } }, "x", new Headers());
}

describe("teste da IA antes de processar", () => {
  it("o modelo do teste e o mesmo que gera os documentos", () => {
    const gerador = readFileSync(new URL("./generate-prognostic.ts", import.meta.url), "utf8");
    expect(gerador).toContain(`model: "${MODELO_DOS_DOCUMENTOS}"`);
  });

  it("classifica pelo status e pelo tipo do SDK", () => {
    expect(classificarFalhaDaIA(erroDaApi(401, "authentication_error")).classe).toBe("credencial");
    expect(classificarFalhaDaIA(erroDaApi(402, "billing_error")).classe).toBe("saldo");
    expect(classificarFalhaDaIA(erroDaApi(403, "permission_error")).classe).toBe("permissao");
    expect(classificarFalhaDaIA(erroDaApi(404, "not_found_error")).classe).toBe("modelo");
    expect(classificarFalhaDaIA(erroDaApi(429, "rate_limit_error")).classe).toBe("limite");
    expect(classificarFalhaDaIA(erroDaApi(529, "overloaded_error")).classe).toBe("provedor");
    expect(classificarFalhaDaIA(erroDaApi(500, "api_error")).classe).toBe("provedor");
    expect(classificarFalhaDaIA(new Anthropic.APIConnectionError({ message: "x" })).classe).toBe("rede");
    expect(classificarFalhaDaIA(new Error("x")).classe).toBe("outra");
  });

  it("o destino mostra so o host", () => {
    expect(destinoDaChamada(undefined)).toBe("api.anthropic.com");
    expect(destinoDaChamada("http://127.0.0.1:56083")).toBe("127.0.0.1:56083");
  });

  it("chamada que da certo devolve modelo, destino e tempo; que falha devolve a classe", async () => {
    let t = 0;
    const relogio = () => (t += 100);
    const ok = {
      baseURL: "https://api.anthropic.com",
      messages: { create: async () => ({ model: "claude-opus-5", stop_reason: "end_turn" }) },
    } as unknown as Anthropic;
    const r = await testarConexaoComIA(ok, relogio);
    expect(r).toMatchObject({ ok: true, modelo: "claude-opus-5", destino: "api.anthropic.com", latenciaMs: 100 });

    const recusada = {
      baseURL: "https://api.anthropic.com",
      messages: {
        create: async () => {
          throw erroDaApi(401, "authentication_error");
        },
      },
    } as unknown as Anthropic;
    expect(await testarConexaoComIA(recusada, relogio)).toMatchObject({ ok: false, classe: "credencial", status: 401 });
  });
});
