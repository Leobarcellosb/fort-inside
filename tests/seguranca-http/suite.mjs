// Suíte de regressão de segurança da camada HTTP (fort-inside).
//
// NÃO rode isto direto: use `bash scripts/test-seguranca-http.sh`. O script sobe
// um app isolado (clone descartável, banco Supabase LOCAL, Anthropic substituída
// por um canário) e só então chama esta suíte com as variáveis abaixo.
//
// Variáveis obrigatórias: APP_URL SUPA_URL ANON_KEY SERVICE_KEY CANARIO_URL
// Opcional: CENARIOS="1,2,5" (padrão: todos). O cenário 0 (pré-condições) sempre roda.
//
// Convenção de veredito (a "armadilha conhecida" do enunciado):
//   - recusa de autorização  = 401/403 em API, ou redirect para /admin/login em página.
//   - QUALQUER outra coisa numa checagem negativa é FALHA: 2xx (acesso concedido),
//     5xx (a rota quebrou - falso verde evitado), 400/404 (rota nem chegou a recusar).
//   - servidor fora do ar = exceção de rede = FALHA, nunca aprovação.

import { createServerClient } from "@supabase/ssr";

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

// Trava de segurança: esta suíte cria e apaga dados. Só roda contra banco local.
const hostSupa = new URL(SUPA).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(hostSupa)) {
  console.error(`ABORTADO: SUPA_URL aponta para ${hostSupa}, que não é local.`);
  process.exit(2);
}

const FILTRO = (process.env.CENARIOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const deveRodar = (n) => FILTRO.length === 0 || FILTRO.includes(String(n));

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MARCA = `[seg-http-${RUN}]`;
const DOMINIO = "seguranca-http.test";

// ---------------------------------------------------------------- relatório
const resultados = [];
let cenarioAtual = "0";
let contador = 0;

function registra({ ator, acao, esperado, obtido, ok }) {
  contador += 1;
  const id = `C${cenarioAtual}.${String(contador).padStart(2, "0")}`;
  resultados.push({ id, cenario: cenarioAtual, ok });
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${id} | ator: ${ator} | ação: ${acao} | esperado: ${esperado} | obtido: ${obtido}`
  );
}
function cenario(n, titulo) {
  cenarioAtual = String(n);
  contador = 0;
  console.log(`\n=== CENÁRIO ${n}: ${titulo}`);
}

// ---------------------------------------------------------------- HTTP
async function http(metodo, caminho, { cookie, json, form, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
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
    // Headers que podem carregar credencial ou denunciar diferença de tratamento.
    setCookie: res.headers.getSetCookie?.() ?? [],
    cacheControl: res.headers.get("cache-control"),
    contentType: res.headers.get("content-type"),
  };
}

const svcHeaders = (extra = {}) => ({
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
  "content-type": "application/json",
  ...extra,
});
async function rest(metodo, caminho, corpo, extra = {}) {
  const res = await fetch(`${SUPA}/rest/v1/${caminho}`, {
    method: metodo,
    headers: svcHeaders({ prefer: "return=representation", ...extra }),
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
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
async function authAdmin(metodo, caminho, corpo) {
  const res = await fetch(`${SUPA}/auth/v1/admin/${caminho}`, {
    method: metodo,
    headers: svcHeaders(),
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`GoTrue admin ${metodo} ${caminho} -> ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}
async function criaUsuario({ email, password, app_metadata, user_metadata }) {
  return authAdmin("POST", "users", {
    email,
    password,
    email_confirm: true,
    app_metadata,
    user_metadata,
  });
}
// Login real (senha) e cookie no formato exato que o @supabase/ssr do app espera.
async function sessao(email, password) {
  const jar = new Map();
  const sb = createServerClient(SUPA, ANON, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { ok: false, erro: error?.message ?? "sem sessão", cookie: null };
  return {
    ok: true,
    userId: data.user.id,
    accessToken: data.session.access_token,
    cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
  };
}
async function loginDireto(email, password) {
  const res = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.status;
}

const canario = {
  async total() {
    return (await (await fetch(`${CANARIO}/__canario/contagem`)).json()).total;
  },
  async detalhe() {
    return (await fetch(`${CANARIO}/__canario/contagem`)).json();
  },
};

// ---------------------------------------------------------------- classificação
function descreveBase(r, legitimo = false) {
  const s = r.status;
  if (s >= 300 && s < 400) return `redirect ${s} -> ${r.location}`;
  if (s === 401 || s === 403) return `recusa ${s}${r.corpo?.error ? ` ("${r.corpo.error}")` : ""}`;
  if (s >= 200 && s < 300) return legitimo ? `autorizado ${s}` : `ACESSO CONCEDIDO ${s}`;
  if (s >= 500) return `ERRO DE SERVIDOR ${s} (não é recusa de autorização)`;
  return `resposta ${s}${r.corpo?.error ? ` ("${r.corpo.error}")` : ""}`;
}
const descreve = (r) => descreveBase(r, false);
// Para respostas que NÃO são recusa de autorização nem acesso (ex.: o 503 contido do join-event).
const resumoHttp = (r) => `status ${r.status}${r.corpo?.codigo ? ` (${r.corpo.codigo})` : r.corpo?.error ? ` ("${r.corpo.error}")` : ""}`;
const eRecusaApi = (r) => r.status === 401 || r.status === 403;
const eRedirectLogin = (r) =>
  [301, 302, 303, 307, 308].includes(r.status) && !!r.location && new URL(r.location, APP).pathname === "/admin/login";

// Checagem negativa de API: tem que ser recusa de autorização.
function recusaApi(ator, acao, r, extra = {}) {
  const vazou = extra.naoDeveConter && r.texto.includes(extra.naoDeveConter);
  registra({
    ator,
    acao,
    esperado: "recusa de autorização (401/403)" + (extra.naoDeveConter ? " e corpo sem o conteúdo protegido" : ""),
    obtido: descreve(r) + (vazou ? " + CONTEÚDO PROTEGIDO VAZOU NO CORPO" : ""),
    ok: eRecusaApi(r) && !vazou,
  });
}
function exige(ator, acao, esperado, ok, obtido) {
  registra({ ator, acao, esperado, obtido, ok });
}

// ---------------------------------------------------------------- credenciais
// Chaves/trechos que, em QUALQUER resposta de join-event, significam que a rota
// voltou a emitir algo que serve de credencial. Procura pela CHAVE JSON (não por
// substring solta) para não confundir com texto de mensagem em português.
const CHAVES_CREDENCIAL = ["password", "senha", "access_token", "refresh_token", "token", "token_hash", "hashed_token", "action_link", "email_otp", "session", "jwt"];
function vazamentoDeCredencial(r, segredosConhecidos = []) {
  const achados = [];
  const visita = (v, caminho) => {
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (CHAVES_CREDENCIAL.includes(k.toLowerCase())) achados.push(`${caminho}${k}`);
        visita(x, `${caminho}${k}.`);
      }
    }
  };
  visita(r.corpo, "corpo.");
  if (r.setCookie.length) achados.push(`Set-Cookie x${r.setCookie.length}`);
  for (const seg of segredosConhecidos) if (seg && r.texto.includes(seg)) achados.push("senha conhecida no texto da resposta");
  return achados;
}
const mesmaResposta = (x, y) =>
  x.status === y.status && x.texto === y.texto && x.contentType === y.contentType && x.cacheControl === y.cacheControl && x.setCookie.length === y.setCookie.length;

