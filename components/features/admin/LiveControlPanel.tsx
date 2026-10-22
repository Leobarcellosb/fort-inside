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
import { GuiaDoFacilitadorCard } from "@/components/features/marco-zero/GuiaDoFacilitadorCard";
import { CadernoDeConducaoCard } from "@/components/features/marco-zero/CadernoDeConducaoCard";
import { TesteDaIACard } from "@/components/features/admin/TesteDaIACard";
import type { EstadoDaFila } from "@/components/features/admin/SituacaoPrognosticos";
import {
  MENSAGEM_FILA_INDISPONIVEL,
  solicitarProcessamento,
  textoDoEnfileiramento,
} from "@/components/features/admin/processar-evento";
import type { BatchSummary } from "@/components/features/admin/classificar-lote";
import {
  rotuloDoEventoConcluido,
  type ResumoDosDocumentos,
} from "@/components/features/admin/situacao-prognostico";
import {
  ROTULO_CONTAGEM_DESCONHECIDA,
  ROTULO_SITUACAO_DESCONHECIDA,
  coletaDeEtapasConcluida,
  contagemNaEtapaAtual,
  leituraDoPainel,
  pendentesDaEtapaAtual,
  proximaEtapa,
  situacaoDaPessoa,
  textoDeEtapaLiberada,
  textoDeRespostaRecebida,
  trilhaDaPessoa,
} from "@/components/features/admin/etapas-do-painel";
import {
  classificarRecusaDeLiberacao,
  type ErroDeGravacao,
} from "@/components/features/admin/liberar-etapa";

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

