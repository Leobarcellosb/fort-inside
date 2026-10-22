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

  // --- importação de respostas coletadas FORA do aplicativo (/api/importacao/*)
  //
  // A distinção que governa esta família, e que é a razão de ela ter seis códigos
  // em vez de um: "não consegui verificar", "verifiquei e NÃO permiti" e "o
  // recurso não está instalado" são TRÊS FATOS DIFERENTES. Colapsá-los manda o
  // operador investigar a coisa errada -- e, no caso do manifesto, manda-o
  // reescrever um formulário que talvez esteja certo.
  //
  //   não instalado      IMPORT_SCHEMA_MISSING        (a ÚNICA que cita a 022)
  //   não respondeu      IMPORT_UNAVAILABLE
  //   respondeu e se contradiz  IMPORT_WRITE_UNVERIFIABLE (não se afirma nem que
  //                      gravou nem que não gravou)
  //   não deu p/ conferir IMPORT_MANIFEST_UNVERIFIABLE
  //   conferi e recusei  IMPORT_MANIFEST_MISMATCH, IMPORT_SPREADSHEET_INVALID,
  //                      IMPORT_PLAN_REFUSED, IMPORT_PREVIEW_STALE

  /** As tabelas e a função `importacao_externa_aplicar` NÃO EXISTEM no banco. A ÚNICA causa que menciona a 022. */
  IMPORT_SCHEMA_MISSING: { status: 503, error: "A importação de respostas externas não está instalada no banco" },
  /** A importação existe e a chamada falhou (rede, banco, timeout). NÃO é ausência e NÃO é recusa. */
  IMPORT_UNAVAILABLE: { status: 503, error: "A importação de respostas externas não respondeu" },
  /**
   * A gravação RESPONDEU, e a resposta se CONTRADIZ: ela afirma que o lote foi
   * recusado e ao mesmo tempo informa escrita (linhas gravadas, itens registrados
   * ou `por_estado` não-vazio), ou afirma que gravou e nomeia submissões
   * recusadas. Nenhuma das duas coisas pode ser afirmada a partir dela.
   *
   * É um QUARTO fato, e não um dos três: não é "não está instalado", não é "não
   * respondeu" (respondeu), e não é "conferi e recusei" (a recusa é justamente o
   * que não se pode afirmar). Colapsá-lo em IMPORT_UNAVAILABLE faria a tela dizer
   * "nada foi gravado" sobre um corpo que afirma linhas gravadas -- e afirmar
   * falsamente que nada foi escrito é pior que o enigma: enigma deixa quem lê
   * desconfiado, afirmação falsa deixa tranquilo.
   */
  IMPORT_WRITE_UNVERIFIABLE: {
    status: 503,
    error: "A resposta da gravação da importação se contradiz",
  },
  /** CONFERIDO: a impressão digital do questionário da coleta NÃO é a do sistema. Recusa ANTES de pontuar. */
  IMPORT_MANIFEST_MISMATCH: { status: 400, error: "O questionário da coleta não é o do sistema" },
  /** NÃO deu para conferir a impressão (não declarada, ou não é SHA-256). NÃO é "bate" nem "não bate". */
  IMPORT_MANIFEST_UNVERIFIABLE: { status: 503, error: "Não foi possível conferir a impressão digital do questionário" },
  /** CONFERIDO: os cabeçalhos da planilha não correspondem ao questionário (coluna sobrando, faltando, ambígua, sem e-mail). */
  IMPORT_SPREADSHEET_INVALID: { status: 400, error: "As colunas da planilha não correspondem ao questionário" },
  /** CONFERIDO: o plano foi recusado por falta de operador, de origem, ou por versão divergente. */
  IMPORT_PLAN_REFUSED: { status: 400, error: "A importação não foi autorizada" },
  /** CONFERIDO: o que seria gravado deixou de ser o que a prévia mostrou. Nada foi gravado. */
  IMPORT_PREVIEW_STALE: { status: 400, error: "A prévia não corresponde mais ao que seria gravado" },

  // --- a DECISÃO DO OPERADOR sobre identidade (/api/importacao/reconciliar e
  //     /api/importacao/revogar)
  //
  // Reconciliar à mão é afirmar "esta submissão é desta pessoa" SEM que o sistema
  // tenha verificado. É poder sobre dado de outra pessoa, então a família tem
  // códigos próprios: colapsá-los em IMPORT_PLAN_REFUSED diria "não autorizado"
  // para cinco fatos diferentes, e quatro deles têm correção diferente.

  /** CONFERIDO: a submissão não existe neste evento (id trocado, ou evento errado). */
  IMPORT_SUBMISSION_NOT_FOUND: { status: 404, error: "Submissão externa não encontrada neste evento" },
  /** CONFERIDO e NÃO PERMITIDO: a decisão não cabe no estado atual (já reconciliada, nada a revogar, participante de outro evento). */
  IMPORT_DECISION_REFUSED: { status: 400, error: "A decisão sobre esta submissão não foi autorizada" },
  /** CONFERIDO: a ficha que o operador viu não é a de agora. Nada foi decidido e nada foi gravado. */
  IMPORT_DECISION_STALE: { status: 400, error: "A ficha da decisão não corresponde mais ao estado atual" },
  /** CONFERIDO e NÃO PERMITIDO: o participante escolhido já tem resposta própria -- gravar por cima não teria volta. */
  IMPORT_TARGET_OCCUPIED: { status: 400, error: "O participante escolhido já tem resposta registrada" },
  /** O ato FOI registrado no histórico e NÃO foi efetivado: nenhuma resposta gravada. Nem recusa nem ausência. */
  IMPORT_ACT_NOT_APPLIED: { status: 503, error: "A decisão foi registrada e não foi efetivada" },
  /**
   * O BANCO conferiu NA HORA DE GRAVAR, dentro da transação, e recusou: a resposta
   * canônica daquelas etapas passou a ter outro dono entre a conferência e a
   * confirmação (migration 024). É a segunda camada do portão, não a primeira:
   * IMPORT_TARGET_OCCUPIED recusa ANTES de escrever, com o que a tela já mostrava;
   * este código é o que sobra quando a corrida acontece no meio.
   */
  IMPORT_REVALIDATION_REFUSED: { status: 400, error: "A gravação foi recusada na revalidação do banco" },
  /**
   * CONFERIDO e NÃO PERMITIDO: já existe DOCUMENTO gerado, revisado ou entregue a
   * partir destas respostas. Desfazer deixou de ser ação simples -- os derivados
   * têm de ser invalidados e o acesso indevido suspenso antes, por procedimento
   * excepcional. Não é "não autorizado" genérico: é "este caminho não serve mais".
   */
  IMPORT_REVOKE_BLOCKED: { status: 400, error: "Há documento gerado a partir destas respostas" },
  /**
   * NÃO DEU PARA VERIFICAR se há documento ou pontuação derivada. Sem isso não se
   * pode afirmar se a decisão é reversível por ação simples -- e afirmar que é,
   * sem ter conferido, é a promessa que não se pode cumprir depois.
   */
  IMPORT_DERIVATIVES_UNVERIFIABLE: { status: 503, error: "Não foi possível verificar os documentos derivados" },

  // --- Guia de Preparação do Facilitador (/api/marco-zero/guia-facilitador)
  //
  // O guia é a contingência do evento que NÃO tem DNA Coletivo publicado. As
  // três recusas abaixo são os três fatos que o gerador prevê, e são fatos
  // DIFERENTES: "há um DNA publicado" é uma recusa verificada; "não deu para
  // saber se há" é indisponibilidade; "os dados não fecham" é terceira coisa.
  // Colapsá-los diria ao host para fazer a coisa errada -- procurar um DNA que
  // talvez não exista, ou corrigir dados que talvez estejam certos.

  /** CONFERIDO: há DNA Coletivo válido, revisado e disponibilizado para estes dados. O guia não é alternativa simultânea a ele. */
  GUIDE_DNA_PUBLISHED: { status: 400, error: "Este evento já tem DNA Coletivo disponibilizado" },
  /** NÃO deu para saber se há DNA Coletivo disponibilizado. NÃO é "não há": indisponibilidade bloqueia o guia. */
  GUIDE_DNA_STATE_UNVERIFIABLE: { status: 503, error: "Não foi possível verificar o estado do DNA Coletivo" },
  /** CONFERIDO: as contagens de participação do evento não fecham entre si. */
  GUIDE_DATA_INCONSISTENT: { status: 400, error: "Os dados de participação do evento não fecham" },

  // --- o DOCUMENTO INDIVIDUAL (geração, revisão e entrega)
  //
  // A mesma distinção de sempre, aplicada ao documento que o jovem recebe:
  // "não consegui gravar", "conferi e recusei" e "o recurso não está instalado"
  // são fatos diferentes. Recusar por DADO INSUFICIENTE não é erro de servidor:
  // é desfecho previsto, com código próprio e mensagem que diz o que falta.

  /**
   * CONFERIDO pelo motor de pontuação: faltam perguntas acima do limiar
   * (lib/ai/completude-marco-zero.ts). Nenhuma chamada ao modelo foi feita e
   * nenhum documento foi gravado. `detalhes.itens` nomeia o que falta.
   */
  PROGNOSTIC_RESPONSES_INSUFFICIENT: { status: 400, error: "As respostas não bastam para gerar o documento" },
  /** CONFERIDO: há valor PRESENTE e ilegível (fora do domínio do motor). Não é "não respondeu": é dado errado. */
  PROGNOSTIC_RESPONSES_UNREADABLE: { status: 422, error: "Há resposta ilegível no questionário" },
  /** CONFERIDO e NÃO PERMITIDO: o documento já avançou (entregue) e não volta para revisão. */
  PROGNOSTIC_STATE_REGRESSION: { status: 400, error: "O documento não volta para o estado de revisão" },
  /**
   * CONFERIDO e NÃO PERMITIDO pelo banco (migration 027): só um documento
   * ENTREGUE sai do ar. É um fato DIFERENTE de PROGNOSTIC_STATE_REGRESSION e
   * colapsá-los mandaria o operador investigar a coisa errada: lá o documento
   * está adiante do que se pediu, aqui ele está ATRÁS -- ninguém leu nada, e não
   * há o que tirar do ar. A correção também é outra: lá é "não insista", aqui é
   * "entregue primeiro, se for para entregar".
   */
  PROGNOSTIC_SUSPENSION_REFUSED: { status: 400, error: "Só um documento entregue pode sair do ar" },
  /**
   * CONFERIDO e NÃO PERMITIDO pelo banco (migration 025): o conteúdo a entregar
   * não é o conteúdo aprovado, ou não há aprovação vigente sobre ele.
   */
  PROGNOSTIC_APPROVAL_STALE: { status: 400, error: "A aprovação não cobre este conteúdo" },
  /** CONFERIDO: não existe documento com este identificador. */
  PROGNOSTIC_NOT_FOUND: { status: 404, error: "Documento não encontrado" },
  /** NÃO DEU PARA GRAVAR: o banco não respondeu ou falhou por causa não prevista. Nem recusa nem ausência. */
  PROGNOSTIC_WRITE_UNAVAILABLE: { status: 503, error: "Não foi possível gravar o documento" },

  /** A consulta oficial de cobertura do Marco Zero não respondeu. Sem ela não há denominador nem veredito de volume. */
  COVERAGE_UNAVAILABLE: { status: 503, error: "A cobertura oficial do evento não respondeu" },
  /** Verificado: o banco não tem fotografia de convite utilizável, então o total de convidados não é conhecido. */
  INVITE_COUNT_UNDETERMINED: { status: 503, error: "O total de convidados do evento não está determinado" },

  // --- a LIBERAÇÃO DE ETAPA pelo painel ao vivo (migration 028)
  //
  // O painel ao vivo não passa por rota de API para liberar etapa: ele grava
  // `events.current_stage` DIRETO na tabela, pelo cliente do navegador. Até a
  // migration 028 não havia gatilho, CHECK nem restrição nenhuma sobre esse
  // campo -- foi medido: etapa 6 num evento de cinco etapas, etapa 3 num evento
  // assíncrono e etapa 99 eram todas ACEITAS por uma sessão de administrador.
  // A contenção que existia era só de interface (etapas-do-painel.ts): a tela
  // parou de OFERECER a operação, e o sistema não parou de ACEITÁ-LA.
  //
  // A 028 pôs a trava no banco. Esta família é o que a tela diz quando ela
  // recusa, e ela tem a MESMA divisão de sempre, porque são fatos diferentes
  // com correções diferentes:
  //
  //   conferi e recusei          STAGE_RELEASE_MODE_MISMATCH (a operação não se
  //                              aplica ao evento -- nada a corrigir)
  //                              STAGE_RELEASE_STAGE_ABSENT (a tela está velha
  //                              -- recarregar resolve)
  //   não deu p/ verificar       STAGE_RELEASE_STAGES_UNUSABLE (configuração do
  //                              questionário; tentar de novo não resolve)
  //   recusou e não nomeou       STAGE_RELEASE_REFUSED_UNNAMED (o banco conferiu
  //                              e recusou com um nome que esta versão da tela
  //                              não conhece: nada foi gravado, e a tela NÃO
  //                              inventa a causa)
  //   não consegui gravar        STAGE_RELEASE_UNAVAILABLE (não se afirma recusa:
  //                              não se sabe se foi)
  //
  // NÃO há código para "a trava não está instalada". A ausência da 028 não
  // produz erro nenhum -- produz uma gravação que PASSA --, então a tela não tem
  // como detectá-la a partir de um sucesso. Quem cobre essa ausência é o guarda
  // de drift (`scripts/drift`), comparando o banco com as migrations; não há
  // mensagem de host possível para um fato que o aplicativo não observa.

  /** CONFERIDO pelo banco e NÃO PERMITIDO: o evento não é `live`, e liberar etapa não existe nesses modos. */
  STAGE_RELEASE_MODE_MISMATCH: { status: 400, error: "Este evento não libera etapa" },
  /** CONFERIDO pelo banco e NÃO PERMITIDO: a etapa não existe na versão do questionário do evento. */
  STAGE_RELEASE_STAGE_ABSENT: { status: 400, error: "A etapa não existe na versão do questionário do evento" },
  /** NÃO DEU PARA VERIFICAR: a versão do questionário do evento não tem lista de etapas utilizável. */
  STAGE_RELEASE_STAGES_UNUSABLE: { status: 503, error: "As etapas da versão do questionário do evento não são utilizáveis" },
  /** O banco RECUSOU e nomeou a causa com um nome fora deste vocabulário. Nada foi gravado; a causa não se afirma. */
  STAGE_RELEASE_REFUSED_UNNAMED: { status: 503, error: "A liberação de etapa foi recusada por causa não nomeada" },
  /** NÃO DEU PARA GRAVAR: o banco não respondeu ou falhou por causa não prevista. Nem recusa nem ausência. */
  STAGE_RELEASE_UNAVAILABLE: { status: 503, error: "Não foi possível liberar a etapa" },

  // --- o FORMULÁRIO PÚBLICO (link sem login, /api/formulario-publico)
  //
  // Família própria, fora de `CodigoDeErro`, pela mesma razão das outras duas:
  // quem a recebe é a tela pública do formulário, e as telas de processamento e
  // de importação nunca veem este código.
  //
  //   gravei                     200 (resposta oficial, ou segunda resposta
  //                              CONFIRMADA na mesa de decisão)
  //   recusei                    404/409/422/400 (evento, prazo, obrigatória)
  //   não consegui gravar        PUBLIC_FORM_WRITE_UNAVAILABLE -- o armazenamento
  //                              próprio (participants/quiz_responses, ou a mesa
  //                              `external_submissions`) não confirmou a gravação.
  //                              NÃO é recusa e NÃO é "guardado em outro lugar":
  //                              não existe reserva em `event_logs` para conteúdo
  //                              de resposta. A pessoa ainda tem o rascunho e
  //                              reenvia o mesmo conteúdo.

  /** NÃO DEU PARA GRAVAR: o armazenamento próprio do formulário não confirmou a gravação. Nada foi dado como recebido. */
  PUBLIC_FORM_WRITE_UNAVAILABLE: { status: 503, error: "Não foi possível gravar o envio do formulário" },

  // --- o que ninguém previu -------------------------------------------------
  INTERNAL_ERROR: { status: 500, error: "Erro interno" },
} as const satisfies Record<string, { status: number; error: string }>;

