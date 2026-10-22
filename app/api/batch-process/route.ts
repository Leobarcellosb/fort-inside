import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { generatePrognostic } from "@/lib/ai/generate-prognostic";
import { prepararProcessamento, type ClienteDeProcessamento } from "@/lib/erros/preparar-processamento";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import { renderAndStorePdf } from "@/lib/pdf/render-prognostic-pdf";

export const maxDuration = 300;

// Dispara em ondas em vez de tudo de uma vez. Vinte requests simultaneos de
// 32k max_tokens podem estourar o rate limit da organizacao no meio do evento,
// e vinte renderizacoes de PDF ao mesmo tempo pesam na memoria da funcao.
// Com ~63s por prognostico, 10 por onda entrega 20 participantes em ~2 min.
// Tudo de uma vez seria ~1 min, mas um 429 no meio do evento custa mais que o
// minuto economizado: o SDK so tenta de novo 2 vezes antes de desistir, e um
// participante sem prognostico e um problema visivel na sala.
const CONCURRENCY = 10;

async function inWaves<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const wave = items.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.allSettled(wave.map(fn))));
  }
  return out;
}

// Erros: status HTTP e codigo vem de lib/erros/codigos.ts, e as condicoes comuns
// (pedido, etapas, participantes) passam por prepararProcessamento -- o MESMO
// caminho de /api/jobs/enfileirar, entao as duas rotas respondem igual diante da
// mesma condicao. O corpo nunca carrega texto interno de banco.
export async function POST(req: NextRequest) {
  try {
    return await processar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function processar(req: NextRequest) {
  // Admin only: this fans out one Anthropic call per participant.
  // verificarAdmin() devolve tres desfechos (AUTH_REQUIRED 401, ADMIN_FORBIDDEN 403,
  // AUTH_UNAVAILABLE 503): "sem permissao" so quando o servico de login respondeu.
  const admin = await verificarAdmin();
  if (!admin.autorizado) {
    return respostaDeRecusa(admin);
  }

  const supabase = createAdminClient();

  // Pedido, etapas (a contagem vem do banco, nunca de um numero fixo) e
  // participantes que concluiram. Mesmo helper de /api/jobs/enfileirar.
  // No assíncrono o banco confere e fotografa (sem enfileirar) e o lote gera SOBRE
  // esse conjunto: o mesmo critério e a mesma proteção da corrida do fechamento.
  const preparo = await prepararProcessamento(req, supabase as unknown as ClienteDeProcessamento, {
    assincrono: "verificar",
  });
  if (!preparo.ok) return preparo.resposta;
  const { eventId: event_id, participantes: participants } = preparo;

  await (
    supabase.from("events") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }
  )
    .update({ status: "processing" })
    .eq("id", event_id);

  // Generate in-process. The previous self-fetch to /api/generate-prognostic hit
  // that route's per-participant rate limit whenever the admin pressed
  // "Processar" within 60s of the stage-6 auto-fire, so successful generations
  // were reported back as failures.
  const results = await inWaves(participants, (p) =>
    generatePrognostic(p.id, event_id)
  );

  let succeeded = 0;
  let skipped = 0;
  const generatedIds: string[] = [];

  results.forEach((r, idx) => {
    const participantId = participants[idx]?.id;

    if (r.status === "rejected") {
      console.error("[batch-process] generation threw", {
        participant_id: participantId,
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
      return;
    }

    // 409 = o prognostico ja esta em in_review, reviewed ou delivered (ou
    // avancou enquanto o modelo rodava) e a regeracao foi recusada DE PROPOSITO,
    // para nao apagar trabalho de revisao nem gastar modelo (migration 015 e
    // generatePrognostic). Nao e falha: contar aqui inflaria `failed` em todo
    // reprocessamento e esconderia as falhas reais. O documento fica como esta.
    if (!r.value.ok && r.value.status === 409) {
      skipped++;
      console.info("[batch-process] prognostico pulado (estado ja avancado)", {
        participant_id: participantId,
        reason: r.value.error,
      });
      return;
    }

    if (!r.value.ok) {
      console.error("[batch-process] generation failed", {
        participant_id: participantId,
        status: r.value.status,
        error: r.value.error,
        detail: r.value.detail,
      });
      return;
    }

    succeeded++;
    generatedIds.push(r.value.prognosticId);
  });

  const failed = results.length - succeeded - skipped;

  // Render PDFs up front so the participant's share page doesn't sit polling.
  await inWaves(generatedIds, (id) => renderAndStorePdf(id));

  await (
    supabase.from("events") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }
  )
    .update({ status: "completed" })
    .eq("id", event_id);

  await (
    supabase.from("event_logs") as unknown as {
      insert(v: Record<string, unknown>): Promise<unknown>;
    }
  ).insert({
    event_id,
    action: "batch_process_completed",
    payload: { total: participants.length, succeeded, skipped, failed },
  });

  return NextResponse.json({
    success: true,
    total: participants.length,
    succeeded,
    skipped,
    failed,
  });
}
