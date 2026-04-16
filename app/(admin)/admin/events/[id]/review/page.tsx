import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { PrognosticReviewGrid } from "@/components/features/admin/PrognosticReviewGrid";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ReviewPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select("id, name, status")
    .eq("id", id)
    .single();

  if (!event) notFound();

  const { data: participants } = await supabase
    .from("participants")
    .select("id, full_name, email")
    .eq("event_id", id);

  const { data: prognostics } = await supabase
    .from("prognostics")
    .select("*")
    .in("participant_id", (participants ?? []).map((p) => p.id));

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="mb-8 space-y-1">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Revisão de prognósticos</p>
        <h1 className="font-display text-2xl text-foreground">{event.name}</h1>
        <p className="text-muted-foreground text-sm">
          {prognostics?.filter((p) => p.status === "delivered").length ?? 0} de {prognostics?.length ?? 0} entregues
        </p>
      </div>

      <PrognosticReviewGrid
        eventId={id}
        participants={participants ?? []}
        prognostics={prognostics ?? []}
      />
    </div>
  );
}
