import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pdfPermitido } from "@/lib/pdf/politica-do-pdf";

// Public status endpoint for polling PDF generation completion.
// Uses service_role (same pattern as /prognostic/[token]) because the
// participant has no session — access is gated by the unguessable share token.

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ token: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { token } = await params;

  const admin = createAdminClient();
  const { data } = (await admin
    .from("prognostics")
    .select("pdf_url, status, participants(events(quiz_version))")
    .eq("public_share_token", token)
    .single()) as {
    data: {
      pdf_url: string | null;
      status: string;
      participants: { events: { quiz_version: number } | null } | null;
    } | null;
  };

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Evento sem PDF (politica-do-pdf.ts): esta rota nao devolve o endereco de
  // um arquivo, nem de um gravado antes da decisao.
  const pdfUrl = pdfPermitido(data.participants?.events) ? data.pdf_url : null;

  return NextResponse.json(
    { pdf_url: pdfUrl, status: data.status },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
