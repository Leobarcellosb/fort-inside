// PROVA DA ROTA DO CADERNO DE CONDUCAO: o handler DE VERDADE
// (app/api/marco-zero/caderno-de-conducao/route.ts), com `verificarAdmin()` de
// verdade, e com o montador de verdade.
//
// POR QUE ESTA PROVA NAO PRECISA DE POSTGRES, ao contrario da prova da rota
// irma do Guia: a rota do Caderno NAO LE BANCO. Isso nao e conveniencia de
// teste, e a propriedade central do artefato -- o Caderno existe para o cenario
// em que NENHUM participante respondeu o questionario, e um artefato que
// precisasse do banco para sair nao atenderia esse cenario. Esta prova e o lugar
// onde isso e medido, e por isso ela roda no `npx vitest run` de sempre.
//
// SIMULADO: so o SERVICO DE LOGIN (`auth.getUser`), que e justamente o que se
// quer variar para dizer quem esta batendo na porta.
// REAL: o handler POST, `verificarAdmin()`, `respostaDeRecusa`, a tabela de
// status de `lib/erros/codigos.ts`, a entrada estatica e o montador.
//
// CADA NEGATIVA COM CONTROLE POSITIVO: o admin passa NO MESMO AMBIENTE em que o
// anonimo, o participante e o login fora do ar foram recusados -- sem isso, uma
// negativa poderia vir de qualquer outra coisa quebrada.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RAIZ = join(__dirname, "..", "..");

// --- o servico de login, a unica coisa simulada -----------------------------

let getUser: () => Promise<{ data?: { user?: unknown } | null; error?: unknown }>;

vi.mock("../supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => getUser() } }),
}));

// --- a prova de que nada aqui abre cliente de banco -------------------------
// Se a rota chamasse `createAdminClient()`, este mock LANCARIA e o cenario do
// admin cairia em 500. Ele passa porque ninguem o chama.

let tocouOBanco = false;
vi.mock("../supabase/admin", () => ({
  createAdminClient: () => {
    tocouOBanco = true;
    throw new Error("o Caderno de Condução não pode abrir cliente de banco");
  },
}));

async function chamar() {
  const m = await import("../../app/api/marco-zero/caderno-de-conducao/route");
  return m.POST();
}

const ADMIN = { id: "u-admin", app_metadata: { role: "admin" } };
const PARTICIPANTE = { id: "u-participante", app_metadata: { role: "participant" } };

function erroDeAuth(name: string, status?: number) {
  const e = new Error("simulado");
  e.name = name;
  if (status !== undefined) (e as Error & { status?: number }).status = status;
  return e;
}

beforeEach(() => {
  tocouOBanco = false;
  getUser = async () => ({ data: { user: ADMIN } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("negativa de autorização, com controle positivo", () => {
  it("ANÔNIMO (o serviço respondeu que não há sessão) -> 401 AUTH_REQUIRED", async () => {
    getUser = async () => ({ data: null, error: erroDeAuth("AuthSessionMissingError") });
    const res = await chamar();
    expect(res.status).toBe(401);
    const corpo = await res.json();
    expect(corpo.code).toBe("AUTH_REQUIRED");
    expect(corpo.texto).toBeUndefined();
    expect(corpo.ok).toBeUndefined();
  });

  it("PARTICIPANTE (sessão válida, sem o papel) -> 403 ADMIN_FORBIDDEN", async () => {
    getUser = async () => ({ data: { user: PARTICIPANTE } });
    const res = await chamar();
    expect(res.status).toBe(403);
    const corpo = await res.json();
    expect(corpo.code).toBe("ADMIN_FORBIDDEN");
    expect(corpo.texto).toBeUndefined();
  });

  it("LOGIN FORA DO AR -> 503 AUTH_UNAVAILABLE, e NÃO 403: não é falta de permissão", async () => {
    getUser = async () => ({ data: null, error: erroDeAuth("AuthRetryableFetchError") });
    const res = await chamar();
    expect(res.status).toBe(503);
    const corpo = await res.json();
    expect(corpo.code).toBe("AUTH_UNAVAILABLE");
    expect(corpo.code).not.toBe("ADMIN_FORBIDDEN");
    expect(corpo.texto).toBeUndefined();
  });

  it("EXCEÇÃO ao falar com o serviço de login -> 503, nunca entrega o Caderno", async () => {
    getUser = async () => {
      throw new Error("socket");
    };
    const res = await chamar();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("AUTH_UNAVAILABLE");
  });

  it("CONTROLE POSITIVO: ADMIN, no mesmo ambiente, recebe o Caderno", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.ok).toBe(true);
    expect(corpo.conteudo_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(corpo.texto.length).toBeGreaterThan(10_000);
    expect(corpo.momentos).toHaveLength(8);
    expect(corpo.lacunas.length).toBeGreaterThan(0);
  });
});

describe("o Caderno sai com ZERO resposta no banco", () => {
  it("nenhum cliente de banco é aberto, e o Caderno sai igual", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(tocouOBanco, "a rota abriu cliente de banco").toBe(false);
  });

  it("sai com a configuração de banco AUSENTE do ambiente", async () => {
    // Sem URL e sem chave: nenhuma leitura seria possível nem se fosse tentada.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.ok).toBe(true);
    expect(tocouOBanco).toBe(false);

    // E o conteúdo é EXATAMENTE o do montador puro: nada veio de fora.
    const { cadernoDeConducao } = await import("./caderno-de-conducao");
    expect(corpo.conteudo_sha256).toBe(cadernoDeConducao().conteudoSha256);
    expect(corpo.texto).toBe(cadernoDeConducao().texto);
  });

  it("o corpo da resposta não carrega nada sobre pessoa alguma", async () => {
    const corpo = await (await chamar()).json();
    expect(Object.keys(corpo).sort()).toEqual([
      "contagem",
      "conteudo_sha256",
      "html",
      "lacunas",
      "momentos",
      "ok",
      "texto",
      "versao",
    ]);
    // O texto do Caderno não nomeia participante, e-mail nem identificador.
    expect(corpo.texto).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(corpo.texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });

  it("a rota NÃO menciona banco, resposta, participante nem o gerador do Guia", () => {
    const fonte = readFileSync(
      join(RAIZ, "app", "api", "marco-zero", "caderno-de-conducao", "route.ts"),
      "utf8",
    );
    // O cabeçalho da rota CITA a rota irmã para explicar a diferença; o que não
    // pode existir é chamada. Conferimos as chamadas, não as menções do comentário.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const proibido of [
      "createAdminClient",
      "createClient",
      "prepararEntradaDoGuia",
      "gerarGuiaDoFacilitador",
      "quiz_responses",
      "participants",
      "event_id",
      ".from(",
      ".rpc(",
    ]) {
      expect(codigo, `a rota chama/menciona ${proibido}`).not.toContain(proibido);
    }
  });
});
