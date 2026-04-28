import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { JoinForm } from "@/components/features/participant/JoinForm";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { AMBIENT_IMAGES } from "@/lib/cinematic-map";
import type { Event } from "@/types/database";

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
    .single() as { data: Pick<Event, "id" | "name" | "event_date" | "host_name" | "location_name" | "status" | "max_participants"> | null; error: unknown };

  if (!event) notFound();

  if (event.status === "completed") {
    return (
      <main className="min-h-screen bg-background">
        <CinematicHero
          imageSrc={AMBIENT_IMAGES.join}
          imageAlt="Imersão encerrada"
          eyebrow="Imersão Fort Inside"
          title="Imersão encerrada"
          subtitle="Esta imersão já foi concluída."
        />
      </main>
    );
  }

  const { count } = await supabase
    .from("participants")
    .select("id", { count: "exact", head: true })
    .eq("event_id", event.id);

  const isFull = (count ?? 0) >= event.max_participants;

  return (
    <main className="min-h-screen bg-background">
      <CinematicHero
        imageSrc={AMBIENT_IMAGES.join}
        imageAlt="Entrada da imersão"
        eyebrow="Imersão Fort Inside"
        title="Entre"
        subtitle={`${event.name}${event.location_name ? ` · ${event.location_name}` : ""}`}
      />
      <section className="px-6 py-16 max-w-md mx-auto">
        {isFull ? (
          <p className="text-destructive text-sm text-center bg-secondary border border-border rounded-md px-4 py-3">
            Vagas esgotadas para este evento.
          </p>
        ) : (
          <JoinForm eventId={event.id} eventCode={eventCode.toUpperCase()} />
        )}
      </section>
    </main>
  );
}
