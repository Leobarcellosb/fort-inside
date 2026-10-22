import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildSystemPrompt,
  buildSystemPromptMarcoZero,
  buildUserPrompt,
  buildUserPromptMarcoZero,
} from "@/lib/ai/prognostic-prompt";
import { TOTAL_STAGES } from "@/lib/constants";
import {
  carregarContextoQuiz,
  type ClienteDeLeitura as ClienteDeLeituraQuiz,
} from "@/lib/ai/contexto-quiz";
import { correcoesSchema, prognosticContentSchema } from "@/lib/ai/prognostic-schema";
import {
  QUIZ_VERSION_FORT_INSIDE,
  QUIZ_VERSION_MARCO_ZERO,
  prepararBriefing,
} from "@/lib/ai/briefing-prognostico";
import {
  gerarComVeto,
  gerarSemVeto,
  type Chamadas,
  type SaidaDoModelo,
} from "@/lib/ai/gerar-com-veto";
import type {
  PrognosticContent,
  Participant,
  Prognostic,
  TrailRecommendation,
} from "@/types/database";
import type { DetalhesDeErro, TodoCodigoDeErro } from "@/lib/erros/codigos";

// Core prognostic generation, callable in-process. Both the HTTP route and
// batch-process go through this instead of self-fetching /api/generate-prognostic,
// which used to (a) need the endpoint to stay unauthenticated, (b) burn an extra
// function invocation per participant, and (c) trip the per-participant rate
// limit when the batch raced the auto-fire from stage 6.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export { TOTAL_STAGES };

// O schema da saida da IA mora em lib/ai/prognostic-schema.ts (testavel sem o SDK).

// Estados em que regerar o conteudo da IA ainda e seguro. A partir de in_review
// existe trabalho humano em cima do documento (edicao, revisao, entrega) e o
// banco recusa qualquer volta de status (migration 015). Regerar nesses estados
// so queimaria uma chamada de modelo para o resultado ser descartado, ou pior,
// apagaria o pdf_url de um documento ja entregue. Por isso a recusa acontece
// ANTES do modelo, nao na hora de gravar.
const ESTADOS_REGERAVEIS = ["pending", "generating", "generated"] as const;

export type GenerateResult =
  | { ok: true; prognosticId: string; trail: TrailRecommendation }
  | {
      ok: false;
      status: number;
      error: string;
      /**
       * A CAUSA no vocabulário de lib/erros/codigos.ts, quando ela e conhecida.
       * Recusar por DADO INSUFICIENTE nao e erro de servidor: e desfecho
       * previsto, e o codigo e o que deixa a tela dizer o que falta. As recusas
       * mais antigas (veto da saida, estado avancado) seguem sem codigo: o
       * status delas ja esta provado e nao foi tocado por esta unidade.
       */
      code?: TodoCodigoDeErro;
      detalhes?: DetalhesDeErro;
      detail?: unknown;
    };

interface ParametrosDeChamada {
  system: Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.Messages.MessageParam[];
  format: Anthropic.Messages.JSONOutputFormat;
  maxTokens: number;
  effort: "low" | "medium";
  participantId: string;
}

