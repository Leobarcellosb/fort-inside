import { NextRequest, NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { prepararProcessamento, type ClienteDeProcessamento } from "@/lib/erros/preparar-processamento";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import { codigoDeFalhaDeFila, observarRpc } from "@/lib/erros/falha-de-fila";
import type { CodigoDeErro } from "@/lib/erros/codigos";
import { lerConfigFila } from "@/lib/jobs/config";
import {
  enfileirarJob,
  resumoEvento,
  type ClienteFila,
} from "@/lib/jobs/fila";
import { rodarTick, type ClienteWorker } from "@/lib/jobs/worker";
import { trabalhoPrognostico } from "@/lib/jobs/trabalho-prognostico";

export const maxDuration = 300;

/**
 * Enfileira um job de prognóstico por participante que concluiu o quiz.
 *
 * Fica AO LADO de /api/batch-process, que continua existindo e intocado. Esta
 * rota não gera nada: ela só cria linhas. Quem gera é o worker, em ticks que
 * podem morrer sem levar o trabalho embora.
 *
 * Idempotente de verdade, e isso é propriedade do banco, não desta rota:
 * `jobs_enfileirar` tem `on conflict (kind, participant_id) do nothing`, então
 * clique duplo em "Processar" NÃO duplica trabalho pago e NÃO ressuscita job
 * que já terminou. Reprocessar é operação explícita (`jobs_reenfileirar`).
 */
export async function POST(req: NextRequest) {
  try {
    return await enfileirar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function enfileirar(req: NextRequest) {
  // Só admin: isto agenda uma chamada de Opus por participante. verificarAdmin() devolve
  // três desfechos (AUTH_REQUIRED 401, ADMIN_FORBIDDEN 403, AUTH_UNAVAILABLE 503):
  // "sem permissão" só quando o serviço de login respondeu.
  const admin = await verificarAdmin();
  if (!admin.autorizado) {
    return respostaDeRecusa(admin);
  }

  const supabase = createAdminClient();

  // Pedido, etapas (a contagem vem do banco, nunca de um número fixo) e
  // participantes que concluíram. Mesmo helper de /api/batch-process: diante da
  // mesma condição, as duas rotas respondem o mesmo status e o mesmo código.
  const preparo = await prepararProcessamento(req, supabase as unknown as ClienteDeProcessamento);
  if (!preparo.ok) return preparo.resposta;
  const { eventId: event_id, evento, participantes, inicio } = preparo;

  let config;
  try {
    config = lerConfigFila();
  } catch (err) {
    return erroHttp("QUEUE_CONFIG_INVALID", { causa: err });
  }

  // O cliente da fila é observado: `lib/jobs/fila.ts` transforma o erro do
  // PostgREST em exceção só com a mensagem e perde o CÓDIGO, e é o código que
  // separa "a função não existe" (migration 018 ausente) de "a fila não respondeu".
  const observado = observarRpc(supabase as unknown as ClienteFila);
  const cliente = observado.cliente;

  // Sequencial de propósito: são N inserts baratos, e um erro no meio precisa
  // ser atribuível ao participante certo em vez de virar um Promise.all que
  // rejeita sem dizer de quem.
  let criados = 0;
  let reaproveitados = 0;
  const comErro: { participant_id: string; codigo: CodigoDeErro; causa: unknown }[] = [];

  // ASSÍNCRONO: o banco JÁ enfileirou, numa transação só e sobre uma fotografia
  // consistente (ver preparar-processamento.ts e jobs_iniciar_assincrono). Não se
  // enfileira de novo daqui, pessoa por pessoa: reabriria a corrida do fechamento.
  if (inicio) {
    criados = inicio.criados;
    reaproveitados = inicio.reaproveitados;
  }

  for (const p of inicio ? [] : participantes) {
    observado.zerar();
    try {
      const r = await enfileirarJob(cliente, {
        kind: "prognostico",
        eventId: event_id,
        participantId: p.id,
        maxTentativas: 3,
      });
      if (r.criado) criados++;
      else reaproveitados++;
    } catch (err) {
      comErro.push({
        participant_id: p.id,
        codigo: codigoDeFalhaDeFila(observado.ultimoErro()),
        causa: observado.ultimoErro() ?? err,
      });
    }
  }

  // NINGUÉM entrou na fila: é a infraestrutura, não um caso isolado. O que o
  // banco disse separa "a função não existe" de "a fila não respondeu", e quem
  // decide o que o host lê é o código.
  if (comErro.length > 0 && criados + reaproveitados === 0) {
    const faltaEsquema = comErro.some((c) => c.codigo === "QUEUE_SCHEMA_MISSING");
    return erroHttp(faltaEsquema ? "QUEUE_SCHEMA_MISSING" : "QUEUE_UNAVAILABLE", {
      causa: comErro[0].causa,
    });
  }

  observado.zerar();
  let resumo;
  try {
    resumo = await resumoEvento(cliente, { eventId: event_id, kind: "prognostico" });
  } catch (err) {
    // Os jobs JÁ foram criados (e reenviar é idempotente): o que falhou foi só
    // ler o resumo. Não dá para fingir sucesso nem dizer que nada aconteceu.
    return erroHttp(codigoDeFalhaDeFila(observado.ultimoErro()), {
      causa: observado.ultimoErro() ?? err,
    });
  }

  // 'processing' só com trabalho de verdade pendente. Marcar o evento como
  // processando quando não há nada a fazer deixaria o evento num estado que só
  // o worker desfaz -- e se nada foi enfileirado, não há worker para desfazer.
  if (resumo.pendentes > 0 && evento.status === "live") {
    await (
      supabase.from("events") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
      }
    )
      .update({ status: "processing" })
      .eq("id", event_id);
  }

  await (
    supabase.from("event_logs") as unknown as {
      insert(v: Record<string, unknown>): Promise<unknown>;
    }
  ).insert({
    event_id,
    action: "jobs_enfileirados",
    payload: {
      modo: inicio ? "async" : "live",
      total: inicio ? inicio.total : participantes.length,
      ...(inicio ? { digest: inicio.digest, referencia_do_banco: inicio.agoraDoBanco } : {}),
      criados,
      reaproveitados,
      com_erro: comErro.length,
      pendentes: resumo.pendentes,
    },
  });

  // Empurrão imediato, para a operação não esperar o próximo minuto do
  // agendador. É OTIMIZAÇÃO, não garantia: se esta invocação morrer, o cron
  // continua sendo quem garante que a fila anda. `after()` roda depois da
  // resposta e mantém o runtime vivo até o maxDuration desta rota.
  if (resumo.pendentes > 0) {
    after(async () => {
      try {
        await rodarTick(supabase as unknown as ClienteWorker, {
          kind: "prognostico",
          worker: `kick:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}`,
          trabalho: trabalhoPrognostico,
          config,
        });
      } catch (err) {
        console.error("[jobs/enfileirar] empurrão inicial falhou (o cron assume)", {
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return NextResponse.json({
    ok: comErro.length === 0,
    total_participantes: inicio ? inicio.total : participantes.length,
    criados,
    reaproveitados,
    // Só o código por pessoa: a mensagem do banco fica no log do servidor.
    com_erro: comErro.map(({ participant_id, codigo }) => ({ participant_id, codigo })),
    resumo,
  });
}