// ---------------------------------------------------------------- fixtures
const F = {};
const limpeza = { eventos: [], usuarios: [], kb: [] };

// Conta + participante criados direto no GoTrue e no banco (service_role). Devolve
// a senha, que SÓ a suíte conhece, para poder abrir sessão real em seguida.
async function criaParticipante({ chave, rotulo, nome, eventoId, nomeCompleto }) {
  const email = `${chave}-${RUN}@${DOMINIO}`;
  const senha = `Part-${chave}-${RUN}-k3!`;
  const completo = nomeCompleto ?? `${nome} ${MARCA}`;
  const u = await criaUsuario({ email, password: senha, user_metadata: { full_name: completo } });
  limpeza.usuarios.push(u.id);
  const [p] = await rest("POST", "participants", { event_id: eventoId, user_id: u.id, full_name: completo, email });
  return { rotulo, email, senha, userId: u.id, participantId: p.id };
}

async function preparaFixtures() {
  const senhaAdmin = `Adm-${RUN}-x9!`;

  // Identidades criadas direto no GoTrue (service_role).
  F.admin = { rotulo: "ADMIN (app_metadata.role=admin)", email: `adm-${RUN}@${DOMINIO}`, senha: senhaAdmin };
  F.adminAlvo = {
    rotulo: "ADMIN-VÍTIMA (outro admin, alvo do ataque de join-event)",
    email: `adm-alvo-${RUN}@${DOMINIO}`,
    senha: `Alvo-${RUN}-y7!`,
  };
  F.forjador = {
    rotulo: "FORJADOR (logado, só user_metadata.role=admin, sem app_metadata)",
    email: `forja-${RUN}@${DOMINIO}`,
    senha: `Forja-${RUN}-z5!`,
  };
  for (const [chave, extra] of [
    ["admin", { app_metadata: { role: "admin" } }],
    ["adminAlvo", { app_metadata: { role: "admin" } }],
    ["forjador", { user_metadata: { role: "admin" } }],
  ]) {
    const u = await criaUsuario({ email: F[chave].email, password: F[chave].senha, ...extra });
    F[chave].id = u.id;
    limpeza.usuarios.push(u.id);
  }

  // Evento ao vivo, com as 6 etapas liberadas (batch-process só avança assim).
  const [ev] = await rest("POST", "events", {
    name: `${MARCA} evento`,
    event_code: `HTTP-${RUN}`.toUpperCase(),
    event_date: new Date().toISOString(),
    status: "live",
    current_stage: 6,
  });
  F.evento = ev;
  limpeza.eventos.push(ev.id);

  // Evento descartável, alvo do DELETE administrativo.
  const [evDel] = await rest("POST", "events", {
    name: `${MARCA} evento descartável`,
    event_code: `DEL-${RUN}`.toUpperCase(),
    event_date: new Date().toISOString(),
    status: "draft",
  });
  F.eventoDescartavel = evDel;
  limpeza.eventos.push(evDel.id);

  // Participantes A e B: conta no GoTrue (admin API) + linha em `participants`.
  // NÃO passam por /api/join-event: essa rota foi contida de propósito e não
  // devolve mais credencial nenhuma (responde 503 enquanto o login por código de
  // uso único não existir). Quem quiser entrar pela rota para criar fixture está
  // pedindo a vulnerabilidade de volta.
  for (const [chave, rotulo, nome] of [
    ["a", "PARTICIPANTE-A (dono do prognóstico)", "Participante A"],
    ["b", "PARTICIPANTE-B (outro participante do mesmo evento)", "Participante B"],
  ]) {
    F[chave] = await criaParticipante({ chave, rotulo, nome, eventoId: ev.id });
  }

  // Sessões reais.
  for (const k of ["admin", "forjador", "a", "b"]) {
    const s = await sessao(F[k].email, F[k].senha);
    if (!s.ok) throw new Error(`setup: login de ${k} falhou: ${s.erro}`);
    F[k].cookie = s.cookie;
    F[k].accessToken = s.accessToken;
    if (F[k].userId && s.userId !== F[k].userId) throw new Error(`setup: sessão de ${k} é de outro usuário`);
    F[k].userId = s.userId;
  }

  // A completou o quiz (6 etapas) e tem prognóstico semente: é a "vítima
  // perfeita" para ataques de geração - qualquer brecha de autorização chegaria
  // de fato até o modelo (ou seja, ao canário).
  await rest(
    "POST",
    "quiz_responses",
    [1, 2, 3, 4, 5, 6].map((stage_id) => ({ participant_id: F.a.participantId, stage_id, answers: { q1: "semente" } }))
  );
  await rest("PATCH", `participants?id=eq.${F.a.participantId}`, { completed_at: new Date().toISOString() });
  const [prog] = await rest("POST", "prognostics", {
    participant_id: F.a.participantId,
    raw_ai_output: { semente: MARCA },
    status: "pending",
  });
  F.prog = prog;

  // Base de conhecimento sentinela.
  const [kb] = await rest("POST", "knowledge_base", {
    title: `${MARCA} sentinela`,
    content: `CONTEUDO-RESTRITO-${RUN}`,
    type: "text",
  });
  F.kb = kb;
  limpeza.kb.push(kb.id);
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
  await tenta("kb", () => rest("DELETE", `knowledge_base?title=like.${encodeURIComponent(MARCA + "*")}`));
  await tenta("nps", () => rest("DELETE", `nps_responses?full_name=like.${encodeURIComponent(MARCA + "*")}`));
  for (const id of limpeza.eventos) {
    await tenta(`evento ${id}`, async () => {
      const res = await fetch(`${SUPA}/rest/v1/rpc/delete_event_cascade`, {
        method: "POST",
        headers: svcHeaders(),
        body: JSON.stringify({ event_uuid: id }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await rest("DELETE", `events?id=eq.${id}`);
    });
  }
  for (const id of new Set(limpeza.usuarios.filter(Boolean))) {
    await tenta(`usuário ${id}`, async () => {
      const res = await fetch(`${SUPA}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svcHeaders() });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
    });
  }
  if (falhas.length) console.log(`\n[aviso] limpeza incompleta:\n  - ${falhas.join("\n  - ")}`);
  else console.log("\n[limpeza] dados da rodada removidos do banco local.");
}

const ANONIMO = "ANÔNIMO (sem cookie)";
const PAGINAS_ADMIN = [
  "/admin",
  "/admin/events",
  "/admin/events/new",
  "/admin/nps",
  "/admin/settings",
  () => `/admin/events/${F.evento.id}`,
  () => `/admin/events/${F.evento.id}/dashboard`,
  () => `/admin/events/${F.evento.id}/review`,
].map((p) => (typeof p === "function" ? p : () => p));

// ================================================================= cenários
async function c0() {
  cenario(0, "pré-condições (evitam falso verde: servidor vivo, canário vivo, banco local)");
  const r = await http("GET", "/admin/login");
  exige("ANÔNIMO", "GET /admin/login (rota pública do próprio login)", "200 HTML (servidor de pé, login não protegido)", r.status === 200 && /html/i.test(r.texto.slice(0, 400)), `status ${r.status}`);

  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  await fetch(`${CANARIO.replace(/\/$/, "")}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "controle-positivo", stream: false }) });
  const n = await canario.total();
  exige("harness", "controle positivo do canário: 1 POST direto em /v1/messages", "contagem do canário == 1 (ele enxerga chamadas)", n === 1, `contagem ${n}`);
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });

  // Prova de que o app lê o MESMO banco que a suíte escreve (e não outro). O token
  // abaixo só existe no banco local: foi gerado pelo INSERT feito aqui, via REST.
  const tokenSentinela = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=public_share_token`))[0].public_share_token;
  const viaApp = await http("GET", `/api/prognostic-status/${tokenSentinela}`);
  exige("harness", `o app lê do banco local (${hostSupa})`, "GET /api/prognostic-status/<token criado só no banco LOCAL> responde 200 com o status semeado ('pending')", viaApp.status === 200 && viaApp.corpo?.status === "pending", `status ${viaApp.status}, corpo ${JSON.stringify(viaApp.corpo)}`);
  exige("harness", "identidades reais obtidas por login com senha", "ADMIN, FORJADOR, PARTICIPANTE-A e PARTICIPANTE-B com sessão", !!(F.admin.cookie && F.forjador.cookie && F.a.cookie && F.b.cookie), "4 sessões criadas");
}

async function c1() {
  cenario(1, "usuário autenticado sem papel admin NÃO alcança /admin/* (redirect para login)");
  for (const quem of [ANONIMO, F.a, F.forjador]) {
    const rotulo = typeof quem === "string" ? quem : quem.rotulo;
    const cookie = typeof quem === "string" ? undefined : quem.cookie;
    for (const mk of PAGINAS_ADMIN) {
      const caminho = mk();
      const r = await http("GET", caminho, { cookie });
      const vazou = r.status === 200;
      registra({
        ator: rotulo,
        acao: `GET ${caminho.replace(F.evento.id, "<evento>")}`,
        esperado: "redirect para /admin/login (página nunca servida)",
        obtido: descreve(r),
        ok: eRedirectLogin(r) && !vazou,
      });
    }
  }
  // Sem laço de redirects: seguir o redirect cai no login (200), não em outro redirect.
  const r = await http("GET", "/admin/events", { cookie: F.a.cookie });
  const alvo = r.location ? new URL(r.location, APP).pathname + new URL(r.location, APP).search : "/";
  const seg = await http("GET", alvo, { cookie: F.a.cookie });
  exige(F.a.rotulo, "seguir o redirect de /admin/events", "chega em /admin/login com 200 (sem laço de redirects)", seg.status === 200, `status ${seg.status}`);
}

async function c2() {
  cenario(2, "base de conhecimento: anônimo e participante não leem nem alteram (3 handlers)");
  const antes = (await rest("GET", `knowledge_base?id=eq.${F.kb.id}&select=id,title,content`))[0];
  for (const quem of [ANONIMO, F.a, F.forjador]) {
    const rotulo = typeof quem === "string" ? quem : quem.rotulo;
    const cookie = typeof quem === "string" ? undefined : quem.cookie;

    const g = await http("GET", "/api/knowledge-base", { cookie });
    recusaApi(rotulo, "GET /api/knowledge-base (ler)", g, { naoDeveConter: `CONTEUDO-RESTRITO-${RUN}` });

    const p = await http("POST", "/api/knowledge-base", { cookie, json: { title: `${MARCA} invasor-json`, content: "x", type: "text" } });
    recusaApi(rotulo, "POST /api/knowledge-base (criar, JSON)", p);

    const form = new FormData();
    form.set("title", `${MARCA} invasor-arquivo`);
    form.set("file", new Blob(["x"], { type: "text/plain" }), "invasor.txt");
    const pf = await http("POST", "/api/knowledge-base", { cookie, form });
    recusaApi(rotulo, "POST /api/knowledge-base (criar, multipart)", pf);

    const d = await http("DELETE", `/api/knowledge-base?id=${F.kb.id}`, { cookie });
    recusaApi(rotulo, "DELETE /api/knowledge-base?id=<sentinela>", d);
  }
  const depois = await rest("GET", `knowledge_base?title=like.${encodeURIComponent(MARCA + "*")}&select=id,title,content`);
  const sentinela = depois.find((x) => x.id === F.kb.id);
  const invasores = depois.filter((x) => x.title.includes("invasor"));
  exige("(efeito colateral, verificado no banco)", "linha sentinela após todas as tentativas", "sentinela intacta (existe, mesmo título e conteúdo)", !!sentinela && sentinela.content === antes.content && sentinela.title === antes.title, sentinela ? "intacta" : "SENTINELA APAGADA");
  exige("(efeito colateral, verificado no banco)", "linhas criadas pelos atacantes", "nenhuma linha 'invasor' gravada", invasores.length === 0, `${invasores.length} linhas`);
}

async function c3() {
  cenario(3, "processamento em lote: anônimo e participante recusados (+ demais rotas administrativas)");
  const antesCanario = await canario.total();
  const antesEvento = (await rest("GET", `events?id=eq.${F.evento.id}&select=status`))[0].status;
  for (const quem of [ANONIMO, F.a, F.forjador]) {
    const rotulo = typeof quem === "string" ? quem : quem.rotulo;
    const cookie = typeof quem === "string" ? undefined : quem.cookie;
    const r = await http("POST", "/api/batch-process", { cookie, json: { event_id: F.evento.id } });
    recusaApi(rotulo, "POST /api/batch-process {event_id do evento completo}", r);
  }
  const depoisEvento = (await rest("GET", `events?id=eq.${F.evento.id}&select=status`))[0].status;
  const depoisCanario = await canario.total();
  exige("(efeito colateral, verificado no banco)", "status do evento após os 3 ataques", `evento segue '${antesEvento}' (nenhum processamento iniciado)`, depoisEvento === antesEvento, `status '${depoisEvento}'`);
  exige("(canário Anthropic)", "chamadas ao modelo durante o lote negado", "0 (recusa antes do trabalho caro)", depoisCanario === antesCanario, `${depoisCanario - antesCanario} chamadas`);

  // Demais rotas administrativas.
  const codigo = F.eventoDescartavel.event_code;
  for (const quem of [ANONIMO, F.a, F.forjador]) {
    const rotulo = typeof quem === "string" ? quem : quem.rotulo;
    const cookie = typeof quem === "string" ? undefined : quem.cookie;
    const r = await http("DELETE", `/api/admin/events/${F.eventoDescartavel.id}`, { cookie, json: { confirmation_code: codigo } });
    recusaApi(rotulo, "DELETE /api/admin/events/<descartável> com o código de confirmação correto", r);
    const conteudo = {
      analise_geral: "x", areas_chave: [{ nome: "x", diagnostico: "x", risco: "x", movimento: "x" }],
      plano_30_dias: [{ titulo: "x", objetivos: ["x"], acao: "x", resultado_esperado: "x" }],
      praticas: [{ nome: "x", descricao: "x" }],
      frase_ativacao: { frase: "x", contexto: "x", aplicacao: "x", pergunta_pratica: "x" },
      trilha_recomendada: "Exploração", justificativa_trilha: "x",
    };
    const p = await http("PATCH", `/api/prognostics/${F.prog.id}`, { cookie, json: { content: conteudo, yuri_note: "invasor" } });
    recusaApi(rotulo, "PATCH /api/prognostics/<id> com conteúdo válido", p);
  }
  const ainda = await rest("GET", `events?id=eq.${F.eventoDescartavel.id}&select=id`);
  const prog = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=status,yuri_note`))[0];
  exige("(efeito colateral, verificado no banco)", "evento descartável após os DELETEs negados", "evento ainda existe", ainda.length === 1, ainda.length === 1 ? "existe" : "APAGADO");
  exige("(efeito colateral, verificado no banco)", "prognóstico após os PATCHs negados", "status 'pending' e sem yuri_note", prog.status === "pending" && prog.yuri_note === null, `status '${prog.status}', yuri_note ${JSON.stringify(prog.yuri_note)}`);
}

