import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/nps — submissão pública de feedback. Sem auth.
// Anti-spam: 1 por sessão (cookie / localStorage no cliente). Aqui só validamos
// shape e gravamos via admin client (RLS permite INSERT anon de qualquer jeito,
// mas o admin client deixa o flow consistente com o resto da API).

const npsSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  nps_score: z.number().int().min(0).max(10),
  quality_rating: z.enum(["nao_refletiu", "parcialmente", "bem", "precisao"]),
  highlight: z.string().max(2000).nullable().optional(),
  improvement: z.string().max(2000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = npsSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!parsed?.success) {
    return NextResponse.json(
      { error: "Dados inválidos", details: parsed?.error.format() },
      { status: 400 }
    );
  }

  const { full_name, nps_score, quality_rating, highlight, improvement } = parsed.data;

  const supabase = createAdminClient();

  type MutResult = { data: unknown; error: { message: string } | null };
  const { error } = (await (supabase.from("nps_responses") as unknown as {
    insert(v: Record<string, unknown>): Promise<MutResult>;
  }).insert({
    full_name,
    nps_score,
    quality_rating,
    highlight: highlight ?? null,
    improvement: improvement ?? null,
  })) as MutResult;

  if (error) {
    console.error("[POST /api/nps] DB error:", error);
    return NextResponse.json({ error: "Erro ao salvar" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
