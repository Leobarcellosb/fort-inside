import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAdminUser } from "@/lib/auth/require-admin";
import { lerConfigFila } from "@/lib/jobs/config";
import {
  liberarOrcamento,
  resumoConsumo,
  verificarOrcamento,
  type ClienteFila,
} from "@/lib/jobs/fila";

export const maxDuration = 30;

// Disjuntor de consumo externo: medição por evento (GET) e liberação
// excepcional AUDITADA (POST).
//
// O teto NÃO é alterável por variável de ambiente sem rastro. A variável só
// fornece o PADRÃO inicial; a partir da primeira liberação o teto daquele
// evento é persistido no banco, e toda alteração passa por
// `jobs_orcamento_liberar`, que exige quem e por quê e grava a trilha antes de
// mexer no teto.

const corpoLiberacao = z.object({
  event_id: z.string().uuid(),
  teto_evento: z.number().int().min(0).max(10_000),
  teto_participante: z.number().int().min(0).max(100),
  // Mínimo de 10 caracteres no banco também (CHECK da 021): "porque sim" não é
  // motivo, e um campo de auditoria vazio é pior que não ter campo.
  motivo: z.string().trim().min(10).max(1000),
});

/** Medição por evento: quanto já se gastou, e qual o teto em vigor. */
export async function GET(req: NextRequest) {
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  const eventId = req.nextUrl.searchParams.get("event_id");
  const participantId = req.nextUrl.searchParams.get("participant_id");
  if (!eventId || !z.string().uuid().safeParse(eventId).success) {
    return NextResponse.json({ error: "event_id inválido" }, { status: 400 });
  }

  let config;
  try {
    config = lerConfigFila();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "configuração inválida" },
      { status: 500 }
    );
  }

  const cliente = createAdminClient() as unknown as ClienteFila;

  try {
    const consumo = await resumoConsumo(cliente, { eventId, kind: "prognostico" });

    // `verificar` precisa de um participante para avaliar o teto individual.
    // Sem um na consulta, devolvemos só o quadro do evento.
    const veredito = participantId
      ? await verificarOrcamento(cliente, {
          kind: "prognostico",
          eventId,
          participantId,
          tetoEventoPadrao: config.orcamentoTentativasPorEvento,
          tetoParticipantePadrao: config.orcamentoTentativasPorParticipante,
        })
      : null;

    return NextResponse.json({
      ok: true,
      event_id: eventId,
      // Unidade de contagem, dita por extenso para ninguém confundir com
      // dólares nem com `jobs.attempts`.
      unidade:
        "tentativas que CHEGARAM ao provedor externo (inclusive abortadas); " +
        "tentativa que nunca abriu conexão não conta",
      padrao_configurado: {
        teto_evento: config.orcamentoTentativasPorEvento,
        teto_participante: config.orcamentoTentativasPorParticipante,
      },
      consumo,
      veredito,
    });
  } catch (err) {
    // Sem a 021 aplicada não há medição. Dizer isso é melhor que devolver zeros,
    // que pareceriam "não gastou nada".
    return NextResponse.json(
      {
        error:
          "Não consegui ler o consumo externo (migration 021 aplicada?). " +
          "O disjuntor NÃO está ativo e NÃO há medição disponível.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

/** Liberação excepcional auditada: quem, quando, por quê, e o teto novo. */
export async function POST(req: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }
  const parsed = corpoLiberacao.safeParse(bruto);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Dados inválidos. `motivo` é obrigatório e precisa de ao menos 10 caracteres: " +
          "a liberação é auditada e sem motivo não há auditoria.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { event_id, teto_evento, teto_participante, motivo } = parsed.data;

  // QUEM vem da SESSÃO, nunca do corpo da requisição: um campo "liberado_por"
  // enviado pelo cliente seria auditoria que o próprio auditado escreve.
  const liberadoPor = admin.email ?? admin.id;

  const cliente = createAdminClient() as unknown as ClienteFila;

  try {
    const r = await liberarOrcamento(cliente, {
      eventId: event_id,
      tetoEvento: teto_evento,
      tetoParticipante: teto_participante,
      liberadoPor,
      motivo,
    });

    console.warn("[jobs/orcamento] LIBERAÇÃO EXCEPCIONAL de orçamento", {
      liberacao_id: r.liberacaoId,
      event_id,
      liberado_por: liberadoPor,
      teto_anterior_evento: r.tetoAnteriorEvento,
      teto_novo_evento: r.tetoNovoEvento,
      teto_novo_participante: teto_participante,
      usado_no_momento: r.usadoNoMomento,
      motivo,
    });

    return NextResponse.json({
      ok: true,
      liberacao_id: r.liberacaoId,
      liberado_por: liberadoPor,
      teto_anterior_evento: r.tetoAnteriorEvento,
      teto_novo_evento: r.tetoNovoEvento,
      teto_novo_participante: teto_participante,
      usado_no_momento: r.usadoNoMomento,
      // O teto agora é PERSISTIDO para este evento: deixa de depender da
      // variável de ambiente, e a trilha fica em jobs_orcamento_liberacoes.
      persistido: true,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Não consegui registrar a liberação (migration 021 aplicada?)",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
