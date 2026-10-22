// JORNADA COMPLETA, DE PONTA A PONTA, COM UM PARTICIPANTE DE VERDADE.
//
// NÃO rode isto direto: use `bash scripts/test-jornada.sh`. O runner sobe o app
// isolado (clone descartável, Supabase LOCAL, Anthropic substituída por um
// canário que CONTA chamadas) e só então chama este arquivo.
//
// POR QUE ESTA SUÍTE EXISTE, SE AS UNIDADES JÁ PASSAM
// ---------------------------------------------------
// As peças deste fluxo têm teste de unidade e passam isoladamente. O defeito que
// já aconteceu aqui nasceu no VÃO entre elas: duas correções individualmente
// corretas que, juntas, pararam o produto. O caso concreto: a tela grava o TEXTO
// da alternativa situacional e o motor de pontuação só aceita a LETRA. Cada lado
// está certo; a jornada é o único lugar onde o par é medido. Se a normalização da
// borda falhar, metade do instrumento de 4 eixos desaparece sem erro nenhum --
// o motor devolve `null`, trata como "não respondido" e o documento sai mais
// pobre, sem nada vermelho em nenhum log.
//
// O QUE A JORNADA PERCORRE (uma pessoa, do convite ao documento)
//   0. pré-condições (anti-falso-verde: app vivo, canário enxerga, 17 migrations)
//   1. pede o código de entrada -- e NENHUMA sessão nasce antes de verificar
//   2. obtém o código pela API admin do GoTrue (sem SMTP) e autentica
//   3. responde as 5 etapas (52 perguntas) pelo caminho REAL de gravação
//   4. conclui pelo SERVIDOR, que confere no banco
//   5. pontua o que FICOU GRAVADO e monta o briefing
//   6. enfileira e roda ticks até a fila drenar, com a Anthropic substituída
//   7. verifica o que o participante e o host recebem no fim
//
// REGRAS DE VEREDITO (as armadilhas já medidas neste projeto)
//   - Toda asserção de RECUSA tem, ao lado, no MESMO ambiente, uma asserção de
//     PERMISSÃO. "Tudo negado" não é aprovação: pode ser o ambiente negando até
//     o fluxo legítimo. Cada negativa abaixo diz qual é o seu controle positivo.
//   - Servidor fora do ar, exceção de rede, erro 5xx: FALHA, nunca aprovação.
//   - Etapa que não produziu verificação nenhuma: FALHA (lista no resumo).
//   - O que a jornada NÃO consegue percorrer porque a peça não existe é
//     declarado como PENDÊNCIA no resumo, com nome. Não se pula em silêncio.

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServerClient } from "@supabase/ssr";

const executar = promisify(execFile);

const env = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`variável obrigatória ausente: ${n}`);
  return v;
};
const APP = env("APP_URL");
const SUPA = env("SUPA_URL");
const ANON = env("ANON_KEY");
const SERVICE = env("SERVICE_KEY");
const CANARIO = env("CANARIO_URL");
const DB_URL = env("DB_URL");
const SCORING = env("SCORING_DIR");
const CRON_SECRET = env("CRON_SECRET");

// Trava de segurança: esta jornada CRIA e APAGA dados e cria identidades no
// Auth. Só roda contra banco local. Produção nunca, por nenhum atalho.
for (const [nome, url] of [["SUPA_URL", SUPA], ["DB_URL", DB_URL]]) {
  // new URL() entende tanto http:// quanto postgresql://, então o mesmo teste
  // vale para a API e para a conexão de banco.
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    console.error(`ABORTADO: ${nome} aponta para ${host}, que não é local.`);
    process.exit(2);
  }
}

// Motor de pontuação e camada de linguagem: o código de PRODUÇÃO, compilado pelo
// runner a partir do mesmo arquivo que o app sob teste carrega. Não há cópia nem
// reimplementação aqui -- sabotar lib/scoring quebra esta jornada.
const requerer = createRequire(import.meta.url);
const { achatarRespostas, extrairLetraAlternativa } = requerer(`${SCORING}/achatar-respostas.js`);
const { calcularMarcoZero, EIXOS, ELEMENTOS, SITUACIONAIS, MAPA_SITUACIONAL } = requerer(`${SCORING}/marco-zero.js`);
const {
  montarBriefingMarcoZero,
  textoDoParticipante,
  encontrarExpressoesVetadas,
} = requerer(`${SCORING}/briefing-marco-zero.js`);

const {
  LETRAS_SITUACIONAIS,
  CONTAGEM_SITUACIONAL_ESPERADA,
  EIXO_SITUACIONAL_ESPERADO,
  EIXO_LIKERT_ESPERADO,
  SOMAS_LIKERT_ESPERADAS,
  VALORES_ELEMENTOS,
  montarRespostasDaEtapa,
  problemasPelaRegraDaInterface,
} = await import("./respostas.mjs");

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MARCA = `[jornada-${RUN}]`;
const DOMINIO = "jornada.test";
const NOME_PARTICIPANTE = `Marina Alencar ${MARCA}`;

// Rótulos públicos dos eixos: este módulo de teste NÃO define metodologia, só
// injeta rótulos para o briefing poder nomear os eixos (ver OpcoesBriefing).
const ROTULOS_EIXOS = {
  visao: "Visão",
  execucao: "Execução",
  relacao: "Relação",
  integridade: "Integridade",
};

// ----------------------------------------------------------------- relatório
const resultados = [];
const pendencias = [];
const achados = [];
let etapaAtual = "0";
let contador = 0;

