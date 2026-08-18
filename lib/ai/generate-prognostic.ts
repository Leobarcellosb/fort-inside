import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prognostic-prompt";
import { TOTAL_STAGES } from "@/lib/constants";
import type {
  PrognosticContent,
  QuizResponse,
  QuizStage,
  Participant,
  Prognostic,
  TrailRecommendation,
} from "@/types/database";

// Core prognostic generation, callable in-process. Both the HTTP route and
// batch-process go through this instead of self-fetching /api/generate-prognostic,
// which used to (a) need the endpoint to stay unauthenticated, (b) burn an extra
// function invocation per participant, and (c) trip the per-participant rate
// limit when the batch raced the auto-fire from stage 6.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export { TOTAL_STAGES };

// Runtime schema validating IA output. Mirrors PrognosticContent shape.
//
// Array sizes are ranges, not exact counts: structured outputs pass minItems /
// maxItems through to the model as a hint but do NOT enforce them server-side
// ("complex array constraints" are unsupported). Opus 5 consistently writes 4
// steps in plano_30_dias, so the previous .length(3) would have rejected every
// generation. Ranges let the depth of the answer follow the participant.
const prognosticContentSchema = z.object({
  analise_geral: z.string().min(1),
  areas_chave: z
    .array(
      z.object({
        nome: z.string().min(1),
        diagnostico: z.string().min(1),
        risco: z.string().min(1),
        movimento: z.string().min(1),
      })
    )
    .min(3)
    .max(5),
  plano_30_dias: z
    .array(
      z.object({
        titulo: z.string().min(1),
        objetivos: z.array(z.string().min(1)).min(1).max(5),
        acao: z.string().min(1),
        resultado_esperado: z.string().min(1),
      })
    )
    .min(3)
    .max(5),
  praticas: z
    .array(z.object({ nome: z.string().min(1), descricao: z.string().min(1) }))
    .min(3)
    .max(5),
  frase_ativacao: z.object({
    frase: z.string().min(1),
    contexto: z.string().min(1),
    aplicacao: z.string().min(1),
    pergunta_pratica: z.string().min(1),
  }),
  trilha_recomendada: z.enum([
    "Exploração",
    "Direção",
    "Aproximação",
    "Aceleração",
    "Sessão Privada",
  ]),
  justificativa_trilha: z.string().min(1),
});

export type GenerateResult =
  | { ok: true; prognosticId: string; trail: TrailRecommendation }
  | { ok: false; status: number; error: string; detail?: unknown };

export async function generatePrognostic(
  participantId: string,
  eventId: string
): Promise<GenerateResult> {
  const supabase = createAdminClient();

  const { data: participant, error: pErr } = (await supabase
    .from("participants")
    .select("full_name")
    .eq("id", participantId)
    .single()) as {
    data: Pick<Participant, "full_name"> | null;
    error: { message: string } | null;
  };

  if (pErr || !participant) {
    return { ok: false, status: 404, error: "Participante não encontrado" };
  }

  const { data: responses, error: rErr } = (await supabase
    .from("quiz_responses")
    .select("*")
    .eq("participant_id", participantId)) as {
    data: QuizResponse[] | null;
    error: { message: string } | null;
  };

  if (rErr || !responses || responses.length < TOTAL_STAGES) {
    return {
      ok: false,
      status: 400,
      error: "Participante não completou todas as etapas",
    };
  }

  const { data: stages, error: sErr } = (await supabase
    .from("quiz_stages")
    .select("*")
    .order("id")) as { data: QuizStage[] | null; error: { message: string } | null };

  if (sErr || !stages) {
    return { ok: false, status: 500, error: "Erro ao buscar etapas" };
  }

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

  const systemPrompt = buildSystemPrompt(kbEntries ?? []);
  const userPrompt = buildUserPrompt(participant.full_name, {
    responses,
    stages,
  });

  // Structured outputs: the model is constrained to this JSON shape, which
  // removes the "extract the JSON with a regex and hope" failure mode.
  // Serialized to a plain object on purpose — zodOutputFormat attaches a
  // client-side parser that THROWS mid-stream on a schema mismatch, and we
  // want the graceful error path below instead.
  const outputFormat = JSON.parse(
    JSON.stringify(zodOutputFormat(prognosticContentSchema))
  ) as Anthropic.Messages.JSONOutputFormat;

  // Streaming is required at this max_tokens: a non-streaming request that
  // large risks an HTTP timeout before the model finishes.
  const stream = anthropic.messages.stream({
    model: "claude-opus-5",
    // Thinking and visible output share this budget. The old 4096 was already
    // tight for a ~1.3k-word deliverable and would truncate with thinking on.
    max_tokens: 32000,
    // Adaptive thinking replaces the fixed budget; `temperature` is rejected
    // outright by Opus 5 and had to go.
    thinking: { type: "adaptive" },
    // effort medium, nao high: medido no mesmo participante real, o high
    // levava 147s e 10.749 tokens de saida para produzir 1.303 palavras; o
    // medium leva 63s e 3.931 tokens para produzir 1.280. Os ~8.700 tokens de
    // raciocinio extras do high nao apareciam no texto entregue.
    output_config: { effort: "medium", format: outputFormat },
    // cache_control on the system prompt: it is large (methodology + knowledge
    // base) and identical for every participant, so a batch of 20 pays the
    // write once and reads it 19 times at a tenth of the price.
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const message = await stream.finalMessage();

  // Safety classifiers can decline a request: HTTP 200, empty or partial
  // content, stop_reason "refusal". Reading content[0] blind would throw.
  if (message.stop_reason === "refusal") {
    console.error("[generate-prognostic] refusal", {
      participantId,
      stopDetails: message.stop_details,
    });
    return {
      ok: false,
      status: 502,
      error: "A IA recusou a geração para este participante",
    };
  }

  const rawText = message.content.find((b) => b.type === "text")?.text ?? "";

  let content: PrognosticContent;
  try {
    const parsed: unknown = JSON.parse(rawText);

    const validated = prognosticContentSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[generate-prognostic] schema validation failed", {
        errors: validated.error.flatten(),
        parsedPreview: JSON.stringify(parsed).slice(0, 800),
      });
      return {
        ok: false,
        status: 500,
        error: "IA retornou estrutura inválida",
        detail: validated.error.flatten(),
      };
    }
    content = validated.data as PrognosticContent;
  } catch (err) {
    console.error("[generate-prognostic] parse failure", {
      err: err instanceof Error ? err.message : String(err),
      rawTextPreview: rawText.slice(0, 800),
      rawTextLength: rawText.length,
      anthropicUsage: message.usage,
      stopReason: message.stop_reason,
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao parsear resposta da IA",
      detail: err instanceof Error ? err.message : "unknown",
    };
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
    const { error: uErr } = await (
      supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }
    )
      .update({
        raw_ai_output: content,
        status: "generated",
        trail_recommendation: content.trilha_recomendada,
        generated_at: new Date().toISOString(),
        pdf_url: null,
      })
      .eq("participant_id", participantId);

    if (uErr) {
      console.error("[generate-prognostic] update failure", { err: uErr, participantId });
      return {
        ok: false,
        status: 500,
        error: "Erro ao salvar prognóstico",
        detail: uErr.message,
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
    payload: { trail: content.trilha_recomendada },
  });

  return { ok: true, prognosticId, trail: content.trilha_recomendada };
}
