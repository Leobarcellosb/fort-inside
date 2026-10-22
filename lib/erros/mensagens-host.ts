import type { CodigoDeErro, DetalhesDeErro } from "./codigos";
import { formatarInstante } from "../eventos/fuso";

// CÓDIGO -> MENSAGEM QUE O HOST LÊ. É o único lugar onde o texto da tela nasce.
//
// A interface nunca exibe o `error` do corpo: ele é texto do servidor e, em
// qualquer resposta que não saiba o código, pode ser "Erro" ou algo vindo do
// banco. O host lê o que está aqui, escrito para quem conduz o evento.
//
// `Record<CodigoDeErro, ...>` faz o compilador exigir uma mensagem para cada
// código do vocabulário: acrescentar um código sem dizer o que o host vê não
// compila.
//
// REGRA: "migration 018" aparece em UMA entrada, QUEUE_SCHEMA_MISSING, a única
// causa que significa isso. Um teste garante que nenhuma outra a cita.

export const MENSAGEM_FILA_INDISPONIVEL =
  "A fila de processamento não está ativa neste ambiente, então o processamento está bloqueado. Avise a equipe técnica: falta aplicar a atualização do banco da fila (migration 018). Depois de aplicada, recarregue esta página. O processamento antigo em lote foi descontinuado e não será usado no lugar.";

/** Para código desconhecido, ausente ou corpo genérico ("Erro"). Sem causa presumida. */
export const MENSAGEM_GENERICA =
  "Algo inesperado impediu o processamento. Antes de tentar de novo, confira a seção Prognósticos para ver se alguém já entrou na fila (reenviar não duplica o trabalho). Se continuar, avise a equipe técnica informando o número da ocorrência.";

type Mensagem = string | ((detalhes: DetalhesDeErro | undefined) => string);

const MENSAGENS: Record<CodigoDeErro, Mensagem> = {
  INVALID_REQUEST: "O pedido enviado pela tela não é válido. Recarregue a página e tente de novo.",

  AUTH_REQUIRED: "Sua sessão expirou ou não foi encontrada. Entre de novo como administrador.",
  ADMIN_FORBIDDEN:
    "Esta conta está conectada, mas não tem permissão de administrador para processar. Entre com uma conta de administrador.",
  AUTH_UNAVAILABLE:
    "Não foi possível confirmar sua sessão agora, porque o serviço de login não respondeu. Isso não significa que você perdeu a permissão. Aguarde alguns instantes e tente de novo.",

  EVENT_NOT_FOUND: "Este evento não foi encontrado. Recarregue a página.",
  EVENT_INCOMPLETE: (d) => {
    const a = d?.etapa_atual;
    const n = d?.total_etapas;
    return typeof a === "number" && typeof n === "number"
      ? `Ainda há etapa pendente: o evento está na etapa ${a} de ${n}. Libere todas as ${n} etapas do questionário antes de processar.`
      : "Ainda há etapa pendente: libere todas as etapas do questionário antes de processar.";
  },
  COLLECTION_OPEN: (d) => {
    // O prazo sai no FUSO DO EVENTO, identificado (lib/eventos/fuso.ts). Nunca no do
    // computador de quem lê, nunca com conta manual de UTC-3.
    const quando = formatarInstante(d?.coleta_encerra_em, d?.fuso ?? null);
    return (
      "A coleta deste evento ainda não encerrou" +
      (quando ? `: o prazo para responder termina em ${quando}` : "") +
      ", mais 15 minutos de tolerância para quem já começou. O processamento coletivo só é liberado depois do prazo, para ninguém ficar de fora. Não há etapa para liberar neste modo."
    );
  },
  EVENT_MODE_UNDETERMINED:
    "Não foi possível determinar se este evento é presencial ou assíncrono, então o processamento não foi iniciado. Tentar de novo não resolve se o dado do evento estiver faltando: avise a equipe técnica.",
  COLLECTION_WINDOW_UNDETERMINED:
    "Este evento é assíncrono, mas o prazo da coleta não está definido ou não pôde ser lido. Sem o prazo não dá para saber se a coleta encerrou, então o processamento não foi iniciado. Defina o prazo do evento ou avise a equipe técnica.",
  TIME_REFERENCE_UNAVAILABLE:
    "Não foi possível obter do banco a hora de referência para conferir o prazo da coleta, então o processamento não foi iniciado. Tente de novo em instantes; se persistir, avise a equipe técnica.",
  ASYNC_PROCESSING_MISSING:
    "O processamento de eventos assíncronos depende de uma atualização do banco que ainda não foi aplicada neste ambiente, então ele está bloqueado. Avise a equipe técnica para aplicar a atualização do banco do processamento assíncrono; depois recarregue esta página. Eventos presenciais não são afetados.",
  SNAPSHOT_UNSTABLE:
    "Há respostas sendo gravadas agora, bem no limite do prazo da coleta, então o processamento não foi iniciado: processar neste instante poderia gerar documentos sobre respostas incompletas. Nenhum documento foi gerado. Aguarde alguns instantes e tente de novo.",
  BUDGET_MEASUREMENT_MISSING:
    "A medição de consumo de IA não está ativa neste ambiente, então o processamento está bloqueado. Avise a equipe técnica: falta aplicar a atualização do banco da medição de consumo (migration 021). Depois de aplicada, recarregue esta página.",
  BUDGET_MEASUREMENT_UNAVAILABLE:
    "A medição de consumo de IA não respondeu agora. Aguarde alguns instantes e tente de novo; se persistir, avise a equipe técnica.",
  NO_COMPLETED_PARTICIPANTS:
    "Ninguém concluiu o quiz neste evento ainda, então não há o que processar.",
  PARTICIPANTS_UNAVAILABLE:
    "Não foi possível ler a lista de participantes agora, então o processamento não foi iniciado. Tente de novo em instantes; se persistir, avise a equipe técnica.",

  QUIZ_STAGES_UNAVAILABLE:
    "Não foi possível verificar as etapas do questionário deste evento. O processamento não foi iniciado. Tente de novo em instantes; se persistir, avise a equipe técnica.",
  QUIZ_STAGES_INVALID:
    "As etapas do questionário deste evento foram consultadas, mas estão inconsistentes (numeração com falha ou versão sem etapas). O processamento não foi iniciado. Avise a equipe técnica: é um problema de configuração do questionário, e tentar de novo não resolve.",

  QUEUE_SCHEMA_MISSING: MENSAGEM_FILA_INDISPONIVEL,
  QUEUE_UNAVAILABLE:
    "A fila de processamento não respondeu agora. Algumas pessoas podem já ter entrado nela: confira a seção Prognósticos antes de tentar de novo (reenviar não duplica o trabalho). Se persistir, avise a equipe técnica.",
  QUEUE_CONFIG_INVALID:
    "A configuração da fila de processamento está inválida no servidor, então o processamento não foi iniciado. Avise a equipe técnica.",

  INTERNAL_ERROR: MENSAGEM_GENERICA,
};

export function mensagemParaHost(codigo: CodigoDeErro, detalhes?: DetalhesDeErro): string {
  const m = MENSAGENS[codigo];
  return typeof m === "function" ? m(detalhes) : m;
}
