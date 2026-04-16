import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { batchProcessSchema } from "@/lib/schemas";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = batchProcessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { event_id } = parsed.data;
  const supabase = createAdminClient();

  const { data: event } = await supabase
    .from("events")
    .select("id, current_stage")
    .eq("id", event_id)
    .single();

  if (!event || event.current_stage < 5) {
    return NextResponse.json({ error: "Evento não completou as 5 etapas" }, { status: 400 });
  }

  await supabase
    .from("events")
    .update({ status: "processing" })
    .eq("id", event_id);

  const { data: participants } = await supabase
    .from("participants")
    .select("id, completed_at")
    .eq("event_id", event_id)
    .not("completed_at", "is", null);

  if (!participants || participants.length === 0) {
    return NextResponse.json({ error: "Nenhum participante completou o quiz" }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const results = await Promise.allSettled(
    participants.map((p) =>
      fetch(`${baseUrl}/api/generate-prognostic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participant_id: p.id, event_id }),
      }).then((r) => r.json())
    )
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  await supabase
    .from("events")
    .update({ status: "completed" })
    .eq("id", event_id);

  await supabase.from("event_logs").insert({
    event_id,
    action: "batch_process_completed",
    payload: { total: participants.length, succeeded, failed },
  });

  return NextResponse.json({ success: true, total: participants.length, succeeded, failed });
}