// A FAMÍLIA DO DOCUMENTO INDIVIDUAL (prefixo `PROGNOSTIC_`) está na MESMA tabela
// de status e texto -- um código, um lugar -- mas FORA do tipo `CodigoDeErro`.
//
// Por que essa separação existe, escrito aqui para quem for juntá-las:
//   `CodigoDeErro` é consumido por MAPAS EXAUSTIVOS nas telas de processamento e
//   de importação (`components/features/admin/processar-evento.ts` e
//   `components/features/admin/importar-respostas.ts`), e essas telas NUNCA
//   recebem um código desta família: quem a emite é /api/generate-prognostic e
//   /api/prognostics/[id], que têm tela própria (o painel de revisão). Fechar
//   aqueles mapas sobre os códigos que eles de fato recebem é mais honesto do
//   que obrigá-los a classificar um desfecho que não chega até lá.
//   Juntar as duas famílias depois é remover o `Exclude` destas duas linhas e
//   classificar os seis códigos naqueles dois mapas.
export type CodigoDeErroDocumento = Extract<
  keyof typeof DEFINICOES_DE_ERRO,
  `PROGNOSTIC_${string}`
>;
/**
 * A FAMÍLIA DA LIBERAÇÃO DE ETAPA (prefixo `STAGE_RELEASE_`), fora de
 * `CodigoDeErro` pela MESMA razão da família do documento, escrita acima: quem
 * emite estes códigos é o painel ao vivo, lendo a recusa do gatilho da migration
 * 028 numa gravação DIRETA à tabela -- não há rota de API no caminho, e as telas
 * de processamento e de importação nunca recebem um código desta família. Fechar
 * os mapas exaustivos daquelas telas sobre os códigos que elas de fato recebem é
 * mais honesto do que obrigá-las a classificar um desfecho que não chega lá.
 */
