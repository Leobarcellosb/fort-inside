import { TOTAL_STAGES } from "../constants";
import type { QuizResponse, QuizStage } from "@/types/database";

// Le o que o prognostico precisa do questionario: as ETAPAS e as RESPOSTAS DA
// VERSAO DO QUIZ DO EVENTO DO PARTICIPANTE, e so elas.
//
// Esta e a metade LEITURA da protecao do versionamento (migration 010). A
// escrita foi protegida no banco; a leitura sem filtro reabriria o mesmo
// incidente pelo outro lado: com a v2 (Marco Zero) cadastrada, `select * from
// quiz_stages` devolveria as etapas dos dois quizzes e o prognostico de quem
// respondeu o Fort Inside receberia as 52 perguntas do Marco Zero como contexto.
//
// Separado de generate-prognostic.ts para poder ser testado sem o SDK da
// Anthropic e sem chamar o modelo.

interface Consulta extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(coluna: string, valor: string | number): Consulta;
  in(coluna: string, valores: readonly (string | number)[]): Consulta;
  order(coluna: string): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ClienteDeLeitura {
  from(tabela: string): { select(colunas: string): Consulta };
}

export type ContextoQuiz =
  | { ok: true; stages: QuizStage[]; responses: QuizResponse[]; quizVersion: number }
  | { ok: false; status: number; error: string };

export async function carregarContextoQuiz(
  supabase: ClienteDeLeitura,
  participantId: string,
  eventId: string,
): Promise<ContextoQuiz> {
  const { data: evento, error: eErr } = (await supabase
    .from("events")
    .select("quiz_version")
    .eq("id", eventId)
    .maybeSingle()) as {
    data: { quiz_version: number } | null;
    error: unknown;
  };

  if (eErr || !evento) {
    return { ok: false, status: 500, error: "Erro ao buscar etapas" };
  }

  const { data: stages, error: sErr } = (await supabase
    .from("quiz_stages")
    .select("*")
    .eq("quiz_version", evento.quiz_version)
    .order("id")) as { data: QuizStage[] | null; error: unknown };

  // Zero etapas tornaria "respondeu todas" uma verdade vazia. Na v1 a contagem
  // e exatamente TOTAL_STAGES (mesma trava de /api/complete-quiz).
  if (
    sErr ||
    !stages ||
    stages.length === 0 ||
    (evento.quiz_version === 1 && stages.length !== TOTAL_STAGES)
  ) {
    console.error("[generate-prognostic] quiz do evento com etapas inesperadas", {
      event_id: eventId,
      quiz_version: evento.quiz_version,
      encontradas: stages?.length ?? null,
    });
    return { ok: false, status: 500, error: "Erro ao buscar etapas" };
  }

  // Respostas so das etapas desta versao: nada de outra versao entra no prompt,
  // mesmo que exista linha solta no banco.
  const { data: responses, error: rErr } = (await supabase
    .from("quiz_responses")
    .select("*")
    .eq("participant_id", participantId)
    .in(
      "stage_id",
      stages.map((s) => s.id),
    )) as { data: QuizResponse[] | null; error: unknown };

  if (rErr || !responses || responses.length < stages.length) {
    return {
      ok: false,
      status: 400,
      error: "Participante não completou todas as etapas",
    };
  }

  return { ok: true, stages, responses, quizVersion: evento.quiz_version };
}
