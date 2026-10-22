// Classificação de quem foi gerado, pulado ou falhou numa rodada do lote
// (/api/batch-process), feita pela própria tela comparando o estado dos
// prognósticos ANTES e DEPOIS. Função pura, separada do componente para poder ser
// provada em teste (inclusive no teste das duas sessões).
//
// "pulado" aqui é o RESULTADO desta rodada, não o estado do documento.

export interface BatchSummary {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface PrognosticSnapshot {
  status: string;
  generated_at: string | null;
}

export interface BatchPerson {
  id: string;
  name: string;
}

export interface BatchOutcome {
  summary: BatchSummary;
  /** true quando os grupos de nomes batem com os contadores da rota. */
  identified: boolean;
  generated: BatchPerson[];
  skipped: (BatchPerson & { status: string })[];
  failed: BatchPerson[];
}

// Estados a partir dos quais a rota recusa regerar (espelha ESTADOS_REGERAVEIS em
// lib/ai/generate-prognostic.ts: pending, generating e generated podem regerar).
const ESTADOS_PROTEGIDOS = ["in_review", "reviewed", "delivered"];

export function classifyBatch(
  people: BatchPerson[],
  before: Map<string, PrognosticSnapshot> | null,
  after: Map<string, PrognosticSnapshot> | null,
  summary: BatchSummary
): BatchOutcome {
  const outcome: BatchOutcome = { summary, identified: false, generated: [], skipped: [], failed: [] };
  if (!before || !after) return outcome;

  for (const person of people) {
    const b = before.get(person.id);
    const a = after.get(person.id);
    if (b && ESTADOS_PROTEGIDOS.includes(b.status)) {
      outcome.skipped.push({ ...person, status: b.status });
    } else if (a && (!b || a.generated_at !== b.generated_at)) {
      // generated_at é regravado a cada geração concluída; se não mudou, esta
      // rodada não gerou nada para a pessoa (mesmo que exista um documento antigo).
      outcome.generated.push(person);
    } else {
      outcome.failed.push(person);
    }
  }

  outcome.identified =
    people.length === summary.total &&
    outcome.generated.length === summary.succeeded &&
    outcome.skipped.length === summary.skipped &&
    outcome.failed.length === summary.failed;
  return outcome;
}