export type CodigoDeLiberacaoDeEtapa = Extract<
  keyof typeof DEFINICOES_DE_ERRO,
  `STAGE_RELEASE_${string}`
>;
/**
 * A FAMÍLIA DO FORMULÁRIO PÚBLICO (prefixo `PUBLIC_FORM_`), fora de
 * `CodigoDeErro` pela mesma razão das duas acima: só a tela pública do
 * formulário recebe estes códigos.
 */
export type CodigoDoFormularioPublico = Extract<
  keyof typeof DEFINICOES_DE_ERRO,
  `PUBLIC_FORM_${string}`
>;
export type CodigoDeErro = Exclude<
  keyof typeof DEFINICOES_DE_ERRO,
  CodigoDeErroDocumento | CodigoDeLiberacaoDeEtapa | CodigoDoFormularioPublico
>;
/** Qualquer código do vocabulário, de todas as famílias. É o que `erroHttp` aceita. */
export type TodoCodigoDeErro =
  | CodigoDeErro
  | CodigoDeErroDocumento
  | CodigoDeLiberacaoDeEtapa
  | CodigoDoFormularioPublico;

const EH_DOCUMENTO = (k: string) => k.startsWith("PROGNOSTIC_");
const EH_LIBERACAO_DE_ETAPA = (k: string) => k.startsWith("STAGE_RELEASE_");
const EH_FORMULARIO_PUBLICO = (k: string) => k.startsWith("PUBLIC_FORM_");
/** Tem família própria, ou seja, está FORA do tipo `CodigoDeErro`. */
const EH_FAMILIA_PROPRIA = (k: string) =>
  EH_DOCUMENTO(k) || EH_LIBERACAO_DE_ETAPA(k) || EH_FORMULARIO_PUBLICO(k);

