import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePdfSchema } from "@/lib/schemas";
import type { PrognosticContent } from "@/types/database";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = generatePdfSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { prognostic_id } = parsed.data;
  const supabase = createAdminClient();

  const { data: prognostic } = await supabase
    .from("prognostics")
    .select("*, participants(full_name, event_id)")
    .eq("id", prognostic_id)
    .single();

  if (!prognostic) {
    return NextResponse.json({ error: "Prognóstico não encontrado" }, { status: 404 });
  }

  // Return existing PDF if already generated
  if (prognostic.pdf_url) {
    return NextResponse.json({ pdf_url: prognostic.pdf_url });
  }

  const participant = prognostic.participants as { full_name: string; event_id: string } | null;

  const { data: event } = await supabase
    .from("events")
    .select("name, event_date, host_name")
    .eq("id", participant?.event_id ?? "")
    .single();

  const content = (prognostic.final_content ?? prognostic.raw_ai_output) as PrognosticContent;

  // Dynamic import to avoid bundling issues
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { PrognosticPdfDocument } = await import("@/components/features/prognostic/PrognosticPdfDocument");
  const { createElement } = await import("react");

  const pdfBuffer = await renderToBuffer(
    createElement(PrognosticPdfDocument, {
      participantName: participant?.full_name ?? "",
      eventName: event?.name ?? "Fort Inside",
      eventDate: event?.event_date ?? "",
      hostName: event?.host_name ?? "Yuri Fortes",
      content,
      yuriNote: prognostic.yuri_note ?? null,
    })
  );

  // Upload to Supabase Storage
  const fileName = `prognostics/${prognostic_id}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(fileName, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: "Erro ao salvar PDF" }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage
    .from("documents")
    .getPublicUrl(fileName);

  await supabase
    .from("prognostics")
    .update({ pdf_url: publicUrl })
    .eq("id", prognostic_id);

  return NextResponse.json({ pdf_url: publicUrl });
}
