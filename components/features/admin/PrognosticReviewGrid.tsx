"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Prognostic, PrognosticContent } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

      const shareUrl = `${window.location.origin}/prognostic/${prog.public_share_token}`;
      await navigator.clipboard.writeText(shareUrl).catch(() => {});
      toast.success("Entregue! Link copiado para a área de transferência.");
    } catch {
      toast.error("Erro ao entregar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {participants.map((participant) => {
        const prog = localPrognostics.find((p) => p.participant_id === participant.id);
        const content = (prog?.edited_content ?? prog?.raw_ai_output) as
          | PrognosticContent
          | undefined;
        const trail = content?.trilha_recomendada;
        const previewText = content?.analise_geral?.split(/\n\n+/)[0] ?? "";

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

            <div className="flex gap-2 pt-1">
              {prog && prog.status !== "delivered" && (
                <Button
                  size="sm"
                  onClick={() => deliver(prog.id)}
                  disabled={saving}
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
  );
}