export const CODIGOS_DE_ERRO = Object.keys(DEFINICOES_DE_ERRO).filter(
  (k) => !EH_FAMILIA_PROPRIA(k),
) as CodigoDeErro[];

export const CODIGOS_DE_ERRO_DOCUMENTO = Object.keys(DEFINICOES_DE_ERRO).filter(
  EH_DOCUMENTO,
) as CodigoDeErroDocumento[];

export const CODIGOS_DE_LIBERACAO_DE_ETAPA = Object.keys(DEFINICOES_DE_ERRO).filter(
  EH_LIBERACAO_DE_ETAPA,
) as CodigoDeLiberacaoDeEtapa[];

export const CODIGOS_DO_FORMULARIO_PUBLICO = Object.keys(DEFINICOES_DE_ERRO).filter(
  EH_FORMULARIO_PUBLICO,
) as CodigoDoFormularioPublico[];

/**
 * Reconhece um código das telas de processamento/importação. NÃO reconhece a
 * família do documento individual: devolver `true` para ela faria aqueles mapas
 * exaustivos serem indexados com uma chave que não têm, e o resultado seria
 * `undefined` em tempo de execução -- um furo pior do que o código desconhecido,
 * que já tem caminho seguro (mensagem genérica).
 */
export function ehCodigoDeErro(valor: unknown): valor is CodigoDeErro {
  return (
    typeof valor === "string" &&
    !EH_FAMILIA_PROPRIA(valor) &&
    Object.prototype.hasOwnProperty.call(DEFINICOES_DE_ERRO, valor)
  );
}

