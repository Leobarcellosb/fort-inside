// VOCABULÁRIO DE CÓDIGOS DE ERRO -- atravessa servidor e interface.
//
// Decisão do responsável técnico, em suas palavras:
//   "O status HTTP continua tendo seu papel. O código de erro identifica a causa
//    de negócio ou operacional."
//   "Não conseguir consultar as etapas é diferente de conseguir consultá-las e
//    encontrar uma sequência inválida. Ambos bloqueiam a operação, mas exigem
//    investigações diferentes."
//   "Nunca presumir que o problema é a migration 018. Nunca mostrar mensagens
//    internas de banco diretamente ao host."
//
// Divisão de trabalho:
//   - o SERVIDOR emite `{ error, code, ocorrencia, detalhes? }`. O `error` é um
//     texto curto e estável para quem lê o log ou o corpo cru; NUNCA carrega texto
//     de banco, e a interface NÃO o exibe;
//   - a INTERFACE traduz `code` para a mensagem do host (mensagens-host.ts).
//     Código fora deste vocabulário, ou ausente, vira mensagem genérica segura.
//
// O STATUS HTTP é a classe do problema (400 regra, 401/403 permissão, 404
// inexistente, 500/503 operacional). O CÓDIGO é a causa. Dois códigos podem dividir
// o mesmo status (QUIZ_STAGES_UNAVAILABLE e QUIZ_STAGES_INVALID são ambos 503) --
// é justamente por isso que o status sozinho não basta.
//
// Este arquivo é puro (sem next, sem react): é importado pelas rotas e pela tela.

export const DEFINICOES_DE_ERRO = {
  // --- pedido ---------------------------------------------------------------
  /** Corpo ausente, não-JSON ou fora do formato (event_id que não é UUID). */
  INVALID_REQUEST: { status: 400, error: "Dados inválidos" },

  // --- quem pede ------------------------------------------------------------
  /** Sem sessão, ou sessão que o serviço de login recusou (expirada, inválida). */
  AUTH_REQUIRED: { status: 401, error: "Sessão ausente ou expirada" },
  /** Sessão válida de quem NÃO é administrador. É a única "falta de permissão". */
  ADMIN_FORBIDDEN: { status: 403, error: "Não autorizado" },
  /** O serviço de login não respondeu: não deu para saber quem é. NÃO é recusa. */
  AUTH_UNAVAILABLE: { status: 503, error: "Não foi possível verificar a sessão" },

  // --- o evento -------------------------------------------------------------
  EVENT_NOT_FOUND: { status: 404, error: "Evento não encontrado" },
  /** Verificado: o evento ainda não liberou todas as etapas da versão do quiz. */
  EVENT_INCOMPLETE: { status: 400, error: "Evento não completou as etapas" },
  /** Verificado: evento ASSÍNCRONO cuja coleta ainda não encerrou (o critério é o prazo, não etapa). */
  COLLECTION_OPEN: { status: 400, error: "A coleta do evento ainda não encerrou" },
  NO_COMPLETED_PARTICIPANTS: { status: 400, error: "Nenhum participante completou o quiz" },
  /** Não deu para LER os participantes -- diferente de "ninguém concluiu". */
  PARTICIPANTS_UNAVAILABLE: { status: 503, error: "Não foi possível ler os participantes" },

  // --- etapas do quiz (portão compartilhado pelas duas rotas) ----------------
  /** Não deu para saber se o evento é presencial ou assíncrono (modo ausente ou desconhecido). Bloqueia. */
  EVENT_MODE_UNDETERMINED: { status: 503, error: "Não foi possível determinar o modo do evento" },
  /** Evento assíncrono sem prazo de coleta utilizável (ausente, ilegível ou incoerente). Bloqueia. */
  COLLECTION_WINDOW_UNDETERMINED: { status: 503, error: "O prazo da coleta do evento não está definido ou não pôde ser lido" },

  /** Não deu para obter a hora de referência DO BANCO (a decisão do prazo nunca cai no relógio do Node). Bloqueia. */
  TIME_REFERENCE_UNAVAILABLE: { status: 503, error: "Não foi possível obter a hora de referência do banco" },
  /** As funções do processamento assíncrono não existem no banco (atualização ausente): a mensagem manda APLICAR. */
  ASYNC_PROCESSING_MISSING: { status: 503, error: "O processamento assíncrono não está instalado no banco" },
  /** Não se pôde garantir uma fotografia consistente das respostas (gravação em voo no limite da janela). Bloqueia. */
  SNAPSHOT_UNSTABLE: { status: 503, error: "Não foi possível garantir um conjunto consistente de respostas" },

  /** A medição de consumo de IA não está instalada no banco (migration 021 ausente): a mensagem manda APLICAR. */
  BUDGET_MEASUREMENT_MISSING: { status: 503, error: "A medição de consumo de IA não está instalada no banco" },
  /** A medição existe e não respondeu: a mensagem manda AGUARDAR e NÃO cita migration. */
  BUDGET_MEASUREMENT_UNAVAILABLE: { status: 503, error: "A medição de consumo de IA não respondeu" },

  /** NÃO conseguiu consultar as etapas (erro de leitura). Investigar o acesso ao banco. */
  QUIZ_STAGES_UNAVAILABLE: { status: 503, error: "Não foi possível verificar as etapas do questionário" },
  /** Consultou e a versão é inválida (sem etapas, stage_number nulo ou com buraco). Investigar os dados. */
  QUIZ_STAGES_INVALID: { status: 503, error: "As etapas do questionário estão inconsistentes" },

  // --- fila (só /api/jobs/enfileirar) ---------------------------------------
  /** As funções jobs_* NÃO EXISTEM no banco: migration 018 ausente. A ÚNICA causa que a menciona. */
  QUEUE_SCHEMA_MISSING: { status: 503, error: "A fila de processamento não está instalada no banco" },
  /** A fila existe, mas a chamada a ela falhou (rede, banco, timeout). */
  QUEUE_UNAVAILABLE: { status: 503, error: "A fila de processamento não respondeu" },
  /** Variável de ambiente da fila inválida no servidor. */
  QUEUE_CONFIG_INVALID: { status: 500, error: "Configuração da fila inválida" },

  // --- o que ninguém previu -------------------------------------------------
  INTERNAL_ERROR: { status: 500, error: "Erro interno" },
} as const satisfies Record<string, { status: number; error: string }>;

