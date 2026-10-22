"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { SituacaoPrognosticos } from "@/components/features/admin/SituacaoPrognosticos";
import type { EstadoDaFila } from "@/components/features/admin/SituacaoPrognosticos";
import {
  MENSAGEM_FILA_INDISPONIVEL,
  solicitarProcessamento,
  textoDoEnfileiramento,
} from "@/components/features/admin/processar-evento";
import type { BatchSummary } from "@/components/features/admin/classificar-lote";

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

// ---------------------------------------------------------------------------
// Processar = enfileirar
// ---------------------------------------------------------------------------
// O botão "Processar prognósticos" cria jobs duráveis em /api/jobs/enfileirar
// (ver processar-evento.ts). O processamento antigo em lote (/api/batch-process) foi
// descontinuado como mecanismo oficial: ele só devolvia contagens, vivia dentro de
// UMA requisição e não deixava registro por pessoa. Aqui NÃO há caminho de volta
// para ele: sem a fila, o botão fica bloqueado e explica o que fazer.
//
// `BatchSummary` continua importado só para ler registros HISTÓRICOS da timeline
// (action "batch_process_completed", gravados antes da troca).

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function LiveControlPanel({ event, stages, participants: initialParticipants, initialResponses, initialLogs }: Props) {
  const router = useRouter();
  const [currentStage, setCurrentStage] = useState(event.current_stage);
  const [eventStatus, setEventStatus] = useState(event.status);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [responses, setResponses] = useState<ResponseRecord[]>(initialResponses);
  const [logs, setLogs] = useState<LogRecord[]>(initialLogs);
  // Realtime handlers are registered once; a ref keeps them reading the current
  // participant list instead of closing over the initial server snapshot.
  const participantsRef = useRef<Participant[]>(initialParticipants);
  const [releasing, setReleasing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [sinalDeLeitura, setSinalDeLeitura] = useState(0);
  // A fila está utilizável? Só habilita o botão "Processar" quando a leitura da
  // fila respondeu OK. Nunca cai de volta no lote.
  const [fila, setFila] = useState<EstadoDaFila>("verificando");
  const [avisoDeEnfileiramento, setAvisoDeEnfileiramento] = useState<string | null>(null);
  // O diálogo de confirmação é controlado: AlertDialogAction não fecha sozinho, e agora a tela
  // FICA aberta depois do lote (para mostrar o resultado), então o diálogo não pode sobrar por cima.
  const [confirmProcessOpen, setConfirmProcessOpen] = useState(false);

  const getParticipantResponses = useCallback(
    (participantId: string) =>
      responses.filter((r) => r.participant_id === participantId).map((r) => r.stage_id),
    [responses]
  );

  const completedCurrentStage = participants.filter((p) =>
    responses.some((r) => r.participant_id === p.id && r.stage_id === currentStage)
  ).length;

  const pendingParticipants =
    currentStage > 0
      ? participants.filter(
          (p) => !responses.some((r) => r.participant_id === p.id && r.stage_id === currentStage)
        )
      : [];

  const isForcedRelease = currentStage > 0 && pendingParticipants.length > 0;

  const allParticipantsDone =
    participants.length > 0 && participants.every((p) => p.completed_at !== null);

  // Keep the ref in sync so realtime handlers registered once can still resolve
  // participants that joined after mount.
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  useEffect(() => {
    const supabase = createClient();
    const participantIds = new Set(participantsRef.current.map((p) => p.id));

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
      const p = participantsRef.current.find((x) => x.id === r.participant_id);
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
        { event: "INSERT", schema: "public", table: "participants", filter: `event_id=eq.${event.id}` },
        (payload) => {
          // Without this, someone who joined after the panel loaded stayed
          // invisible until a refresh — and still counted toward the
          // "everyone finished this stage" gate that unlocks the next one.
          const joined = payload.new as Participant;
          participantIds.add(joined.id);
          setParticipants((prev) =>
            prev.some((p) => p.id === joined.id) ? prev : [...prev, joined]
          );
          setLogs((prev) => [
            {
              action: "participant_joined",
              payload: null,
              created_at: new Date().toISOString(),
              participant_id: joined.id,
            },
            ...prev,
          ]);
          toast.success(`${joined.full_name} entrou na imersão`);
        }
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
            const p = participantsRef.current.find((x) => x.id === updated.id);
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
          const p = participantsRef.current.find((x) => x.id === pr.participant_id);
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
          const p = participantsRef.current.find((x) => x.id === pr.participant_id);
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
  }, [event.id]);

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

      const releasePayload: Record<string, unknown> = { stage_id: next };
      if (isForcedRelease) {
        releasePayload.forced = true;
        releasePayload.pending = pendingParticipants.length;
      }

      await ((supabase.from("event_logs") as unknown as {
        insert(v: Record<string, unknown>): Promise<unknown>;
      }).insert({ event_id: event.id, action: "stage_released", payload: releasePayload }));

      setCurrentStage(next);
      toast.success(`Etapa ${next} liberada — ${STAGE_LABELS[next]}`);
    } catch {
      toast.error("Erro ao liberar etapa");
    } finally {
      setReleasing(false);
    }
  }

  async function processPrognostics() {
    // Trava contra clique duplo na própria tela. A garantia real é do banco
    // (`on conflict do nothing`); isto só evita pedir duas vezes à toa.
    if (processing || fila !== "ok") return;
    setProcessing(true);
    setAvisoDeEnfileiramento(null);
    try {
      const r = await solicitarProcessamento(event.id);
      const texto = textoDoEnfileiramento(r);
      if (r.tipo === "enfileirado") {
        toast.success("Processamento enfileirado");
        setAvisoDeEnfileiramento(texto);
      } else if (r.tipo === "parcial") {
        toast.warning(texto);
        setAvisoDeEnfileiramento(texto);
      } else {
        if (r.tipo === "fila_indisponivel") setFila("indisponivel");
        toast.error(r.tipo === "fila_indisponivel" ? "A fila de processamento não está disponível" : texto);
        setAvisoDeEnfileiramento(texto);
      }
      // Quem acompanha o andamento é a seção "Prognósticos", lendo a fila.
      setSinalDeLeitura((n) => n + 1);
    } finally {
      setProcessing(false);
    }
  }

  const pessoasDoPrognostico = useMemo(
    () => participants.map((p) => ({ id: p.id, nome: p.full_name, quizConcluido: p.completed_at !== null })),
    [participants]
  );
  const participantesConcluidos = participants.filter((p) => p.completed_at !== null).length;
  const mostrarPrognosticos = currentStage === 6 || participants.some((p) => p.completed_at !== null);

  const nextStageInfo = stages.find((s) => s.id === currentStage + 1);
  const pendingNames = pendingParticipants.map((p) => p.full_name).join(", ");

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
            {eventStatus === "live" ? "🔴 Ao vivo" : eventStatus === "processing" ? "⚙️ Processando" : eventStatus === "completed" ? "Concluído" : eventStatus}
          </Badge>
          <span className="text-muted-foreground text-sm">
            {participants.length} participante{participants.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {mostrarPrognosticos && (
        <div className="mb-8">
          <SituacaoPrognosticos
            eventId={event.id}
            eventStatus={eventStatus}
            pessoas={pessoasDoPrognostico}
            sinalDeLeitura={sinalDeLeitura}
            aoMudarFila={setFila}
            aoIrParaRevisao={() => router.push(`/admin/events/${event.id}/review`)}
          />
        </div>
      )}

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
                    disabled={releasing}
                    className={
                      isForcedRelease
                        ? "w-full h-12 bg-muted text-muted-foreground hover:bg-muted/80 border border-border uppercase tracking-[0.08em] text-sm"
                        : "w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-sm"
                    }
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
                    {isForcedRelease && (
                      <>
                        <strong className="text-foreground">
                          {pendingParticipants.length === 1
                            ? `1 participante ainda não enviou a etapa ${currentStage}: ${pendingNames}.`
                            : `${pendingParticipants.length} participantes ainda não enviaram a etapa ${currentStage}: ${pendingNames}.`}
                        </strong>
                        {" "}Eles serão levados para a próxima etapa e a resposta pendente será perdida.
                        <br />
                      </>
                    )}
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
                    {isForcedRelease ? "Liberar mesmo assim" : "Liberar"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {/* Processar = enfileirar. Sem a fila, o botão fica bloqueado e diz o que fazer. */}
          {currentStage === 6 && eventStatus !== "processing" && eventStatus !== "completed" && (
            <div className="space-y-2">
              <AlertDialog open={confirmProcessOpen} onOpenChange={setConfirmProcessOpen}>
                <AlertDialogTrigger
                  render={
                    <Button
                      className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-sm"
                      disabled={processing || fila !== "ok"}
                    />
                  }
                >
                  {processing
                    ? "Enviando para a fila..."
                    : fila === "ok"
                      ? "Processar prognósticos"
                      : fila === "verificando"
                        ? "Verificando a fila..."
                        : "Processamento indisponível"}
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-border">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display text-foreground">
                      Colocar os prognósticos na fila?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-muted-foreground">
                      Vamos colocar na fila o prognóstico de cada pessoa que concluiu o quiz ({participantesConcluidos}).
                      Cada um leva cerca de 1 minuto e a fila trabalha poucos de cada vez, então uma turma cheia
                      leva vários minutos. O andamento de cada pessoa fica salvo e qualquer administrador vê o
                      mesmo resultado. Mantenha uma página aberta até terminar, para a fila continuar andando.
                      Clicar duas vezes não duplica nada. Quem já está em revisão, revisado ou entregue é
                      pulado, sem alterar o documento.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setConfirmProcessOpen(false);
                        void processPrognostics();
                      }}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      Colocar na fila
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {fila !== "ok" && (
                <div
                  role="status"
                  data-testid="fila-indisponivel"
                  className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground/80"
                >
                  <p>
                    {fila === "verificando"
                      ? "Verificando se a fila de processamento está disponível..."
                      : fila === "indisponivel"
                        ? MENSAGEM_FILA_INDISPONIVEL
                        : "Não foi possível verificar a fila agora (conexão ou sessão). O botão libera quando a verificação funcionar."}
                  </p>
                  {fila !== "verificando" && (
                    <Button
                      variant="outline"
                      onClick={() => setSinalDeLeitura((n) => n + 1)}
                      className="h-9 border-border text-xs uppercase tracking-[0.08em]"
                    >
                      Verificar de novo
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {avisoDeEnfileiramento && !processing && (
            <p role="status" data-testid="aviso-enfileiramento" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground/80">
              {avisoDeEnfileiramento}
            </p>
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
                } else if (log.action === "participant_joined" && participant) {
                  label = `${participant.full_name} entrou na imersão`;
                } else if (log.action === "jobs_enfileirados") {
                  const c = log.payload as { criados?: unknown; reaproveitados?: unknown } | null;
                  label =
                    c && isCount(c.criados) && isCount(c.reaproveitados)
                      ? `Processamento enfileirado: ${c.criados} ${c.criados === 1 ? "entrou" : "entraram"} na fila, ${c.reaproveitados} já ${c.reaproveitados === 1 ? "estava" : "estavam"} nela`
                      : "Processamento enfileirado";
                } else if (log.action === "batch_process_completed") {
                  const c = log.payload as Partial<BatchSummary> | null;
                  label =
                    c && isCount(c.succeeded) && isCount(c.skipped) && isCount(c.failed)
                      ? `Processamento concluído: ${c.succeeded} ${c.succeeded === 1 ? "gerado" : "gerados"}, ${c.skipped} ${c.skipped === 1 ? "pulado" : "pulados"}, ${c.failed} ${c.failed === 1 ? "falhou" : "falharam"}`
                      : `Processamento concluído`;
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
