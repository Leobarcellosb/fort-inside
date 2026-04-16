import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePrognosticSchema } from "@/lib/schemas";
import { PROGNOSTIC_SYSTEM_PROMPT, buildUserPrompt } from "@/lib/ai/prognostic-prompt";
import type { PrognosticContent, QuizResponse, QuizStage } from "@/types/database";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RATE_LIMIT_MAP = new Map<string, number>();

function checkRateLimit(participantId: string): boolean {
  const lastCall = RATE_LIMIT_MAP.get(participantId);
  const now = Date.now();
  if (lastCall && now - lastCall < 60_000) return false;
  RATE_LIMIT_MAP.set(participantId, now);
  return true;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = generatePrognosticSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos", details: parsed.error.flatten() }, { status: 400 });
  }

  const { participant_id, event_id } = parsed.data;

  if (!checkRateLimit(participant_id)) {
    return NextResponse.json({ error: "Aguarde antes de tentar novamente." }, { status: 429 });
  }

  const supabase = createAdminClient();

  const { data: participant, error: pErr } = await supabase
    .from("participants")
    .select("full_name")
    .eq("id", participant_id)
    .single();

  if (pErr || !participant) {
    return NextResponse.json({ error: "Participante não encontrado" }, { status: 404 });
  }

  const { data: responses, error: rErr } = await supabase
    .from("quiz_responses")
    .select("*")
    .eq("participant_id", participant_id);

  if (rErr || !responses || responses.length < 5) {
    return NextResponse.json({ error: "Participante não completou todas as etapas" }, { status: 400 });
  }

  const { data: stages, error: sErr } = await supabase
    .from("quiz_stages")
    .select("*")
    .order("id");

  if (sErr || !stages) {
    return NextResponse.json({ error: "Erro ao buscar etapas" }, { status: 500 });
  }

  const userPrompt = buildUserPrompt(participant.full_name, {
    responses: responses as QuizResponse[],
    stages: stages as QuizStage[],
  });

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    temperature: 0.7,
    system: PROGNOSTIC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";

  let content: PrognosticContent;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSON não encontrado");
    content = JSON.parse(jsonMatch[0]);
  } catch {
    return NextResponse.json({ error: "Falha ao parsear resposta da IA" }, { status: 500 });
  }

  const { data: existing } = await supabase
    .from("prognostics")
    .select("id")
    .eq("participant_id", participant_id)
    .single();

  if (existing) {
    const { error: uErr } = await supabase
      .from("prognostics")
      .update({
        raw_ai_output: content,
        status: "generated",
        trail_recommendation: content.trilha_recomendada,
        generated_at: new Date().toISOString(),
      })
      .eq("participant_id", participant_id);

    if (uErr) return NextResponse.json({ error: "Erro ao salvar prognóstico" }, { status: 500 });
  } else {
    const { error: iErr } = await supabase.from("prognostics").insert({
      participant_id,
      raw_ai_output: content,
      status: "generated",
      trail_recommendation: content.trilha_recomendada,
      generated_at: new Date().toISOString(),
    });

    if (iErr) return NextResponse.json({ error: "Erro ao salvar prognóstico" }, { status: 500 });
  }

  await supabase.from("event_logs").insert({
    event_id,
    participant_id,
    action: "prognostic_generated",
    payload: { trail: content.trilha_recomendada },
  });

  return NextResponse.json({ success: true, trail: content.trilha_recomendada });
}