export function ehCodigoDeErroDocumento(
  valor: unknown,
): valor is CodigoDeErroDocumento {
  return (
    typeof valor === "string" &&
    EH_DOCUMENTO(valor) &&
    Object.prototype.hasOwnProperty.call(DEFINICOES_DE_ERRO, valor)
  );
}

export function ehCodigoDeLiberacaoDeEtapa(
  valor: unknown,
): valor is CodigoDeLiberacaoDeEtapa {
  return (
    typeof valor === "string" &&
    EH_LIBERACAO_DE_ETAPA(valor) &&
    Object.prototype.hasOwnProperty.call(DEFINICOES_DE_ERRO, valor)
  );
}

export function statusDoCodigo(codigo: TodoCodigoDeErro): number {
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

  // --- importação externa ---------------------------------------------------
  // Tudo aqui é dado que o OPERADOR já tem em mãos (a impressão que ele declarou,
  // os cabeçalhos da planilha dele) ou um número. Nunca texto interno de banco.

  /** Impressão digital do questionário DECLARADA pela coleta (hex de 64 dígitos; não é segredo). */
  impressao_declarada?: string;
  /** Impressão digital do questionário DO SISTEMA (hex de 64 dígitos). */
  impressao_do_sistema?: string;
  /** Cabeçalhos de coluna ou ids de pergunta que causaram a recusa, nomeados -- não contados. */
  itens?: string[];
  /** Classe da divergência da planilha, para a tela decidir sem interpretar texto. */
  divergencia?:
    | "coluna_desconhecida"
    | "coluna_ambigua"
    | "coluna_faltando"
    | "email_sem_coluna"
    | "submissao_sem_id"
    | "linha_curta";
  /** Qual portão do planejador recusou (lib/importacao/planejar-importacao.ts). */
  portao?: "operador" | "origem" | "versao";
  /** Linha da planilha (contada de 0) quando a recusa é de uma linha específica. */
  linha?: number;
  /** Versão do questionário envolvida na divergência. */
  versao_declarada?: number;
  versao_do_evento?: number;

  // --- decisão do operador sobre identidade ---------------------------------
  // Tudo aqui é o que a própria tela do operador já mostra: o estado da submissão
  // que ele escolheu e por que o alvo está ocupado. Nunca texto interno de banco,
  // nunca e-mail de terceiro (o e-mail aparece na FICHA, não na mensagem de erro).

  /** Estado em que a submissão está AGORA, quando é ele que impede a decisão. */
  estado_da_submissao?: "importavel" | "incompativel" | "pendente" | "conflito" | "revogada";
  /** Por que o participante escolhido não pode receber esta submissão. */
  ocupacao?: "respostas_canonicas" | "submissao_externa_ativa" | "ambos";
  /** Quantas respostas o participante escolhido já tem. Número, não lista. */
  respostas_existentes?: number;
  /**
   * Qual ato o operador tentou. `importar_lote` é a importação de uma planilha
   * inteira (/api/importacao/aplicar); os outros dois são a decisão sobre UMA
   * submissão. O ato muda o que o operador tem de fazer em seguida -- pedir uma
   * prévia nova sem as conflitantes não é o mesmo que recarregar a mesa --, então
   * ele é DECLARADO pelo servidor e não adivinhado pela tela.
   */
  ato?: "reconciliar" | "revogar" | "importar_lote";
  /**
   * Em qual dos três estados do contrato de reversibilidade a decisão cai.
   * `correcao_simples` desfaz com um ato; `operacao_controlada` desfaz removendo
   * registro e preservando histórico; `procedimento_excepcional` não desfaz por
   * ação simples, porque há derivado gerado ou entregue.
   */
  reversibilidade?: "correcao_simples" | "operacao_controlada" | "procedimento_excepcional";
  // --- documento individual -------------------------------------------------
  /**
   * Bloco do instrumento que ficou abaixo do mínimo de perguntas respondidas
   * (lib/ai/completude-marco-zero.ts). A tela usa isto para dizer ONDE falta,
   * sem interpretar texto. `itens` nomeia as perguntas.
   */
  blocos_incompletos?: ("likert" | "situacional" | "elementos")[];
  /** Quantas perguntas o motor exige e quantas chegaram, por bloco insuficiente. */
  completude?: { bloco: string; respondidas: number; total: number; minimo: number }[];
  /** Estado em que o documento está AGORA, quando é ele que impede a escrita. */
  estado_do_documento?: string;

  // --- liberação de etapa (migration 028) -----------------------------------
  // Tudo aqui é o que a própria tela do host já mostra: a etapa que ele clicou e
  // quantas etapas o evento tem. Nunca texto interno de banco.

  /** A etapa que o painel TENTOU liberar. Distinta de `etapa_atual`, que é onde o evento está. */
  etapa_pedida?: number;
  /**
   * O modo do evento, quando é ele que impede a liberação. Fechado em três
   * valores: `desconhecido` é o que a tela diz quando o banco recusou por modo e
   * a tela não conseguiu ler qual era -- não é "é assíncrono".
   */
  modo_do_evento?: "live" | "async" | "desconhecido";
  /** O nome que o banco deu à causa, quando esta versão da tela não o conhece. Citável pelo host. */
  fato_do_banco?: string;

  /** O código com que a revalidação do banco (migration 024) recusou a gravação. */
  revalidacao?: CodigoDaRevalidacao;
  /**
   * As submissões que a revalidação do banco RECUSOU, nomeadas uma por uma.
   *
   * Existe porque um lote recusado é ATÔMICO: nada do lote foi gravado, e dizer
   * só "o lote foi recusado" deixaria o operador sem saber QUAL submissão tirar
   * da planilha para a próxima prévia. Vazia nunca é enviada: um retorno que diz
   * recusa e não diz quais submissões é INDISPONIBILIDADE, não "recusa sem
   * motivo" (lib/importacao/borda.ts).
   *
   * Só dado que o operador já tem em mãos: o id da submissão da planilha dele, o
   * nome fechado da causa e números. Nunca texto interno de banco.
   */
  recusadas?: RecusaDeSubmissaoNaRevalidacao[];
}

