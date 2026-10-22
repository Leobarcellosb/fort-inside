import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Os três desfechos NAS PÁGINAS, exercitando a função `proxy` de verdade.
//
// O cliente do Supabase é o único ponto trocado: `createServerClient` é
// substituído por um cliente cujo `auth.getUser()` devolve o que cada cenário
// precisa. A decisão, o redirect, a 503 e os cabeçalhos são os do arquivo.

const respostaDeGetUser = { valor: undefined as unknown };

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => respostaDeGetUser.valor },
  }),
}));

const { proxy, config } = await import("./proxy");

const admin = { id: "11111111-1111-4111-8111-111111111111", app_metadata: { role: "admin" } };
const participante = { id: "22222222-2222-4222-8222-222222222222", app_metadata: { role: "participant" } };

const pede = (caminho: string) => proxy(new NextRequest(new URL(caminho, "http://localhost:3000")));

const PAGINAS_ADMIN = [
  "/admin",
  "/admin/events",
  "/admin/events/new",
  "/admin/nps",
  "/admin/settings",
  "/admin/events/9f1b0c3e-0000-4000-8000-000000000001",
  "/admin/events/9f1b0c3e-0000-4000-8000-000000000001/dashboard",
];

const ENGASGOS_DO_GOTRUE: { nome: string; resposta: unknown }[] = [
  { nome: "rede caída", resposta: { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } } },
  { nome: "502 do gateway", resposta: { data: { user: null }, error: { name: "AuthApiError", status: 502, message: "Bad Gateway" } } },
  { nome: "503 do GoTrue", resposta: { data: { user: null }, error: { name: "AuthApiError", status: 503, message: "upstream connect error" } } },
  { nome: "504 (timeout)", resposta: { data: { user: null }, error: { name: "AuthApiError", status: 504, message: "gateway timeout" } } },
  { nome: "resposta em formato inesperado", resposta: { data: null, error: null } },
  // O caso perigoso: houve erro, mas veio um admin no corpo. Não foi verificado.
  { nome: "erro COM admin no corpo", resposta: { data: { user: admin }, error: { name: "AuthRetryableFetchError", status: 0 } } },
];

const eRedirectLogin = (r: Response) =>
  [301, 302, 303, 307, 308].includes(r.status) &&
  new URL(r.headers.get("location")!, "http://localhost:3000").pathname === "/admin/login";

beforeEach(() => {
  respostaDeGetUser.valor = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("o matcher continua certo", () => {
  it("o export chama-se `config` (com `proxyConfig` o Next ignora o matcher em silêncio)", () => {
    expect(config.matcher).toEqual(["/admin/:path*"]);
  });

  it("/admin/login não é protegido (senão não há como entrar)", async () => {
    respostaDeGetUser.valor = { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } };
    const r = await pede("/admin/login");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-codigo-erro")).toBeNull();
  });
});

describe("CONTROLE POSITIVO: o admin de verdade continua passando", () => {
  it.each(PAGINAS_ADMIN)("admin alcança %s", async (caminho) => {
    respostaDeGetUser.valor = { data: { user: admin }, error: null };
    const r = await pede(caminho);
    expect(r.status).toBe(200);
    expect(eRedirectLogin(r)).toBe(false);
    expect(r.headers.get("x-codigo-erro")).toBeNull();
  });
});

describe("CONTROLE POSITIVO da recusa: participante continua sendo barrado", () => {
  it.each(PAGINAS_ADMIN)("participante autenticado não alcança %s", async (caminho) => {
    respostaDeGetUser.valor = { data: { user: participante }, error: null };
    const r = await pede(caminho);
    expect(eRedirectLogin(r)).toBe(true);
    expect(r.status).not.toBe(200);
    // Permanece redirect, como a suíte de segurança HTTP já exige: a recusa por
    // falta de papel NÃO foi transformada em página de indisponibilidade.
    expect(r.headers.get("x-codigo-erro")).toBeNull();
    expect(new URL(r.headers.get("location")!).searchParams.get("next")).toBe(caminho);
  });

  it("anônimo (sem sessão) também vai para o login, com `next` preservado", async () => {
    respostaDeGetUser.valor = { data: { user: null }, error: null };
    const r = await pede("/admin/events");
    expect(eRedirectLogin(r)).toBe(true);
    expect(new URL(r.headers.get("location")!).searchParams.get("next")).toBe("/admin/events");
  });

  it("sessão expirada (401 do serviço) vai para o login: aí entrar de novo RESOLVE", async () => {
    respostaDeGetUser.valor = { data: { user: null }, error: { name: "AuthApiError", status: 401, code: "bad_jwt" } };
    expect(eRedirectLogin(await pede("/admin/events"))).toBe(true);
  });
});

describe("GoTrue indisponível: 503 explicativa, NÃO redirect mudo para o login", () => {
  it.each(ENGASGOS_DO_GOTRUE)("$nome -> 503 distinguível", async ({ resposta }) => {
    respostaDeGetUser.valor = resposta;
    const r = await pede("/admin/events");

    // Não é redirect: o host não é mandado para o login sem explicação.
    expect(eRedirectLogin(r)).toBe(false);
    expect([301, 302, 303, 307, 308]).not.toContain(r.status);
    expect(r.headers.get("location")).toBeNull();

    // É indisponibilidade, e o status não é o de permissão.
    expect(r.status).toBe(503);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
    expect(r.headers.get("x-codigo-erro")).toBe("AUTH_UNAVAILABLE");
    expect(r.headers.get("retry-after")).toBe("5");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-ocorrencia")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("a página diz o que aconteceu, que não é falta de permissão, e traz a ocorrência", async () => {
    respostaDeGetUser.valor = { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } };
    const r = await pede("/admin/events/abc/dashboard");
    const html = await r.text();

    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(html).toContain("Não foi possível verificar sua sessão");
    expect(html).toContain("o serviço de login não respondeu");
    expect(html).toContain("não</strong> perdeu o acesso");
    expect(html).toContain("Entrar de novo não resolve este caso");
    // Caminho de volta: tentar de novo no MESMO destino, por escolha do host.
    expect(html).toContain('href="/admin/events/abc/dashboard"');
    // A ocorrência que está no log do servidor é a que o host lê na tela.
    expect(html).toContain(r.headers.get("x-ocorrencia")!);
  });

  it("o host NÃO lê 'não autorizado' nem a mensagem interna do GoTrue", async () => {
    respostaDeGetUser.valor = {
      data: { user: null },
      error: {
        name: "AuthApiError",
        status: 503,
        code: "service_unavailable",
        message: "upstream connect error or disconnect/reset before headers: connection refused to db:5432",
      },
    };
    const r = await pede("/admin/events");
    const html = await r.text();

    expect(html).not.toMatch(/não autorizado/i);
    expect(html).not.toMatch(/sem permissão|forbidden/i);
    expect(html).not.toMatch(/upstream|connection refused|db:5432|AuthApiError|GoTrue/i);
    expect(html).not.toMatch(/service_unavailable/);
    // E o identificador foi para o log do servidor, junto do código e da causa.
    const chamadas = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const registro = chamadas.at(-1)![1] as Record<string, string>;
    expect(registro.ocorrencia).toBe(r.headers.get("x-ocorrencia"));
    expect(registro.codigo).toBe("AUTH_UNAVAILABLE");
    expect(registro.causa).toBe("AuthApiError status=503 code=service_unavailable");
    expect(registro.causa).not.toContain("db:5432");
  });
});

