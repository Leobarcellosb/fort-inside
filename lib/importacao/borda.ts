// A BORDA da importacao externa: tudo o que a rota HTTP decide, SEM Next e SEM
// banco.
//
// POR QUE ESTE ARQUIVO EXISTE, e nao duas rotas escrevendo cada uma a sua versao
// -------------------------------------------------------------------------------
// A borda tem DUAS operacoes: ver a previa e gravar. Se cada uma montasse o seu
// proprio plano, elas poderiam divergir -- e divergir aqui significa uma tela
// afirmando "entram 48, duas ficam pendentes" enquanto o banco grava outra coisa.
// Seria o oposto exato do que este projeto construiu: a previa existe para que o
// operador VEJA antes, e uma previa que nao bate com o que acontece e pior que
// nenhuma previa, porque autoriza com confianca.
//
// Entao a previa e a aplicacao chamam A MESMA funcao, `montarPlanoDaBorda`, sobre
// o MESMO pedido. E, para que isso nao seja apenas uma promessa de construcao, a
// previa carrega a IMPRESSAO DO PLANO (`impressaoDaPrevia`): na hora de gravar, o
// operador devolve a impressao que viu, e a borda RECUSA (IMPORT_PREVIEW_STALE) se
// o plano montado agora nao for byte a byte o que ele viu. Mudou um participante
// do evento entre a conferencia e a confirmacao? Nada e gravado, e o operador olha
// de novo. Estrito nessa direcao de proposito: recusar de mais custa um clique,
// gravar o que a tela nao mostrou custa um documento sobre a pessoa errada.
//
// A ORDEM DOS PORTOES e a de `planejar-importacao.ts`, e nao e reordenada aqui:
// a conferencia da planilha (casarColunas/lerPlanilha) entra ANTES do planejador
// porque sem submissoes lidas nao ha o que planejar, e o planejador ainda confere
// o manifesto antes de mapear qualquer resposta.
//
// OS CODIGOS, e a distincao que governa esta borda inteira (lib/erros/codigos.ts):
//   IMPORT_SCHEMA_MISSING         o recurso NAO ESTA INSTALADO no banco;
//   IMPORT_UNAVAILABLE           o recurso existe e NAO RESPONDEU;
//   IMPORT_WRITE_UNVERIFIABLE    RESPONDEU e a resposta SE CONTRADIZ (recusa com
//                                escrita informada, ou gravacao com recusas
//                                nomeadas): nao se afirma nem que gravou nem que
//                                nao gravou;
//   IMPORT_MANIFEST_UNVERIFIABLE NAO DEU PARA CONFERIR a impressao;
//   IMPORT_MANIFEST_MISMATCH     CONFERI e o questionario e outro -> recusa;
//   IMPORT_SPREADSHEET_INVALID   CONFERI os cabecalhos e nao casam -> recusa;
//   IMPORT_PLAN_REFUSED          CONFERI o operador/origem/versao -> recusa;
//   IMPORT_PREVIEW_STALE         CONFERI que a previa venceu -> recusa;
//   IMPORT_REVALIDATION_REFUSED  o BANCO conferiu DENTRO da transacao e recusou o
//                                LOTE INTEIRO (migration 024) -> recusa, e nada
//                                foi gravado. Desfecho PREVISTO, nao erro: ele
//                                protegeu a resposta de alguem.
// Os tres primeiros grupos nunca se confundem, e e por isso que sao oito codigos.
//
// O OPERADOR NAO VEM DO CORPO DO PEDIDO. Vem de `verificarAdmin()`, e so. Um
// campo `operador` no JSON seria um pedido para importar em nome de outra pessoa,
// e a regra 3 diz que a importacao nao impersona ninguem -- nem o participante,
// nem outro operador. `lerPedidoDeImportacao` RECUSA o corpo que tentar.
//
// Funcoes puras, fora de `lerContextoDoEvento` (que le o banco) e do SHA-256.

import { createHash } from "node:crypto";
import {
  ehCodigoDaRevalidacao,
  type CodigoDaRevalidacao,
  type CodigoDeErro,
  type DetalhesDeErro,
} from "../erros/codigos";
import { indicaEsquemaAusente, type ErroRpcCru } from "../erros/falha-de-fila";
import {
  montarManifesto,
  type LinhaDeEtapa,
  type ManifestoQuestionario,
} from "./manifesto-questionario";
import {
  casarColunas,
  lerPlanilha,
  type LinhaDaPlanilha,
  type OpcoesDoCasamento,
} from "./ler-planilha";
import {
  IDS_ELEMENTOS,
  IDS_LIKERT,
  IDS_SITUACIONAIS,
  type CausaDeIncompatibilidade,
} from "./mapear-resposta";
import {
  planejarImportacao,
  type CodigoDeRecusaDoPlano,
  type EstadoDaSubmissao,
  type OperadorDaImportacao,
  type PlanoDeImportacao,
} from "./planejar-importacao";
import type { ParticipanteDoEvento } from "./reconciliar-identidade";

/** O plano, no ramo em que ele existe. */
export type PlanoAceito = Extract<PlanoDeImportacao, { ok: true }>;

// ===========================================================================
// 1. O PEDIDO
// ===========================================================================

export interface PedidoDeImportacao {
  event_id: string;
  formulario_id: string;
  formulario_nome: string | null;
  /** Impressao digital DECLARADA por quem montou a coleta. `unknown` de proposito:
   *  quem decide se da para conferir e `conferirImpressao`, nao esta validacao. */
  impressao_declarada: unknown;
  /** Cabecalhos da planilha, na ordem das colunas. */
  cabecalhos: string[];
  linhas: LinhaDaPlanilha[];
  /**
   * O formulario confirmou a posse do e-mail? Declarado por quem opera, por lote.
   * O padrao e `false`, que leva tudo para PENDENTE -- seguro, visivel, corrigivel.
   */
  email_verificado: boolean;
  casamento: OpcoesDoCasamento;
  /** So em /aplicar: a impressao do plano que o operador VIU na previa. */
  previa_impressao: string | null;
}

export type FalhaDoPedido = {
  codigo: Extract<CodigoDeErro, "INVALID_REQUEST">;
  motivo: string;
};

export type LeituraDoPedido =
  | { ok: true; pedido: PedidoDeImportacao }
  | ({ ok: false } & FalhaDoPedido);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPRESSAO_HEX = /^[0-9a-f]{64}$/i;

