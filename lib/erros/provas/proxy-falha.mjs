// GATEWAY DE TESTE entre o app sob teste e o stack DESCARTAVEL (Postgres + PostgREST
// em containers proprios), com falha sob demanda.
//
// Faz o papel do Kong do Supabase local, e nada alem:
//   /rest/v1/*  -> PostgREST descartavel (sem o prefixo /rest/v1)
//   /auth/v1/*  -> servico de identidade SIMULADO (so GET /user e /health): valida a
//                  assinatura HS256 do JWT e devolve o usuario do proprio token. NAO e o
//                  GoTrue. A classificacao AUTH_REQUIRED/ADMIN_FORBIDDEN/AUTH_UNAVAILABLE
//                  ja foi provada contra o GoTrue real em rodadas anteriores; aqui o
//                  foco e o banco, e o stack nao pode escrever no banco compartilhado.
//
// Falhas ligadas/desligadas por /__falha (o MESMO app, no MESMO banco, e medido com a
// falha ligada e desligada):
//   - 503 injetado: auth, quiz_stages, participants, rpc_enfileirar, rpc_resumo,
//     leitura_jobs, relogio_banco, rpc_iniciar;
//   - AUSENCIA real, sem DDL: o gateway reescreve o caminho para um nome que NAO existe e
//     quem responde e o PostgREST de verdade (PGRST202 funcao / PGRST205 tabela);
//   - evento_sem_modo: o PostgREST responde o evento SEM a coluna `mode`.
//
// Conexao ate o upstream que cai antes de responder e repetida (o corpo esta em
// memoria); o que for injetado de proposito nunca passa por essa repeticao.
//
// Uso: node proxy-falha.mjs <url-do-postgrest> <segredo-jwt> <arquivo-onde-gravar-a-porta>
import http from "node:http";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

