import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
    .select("pdf_url, status")
    .eq("public_share_token", token)
    .single()) as { data: { pdf_url: string | null; status: string } | null };

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    { pdf_url: data.pdf_url, status: data.status },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
