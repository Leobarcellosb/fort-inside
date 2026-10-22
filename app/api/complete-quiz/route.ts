import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TOTAL_STAGES } from "@/lib/constants";
import type { Event, Participant, QuizResponse, QuizStage } from "@/types/database";

/*
 * ============================================================================
 * POR QUE A CONCLUSAO DO QUIZ PASSA POR ESTA ROTA -- LEIA ANTES DE "SIMPLIFICAR"
 * ============================================================================
 *
 * Antes, o navegador gravava o proprio `participants.completed_at` ao enviar a
 * ultima etapa. A migration 014 revogou esse UPDATE de `authenticated` (o
 * participante usava a coluna para entrar na fila de geracao de IA sem ter
 * respondido o questionario), e esta e a ULTIMA gravadora de `completed_at` do
 * sistema: `batch-process` so processa quem tem `completed_at` preenchido.
 *
 * O ponto de seguranca e o seguinte: o participante nao AFIRMA mais que
 * terminou. O servidor CONFERE, no banco, se cada etapa do quiz do evento tem
 * resposta gravada, e so entao marca. A rota nao e porta dos fundos da 014:
 *   - o dono e identificado pela SESSAO (cookie), nunca por dado do corpo;
 *   - o corpo so diz QUAL participante; quem decide se terminou e o banco;
 *   - a gravacao usa service_role, mas so depois de passar por tudo acima.
 *
 * Quais sao "todas as etapas": as de `quiz_stages` na `quiz_version` DO EVENTO
 * do participante (010_programas.sql). Nao presume 1..6: a versao 2 (Marco Zero)
 * tem ids a partir de 101. `TOTAL_STAGES` e a contagem esperada da versao 1 e
 * serve de trava contra configuracao quebrada (ver abaixo), nao de lista.
 *
 * O que esta rota NAO verifica: o CONTEUDO das respostas. Isso e regra do
 * questionario (obrigatorias, minimo de caracteres, ranking completo) e vive no
 * cliente; duplica-la aqui criaria duas fontes de verdade. O que o servidor
 * garante e que existe uma resposta gravada, pela RLS de quiz_responses, para
 * cada etapa que o evento exige.
 * ============================================================================
 */

