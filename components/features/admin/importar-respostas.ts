// A TELA da importacao de respostas coletadas FORA do aplicativo, sem React.
//
// Aqui mora a decisao de o que o operador LE. A tela decide por CODIGO
// (lib/erros/codigos.ts), nunca por status HTTP solto, e o texto nasce num unico
// lugar (lib/erros/mensagens-host.ts). O `error` do corpo NUNCA e exibido: ele e
// texto do servidor e, numa resposta que a tela nao reconhece, pode ser "Erro" ou
// algo vindo do banco.
//
// AS TRES CLASSES, e a razao de serem tres:
//
//   recusado          CONFERI e NAO PERMITI. Ha o que corrigir, e quem corrige e
//                     o operador: a coluna renomeada, a coleta de outra versao, a
//                     sessao errada. Tentar de novo sem mudar nada nao resolve.
//   nao_verificado    NAO CONSEGUI VERIFICAR. Nada foi decidido e nada foi
//                     gravado. NAO acusa a planilha e NAO acusa a permissao de
//                     ninguem. Esperar e tentar de novo e o certo.
//   recurso_ausente   O RECURSO NAO ESTA INSTALADO neste ambiente. Nem o operador
//                     nem a espera resolvem: alguem aplica a atualizacao do banco.
//
// Colapsar duas delas e o defeito que este projeto ja pagou caro: "nao consegui
// verificar" aparecendo como "voce nao tem permissao" manda o host entrar de novo
// com a credencial certa, que vai falhar de novo; "nao esta instalado" aparecendo
// como "nao respondeu" manda esperar por algo que nao vai chegar; e "nao
// respondeu" aparecendo como "nao esta instalado" manda a equipe tecnica mexer no
// banco no meio de um evento, por nada.
//
// Funcoes puras em torno de um `fetcher` injetavel, para provar o comportamento
// sem rede -- e, na prova, com as rotas de verdade contra Postgres de verdade.

import {
  ehCodigoDaRevalidacao,
  ehCodigoDeErro,
  type CodigoDeErro,
  type DetalhesDeErro,
  type RecusaDeSubmissaoNaRevalidacao,
} from "../../../lib/erros/codigos";
import {
  MENSAGEM_GENERICA,
  MOTIVO_DA_REVALIDACAO,
  MOTIVO_DA_REVALIDACAO_SEM_NOME,
  mensagemParaHost,
} from "../../../lib/erros/mensagens-host";
import type { Previa } from "../../../lib/importacao/borda";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type Registrador = (registro: {
  ocorrencia: string;
  status: number;
  codigo: string | null;
}) => void;

export const ROTA_DA_PREVIA = "/api/importacao/previa";
export const ROTA_DA_APLICACAO = "/api/importacao/aplicar";

/** O corpo que as duas rotas recebem. `previa_impressao` so na aplicacao. */
export interface PedidoDaTela {
  event_id: string;
  formulario_id: string;
  formulario_nome?: string | null;
  impressao_declarada: string;
  cabecalhos: string[];
  linhas: { celulas: unknown[]; submissao_id: string }[];
  email_verificado: boolean;
  casamento?: {
    cabecalhoDoEmail?: string;
    cabecalhoDoCarimbo?: string;
    ignorar?: string[];
    tolerarPerguntaFaltando?: boolean;
  };
}

export interface ResumoGravado {
  evento_id: string;
  formulario_id: string;
  questionario_impressao: string;
  por_estado: Partial<Record<"importavel" | "incompativel" | "pendente" | "conflito", number>>;
  linhas_de_resposta_gravadas: number;
  itens_registrados: number;
  importado_por: string;
}

