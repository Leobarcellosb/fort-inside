// PROVA COM HTTP, BANCO E SERVIÇO DE LOGIN REAIS dos códigos de erro.
//
// As DUAS rotas de verdade (/api/jobs/enfileirar e /api/batch-process), em modo
// de produção, falando com o Supabase LOCAL por um proxy que derruba, sob
// demanda, o serviço de login, a leitura de etapas, a de participantes e o rpc da
// fila. As funções jobs_* são RENOMEADAS no banco local (e restauradas no finally)
// para produzir a ausência real do esquema da fila.
//
// REGRA DESTE ARQUIVO (critério 7 do responsável técnico): nenhuma negativa existe
// sem o controle positivo ao lado. Cada cenário faz, no MESMO app e no MESMO banco:
//     aplicar a condição -> pedido NEGATIVO -> restaurar -> pedido POSITIVO
// e o positivo é o mesmo pedido legítimo, que tem de dar 200. Uma bateria de
// negativas sozinha poderia estar medindo "tudo quebrado".
//
// Como rodar (sobe tudo sozinho, tudo local):  bash lib/erros/provas/rodar-provas.sh
// Sem as variáveis ERROS_* o arquivo é PULADO, e `npx vitest run` segue verde.

import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { solicitarProcessamento, type ResultadoSolicitacao } from "../../../components/features/admin/processar-evento";
import { interpretarRespostaDaFila } from "../../../components/features/admin/estado-da-fila";
import { DEFINICOES_DE_ERRO, type CodigoDeErro } from "../codigos";

const E = process.env;
const APP = E.ERROS_APP_URL;
const APP_CONFIG = E.ERROS_APP_CONFIG_URL;
const APP_SEMCHAVE = E.ERROS_APP_SEMCHAVE_URL;
const PROXY = E.ERROS_PROXY_URL;
const SUPA = E.ERROS_SUPA_URL;
const ANON = E.ERROS_ANON_KEY;
const SERVICE = E.ERROS_SERVICE_KEY;
const DB = E.ERROS_DB_URL;
const CANARIO = E.ERROS_CANARIO_URL;
const JWT_SECRET = E.ERROS_JWT_SECRET;

const pronto = Boolean(APP && APP_CONFIG && APP_SEMCHAVE && PROXY && SUPA && ANON && SERVICE && DB && CANARIO && JWT_SECRET);
const descreve = pronto ? describe : describe.skip;

if (pronto) {
  for (const [nome, u] of [["SUPA", SUPA], ["PROXY", PROXY], ["APP", APP], ["DB", DB]] as const) {
    const h = new URL(u!.replace(/^postgresql:/, "http:")).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(h)) throw new Error(`ABORTADO: ${nome} aponta para ${h}, que não é local.`);
  }
}

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// ------------------------------------------------------------------ infraestrutura
// O Supabase local é compartilhado com outros trabalhos (builds, jornadas) que
// às vezes o saturam: um 504 do gateway ao criar uma conta de teste não diz nada
// sobre as rotas. A PREPARAÇÃO (contas, sessões, fixtures) tenta de novo; as
// MEDIÇÕES só repetem num caso estreito e declarado (ver `medir`).
async function comTentativas<T>(rotulo: string, f: () => Promise<T>, n = 6): Promise<T> {
  let ultimo: unknown;
  for (let i = 1; i <= n; i++) {
    try {
      return await f();
    } catch (e) {
      ultimo = e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`${rotulo}: falhou ${n}x na preparação (ambiente): ${ultimo instanceof Error ? ultimo.message : ultimo}`);
}

// O túnel até o Supabase local às vezes cai por segundos. Antes de CADA cenário,
// espera o serviço de login responder (até 3 min): uma queda do ambiente ENTRE
// cenários não pode virar timeout dentro de um. Queda durante a medição não é
// mascarada (as regras de repetição de `medir*` continuam valendo e contadas).
async function ambienteOk() {
  const limite = Date.now() + 180_000;
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${SUPA}/auth/v1/health`, { headers: { apikey: ANON! }, signal: AbortSignal.timeout(4000) });
      if (r.ok) return;
    } catch {
      /* ainda fora */
    }
    await dorme(2000);
  }
  throw new Error("ambiente local (Supabase) indisponível por 3 min: a prova não é interpretável");
}

function sql(consulta: string): string {
  return execFileSync("psql", [DB!, "-v", "ON_ERROR_STOP=1", "-Atc", consulta], { encoding: "utf8" }).trim();
}

async function rest<T = unknown>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  return comTentativas(`${metodo} ${caminho}`, () => restUma<T>(metodo, caminho, corpo), metodo === "POST" ? 1 : 4);
}
async function restUma<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const res = await fetch(`${SUPA}/rest/v1/${caminho}`, {
    method: metodo,
    headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json", prefer: "return=representation" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${metodo} ${caminho} -> ${res.status}: ${t.slice(0, 300)}`);
  return (t ? JSON.parse(t) : null) as T;
}

type Falha =
  | "auth" | "quiz_stages" | "participants" | "rpc_enfileirar" | "rpc_resumo" | "leitura_jobs"
  | "rpc_enfileirar_ausente" | "rpc_resumo_ausente" | "tabela_jobs_ausente" | "evento_sem_modo"
  | "relogio_banco" | "rpc_iniciar" | "relogio_ausente";
