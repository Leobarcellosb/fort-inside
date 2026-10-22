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
  PARAGRAFOS_DOCUMENTO_SUSPENSO,
  RODAPE_DOCUMENTO_SUSPENSO,
  TITULO_DOCUMENTO_SUSPENSO,
  textoIntegralDoAviso,
} from "../../components/features/prognostic/documento-suspenso";
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
    it("entregar SEM revisao e recusado pelo banco (migration 025), e a revisao legitima libera: controle positivo ao lado", async () => {
      // ASSERCAO REESCRITA. O que ela afirmava antes: "o sistema NAO exige
      // revisao antes de entregar: generated -> delivered passa" -- e passava
      // mesmo, com `reviewed_at` nulo. Isso e o caso EXTREMO do defeito 2
      // (conteudo entregue que nenhuma aprovacao cobre), e a migration 025 o
      // fecha: `delivered` exige `final_content` com a MESMA impressao digital
      // registrada em `conteudo_aprovado_hash`, e o selo so e escrito pelo
      // gatilho no ato de aprovacao (status `reviewed` com `reviewed_at` novo).
      // A evidencia nova e a recusa do banco + o selo nulo; o porque esta aqui.
      await zerarCanario();
      const g = await generatePrognostic(P.B.id, eventId);
      expect(g.ok).toBe(true);
      const { data: antes } = await db
        .from("prognostics")
        .select("id, status, raw_ai_output, edited_content, conteudo_aprovado_hash, aprovado_em")
        .eq("participant_id", P.B.id)
        .single();
      const docB = antes as Record<string, any>;
      const final = docB.edited_content ?? docB.raw_ai_output;
      anota("elo4_B_antes_da_entrega", {
        status: docB.status,
        selo: docB.conteudo_aprovado_hash,
        aprovado_em: docB.aprovado_em,
      });
      expect(docB.conteudo_aprovado_hash).toBeNull(); // documento nasce sem aprovacao

      const { error } = await db
        .from("prognostics")
        .update({
          final_content: final,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docB.id);
      anota("elo4_entrega_sem_revisao_recusa", {
        codigo: (error as any)?.code ?? null,
        mensagem: error?.message ?? "ACEITO",
      });
      const { data: depois } = await db
        .from("prognostics")
        .select("status, reviewed_at, delivered_at, final_content")
        .eq("participant_id", P.B.id)
        .single();
      anota("elo4_estado_de_B_apos_tentativa_de_entrega", {
        status: (depois as any).status,
        reviewed_at: (depois as any).reviewed_at,
        delivered_at: (depois as any).delivered_at,
        tem_final: !!(depois as any).final_content,
      });
      // A NEGATIVA: nada foi entregue, e o estado nao mudou.
      expect(error).not.toBeNull();
      expect((depois as any).status).toBe("generated");
      expect((depois as any).delivered_at).toBeNull();

      // CONTROLE POSITIVO, no mesmo ambiente: a revisao legitima (a escrita do
      // PATCH de producao) sela, e a entrega do texto aprovado passa.
      const revisadoB = { ...docB.raw_ai_output, analise_geral: "TEXTO REVISADO DE B (marca da prova)." };
      const { error: eRev } = await db
        .from("prognostics")
        .update({
          edited_content: revisadoB,
          trail_recommendation: revisadoB.trilha_recomendada,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", docB.id);
      expect(eRev).toBeNull();
      const seloDeB = sql(
        `select conteudo_aprovado_hash from public.prognostics where id = '${docB.id}'`,
      );
      const impressaoDoRevisado = sql(
        `select encode(sha256(convert_to(coalesce(edited_content, raw_ai_output)::text, 'UTF8')), 'hex')
           from public.prognostics where id = '${docB.id}'`,
      );
      anota("elo4_controle_positivo_selo_de_B", {
        selo: seloDeB.slice(0, 12),
        impressao_do_conteudo_em_revisao: impressaoDoRevisado.slice(0, 12),
      });
      expect(seloDeB).toBe(impressaoDoRevisado);

      const { error: eEnt } = await db
        .from("prognostics")
        .update({
          final_content: revisadoB,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docB.id);
      anota("elo4_controle_positivo_entrega_de_B", eEnt?.message ?? "ENTREGUE");
      expect(eEnt).toBeNull();
      const { data: fim } = await db
        .from("prognostics")
        .select("status, reviewed_at, delivered_at")
        .eq("participant_id", P.B.id)
        .single();
      anota("elo4_estado_de_B_apos_revisao_e_entrega", fim);
      expect((fim as any).status).toBe("delivered");
      expect((fim as any).reviewed_at).not.toBeNull();
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

    it("VERSIONAMENTO: segue UMA linha por participante, sem historico -- o que amarra a aprovacao e a IMPRESSAO DIGITAL do conteudo", async () => {
      const linhasDeA = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.A.id}'`),
      );
      const colunas = sql(
        `select string_agg(column_name, ',' order by ordinal_position)
           from information_schema.columns
          where table_schema = 'public' and table_name = 'prognostics'`,
      );
      const tabelasDeHistorico = sql(
        `select coalesce(string_agg(table_name, ',' order by table_name), '(nenhuma)')
           from information_schema.tables
          where table_schema = 'public'
            and (table_name like '%prognostic%version%'
              or table_name like '%prognostic%histor%'
              or table_name like '%version%prognostic%')`,
      );
      const travas = sql(
        `select coalesce(string_agg(conname, ',' order by conname), '(nenhuma)')
           from pg_constraint
          where conrelid = 'public.prognostics'::regclass and contype = 'c'`,
      );
      const gatilhos = sql(
        `select coalesce(string_agg(tgname, ',' order by tgname), '(nenhum)')
           from pg_trigger
          where tgrelid = 'public.prognostics'::regclass and not tgisinternal`,
      );
      anota("elo4_linhas_de_prognostico_de_A", linhasDeA);
      anota("elo4_colunas_de_prognostics", colunas.split(","));
      anota("elo4_tabelas_de_historico_ou_versao", tabelasDeHistorico);
      anota("elo4_checks_de_prognostics", travas.split(","));
      anota("elo4_gatilhos_de_prognostics", gatilhos.split(","));
      expect(linhasDeA).toBe(1);
      // ASSERCAO REESCRITA, pela SEGUNDA vez, e e por isso que as duas versoes
      // anteriores estao nomeadas aqui.
      //
      // 1a versao: so MEDIA a ausencia ("nenhuma coluna de versao, nenhuma
      //    tabela de historico") e parava ali, com o defeito 2 aberto.
      // 2a versao: media a ausencia de historico como LIMITACAO DECLARADA do
      //    desenho da 025 -- `expect(tabelasDeHistorico).toBe("(nenhuma)")` --
      //    porque o desenho escolhido foi amarrar a aprovacao a uma impressao
      //    digital, nao versionar.
      //
      // A revisao aceitou a protecao por hash E manteve a exigencia:
      // "preservar historico do conteudo entregue continua necessario". A
      // migration 026 a cumpre. Entao a EVIDENCIA NOVA e que a ausencia acabou:
      // existe tabela de historico, ela e escrita por gatilho proprio, e existe
      // a view que responde "o que esta pessoa leu, e quando".
      //
      // O que NAO mudou e segue medido aqui, porque continua sendo o desenho:
      // `prognostics` segue com UMA linha por participante e SEM coluna de
      // versao -- o historico nao versionou a tabela, ele registra ao lado o
      // que JA ESTEVE ENTREGUE. E as tres pecas da 025 seguem todas de pe.
      expect(colunas.split(",")).not.toContain("version");
      expect(tabelasDeHistorico).toBe("prognostic_delivery_history");
      expect(
        sql(
          `select count(*) from information_schema.views
            where table_schema = 'public'
              and table_name = 'v_historico_do_conteudo_entregue'`,
        ),
      ).toBe("1");
      expect(gatilhos.split(",")).toContain("prognostics_historico_do_entregue");
      expect(colunas.split(",")).toContain("conteudo_aprovado_hash");
      expect(colunas.split(",")).toContain("aprovado_em");
      expect(travas.split(",")).toContain("prognostics_entrega_cobre_aprovacao");
      expect(gatilhos.split(",")).toContain("prognostics_selo_de_aprovacao");
      // O gatilho da 015 continua no lugar: ele cobre regressao de ESTADO, que
      // e outro fato e nao foi substituido por este trabalho.
      expect(gatilhos.split(",")).toContain("prognostics_status_sem_regressao");
    });

    it("CONTEUDO TROCADO DEPOIS DE APROVADO: a aprovacao DEIXA de cobri-lo e a ENTREGA e recusada", async () => {
      // ASSERCAO REESCRITA. Antes este teste terminava em
      // `expect(d.status).toBe("reviewed")` e `expect(d.reviewed_at).toBe(...)`
      // -- isto e, AFIRMAVA o defeito: "a aprovacao anterior continua valendo
      // sobre um texto diferente do que foi aprovado". Os dois fatos antigos
      // continuam verdadeiros e seguem medidos (a troca de conteudo e uma
      // escrita legitima, e o gatilho da 015 nem dispara, porque ele e
      // `before update of status`). O que mudou e a CONSEQUENCIA, e e ela a
      // evidencia nova: o selo de aprovacao deixa de bater com o conteudo, e o
      // banco RECUSA entregar esse texto. O selo nao e apagado nem reescrito --
      // ele segue dizendo a verdade sobre qual texto foi aprovado.
      const { data: antes } = await db
        .from("prognostics")
        .select("id, status, reviewed_at, edited_content, conteudo_aprovado_hash")
        .eq("participant_id", P.A.id)
        .single();
      const doc = antes as Record<string, any>;
      const revisadoEm = doc.reviewed_at;
      const seloDaAprovacao = doc.conteudo_aprovado_hash as string;
      expect(seloDaAprovacao).not.toBeNull();

      const trocado = {
        ...doc.edited_content,
        analise_geral: "TEXTO TROCADO DEPOIS DA APROVACAO (marca da prova).",
      };
      // Troca SO o conteudo, sem tocar no status nem na data de revisao.
      const { error } = await db
        .from("prognostics")
        .update({ edited_content: trocado } as never)
        .eq("id", doc.id);

      const { data: depois } = await db
        .from("prognostics")
        .select("status, reviewed_at, edited_content, conteudo_aprovado_hash")
        .eq("participant_id", P.A.id)
        .single();
      const d = depois as Record<string, any>;
      const impressaoDoTextoDeAgora = sql(
        `select encode(sha256(convert_to(coalesce(edited_content, raw_ai_output)::text, 'UTF8')), 'hex')
           from public.prognostics where id = '${doc.id}'`,
      );
      anota("elo4_troca_de_conteudo_pos_aprovacao", {
        erro: error?.message ?? null,
        status_continua: d.status,
        reviewed_at_mudou: d.reviewed_at !== revisadoEm,
        texto_agora: String(d.edited_content?.analise_geral ?? "").slice(0, 60),
        selo_mudou: d.conteudo_aprovado_hash !== seloDaAprovacao,
        selo: String(d.conteudo_aprovado_hash).slice(0, 12),
        impressao_do_texto_de_agora: impressaoDoTextoDeAgora.slice(0, 12),
      });
      expect(error).toBeNull();
      expect(d.status).toBe("reviewed");
      expect(d.reviewed_at).toBe(revisadoEm);
      // O selo e IMUTAVEL fora do ato de aprovacao, e agora NAO cobre o texto.
      expect(d.conteudo_aprovado_hash).toBe(seloDaAprovacao);
      expect(impressaoDoTextoDeAgora).not.toBe(seloDaAprovacao);

      // A CONSEQUENCIA: entregar o texto trocado e RECUSADO pelo banco.
      const { error: eEntrega } = await db
        .from("prognostics")
        .update({
          final_content: trocado,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", doc.id);
      anota("elo4_entrega_do_texto_trocado", {
        codigo: (eEntrega as any)?.code ?? null,
        mensagem: eEntrega?.message ?? "ACEITO",
      });
      expect(eEntrega).not.toBeNull();

      // E O QUE O PARTICIPANTE VE: a consulta EXATA da pagina de entrega
      // (app/(participant)/prognostic/[token]/page.tsx) nao acha nada.
      const tokenDeA = sql(
        `select public_share_token from public.prognostics where id = '${doc.id}'`,
      );
      const { data: pagina } = await db
        .from("prognostics")
        .select("final_content")
        .eq("public_share_token", tokenDeA)
        .eq("status", "delivered")
        .maybeSingle();
      anota("elo4_o_que_o_participante_ve_com_o_texto_trocado", pagina ? "MOSTROU" : "404 (nada entregue)");
      expect(pagina).toBeNull();
    });

    it("CONTROLE POSITIVO da correcao legitima: salvar a revisao REAPROVA no mesmo ato e a entrega e liberada", async () => {
      // A decisao de produto declarada: corrigir uma virgula INVALIDA a
      // aprovacao anterior (teste acima) E a propria correcao, salva pelo
      // caminho da revisao, e uma nova aprovacao -- a rota grava status
      // `reviewed` com `reviewed_at` NOVO, e o gatilho sela o texto daquele
      // instante. Sem este controle positivo, a correcao acima poderia estar
      // medindo "entrega quebrada para todo mundo".
      const { data: antes } = await db
        .from("prognostics")
        .select("id, reviewed_at, raw_ai_output, conteudo_aprovado_hash")
        .eq("participant_id", P.A.id)
        .single();
      const doc = antes as Record<string, any>;
      const seloAntigo = doc.conteudo_aprovado_hash as string;
      const revisadoEmAntigo = doc.reviewed_at as string;

      const reaprovado = {
        ...doc.raw_ai_output,
        analise_geral: "TEXTO REAPROVADO PELO HOST APOS CORRECAO (marca da prova).",
      };
      // A MESMA escrita de app/api/prognostics/[id]/route.ts.
      const { error } = await db
        .from("prognostics")
        .update({
          edited_content: reaprovado,
          yuri_note: null,
          trail_recommendation: reaprovado.trilha_recomendada,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", doc.id);
      expect(error).toBeNull();

      const { data: depois } = await db
        .from("prognostics")
        .select("reviewed_at, aprovado_em, conteudo_aprovado_hash")
        .eq("participant_id", P.A.id)
        .single();
      const d = depois as Record<string, any>;
      const impressaoDoReaprovado = sql(
        `select encode(sha256(convert_to(coalesce(edited_content, raw_ai_output)::text, 'UTF8')), 'hex')
           from public.prognostics where id = '${doc.id}'`,
      );
      anota("elo4_reaprovacao", {
        selo_novo: String(d.conteudo_aprovado_hash).slice(0, 12),
        selo_antigo: String(seloAntigo).slice(0, 12),
        impressao_do_texto_reaprovado: impressaoDoReaprovado.slice(0, 12),
        aprovado_em_igual_reviewed_at: d.aprovado_em === d.reviewed_at,
        reviewed_at_avancou: d.reviewed_at !== revisadoEmAntigo,
      });
      expect(d.conteudo_aprovado_hash).toBe(impressaoDoReaprovado);
      expect(d.conteudo_aprovado_hash).not.toBe(seloAntigo);
      expect(d.aprovado_em).toBe(d.reviewed_at);
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
      anota("elo4_corrigir_documento_entregue", {
        codigo: (error as any)?.code ?? null,
        mensagem: error?.message ?? "ACEITO",
      });
      expect(error).not.toBeNull();
      // ASSERCAO ACRESCENTADA: o codigo do banco e `23514` (check_violation), e
      // e exatamente nele que `app/api/prognostics/[id]/route.ts` passou a
      // ramificar para devolver PROGNOSTIC_STATE_REGRESSION (400) em vez do
      // texto cru do banco com 500 -- erro de produto vestido de falha de
      // servidor. A rota em si nao e servida nesta prova (ver o cabecalho); o
      // que esta prova garante e o FATO de banco em que ela se apoia.
      expect((error as any)?.code).toBe("23514");
    });

    // ===================================================================
    // HISTORICO DO CONTEUDO ENTREGUE (migration 026)
    // ===================================================================
    it("HISTORICO: o conteudo entregue de B foi registrado pelo banco, com impressao e data", async () => {
      // A primeira metade da exigencia que sobrou da revisao: "preservar
      // historico do conteudo entregue continua necessario". B foi revisado e
      // entregue no primeiro teste deste elo. O registro nao e feito pela
      // aplicacao: quem sabe que uma entrega aconteceu e o banco, no mesmo
      // instante em que ela passa pelo portao da 025.
      const linhas = sql(
        `select sequencia || '|' || (conteudo->>'analise_geral') || '|' || left(conteudo_hash, 16)
           from public.v_historico_do_conteudo_entregue
          where participant_id = '${P.B.id}'
          order by sequencia`,
      );
      const impressaoDoEntregue = sql(
        `select encode(sha256(convert_to(final_content::text, 'UTF8')), 'hex')
           from public.prognostics where participant_id = '${P.B.id}'`,
      );
      const conferencia = sql(
        `select (h.conteudo_hash = p.conteudo_aprovado_hash)::text || '|' ||
                (h.conteudo = p.final_content)::text || '|' ||
                (h.leu_ate is null)::text || '|' || h.vigente::text
           from public.v_historico_do_conteudo_entregue h
           join public.prognostics p on p.id = h.prognostic_id
          where h.participant_id = '${P.B.id}'
          order by h.sequencia desc limit 1`,
      );
      anota("elo4_historico_de_B_apos_a_1a_entrega", linhas.split("\n"));
      anota("elo4_historico_de_B_confere_com_prognostics", {
        impressao_do_entregue: impressaoDoEntregue.slice(0, 16),
        hash_bate_com_o_selo_de_aprovacao: conferencia.split("|")[0],
        conteudo_identico_ao_final_content: conferencia.split("|")[1],
        leu_ate_nulo_porque_e_o_vigente: conferencia.split("|")[2],
        vigente: conferencia.split("|")[3],
      });

      // UMA linha: o texto que B leu, e so ele.
      expect(linhas.split("\n")).toHaveLength(1);
      expect(linhas).toContain("TEXTO REVISADO DE B (marca da prova).");
      expect(linhas).toContain(impressaoDoEntregue.slice(0, 16));
      // O que foi registrado e o MESMO que o selo de aprovacao cobre: o
      // historico e a 025 falam do mesmo texto, nao de dois.
      expect(conferencia).toBe("true|true|true|true");

      // E escrita que NAO e entrega nova nao duplica linha: a linha entregue
      // recebe outras escritas depois (pdf_url, por exemplo) e cada uma dispara
      // o gatilho. Sem a deduplicacao o historico encheria de repeticoes do
      // mesmo texto, e "o que esta pessoa leu" viraria uma lista de copias.
      const { error } = await db
        .from("prognostics")
        .update({ pdf_url: "https://127.0.0.1/pdf-da-prova.pdf" } as never)
        .eq("participant_id", P.B.id);
      expect(error).toBeNull();
      const depoisDoPdf = Number(
        sql(
          `select count(*) from public.prognostic_delivery_history
            where participant_id = '${P.B.id}'`,
        ),
      );
      anota("elo4_historico_de_B_apos_escrita_que_nao_e_entrega", depoisDoPdf);
      expect(depoisDoPdf).toBe(1);
    });

    it("HISTORICO: entregue, CORRIGIDO e REENTREGUE -- os DOIS textos, suas impressoes e suas datas", async () => {
      // O caso que a revisao nomeou: "se um documento for entregue, depois
      // corrigido e reentregue, ninguem consegue reconstruir o que o jovem leu
      // da primeira vez".
      //
      // ACHADO MEDIDO, declarado, e ele muda o COMO desta prova: corrigir um
      // documento JA ENTREGUE nao e possivel pelo caminho comum. O teste acima
      // mediu a recusa -- `delivered` nao regride para `reviewed` (gatilho da
      // 015) -- e sem voltar a `reviewed` o selo da 025 nao se refaz, entao a
      // entrega do texto corrigido tambem seria recusada. As duas protecoes,
      // juntas, fecham o caminho comum. Esta unidade NAO mexe nisso: afrouxar a
      // maquina de estados seria decisao de produto que ninguem autorizou.
      //
      // Entao a correcao de documento entregue segue exigindo o PROCEDIMENTO
      // EXCEPCIONAL de quem e dono da tabela (DDL para desligar o gatilho de
      // estado) -- e e exatamente ali que o texto anterior desaparecia, porque
      // o selo da 025 e reescrito no ato da nova aprovacao. O gatilho do
      // historico nao participa da maquina de estados e continua de pe durante
      // o procedimento: e isso que esta prova mede.
      const docId = sql(
        `select id from public.prognostics where participant_id = '${P.B.id}'`,
      );
      const primeiroTexto = sql(
        `select conteudo->>'analise_geral' from public.prognostic_delivery_history
          where participant_id = '${P.B.id}' order by sequencia limit 1`,
      );
      const primeiraImpressao = sql(
        `select conteudo_hash from public.prognostic_delivery_history
          where participant_id = '${P.B.id}' order by sequencia limit 1`,
      );

      // O PROCEDIMENTO EXCEPCIONAL, passo a passo e nomeado. Nenhum gatilho do
      // historico e desligado, e o selo da 025 segue sendo exigido: o texto
      // corrigido so e entregue porque foi REAPROVADO sobre ele mesmo.
      sql(
        `alter table public.prognostics disable trigger prognostics_status_sem_regressao;
         update public.prognostics
            set edited_content = '{"analise_geral":"TEXTO CORRIGIDO DE B (segunda versao da prova)."}'::jsonb,
                status = 'reviewed',
                reviewed_at = now()
          where id = '${docId}';
         alter table public.prognostics enable trigger prognostics_status_sem_regressao;`,
      );
      // A REENTREGA, pelo caminho normal: nada desligado aqui.
      const { error: eReentrega } = await db
        .from("prognostics")
        .update({
          final_content: {
            analise_geral: "TEXTO CORRIGIDO DE B (segunda versao da prova).",
          },
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docId);
      anota("elo4_reentrega_de_B", eReentrega?.message ?? "REENTREGUE");
      expect(eReentrega).toBeNull();

      const historico = sql(
        `select sequencia || ' :: ' || (conteudo->>'analise_geral')
                || ' :: impressao=' || left(conteudo_hash, 16)
                || ' :: leu_de=' || leu_a_partir_de
                || ' :: leu_ate=' || coalesce(leu_ate::text, '(vigente)')
                || ' :: aprovado_em=' || coalesce(aprovado_em::text, '(nulo)')
           from public.v_historico_do_conteudo_entregue
          where participant_id = '${P.B.id}'
          order by sequencia`,
      );
      anota("elo4_historico_de_B_os_dois_textos", historico.split("\n"));

      const campos = sql(
        `select string_agg(linha, '#') from (
           select (conteudo->>'analise_geral') || '|' || conteudo_hash || '|' ||
                  (leu_ate is null)::text || '|' || vigente::text as linha
             from public.v_historico_do_conteudo_entregue
            where participant_id = '${P.B.id}'
            order by sequencia
         ) x`,
      ).split("#");
      expect(campos).toHaveLength(2);

      const [um, dois] = campos.map((l) => l.split("|"));
      // OS DOIS TEXTOS: o primeiro nao foi sobrescrito nem apagado.
      expect(um[0]).toBe(primeiroTexto);
      expect(dois[0]).toBe("TEXTO CORRIGIDO DE B (segunda versao da prova).");
      // AS DUAS IMPRESSOES, diferentes entre si, e a primeira e a que ja
      // estava registrada antes da correcao.
      expect(um[1]).toBe(primeiraImpressao);
      expect(dois[1]).not.toBe(um[1]);
      expect(dois[1]).toBe(
        sql(
          `select encode(sha256(convert_to(final_content::text, 'UTF8')), 'hex')
             from public.prognostics where id = '${docId}'`,
        ),
      );
      // AS DUAS DATAS: a primeira deixou de valer EXATAMENTE quando a segunda
      // passou a valer, e so a segunda e a vigente. `leu_ate` nao e coluna --
      // e derivado na view, porque guarda-lo exigiria UPDATE no historico, que
      // e justamente o privilegio que o historico nao concede a ninguem.
      expect(um[2]).toBe("false"); // a primeira tem `leu_ate`
      expect(um[3]).toBe("false");
      expect(dois[2]).toBe("true"); // a segunda e a vigente
      expect(dois[3]).toBe("true");
      expect(
        sql(
          `select (
             (select leu_ate from public.v_historico_do_conteudo_entregue
               where participant_id = '${P.B.id}' order by sequencia limit 1)
             =
             (select leu_a_partir_de from public.v_historico_do_conteudo_entregue
               where participant_id = '${P.B.id}' order by sequencia desc limit 1)
           )::text`,
        ),
      ).toBe("true");
      // E a pergunta que o historico existe para responder, respondida: o selo
      // de aprovacao vigente cobre o texto VIGENTE, e nao o que foi lido antes.
      expect(
        sql(
          `select (p.conteudo_aprovado_hash = h.conteudo_hash)::text
             from public.prognostics p
             join public.prognostic_delivery_history h on h.prognostic_id = p.id
            where p.id = '${docId}' order by h.sequencia desc limit 1`,
        ),
      ).toBe("true");
      expect(
        sql(
          `select (p.conteudo_aprovado_hash = h.conteudo_hash)::text
             from public.prognostics p
             join public.prognostic_delivery_history h on h.prognostic_id = p.id
            where p.id = '${docId}' order by h.sequencia asc limit 1`,
        ),
      ).toBe("false");
    });

    it("HISTORICO APPEND-ONLY: privilegio CONFERIDO no banco, e a tentativa real recusada", async () => {
      // "Sem privilegio de alteracao nem de remocao" nao e afirmacao: e
      // consulta. Mesma tecnica da 022, com `service_role` nomeado -- ele e o
      // papel com que as rotas de administracao escrevem e ele NAO e alcancado
      // pela RLS (BYPASSRLS).
      const privilegios = sql(
        `select r.papel || ': ler=' ||
                has_table_privilege(r.papel, 'public.prognostic_delivery_history', 'select')::text ||
                ' inserir=' ||
                has_table_privilege(r.papel, 'public.prognostic_delivery_history', 'insert')::text ||
                ' alterar=' ||
                has_table_privilege(r.papel, 'public.prognostic_delivery_history', 'update')::text ||
                ' apagar=' ||
                has_table_privilege(r.papel, 'public.prognostic_delivery_history', 'delete')::text ||
                ' truncar=' ||
                has_table_privilege(r.papel, 'public.prognostic_delivery_history', 'truncate')::text
           from (values ('anon'), ('authenticated'), ('service_role')) as r(papel)
          order by r.papel`,
      );
      const rls = sql(
        `select relrowsecurity::text from pg_class
          where oid = 'public.prognostic_delivery_history'::regclass`,
      );
      const policies = sql(
        `select coalesce(string_agg(polname || '[' || polcmd::text || ']', ',' order by polname), '(nenhuma)')
           from pg_policy where polrelid = 'public.prognostic_delivery_history'::regclass`,
      );
      anota("elo4_historico_privilegios_conferidos_no_banco", privilegios.split("\n"));
      anota("elo4_historico_rls_e_policies", { rls_ligada: rls, policies });

      // NENHUM dos tres papeis altera, apaga, trunca OU insere.
      for (const papel of ["anon", "authenticated", "service_role"]) {
        expect(privilegios).toContain(`${papel}: ler=`);
      }
      expect(privilegios).not.toMatch(/alterar=true/);
      expect(privilegios).not.toMatch(/apagar=true/);
      expect(privilegios).not.toMatch(/truncar=true/);
      expect(privilegios).not.toMatch(/inserir=true/);
      // Ler, sim -- o historico existe para ser lido; a RLS decide por quem, e
      // nao existe policy de escrita para ninguem abrir por descuido.
      expect(privilegios).toContain("authenticated: ler=true");
      expect(privilegios).toContain("service_role: ler=true");
      expect(privilegios).toContain("anon: ler=false");
      expect(rls).toBe("true");
      expect(policies).toBe("prognostic_delivery_history_admin_select[r]");

      // A TENTATIVA REAL, pelo caminho da aplicacao (PostgREST com a chave de
      // service_role): nao basta o privilegio estar revogado na consulta acima,
      // a escrita tem de ser recusada de fato.
      const linhasAntes = sql(
        `select count(*) from public.prognostic_delivery_history`,
      );
      const alterar = await fetch(
        `${SUPA}/rest/v1/prognostic_delivery_history?participant_id=eq.${P.B.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE,
            Authorization: `Bearer ${SERVICE}`,
            "content-type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({ conteudo: { analise_geral: "REESCRITO PELA PROVA" } }),
        },
      );
      const apagar = await fetch(
        `${SUPA}/rest/v1/prognostic_delivery_history?participant_id=eq.${P.B.id}`,
        {
          method: "DELETE",
          headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
        },
      );
      const inserir = await fetch(`${SUPA}/rest/v1/prognostic_delivery_history`, {
        method: "POST",
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prognostic_id: sql(
            `select id from public.prognostics where participant_id = '${P.B.id}'`,
          ),
          participant_id: P.B.id,
          conteudo: { analise_geral: "ENTREGA QUE NUNCA ACONTECEU" },
          conteudo_hash:
            "0000000000000000000000000000000000000000000000000000000000000000",
          passou_a_valer_em: new Date().toISOString(),
        }),
      });
      const linhasDepois = sql(
        `select count(*) from public.prognostic_delivery_history`,
      );
      const textosDepois = sql(
        `select string_agg(conteudo->>'analise_geral', ' | ' order by sequencia)
           from public.prognostic_delivery_history where participant_id = '${P.B.id}'`,
      );
      anota("elo4_historico_tentativa_real_como_service_role", {
        alterar: alterar.status,
        apagar: apagar.status,
        inserir: inserir.status,
        linhas: { antes: linhasAntes, depois: linhasDepois },
        textos_depois: textosDepois,
      });

      // Recusadas as tres, e o historico intacto -- os dois textos ainda la.
      expect(alterar.ok).toBe(false);
      expect(apagar.ok).toBe(false);
      expect(inserir.ok).toBe(false);
      expect(linhasDepois).toBe(linhasAntes);
      expect(textosDepois).toContain("TEXTO REVISADO DE B (marca da prova).");
      expect(textosDepois).toContain("TEXTO CORRIGIDO DE B (segunda versao da prova).");

      // E a impressao digital nao pode mentir NEM PARA O DONO da tabela: o
      // CHECK recalcula o hash do conteudo da propria linha em toda escrita.
      // Sem isto, o unico caminho que sobra (DDL de quem e dono) poderia trocar
      // o texto e manter a impressao antiga -- e o historico passaria a afirmar
      // sobre si mesmo a unica coisa que ele nao pode errar.
      let recusouODono = "ACEITO (nao deveria)";
      try {
        sql(
          `update public.prognostic_delivery_history
              set conteudo = '{"analise_geral":"TEXTO FORJADO"}'::jsonb
            where participant_id = '${P.B.id}'`,
        );
      } catch (err) {
        recusouODono = String((err as Error).message).includes(
          "prognostic_delivery_history_hash_do_conteudo",
        )
          ? "RECUSADO pelo CHECK do hash"
          : `RECUSADO: ${String((err as Error).message).slice(0, 120)}`;
      }
      anota("elo4_historico_dono_da_tabela_nao_forja_impressao", recusouODono);
      expect(recusouODono).toBe("RECUSADO pelo CHECK do hash");
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

      // ASSERCAO REESCRITA. Antes esta linha apenas ANOTAVA que a entrega
      // mostrava o texto que comecava com "TEXTO TROCADO" -- o texto que
      // ninguem aprovou. Agora o que chega ao participante e o texto
      // REAPROVADO, e o trocado nao chega: a entrega so passou depois da
      // reaprovacao, e o que foi entregue tem a impressao digital aprovada.
      const textoEntregue = String(vista.final_content?.analise_geral ?? "");
      anota("elo5_texto_que_o_participante_ve", textoEntregue.slice(0, 70));
      anota("elo5_entrega_mostra_texto_reaprovado", textoEntregue.startsWith("TEXTO REAPROVADO"));
      expect(textoEntregue).toContain("TEXTO REAPROVADO");
      expect(textoEntregue).not.toContain("TEXTO TROCADO");
      const conferencia = sql(
        `select conteudo_aprovado_hash = encode(sha256(convert_to(final_content::text, 'UTF8')), 'hex')
           from public.prognostics where participant_id = '${P.A.id}'`,
      );
      anota("elo5_impressao_do_entregue_bate_com_a_aprovada", conferencia);
      expect(conferencia).toBe("t");
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

    it("RESPOSTA PARCIAL - 5 etapas mas as 30 perguntas do motor ausentes: RECUSADO, sem chamada ao modelo e sem documento", async () => {
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

      // ASSERCAO REESCRITA. Antes era `expect(typeof r.ok).toBe("boolean")` --
      // uma assercao que passa nos DOIS lados e por isso documentava o defeito
      // 1 sem reprova-lo (medido: o gerador ACEITOU, chamou o modelo, gastou a
      // chamada e GRAVOU o documento com os quatro eixos em zero). A evidencia
      // nova e a recusa COM CODIGO PROPRIO do portao de completude
      // (lib/ai/completude-marco-zero.ts), zero chamada ao modelo e zero linha
      // em `prognostics`.
      anota("elo6_parcial_perguntas_veredito", r.ok ? "GEROU DOCUMENTO" : "RECUSOU");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(400);
      expect(r.code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
      expect(r.detalhes?.blocos_incompletos).toEqual(["likert", "situacional"]);
      expect(r.detalhes?.itens?.length).toBe(30);
      // A mensagem DIZ O QUE FALTA, e nao carrega texto de resposta de ninguem.
      expect(r.error).toContain("de 24");
      expect(depois).toBe(antes); // nenhuma chamada ao modelo
      expect(linhas).toBe(0); // nenhum documento gravado
    });

    // ASSERCAO REESCRITA, e esta e a MUDANCA DE COMPORTAMENTO desta unidade.
    //
    // O que ela afirmava antes: "FRONTEIRA DO LIMIAR, os dois lados: 2 Elementos
    // ausentes GERA; 3 ausentes RECUSA" -- o participante G, com 5 de 7
    // Elementos, GERAVA documento, e o teste media isso como controle positivo
    // do piso `MINIMO_ELEMENTOS_ANALISE_PARCIAL` (5), importado do motor.
    //
    // A revisao aprovou a arquitetura do portao e RECUSOU essa tolerancia:
    // "aprovo a arquitetura do novo portao, mas nao a flexibilizacao de
    // perguntas obrigatorias". As sete perguntas dos Elementos sao obrigatorias
    // no questionario canonico, e uma regra de completude que tolera a falta de
    // pergunta obrigatoria contradiz o contrato do instrumento. O piso do motor
    // existe para separar leitura "parcial" de "insuficiente" DENTRO da
    // analise, nao para decidir se um documento pode existir.
    //
    // A EVIDENCIA NOVA, e e por isso que a fronteira foi remedida aqui em vez
    // de o teste antigo ser apagado: a fronteira MUDOU DE LUGAR. Ela nao esta
    // mais entre 5 e 4 -- esta entre 7 e 6. Os tres estados ficam medidos no
    // mesmo ambiente: 6 de 7 recusa (uma unica ausente, o caso mais barato de
    // esquecer), 5 de 7 recusa (o caso que ANTES gerava) e 4 de 7 segue
    // recusando. Com o controle positivo ao lado, para que a medicao nao possa
    // ser "o portao passou a recusar todo mundo".
    it("FRONTEIRA DO LIMIAR nos Elementos: 6 de 7 RECUSA (antes gerava), 5 de 7 RECUSA, 7 de 7 GERA", async () => {
      await criarParticipante("G"); // 6 de 7: UMA ausente
      const errosG = await gravarPelaTela("G", respostasCanonicas({ omitir: new Set(["q13"]) }));
      expect(errosG.every((e) => e === null)).toBe(true);
      await concluir("G");

      await criarParticipante("J"); // 5 de 7: o estado que ANTES virava documento
      const errosJ = await gravarPelaTela(
        "J",
        respostasCanonicas({ omitir: new Set(["q12", "q13"]) }),
      );
      expect(errosJ.every((e) => e === null)).toBe(true);
      await concluir("J");

      await criarParticipante("H"); // 4 de 7: seguia e segue recusado
      const errosH = await gravarPelaTela(
        "H",
        respostasCanonicas({ omitir: new Set(["q11", "q12", "q13"]) }),
      );
      expect(errosH.every((e) => e === null)).toBe(true);
      await concluir("H");

      // CONTROLE POSITIVO no MESMO ato: as 52 respondidas, nada omitido.
      await criarParticipante("K");
      const errosK = await gravarPelaTela("K", respostasCanonicas());
      expect(errosK.every((e) => e === null)).toBe(true);
      await concluir("K");

      await zerarCanario();
      const antes = await chamadasAoModelo();
      const rG = await generatePrognostic(P.G.id, eventId);
      const depoisDeG = await chamadasAoModelo();
      const rJ = await generatePrognostic(P.J.id, eventId);
      const depoisDeJ = await chamadasAoModelo();
      const rH = await generatePrognostic(P.H.id, eventId);
      const depoisDeH = await chamadasAoModelo();
      const rK = await generatePrognostic(P.K.id, eventId);
      const depoisDeK = await chamadasAoModelo();

      const docs = (apelido: string) =>
        Number(
          sql(`select count(*) from public.prognostics where participant_id = '${P[apelido].id}'`),
        );

      anota("elo6_fronteira_6_de_7_elementos", {
        ok: rG.ok,
        status: (rG as any).status ?? null,
        code: (rG as any).code ?? null,
        detalhes: (rG as any).detalhes ?? null,
        error: (rG as any).error ?? null,
        chamadas: { antes, depois: depoisDeG },
        documentos_gravados: docs("G"),
      });
      anota("elo6_fronteira_5_de_7_elementos_o_caso_que_antes_gerava", {
        ok: rJ.ok,
        code: (rJ as any).code ?? null,
        detalhes: (rJ as any).detalhes ?? null,
        chamadas: { antes: depoisDeG, depois: depoisDeJ },
        documentos_gravados: docs("J"),
      });
      anota("elo6_fronteira_4_de_7_elementos", {
        ok: rH.ok,
        code: (rH as any).code ?? null,
        detalhes: (rH as any).detalhes ?? null,
        chamadas: { antes: depoisDeJ, depois: depoisDeH },
        documentos_gravados: docs("H"),
      });
      anota("elo6_fronteira_controle_positivo_7_de_7", {
        ok: rK.ok,
        chamadas: { antes: depoisDeH, depois: depoisDeK },
        documentos_gravados: docs("K"),
      });

      // 6 DE 7: RECUSADO, com codigo proprio, ZERO chamada ao modelo e ZERO
      // documento gravado. Este caso GERAVA antes desta unidade.
      expect(rG.ok).toBe(false);
      expect((rG as any).status).toBe(400);
      expect((rG as any).code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
      expect((rG as any).detalhes?.blocos_incompletos).toEqual(["elementos"]);
      expect((rG as any).detalhes?.itens).toEqual(["q13"]);
      expect((rG as any).detalhes?.completude).toEqual([
        { bloco: "elementos", respondidas: 6, total: 7, minimo: 7 },
      ]);
      expect(depoisDeG).toBe(antes);
      expect(docs("G")).toBe(0);

      // 5 DE 7: o estado que o teste antigo media como "GERA". Recusado agora.
      expect(rJ.ok).toBe(false);
      expect((rJ as any).code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
      expect((rJ as any).detalhes?.itens).toEqual(["q12", "q13"]);
      expect(depoisDeJ).toBe(depoisDeG);
      expect(docs("J")).toBe(0);

      // 4 DE 7: segue recusado, pelo mesmo bloco e sem gasto.
      expect(rH.ok).toBe(false);
      expect((rH as any).code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
      expect((rH as any).detalhes?.blocos_incompletos).toEqual(["elementos"]);
      expect(depoisDeH).toBe(depoisDeJ);
      expect(docs("H")).toBe(0);

      // CONTROLE POSITIVO: 7 de 7 gera, gasta a chamada e grava o documento.
      // Sem ele, as tres recusas acima nao distinguiriam "limiar correto" de
      // "portao quebrado".
      expect(rK.ok).toBe(true);
      expect(depoisDeK).toBeGreaterThan(depoisDeH);
      expect(docs("K")).toBe(1);
    });

    it("FRONTEIRA DO LIMIAR: UMA pergunta Likert em branco (29 de 30) ja RECUSA, e o controle positivo e A", async () => {
      // O lado rigido do limiar, medido: nos blocos Likert e situacional o item
      // ausente nao vira "nao sei", vira ZERO na soma -- entao uma pergunta em
      // branco produz um eixo REBAIXADO, e o texto falaria com autoridade sobre
      // uma medida errada. Zero tolerancia ali e decisao declarada, e ela nao
      // custa documento de quem respondeu pelo aplicativo: as 37 perguntas que
      // o motor consome sao todas `required` e a tela nao deixa enviar a etapa
      // com pergunta `required` em branco.
      await criarParticipante("I");
      const erros = await gravarPelaTela("I", respostasCanonicas({ omitir: new Set(["q31"]) }));
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("I");

      await zerarCanario();
      const antes = await chamadasAoModelo();
      const r = await generatePrognostic(P.I.id, eventId);
      const depois = await chamadasAoModelo();
      const linhas = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.I.id}'`),
      );
      anota("elo6_fronteira_uma_likert_em_branco", {
        ok: r.ok,
        status: (r as any).status ?? null,
        code: (r as any).code ?? null,
        detalhes: (r as any).detalhes ?? null,
        error: (r as any).error ?? null,
        chamadas: { antes, depois },
        documentos_gravados: linhas,
      });
      expect(r.ok).toBe(false);
      expect((r as any).code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
      expect((r as any).detalhes?.itens).toEqual(["q31"]);
      expect(depois).toBe(antes);
      expect(linhas).toBe(0);

      // CONTROLE POSITIVO ja medido no elo 3: A, com as 52 respondidas, gerou
      // documento neste mesmo ambiente. Aqui so se afirma que o portao nao
      // passou a recusar todo mundo.
      const docsDeA = Number(
        sql(`select count(*) from public.prognostics where participant_id = '${P.A.id}'`),
      );
      anota("elo6_controle_positivo_A_segue_com_documento", docsDeA);
      expect(docsDeA).toBe(1);
    });
  });

  // ================================================================= ELO 7
  //
  // SUSPENDER UM DOCUMENTO JA ENTREGUE, E CORRIGI-LO POR NOVA REVISAO APROVADA
  // (migration 027).
  //
  // O IMPASSE QUE ESTE ELO FECHA, e que os testes do elo 4 mediram: um documento
  // `delivered` nao podia ser corrigido por caminho nenhum. O gatilho da 015
  // recusa `delivered -> reviewed`, e sem voltar a `reviewed` com `reviewed_at`
  // novo o selo da 025 nao se refaz, entao a reentrega tambem era recusada. O
  // teste "HISTORICO: entregue, CORRIGIDO e REENTREGUE" do elo 4 declarou isso em
  // voz alta e precisou do PROCEDIMENTO EXCEPCIONAL (`alter table ... disable
  // trigger`, que exige ser dono da tabela) para medir o que queria medir.
  //
  // O QUE MUDOU, e e a evidencia nova deste elo: existe um caminho PARA A FRENTE,
  // sem nenhum gatilho desligado e sem nenhuma regressao nova --
  //
  //     delivered -> suspended -> reviewed -> delivered
  //
  // e `suspended` fica FORA do vetor de ordem da 015, que e por isso que a trava
  // dela continua inteira (o ultimo teste deste elo mede isso).
  //
  // NADA AQUI DESLIGA NADA. Se alguem precisar de `disable trigger` para fazer
  // este elo passar, o desenho esta errado.
  describe("elo 7 - SUSPENSAO SEGURA e RETIFICACAO VERSIONADA (migration 027)", () => {
    /** Operador ficticio: a rota le o id da SESSAO, aqui ele e fixado. */
    const OPERADOR = "99999999-9999-9999-9999-999999999999";
    const OPERADOR_EMAIL = "host@127.0.0.1";
    const MOTIVO =
      "A trilha recomendada saiu trocada: o texto cita Aceleracao e a analise e de Direcao.";

    const TEXTO_ERRADO = "TEXTO COM O ERRO, QUE M LEU (marca da prova).";
    const TEXTO_CORRIGIDO = "TEXTO CORRIGIDO DE M, SEGUNDA VERSAO (marca da prova).";
    const TEXTO_NAO_APROVADO = "TEXTO QUE NINGUEM APROVOU (marca da prova).";

    let docM = "";
    let tokenDeM = "";

    /** A consulta EXATA de app/(participant)/prognostic/[token]/page.tsx. */
    async function paginaDoParticipante(token: string) {
      const { data } = await db
        .from("prognostics")
        .select("*, participants(full_name, event_id)")
        .eq("public_share_token", token)
        .in("status", ["delivered", "suspended"])
        .single();
      return data as Record<string, any> | null;
    }

    /** A consulta que a pagina fazia ANTES da 027 -- e o que produzia notFound(). */
    async function paginaAntesDa027(token: string) {
      const { data } = await db
        .from("prognostics")
        .select("final_content")
        .eq("public_share_token", token)
        .eq("status", "delivered")
        .maybeSingle();
      return data as Record<string, any> | null;
    }

    /** O UPDATE que a rota /api/prognostics/[id]/suspender escreve. */
    async function suspender(
      id: string,
      campos: Partial<{
        suspenso_por: string | null;
        suspenso_por_email: string | null;
        suspensao_motivo: string | null;
        suspenso_em: string | null;
      }> = {},
    ) {
      return db
        .from("prognostics")
        .update({
          status: "suspended",
          suspenso_por: OPERADOR,
          suspenso_por_email: OPERADOR_EMAIL,
          suspensao_motivo: MOTIVO,
          ...campos,
        } as never)
        .eq("id", id);
    }

    it("montagem: M tem documento revisado, entregue, e esta LENDO o texto errado", async () => {
      await criarParticipante("M");
      const erros = await gravarPelaTela("M", respostasCanonicas());
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("M");

      await zerarCanario();
      const g = await generatePrognostic(P.M.id, eventId);
      expect(g.ok).toBe(true);

      const { data } = await db
        .from("prognostics")
        .select("id, raw_ai_output, public_share_token")
        .eq("participant_id", P.M.id)
        .single();
      docM = (data as any).id;
      tokenDeM = (data as any).public_share_token;
      const conteudoErrado = { ...(data as any).raw_ai_output, analise_geral: TEXTO_ERRADO };

      // Revisao (o ato de aprovacao, 025) e entrega, pelas MESMAS escritas de
      // producao: app/api/prognostics/[id]/route.ts e o botao Entregar.
      const { error: eRev } = await db
        .from("prognostics")
        .update({
          edited_content: conteudoErrado,
          trail_recommendation: conteudoErrado.trilha_recomendada,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", docM);
      expect(eRev).toBeNull();
      const { error: eEnt } = await db
        .from("prognostics")
        .update({
          final_content: conteudoErrado,
          status: "delivered",
          delivered_at: new Date().toISOString(),
          pdf_url: "https://127.0.0.1/pdf-do-texto-errado.pdf",
        } as never)
        .eq("id", docM);
      expect(eEnt).toBeNull();

      const vista = await paginaDoParticipante(tokenDeM);
      anota("elo7_montagem_M_esta_lendo", {
        nome: vista?.participants?.full_name,
        texto: String(vista?.final_content?.analise_geral ?? "").slice(0, 60),
        pdf: vista?.pdf_url,
      });
      expect(String(vista?.final_content?.analise_geral)).toBe(TEXTO_ERRADO);
      // UMA linha de historico: o que ele leu, e so isso.
      expect(
        Number(
          sql(`select count(*) from public.prognostic_delivery_history
                where prognostic_id = '${docM}'`),
        ),
      ).toBe(1);
    });

    it("SUSPENSAO sem AUTOR, sem MOTIVO e com motivo CURTO: recusada pelo banco, as tres", async () => {
      // Ato de operador sem justificativa nao e ato registrado (precedente da
      // 022). Aqui nao e desencorajado: e impossivel, como o selo da 025. Os tres
      // casos sao medidos porque a rota pode ser contornada -- quem escreve em
      // `prognostics` com service_role nao passa por ela.
      const semAutor = await suspender(docM, { suspenso_por: null });
      const semMotivo = await suspender(docM, { suspensao_motivo: null });
      const motivoCurto = await suspender(docM, { suspensao_motivo: "erro" });
      const estado = sql(`select status from public.prognostics where id = '${docM}'`);
      anota("elo7_suspensao_sem_autor_ou_sem_motivo", {
        sem_autor: (semAutor.error as any)?.code ?? semAutor.error?.message ?? "ACEITO",
        sem_motivo: (semMotivo.error as any)?.code ?? semMotivo.error?.message ?? "ACEITO",
        motivo_curto: (motivoCurto.error as any)?.code ?? motivoCurto.error?.message ?? "ACEITO",
        estado_do_documento_depois: estado,
      });
      expect(semAutor.error).not.toBeNull();
      expect(semMotivo.error).not.toBeNull();
      expect(motivoCurto.error).not.toBeNull();
      // E nada aconteceu: o documento continua no ar.
      expect(estado).toBe("delivered");
    });

    it("SUSPENSAO de documento NAO entregue: recusada (e o controle positivo vem no teste seguinte)", async () => {
      // So um documento ENTREGUE pode sair do ar: e o unico que alguem esta
      // lendo. Entao o caso precisa de um documento que EXISTE e nao foi
      // entregue -- Q, gerado agora e parado em `generated`.
      //
      // (A primeira versao deste teste usou C, do elo 2, acreditando que ele
      // tinha documento em `generated`. NAO tinha: o valor fora do dominio fez o
      // motor recusar ANTES de gerar, e C nao tem linha em `prognostics`. O
      // teste nao media "suspensao recusada", media um id vazio -- e e por isso
      // que o documento desta negativa e criado aqui, onde se ve que ele existe.)
      await criarParticipante("Q");
      const errosQ = await gravarPelaTela("Q", respostasCanonicas());
      expect(errosQ.every((e) => e === null)).toBe(true);
      await concluir("Q");
      await zerarCanario();
      const gQ = await generatePrognostic(P.Q.id, eventId);
      expect(gQ.ok).toBe(true);

      const docQ = sql(
        `select id from public.prognostics where participant_id = '${P.Q.id}'`,
      );
      const estadoDeQ = sql(`select status from public.prognostics where id = '${docQ}'`);
      const { error } = await suspender(docQ);
      anota("elo7_suspensao_de_documento_nao_entregue", {
        estado_de_Q: estadoDeQ,
        codigo: (error as any)?.code ?? null,
        mensagem: error?.message ?? "ACEITO",
        estado_depois: sql(`select status from public.prognostics where id = '${docQ}'`),
      });
      expect(estadoDeQ).toBe("generated");
      expect(error).not.toBeNull();
      expect((error as any)?.code).toBe("23514");
      expect(sql(`select status from public.prognostics where id = '${docQ}'`)).toBe(estadoDeQ);
    });

    it("SUSPENSAO legitima: um ato so, com quem/quando/por que, e o PDF sai do ar junto", async () => {
      const antes = sql(
        `select left(conteudo_aprovado_hash, 16) || '|' || (final_content->>'analise_geral')
           from public.prognostics where id = '${docM}'`,
      );

      // `suspenso_em` e enviado com uma data ABSURDA de proposito: o gatilho da
      // 027 carimba `now()` do banco e descarta o que a aplicacao puser ali. O
      // relogio de quem chamou nao entra no livro-razao (mesma regra da 026).
      const { error } = await suspender(docM, { suspenso_em: "1999-01-01T00:00:00.000Z" });
      expect(error).toBeNull();

      const linha = sql(
        `select status || ' :: autor=' || suspenso_por || ' :: email=' || suspenso_por_email
                || ' :: quando_do_banco=' || (suspenso_em > now() - interval '5 minutes')::text
                || ' :: ignorou_o_relogio_do_chamador=' || (suspenso_em > '2020-01-01')::text
                || ' :: motivo=' || left(suspensao_motivo, 48)
                || ' :: pdf_saiu_do_ar=' || (pdf_url is null)::text
                || ' :: conteudo_continua_guardado=' || (final_content->>'analise_geral')
                || ' :: selo_intacto=' || (left(conteudo_aprovado_hash, 16) || '|' || (final_content->>'analise_geral') = '${antes}')::text
           from public.prognostics where id = '${docM}'`,
      );
      anota("elo7_suspensao_legitima", linha);
      expect(linha).toContain("suspended ::");
      expect(linha).toContain(`autor=${OPERADOR}`);
      expect(linha).toContain("quando_do_banco=true");
      expect(linha).toContain("ignorou_o_relogio_do_chamador=true");
      expect(linha).toContain("pdf_saiu_do_ar=true");
      // SUSPENDER TIRA DO AR, NAO REESCREVE O PASSADO: o conteudo suspenso
      // continua na linha, e o selo da aprovacao que o cobria continua intacto.
      expect(linha).toContain(`conteudo_continua_guardado=${TEXTO_ERRADO}`);
      expect(linha).toContain("selo_intacto=true");

      const livro = sql(
        `select acao || ' | ' || operador || ' | ' || operador_email || ' | ' || motivo
                || ' | impressao=' || left(conteudo_hash, 16)
                || ' | em=' || (em is not null)::text
           from public.prognostic_suspension_events
          where prognostic_id = '${docM}' order by sequencia`,
      );
      anota("elo7_livro_razao_da_suspensao", livro.split("\n"));
      expect(livro.split("\n")).toHaveLength(1);
      expect(livro).toContain("suspenso | ");
      expect(livro).toContain(MOTIVO);
      // A impressao registrada e a do texto que SAIU DO AR -- a mesma do
      // historico da 026 e a mesma que o selo da 025 cobria.
      expect(livro).toContain(
        sql(
          `select left(conteudo_hash, 16) from public.prognostic_delivery_history
            where prognostic_id = '${docM}' order by sequencia limit 1`,
        ),
      );
    });

    it("O QUE O JOVEM VE ao abrir o link depois da suspensao: um aviso escrito para ele, nao um erro", async () => {
      // A metade "nao deixar o jovem exposto ao conteudo incorreto" -- medida nos
      // TRES canais por onde o documento dele podia sair.
      //
      // Canal 1: a consulta da pagina. ANTES da 027 ela filtrava so `delivered`,
      // entao um documento fora do ar nao era achado e a pagina caia em
      // `notFound()`: ele clicava num link que FUNCIONAVA e recebia erro cru.
      const comoEraAntes = await paginaAntesDa027(tokenDeM);
      const vista = await paginaDoParticipante(tokenDeM);
      anota("elo7_consulta_antiga_da_pagina", comoEraAntes ? "MOSTROU" : "404 (erro cru, sem uma palavra)");
      anota("elo7_consulta_de_hoje_acha_o_documento_fora_do_ar", !!vista);
      expect(comoEraAntes).toBeNull();
      expect(vista).not.toBeNull();
      expect(vista?.status).toBe("suspended");

      // O RAMO da pagina: status suspenso -> DocumentoSuspensoView, SEM conteudo.
      // O texto abaixo e o do modulo de PRODUCAO, importado -- nao uma copia.
      const ehOAviso = vista?.status === "suspended";
      expect(ehOAviso).toBe(true);
      const primeiroNome = String(vista?.participants?.full_name ?? "").trim().split(" ")[0];
      anota("elo7_O_QUE_O_JOVEM_LE", `${primeiroNome}, ${TITULO_DOCUMENTO_SUSPENSO.charAt(0).toLowerCase() + TITULO_DOCUMENTO_SUSPENSO.slice(1)}\n\n${PARAGRAFOS_DOCUMENTO_SUSPENSO.join("\n\n")}\n\n${RODAPE_DOCUMENTO_SUSPENSO}`);
      // Ele sera avisado, e o link que ele tem na mao e o mesmo: as duas frases
      // que a decisao de produto exige que estejam la.
      expect(textoIntegralDoAviso().toLowerCase()).toContain("avisar você");
      expect(textoIntegralDoAviso().toLowerCase()).toContain("este mesmo link");
      // E o motivo INTERNO do operador nao esta no que ele le.
      expect(textoIntegralDoAviso()).not.toContain(MOTIVO);
      expect(textoIntegralDoAviso()).not.toContain(TEXTO_ERRADO);

      // Canal 2: a RLS, com a sessao DELE. A policy da 002 exige `delivered`,
      // entao o conteudo suspenso nao volta nem por aqui.
      const comoM = clienteDaTela(P.M.token);
      const { data: porRls } = await comoM
        .from("prognostics")
        .select("id, status")
        .eq("id", docM);
      anota("elo7_M_lendo_pela_RLS_com_a_sessao_dele", (porRls as any[])?.length ?? 0);
      expect((porRls as any[]) ?? []).toHaveLength(0);

      // Canal 3: o PDF. O gatilho zerou `pdf_url`, entao a rota de status nao
      // oferece mais o arquivo do texto suspenso.
      const status = sql(
        `select coalesce(pdf_url, '(nulo)') || ' | ' || status
           from public.prognostics where public_share_token = '${tokenDeM}'`,
      );
      anota("elo7_rota_de_status_depois_da_suspensao", status);
      expect(status).toBe("(nulo) | suspended");
    });

    it("O HISTORICO NAO SUMIU: continua dizendo o que ele leu e quando", async () => {
      // A outra metade do principio -- "a correcao nao pode apagar o erro da
      // historia". A suspensao nao escreve no historico da 026 e nao apaga nada:
      // a linha do texto que M leu continua la, com a impressao digital e a data.
      const historico = sql(
        `select sequencia || ' :: ' || (conteudo->>'analise_geral')
                || ' :: impressao=' || left(conteudo_hash, 16)
                || ' :: leu_a_partir_de=' || (leu_a_partir_de is not null)::text
                || ' :: aprovado_em=' || (aprovado_em is not null)::text
           from public.v_historico_do_conteudo_entregue
          where prognostic_id = '${docM}' order by sequencia`,
      );
      anota("elo7_historico_depois_da_suspensao", historico.split("\n"));
      expect(historico.split("\n")).toHaveLength(1);
      expect(historico).toContain(TEXTO_ERRADO);
      expect(historico).toContain("leu_a_partir_de=true");
      expect(historico).toContain("aprovado_em=true");

      // E o conteudo suspenso TAMBEM continua na propria linha do documento:
      // tirar do ar nao e apagar.
      expect(
        sql(`select final_content->>'analise_geral' from public.prognostics where id = '${docM}'`),
      ).toBe(TEXTO_ERRADO);
    });

    it("de SUSPENSO nao se volta: reentregar sem nova revisao, e voltar para tras, sao recusados", async () => {
      // Reentregar como esta devolveria ao ar o MESMO texto errado -- o conteudo
      // nao mudou, entao o selo da 025 BATERIA e so a cerca da 027 recusa.
      const reentregaSeca = await db
        .from("prognostics")
        .update({ status: "delivered", delivered_at: new Date().toISOString() } as never)
        .eq("id", docM);
      const paraTras = await db
        .from("prognostics")
        .update({ status: "generated" } as never)
        .eq("id", docM);
      anota("elo7_de_suspenso_nao_se_volta", {
        reentregar_sem_nova_revisao: (reentregaSeca.error as any)?.code ?? reentregaSeca.error?.message ?? "ACEITO",
        voltar_para_generated: (paraTras.error as any)?.code ?? paraTras.error?.message ?? "ACEITO",
        estado_depois: sql(`select status from public.prognostics where id = '${docM}'`),
      });
      expect(reentregaSeca.error).not.toBeNull();
      expect((reentregaSeca.error as any)?.code).toBe("23514");
      expect(paraTras.error).not.toBeNull();
      expect(sql(`select status from public.prognostics where id = '${docM}'`)).toBe("suspended");
    });

    it("RETIFICACAO: nova revisao, nova aprovacao, nova entrega -- e o selo continua sendo o portao", async () => {
      // A revisao de um documento FORA DO AR e a MESMA escrita de producao
      // (app/api/prognostics/[id]/route.ts), agora que `suspended` entrou em
      // ESTADOS_REVISAVEIS. Nao e regressao disfarcada: de `suspended` o banco so
      // aceita `in_review` ou `reviewed`, e so por aqui o documento volta ao ar.
      const { data: antes } = await db
        .from("prognostics")
        .select("raw_ai_output, conteudo_aprovado_hash")
        .eq("id", docM)
        .single();
      const seloDoTextoErrado = (antes as any).conteudo_aprovado_hash as string;
      const corrigido = { ...(antes as any).raw_ai_output, analise_geral: TEXTO_CORRIGIDO };

      const { error: eRev } = await db
        .from("prognostics")
        .update({
          edited_content: corrigido,
          yuri_note: null,
          trail_recommendation: corrigido.trilha_recomendada,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", docM);
      anota("elo7_retificacao_salvar_a_revisao", eRev?.message ?? "SALVA");
      expect(eRev).toBeNull();

      const depoisDaRevisao = sql(
        `select status
                || ' :: marca_de_suspensao_saiu_da_linha=' || (suspenso_em is null and suspenso_por is null and suspensao_motivo is null)::text
                || ' :: selo_novo=' || left(conteudo_aprovado_hash, 16)
                || ' :: selo_e_do_texto_corrigido=' || (conteudo_aprovado_hash = encode(sha256(convert_to(edited_content::text, 'UTF8')), 'hex'))::text
                || ' :: selo_mudou=' || (conteudo_aprovado_hash <> '${seloDoTextoErrado}')::text
           from public.prognostics where id = '${docM}'`,
      );
      anota("elo7_retificacao_estado_apos_a_nova_aprovacao", depoisDaRevisao);
      expect(depoisDaRevisao).toContain("reviewed ::");
      expect(depoisDaRevisao).toContain("marca_de_suspensao_saiu_da_linha=true");
      expect(depoisDaRevisao).toContain("selo_e_do_texto_corrigido=true");
      expect(depoisDaRevisao).toContain("selo_mudou=true");

      // O SELO CONTINUA SENDO O PORTAO, DEPOIS DA MUDANCA DESTA UNIDADE:
      // entregar texto que ninguem aprovou segue impossivel.
      const naoAprovado = await db
        .from("prognostics")
        .update({
          final_content: { ...corrigido, analise_geral: TEXTO_NAO_APROVADO },
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docM);
      anota("elo7_entregar_texto_nao_aprovado_depois_da_027", {
        codigo: (naoAprovado.error as any)?.code ?? null,
        mensagem: naoAprovado.error?.message ?? "ACEITO",
        estado_depois: sql(`select status from public.prognostics where id = '${docM}'`),
      });
      expect(naoAprovado.error).not.toBeNull();
      expect((naoAprovado.error as any)?.code).toBe("23514");
      expect(sql(`select status from public.prognostics where id = '${docM}'`)).toBe("reviewed");

      // A REENTREGA do texto APROVADO, pelo caminho normal.
      const { error: eEnt } = await db
        .from("prognostics")
        .update({
          final_content: corrigido,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docM);
      anota("elo7_reentrega_do_texto_aprovado", eEnt?.message ?? "REENTREGUE");
      expect(eEnt).toBeNull();
    });

    it("depois da retificacao: o historico tem as DUAS versoes, e o jovem passa a ler a correta", async () => {
      const historico = sql(
        `select sequencia || ' :: ' || (conteudo->>'analise_geral')
                || ' :: impressao=' || left(conteudo_hash, 16)
                || ' :: leu_ate=' || coalesce(leu_ate::text, '(vigente)')
                || ' :: vigente=' || vigente::text
           from public.v_historico_do_conteudo_entregue
          where prognostic_id = '${docM}' order by sequencia`,
      );
      anota("elo7_historico_com_as_DUAS_versoes", historico.split("\n"));
      const linhas = historico.split("\n");
      expect(linhas).toHaveLength(2);
      // A que ele LEU continua la, com a data em que deixou de valer...
      expect(linhas[0]).toContain(TEXTO_ERRADO);
      expect(linhas[0]).toContain("vigente=false");
      expect(linhas[0]).not.toContain("leu_ate=(vigente)");
      // ...e a que ele PASSA A LER e a vigente.
      expect(linhas[1]).toContain(TEXTO_CORRIGIDO);
      expect(linhas[1]).toContain("leu_ate=(vigente)");
      expect(linhas[1]).toContain("vigente=true");
      // Duas impressoes diferentes, e a vigente e a que o selo da 025 cobre.
      expect(
        sql(
          `select (p.conteudo_aprovado_hash = h.conteudo_hash)::text
             from public.prognostics p
             join public.prognostic_delivery_history h on h.prognostic_id = p.id
            where p.id = '${docM}' order by h.sequencia desc limit 1`,
        ),
      ).toBe("true");

      // O LIVRO-RAZAO fechado: suspenso -> reentregue, com as duas impressoes.
      const livro = sql(
        `select sequencia || ' :: ' || acao
                || ' :: motivo=' || coalesce(left(motivo, 40), '(nenhum)')
                || ' :: impressao=' || left(conteudo_hash, 16)
           from public.prognostic_suspension_events
          where prognostic_id = '${docM}' order by sequencia`,
      );
      anota("elo7_livro_razao_fechado", livro.split("\n"));
      expect(livro.split("\n")).toHaveLength(2);
      expect(livro.split("\n")[0]).toContain("suspenso");
      expect(livro.split("\n")[1]).toContain("reentregue");

      // E O QUE O JOVEM VE AGORA, pelo MESMO link que ele tinha na mao: o texto
      // corrigido. Nenhum link novo foi emitido -- o `public_share_token` nao e
      // tocado pela suspensao, que e a decisao de produto declarada na 027.
      const vista = await paginaDoParticipante(tokenDeM);
      anota("elo7_o_que_o_jovem_le_depois_da_retificacao", {
        mesmo_link: tokenDeM === (vista as any)?.public_share_token,
        status: vista?.status,
        texto: String(vista?.final_content?.analise_geral ?? "").slice(0, 70),
      });
      expect(vista?.status).toBe("delivered");
      expect((vista as any)?.public_share_token).toBe(tokenDeM);
      expect(String(vista?.final_content?.analise_geral)).toBe(TEXTO_CORRIGIDO);
      expect(String(vista?.final_content?.analise_geral)).not.toBe(TEXTO_ERRADO);
    });

    it("CONTROLE POSITIVO: documento NUNCA suspenso continua sendo entregue como sempre", async () => {
      // Sem isto, tudo acima poderia estar medindo "a entrega quebrou para todo
      // mundo depois da 027" em vez de "a suspensao funciona".
      await criarParticipante("N");
      const erros = await gravarPelaTela("N", respostasCanonicas());
      expect(erros.every((e) => e === null)).toBe(true);
      await concluir("N");

      await zerarCanario();
      const g = await generatePrognostic(P.N.id, eventId);
      expect(g.ok).toBe(true);

      const { data } = await db
        .from("prognostics")
        .select("id, raw_ai_output, public_share_token")
        .eq("participant_id", P.N.id)
        .single();
      const docN = (data as any).id as string;
      const tokenDeN = (data as any).public_share_token as string;
      const conteudo = {
        ...(data as any).raw_ai_output,
        analise_geral: "TEXTO DE N, NUNCA SUSPENSO (marca da prova).",
      };

      const { error: eRev } = await db
        .from("prognostics")
        .update({
          edited_content: conteudo,
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
          pdf_url: null,
        } as never)
        .eq("id", docN);
      const { error: eEnt } = await db
        .from("prognostics")
        .update({
          final_content: conteudo,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        } as never)
        .eq("id", docN);

      const vista = await paginaDoParticipante(tokenDeN);
      const linha = sql(
        `select status
                || ' :: nunca_suspenso=' || (suspenso_em is null and suspenso_por is null)::text
                || ' :: linhas_no_livro_razao=' || (
                     select count(*) from public.prognostic_suspension_events
                      where prognostic_id = '${docN}')
                || ' :: linhas_no_historico=' || (
                     select count(*) from public.prognostic_delivery_history
                      where prognostic_id = '${docN}')
           from public.prognostics where id = '${docN}'`,
      );
      anota("elo7_controle_positivo_documento_normal", {
        revisao: eRev?.message ?? "SALVA",
        entrega: eEnt?.message ?? "ENTREGUE",
        linha,
        o_que_N_le: String(vista?.final_content?.analise_geral ?? "").slice(0, 60),
      });
      expect(eRev).toBeNull();
      expect(eEnt).toBeNull();
      expect(linha).toContain("delivered ::");
      expect(linha).toContain("nunca_suspenso=true");
      // O livro-razao da suspensao NAO ganha linha por uma entrega comum: ele
      // registra atos de suspensao, nao entregas.
      expect(linha).toContain("linhas_no_livro_razao=0");
      expect(linha).toContain("linhas_no_historico=1");
      expect(String(vista?.final_content?.analise_geral)).toContain("NUNCA SUSPENSO");
    });

    it("A TRAVA DA 015 NAO FOI AFROUXADA: delivered -> reviewed DIRETO continua recusado", async () => {
      // A pergunta que decide se esta unidade abriu a porta que a revisao mandou
      // manter fechada. `suspended` esta FORA do vetor de ordem da 015, entao a
      // 027 nao precisou de nenhuma transicao nova entre os seis estados dela --
      // e a regressao que a 015 existe para recusar continua recusada, sobre um
      // documento que NUNCA passou por suspensao.
      const docN = sql(
        `select id from public.prognostics where participant_id = '${P.N.id}'`,
      );
      const { error } = await db
        .from("prognostics")
        .update({
          edited_content: { analise_geral: "correcao direta, sem tirar do ar" },
          status: "reviewed",
          reviewed_at: new Date().toISOString(),
        } as never)
        .eq("id", docN);
      const gatilhos = sql(
        `select string_agg(tgname, ',' order by tgname)
           from pg_trigger
          where tgrelid = 'public.prognostics'::regclass and not tgisinternal`,
      );
      const vocabulario = sql(
        `select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'public.prognostics'::regclass and conname = 'prognostics_status_check'`,
      );
      anota("elo7_a_trava_da_015_continua", {
        delivered_para_reviewed_direto: (error as any)?.code ?? error?.message ?? "ACEITO",
        estado_de_N_depois: sql(`select status from public.prognostics where id = '${docN}'`),
        gatilhos_de_prognostics: gatilhos.split(","),
        vocabulario_de_status: vocabulario,
      });
      expect(error).not.toBeNull();
      expect((error as any)?.code).toBe("23514");
      expect(sql(`select status from public.prognostics where id = '${docN}'`)).toBe("delivered");
      // Os quatro gatilhos convivem: nenhum foi substituido por este trabalho.
      for (const g of [
        "prognostics_status_sem_regressao", // 015
        "prognostics_selo_de_aprovacao", // 025
        "prognostics_historico_do_entregue", // 026
        "prognostics_suspensao", // 027
        "prognostics_livro_da_suspensao", // 027
      ]) {
        expect(gatilhos.split(",")).toContain(g);
      }
      // E o setimo valor entrou no vocabulario sem tirar nenhum dos seis.
      for (const estado of [
        "pending",
        "generating",
        "generated",
        "in_review",
        "reviewed",
        "delivered",
        "suspended",
      ]) {
        expect(vocabulario).toContain(`'${estado}'`);
      }
    });

    it("O LIVRO-RAZAO E APPEND-ONLY: privilegio CONFERIDO no banco, e a tentativa real recusada", async () => {
      // Mesma tecnica e mesma razao do teste equivalente da 026, com
      // `service_role` NOMEADO: ele nao e alcancado pela RLS (BYPASSRLS) e e o
      // papel com que as rotas de administracao escrevem.
      const privilegios = sql(
        `select r.papel || ': ler=' ||
                has_table_privilege(r.papel, 'public.prognostic_suspension_events', 'select')::text ||
                ' inserir=' ||
                has_table_privilege(r.papel, 'public.prognostic_suspension_events', 'insert')::text ||
                ' alterar=' ||
                has_table_privilege(r.papel, 'public.prognostic_suspension_events', 'update')::text ||
                ' apagar=' ||
                has_table_privilege(r.papel, 'public.prognostic_suspension_events', 'delete')::text ||
                ' truncar=' ||
                has_table_privilege(r.papel, 'public.prognostic_suspension_events', 'truncate')::text
           from (values ('anon'), ('authenticated'), ('service_role')) as r(papel)
          order by r.papel`,
      );
      const rls = sql(
        `select relrowsecurity::text from pg_class
          where oid = 'public.prognostic_suspension_events'::regclass`,
      );
      const policies = sql(
        `select coalesce(string_agg(polname || '[' || polcmd::text || ']', ',' order by polname), '(nenhuma)')
           from pg_policy where polrelid = 'public.prognostic_suspension_events'::regclass`,
      );
      anota("elo7_livro_razao_privilegios_conferidos", privilegios.split("\n"));
      anota("elo7_livro_razao_rls_e_policies", { rls_ligada: rls, policies });

      expect(privilegios).not.toMatch(/alterar=true/);
      expect(privilegios).not.toMatch(/apagar=true/);
      expect(privilegios).not.toMatch(/truncar=true/);
      expect(privilegios).not.toMatch(/inserir=true/);
      expect(privilegios).toContain("authenticated: ler=true");
      expect(privilegios).toContain("service_role: ler=true");
      expect(privilegios).toContain("anon: ler=false");
      expect(rls).toBe("true");
      expect(policies).toBe("prognostic_suspension_events_admin_select[r]");

      // A TENTATIVA REAL, pelo caminho da aplicacao (PostgREST com a chave de
      // service_role): nao basta o privilegio estar revogado na consulta acima.
      const linhasAntes = sql(`select count(*) from public.prognostic_suspension_events`);
      const cabecalho = {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        "content-type": "application/json",
      };
      const alterar = await fetch(
        `${SUPA}/rest/v1/prognostic_suspension_events?prognostic_id=eq.${docM}`,
        { method: "PATCH", headers: cabecalho, body: JSON.stringify({ motivo: "REESCRITO PELA PROVA, com folga de caracteres" }) },
      );
      const apagar = await fetch(
        `${SUPA}/rest/v1/prognostic_suspension_events?prognostic_id=eq.${docM}`,
        { method: "DELETE", headers: cabecalho },
      );
      const inserir = await fetch(`${SUPA}/rest/v1/prognostic_suspension_events`, {
        method: "POST",
        headers: cabecalho,
        body: JSON.stringify({
          prognostic_id: docM,
          participant_id: P.M.id,
          acao: "suspenso",
          operador: OPERADOR,
          motivo: "SUSPENSAO QUE NUNCA ACONTECEU, com folga de caracteres",
          conteudo_hash: "0000000000000000000000000000000000000000000000000000000000000000",
          em: new Date().toISOString(),
        }),
      });
      const linhasDepois = sql(`select count(*) from public.prognostic_suspension_events`);
      const motivosDepois = sql(
        `select string_agg(coalesce(motivo, '(nenhum)'), ' | ' order by sequencia)
           from public.prognostic_suspension_events where prognostic_id = '${docM}'`,
      );
      anota("elo7_livro_razao_tentativa_real_como_service_role", {
        alterar: alterar.status,
        apagar: apagar.status,
        inserir: inserir.status,
        linhas: { antes: linhasAntes, depois: linhasDepois },
        motivos_depois: motivosDepois,
      });
      expect(alterar.ok).toBe(false);
      expect(apagar.ok).toBe(false);
      expect(inserir.ok).toBe(false);
      expect(linhasDepois).toBe(linhasAntes);
      expect(motivosDepois).toContain(MOTIVO);
      expect(motivosDepois).not.toContain("REESCRITO");

      // O TETO, DECLARADO e nao disfarcado: ser DONO da tabela (DDL, ou UPDATE
      // direto como `postgres`) continua contornando isto -- e o mesmo teto dos
      // gatilhos da 015, da 025 e da 026, e a condicao que este projeto aceita
      // como "procedimento excepcional". O que o CHECK do motivo garante mesmo
      // para o dono e que um ato de suspensao nao fica SEM motivo e SEM autor.
      let recusouODono = "ACEITO (nao deveria)";
      try {
        sql(
          `update public.prognostic_suspension_events
              set motivo = null, operador = null
            where prognostic_id = '${docM}' and acao = 'suspenso'`,
        );
      } catch (err) {
        recusouODono = String((err as Error).message).includes(
          "prognostic_suspension_events_motivo_check",
        )
          ? "RECUSADO pelo CHECK do motivo"
          : `RECUSADO: ${String((err as Error).message).slice(0, 120)}`;
      }
      anota("elo7_livro_razao_dono_nao_deixa_ato_sem_autor_nem_motivo", recusouODono);
      expect(recusouODono).toBe("RECUSADO pelo CHECK do motivo");
    });
  });

});
