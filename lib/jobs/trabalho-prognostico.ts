// O trabalho que a fila enfileira hoje: gerar o prognóstico de um participante.
//
// Arquivo separado do executor de propósito. Importar `generate-prognostic`
// instancia o SDK da Anthropic no carregamento do módulo; mantendo o adaptador
// isolado, toda a prova da fila (reivindicação, lease, fencing, recuperação,
// concorrência) roda com um trabalho simulado, sem SDK e sem gastar crédito.
//
// Aqui NÃO há regra de fila nenhuma: só a tradução do contrato de
// `generatePrognostic` para o vocabulário de desfecho do job.

import { generatePrognostic } from "../ai/generate-prognostic";
import type { Trabalho } from "./executor";

export const trabalhoPrognostico: Trabalho = async (job, sinal) => {
  // Portão barato antes de gastar Opus. Se o lease já foi tomado, o resultado
  // desta tentativa seria recusado pelo fencing -- chamar o modelo aqui seria
  // pagar por lixo.
  //
  // Isto NÃO é o que corta o consumo no meio da chamada: `generatePrognostic`
  // não aceita AbortSignal e fica ~63s dentro de um único
  // `anthropic.messages.stream()`, sem ponto de checagem. Quem corta é o
  // executor, abortando o signal da tentativa -- que `lib/jobs/aborto.ts`
  // amarrou a todo fetch feito aqui dentro, inclusive os do SDK da Anthropic.
  // Ver a prova em `lib/jobs/aborto.test.ts`.
  if (sinal.perdido || sinal.signal.aborted) {
    return {
      desfecho: "failed",
      erro: "lease perdido antes de chamar o modelo; nada foi gerado",
      codigo: "lease_perdido",
    };
  }

  const r = await generatePrognostic(job.participantId, job.eventId);

  if (r.ok) {
    return {
      desfecho: "succeeded",
      // `result` do job é o rastro do que esta tentativa produziu. `ai_usage`
      // fica NULL porque generatePrognostic descarta o `message.usage` da
      // Anthropic (limitação 1 da migration 018). O proxy de custo continua
      // sendo `attempts`.
      resultado: { prognostic_id: r.prognosticId, trail: r.trail },
    };
  }

  // 409 = o documento avançou de estado (in_review/reviewed/delivered) e a
  // regeração foi recusada DE PROPÓSITO pela migration 015. Isso é PULADO, não
  // falha: o documento está íntegro, só não era para ser refeito. Mesmo
  // tratamento que o lote de hoje dá.
  if (r.status === 409) {
    return { desfecho: "skipped", motivo: r.error };
  }

  return {
    desfecho: "failed",
    erro: r.error,
    // O código vai para `last_error_code` e é o que permite agrupar falhas sem
    // ler texto livre: http_404 (entrada errada), http_502 (recusa da IA),
    // http_500 (saída inválida ou erro ao gravar).
    codigo: `http_${r.status}`,
  };
};