function registra({ ator, acao, esperado, obtido, ok }) {
  contador += 1;
  const id = `E${etapaAtual}.${String(contador).padStart(2, "0")}`;
  resultados.push({ id, etapa: etapaAtual, ok, acao });
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${id} | ator: ${ator} | ação: ${acao} | esperado: ${esperado} | obtido: ${obtido}`
  );
}
function etapa(n, titulo) {
  etapaAtual = String(n);
  contador = 0;
  console.log(`\n=== ETAPA ${n}: ${titulo}`);
}
function exige(ator, acao, esperado, ok, obtido) {
  registra({ ator, acao, esperado, obtido, ok });
}
/** Peça que não existe no produto. Declarada com nome; não é falha nem silêncio. */
function pendencia(titulo, descricao) {
  pendencias.push({ etapa: etapaAtual, titulo, descricao });
  console.log(`[PENDÊNCIA] etapa ${etapaAtual} | ${titulo} | ${descricao}`);
}
/**
 * Fato MEDIDO nesta rodada que merece decisão humana e NÃO é veredito da
 * jornada -- tipicamente porque depende da configuração do ambiente, e
 * transformá-lo em falha faria a suíte medir o ambiente em vez do código (a
 * armadilha declarada no topo). Aparece no resumo e é impossível de não ver.
 */
function achado(titulo, descricao) {
  achados.push({ etapa: etapaAtual, titulo, descricao });
  console.log(`[ACHADO] etapa ${etapaAtual} | ${titulo} | ${descricao}`);
}

// ----------------------------------------------------------------- HTTP / banco
async function http(metodo, caminho, { cookie, json, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(APP + caminho, { method: metodo, headers: h, body, redirect: "manual" });
  const texto = await res.text();
  let corpo = null;
  try {
    corpo = JSON.parse(texto);
  } catch {
    /* html ou vazio */
  }
  return {
    status: res.status,
    location: res.headers.get("location"),
    texto,
    corpo,
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
}

const svcHeaders = (extra = {}) => ({
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
  "content-type": "application/json",
  ...extra,
});

/**
 * Nova tentativa SÓ para as chamadas que o HARNESS faz por conta própria
 * (semear fixture e inspecionar o banco com service_role), e SÓ em 5xx ou
 * exceção de rede -- que no stack local são o Kong/GoTrue engasgando, não
 * comportamento do produto. Medido: uma rodada morreu na criação do usuário
 * admin com `504 The upstream server is timing out`.
 *
 * O que isto NÃO faz: nunca repete requisição do FLUXO sob teste. Lá, 5xx é
 * veredito (e falha), porque é justamente o que a jornada precisa enxergar.
 * Cada nova tentativa é ANUNCIADA: ambiente instável aparece na saída em vez de
 * ficar escondido atrás de um verde.
 */
async function comNovaTentativa(rotulo, fn) {
  let ultimo = null;
  for (let i = 1; i <= 3; i += 1) {
    try {
      const r = await fn();
      if (r.status < 500) return r;
      ultimo = `status ${r.status}`;
    } catch (e) {
      ultimo = e.message;
    }
    if (i < 3) {
      console.log(`  [aviso] ${rotulo} falhou (${ultimo}); nova tentativa ${i + 1}/3 em 1s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${rotulo} falhou 3 vezes seguidas (última: ${ultimo})`);
}

/** PostgREST com service_role: só para SEMEAR e INSPECIONAR, nunca para o fluxo. */
async function rest(metodo, caminho, corpo, extra = {}) {
  const res = await comNovaTentativa(`REST ${metodo} ${caminho}`, () =>
    fetch(`${SUPA}/rest/v1/${caminho}`, {
      method: metodo,
      headers: svcHeaders({ prefer: "return=representation", ...extra }),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    })
  );
  const txt = await res.text();
  let dados = null;
  try {
    dados = JSON.parse(txt);
  } catch {
    /* vazio */
  }
  if (!res.ok) throw new Error(`REST ${metodo} ${caminho} -> ${res.status} ${txt}`);
  return dados;
}

/**
 * PostgREST como o NAVEGADOR fala: chave anônima + JWT do usuário. É por aqui
 * que a tela do participante grava as respostas, então é por aqui que a jornada
 * grava. Devolve status e corpo sem lançar: o status é parte do que se mede.
 */
async function restComoUsuario(metodo, caminho, corpo, { token, prefer } = {}) {
  const headers = { apikey: ANON, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${SUPA}/rest/v1/${caminho}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await res.text();
  let dados = null;
  try {
    dados = JSON.parse(txt);
  } catch {
    /* vazio */
  }
  return { status: res.status, corpo: dados, texto: txt };
}

async function authAdmin(metodo, caminho, corpo) {
  const res = await comNovaTentativa(`GoTrue admin ${metodo} ${caminho}`, () =>
    fetch(`${SUPA}/auth/v1/admin/${caminho}`, {
      method: metodo,
      headers: svcHeaders(),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    })
  );
  const txt = await res.text();
  if (!res.ok) throw new Error(`GoTrue admin ${metodo} ${caminho} -> ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

/**
 * Consulta direta ao Postgres. Usada só para o que NÃO é observável por HTTP:
 * a contagem de sessões no schema `auth` e o manifesto de migrations. Falha
 * alto: `ON_ERROR_STOP=1` e exceção se o psql não existir.
 */
async function psql(sql) {
  const { stdout } = await executar(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", DB_URL, "-c", sql],
    { env: { ...process.env, PGCONNECT_TIMEOUT: "10" }, maxBuffer: 8 * 1024 * 1024 }
  );
  return stdout.trim();
}

const canario = {
  async zerar() {
    await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  },
  async detalhe() {
    return (await fetch(`${CANARIO}/__canario/contagem`)).json();
  },
  async total() {
    return (await canario.detalhe()).total;
  },
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const eRedirectLogin = (r) =>
  [301, 302, 303, 307, 308].includes(r.status) &&
  !!r.location &&
  new URL(r.location, APP).pathname === "/admin/login";

/**
 * Chamada do HOST/ADMIN feita pelo HARNESS (semear, inspecionar, acionar o
 * tick). Uma recusa que NÃO se repete depois de renovar a sessão é instabilidade
 * de ambiente; uma que se repete é veredito e chega inteira a quem chamou.
 *
 * Por que isto foi preciso: medido numa rodada, `GET /api/jobs/status` respondeu
 * 403 "Não autorizado" com a mesma sessão de admin que, um segundo antes, tinha
 * sido aceita por `POST /api/jobs/enfileirar`. A causa é que `getAdminUser()`
 * descarta o erro de `supabase.auth.getUser()`: se o GoTrue engasga, `user` vem
 * nulo e a rota responde 403 -- "não consegui verificar" vestido de "não
 * autorizado". Está registrado como ACHADO quando acontece.
 *
 * As negativas (participante, anônimo) NUNCA passam por aqui: recusa esperada
 * não se repete, mede-se de primeira.
 */
let recusasTransitorias = 0;
async function httpComoAdmin(metodo, caminho, opts = {}) {
  const r = await http(metodo, caminho, { ...opts, cookie: F.admin.cookie });
  // Em PÁGINA o mesmo engasgo aparece como redirect para o login, porque
  // proxy.ts também descarta o erro de getUser(): sem `user`, não é admin, e
  // redireciona. Mesma classe de recusa, mesmo tratamento.
  const recusou = [401, 403].includes(r.status) || r.status >= 500 || eRedirectLogin(r);
  if (!recusou) return r;

  console.log(
    `  [aviso] ${metodo} ${caminho} com a sessão de admin respondeu ${r.status}; ` +
      "renovando a sessão e tentando UMA vez"
  );
  await dormir(1000);
  Object.assign(F.admin, await sessaoPorSenha(F.admin.email, F.admin.senha));
  const segunda = await http(metodo, caminho, { ...opts, cookie: F.admin.cookie });
  if (segunda.status < 400 && !eRedirectLogin(segunda)) {
    recusasTransitorias += 1;
    if (recusasTransitorias === 1) {
      achado(
        "recusa transitória de admin: rota respondeu 403/401 e, com a sessão renovada, respondeu 2xx",
        `${metodo} ${caminho} devolveu ${r.status} e depois ${segunda.status} com a MESMA identidade. ` +
          "getAdminUser() (lib/auth/require-admin.ts) descarta o erro de supabase.auth.getUser(): " +
          "qualquer engasgo do GoTrue vira `user === null` e a rota responde 'Não autorizado'. " +
          "Para a operação, indisponibilidade de Auth fica indistinguível de falta de permissão."
      );
    }
  }
  return segunda;
}

// Chaves JSON que, em QUALQUER resposta das rotas de entrada, significam que
// voltou a sair credencial pelo corpo. Procura pela CHAVE, não por substring
// solta, para não confundir com texto de mensagem em português.
const CHAVES_CREDENCIAL = [
  "password", "senha", "access_token", "refresh_token", "token", "token_hash",
  "hashed_token", "action_link", "email_otp", "session", "jwt",
];
function credenciaisNoCorpo(corpo) {
  const achados = [];
  const visita = (v, caminho) => {
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (CHAVES_CREDENCIAL.includes(k.toLowerCase())) achados.push(`${caminho}${k}`);
        visita(x, `${caminho}${k}.`);
      }
    }
  };
  visita(corpo, "corpo.");
  return achados;
}

/** Cookies de uma resposta, no formato que o navegador reenviaria. */
function cookiesDaResposta(r, jar = new Map()) {
  for (const sc of r.setCookie) {
    const par = sc.split(";")[0];
    const i = par.indexOf("=");
    if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  return jar;
}
const cabecalhoCookie = (jar) => [...jar].map(([n, v]) => `${n}=${v}`).join("; ");

/**
 * Access token da sessão que o app gravou nos cookies. Usa o MESMO cliente
 * (@supabase/ssr) que o app usa para escrever esses cookies, em vez de adivinhar
 * o formato deles.
 */
async function tokenDosCookies(jar) {
  const decodifica = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const sb = createServerClient(SUPA, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value: decodifica(value) })),
      setAll: () => {},
    },
  });
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) {
    throw new Error(
      `não foi possível ler a sessão dos cookies do app (${error?.message ?? "sem sessão"}); ` +
        `cookies recebidos: ${[...jar.keys()].join(", ") || "nenhum"}`
    );
  }
  // O id do usuário vem de getUser(), que CONFERE o token com o servidor de
  // Auth, e não do objeto guardado no cookie. Aqui isso não é zelo: a jornada
  // afirma "este participante é o dono desta conta", e a afirmação tem de vir
  // de quem pode garanti-la.
  const { data: dadosUsuario, error: erroUsuario } = await sb.auth.getUser();
  if (erroUsuario || !dadosUsuario.user) {
    throw new Error(`a sessão dos cookies não foi aceita pelo Auth: ${erroUsuario?.message}`);
  }
  return { token: data.session.access_token, userId: dadosUsuario.user.id };
}

