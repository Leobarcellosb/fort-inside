#!/usr/bin/env node
// SMOKE TEST DO APP PUBLICADO, SO LEITURA (CTO, Rodada 86).
//
// Para rodar logo depois de uma publicacao:
//   node scripts/smoke-publicado.mjs https://marcozero-gp.vercel.app --commit <sha>
//
// O que ele prova: o app responde, o login existe, o formulario diz que o prazo
// terminou, as paginas do admin mandam para o login sem mostrar dado, e link de
// documento invalido ou inexistente da 404.
//
// O que ele NAO prova: que o administrador consegue entrar e operar. Uma pagina
// protegida respondendo nao e acesso validado; isso e a camada manual, feita
// por uma pessoa com login (ver docs/LEIA-AO-ACORDAR.md).
//
// Regras: so GET, sem cookie, sem credencial, sem chamada paga, sem token de
// documento real (os tokens abaixo sao inventados). Nenhuma requisicao muda nada.

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "https://marcozero-gp.vercel.app").replace(/\/$/, "");
const iCommit = args.indexOf("--commit");
const commit = iCommit >= 0 ? args[iCommit + 1] : "(nao informado)";
const codigoDoEvento = process.env.CODIGO_DO_EVENTO ?? "MARCOZERO";

// Tokens inventados: formato valido que nao existe, e formato invalido.
const TOKEN_INEXISTENTE = "00000000-0000-4000-8000-000000000000";
const TOKEN_INVALIDO = "nao-e-um-token";

async function get(caminho) {
  const res = await fetch(base + caminho, { redirect: "manual", headers: { "user-agent": "smoke-publicado" } });
  const corpo = res.status >= 300 && res.status < 400 ? "" : await res.text();
  return { status: res.status, destino: res.headers.get("location") ?? "", corpo, vercelId: res.headers.get("x-vercel-id") ?? "" };
}

function textoVisivel(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const verificacoes = [
  {
    nome: "Login do admin abre",
    caminho: "/admin/login",
    ok: (r) => r.status === 200 && textoVisivel(r.corpo).includes("Entrar"),
    esperado: "200 com o botao Entrar",
  },
  {
    nome: "Lista de eventos sem sessao vai para o login",
    caminho: "/admin/events",
    ok: (r) => [302, 303, 307, 308].includes(r.status) && r.destino.includes("/admin/login"),
    esperado: "redirect para /admin/login",
  },
  {
    nome: "Pesquisa de satisfacao sem sessao vai para o login",
    caminho: "/admin/nps",
    ok: (r) => [302, 303, 307, 308].includes(r.status) && r.destino.includes("/admin/login"),
    esperado: "redirect para /admin/login",
  },
  {
    nome: "Formulario publico diz que o prazo terminou",
    caminho: `/formulario/${codigoDoEvento}`,
    ok: (r) => r.status === 200 && textoVisivel(r.corpo).includes("Prazo encerrado"),
    esperado: "200 com 'Prazo encerrado'",
  },
  {
    nome: "Documento com token inexistente da 404",
    caminho: `/prognostic/${TOKEN_INEXISTENTE}`,
    ok: (r) => r.status === 404,
    esperado: "404",
  },
  {
    nome: "Documento com token invalido da 404",
    caminho: `/prognostic/${TOKEN_INVALIDO}`,
    ok: (r) => r.status === 404,
    esperado: "404",
  },
  {
    nome: "Teste da IA nao aceita GET (so POST de admin)",
    caminho: "/api/marco-zero/teste-ia",
    ok: (r) => r.status === 405,
    esperado: "405, sem chamar a IA",
  },
];

const inicio = new Date();
console.log(`Smoke test do app publicado (so leitura)`);
console.log(`Ambiente: ${base}`);
console.log(`Commit informado: ${commit}`);
console.log(`Inicio: ${inicio.toISOString()}\n`);

let falhas = 0;
let vercelId = "";
for (const v of verificacoes) {
  let linha;
  try {
    const r = await get(v.caminho);
    vercelId ||= r.vercelId;
    const passou = v.ok(r);
    if (!passou) falhas += 1;
    const visto = r.destino ? `${r.status} -> ${r.destino}` : String(r.status);
    linha = `${passou ? "OK   " : "FALHA"}  ${v.nome}  [${v.caminho}]  visto: ${visto}${passou ? "" : `  esperado: ${v.esperado}`}`;
  } catch (e) {
    falhas += 1;
    linha = `FALHA  ${v.nome}  [${v.caminho}]  erro de rede: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(linha);
}

console.log(`\nResultado: ${verificacoes.length - falhas} de ${verificacoes.length} OK${vercelId ? `  (x-vercel-id ${vercelId})` : ""}`);
console.log(
  falhas === 0
    ? "Camada automatica aprovada. Falta a camada manual: um administrador entra, abre o Marco Zero, ve os passos, a revisao e as ferramentas."
    : "Camada automatica REPROVADA. Nao siga para a operacao; compare com a versao anterior e decida se volta.",
);
process.exit(falhas === 0 ? 0 : 1);
