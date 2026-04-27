"use client";

import { use, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { QuizStage } from "@/types/database";
import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { getStageImage } from "@/lib/cinematic-map";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ stageId: string }>;
}

export default function QuizPage({ params }: Props) {
  const { stageId } = use(params);
  const router = useRouter();
  const stageNum = parseInt(stageId, 10);

  const [stage, setStage] = useState<QuizStage | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  useEffect(() => {
    const pid = localStorage.getItem("fort_participant_id");
    const eid = localStorage.getItem("fort_event_id");
    if (!pid || !eid) { router.replace("/"); return; }
    setParticipantId(pid);
    setEventId(eid);

    const saved = localStorage.getItem(`fort_answers_${stageNum}`);
    if (saved) {
      try { setAnswers(JSON.parse(saved)); } catch { /* ignore */ }
    }
  }, [router, stageNum]);

  useEffect(() => {
    if (!participantId) return;
    const supabase = createClient();
    supabase
      .from("quiz_stages")
      .select("*")
      .eq("id", stageNum)
      .single()
      .then(({ data }) => {
        if (data) setStage(data as QuizStage);
      });
  }, [stageNum, participantId]);

  const autosave = useCallback(
    (updated: Record<string, string>) => {
      localStorage.setItem(`fort_answers_${stageNum}`, JSON.stringify(updated));
    },
    [stageNum]
  );

  function setAnswer(questionId: string, value: string) {
    const updated = { ...answers, [questionId]: value };
    setAnswers(updated);
    autosave(updated);
  }

  const allValid = !!stage && stage.questions.every((q) => {
    const min = q.min_chars ?? 0;
    const val = answers[q.id] ?? "";
    return val.trim().length >= min;
  });

  async function handleSubmit() {
    if (!stage || !participantId || !eventId || !allValid) return;

    setSubmitting(true);
    try {
      const supabase = createClient();

      const { error } = await (supabase.from("quiz_responses") as unknown as {
        upsert(values: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      }).upsert({ participant_id: participantId, stage_id: stageNum, answers });

      if (error) throw new Error(error.message);

      // Broadcast to Yuri's panel
      await supabase.channel(`event:${eventId}`).send({
        type: "broadcast",
        event: "response_submitted",
        payload: { participant_id: participantId, stage_id: stageNum },
      });

      // If stage 5 complete, mark participant as done and trigger prognostic + PDF
      if (stageNum === 5) {
        await ((supabase.from("participants") as unknown as {
          update(values: Record<string, unknown>): { eq(col: string, val: string): Promise<unknown> };
        }).update({ completed_at: new Date().toISOString() }).eq("id", participantId));

        // Fire-and-forget: prognostic generation chains into PDF generation server-side
        fetch("/api/generate-prognostic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participant_id: participantId, event_id: eventId }),
          keepalive: true,
        }).catch(() => {
          // Admin can re-run via "Processar prognósticos" if this fails
        });
      }

      localStorage.removeItem(`fort_answers_${stageNum}`);
      router.push("/waiting");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao enviar respostas");
    } finally {
      setSubmitting(false);
    }
  }

  if (!stage) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col bg-background">
      {/* Cinematic hero — top 40vh with ambient image + stage title in Playfair */}
      <CinematicHero
        image={getStageImage(stageNum)}
        alt={`${stage.title} — ${stage.ambient_name}`}
        overlay="medium"
        height="split"
        priority
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-white/70">
              Etapa {stageNum} de 5
            </p>
            <p className="text-xs text-white/70">{stage.ambient_name}</p>
          </div>
          <h2 className="font-playfair text-3xl md:text-5xl font-light text-white leading-tight tracking-tight">
            {stage.title}
          </h2>
        </div>
      </CinematicHero>

      {/* Questions — all visible, single submit at bottom */}
      <div className="flex-1 px-6 py-10 space-y-12 max-w-xl w-full mx-auto">
        {stage.questions.map((question, idx) => {
          const value = answers[question.id] ?? "";
          const minChars = question.min_chars ?? 0;
          const currentLen = value.trim().length;
          const tooShort = minChars > 0 && currentLen < minChars;

          return (
            <div key={question.id} className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Pergunta {idx + 1} de {stage.questions.length}
              </p>
              <p className="text-foreground text-[16px] leading-relaxed font-medium">
                {question.text}
              </p>
              <Textarea
                placeholder={question.placeholder ?? "Responda com suas palavras..."}
                value={value}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setAnswer(question.id, e.target.value)
                }
                rows={6}
                className={cn(
                  "min-h-[140px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground resize-none focus-visible:ring-0 transition-colors",
                  tooShort
                    ? "border-primary/20 focus-visible:border-primary"
                    : "border-primary/40 focus-visible:border-primary"
                )}
              />
              {minChars > 0 && (
                <p
                  className={cn(
                    "text-xs transition-colors",
                    tooShort ? "text-destructive" : "text-primary/60"
                  )}
                  aria-live="polite"
                >
                  {currentLen}/{minChars} {tooShort ? "mínimo" : "caracteres"}
                </p>
              )}
            </div>
          );
        })}

        <Button
          onClick={handleSubmit}
          disabled={submitting || !allValid}
          className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Enviando..." : "Enviar esta etapa"}
        </Button>
      </div>
    </main>
  );
}