export type Desfecho =
  /** A previa chegou. NADA foi gravado. */
  | { tipo: "previa"; previa: Previa }
  /** Gravado. A previa autorizada vem junto, para conferir contra o que o banco gravou. */
  | { tipo: "aplicado"; previa: Previa; gravado: ResumoGravado }
  /**
   * O LOTE INTEIRO foi RECUSADO na revalidacao do banco (migration 024), e NADA
   * foi gravado -- nem as submissoes sem conflito.
   *
   * Tem ramo PROPRIO, e nao e um `recusado` qualquer, por duas razoes:
   *
   *   1. a ACAO e outra. As outras recusas se corrigem na planilha, na coleta ou
   *      na mesa de decisoes; esta se resolve pedindo PREVIA NOVA SEM as
   *      submissoes conflitantes, e `DESFECHO_DO_CODIGO` tem UMA acao por codigo
   *      -- o mesmo codigo serve a decisao sobre uma submissao, onde a acao e
   *      recarregar a mesa;
   *   2. ele carrega a LISTA das recusadas. Sem ela o operador leria "o lote foi
   *      recusado" sem saber o que tirar da planilha, que e o enigma que este
   *      ramo existe para acabar.
   *
   * A CLASSE continua saindo de `DESFECHO_DO_CODIGO` (e "recusado": conferido e
   * nao permitido). Nenhuma segunda tabela de "qual dos tres fatos e este".
   */
  | {
      tipo: "lote_recusado";
      codigo: Extract<CodigoDeErro, "IMPORT_REVALIDATION_REFUSED">;
      acao: AcaoSugerida;
      mensagem: string;
      recusadas: RecusaDeSubmissaoNaRevalidacao[];
    }
  /** CONFERI e NAO PERMITI. */
  | { tipo: "recusado"; codigo: CodigoDeErro; acao: AcaoSugerida; mensagem: string }
  /** NAO CONSEGUI VERIFICAR. Nada foi gravado. */
  | { tipo: "nao_verificado"; codigo: CodigoDeErro; acao: AcaoSugerida; mensagem: string; ocorrencia: string | null }
  /**
   * NAO DA PARA AFIRMAR O QUE FOI GRAVADO: a resposta da gravacao se contradiz.
   *
   * Ramo proprio porque todos os outros avisos desta tela terminam em "nada foi
   * gravado", e aqui essa frase seria uma AFIRMACAO FALSA -- o corpo que a tela
   * acabou de ler informa escrita. A classe do codigo continua sendo
   * indisponibilidade (`nao_verificado` em `DESFECHO_DO_CODIGO`); o que muda e o
   * que a tela pode dizer, e so isto: que as duas afirmacoes vieram juntas e que
   * o estado tem de ser conferido antes de tentar de novo.
   */
  | {
      tipo: "estado_incerto";
      codigo: Extract<CodigoDeErro, "IMPORT_WRITE_UNVERIFIABLE">;
      acao: AcaoSugerida;
      mensagem: string;
      ocorrencia: string | null;
    }
  /** O RECURSO NAO ESTA INSTALADO. */
  | { tipo: "recurso_ausente"; codigo: CodigoDeErro; acao: AcaoSugerida; mensagem: string; ocorrencia: string | null }
  /** Codigo desconhecido ou ausente: mensagem generica segura + ocorrencia. */
  | { tipo: "erro_inesperado"; mensagem: string; ocorrencia: string; status: number }
  | { tipo: "sem_conexao"; mensagem: string };

export type ClasseDoDesfecho = "recusado" | "nao_verificado" | "recurso_ausente" | "inesperado";

/** O que o operador deve FAZER. Sai da tabela, nao de uma leitura do texto. */
export type AcaoSugerida =
  | "corrigir_planilha"
  | "corrigir_coleta"
  | "refazer_previa"
  /**
   * Tirar da planilha as submissoes que o banco recusou, gerar uma PREVIA NOVA
   * sem elas e confirmar a partir dela. Nao e `refazer_previa`: a previa de novo
   * COM as mesmas submissoes seria recusada de novo, pelo mesmo motivo.
   */
  | "refazer_previa_sem_as_recusadas"
  /**
   * CONFERIR, no evento, o que esta registrado -- antes de qualquer nova
   * tentativa. E a acao de quando nao se sabe o que foi escrito: "aguarde e tente
   * de novo" ali convidaria a repetir uma gravacao que pode ter acontecido.
   */
  | "conferir_o_que_esta_gravado"
  /** Recarregar a MESA DE DECISOES e confirmar a partir da ficha que ela mostra. */
  | "refazer_ficha"
  /** Escolher outro participante (ou revogar a reconciliacao que ocupa o alvo). */
  | "escolher_outro_alvo"
  | "entrar_de_novo"
  | "aguardar"
  | "instalar_no_banco"
  | "falar_com_equipe";

export const MENSAGEM_SEM_CONEXAO =
  "Não foi possível falar com o servidor agora. Nada foi conferido e nada foi gravado. Confira a conexão e tente de novo.";

/**
 * CODIGO -> (classe, acao). Uma tabela, exaustiva sobre o vocabulario: um codigo
 * novo em `lib/erros/codigos.ts` NAO COMPILA sem que alguem diga, aqui, qual dos
 * tres fatos ele e e o que o operador faz com ele. E de proposito.
 */
