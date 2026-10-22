// Fachada /rest/v1 -> PostgREST, para o stack DESCARTAVEL desta prova.
//
// POR QUE ELE EXISTE
// ------------------
// Os modulos de producao falam com o banco por `@supabase/supabase-js`, que
// monta as URLs como `<SUPABASE_URL>/rest/v1/<tabela>` e
// `<SUPABASE_URL>/rest/v1/rpc/<funcao>`. No stack de verdade quem corta esse
// prefixo e o Kong. Esta prova nao sobe Kong (nem GoTrue): sobe Postgres
// descartavel + PostgREST, e este processo faz o unico papel do Kong que o
// caminho sob teste usa -- tirar o prefixo /rest/v1 e repassar.
//
// O QUE ELE NAO FAZ, DE PROPOSITO
// -------------------------------
// - Nao emite token: /auth/v1/* responde 501. Os JWT desta prova sao assinados
//   no proprio teste com o segredo do PostgREST. Ou seja: a EMISSAO de sessao
//   (GoTrue) nao e exercitada aqui; a VERIFICACAO do token e a RLS que ele
//   ativa sao, porque e o PostgREST de verdade que valida e e o Postgres de
//   verdade que aplica a policy.
// - Nao autentica nada por conta propria: o cabecalho `apikey` e ignorado, como
//   o PostgREST ja o ignora. Quem decide e o `Authorization: Bearer`.
// - Nao reescreve corpo nem status: o que o PostgREST responde chega cru ao
//   cliente, para que a prova meca a recusa do banco e nao a deste proxy.
//
// Uso: node proxy-supabase.mjs <url-do-postgrest> <arquivo-onde-gravar-a-porta>

import http from "node:http";
import { writeFileSync } from "node:fs";

const [, , ALVO, ARQUIVO_PORTA] = process.argv;
if (!ALVO || !ARQUIVO_PORTA) {
  console.error("uso: proxy-supabase.mjs <url-do-postgrest> <arquivo-porta>");
  process.exit(2);
}

// Cinto de seguranca: este processo so fala com PostgREST local. Se alguem
// apontar o alvo para fora, ele recusa subir em vez de virar um tunel.
const alvo = new URL(ALVO);
if (alvo.hostname !== "127.0.0.1" && alvo.hostname !== "localhost") {
  console.error(`proxy: alvo nao e local (${ALVO}); recuso subir.`);
  process.exit(2);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname.startsWith("/auth/v1/")) {
    // Declarado, nao simulado: esta prova nao tem GoTrue.
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "sem GoTrue nesta prova: o JWT e assinado no teste" }));
    return;
  }

  if (!url.pathname.startsWith("/rest/v1")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `fora do escopo do proxy: ${url.pathname}` }));
    return;
  }

  const corpo = [];
  for await (const pedaco of req) corpo.push(pedaco);

  const caminho = url.pathname.slice("/rest/v1".length) || "/";
  const destino = new URL(caminho + url.search, alvo);

  // Repassa os cabecalhos como vieram, menos os de conexao/host, que pertencem
  // a este salto e nao ao de cima.
  const cabecalhos = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length"].includes(k.toLowerCase())) continue;
    cabecalhos[k] = v;
  }

  try {
    const r = await fetch(destino, {
      method: req.method,
      headers: cabecalhos,
      body: corpo.length ? Buffer.concat(corpo) : undefined,
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    const saida = {};
    r.headers.forEach((v, k) => {
      if (["content-encoding", "transfer-encoding", "connection"].includes(k)) return;
      saida[k] = v;
    });
    res.writeHead(r.status, saida);
    res.end(bytes);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `proxy nao alcancou o PostgREST: ${err?.message ?? err}` }));
  }
});

servidor.listen(0, "127.0.0.1", () => {
  writeFileSync(ARQUIVO_PORTA, String(servidor.address().port));
});