function recusaDePedido(motivo: string): LeituraDoPedido {
  return { ok: false, codigo: "INVALID_REQUEST", motivo };
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Le e valida o corpo do pedido. NAO interpreta o conteudo da planilha: isso e
 * `casarColunas`/`lerPlanilha`, que devolvem diagnostico completo.
 *
 * Recusa o corpo que traz `operador`, `operador_id`, `importado_por` ou
 * `participant_id`: nenhum dos dois atos que esta borda executa -- importar e
 * reconciliar -- pode ser atribuido a alguem escolhido pelo cliente.
 */
export function lerPedidoDeImportacao(bruto: unknown): LeituraDoPedido {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
    return recusaDePedido("o corpo do pedido nao e um objeto JSON");
  }
  const o = bruto as Record<string, unknown>;

  for (const proibido of ["operador", "operador_id", "importado_por", "importado_por_email"]) {
    if (o[proibido] !== undefined) {
      return recusaDePedido(
        `o corpo traz \`${proibido}\`: o responsavel pela importacao e a sessao verificada, nunca um campo do pedido`,
      );
    }
  }

  const event_id = textoOuNulo(o.event_id);
  if (event_id === null || !UUID.test(event_id)) {
    return recusaDePedido("`event_id` ausente ou nao e um UUID");
  }

  const formulario_id = textoOuNulo(o.formulario_id);
  if (formulario_id === null) {
    return recusaDePedido("`formulario_id` ausente: sem origem nao ha proveniencia");
  }
  if (formulario_id.length > 300) {
    return recusaDePedido("`formulario_id` longo demais");
  }

  if (!Array.isArray(o.cabecalhos) || o.cabecalhos.some((c) => typeof c !== "string")) {
    return recusaDePedido("`cabecalhos` ausente ou nao e uma lista de textos");
  }
  if (o.cabecalhos.length === 0) {
    return recusaDePedido("`cabecalhos` vazio: sem cabecalho nao da para casar coluna com pergunta");
  }

  if (!Array.isArray(o.linhas)) {
    return recusaDePedido("`linhas` ausente ou nao e uma lista");
  }
  const linhas: LinhaDaPlanilha[] = [];
  for (let i = 0; i < o.linhas.length; i++) {
    const l = o.linhas[i];
    if (l === null || typeof l !== "object" || Array.isArray(l)) {
      return recusaDePedido(`linha ${i} nao e um objeto`);
    }
    const r = l as Record<string, unknown>;
    if (!Array.isArray(r.celulas)) {
      return recusaDePedido(`linha ${i} sem \`celulas\``);
    }
    // `submissao_id` vazio NAO e recusado aqui: `lerPlanilha` o recusa com
    // SUBMISSAO_SEM_ID, que diz ao operador QUAL linha e por que. Validar duas
    // vezes com mensagens diferentes e dar dois nomes ao mesmo defeito.
    linhas.push({
      celulas: r.celulas as readonly unknown[],
      submissao_id: typeof r.submissao_id === "string" ? r.submissao_id : "",
    });
  }

  if (o.email_verificado !== undefined && typeof o.email_verificado !== "boolean") {
    return recusaDePedido("`email_verificado` nao e booleano");
  }

  const previa = o.previa_impressao;
  if (previa !== undefined && previa !== null) {
    if (typeof previa !== "string" || !IMPRESSAO_HEX.test(previa.trim())) {
      return recusaDePedido("`previa_impressao` nao e um SHA-256 hexadecimal de 64 digitos");
    }
  }

  const c = (o.casamento ?? {}) as Record<string, unknown>;
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    return recusaDePedido("`casamento` nao e um objeto");
  }
  if (c.ignorar !== undefined && (!Array.isArray(c.ignorar) || c.ignorar.some((x) => typeof x !== "string"))) {
    return recusaDePedido("`casamento.ignorar` nao e uma lista de textos");
  }

  return {
    ok: true,
    pedido: {
      event_id,
      formulario_id,
      formulario_nome: textoOuNulo(o.formulario_nome),
      impressao_declarada: o.impressao_declarada,
      cabecalhos: o.cabecalhos as string[],
      linhas,
      email_verificado: o.email_verificado === true,
      casamento: {
        cabecalhoDoEmail: textoOuNulo(c.cabecalhoDoEmail) ?? undefined,
        cabecalhoDoCarimbo: textoOuNulo(c.cabecalhoDoCarimbo) ?? undefined,
        ignorar: (c.ignorar as string[] | undefined) ?? undefined,
        tolerarPerguntaFaltando: c.tolerarPerguntaFaltando === true,
      },
      previa_impressao: typeof previa === "string" ? previa.trim().toLowerCase() : null,
    },
  };
}

// ===========================================================================
// 2. O CONTEXTO DO EVENTO (a unica parte que le o banco)
// ===========================================================================

export interface ContextoDoEvento {
  evento: { id: string; quiz_version: number };
  etapas: LinhaDeEtapa[];
  participantes: ParticipanteDoEvento[];
}

/** Forma minima do cliente de leitura. Qualquer coisa que saiba `from().select()`. */
export interface ClienteDeLeitura {
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: unknown): unknown;
      in?(coluna: string, valores: readonly unknown[]): unknown;
    };
  };
}

type Resposta = { data: unknown; error: unknown };

export type FalhaDeContexto = {
  codigo: Extract<
    CodigoDeErro,
    "EVENT_NOT_FOUND" | "QUIZ_STAGES_UNAVAILABLE" | "QUIZ_STAGES_INVALID" | "PARTICIPANTS_UNAVAILABLE"
  >;
  motivo: string;
};

export type LeituraDoContexto =
  | { ok: true; contexto: ContextoDoEvento; manifesto: ManifestoQuestionario }
  | ({ ok: false } & FalhaDeContexto);

/**
 * Le evento, etapas do questionario e participantes, e monta o manifesto.
 *
 * Os codigos sao os que as outras rotas administrativas ja usam para as MESMAS
 * condicoes (lib/erros/preparar-processamento.ts): "nao deu para ler as etapas"
 * e "li e estao inconsistentes" continuam sendo dois fatos.
 */
