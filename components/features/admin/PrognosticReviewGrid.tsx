"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Prognostic, PrognosticContent } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EditPrognosticDialog } from "./EditPrognosticDialog";
import { idDaRazao, situacaoDaEntrega } from "./entrega-do-documento";

interface Participant {
  id: string;
  full_name: string;
  email: string;
  completed_at: string | null;
}

interface Props {
  eventId: string;
  participants: Participant[];
  prognostics: Prognostic[];
}

const TRAIL_COLORS: Record<string, string> = {
  "Exploração": "bg-chart-3/20 text-chart-3 border-chart-3/30",
  "Direção": "bg-chart-1/20 text-chart-1 border-chart-1/30",
  "Aproximação": "bg-chart-2/20 text-chart-2 border-chart-2/30",
  "Aceleração": "bg-chart-4/20 text-chart-4 border-chart-4/30",
  "Sessão Privada": "bg-primary/20 text-primary border-primary/30",
};

export function PrognosticReviewGrid({ eventId, participants, prognostics }: Props) {
  const [localPrognostics, setLocalPrognostics] = useState<Prognostic[]>(prognostics);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Realtime: sincroniza localPrognostics quando IA gera ou outro admin entrega.
  useEffect(() => {
    const supabase = createClient();
    const participantIds = new Set(participants.map((p) => p.id));

    const channel = supabase
      .channel(`prognostics-review-${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "prognostics",
        },
        (payload) => {
          const newRow = payload.new as Prognostic | undefined;
          const oldRow = payload.old as { id?: string; participant_id?: string } | undefined;

          if (
            payload.eventType === "INSERT" &&
            newRow?.participant_id &&
            participantIds.has(newRow.participant_id)
          ) {
            setLocalPrognostics((prev) => {
              if (prev.some((p) => p.id === newRow.id)) return prev;
              return [...prev, newRow];
            });
            return;
          }

          if (
            payload.eventType === "UPDATE" &&
            newRow?.participant_id &&
            participantIds.has(newRow.participant_id)
          ) {
            setLocalPrognostics((prev) =>
              prev.map((p) => (p.id === newRow.id ? newRow : p))
            );
            return;
          }

          if (payload.eventType === "DELETE" && oldRow?.id) {
            setLocalPrognostics((prev) => prev.filter((p) => p.id !== oldRow.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, participants]);

  async function deliver(prognosticId: string) {
    setSaving(true);
    try {
      const supabase = createClient();
      const prog = localPrognostics.find((p) => p.id === prognosticId);
      if (!prog) return;

      const final = prog.edited_content ?? prog.raw_ai_output;

      type MutResult = { data: unknown; error: { message: string } | null };
      const { error } = await ((supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }).update({
        final_content: final,
        status: "delivered",
        delivered_at: new Date().toISOString(),
      }).eq("id", prognosticId));

      if (error) throw error;

      setLocalPrognostics((prev) =>
        prev.map((p) =>
          p.id === prognosticId
            ? { ...p, final_content: final as PrognosticContent, status: "delivered" }
            : p
        )
      );

      // Editing a prognostic nulls pdf_url, so after an edited delivery there is
      // no PDF and nothing was generating one — the participant's page just sat
      // polling for 120s. Kick the render off here (the realtime subscription
      // picks up pdf_url when it lands).
      if (!prog.pdf_url) {
        fetch("/api/generate-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prognostic_id: prognosticId }),
        }).catch(() => {
          // Non-fatal: the participant still has the on-demand PDF button.
        });
      }

      const shareUrl = `${window.location.origin}/prognostic/${prog.public_share_token}`;
      await navigator.clipboard.writeText(shareUrl).catch(() => {});
      toast.success("Entregue! Link copiado para a área de transferência.");
    } catch (err) {
      // A entrega passa pelo portão do banco (migration 025): `delivered` exige
      // `final_content` com a MESMA impressão digital que a última revisão
      // humana aprovou. A recusa chega aqui como `check_violation` (23514), e
      // "Erro ao entregar" mandaria o host investigar a coisa errada -- ele
      // tentaria de novo, e seria recusado de novo, pelo mesmo motivo. A
      // mensagem abaixo é a mesma frase de PROGNOSTIC_APPROVAL_STALE em
      // lib/erros/mensagens-host.ts; esta tela escreve direto no banco (não há
      // rota no caminho), então o texto é escolhido aqui pelo código do banco.
      const codigo = (err as { code?: string } | null)?.code;
      toast.error(
        codigo === "23514"
          ? "Entrega recusada: o texto deste documento não é o que foi revisado e aprovado. Abra o documento, revise o texto como ele está agora e salve a revisão; depois disso a entrega é liberada."
          : "Erro ao entregar"
      );
    } finally {
      setSaving(false);
    }
  }

  const editingProg = editingId
    ? localPrognostics.find((p) => p.id === editingId) ?? null
    : null;
  const editingParticipantName = editingProg
    ? participants.find((pt) => pt.id === editingProg.participant_id)?.full_name ?? ""
    : "";

  return (
    <>
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {participants.map((participant) => {
        const prog = localPrognostics.find((p) => p.participant_id === participant.id);
        const content = (prog?.edited_content ?? prog?.raw_ai_output) as
          | PrognosticContent
          | undefined;
        const trail = content?.trilha_recomendada;
        const previewText = content?.analise_geral?.split(/\n\n+/)[0] ?? "";
        // A razão de "Entregar" estar desligado é calculada POR DOCUMENTO: o
        // texto nasce no cartão de quem está bloqueado e desaparece sozinho
        // quando aquele documento ganha revisão salva. Um aviso só no topo da
        // tela seria igual em todos os cartões e não diria QUAL documento.
        const entrega = prog ? situacaoDaEntrega(prog) : null;

        return (
          <div
            key={participant.id}
            className="rounded-lg border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">{participant.full_name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{participant.email}</p>
              </div>
              {prog && (
                <Badge
                  className={`text-xs shrink-0 border ${
                    prog.status === "delivered"
                      ? "bg-success/20 text-success border-success/30"
                      : prog.status === "reviewed"
                      ? "bg-primary/20 text-primary border-primary/30"
                      : "bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {prog.status === "delivered"
                    ? "Entregue"
                    : prog.status === "reviewed"
                    ? "Revisado"
                    : "Gerado"}
                </Badge>
              )}
            </div>

            {trail && (
              <div
                className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs border ${
                  TRAIL_COLORS[trail] ?? ""
                }`}
              >
                {trail}
              </div>
            )}

            {previewText && (
              <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                {previewText}
              </p>
            )}

            {!prog && participant.completed_at && (
              <div className="flex items-center gap-2 text-foreground">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="animate-spin shrink-0"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <p className="text-xs">Gerando prognóstico...</p>
              </div>
            )}
            {!prog && !participant.completed_at && (
              <p className="text-xs text-muted-foreground italic">Aguardando participante</p>
            )}

            {/* A RAZÃO FICA NO CONTEÚDO DA TELA, não no `title` do botão.
                `title` só aparece no hover do mouse: em tela de toque não
                existe hover, e para leitor de tela um botão desabilitado nem
                entra na ordem de foco, então a descrição nunca é anunciada.
                Aqui o texto é lido por quem olha, por quem toca e por quem
                ouve a página, sem gesto nenhum. */}
            {prog && prog.status !== "delivered" && entrega && !entrega.liberada && (
              <p
                id={idDaRazao(prog.id)}
                data-testid={idDaRazao(prog.id)}
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground/80"
              >
                {entrega.texto}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              {prog && prog.status !== "delivered" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingId(prog.id)}
                  disabled={saving}
                  className="text-xs border-border text-muted-foreground hover:text-foreground"
                >
                  Editar
                </Button>
              )}
              {prog && prog.status !== "delivered" && entrega && (
                // O botão fica DESLIGADO enquanto não há aprovação registrada
                // (migration 025): o banco recusaria a entrega de qualquer
                // maneira, e um botão que só pode falhar é pior do que um botão
                // que diz por que está desligado. A garantia é do banco; isto
                // aqui é só não oferecer o caminho sem saída. O selo em si é
                // escrito pelo gatilho quando a revisão é salva -- esta tela
                // não o calcula e não o escreve.
                //
                // `aria-describedby` amarra o botão ao parágrafo acima para quem
                // navega com leitor de tela e chega ao botão por outro caminho
                // (modo de leitura, lista de elementos). Não SUBSTITUI o texto
                // visível: ele é o que resolve para o operador de celular.
                <Button
                  size="sm"
                  onClick={() => deliver(prog.id)}
                  disabled={saving || !entrega.liberada}
                  aria-describedby={entrega.liberada ? undefined : idDaRazao(prog.id)}
                  className="flex-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Entregar
                </Button>
              )}
              {prog?.status === "delivered" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const url = `${window.location.origin}/prognostic/${prog.public_share_token}`;
                    navigator.clipboard.writeText(url).catch(() => {});
                    toast.success("Link copiado");
                  }}
                  className="flex-1 text-xs border-border text-muted-foreground hover:text-foreground"
                >
                  Copiar link
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>

    {editingProg && (
      <EditPrognosticDialog
        prognosticId={editingProg.id}
        participantName={editingParticipantName}
        initialContent={
          (editingProg.edited_content ?? editingProg.raw_ai_output) as PrognosticContent
        }
        initialYuriNote={editingProg.yuri_note}
        onClose={() => setEditingId(null)}
        onSaved={() => {
          // Realtime subscription propaga, mas atualiza localmente também
          // pra UX imediata caso a subscription demore.
          setLocalPrognostics((prev) =>
            prev.map((p) => (p.id === editingProg.id ? { ...p, status: "reviewed", pdf_url: null } : p))
          );
        }}
      />
    )}
    </>
  );
}