export const DESFECHO_DO_CODIGO: Record<CodigoDeErro, { classe: ClasseDoDesfecho; acao: AcaoSugerida }> = {
  // --- conferi e nao permiti ------------------------------------------------
  INVALID_REQUEST: { classe: "recusado", acao: "refazer_previa" },
  AUTH_REQUIRED: { classe: "recusado", acao: "entrar_de_novo" },
  ADMIN_FORBIDDEN: { classe: "recusado", acao: "entrar_de_novo" },
  EVENT_NOT_FOUND: { classe: "recusado", acao: "refazer_previa" },
  IMPORT_MANIFEST_MISMATCH: { classe: "recusado", acao: "corrigir_coleta" },
  IMPORT_SPREADSHEET_INVALID: { classe: "recusado", acao: "corrigir_planilha" },
  IMPORT_PLAN_REFUSED: { classe: "recusado", acao: "corrigir_coleta" },
  IMPORT_PREVIEW_STALE: { classe: "recusado", acao: "refazer_previa" },
  // A decisão do operador sobre identidade: quatro recusas conferidas, cada uma
  // com a sua correção, e uma que NÃO é recusa (o ato ficou registrado e não
  // pegou -- esperar e confirmar outra vez é o certo).
  IMPORT_SUBMISSION_NOT_FOUND: { classe: "recusado", acao: "refazer_ficha" },
  IMPORT_DECISION_REFUSED: { classe: "recusado", acao: "refazer_ficha" },
  IMPORT_DECISION_STALE: { classe: "recusado", acao: "refazer_ficha" },
  IMPORT_TARGET_OCCUPIED: { classe: "recusado", acao: "escolher_outro_alvo" },
  // O banco recusou na hora de gravar (024). Conferido e nao permitido -- e o
  // caminho de correcao e a ficha nova, nao a espera.
  IMPORT_REVALIDATION_REFUSED: { classe: "recusado", acao: "refazer_ficha" },
  // Desfazer deixou de ser acao simples: quem resolve nao e o operador sozinho.
  IMPORT_REVOKE_BLOCKED: { classe: "recusado", acao: "falar_com_equipe" },

  // --- nao consegui verificar ----------------------------------------------
  // AUTH_UNAVAILABLE e o caso que nomeia esta classe: NUNCA "sem permissao".
  AUTH_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  IMPORT_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  // RESPONDEU e a resposta se contradiz. Indisponibilidade (nao e recusa e nao e
  // ausencia), mas a acao NAO e "aguardar": nao se convida a repetir uma gravacao
  // que pode ter acontecido. Primeiro se confere o que esta registrado.
  IMPORT_WRITE_UNVERIFIABLE: { classe: "nao_verificado", acao: "conferir_o_que_esta_gravado" },
  // O ato ficou REGISTRADO e nao foi efetivado. Nao e recusa (nao ha o que
  // corrigir) e nao e ausencia de recurso (ele esta instalado): e "nao deu para
  // concluir", e a tela diz exatamente isso, sem inventar causa.
  IMPORT_ACT_NOT_APPLIED: { classe: "nao_verificado", acao: "aguardar" },
  // NAO DEU PARA VERIFICAR os derivados. Nao e recusa e nao e ausencia de recurso.
  IMPORT_DERIVATIVES_UNVERIFIABLE: { classe: "nao_verificado", acao: "aguardar" },
  IMPORT_MANIFEST_UNVERIFIABLE: { classe: "nao_verificado", acao: "corrigir_coleta" },
  QUIZ_STAGES_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  PARTICIPANTS_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  TIME_REFERENCE_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  SNAPSHOT_UNSTABLE: { classe: "nao_verificado", acao: "aguardar" },
  BUDGET_MEASUREMENT_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  QUEUE_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  // Consultei e os dados do questionario estao inconsistentes: nao e "nao
  // consegui" nem coisa que o operador corrija na planilha dele.
  QUIZ_STAGES_INVALID: { classe: "nao_verificado", acao: "falar_com_equipe" },
  QUEUE_CONFIG_INVALID: { classe: "nao_verificado", acao: "falar_com_equipe" },
  EVENT_MODE_UNDETERMINED: { classe: "nao_verificado", acao: "falar_com_equipe" },
  COLLECTION_WINDOW_UNDETERMINED: { classe: "nao_verificado", acao: "falar_com_equipe" },

  // --- o recurso nao esta instalado ----------------------------------------
  IMPORT_SCHEMA_MISSING: { classe: "recurso_ausente", acao: "instalar_no_banco" },
  QUEUE_SCHEMA_MISSING: { classe: "recurso_ausente", acao: "instalar_no_banco" },
  BUDGET_MEASUREMENT_MISSING: { classe: "recurso_ausente", acao: "instalar_no_banco" },
  ASYNC_PROCESSING_MISSING: { classe: "recurso_ausente", acao: "instalar_no_banco" },

  // --- regras de processamento que nao sao desta borda ---------------------
  // Nao chegam aqui, mas o vocabulario e fechado: se chegassem, cairiam na classe
  // do FATO que sao, nunca na de "nao instalado".
  EVENT_INCOMPLETE: { classe: "recusado", acao: "falar_com_equipe" },
  COLLECTION_OPEN: { classe: "recusado", acao: "aguardar" },
  NO_COMPLETED_PARTICIPANTS: { classe: "recusado", acao: "refazer_previa" },

  // --- Guia de Preparação do Facilitador -----------------------------------
  // Também não chegam a esta borda. Classificados pelo FATO que são: duas
  // recusas conferidas e uma indisponibilidade -- "não deu para saber se há DNA
  // disponibilizado" nunca é "conferi e não permiti".
  GUIDE_DNA_PUBLISHED: { classe: "recusado", acao: "falar_com_equipe" },
  GUIDE_DATA_INCONSISTENT: { classe: "recusado", acao: "falar_com_equipe" },
  GUIDE_DNA_STATE_UNVERIFIABLE: { classe: "nao_verificado", acao: "aguardar" },
  COVERAGE_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  INVITE_COUNT_UNDETERMINED: { classe: "nao_verificado", acao: "falar_com_equipe" },

  INTERNAL_ERROR: { classe: "inesperado", acao: "falar_com_equipe" },
};