export async function lerContextoDoEvento(
  cliente: ClienteDeLeitura,
  eventId: string,
): Promise<LeituraDoContexto> {
  // --- evento ---------------------------------------------------------------
  let evento: Resposta;
  try {
    const q = cliente.from("events").select("id, quiz_version").eq("id", eventId) as {
      maybeSingle(): PromiseLike<Resposta>;
    };
    evento = await q.maybeSingle();
  } catch (e) {
    return {
      ok: false,
      codigo: "QUIZ_STAGES_UNAVAILABLE",
      motivo: `excecao ao ler o evento: ${e instanceof Error ? e.name : typeof e}`,
    };
  }
  if (evento.error) {
    return { ok: false, codigo: "QUIZ_STAGES_UNAVAILABLE", motivo: "falha ao ler o evento" };
  }
  const linhaDoEvento = evento.data as { id?: string; quiz_version?: unknown } | null;
  if (!linhaDoEvento || typeof linhaDoEvento.id !== "string") {
    return { ok: false, codigo: "EVENT_NOT_FOUND", motivo: `evento ${eventId} nao encontrado` };
  }
  const quizVersion = linhaDoEvento.quiz_version;
  if (typeof quizVersion !== "number" || !Number.isInteger(quizVersion)) {
    // Sem a versao do questionario nao da para montar manifesto nenhum: nao e
    // "o questionario esta errado", e "nao deu para saber qual e".
    return {
      ok: false,
      codigo: "QUIZ_STAGES_UNAVAILABLE",
      motivo: "o evento nao tem versao de questionario legivel",
    };
  }

  // --- etapas ---------------------------------------------------------------
  let etapas: Resposta;
  try {
    const q = cliente
      .from("quiz_stages")
      .select("id, stage_number, title, questions")
      .eq("quiz_version", quizVersion) as { order(c: string): PromiseLike<Resposta> };
    etapas = await q.order("stage_number");
  } catch (e) {
    return {
      ok: false,
      codigo: "QUIZ_STAGES_UNAVAILABLE",
      motivo: `excecao ao ler as etapas: ${e instanceof Error ? e.name : typeof e}`,
    };
  }
  if (etapas.error || !Array.isArray(etapas.data)) {
    return {
      ok: false,
      codigo: "QUIZ_STAGES_UNAVAILABLE",
      motivo: "falha ao ler as etapas do questionario",
    };
  }

  const manifesto = montarManifesto(etapas.data as LinhaDeEtapa[], quizVersion);
  if (!manifesto.ok) {
    // `montarManifesto` ja separa "nao deu para montar" de "montei e esta
    // inconsistente"; aqui so se traduz para o vocabulario de erros das rotas.
    return {
      ok: false,
      codigo: manifesto.codigo === "MANIFESTO_INDISPONIVEL" ? "QUIZ_STAGES_UNAVAILABLE" : "QUIZ_STAGES_INVALID",
      motivo: manifesto.motivo,
    };
  }

  // --- participantes --------------------------------------------------------
  let participantes: Resposta;
  try {
    const q = cliente
      .from("participants")
      .select("id, email, full_name")
      .eq("event_id", eventId) as PromiseLike<Resposta>;
    participantes = await q;
  } catch (e) {
    return {
      ok: false,
      codigo: "PARTICIPANTS_UNAVAILABLE",
      motivo: `excecao ao ler os participantes: ${e instanceof Error ? e.name : typeof e}`,
    };
  }
  if (participantes.error || !Array.isArray(participantes.data)) {
    return {
      ok: false,
      codigo: "PARTICIPANTS_UNAVAILABLE",
      motivo: "falha ao ler os participantes do evento",
    };
  }
  const linhas = participantes.data as { id: string; email: string | null; full_name: string | null }[];

  // --- respostas que cada participante JA tem ------------------------------
  // Isto nao e enfeite: e o que faz `reconciliarLote` devolver CONFLITO em vez de
  // gravar por cima de resposta existente. Ler isto errado (ou nao ler) apagaria
  // resposta de quem respondeu pelo aplicativo. Falha aqui NAO vira zero: vira
  // PARTICIPANTS_UNAVAILABLE, porque sem este numero a reconciliacao e um chute.
  const contagem = new Map<string, number>();
  const ids = linhas.map((p) => p.id);
  if (ids.length > 0) {
    let respostas: Resposta;
    try {
      const sel = cliente.from("quiz_responses").select("participant_id");
      const emLote = (sel as unknown as {
        in(c: string, v: readonly unknown[]): PromiseLike<Resposta>;
      }).in("participant_id", ids);
      respostas = await emLote;
    } catch (e) {
      return {
        ok: false,
        codigo: "PARTICIPANTS_UNAVAILABLE",
        motivo: `excecao ao contar respostas ja existentes: ${e instanceof Error ? e.name : typeof e}`,
      };
    }
    if (respostas.error || !Array.isArray(respostas.data)) {
      return {
        ok: false,
        codigo: "PARTICIPANTS_UNAVAILABLE",
        motivo:
          "falha ao contar as respostas que os participantes ja tem; sem isso a reconciliacao poderia gravar por cima",
      };
    }
    for (const r of respostas.data as { participant_id?: unknown }[]) {
      if (typeof r.participant_id !== "string") continue;
      contagem.set(r.participant_id, (contagem.get(r.participant_id) ?? 0) + 1);
    }
  }

  return {
    ok: true,
    manifesto: manifesto.manifesto,
    contexto: {
      evento: { id: linhaDoEvento.id, quiz_version: quizVersion },
      etapas: etapas.data as LinhaDeEtapa[],
      participantes: linhas.map((p) => ({
        id: p.id,
        email: p.email ?? "",
        full_name: p.full_name ?? "",
        respostas_existentes: contagem.get(p.id) ?? 0,
      })),
    },
  };
}

// ===========================================================================
// 3. O PLANO
// ===========================================================================

export type FalhaDaBorda = {
  codigo: CodigoDeErro;
  motivo: string;
  detalhes?: DetalhesDeErro;
};

export type MontagemDoPlano =
  | { ok: true; plano: PlanoAceito; previa: Previa }
  | ({ ok: false } & FalhaDaBorda);

/** Qual codigo HTTP corresponde a cada recusa do planejador. Uma tabela, nao um `if`. */
const CODIGO_DA_RECUSA_DO_PLANO: Record<CodigoDeRecusaDoPlano, CodigoDeErro> = {
  // CONFERIDO e NAO BATE.
  MANIFESTO_DIFERENTE: "IMPORT_MANIFEST_MISMATCH",
  // NAO DEU PARA CONFERIR. Nao e "bate" e nao e "nao bate".
  MANIFESTO_INDISPONIVEL: "IMPORT_MANIFEST_UNVERIFIABLE",
  OPERADOR_AUSENTE: "IMPORT_PLAN_REFUSED",
  ORIGEM_AUSENTE: "IMPORT_PLAN_REFUSED",
  VERSAO_DIVERGENTE: "IMPORT_PLAN_REFUSED",
};

const PORTAO_DA_RECUSA: Partial<Record<CodigoDeRecusaDoPlano, NonNullable<DetalhesDeErro["portao"]>>> = {
  OPERADOR_AUSENTE: "operador",
  ORIGEM_AUSENTE: "origem",
  VERSAO_DIVERGENTE: "versao",
};

