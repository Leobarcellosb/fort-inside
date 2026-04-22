import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Event } from "@/types/database";

export const maxDuration = 30;

const DELETABLE_STATUSES = ["draft", "completed"] as const;

interface Params {
  params: Promise<{ eventId: string }>;
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { eventId } = await params;

  // 1. Admin auth check (SSR + cookies)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  // 2. Parse body
  let confirmationCode: string;
  try {
    const body = await req.json();
    confirmationCode = typeof body?.confirmation_code === "string" ? body.confirmation_code : "";
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!confirmationCode) {
    return NextResponse.json({ error: "Código de confirmação obrigatório" }, { status: 400 });
  }

  // 3. Fetch event + validate
  const admin = createAdminClient();
  const { data: event, error: eErr } = await admin
    .from("events")
    .select("id, event_code, status")
    .eq("id", eventId)
    .single() as {
      data: Pick<Event, "id" | "event_code" | "status"> | null;
      error: { message: string } | null;
    };

  if (eErr || !event) {
    return NextResponse.json({ error: "Evento não encontrado" }, { status: 404 });
  }

  if (!DELETABLE_STATUSES.includes(event.status as (typeof DELETABLE_STATUSES)[number])) {
    return NextResponse.json(
      { error: "Não é possível deletar evento ativo. Encerre o evento primeiro." },
      { status: 400 }
    );
  }

  if (confirmationCode !== event.event_code) {
    return NextResponse.json({ error: "Código incorreto" }, { status: 400 });
  }

  // 4. Collect PDF paths from Storage (non-fatal if fails)
  const { data: participants } = await admin
    .from("participants")
    .select("id")
    .eq("event_id", eventId) as { data: { id: string }[] | null };

  const participantIds = (participants ?? []).map((p) => p.id);

  const storagePaths: string[] = [];
  if (participantIds.length > 0) {
    const { data: pdfs } = await admin
      .from("prognostics")
      .select("pdf_url")
      .in("participant_id", participantIds) as { data: { pdf_url: string | null }[] | null };

    for (const p of pdfs ?? []) {
      if (!p.pdf_url) continue;
      const match = p.pdf_url.match(/\/documents\/(.+)$/);
      if (match) storagePaths.push(match[1]);
    }
  }

  if (storagePaths.length > 0) {
    try {
      await admin.storage.from("documents").remove(storagePaths);
    } catch {
      // orphan PDFs are acceptable — cascade still runs
    }
  }

  // 5. Cascade delete via SQL function
  type RpcResult = { data: unknown; error: { message: string } | null };
  const { data: summary, error: rpcErr } = await (admin.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<RpcResult>)("delete_event_cascade", { event_uuid: eventId });

  if (rpcErr) {
    return NextResponse.json(
      { error: "Erro ao deletar: " + rpcErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, summary });
}
