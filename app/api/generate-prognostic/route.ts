import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePrognosticSchema } from "@/lib/schemas";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prognostic-prompt";
import type { PrognosticContent, QuizResponse, QuizStage, Participant, Prognostic } from "@/types/database";

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
    .single() as { data: Pick<Participant, "full_name"> | null; error: { message: string } | null };

  if (pErr || !participant) {
    return NextResponse.json({ error: "Participante não encontrado" }, { status: 404 });
  }

  const { data: responses, error: rErr } = await supabase
    .from("quiz_responses")
    .select("*")
    .eq("participant_id", participant_id) as { data: QuizResponse[] | null; error: { message: string } | null };

  if (rErr || !responses || responses.length < 5) {
    return NextResponse.json({ error: "Participante não completou todas as etapas" }, { status: 400 });
  }

  const { data: stages, error: sErr } = await supabase
    .from("quiz_stages")
    .select("*")
    .order("id") as { data: QuizStage[] | null; error: { message: string } | null };

  if (sErr || !stages) {
    return NextResponse.json({ error: "Erro ao buscar etapas" }, { status: 500 });
  }

  const { data: kbEntries } = await supabase
    .from("knowledge_base")
    .select("title, content")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true }) as { data: { title: string; content: string }[] | null; error: unknown };

  const systemPrompt = buildSystemPrompt(kbEntries ?? []);
  const userPrompt = buildUserPrompt(participant.full_name, {
    responses: responses as QuizResponse[],
    stages: stages as QuizStage[],
  });

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    temperature: 0.7,
    system: systemPrompt,
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
    .single() as { data: Pick<Prognostic, "id"> | null; error: unknown };

  type MutResult = { data: unknown; error: { message: string } | null };
  type SelectSingle<T> = { data: T | null; error: { message: string } | null };

  let prognosticId: string | null = null;

  if (existing) {
    prognosticId = existing.id;
    const { error: uErr } = await ((supabase.from("prognostics") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
    }).update({
      raw_ai_output: content,
      status: "generated",
      trail_recommendation: content.trilha_recomendada,
      generated_at: new Date().toISOString(),
      pdf_url: null,
    }).eq("participant_id", participant_id));

    if (uErr) return NextResponse.json({ error: "Erro ao salvar prognóstico" }, { status: 500 });
  } else {
    const { data: inserted, error: iErr } = await ((supabase.from("prognostics") as unknown as {
      insert(v: Record<string, unknown>): {
        select(cols: string): { single(): Promise<SelectSingle<Pick<Prognostic, "id">>> };
      };
    }).insert({
      participant_id,
      raw_ai_output: content,
      status: "generated",
      trail_recommendation: content.trilha_recomendada,
      generated_at: new Date().toISOString(),
    }).select("id").single());

    if (iErr || !inserted) return NextResponse.json({ error: "Erro ao salvar prognóstico" }, { status: 500 });
    prognosticId = inserted.id;
  }

  await ((supabase.from("event_logs") as unknown as {
    insert(v: Record<string, unknown>): Promise<unknown>;
  }).insert({ event_id, participant_id, action: "prognostic_generated", payload: { trail: content.trilha_recomendada } }));

  // Chain PDF generation — await so result is persisted before response
  let pdfUrl: string | null = null;
  if (prognosticId) {
    try {
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (req.headers.get("origin") || `http://${req.headers.get("host") ?? "localhost:3000"}`);
      const pdfRes = await fetch(`${baseUrl}/api/generate-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prognostic_id: prognosticId }),
      });
      if (pdfRes.ok) {
        const pdfJson = (await pdfRes.json()) as { pdf_url?: string };
        pdfUrl = pdfJson.pdf_url ?? null;
      }
    } catch {
      // PDF failure should not break prognostic generation
    }
  }

  return NextResponse.json({
    success: true,
    prognostic_id: prognosticId,
    trail: content.trilha_recomendada,
    pdf_url: pdfUrl,
  });
}
