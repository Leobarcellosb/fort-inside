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

import { ehCodigoDeErro, type CodigoDeErro, type DetalhesDeErro } from "../../../lib/erros/codigos";
import { MENSAGEM_GENERICA, mensagemParaHost } from "../../../lib/erros/mensagens-host";
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
  /** CONFERI e NAO PERMITI. */
  | { tipo: "recusado"; codigo: CodigoDeErro; acao: AcaoSugerida; mensagem: string }
  /** NAO CONSEGUI VERIFICAR. Nada foi gravado. */
  | { tipo: "nao_verificado"; codigo: CodigoDeErro; acao: AcaoSugerida; mensagem: string; ocorrencia: string | null }
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

  // --- nao consegui verificar ----------------------------------------------
  // AUTH_UNAVAILABLE e o caso que nomeia esta classe: NUNCA "sem permissao".
  AUTH_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
  IMPORT_UNAVAILABLE: { classe: "nao_verificado", acao: "aguardar" },
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

  INTERNAL_ERROR: { classe: "inesperado", acao: "falar_com_equipe" },
};

const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

function ocorrenciaDaResposta(res: Response, corpo: Record<string, unknown>): string | null {
  if (typeof corpo.ocorrencia === "string" && ID_VALIDO.test(corpo.ocorrencia)) return corpo.ocorrencia;
  for (const h of ["x-request-id", "x-vercel-id"]) {
    const v = res.headers?.get?.(h);
    if (v && ID_VALIDO.test(v)) return v;
  }
  return null;
}

function ocorrenciaLocal(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

const registrarNoConsole: Registrador = (r) => {
  console.error("[importar-respostas] ocorrência", r);
};

function comOcorrencia(mensagem: string, ocorrencia: string | null): string {
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
  };
}

/** Transforma a resposta de erro de qualquer uma das duas rotas num desfecho. */
function desfechoDeErro(res: Response, corpo: Record<string, unknown>, registrar: Registrador): Desfecho {
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
  return {
    tipo: "nao_verificado",
    codigo,
    acao,
    mensagem: comOcorrencia(mensagem, ocorrenciaServidor),
    ocorrencia: ocorrenciaServidor,
  };
}

async function corpoDe(res: Response): Promise<Record<string, unknown>> {
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
  if (!res.ok) return desfechoDeErro(res, corpo, registrar);

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