/** Login por senha, no formato de cookie que o app espera. Só para o ADMIN. */
async function sessaoPorSenha(email, senha) {
  const jar = new Map();
  const sb = createServerClient(SUPA, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  // Fixture do harness: tolera 5xx transitório do GoTrue local, anunciando.
  let data = null;
  let error = null;
  for (let i = 1; i <= 3; i += 1) {
    ({ data, error } = await sb.auth.signInWithPassword({ email, password: senha }));
    if (!error && data?.session) break;
    const transitorio = typeof error?.status === "number" && error.status >= 500;
    if (!transitorio) break;
    console.log(`  [aviso] login de ${email} falhou (${error.status}); nova tentativa ${i + 1}/3 em 1s`);
    jar.clear();
    await dormir(1000);
  }
  if (error || !data?.session) throw new Error(`login de ${email} falhou: ${error?.message}`);
  return {
    userId: data.user.id,
    accessToken: data.session.access_token,
    cookie: cabecalhoCookie(jar),
  };
}

// ----------------------------------------------------------------- fixtures
const F = {};
const limpeza = { eventos: [], usuarios: [] };

async function prepara() {
  // ADMIN: o host (Yuri). app_metadata.role = admin é o que require-admin exige.
  F.admin = {
    rotulo: "HOST/ADMIN (app_metadata.role=admin)",
    email: `host-${RUN}@${DOMINIO}`,
    senha: `Host-${RUN}-k9!`,
  };
  const uAdmin = await authAdmin("POST", "users", {
    email: F.admin.email,
    password: F.admin.senha,
    email_confirm: true,
    app_metadata: { role: "admin" },
  });
  limpeza.usuarios.push(uAdmin.id);
  Object.assign(F.admin, await sessaoPorSenha(F.admin.email, F.admin.senha));

  // EVENTO do Marco Zero: quiz_version 2 (as 5 etapas / 52 perguntas da 017).
  //
  // current_stage = 5: a ÚLTIMA etapa do Marco Zero. O portão de
  // /api/jobs/enfileirar compara com o número de etapas da VERSÃO do quiz do evento
  // (5 na v2), então um evento conduzido normalmente chega aqui sem ajuste à mão.
  const [ev] = await rest("POST", "events", {
    name: `${MARCA} Marco Zero`,
    event_code: `JOR-${RUN}`.toUpperCase(),
    event_date: new Date().toISOString(),
    status: "live",
    current_stage: 5,
    quiz_version: 2,
    max_participants: 5,
    mode: "live",
  });
  F.evento = ev;
  limpeza.eventos.push(ev.id);

  // CONVIDADO: só um e-mail. Sem conta, sem linha em `participants`. É a rota
  // /api/entrar/verificar que cria as duas coisas -- é isso que está sob teste.
  F.convidado = {
    rotulo: "CONVIDADO (só tem o e-mail; sem conta e sem participante)",
    email: `convidado-${RUN}@${DOMINIO}`,
    nome: NOME_PARTICIPANTE,
  };

  // VIZINHO: participante legítimo do MESMO evento, com sessão própria e ZERO
  // respostas. Existe para dar controle às negativas (escrita cruzada, conclusão
  // em nome de outro, trava de etapas pendentes) sem depender do convidado.
  F.vizinho = {
    rotulo: "VIZINHO (outro participante do mesmo evento, sem nenhuma resposta)",
    email: `vizinho-${RUN}@${DOMINIO}`,
    senha: `Viz-${RUN}-m4!`,
  };
  const uViz = await authAdmin("POST", "users", {
    email: F.vizinho.email,
    password: F.vizinho.senha,
    email_confirm: true,
    user_metadata: { full_name: `Vizinho ${MARCA}` },
  });
  limpeza.usuarios.push(uViz.id);
  const [pViz] = await rest("POST", "participants", {
    event_id: ev.id,
    user_id: uViz.id,
    full_name: `Vizinho ${MARCA}`,
    email: F.vizinho.email,
  });
  F.vizinho.participantId = pViz.id;
  Object.assign(F.vizinho, await sessaoPorSenha(F.vizinho.email, F.vizinho.senha));
}

async function limpa() {
  const falhas = [];
  const tenta = async (nome, fn) => {
    try {
      await fn();
    } catch (e) {
      falhas.push(`${nome}: ${e.message}`);
    }
  };
  for (const id of limpeza.eventos) {
    await tenta(`evento ${id}`, async () => {
      // jobs tem FK para events com ON DELETE CASCADE; prognostics/participants
      // saem pela função de cascata que o próprio app usa.
      const res = await fetch(`${SUPA}/rest/v1/rpc/delete_event_cascade`, {
        method: "POST",
        headers: svcHeaders(),
        body: JSON.stringify({ event_uuid: id }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await rest("DELETE", `events?id=eq.${id}`);
    });
  }
  // O usuário do convidado nasceu dentro do fluxo: descobre pelo e-mail.
  await tenta("usuário do convidado", async () => {
    const id = await psql(
      `select id from auth.users where email = '${F.convidado.email.replace(/'/g, "''")}'`
    );
    if (id) limpeza.usuarios.push(id);
  });
  for (const id of new Set(limpeza.usuarios.filter(Boolean))) {
    await tenta(`usuário ${id}`, async () => {
      const res = await fetch(`${SUPA}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: svcHeaders(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
    });
  }
  if (falhas.length) console.log(`\n[aviso] limpeza incompleta:\n  - ${falhas.join("\n  - ")}`);
  else console.log("\n[limpeza] dados desta rodada removidos do banco local.");
}

const ANONIMO = "ANÔNIMO (sem cookie)";
const HARNESS = "harness";

// ================================================================ ETAPA 0
const MIGRATIONS_ESPERADAS = [
  "001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011",
  "012", /* 013 não existe: foi dobrada na 011 */ "014", "015", "016", "017", "018",
];

async function e0() {
  etapa(0, "pré-condições (sem elas, verde não significa nada)");

  const login = await http("GET", "/admin/login");
  exige(
    ANONIMO,
    "GET /admin/login (rota pública: prova que o servidor está de pé)",
    "200 com HTML",
    login.status === 200 && /html/i.test(login.texto.slice(0, 400)),
    `status ${login.status}`
  );

  // Controle positivo do canário: se ele não contasse, "zero chamadas à
  // Anthropic" seria uma frase sobre um instrumento cego.
  await canario.zerar();
  await fetch(`${CANARIO.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "controle-positivo-da-jornada", stream: false }),
  });
  const nControle = await canario.total();
  exige(
    HARNESS,
    "controle positivo do canário: 1 POST direto em /v1/messages",
    "contagem == 1 (o canário ENXERGA chamadas)",
    nControle === 1,
    `contagem ${nControle}`
  );
  await canario.zerar();
  const nZero = await canario.total();
  exige(HARNESS, "zerar o canário antes da jornada", "contagem == 0", nZero === 0, `contagem ${nZero}`);

  // Migrations: a máquina conta. "São 17 arquivos, a 013 não existe" é uma
  // afirmação verificável, não um comentário.
  const aplicadas = (await psql(
    "select version from supabase_migrations.schema_migrations order by version"
  ))
    .split("\n")
    .filter(Boolean);
  exige(
    HARNESS,
    "migrations aplicadas no banco local",
    `exatamente as 17 esperadas (${MIGRATIONS_ESPERADAS.join(",")}; a 013 não existe)`,
    aplicadas.length === MIGRATIONS_ESPERADAS.length &&
      aplicadas.every((v, i) => v === MIGRATIONS_ESPERADAS[i]),
    `${aplicadas.length} aplicadas: ${aplicadas.join(",")}`
  );

  // O questionário do Marco Zero está semeado: 5 etapas, 52 perguntas.
  const etapasV2 = await rest(
    "GET",
    "quiz_stages?quiz_version=eq.2&select=id,stage_number,questions&order=stage_number"
  );
  const totalPerguntas = etapasV2.reduce((s, e) => s + e.questions.length, 0);
  exige(
    HARNESS,
    "seed do quiz v2 (migration 017)",
    "5 etapas (ids 101..105) e 52 perguntas",
    etapasV2.length === 5 &&
      totalPerguntas === 52 &&
      etapasV2.every((e, i) => e.id === 101 + i && e.stage_number === i + 1),
    `${etapasV2.length} etapas, ${totalPerguntas} perguntas, ids ${etapasV2.map((e) => e.id).join(",")}`
  );

  // O app lê o MESMO banco que esta suíte escreve. O nome do evento com a marca
  // da rodada só existe no banco local, criado por esta suíte segundos atrás.
  const pagina = await httpComoAdmin("GET", `/admin/events/${F.evento.id}`);
  exige(
    F.admin.rotulo,
    `GET /admin/events/<evento criado só no banco local>`,
    `200 e o HTML contém a marca da rodada (${MARCA})`,
    pagina.status === 200 && pagina.texto.includes(MARCA),
    `status ${pagina.status}, marca ${pagina.texto.includes(MARCA) ? "presente" : "AUSENTE"}`
  );
}

// ================================================================ ETAPA 1
async function e1() {
  etapa(1, "o convidado pede o código -- e nenhuma sessão nasce antes de verificá-lo");

  const contaSessoes = async (email) =>
    Number(
      await psql(
        `select count(*) from auth.sessions s join auth.users u on u.id = s.user_id ` +
          `where u.email = '${email.replace(/'/g, "''")}'`
      )
    );

  const pedido = await http("POST", "/api/entrar/solicitar", {
    json: {
      email: F.convidado.email,
      event_id: F.evento.id,
      event_code: F.evento.event_code,
    },
  });
  // 200 = o GoTrue aceitou enviar. 503/429 = ambiente sem SMTP ou com a
  // frequência do GoTrue batendo. Os três são caminhos legítimos do produto e
  // NENHUM deles pode produzir credencial. Qualquer outro status é falha.
  const statusAceitavel = [200, 429, 503].includes(pedido.status);
  const vazou = credenciaisNoCorpo(pedido.corpo);
  // `eyJ` é o início de qualquer JWT em base64url: procura o formato, não só a
  // chave JSON, para pegar também token escondido em texto livre ou em cookie.
  const temJwt = /eyJ[A-Za-z0-9_-]{10}/.test(pedido.texto) ||
    pedido.setCookie.some((c) => /eyJ[A-Za-z0-9_-]{10}/.test(c));
  exige(
    F.convidado.rotulo,
    "POST /api/entrar/solicitar",
    "200 (enviado), 429 (aguarde) ou 503 (envio indisponível), SEM Set-Cookie, SEM chave de credencial e SEM nenhum JWT na resposta",
    statusAceitavel && vazou.length === 0 && pedido.setCookie.length === 0 && !temJwt,
    `status ${pedido.status}${pedido.corpo?.codigo ? ` (${pedido.corpo.codigo})` : ""}; ` +
      `Set-Cookie x${pedido.setCookie.length}; credenciais no corpo: ${vazou.length ? vazou.join(",") : "nenhuma"}; ` +
      `JWT na resposta: ${temJwt ? "SIM" : "nenhum"}`
  );

  // "Nenhuma sessão existe antes de o código ser verificado" se mede de duas
  // formas, e as duas estão aqui:
  //
  //  (a) O CHAMADOR não tem nada. É a propriedade que o produto controla, e é
  //      asserção dura: com tudo o que a resposta entregou (nada), a próxima
  //      requisição continua anônima.
  //  (b) Quantas linhas existem em auth.sessions. Essa é REGISTRADA, não
  //      transformada em veredito, porque depende da configuração do GoTrue do
  //      ambiente: com GOTRUE_MAILER_AUTOCONFIRM ligado (que é o que acontece
  //      no stack local, onde não há SMTP), o próprio endpoint /auth/v1/otp
  //      cria sessão + refresh token do lado do servidor. Medido nesta máquina:
  //      createUser -> 0 sessões; /auth/v1/otp -> 1 sessão. Nada disso chega ao
  //      chamador (o cliente da rota usa persistSession:false), mas a linha
  //      existe. Falhar aqui seria medir o ambiente, não o código -- e é
  //      exatamente a armadilha que esta suíte declara no topo.
  const comOQueRecebeu = await http("POST", "/api/complete-quiz", {
    cookie: cabecalhoCookie(cookiesDaResposta(pedido)) || undefined,
    json: { participant_id: F.vizinho.participantId },
  });
  exige(
    F.convidado.rotulo,
    "POST /api/complete-quiz usando TUDO o que a resposta de /solicitar entregou",
    "401 (quem só pediu o código segue anônimo) -- controle positivo: com a sessão da ETAPA 2 esta mesma rota responde 200 na ETAPA 4",
    comOQueRecebeu.status === 401,
    `status ${comOQueRecebeu.status}; cookies recebidos no pedido do código: ${pedido.setCookie.length}`
  );

  const sessoesAntes = await contaSessoes(F.convidado.email);
  console.log(`  [medido] linhas em auth.sessions para o convidado depois de pedir o código: ${sessoesAntes}`);
  if (sessoesAntes > 0) {
    achado(
      "pedir o código já cria sessão no GoTrue (neste ambiente, por autoconfirm)",
      `auth.sessions tem ${sessoesAntes} linha(s) para o convidado APÓS /api/entrar/solicitar e ANTES de ` +
        "qualquer código ser verificado. Medido: admin.createUser não cria sessão; /auth/v1/otp cria " +
        "sessão + refresh token quando GOTRUE_MAILER_AUTOCONFIRM está ligado (stack local sem SMTP). " +
        "A rota não entrega nada disso ao chamador (verificado acima), mas o token existe no servidor. " +
        "Vale conferir em produção, onde o SMTP está configurado e o autoconfirm deveria estar desligado."
    );
  }

  // NEGATIVA: sem sessão, ninguém grava resposta de quiz.
  // CONTROLE POSITIVO: a MESMA requisição, com a sessão provada, grava (E3.xx).
  const semSessao = await restComoUsuario(
    "POST",
    "quiz_responses?on_conflict=participant_id,stage_id",
    { participant_id: F.vizinho.participantId, stage_id: 101, answers: { q1: "sem sessão" } },
    { prefer: "resolution=merge-duplicates,return=representation" }
  );
  exige(
    ANONIMO,
    "POST quiz_responses no PostgREST só com a chave anônima (sem JWT de usuário)",
    "recusado (401/403) -- controle positivo: a mesma escrita com sessão provada passa na ETAPA 3",
    [401, 403].includes(semSessao.status),
    `status ${semSessao.status} ${semSessao.texto.slice(0, 160)}`
  );
  // A recusa acima é recusa, mas o MOTIVO importa: se vier como falta de
  // privilégio numa tabela auxiliar, e não da política, a negativa está
  // passando por um caminho diferente do que se pretendia verificar.
  if (semSessao.corpo?.message?.includes("participant_stage_sessions")) {
    achado(
      "recusa do anônimo em quiz_responses vem de GRANT, não da política, e vaza nome de tabela",
      `a resposta foi "${semSessao.corpo.message}". A política de INSERT de quiz_responses referencia ` +
        "participant_stage_sessions (modo async, migration 010); `anon` não tem SELECT nessa tabela " +
        "(`authenticated` tem), então o PostgREST devolve 42501 citando a tabela em vez da recusa " +
        "limpa da política. Nega do mesmo jeito, mas por outro caminho -- e informa o nome de uma " +
        "tabela interna a quem não está autenticado."
    );
  }

  // NEGATIVA: código errado não entra. CONTROLE POSITIVO: o código certo entra (E2).
  const errado = await http("POST", "/api/entrar/verificar", {
    json: {
      email: F.convidado.email,
      token: "000000",
      event_id: F.evento.id,
      event_code: F.evento.event_code,
      full_name: F.convidado.nome,
    },
  });
  // A asserção é sobre o DELTA: um código errado não pode criar sessão nenhuma.
  // O delta é independente da configuração do ambiente; a contagem absoluta não.
  const sessoesDepoisDoErro = await contaSessoes(F.convidado.email);
  exige(
    F.convidado.rotulo,
    "POST /api/entrar/verificar com código errado",
    "401 codigo_invalido, sem Set-Cookie e NENHUMA sessão nova -- controle positivo: o código certo responde 200 e cria sessão na ETAPA 2",
    errado.status === 401 &&
      errado.corpo?.codigo === "codigo_invalido" &&
      errado.setCookie.length === 0 &&
      sessoesDepoisDoErro === sessoesAntes,
    `status ${errado.status} (${errado.corpo?.codigo ?? "sem código"}); Set-Cookie x${errado.setCookie.length}; ` +
      `sessões ${sessoesAntes} -> ${sessoesDepoisDoErro} (delta ${sessoesDepoisDoErro - sessoesAntes})`
  );

  F.contaSessoes = contaSessoes;
  F.sessoesAntesDaVerificacao = sessoesDepoisDoErro;
}

// ================================================================ ETAPA 2
async function e2() {
  etapa(2, "obtém o código (API admin do GoTrue, sem SMTP) e autentica de verdade");

  // generate_link devolve o `email_otp` que o GoTrue colocaria no e-mail. É
  // assim que a jornada roda sem SMTP, sem inbucket e sem caixa de entrada --
  // e sem inventar um código, que provaria nada.
  let link = null;
  let erroLink = null;
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${SUPA}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ type: "magiclink", email: F.convidado.email }),
    });
    const txt = await res.text();
    if (res.ok) {
      link = JSON.parse(txt);
      break;
    }
    // 429 aqui é a frequência mínima do próprio GoTrue (max_frequency) e 5xx é
    // o Kong/GoTrue engasgando: nenhum dos dois é defeito do produto. Espera e
    // tenta de novo, no máximo 4 vezes. Qualquer outro status para na hora.
    erroLink = `${res.status} ${txt.slice(0, 160)}`;
    if (res.status !== 429 && res.status < 500) break;
    await dormir(1500);
  }
  const otp = link?.email_otp ?? null;
  exige(
    HARNESS,
    "POST /auth/v1/admin/generate_link (type=magiclink) para o e-mail do convidado",
    "200 com email_otp de 6 a 10 dígitos",
    typeof otp === "string" && /^\d{6,10}$/.test(otp),
    otp ? `email_otp com ${otp.length} dígitos` : `sem email_otp (${erroLink})`
  );
  if (!otp) throw new Error(`não foi possível obter o código de entrada: ${erroLink}`);

  const entrada = await http("POST", "/api/entrar/verificar", {
    json: {
      email: F.convidado.email,
      token: otp,
      event_id: F.evento.id,
      event_code: F.evento.event_code,
      full_name: F.convidado.nome,
      course_or_moment: "Diretoria de operações, reorganizando prioridades",
    },
  });
  const vazou = credenciaisNoCorpo(entrada.corpo);
  exige(
    F.convidado.rotulo,
    "POST /api/entrar/verificar com o código correto",
    "200 ok=true com participant_id, sessão em Set-Cookie e NENHUM token no corpo",
    entrada.status === 200 &&
      entrada.corpo?.ok === true &&
      typeof entrada.corpo?.participant_id === "string" &&
      entrada.setCookie.length > 0 &&
      vazou.length === 0,
    `status ${entrada.status}; corpo ${JSON.stringify(entrada.corpo)}; Set-Cookie x${entrada.setCookie.length}; credenciais no corpo: ${vazou.length ? vazou.join(",") : "nenhuma"}`
  );
  if (entrada.status !== 200) throw new Error(`entrada recusada: ${entrada.texto.slice(0, 300)}`);

  const jar = cookiesDaResposta(entrada);
  const { token, userId } = await tokenDosCookies(jar);
  F.participante = {
    rotulo: "PARTICIPANTE (o convidado, agora autenticado por código)",
    email: F.convidado.email,
    nome: F.convidado.nome,
    participantId: entrada.corpo.participant_id,
    cookie: cabecalhoCookie(jar),
    token,
    userId,
  };

  const sessoes = await F.contaSessoes(F.convidado.email);
  exige(
    HARNESS,
    "sessões no Auth para o convidado DEPOIS de verificar o código certo",
    "ao menos uma sessão NOVA (controle positivo do delta zero do código errado, na ETAPA 1)",
    sessoes > F.sessoesAntesDaVerificacao,
    `sessões ${F.sessoesAntesDaVerificacao} -> ${sessoes} (delta ${sessoes - F.sessoesAntesDaVerificacao})`
  );

  const [linha] = await rest(
    "GET",
    `participants?id=eq.${F.participante.participantId}&select=id,user_id,email,full_name,event_id,completed_at`
  );
  exige(
    HARNESS,
    "linha em `participants` criada pela própria rota de entrada",
    "vinculada ao usuário do e-mail PROVADO, no evento certo, com o nome enviado e completed_at nulo",
    !!linha &&
      linha.user_id === userId &&
      linha.email === F.convidado.email &&
      linha.full_name === F.convidado.nome &&
      linha.event_id === F.evento.id &&
      linha.completed_at === null,
    JSON.stringify(linha)
  );

  // NEGATIVA: código é de uso único. CONTROLE POSITIVO: o 200 logo acima, com
  // o MESMO código, no MESMO ambiente.
  const reuso = await http("POST", "/api/entrar/verificar", {
    json: {
      email: F.convidado.email,
      token: otp,
      event_id: F.evento.id,
      event_code: F.evento.event_code,
      full_name: F.convidado.nome,
    },
  });
  exige(
    F.participante.rotulo,
    "POST /api/entrar/verificar reusando o MESMO código",
    "401 codigo_invalido (uso único) e sem Set-Cookie",
    reuso.status === 401 && reuso.corpo?.codigo === "codigo_invalido" && reuso.setCookie.length === 0,
    `status ${reuso.status} (${reuso.corpo?.codigo ?? "sem código"}); Set-Cookie x${reuso.setCookie.length}`
  );
}