/**
 * O TITULO de cada desfecho, e o ROTULO de cada acao.
 *
 * Moram aqui, e nao no componente, pelo mesmo motivo que `TITULO_DO_CODIGO` mora
 * em decidir-identidade.ts: e texto que o operador le, e texto que o operador le
 * nasce num lugar so -- e num lugar que a prova consegue ler sem montar React.
 *
 * `Record` fechado nos dois: um desfecho novo ou uma acao nova NAO COMPILA sem que
 * alguem diga, aqui, o que o operador le.
 */
/**
 * O titulo do estado incerto, num lugar so: as DUAS telas (a importacao e a
 * decisao do operador) recebem `IMPORT_WRITE_UNVERIFIABLE`, e o fato e o mesmo.
 * Duas frases para o mesmo fato e como as duas versoes de um fato comecam.
 */
export const TITULO_DO_ESTADO_INCERTO =
  "A resposta do banco se contradiz — não dá para afirmar o que foi gravado";

export const TITULO_DO_AVISO: Record<Desfecho["tipo"], string> = {
  previa: "Prévia",
  aplicado: "Importação gravada",
  // NAO e erro: e o portao do banco tendo funcionado. O titulo diz as duas coisas
  // que o operador precisa saber na primeira linha -- o lote nao entrou, e o que
  // ja existia nao foi tocado.
  lote_recusado: "Lote recusado na revalidação — NADA foi gravado, e nada que existia foi tocado",
  recusado: "Conferido e não autorizado — nada foi gravado",
  nao_verificado: "Não foi possível verificar — nada foi gravado",
  // NAO diz "nada foi gravado" e NAO diz que gravou: as duas coisas e que estao
  // em duvida. O titulo diz a duvida, e a mensagem diz o que fazer com ela.
  estado_incerto: TITULO_DO_ESTADO_INCERTO,
  recurso_ausente: "O recurso não está instalado neste ambiente — nada foi gravado",
  erro_inesperado: "Algo inesperado — nada foi gravado",
  sem_conexao: "Sem conexão — nada foi gravado",
};

export const ROTULO_DA_ACAO: Record<AcaoSugerida, string> = {
  corrigir_planilha: "Corrija a planilha e confira de novo.",
  corrigir_coleta: "Corrija a coleta (o formulário ou a versão) e confira de novo.",
  refazer_previa: "Gere a prévia outra vez.",
  refazer_previa_sem_as_recusadas:
    "Tire da planilha as submissões recusadas, carregue o arquivo outra vez e confira — a prévia nova já não as inclui.",
  conferir_o_que_esta_gravado:
    "Antes de tentar outra vez: abra este evento e confira o que está registrado para estas pessoas. Avise a equipe técnica com o número da ocorrência.",
  refazer_ficha: "Recarregue a mesa de decisões e confirme a partir da ficha que ela mostra.",
  escolher_outro_alvo:
    "Escolha outro participante, ou revogue antes a reconciliação que ocupa esse participante.",
  entrar_de_novo: "Entre de novo como administrador.",
  aguardar: "Aguarde alguns instantes e tente de novo.",
  instalar_no_banco: "Avise a equipe técnica: falta instalar a atualização do banco.",
  falar_com_equipe: "Avise a equipe técnica.",
};