// Uma chamada ao modelo, em streaming. Toda a politica (o que fazer com a
// resposta) fica em gerar-com-veto.ts; aqui so se fala com o SDK.
async function chamarModelo(p: ParametrosDeChamada): Promise<SaidaDoModelo> {
  // Streaming is required at this max_tokens: a non-streaming request that
  // large risks an HTTP timeout before the model finishes.
  const stream = anthropic.messages.stream({
    model: "claude-opus-5",
    // Thinking and visible output share this budget. The old 4096 was already
    // tight for a ~1.3k-word deliverable and would truncate with thinking on.
    max_tokens: p.maxTokens,
    // Adaptive thinking replaces the fixed budget; `temperature` is rejected
    // outright by Opus 5 and had to go.
    thinking: { type: "adaptive" },
    // effort medium, nao high: medido no mesmo participante real, o high
    // levava 147s e 10.749 tokens de saida para produzir 1.303 palavras; o
    // medium leva 63s e 3.931 tokens para produzir 1.280. Os ~8.700 tokens de
    // raciocinio extras do high nao apareciam no texto entregue.
    output_config: { effort: p.effort, format: p.format },
    system: p.system,
    messages: p.messages,
  });

  const message = await stream.finalMessage();

  // Uso por chamada no log: e a unica medida de custo que o fluxo deixa.
  console.info("[generate-prognostic] chamada ao modelo", {
    participantId: p.participantId,
    effort: p.effort,
    usage: message.usage,
    stopReason: message.stop_reason,
  });

  // Safety classifiers can decline a request: HTTP 200, empty or partial
  // content, stop_reason "refusal". Reading content[0] blind would throw.
  if (message.stop_reason === "refusal") {
    console.error("[generate-prognostic] refusal", {
      participantId: p.participantId,
      stopDetails: message.stop_details,
    });
    return { texto: "", recusou: true, detalheRecusa: message.stop_details };
  }
  return {
    texto: message.content.find((b) => b.type === "text")?.text ?? "",
    recusou: false,
  };
}

