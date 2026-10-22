import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepararProcessamento } from "./preparar-processamento";
import { criarClienteFalso } from "../testing/cliente-falso";

const EV = "22222222-2222-4222-8222-222222222222";

function cliente(cs = 5) {
  const base = criarClienteFalso({
    events: [{ id: EV, quiz_version: 2, current_stage: cs, status: "live", mode: "live", form_opens_at: null, form_closes_at: null }],
    quiz_stages: [1, 2, 3, 4, 5].map((n) => ({ id: 100 + n, quiz_version: 2, stage_number: n })),
  });
  return {
    from(t: string) {
      if (t === "participants")
        return { select: () => ({ eq: () => ({ not: async () => ({ data: [{ id: "p", completed_at: "x" }], error: null }) }) }) };
      return base.from(t);
    },
  } as never;
}
const lerCodigo = async (r: { ok: boolean; resposta?: Response }) => (r.ok ? null : (await r.resposta!.json()).code);

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("prepararProcessamento -- pedido", () => {
  it.each([
    ["corpo que não é JSON", { json: async () => { throw new SyntaxError("x"); } }],
    ["corpo null", { json: async () => null }],
    ["sem event_id", { json: async () => ({}) }],
    ["event_id que não é UUID", { json: async () => ({ event_id: "abc" }) }],
    ["event_id numérico", { json: async () => ({ event_id: 7 }) }],
  ])("%s -> 400 INVALID_REQUEST", async (_n, req) => {
    const r = await prepararProcessamento(req, cliente());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.resposta.status).toBe(400);
    expect(await lerCodigo(r as never)).toBe("INVALID_REQUEST");
  });

  it("controle positivo: UUID válido, evento completo -> libera com a contagem do banco", async () => {
    const r = await prepararProcessamento({ json: async () => ({ event_id: EV }) }, cliente());
    expect(r).toMatchObject({ ok: true, eventId: EV, totalEtapas: 5 });
  });
});