async function c4() {
  cenario(4, "prognóstico e PDF: recusados ANTES de qualquer chamada ao modelo");
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const corpoVitima = { participant_id: F.a.participantId, event_id: F.evento.id };
  const progAntes = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=status,raw_ai_output`))[0];

  const respostasRecusa = [];
  const atacantes = [
    [ANONIMO, undefined],
    [F.b.rotulo, F.b.cookie],
    [F.forjador.rotulo, F.forjador.cookie],
  ];
  for (const [rotulo, cookie] of atacantes) {
    const r = await http("POST", "/api/generate-prognostic", { cookie, json: corpoVitima });
    respostasRecusa.push(r);
    recusaApi(rotulo, "POST /api/generate-prognostic para o participante A (quiz completo = vítima perfeita)", r);
  }
  for (const [rotulo, cookie] of atacantes) {
    const r = await http("POST", "/api/generate-pdf", { cookie, json: { prognostic_id: F.prog.id } });
    respostasRecusa.push(r);
    recusaApi(rotulo, "POST /api/generate-pdf {prognostic_id existente}", r);
  }
  const rtok = await http("POST", "/api/generate-pdf", { json: { token: `token-inexistente-${RUN}` } });
  exige(ANONIMO, "POST /api/generate-pdf {token inexistente}", "404 (ramo público não renderiza nada sem token válido)", rtok.status === 404, descreve(rtok));

  const det = await canario.detalhe();
  exige(
    "(canário Anthropic)",
    "chamadas ao modelo durante TODAS as tentativas negadas acima",
    "0 chamadas: a recusa vem antes do modelo",
    det.total === 0,
    `${det.total} chamadas` + (det.total ? ` -> ${JSON.stringify(det.requisicoes)}` : "")
  );
  const progDepois = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=status,raw_ai_output`))[0];
  exige("(efeito colateral, verificado no banco)", "prognóstico de A após os ataques", "inalterado (status e conteúdo)", JSON.stringify(progAntes) === JSON.stringify(progDepois), progDepois.status);
  // Prova de que a recusa é do app e não um erro de chave: a ANTHROPIC_API_KEY do app
  // é falsa de propósito. Se alguma recusa viesse do SDK/Anthropic, o corpo seria um
  // erro de autenticação do modelo, não a mensagem de autorização do próprio app.
  const todasDoApp = respostasRecusa.every((r) => r.corpo?.error === "Não autorizado" && !/anthropic|api[-_ ]?key|x-api-key|invalid/i.test(r.texto));
  exige(
    "(prova de que não é erro de chave)",
    "corpo de todas as recusas de prognóstico/PDF (app roda com ANTHROPIC_API_KEY falsa)",
    `todas == { error: "Não autorizado" } do próprio app, sem menção a chave/Anthropic`,
    respostasRecusa.length === 6 && todasDoApp,
    `${respostasRecusa.length} respostas; todas do app: ${todasDoApp}`
  );
}

