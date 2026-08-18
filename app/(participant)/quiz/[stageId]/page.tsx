"use client";

import { use, useEffect, useState, useCallback } from "react";
import { notFound, useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { QuizQuestion, QuizStage } from "@/types/database";
import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { getStageImage } from "@/lib/cinematic-map";
import { TOTAL_STAGES } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ stageId: string }>;
}

export default function QuizPage({ params }: Props) {
  const { stageId } = use(params);
  const router = useRouter();
  const stageNum = parseInt(stageId, 10);

  const [stage, setStage] = useState<QuizStage | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [stageMissing, setStageMissing] = useState(false);

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
    if (!Number.isInteger(stageNum) || stageNum < 1 || stageNum > TOTAL_STAGES) {
      setStageMissing(true);
      return;
    }
    const supabase = createClient();
    supabase
      .from("quiz_stages")
      .select("*")
      .eq("id", stageNum)
      .single()
      .then(({ data }) => {
        if (data) setStage(data as QuizStage);
        else setStageMissing(true);
      });
  }, [stageNum, participantId]);

  const autosave = useCallback(
    (updated: Record<string, string | string[] | number>) => {
      localStorage.setItem(`fort_answers_${stageNum}`, JSON.stringify(updated));
    },
    [stageNum]
  );

  function setAnswer(questionId: string, value: string | string[] | number) {
    const updated = { ...answers, [questionId]: value };
    setAnswers(updated);
    autosave(updated);
  }

  // ranking: toca em uma opção para dar a ela a próxima posição livre;
  // tocar de novo numa opção já ordenada remove e reordena as demais.
  function toggleRanking(question: QuizQuestion, option: string) {
    const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
    const updated = current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option];
    setAnswer(question.id, updated);
  }

  // multi_select: alterna a opção, respeitando max_choices quando definido.
  function toggleMultiSelect(question: QuizQuestion, option: string) {
    const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
    if (current.includes(option)) {
      setAnswer(question.id, current.filter((o) => o !== option));
      return;
    }
    if (question.max_choices && current.length >= question.max_choices) return;
    setAnswer(question.id, [...current, option]);
  }

  const allValid = !!stage && stage.questions.every((q) => {
    const val = answers[q.id];
    switch (q.type) {
      case "select":
      case "short_text":
      case "dilemma": {
        const str = typeof val === "string" ? val : "";
        return q.required ? str.length > 0 : true;
      }
      case "text": {
        const str = typeof val === "string" ? val : "";
        const min = q.min_chars ?? 0;
        return str.trim().length >= min;
      }
      case "scale": {
        if (typeof val === "number") return true;
        return !q.required;
      }
      case "multi_select": {
        const arr = Array.isArray(val) ? val : [];
        if (arr.length > 0) return true;
        return !q.required;
      }
      case "ranking": {
        // Ranking parcial não serve para nada: ou ordena tudo, ou não responde.
        const arr = Array.isArray(val) ? val : [];
        const total = q.options?.length ?? 0;
        if (total > 0 && arr.length === total) return true;
        return !q.required && arr.length === 0;
      }
      default:
        return true;
    }
  });

  async function handleSubmit() {
    if (!stage || !participantId || !eventId || !allValid) return;

    setSubmitting(true);
    try {
      const supabase = createClient();

      // onConflict must name the (participant_id, stage_id) unique constraint.
      // Without it PostgREST infers the primary key (id), so re-submitting a
      // stage raised a duplicate-key error instead of updating the answers.
      const { error } = await (supabase.from("quiz_responses") as unknown as {
        upsert(
          values: Record<string, unknown>,
          options: { onConflict: string }
        ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      }).upsert(
        { participant_id: participantId, stage_id: stageNum, answers },
        { onConflict: "participant_id,stage_id" }
      );

      if (error) {
        // O participante nunca deve ver erro cru de banco no meio da imersao.
        // A mensagem tecnica fica no console para o Yuri/suporte diagnosticar.
        console.error("[quiz] falha ao gravar etapa", { stageNum, error });
        const code = (error as { code?: string }).code;
        throw new Error(
          code === "42501"
            ? "Sua sessão expirou. Recarregue a página e tente de novo."
            : "Não consegui salvar suas respostas. Tente de novo em alguns segundos."
        );
      }

      // Broadcast to Yuri's panel
      await supabase.channel(`event:${eventId}`).send({
        type: "broadcast",
        event: "response_submitted",
        payload: { participant_id: participantId, stage_id: stageNum },
      });

      // Last stage complete: mark participant as done and trigger prognostic + PDF
      if (stageNum === TOTAL_STAGES) {
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

  if (stageMissing) {
    notFound();
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
      <CinematicHero
        variant="compact"
        imageSrc={getStageImage(stage.id)}
        imageAlt={stage.ambient_name}
        eyebrow={`Etapa ${stageNum} de ${TOTAL_STAGES}`}
        title={stage.ambient_name.toUpperCase()}
        subtitle={stage.title}
      />

      {/* Questions — all visible, single submit at bottom */}
      <div className="flex-1 px-6 py-10 space-y-12 max-w-xl w-full mx-auto">
        {stage.questions.map((question, idx) => {
          const rawValue = answers[question.id];
          const stringValue = typeof rawValue === "string" ? rawValue : "";
          const numberValue = typeof rawValue === "number" ? rawValue : undefined;
          const arrayValue = Array.isArray(rawValue) ? rawValue : [];
          const minChars = question.min_chars ?? 0;
          const currentLen = stringValue.trim().length;
          const tooShort = minChars > 0 && currentLen < minChars;
          const scaleMin = question.min ?? 0;
          const scaleMax = question.max ?? 10;
          const scaleSteps = Array.from(
            { length: Math.max(scaleMax - scaleMin + 1, 0) },
            (_, i) => scaleMin + i
          );
          const maxChoices = question.max_choices;

          return (
            <div key={question.id} className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Pergunta {idx + 1} de {stage.questions.length}
              </p>
              <p className="text-foreground text-[16px] leading-relaxed font-medium">
                {question.text}
              </p>

              {question.type === "select" && question.options ? (
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const selected = stringValue === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setAnswer(question.id, option)}
                        className={cn(
                          "w-full text-left px-4 py-3.5 rounded-md border text-base transition-all",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "multi_select" && question.options ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    {question.options.map((option) => {
                      const selected = arrayValue.includes(option);
                      const limitReached = !!maxChoices && arrayValue.length >= maxChoices && !selected;
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={limitReached}
                          onClick={() => toggleMultiSelect(question, option)}
                          className={cn(
                            "w-full text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[44px]",
                            selected
                              ? "border-primary bg-primary/10 text-foreground"
                              : limitReached
                                ? "border-primary/10 bg-card text-muted-foreground/50 cursor-not-allowed"
                                : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          )}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                  {maxChoices && (
                    <p className="text-xs text-primary/60" aria-live="polite">
                      {arrayValue.length} de {maxChoices} escolhidos
                    </p>
                  )}
                </div>
              ) : question.type === "ranking" && question.options ? (
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const position = arrayValue.indexOf(option);
                    const selected = position !== -1;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => toggleRanking(question, option)}
                        className={cn(
                          "w-full flex items-center gap-3 text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[44px]",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        <span
                          className={cn(
                            "flex items-center justify-center w-7 h-7 rounded-full border text-xs font-semibold shrink-0",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-primary/30 text-muted-foreground"
                          )}
                        >
                          {selected ? position + 1 : ""}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "dilemma" ? (
                <div className="flex flex-col sm:flex-row gap-3">
                  {[question.option_a, question.option_b].map((option, optionIdx) => {
                    if (!option) return null;
                    const selected = stringValue === option;
                    return (
                      <button
                        key={optionIdx}
                        type="button"
                        onClick={() => setAnswer(question.id, option)}
                        className={cn(
                          "flex-1 text-left px-4 py-5 rounded-md border text-base transition-all min-h-[44px]",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "scale" ? (
                <div className="space-y-2">
                  {/* Grade fixa em vez de flex-wrap: com 11 passos o wrap
                      deixava o "10" sozinho ocupando a linha inteira. 6 por
                      linha no mobile mantem o alvo de toque grande. */}
                  <div className="grid grid-cols-6 sm:grid-cols-11 gap-2">
                    {scaleSteps.map((step) => {
                      const selected = numberValue === step;
                      return (
                        <button
                          key={step}
                          type="button"
                          onClick={() => setAnswer(question.id, step)}
                          className={cn(
                            "flex-1 min-w-[44px] min-h-[44px] rounded-md border text-base transition-all",
                            selected
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          )}
                        >
                          {step}
                        </button>
                      );
                    })}
                  </div>
                  {(question.min_label || question.max_label) && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{question.min_label}</span>
                      <span>{question.max_label}</span>
                    </div>
                  )}
                </div>
              ) : question.type === "short_text" ? (
                <Input
                  placeholder={question.placeholder ?? "Responda com suas palavras..."}
                  value={stringValue}
                  maxLength={question.max_chars}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setAnswer(question.id, e.target.value)
                  }
                  className="h-[44px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground border-primary/40 focus-visible:border-primary focus-visible:ring-0 transition-colors"
                />
              ) : (
                <Textarea
                  placeholder={question.placeholder ?? "Responda com suas palavras..."}
                  value={stringValue}
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
              )}

              {question.type === "text" && minChars > 0 && (
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