const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

export function ocorrenciaDaResposta(res: Response, corpo: Record<string, unknown>): string | null {
  if (typeof corpo.ocorrencia === "string" && ID_VALIDO.test(corpo.ocorrencia)) return corpo.ocorrencia;
  for (const h of ["x-request-id", "x-vercel-id"]) {
    const v = res.headers?.get?.(h);
    if (v && ID_VALIDO.test(v)) return v;
  }
  return null;
}

export function ocorrenciaLocal(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

export const registrarNoConsole: Registrador = (r) => {
  console.error("[importar-respostas] ocorrência", r);
};

export function comOcorrencia(mensagem: string, ocorrencia: string | null): string {
  return ocorrencia ? `${mensagem} Ocorrência: ${ocorrencia}.` : mensagem;
}

/** So os campos declarados de `detalhes`, e nunca texto livre do servidor. */
function detalhesDe(corpo: Record<string, unknown>): DetalhesDeErro | undefined {
  const d = corpo.detalhes;
  if (!d || typeof d !== "object" || Array.isArray(d)) return undefined;
  const o = d as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    impressao_declarada: texto(o.impressao_declarada),
    impressao_do_sistema: texto(o.impressao_do_sistema),
    itens: Array.isArray(o.itens) ? o.itens.filter((x): x is string => typeof x === "string") : undefined,
    divergencia: texto(o.divergencia) as DetalhesDeErro["divergencia"],
    portao: texto(o.portao) as DetalhesDeErro["portao"],
    linha: num(o.linha),
    versao_declarada: num(o.versao_declarada),
    versao_do_evento: num(o.versao_do_evento),
    // Os campos da DECISAO DO OPERADOR. Sem eles, a mensagem de
    // IMPORT_DECISION_REFUSED cairia sempre no texto generico e o operador leria
    // "nao autorizado" onde o servidor disse "nao ha reconciliacao a revogar".
    estado_da_submissao: texto(o.estado_da_submissao) as DetalhesDeErro["estado_da_submissao"],
    ocupacao: texto(o.ocupacao) as DetalhesDeErro["ocupacao"],
    respostas_existentes: num(o.respostas_existentes),
    ato: texto(o.ato) as DetalhesDeErro["ato"],
    revalidacao: ehCodigoDaRevalidacao(o.revalidacao) ? o.revalidacao : undefined,
    // A lista das submissoes que o banco recusou. Entrada que nao nomeia a
    // submissao e DESCARTADA aqui, e e por isso que `lerRecusadas` pode devolver
    // lista vazia num corpo que dizia recusa -- caso em que a tela NAO afirma
    // recusa (vira indisponibilidade, em `aplicarImportacao`).
    recusadas: lerRecusadas(o.recusadas),
  };
}

/** So os campos declarados de cada recusada, e nunca texto livre do servidor. */
function lerRecusadas(bruto: unknown): RecusaDeSubmissaoNaRevalidacao[] | undefined {
  if (!Array.isArray(bruto)) return undefined;
  const lidas: RecusaDeSubmissaoNaRevalidacao[] = [];
  for (const item of bruto) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.submissao_id !== "string" || r.submissao_id.trim() === "") continue;
    lidas.push({
      submissao_id: r.submissao_id,
      // Codigo fora do vocabulario nao e inventado nem traduzido: fica `null`, e a
      // tela diz que a causa tem nome que ela nao conhece.
      codigo: ehCodigoDaRevalidacao(r.codigo) ? r.codigo : null,
      etapas_em_conflito: Array.isArray(r.etapas_em_conflito)
        ? r.etapas_em_conflito.filter((e): e is string => typeof e === "string")
        : [],
      etapas_nao_gravadas:
        typeof r.etapas_nao_gravadas === "number" && Number.isFinite(r.etapas_nao_gravadas)
          ? r.etapas_nao_gravadas
          : 0,
    });
  }
  return lidas;
}

/**
 * Transforma a resposta de erro de qualquer uma das rotas de importacao num
 * desfecho.
 *
 * EXPORTADA de proposito: a tela da DECISAO DO OPERADOR
 * (components/features/admin/decidir-identidade.ts) classifica os erros dela com
 * ESTA funcao, e nao com uma copia. Duas copias da regra "qual dos tres fatos e
 * este" divergem, e a divergencia e exatamente o defeito que este projeto ja
 * pagou caro: "nao consegui verificar" aparecendo como "voce nao tem permissao".
 */