async function c5() {
  cenario(5, "join-event: nenhuma resposta distingue admin de participante comum, nenhuma credencial sai, senhas intactas");
  // A rota foi contida de propósito (ver o comentário no topo de app/api/join-event/route.ts).
  // O 403 só para admin, que esta suíte já exigiu, era justamente o ORÁCULO que permitia
  // enumerar quais e-mails são de administrador. A expectativa agora é a oposta: admin e
  // participante comum recebem a MESMA resposta, e nenhuma resposta é credencial.
  const alvo = F.adminAlvo;
  const ctrl = F.b; // controle: participante comum, já cadastrado neste evento
  const loginAntes = await loginDireto(alvo.email, alvo.senha);
  const loginCtrlAntes = await loginDireto(ctrl.email, ctrl.senha);
  exige("(pré-condição)", "login do admin-vítima e do participante-controle com as senhas originais ANTES do ataque", "200 e 200", loginAntes === 200 && loginCtrlAntes === 200, `status ${loginAntes} e ${loginCtrlAntes}`);
  // Snapshot DEPOIS dos logins de controle: login mexe em updated_at, e o que
  // queremos isolar é só o efeito das chamadas à rota.
  const antes = await authAdmin("GET", `users/${alvo.id}`);
  const antesCtrl = await authAdmin("GET", `users/${ctrl.userId}`);

  const corpoDe = (email, nome) => ({ event_id: F.evento.id, event_code: F.evento.event_code, email, full_name: nome });
  const variantes = [
    ["admin", "ANÔNIMO com o QR público (event_code) e o e-mail exato do ADMIN", alvo.email],
    ["adminMaiusc", "ANÔNIMO com o QR público e o e-mail do ADMIN em CAIXA ALTA", alvo.email.toUpperCase()],
    ["comum", "ANÔNIMO com o QR público e o e-mail de um PARTICIPANTE COMUM (controle)", ctrl.email],
    ["comumMaiusc", "ANÔNIMO com o QR público e o e-mail do PARTICIPANTE COMUM em CAIXA ALTA (controle)", ctrl.email.toUpperCase()],
  ];
  const resp = {};
  for (const [chave, rotulo, email] of variantes) {
    const r = await http("POST", "/api/join-event", { json: corpoDe(email, "Atacante") });
    resp[chave] = r;
    const achados = vazamentoDeCredencial(r, [alvo.senha, ctrl.senha]);
    registra({
      ator: rotulo,
      acao: "POST /api/join-event",
      esperado: "503 sem credencial: sem password/token/sessão no corpo e sem Set-Cookie",
      obtido: `${resumoHttp(r)}${achados.length ? ` + CREDENCIAL NA RESPOSTA: ${achados.join(", ")}` : ""}`,
      ok: r.status === 503 && achados.length === 0,
    });
  }
  // O coração do cenário: indistinguíveis. Se alguma volta a diferir (ex.: 403 só
  // para admin), o formulário público volta a ser oráculo de "este e-mail é admin".
  for (const [a, b] of [["admin", "comum"], ["adminMaiusc", "comumMaiusc"], ["admin", "adminMaiusc"]]) {
    const x = resp[a], y = resp[b];
    exige(
      "(oráculo)",
      `resposta para '${a}' x resposta para '${b}'`,
      "idênticas: mesmo status, mesmo corpo, mesmos cabeçalhos relevantes",
      mesmaResposta(x, y),
      mesmaResposta(x, y) ? `idênticas (${x.status}, ${x.texto.length} bytes)` : `DIFEREM: ${x.status} ${JSON.stringify(x.corpo)} x ${y.status} ${JSON.stringify(y.corpo)}`
    );
  }

  // Prova no GoTrue: nada foi alterado em nenhuma das duas contas.
  const depois = await authAdmin("GET", `users/${alvo.id}`); // antes de qualquer novo login
  const depoisCtrl = await authAdmin("GET", `users/${ctrl.userId}`);
  const loginDepois = await loginDireto(alvo.email, alvo.senha);
  const loginCtrlDepois = await loginDireto(ctrl.email, ctrl.senha);
  exige("(prova no GoTrue)", "login do admin-vítima com a senha ORIGINAL depois do ataque", "200 (a senha não foi alterada)", loginDepois === 200, `status ${loginDepois}`);
  exige("(prova no GoTrue)", "login do participante-controle com a senha ORIGINAL depois das chamadas", "200 (a senha não foi alterada)", loginCtrlDepois === 200, `status ${loginCtrlDepois}`);
  exige("(prova no GoTrue)", "updated_at do admin antes x depois", "idêntico (updateUserById nunca foi chamado)", antes.updated_at === depois.updated_at, `antes ${antes.updated_at} | depois ${depois.updated_at}`);
  exige("(prova no GoTrue)", "updated_at do participante-controle antes x depois", "idêntico (a senha dele também não foi redefinida)", antesCtrl.updated_at === depoisCtrl.updated_at, `antes ${antesCtrl.updated_at} | depois ${depoisCtrl.updated_at}`);
  exige("(prova no GoTrue)", "app_metadata do admin antes x depois", "role=admin preservado", depois.app_metadata?.role === "admin", JSON.stringify(depois.app_metadata));
  const parts = await rest("GET", `participants?event_id=eq.${F.evento.id}&email=ilike.${encodeURIComponent(alvo.email)}&select=id`);
  exige("(efeito colateral, verificado no banco)", "participante criado com o e-mail do admin no evento", "nenhum", parts.length === 0, `${parts.length} linhas`);
  const partsCtrl = await rest("GET", `participants?event_id=eq.${F.evento.id}&email=ilike.${encodeURIComponent(ctrl.email)}&select=id`);
  exige("(efeito colateral, verificado no banco)", "linhas do participante-controle no evento", "exatamente 1 (nenhuma duplicata)", partsCtrl.length === 1, `${partsCtrl.length} linhas`);
}

