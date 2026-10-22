import { describe, expect, it } from "vitest";
import { diagnosticarRecusaLive, type ClienteDeDiagnostico } from "./diagnostico-de-recusa-live";
import { MSG_ETAPA_NAO_LIBERADA, MSG_SESSAO_DE_LOGIN_EXPIRADA } from "./textos-da-janela";

function cliente(o: {
  user?: unknown | null;
  authErro?: { name?: string; status?: number } | null;
  currentStage?: number | null;
  eventoErro?: boolean;
}): ClienteDeDiagnostico {
  return {
    auth: {
      getUser: async () => ({ data: { user: o.user === undefined ? { id: "u" } : o.user }, error: o.authErro ?? null }),
    },
    from: () => ({
      select: () => {
        const q = {
          eq: () => q,
          maybeSingle: async () => ({
            data: o.currentStage == null ? null : { current_stage: o.currentStage },
            error: o.eventoErro ? { code: "XX" } : null,
          }),
          then: (ok: (v: { data: unknown; error: unknown }) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
        };
        return q as never;
      },
    }),
  };
}

describe("diagnosticarRecusaLive", () => {
  it("login valido + etapa 3 com current_stage 2 = etapa nao liberada", async () => {
    expect(await diagnosticarRecusaLive(cliente({ currentStage: 2 }), "e", 3)).toBe("etapa_nao_liberada");
  });
  it("sem usuario (login ausente de verdade) = login_ausente, mesmo que a etapa nao esteja liberada", async () => {
    expect(await diagnosticarRecusaLive(cliente({ user: null, currentStage: 2 }), "e", 3)).toBe("login_ausente");
    expect(await diagnosticarRecusaLive(cliente({ user: null, authErro: { name: "AuthSessionMissingError" } }), "e", 1)).toBe("login_ausente");
  });
  it("login fora do ar nao e login ausente: indeterminado", async () => {
    expect(await diagnosticarRecusaLive(cliente({ user: null, authErro: { name: "AuthRetryableFetchError", status: 0 } }), "e", 3)).toBe("indeterminado");
    expect(await diagnosticarRecusaLive(cliente({ user: null, authErro: { status: 503 } }), "e", 3)).toBe("indeterminado");
  });
  it("etapa liberada mas recusada, ou leitura falhou: indeterminado (nao se adivinha)", async () => {
    expect(await diagnosticarRecusaLive(cliente({ currentStage: 3 }), "e", 3)).toBe("indeterminado");
    expect(await diagnosticarRecusaLive(cliente({ currentStage: 2, eventoErro: true }), "e", 3)).toBe("indeterminado");
    expect(await diagnosticarRecusaLive(cliente({ currentStage: null }), "e", 3)).toBe("indeterminado");
  });
  it("os dois textos sao distintos", () => {
    expect(MSG_ETAPA_NAO_LIBERADA).toBe("Esta etapa ainda não foi liberada pela organização.");
    expect(MSG_SESSAO_DE_LOGIN_EXPIRADA).toBe("Sua sessão expirou. Recarregue a página e tente de novo.");
  });
});
