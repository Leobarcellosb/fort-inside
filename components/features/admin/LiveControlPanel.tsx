"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Event, QuizStage } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { EventQRDialog } from "@/components/features/admin/EventQRDialog";

interface Participant {
  id: string;
  full_name: string;
  email: string;
  completed_at: string | null;
}

interface ResponseRecord {
  participant_id: string;
  stage_id: number;
}

interface LogRecord {
  action: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  participant_id: string | null;
}

interface Props {
  event: Event;
  stages: Pick<QuizStage, "id" | "title" | "ambient_name" | "questions">[];
  participants: Participant[];
  initialResponses: ResponseRecord[];
  initialLogs: LogRecord[];
}

const STAGE_LABELS = ["—", "Portão", "Entrada", "Sala Principal", "Cozinha", "Varanda", "Suíte"];

export function LiveControlPanel({ event, stages, participants: initialParticipants, initialResponses, initialLogs }: Props) {
  const router = useRouter();
  const [currentStage, setCurrentStage] = useState(event.current_stage);
  const [eventStatus, setEventStatus] = useState(event.status);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [responses, setResponses] = useState<ResponseRecord[]>(initialResponses);
  const [logs, setLogs] = useState<LogRecord[]>(initialLogs);
  const [releasing, setReleasing] = useState(false);
  const [processing, setProcessing] = useState(false);

  const getParticipantResponses = useCallback(
    (participantId: string) =>
      responses.filter((r) => r.participant_id === participantId).map((r) => r.stage_id),
    [responses]
  );

  const completedCurrentStage = participants.filter((p) =>
    responses.some((r) => r.participant_id === p.id && r.stage_id === currentStage)
  ).length;

  const allCompletedCurrent =
    currentStage > 0 && completedCurrentStage >= participants.length;

  const allParticipantsDone =
    participants.length > 0 && participants.every((p) => p.completed_at !== null);

  useEffect(() => {
    const supabase = createClient();
    const participantIds = new Set(initialParticipants.map((p) => p.id));

    const upsertResponse = (r: ResponseRecord) => {
      if (!participantIds.has(r.participant_id)) return;
      setResponses((prev) => {
        const idx = prev.findIndex(
          (x) => x.participant_id === r.participant_id && x.stage_id === r.stage_id
        );
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = r;
          return next;
        }
        return [...prev, r];
      });
      const p = initialParticipants.find((x) => x.id === r.participant_id);
      setLogs((prev) => [
        {
          action: "response_submitted",
          payload: { stage_id: r.stage_id },
          created_at: new Date().toISOString(),
          participant_id: r.participant_id,
        },
        ...prev,
      ]);
      if (p) toast.success(`${p.full_name} completou etapa ${r.stage_id}`);
    };

    const channel = supabase
      .channel(`event:${event.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "quiz_responses" },
        (payload) => upsertResponse(payload.new as ResponseRecord)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "quiz_responses" },
        (payload) => upsertResponse(payload.new as ResponseRecord)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (payload) => {
          const updated = payload.new as Participant;
          setParticipants((prev) =>
            prev.map((p) => (p.id === updated.id ? { ...p, completed_at: updated.completed_at } : p))
          );
          if (updated.completed_at) {
            const p = initialParticipants.find((x) => x.id === updated.id);
            if (p) {
              setLogs((prev) => [
                {
                  action: "participant_completed",
                  payload: null,
                  created_at: new Date().toISOString(),
                  participant_id: updated.id,
                },
                ...prev,
              ]);
              toast.success(`${p.full_name} concluiu o quiz — gerando prognóstico…`);
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "prognostics" },
        (payload) => {
          const pr = payload.new as { participant_id: string; trail_recommendation: string | null };
          if (!participantIds.has(pr.participant_id)) return;
          const p = initialParticipants.find((x) => x.id === pr.participant_id);
          setLogs((prev) => [
            {
              action: "prognostic_generated",
              payload: { trail: pr.trail_recommendation },
              created_at: new Date().toISOString(),
              participant_id: pr.participant_id,
            },
            ...prev,
          ]);
          if (p) toast.success(`Prognóstico gerado — ${p.full_name}`);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "prognostics" },
        (payload) => {
          const pr = payload.new as { participant_id: string; pdf_url: string | null };
          if (!participantIds.has(pr.participant_id) || !pr.pdf_url) return;
          const p = initialParticipants.find((x) => x.id === pr.participant_id);
          setLogs((prev) => [
            {
              action: "pdf_generated",
              payload: null,
              created_at: new Date().toISOString(),
              participant_id: pr.participant_id,
            },
            ...prev,
          ]);
          if (p) toast.success(`PDF pronto — ${p.full_name}`);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "events", filter: `id=eq.${event.id}` },
        (payload) => {
          const e = payload.new as Event;
          setCurrentStage(e.current_stage);
          setEventStatus(e.status);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [event.id, initialParticipants]);

  async function releaseNextStage() {
    if (releasing) return;
    setReleasing(true);
    try {
      const supabase = createClient();
      const next = currentStage + 1;
      type MutResult = { data: unknown; error: { message: string } | null };
      const { error } = await ((supabase.from("events") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }).update({ current_stage: next, status: "live" }).eq("id", event.id));

      if (error) throw error;

      await ((supabase.from("event_logs") as unknown as {
        insert(v: Record<string, unknown>): Promise<unknown>;
      }).insert({ event_id: event.id, action: "stage_released", payload: { stage_id: next } }));

      setCurrentStage(next);
      toast.success(`Etapa ${next} liberada — ${STAGE_LABELS[next]}`);
    } catch {
      toast.error("Erro ao liberar etapa");
    } finally {
      setReleasing(false);
    }
  }

  async function processPrognostics() {
    setProcessing(true);
    try {
      const res = await fetch("/api/batch-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: event.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`${data.succeeded} de ${data.total} prognósticos gerados`);
      router.push(`/admin/events/${event.id}/review`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao processar");
    } finally {
      setProcessing(false);
    }
  }

  const nextStageInfo = stages.find((s) => s.id === currentStage + 1);
  const canReleaseNext = currentStage < 6 && (allCompletedCurrent || currentStage === 0);

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      {/* Header */}
      <div className="mb-8 space-y-1">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Painel ao vivo</p>
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-2xl text-foreground">{event.name}</h1>
          <EventQRDialog event={{ event_code: event.event_code }} />
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={eventStatus === "live" ? "default" : "secondary"} className="text-xs">
            {eventStatus === "live" ? "🔴 Ao vivo" : eventStatus === "processing" ? "⚙️ Processando" : eventStatus}
          </Badge>
          <span className="text-muted-foreground text-sm">
            {participants.length} participante{participants.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Column 1 — Stage Control */}
        <div className="space-y-4">
          <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Controle de etapas</h2>

          {/* Stage progress */}
          <div className="space-y-2">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div
                key={n}
                className={`flex items-center gap-3 px-4 py-3 rounded-md border transition-colors
                  ${n === currentStage
                    ? "border-primary bg-primary/10"
                    : n < currentStage
                    ? "border-border bg-card opacity-60"
                    : "border-border/50 opacity-30"
                  }`}
              >
                <span className={`text-xs font-mono w-4 ${n <= currentStage ? "text-primary" : "text-muted-foreground"}`}>
                  {n <= currentStage ? "✓" : n}
                </span>
                <div>
                  <p className="text-sm text-foreground leading-none">{stages.find((s) => s.id === n)?.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{STAGE_LABELS[n]}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Release button */}
          {currentStage < 6 && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    disabled={!canReleaseNext || releasing}
                    className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-sm"
                  />
                }
              >
                {releasing ? "Liberando..." : `Liberar etapa ${currentStage + 1}`}
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-foreground">
                    Liberar etapa {currentStage + 1}?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-muted-foreground">
                    {nextStageInfo ? (
                      <>
                        <strong className="text-foreground">{nextStageInfo.title}</strong>
                        {" — "}{nextStageInfo.ambient_name}
                        <br />
                        Os participantes serão redirecionados automaticamente.
                      </>
                    ) : "Isso não pode ser desfeito."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={releaseNextStage}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Liberar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {/* Process prognostics */}
          {currentStage === 6 && eventStatus !== "processing" && eventStatus !== "completed" && (
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-sm"
                    disabled={processing}
                  />
                }
              >
                {processing ? "Processando prognósticos..." : "Processar prognósticos"}
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-foreground">
                    Gerar prognósticos agora?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-muted-foreground">
                    Isso irá gerar o Mapa da Próxima Construção para todos os {participants.length} participantes.
                    Pode levar de 60 a 90 segundos.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={processPrognostics}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Processar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {processing && (
            <div className="space-y-2 px-4 py-3 rounded-md border border-primary/30 bg-primary/5">
              <p className="text-xs text-primary animate-pulse">Gerando prognósticos...</p>
              <div className="h-0.5 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full animate-pulse w-2/3" />
              </div>
            </div>
          )}
        </div>

        {/* Column 2 — Participants */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Participantes</h2>
            {currentStage > 0 && (
              <span className="text-xs text-muted-foreground">
                {completedCurrentStage}/{participants.length} na etapa {currentStage}
              </span>
            )}
          </div>

          <div className="space-y-2">
            {participants.map((p) => {
              const stagesAnswered = getParticipantResponses(p.id);
              const completedCurrent = stagesAnswered.includes(currentStage);
              const allDone = p.completed_at !== null;

              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-md border border-border bg-card"
                >
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs text-muted-foreground font-medium shrink-0">
                    {p.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{p.full_name}</p>
                    <div className="flex gap-1 mt-1">
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <div
                          key={n}
                          className={`w-4 h-1 rounded-full ${
                            stagesAnswered.includes(n) ? "bg-primary" : "bg-border"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {allDone ? (
                      <span className="text-xs text-success">✓ Completo</span>
                    ) : currentStage > 0 && completedCurrent ? (
                      <span className="text-xs text-primary">✓ Etapa {currentStage}</span>
                    ) : currentStage > 0 ? (
                      <span className="text-xs text-muted-foreground animate-pulse">Respondendo</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 3 — Timeline */}
        <div className="space-y-4">
          <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Timeline ao vivo</h2>
          <ScrollArea className="h-[500px]">
            <div className="space-y-2 pr-3">
              {logs.map((log, i) => {
                const participant = participants.find((p) => p.id === log.participant_id);
                const time = new Date(log.created_at).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                });

                let label = log.action;
                if (log.action === "response_submitted" && participant) {
                  label = `${participant.full_name} completou etapa ${(log.payload as { stage_id?: number })?.stage_id ?? ""}`;
                } else if (log.action === "stage_released") {
                  label = `Etapa ${(log.payload as { stage_id?: number })?.stage_id ?? ""} liberada`;
                } else if (log.action === "prognostic_generated" && participant) {
                  label = `Prognóstico gerado — ${participant.full_name}`;
                } else if (log.action === "pdf_generated" && participant) {
                  label = `PDF pronto — ${participant.full_name}`;
                } else if (log.action === "participant_completed" && participant) {
                  label = `${participant.full_name} concluiu o quiz`;
                } else if (log.action === "batch_process_completed") {
                  label = `Processamento concluído`;
                }

                return (
                  <div key={i} className="flex gap-3 text-xs">
                    <span className="text-muted-foreground font-mono shrink-0 pt-0.5">{time}</span>
                    <span className="text-foreground/80">{label}</span>
                  </div>
                );
              })}
              {logs.length === 0 && (
                <p className="text-xs text-muted-foreground">Nenhuma atividade ainda.</p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