export function desfechoDeErro(res: Response, corpo: Record<string, unknown>, registrar: Registrador): Desfecho {
  const ocorrenciaServidor = ocorrenciaDaResposta(res, corpo);

  // Sem um codigo DO VOCABULARIO nao ha como saber o que aconteceu. Inventar uma
  // causa aqui -- a atualizacao do banco, em especial -- manda o operador
  // investigar a coisa errada no meio de um evento.
  if (!ehCodigoDeErro(corpo.code)) {
    const ocorrencia = ocorrenciaServidor ?? ocorrenciaLocal();
    registrar({ ocorrencia, status: res.status, codigo: typeof corpo.code === "string" ? corpo.code : null });
    return {
      tipo: "erro_inesperado",
      mensagem: comOcorrencia(MENSAGEM_GENERICA, ocorrencia),
      ocorrencia,
      status: res.status,
    };
  }

  const codigo = corpo.code;
  const { classe, acao } = DESFECHO_DO_CODIGO[codigo];
  const mensagem = mensagemParaHost(codigo, detalhesDe(corpo));

  if (classe === "inesperado") {
    const ocorrencia = ocorrenciaServidor ?? ocorrenciaLocal();
    registrar({ ocorrencia, status: res.status, codigo });
    return { tipo: "erro_inesperado", mensagem: comOcorrencia(mensagem, ocorrencia), ocorrencia, status: res.status };
  }
  if (classe === "recusado") {
    // Recusa conferida: nao precisa de numero de ocorrencia, precisa de correcao.
    return { tipo: "recusado", codigo, acao, mensagem };
  }
  if (ocorrenciaServidor) registrar({ ocorrencia: ocorrenciaServidor, status: res.status, codigo });
  if (classe === "recurso_ausente") {
    return { tipo: "recurso_ausente", codigo, acao, mensagem, ocorrencia: ocorrenciaServidor };
  }
  if (codigo === "IMPORT_WRITE_UNVERIFIABLE") {
    // Indisponibilidade, como a classe diz -- mas com titulo proprio, porque o de
    // `nao_verificado` termina em "nada foi gravado" e aqui isso nao foi
    // verificado. Vale para QUALQUER tela que receba este codigo: a regra mora
    // nesta funcao, que e a unica que classifica.
    return {
      tipo: "estado_incerto",
      codigo,
      acao,
      mensagem: comOcorrencia(mensagem, ocorrenciaServidor),
      ocorrencia: ocorrenciaServidor,
    };
  }
  return {
    tipo: "nao_verificado",
    codigo,
    acao,
    mensagem: comOcorrencia(mensagem, ocorrenciaServidor),
    ocorrencia: ocorrenciaServidor,
  };
}

/**
 * O LOTE foi RECUSADO na revalidacao do banco, lido para a tela.
 *
 * TRES coisas, e cada uma e um fato diferente:
 *
 *   - a lista NAO da para ler (vazia, ou sem nenhuma submissao nomeada): isto NAO
 *     e "recusa sem motivo". Nao se afirma recusa sem poder dizer o que tirar da
 *     planilha, entao e INDISPONIBILIDADE -- o recurso existe, respondeu, e o que
 *     respondeu nao da para ler. A borda (lib/importacao/borda.ts) ja recusa esse
 *     retorno antes de chegar aqui; esta e a segunda guarda, para o caso de o
 *     corpo chegar por outro caminho;
 *   - a lista da para ler: RECUSA do lote inteiro, com as submissoes nomeadas;
 *   - a classe e a acao saem das tabelas unicas, nao de um `if` escrito aqui.
 */
function loteRecusado(
  res: Response,
  corpo: Record<string, unknown>,
  registrar: Registrador,
): Desfecho {
  const detalhes = detalhesDe(corpo);
  const recusadas = detalhes?.recusadas ?? [];
  if (recusadas.length === 0) {
    const ocorrencia = ocorrenciaDaResposta(res, corpo);
    if (ocorrencia) registrar({ ocorrencia, status: res.status, codigo: "IMPORT_REVALIDATION_REFUSED" });
    return {
      tipo: "nao_verificado",
      codigo: "IMPORT_UNAVAILABLE",
      acao: DESFECHO_DO_CODIGO.IMPORT_UNAVAILABLE.acao,
      mensagem: comOcorrencia(mensagemParaHost("IMPORT_UNAVAILABLE"), ocorrencia),
      ocorrencia,
    };
  }
  return {
    tipo: "lote_recusado",
    codigo: "IMPORT_REVALIDATION_REFUSED",
    acao: "refazer_previa_sem_as_recusadas",
    // O ato e DECLARADO: esta funcao so e chamada pela rota que grava um LOTE, e
    // e o ato que decide o que o operador le em seguida.
    mensagem: mensagemParaHost("IMPORT_REVALIDATION_REFUSED", {
      ...detalhes,
      ato: "importar_lote",
      recusadas,
    }),
    recusadas,
  };
}

