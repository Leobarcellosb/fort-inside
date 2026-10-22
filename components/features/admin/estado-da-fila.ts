// O que a tela conclui da resposta de GET /api/jobs/status -- a fila está
// utilizável? Função pura, para provar com a resposta REAL da rota.
//
// REGRA, do responsável técnico: "O status HTTP continua tendo seu papel. O código
// de erro identifica a causa". Antes, `status >= 500` virava "indisponivel", e
// "indisponivel" faz o painel exibir a mensagem da MIGRATION 018 e travar o botão.
// Um soluço de banco (500/503 sem relação com esquema) mandava o host aplicar uma
// migration que já estava aplicada.
//
// Agora:
//   200 com `jobs`            -> "ok"
//   QUEUE_SCHEMA_MISSING      -> "indisponivel"  (a ÚNICA causa que significa "falta a 018")
//   qualquer outra coisa      -> "sem_resposta"  ("não consegui verificar a fila agora",
//                                 mensagem que NÃO cita migration e libera o botão
//                                 assim que a verificação funcionar)
// Isso vale para AUTH_UNAVAILABLE, AUTH_REQUIRED, ADMIN_FORBIDDEN, QUEUE_UNAVAILABLE,
// INTERNAL_ERROR, código desconhecido, corpo genérico ("Erro"), 5xx de proxy e 200
// de formato inesperado. "sem_resposta" é conservador de propósito: na dúvida o
// botão fica bloqueado (não enfileira sem saber), mas o painel não inventa causa.
import { ehCodigoDeErro, type CodigoDeErro } from "../../../lib/erros/codigos";

export type EstadoDaFila = "verificando" | "ok" | "indisponivel" | "sem_resposta";

export interface LeituraDaFila {
  fila: Exclude<EstadoDaFila, "verificando">;
  /** Código do vocabulário, quando o servidor mandou um. */
  codigo: CodigoDeErro | null;
  /** Ocorrência citável (do corpo), para registro. */
  ocorrencia: string | null;
}

export function interpretarRespostaDaFila(status: number, corpo: unknown): LeituraDaFila {
  const c = corpo && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
  const codigo = ehCodigoDeErro(c.code) ? c.code : null;
  const ocorrencia = typeof c.ocorrencia === "string" ? c.ocorrencia : null;

  if (status >= 200 && status < 300) {
    return Array.isArray(c.jobs)
      ? { fila: "ok", codigo: null, ocorrencia: null }
      : { fila: "sem_resposta", codigo: null, ocorrencia };
  }
  if (codigo === "QUEUE_SCHEMA_MISSING") return { fila: "indisponivel", codigo, ocorrencia };
  return { fila: "sem_resposta", codigo, ocorrencia };
}
