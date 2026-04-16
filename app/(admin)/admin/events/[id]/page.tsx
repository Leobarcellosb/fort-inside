import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { LiveControlPanel } from "@/components/features/admin/LiveControlPanel";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EventControlPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select("*")
    .eq("id", id)
    .single();

  if (!event) notFound();

  const { data: stages } = await supabase
    .from("quiz_stages")
    .select("id, title, ambient_name, questions")
    .order("id");

  const { data: participants } = await supabase
    .from("participants")
    .select("id, full_name, email, completed_at")
    .eq("event_id", id);

  const { data: responses } = await supabase
    .from("quiz_responses")
    .select("participant_id, stage_id")
    .in("participant_id", (participants ?? []).map((p) => p.id));

  const { data: logs } = await supabase
    .from("event_logs")
    .select("action, payload, created_at, participant_id")
    .eq("event_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <LiveControlPanel
      event={event}
      stages={stages ?? []}
      participants={participants ?? []}
      initialResponses={responses ?? []}
      initialLogs={logs ?? []}
    />
  );
}
