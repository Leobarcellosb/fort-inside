import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PrognosticContent } from "@/types/database";

// PATCH /api/prognostics/[id]
// Yuri-only: salva texto editado em `edited_content`, marca status='reviewed',
// nulifica pdf_url para forçar regeneração com texto novo no momento da entrega.

const TRAILS = [
  "Exploração",
  "Direção",
  "Aproximação",
  "Aceleração",
  "Sessão Privada",
] as const;

// Schema flexível: arrays com tamanho mínimo 1 (admin pode estar reorganizando
// blocos durante edição), strings com min(1) pra evitar entregar campo vazio.
const contentSchema = z.object({
  analise_geral: z.string().min(1),
  areas_chave: z
    .array(
      z.object({
        nome: z.string().min(1),
        diagnostico: z.string().min(1),
        risco: z.string().min(1),
        movimento: z.string().min(1),
      })
    )
    .min(1),
  plano_30_dias: z
    .array(
      z.object({
        titulo: z.string().min(1),
        objetivos: z.array(z.string().min(1)).min(1),
        acao: z.string().min(1),
        resultado_esperado: z.string().min(1),
      })
    )
    .min(1),
  praticas: z
    .array(z.object({ nome: z.string().min(1), descricao: z.string().min(1) }))
    .min(1),
  frase_ativacao: z.object({
    frase: z.string().min(1),
    contexto: z.string().min(1),
    aplicacao: z.string().min(1),
    pergunta_pratica: z.string().min(1),
  }),
  trilha_recomendada: z.enum(TRAILS),
  justificativa_trilha: z.string().min(1),
});

const bodySchema = z.object({
  content: contentSchema,
  yuri_note: z.string().nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;

  // Admin auth — same pattern as /api/admin/events/[eventId]
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!parsed?.success) {
    return NextResponse.json(
      { error: "Conteúdo inválido", detail: parsed?.error.flatten() },
      { status: 400 }
    );
  }

  const { content, yuri_note } = parsed.data;

  // Use admin client to bypass RLS for the write — auth already checked above.
  const admin = createAdminClient();

  type MutResult = { data: unknown; error: { message: string } | null };
  const { error } = await ((admin.from("prognostics") as unknown as {
    update(v: Record<string, unknown>): {
      eq(c: string, v: string): Promise<MutResult>;
    };
  })
    .update({
      edited_content: content as PrognosticContent,
      yuri_note: yuri_note ?? null,
      trail_recommendation: content.trilha_recomendada,
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      pdf_url: null,
    })
    .eq("id", id));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