// ================================================================ ETAPA 3
async function e3() {
  etapa(3, "responde as 5 etapas (52 perguntas) pelo caminho real de gravação");

  const p = F.participante;

  // A versão do quiz vem do EVENTO, como lib/quiz/carregar-etapa.ts faz. Lido
  // com a sessão do participante (chave anônima + JWT), como o navegador lê.
  const ev = await restComoUsuario("GET", `events?id=eq.${F.evento.id}&select=quiz_version`, undefined, { token: p.token });
  const versao = ev.corpo?.[0]?.quiz_version;
  exige(
    p.rotulo,
    "GET events?select=quiz_version com a própria sessão (como a tela faz)",
    "200 e quiz_version = 2",
    ev.status === 200 && versao === 2,
    `status ${ev.status}, quiz_version ${versao}`
  );

  const todas = await restComoUsuario(
    "GET",
    `quiz_stages?quiz_version=eq.${versao}&select=stage_number&order=stage_number`,
    undefined,
    { token: p.token }
  );
  const totalEtapas = todas.corpo?.length ?? 0;
  exige(
    p.rotulo,
    "contagem de etapas da versão do evento (é ela que define 'última etapa')",
    "5 etapas",
    totalEtapas === 5,
    `${totalEtapas} etapas`
  );

  F.situacionaisGravadas = [];
  let perguntasRespondidas = 0;

  for (let numero = 1; numero <= totalEtapas; numero += 1) {
    const r = await restComoUsuario(
      "GET",
      `quiz_stages?quiz_version=eq.${versao}&stage_number=eq.${numero}&select=id,stage_number,title,questions`,
      undefined,
      { token: p.token }
    );
    const etapaDoQuiz = r.corpo?.[0];
    if (!etapaDoQuiz) {
      throw new Error(`etapa ${numero} da versão ${versao} não foi encontrada (status ${r.status})`);
    }

    const { answers, situacionais } = montarRespostasDaEtapa(etapaDoQuiz, {
      nomeCompleto: p.nome,
    });
    F.situacionaisGravadas.push(...situacionais);
    perguntasRespondidas += Object.keys(answers).length;

    // As respostas do plano passariam pela validação da PRÓPRIA tela. Sem isto,
    // a jornada poderia gravar, por um caminho de servidor, algo que nenhuma
    // pessoa consegue enviar -- e estaria medindo um fluxo que não existe.
    const problemas = problemasPelaRegraDaInterface(etapaDoQuiz, answers);
    exige(
      p.rotulo,
      `etapa ${numero} ("${etapaDoQuiz.title}"): respostas aceitas pela regra da própria tela`,
      "nenhum problema de obrigatória/min_chars/max_chars",
      problemas.length === 0,
      problemas.length ? problemas.join(" | ") : `${Object.keys(answers).length} respostas válidas`
    );

    // O CAMINHO REAL: upsert em quiz_responses pelo PostgREST, com a chave
    // anônima e o JWT do participante, nomeando o conflito
    // (participant_id, stage_id) -- exatamente o que handleSubmit faz.
    const grava = await restComoUsuario(
      "POST",
      "quiz_responses?on_conflict=participant_id,stage_id",
      { participant_id: p.participantId, stage_id: etapaDoQuiz.id, answers },
      { token: p.token, prefer: "resolution=merge-duplicates,return=representation" }
    );
    exige(
      p.rotulo,
      `etapa ${numero}: upsert em quiz_responses (stage_id ${etapaDoQuiz.id}) com a própria sessão`,
      "2xx e a linha gravada (RLS permite o dono gravar na etapa liberada)",
      grava.status >= 200 && grava.status < 300 && Array.isArray(grava.corpo) && grava.corpo.length === 1,
      `status ${grava.status} ${grava.texto.slice(0, 160)}`
    );
  }

  exige(
    p.rotulo,
    "total de perguntas respondidas nas 5 etapas",
    "52 perguntas (as da migration 017)",
    perguntasRespondidas === 52,
    `${perguntasRespondidas} perguntas`
  );
  exige(
    p.rotulo,
    "situacionais respondidas",
    `6 situacionais (${SITUACIONAIS.join(", ")})`,
    F.situacionaisGravadas.length === 6 &&
      SITUACIONAIS.every((id) => F.situacionaisGravadas.some((s) => s.id === id)),
    `${F.situacionaisGravadas.length}: ${F.situacionaisGravadas.map((s) => `${s.id}=${s.letra}`).join(" ")}`
  );

  // NEGATIVA: gravar resposta em nome de OUTRO participante.
  // CONTROLE POSITIVO: as 5 gravações legítimas acima, mesma rota, mesmo token.
  const cruzada = await restComoUsuario(
    "POST",
    "quiz_responses?on_conflict=participant_id,stage_id",
    { participant_id: F.vizinho.participantId, stage_id: 101, answers: { q1: "escrita cruzada" } },
    { token: p.token, prefer: "resolution=merge-duplicates,return=representation" }
  );
  const doVizinho = await rest(
    "GET",
    `quiz_responses?participant_id=eq.${F.vizinho.participantId}&select=stage_id`
  );
  exige(
    p.rotulo,
    "upsert em quiz_responses no participant_id do VIZINHO",
    "recusado pela RLS (401/403) e o vizinho continua com 0 respostas",
    [401, 403].includes(cruzada.status) && doVizinho.length === 0,
    `status ${cruzada.status}; respostas do vizinho: ${doVizinho.length}`
  );
}