/**
 * O vocabulário FECHADO das causas de recusa da revalidação (migration 024).
 *
 * Esta lista é o espelho, em TypeScript, do `check` de
 * `external_import_rejections.codigo`. Os dois lados têm de dizer o mesmo: um
 * código que o banco emite e o TypeScript não conhece cai em "o ato ficou
 * registrado e não foi efetivado" -- degradação honesta e IMPRECISA, porque o
 * sistema conferiu e recusou. Um teste compara esta lista com o SQL da 024
 * (lib/importacao/decisao-do-operador.test.ts) para que elas não divirjam em
 * silêncio.
 */
export type CodigoDaRevalidacao =
  | "resposta_do_aplicativo"
  | "outra_submissao_externa"
  | "outra_submissao_ativa_do_participante"
  | "duplicidade_no_lote"
  | "participante_inexistente"
  | "participante_fora_do_evento"
  | "email_do_participante_mudou"
  | "versao_da_submissao_mudou"
  | "identidade_da_submissao_mudou";

/**
 * As causas, em lista. Derivada de um `Record<CodigoDaRevalidacao, true>` de
 * propósito: a lista é EXAUSTIVA por construção, e um código novo no tipo acima
 * NÃO COMPILA sem entrar aqui. Antes, a lista era escrita à mão num outro
 * arquivo, e foi assim que duas causas da 024 ficaram de fora dela -- caindo em
 * "o ato ficou registrado e não foi efetivado" em vez de "recusado na
 * revalidação", que é honesto e impreciso.
 */