const [, , upstreamBruto, segredo, arquivoPorta] = process.argv;
const upstream = new URL(upstreamBruto);
if (!["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)) {
  console.error(`proxy-falha: upstream ${upstream.hostname} nao e local; recusado.`);
  process.exit(2);
}

const agente = new http.Agent({ keepAlive: false });

const falhas = {
  auth: false, quiz_stages: false, participants: false, rpc_enfileirar: false,
  rpc_resumo: false, leitura_jobs: false, relogio_banco: false, rpc_iniciar: false,
  evento_sem_modo: false,
  rpc_enfileirar_ausente: false, rpc_resumo_ausente: false, tabela_jobs_ausente: false, relogio_ausente: false,
};
const contagem = Object.fromEntries(Object.keys(falhas).map((k) => [k, 0]));

const REESCRITAS = {
  rpc_enfileirar_ausente: ["POST", "/rest/v1/rpc/jobs_enfileirar"],
  rpc_resumo_ausente: ["POST", "/rest/v1/rpc/jobs_resumo_evento"],
  tabela_jobs_ausente: ["GET", "/rest/v1/jobs"],
  relogio_ausente: ["POST", "/rest/v1/rpc/referencia_temporal_do_banco"],
};

function qualFalha(metodo, caminho) {
  if (caminho.startsWith("/auth/v1/")) return "auth";
  if (caminho.startsWith("/rest/v1/quiz_stages")) return "quiz_stages";
  if (caminho.startsWith("/rest/v1/participants")) return "participants";
  if (metodo === "POST" && caminho.startsWith("/rest/v1/rpc/jobs_enfileirar")) return "rpc_enfileirar";
  if (metodo === "POST" && caminho.startsWith("/rest/v1/rpc/jobs_resumo_evento")) return "rpc_resumo";
  if (metodo === "POST" && caminho.startsWith("/rest/v1/rpc/referencia_temporal_do_banco")) return "relogio_banco";
  if (metodo === "POST" && caminho.startsWith("/rest/v1/rpc/jobs_iniciar_assincrono")) return "rpc_iniciar";
  if (metodo === "GET" && caminho === "/rest/v1/jobs") return "leitura_jobs";
  return null;
}

// ---- identidade simulada -------------------------------------------------
function verificaJwt(token) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const esperado = crypto.createHmac("sha256", segredo).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(esperado);
  const b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function identidade(req, res) {
  const url = new URL(req.url, "http://gateway.local");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/auth/v1/health") return void res.end(JSON.stringify({ name: "GoTrue-simulado", status: "ok" }));
  if (url.pathname === "/auth/v1/user" && req.method === "GET") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
    const claims = token ? verificaJwt(token) : null;
    if (!claims || !claims.sub) {
      res.statusCode = 401;
      return void res.end(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }));
    }
    return void res.end(
      JSON.stringify({
        id: claims.sub, aud: "authenticated", role: claims.role ?? "authenticated", email: claims.email ?? null,
        app_metadata: claims.app_metadata ?? {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z",
      })
    );
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ msg: "nao simulado" }));
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gateway.local");

  if (url.pathname === "/__falha") {
    if (req.method === "POST") {
      let corpo = "";
      req.on("data", (c) => (corpo += c));
      req.on("end", () => {
        const novo = JSON.parse(corpo || "{}");
        for (const k of Object.keys(falhas)) if (k in novo) falhas[k] = Boolean(novo[k]);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ falhas, contagem }));
      });
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ falhas, contagem }));
    return;
  }

  const qual = qualFalha(req.method ?? "GET", url.pathname);
  if (qual && falhas[qual]) {
    contagem[qual] += 1;
    // 503 com corpo que PARECE interno de banco: se algo disto vazar ate o host, o teste enxerga.
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: `falha injetada (${qual}): connection to server lost`, code: "57P01" }));
    req.resume();
    return;
  }

  if (url.pathname.startsWith("/auth/v1/")) {
    req.resume();
    return identidade(req, res);
  }

  // ---- REST: reescritas e encaminhamento ----------------------------------
  let queryFinal = url.search;
  if (falhas.evento_sem_modo && req.method === "GET" && url.pathname === "/rest/v1/events") {
    const sel = url.searchParams.get("select") ?? "";
    if (sel.includes("form_closes_at") && sel.split(",").includes("mode")) {
      contagem.evento_sem_modo += 1;
      url.searchParams.set("select", sel.split(",").filter((c) => c.trim() !== "mode").join(","));
      queryFinal = url.search;
    }
  }
  let caminho = url.pathname;
  for (const [nome, [metodo, base]] of Object.entries(REESCRITAS)) {
    if (falhas[nome] && req.method === metodo && url.pathname === base) {
      contagem[nome] += 1;
      caminho = `${base}__ausente`;
    }
  }
  // O PostgREST sozinho serve na raiz; o prefixo /rest/v1 era do Kong.
  const caminhoUpstream = `${caminho.replace(/^\/rest\/v1/, "") || "/"}${queryFinal}`;

  const cabecalhos = { ...req.headers, host: `${upstream.hostname}:${upstream.port}`, connection: "close" };
  delete cabecalhos["transfer-encoding"];
  const inicio = Date.now();
  const pedacos = [];
  req.on("data", (c) => pedacos.push(c));
  req.on("end", () => {
    const corpo = Buffer.concat(pedacos);
    const tenta = (n) => {
      const saida = http.request(
        {
          hostname: upstream.hostname, port: upstream.port, path: caminhoUpstream, method: req.method,
          headers: { ...cabecalhos, "content-length": String(corpo.length) }, agent: agente,
        },
        (resp) => {
          res.writeHead(resp.statusCode ?? 502, resp.headers);
          resp.pipe(res);
          resp.on("end", () => {
            const ms = Date.now() - inicio;
            if (ms > 1500) console.error(`[lento] ${req.method} ${url.pathname} ${resp.statusCode} ${ms}ms`);
          });
        }
      );
      saida.on("error", (e) => {
        if (n < 4 && !res.headersSent) {
          console.error(`[repete ${n + 1}] ${req.method} ${url.pathname}: ${e.message}`);
          setTimeout(() => tenta(n + 1), 400);
          return;
        }
        console.error(`[ERRO-DO-PROXY] ${req.method} ${url.pathname}: ${e.message}`);
        if (!res.headersSent) res.statusCode = 502;
        res.end(`proxy-falha: ${e.message}`);
      });
      saida.end(corpo);
    };
    tenta(0);
  });
});

servidor.listen(0, "127.0.0.1", () => {
  writeFileSync(arquivoPorta, String(servidor.address().port));
});