// ================================================================ ETAPA 4
async function e4() {
  etapa(4, "a conclusão é decidida pelo SERVIDOR, conferindo no banco");

  const p = F.participante;
  const completedAt = async (id) =>
    (await rest("GET", `participants?id=eq.${id}&select=completed_at`))[0].completed_at;
  const concluir = (quem, id) =>
    http("POST", "/api/complete-quiz", { cookie: quem?.cookie, json: { participant_id: id } });

  const anon = await concluir(undefined, p.participantId);
  exige(
    ANONIMO,
    "POST /api/complete-quiz com o participant_id do participante",
    "401 e completed_at segue nulo -- controle positivo: o dono conclui com 200 abaixo",
    anon.status === 401 && (await completedAt(p.participantId)) === null,
    `status ${anon.status}; completed_at ${await completedAt(p.participantId)}`
  );

  // A trava não é "verdade vazia": quem não respondeu nada recebe a lista das 5.
  const semNada = await concluir(F.vizinho, F.vizinho.participantId);
  exige(
    F.vizinho.rotulo,
    "POST /api/complete-quiz sem ter respondido nenhuma etapa",
    "409 etapas_pendentes com as 5 etapas [1,2,3,4,5] e completed_at nulo",
    semNada.status === 409 &&
      semNada.corpo?.codigo === "etapas_pendentes" &&
      JSON.stringify(semNada.corpo?.etapas_pendentes) === "[1,2,3,4,5]" &&
      (await completedAt(F.vizinho.participantId)) === null,
    `status ${semNada.status} ${JSON.stringify(semNada.corpo)}`
  );

  const emNomeDeOutro = await concluir(p, F.vizinho.participantId);
  exige(
    p.rotulo,
    "POST /api/complete-quiz em nome do VIZINHO",
    "403 e completed_at do vizinho segue nulo",
    emNomeDeOutro.status === 403 && (await completedAt(F.vizinho.participantId)) === null,
    `status ${emNomeDeOutro.status}; completed_at do vizinho ${await completedAt(F.vizinho.participantId)}`
  );

  const ok1 = await concluir(p, p.participantId);
  const t1 = await completedAt(p.participantId);
  exige(
    p.rotulo,
    "POST /api/complete-quiz com as 5 etapas respondidas",
    "200 success ja_concluido=false e completed_at gravado (controle positivo das recusas acima)",
    ok1.status === 200 && ok1.corpo?.success === true && ok1.corpo?.ja_concluido === false && !!t1,
    `status ${ok1.status} ${JSON.stringify(ok1.corpo)}; completed_at ${t1}`
  );
  if (!t1) throw new Error("conclusão não foi gravada; a jornada não pode seguir");

  const ok2 = await concluir(p, p.participantId);
  const t2 = await completedAt(p.participantId);
  exige(
    p.rotulo,
    "POST /api/complete-quiz de novo (idempotência)",
    "200 ja_concluido=true e completed_at IDÊNTICO ao primeiro",
    ok2.status === 200 && ok2.corpo?.ja_concluido === true && t2 === t1,
    `status ${ok2.status} ${JSON.stringify(ok2.corpo)}; completed_at ${t1} -> ${t2}`
  );
}

