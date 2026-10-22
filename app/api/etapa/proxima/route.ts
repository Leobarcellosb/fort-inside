import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { calcularProximaEtapa, type ClienteDeProxima } from "./proxima-etapa";

// POST /api/etapa/proxima -- para onde levar o participante do modo ASSINCRONO.
// No live devolve `destino: null` (current_stage manda, no cliente).
// Mesmas regras de resposta de /api/etapa/abrir: nenhum texto de banco no corpo,
// servico de login fora do ar e 503 (nao "sessao expirou").

const NO_STORE = { "Cache-Control": "no-store" } as const;
const bodySchema = z.object({ participant_id: z.string().uuid() });

function erro(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: erroDeLogin,
  } = await supabase.auth.getUser();
  if (!user) {
    const status = (erroDeLogin as { status?: number } | null)?.status;
    const transitorio =
      !!erroDeLogin &&
      (erroDeLogin.name === "AuthRetryableFetchError" ||
        status === 0 ||
        (typeof status === "number" && status >= 500));
    if (transitorio) {
      console.error("[etapa/proxima] servico de login indisponivel", { nome: erroDeLogin?.name, status });
      return erro(503, "Não conseguimos confirmar seu acesso agora. Tente de novo em instantes.");
    }
    return erro(401, "Sua sessão expirou. Recarregue a página e tente de novo.");
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return erro(400, "Dados inválidos");
  }
  const parsed = bodySchema.safeParse(corpo);
  if (!parsed.success) return erro(400, "Dados inválidos");

  const r = await calcularProximaEtapa(supabase as unknown as ClienteDeProxima, {
    userId: user.id,
    participantId: parsed.data.participant_id,
  });

  switch (r.tipo) {
    case "ok":
      return NextResponse.json(r.resposta, { headers: NO_STORE });
    case "nao_autorizado":
      return erro(403, "Não autorizado");
    case "nao_encontrado":
      return erro(404, "Evento não encontrado");
    case "erro":
      console.error("[etapa/proxima] falha inesperada", r.causa);
      return erro(500, "Não conseguimos descobrir sua próxima etapa agora. Tente de novo em instantes.");
  }
}
