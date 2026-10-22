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
// REGRA: cada migration é citada SÓ pela mensagem do código que significa a
// ausência dela -- "migration 018" só em QUEUE_SCHEMA_MISSING, "021" só em
// BUDGET_MEASUREMENT_MISSING, "022" só em IMPORT_SCHEMA_MISSING. Um teste garante
// que nenhuma outra mensagem as cita, e que só as mensagens de AUSÊNCIA mandam
// aplicar: as de indisponibilidade mandam aguardar.

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

  // --- importação de respostas coletadas FORA do aplicativo ------------------
  // Os três fatos ficam em três textos que NÃO se parecem: um manda instalar, um
  // manda esperar, um manda corrigir o formulário. Quem lê não tem de adivinhar
  // qual dos três aconteceu.
  IMPORT_SCHEMA_MISSING:
    "A importação de respostas coletadas fora do aplicativo não está instalada neste ambiente, então nada foi conferido e nada foi gravado. Avise a equipe técnica: falta aplicar a atualização do banco da importação externa (migration 022). Depois de aplicada, recarregue esta página.",
  IMPORT_UNAVAILABLE:
    "A importação de respostas externas não respondeu agora, então nada foi gravado. Isso não quer dizer que a planilha ou o questionário estejam errados. Aguarde alguns instantes e tente de novo; se persistir, avise a equipe técnica.",
  IMPORT_MANIFEST_MISMATCH: (d) => {
    const base =
      "O questionário usado na coleta NÃO é o que o sistema conhece: algum enunciado, alternativa, escala ou ordem foi alterado no caminho. A importação foi recusada ANTES de pontuar qualquer resposta, e nada foi gravado -- pontuar estas respostas produziria número errado, e número errado não parece erro. Refaça o formulário a partir do questionário que o sistema exporta, ou confirme com a equipe técnica qual versão do questionário foi usada na coleta.";
    const dec = d?.impressao_declarada;
    const sis = d?.impressao_do_sistema;
    return dec && sis
      ? `${base} Impressão declarada pela coleta: ${dec}. Impressão do sistema: ${sis}.`
      : base;
  },
  IMPORT_MANIFEST_UNVERIFIABLE:
    "Não foi possível conferir a impressão digital do questionário da coleta, então a importação não seguiu e nada foi gravado. Isso NÃO quer dizer que o questionário está errado: quer dizer que não deu para afirmar que é o mesmo, e pontuar sem essa afirmação é o que já apagou um instrumento inteiro neste projeto. Informe a impressão digital que o sistema exportou junto com o questionário e tente de novo; se ela não estiver à mão, avise a equipe técnica.",
  IMPORT_SPREADSHEET_INVALID: (d) => {
    const porQue: Record<NonNullable<DetalhesDeErro["divergencia"]>, string> = {
      coluna_desconhecida:
        "há coluna na planilha que não corresponde a nenhum enunciado do questionário do sistema",
      coluna_ambigua: "há enunciado repetido em mais de uma coluna, e não se escolhe uma delas",
      coluna_faltando:
        "há pergunta do questionário sem coluna na planilha, o que viraria resposta ausente para a turma inteira",
      email_sem_coluna:
        "a planilha não tem coluna de e-mail, e a identidade é reconciliada por e-mail verificado",
      submissao_sem_id:
        "há linha sem identificador de submissão, e sem identificador não há procedência",
      linha_curta:
        "há linha mais curta que o cabeçalho, o que transformaria colunas truncadas em respostas ausentes",
    };
    const causa = d?.divergencia ? porQue[d.divergencia] : null;
    const onde = typeof d?.linha === "number" ? ` Linha da planilha: ${d.linha + 1}.` : "";
    const quais =
      d?.itens && d.itens.length > 0
        ? ` Em questão: ${d.itens.slice(0, 12).join(" | ")}${d.itens.length > 12 ? ` e mais ${d.itens.length - 12}` : ""}.`
        : "";
    return (
      "A planilha não foi aceita e nada foi gravado" +
      (causa ? `, porque ${causa}` : "") +
      ". Nenhuma coluna é atribuída à pergunta mais parecida: um cabeçalho reescrito à mão viraria resposta na pergunta errada, que é pior que resposta faltando porque pontua." +
      onde +
      quais +
      " Corrija os cabeçalhos para o texto exato do questionário exportado e envie a planilha outra vez."
    );
  },
  IMPORT_PLAN_REFUSED: (d) => {
    if (d?.portao === "operador") {
      return "A importação não foi autorizada porque não há operador responsável identificado, e nada foi gravado. Reconciliar identidade é um ato de alguém, registrado e reversível, nunca efeito colateral de um import. Entre de novo como administrador.";
    }
    if (d?.portao === "origem") {
      return "A importação não foi autorizada porque o formulário de origem não foi identificado, e nada foi gravado. Sem a origem não há procedência, e sem procedência não se sabe de onde veio um dado que vai virar documento sobre uma pessoa. Informe o identificador do formulário da coleta.";
    }
    if (d?.portao === "versao") {
      const a = d?.versao_declarada;
      const b = d?.versao_do_evento;
      return (
        "A importação não foi autorizada porque a coleta é de outra versão do questionário" +
        (typeof a === "number" && typeof b === "number"
          ? `: a coleta é da versão ${a} e o evento está na versão ${b}`
          : "") +
        ". Nada foi gravado e nada foi pontuado. Use a coleta da versão do evento, ou corrija a versão do evento com a equipe técnica."
      );
    }
    return "A importação não foi autorizada e nada foi gravado. Confira o formulário de origem e a versão do questionário da coleta antes de enviar outra vez.";
  },
  // NOTA DE REDAÇÃO, e o teste do vocabulário a prende: "aplicar" é o verbo de
  // domínio desta tela ("aplicar a importação") E o verbo das mensagens que mandam
  // instalar atualização de banco. Nas mensagens de erro ele fica reservado para o
  // segundo sentido; aqui se diz "confirmar" e "gravar". Sem isso, uma prévia
  // vencida pareceria pedir que a equipe técnica instalasse alguma coisa.
  IMPORT_PREVIEW_STALE:
    "A prévia que está na tela não corresponde mais ao que seria gravado: algo mudou entre a conferência e a confirmação -- os participantes do evento, o questionário, ou a própria planilha. Nada foi gravado, de propósito: gravar agora escreveria uma coisa enquanto a tela afirma outra. Gere a prévia outra vez, confira o que ela mostra e confirme a importação a partir dela.",

  // --- a decisão do operador sobre identidade --------------------------------
  // Nenhuma destas manda instalar nada e nenhuma usa o verbo reservado às
  // mensagens de ausência: aqui se diz "registrar", "confirmar" e "gravar".
  IMPORT_SUBMISSION_NOT_FOUND:
    "Esta submissão externa não foi encontrada neste evento. Ela pode ter sido removida, ou a página está mostrando uma lista antiga. Recarregue a mesa de decisões e escolha outra vez a partir do que ela mostrar.",
  IMPORT_DECISION_REFUSED: (d) => {
    const estado = d?.estado_da_submissao;
    if (d?.ato === "revogar") {
      return (
        "Não há reconciliação a revogar nesta submissão" +
        (estado ? `: ela está no estado “${estado}”` : "") +
        ". Revogar desfaz a ligação entre uma submissão e um participante; uma submissão que não está ligada a ninguém não tem o que desfazer. Nada foi alterado."
      );
    }
    if (estado === "importavel" || estado === "incompativel") {
      return "Esta submissão JÁ está reconciliada com um participante, então ela não é reconciliada de novo por cima. Para atribuí-la a outra pessoa, revogue a reconciliação atual primeiro -- a revogação fica registrada no histórico e não apaga o que já havia. Nada foi alterado.";
    }
    return "A decisão sobre esta submissão não foi autorizada: o participante escolhido não é deste evento, ou o estado da submissão mudou desde que a tela foi carregada. Nada foi registrado e nada foi gravado. Recarregue a mesa de decisões e confira antes de confirmar.";
  },
  IMPORT_DECISION_STALE:
    "A ficha que está na tela não descreve mais o que seria gravado: algo mudou entre a conferência e a confirmação -- a submissão, o participante escolhido, as respostas que ele já tem, ou o questionário. Nada foi registrado e nada foi gravado, de propósito: confirmar aqui é afirmar que uma resposta é de uma pessoa, e essa afirmação não pode se referir a uma tela velha. Recarregue a mesa de decisões, leia a ficha outra vez e confirme a partir dela.",
  IMPORT_TARGET_OCCUPIED: (d) => {
    const n = d?.respostas_existentes;
    const quantas = typeof n === "number" && n > 0 ? ` (${n} ${n === 1 ? "resposta" : "respostas"})` : "";
    const porQue =
      d?.ocupacao === "submissao_externa_ativa"
        ? "este participante já tem OUTRA submissão externa ligada a ele"
        : d?.ocupacao === "ambos"
          ? `este participante já tem resposta registrada${quantas} e já tem outra submissão externa ligada a ele`
          : `este participante já tem resposta registrada${quantas}`;
    return (
      `A submissão não foi atribuída a este participante porque ${porQue}, e nada foi alterado. ` +
      "Isto é recusado por um motivo que não tem volta: a gravação escreveria as respostas importadas por cima das que ele já tem, e revogar depois removeria as importadas sem devolver as anteriores -- a resposta antiga some para sempre. " +
      "Confira se é a mesma pessoa. Se for, e se as respostas importadas forem as que devem valer, revogue primeiro a reconciliação da submissão que já está ligada a ele; se não for, escolha outro participante."
    );
  },
  IMPORT_REVALIDATION_REFUSED: (d) => {
    const porQue: Record<NonNullable<DetalhesDeErro["revalidacao"]>, string> = {
      resposta_do_aplicativo:
        "entre a sua conferência e a sua confirmação, esse participante respondeu PELO APLICATIVO nas mesmas etapas. A resposta dele vale e fica; a importada foi recusada",
      outra_submissao_externa:
        "essas etapas já têm resposta de OUTRA submissão externa. Trocar uma coleta por outra em silêncio não é atualização, é conflito",
      outra_submissao_ativa_do_participante:
        "esse participante já tem outra submissão externa ligada a ele",
      duplicidade_no_lote: "outra submissão do mesmo envio já gravou para esse participante",
      participante_inexistente: "o participante escolhido não existe mais",
      participante_fora_do_evento: "o participante escolhido não é mais deste evento",
      email_do_participante_mudou: "o e-mail do participante mudou depois que a ficha foi gerada",
    };
    const causa = d?.revalidacao ? porQue[d.revalidacao] : null;
    return (
      "O banco conferiu na hora de gravar e RECUSOU" +
      (causa ? `, porque ${causa}` : "") +
      ". NENHUMA resposta foi gravada e nada que já existia foi tocado -- a resposta que o participante tinha continua como estava. " +
      "A sua decisão e esta recusa ficam as duas no histórico: o que você decidiu não é apagado, e fica registrado que não foi efetivada. " +
      "A submissão volta para a mesa, com o payload inteiro. Recarregue a mesa, leia a ficha nova e decida a partir dela."
    );
  },
  IMPORT_REVOKE_BLOCKED:
    "Esta reconciliação NÃO é desfeita por aqui, porque já existe documento gerado a partir destas respostas -- e pode ter sido revisado, entregue ou compartilhado por link. Remover as respostas agora deixaria o documento de pé, falando sobre a pessoa errada, e nada foi alterado. O caminho é outro, e é excepcional: invalidar o documento derivado, suspender o acesso indevido (inclusive o link público, se houver) e só então corrigir a identidade, com registro de quem autorizou. Fale com a equipe técnica antes de qualquer passo -- o registro da submissão continua preservado e nada se perde nesse meio-tempo.",
  IMPORT_DERIVATIVES_UNVERIFIABLE:
    "Não foi possível verificar se já existe documento ou pontuação gerados a partir destas respostas, então nada foi alterado. Isso NÃO quer dizer que existe nem que não existe: quer dizer que não deu para afirmar, e sem essa resposta não se pode dizer se a decisão seria reversível. Aguarde alguns instantes e tente de novo; se persistir, avise a equipe técnica.",
  IMPORT_ACT_NOT_APPLIED:
    "Sua decisão FOI registrada no histórico, com seu nome e sua justificativa, e NÃO foi efetivada: nenhuma resposta foi gravada e a submissão continua sem participante. O histórico guarda o ato sem o efeito, que é o registro honesto do que aconteceu. Aguarde alguns instantes e confirme outra vez a partir da mesa de decisões; o histórico vai mostrar as duas tentativas, e é assim que se vê o que de fato pegou.",

  QUEUE_SCHEMA_MISSING: MENSAGEM_FILA_INDISPONIVEL,
  QUEUE_UNAVAILABLE:
    "A fila de processamento não respondeu agora. Algumas pessoas podem já ter entrado nela: confira a seção Prognósticos antes de tentar de novo (reenviar não duplica o trabalho). Se persistir, avise a equipe técnica.",
  QUEUE_CONFIG_INVALID:
    "A configuração da fila de processamento está inválida no servidor, então o processamento não foi iniciado. Avise a equipe técnica.",

  // --- Guia de Preparação do Facilitador -------------------------------------
  // As três recusas previstas do gerador, cada uma mandando fazer uma coisa
  // diferente. Nenhuma manda instalar nada, e nenhuma usa o verbo reservado às
  // mensagens de ausência de atualização de banco.
  GUIDE_DNA_PUBLISHED:
    "Este evento já tem DNA Coletivo disponibilizado, com a revisão metodológica registrada, então o Guia de Preparação do Facilitador não foi gerado. O guia é o material de condução do evento que NÃO tem esse documento; entregar os dois ao mesmo tempo faria um parecer complemento do outro. Use o DNA Coletivo disponibilizado e, para as conversas individuais, os one-pagers.",
  GUIDE_DNA_STATE_UNVERIFIABLE:
    "Não foi possível verificar se este evento já tem um DNA Coletivo disponibilizado, e por isso o guia não foi gerado. Isso NÃO quer dizer que exista um DNA disponibilizado, e também não quer dizer que não exista: quer dizer que não deu para saber, e gerar o guia sem saber poderia entregá-lo ao lado de um documento que o facilitador já recebeu. Aguarde alguns instantes e tente de novo; se persistir, avise a equipe técnica informando o número da ocorrência.",
  GUIDE_DATA_INCONSISTENT:
    "As contagens de participação deste evento não fecham entre si, então o guia não foi gerado. Um guia com a população errada afirmaria a coisa errada sobre o que foi verificado. Confira a lista de convidados, os check-ins e as respostas registradas deste evento antes de gerar outra vez.",

  COVERAGE_UNAVAILABLE:
    "A cobertura oficial deste evento não respondeu agora, e sem ela não há população verificada para o guia nem veredito do volume mínimo. Nada foi gerado. Aguarde alguns instantes e tente de novo; se persistir, avise a equipe técnica informando o número da ocorrência.",
  INVITE_COUNT_UNDETERMINED:
    "O total de convidados deste evento não está determinado: não há fotografia da lista de convites, ou ela não fecha com as pessoas registradas nela. O guia não foi gerado porque as contagens de participação sairiam sobre um total estimado, e estimativa não é população verificada. Encerre a lista de convites do evento e tente de novo.",

  INTERNAL_ERROR: MENSAGEM_GENERICA,
};

export function mensagemParaHost(codigo: CodigoDeErro, detalhes?: DetalhesDeErro): string {
  const m = MENSAGENS[codigo];
  return typeof m === "function" ? m(detalhes) : m;
}