export async function generatePrognostic(
  participantId: string,
  eventId: string
): Promise<GenerateResult> {
  const supabase = createAdminClient();

  const { data: participant, error: pErr } = (await supabase
    .from("participants")
    .select("full_name, event_id")
    .eq("id", participantId)
    .single()) as {
    data: Pick<Participant, "full_name" | "event_id"> | null;
    error: { message: string } | null;
  };

  if (pErr || !participant) {
    return { ok: false, status: 404, error: "Participante não encontrado" };
  }

  // A versao do quiz vem do evento DO PARTICIPANTE, nao do `eventId` recebido:
  // se os dois divergissem, o contexto de um quiz seria gravado no evento de
  // outro. Divergencia e entrada errada, nao caso de uso.
  if (participant.event_id !== eventId) {
    console.error("[generate-prognostic] participante nao pertence ao evento informado", {
      participantId,
      eventId,
    });
    return { ok: false, status: 404, error: "Participante não encontrado" };
  }

  // Trava de estado, antes de qualquer chamada ao modelo. A gravacao la embaixo
  // repete a condicao no proprio UPDATE (o modelo leva ~1 min e o estado pode
  // avancar nesse intervalo); esta checagem aqui existe para nao gastar o Opus.
  const { data: atual } = (await supabase
    .from("prognostics")
    .select("status")
    .eq("participant_id", participantId)
    .maybeSingle()) as {
    data: Pick<Prognostic, "status"> | null;
    error: unknown;
  };

  if (atual && !(ESTADOS_REGERAVEIS as readonly string[]).includes(atual.status)) {
    return {
      ok: false,
      status: 409,
      error: `Prognóstico já está em "${atual.status}"; não pode ser regerado.`,
    };
  }

  // Etapas e respostas da VERSAO DO QUIZ DO EVENTO, e so dela. Ver
  // lib/ai/contexto-quiz.ts: ler quiz_stages sem filtrar versao jogaria no
  // prompt as etapas de outro questionario.
  const contexto = await carregarContextoQuiz(
    supabase as unknown as ClienteDeLeituraQuiz,
    participantId,
    eventId
  );
  if (!contexto.ok) {
    return { ok: false, status: contexto.status, error: contexto.error };
  }
  const { stages, responses } = contexto;

  const { data: kbEntries, error: kbErr } = (await supabase
    .from("knowledge_base")
    .select("title, content")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })) as {
    data: { title: string; content: string }[] | null;
    error: { message: string } | null;
  };

  // A failed knowledge-base read silently produced generic prognostics with no
  // methodology context. Surface it in the logs instead of swallowing it.
  if (kbErr) {
    console.error("[generate-prognostic] knowledge_base read failed", kbErr);
  }

  // Quiz da versao do evento decide o caminho. O Marco Zero (v2) e MEDIDO:
  // as respostas passam pelo motor e pela camada de briefing, e a saida do
  // modelo e verificada contra o veto antes de virar documento. O Fort Inside
  // (v1) nao tem pontuacao nem veto e segue como era. Versao desconhecida
  // recusa: mandar respostas cruas de um quiz que ninguem descreveu ao modelo,
  // sem veto, seria o defeito que esta unidade existe para fechar.
  const { quizVersion } = contexto;
  if (quizVersion !== QUIZ_VERSION_FORT_INSIDE && quizVersion !== QUIZ_VERSION_MARCO_ZERO) {
    console.error("[generate-prognostic] versao de quiz sem prompt definido", {
      participantId,
      quizVersion,
    });
    return {
      ok: false,
      status: 500,
      error: `Versão ${quizVersion} do questionário não tem geração de prognóstico definida`,
    };
  }
  const marcoZero = quizVersion === QUIZ_VERSION_MARCO_ZERO;

  // O briefing sai ANTES de qualquer chamada ao modelo: resposta ilegivel ou
  // briefing recusado nao custa Opus.
  let systemPrompt: string;
  let userPrompt: string;
  if (marcoZero) {
    const preparado = prepararBriefing(responses);
    if (!preparado.ok) {
      // O portao de completude mora dentro de prepararBriefing: a recusa por
      // perguntas faltando acontece AQUI, antes de chamar o modelo e antes de
      // existir linha em `prognostics`. O codigo atravessa junto.
      return {
        ok: false,
        status: preparado.status,
        error: preparado.error,
        code: preparado.code,
        detalhes: preparado.detalhes,
      };
    }
    systemPrompt = buildSystemPromptMarcoZero(kbEntries ?? []);
    userPrompt = buildUserPromptMarcoZero(participant.full_name, {
      responses,
      stages,
      blocoBriefing: preparado.bloco,
    });
  } else {
    systemPrompt = buildSystemPrompt(kbEntries ?? []);
    userPrompt = buildUserPrompt(participant.full_name, { responses, stages });
  }

  // Structured outputs: the model is constrained to this JSON shape, which
  // removes the "extract the JSON with a regex and hope" failure mode.
  // Serialized to a plain object on purpose — zodOutputFormat attaches a
  // client-side parser that THROWS mid-stream on a schema mismatch, and we
  // want the graceful error path below instead.
  const outputFormat = JSON.parse(
    JSON.stringify(zodOutputFormat(prognosticContentSchema))
  ) as Anthropic.Messages.JSONOutputFormat;
  const formatoDeCorrecao = JSON.parse(
    JSON.stringify(zodOutputFormat(correcoesSchema))
  ) as Anthropic.Messages.JSONOutputFormat;

  // cache_control on the system prompt: it is large (methodology + knowledge
  // base) and identical for every participant, so a batch of 20 pays the
  // write once and reads it 19 times at a tenth of the price.
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  let content: PrognosticContent;
  let chamadas: Chamadas;

  if (marcoZero) {
    const r = await gerarComVeto({
      gerar: () =>
        chamarModelo({
          system,
          messages: [{ role: "user", content: userPrompt }],
          format: outputFormat,
          maxTokens: 32000,
          effort: "medium",
          participantId,
        }),
      // Correcao pontual: o modelo ve o proprio rascunho e so reescreve os
      // campos recusados. Saida curta (limite de 8000 tokens) e esforco baixo.
      corrigir: (rascunho, pedido) =>
        chamarModelo({
          system,
          messages: [
            { role: "user", content: userPrompt },
            { role: "assistant", content: rascunho },
            { role: "user", content: pedido },
          ],
          format: formatoDeCorrecao,
          maxTokens: 8000,
          effort: "low",
          participantId,
        }),
    });
    chamadas = r.chamadas;

    if (!r.ok) {
      if (r.violacoes) {
        // Nada e gravado em `prognostics`. O registro fica no log do evento,
        // so com campo e motivo (nunca o texto do participante).
        await (
          supabase.from("event_logs") as unknown as {
            insert(v: Record<string, unknown>): Promise<unknown>;
          }
        ).insert({
          event_id: eventId,
          participant_id: participantId,
          action: "prognostic_vetoed",
          payload: { chamadas: r.chamadas, violacoes: r.violacoes },
        });
      }
      return { ok: false, status: r.status, error: r.error, detail: r.detail };
    }
    content = r.content;
  } else {
    const r = await gerarSemVeto(() =>
      chamarModelo({
        system,
        messages: [{ role: "user", content: userPrompt }],
        format: outputFormat,
        maxTokens: 32000,
        effort: "medium",
        participantId,
      }),
    );
    chamadas = r.chamadas;
    if (!r.ok) {
      return { ok: false, status: r.status, error: r.error, detail: r.detail };
    }
    content = r.content;
  }

  const { data: existing } = (await supabase
    .from("prognostics")
    .select("id")
    .eq("participant_id", participantId)
    .single()) as { data: Pick<Prognostic, "id"> | null; error: unknown };

  type MutResult = { data: unknown; error: { message: string } | null };
  type SelectSingle<T> = { data: T | null; error: { message: string } | null };

  let prognosticId: string;

  if (existing) {
    prognosticId = existing.id;
    // O WHERE repete a trava de estado: se o documento avancou (in_review,
    // reviewed, delivered) enquanto o modelo rodava, nenhuma linha casa e nada
    // e sobrescrito. O status so e reafirmado como "generated" dentro do
    // conjunto de estados anteriores a revisao, onde isso nao e regressao.
    const { data: atualizadas, error: uErr } = await (
      supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): {
          eq(c: string, v: string): {
            in(c: string, v: readonly string[]): {
              select(cols: string): Promise<SelectSingle<{ id: string }[]>>;
            };
          };
        };
      }
    )
      .update({
        raw_ai_output: content,
        status: "generated",
        trail_recommendation: content.trilha_recomendada,
        generated_at: new Date().toISOString(),
        pdf_url: null,
      })
      .eq("participant_id", participantId)
      .in("status", ESTADOS_REGERAVEIS)
      .select("id");

    if (uErr) {
      console.error("[generate-prognostic] update failure", { err: uErr, participantId });
      return {
        ok: false,
        status: 500,
        error: "Erro ao salvar prognóstico",
        detail: uErr.message,
      };
    }

    if (!atualizadas || atualizadas.length === 0) {
      console.error("[generate-prognostic] estado avancou durante a geracao; saida descartada", {
        participantId,
      });
      return {
        ok: false,
        status: 409,
        error: "Prognóstico avançou de estado durante a geração; saída descartada.",
      };
    }
  } else {
    const { data: inserted, error: iErr } = await (
      supabase.from("prognostics") as unknown as {
        insert(v: Record<string, unknown>): {
          select(cols: string): { single(): Promise<SelectSingle<Pick<Prognostic, "id">>> };
        };
      }
    )
      .insert({
        participant_id: participantId,
        raw_ai_output: content,
        status: "generated",
        trail_recommendation: content.trilha_recomendada,
        generated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (iErr || !inserted) {
      console.error("[generate-prognostic] insert failure", { err: iErr, participantId });
      return {
        ok: false,
        status: 500,
        error: "Erro ao salvar prognóstico",
        detail: iErr?.message ?? "no insert result",
      };
    }
    prognosticId = inserted.id;
  }

  await (
    supabase.from("event_logs") as unknown as {
      insert(v: Record<string, unknown>): Promise<unknown>;
    }
  ).insert({
    event_id: eventId,
    participant_id: participantId,
    action: "prognostic_generated",
    payload: {
      trail: content.trilha_recomendada,
      chamadas_modelo: chamadas,
      quiz_version: quizVersion,
    },
  });

  return { ok: true, prognosticId, trail: content.trilha_recomendada };
}
