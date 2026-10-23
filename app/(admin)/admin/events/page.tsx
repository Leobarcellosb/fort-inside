import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteEventDialog } from "@/components/features/admin/DeleteEventDialog";
import type { Event } from "@/types/database";

import { tipoDaOperacao } from "@/components/features/admin/operacao-do-evento";

// O selo do evento na lista. "Ao vivo" so vale para evento ao vivo: o Marco Zero
// e assincrono e, coletando, esta "Em andamento". Estado desconhecido nunca
// aparece cru (era "active", em ingles, na tela).
function rotuloDaLista(status: string, mode: string | null | undefined, quizVersion: number | null | undefined): string {
  if (status === "live") return tipoDaOperacao({ mode, quiz_version: quizVersion }) === "ao_vivo" ? "Ao vivo" : "Em andamento";
  const rotulos: Record<string, string> = { draft: "Rascunho", processing: "Gerando documentos", completed: "Concluído" };
  return rotulos[status] ?? "Estado não reconhecido";
}

const STATUS_STYLE: Record<string, string> = {
  draft: "border-border text-muted-foreground",
  live: "border-success/40 text-success bg-success/10",
  processing: "border-chart-4/40 text-chart-4 bg-chart-4/10",
  completed: "border-border text-muted-foreground bg-muted",
};

export default async function EventsPage() {
  const supabase = await createClient();

  const { data: events } = await supabase
    .from("events")
    .select("id, name, event_code, event_date, status, max_participants, mode, quiz_version")
    .order("event_date", { ascending: false }) as {
    data: Pick<Event, "id" | "name" | "event_code" | "event_date" | "status" | "max_participants" | "mode" | "quiz_version">[] | null;
    error: unknown;
  };

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Geração Preparada</p>
            <h1 className="font-display text-3xl font-bold text-foreground mt-1">Eventos</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className="border-border text-muted-foreground hover:text-foreground">
              <Link href="/admin/nps">Avaliações</Link>
            </Button>
            <Button asChild variant="outline" className="border-border text-muted-foreground hover:text-foreground">
              <Link href="/admin/settings">Configurações</Link>
            </Button>
            <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
              <Link href="/admin/events/new">Novo evento</Link>
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {(events ?? []).map((event) => (
            <div key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 rounded-lg border border-border bg-card">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-medium text-foreground">{event.name}</p>
                  <Badge className={`text-xs border ${STATUS_STYLE[event.status] ?? "border-border bg-transparent text-muted-foreground"}`}>
                    {rotuloDaLista(event.status, event.mode, event.quiz_version)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {event.event_code} ·{" "}
                  {new Date(event.event_date).toLocaleDateString("pt-BR", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Uma acao principal em toda linha: o painel do evento leva a
                    revisao, ao envio e aos materiais. */}
                <Button asChild size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs">
                  <Link href={`/admin/events/${event.id}`}>Abrir</Link>
                </Button>
                {event.status === "completed" && (
                  <Button asChild size="sm" variant="outline" className="border-border text-muted-foreground hover:text-foreground text-xs">
                    <Link href={`/admin/events/${event.id}/dashboard`}>Dashboard</Link>
                  </Button>
                )}
                <DeleteEventDialog
                  event={{
                    id: event.id,
                    name: event.name,
                    event_code: event.event_code,
                    status: event.status,
                  }}
                  variant="icon"
                />
              </div>
            </div>
          ))}

          {(events ?? []).length === 0 && (
            <div className="text-center py-16 space-y-3">
              <p className="text-muted-foreground text-sm">Nenhum evento criado ainda.</p>
              <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
                <Link href="/admin/events/new">Criar primeiro evento</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
