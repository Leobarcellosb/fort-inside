// CADEIA POS-COLETA, ELO POR ELO, COM SAIDA MEDIDA.
//
// Pergunta que esta prova responde: existe uma cadeia integra entre RESPOSTA,
// IDENTIDADE, SCORING, GERACAO, REVISAO e ENTREGA do documento individual --
// ou ha peca verde sem encaixe?
//
// Cada elo roda contra um Postgres DESCARTAVEL construido pelas migrations de
// `supabase/migrations/` e um PostgREST de verdade na frente dele; a Anthropic
// e substituida pelo CANARIO local (`lib/ai/provas/canario-roteirizado.mjs`),
// que CONTA as chamadas. Nenhum token e gasto e nenhuma chave real e usada.
// Como rodar: `bash scripts/jornada-individual-cadeia.sh`.
// Sem as variaveis JORNADA_* o arquivo e PULADO, para `npx vitest run` seguir
// verde em maquina sem Docker.
//
// O QUE ESTA PROVA EXERCITA DE VERDADE
//   - a escrita de resposta pelo MESMO caminho da tela: `supabase-js` ->
//     PostgREST -> RLS, com o JWT do participante no cabecalho, upsert com
//     `onConflict: participant_id,stage_id` (ver app/(participant)/quiz/[stageId]/page.tsx);
//   - o motor de pontuacao e a camada de briefing de PRODUCAO, importados, nao
//     copiados;
//   - `generatePrognostic()` de producao, ponta a ponta, inclusive o veto de
//     saida e a gravacao em `prognostics`;
//   - a maquina de estados da migration 015 (gatilho anti-regressao) e as
//     policies de RLS da 002, pelo banco, nao por leitura de codigo;
//   - as consultas EXATAS que a entrega faz (`app/(participant)/prognostic/[token]/page.tsx`
//     e `app/api/prognostic-status/[token]/route.ts`), copiadas aqui.
//
// O QUE ELA NAO EXERCITA (declarado, nao escondido)
//   - GoTrue: o JWT do participante e ASSINADO NESTA PROVA com o segredo do
//     PostgREST. A emissao de sessao (OTP, e-mail, /api/entrar/*) nao e medida.
//     O que o JWT ativa -- RLS, auth.uid() -- e medido de verdade.
//   - Next: as ROTAS nao sao servidas. Onde a regra mora na rota (autorizacao de
//     admin, rate limit), esta prova diz isso e mede a regra do banco, nao a da
//     rota. Onde a rota so repassa (a consulta da pagina publica), a consulta e
//     reproduzida identica.
//   - React: nenhuma tela e renderizada. As respostas sao montadas no formato
//     que a tela grava, a partir do questionario canonico com impressao
//     digital conferida.
//   - Storage/PDF: desligado. `pdf_url` e conferido como nulo e a prova para ai.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { achatarRespostas, ErroNormalizacaoResposta } from "../../lib/scoring/achatar-respostas";
import { calcularMarcoZero } from "../../lib/scoring/marco-zero";
import { prepararBriefing } from "../../lib/ai/briefing-prognostico";
import {
  IMPRESSAO_PUBLICADA,
  TOTAL_DE_PERGUNTAS,
  impressaoCanonica,
  respostasCanonicas,
  type RespostasDaEtapa,
} from "./respostas-canonicas";

const SUPA = process.env.JORNADA_SUPA_URL ?? "";
const SERVICE = process.env.JORNADA_SERVICE_KEY ?? "";
const ANON = process.env.JORNADA_ANON_KEY ?? "";
const SEGREDO = process.env.JORNADA_JWT_SECRET ?? "";
const CANARIO = process.env.JORNADA_CANARIO_URL ?? "";
const PG = process.env.JORNADA_PG_URL ?? "";

const ligada = !!(SUPA && SERVICE && ANON && SEGREDO && CANARIO && PG);
const descreve = ligada ? describe : describe.skip;

// ---------------------------------------------------------------- utilitarios

/** Tudo o que a prova mediu, impresso no fim como EVIDENCIA. */
const medido: Record<string, unknown> = {};
const anota = (chave: string, valor: unknown) => {
  medido[chave] = valor;
  console.log(`[medido] ${chave} = ${JSON.stringify(valor)}`);
};

/** JWT HS256 assinado com o segredo do PostgREST deste stack descartavel. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const cabeca = b64({ alg: "HS256", typ: "JWT" });
  const corpo = b64({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  const assinatura = createHmac("sha256", SEGREDO)
    .update(`${cabeca}.${corpo}`)
    .digest("base64url");
  return `${cabeca}.${corpo}.${assinatura}`;
}

/** psql no banco descartavel: a prova precisa do schema `auth` e de RPCs. */
function sql(consulta: string): string {
  const saida = execFileSync("psql", ["-X", "-Atc", consulta, PG], {
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "60" },
  });
  // `-Atc` com RETURNING imprime a linha E a etiqueta do comando ("INSERT 0 1").
  // A etiqueta nao e dado: sai fora.
  return saida
    .split("\n")
    .filter((l) => l.trim() !== "" && !/^(INSERT|UPDATE|DELETE|SELECT|ALTER|CREATE) \d*\s*\d*$/.test(l.trim()))
    .join("\n")
    .trim();
}

