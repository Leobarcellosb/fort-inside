"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Prognostic, PrognosticContent } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface Participant {
  id: string;
  full_name: string;
  email: string;
}

interface Props {
  eventId: string;
  participants: Participant[];
  prognostics: Prognostic[];
}

const FIELD_LABELS: Record<keyof PrognosticContent, string> = {
  momento_atual: "Momento atual",
  forca_central: "Força central",
  gargalo_sensivel: "Gargalo sensível",
  risco_permanecer: "Risco de permanecer",
  construir_agora: "Construir agora",
  proximo_passo: "Próximo passo",
  trilha_recomendada: "Trilha recomendada",
  justificativa_trilha: "Justificativa da trilha",
};

const TRAIL_COLORS: Record<string, string> = {
  "Exploração": "bg-chart-3/20 text-chart-3 border-chart-3/30",
  "Direção": "bg-chart-1/20 text-chart-1 border-chart-1/30",
  "Aproximação": "bg-chart-2/20 text-chart-2 border-chart-2/30",
  "Aceleração": "bg-chart-4/20 text-chart-4 border-chart-4/30",
  "Sessão Privada": "bg-primary/20 text-primary border-primary/30",
};

export function PrognosticReviewGrid({ eventId, participants, prognostics }: Props) {
  const [localPrognostics, setLocalPrognostics] = useState<Prognostic[]>(prognostics);
  const [selected, setSelected] = useState<string | null>(null);
  const [editData, setEditData] = useState<PrognosticContent | null>(null);
  const [yuriNote, setYuriNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Realtime: sincroniza localPrognostics quando IA gera novo prognostic ou
  // outro admin edita/entrega. Filtra client-side por participant_id pra
  // ignorar prognosticos de outros eventos (postgres_changes não suporta
  // filtro por join com participants server-side).
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

  const selectedPrognostic = localPrognostics.find((p) => p.id === selected);
  const selectedParticipant = selectedPrognostic
    ? participants.find((p) => p.id === selectedPrognostic.participant_id)
    : null;

  function openEdit(prognostic: Prognostic) {
    const content = prognostic.edited_content ?? prognostic.raw_ai_output;
    setEditData(content as PrognosticContent);
    setYuriNote(prognostic.yuri_note ?? "");
    setSelected(prognostic.id);
  }

  function updateField(key: keyof PrognosticContent, value: string) {
    if (!editData) return;
    setEditData({ ...editData, [key]: value });
  }

  async function saveEdits() {
    if (!selected || !editData) return;
    setSaving(true);
    try {
      const supabase = createClient();
      type MutResult = { data: unknown; error: { message: string } | null };
      const { error } = await ((supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }).update({
        edited_content: editData,
        trail_recommendation: editData.trilha_recomendada,
        yuri_note: yuriNote || null,
        status: "reviewed",
        reviewed_at: new Date().toISOString(),
      }).eq("id", selected));

      if (error) throw error;

      setLocalPrognostics((prev) =>
        prev.map((p) =>
          p.id === selected
            ? { ...p, edited_content: editData, yuri_note: yuriNote || null, status: "reviewed" }
            : p
        )
      );
      toast.success("Prognóstico salvo");
      setSelected(null);
    } catch {
      toast.error("Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function deliver(prognosticId: string) {
    setSaving(true);
    try {
      const supabase = createClient();
      const prog = localPrognostics.find((p) => p.id === prognosticId);
      if (!prog) return;

      const final = prog.edited_content ?? prog.raw_ai_output;

      type MutResult2 = { data: unknown; error: { message: string } | null };
      const { error } = await ((supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult2> };
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
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {participants.map((participant) => {
          const prog = localPrognostics.find((p) => p.participant_id === participant.id);
          const content = (prog?.edited_content ?? prog?.raw_ai_output) as PrognosticContent | undefined;
          const trail = content?.trilha_recomendada;

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
                    {prog.status === "delivered" ? "Entregue" : prog.status === "reviewed" ? "Revisado" : "Gerado"}
                  </Badge>
                )}
              </div>

              {trail && (
                <div className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs border ${TRAIL_COLORS[trail] ?? ""}`}>
                  {trail}
                </div>
              )}

              {content && (
                <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                  {content.momento_atual}
                </p>
              )}

              {!prog && (
                <p className="text-xs text-muted-foreground italic">Prognóstico não gerado</p>
              )}

              <div className="flex gap-2 pt-1">
                {prog && prog.status !== "delivered" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEdit(prog)}
                      className="flex-1 text-xs border-border text-muted-foreground hover:text-foreground"
                    >
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => deliver(prog.id)}
                      disabled={saving}
                      className="flex-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      Entregar
                    </Button>
                  </>
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

      {/* Edit Sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="bg-card border-border w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="mb-6">
            <SheetTitle className="font-display text-foreground">
              {selectedParticipant?.full_name}
            </SheetTitle>
          </SheetHeader>

          {editData && (
            <div className="space-y-5">
              {(Object.keys(FIELD_LABELS) as Array<keyof PrognosticContent>).map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
                    {FIELD_LABELS[key]}
                  </Label>
                  {key === "trilha_recomendada" ? (
                    <select
                      value={editData[key]}
                      onChange={(e) => updateField(key, e.target.value)}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
                    >
                      {["Exploração", "Direção", "Aproximação", "Aceleração", "Sessão Privada"].map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  ) : (
                    <Textarea
                      value={editData[key] as string}
                      onChange={(e) => updateField(key, e.target.value)}
                      className="bg-background border-border text-foreground resize-none text-sm leading-relaxed"
                      rows={3}
                    />
                  )}
                </div>
              ))}

              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
                  Observação pessoal do Yuri
                </Label>
                <Textarea
                  value={yuriNote}
                  onChange={(e) => setYuriNote(e.target.value)}
                  placeholder="Nota manuscrita opcional..."
                  className="bg-background border-border text-foreground resize-none text-sm italic placeholder:text-muted-foreground/50"
                  rows={3}
                />
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  onClick={saveEdits}
                  disabled={saving}
                  className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving ? "Salvando..." : "Salvar edições"}
                </Button>
                {selectedPrognostic && (
                  <Button
                    onClick={() => { saveEdits().then(() => deliver(selectedPrognostic.id)); }}
                    disabled={saving}
                    variant="outline"
                    className="flex-1 border-primary text-primary hover:bg-primary/10"
                  >
                    Salvar e entregar
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