// ---------------------------------------------------------------------------
// ISOLAMENTO ESTRUTURAL DO PAINEL AO VIVO
// ---------------------------------------------------------------------------
// Este painel nasceu para o Fort Inside (questionario v1), onde o ID da linha de
// `quiz_stages` e o ORDINAL da etapa sao o mesmo numero (1..6). Ele comparava as
// duas grandezas sem perceber que sao diferentes, e tinha etapas escritas a mao:
// `[1,2,3,4,5,6].map(...)`, `currentStage + 1`, e um vetor fixo com os nomes dos
// ambientes da casa ("Portao, Entrada, Sala Principal, Cozinha, Varanda,
// Suite") -- nomes que o dono pediu NOMINALMENTE que saissem da versao do Marco
// Zero e que esta tela continuava exibindo em qualquer evento.
//
// Num evento do Marco Zero (v2: ids 101..105, ordinais 1..5) o resultado era uma
// tela que mentia: oferecia "LIBERAR ETAPA 6" num evento de cinco etapas e
// mostrava "0/4 na etapa 5" num evento onde todo mundo tinha respondido tudo --
// porque `r.stage_id === currentStage` nunca batia.
//
// DECISAO DA REVISAO, literal: "Painel ao vivo: nao sera utilizado no Marco
// Zero. Porem, deve ser ISOLADO ESTRUTURALMENTE para impedir acoes incompativeis
// e numeros falsos."
//
// Entao o painel NAO foi reescrito para funcionar na v2 (nao e esta unidade). Ele
// passou a PERGUNTAR, antes de desenhar, se sabe ler as etapas deste evento --
// `leituraDoPainel`, em etapas-do-painel.ts. Quando nao sabe:
//   - nao oferece liberar etapa (operacao que talvez nao exista);
//   - nao exibe contagem por etapa, trilha de etapas nem "Respondendo";
//   - DIZ, em texto visivel, que esta tela nao le este evento -- porque numero
//     que a tela nao sabe calcular NAO E ZERO. Zero afirmaria que ninguem
//     respondeu; o fato verdadeiro e sobre a tela, nao sobre as pessoas.
// O que continua sendo exibido e so o que nao depende de etapa: nome do evento,
// participantes, `completed_at`, a secao Prognosticos e a timeline.
//
// Os nomes dos ambientes agora vem de `quiz_stages.ambient_name`, do banco. Nao
// ha mais copia de nome de casa nenhuma neste arquivo.

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
  const [resumoDosDocumentos, setResumoDosDocumentos] = useState<ResumoDosDocumentos | null>(null);

  const getParticipantResponses = useCallback(
    (participantId: string) =>
      responses.filter((r) => r.participant_id === participantId).map((r) => r.stage_id),
    [responses]
  );

  // A pergunta que vem antes de qualquer numero por etapa: esta tela sabe ler as
  // etapas DESTE evento? Deriva das etapas recebidas, nao de `quiz_version`.
  const leitura = useMemo(() => leituraDoPainel(stages), [stages]);
  // Os handlers de realtime são registrados uma vez; um ref os mantém lendo a
  // leitura atual em vez de fechar sobre a do primeiro render.
  const leituraRef = useRef(leitura);
  useEffect(() => {
    leituraRef.current = leitura;
  }, [leitura]);

  const contagem = contagemNaEtapaAtual({
    leitura,
    etapaAtual: currentStage,
    participantes: participants,
    respostas: responses,
  });

  const pendingParticipants = pendentesDaEtapaAtual({
    leitura,
    etapaAtual: currentStage,
    participantes: participants,
    respostas: responses,
  });

  const proxima = proximaEtapa(leitura, currentStage);
  const isForcedRelease = pendingParticipants.length > 0;

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
      // `r.stage_id` é um ID de linha, não um número de etapa: num evento da v2
      // isto dizia "completou etapa 103", número que nenhum participante vê em
      // tela nenhuma. Sem leitura das etapas, o aviso não cita número.
      if (p) toast.success(textoDeRespostaRecebida(leituraRef.current, p.full_name, r.stage_id));
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
    // SEGUNDA TRAVA, de propósito. O botão já não é renderizado quando não há
    // próxima etapa, mas a próxima etapa não pode ser `currentStage + 1`
    // calculado aqui: era isso que escrevia `current_stage: 6` num evento de
    // cinco etapas. Se esta função for alcançada por qualquer outro caminho, ela
    // recusa em vez de gravar uma etapa inexistente no banco.
    if (!proxima.oferecer) {
      toast.error(proxima.texto);
      return;
    }
    const next = proxima.numero;
    setReleasing(true);
    try {
      const supabase = createClient();
      // `error` carrega os quatro campos do PostgREST, e não só `message`: é em
      // `details` que vem o NOME DO FATO com que o gatilho da migration 028
      // recusa, e era por ler só `message` que esta tela não tinha como saber
      // qual recusa aconteceu.
      type MutResult = { data: unknown; error: ErroDeGravacao | null };
      const { error } = await ((supabase.from("events") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }).update({ current_stage: next, status: "live" }).eq("id", event.id));

      if (error) {
        // A TRAVA ESTRUTURAL RESPONDEU. A tela parou de oferecer a operação na
        // unidade anterior; a migration 028 fez o banco parar de aceitá-la, e
        // aqui a recusa é NOMEADA para o host -- "não se aplica a este evento"
        // nunca sai como "Erro ao liberar etapa".
        const recusa = classificarRecusaDeLiberacao(error, {
          etapaPedida: next,
          totalEtapas: leitura.suportado ? leitura.total : null,
          modo: event.mode,
        });
        // O texto cru do banco fica AQUI, no console, sob o número da ocorrência
        // que o host cita. Ele não vai para a tela.
        console.error("[painel] liberação de etapa recusada", {
          ocorrencia: recusa.ocorrencia,
          codigo: recusa.codigo,
          evento: event.id,
          etapa_pedida: next,
          erro: error,
        });
        toast.error(recusa.mensagem, { duration: 15000 });
        return;
      }

      const releasePayload: Record<string, unknown> = { stage_id: next };
      if (isForcedRelease) {
        releasePayload.forced = true;
        releasePayload.pending = pendingParticipants.length;
      }

      await ((supabase.from("event_logs") as unknown as {
        insert(v: Record<string, unknown>): Promise<unknown>;
      }).insert({ event_id: event.id, action: "stage_released", payload: releasePayload }));

      setCurrentStage(next);
      // O nome vem da LINHA da etapa, no banco. Antes vinha de um vetor fixo com
      // os ambientes da casa do Fort Inside, indexado pelo número da etapa.
      const nome = proxima.etapa.ambiente || proxima.etapa.titulo;
      toast.success(nome ? `Etapa ${next} liberada — ${nome}` : `Etapa ${next} liberada`);
    } catch (causa) {
      // O que sobra aqui é o que o cliente lançou em vez de devolver em `error`:
      // rede caída, sessão perdida, resposta ilegível. NÃO se afirma recusa --
      // não se sabe se a gravação passou --, e por isso não se diz "não foi
      // liberada". A mensagem manda recarregar para ver a etapa atual. Antes
      // este bloco dizia "Erro ao liberar etapa" para TUDO, inclusive para as
      // recusas verificadas, que agora têm texto próprio acima.
      const recusa = classificarRecusaDeLiberacao(null, {
        etapaPedida: next,
        totalEtapas: leitura.suportado ? leitura.total : null,
        modo: event.mode,
      });
      console.error("[painel] liberação de etapa não concluída", {
        ocorrencia: recusa.ocorrencia,
        codigo: recusa.codigo,
        evento: event.id,
        etapa_pedida: next,
        causa,
      });
      toast.error(recusa.mensagem, { duration: 15000 });
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
  // `currentStage === 6` era a etapa final escrita a mão. Agora vem da contagem
  // de etapas da versão do evento; num evento que esta tela não lê, a seção
  // aparece pelo outro critério (alguém concluiu o quiz), que não usa etapa.
  const mostrarPrognosticos =
    coletaDeEtapasConcluida(leitura, currentStage) ||
    participants.some((p) => p.completed_at !== null);

  const pendingNames = pendingParticipants.map((p) => p.full_name).join(", ");

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      {/* Header */}
      <div className="mb-8 space-y-1">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Painel ao vivo</p>
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-2xl text-foreground">{event.name}</h1>
          <EventQRDialog event={{ event_code: event.event_code, mode: event.mode }} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={eventStatus === "live" ? "default" : "secondary"} className="text-xs">
            {eventStatus === "live"
              ? "🔴 Ao vivo"
              : eventStatus === "processing"
                ? "⚙️ Processando"
                : eventStatus === "completed"
                  ? rotuloDoEventoConcluido(resumoDosDocumentos)
                  : eventStatus}
          </Badge>
          <span className="text-muted-foreground text-sm">
            {participants.length} participante{participants.length !== 1 ? "s" : ""}
          </span>
          {/* A entrada da tela de importacao externa. Sem este link a pagina
              existiria e ninguem a alcancaria. */}
          <button
            type="button"
            onClick={() => router.push(`/admin/events/${event.id}/importacao`)}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Importar respostas coletadas fora do app
          </button>
        </div>
      </div>

      {/* O acesso do host ao Guia de Preparacao do Facilitador. Fica aqui, e
          nao atras de um estado do evento, porque o guia e material de
          PREPARACAO: quem conduz precisa dele antes do dia, e o proprio gerador
          recusa o guia quando o evento tem DNA Coletivo disponibilizado. */}
      <div className="mb-8">
        <GuiaDoFacilitadorCard eventId={event.id} />
      </div>

      {/* O CADERNO DE CONDUCAO vem ANTES do Guia na ordem de necessidade e
          depois dele aqui por um motivo so: o Guia ja estava montado neste
          ponto. Ele e o terceiro artefato e nao recebe `eventId` -- nao e por
          evento, nao le banco e nao depende de resposta alguma. E o unico dos
          tres que esta sempre disponivel, inclusive se nenhum participante
          responder o questionario antes do dia. */}
      <div className="mb-8">
        <CadernoDeConducaoCard />
      </div>

      {/* TESTE DA IA, logo antes da secao que processa: e o passo que o CTO
          exigiu antes de colocar os documentos na fila (Rodada 71). */}
      {mostrarPrognosticos && (
        <div className="mb-8">
          <TesteDaIACard />
        </div>
      )}

      {mostrarPrognosticos && (
        <div className="mb-8">
          <SituacaoPrognosticos
            eventId={event.id}
            eventStatus={eventStatus}
            pessoas={pessoasDoPrognostico}
            sinalDeLeitura={sinalDeLeitura}
            aoMudarFila={setFila}
            aoIrParaRevisao={() => router.push(`/admin/events/${event.id}/review`)}
            aoResumir={setResumoDosDocumentos}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Column 1 — Stage Control */}
        <div className="space-y-4">
          <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Controle de etapas</h2>

          {/* SEM LEITURA: a tela diz que não sabe, em vez de desenhar seis
              etapas que não são as do evento. O texto é conteúdo da página --
              não depende de hover, de toque longo nem de gesto nenhum. */}
          {!leitura.suportado && (
            <div
              role="status"
              data-testid="painel-sem-leitura-de-etapas"
              className="space-y-2 rounded-md border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-foreground/80"
            >
              <p className="text-sm font-medium text-foreground">
                Esta tela não sabe ler as etapas deste evento
              </p>
              <p>{leitura.texto}</p>
              <p className="text-muted-foreground">
                Identificadores de etapa recebidos:{" "}
                {leitura.idsEncontrados.length > 0 ? leitura.idsEncontrados.join(", ") : "nenhum"}.
              </p>
            </div>
          )}

          {/* Stage progress — as etapas e os nomes vêm do banco. */}
          {leitura.suportado && (
            <div className="space-y-2">
              {leitura.etapas.map((etapa) => (
                <div
                  key={etapa.numero}
                  className={`flex items-center gap-3 px-4 py-3 rounded-md border transition-colors
                  ${etapa.numero === currentStage
                      ? "border-primary bg-primary/10"
                      : etapa.numero < currentStage
                      ? "border-border bg-card opacity-60"
                      : "border-border/50 opacity-30"
                    }`}
                >
                  <span className={`text-xs font-mono w-4 ${etapa.numero <= currentStage ? "text-primary" : "text-muted-foreground"}`}>
                    {etapa.numero <= currentStage ? "✓" : etapa.numero}
                  </span>
                  <div>
                    <p className="text-sm text-foreground leading-none">{etapa.titulo}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{etapa.ambiente}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Release button. NÃO aparece quando não há uma próxima etapa real:
              "Liberar etapa 6" num evento de cinco etapas oferecia uma operação
              que não existe. No lugar, a tela diz por que não se aplica. */}
          {!proxima.oferecer && !leitura.suportado && (
            <p
              data-testid="liberar-nao-se-aplica"
              className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-foreground/80"
            >
              {proxima.texto}
            </p>
          )}
          {proxima.oferecer && (
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
                {releasing ? "Liberando..." : `Liberar etapa ${proxima.numero}`}
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-display text-foreground">
                    Liberar etapa {proxima.numero}?
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
                    {/* Título e ambiente da PRÓXIMA etapa, lidos da linha dela
                        no banco (`proxima.etapa`), não de um vetor fixo. */}
                    <strong className="text-foreground">{proxima.etapa.titulo}</strong>
                    {proxima.etapa.ambiente ? ` — ${proxima.etapa.ambiente}` : ""}
                    <br />
                    Os participantes serão redirecionados automaticamente.
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
          {/* `currentStage === 6` era a etapa final escrita a mão. O critério
              agora é a contagem de etapas da versão do evento; num evento que
              esta tela não lê, ela não oferece o processamento -- não porque o
              evento não possa ser processado, mas porque esta tela não sabe
              dizer que ele terminou. O caminho que funciona é a seção
              Prognósticos acima, que não depende de etapa. */}
          {/* QUANDO ESTA TELA NAO LE AS ETAPAS (o questionario v2, ids 101..105,
              que e o do Marco Zero), o botao aparece mesmo assim: sem ele nao
              havia caminho nenhum para gerar os documentos de um evento
              assincrono -- a secao Prognosticos acompanha a fila, mas nao a
              inicia. Quem decide se pode e o SERVIDOR (/api/jobs/enfileirar):
              no assincrono ele recusa enquanto a coleta nao fechou
              (COLLECTION_OPEN), e a recusa chega aqui com o texto do
              vocabulario. A tela so oferece; a garantia continua do servidor. */}
          {(coletaDeEtapasConcluida(leitura, currentStage) || !leitura.suportado) &&
            eventStatus !== "processing" &&
            eventStatus !== "completed" && (
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
            {/* "0/4 na etapa 5" era um número FALSO: o painel comparava o
                ordinal da etapa com o id da linha, a comparação nunca batia, e
                a tela afirmava que ninguém respondeu num evento onde todos
                responderam. Número que esta tela não sabe calcular não é zero --
                ela não exibe contagem nenhuma e diz que não sabe. */}
            {contagem.estado === "conhecida" && (
              <span className="text-xs text-muted-foreground">
                {contagem.feitos}/{contagem.total} na etapa {contagem.etapa}
              </span>
            )}
            {contagem.estado === "nao_sei" && (
              <span data-testid="contagem-desconhecida" className="text-xs text-muted-foreground">
                {ROTULO_CONTAGEM_DESCONHECIDA}
              </span>
            )}
          </div>

          {contagem.estado === "nao_sei" && (
            <p
              data-testid="contagem-desconhecida-explicacao"
              className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground/80"
            >
              {contagem.texto}
            </p>
          )}

          <div className="space-y-2">
            {participants.map((p) => {
              const stagesAnswered = getParticipantResponses(p.id);
              const trilha = trilhaDaPessoa({ leitura, respondidas: stagesAnswered });
              const situacao = situacaoDaPessoa({
                leitura,
                etapaAtual: currentStage,
                concluiuQuiz: p.completed_at !== null,
                respondidas: stagesAnswered,
              });

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
                    {/* As barrinhas eram `[1..6]` comparadas com `stage_id`:
                        num evento da v2 ficavam TODAS apagadas, desenhando
                        "não respondeu nada" para quem respondeu tudo. Sem
                        leitura das etapas, não se desenha trilha. */}
                    {trilha.estado === "conhecida" && (
                      <div className="flex gap-1 mt-1">
                        {trilha.marcas.map((m) => (
                          <div
                            key={m.numero}
                            className={`w-4 h-1 rounded-full ${m.respondida ? "bg-primary" : "bg-border"}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {/* "Completo" vem de `participants.completed_at`: é fato do
                        banco e não depende de etapa, então continua. O resto
                        dependia da comparação quebrada -- "Respondendo"
                        (pulsando) aparecia para TODOS num evento da v2,
                        inclusive para quem já tinha enviado tudo. */}
                    {situacao.tipo === "completo" ? (
                      <span className="text-xs text-success">✓ Completo</span>
                    ) : situacao.tipo === "na_etapa_atual" ? (
                      <span className="text-xs text-primary">✓ Etapa {situacao.etapa}</span>
                    ) : situacao.tipo === "respondendo" ? (
                      <span className="text-xs text-muted-foreground animate-pulse">Respondendo</span>
                    ) : situacao.tipo === "nao_sei" ? (
                      <span className="text-xs text-muted-foreground italic">{ROTULO_SITUACAO_DESCONHECIDA}</span>
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
                  // O `stage_id` do registro é um ID de linha; num evento da v2
                  // isto escrevia "completou etapa 103" na timeline.
                  const sid = (log.payload as { stage_id?: number })?.stage_id;
                  label =
                    sid === undefined
                      ? `${participant.full_name} enviou uma resposta`
                      : textoDeRespostaRecebida(leitura, participant.full_name, sid);
                } else if (log.action === "stage_released") {
                  label = textoDeEtapaLiberada(leitura, (log.payload as { stage_id?: number })?.stage_id);
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
