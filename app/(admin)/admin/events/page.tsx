import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteEventDialog } from "@/components/features/admin/DeleteEventDialog";
import type { Event } from "@/types/database";

const STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho",
  live: "Ao vivo",
  processing: "Processando",
  completed: "Concluído",
};

const STATUS_STYLE: Record<string, string> = {
  draft: "border-border text-muted-foreground",
  live: "border-success/40 text-success bg-success/10",
  processing: "border-primary/40 text-primary bg-primary/10",
  completed: "border-border text-muted-foreground bg-muted",
};

export default async function EventsPage() {
  const supabase = await createClient();

  const { data: events } = await supabase
    .from("events")
    .select("id, name, event_code, event_date, status, max_participants")
    .order("event_date", { ascending: false }) as { data: Pick<Event, "id" | "name" | "event_code" | "event_date" | "status" | "max_participants">[] | null; error: unknown };

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Admin</p>
            <h1 className="font-display text-2xl text-foreground mt-1">Eventos</h1>
          </div>
          <div className="flex gap-2">
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
            <div key={event.id} className="flex items-center justify-between px-5 py-4 rounded-lg border border-border bg-card">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-foreground">{event.name}</p>
                  <Badge className={`text-xs border ${STATUS_STYLE[event.status] ?? ""}`}>
                    {STATUS_LABEL[event.status] ?? event.status}
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
                {event.status === "live" || event.status === "draft" ? (
                  <Button asChild size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 text-xs">
                    <Link href={`/admin/events/${event.id}`}>Painel</Link>
                  </Button>
                ) : event.status === "completed" ? (
                  <>
                    <Button asChild size="sm" variant="outline" className="border-border text-muted-foreground hover:text-foreground text-xs">
                      <Link href={`/admin/events/${event.id}/review`}>Prognósticos</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline" className="border-border text-muted-foreground hover:text-foreground text-xs">
                      <Link href={`/admin/events/${event.id}/dashboard`}>Dashboard</Link>
                    </Button>
                  </>
                ) : (
                  <Button asChild size="sm" variant="outline" className="border-border text-muted-foreground text-xs">
                    <Link href={`/admin/events/${event.id}`}>Ver</Link>
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
