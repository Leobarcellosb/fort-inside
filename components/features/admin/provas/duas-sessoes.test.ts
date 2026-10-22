// TESTE DAS DUAS SESSÕES ADMINISTRATIVAS
//
// Exigência do responsável técnico: um administrador solicita o processamento e
// fecha a página; outro administrador (OUTRA conta, OUTRA sessão) abre o mesmo
// evento e encontra exatamente os mesmos jobs e resultados. Se o histórico
// desaparecer entre as sessões, a entrega reprova.
//
// Este teste é o JUIZ, e suas asserções NÃO foram afrouxadas.
//   - Histórico: com o botão ligado ao LOTE (/api/batch-process) o critério "B vê o
//     que A viu" REPROVAVA (o resultado por pessoa só existia na memória da página
//     de A). Foi esse vermelho que decidiu trocar o botão.
//   - Agora: o botão chama `solicitarProcessamento` (processar-evento.ts), que só
//     enfileira em /api/jobs/enfileirar. O MESMO critério, com as MESMAS asserções,
//     é aplicado a esse fluxo e aprova.
//   - O lote segue exercitado no último teste, só como COMPARAÇÃO HISTÓRICA: ele
//     afirma que o lote continua perdendo o histórico (por isso foi descontinuado).
//
// Também cobre, em execução real, os critérios de aprovação 1 a 8 (ver cada `it`).
//
// "Fechar a página" = descartar tudo o que a sessão A guardava em memória (a rodada
// do lote classificada pela tela). O que sobrar é só o que está no banco.
//
// Como rodar (tudo LOCAL; recusa qualquer outro host):
//   1. Suba o app com a Anthropic apontada para um canal morto, por exemplo:
//        ANTHROPIC_BASE_URL=http://127.0.0.1:9 ANTHROPIC_API_KEY=sk-teste npx next dev -p 3100
//      (os participantes do cenário falham ou são recusados ANTES de qualquer chamada
//      ao modelo, e mesmo assim o servidor não alcança a Anthropic real).
//   2. DUAS_SESSOES_APP_URL=http://localhost:3100 \
//      DUAS_SESSOES_SUPA_URL=http://127.0.0.1:54731 \
//      DUAS_SESSOES_ANON_KEY=... DUAS_SESSOES_SERVICE_KEY=... \
//      DUAS_SESSOES_SEM_IA=1 \
//      DUAS_SESSOES_DB_CONTAINER=supabase_db_fort-inside   (opcional: liga o critério 8) \
//      npx vitest run components/features/admin/provas/duas-sessoes.test.ts
//
// Sem as variáveis o arquivo é PULADO (e `npx vitest run` segue verde). Pular é
// explícito: um teste de integração que finge ser verde sem servidor seria pior
// que não existir.

import { createServerClient } from "@supabase/ssr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyBatch, type PrognosticSnapshot } from "../classificar-lote";
import { solicitarProcessamento, type Fetcher, type ResultadoSolicitacao } from "../processar-evento";
import {
  montarSituacao,
  type LinhaDocumento,
  type LinhaJob,
  type ResultadoLote,
} from "../situacao-prognostico";

const APP = process.env.DUAS_SESSOES_APP_URL;
const SUPA = process.env.DUAS_SESSOES_SUPA_URL;
const ANON = process.env.DUAS_SESSOES_ANON_KEY;
const SERVICE = process.env.DUAS_SESSOES_SERVICE_KEY;
const SEM_IA = process.env.DUAS_SESSOES_SEM_IA === "1";

const pronto = Boolean(APP && SUPA && ANON && SERVICE && SEM_IA);
const descreve = pronto ? describe : describe.skip;

