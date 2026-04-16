import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { JoinForm } from "@/components/features/participant/JoinForm";

interface Props {
  params: Promise<{ eventCode: string }>;
}

export default async function JoinPage({ params }: Props) {
  const { eventCode } = await params;
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select("id, name, event_date, host_name, location_name, status, max_participants")
    .eq("event_code", eventCode.toUpperCase())
    .single();

  if (!event) notFound();

  if (event.status === "completed") {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center space-y-3 max-w-sm">
          <p className="font-display text-2xl text-foreground">Imersão encerrada</p>
          <p className="text-muted-foreground text-sm">Esta imersão já foi concluída.</p>
        </div>
      </main>
    );
  }

  const { count } = await supabase
    .from("participants")
    .select("id", { count: "exact", head: true })
    .eq("event_id", event.id);

  const isFull = (count ?? 0) >= event.max_participants;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground font-sans">
            Fort Inside
          </p>
          <h1 className="font-display text-3xl text-foreground leading-tight">
            {event.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            com {event.host_name}
            {event.location_name && ` · ${event.location_name}`}
          </p>
        </div>

        {isFull ? (
          <div className="text-center space-y-2">
            <p className="text-destructive text-sm">Vagas esgotadas para este evento.</p>
          </div>
        ) : (
          <JoinForm eventId={event.id} eventCode={eventCode.toUpperCase()} />
        )}
      </div>
    </main>
  );
}