const DIVERGENCIA_DO_CASAMENTO = {
  COLUNA_DESCONHECIDA: "coluna_desconhecida",
  COLUNA_AMBIGUA: "coluna_ambigua",
  COLUNA_FALTANDO: "coluna_faltando",
  EMAIL_SEM_COLUNA: "email_sem_coluna",
} as const;

/**
 * Monta o plano a partir do contexto do evento e do pedido. E ESTA funcao que a
 * previa e a aplicacao chamam -- as duas, sobre o mesmo pedido.
 *
 * O `operador` vem da sessao verificada, nunca do pedido.
 */
export function montarPlanoDaBorda(
  contexto: ContextoDoEvento,
  manifesto: ManifestoQuestionario,
  pedido: PedidoDeImportacao,
  operador: OperadorDaImportacao,
): MontagemDoPlano {
  // --- a planilha: cabecalho por cabecalho, sem adivinhar nada --------------
  const casado = casarColunas(manifesto, pedido.cabecalhos, pedido.casamento);
  if (!casado.ok) {
    const itens =
      casado.codigo === "COLUNA_DESCONHECIDA"
        ? casado.casamento.desconhecidos.map((c) => c.cabecalho)
        : casado.codigo === "COLUNA_AMBIGUA"
          ? casado.casamento.cabecalhosDuplicados
          : casado.codigo === "COLUNA_FALTANDO"
            ? casado.casamento.perguntasSemColuna
            : [];
    return {
      ok: false,
      codigo: "IMPORT_SPREADSHEET_INVALID",
      motivo: casado.motivo,
      detalhes: { divergencia: DIVERGENCIA_DO_CASAMENTO[casado.codigo], itens },
    };
  }

  const lida = lerPlanilha(casado.casamento, pedido.linhas, {
    emailVerificado: pedido.email_verificado,
  });
  if (!lida.ok) {
    return {
      ok: false,
      codigo: "IMPORT_SPREADSHEET_INVALID",
      motivo: lida.motivo,
      detalhes: {
        divergencia: lida.codigo === "SUBMISSAO_SEM_ID" ? "submissao_sem_id" : "linha_curta",
        linha: lida.linha,
      },
    };
  }

  // --- os cinco portoes do planejador --------------------------------------
  const plano = planejarImportacao({
    evento: contexto.evento,
    manifesto,
    origem: {
      formulario_id: pedido.formulario_id,
      formulario_nome: pedido.formulario_nome,
      impressao_declarada: pedido.impressao_declarada,
    },
    submissoes: lida.submissoes,
    participantes: contexto.participantes,
    operador,
  });

  if (!plano.ok) {
    const detalhes: DetalhesDeErro = {};
    const portao = PORTAO_DA_RECUSA[plano.codigo];
    if (portao) detalhes.portao = portao;
    if (plano.codigo === "VERSAO_DIVERGENTE") {
      detalhes.versao_declarada = manifesto.quiz_version;
      detalhes.versao_do_evento = contexto.evento.quiz_version;
    }
    if (plano.conferencia?.veredito === "diferente") {
      detalhes.impressao_declarada = plano.conferencia.declarada;
      detalhes.impressao_do_sistema = plano.conferencia.doSistema;
    }
    return {
      ok: false,
      codigo: CODIGO_DA_RECUSA_DO_PLANO[plano.codigo],
      motivo: plano.motivo,
      detalhes,
    };
  }

  return { ok: true, plano, previa: resumirPrevia(plano, manifesto) };
}

// ===========================================================================
// 4. A PREVIA: o que o operador VE antes de autorizar
// ===========================================================================

export type Instrumento = "likert" | "elementos" | "situacionais";

export interface PerguntaIncompativel {
  pergunta_id: string;
  /** O enunciado como o sistema o conhece, para o operador comparar com o formulario. */
  enunciado: string;
  pontuada: boolean;
  instrumento: Instrumento | null;
  /** Quantas submissoes falharam NESTA pergunta. */
  submissoes: number;
  causas: Partial<Record<CausaDeIncompatibilidade, number>>;
  /** Ate tres exemplos, para o operador reconhecer o erro de copia de imediato. */
  exemplos: { submissao_id: string; respondido: string; motivo: string }[];
}

export interface CoberturaDeInstrumento {
  instrumento: Instrumento;
  perguntas: number;
  compativeis: number;
  incompativeis: number;
  ausentes: number;
  /** compativeis / (submissoes com identidade resolvida x perguntas). 0..1, ou null se nao ha base. */
  cobertura: number | null;
}

export interface PrevisaoDeCobertura {
  /** Submissoes com identidade resolvida: a base sobre a qual a cobertura e medida. */
  base_de_submissoes: number;
  perguntas_pontuadas: number;
  por_instrumento: CoberturaDeInstrumento[];
  /** Cobertura pontuavel do lote inteiro, 0..1, ou null quando nao ha base. */
  geral: number | null;
}

export interface LinhaDaPrevia {
  submissao_id: string;
  estado: EstadoDaSubmissao;
  /** O que a coleta trouxe, para o operador reconhecer a pessoa. Nunca usado para casar. */
  email: string | null;
  nome_declarado: string | null;
  participant_id: string | null;
  identidade_via: "email_verificado" | "decisao_do_operador" | null;
  /** Por que a identidade nao resolveu, quando nao resolveu. */
  motivo_da_identidade: string | null;
  apto_para_pontuar: boolean;
  bloqueio: { motivo: string; perguntas: string[] } | null;
  etapas_a_gravar: number;
  contagens: PlanoAceito["submissoes"][number]["contagens"];
}

export interface Previa {
  evento_id: string;
  quiz_version: number;
  questionario_impressao: string;
  /** Sempre "igual": uma previa so existe depois do portao do manifesto. */
  conferencia_do_manifesto: "igual";
  origem: { formulario_id: string; formulario_nome: string | null };
  operador: { id: string; email: string | null };

  /** Quantas submissoes ENTRAM (viram resposta canonica pontuavel). */
  entram: number;
  /** Quantas ficam RETIDAS por identidade, e por que. Nunca criadas, nunca descartadas. */
  retidas_por_identidade: {
    pendentes: number;
    conflitos: number;
    submissoes: { submissao_id: string; estado: "pendente" | "conflito"; email: string | null; motivo: string }[];
  };
  /** Quantas tem DADO INCOMPATIVEL, e EM QUAIS PERGUNTAS. Nunca pontuacao zero. */
  com_dado_incompativel: {
    submissoes: number;
    /** Toda resposta que falhou a correspondencia, pontuada ou nao. */
    itens: number;
    /** So as que o motor pontua: sao estas que apagam instrumento. */
    itens_pontuados: number;
    perguntas: PerguntaIncompativel[];
  };