// ================================================================ ETAPA 5
async function e5() {
  etapa(5, "pontuação e briefing a partir do que FICOU GRAVADO no banco");

  // Lê de volta o que está no banco -- não o que a suíte mandou gravar.
  const linhas = await rest(
    "GET",
    `quiz_responses?participant_id=eq.${F.participante.participantId}&select=stage_id,answers&order=stage_id`
  );
  exige(
    HARNESS,
    "linhas de quiz_responses do participante, lidas do banco",
    "5 linhas (uma por etapa), stage_id 101..105",
    linhas.length === 5 && linhas.every((l, i) => l.stage_id === 101 + i),
    `${linhas.length} linhas: ${linhas.map((l) => l.stage_id).join(",")}`
  );

  // A ARMADILHA, medida: o que está no banco é o TEXTO da alternativa, com
  // prefixo "A. ", e NÃO a letra. Se algum dia a gravação passar a guardar a
  // letra, esta verificação falha -- e com ela cai a prova de normalização, que
  // é o motivo desta etapa existir.
  const gravadas = Object.fromEntries(
    linhas.flatMap((l) => Object.entries(l.answers).filter(([id]) => SITUACIONAIS.includes(id)))
  );
  const formatoTexto = SITUACIONAIS.every((id) => {
    const v = gravadas[id];
    return typeof v === "string" && new RegExp(`^${LETRAS_SITUACIONAIS[id]}\\. \\S`).test(v) && v.length > 10;
  });
  exige(
    HARNESS,
    "formato das 6 situacionais COMO ESTÃO NO BANCO",
    'o TEXTO da alternativa ("A. Organizar o problema ..."), nunca a letra isolada',
    formatoTexto,
    SITUACIONAIS.map((id) => `${id}="${String(gravadas[id]).slice(0, 24)}..."`).join(" | ")
  );
  if (!formatoTexto) {
    throw new Error(
      "as situacionais não foram gravadas no formato da interface; a prova de normalização seria vazia"
    );
  }

  // Normalização de borda: é ela que converte o texto em letra para o motor.
  const letras = Object.fromEntries(
    SITUACIONAIS.map((id) => [id, extrairLetraAlternativa(gravadas[id])])
  );
  exige(
    HARNESS,
    "extrairLetraAlternativa() sobre o valor BRUTO de cada situacional",
    `a letra escolhida em cada uma (${SITUACIONAIS.map((id) => `${id}=${LETRAS_SITUACIONAIS[id]}`).join(" ")})`,
    SITUACIONAIS.every((id) => letras[id] === LETRAS_SITUACIONAIS[id]),
    SITUACIONAIS.map((id) => `${id}=${letras[id] ?? "null"}`).join(" ")
  );

  const achatado = achatarRespostas(linhas);
  const scores = calcularMarcoZero(achatado);

  exige(
    HARNESS,
    "perguntas que o motor consome e não encontrou (`incompleto`)",
    "lista vazia: as 24 Likert, os 7 elementos e as 6 situacionais chegaram ao motor",
    scores.incompleto.length === 0,
    scores.incompleto.length ? scores.incompleto.join(",") : "nenhuma"
  );

  // O CRITÉRIO CENTRAL: as 6 situacionais reconhecidas, com contagem por eixo
  // diferente de zero em TODOS os quatro.
  const c = scores.analiseSituacional.contagens;
  const soma = EIXOS.reduce((s, e) => s + c[e], 0);
  console.log(
    `  [situacionais] contagens por eixo: ${EIXOS.map((e) => `${e}=${c[e]}`).join(" | ")} ` +
      `(soma ${soma} de 6) | eixo destacado: ${scores.analiseSituacional.eixoDestacado ?? "nenhum"} ` +
      `| margem ${scores.analiseSituacional.margem} | status ${scores.analiseSituacional.status}`
  );
  exige(
    HARNESS,
    "contagem situacional por eixo (o instrumento de 4 eixos)",
    "os 4 eixos com contagem > 0 e soma == 6",
    EIXOS.every((e) => c[e] > 0) && soma === 6,
    EIXOS.map((e) => `${e}=${c[e]}`).join(" ") + ` soma=${soma}`
  );
  exige(
    HARNESS,
    "contagem situacional exatamente como as letras escolhidas mandam",
    `${EIXOS.map((e) => `${e}=${CONTAGEM_SITUACIONAL_ESPERADA[e]}`).join(" ")} (derivado de MAPA_SITUACIONAL)`,
    EIXOS.every((e) => c[e] === CONTAGEM_SITUACIONAL_ESPERADA[e]),
    EIXOS.map((e) => `${e}=${c[e]}`).join(" ")
  );
  // Mesma conta, feita de outro jeito: pelo mapa, a partir das letras do plano.
  // Se as duas discordarem, o motor e o mapa divergiram.
  const porMapa = Object.fromEntries(EIXOS.map((e) => [e, 0]));
  for (const id of SITUACIONAIS) porMapa[MAPA_SITUACIONAL[id][LETRAS_SITUACIONAIS[id]]] += 1;
  exige(
    HARNESS,
    "contagem do motor conferida contra MAPA_SITUACIONAL (conta independente)",
    "as duas contagens coincidem",
    EIXOS.every((e) => c[e] === porMapa[e]),
    `motor ${EIXOS.map((e) => c[e]).join("/")} x mapa ${EIXOS.map((e) => porMapa[e]).join("/")}`
  );
  exige(
    HARNESS,
    "eixo destacado nas situacionais",
    `"${EIXO_SITUACIONAL_ESPERADO}" com status destacado (margem >= 2)`,
    scores.analiseSituacional.eixoDestacado === EIXO_SITUACIONAL_ESPERADO &&
      scores.analiseSituacional.status === "destacado",
    `${scores.analiseSituacional.eixoDestacado} (${scores.analiseSituacional.status}, margem ${scores.analiseSituacional.margem})`
  );

  const brutos = scores.analiseLikert.pontuacoesBrutas;
  console.log(
    `  [likert] somas brutas: ${EIXOS.map((e) => `${e}=${brutos[e]}`).join(" | ")} ` +
      `| destacado: ${scores.analiseLikert.eixoDestacado ?? "nenhum"} (${scores.analiseLikert.status})`
  );
  exige(
    HARNESS,
    "somas brutas do Likert (24 itens, 6 por eixo)",
    EIXOS.map((e) => `${e}=${SOMAS_LIKERT_ESPERADAS[e]}`).join(" "),
    EIXOS.every((e) => brutos[e] === SOMAS_LIKERT_ESPERADAS[e]),
    EIXOS.map((e) => `${e}=${brutos[e]}`).join(" ")
  );
  exige(
    HARNESS,
    "relação entre os dois autorrelatos (Likert x situacional)",
    `convergência (os dois destacam "${EIXO_LIKERT_ESPERADO}")`,
    scores.analiseLikert.eixoDestacado === EIXO_LIKERT_ESPERADO &&
      scores.relacaoEntreAutorrelatos === "convergencia",
    `likert=${scores.analiseLikert.eixoDestacado}, situacional=${scores.analiseSituacional.eixoDestacado}, relação=${scores.relacaoEntreAutorrelatos}`
  );

  const notas = ELEMENTOS.map((e) => scores.elementos[e].valor);
  console.log(
    `  [elementos] ${ELEMENTOS.map((e) => `${e}=${scores.elementos[e].valor}`).join(" | ")} ` +
      `| média ${scores.elementosMedia.valor} (${scores.elementosMedia.denominador} de 7)`
  );
  exige(
    HARNESS,
    "os 7 Elementos da Vida Plena",
    "7 respondidos, análise completa, maior apresentável e menor único",
    scores.analiseElementos.status === "completo" &&
      scores.analiseElementos.elementosRespondidos === 7 &&
      scores.elementoDeMaiorPontuacao.status === "apresentavel" &&
      scores.analiseElementos.elementoDeMenorPontuacao !== null &&
      notas.every((v) => typeof v === "number"),
    `status ${scores.analiseElementos.status}, respondidos ${scores.analiseElementos.elementosRespondidos}, ` +
      `maior ${scores.elementoDeMaiorPontuacao.elemento} (${scores.elementoDeMaiorPontuacao.status}), ` +
      `menor ${scores.analiseElementos.elementoDeMenorPontuacao}`
  );
  // As notas no motor são as que foram GRAVADAS, não as que o plano pretendia.
  exige(
    HARNESS,
    "notas dos elementos conferidas contra o que foi gravado",
    "cada elemento com a nota do plano (0..10)",
    ELEMENTOS.every((e, i) => scores.elementos[e].valor === Object.values(VALORES_ELEMENTOS)[i]),
    ELEMENTOS.map((e) => scores.elementos[e].valor).join(",")
  );

  // Camada de linguagem: o texto que vai para a pessoa.
  const briefing = montarBriefingMarcoZero(scores, { rotulosEixos: ROTULOS_EIXOS });
  const texto = textoDoParticipante(briefing);
  const vetadas = encontrarExpressoesVetadas(texto);
  exige(
    HARNESS,
    "montarBriefingMarcoZero() a partir da pontuação real",
    "texto não vazio para o participante, sem nenhuma expressão vetada",
    texto.trim().length > 200 && vetadas.length === 0,
    `${texto.length} caracteres, ${briefing.afirmacoes.length} afirmações, vetadas: ${vetadas.length ? vetadas.join(",") : "nenhuma"}`
  );
  exige(
    HARNESS,
    "avisos do briefing (destinados a quem monta o documento)",
    "nenhum aviso de dados inconsistentes",
    !briefing.avisos.some((a) => a.codigo === "dados_inconsistentes"),
    briefing.avisos.length ? briefing.avisos.map((a) => a.codigo).join(",") : "nenhum aviso"
  );

  console.log("\n  ---------- TEXTO DO BRIEFING (dados reais desta jornada) ----------");
  for (const linha of texto.split("\n")) console.log(`  ${linha}`);
  console.log("  -------------------------------------------------------------------\n");

  F.briefing = { texto, scores };

  // O briefing existe e sai; o que NÃO existe é o documento que o usaria.
  pendencia(
    "briefing do Marco Zero não está ligado ao documento gerado",
    "lib/scoring/briefing-marco-zero.ts produz o texto acima, mas lib/ai/generate-prognostic.ts " +
      "monta o prompt por lib/ai/contexto-quiz.ts e NÃO consome briefing nem pontuação. O documento " +
      "entregue na ETAPA 7 não contém nada do que foi medido aqui."
  );
}

