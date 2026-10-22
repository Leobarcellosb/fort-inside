import { describe, expect, it } from "vitest";
import {
  classificarFalhaDeAuth,
  foiVerificado,
  isAdminUser,
  verificarAdminCom,
  type ClienteDeAuth,
  type ErroDeAuthObservado,
} from "./require-admin";
import { DEFINICOES_DE_ERRO } from "../erros/codigos";

// Os três desfechos de uma verificação de identidade de administrador.
//
// O que estes testes protegem, nesta ordem de importância:
//   1. CONTROLE POSITIVO: admin de verdade passa. Sem isto, "tudo bloqueado"
//      passaria por aprovação -- e um guard que recusa todo mundo é inútil, não
//      seguro.
//   2. participante autenticado é recusado por PERMISSÃO (ADMIN_FORBIDDEN);
//   3. engasgo do serviço de login é INDISPONIBILIDADE (AUTH_UNAVAILABLE), nunca
//      recusa de permissão;
//   4. indisponibilidade BLOQUEIA: `autorizado` nunca é `true` fora do caminho
//      verificado;
//   5. nenhuma `message` do GoTrue entra na `causa` (que é o que vai ao log).

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  app_metadata: { role: "admin" },
} as never;
const participante = {
  id: "22222222-2222-4222-8222-222222222222",
  app_metadata: { role: "participant" },
} as never;

const clienteQue = (resposta: unknown): ClienteDeAuth =>
  ({ auth: { getUser: async () => resposta } }) as ClienteDeAuth;
const clienteQueExplode = (erro: unknown): ClienteDeAuth =>
  ({
    auth: {
      getUser: async () => {
        throw erro;
      },
    },
  }) as ClienteDeAuth;