async function c6() {
  cenario(6, "FLUXO LEGÍTIMO: admin de verdade e participante de verdade continuam funcionando");
  const descreve = (r) => descreveBase(r, true);

  // ---- Admin: páginas
  for (const mk of PAGINAS_ADMIN.slice(1)) {
    const caminho = mk();
    const r = await http("GET", caminho, { cookie: F.admin.cookie });
    exige(F.admin.rotulo, `GET ${caminho.replace(F.evento.id, "<evento>")}`, "200 HTML (página servida, sem redirect)", r.status === 200 && /html/i.test(r.texto.slice(0, 400)), descreve(r));
  }

  // ---- Admin: base de conhecimento
  const g = await http("GET", "/api/knowledge-base", { cookie: F.admin.cookie });
  exige(F.admin.rotulo, "GET /api/knowledge-base", "200 e lista contendo a sentinela", g.status === 200 && Array.isArray(g.corpo) && g.corpo.some((x) => x.id === F.kb.id), descreve(g));
  const p = await http("POST", "/api/knowledge-base", { cookie: F.admin.cookie, json: { title: `${MARCA} criada pelo admin`, content: "ok", type: "text" } });
  exige(F.admin.rotulo, "POST /api/knowledge-base", "201 com id", p.status === 201 && !!p.corpo?.id, descreve(p));
  if (p.corpo?.id) {
    const d = await http("DELETE", `/api/knowledge-base?id=${p.corpo.id}`, { cookie: F.admin.cookie });
    const resta = await rest("GET", `knowledge_base?id=eq.${p.corpo.id}&select=id`);
    exige(F.admin.rotulo, "DELETE /api/knowledge-base?id=<criada pelo admin>", "200 e linha realmente removida", d.status === 200 && resta.length === 0, `${descreve(d)}; linhas restantes ${resta.length}`);
  }

  const docA = async () => (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=status,raw_ai_output,edited_content,yuri_note,reviewed_at,generated_at,pdf_url`))[0];
  // ---- Participante NÃO gera o próprio prognóstico.
  // Antes esta verificação esperava 200. Foi retirada a permissão por decisão de
  // produto: o documento é produzido sob controle da operação, com revisão humana.
  // A expectativa agora é recusa 403, SEM chamada ao modelo e sem tocar no documento.
  // Vem ANTES da geração do admin de propósito: assim o rate limit por participante
  // (429) não tem como mascarar a resposta, e um guarda removido apareceria como 200.
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const docAntes = await docA();
  const gp = await http("POST", "/api/generate-prognostic", { cookie: F.a.cookie, json: { participant_id: F.a.participantId, event_id: F.evento.id } });
  const chamadas = await canario.total();
  const docDepois = await docA();
  exige(F.a.rotulo, "POST /api/generate-prognostic para o PRÓPRIO participant_id", "403 'Não autorizado', 0 chamadas ao canário e documento intocado (participante perdeu esta permissão)", gp.status === 403 && gp.corpo?.error === "Não autorizado" && !gp.corpo?.success && chamadas === 0 && JSON.stringify(docAntes) === JSON.stringify(docDepois), `${descreve(gp)}; chamadas ao canário ${chamadas}; documento ${JSON.stringify(docAntes) === JSON.stringify(docDepois) ? "intocado" : "ALTERADO"}`);

  // ---- Admin: gerar prognóstico (único papel que pode; chega ao canário, zero token)
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const gAdmin = await http("POST", "/api/generate-prognostic", { cookie: F.admin.cookie, json: { participant_id: F.a.participantId, event_id: F.evento.id } });
  const chamadasAdmin = await canario.total();
  const progGerado = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=status`))[0];
  exige(F.admin.rotulo, "POST /api/generate-prognostic para o participante A", "200 success + exatamente 1 chamada ao canário + prognóstico 'generated' (controle positivo: o admin continua podendo)", gAdmin.status === 200 && gAdmin.corpo?.success === true && chamadasAdmin === 1 && progGerado.status === "generated", `${descreve(gAdmin)}; chamadas ao canário ${chamadasAdmin}; status '${progGerado.status}'`);

  // ---- Admin: PATCH de prognóstico
  const conteudo = {
    analise_geral: "revisado", areas_chave: [{ nome: "x", diagnostico: "x", risco: "x", movimento: "x" }],
    plano_30_dias: [{ titulo: "x", objetivos: ["x"], acao: "x", resultado_esperado: "x" }],
    praticas: [{ nome: "x", descricao: "x" }],
    frase_ativacao: { frase: "x", contexto: "x", aplicacao: "x", pergunta_pratica: "x" },
    trilha_recomendada: "Exploração", justificativa_trilha: "x",
  };
  const pt = await http("PATCH", `/api/prognostics/${F.prog.id}`, { cookie: F.admin.cookie, json: { content: conteudo, yuri_note: "nota do admin" } });
  exige(F.admin.rotulo, "PATCH /api/prognostics/<id>", "200 (passou do guarda e gravou)", pt.status === 200, descreve(pt));

  // ---- Admin: DELETE de evento descartável
  const del = await http("DELETE", `/api/admin/events/${F.eventoDescartavel.id}`, { cookie: F.admin.cookie, json: { confirmation_code: F.eventoDescartavel.event_code } });
  const sobrou = await rest("GET", `events?id=eq.${F.eventoDescartavel.id}&select=id`);
  exige(F.admin.rotulo, "DELETE /api/admin/events/<descartável> com o código correto", "200 e evento realmente apagado", del.status === 200 && sobrou.length === 0, `${descreve(del)}; eventos restantes ${sobrou.length}`);

  // ---- Admin: PDF (SÓ autorização; Storage está desligado neste ambiente)
  const pdf404 = await http("POST", "/api/generate-pdf", { cookie: F.admin.cookie, json: { prognostic_id: "00000000-0000-4000-8000-00000000dead" } });
  exige(F.admin.rotulo, "POST /api/generate-pdf {prognostic_id inexistente}", "404 'Prognóstico não encontrado' (passou do guarda; recusa NÃO é de autorização)", pdf404.status === 404, descreve(pdf404));
  const pdfReal = await http("POST", "/api/generate-pdf", { cookie: F.admin.cookie, json: { prognostic_id: F.prog.id } });
  exige(F.admin.rotulo, "POST /api/generate-pdf {prognostic_id real} [só autorização - Storage desligado, gravação NÃO validada]", "não ser recusa 401/403 (200 ou erro de Storage 500 são aceitos AQUI)", !eRecusaApi(pdfReal), descreve(pdfReal));

  // ---- Admin: lotes. A está 'reviewed' (o PATCH acima). Três lotes, do mais simples ao misto.
  const logLote = async () => (await rest("GET", `event_logs?event_id=eq.${F.evento.id}&action=eq.batch_process_completed&order=created_at.desc&limit=1&select=payload`))[0]?.payload;
  const quatro = (c) => c && ["total", "succeeded", "skipped", "failed"].every((k) => Number.isInteger(c[k]));
  const resumo = (c) => `total=${c?.total} succeeded=${c?.succeeded} skipped=${c?.skipped} failed=${c?.failed}`;

  // Lote 1: só há um concluído e o documento dele já está em revisão -> PULADO, não falha.
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const rev0 = await docA();
  const bp1 = await http("POST", "/api/batch-process", { cookie: F.admin.cookie, json: { event_id: F.evento.id } });
  const chamadas1 = await canario.total();
  const rev1 = await docA();
  exige(F.admin.rotulo, "POST /api/batch-process {1 concluído, documento já 'reviewed'}", "200 total=1 succeeded=0 skipped=1 failed=0; status 'reviewed' preservado, edição do admin intacta; 0 chamadas ao canário", bp1.status === 200 && bp1.corpo?.success === true && quatro(bp1.corpo) && bp1.corpo.total === 1 && bp1.corpo.succeeded === 0 && bp1.corpo.skipped === 1 && bp1.corpo.failed === 0 && rev1.status === "reviewed" && JSON.stringify(rev0) === JSON.stringify(rev1) && rev1.yuri_note === "nota do admin" && chamadas1 === 0, `${descreve(bp1)} ${resumo(bp1.corpo)}; status '${rev1.status}'; documento ${JSON.stringify(rev0) === JSON.stringify(rev1) ? "intocado" : "ALTERADO"}; chamadas ao canário ${chamadas1}`);
  const log1 = await logLote();
  exige("(efeito colateral, verificado no banco)", "event_logs batch_process_completed do lote 1", "payload com os quatro contadores, igual à resposta", quatro(log1) && log1.total === bp1.corpo?.total && log1.skipped === bp1.corpo?.skipped && log1.failed === bp1.corpo?.failed && log1.succeeded === bp1.corpo?.succeeded, JSON.stringify(log1));

  // Lote 2: entra G (quiz completo, sem prognóstico). G gera; A segue pulado.
  const pg = await criaParticipante({ chave: "g", rotulo: "PARTICIPANTE-G (concluído, ainda sem prognóstico)", nome: "Participante G", eventoId: F.evento.id });
  await rest("POST", "quiz_responses", [1, 2, 3, 4, 5, 6].map((stage_id) => ({ participant_id: pg.participantId, stage_id, answers: { q1: "semente" } })));
  await rest("PATCH", `participants?id=eq.${pg.participantId}`, { completed_at: new Date().toISOString() });
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const bp2 = await http("POST", "/api/batch-process", { cookie: F.admin.cookie, json: { event_id: F.evento.id } });
  const chamadas2 = await canario.total();
  const progG = await rest("GET", `prognostics?participant_id=eq.${pg.participantId}&select=status`);
  const rev2 = await docA();
  exige(F.admin.rotulo, "POST /api/batch-process {A 'reviewed' + G sem prognóstico}", "200 total=2 succeeded=1 skipped=1 failed=0; exatamente 1 chamada ao canário (só G); G 'generated'; A intocado", bp2.status === 200 && bp2.corpo?.success === true && quatro(bp2.corpo) && bp2.corpo.total === 2 && bp2.corpo.succeeded === 1 && bp2.corpo.skipped === 1 && bp2.corpo.failed === 0 && chamadas2 === 1 && progG.length === 1 && progG[0].status === "generated" && JSON.stringify(rev0) === JSON.stringify(rev2), `${descreve(bp2)} ${resumo(bp2.corpo)}; chamadas ao canário ${chamadas2}; G ${progG[0]?.status ?? "sem prognóstico"}; A ${JSON.stringify(rev0) === JSON.stringify(rev2) ? "intocado" : "ALTERADO"}`);

  // Lote 3: entra H, cujo nome faz o canário recusar a geração (erro 400 do "modelo").
  // É a falha REAL: a rota tem que contá-la em `failed`, nunca esconder nem chamar de pulado.
  const ph = await criaParticipante({ chave: "h", rotulo: "PARTICIPANTE-H (a geração dele falha)", nome: "Participante H", eventoId: F.evento.id, nomeCompleto: `${MARCADOR_FALHA_CANARIO} ${MARCA}` });
  await rest("POST", "quiz_responses", [1, 2, 3, 4, 5, 6].map((stage_id) => ({ participant_id: ph.participantId, stage_id, answers: { q1: "semente" } })));
  await rest("PATCH", `participants?id=eq.${ph.participantId}`, { completed_at: new Date().toISOString() });
  await fetch(`${CANARIO}/__canario/zerar`, { method: "POST" });
  const bp3 = await http("POST", "/api/batch-process", { cookie: F.admin.cookie, json: { event_id: F.evento.id } });
  const chamadas3 = await canario.total();
  const progH = await rest("GET", `prognostics?participant_id=eq.${ph.participantId}&select=status`);
  const rev3 = await docA();
  exige(F.admin.rotulo, "POST /api/batch-process {A 'reviewed' + G 'generated' + H que falha}", "200 total=3 succeeded=1 skipped=1 failed=1; H continua sem prognóstico; A intocado", bp3.status === 200 && bp3.corpo?.success === true && quatro(bp3.corpo) && bp3.corpo.total === 3 && bp3.corpo.succeeded === 1 && bp3.corpo.skipped === 1 && bp3.corpo.failed === 1 && progH.length === 0 && JSON.stringify(rev0) === JSON.stringify(rev3), `${descreve(bp3)} ${resumo(bp3.corpo)}; chamadas ao canário ${chamadas3}; H ${progH[0]?.status ?? "sem prognóstico"}; A ${JSON.stringify(rev0) === JSON.stringify(rev3) ? "intocado" : "ALTERADO"}`);
  const log3 = await logLote();
  exige("(efeito colateral, verificado no banco)", "event_logs batch_process_completed do lote 3", "payload com os quatro contadores, igual à resposta", quatro(log3) && ["total", "succeeded", "skipped", "failed"].every((k) => log3[k] === bp3.corpo?.[k]), JSON.stringify(log3));

  // ---- Participante: demais ações do dia a dia
  const nps = await http("POST", "/api/nps", {
    headers: { "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    json: { full_name: `${MARCA} Participante A`, nps_score: 9, quality_rating: "bem" },
  });
  const npsLinhas = await rest("GET", `nps_responses?full_name=like.${encodeURIComponent(MARCA + "*")}&select=id`);
  exige(F.a.rotulo, "POST /api/nps (feedback público)", "200 e linha gravada", nps.status === 200 && npsLinhas.length === 1, `${descreve(nps)}; linhas ${npsLinhas.length}`);

  const tok = (await rest("GET", `prognostics?id=eq.${F.prog.id}&select=public_share_token`))[0].public_share_token;
  const st = await http("GET", `/api/prognostic-status/${tok}`, { cookie: F.a.cookie });
  exige(F.a.rotulo, "GET /api/prognostic-status/<token do próprio prognóstico>", "200 com status", st.status === 200 && typeof st.corpo?.status === "string", descreve(st));

  // ---- join-event: retorno e e-mail inédito respondem IGUAL, sem credencial.
  // Antes: C6.19 exigia 200 + que a senha NOVA logasse (isso era a tomada de conta de um
  // participante por quem só soubesse o e-mail) e C6.20 exigia que um e-mail inédito
  // recebesse senha e sessão. Os dois descreviam a vulnerabilidade, e foram reescritos
  // para provar que ela morreu.
  const antesA = await authAdmin("GET", `users/${F.a.userId}`);
  const re = await http("POST", "/api/join-event", { json: { event_id: F.evento.id, event_code: F.evento.event_code, email: F.a.email, full_name: `Participante A ${MARCA}` } });
  const depoisA = await authAdmin("GET", `users/${F.a.userId}`);
  const loginA = await loginDireto(F.a.email, F.a.senha);
  const credRe = vazamentoDeCredencial(re, [F.a.senha]);
  exige(F.a.rotulo, "POST /api/join-event reentrando com o próprio e-mail (participante que volta)", "503 sem credencial; updated_at no GoTrue idêntico; a senha ORIGINAL ainda loga", re.status === 503 && credRe.length === 0 && antesA.updated_at === depoisA.updated_at && loginA === 200, `${resumoHttp(re)}; credencial: ${credRe.join(", ") || "nenhuma"}; updated_at ${antesA.updated_at === depoisA.updated_at ? "idêntico" : `ALTERADO (${antesA.updated_at} -> ${depoisA.updated_at})`}; login com a senha original ${loginA}`);

  const c = `c-${RUN}@${DOMINIO}`;
  const novo = await http("POST", "/api/join-event", { json: { event_id: F.evento.id, event_code: F.evento.event_code, email: c, full_name: `Participante C ${MARCA}` } });
  // Se a rota cria a conta do e-mail inédito, ela precisa ser apagada ao final.
  for (const p of await rest("GET", `participants?email=eq.${encodeURIComponent(c)}&select=user_id`)) if (p.user_id) limpeza.usuarios.push(p.user_id);
  const credNovo = vazamentoDeCredencial(novo);
  exige("PARTICIPANTE-C (e-mail inédito)", "POST /api/join-event com e-mail que nunca entrou", "503 sem credencial e sem Set-Cookie (nenhuma sessão é aberta só porque alguém digitou um e-mail)", novo.status === 503 && credNovo.length === 0, `${resumoHttp(novo)}; credencial: ${credNovo.join(", ") || "nenhuma"}`);
  exige("(oráculo)", "resposta de e-mail inédito x resposta de participante que volta", "idênticas (a rota não revela se o e-mail já existe)", mesmaResposta(novo, re), mesmaResposta(novo, re) ? `idênticas (${novo.status}, ${novo.texto.length} bytes)` : `DIFEREM: ${novo.status} ${JSON.stringify(novo.corpo)} x ${re.status} ${JSON.stringify(re.corpo)}`);
}