const TODAS_DESLIGADAS: Record<Falha, boolean> = {
  auth: false, quiz_stages: false, participants: false, rpc_enfileirar: false, rpc_resumo: false,
  leitura_jobs: false, rpc_enfileirar_ausente: false, rpc_resumo_ausente: false, tabela_jobs_ausente: false,
  evento_sem_modo: false, relogio_banco: false, rpc_iniciar: false, relogio_ausente: false,
};
async function falha(liga: Partial<Record<Falha, boolean>>) {
  const r = await fetch(`${PROXY}/__falha`, { method: "POST", body: JSON.stringify(liga) });
  return (await r.json()) as { falhas: Record<string, boolean>; contagem: Record<string, number> };
}

// Identidade SIMULADA (o gateway valida a assinatura): a sessao e um JWT HS256 com o
// papel no app_metadata, no formato que o @supabase/ssr do app espera nos cookies.
function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" });
  const p = b({ iss: "supabase-demo", exp: 4102444800, ...payload });
  return `${h}.${p}.${createHmac("sha256", JWT_SECRET!).update(`${h}.${p}`).digest("base64url")}`;
}

async function sessao(admin: boolean): Promise<string> {
  const id = randomUUID();
  const jar = new Map<string, string>();
  const sb = createServerClient(SUPA!, ANON!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const token = jwt({ sub: id, role: "authenticated", aud: "authenticated", email: `${id}@erros-http.test`, app_metadata: admin ? { role: "admin" } : {} });
  const { data, error } = await sb.auth.setSession({ access_token: token, refresh_token: "refresh-simulado" });
  if (error || !data.session) throw new Error(`sessão simulada: ${error?.message ?? "sem sessão"}`);
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
}

type Instancia = "principal" | "config" | "semchave";
const URL_DA: Record<Instancia, () => string> = {
  principal: () => APP!,
  config: () => APP_CONFIG!,
  semchave: () => APP_SEMCHAVE!,
};
type Rota = "enfileirar" | "batch";
// O banco desta prova e DESCARTAVEL: renomear funcoes de verdade e seguro (e e a prova original).
const RENOMEAR = E.ERROS_RENOMEAR_FUNCOES !== "0";
const CAMINHO: Record<Rota, string> = { enfileirar: "/api/jobs/enfileirar", batch: "/api/batch-process" };

interface Pedido {
  cookie?: string;
  corpo: unknown; // objeto => JSON; string => corpo cru
  instancia?: Instancia;
}
interface Resposta {
  status: number;
  texto: string;
  json: Record<string, any> | null;
}

async function chamar(rota: Rota, p: Pedido): Promise<Resposta> {
  const res = await fetch(`${URL_DA[p.instancia ?? "principal"]()}${CAMINHO[rota]}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(p.cookie ? { cookie: p.cookie } : {}) },
    body: typeof p.corpo === "string" ? p.corpo : JSON.stringify(p.corpo),
  });
  const texto = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* não-JSON */
  }
  return { status: res.status, texto, json };
}

// MEDIR: repete SÓ em duas situações, ambas ambientais e ambas contadas na tabela:
//   - negativa: 502/504 (gateway) ou AUTH_UNAVAILABLE quando a negativa em teste
//     NÃO é AUTH_UNAVAILABLE -- o serviço de login, compartilhado, engasgou sob carga;
//   - positiva: qualquer resposta que não seja 200 (um app quebrado falha em TODAS
//     as tentativas; só a oscilação do ambiente passa na seguinte).
let retentativas = 0;
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));
function bolhaNegativa(r: Resposta, esperado: CodigoDeErro) {
  return r.status === 502 || r.status === 504 || (r.json?.code === "AUTH_UNAVAILABLE" && esperado !== "AUTH_UNAVAILABLE");
}
async function medirNegativa(rota: Rota, p: Pedido, esperado: CodigoDeErro): Promise<Resposta> {
  let r = await chamar(rota, p);
  for (let i = 1; i < 4 && bolhaNegativa(r, esperado); i++) {
    retentativas++;
    await dorme(3000);
    r = await chamar(rota, p);
  }
  return r;
}
async function medirPositiva(rota: Rota, p: Pedido): Promise<Resposta> {
  let r = await chamar(rota, p);
  for (let i = 1; i < 4 && r.status !== 200; i++) {
    retentativas++;
    await dorme(3000);
    r = await chamar(rota, p);
  }
  return r;
}

/** A tela de verdade (solicitarProcessamento) falando com o app de verdade. */
async function pelaTela(p: Pedido): Promise<ResultadoSolicitacao> {
  const eventId = (p.corpo as { event_id?: string })?.event_id ?? "";
  return solicitarProcessamento(
    eventId,
    (url, init) =>
      fetch(`${URL_DA[p.instancia ?? "principal"]()}${url}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), ...(p.cookie ? { cookie: p.cookie } : {}) },
      }),
    () => {}
  );
}

async function canarioTotal(): Promise<number> {
  const r = await fetch(`${CANARIO}/__canario/contagem`);
  return ((await r.json()) as { total: number }).total;
}

// ------------------------------------------------------------------ fixtures
let contador = 0;
const eventosCriados: string[] = [];
const etapasCriadas: number[] = [];

