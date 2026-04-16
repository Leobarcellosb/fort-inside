"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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

    supabase
      .from("events")
      .select("name, current_stage, host_name, status")
      .eq("id", eventId)
      .single()
      .then(({ data }) => {
        if (!data) return;
        setEventName(data.name);
        setHostName(data.host_name ?? "Yuri Fortes");
        setCurrentStage(data.current_stage);

        if (data.current_stage > 0) {
          checkAndRedirect(supabase, participantId, data.current_stage);
        }
      });

    // Subscribe to event stage changes
    const channel = supabase
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

    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);

  async function checkAndRedirect(
    supabase: ReturnType<typeof createClient>,
    participantId: string,
    stage: number
  ) {
    // Check if participant already answered this stage
    const { data } = await supabase
      .from("quiz_responses")
      .select("id")
      .eq("participant_id", participantId)
      .eq("stage_id", stage)
      .single();

    if (!data) {
      router.push(`/quiz/${stage}`);
    }
    // If already answered, stay on waiting page (next stage will come)
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm text-center space-y-8">
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
            Fort Inside
          </p>
          <h1 className="font-display text-2xl text-foreground leading-snug">
            {eventName || "Imersão"}
          </h1>
          <p className="text-muted-foreground text-sm">com {hostName}</p>
        </div>

        <div className="space-y-4 py-8">
          <div className="relative mx-auto w-16 h-16">
            <div className="absolute inset-0 rounded-full border border-primary/20 animate-ping" />
            <div className="absolute inset-2 rounded-full border border-primary/40" />
            <div className="absolute inset-4 rounded-full bg-primary/20" />
          </div>

          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">
              Aguardando próxima etapa{dots}
            </p>
            {currentStage > 0 && (
              <p className="text-xs text-muted-foreground">
                Etapa {currentStage} em andamento
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground/60 leading-relaxed">
          Quando Yuri liberar a próxima etapa,<br />
          você será redirecionado automaticamente.
        </p>
      </div>
    </main>
  );
}
