"use client";

import { use, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { QuizStage } from "@/types/database";
import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { getStageImage } from "@/lib/cinematic-map";

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
  const [currentQ, setCurrentQ] = useState(0);
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

  // Autosave debounced
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

  function handleSelectOption(questionId: string, option: string) {
    setAnswer(questionId, option);
    // Auto-advance after short delay for select questions
    setTimeout(() => {
      if (stage && currentQ < stage.questions.length - 1) {
        setCurrentQ((q) => q + 1);
      }
    }, 300);
  }

  async function handleSubmit() {
    if (!stage || !participantId || !eventId) return;

    const unanswered = stage.questions.filter((q) => !answers[q.id]?.trim());
    if (unanswered.length > 0) {
      toast.error("Responda todas as perguntas antes de continuar.");
      return;
    }

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

  const question = stage.questions[currentQ];
  const progress = (currentQ / stage.questions.length) * 100;
  const isLast = currentQ === stage.questions.length - 1;
  const canAdvance = !!answers[question.id]?.trim();

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

      {/* Progress bar bridge */}
      <div className="px-6 pt-4">
        <Progress value={progress} className="h-0.5 bg-border" />
      </div>

      {/* Question */}
      <div className="flex-1 px-6 py-6 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {currentQ + 1} / {stage.questions.length}
            </p>
            <p className="text-foreground text-base leading-relaxed font-medium">
              {question.text}
            </p>
          </div>

          {question.type === "select" && question.options ? (
            <div className="space-y-2">
              {question.options.map((option) => {
                const selected = answers[question.id] === option;
                return (
                  <button
                    key={option}
                    onClick={() => handleSelectOption(question.id, option)}
                    className={`w-full text-left px-4 py-3 rounded-md border text-sm transition-all duration-200
                      ${selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          ) : (
            <Textarea
              placeholder="Escreva sua resposta..."
              value={answers[question.id] ?? ""}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAnswer(question.id, e.target.value)}
              className="min-h-[140px] bg-card border-border text-foreground placeholder:text-muted-foreground resize-none focus-visible:ring-primary/40"
              autoFocus
            />
          )}
        </div>

        {/* Navigation */}
        <div className="flex gap-3 mt-8">
          {currentQ > 0 && (
            <Button
              variant="outline"
              onClick={() => setCurrentQ((q) => q - 1)}
              className="flex-1 border-border text-muted-foreground hover:text-foreground"
            >
              Voltar
            </Button>
          )}

          {isLast ? (
            <Button
              onClick={handleSubmit}
              disabled={submitting || !canAdvance}
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.06em] h-12"
            >
              {submitting ? "Enviando..." : "Concluir etapa"}
            </Button>
          ) : (
            <Button
              onClick={() => setCurrentQ((q) => q + 1)}
              disabled={!canAdvance}
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 h-12"
            >
              Próxima
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