const CAUSAS_DA_REVALIDACAO: Record<CodigoDaRevalidacao, true> = {
  resposta_do_aplicativo: true,
  outra_submissao_externa: true,
  outra_submissao_ativa_do_participante: true,
  duplicidade_no_lote: true,
  participante_inexistente: true,
  participante_fora_do_evento: true,
  email_do_participante_mudou: true,
  versao_da_submissao_mudou: true,
  identidade_da_submissao_mudou: true,
};

export const CODIGOS_DA_REVALIDACAO = Object.keys(CAUSAS_DA_REVALIDACAO) as CodigoDaRevalidacao[];

/**
 * O vocabulário FECHADO dos fatos com que a trava da liberação de etapa recusa
 * (migration 028).
 *
 * Este é o espelho, em TypeScript, dos nomes que o gatilho
 * `events_valida_liberacao_de_etapa()` põe no campo DETAIL da exceção. O nome
 * viaja no DETAIL, e não na prosa da MESSAGE, justamente para que a tela leia um
 * NOME FECHADO em vez de interpretar texto de banco em português -- o PostgREST
 * entrega DETAIL em `error.details`.
 *
 * Os dois lados têm de dizer o mesmo: um nome que o banco emite e o TypeScript
 * não conhece cai em STAGE_RELEASE_REFUSED_UNNAMED -- degradação honesta e
 * IMPRECISA, porque o banco conferiu e recusou e a tela não sabe dizer o quê. Um
 * teste compara esta lista com o SQL da 028 (components/features/admin/
 * liberar-etapa.test.ts) para que elas não divirjam em silêncio, na mesma
 * disciplina do vocabulário da revalidação, acima.
 */