/**
 * Uma linha por submissao recusada: QUAL submissao, de QUEM era, POR QUE, e
 * quantas etapas dela deixaram de ser gravadas.
 *
 * A causa sai de `MOTIVO_DA_REVALIDACAO` (lib/erros/mensagens-host.ts), a mesma
 * tabela que a mensagem do host usa: um fato, um texto. O e-mail e o nome saem da
 * PREVIA que esta na tela -- dado que o operador ja tem em maos, e que e o que
 * liga `resp-0007` a uma pessoa na cabeca de quem le.
 */
export function linhaDaRecusa(r: RecusaDeSubmissaoNaRevalidacao, previa: Previa | null): string {
  const linha = previa?.submissoes.find((s) => s.submissao_id === r.submissao_id) ?? null;
  const quem = linha?.email ? ` (${linha.email})` : "";
  const causa = r.codigo === null ? MOTIVO_DA_REVALIDACAO_SEM_NOME : MOTIVO_DA_REVALIDACAO[r.codigo];
  const etapas =
    r.etapas_em_conflito.length > 0 ? ` Etapas em conflito: ${r.etapas_em_conflito.join(", ")}.` : "";
  const naoGravadas = ` ${r.etapas_nao_gravadas} etapa(s) desta submissão não foram gravadas.`;
  return `${r.submissao_id}${quem}: ${causa}.${etapas}${naoGravadas}`;
}

/** O corpo JSON da resposta, ou `{}`. Exportada para a tela da decisao. */
export async function corpoDe(res: Response): Promise<Record<string, unknown>> {
  try {
    const lido = await res.json();
    if (lido && typeof lido === "object" && !Array.isArray(lido)) return lido as Record<string, unknown>;
  } catch {
    /* corpo nao-JSON */
  }
  return {};
}

/**
 * Pede a PREVIA. Nao grava nada, e nao existe argumento nesta funcao capaz de
 * fazer com que grave: ela so conhece a rota da previa.
 */
