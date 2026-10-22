import { describe, expect, it } from "vitest";
import { chamarAbrirEtapa } from "./abrir-etapa-cliente";

const corpo = (agora: string) => ({
  modo: "async",
  agora,
  janela: null,
  total_etapas: 5,
  etapas_iniciadas: [],
  sessao: null,
  recem_criada: false,
  motivo_recusa: null,
});
const resposta = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("chamarAbrirEtapa", () => {
  it("mede o desvio entre o relogio do servidor e o do aparelho (aparelho 1h atrasado)", async () => {
    const servidor = Date.parse("2026-10-21T23:00:00Z");
    // aparelho: 22h00Z (1h atras). Ida e volta de 200ms: o meio e +100ms.
    let t = servidor - 3600_000;
    const relogio = () => {
      const v = t;
      t += 200;
      return v;
    };
    const r = await chamarAbrirEtapa("p", 1, resposta(200, corpo(new Date(servidor).toISOString())), relogio);
    expect(r.tipo).toBe("ok");
    if (r.tipo !== "ok") return;
    expect(r.deslocamento).toBeCloseTo(3600_000 - 100, -1);
  });

  it("nunca lanca: rede caida, 500, 401/403, 404, corpo ilegivel", async () => {
    const rede = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect((await chamarAbrirEtapa("p", 1, rede)).tipo).toBe("indisponivel");
    expect((await chamarAbrirEtapa("p", 1, resposta(500, {}))).tipo).toBe("indisponivel");
    expect((await chamarAbrirEtapa("p", 1, resposta(401, {}))).tipo).toBe("sem_acesso");
    expect((await chamarAbrirEtapa("p", 1, resposta(403, {}))).tipo).toBe("sem_acesso");
    expect((await chamarAbrirEtapa("p", 1, resposta(404, {}))).tipo).toBe("inexistente");
    expect((await chamarAbrirEtapa("p", 1, resposta(200, { agora: "lixo" }))).tipo).toBe("indisponivel");
  });
});
