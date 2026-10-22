import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAdminUser } from "@/lib/auth/require-admin";
import {
  cancelarJob,
  reenfileirarJob,
  type ClienteFila,
} from "@/lib/jobs/fila";

export const maxDuration = 30;

// Operação manual sobre UM job: reprocessar ou cancelar. Existe para que
// destravar a fila não exija psql em produção.
//
// `forcar` é separado de propósito: sem ele, o banco RECUSA desfazer um job que
// terminou em sucesso ou pulado (a preservação é a regra, e quem quiser
// quebrá-la escreve isso). Com ele, o job volta à fila -- mas a migration 015
// continua valendo no documento: um prognóstico já entregue será recusado de
// novo e o job terminará em 'skipped', sem apagar nada.
const corpo = z.object({
  job_id: z.string().uuid(),
  acao: z.enum(["reenfileirar", "cancelar"]),
  forcar: z.boolean().optional(),
  motivo: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const parsed = corpo.safeParse(bruto);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const { job_id, acao, forcar, motivo } = parsed.data;

  const cliente = createAdminClient() as unknown as ClienteFila;

  try {
    if (acao === "cancelar") {
      const aplicado = await cancelarJob(cliente, { id: job_id, motivo });
      return NextResponse.json({
        ok: aplicado,
        acao,
        // false = o job já era terminal em sucesso/pulado/cancelado. Cancelar
        // não desfaz desfecho bom.
        motivo: aplicado ? "cancelado" : "job não está em estado cancelável",
      });
    }

    const r = await reenfileirarJob(cliente, { id: job_id, forcar });
    return NextResponse.json({
      ok: r.aplicado,
      acao,
      status_anterior: r.statusAnterior,
      motivo: r.motivo,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falha na operação" },
      { status: 500 }
    );
  }
}