// Nome que faz o canário recusar a geração (ver canario-anthropic.mjs).
const MARCADOR_FALHA_CANARIO = "FALHAR-CANARIO";

async function c7() {
  cenario(7, "complete-quiz: só o dono conclui, o servidor confere as etapas, é idempotente e NÃO é porta dos fundos de completed_at");
  const descreve = (r) => descreveBase(r, true); // 2xx aqui é o fluxo legítimo, não "acesso concedido"
  const completedAt = async (id) => (await rest("GET", `participants?id=eq.${id}&select=completed_at`))[0].completed_at;
  const resp = (id, etapas) => rest("POST", "quiz_responses", etapas.map((stage_id) => ({ participant_id: id, stage_id, answers: { q1: "semente" } })));

  const d = await criaParticipante({ chave: "d", rotulo: "PARTICIPANTE-D (dono; vai concluir)", nome: "Participante D", eventoId: F.evento.id });
  const e = await criaParticipante({ chave: "e", rotulo: "PARTICIPANTE-E (outra pessoa, quiz completo, não concluída)", nome: "Participante E", eventoId: F.evento.id });
  const f = await criaParticipante({ chave: "f", rotulo: "PARTICIPANTE-F (sem nenhuma resposta; tenta forçar completed_at)", nome: "Participante F", eventoId: F.evento.id });
  for (const x of [d, e, f]) {
    const s = await sessao(x.email, x.senha);
    if (!s.ok) throw new Error(`setup c7: login de ${x.rotulo} falhou: ${s.erro}`);
    x.cookie = s.cookie;
    x.accessToken = s.accessToken;
  }
  await resp(d.participantId, [1, 2, 3, 4]);
  await resp(e.participantId, [1, 2, 3, 4, 5, 6]);
  const chama = (quem, id) => http("POST", "/api/complete-quiz", { cookie: quem?.cookie, json: { participant_id: id } });

  // Sem sessão.
  const anon = await chama(undefined, d.participantId);
  exige(ANONIMO, "POST /api/complete-quiz {participant_id de D}", "401 e completed_at de D segue nulo", anon.status === 401 && (await completedAt(d.participantId)) === null, `${descreve(anon)}; completed_at ${await completedAt(d.participantId)}`);

  // Corpo inválido.
  const ruim = await http("POST", "/api/complete-quiz", { cookie: d.cookie, json: { participant_id: "isto-nao-e-uuid" } });
  exige(d.rotulo, "POST /api/complete-quiz com participant_id que não é UUID", "400 'Dados inválidos'", ruim.status === 400, descreve(ruim));

  // Concluir em nome de outro: 403 IDÊNTICO ao de id inexistente (senão vira oráculo de ids).
  const emNomeDeE = await chama(d, e.participantId);
  const inexistente = await chama(d, "00000000-0000-4000-8000-0000000000aa");
  exige(d.rotulo, "POST /api/complete-quiz em nome de E (quiz completo!) e de um id inexistente", "ambos 403, resposta IDÊNTICA entre si, e completed_at de E segue nulo", emNomeDeE.status === 403 && inexistente.status === 403 && mesmaResposta(emNomeDeE, inexistente) && (await completedAt(e.participantId)) === null, `em nome de E: ${descreve(emNomeDeE)} | inexistente: ${descreve(inexistente)} | idênticas: ${mesmaResposta(emNomeDeE, inexistente)}; completed_at de E ${await completedAt(e.participantId)}`);

  // Faltando etapas: 409 com a lista, e nada é gravado.
  const falta1 = await chama(d, d.participantId);
  exige(d.rotulo, "POST /api/complete-quiz com as etapas 1-4 respondidas", "409 código etapas_pendentes, lista exata [5,6], completed_at segue nulo", falta1.status === 409 && falta1.corpo?.codigo === "etapas_pendentes" && JSON.stringify(falta1.corpo?.etapas_pendentes) === "[5,6]" && (await completedAt(d.participantId)) === null, `${descreve(falta1)} ${JSON.stringify(falta1.corpo)}`);
  await resp(d.participantId, [5]);
  const falta2 = await chama(d, d.participantId);
  exige(d.rotulo, "POST /api/complete-quiz depois de responder a etapa 5", "409 e a lista encolhe para [6]", falta2.status === 409 && JSON.stringify(falta2.corpo?.etapas_pendentes) === "[6]" && (await completedAt(d.participantId)) === null, `${descreve(falta2)} ${JSON.stringify(falta2.corpo)}`);

  // Participante sem resposta nenhuma: lista as seis. A trava não é "verdade vazia".
  const faltaTudo = await chama(f, f.participantId);
  exige(f.rotulo, "POST /api/complete-quiz sem nenhuma resposta", "409 com as seis etapas pendentes", faltaTudo.status === 409 && JSON.stringify(faltaTudo.corpo?.etapas_pendentes) === "[1,2,3,4,5,6]" && (await completedAt(f.participantId)) === null, `${descreve(faltaTudo)} ${JSON.stringify(faltaTudo.corpo)}`);

  // Dono com todas as etapas: conclui.
  await resp(d.participantId, [6]);
  const ok1 = await chama(d, d.participantId);
  const t1 = await completedAt(d.participantId);
  exige(d.rotulo, "POST /api/complete-quiz com as 6 etapas respondidas", "200 success ja_concluido=false e completed_at gravado", ok1.status === 200 && ok1.corpo?.success === true && ok1.corpo?.ja_concluido === false && !!t1, `${descreve(ok1)} ${JSON.stringify(ok1.corpo)}; completed_at ${t1}`);

  // Segunda chamada: idempotente, não reescreve o instante.
  const ok2 = await chama(d, d.participantId);
  const t2 = await completedAt(d.participantId);
  exige(d.rotulo, "POST /api/complete-quiz de novo (idempotência)", "200 ja_concluido=true e completed_at IDÊNTICO ao da primeira conclusão", ok2.status === 200 && ok2.corpo?.success === true && ok2.corpo?.ja_concluido === true && t2 === t1, `${descreve(ok2)} ${JSON.stringify(ok2.corpo)}; completed_at ${t1} -> ${t2}`);

  // Controle positivo do 403 acima: E, a dona, conclui normalmente. Prova que a recusa de D
  // era por não ser dono, e não porque E não pudesse concluir.
  const eConclui = await chama(e, e.participantId);
  exige(e.rotulo, "POST /api/complete-quiz pela própria dona (controle do 403)", "200 e completed_at gravado", eConclui.status === 200 && eConclui.corpo?.success === true && !!(await completedAt(e.participantId)), `${descreve(eConclui)} ${JSON.stringify(eConclui.corpo)}`);

  // A rota NÃO virou porta dos fundos: o caminho que a migration 014 fechou continua fechado.
  // PATCH direto no PostgREST, com o token do próprio participante e a chave anônima (o que
  // o navegador faz). Controle: na coluna que ele PODE editar o mesmo PATCH funciona, então a
  // recusa abaixo é de privilégio e não de token ruim, URL errada ou RLS.
  const patch = async (coluna, valor) => {
    const res = await fetch(`${SUPA}/rest/v1/participants?id=eq.${f.participantId}`, {
      method: "PATCH",
      headers: { apikey: ANON, authorization: `Bearer ${f.accessToken}`, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ [coluna]: valor }),
    });
    const txt = await res.text();
    let corpo = null;
    try { corpo = JSON.parse(txt); } catch { /* vazio */ }
    return { status: res.status, corpo, txt };
  };
  const nomeNovo = `Participante F editado ${MARCA}`;
  const pOk = await patch("full_name", nomeNovo);
  exige(f.rotulo, "PATCH direto em participants.full_name com o próprio token (controle)", "200 e a linha vem alterada (o participante edita os dados dele)", pOk.status === 200 && Array.isArray(pOk.corpo) && pOk.corpo[0]?.full_name === nomeNovo, `status ${pOk.status} ${pOk.txt.slice(0, 160)}`);
  const pBloq = await patch("completed_at", new Date().toISOString());
  const aindaNulo = (await completedAt(f.participantId)) === null;
  exige(f.rotulo, "PATCH direto em participants.completed_at com o próprio token", "recusado por PRIVILÉGIO (403, código 42501) e completed_at segue nulo", pBloq.status === 403 && pBloq.corpo?.code === "42501" && aindaNulo, `status ${pBloq.status} ${pBloq.txt.slice(0, 200)}; completed_at ${aindaNulo ? "nulo" : "GRAVADO"}`);
  const [outroEvento] = await rest("POST", "events", { name: `${MARCA} outro evento`, event_code: `OUT-${RUN}`.toUpperCase(), event_date: new Date().toISOString(), status: "draft" });
  limpeza.eventos.push(outroEvento.id);
  const pBloqEvento = await patch("event_id", outroEvento.id);
  exige(f.rotulo, "PATCH direto em participants.event_id com o próprio token", "recusado por PRIVILÉGIO (403, código 42501) e a linha continua no evento de origem", pBloqEvento.status === 403 && pBloqEvento.corpo?.code === "42501" && (await rest("GET", `participants?id=eq.${f.participantId}&select=event_id`))[0].event_id === F.evento.id, `status ${pBloqEvento.status} ${pBloqEvento.txt.slice(0, 200)}`);
}