  /**
   * O que a funcao do banco vai gravar. Estes dois numeros sao os MESMOS que
   * `importacao_externa_aplicar` devolve em `linhas_de_resposta_gravadas` e
   * `itens_registrados`: e com eles que se confere, depois, que a previa batia.
   */
  linhas_de_resposta_a_gravar: number;
  itens_a_registrar: number;

  cobertura: PrevisaoDeCobertura;
  submissoes: LinhaDaPrevia[];
  /** A impressao do plano. Volta em /aplicar e amarra a previa ao que e gravado. */
  impressao_da_previa: string;
}

function instrumentoDe(perguntaId: string): Instrumento | null {
  if (IDS_SITUACIONAIS.has(perguntaId)) return "situacionais";
  if (IDS_LIKERT.has(perguntaId)) return "likert";
  if (IDS_ELEMENTOS.has(perguntaId)) return "elementos";
  return null;
}

function descreverBruto(valor: unknown): string {
  let t: string;
  try {
    t = typeof valor === "string" ? valor : (JSON.stringify(valor) ?? String(valor));
  } catch {
    t = String(valor);
  }
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/**
 * O resumo que a tela mostra ANTES de gravar.
 *
 * NAO recalcula o que o planejador ja decidiu: os estados, as contagens e o
 * `apto_para_pontuar` sao LIDOS do plano. Recontar aqui abriria a porta para a
 * previa e a gravacao discordarem -- que e exatamente o que esta borda existe
 * para impedir.
 */
export function resumirPrevia(plano: PlanoAceito, manifesto?: ManifestoQuestionario): Previa {
  const porPergunta = new Map<string, PerguntaIncompativel>();
  const retidas: Previa["retidas_por_identidade"]["submissoes"] = [];
  const linhas: LinhaDaPrevia[] = [];

  let submissoesComIncompativel = 0;
  let itensIncompativeis = 0;
  let itensIncompativeisPontuados = 0;
  let linhasAGravar = 0;
  let itensARegistrar = 0;

  // A cobertura e medida SO sobre identidade resolvida: contar uma submissao
  // pendente como "0% de cobertura" inventaria um resultado para uma pessoa que
  // ainda nao se sabe quem e.
  const base = plano.submissoes.filter((s) => s.participant_id !== null);
  const contagemPorInstrumento: Record<Instrumento, { compativeis: number; incompativeis: number; ausentes: number }> = {
    likert: { compativeis: 0, incompativeis: 0, ausentes: 0 },
    elementos: { compativeis: 0, incompativeis: 0, ausentes: 0 },
    situacionais: { compativeis: 0, incompativeis: 0, ausentes: 0 },
  };

  for (const s of plano.submissoes) {
    linhasAGravar += s.etapas.length;
    itensARegistrar += s.itens.length;

    if (s.estado === "pendente" || s.estado === "conflito") {
      retidas.push({
        submissao_id: s.submissao_id,
        estado: s.estado,
        email: s.coleta.email,
        motivo: s.bloqueio?.motivo ?? "identidade nao resolvida",
      });
    }

    let temIncompativel = false;
    for (const item of s.itens) {
      const instrumento = instrumentoDe(item.pergunta_id);

      if (item.estado === "incompativel") {
        temIncompativel = true;
        itensIncompativeis++;
        if (item.pontuada) itensIncompativeisPontuados++;

        const atual = porPergunta.get(item.pergunta_id) ?? {
          pergunta_id: item.pergunta_id,
          // O enunciado COMO O SISTEMA O CONHECE: e com ele que o operador acha a
          // palavra trocada no formulario, sem abrir o banco.
          enunciado: manifesto?.porId[item.pergunta_id]?.text ?? "",
          pontuada: item.pontuada,
          instrumento,
          submissoes: 0,
          causas: {},
          exemplos: [],
        };
        atual.submissoes++;
        atual.causas[item.causa] = (atual.causas[item.causa] ?? 0) + 1;
        if (atual.exemplos.length < 3) {
          atual.exemplos.push({
            submissao_id: s.submissao_id,
            respondido: descreverBruto(item.bruto),
            motivo: item.motivo,
          });
        }
        porPergunta.set(item.pergunta_id, atual);
      }

      // A cobertura por instrumento conta APENAS as submissoes da base.
      if (instrumento !== null && s.participant_id !== null) {
        if (item.estado === "compativel") contagemPorInstrumento[instrumento].compativeis++;
        else if (item.estado === "incompativel") contagemPorInstrumento[instrumento].incompativeis++;
        else contagemPorInstrumento[instrumento].ausentes++;
      }
    }
    if (temIncompativel) submissoesComIncompativel++;

    linhas.push({
      submissao_id: s.submissao_id,
      estado: s.estado,
      email: s.coleta.email,
      nome_declarado: s.coleta.nome_declarado,
      participant_id: s.participant_id,
      identidade_via: s.proveniencia.identidade_via,
      motivo_da_identidade:
        s.identidade.estado === "reconciliada" ? null : s.identidade.explicacao,
      apto_para_pontuar: s.apto_para_pontuar,
      bloqueio: s.bloqueio,
      etapas_a_gravar: s.etapas.length,
      contagens: s.contagens,
    });
  }

  const perguntasPorInstrumento: Record<Instrumento, number> = {
    likert: IDS_LIKERT.size,
    elementos: IDS_ELEMENTOS.size,
    situacionais: IDS_SITUACIONAIS.size,
  };
  const porInstrumento: CoberturaDeInstrumento[] = (
    ["likert", "elementos", "situacionais"] as Instrumento[]
  ).map((i) => {
    const n = perguntasPorInstrumento[i];
    const possiveis = base.length * n;
    return {
      instrumento: i,
      perguntas: n,
      ...contagemPorInstrumento[i],
      cobertura: possiveis === 0 ? null : contagemPorInstrumento[i].compativeis / possiveis,
    };
  });

  const totalPontuadas = IDS_LIKERT.size + IDS_ELEMENTOS.size + IDS_SITUACIONAIS.size;
  const compativeisPontuadas = porInstrumento.reduce((a, i) => a + i.compativeis, 0);
  const possiveisGerais = base.length * totalPontuadas;

  const previaSemImpressao: Omit<Previa, "impressao_da_previa"> = {
    evento_id: plano.evento_id,
    quiz_version: plano.quiz_version,
    questionario_impressao: plano.questionario_impressao,
    conferencia_do_manifesto: "igual",
    origem: { formulario_id: plano.origem.formulario_id, formulario_nome: plano.origem.formulario_nome ?? null },
    operador: { id: plano.operador.id, email: plano.operador.email ?? null },
    entram: plano.resumo.importaveis,
    retidas_por_identidade: {
      pendentes: plano.resumo.pendentes,
      conflitos: plano.resumo.conflitos,
      submissoes: retidas,
    },
    com_dado_incompativel: {
      submissoes: submissoesComIncompativel,
      itens: itensIncompativeis,
      itens_pontuados: itensIncompativeisPontuados,
      perguntas: [...porPergunta.values()].sort((a, b) =>
        a.pontuada === b.pontuada ? a.pergunta_id.localeCompare(b.pergunta_id) : a.pontuada ? -1 : 1,
      ),
    },
    linhas_de_resposta_a_gravar: linhasAGravar,
    itens_a_registrar: itensARegistrar,
    cobertura: {
      base_de_submissoes: base.length,
      perguntas_pontuadas: totalPontuadas,
      por_instrumento: porInstrumento,
      geral: possiveisGerais === 0 ? null : compativeisPontuadas / possiveisGerais,
    },
    submissoes: linhas,
  };

  return { ...previaSemImpressao, impressao_da_previa: impressaoDaPrevia(plano) };
}

/**
 * A impressao digital DO PLANO: SHA-256 do plano inteiro, serializado.
 *
 * Do plano INTEIRO de proposito, e nao de uma selecao dos campos que a funcao SQL
 * le. Uma selecao seria uma segunda copia da regra "o que importa para gravar", e
 * duas copias divergem. Assim, se qualquer coisa que o planejador decidiu mudar
 * entre a previa e a confirmacao, a confirmacao RECUSA.
 *
 * O custo e um falso vencimento quando algo irrelevante muda (um participante
 * entrou no evento sem relacao com este lote). O beneficio e que nunca se grava o
 * que a tela nao mostrou. A troca e deliberada e nesta direcao.
 */
export function impressaoDaPrevia(plano: PlanoAceito): string {
  return createHash("sha256").update(JSON.stringify(plano), "utf8").digest("hex");
}

// ===========================================================================
// 5. A GRAVACAO
// ===========================================================================

export interface ClienteDeAplicacao {
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: ErroRpcCru | null }>;
}

