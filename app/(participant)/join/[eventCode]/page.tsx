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
      <CinematicHero image={AMBIENT_IMAGES.join} alt="Entrada da imersão" overlay="heavy">
        <div className="mx-auto w-full max-w-md text-center space-y-3">
          <p className="font-playfair text-4xl md:text-6xl font-light text-white tracking-tight leading-tight">
            Imersão encerrada
          </p>
          <p className="text-white/80 text-sm">Esta imersão já foi concluída.</p>
        </div>
      </CinematicHero>
    );
  }

  const { count } = await supabase
    .from("participants")
    .select("id", { count: "exact", head: true })
    .eq("event_id", event.id);

  const isFull = (count ?? 0) >= event.max_participants;

  return (
    <main className="min-h-screen bg-background">
      <CinematicHero image={AMBIENT_IMAGES.join} alt={`Entrada da imersão ${event.name}`} overlay="heavy">
        <div className="mx-auto w-full max-w-md space-y-8">
          <div className="space-y-4 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-white/70 font-sans">
              {event.name}
              {event.location_name && ` · ${event.location_name}`}
            </p>
            <h1 className="font-playfair text-5xl md:text-7xl font-light text-white leading-tight tracking-tight">
              Você está prestes a entrar
            </h1>
          </div>

          {isFull ? (
            <div className="text-center">
              <p className="text-red-300 text-sm bg-black/40 border border-white/10 rounded-md px-4 py-3 backdrop-blur-sm">
                Vagas esgotadas para este evento.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-background/80 border border-white/10 p-5 backdrop-blur-md shadow-2xl">
              <JoinForm eventId={event.id} eventCode={eventCode.toUpperCase()} />
            </div>
          )}
        </div>
      </CinematicHero>
    </main>
  );
}
