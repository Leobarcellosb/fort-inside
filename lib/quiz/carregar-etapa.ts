import type { QuizStage } from "@/types/database";

// Localiza a etapa que o participante vai responder.
//
// A URL carrega o NUMERO DA ETAPA (`/quiz/1`), nao o id da linha. A pessoa ve
// "Etapa 1 de 5"; o banco guarda id 101. A etapa e achada pela VERSAO DO QUIZ DO
// EVENTO do participante + `stage_number` (migration 010). Na v1 o
// `stage_number` e igual ao id, entao o mesmo caminho serve para as duas.
//
// Nunca se busca por `id` cru nem sem filtro de versao: com a v2 cadastrada, um
// evento do Fort Inside passaria a enxergar etapas do Marco Zero.

// Subconjunto do cliente do Supabase que esta funcao usa. Estrutural de
// proposito: o cliente real (browser) satisfaz, e o teste injeta um falso.
interface Consulta extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ClienteDeLeitura {
  from(tabela: string): { select(colunas: string): Consulta };
}

export type ResultadoEtapa =
  | { ok: true; etapa: QuizStage; totalEtapas: number }
  | { ok: false; motivo: "numero_invalido" | "evento_inexistente" | "etapa_inexistente" | "erro" };

/** Numero de etapa valido: inteiro positivo, sem sufixo ("1abc" nao vale). */
export function lerNumeroDaEtapa(param: string): number | null {
  return /^[1-9]\d*$/.test(param) ? Number(param) : null;
}

/** Rotulo mostrado a pessoa. Usa a contagem da VERSAO, nunca uma constante. */
export function rotuloDaEtapa(numero: number, total: number): string {
  return `Etapa ${numero} de ${total}`;
}

export async function carregarEtapa(
  supabase: ClienteDeLeitura,
  eventId: string,
  numeroDaEtapa: number,
): Promise<ResultadoEtapa> {
  if (!Number.isInteger(numeroDaEtapa) || numeroDaEtapa < 1) {
    return { ok: false, motivo: "numero_invalido" };
  }

  const evento = (await supabase
    .from("events")
    .select("quiz_version")
    .eq("id", eventId)
    .maybeSingle()) as {
    data: { quiz_version: number } | null;
    error: unknown;
  };
  if (evento.error) return { ok: false, motivo: "erro" };
  if (!evento.data) return { ok: false, motivo: "evento_inexistente" };
  const versao = evento.data.quiz_version;

  const [etapa, todas] = (await Promise.all([
    supabase
      .from("quiz_stages")
      .select("*")
      .eq("quiz_version", versao)
      .eq("stage_number", numeroDaEtapa)
      .maybeSingle(),
    supabase.from("quiz_stages").select("stage_number").eq("quiz_version", versao),
  ])) as [
    { data: QuizStage | null; error: unknown },
    { data: { stage_number: number | null }[] | null; error: unknown },
  ];

  if (etapa.error || todas.error || !todas.data) return { ok: false, motivo: "erro" };
  if (!etapa.data) return { ok: false, motivo: "etapa_inexistente" };

  return { ok: true, etapa: etapa.data, totalEtapas: todas.data.length };
}