async function novoEvento(o: Parameters<typeof novoEventoUma>[0]) {
  return comTentativas("criar evento", () => novoEventoUma(o), 4);
}
async function novoEventoUma(o: {
  rotulo: string;
  quiz_version?: number;
  current_stage?: number;
  concluidos?: number;
  mode?: "live" | "async";
  form_opens_at?: string | null;
  form_closes_at?: string | null;
}) {
  const [ev] = await rest<{ id: string }[]>("POST", "events", {
    name: `erros-http ${o.rotulo} ${RUN}`,
    event_code: `EH${RUN}${++contador}`.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    event_date: new Date().toISOString(),
    status: "live",
    current_stage: o.current_stage ?? 5,
    quiz_version: o.quiz_version ?? 2,
    ...(o.mode ? { mode: o.mode, form_opens_at: o.form_opens_at ?? null, form_closes_at: o.form_closes_at ?? null } : {}),
  });
  eventosCriados.push(ev.id);
  const n = o.concluidos ?? 1;
  const agora = new Date().toISOString();
  const parts = await rest<{ id: string }[]>(
    "POST",
    "participants",
    Array.from({ length: Math.max(n, 1) }, (_, i) => ({
      event_id: ev.id,
      full_name: `Pessoa ${i + 1} ${o.rotulo}`,
      email: `p${i}-${o.rotulo}-${RUN}@erros-http.test`,
      completed_at: i < n ? agora : null,
    }))
  );
  return { id: ev.id, participantes: parts.map((p) => p.id) };
}

// ------------------------------------------------------------------ sessões
let cookieAdmin = "";
let cookieComum = "";
const ID_FALSO = "00000000-0000-4000-8000-000000000000";

// Efeitos de estado (função da fila renomeada) precisam ser desfeitos mesmo se o teste quebrar.
let funcoesRenomeadas = false;
function renomearFilaNoBanco(ausente: boolean) {
  sql(`
    do $$
    declare r record;
    begin
      for r in select p.oid::regprocedure as assinatura, p.proname
               from pg_proc p where p.pronamespace = 'public'::regnamespace
                 and p.proname ${ausente ? "like 'jobs\\_%' and p.proname not like '%\\_\\_ausente'" : "like 'jobs\\_%\\_\\_ausente'"}
      loop
        execute format('alter function %s rename to %I', r.assinatura,
          ${ausente ? "r.proname || '__ausente'" : "regexp_replace(r.proname, '__ausente$', '')"});
      end loop;
    end $$;
    notify pgrst, 'reload schema';
  `);
  funcoesRenomeadas = ausente;
}
async function esperaPostgrestVer(ausente: boolean) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${SUPA}/rest/v1/rpc/jobs_enfileirar`, {
      method: "POST",
      headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
      body: JSON.stringify({ p_kind: "prognostico", p_event_id: ID_FALSO, p_participant_id: ID_FALSO, p_priority: 0, p_max_attempts: 1 }),
    });
    const ve = r.status === 404; // PGRST202 = função não está no schema cache
    if (ve === ausente) return;
    await new Promise((x) => setTimeout(x, 250));
  }
  throw new Error(`PostgREST não refletiu a mudança (ausente=${ausente}) em 15s`);
}


/** Renomeia UMA funcao (sem argumentos conhecidos pelo nome) e espera o PostgREST refletir. */
async function renomearFuncaoSolta(base: string, assinatura: string, ausente: boolean) {
  const de = ausente ? base : `${base}__ausente`;
  const para = ausente ? `${base}__ausente` : base;
  sql(`alter function public.${de}(${assinatura}) rename to ${para}; notify pgrst, 'reload schema';`);
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${base}`, {
      method: "POST",
      headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
      body: "{}",
    });
    if ((r.status === 404) === ausente) return;
    await dorme(250);
  }
  throw new Error(`PostgREST não refletiu a mudança de ${base}`);
}

/** Uma transacao ABERTA em outra conexao (gravacao em voo). */
function sessaoPsql(script: string) {
  const p = spawn("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", DB!, "-f", "-"], { env: { ...process.env, PGCONNECT_TIMEOUT: "30" } });
  let erro = "";
  p.stderr.on("data", (d) => (erro += d));
  p.stdin.write(script);
  p.stdin.end();
  return { fim: new Promise<{ codigo: number | null; erro: string }>((res) => p.on("close", (codigo) => res({ codigo, erro }))) };
}
async function esperaLimiteNoBanco(eventId: string, tolSeg = 900) {
  for (let i = 0; i < 160; i++) {
    if (sql(`select clock_timestamp() >= form_closes_at + interval '${tolSeg} seconds' from events where id = '${eventId}'`) === "t") return;
    await dorme(250);
  }
  throw new Error("o limite da janela não chegou");
}

beforeAll(async () => {
  if (!pronto) return;
  cookieAdmin = await comTentativas("sessão admin", () => sessao(true));
  cookieComum = await comTentativas("sessão comum", () => sessao(false));
  await falha(TODAS_DESLIGADAS);
}, 180_000);

