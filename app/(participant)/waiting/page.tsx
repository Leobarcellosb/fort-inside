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

    // Channel 1: event stage progression (redirects to /quiz/[stageId] when admin advances)
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

    // Channel 2: prognostic delivery (redirects to /prognostic/[token] when admin clicks "Entregar")
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
    // Always redirect to the FIRST unanswered stage <= currentStage so the
    // participant catches up sequentially even if admin advanced multiple
    // stages while they were in transit (e.g. between submit and /waiting load).
    // Without this, admin moving 2 -> 3 -> 4 fast caused stage 3 to be skipped.
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
    // All stages up to currentStage already answered — stay on waiting.
  }

  return (
    <main className="min-h-screen bg-background">
      <CinematicHero
        image={AMBIENT_IMAGES.waiting}
        alt="Aguardando a próxima etapa"
        overlay="heavy"
        contentClassName="pb-24 [padding-bottom:calc(env(safe-area-inset-bottom)+6rem)]"
      >
        <div className="mx-auto w-full max-w-md text-center space-y-10">
          <div className="space-y-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/70">Fort Inside</p>
            <h1 className="font-playfair text-5xl md:text-7xl font-light text-white leading-tight tracking-tight">
              Em silêncio até o próximo convite
            </h1>
            {eventName && (
              <p className="text-white/75 text-sm">
                {eventName} · com {hostName}
              </p>
            )}
          </div>

          <div className="space-y-5 py-4">
            <div className="relative mx-auto w-16 h-16">
              <div className="absolute inset-0 rounded-full border border-primary/30 animate-ping" />
              <div className="absolute inset-2 rounded-full border border-primary/50" />
              <div className="absolute inset-4 rounded-full bg-primary/40" />
            </div>

            <div className="space-y-2">
              <p className="text-white/90 text-base font-medium">
                Aguardando próxima etapa{dots}
              </p>
              {currentStage > 0 && (
                <p className="text-xs text-white/60">
                  Etapa {currentStage} em andamento
                </p>
              )}
            </div>
          </div>

          <p className="text-xs text-white/50 leading-relaxed">
            Quando {hostName} liberar a próxima etapa,<br />
            você será redirecionado automaticamente.
          </p>
        </div>
      </CinematicHero>
    </main>
  );
}