if (pronto) {
  const host = new URL(SUPA!).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error(`ABORTADO: DUAS_SESSOES_SUPA_URL aponta para ${host}, que não é local.`);
  }
}

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- infraestrutura
async function rest<T = unknown>(
  metodo: string,
  caminho: string,
  corpo?: unknown,
  token?: string
): Promise<T> {
  const res = await fetch(`${SUPA}/rest/v1/${caminho}`, {
    method: metodo,
    headers: {
      apikey: token ? ANON! : SERVICE!,
      authorization: `Bearer ${token ?? SERVICE}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${metodo} ${caminho} -> ${res.status}: ${texto.slice(0, 300)}`);
  return (texto ? JSON.parse(texto) : null) as T;
}

interface Sessao {
  userId: string;
  accessToken: string;
  cookie: string;
}

async function criarAdmin(rotulo: string): Promise<{ email: string; senha: string; userId: string }> {
  const email = `admin-${rotulo}-${RUN}@duas-sessoes.test`;
  const senha = `Tst-${crypto.randomUUID()}`;
  const res = await fetch(`${SUPA}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: senha, email_confirm: true, app_metadata: { role: "admin" } }),
  });
  if (!res.ok) throw new Error(`criar admin ${rotulo}: ${res.status}`);
  const u = (await res.json()) as { id: string };
  return { email, senha, userId: u.id };
}

// Login real e cookie no formato exato que o @supabase/ssr do app espera.
async function entrar(email: string, senha: string): Promise<Sessao> {
  const jar = new Map<string, string>();
  const sb = createServerClient(SUPA!, ANON!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (lista) => lista.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) throw new Error(`login: ${error?.message ?? "sem sessão"}`);
  return {
    userId: data.user.id,
    accessToken: data.session.access_token,
    cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
  };
}

async function api(sessao: Sessao, metodo: string, caminho: string, corpo?: unknown) {
  const res = await fetch(`${APP}${caminho}`, {
    method: metodo,
    headers: { cookie: sessao.cookie, "content-type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  let json: unknown = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

// ---------------------------------------------------------------- cenário
interface Cenario {
  eventId: string;
  pessoas: { id: string; nome: string; quizConcluido: boolean }[];
}

async function semearEvento(rotulo: string): Promise<Cenario> {
  const [ev] = await rest<{ id: string }[]>("POST", "events", {
    name: `duas-sessoes ${rotulo} ${RUN}`,
    event_code: `DS${rotulo}${RUN}`.toUpperCase().slice(0, 12),
    event_date: new Date().toISOString(),
    status: "live",
    current_stage: 6,
    quiz_version: 2,
  });
  const agora = new Date().toISOString();
  const quem = [
    { nome: "Ana Entregue", doc: "delivered" },
    { nome: "Bruno Sem Respostas", doc: null }, // falha ANTES da IA (quiz sem respostas)
    { nome: "Carla Em Revisao", doc: "in_review" },
    { nome: "Diego Sem Respostas", doc: null },
  ];
  const parts = await rest<{ id: string; full_name: string }[]>(
    "POST",
    "participants",
    quem.map((q, i) => ({
      event_id: ev.id,
      full_name: q.nome,
      email: `p${i}-${rotulo}-${RUN}@duas-sessoes.test`,
      completed_at: agora,
    }))
  );
  const porNome = new Map(parts.map((p) => [p.full_name, p.id]));
  const comDoc = quem.filter((q) => q.doc);
  await rest(
    "POST",
    "prognostics",
    comDoc.map((q) => ({
      participant_id: porNome.get(q.nome),
      raw_ai_output: {},
      status: q.doc,
      generated_at: agora,
    }))
  );
  return {
    eventId: ev.id,
    pessoas: parts.map((p) => ({ id: p.id, nome: p.full_name, quizConcluido: true })),
  };
}

// ---------------------------------------------------------------- o que UMA página enxerga
// É a mesma leitura que SituacaoPrognosticos faz: jobs pela rota do app, documentos
// pelo PostgREST com o token DA SESSÃO, e a mesma função pura de montagem.
async function lerDocumentos(sessao: Sessao, ids: string[]): Promise<LinhaDocumento[]> {
  return rest<LinhaDocumento[]>(
    "GET",
    `prognostics?select=participant_id,status,generated_at&participant_id=in.(${ids.join(",")})`,
    undefined,
    sessao.accessToken
  );
}
async function lerJobs(sessao: Sessao, eventId: string): Promise<LinhaJob[]> {
  const r = await api(sessao, "GET", `/api/jobs/status?event_id=${eventId}`);
  expect(r.status).toBe(200);
  return (r.json?.jobs ?? []) as LinhaJob[];
}

function projetar(
  c: Cenario,
  documentos: LinhaDocumento[],
  jobs: LinhaJob[],
  lote?: Map<string, ResultadoLote>
) {
  return montarSituacao({ pessoas: c.pessoas, documentos, jobs, lote })
    .map((s) => ({
      nome: s.nome,
      grupo: s.grupo,
      documento: s.documentoRotulo,
      resultado: s.processamento.resultado,
      fonte: s.processamento.fonte,
      tentativas: s.processamento.tentativas,
      erro: s.processamento.erro,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

const projetarJobs = (jobs: LinhaJob[]) =>
  jobs
    .map((j) => ({
      id: j.id,
      participant_id: j.participant_id,
      status: j.status,
      attempts: j.attempts,
      max_attempts: j.max_attempts,
      last_error_code: j.last_error_code,
      last_error: j.last_error,
      result: j.result,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

function mostrar(
  caminho: string,
  a: ReturnType<typeof projetar>,
  b: ReturnType<typeof projetar>,
  jobsA: number,
  jobsB: number
) {
  const linha = (v: ReturnType<typeof projetar>[number]) =>
    `${v.nome.padEnd(22)} documento=${v.documento.padEnd(18)} resultado=${v.resultado.padEnd(7)} tentativas=${String(v.tentativas).padEnd(4)} grupo=${v.grupo}`;
  console.log(`\n[${caminho}] jobs no banco vistos por A=${jobsA}, por B=${jobsB}`);
  console.log(`[${caminho}] A (quem pediu):\n  ${a.map(linha).join("\n  ")}`);
  console.log(`[${caminho}] B (outra conta, página nova):\n  ${b.map(linha).join("\n  ")}`);
}

async function esperarAquietar(sessao: Sessao, eventId: string) {
  let anterior = "";
  for (let i = 0; i < 40; i++) {
    const jobs = await lerJobs(sessao, eventId);
    const atual = JSON.stringify(projetarJobs(jobs));
    if (jobs.length > 0 && !jobs.some((j) => j.status === "running") && atual === anterior) return;
    anterior = atual;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("a fila não aquietou em 40s");
}

// ---------------------------------------------------------------- teste
const CONTAINER = process.env.DUAS_SESSOES_DB_CONTAINER;

function comSessao(s: Sessao, registro?: string[]): Fetcher {
  return async (url, init) => {
    registro?.push(url);
    return fetch(`${APP}${url}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie: s.cookie },
    });
  };
}