/**
 * Uma submissao que o PLANO autorizava e que o BANCO recusou na revalidacao
 * DENTRO da transacao (migration 024): entre a previa e a gravacao, a resposta
 * canonica daquelas etapas passou a ter outro dono -- a pessoa respondeu pelo
 * aplicativo, ou outra coleta chegou primeiro.
 *
 * Lida aqui, e nao descartada, porque "gravei 48 de 50" sem dizer QUAIS duas e
 * por que e a mesma omissao silenciosa que este projeto existe para nao repetir.
 */
export interface RecusaNaRevalidacao {
  submissao_id: string;
  /** O codigo da 024: `resposta_do_aplicativo`, `outra_submissao_externa`, ... */
  codigo: string;
  /**
   * O estado em que a submissao FICOU no banco depois da recusa. Como o lote e
   * atomico e NADA foi gravado, e o estado que ela ja tinha -- ou `null` quando
   * ela nunca foi gravada. `null` nao e "conflito" nem "" : e "nao existe linha".
   */
  estado: string | null;
  /** O estado que o PLANO pretendia gravar. */
  estado_do_plano: string | null;
  /** O participante a quem esta submissao seria atribuida, se houver. */
  participante_pretendido: string | null;
  /** As etapas cuja resposta canonica passou a ter outro dono. Ids de etapa. */
  etapas_em_conflito: string[];
  etapas_nao_gravadas: number;
  /**
   * A prosa do banco. Vai para o LOG (a `causa` de `erroHttp`) e NUNCA para a
   * tela: o que o operador le nasce em lib/erros/mensagens-host.ts, a partir do
   * `codigo`. Texto interno de banco nao chega a quem conduz o evento.
   */
  motivo: string;
}

/**
 * O que a funcao do banco devolveu sobre o LOTE -- nos dois desfechos.
 *
 * `ok: false` NAO e um sucesso com numeros estranhos: e o LOTE RECUSADO da
 * migration 024, com todos os contadores em zero porque nada foi gravado, e com
 * `recusadas_na_revalidacao` dizendo quais submissoes causaram e por que. Remontar
 * so os contadores e descartar esses campos -- o que esta borda fazia antes --
 * entregava ao operador a divergencia generica da conferencia ("a previa disse 5
 * e o banco gravou 0") em vez da instrucao que ele precisa.
 */
export interface ResumoDaGravacao {
  /** `true` gravou, `false` RECUSOU o lote inteiro. Ausente no banco pre-024: ausencia e sucesso. */
  ok: boolean;
  /** O codigo DO BANCO na recusa (`LOTE_RECUSADO_NA_REVALIDACAO`); `null` no sucesso. */
  codigo: string | null;
  /** A prosa do banco na recusa, para o LOG; `null` no sucesso. Nunca para a tela. */
  motivo: string | null;
  evento_id: string;
  formulario_id: string;
  questionario_impressao: string;
  /** A marca do lote (md5 do plano), como a 024 a devolve. `null` em banco que nao a tem. */
  lote_impressao: string | null;
  por_estado: Partial<Record<EstadoDaSubmissao, number>>;
  linhas_de_resposta_gravadas: number;
  itens_registrados: number;
  importado_por: string;
  /** Vazio e uma AFIRMACAO ("nada foi recusado"), nao uma omissao. */
  recusadas_na_revalidacao: RecusaNaRevalidacao[];
}

export type Aplicacao =
  | { ok: true; resumo: ResumoDaGravacao }
  /**
   * `recusa` presente significa UM fato especifico: o banco CONFERIU e NAO
   * PERMITIU, e nada foi gravado. Ausente, a falha e das outras duas naturezas
   * ("nao esta instalado" / "nao respondeu"), e nenhuma das tres se confunde.
   */
  | ({ ok: false; recusa?: ResumoDaGravacao } & FalhaDaBorda);

/**
 * "O recurso nao esta instalado" x "o recurso nao respondeu".
 *
 * Mesma classificacao que `codigoDeFalhaDeFila` faz para a fila, e pelo mesmo
 * motivo: mandar instalar o que nao falta manda o operador investigar a coisa
 * errada, e no meio de um evento isso custa o evento.
 */