// ================================================================ ETAPA 6
async function e6() {
  etapa(6, "enfileira o trabalho e roda ticks até a fila drenar, com a Anthropic substituída");

  await canario.zerar();
  const zerado = await canario.total();
  exige(HARNESS, "canário zerado antes de enfileirar", "contagem == 0", zerado === 0, `contagem ${zerado}`);

  // NEGATIVA: o participante não agenda chamada de modelo.
  // CONTROLE POSITIVO: o admin agenda, logo abaixo, no mesmo ambiente.
  const pelaPessoa = await http("POST", "/api/jobs/enfileirar", {
    cookie: F.participante.cookie,
    json: { event_id: F.evento.id },
  });
  exige(
    F.participante.rotulo,
    "POST /api/jobs/enfileirar",
    "403 (só admin agenda trabalho que gasta modelo)",
    pelaPessoa.status === 403,
    `status ${pelaPessoa.status} ${JSON.stringify(pelaPessoa.corpo)}`
  );

  const tickAnon = await http("GET", "/api/jobs/tick");
  exige(
    ANONIMO,
    "GET /api/jobs/tick sem credencial nenhuma",
    "401 (as únicas portas são o agendador com CRON_SECRET e a sessão de admin)",
    tickAnon.status === 401,
    `status ${tickAnon.status} ${JSON.stringify(tickAnon.corpo)}`
  );

  // PORTÃO DE ENFILEIRAMENTO: a contagem de etapas vem da VERSÃO do quiz do evento
  // (quiz_stages), não de uma constante. O Marco Zero (quiz_version 2) tem 5 etapas,
  // então current_stage=5 é a ÚLTIMA etapa dele e libera; current_stage=4 ainda
  // falta uma e recusa com 400 EVENT_INCOMPLETE ("etapa 4 de 5"), não com a
  // contagem da v1. NEGATIVA (4) e CONTROLE POSITIVO (5, logo abaixo) no mesmo evento.
  await rest("PATCH", `events?id=eq.${F.evento.id}`, { current_stage: 4 });
  const comQuatro = await httpComoAdmin("POST", "/api/jobs/enfileirar", {
    json: { event_id: F.evento.id },
  });
  await rest("PATCH", `events?id=eq.${F.evento.id}`, { current_stage: 5 });
  exige(
    F.admin.rotulo,
    "POST /api/jobs/enfileirar com o evento do Marco Zero em current_stage=4 (falta a etapa 5)",
    "400 EVENT_INCOMPLETE, etapa_atual=4 de total_etapas=5 (a contagem vem da versão 2, não da v1)",
    comQuatro.status === 400 &&
      comQuatro.corpo?.code === "EVENT_INCOMPLETE" &&
      comQuatro.corpo?.detalhes?.etapa_atual === 4 &&
      comQuatro.corpo?.detalhes?.total_etapas === 5,
    `status ${comQuatro.status} ${JSON.stringify(comQuatro.corpo)}`
  );

  const enfileira = await httpComoAdmin("POST", "/api/jobs/enfileirar", {
    json: { event_id: F.evento.id },
  });
  exige(
    F.admin.rotulo,
    "POST /api/jobs/enfileirar com o evento do Marco Zero em current_stage=5, a última etapa da v2 (controle positivo das recusas acima)",
    "200 ok=true, 1 job criado para o único participante que concluiu",
    enfileira.status === 200 &&
      enfileira.corpo?.ok === true &&
      enfileira.corpo?.criados === 1 &&
      enfileira.corpo?.total_participantes === 1,
    `status ${enfileira.status} ${JSON.stringify(enfileira.corpo?.resumo ?? enfileira.corpo)}`
  );

  const statusDaFila = async () => {
    const r = await httpComoAdmin("GET", `/api/jobs/status?event_id=${F.evento.id}`);
    if (r.status !== 200) throw new Error(`GET /api/jobs/status -> ${r.status} ${r.texto.slice(0, 200)}`);
    return r.corpo;
  };

  // Ticks até drenar. Teto explícito: fila que não drena é FALHA com o resumo na
  // mão, nunca espera infinita nem "deve ter dado certo".
  const MAX_TICKS = 12;
  let ticks = 0;
  let resumo = (await statusDaFila()).resumo;
  const relatorios = [];
  while (resumo.pendentes > 0 && ticks < MAX_TICKS) {
    const t = await httpComoAdmin("POST", "/api/jobs/tick");
    ticks += 1;
    if (t.status !== 200) throw new Error(`tick ${ticks} -> ${t.status} ${t.texto.slice(0, 300)}`);
    relatorios.push(
      `tick ${ticks}: reivindicados=${t.corpo.reivindicados} sucesso=${t.corpo.sucesso} ` +
        `falhas=${t.corpo.falhas} pulados=${t.corpo.pulados} parada=${t.corpo.motivo_de_parada}`
    );
    resumo = (await statusDaFila()).resumo;
    if (resumo.pendentes > 0) await dormir(1000);
  }
  for (const l of relatorios) console.log(`  [fila] ${l}`);
  exige(
    F.admin.rotulo,
    `rodar ticks até a fila drenar (${ticks} tick(s) acionado(s) pela sessão de admin)`,
    "0 pendentes, 1 succeeded, 0 failed",
    resumo.pendentes === 0 && resumo.succeeded === 1 && resumo.failed === 0,
    JSON.stringify(resumo)
  );
  if (resumo.pendentes > 0) throw new Error("a fila não drenou no teto de ticks");

  // Porta do agendador, com o segredo. Depois da fila drenada, um tick não
  // reivindica nada: é idempotente, que é a propriedade que permite o cron ser
  // burro e bater de minuto em minuto.
  const tickCron = await http("GET", "/api/jobs/tick", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  exige(
    "AGENDADOR (Bearer CRON_SECRET)",
    "GET /api/jobs/tick com a fila já drenada",
    "200 e reivindicados == 0 (tick idempotente)",
    tickCron.status === 200 && tickCron.corpo?.reivindicados === 0,
    `status ${tickCron.status} reivindicados=${tickCron.corpo?.reivindicados}`
  );

  const fila = await statusDaFila();
  const job = fila.jobs[0];
  exige(
    HARNESS,
    "linha do job no banco (visibilidade que sobrevive à função que morreu)",
    "status succeeded, 1 tentativa, sem erro, com prognostic_id no resultado",
    !!job &&
      job.status === "succeeded" &&
      job.attempts === 1 &&
      job.last_error === null &&
      typeof job.result?.prognostic_id === "string",
    job
      ? `status ${job.status}, tentativas ${job.attempts}/${job.max_attempts}, erro ${job.last_error ?? "nenhum"}, duração ${job.last_duration_ms}ms`
      : "nenhum job"
  );
  exige(
    HARNESS,
    "nada na lista de atenção do painel",
    "0 jobs com falha ou lease vencido",
    Array.isArray(fila.atencao) && fila.atencao.length === 0,
    JSON.stringify(fila.atencao)
  );

  // A PROVA de que nenhum token foi gasto: a geração aconteceu, e aconteceu
  // DENTRO do canário. Zero chamadas seria suspeito (significaria que o trabalho
  // não chamou modelo nenhum); o que se exige é que TODAS as chamadas tenham
  // chegado aqui, com o modelo de produção no corpo.
  const detalhe = await canario.detalhe();
  const todasNoCanario =
    detalhe.total >= 1 &&
    detalhe.requisicoes.every((r) => r.metodo === "POST" && r.caminho === "/v1/messages");
  exige(
    HARNESS,
    "chamadas de modelo registradas pelo canário durante a drenagem",
    "pelo menos 1, todas POST /v1/messages, nenhuma saindo da máquina",
    todasNoCanario,
    `${detalhe.total} chamada(s): ${detalhe.requisicoes.map((r) => `${r.metodo} ${r.caminho} modelo=${r.modelo}`).join(" | ")}`
  );
  exige(
    HARNESS,
    "modelo pedido pelo app (lido do corpo que chegou ao canário)",
    "claude-opus-5 (é o caminho de produção que rodou, não um atalho de teste)",
    detalhe.requisicoes.some((r) => r.modelo === "claude-opus-5"),
    detalhe.requisicoes.map((r) => r.modelo).join(",")
  );

  const [prog] = await rest(
    "GET",
    `prognostics?participant_id=eq.${F.participante.participantId}&select=id,status,raw_ai_output,trail_recommendation,public_share_token,pdf_url`
  );
  exige(
    HARNESS,
    "documento gravado em `prognostics`",
    'status "generated", com o conteúdo que veio do canário e trilha preenchida',
    !!prog &&
      prog.status === "generated" &&
      typeof prog.raw_ai_output?.analise_geral === "string" &&
      prog.raw_ai_output.analise_geral.includes("canário") &&
      !!prog.trail_recommendation,
    prog
      ? `status ${prog.status}, trilha "${prog.trail_recommendation}", análise "${String(prog.raw_ai_output?.analise_geral).slice(0, 60)}..."`
      : "nenhum prognóstico"
  );
  if (!prog) throw new Error("o prognóstico não foi gravado; a jornada não pode seguir");
  F.prog = prog;

  const [eventoDepois] = await rest("GET", `events?id=eq.${F.evento.id}&select=status`);
  exige(
    HARNESS,
    "estado do evento depois de a fila drenar",
    '"completed" (live -> processing -> completed, fechado por qualquer tick)',
    eventoDepois.status === "completed",
    `status ${eventoDepois.status}`
  );
}

// ================================================================ ETAPA 7
async function e7() {
  etapa(7, "o que o participante e o host recebem no fim");

  const p = F.participante;

  // NEGATIVA: enquanto o documento não foi entregue, o participante não o lê.
  // CONTROLE POSITIVO: com o MESMO token, ele lê as próprias respostas.
  const antes = await restComoUsuario(
    "GET",
    `prognostics?participant_id=eq.${p.participantId}&select=id,status`,
    undefined,
    { token: p.token }
  );
  const proprias = await restComoUsuario(
    "GET",
    `quiz_responses?participant_id=eq.${p.participantId}&select=stage_id`,
    undefined,
    { token: p.token }
  );
  exige(
    p.rotulo,
    'GET prognostics com a própria sessão, com o documento em "generated"',
    "200 com 0 linhas (a RLS só libera 'delivered') -- controle positivo: o mesmo token lê as 5 respostas dele",
    antes.status === 200 &&
      Array.isArray(antes.corpo) &&
      antes.corpo.length === 0 &&
      proprias.status === 200 &&
      proprias.corpo.length === 5,
    `prognostics: status ${antes.status}, ${antes.corpo?.length} linha(s); quiz_responses: status ${proprias.status}, ${proprias.corpo?.length} linha(s)`
  );

  // É isto que a tela /waiting consulta enquanto a pessoa espera.
  const statusPublico = await http("GET", `/api/prognostic-status/${F.prog.public_share_token}`);
  exige(
    "PARTICIPANTE na tela de espera (sem sessão, só o token de compartilhamento)",
    "GET /api/prognostic-status/<token>",
    '200 com status "generated" e pdf_url nulo (ainda não entregue)',
    statusPublico.status === 200 &&
      statusPublico.corpo?.status === "generated" &&
      statusPublico.corpo?.pdf_url === null,
    `status ${statusPublico.status} ${JSON.stringify(statusPublico.corpo)}`
  );

  // A página pública só existe depois da entrega: antes dela, 404.
  const paginaAntes = await http("GET", `/prognostic/${F.prog.public_share_token}`);
  exige(
    ANONIMO,
    "GET /prognostic/<token> antes da entrega",
    "404 (a página filtra por status 'delivered')",
    paginaAntes.status === 404,
    `status ${paginaAntes.status}`
  );

  // O HOST. NEGATIVA: o participante não vê a fila. CONTROLE POSITIVO: o admin vê.
  const filaPelaPessoa = await http("GET", `/api/jobs/status?event_id=${F.evento.id}`, {
    cookie: p.cookie,
  });
  const filaPeloHost = await httpComoAdmin("GET", `/api/jobs/status?event_id=${F.evento.id}`);
  exige(
    p.rotulo,
    "GET /api/jobs/status do próprio evento",
    "403 -- controle positivo: o host recebe 200 com o resumo, logo abaixo",
    filaPelaPessoa.status === 403,
    `status ${filaPelaPessoa.status}`
  );
  exige(
    F.admin.rotulo,
    "GET /api/jobs/status do evento",
    "200 com 1 job concluído e nada na lista de atenção",
    filaPeloHost.status === 200 &&
      filaPeloHost.corpo?.resumo?.succeeded === 1 &&
      filaPeloHost.corpo?.atencao?.length === 0,
    `status ${filaPeloHost.status} ${JSON.stringify(filaPeloHost.corpo?.resumo)}`
  );

  const revisaoAnon = await http("GET", `/admin/events/${F.evento.id}/review`);
  const revisaoHost = await httpComoAdmin("GET", `/admin/events/${F.evento.id}/review`);
  exige(
    ANONIMO,
    "GET /admin/events/<evento>/review (a tela de revisão do host)",
    "redirect para /admin/login, página nunca servida",
    eRedirectLogin(revisaoAnon),
    `status ${revisaoAnon.status} -> ${revisaoAnon.location ?? "sem location"}`
  );
  exige(
    F.admin.rotulo,
    "GET /admin/events/<evento>/review",
    "200 e o nome do participante aparece na tela (controle positivo do redirect acima)",
    revisaoHost.status === 200 && revisaoHost.texto.includes(p.nome),
    `status ${revisaoHost.status}, nome do participante ${revisaoHost.texto.includes(p.nome) ? "presente" : "AUSENTE"}`
  );

  // ENTREGA pelo caminho do painel: o botão "Entregar" do PrognosticReviewGrid
  // escreve com o JWT DO ADMIN (não com service_role). É esse caminho que a
  // jornada exercita -- inclusive porque é ele que a RLS tem de permitir.
  const entrega = await restComoUsuario(
    "PATCH",
    `prognostics?id=eq.${F.prog.id}`,
    {
      final_content: F.prog.raw_ai_output,
      status: "delivered",
      delivered_at: new Date().toISOString(),
    },
    { token: F.admin.accessToken, prefer: "return=representation" }
  );
  exige(
    F.admin.rotulo,
    'PATCH prognostics status="delivered" com o JWT do admin (botão Entregar)',
    "200 e a linha volta entregue",
    entrega.status === 200 && entrega.corpo?.[0]?.status === "delivered",
    `status ${entrega.status} ${entrega.texto.slice(0, 160)}`
  );

  // CONTROLE POSITIVO da primeira negativa desta etapa: agora o participante lê.
  const depois = await restComoUsuario(
    "GET",
    `prognostics?participant_id=eq.${p.participantId}&select=id,status`,
    undefined,
    { token: p.token }
  );
  exige(
    p.rotulo,
    "GET prognostics com a própria sessão, agora com o documento entregue",
    "200 com 1 linha em 'delivered' (a recusa anterior era de estado, não do ambiente)",
    depois.status === 200 && depois.corpo?.length === 1 && depois.corpo[0].status === "delivered",
    `status ${depois.status} ${JSON.stringify(depois.corpo)}`
  );

  const statusFinal = await http("GET", `/api/prognostic-status/${F.prog.public_share_token}`);
  exige(
    "PARTICIPANTE na tela de espera",
    "GET /api/prognostic-status/<token> depois da entrega",
    '200 com status "delivered" (é o gatilho que manda a tela abrir o documento)',
    statusFinal.status === 200 && statusFinal.corpo?.status === "delivered",
    `status ${statusFinal.status} ${JSON.stringify(statusFinal.corpo)}`
  );

  const pagina = await http("GET", `/prognostic/${F.prog.public_share_token}`);
  exige(
    "PARTICIPANTE com o link do documento (sem sessão)",
    "GET /prognostic/<token> depois da entrega",
    "200 e o HTML traz o nome da pessoa e o conteúdo que veio do canário",
    pagina.status === 200 &&
      pagina.texto.includes(p.nome) &&
      pagina.texto.includes("Prognóstico sintético do canário"),
    `status ${pagina.status}; nome ${pagina.texto.includes(p.nome) ? "presente" : "AUSENTE"}; ` +
      `conteúdo do canário ${pagina.texto.includes("Prognóstico sintético do canário") ? "presente" : "AUSENTE"}`
  );

  // O que o marco pede e o produto ainda não tem. Declarado, com nome.
  pendencia(
    "one-pager do participante não existe",
    "o entregável desta jornada é o prognóstico longo (PrognosticView / PDF). Não há nenhuma peça " +
      "no código que produza o one-pager descrito em docs/BRIEFING.md: nenhuma rota, nenhum módulo, " +
      "nenhuma coluna. A jornada entrega o documento que EXISTE e declara a ausência."
  );
  pendencia(
    "DNA coletivo do evento não existe",
    "não há agregação por evento que produza o documento de DNA coletivo (docs/BRIEFING.md). O painel " +
      "tem dashboard agregado de métricas (AggregatedDashboard), que é outra coisa. A jornada não " +
      "simula o entregável ausente."
  );
  pendencia(
    "PDF não é exercitado nesta jornada",
    "/api/generate-pdf depende de @react-pdf/renderer e de Storage, que está DESLIGADO no stack local " +
      "(supabase/config.toml, [storage] enabled = false). A jornada verifica pdf_url nulo e para aí, " +
      "em vez de fingir que renderizou."
  );
}

// ================================================================ main
const ETAPAS = [
  [0, e0],
  [1, e1],
  [2, e2],
  [3, e3],
  [4, e4],
  [5, e5],
  [6, e6],
  [7, e7],
];

let falhaFatal = null;
let etapaDaFalha = null;
try {
  await prepara();
  for (const [n, fn] of ETAPAS) {
    etapaDaFalha = n;
    await fn();
  }
  etapaDaFalha = null;
} catch (e) {
  falhaFatal = e;
  console.log(
    `\n[FAIL] A JORNADA PAROU NA ETAPA ${etapaDaFalha ?? "de preparação"} ` +
      `(isto NÃO é aprovação): ${e.stack ?? e}`
  );
} finally {
  await limpa();
}

const falhas = resultados.filter((r) => !r.ok);
const porEtapa = {};
for (const r of resultados) {
  porEtapa[r.etapa] ??= { total: 0, falhas: 0 };
  porEtapa[r.etapa].total += 1;
  if (!r.ok) porEtapa[r.etapa].falhas += 1;
}

console.log("\n=== RESUMO DA JORNADA");
for (const [n, titulo] of [
  ["0", "pré-condições"],
  ["1", "pedido do código, sem sessão"],
  ["2", "código verificado, sessão real"],
  ["3", "52 respostas pelo caminho real"],
  ["4", "conclusão verificada no servidor"],
  ["5", "pontuação e briefing do que ficou gravado"],
  ["6", "fila drenada sem Anthropic real"],
  ["7", "entrega ao participante e ao host"],
]) {
  const v = porEtapa[n];
  if (!v) {
    console.log(`etapa ${n} (${titulo}): NÃO ACONTECEU -- nenhuma verificação produzida`);
    continue;
  }
  console.log(
    `etapa ${n} (${titulo}): ${v.total - v.falhas}/${v.total} verificações ${v.falhas ? "COM FALHA" : "ok"}`
  );
}
if (falhas.length) {
  console.log("\nverificações que falharam:");
  for (const f of falhas) console.log(`  - ${f.id}: ${f.acao}`);
}
const ausentes = ETAPAS.map(([n]) => String(n)).filter((n) => !porEtapa[n]);

if (pendencias.length) {
  console.log(`\n=== PENDÊNCIAS DECLARADAS (${pendencias.length}) -- a jornada não as simula`);
  for (const p of pendencias) console.log(`  - [etapa ${p.etapa}] ${p.titulo}: ${p.descricao}`);
}

if (achados.length) {
  console.log(
    `\n=== ACHADOS (${achados.length}) -- medidos nesta rodada, pedem decisão humana; não são veredito da jornada`
  );
  for (const a of achados) console.log(`  - [etapa ${a.etapa}] ${a.titulo}: ${a.descricao}`);
}

if (recusasTransitorias > 0) {
  console.log(
    `\n[ambiente] ${recusasTransitorias} recusa(s) de admin absorvida(s) por renovação de sessão. ` +
      "Não são falha da jornada, mas instabilidade do Auth local -- e estão contadas, não escondidas."
  );
}

console.log(
  `\ntotal: ${resultados.length} verificações, ${falhas.length} falhas, ` +
    `${pendencias.length} pendências declaradas, ${achados.length} achados` +
    (ausentes.length ? `, etapas sem verificação: ${ausentes.join(",")}` : "")
);
process.exit(falhaFatal || falhas.length || ausentes.length ? 1 : 0);