const jobsDoBanco = (eventId: string) =>
  rest<{ id: string; participant_id: string; status: string; attempts: number }[]>(
    "GET",
    `jobs?select=id,participant_id,status,attempts&event_id=eq.${eventId}`
  );
const linhasDeDocumento = (ids: string[]) =>
  rest<Record<string, unknown>[]>("GET", `prognostics?select=*&participant_id=in.(${ids.join(",")})&order=participant_id`);

descreve("duas sessões administrativas: o que A viu, B encontra?", () => {
  let adminA: { email: string; senha: string; userId: string };
  let adminB: { email: string; senha: string; userId: string };
  const eventos: string[] = [];
  const nomeDe = (c: Cenario, nome: string) => c.pessoas.find((p) => p.nome === nome)!;

  // estado compartilhado, na ordem dos testes
  let c: Cenario;
  let ids: string[];
  let docsAntes: Record<string, unknown>[];
  let A: Sessao;
  let B: Sessao;
  const urlsChamadasPorA: string[] = [];
  let visaoA: ReturnType<typeof projetar>;
  let jobsA: LinhaJob[];

  beforeAll(async () => {
    adminA = await criarAdmin("a");
    adminB = await criarAdmin("b");
    A = await entrar(adminA.email, adminA.senha);
    B = await entrar(adminB.email, adminB.senha);
    c = await semearEvento("fila");
    eventos.push(c.eventId);
    ids = c.pessoas.map((p) => p.id);
    docsAntes = await linhasDeDocumento(ids);
  }, 60_000);

  afterAll(async () => {
    if (CONTAINER) await restaurarFila().catch(() => undefined);
    for (const id of eventos) await rest("DELETE", `events?id=eq.${id}`).catch(() => undefined);
    for (const u of [adminA, adminB]) {
      if (!u) continue;
      await fetch(`${SUPA}/auth/v1/admin/users/${u.userId}`, {
        method: "DELETE",
        headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}` },
      }).catch(() => undefined);
    }
  });

  it("as duas sessões são de fato distintas (contas, tokens e cookies diferentes)", () => {
    expect(A.userId).not.toBe(B.userId);
    expect(A.accessToken).not.toBe(B.accessToken);
    expect(A.cookie).not.toBe(B.cookie);
  });

  it("CRITÉRIOS 1 e 2: o botão (solicitarProcessamento) cria jobs duráveis sem o lote; três cliques simultâneos de dois administradores não duplicam", async () => {
    const [r1, r2, r3]: ResultadoSolicitacao[] = await Promise.all([
      solicitarProcessamento(c.eventId, comSessao(A, urlsChamadasPorA)),
      solicitarProcessamento(c.eventId, comSessao(A, urlsChamadasPorA)),
      solicitarProcessamento(c.eventId, comSessao(B)),
    ]);
    for (const r of [r1, r2, r3]) expect(r.tipo).toBe("enfileirado");
    const criados = [r1, r2, r3].reduce((n, r) => n + (r.tipo === "enfileirado" ? r.criados : 0), 0);
    // Cada pessoa elegível entrou na fila EXATAMENTE uma vez, por mais cliques que houvesse.
    expect(criados).toBe(c.pessoas.length);
    const noBanco = await jobsDoBanco(c.eventId);
    expect(noBanco).toHaveLength(c.pessoas.length);
    expect(new Set(noBanco.map((j) => j.participant_id)).size).toBe(c.pessoas.length);

    // Um clique depois: ninguém novo, mesmos ids.
    const depois = await solicitarProcessamento(c.eventId, comSessao(A, urlsChamadasPorA));
    expect(depois).toMatchObject({ tipo: "enfileirado", criados: 0, reaproveitados: c.pessoas.length });
    expect((await jobsDoBanco(c.eventId)).map((j) => j.id).sort()).toEqual(noBanco.map((j) => j.id).sort());

    // CRITÉRIO 1: só a rota da fila foi chamada pela tela, e o lote não rodou.
    expect(new Set(urlsChamadasPorA)).toEqual(new Set(["/api/jobs/enfileirar"]));
    const lotes = await rest<unknown[]>("GET", `event_logs?event_id=eq.${c.eventId}&action=eq.batch_process_completed`);
    expect(lotes).toHaveLength(0);
    const enfileirados = await rest<unknown[]>("GET", `event_logs?event_id=eq.${c.eventId}&action=eq.jobs_enfileirados`);
    expect(enfileirados.length).toBeGreaterThanOrEqual(1);

    await api(A, "POST", "/api/jobs/tick");
    await esperarAquietar(A, c.eventId);
  }, 120_000);

  it("CRITÉRIO 3 e 9: A fecha a página; B (outra conta) encontra os mesmos IDs, estados, tentativas e erros, e a mesma visão por pessoa", async () => {
    jobsA = await lerJobs(A, c.eventId);
    visaoA = projetar(c, await lerDocumentos(A, ids), jobsA);
    // O que A viu precisa ser informativo, senão "igual" não prova nada.
    expect(jobsA.length).toBe(c.pessoas.length);
    expect(visaoA.find((v) => v.nome === "Ana Entregue")).toMatchObject({ resultado: "pulado", documento: "Entregue" });
    expect(visaoA.find((v) => v.nome === "Carla Em Revisao")).toMatchObject({ resultado: "pulado", documento: "Em revisão" });
    expect(visaoA.find((v) => v.nome === "Bruno Sem Respostas")?.tentativas).toBeGreaterThanOrEqual(1);
    expect(visaoA.find((v) => v.nome === "Bruno Sem Respostas")?.erro).toBeTruthy();

    // --- A "fecha a página": nada do que A tinha em memória é levado adiante.
    // --- B: OUTRA conta, abre o mesmo evento.
    const jobsB = await lerJobs(B, c.eventId);
    const visaoB = projetar(c, await lerDocumentos(B, ids), jobsB);

    mostrar("FILA (botão novo)", visaoA, visaoB, jobsA.length, jobsB.length);
    expect(projetarJobs(jobsB)).toEqual(projetarJobs(jobsA));
    expect(visaoB).toEqual(visaoA);
  });

  it("CRITÉRIO 4: recarregar a página (sessão nova, leitura nova) não altera nada", async () => {
    const A2 = await entrar(adminA.email, adminA.senha);
    const jobs2 = await lerJobs(A2, c.eventId);
    const jobs3 = await lerJobs(A2, c.eventId);
    expect(projetarJobs(jobs2)).toEqual(projetarJobs(jobsA));
    expect(projetarJobs(jobs3)).toEqual(projetarJobs(jobsA));
    expect(projetar(c, await lerDocumentos(A2, ids), jobs3)).toEqual(visaoA);
  });

  it("CRITÉRIO 5: a falha de um job não altera documentos já existentes (linhas inteiras idênticas) nem cria documento para quem falhou", async () => {
    const depois = await linhasDeDocumento(ids);
    expect(depois).toEqual(docsAntes);
    const bruno = nomeDe(c, "Bruno Sem Respostas").id;
    const diego = nomeDe(c, "Diego Sem Respostas").id;
    expect(depois.some((d) => d.participant_id === bruno || d.participant_id === diego)).toBe(false);
  });

  it("CRITÉRIO 6: retentativa respeita as travas de revisão e entrega (mesmo FORÇADA, o documento não muda); a legítima volta para a fila", async () => {
    const jobs = await lerJobs(A, c.eventId);
    const jobDe = (p: { id: string }) => jobs.find((j) => j.participant_id === p.id)!;
    const ana = nomeDe(c, "Ana Entregue");
    const carla = nomeDe(c, "Carla Em Revisao");
    const bruno = nomeDe(c, "Bruno Sem Respostas");

    // O painel não oferece botão para documento protegido.
    const sit = montarSituacao({ pessoas: c.pessoas, documentos: await lerDocumentos(A, ids), jobs });
    expect(sit.find((s) => s.id === ana.id)?.retentativa).toBeNull();
    expect(sit.find((s) => s.id === carla.id)?.retentativa).toBeNull();

    // Pior caso: alguém força o reprocessamento direto pela rota (forcar:true).
    for (const p of [ana, carla]) {
      const r = await api(A, "POST", "/api/jobs/operacao", { job_id: jobDe(p).id, acao: "reenfileirar", forcar: true });
      expect(r.json?.ok).toBe(true);
    }
    await api(A, "POST", "/api/jobs/tick");
    await esperarAquietar(A, c.eventId);
    const jobsDepois = await lerJobs(A, c.eventId);
    for (const p of [ana, carla]) {
      const j = jobsDepois.find((x) => x.participant_id === p.id)!;
      expect(j.status).toBe("skipped"); // a trava recusou de novo
    }
    expect(await linhasDeDocumento(ids)).toEqual(docsAntes); // e o documento é o mesmo, byte a byte

    // Retentativa legítima (sem documento protegido): volta para a fila com tentativas novas.
    const r = await api(A, "POST", "/api/jobs/operacao", { job_id: jobDe(bruno).id, acao: "reenfileirar" });
    expect(r.json).toMatchObject({ ok: true });
    const bj = (await lerJobs(A, c.eventId)).find((j) => j.participant_id === bruno.id)!;
    expect(bj.status).toBe("pending");
    expect(bj.attempts).toBe(0);
  }, 120_000);

  it("CRITÉRIO 7: eventos distintos não se misturam (jobs, status e visão do painel)", async () => {
    const y = await semearEvento("evty");
    eventos.push(y.eventId);
    const idsY = y.pessoas.map((p) => p.id);
    // Enfileirar o evento X não tocou em Y.
    expect(await jobsDoBanco(y.eventId)).toHaveLength(0);
    expect(await lerJobs(A, y.eventId)).toHaveLength(0);

    await solicitarProcessamento(y.eventId, comSessao(A));
    await api(A, "POST", "/api/jobs/tick");
    await esperarAquietar(A, y.eventId);

    const jobsX = await lerJobs(B, c.eventId);
    const jobsY = await lerJobs(B, y.eventId);
    const setX = new Set(ids);
    const setY = new Set(idsY);
    expect(jobsX.every((j) => setX.has(j.participant_id))).toBe(true);
    expect(jobsY.every((j) => setY.has(j.participant_id))).toBe(true);
    expect(jobsY).toHaveLength(y.pessoas.length);
    expect(new Set([...jobsX, ...jobsY].map((j) => j.id)).size).toBe(jobsX.length + jobsY.length);

    // Mesmo que alguém entregasse ao painel de X os jobs de X e de Y misturados,
    // a visão de X só conteria as pessoas de X, e igual à visão só com os jobs de X.
    const docsX = await lerDocumentos(B, ids);
    const misturado = projetar(c, docsX, [...jobsX, ...jobsY]);
    expect(misturado).toEqual(projetar(c, docsX, jobsX));
    expect(misturado).toHaveLength(c.pessoas.length);
  }, 120_000);

  it.skipIf(!CONTAINER)("CRITÉRIO 8: sem a infraestrutura da fila, o botão é bloqueado com mensagem explícita, nada é enfileirado e o lote NÃO é chamado", async () => {
    const z = await semearEvento("evtz");
    eventos.push(z.eventId);
    const urls: string[] = [];
    try {
      await removerFila(); // simula "migration 018 não aplicada"
      // a leitura que habilita o botão responde 5xx
      const status = await fetch(`${APP}/api/jobs/status?event_id=${z.eventId}`, { headers: { cookie: A.cookie } });
      expect(status.status).toBeGreaterThanOrEqual(500);
      // e o clique, se alguém o forçasse, não cai no lote
      const r = await solicitarProcessamento(z.eventId, comSessao(A, urls));
      expect(r.tipo).toBe("fila_indisponivel");
      expect(r.tipo === "fila_indisponivel" && r.mensagem).toContain("migration 018");
      expect(new Set(urls)).toEqual(new Set(["/api/jobs/enfileirar"]));
    } finally {
      await restaurarFila();
    }
    // e com a fila de volta, a leitura volta a ser 200. O PostgREST recarrega o cache de
    // schema de forma assíncrona depois do DDL, então espera-se a RESTAURAÇÃO da
    // infraestrutura (até 20s); o que se afirma é o status final.
    let voltou = 0;
    for (let i = 0; i < 20 && voltou !== 200; i++) {
      voltou = (await fetch(`${APP}/api/jobs/status?event_id=${z.eventId}`, { headers: { cookie: A.cookie } })).status;
      if (voltou !== 200) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(voltou).toBe(200);
    expect(await jobsDoBanco(z.eventId)).toHaveLength(0);
    const lotes = await rest<unknown[]>("GET", `event_logs?event_id=eq.${z.eventId}&action=eq.batch_process_completed`);
    expect(lotes).toHaveLength(0);
  }, 60_000);

  it("COMPARAÇÃO HISTÓRICA: o lote antigo continua perdendo o histórico entre sessões (é por isso que foi descontinuado)", async () => {
    const l = await semearEvento("lote");
    eventos.push(l.eventId);
    const idsL = l.pessoas.map((p) => p.id);
    const snap = async (): Promise<Map<string, PrognosticSnapshot>> =>
      new Map((await lerDocumentos(A, idsL)).map((d) => [d.participant_id, { status: d.status, generated_at: d.generated_at }]));

    const antes = await snap();
    const lote = await api(A, "POST", "/api/batch-process", { event_id: l.eventId });
    expect(lote.status).toBe(200);
    const resumo = lote.json as { total: number; succeeded: number; skipped: number; failed: number };
    const depois = await snap();
    const resultado = classifyBatch(
      l.pessoas.map((p) => ({ id: p.id, name: p.nome })),
      antes,
      depois,
      { total: resumo.total, succeeded: resumo.succeeded, skipped: resumo.skipped, failed: resumo.failed }
    );
    expect(resultado.identified).toBe(true);
    const agora = new Date().toISOString();
    const memoriaDeA = new Map<string, ResultadoLote>();
    resultado.skipped.forEach((p) => memoriaDeA.set(p.id, { resultado: "pulado", estadoAntes: p.status, em: agora }));
    resultado.failed.forEach((p) => memoriaDeA.set(p.id, { resultado: "falhou", estadoAntes: null, em: agora }));
    const visaoDeA = projetar(l, await lerDocumentos(A, idsL), await lerJobs(A, l.eventId), memoriaDeA);
    const visaoDeB = projetar(l, await lerDocumentos(B, idsL), await lerJobs(B, l.eventId));

    mostrar("LOTE (histórico)", visaoDeA, visaoDeB, 0, (await lerJobs(B, l.eventId)).length);
    // Esta é a evidência preservada: o critério "B vê o que A viu" REPROVA no lote.
    expect(visaoDeB).not.toEqual(visaoDeA);
    expect((await jobsDoBanco(l.eventId)).length).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------- simular "fila ausente"
const FUNCOES_DA_FILA = [
  "jobs_enfileirar(text,uuid,uuid,integer,integer)",
  "jobs_resumo_evento(uuid,text)",
];
async function docker(sql: string) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("docker", ["exec", CONTAINER!, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
}
async function removerFila() {
  for (const f of FUNCOES_DA_FILA) {
    const nome = f.split("(")[0];
    await docker(`alter function public.${f} rename to ${nome}_ausente`);
  }
}
async function restaurarFila() {
  for (const f of FUNCOES_DA_FILA) {
    const [nome, resto] = f.split("(");
    await docker(
      `do $$ begin if to_regprocedure('public.${nome}_ausente(${resto.replace(")", "")})') is not null then alter function public.${nome}_ausente(${resto.replace(")", "")}) rename to ${nome}; end if; end $$`
    );
  }
}