export function codigoDeFalhaDaImportacao(
  erro: ErroRpcCru | null | undefined,
): "IMPORT_SCHEMA_MISSING" | "IMPORT_UNAVAILABLE" {
  return indicaEsquemaAusente(erro) ? "IMPORT_SCHEMA_MISSING" : "IMPORT_UNAVAILABLE";
}

const NOME_DA_FUNCAO = "importacao_externa_aplicar";

/**
 * Grava o plano, numa transacao, pela funcao do banco. Nao decide nada: o plano
 * ja decidiu, e a funcao recusa plano que ela nao autoriza.
 */
export async function aplicarPlano(
  cliente: ClienteDeAplicacao,
  plano: PlanoAceito,
): Promise<Aplicacao> {
  let resposta: { data: unknown; error: ErroRpcCru | null };
  try {
    resposta = await cliente.rpc(NOME_DA_FUNCAO, { plano });
  } catch (e) {
    // Excecao ao falar com o banco: NAO e ausencia de esquema. Nao se manda
    // instalar nada com base num socket fechado.
    return {
      ok: false,
      codigo: "IMPORT_UNAVAILABLE",
      motivo: `excecao ao gravar: ${e instanceof Error ? e.name : typeof e}`,
    };
  }
  if (resposta.error) {
    return {
      ok: false,
      codigo: codigoDeFalhaDaImportacao(resposta.error),
      motivo: resposta.error.message ?? "falha ao gravar a importacao",
    };
  }
  const d = resposta.data as Record<string, unknown> | null;
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    // A funcao respondeu sem o resumo: NAO da para afirmar o que foi gravado.
    // Dizer "pronto" aqui seria afirmar um numero que nao se tem.
    return {
      ok: false,
      codigo: "IMPORT_UNAVAILABLE",
      motivo: "a funcao de importacao respondeu sem resumo: nao da para afirmar o que foi gravado",
    };
  }

  // `ok` AUSENTE e sucesso: e a funcao da 022, que nao tinha este campo e nao
  // tinha revalidacao. `ok` presente com valor que nao e booleano nao e nenhuma
  // das duas coisas -- nao da para afirmar nem gravacao nem recusa.
  if (d.ok !== undefined && typeof d.ok !== "boolean") {
    return {
      ok: false,
      codigo: "IMPORT_UNAVAILABLE",
      motivo: `a funcao de importacao respondeu com 'ok' de tipo ${typeof d.ok}: nao da para afirmar se gravou ou recusou`,
    };
  }

  const resumo = lerResumoDaGravacao(d);

  // --------------------------------------------------------------------------
  // A RESPOSTA SE CONTRADIZ? Antes de ler o desfecho, nos DOIS sentidos.
  //
  // E a mesma regra, e por isso ela e UMA funcao: "gravou e recusou" nao existe,
  // venha a contradicao de que lado vier. Afirmar o desfecho que o `ok` diz, com
  // o resto do corpo dizendo o contrario, e confiar num invariante do banco em
  // vez de conferi-lo -- e a tela afirmaria "NADA foi gravado" em cima de um
  // corpo que informa cinco linhas gravadas.
  // --------------------------------------------------------------------------
  const contradicao = contradicaoDaGravacao(resumo);
  if (contradicao !== null) {
    return { ok: false, codigo: "IMPORT_WRITE_UNVERIFIABLE", motivo: contradicao };
  }

  if (resumo.ok === false) {
    // ---------------------------------------------------------------------
    // LOTE RECUSADO NA REVALIDACAO (migration 024). Desfecho PREVISTO: o banco
    // conferiu dentro da transacao e nao permitiu. Nada foi gravado -- nem as
    // submissoes sem conflito --, e a resposta que cada participante tinha
    // continua intacta.
    // ---------------------------------------------------------------------
    if (!recusaUtilizavel(resumo.recusadas_na_revalidacao)) {
      // Um retorno que diz RECUSA e nao diz QUAIS submissoes nao autoriza
      // afirmar "recusa sem motivo": nao se promete o que nao foi verificado.
      // Isto e INDISPONIBILIDADE -- o recurso existe, respondeu, e o que
      // respondeu nao da para ler.
      return {
        ok: false,
        codigo: "IMPORT_UNAVAILABLE",
        motivo: `a funcao de importacao disse ${resumo.codigo ?? "recusa"} e nao disse quais submissoes recusou (${resumo.recusadas_na_revalidacao.length} entrada(s) ilegivel(eis)): nao da para afirmar o motivo`,
      };
    }
    return {
      ok: false,
      codigo: "IMPORT_REVALIDATION_REFUSED",
      motivo: `${resumo.codigo ?? "LOTE_RECUSADO_NA_REVALIDACAO"}: ${resumo.motivo ?? "o banco recusou o lote na revalidacao"}`,
      detalhes: detalhesDaRecusaDoLote(resumo.recusadas_na_revalidacao),
      recusa: resumo,
    };
  }

  return { ok: true, resumo };
}

/**
 * "GRAVOU e RECUSOU" nao existe. Esta funcao e a unica que decide isso, e ela
 * olha os DOIS sentidos da mesma contradicao:
 *
 *   `ok: true` com recusas NOMEADAS. Na 024, lote gravado tem lista VAZIA -- e e
 *   assim que a lista vazia e uma AFIRMACAO ("nada foi recusado"). Aceitar como
 *   sucesso descartaria em silencio uma recusa que o banco nomeou.
 *
 *   `ok: false` com ESCRITA informada (linhas, itens ou `por_estado` nao-vazio).
 *   Na 024, a recusa decide ANTES de escrever qualquer coisa do plano e sai com
 *   todos os contadores em zero -- os zeros sao a afirmacao de que o lote nao
 *   entrou. Aceitar como recusa normal faria a tela afirmar "NADA foi gravado, e
 *   nada que existia foi tocado" em cima de um corpo que informa escrita.
 *
 * Nenhum dos dois e defeito observado em producao: sob a 024 de hoje nenhum
 * acontece. Sao invariantes do banco, e esta borda os CONFERE em vez de confiar
 * neles -- porque o preco de confiar e uma afirmacao falsa sobre o que foi escrito
 * no documento de alguem, e afirmacao falsa deixa quem le tranquilo.
 *
 * Devolve a descricao da contradicao (para o LOG), ou `null` quando o corpo e
 * coerente.
 */