// ================================================================= main
const FUNCOES = { 1: c1, 2: c2, 3: c3, 4: c4, 5: c5, 6: c6, 7: c7 };

let falhaFatal = null;
try {
  await preparaFixtures();
  await c0();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    if (deveRodar(n)) await FUNCOES[n]();
  }
} catch (e) {
  falhaFatal = e;
  console.log(`\n[FAIL] ERRO FATAL (suíte não concluiu; isto NÃO é aprovação): ${e.stack ?? e}`);
} finally {
  await limpa();
}

const falhas = resultados.filter((r) => !r.ok);
const porCenario = {};
for (const r of resultados) {
  porCenario[r.cenario] ??= { total: 0, falhas: 0 };
  porCenario[r.cenario].total += 1;
  if (!r.ok) porCenario[r.cenario].falhas += 1;
}
console.log("\n=== RESUMO");
for (const [c, v] of Object.entries(porCenario)) {
  console.log(`cenário ${c}: ${v.total - v.falhas}/${v.total} verificações ${v.falhas ? "COM FALHA" : "ok"}`);
}
const esperados = ["0", ...[1, 2, 3, 4, 5, 6, 7].filter(deveRodar).map(String)];
const ausentes = esperados.filter((c) => !porCenario[c]);
if (ausentes.length) console.log(`cenários que NÃO produziram nenhuma verificação (vazio = falha): ${ausentes.join(",")}`);
console.log(`total: ${resultados.length} verificações, ${falhas.length} falhas`);
process.exit(falhaFatal || falhas.length || ausentes.length ? 1 : 0);
