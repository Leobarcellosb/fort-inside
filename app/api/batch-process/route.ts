import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAdminUser } from "@/lib/auth/require-admin";
import { batchProcessSchema } from "@/lib/schemas";
import { generatePrognostic, TOTAL_STAGES } from "@/lib/ai/generate-prognostic";
import { renderAndStorePdf } from "@/lib/pdf/render-prognostic-pdf";
import type { Event, Participant } from "@/types/database";

export const maxDuration = 300;

// Dispara em ondas em vez de tudo de uma vez. Vinte requests simultaneos de
// 32k max_tokens podem estourar o rate limit da organizacao no meio do evento,
// e vinte renderizacoes de PDF ao mesmo tempo pesam na memoria da funcao.
// Com ~63s por prognostico, 10 por onda entrega 20 participantes em ~2 min.
// Tudo de uma vez seria ~1 min, mas um 429 no meio do evento custa mais que o
// minuto economizado: o SDK so tenta de novo 2 vezes antes de desistir, e um
// participante sem prognostico e um problema visivel na sala.
const CONCURRENCY = 10;

async function inWaves<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const wave = items.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.allSettled(wave.map(fn))));
  }
  return out;
}

export async function POST(req: NextRequest) {
  // Admin only: this fans out one Anthropic call per participant.
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = batchProcessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { event_id } = parsed.data;
  const supabase = createAdminClient();

  const { data: event } = (await supabase
    .from("events")
    .select("id, current_stage")
    .eq("id", event_id)
    .single()) as { data: Pick<Event, "id" | "current_stage"> | null; error: unknown };

  if (!event || event.current_stage < TOTAL_STAGES) {
    return NextResponse.json(
      { error: `Evento não completou as ${TOTAL_STAGES} etapas` },
      { status: 400 }
    );
  }

  const { data: participants } = (await supabase
    .from("participants")
    .select("id, completed_at")
    .eq("event_id", event_id)
    .not("completed_at", "is", null)) as {
    data: Pick<Participant, "id" | "completed_at">[] | null;
    error: unknown;
  };

  if (!participants || participants.length === 0) {
    return NextResponse.json(
      { error: "Nenhum participante completou o quiz" },
      { status: 400 }
    );
  }

  await (
    supabase.from("events") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }
  )
    .update({ status: "processing" })
    .eq("id", event_id);

  // Generate in-process. The previous self-fetch to /api/generate-prognostic hit
  // that route's per-participant rate limit whenever the admin pressed
  // "Processar" within 60s of the stage-6 auto-fire, so successful generations
  // were reported back as failures.
  const results = await inWaves(participants, (p) =>
    generatePrognostic(p.id, event_id)
  );

  let succeeded = 0;
  const generatedIds: string[] = [];

  results.forEach((r, idx) => {
    const participantId = participants[idx]?.id;

    if (r.status === "rejected") {
      console.error("[batch-process] generation threw", {
        participant_id: participantId,
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
      return;
    }

    if (!r.value.ok) {
      console.error("[batch-process] generation failed", {
        participant_id: participantId,
        status: r.value.status,
        error: r.value.error,
        detail: r.value.detail,
      });
      return;
    }

    succeeded++;
    generatedIds.push(r.value.prognosticId);
  });

  const failed = results.length - succeeded;

  // Render PDFs up front so the participant's share page doesn't sit polling.
  await inWaves(generatedIds, (id) => renderAndStorePdf(id));

  await (
    supabase.from("events") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }
  )
    .update({ status: "completed" })
    .eq("id", event_id);

  await (
    supabase.from("event_logs") as unknown as {
      insert(v: Record<string, unknown>): Promise<unknown>;
    }
  ).insert({
    event_id,
    action: "batch_process_completed",
    payload: { total: participants.length, succeeded, failed },
  });

  return NextResponse.json({
    success: true,
    total: participants.length,
    succeeded,
    failed,
  });
}