describe("indisponibilidade BLOQUEIA: ninguém atravessa por esse caminho", () => {
  it.each(ENGASGOS_DO_GOTRUE)("$nome: nenhuma página de /admin/* é servida", async ({ resposta }) => {
    respostaDeGetUser.valor = resposta;
    for (const caminho of PAGINAS_ADMIN) {
      const r = await pede(caminho);
      expect(r.status, `${caminho} foi servida`).toBe(503);
      // `x-middleware-next` é o que o Next lê para deixar o request seguir para a
      // página. A 503 não o tem: a renderização nunca é alcançada.
      expect(r.headers.get("x-middleware-next"), `${caminho} seguiu para a página`).toBeNull();
      expect(r.headers.get("x-middleware-rewrite"), `${caminho} foi reescrita`).toBeNull();
    }
  });

  it("o caminho de 'indisponível' não pode ser escolhido pelo pedido", async () => {
    // Um atacante controla URL, query, cabeçalhos e cookies -- nada disso entra na
    // decisão. Com o serviço respondendo normalmente, um participante continua
    // sendo barrado por mais que tente se declarar indisponível ou admin.
    respostaDeGetUser.valor = { data: { user: participante }, error: null };
    const tentativas = [
      "/admin/events?code=AUTH_UNAVAILABLE",
      "/admin/events?x-codigo-erro=AUTH_UNAVAILABLE",
      "/admin/nps?role=admin",
      "/admin/settings?next=/admin/nps",
    ];
    for (const caminho of tentativas) {
      const r = await pede(caminho);
      expect(r.status, caminho).not.toBe(200);
      expect(eRedirectLogin(r), caminho).toBe(true);
    }

    const comCabecalhos = await proxy(
      new NextRequest(new URL("/admin/nps", "http://localhost:3000"), {
        headers: {
          "x-codigo-erro": "AUTH_UNAVAILABLE",
          "x-forwarded-for": "127.0.0.1",
          cookie: "sb-access-token=forjado; role=admin",
          authorization: "Bearer forjado",
        },
      })
    );
    expect(comCabecalhos.status).not.toBe(200);
    expect(eRedirectLogin(comCabecalhos)).toBe(true);
  });

  it("com o serviço fora, nem quem TEM a claim passa (a verificação é que falhou)", async () => {
    respostaDeGetUser.valor = { data: { user: admin }, error: { name: "AuthRetryableFetchError", status: 0 } };
    const r = await pede("/admin/nps");
    expect(r.status).toBe(503);
    expect(r.headers.get("x-middleware-next")).toBeNull();
  });
});
