"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { AMBIENT_IMAGES } from "@/lib/cinematic-map";
import type { Event, QuizResponse } from "@/types/database";

export default function WaitingPage() {
  const router = useRouter();
  const [eventName, setEventName] = useState<string>("");
  const [currentStage, setCurrentStage] = useState(0);
  const [hostName, setHostName] = useState("Yuri Fortes");
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 600);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const eventId = localStorage.getItem("fort_event_id");
    const participantId = localStorage.getItem("fort_participant_id");

    if (!eventId || !participantId) {
      router.replace("/");
      return;
    }

    const supabase = createClient();

    (supabase
      .from("events")
      .select("name, current_stage, host_name, status")
      .eq("id", eventId)
      .single() as unknown as Promise<{ data: Pick<Event, "name" | "current_stage" | "host_name" | "status"> | null; error: unknown }>)
      .then(({ data }) => {
        if (!data) return;
        setEventName(data.name);
        setHostName(data.host_name ?? "Yuri Fortes");
        setCurrentStage(data.current_stage);

        if (data.current_stage > 0) {
          checkAndRedirect(supabase, participantId, data.current_stage);
        }
      });

    const eventChannel = supabase
      .channel(`event:${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "events",
          filter: `id=eq.${eventId}`,
        },
        (payload) => {
          const stage = (payload.new as { current_stage: number }).current_stage;
          setCurrentStage(stage);
          if (stage > 0) {
            checkAndRedirect(supabase, participantId, stage);
          }
        }
      )
      .subscribe();

    const deliveryChannel = supabase
      .channel(`prognostic-delivery-${participantId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "prognostics",
          filter: `participant_id=eq.${participantId}`,
        },
        (payload) => {
          const prog = payload.new as { status: string; public_share_token: string | null };
          if (prog.status === "delivered" && prog.public_share_token) {
            router.push(`/prognostic/${prog.public_share_token}`);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(eventChannel);
      supabase.removeChannel(deliveryChannel);
    };
  }, [router]);

  async function checkAndRedirect(
    supabase: ReturnType<typeof createClient>,
    participantId: string,
    currentStage: number
  ) {
    const { data: answered } = await supabase
      .from("quiz_responses")
      .select("stage_id")
      .eq("participant_id", participantId) as {
        data: Pick<QuizResponse, "stage_id">[] | null;
        error: unknown;
      };

    const answeredIds = new Set((answered ?? []).map((r) => r.stage_id));

    for (let s = 1; s <= currentStage; s++) {
      if (!answeredIds.has(s)) {
        router.push(`/quiz/${s}`);
        return;
      }
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <CinematicHero
        imageSrc={AMBIENT_IMAGES.waiting}
        imageAlt="Aguardando próxima etapa"
        eyebrow="Próxima etapa"
        title="Aguarde"
        subtitle={`${hostName} vai liberar em instantes`}
      />
      <section className="px-6 py-16 max-w-md mx-auto text-center space-y-10">
        <div className="relative mx-auto w-16 h-16">
          <div className="absolute inset-0 rounded-full border border-foreground/30 animate-ping" />
          <div className="absolute inset-2 rounded-full border border-foreground/50" />
          <div className="absolute inset-4 rounded-full bg-foreground/40" />
        </div>

        <div className="space-y-2">
          <p className="text-foreground text-base font-medium">
            Aguardando próxima etapa{dots}
          </p>
          {currentStage > 0 && (
            <p className="text-xs text-muted-foreground">
              Etapa {currentStage} em andamento
            </p>
          )}
          {eventName && (
            <p className="text-xs text-muted-foreground">
              {eventName} · com {hostName}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          Quando {hostName} liberar a próxima etapa,<br />
          você será redirecionado automaticamente.
        </p>
      </section>
    </main>
  );
}