const bodySchema = z.object({
  participant_id: z.string().uuid(),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

function erro(
  status: number,
  error: string,
  extra?: Record<string, unknown>
) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

// Mensagem unica para "participante nao existe" e "participante e de outra
// pessoa": diferenciar viraria oraculo de quais ids existem.
const NAO_AUTORIZADO = "Não autorizado";

const ERRO_INTERNO =
  "Não conseguimos confirmar a conclusão agora. Suas respostas estão guardadas. Tente de novo em instantes.";

export async function POST(req: NextRequest) {
  // 1. Autorizacao ANTES de qualquer outro trabalho, inclusive ler o corpo.
  const sessao = await createClient();
  const {
    data: { user },
  } = await sessao.auth.getUser();

  if (!user) {
    return erro(401, "Sua sessão expirou. Recarregue a página e tente de novo.");
  }

  // 2. Corpo malformado e erro do cliente: 400, nunca 500. Nada do que foi
  //    enviado e ecoado na resposta.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return erro(400, "Dados inválidos");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return erro(400, "Dados inválidos");
  }
  const { participant_id } = parsed.data;

  const admin = createAdminClient();

  // 3. O chamador precisa ser o DONO deste participante.
  const { data: participant, error: pErr } = (await admin
    .from("participants")
    .select("id, user_id, event_id, completed_at")
    .eq("id", participant_id)
    .maybeSingle()) as {
    data: Pick<Participant, "id" | "user_id" | "event_id" | "completed_at"> | null;
    error: { code?: string } | null;
  };

  if (pErr) {
    console.error("[complete-quiz] falha ao ler participante", { code: pErr.code });
    return erro(500, ERRO_INTERNO);
  }

  if (!participant || !participant.user_id || participant.user_id !== user.id) {
    return erro(403, NAO_AUTORIZADO);
  }

  // 4. Idempotencia: ja concluido e sucesso, sem reescrever o instante original
  //    nem refazer a conferencia.
  if (participant.completed_at) {
    return NextResponse.json(
      { success: true, ja_concluido: true },
      { headers: NO_STORE }
    );
  }

  // 5. Quais etapas o evento exige.
  const { data: event, error: eErr } = (await admin
    .from("events")
    .select("id, quiz_version")
    .eq("id", participant.event_id)
    .maybeSingle()) as {
    data: Pick<Event, "id" | "quiz_version"> | null;
    error: { code?: string } | null;
  };

  if (eErr || !event) {
    console.error("[complete-quiz] falha ao ler evento", { code: eErr?.code });
    return erro(500, ERRO_INTERNO);
  }

  const { data: stages, error: sErr } = (await admin
    .from("quiz_stages")
    .select("id, stage_number")
    .eq("quiz_version", event.quiz_version)) as {
    data: Pick<QuizStage, "id" | "stage_number">[] | null;
    error: { code?: string } | null;
  };

  if (sErr || !stages) {
    console.error("[complete-quiz] falha ao ler etapas", { code: sErr?.code });
    return erro(500, ERRO_INTERNO);
  }

  // Trava contra configuracao quebrada: com zero etapas, "todas respondidas"
  // seria verdade vazia e qualquer um concluiria sem responder nada. Na versao 1
  // a contagem tem de ser exatamente TOTAL_STAGES.
  const contagemInesperada =
    stages.length === 0 ||
    (event.quiz_version === 1 && stages.length !== TOTAL_STAGES);
  if (contagemInesperada) {
    console.error("[complete-quiz] quiz do evento com contagem de etapas inesperada", {
      event_id: event.id,
      quiz_version: event.quiz_version,
      encontradas: stages.length,
      esperadas_v1: TOTAL_STAGES,
    });
    return erro(500, ERRO_INTERNO);
  }

  // 6. O que a pessoa de fato respondeu (lido do banco, nunca do corpo).
  const { data: responses, error: rErr } = (await admin
    .from("quiz_responses")
    .select("stage_id")
    .eq("participant_id", participant.id)) as {
    data: Pick<QuizResponse, "stage_id">[] | null;
    error: { code?: string } | null;
  };

  if (rErr || !responses) {
    console.error("[complete-quiz] falha ao ler respostas", { code: rErr?.code });
    return erro(500, ERRO_INTERNO);
  }

  const respondidas = new Set(responses.map((r) => r.stage_id));
  const pendentes = stages
    .filter((s) => !respondidas.has(s.id))
    .sort((a, b) => (a.stage_number ?? a.id) - (b.stage_number ?? b.id));

  if (pendentes.length > 0) {
    return erro(
      409,
      "Ainda não recebemos as respostas de todas as etapas. O que você já enviou está guardado. Volte para as etapas que faltam e envie para concluir.",
      {
        codigo: "etapas_pendentes",
        etapas_pendentes: pendentes.map((s) => s.stage_number ?? s.id),
      }
    );
  }

  // 7. Grava. `.is("completed_at", null)` torna o UPDATE condicional: duas
  //    chamadas simultaneas nao se atropelam e a segunda nao reescreve o
  //    instante. Zero linhas afetadas aqui significa "outra chamada ja
  //    concluiu", que tambem e sucesso.
  const { error: uErr } = await (
    admin.from("participants") as unknown as {
      update(v: Record<string, unknown>): {
        eq(c: string, v: string): {
          is(c: string, v: null): Promise<{ error: { code?: string } | null }>;
        };
      };
    }
  )
    .update({ completed_at: new Date().toISOString() })
    .eq("id", participant.id)
    .is("completed_at", null);

  if (uErr) {
    console.error("[complete-quiz] falha ao gravar conclusao", { code: uErr.code });
    return erro(500, ERRO_INTERNO);
  }

  return NextResponse.json({ success: true, ja_concluido: false }, { headers: NO_STORE });
}