export type FatoDaLiberacaoDeEtapa =
  /** CONFERIDO: o evento não é `live`. Liberar etapa não existe nesses modos. */
  | "modo_nao_libera_etapa"
  /** CONFERIDO: a versão do questionário do evento está coerente e não tem esta etapa. */
  | "etapa_fora_da_versao_do_evento"
  /** NÃO DEU PARA VERIFICAR: a versão não tem lista de etapas 1..N utilizável. */
  | "versao_sem_etapas_utilizaveis";

/** Exaustiva por construção: um fato novo no tipo acima NÃO COMPILA sem entrar aqui. */
const FATOS_DA_LIBERACAO_DE_ETAPA: Record<FatoDaLiberacaoDeEtapa, true> = {
  modo_nao_libera_etapa: true,
  etapa_fora_da_versao_do_evento: true,
  versao_sem_etapas_utilizaveis: true,
};

export const FATOS_DA_LIBERACAO = Object.keys(
  FATOS_DA_LIBERACAO_DE_ETAPA,
) as FatoDaLiberacaoDeEtapa[];

/** O nome que o banco mandou é um fato DESTE vocabulário? */
export function ehFatoDaLiberacaoDeEtapa(valor: unknown): valor is FatoDaLiberacaoDeEtapa {
  return (
    typeof valor === "string" &&
    Object.prototype.hasOwnProperty.call(FATOS_DA_LIBERACAO_DE_ETAPA, valor)
  );
}

/** O nome que o banco mandou é uma causa DESTE vocabulário? */
export function ehCodigoDaRevalidacao(valor: unknown): valor is CodigoDaRevalidacao {
  return (
    typeof valor === "string" &&
    Object.prototype.hasOwnProperty.call(CAUSAS_DA_REVALIDACAO, valor)
  );
}

/** Uma submissão recusada na revalidação, como a tela a lê. */
export interface RecusaDeSubmissaoNaRevalidacao {
  /** O identificador da submissão na planilha do operador. */
  submissao_id: string;
  /** A causa, nomeada. `null` quando o banco usou um nome fora deste vocabulário. */
  codigo: CodigoDaRevalidacao | null;
  /** As etapas cuja resposta já tem outro dono. Ids de etapa, não conteúdo. */
  etapas_em_conflito: string[];
  /** Quantas etapas desta submissão deixaram de ser gravadas. Zero é um número. */
  etapas_nao_gravadas: number;
}

/** Corpo de toda resposta de erro das rotas de processamento. */
export interface CorpoDeErro {
  error: string;
  code: TodoCodigoDeErro;
  /** Identificador desta ocorrência: está no log do servidor e é o que o host informa à equipe. */
  ocorrencia: string;
  detalhes?: DetalhesDeErro;
}

/** Identificador curto e citável. Não é segredo e não carrega dado pessoal. */
export function novaOcorrencia(): string {
  const id = globalThis.crypto.randomUUID().replace(/-/g, "");
  return id.slice(0, 12);
}