/** Cliente como a TELA o cria: chave anon + (opcional) JWT da sessao. */
function clienteDaTela(token?: string): SupabaseClient {
  return createClient(SUPA, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
}

const canario = async (caminho: string, init?: RequestInit) =>
  (await fetch(`${CANARIO}${caminho}`, init)).json() as Promise<any>;
const zerarCanario = () => canario("/__canario/zerar", { method: "POST" });
const chamadasAoModelo = async () => (await canario("/__canario/contagem")).total as number;
const ultimaChamada = () => canario("/__canario/ultima");

// --------------------------------------------------------------------- prova

descreve("cadeia pos-coleta do documento individual", () => {
  let db: SupabaseClient; // service_role, como as rotas de admin usam
  let generatePrognostic: typeof import("../../lib/ai/generate-prognostic").generatePrognostic;
  let verificarOrcamento: typeof import("../../lib/jobs/fila").verificarOrcamento;
  let registrarConsumo: typeof import("../../lib/jobs/fila").registrarConsumo;

  const marca = `JORNADA-${Date.now()}`;
  let eventId = "";
  const etapas: { n: number; stage_id: number }[] = [];
  const hostsAlcancados = new Set<string>();

  /** participantes desta rodada, por apelido */
  const P: Record<string, { id: string; userId: string; token: string; email: string }> = {};

  beforeAll(async () => {
    // GUARDAS. Producao nunca e tocada: tudo tem de ser 127.0.0.1.
    for (const [nome, url] of [
      ["JORNADA_SUPA_URL", SUPA],
      ["JORNADA_CANARIO_URL", CANARIO],
    ] as const) {
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(url)) {
        throw new Error(`${nome} nao e local: ${url}`);
      }
    }
    if (!/@(127\.0\.0\.1|localhost):\d+\//.test(PG)) {
      throw new Error(`JORNADA_PG_URL nao e local: ${PG}`);
    }

    // Rede: todo fetch do processo passa por aqui. Host que nao seja local e
    // recusado ANTES de sair, e a lista de hosts vira evidencia.
    const original = globalThis.fetch;
    globalThis.fetch = (async (entrada: any, init?: any) => {
      const alvo = new URL(typeof entrada === "string" ? entrada : (entrada.url ?? String(entrada)));
      hostsAlcancados.add(alvo.host);
      if (alvo.hostname !== "127.0.0.1" && alvo.hostname !== "localhost") {
        throw new Error(`REDE EXTERNA BLOQUEADA PELA PROVA: ${alvo.host}`);
      }
      return original(entrada, init);
    }) as typeof fetch;

    // A Anthropic e o canario; a chave e falsa. O SDK le o env na construcao do
    // modulo, por isso os imports de producao vem DEPOIS.
    process.env.ANTHROPIC_BASE_URL = CANARIO;
    process.env.ANTHROPIC_API_KEY = "sk-ant-FALSA-jornada-individual-nao-existe";
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

    ({ generatePrognostic } = await import("../../lib/ai/generate-prognostic"));
    ({ verificarOrcamento, registrarConsumo } = await import("../../lib/jobs/fila"));

    db = createClient(SUPA, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Evento do Marco Zero (quiz_version 2), etapa corrente 5 (todas liberadas).
    const { data: ev, error } = await db
      .from("events")
      .insert({
        name: `jornada individual ${marca}`,
        event_code: marca,
        event_date: new Date().toISOString(),
        status: "processing",
        current_stage: 5,
        quiz_version: 2,
      } as never)
      .select("id")
      .single();
    if (error || !ev) throw new Error(`seed do evento: ${error?.message}`);
    eventId = (ev as { id: string }).id;

    // As etapas REAIS da versao 2, como a migration 017 as semeou.
    const { data: st, error: sErr } = await db
      .from("quiz_stages")
      .select("id, stage_number")
      .eq("quiz_version", 2)
      .order("stage_number");
    if (sErr || !st) throw new Error(`leitura de quiz_stages: ${sErr?.message}`);
    for (const linha of st as { id: number; stage_number: number }[]) {
      etapas.push({ n: linha.stage_number, stage_id: linha.id });
    }
    await zerarCanario();
  });

  afterAll(async () => {
    if (eventId) await db.from("events").delete().eq("id", eventId); // cascata leva o resto
    for (const p of Object.values(P)) {
      try {
        sql(`delete from auth.users where id = '${p.userId}'`);
      } catch {
        /* a cascata do evento ja levou o participante; o usuario e so rastro */
      }
    }
    anota("hosts_alcancados_no_processo", [...hostsAlcancados].sort());
    console.log("\n================ EVIDENCIA MEDIDA ================");
    console.log(JSON.stringify(medido, null, 2));
  });

  /** Cria auth.users + participants e devolve o JWT que a tela carregaria. */
  async function criarParticipante(apelido: string): Promise<void> {
    // A imagem descartavel traz o ESQUELETO do schema `auth` (as colunas que o
    // GoTrue cria nas migrations dele nao existem aqui, p.ex. email_confirmed_at).
    // Isto nao afeta o que a prova mede: a RLS le a claim do JWT
    // (`auth.uid()`), nao esta tabela; a linha existe por causa da FK de
    // `participants.user_id`.
    const userId = sql(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, confirmed_at, raw_app_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
               '${apelido}-${marca}@prova.test', 'nao-e-senha-real', now(), '{}'::jsonb, now(), now())
       returning id`,
    );
    const { data, error } = await db
      .from("participants")
      .insert({
        event_id: eventId,
        user_id: userId,
        full_name: `Participante ${apelido}`,
        email: `${apelido}-${marca}@prova.test`,
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed do participante ${apelido}: ${error?.message}`);
    P[apelido] = {
      id: (data as { id: string }).id,
      userId,
      email: `${apelido}-${marca}@prova.test`,
      // O MESMO formato de token que o GoTrue emite para participante.
      token: jwt({ sub: userId, role: "authenticated", aud: "authenticated", app_metadata: {} }),
    };
  }

  /** Grava as etapas pelo caminho da tela. Devolve o erro de cada upsert. */
  async function gravarPelaTela(
    apelido: string,
    linhas: { n: number; answers: RespostasDaEtapa }[],
    comoParticipante = apelido,
  ): Promise<({ message: string; code?: string } | null)[]> {
    const cliente = clienteDaTela(P[comoParticipante]?.token);
    const erros: ({ message: string; code?: string } | null)[] = [];
    for (const linha of linhas) {
      const etapa = etapas.find((e) => e.n === linha.n);
      if (!etapa) throw new Error(`sem stage_id para a etapa ${linha.n}`);
      // EXATAMENTE a chamada de app/(participant)/quiz/[stageId]/page.tsx.
      const { error } = await (
        cliente.from("quiz_responses") as unknown as {
          upsert(
            v: Record<string, unknown>,
            o: { onConflict: string },
          ): Promise<{ error: { message: string; code?: string } | null }>;
        }
      ).upsert(
        { participant_id: P[apelido].id, stage_id: etapa.stage_id, answers: linha.answers },
        { onConflict: "participant_id,stage_id" },
      );
      erros.push(error);
    }
    return erros;
  }

  /** Marca a conclusao, como /api/complete-quiz faz depois de conferir etapa por etapa. */
  async function concluir(apelido: string) {
    const { error } = await db
      .from("participants")
      .update({ completed_at: new Date().toISOString() } as never)
      .eq("id", P[apelido].id);
    if (error) throw new Error(`conclusao de ${apelido}: ${error.message}`);
  }

  // ================================================================= ELO 0
  it("elo 0: o instrumento sob prova e o canonico publicado, e o banco tem as 5 etapas", () => {
    expect(impressaoCanonica()).toBe(IMPRESSAO_PUBLICADA);
    anota("elo0_impressao_do_questionario", impressaoCanonica());
    anota("elo0_total_de_perguntas_no_canonico", TOTAL_DE_PERGUNTAS);
    anota("elo0_etapas_no_banco", etapas);
    expect(TOTAL_DE_PERGUNTAS).toBe(52);
    expect(etapas.length).toBe(5);

    const perguntasNoBanco = Number(
      sql("select count(*) from (select jsonb_array_elements(questions) from quiz_stages where quiz_version = 2) x"),
    );
    anota("elo0_total_de_perguntas_no_banco", perguntasNoBanco);
    expect(perguntasNoBanco).toBe(52);
  });

  // ================================================================= ELO 1
  describe("elo 1 - RESPOSTA (pelo caminho da tela)", () => {
    it("A grava as 5 etapas / 52 perguntas pelo upsert que a tela usa", async () => {
      await criarParticipante("A");
      const erros = await gravarPelaTela("A", respostasCanonicas());
      anota("elo1_erros_do_upsert_de_A", erros);
      expect(erros.every((e) => e === null)).toBe(true);

      // O que FICOU GRAVADO, lido de volta.
      const { data } = await db
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", P.A.id)
        .order("stage_id");
      const linhas = (data ?? []) as { stage_id: number; answers: Record<string, unknown> }[];
      const ids = linhas.flatMap((l) => Object.keys(l.answers));
      anota("elo1_linhas_gravadas", linhas.length);
      anota("elo1_perguntas_gravadas", ids.length);
      anota("elo1_amostra_situacional_q40", linhas.flatMap((l) => (l.answers.q40 ? [l.answers.q40] : [])));
      expect(linhas.length).toBe(5);
      expect(ids.length).toBe(52);
      await concluir("A");
    });

    it("negativa COM controle positivo: anonimo nao grava; vizinho nao grava no participante de A", async () => {
      await criarParticipante("B");
      // anonimo (chave anon, sem JWT)
      const semSessao = await (
        clienteDaTela().from("quiz_responses") as unknown as {
          upsert(v: Record<string, unknown>, o: { onConflict: string }): Promise<{ error: any }>;
        }
      ).upsert(
        { participant_id: P.A.id, stage_id: etapas[0].stage_id, answers: { q1: "invasor" } },
        { onConflict: "participant_id,stage_id" },
      );
      anota("elo1_anonimo_gravando_em_A", semSessao.error?.code ?? semSessao.error?.message ?? "ACEITO");
      expect(semSessao.error).not.toBeNull();

      // B autenticado, gravando no participant_id de A
      const comoB = await (
        clienteDaTela(P.B.token).from("quiz_responses") as unknown as {
          upsert(v: Record<string, unknown>, o: { onConflict: string }): Promise<{ error: any }>;
        }
      ).upsert(
        { participant_id: P.A.id, stage_id: etapas[0].stage_id, answers: { q1: "vizinho" } },
        { onConflict: "participant_id,stage_id" },
      );
      anota("elo1_B_gravando_em_A", comoB.error?.code ?? comoB.error?.message ?? "ACEITO");
      expect(comoB.error).not.toBeNull();

      // CONTROLE POSITIVO: no mesmo ambiente, B grava no proprio.
      const errosDeB = await gravarPelaTela("B", respostasCanonicas());
      anota("elo1_controle_positivo_B_no_proprio", errosDeB);
      expect(errosDeB.every((e) => e === null)).toBe(true);
      await concluir("B");

      // E as respostas de A seguem intactas depois das duas tentativas.
      const { data } = await db
        .from("quiz_responses")
        .select("answers")
        .eq("participant_id", P.A.id)
        .eq("stage_id", etapas[0].stage_id)
        .single();
      const q1 = (data as { answers: Record<string, unknown> }).answers.q1;
      anota("elo1_q1_de_A_apos_tentativas", q1);
      expect(String(q1)).not.toContain("invasor");
      expect(String(q1)).not.toContain("vizinho");
    });
  });

  // ================================================================= ELO 2
  describe("elo 2 - SCORING", () => {
    it("pontua o que FICOU GRAVADO, com os valores colados", async () => {
      const { data } = await db
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", P.A.id);
      const linhas = (data ?? []) as { stage_id: number; answers: unknown }[];

      const achatadas = achatarRespostas(linhas);
      const marcoZero = calcularMarcoZero(achatadas);
      anota("elo2_perguntas_achatadas", Object.keys(achatadas).length);
      anota("elo2_marco_zero", marcoZero);

      const briefing = prepararBriefing(
        linhas as readonly { stage_id: number; answers: unknown }[] as never,
      );
      anota("elo2_briefing_ok", briefing.ok);
      if (briefing.ok) {
        anota("elo2_briefing_tamanho_do_bloco", briefing.bloco.length);
        anota("elo2_briefing_primeiras_linhas", briefing.bloco.split("\n").slice(0, 6));
      } else {
        anota("elo2_briefing_recusa", briefing);
      }
      expect(briefing.ok).toBe(true);
    });

    it("ACHADO: sem linha em `event_people`, o banco NAO diz invalido -- ele nao diz NADA", () => {
      // A definicao do banco (migration 020) percorre `event_people`, a lista de
      // convidados. Participante sem convite nao aparece no resultado: nao e
      // "valido" nem "invalido", e NAO VERIFICAVEL. Um painel que conte
      // `where valido` le isso como "zero respondentes" -- "nao consegui
      // verificar" entregue como "verifiquei e deu zero".
      const linhasDoBanco = sql(
        `select count(*) from public.marco_zero_respostas_validas('${eventId}')`,
      );
      const temConvite = sql(
        `select count(*) from public.event_people where event_id = '${eventId}'`,
      );
      anota("elo2_linhas_que_o_banco_devolve_sem_convite", linhasDoBanco);
      anota("elo2_convites_no_evento", temConvite);
      expect(temConvite).toBe("0");
      expect(linhasDoBanco).toBe("0"); // nenhum veredito, nem negativo
    });

    it("com o convite na lista, as DUAS definicoes de completo concordam para A", async () => {
      // O caminho real cria a pessoa na lista de convite. Com ela, o banco pode
      // dar veredito -- e e esse veredito que se compara ao do scoring.
      sql(
        `insert into public.event_people (event_id, participant_id, full_name, email, origem)
         values ('${eventId}', '${P.A.id}', 'Participante A', '${P.A.email}', 'lista_convite')`,
      );
      const bancoDizValido = sql(
        `select valido from public.marco_zero_respostas_validas('${eventId}') where participant_id = '${P.A.id}'`,
      );
      const etapas = sql(
        `select etapas_respondidas || '/' || etapas_exigidas from public.marco_zero_respostas_validas('${eventId}') where participant_id = '${P.A.id}'`,
      );
      anota("elo2_banco_diz_valido_para_A", bancoDizValido);
      anota("elo2_banco_etapas_de_A", etapas);

      const { data } = await db
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", P.A.id);
      const mz = calcularMarcoZero(achatarRespostas((data ?? []) as never));
      anota("elo2_scoring_incompleto_para_A", (mz as { incompleto?: unknown }).incompleto ?? null);
      expect(bancoDizValido).toBe("t");
      expect((mz as { incompleto: string[] }).incompleto).toEqual([]);
    });

    it("DIVERGENCIA MEDIDA: valor fora do dominio -- o banco diz valido, o scoring recusa", async () => {
      await criarParticipante("C");
      sql(
        `insert into public.event_people (event_id, participant_id, full_name, email, origem)
         values ('${eventId}', '${P.C.id}', 'Participante C', '${P.C.email}', 'lista_convite')`,
      );
      // q16 e Likert 1..5. A tela aceita qualquer `number` (ver `allValid`),
      // e o banco so exige objeto nao vazio. 9 e fora do dominio do motor.
      const erros = await gravarPelaTela("C", respostasCanonicas({ sobrescrever: { q16: 9 } }));
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("C");

      const bancoDiz = sql(
        `select valido from public.marco_zero_respostas_validas('${eventId}') where participant_id = '${P.C.id}'`,
      );
      anota("elo2_divergencia_banco_diz_valido", bancoDiz);

      const { data } = await db
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", P.C.id);
      let recusaDoScoring: string | null = null;
      try {
        achatarRespostas((data ?? []) as never);
      } catch (err) {
        recusaDoScoring =
          err instanceof ErroNormalizacaoResposta ? err.message : `outro erro: ${String(err)}`;
      }
      anota("elo2_divergencia_scoring_recusa", recusaDoScoring);
      // O lado em que este caso cai: banco APROVA, scoring RECUSA.
      expect(bancoDiz).toBe("t");
      expect(recusaDoScoring).not.toBeNull();
    });
  });

  // ================================================================= ELO 3
  describe("elo 3 - GERACAO do documento individual", () => {
    it("gera o documento de A pelo gerador de PRODUCAO, contra o canario", async () => {
      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.A.id, eventId);
      const depois = await chamadasAoModelo();
      anota("elo3_resultado_para_A", r);
      anota("elo3_chamadas_ao_modelo", { antes, depois });
      expect(r.ok).toBe(true);
      expect(depois).toBeGreaterThan(antes);

      const corpo = await ultimaChamada();
      anota("elo3_modelo_pedido_ao_canario", corpo?.model ?? null);
      anota("elo3_briefing_chegou_no_prompt", JSON.stringify(corpo ?? {}).includes("Marco Zero"));

      const { data } = await db
        .from("prognostics")
        .select("id, status, generated_at, reviewed_at, delivered_at, pdf_url, public_share_token, raw_ai_output, edited_content, final_content")
        .eq("participant_id", P.A.id)
        .single();
      const doc = data as Record<string, any>;
      anota("elo3_documento_gravado", {
        status: doc.status,
        tem_raw: !!doc.raw_ai_output,
        tem_edited: !!doc.edited_content,
        tem_final: !!doc.final_content,
        pdf_url: doc.pdf_url,
        tem_token: !!doc.public_share_token,
      });
      expect(doc.status).toBe("generated");
      // Storage desligado nesta prova: a prova para no pdf nulo, nao finge.
      expect(doc.pdf_url).toBeNull();
    });
  });

  // ================================================================= ELO 4
  describe("elo 4 - REVISAO e VERSIONAMENTO", () => {
    it("o sistema NAO exige revisao antes de entregar: generated -> delivered passa", async () => {
      // Replica a escrita do botao "Entregar" (PrognosticReviewGrid.deliver)
      // num participante que NUNCA passou por revisao: B.
      await zerarCanario();
      const g = await generatePrognostic(P.B.id, eventId);
      expect(g.ok).toBe(true);
      const { data: antes } = await db
        .from("prognostics")
        .select("id, status, raw_ai_output, edited_content")
        .eq("participant_id", P.B.id)
        .single();
      const docB = antes as Record<string, any>;
      const final = docB.edited_content ?? docB.raw_ai_output;
      const { error } = await db
        .from("prognostics")
        .update({
          final_content: final,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docB.id);
      anota("elo4_entrega_sem_revisao_erro", error?.message ?? null);
      const { data: depois } = await db
        .from("prognostics")
        .select("status, reviewed_at, delivered_at")
        .eq("participant_id", P.B.id)
        .single();
      anota("elo4_estado_de_B_apos_entrega", depois);
      // MEDIDO: entregou sem nunca ter sido revisado, e reviewed_at segue nulo.
      expect((depois as any).status).toBe("delivered");
      expect((depois as any).reviewed_at).toBeNull();
    });

    it("revisao de A: a escrita do PATCH de producao grava edited_content e marca reviewed", async () => {
      const { data: antes } = await db
        .from("prognostics")
        .select("id, raw_ai_output")
        .eq("participant_id", P.A.id)
        .single();
      const doc = antes as Record<string, any>;
      const editado = {
        ...doc.raw_ai_output,
        analise_geral: "TEXTO REVISADO PELO HOST (marca da prova).",
      };
      // Mesmos campos que app/api/prognostics/[id]/route.ts escreve.
      const { error } = await db
        .from("prognostics")
        .update({
          edited_content: editado,
          yuri_note: null,
          trail_recommendation: editado.trilha_recomendada,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", doc.id);
      anota("elo4_revisao_de_A_erro", error?.message ?? null);
      expect(error).toBeNull();

      const { data } = await db
        .from("prognostics")
        .select("status, reviewed_at")
        .eq("participant_id", P.A.id)
        .single();
      anota("elo4_estado_de_A_apos_revisao", data);
      expect((data as any).status).toBe("reviewed");
    });

    it("regerar depois de revisado e RECUSADO com 409 e SEM gastar o modelo", async () => {
      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.A.id, eventId);
      const depois = await chamadasAoModelo();
      anota("elo4_regerar_revisado", r);
      anota("elo4_regerar_chamadas_ao_modelo", { antes, depois });
      expect(r.ok).toBe(false);
      expect((r as { status: number }).status).toBe(409);
      expect(depois).toBe(antes); // nao gastou
    });

    it("VERSIONAMENTO: existe UMA linha por participante, sem versao e sem historico", async () => {
      const linhasDeA = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.A.id}'`),
      );
      const colunas = sql(
        `select string_agg(column_name, ',' order by ordinal_position)
           from information_schema.columns
          where table_schema = 'public' and table_name = 'prognostics'`,
      );
      const tabelasDeHistorico = sql(
        `select coalesce(string_agg(table_name, ','), '(nenhuma)')
           from information_schema.tables
          where table_schema = 'public'
            and (table_name like '%prognostic%version%'
              or table_name like '%prognostic%histor%'
              or table_name like '%version%prognostic%')`,
      );
      anota("elo4_linhas_de_prognostico_de_A", linhasDeA);
      anota("elo4_colunas_de_prognostics", colunas.split(","));
      anota("elo4_tabelas_de_historico_ou_versao", tabelasDeHistorico);
      expect(linhasDeA).toBe(1);
      // MEDIDO: nenhuma coluna de versao, nenhuma tabela de historico.
      expect(colunas.split(",")).not.toContain("version");
    });

    it("CONTEUDO MUDA DEPOIS DE REVISADO: a aprovacao anterior continua valendo?", async () => {
      const { data: antes } = await db
        .from("prognostics")
        .select("id, status, reviewed_at, edited_content")
        .eq("participant_id", P.A.id)
        .single();
      const doc = antes as Record<string, any>;
      const revisadoEm = doc.reviewed_at;

      // Troca SO o conteudo, sem tocar no status (nao e regressao: o gatilho da
      // 015 nem dispara, porque ele e `before update of status`).
      const { error } = await db
        .from("prognostics")
        .update({
          edited_content: {
            ...doc.edited_content,
            analise_geral: "TEXTO TROCADO DEPOIS DA APROVACAO (marca da prova).",
          },
        } as never)
        .eq("id", doc.id);

      const { data: depois } = await db
        .from("prognostics")
        .select("status, reviewed_at, edited_content")
        .eq("participant_id", P.A.id)
        .single();
      const d = depois as Record<string, any>;
      anota("elo4_troca_de_conteudo_pos_aprovacao", {
        erro: error?.message ?? null,
        status_continua: d.status,
        reviewed_at_mudou: d.reviewed_at !== revisadoEm,
        texto_agora: String(d.edited_content?.analise_geral ?? "").slice(0, 60),
      });
      // MEDIDO: o conteudo trocou, o status seguiu `reviewed` e `reviewed_at`
      // nao mudou -- a aprovacao anterior cobre um texto que ninguem aprovou.
      expect(error).toBeNull();
      expect(d.status).toBe("reviewed");
      expect(d.reviewed_at).toBe(revisadoEm);
    });

    it("depois de ENTREGUE, a rota de revisao nao consegue mais escrever (regressao recusada pelo banco)", async () => {
      const { data } = await db
        .from("prognostics")
        .select("id, status")
        .eq("participant_id", P.B.id)
        .single();
      const doc = data as Record<string, any>;
      expect(doc.status).toBe("delivered");
      // O PATCH de producao SEMPRE grava status='reviewed'. Sobre um documento
      // entregue, isso e regressao.
      const { error } = await db
        .from("prognostics")
        .update({
          edited_content: { analise_geral: "correcao pos-entrega" },
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
        } as never)
        .eq("id", doc.id);
      anota("elo4_corrigir_documento_entregue", error?.message ?? "ACEITO");
      expect(error).not.toBeNull();
    });
  });

  // ================================================================= ELO 5
  describe("elo 5 - ENTREGA", () => {
    it("A entrega: o participante CONSEGUE ver o documento dele pelo token", async () => {
      // Entrega de A (replica do botao "Entregar").
      const { data: a } = await db
        .from("prognostics")
        .select("id, raw_ai_output, edited_content")
        .eq("participant_id", P.A.id)
        .single();
      const doc = a as Record<string, any>;
      const { error } = await db
        .from("prognostics")
        .update({
          final_content: doc.edited_content ?? doc.raw_ai_output,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", doc.id);
      expect(error).toBeNull();

      const { data: comToken } = await db
        .from("prognostics")
        .select("public_share_token")
        .eq("participant_id", P.A.id)
        .single();
      const tokenDeA = (comToken as any).public_share_token as string;

      // CONSULTA EXATA de app/(participant)/prognostic/[token]/page.tsx.
      const { data: pagina } = await db
        .from("prognostics")
        .select("*, participants(full_name, event_id)")
        .eq("public_share_token", tokenDeA)
        .eq("status", "delivered")
        .single();
      const vista = pagina as Record<string, any>;
      anota("elo5_A_ve_o_proprio", {
        achou: !!vista,
        nome: vista?.participants?.full_name,
        texto: String((vista?.final_content ?? vista?.raw_ai_output)?.analise_geral ?? "").slice(0, 60),
      });
      expect(vista?.participants?.full_name).toBe("Participante A");

      // O que a entrega mostra e o texto REVISADO (final_content), nao o cru.
      anota(
        "elo5_entrega_mostra_texto_revisado",
        String(vista.final_content?.analise_geral ?? "").startsWith("TEXTO TROCADO"),
      );
    });

    it("A NAO ve o documento de B, e anonimo nao ve nenhum (com controle positivo)", async () => {
      const { data: tokens } = await db
        .from("prognostics")
        .select("participant_id, public_share_token")
        .in("participant_id", [P.A.id, P.B.id]);
      const mapa = Object.fromEntries(
        (tokens as any[]).map((t) => [t.participant_id, t.public_share_token]),
      );

      // Canal 1: o token. O token de A NAO devolve o documento de B.
      const { data: comTokenDeA } = await db
        .from("prognostics")
        .select("participant_id")
        .eq("public_share_token", mapa[P.A.id])
        .eq("status", "delivered");
      const idsVistos = (comTokenDeA as any[]).map((x) => x.participant_id);
      anota("elo5_token_de_A_devolve", idsVistos.map((i) => (i === P.A.id ? "A" : i === P.B.id ? "B" : i)));
      expect(idsVistos).toEqual([P.A.id]);

      // Canal 2: a RLS. Participante A, com a sessao dele, lendo prognostics.
      const comoA = clienteDaTela(P.A.token);
      const { data: rlsA } = await comoA.from("prognostics").select("participant_id");
      const vistosPorA = ((rlsA ?? []) as any[]).map((x) => x.participant_id);
      anota("elo5_RLS_A_ve", {
        total: vistosPorA.length,
        ve_o_proprio: vistosPorA.includes(P.A.id),
        ve_o_de_B: vistosPorA.includes(P.B.id),
      });
      expect(vistosPorA).toContain(P.A.id); // controle positivo
      expect(vistosPorA).not.toContain(P.B.id); // a negativa

      // Canal 3: anonimo nao ve nenhum.
      const { data: rlsAnon } = await clienteDaTela().from("prognostics").select("participant_id");
      anota("elo5_RLS_anonimo_ve", (rlsAnon ?? []).length);
      expect((rlsAnon ?? []).length).toBe(0);
    });

    it("MEDIDO: /api/prognostic-status/[token] nao filtra por `delivered`", async () => {
      // Documento de C, que nunca foi gerado/entregue -> gera um documento e
      // deixa em `generated`, depois roda a consulta EXATA da rota de status.
      await zerarCanario();
      // C tem resposta fora do dominio: o gerador recusa. Uso D, limpo.
      await criarParticipante("D");
      const erros = await gravarPelaTela("D", respostasCanonicas());
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("D");
      const g = await generatePrognostic(P.D.id, eventId);
      expect(g.ok).toBe(true);

      const { data: t } = await db
        .from("prognostics")
        .select("public_share_token, status")
        .eq("participant_id", P.D.id)
        .single();
      const tokenDeD = (t as any).public_share_token as string;

      // CONSULTA EXATA de app/api/prognostic-status/[token]/route.ts.
      const { data: status } = await db
        .from("prognostics")
        .select("pdf_url, status")
        .eq("public_share_token", tokenDeD)
        .single();
      anota("elo5_rota_de_status_sobre_documento_nao_entregue", status);

      // A pagina publica, com o MESMO token, recusa (filtra por delivered).
      const { data: pagina } = await db
        .from("prognostics")
        .select("id")
        .eq("public_share_token", tokenDeD)
        .eq("status", "delivered")
        .maybeSingle();
      anota("elo5_pagina_publica_sobre_o_mesmo_token", pagina ? "MOSTROU" : "404");
      expect(pagina).toBeNull();
      // MEDIDO: a rota de status devolve o estado de um documento que a pagina
      // recusa mostrar. Nao e o documento, mas e informacao fora da entrega.
      expect((status as any)?.status).toBe("generated");
    });
  });

  // ================================================================= ELO 6
  describe("elo 6 - OS BLOQUEIOS", () => {
    it("ORCAMENTO estourado: o disjuntor recusa com motivo proprio, ANTES de gastar", async () => {
      // Tetos de PRODUCAO (lib/jobs/config.ts): 100 por evento, 3 por
      // participante. O estouro e produzido lancando consumo no livro-razao
      // pelo caminho de producao (`registrarConsumo` -> RPC da migration 021),
      // nao mexendo no teto.
      const cliente = db as never;
      const TETO_EVENTO = 100;
      const TETO_PARTICIPANTE = 3;
      const pedirVeredito = () =>
        verificarOrcamento(cliente, {
          kind: "prognostico",
          eventId,
          participantId: P.A.id,
          tetoEventoPadrao: TETO_EVENTO,
          tetoParticipantePadrao: TETO_PARTICIPANTE,
        });

      // CONTROLE POSITIVO: com o livro-razao limpo, o disjuntor LIBERA.
      const comFolga = await pedirVeredito();
      anota("elo6_orcamento_com_folga", comFolga);
      expect(comFolga.permitido).toBe(true);

      // Queima as 3 tentativas do participante, uma por uma, como o worker faz.
      const trilha: unknown[] = [];
      for (let i = 1; i <= TETO_PARTICIPANTE; i++) {
        const totais = await registrarConsumo(cliente, {
          kind: "prognostico",
          eventId,
          participantId: P.A.id,
          chamadas: 1,
          abortada: false,
          motivo: `tentativa ${i} da prova`,
        });
        trilha.push({ tentativa: i, ...totais, permitido: (await pedirVeredito()).permitido });
      }
      anota("elo6_orcamento_queimando_as_tentativas", trilha);

      const estourado = await pedirVeredito();
      anota("elo6_orcamento_estourado", estourado);
      expect(estourado.permitido).toBe(false);
      expect(estourado.motivo).toContain("participante");

      // E o teto 0 NAO e estouro: a migration 021 declara que 0 DESLIGA aquele
      // teto. Medido para que ninguem leia "permitido" como furo.
      const tetoZero = await verificarOrcamento(cliente, {
        kind: "prognostico",
        eventId,
        participantId: P.A.id,
        tetoEventoPadrao: 0,
        tetoParticipantePadrao: 0,
      });
      anota("elo6_teto_zero_desliga_o_teto_por_desenho", {
        permitido: tetoZero.permitido,
        motivo: tetoZero.motivo,
      });
      expect(tetoZero.permitido).toBe(true);
    });

    it("RESPOSTAS INCOMPATIVEIS: 422 com codigo proprio, sem documento e sem gasto", async () => {
      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.C.id, eventId); // C tem q16 = 9
      const depois = await chamadasAoModelo();
      anota("elo6_fora_do_dominio_resultado", r);
      anota("elo6_fora_do_dominio_chamadas_ao_modelo", { antes, depois });
      expect(r.ok).toBe(false);
      expect((r as { status: number }).status).toBe(422);
      expect(depois).toBe(antes); // nao gastou credito

      const linhas = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.C.id}'`),
      );
      anota("elo6_documentos_de_C", linhas);
      expect(linhas).toBe(0); // nenhum documento sobre dado que nao presta
    });

    it("RESPOSTA PARCIAL - etapa faltando: recusa 400 sem gasto", async () => {
      await criarParticipante("E");
      const todas = respostasCanonicas();
      await gravarPelaTela("E", todas.slice(0, 4)); // 4 das 5 etapas
      await concluir("E"); // marcado como concluido mesmo assim
      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.E.id, eventId);
      const depois = await chamadasAoModelo();
      anota("elo6_parcial_etapa_faltando", r);
      anota("elo6_parcial_etapa_faltando_chamadas", { antes, depois });
      expect(r.ok).toBe(false);
      expect((r as { status: number }).status).toBe(400);
      expect(depois).toBe(antes);
    });

    it("RESPOSTA PARCIAL - 5 etapas mas perguntas faltando: virou documento?", async () => {
      await criarParticipante("F");
      // As 5 linhas existem (o portao de contexto-quiz conta LINHAS), mas as 24
      // Likert e as 6 situacionais que o motor consome estao ausentes.
      const omitir = new Set<string>();
      for (let i = 16; i <= 45; i++) omitir.add(`q${i}`);
      const erros = await gravarPelaTela("F", respostasCanonicas({ omitir }));
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("F");

      const bancoDiz = sql(
        `select valido from public.marco_zero_respostas_validas('${eventId}') where participant_id = '${P.F.id}'`,
      );
      anota("elo6_parcial_perguntas_banco_diz_valido", bancoDiz);

      const { data } = await db
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", P.F.id);
      const mz = calcularMarcoZero(achatarRespostas((data ?? []) as never));
      anota("elo6_parcial_perguntas_scoring", mz);

      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.F.id, eventId);
      const depois = await chamadasAoModelo();
      anota("elo6_parcial_perguntas_resultado", r);
      anota("elo6_parcial_perguntas_chamadas_ao_modelo", { antes, depois });

      const linhas = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.F.id}'`),
      );
      anota("elo6_parcial_perguntas_documentos_gravados", linhas);

      // Esta asserção e a MEDICAO, nao a preferencia: o relatorio diz em qual
      // lado o produto caiu. Se o gerador aceitar, `ok` e true e ha documento.
      anota("elo6_parcial_perguntas_veredito", r.ok ? "GEROU DOCUMENTO" : "RECUSOU");
      expect(typeof r.ok).toBe("boolean");
    });
  });
});