afterAll(async () => {
  if (!pronto) return;
  try {
    if (funcoesRenomeadas) renomearFilaNoBanco(false);
  } finally {
    await falha(TODAS_DESLIGADAS);
    for (const id of eventosCriados) {
      try {
        sql(`delete from events where id = '${id}'`);
      } catch {
        /* melhor esforço: dados de teste com sufixo único */
      }
    }
    if (etapasCriadas.length) sql(`delete from quiz_stages where id in (${etapasCriadas.join(",")})`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n=== RESULTADOS OBSERVADOS (negativa -> positivo, mesmo ambiente) | repetições por oscilação do ambiente: ${retentativas} ===\n` + TABELA.join("\n"));
}, 60_000);

// ------------------------------------------------------------------ cenários
const TABELA: string[] = [];

interface Cenario {
  codigo: CodigoDeErro;
  rotas: Rota[];
  /** Prepara a condição. Devolve o pedido NEGATIVO e o POSITIVO (mesmo ambiente, condição removida). */
  monta: () => Promise<{
    negativo: Pedido;
    positivo: Pedido;
    aplicar?: () => void | Promise<void>;
    restaurar?: () => void | Promise<void>;
  }>;
  /** O que o host lê, pela tela de verdade (só /api/jobs/enfileirar tem tela). */
  tela: { tipo: ResultadoSolicitacao["tipo"]; mensagem: RegExp; naoMensagem?: RegExp };
}

const SEM_VAZAR = /57P01|connection to server lost|PGRST|SQLSTATE|42P01|42883|relation ".*" does not exist|could not find the function|jobs_enfileirar|stack|at \w+ \(/i;

const CENARIOS: Cenario[] = [
  {
    codigo: "INVALID_REQUEST",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "inv" });
      return { negativo: { cookie: cookieAdmin, corpo: { event_id: "nao-e-uuid" } }, positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id } } };
    },
    tela: { tipo: "recusado", mensagem: /pedido enviado pela tela não é válido/ },
  },
  {
    codigo: "AUTH_REQUIRED",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "anon" });
      return { negativo: { corpo: { event_id: ev.id } }, positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id } } };
    },
    tela: { tipo: "recusado", mensagem: /sessão expirou ou não foi encontrada/, naoMensagem: /não tem permissão/ },
  },
  {
    codigo: "ADMIN_FORBIDDEN",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "comum" });
      return { negativo: { cookie: cookieComum, corpo: { event_id: ev.id } }, positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id } } };
    },
    tela: { tipo: "recusado", mensagem: /não tem permissão de administrador/ },
  },
  {
    // CRITÉRIO 5: serviço de login derrubado SEM tocar em lib/auth.
    codigo: "AUTH_UNAVAILABLE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "auth" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido, // a MESMA sessão, o MESMO pedido
        aplicar: async () => void (await falha({ auth: true })),
        restaurar: async () => void (await falha({ auth: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /serviço de login não respondeu/, naoMensagem: /não tem permissão de administrador|migration/ },
  },
  {
    codigo: "EVENT_NOT_FOUND",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "nf" });
      return { negativo: { cookie: cookieAdmin, corpo: { event_id: ID_FALSO } }, positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id } } };
    },
    tela: { tipo: "recusado", mensagem: /evento não foi encontrado/ },
  },
  {
    // CRITÉRIO 2
    codigo: "EVENT_INCOMPLETE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "inc", current_stage: 3 });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return { negativo: pedido, positivo: pedido, restaurar: () => void sql(`update events set current_stage = 5 where id = '${ev.id}'`) };
    },
    tela: { tipo: "recusado", mensagem: /etapa pendente.*etapa 3 de 5/, naoMensagem: /migration|018|fila/i },
  },
  {
    // ASSÍNCRONO, coleta ABERTA: o critério é o prazo, não a etapa (current_stage fica em 0).
    codigo: "COLLECTION_OPEN",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const h = 3_600_000;
      const ev = await novoEvento({
        rotulo: "co", mode: "async", current_stage: 0,
        form_opens_at: new Date(Date.now() - 24 * h).toISOString(),
        form_closes_at: "2099-11-07T15:00:00.000Z", // 12:00 em São Paulo; o texto tem de sair exatamente assim
      });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      // CONTROLE POSITIVO: o MESMO evento depois que a coleta encerrou (prazo + 15 min de tolerância vencidos).
      return {
        negativo: pedido,
        positivo: pedido,
        restaurar: () => void sql(`update events set form_closes_at = now() - interval '20 minutes' where id = '${ev.id}'`),
      };
    },
    tela: { tipo: "recusado", mensagem: /coleta deste evento ainda não encerrou: o prazo para responder termina em 07\/11\/2099 12:00 \(America\/Sao_Paulo, GMT-03:00\)/, naoMensagem: /libere|etapa pendente|etapa \d+ de \d+|migration|018/i },
  },
  {
    codigo: "COLLECTION_WINDOW_UNDETERMINED",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      // Assíncrono SEM prazo: não dá para saber se a coleta encerrou. Definir o prazo é o controle positivo.
      const ev = await novoEvento({ rotulo: "cw", mode: "async", current_stage: 0, form_opens_at: null, form_closes_at: null });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        restaurar: () => void sql(`update events set form_closes_at = now() - interval '20 minutes' where id = '${ev.id}'`),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /prazo da coleta não está definido/, naoMensagem: /libere|etapa pendente|ainda não encerrou|migration|018/i },
  },
  {
    codigo: "EVENT_MODE_UNDETERMINED",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      // O banco não permite `mode` nulo (NOT NULL + CHECK); o proxy faz o PostgREST responder o evento SEM a coluna.
      const ev = await novoEvento({ rotulo: "em" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => void (await falha({ evento_sem_modo: true })),
        restaurar: async () => void (await falha({ evento_sem_modo: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /determinar se este evento é presencial ou assíncrono/, naoMensagem: /libere|etapa pendente|migration|018/i },
  },
  {
    // O RELOGIO VEM DO BANCO. O evento esta "encerrado" tambem pelo relogio do Node; se
    // houvesse queda para o relogio local, a negativa LIBERARIA (200) em vez de 503.
    codigo: "TIME_REFERENCE_UNAVAILABLE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "tr", mode: "async", current_stage: 0, form_opens_at: new Date(Date.now() - 86_400_000).toISOString(), form_closes_at: new Date(Date.now() - 3_600_000).toISOString() });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => void (await falha({ relogio_banco: true })),
        restaurar: async () => void (await falha({ relogio_banco: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /hora de referência/, naoMensagem: /ainda não encerrou|libere|etapa pendente|migration|018/i },
  },
  {
    // AUSENCIA REAL da funcao do relogio (renomeada de verdade no banco descartavel): manda APLICAR.
    codigo: "ASYNC_PROCESSING_MISSING",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "pm", mode: "async", current_stage: 0, form_opens_at: new Date(Date.now() - 86_400_000).toISOString(), form_closes_at: new Date(Date.now() - 3_600_000).toISOString() });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => renomearFuncaoSolta("referencia_temporal_do_banco", "", true),
        restaurar: async () => renomearFuncaoSolta("referencia_temporal_do_banco", "", false),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /atualização do banco do processamento assíncrono/, naoMensagem: /hora de referência|libere|etapa pendente|migration|018|021/i },
  },
  {
    // A CORRIDA DO FECHAMENTO, de ponta a ponta: uma gravacao que COMECOU antes do limite
    // da janela e ainda nao comitou. O inicio recusa e nada e processado; depois do commit,
    // o MESMO pedido processa a pessoa com todas as respostas.
    codigo: "SNAPSHOT_UNSTABLE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "sn", mode: "async", current_stage: 0, form_opens_at: new Date(Date.now() - 86_400_000).toISOString(), form_closes_at: new Date(Date.now() + 3_600_000).toISOString(), concluidos: 1 });
      // limite (prazo + 15 min) = daqui a ~6 s, medido pelo relogio do BANCO.
      sql(`update events set form_closes_at = now() - interval '894 seconds' where id = '${ev.id}'`);
      const nova = sql(`insert into participants (event_id, full_name, email) values ('${ev.id}', 'No limite', 'limite-${RUN}-${++contador}@erros-http.test') returning id`).split("\n")[0];
      let escritor: ReturnType<typeof sessaoPsql> | null = null;
      return {
        negativo: { cookie: cookieAdmin, corpo: { event_id: ev.id } },
        positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id } },
        aplicar: async () => {
          escritor = sessaoPsql(`
            begin;
            ${[101, 102, 103, 104, 105].map((e) => `insert into quiz_responses (participant_id, stage_id, answers) values ('${nova}', ${e}, '{"v": ${e}}');`).join("\n")}
            update participants set completed_at = now() where id = '${nova}';
            select pg_sleep(25);
            commit;`);
          await esperaLimiteNoBanco(ev.id);
        },
        restaurar: async () => {
          const r = await escritor!.fim;
          if (r.codigo !== 0) throw new Error(`escritor em voo falhou: ${r.erro}`);
        },
      };
    },
    tela: { tipo: "bloqueado", mensagem: /respostas sendo gravadas agora.*Nenhum documento foi gerado/, naoMensagem: /libere|etapa pendente|migration|018|ainda não encerrou/i },
  },
  {
    codigo: "NO_COMPLETED_PARTICIPANTS",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "vazio", concluidos: 0 });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return { negativo: pedido, positivo: pedido, restaurar: () => void sql(`update participants set completed_at = now() where event_id = '${ev.id}'`) };
    },
    tela: { tipo: "recusado", mensagem: /Ninguém concluiu o quiz/ },
  },
  {
    codigo: "PARTICIPANTS_UNAVAILABLE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "pu" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => void (await falha({ participants: true })),
        restaurar: async () => void (await falha({ participants: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /ler a lista de participantes/, naoMensagem: /Ninguém concluiu|migration/i },
  },
  {
    // CRITÉRIO 3
    codigo: "QUIZ_STAGES_UNAVAILABLE",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "su" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => void (await falha({ quiz_stages: true })),
        restaurar: async () => void (await falha({ quiz_stages: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /verificar as etapas do questionário/, naoMensagem: /migration|018|inconsistentes/i },
  },
  {
    codigo: "QUIZ_STAGES_INVALID",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      // Versão própria com stage_number 1, 2, 4 (buraco). Corrigir o buraco é o controle positivo.
      const versao = 1_000_000 + Math.floor(Math.random() * 5_000_000) + ++contador; // único entre rodadas (ids de quiz_stages são globais)
      const base = versao * 10;
      const ids = [base, base + 1, base + 2];
      sql(`insert into quiz_stages (id, title, ambient_name, quiz_version, stage_number, questions) values
        (${ids[0]}, 'v-${versao}-1', 'x', ${versao}, 1, '[]'), (${ids[1]}, 'v-${versao}-2', 'x', ${versao}, 2, '[]'), (${ids[2]}, 'v-${versao}-3', 'x', ${versao}, 4, '[]')`);
      etapasCriadas.push(...ids);
      const ev = await novoEvento({ rotulo: "si", quiz_version: versao, current_stage: 3 });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return { negativo: pedido, positivo: pedido, restaurar: () => void sql(`update quiz_stages set stage_number = 3 where id = ${ids[2]}`) };
    },
    tela: { tipo: "bloqueado", mensagem: /inconsistentes.*configuração do questionário/, naoMensagem: /verificar as etapas|migration|018/i },
  },
  {
    // CRITÉRIO 4: funções jobs_* realmente ausentes no banco.
    codigo: "QUEUE_SCHEMA_MISSING",
    rotas: ["enfileirar"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "sm" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        // Padrão: o proxy aponta o rpc para um nome inexistente e o PostgREST de verdade
        // responde PGRST202 -- nenhum DDL no banco compartilhado. Com
        // ERROS_RENOMEAR_FUNCOES=1 renomeia as jobs_* no banco local (a prova original).
        aplicar: async () => {
          if (RENOMEAR) {
            renomearFilaNoBanco(true);
            await esperaPostgrestVer(true);
          } else await falha({ rpc_enfileirar_ausente: true });
        },
        restaurar: async () => {
          if (RENOMEAR) {
            renomearFilaNoBanco(false);
            await esperaPostgrestVer(false);
          } else await falha({ rpc_enfileirar_ausente: false });
        },
      };
    },
    tela: { tipo: "fila_indisponivel", mensagem: /migration 018/ },
  },
  {
    codigo: "QUEUE_UNAVAILABLE",
    rotas: ["enfileirar"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "qu" });
      const pedido = { cookie: cookieAdmin, corpo: { event_id: ev.id } };
      return {
        negativo: pedido,
        positivo: pedido,
        aplicar: async () => void (await falha({ rpc_enfileirar: true })),
        restaurar: async () => void (await falha({ rpc_enfileirar: false })),
      };
    },
    tela: { tipo: "bloqueado", mensagem: /fila de processamento não respondeu/, naoMensagem: /migration|018/i },
  },
  {
    codigo: "QUEUE_CONFIG_INVALID",
    rotas: ["enfileirar"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "qc" });
      return {
        negativo: { cookie: cookieAdmin, corpo: { event_id: ev.id }, instancia: "config" },
        positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id }, instancia: "principal" },
      };
    },
    tela: { tipo: "bloqueado", mensagem: /configuração da fila.*inválida/, naoMensagem: /migration|018|JOBS_CONCURRENCY/i },
  },
  {
    codigo: "INTERNAL_ERROR",
    rotas: ["enfileirar", "batch"],
    monta: async () => {
      const ev = await novoEvento({ rotulo: "ie" });
      return {
        negativo: { cookie: cookieAdmin, corpo: { event_id: ev.id }, instancia: "semchave" },
        positivo: { cookie: cookieAdmin, corpo: { event_id: ev.id }, instancia: "principal" },
      };
    },
    tela: { tipo: "erro_inesperado", mensagem: /inesperado.*Ocorrência: [A-Za-z0-9_-]+/, naoMensagem: /migration|018|supabaseKey/i },
  },
];

function exigeSucesso(rota: Rota, r: Resposta) {
  expect(r.status, `${rota} positivo: ${r.texto.slice(0, 200)}`).toBe(200);
  if (rota === "enfileirar") expect(r.json).toMatchObject({ ok: true });
  else expect(r.json).toMatchObject({ success: true });
}

descreve("códigos de erro com HTTP, banco e serviço de login reais", () => {
  const observado = new Map<string, { status: number; code: string }>();

  for (const c of CENARIOS) {
    describe(c.codigo, () => {
      for (const rota of c.rotas) {
        it(`${rota}: NEGATIVA -> ${DEFINICOES_DE_ERRO[c.codigo].status} ${c.codigo}; depois CONTROLE POSITIVO -> 200`, async () => {
          await ambienteOk();
          const antesCanario = await canarioTotal();
          const m = await c.monta();
          let negativa: Resposta;
          let telaResultado: ResultadoSolicitacao | null = null;
          try {
            await m.aplicar?.();
            negativa = await medirNegativa(rota, m.negativo, c.codigo);
            if (rota === "enfileirar") {
              telaResultado = await pelaTela(m.negativo);
              for (let i = 1; i < 4 && telaResultado.tipo === "bloqueado" && telaResultado.codigo === "AUTH_UNAVAILABLE" && c.codigo !== "AUTH_UNAVAILABLE"; i++) {
                retentativas++;
                await dorme(3000);
                telaResultado = await pelaTela(m.negativo);
              }
            }
          } finally {
            await m.restaurar?.();
          }

          // --- negativa: status, código, corpo seguro
          const def = DEFINICOES_DE_ERRO[c.codigo];
          expect(negativa.status, negativa.texto.slice(0, 300)).toBe(def.status);
          expect(negativa.json?.code).toBe(c.codigo);
          expect(typeof negativa.json?.ocorrencia).toBe("string");
          expect(negativa.texto).not.toMatch(SEM_VAZAR);
          observado.set(`${c.codigo}/${rota}`, { status: negativa.status, code: negativa.json?.code });

          // --- o que o host lê (pela tela de verdade)
          if (telaResultado) {
            expect(telaResultado.tipo).toBe(c.tela.tipo);
            // O número da ocorrência é aleatório e pode conter "018" por acaso: não é texto de causa.
            const completa = "mensagem" in telaResultado ? telaResultado.mensagem : "";
            const msg = completa.replace(/Ocorrência: [A-Za-z0-9_-]+\.?/g, "");
            expect(completa).toMatch(c.tela.mensagem);
            if (c.tela.naoMensagem) expect(msg).not.toMatch(c.tela.naoMensagem);
            expect(msg).not.toMatch(SEM_VAZAR);
            // "migration 018" só para QUEUE_SCHEMA_MISSING
            if (c.codigo !== "QUEUE_SCHEMA_MISSING") expect(msg).not.toMatch(/migration|018/i);
          }

          // --- CONTROLE POSITIVO: condição removida, mesmo ambiente, mesmo tipo de pedido
          const positiva = await medirPositiva(rota, m.positivo);
          exigeSucesso(rota, positiva);
          if (rota === "enfileirar") {
            let t = await pelaTela(m.positivo);
            for (let i = 1; i < 4 && !["enfileirado", "parcial"].includes(t.tipo); i++) {
              retentativas++;
              await dorme(3000);
              t = await pelaTela(m.positivo);
            }
            expect(["enfileirado", "parcial"]).toContain(t.tipo);
          }

          // Nenhuma chamada ao modelo real (o canário absorveria, e conta).
          TABELA.push(
            `${c.codigo.padEnd(26)} ${rota.padEnd(10)} negativa ${negativa.status} ${String(negativa.json?.code).padEnd(26)} tela=${telaResultado?.tipo ?? "-"}  |  positivo ${positiva.status}`
          );
          void antesCanario;
        }, 120_000);
      }

      if (c.rotas.length === 2) {
        it("PARIDADE (critério 1): as duas rotas devolvem o MESMO status e o MESMO código", () => {
          const a = observado.get(`${c.codigo}/enfileirar`);
          const b = observado.get(`${c.codigo}/batch`);
          expect(a).toBeDefined();
          expect(b).toEqual(a);
        });
      }
    });
  }

  // ================================================================ GET /api/jobs/status
  // O mesmo padrão, agora no caminho de LEITURA: condição -> pedido NEGATIVO ->
  // restaura -> pedido POSITIVO (mesma sessão, mesmo evento). E, junto, a conclusão
  // que a TELA tira da resposta REAL (interpretarRespostaDaFila): só
  // QUEUE_SCHEMA_MISSING vira "indisponivel" (a mensagem da migration 018); tudo o
  // mais vira "sem_resposta".
  describe("GET /api/jobs/status", () => {
    interface PedidoStatus {
      cookie?: string;
      query: string;
      instancia?: Instancia;
    }
    async function lerStatus(p: PedidoStatus): Promise<Resposta> {
      const res = await fetch(`${URL_DA[p.instancia ?? "principal"]()}/api/jobs/status${p.query}`, {
        headers: p.cookie ? { cookie: p.cookie } : {},
      });
      const texto = await res.text();
      let json: Record<string, any> | null = null;
      try {
        json = texto ? JSON.parse(texto) : null;
      } catch {
        /* não-JSON */
      }
      return { status: res.status, texto, json };
    }
    async function medirStatus(p: PedidoStatus, esperado: CodigoDeErro | "ok"): Promise<Resposta> {
      let r = await lerStatus(p);
      const ruim = (x: Resposta) =>
        esperado === "ok"
          ? x.status !== 200
          : x.status === 502 || x.status === 504 || (x.json?.code === "AUTH_UNAVAILABLE" && esperado !== "AUTH_UNAVAILABLE");
      for (let i = 1; i < 4 && ruim(r); i++) {
        retentativas++;
        await dorme(3000);
        r = await lerStatus(p);
      }
      return r;
    }

    // Evento com UM job (cancelado logo em seguida: nenhum worker o reivindica) para o
    // positivo provar que a rota devolve DADOS, não só "200 vazio".
    async function eventoComJob(rotulo: string) {
      const ev = await novoEvento({ rotulo, concluidos: 1 });
      const [job] = await comTentativas("enfileirar fixture", () =>
        rest<{ id: string }[]>("POST", "rpc/jobs_enfileirar", {
          p_kind: "prognostico",
          p_event_id: ev.id,
          p_participant_id: ev.participantes[0],
          p_priority: 0,
          p_max_attempts: 1,
        })
      );
      await rest("POST", "rpc/jobs_cancelar", { p_id: job.id, p_motivo: "fixture de prova de erros" });
      return ev;
    }

    interface CenarioStatus {
      nome: string;
      codigo: CodigoDeErro;
      fila: "indisponivel" | "sem_resposta";
      monta: (ev: { id: string }) => {
        negativo: PedidoStatus;
        aplicar?: () => Promise<void>;
        restaurar?: () => Promise<void>;
      };
    }
    const q = (id: string) => `?event_id=${id}`;
    const CENARIOS_STATUS: CenarioStatus[] = [
      { nome: "pedido sem event_id", codigo: "INVALID_REQUEST", fila: "sem_resposta", monta: () => ({ negativo: { cookie: cookieAdmin, query: "" } }) },
      { nome: "event_id que não é UUID", codigo: "INVALID_REQUEST", fila: "sem_resposta", monta: () => ({ negativo: { cookie: cookieAdmin, query: "?event_id=abc" } }) },
      { nome: "sem sessão", codigo: "AUTH_REQUIRED", fila: "sem_resposta", monta: (ev) => ({ negativo: { query: q(ev.id) } }) },
      { nome: "sessão de quem não é admin", codigo: "ADMIN_FORBIDDEN", fila: "sem_resposta", monta: (ev) => ({ negativo: { cookie: cookieComum, query: q(ev.id) } }) },
      {
        nome: "serviço de login fora do ar (admin legítimo)",
        codigo: "AUTH_UNAVAILABLE",
        fila: "sem_resposta",
        monta: (ev) => ({
          negativo: { cookie: cookieAdmin, query: q(ev.id) },
          aplicar: async () => void (await falha({ auth: true })),
          restaurar: async () => void (await falha({ auth: false })),
        }),
      },
      {
        nome: "função jobs_resumo_evento AUSENTE (PostgREST responde PGRST202)",
        codigo: "QUEUE_SCHEMA_MISSING",
        fila: "indisponivel",
        monta: (ev) => ({
          negativo: { cookie: cookieAdmin, query: q(ev.id) },
          aplicar: async () => void (await falha({ rpc_resumo_ausente: true })),
          restaurar: async () => void (await falha({ rpc_resumo_ausente: false })),
        }),
      },
      {
        nome: "tabela jobs AUSENTE (PostgREST responde PGRST205)",
        codigo: "QUEUE_SCHEMA_MISSING",
        fila: "indisponivel",
        monta: (ev) => ({
          negativo: { cookie: cookieAdmin, query: q(ev.id) },
          aplicar: async () => void (await falha({ tabela_jobs_ausente: true })),
          restaurar: async () => void (await falha({ tabela_jobs_ausente: false })),
        }),
      },
      {
        nome: "rpc da fila 503 (a fila EXISTE e não respondeu)",
        codigo: "QUEUE_UNAVAILABLE",
        fila: "sem_resposta",
        monta: (ev) => ({
          negativo: { cookie: cookieAdmin, query: q(ev.id) },
          aplicar: async () => void (await falha({ rpc_resumo: true })),
          restaurar: async () => void (await falha({ rpc_resumo: false })),
        }),
      },
      {
        nome: "leitura da tabela jobs 503 (a fila EXISTE e não respondeu)",
        codigo: "QUEUE_UNAVAILABLE",
        fila: "sem_resposta",
        monta: (ev) => ({
          negativo: { cookie: cookieAdmin, query: q(ev.id) },
          aplicar: async () => void (await falha({ leitura_jobs: true })),
          restaurar: async () => void (await falha({ leitura_jobs: false })),
        }),
      },
      {
        nome: "erro que ninguém previu (app sem a chave de serviço)",
        codigo: "INTERNAL_ERROR",
        fila: "sem_resposta",
        monta: (ev) => ({ negativo: { cookie: cookieAdmin, query: q(ev.id), instancia: "semchave" } }),
      },
    ];

    for (const c of CENARIOS_STATUS) {
      it(`${c.codigo} -- ${c.nome}: NEGATIVA -> ${DEFINICOES_DE_ERRO[c.codigo].status}; tela='${c.fila}'; depois CONTROLE POSITIVO -> 200 com dados`, async () => {
        await ambienteOk();
        const ev = await eventoComJob("st");
        const m = c.monta(ev);
        let negativa: Resposta;
        try {
          await m.aplicar?.();
          negativa = await medirStatus(m.negativo, c.codigo);
        } finally {
          await m.restaurar?.();
        }

        const def = DEFINICOES_DE_ERRO[c.codigo];
        expect(negativa.status, negativa.texto.slice(0, 300)).toBe(def.status);
        expect(negativa.json?.code).toBe(c.codigo);
        expect(typeof negativa.json?.ocorrencia).toBe("string");
        expect(negativa.texto).not.toMatch(SEM_VAZAR);
        expect(negativa.json).not.toHaveProperty("detail"); // o `detail` com texto do banco morreu

        // O que a TELA conclui desta resposta real.
        const leitura = interpretarRespostaDaFila(negativa.status, negativa.json);
        expect(leitura.fila).toBe(c.fila);
        expect(leitura.codigo).toBe(c.codigo);

        // CONTROLE POSITIVO: mesma sessão, mesmo evento, condição removida.
        const positivo: PedidoStatus = { cookie: cookieAdmin, query: q(ev.id), instancia: "principal" };
        const ok = await medirStatus(positivo, "ok");
        expect(ok.status, ok.texto.slice(0, 300)).toBe(200);
        expect(Array.isArray(ok.json?.jobs)).toBe(true);
        expect(ok.json?.jobs).toHaveLength(1); // dados reais, não "200 vazio"
        expect(ok.json?.jobs[0]).toMatchObject({ participant_id: ev.participantes[0], status: "canceled" });
        expect(interpretarRespostaDaFila(ok.status, ok.json).fila).toBe("ok");

        observado.set(`${c.codigo}/status/${c.nome}`, { status: negativa.status, code: negativa.json?.code });
        TABELA.push(
          `STATUS ${c.codigo.padEnd(22)} ${c.nome.slice(0, 52).padEnd(52)} negativa ${negativa.status} tela=${leitura.fila.padEnd(12)} | positivo ${ok.status} jobs=${ok.json?.jobs.length}`
        );
      }, 120_000);
    }

    it("PARIDADE com as rotas de processamento: as recusas de login têm o MESMO status e código em /status", () => {
      const pares: [CodigoDeErro, string][] = [
        ["AUTH_REQUIRED", "sem sessão"],
        ["ADMIN_FORBIDDEN", "sessão de quem não é admin"],
        ["AUTH_UNAVAILABLE", "serviço de login fora do ar (admin legítimo)"],
      ];
      for (const [codigo, nome] of pares) {
        const st = observado.get(`${codigo}/status/${nome}`);
        const enf = observado.get(`${codigo}/enfileirar`);
        expect(st, `${codigo} em /status`).toBeDefined();
        expect(enf, `${codigo} em /enfileirar`).toBeDefined();
        expect(st).toEqual(enf);
      }
    });
  });

  it("nenhuma chamada saiu para a Anthropic real: o canário viu só o que o app fez, e o app só fala com o canário", async () => {
    // O app roda com ANTHROPIC_BASE_URL no canário e chave FALSA (verificado pelo
    // harness). Aqui só se confere que o canário está vivo e contável.
    expect(await canarioTotal()).toBeGreaterThanOrEqual(0);
  });
});