export async function pedirPrevia(
  pedido: PedidoDaTela,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<Desfecho> {
  let res: Response;
  try {
    res = await fetcher(ROTA_DA_PREVIA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pedido),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }

  const corpo = await corpoDe(res);
  if (!res.ok) return desfechoDeErro(res, corpo, registrar);

  const previa = corpo.previa as Previa | undefined;
  if (!previa || typeof previa !== "object" || typeof previa.impressao_da_previa !== "string") {
    // 200 sem previa utilizavel: NAO se mostra uma previa vazia como se fosse
    // "nada a importar". Uma previa que nao chegou nao e uma previa de zero.
    const ocorrencia = ocorrenciaDaResposta(res, corpo) ?? ocorrenciaLocal();
    registrar({ ocorrencia, status: res.status, codigo: null });
    return {
      tipo: "erro_inesperado",
      mensagem: comOcorrencia(MENSAGEM_GENERICA, ocorrencia),
      ocorrencia,
      status: res.status,
    };
  }
  return { tipo: "previa", previa };
}

/**
 * GRAVA, a partir de uma previa que o operador VIU.
 *
 * A assinatura exige a previa: nao da para chamar esta funcao sem ter uma, e a
 * impressao que vai no corpo e a DA PREVIA RECEBIDA, nao uma recalculada aqui. A
 * rota recusa (IMPORT_PREVIEW_STALE) se o plano tiver mudado desde entao.
 */
export async function aplicarImportacao(
  pedido: PedidoDaTela,
  previaConferida: Previa,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<Desfecho> {
  let res: Response;
  try {
    res = await fetcher(ROTA_DA_APLICACAO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pedido, previa_impressao: previaConferida.impressao_da_previa }),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }

  const corpo = await corpoDe(res);
  if (!res.ok) {
    // O LOTE RECUSADO NA REVALIDACAO tem ramo proprio -- ver `Desfecho`. So
    // AQUI, na rota que grava um LOTE: na decisao sobre uma submissao o mesmo
    // codigo pede outra acao, e e `desfechoDeErro` que a entrega.
    if (corpo.code === "IMPORT_REVALIDATION_REFUSED") {
      return loteRecusado(res, corpo, registrar);
    }
    return desfechoDeErro(res, corpo, registrar);
  }

  const previa = corpo.previa as Previa | undefined;
  const gravado = corpo.gravado as ResumoGravado | undefined;
  if (!previa || !gravado || typeof gravado.linhas_de_resposta_gravadas !== "number") {
    const ocorrencia = ocorrenciaDaResposta(res, corpo) ?? ocorrenciaLocal();
    registrar({ ocorrencia, status: res.status, codigo: null });
    return {
      tipo: "erro_inesperado",
      mensagem: comOcorrencia(MENSAGEM_GENERICA, ocorrencia),
      ocorrencia,
      status: res.status,
    };
  }
  return { tipo: "aplicado", previa, gravado };
}

// ===========================================================================
// A CONFERENCIA DEPOIS: a previa bateu com o que foi gravado?
// ===========================================================================

export type Conferencia =
  | { bate: true }
  | { bate: false; divergencias: string[] };

/**
 * Compara a previa autorizada com o resumo que o banco devolveu.
 *
 * Isto nao e desconfianca do banco: e a unica forma de a afirmacao "a previa bate
 * com o que a importacao faz" ser verificada na borda, em producao, a cada
 * importacao -- e nao apenas uma vez, num teste.
 */
export function conferirPreviaContraGravado(previa: Previa, gravado: ResumoGravado): Conferencia {
  const divergencias: string[] = [];
  const confere = (nome: string, esperado: number | string, obtido: number | string) => {
    if (esperado !== obtido) divergencias.push(`${nome}: a prévia disse ${esperado} e o banco gravou ${obtido}`);
  };

  confere("linhas de resposta", previa.linhas_de_resposta_a_gravar, gravado.linhas_de_resposta_gravadas);
  confere("itens de resposta", previa.itens_a_registrar, gravado.itens_registrados);
  confere("evento", previa.evento_id, gravado.evento_id);
  confere("formulário de origem", previa.origem.formulario_id, gravado.formulario_id);
  confere("impressão do questionário", previa.questionario_impressao, gravado.questionario_impressao);
  confere("operador", previa.operador.id, gravado.importado_por);

  const porEstado = contarEstados(previa);
  for (const estado of ["importavel", "incompativel", "pendente", "conflito"] as const) {
    confere(`submissões ${estado}`, porEstado[estado], gravado.por_estado[estado] ?? 0);
  }

  return divergencias.length === 0 ? { bate: true } : { bate: false, divergencias };
}

export function contarEstados(previa: Previa): Record<"importavel" | "incompativel" | "pendente" | "conflito", number> {
  const c = { importavel: 0, incompativel: 0, pendente: 0, conflito: 0 };
  for (const s of previa.submissoes) c[s.estado]++;
  return c;
}

/** Texto curto do que a prévia diz. Uma frase, para o alto da tela. */
export function resumoDaPrevia(previa: Previa): string {
  const partes = [
    `${previa.entram} ${previa.entram === 1 ? "submissão entra" : "submissões entram"} como resposta pontuável`,
  ];
  const retidas = previa.retidas_por_identidade.pendentes + previa.retidas_por_identidade.conflitos;
  if (retidas > 0) {
    partes.push(
      `${retidas} fica${retidas === 1 ? "" : "m"} retida${retidas === 1 ? "" : "s"} por identidade (${previa.retidas_por_identidade.pendentes} pendente${previa.retidas_por_identidade.pendentes === 1 ? "" : "s"}, ${previa.retidas_por_identidade.conflitos} em conflito)`,
    );
  }
  if (previa.com_dado_incompativel.submissoes > 0) {
    partes.push(
      `${previa.com_dado_incompativel.submissoes} tem DADO INCOMPATÍVEL em ${previa.com_dado_incompativel.perguntas.length} pergunta${previa.com_dado_incompativel.perguntas.length === 1 ? "" : "s"}`,
    );
  }
  const cob = previa.cobertura.geral;
  partes.push(
    cob === null
      ? "cobertura pontuável: não há base para medir (nenhuma identidade resolvida)"
      : `cobertura pontuável resultante: ${(cob * 100).toFixed(1)}%`,
  );
  return `${partes.join("; ")}.`;
}

/** 0..1 -> "73,4%". `null` nunca vira "0%": ausência de base não é cobertura zero. */
export function porcentagem(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`;
}