/** Erros do GoTrue como o cliente realmente os entrega. */
const FALHAS: { nome: string; erro: ErroDeAuthObservado; esperado: string }[] = [
  {
    nome: "sessão ausente (o serviço respondeu e afirmou que não há sessão)",
    erro: { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" },
    esperado: "AUTH_REQUIRED",
  },
  {
    nome: "rede caída / timeout (o serviço NÃO respondeu)",
    erro: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
    esperado: "AUTH_UNAVAILABLE",
  },
  {
    nome: "502 do gateway do GoTrue",
    erro: { name: "AuthApiError", status: 502, message: "Bad Gateway" },
    esperado: "AUTH_UNAVAILABLE",
  },
  {
    nome: "503 do GoTrue",
    erro: { name: "AuthApiError", status: 503, message: "upstream connect error" },
    esperado: "AUTH_UNAVAILABLE",
  },
  {
    nome: "504 do GoTrue",
    erro: { name: "AuthApiError", status: 504, message: "gateway timeout" },
    esperado: "AUTH_UNAVAILABLE",
  },
  {
    nome: "token inválido (401: veredito do serviço)",
    erro: { name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" },
    esperado: "AUTH_REQUIRED",
  },
  {
    nome: "usuário removido (403: veredito do serviço)",
    erro: { name: "AuthApiError", status: 403, code: "user_not_found", message: "User from sub claim in JWT does not exist" },
    esperado: "AUTH_REQUIRED",
  },
  {
    nome: "erro sem nome nem status (formato não reconhecido)",
    erro: { message: "algo estranho" },
    esperado: "AUTH_UNAVAILABLE",
  },
  {
    nome: "status 0 (socket morreu antes de responder)",
    erro: { name: "TypeError", status: 0, message: "Failed to fetch" },
    esperado: "AUTH_UNAVAILABLE",
  },
];

describe("controle positivo: quem É admin passa", () => {
  it("sessão com app_metadata.role === 'admin' é autorizada", async () => {
    const r = await verificarAdminCom(clienteQue({ data: { user: admin }, error: null }));
    expect(r.autorizado).toBe(true);
    expect(r.autorizado && r.user).toBe(admin);
  });

  it("a regra de admin não mudou: é a claim app_metadata.role", () => {
    expect(isAdminUser({ app_metadata: { role: "admin" } })).toBe(true);
    expect(isAdminUser({ app_metadata: { role: "participant" } })).toBe(false);
    expect(isAdminUser({ app_metadata: {} })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
});

describe("controle positivo da recusa: participante é recusado por PERMISSÃO", () => {
  it("sessão válida sem o papel é ADMIN_FORBIDDEN (403), não indisponibilidade", async () => {
    const r = await verificarAdminCom(clienteQue({ data: { user: participante }, error: null }));
    expect(r.autorizado).toBe(false);
    expect(!r.autorizado && r.codigo).toBe("ADMIN_FORBIDDEN");
    expect(DEFINICOES_DE_ERRO.ADMIN_FORBIDDEN.status).toBe(403);
    expect(foiVerificado(r)).toBe(true);
  });

  it("sem usuário e sem erro é AUTH_REQUIRED (401): o serviço respondeu 'não há sessão'", async () => {
    const r = await verificarAdminCom(clienteQue({ data: { user: null }, error: null }));
    expect(!r.autorizado && r.codigo).toBe("AUTH_REQUIRED");
    expect(DEFINICOES_DE_ERRO.AUTH_REQUIRED.status).toBe(401);
    expect(foiVerificado(r)).toBe(true);
  });
});

describe("terceiro desfecho: não foi possível verificar", () => {
  it.each(FALHAS)("$nome -> $esperado", async ({ erro, esperado }) => {
    expect(classificarFalhaDeAuth(erro).autorizado).toBe(false);
    const direto = classificarFalhaDeAuth(erro);
    expect(!direto.autorizado && direto.codigo).toBe(esperado);

    // Mesmo desfecho pelo caminho completo, com o erro vindo do cliente.
    const viaCliente = await verificarAdminCom(clienteQue({ data: { user: null }, error: erro }));
    expect(!viaCliente.autorizado && viaCliente.codigo).toBe(esperado);
  });

  it("AUTH_UNAVAILABLE é 503, e é um status DIFERENTE do de permissão", () => {
    expect(DEFINICOES_DE_ERRO.AUTH_UNAVAILABLE.status).toBe(503);
    expect(DEFINICOES_DE_ERRO.AUTH_UNAVAILABLE.status).not.toBe(
      DEFINICOES_DE_ERRO.ADMIN_FORBIDDEN.status
    );
    expect(DEFINICOES_DE_ERRO.AUTH_UNAVAILABLE.status).not.toBe(
      DEFINICOES_DE_ERRO.AUTH_REQUIRED.status
    );
  });

  it("exceção ao falar com o serviço não vira recusa de permissão", async () => {
    const r = await verificarAdminCom(clienteQueExplode(new TypeError("fetch failed")));
    expect(!r.autorizado && r.codigo).toBe("AUTH_UNAVAILABLE");
    expect(foiVerificado(r)).toBe(false);
  });

  it("resposta em formato inesperado é indisponibilidade, não recusa", async () => {
    for (const resposta of [undefined, null, "nada", 42, {}, { data: null, error: null }]) {
      const r = await verificarAdminCom(clienteQue(resposta));
      expect(!r.autorizado && r.codigo).toBe("AUTH_UNAVAILABLE");
    }
  });

  it("usuário sem `id` não é tratado como sessão válida nem como falta de papel", async () => {
    const r = await verificarAdminCom(clienteQue({ data: { user: { app_metadata: { role: "admin" } } }, error: null }));
    expect(!r.autorizado && r.codigo).toBe("AUTH_UNAVAILABLE");
  });
});

describe("indisponibilidade BLOQUEIA (não é brecha)", () => {
  it("nenhuma resposta anômala produz `autorizado: true`", async () => {
    const respostasQueNaoPodemPassar: unknown[] = [
      undefined,
      null,
      {},
      { data: null, error: null },
      { data: {}, error: null },
      { data: { user: null }, error: null },
      { data: { user: participante }, error: null },
      // O caso perigoso: erro JUNTO com um usuário admin no corpo. Houve erro,
      // então não foi verificado -- a presença do usuário não vale como prova.
      { data: { user: admin }, error: { name: "AuthRetryableFetchError", status: 0 } },
      { data: { user: admin }, error: { name: "AuthApiError", status: 503 } },
      // Resposta forjada que tenta se declarar autorizada: o veredito não é lido
      // do corpo, é derivado de `data.user` + a claim.
      { autorizado: true, user: admin },
      { autorizado: true, codigo: "AUTH_UNAVAILABLE" },
      { data: { user: { id: "x", app_metadata: { role: "admin " } } }, error: null },
      { data: { user: { id: "x", app_metadata: { role: "ADMIN" } } }, error: null },
      { data: { user: { id: "x", app_metadata: { role: ["admin"] } } }, error: null },
    ];
    for (const resposta of respostasQueNaoPodemPassar) {
      const r = await verificarAdminCom(clienteQue(resposta));
      expect(r.autorizado, `passou indevidamente: ${JSON.stringify(resposta)}`).toBe(false);
    }
    // ... e o cliente que explode também não passa.
    expect((await verificarAdminCom(clienteQueExplode(new Error("x")))).autorizado).toBe(false);
  });

  it("todo desfecho de indisponibilidade tem status >= 500 (bloqueia e pede retry)", () => {
    for (const { erro } of FALHAS) {
      const r = classificarFalhaDeAuth(erro);
      if (!r.autorizado && r.codigo === "AUTH_UNAVAILABLE") {
        expect(DEFINICOES_DE_ERRO[r.codigo].status).toBeGreaterThanOrEqual(500);
      }
    }
  });
});

describe("nada do GoTrue vaza na causa", () => {
  it("a causa carrega nome/status/código e NUNCA a message do serviço", async () => {
    const erro: ErroDeAuthObservado = {
      name: "AuthApiError",
      status: 503,
      code: "over_request_rate_limit",
      message: "upstream connect error or disconnect/reset before headers: connection refused to db:5432",
    };
    const r = await verificarAdminCom(clienteQue({ data: { user: null }, error: erro }));
    expect(r.autorizado).toBe(false);
    const causa = !r.autorizado ? r.causa : "";
    expect(causa).toBe("AuthApiError status=503 code=over_request_rate_limit");
    expect(causa).not.toContain(erro.message);
    expect(causa).not.toMatch(/db:5432|connection refused|upstream/i);
  });

  it("nenhuma causa de nenhuma falha contém a message observada", async () => {
    for (const { erro } of FALHAS) {
      const r = classificarFalhaDeAuth(erro);
      const causa = !r.autorizado ? r.causa : "";
      if (erro.message) expect(causa).not.toContain(erro.message);
    }
  });

  it("exceção: só o nome da classe do erro, não a mensagem", async () => {
    const r = await verificarAdminCom(clienteQueExplode(new TypeError("connect ECONNREFUSED 127.0.0.1:54731")));
    const causa = !r.autorizado ? r.causa : "";
    expect(causa).toContain("TypeError");
    expect(causa).not.toContain("ECONNREFUSED");
    expect(causa).not.toContain("54731");
  });
});

// DERIVA: não há mais o que guardar. `lib/erros/diagnostico-auth.ts`, a segunda
// implementação de classificarFalhaDeAuth que existia só porque `getAdminUser()`
// descartava o erro, foi ELIMINADA quando as rotas de processamento e de status
// migraram para `verificarAdmin()`. Uma única implementação não tem como divergir
// de si mesma; um teste de deriva só tem sentido enquanto houver duas cópias.
