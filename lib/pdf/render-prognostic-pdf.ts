import { createAdminClient } from "@/lib/supabase/admin";
import type { PrognosticContent, Prognostic, Event } from "@/types/database";

// Core PDF render + upload, callable in-process. The generate-prognostic route
// used to self-fetch /api/generate-pdf from inside after(), which forced that
// endpoint to stay unauthenticated and cost an extra function invocation.

export type PdfResult =
  | { ok: true; pdfUrl: string }
  | { ok: false; status: number; error: string };

type PrognosticWithParticipant = Prognostic & {
  participants: { full_name: string; event_id: string } | null;
};

export async function renderAndStorePdf(prognosticId: string): Promise<PdfResult> {
  const supabase = createAdminClient();

  const { data: prognostic } = (await supabase
    .from("prognostics")
    .select("*, participants(full_name, event_id)")
    .eq("id", prognosticId)
    .single()) as { data: PrognosticWithParticipant | null; error: unknown };

  if (!prognostic) {
    return { ok: false, status: 404, error: "Prognóstico não encontrado" };
  }

  // Already rendered — reuse. Editing a prognostic nulls pdf_url, so this only
  // short-circuits when the stored file still matches the current content.
  if (prognostic.pdf_url) {
    return { ok: true, pdfUrl: prognostic.pdf_url };
  }

  const participant = prognostic.participants;

  const { data: event } = (await supabase
    .from("events")
    .select("name, event_date, host_name")
    .eq("id", participant?.event_id ?? "")
    .single()) as {
    data: Pick<Event, "name" | "event_date" | "host_name"> | null;
    error: unknown;
  };

  // Prefer the reviewed text over the raw IA output: an admin edit that hadn't
  // been delivered yet used to render the unedited version into the PDF.
  const content = (prognostic.final_content ??
    prognostic.edited_content ??
    prognostic.raw_ai_output) as PrognosticContent;

  // Dynamic import to avoid bundling issues
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { PrognosticPdfDocument } = await import(
    "@/components/features/prognostic/PrognosticPdfDocument"
  );
  const { createElement } = await import("react");

  const pdfBuffer = await renderToBuffer(
    createElement(PrognosticPdfDocument, {
      participantName: participant?.full_name ?? "",
      eventName: event?.name ?? "Marco Zero",
      eventDate: event?.event_date ?? "",
      hostName: event?.host_name ?? "Yuri Fortes",
      content,
      yuriNote: prognostic.yuri_note ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  );

  const fileName = `prognostics/${prognosticId}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(fileName, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error("[render-pdf] upload failed", { prognosticId, uploadError });
    return { ok: false, status: 500, error: "Erro ao salvar PDF" };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("documents").getPublicUrl(fileName);

  await (
    supabase.from("prognostics") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }
  )
    .update({ pdf_url: publicUrl })
    .eq("id", prognosticId);

  return { ok: true, pdfUrl: publicUrl };
}
