import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import type { PrognosticContent, Prognostic, Event } from "@/types/database";
import { PrognosticView } from "@/components/features/prognostic/PrognosticView";

interface Props {
  params: Promise<{ token: string }>;
}

// Public share route — participant accesses via unguessable token, no session.
// Uses service_role to bypass RLS; safe because access requires the UUID token
// and every query is filtered by public_share_token + status="delivered".
export default async function PrognosticPage({ params }: Props) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: prognostic } = await supabase
    .from("prognostics")
    .select("*, participants(full_name, event_id)")
    .eq("public_share_token", token)
    .eq("status", "delivered")
    .single() as { data: (Prognostic & { participants: { full_name: string; event_id: string } | null }) | null; error: unknown };

  if (!prognostic) notFound();

  const participant = prognostic.participants as { full_name: string; event_id: string } | null;

  const { data: event } = await supabase
    .from("events")
    .select("name, event_date, host_name")
    .eq("id", participant?.event_id ?? "")
    .single() as { data: Pick<Event, "name" | "event_date" | "host_name"> | null; error: unknown };

  const content = (prognostic.final_content ?? prognostic.raw_ai_output) as PrognosticContent;

  return (
    <PrognosticView
      participantName={participant?.full_name ?? ""}
      eventName={event?.name ?? "Fort Inside"}
      eventDate={event?.event_date ?? ""}
      hostName={event?.host_name ?? "Yuri Fortes"}
      content={content}
      yuriNote={prognostic.yuri_note ?? null}
      prognosticId={prognostic.id}
      token={token}
      pdfUrl={prognostic.pdf_url ?? null}
    />
  );
}