export type CodigoDeErro = keyof typeof DEFINICOES_DE_ERRO;

export const CODIGOS_DE_ERRO = Object.keys(DEFINICOES_DE_ERRO) as CodigoDeErro[];

export function ehCodigoDeErro(valor: unknown): valor is CodigoDeErro {
  return (
    typeof valor === "string" &&
    Object.prototype.hasOwnProperty.call(DEFINICOES_DE_ERRO, valor)
  );
}

export function statusDoCodigo(codigo: CodigoDeErro): number {
  return DEFINICOES_DE_ERRO[codigo].status;
}

/** Detalhes estruturados e seguros (números e datas): a interface os usa para compor a mensagem. */
export interface DetalhesDeErro {
  etapa_atual?: number;
  total_etapas?: number;
  /** Prazo da coleta (events.form_closes_at, ISO 8601). Não é segredo; a tela o formata. */
  coleta_encerra_em?: string;
  /** Fuso IANA do EVENTO (lib/eventos/fuso.ts), para a tela mostrar o prazo no fuso certo. */
  fuso?: string;
}

/** Corpo de toda resposta de erro das rotas de processamento. */
export interface CorpoDeErro {
  error: string;
  code: CodigoDeErro;
  /** Identificador desta ocorrência: está no log do servidor e é o que o host informa à equipe. */
  ocorrencia: string;
  detalhes?: DetalhesDeErro;
}

/** Identificador curto e citável. Não é segredo e não carrega dado pessoal. */
export function novaOcorrencia(): string {
  const id = globalThis.crypto.randomUUID().replace(/-/g, "");
  return id.slice(0, 12);
}
