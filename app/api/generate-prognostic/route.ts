import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generatePrognosticSchema } from "@/lib/schemas";
import { generatePrognostic } from "@/lib/ai/generate-prognostic";
import { renderAndStorePdf } from "@/lib/pdf/render-prognostic-pdf";

export const maxDuration = 120;

// Rate limit is per-instance and best-effort. It is a courtesy guard against
// double-clicks, NOT the cost control. O controle de custo real e: so admin
// chega aqui, e o estado do prognostico (lib/ai/generate-prognostic.ts) recusa
// regerar um documento que ja entrou em revisao, antes de chamar o modelo.
const RATE_LIMIT_MAP = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

function checkRateLimit(participantId: string): boolean {
  const now = Date.now();

  // Evict expired entries so the map can't grow unbounded on a warm instance.
  for (const [key, ts] of RATE_LIMIT_MAP) {
    if (now - ts >= RATE_LIMIT_MS) RATE_LIMIT_MAP.delete(key);
  }

  const lastCall = RATE_LIMIT_MAP.get(participantId);
  if (lastCall && now - lastCall < RATE_LIMIT_MS) return false;
  RATE_LIMIT_MAP.set(participantId, now);
  return true;
}

export async function POST(req: NextRequest) {
  // Autorizacao ANTES de qualquer outra coisa, inclusive de ler o corpo: esta
  // rota gasta credito de modelo (Opus), entao nenhuma requisicao nao
  // autorizada pode chegar perto do codigo que chama a Anthropic.
  //
  // Quem pode gerar: SOMENTE a operacao (admin). O participante NAO gera nem
  // regera o proprio prognostico: o documento e produzido sob controle da
  // operacao e passa por revisao humana. O processamento em lote nao passa por
  // esta rota; ele chama generatePrognostic() em processo, com service_role, atras
  // do proprio guarda de admin em /api/batch-process.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  // Mesma regra de getAdminUser()/is_admin(): app_metadata.role === "admin".
  if (user.app_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const parsed = generatePrognosticSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { participant_id, event_id } = parsed.data;

  if (!checkRateLimit(participant_id)) {
    return NextResponse.json({ error: "Aguarde antes de tentar novamente." }, { status: 429 });
  }

  const result = await generatePrognostic(participant_id, event_id);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, detail: result.detail },
      { status: result.status }
    );
  }

  // Background PDF generation via Next 16 `after()`: runs after the response is
  // sent and keeps the runtime alive until it finishes. Calling the renderer
  // in-process (instead of self-fetching /api/generate-pdf) removes an extra
  // invocation and lets that endpoint be authorized properly.
  // Failure is non-fatal — the participant can trigger the PDF from the UI.
  const { prognosticId } = result;
  after(async () => {
    try {
      await renderAndStorePdf(prognosticId);
    } catch (err) {
      console.error("[background PDF generation failed]", err);
    }
  });

  return NextResponse.json({
    success: true,
    prognostic_id: result.prognosticId,
    trail: result.trail,
    pdf_pending: true,
  });
}
