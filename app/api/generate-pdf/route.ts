import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAdminUser } from "@/lib/auth/require-admin";
import { renderAndStorePdf } from "@/lib/pdf/render-prognostic-pdf";

export const maxDuration = 60;

// Two ways in:
//   { token }         — the participant's own share token. Same gate as the
//                       /prognostic/[token] page: unguessable and delivered-only.
//   { prognostic_id } — admin only.
// Previously this accepted a bare prognostic_id from anyone, making PDF
// rendering (and Storage writes) an open endpoint.
const bodySchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ prognostic_id: z.string().uuid() }),
]);

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!parsed?.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  let prognosticId: string;

  if ("token" in parsed.data) {
    const admin = createAdminClient();
    const { data } = (await admin
      .from("prognostics")
      .select("id")
      .eq("public_share_token", parsed.data.token)
      .eq("status", "delivered")
      .single()) as { data: { id: string } | null; error: unknown };

    if (!data) {
      return NextResponse.json({ error: "Prognóstico não encontrado" }, { status: 404 });
    }
    prognosticId = data.id;
  } else {
    if (!(await getAdminUser())) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
    }
    prognosticId = parsed.data.prognostic_id;
  }

  const result = await renderAndStorePdf(prognosticId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ pdf_url: result.pdfUrl });
}
