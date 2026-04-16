import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { AggregatedDashboard } from "@/components/features/admin/AggregatedDashboard";
import type { Prognostic, QuizResponse, Participant } from "@/types/database";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function DashboardPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select("id, name, event_date, status")
    .eq("id", id)
    .single();

  if (!event) notFound();

  const { data: participants } = await supabase
    .from("participants")
    .select("id, full_name, joined_at, completed_at")
    .eq("event_id", id);

  const participantIds = (participants ?? []).map((p) => p.id);

  const { data: responses } = await supabase
    .from("quiz_responses")
    .select("participant_id, stage_id, answers, submitted_at")
    .in("participant_id", participantIds);

  const { data: prognostics } = await supabase
    .from("prognostics")
    .select("participant_id, trail_recommendation, status")
    .in("participant_id", participantIds);

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Dashboard</p>
          <h1 className="font-display text-2xl text-foreground">{event.name}</h1>
          <p className="text-muted-foreground text-sm">
            {new Date(event.event_date).toLocaleDateString("pt-BR", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>

        <AggregatedDashboard
          participants={participants as Participant[] ?? []}
          responses={responses as QuizResponse[] ?? []}
          prognostics={prognostics as Pick<Prognostic, "participant_id" | "trail_recommendation" | "status">[] ?? []}
        />
      </div>
    </div>
  );
}
