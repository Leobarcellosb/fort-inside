import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import type { PrognosticContent, Prognostic, Event } from "@/types/database";
import { PrognosticView } from "@/components/features/prognostic/PrognosticView";
import { DocumentoSuspensoView } from "@/components/features/prognostic/DocumentoSuspensoView";

interface Props {
  params: Promise<{ token: string }>;
}

// Public share route — participant accesses via unguessable token, no session.
// Uses service_role to bypass RLS; safe because access requires the UUID token
// and every query is filtered by public_share_token + um dos DOIS estados em que
// este link tem resposta.
//
// POR QUE A CONSULTA ACEITA `suspended` (migration 027)
// -----------------------------------------------------
// Antes ela filtrava só `delivered`, e um documento tirado do ar caía em
// `notFound()`: o jovem clicava num link que FUNCIONAVA e recebia uma página de
// erro cru, sem uma palavra. Ele não fez nada errado, e o que aconteceu não é
// culpa dele nem segredo -- então o estado suspenso é CONSULTADO e respondido
// com um aviso escrito para ele (`DocumentoSuspensoView`).
//
// O que NÃO mudou: nenhum outro estado passa a aparecer. `generated`,
// `in_review` e `reviewed` continuam caindo em `notFound()`, porque documento
// não entregue nunca foi para ser lido. E no ramo suspenso o CONTEÚDO não é
// passado para a tela -- ele não chega ao navegador dele nem escondido no HTML,
// que é a metade "não deixar o jovem exposto ao conteúdo incorreto" do princípio
// da 027.
const ESTADOS_COM_RESPOSTA_NESTE_LINK = ["delivered", "suspended"] as const;

export default async function PrognosticPage({ params }: Props) {
  const { token } = await params;
  const supabase = createAdminClient();

  const { data: prognostic } = await supabase
    .from("prognostics")
    .select("*, participants(full_name, event_id)")
    .eq("public_share_token", token)
    .in("status", ESTADOS_COM_RESPOSTA_NESTE_LINK as unknown as string[])
    .single() as { data: (Prognostic & { participants: { full_name: string; event_id: string } | null }) | null; error: unknown };

  if (!prognostic) notFound();

  const participant = prognostic.participants as { full_name: string; event_id: string } | null;

  // FORA DO AR. Nada de conteúdo, nada de PDF, nada do motivo interno que o
  // operador escreveu (ele é registro de operador, não informação do jovem).
  if (prognostic.status === "suspended") {
    return <DocumentoSuspensoView participantName={participant?.full_name ?? ""} />;
  }

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
      token={token}
      pdfUrl={prognostic.pdf_url ?? null}
    />
  );
}