function contradicaoDaGravacao(resumo: ResumoDaGravacao): string | null {
  const escritas: string[] = [];
  if (resumo.linhas_de_resposta_gravadas !== 0) {
    escritas.push(`linhas_de_resposta_gravadas=${resumo.linhas_de_resposta_gravadas}`);
  }
  if (resumo.itens_registrados !== 0) escritas.push(`itens_registrados=${resumo.itens_registrados}`);
  const porEstado = Object.entries(resumo.por_estado).filter(([, n]) => Number(n) !== 0);
  if (porEstado.length > 0) {
    escritas.push(`por_estado={${porEstado.map(([e, n]) => `${e}=${n}`).join(", ")}}`);
  }
  const recusas = resumo.recusadas_na_revalidacao.length;

  if (resumo.ok === false && escritas.length > 0) {
    return `a funcao de importacao disse ${resumo.codigo ?? "recusa"} (lote recusado, nada gravado) e informou escrita no MESMO retorno (${escritas.join(", ")}): nao da para afirmar o que foi gravado nem o que nao foi`;
  }
  if (resumo.ok === true && recusas > 0) {
    return `a funcao de importacao afirmou gravacao e listou ${recusas} recusa(s) no MESMO retorno: nao da para afirmar o que foi gravado nem o que nao foi`;
  }
  return null;
}

/**
 * O retorno da funcao do banco, lido campo por campo -- os DOIS desfechos pelo
 * MESMO leitor. Um leitor para o sucesso e outro para a recusa divergiriam, e
 * divergir aqui e a tela afirmando uma coisa e o banco tendo feito outra.
 */
function lerResumoDaGravacao(d: Record<string, unknown>): ResumoDaGravacao {
  const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    // Ausencia de `ok` e SUCESSO (banco pre-024). Nao se inventa recusa onde a
    // funcao antiga nao recusava nada.
    ok: d.ok === undefined ? true : d.ok === true,
    codigo: texto(d.codigo),
    motivo: texto(d.motivo),
    evento_id: String(d.evento_id ?? ""),
    formulario_id: String(d.formulario_id ?? ""),
    questionario_impressao: String(d.questionario_impressao ?? ""),
    lote_impressao: texto(d.lote_impressao),
    por_estado: (d.por_estado ?? {}) as Partial<Record<EstadoDaSubmissao, number>>,
    linhas_de_resposta_gravadas: Number(d.linhas_de_resposta_gravadas ?? 0),
    itens_registrados: Number(d.itens_registrados ?? 0),
    importado_por: String(d.importado_por ?? ""),
    // A lista da 024. Ausente em banco que ainda nao a tem: ausencia da lista e
    // lista vazia, e e assim que ela nao inventa recusa onde a funcao antiga
    // nao recusava nada.
    recusadas_na_revalidacao: Array.isArray(d.recusadas_na_revalidacao)
      ? (d.recusadas_na_revalidacao as unknown[])
          .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r))
          .map((r) => ({
            submissao_id: String(r.submissao_id ?? ""),
            codigo: String(r.codigo ?? ""),
            estado: texto(r.estado),
            estado_do_plano: texto(r.estado_do_plano),
            participante_pretendido: texto(r.participante_pretendido),
            etapas_em_conflito: Array.isArray(r.etapas_em_conflito)
              ? (r.etapas_em_conflito as unknown[]).map((e) => String(e)).filter((e) => e !== "")
              : [],
            etapas_nao_gravadas: Number(r.etapas_nao_gravadas ?? 0),
            motivo: String(r.motivo ?? ""),
          }))
      : [],
  };
}

/**
 * A lista de recusadas da para LER? Vazia, nao. Com entrada que nao nomeia a
 * submissao ou a causa, nao.
 *
 * Nao e preciosismo: a unica acao que resolve um lote recusado e pedir previa
 * nova SEM as conflitantes, e isso exige saber QUAIS sao. Uma lista que nao
 * nomeia nao instrui ninguem, e afirmar "recusado" sem poder dizer o que tirar da
 * planilha e o enigma que esta unidade existe para acabar.
 */
function recusaUtilizavel(recusadas: RecusaNaRevalidacao[]): boolean {
  return (
    recusadas.length > 0 &&
    recusadas.every((r) => r.submissao_id.trim() !== "" && r.codigo.trim() !== "")
  );
}

/**
 * Os detalhes SEGUROS da recusa do lote, para a tela. So o que o operador ja tem
 * em maos: o id da submissao da planilha dele, o nome fechado da causa e numeros.
 * Nenhum texto de banco, nenhum e-mail de terceiro.
 *
 * `revalidacao` (a causa da PRIMEIRA recusada) existe para a mensagem do host
 * poder nomear uma causa numa frase; a lista inteira vai em `recusadas`, e e
 * dela que a tela monta o que o operador tem de tirar da planilha.
 */
function detalhesDaRecusaDoLote(recusadas: RecusaNaRevalidacao[]): DetalhesDeErro {
  const nomeada = (c: string): CodigoDaRevalidacao | null => (ehCodigoDaRevalidacao(c) ? c : null);
  const primeira = nomeada(recusadas[0]?.codigo ?? "");
  return {
    ato: "importar_lote",
    ...(primeira === null ? {} : { revalidacao: primeira }),
    recusadas: recusadas.map((r) => ({
      submissao_id: r.submissao_id,
      codigo: nomeada(r.codigo),
      etapas_em_conflito: r.etapas_em_conflito,
      etapas_nao_gravadas: r.etapas_nao_gravadas,
    })),
  };
}

/**
 * A previa que o operador viu e a MESMA coisa que seria gravada agora?
 *
 * Tres desfechos, como o resto do projeto: bate, NAO bate, ou nao foi declarada.
 * "Nao declarada" tambem recusa: confirmar sem dizer o que se viu e confirmar no
 * escuro, e e o passo em que a previa deixaria de servir para alguma coisa.
 */
export function conferirPrevia(
  declarada: string | null,
  plano: PlanoAceito,
): { ok: true } | ({ ok: false } & FalhaDaBorda) {
  const atual = impressaoDaPrevia(plano);
  if (declarada === null || declarada.trim() === "") {
    return {
      ok: false,
      codigo: "IMPORT_PREVIEW_STALE",
      motivo:
        "a confirmacao nao declarou a impressao da previa: sem ela nao da para afirmar que o que foi conferido e o que seria gravado",
    };
  }
  if (declarada.trim().toLowerCase() !== atual) {
    return {
      ok: false,
      codigo: "IMPORT_PREVIEW_STALE",
      motivo: `a previa conferida (${declarada.trim().slice(0, 16)}...) nao corresponde ao plano atual (${atual.slice(0, 16)}...)`,
    };
  }
  return { ok: true };
}
