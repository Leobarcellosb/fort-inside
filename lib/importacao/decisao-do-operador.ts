// A BORDA DA DECISAO DO OPERADOR sobre a identidade de uma submissao externa:
// tudo o que as rotas de reconciliar e de revogar decidem, SEM Next e SEM banco.
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// A borda da importacao (borda.ts) deixou uma coisa sem borda, e ela declarou
// isso: "Reconciliacao manual nao tem borda. A funcao existe em
// reconciliar-identidade.ts e importacao_externa_revogar existe no banco, mas nao
// ha rota nem tela: hoje o operador VE as pendentes e os conflitos, e nao pode
// resolve-los pela interface." Num evento de 50 pessoas com coleta por fora,
// pendencia nao e caso raro: e caso comum. Sem esta borda, sair de PENDENTE exige
// alguem rodando SQL na mao -- sem ficha, sem conferencia e sem justificativa.
//
// O QUE ESTA EM JOGO, e e diferente do que estava na importacao
// -------------------------------------------------------------
// Reconciliar a mao e afirmar "esta submissao e desta pessoa" SEM que o sistema
// tenha verificado. E poder real sobre dado de outra pessoa: errar aqui entrega o
// prognostico de A para B, com o nome de B no documento. Dai as tres coisas que
// esta borda nunca dispensa:
//
//   1. A FICHA. O operador ve a submissao, o e-mail declarado, se o formulario
//      verificou esse e-mail, o nome declarado, o participante escolhido, e O QUE
//      NAO BATE, nomeado item por item. Confirmar sem ver o que se confirma e o
//      oposto do que este projeto construiu.
//   2. A IMPRESSAO DA FICHA. A confirmacao devolve o SHA-256 da ficha que estava
//      na tela, e a rota RECUSA (IMPORT_DECISION_STALE) se a ficha de agora nao
//      for byte a byte aquela. Mesma disciplina de `impressaoDaPrevia`, e pelo
//      mesmo motivo: uma tela velha nao pode afirmar de quem e uma resposta.
//   3. O ATO, REGISTRADO E NOMEADO. Quem decidiu, quando, e por que. O operador
//      vem da sessao verificada, NUNCA do corpo do pedido: auditoria escrita pelo
//      auditado nao e auditoria. `lerPedidoDeReconciliacao` RECUSA o corpo que
//      traga campo de operador, igual a borda da importacao.
//
// O PORTAO DO ALVO OCUPADO, e o caso que mais machuca
// ---------------------------------------------------
// MEDIDO contra Postgres real (lib/importacao/provas/decisao-http.test.ts): se o
// participante escolhido JA TEM resposta canonica, `importacao_externa_aplicar`
// grava as importadas POR CIMA (o upsert e por (participant_id, stage_id) e
// atualiza `answers`, `origem` e `external_submission_id`), e a resposta anterior
// deixa de existir -- nao ha historico de `quiz_responses`. Revogar depois REMOVE
// as linhas importadas e NAO devolve as antigas: o participante termina com zero.
// Ou seja: a reconciliacao e reversivel no HISTORICO e na LIGACAO, e NAO e
// reversivel no dado que ela sobrescreveu.
//
// Por isso esta borda RECUSA, antes de qualquer escrita, atribuir submissao a
// participante que ja tem resposta propria ou outra submissao externa ativa
// (IMPORT_TARGET_OCCUPIED), e a ficha diz isso ANTES do clique, nao depois. O
// caminho legitimo para trocar continua existindo e e explicito: revogar o que
// esta ligado (ato registrado) e so entao reconciliar.
//
// A ORDEM DAS DUAS ESCRITAS DA RECONCILIACAO, e por que e esta
// -----------------------------------------------------------
// A 022 tem `importacao_externa_aplicar` (grava o plano) e
// `importacao_externa_revogar` (desfaz, numa transacao, com o ato dentro). Nao ha
// funcao de banco que grave a reconciliacao do operador E o ato
// 'reconciliada_pelo_operador' juntos -- e nao se escreve migration aqui. Entao a
// rota faz DUAS escritas, nesta ordem: PRIMEIRO registra o ato (com a
// justificativa), DEPOIS grava.
//
// A ordem e deliberada. Se o registro falhar, nada e gravado: ninguem fica ligado
// a ninguem sem ato registrado. Se a gravacao falhar depois do registro, o
// historico guarda o ATO SEM O EFEITO -- e isso e verdade, nao defeito: o
// operador decidiu, e o sistema nao conseguiu cumprir. A linha da submissao
// continua pendente e prova que nao pegou, e o par (ato, efeito) no historico e
// como se le o que de fato aconteceu. A ordem inversa perderia o "por que" de uma
// ligacao ja gravada, e e justamente o "por que" que a regra do CTO exige.
//
// Funcoes puras, fora das que falam com o banco (`lerSubmissoesDoEvento`,
// `registrarAtoDoOperador`, `revogarReconciliacao`) e do SHA-256.

import { createHash } from "node:crypto";
import {
  ehCodigoDaRevalidacao,
  type CodigoDeErro,
  type DetalhesDeErro,
} from "../erros/codigos";
import { indicaEsquemaAusente, type ErroRpcCru } from "../erros/falha-de-fila";
import type { ManifestoQuestionario } from "./manifesto-questionario";
import {
  planejarDecisaoDoOperador,
  type EstadoDaSubmissao,
  type OperadorDaImportacao,
  type PlanoDeDecisao,
} from "./planejar-importacao";
import { normalizarEmail, type ResultadoDeIdentidade } from "./reconciliar-identidade";
import { lerContextoDoEvento, type ClienteDeLeitura, type ContextoDoEvento } from "./borda";

// ===========================================================================
// 1. OS PEDIDOS
// ===========================================================================

export interface PedidoDeReconciliacao {
  event_id: string;
  /** A linha de `external_submissions` (uuid), nao o id do formulario. */
  submission_id: string;
  /** Quem o operador AFIRMA ser o dono desta submissao. */
  participant_id: string;
  justificativa: string;
  /** A impressao da FICHA que o operador viu. Sem ela nao se confirma nada. */
  ficha_impressao: string;
}

export interface PedidoDeRevogacao {
  event_id: string;
  submission_id: string;
  justificativa: string;
  ficha_impressao: string;
}

export type LeituraDoPedido<T> =
  | { ok: true; pedido: T }
  | { ok: false; codigo: Extract<CodigoDeErro, "INVALID_REQUEST">; motivo: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPRESSAO_HEX = /^[0-9a-f]{64}$/i;

/**
 * O MINIMO DE JUSTIFICATIVA. O banco exige 3 caracteres; aqui sao 10.
 *
 * Mais estrito de proposito, e nesta direcao: "ok" nao e uma razao, e o que vai
 * ser lido daqui a um mes por quem precisa entender por que a resposta de uma
 * pessoa foi atribuida a outra e este texto. Recusar de mais custa uma frase;
 * registrar "x" custa a auditoria.
 */
export const MINIMO_DA_JUSTIFICATIVA = 10;

/**
 * Os campos que NUNCA vem do cliente. Os mesmos da borda da importacao, mais os
 * desta borda: nem o operador, nem o instante, nem a acao sao escolhidos por
 * quem pede. O operador e a sessao verificada; o instante e o `now()` do banco; a
 * acao e a da rota.
 */
export const CAMPOS_PROIBIDOS_NO_CORPO = [
  "operador",
  "operador_id",
  "operador_email",
  "importado_por",
  "importado_por_email",
  "decidido_por",
  "acao",
  "criado_em",
] as const;

function recusa<T>(motivo: string): LeituraDoPedido<T> {
  return { ok: false, codigo: "INVALID_REQUEST", motivo };
}

function comumDoPedido(
  bruto: unknown,
): { ok: true; o: Record<string, unknown>; event_id: string; submission_id: string; justificativa: string; ficha_impressao: string } | { ok: false; motivo: string } {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "o corpo do pedido nao e um objeto JSON" };
  }
  const o = bruto as Record<string, unknown>;

  for (const proibido of CAMPOS_PROIBIDOS_NO_CORPO) {
    if (o[proibido] !== undefined) {
      return {
        ok: false,
        motivo: `o corpo traz \`${proibido}\`: o responsavel pela decisao e a sessao verificada, nunca um campo do pedido`,
      };
    }
  }

  const texto = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const event_id = texto(o.event_id);
  if (event_id === null || !UUID.test(event_id)) {
    return { ok: false, motivo: "`event_id` ausente ou nao e um UUID" };
  }
  const submission_id = texto(o.submission_id);
  if (submission_id === null || !UUID.test(submission_id)) {
    return { ok: false, motivo: "`submission_id` ausente ou nao e um UUID" };
  }
  const justificativa = typeof o.justificativa === "string" ? o.justificativa.trim() : "";
  if (justificativa.length < MINIMO_DA_JUSTIFICATIVA) {
    return {
      ok: false,
      motivo: `\`justificativa\` ausente ou curta demais (minimo ${MINIMO_DA_JUSTIFICATIVA} caracteres): decisao sobre a identidade de uma pessoa sem razao escrita nao e decisao registrada`,
    };
  }
  if (justificativa.length > 2000) {
    return { ok: false, motivo: "`justificativa` longa demais" };
  }
  const ficha = texto(o.ficha_impressao);
  if (ficha === null || !IMPRESSAO_HEX.test(ficha)) {
    return {
      ok: false,
      motivo:
        "`ficha_impressao` ausente ou nao e um SHA-256 hexadecimal de 64 digitos: sem a impressao da ficha nao da para afirmar que o que foi conferido e o que seria gravado",
    };
  }
  return {
    ok: true,
    o,
    event_id,
    submission_id,
    justificativa,
    ficha_impressao: ficha.toLowerCase(),
  };
}

export function lerPedidoDeReconciliacao(bruto: unknown): LeituraDoPedido<PedidoDeReconciliacao> {
  const c = comumDoPedido(bruto);
  if (!c.ok) return recusa(c.motivo);

  const participante =
    typeof c.o.participant_id === "string" ? c.o.participant_id.trim() : "";
  if (participante === "" || !UUID.test(participante)) {
    return recusa("`participant_id` ausente ou nao e um UUID");
  }
  return {
    ok: true,
    pedido: {
      event_id: c.event_id,
      submission_id: c.submission_id,
      participant_id: participante,
      justificativa: c.justificativa,
      ficha_impressao: c.ficha_impressao,
    },
  };
}

export function lerPedidoDeRevogacao(bruto: unknown): LeituraDoPedido<PedidoDeRevogacao> {
  const c = comumDoPedido(bruto);
  if (!c.ok) return recusa(c.motivo);
  // `participant_id` nao e aceito aqui: a revogacao desfaz a ligacao que EXISTE,
  // e quem ela desfaz e o que esta gravado -- nunca o que o cliente informa.
  if (c.o.participant_id !== undefined) {
    return recusa(
      "o corpo traz `participant_id`: a revogacao desfaz a ligacao que esta gravada, e nao uma informada pelo pedido",
    );
  }
  return {
    ok: true,
    pedido: {
      event_id: c.event_id,
      submission_id: c.submission_id,
      justificativa: c.justificativa,
      ficha_impressao: c.ficha_impressao,
    },
  };
}

// ===========================================================================
// 2. O QUE SE LE DO BANCO
// ===========================================================================

/** Os cinco estados de `external_submissions` (migration 022). */
export type EstadoNoBanco = EstadoDaSubmissao | "revogada";

export interface LinhaDeSubmissao {
  id: string;
  submissao_id: string;
  formulario_id: string;
  formulario_nome: string | null;
  estado: EstadoNoBanco;
  email_coletado: string | null;
  email_verificado: boolean;
  nome_declarado: string | null;
  respostas_brutas: Readonly<Record<string, unknown>>;
  participant_id: string | null;
  identidade_via: "email_verificado" | "decisao_do_operador" | null;
  quiz_version: number;
  questionario_impressao: string;
  bloqueio: { motivo?: string } | null;
}

/**
 * Uma resposta canonica que nasceu de uma submissao externa, identificada: qual
 * etapa, de quem, de que origem e de quando.
 *
 * Nao e contagem: e INVENTARIO. "Revogar remove 5" nao demonstra de quem era
 * cada registro; a exigencia da revisao e que a reversao PROVE a titularidade, e
 * prova-se nomeando os registros, nao somando-os.
 */
export interface RespostaDaSubmissao {
  external_submission_id: string;
  origem: string;
  stage_id: number;
  participant_id: string;
  submitted_at: string | null;
}

/**
 * O que JA FOI DERIVADO das respostas de um participante: documento e pontuacao.
 *
 * E isto que separa os tres estados do contrato de reversibilidade. Sem ler
 * daqui, a tela so poderia prometer "e reversivel" -- e a promessa que nao se
 * pode cumprir depois e pior que a recusa de agora.
 */
export interface DerivadosDoParticipante {
  /** Existe linha de prognostico para esta pessoa. */
  documento: boolean;
  gerado: boolean;
  revisado: boolean;
  entregue: boolean;
  /** Ha link publico de compartilhamento -- acesso que precisaria ser suspenso. */
  link_publico: boolean;
  /** Ha pontuacao calculada, que a remocao das respostas deixaria obsoleta. */
  pontuacao: boolean;
}

export const SEM_DERIVADOS: DerivadosDoParticipante = {
  documento: false,
  gerado: false,
  revisado: false,
  entregue: false,
  link_publico: false,
  pontuacao: false,
};

export interface ClienteDeConsulta {
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: unknown): unknown;
      in?(coluna: string, valores: readonly unknown[]): unknown;
    };
  };
}

export type FalhaDaLeitura = {
  codigo: Extract<CodigoDeErro, "IMPORT_SCHEMA_MISSING" | "IMPORT_UNAVAILABLE">;
  motivo: string;
};

export type LeituraDasSubmissoes =
  | { ok: true; submissoes: LinhaDeSubmissao[]; respostas: RespostaDaSubmissao[] }
  | ({ ok: false } & FalhaDaLeitura);

const COLUNAS_DOS_DERIVADOS =
  "participant_id, status, generated_at, reviewed_at, delivered_at, public_share_token, pdf_url";

const COLUNAS_DA_SUBMISSAO =
  "id, submissao_id, formulario_id, formulario_nome, estado, email_coletado, email_verificado, nome_declarado, respostas_brutas, participant_id, identidade_via, quiz_version, questionario_impressao, bloqueio";

function falhaDeLeitura(erro: unknown, oQue: string): { ok: false } & FalhaDaLeitura {
  // "nao esta instalado" x "nao respondeu": a mesma distincao da borda da
  // importacao, e pelo mesmo motivo. Mandar instalar o que nao falta manda o
  // operador investigar a coisa errada no meio de um evento.
  const cru = (erro ?? null) as ErroRpcCru | null;
  return {
    ok: false,
    codigo: indicaEsquemaAusente(cru) ? "IMPORT_SCHEMA_MISSING" : "IMPORT_UNAVAILABLE",
    motivo: `falha ao ler ${oQue}: ${cru?.message ?? cru?.code ?? "sem detalhe"}`,
  };
}

/**
 * Le as submissoes externas DESTE evento e as respostas canonicas que nasceram
 * delas.
 *
 * As respostas sao contadas, nao presumidas: e esse numero que a ficha da
 * revogacao mostra como "vai remover N respostas". Falha ao conta-las NAO vira
 * zero -- vira recusa, porque "revoga e remove 0" seria uma afirmacao falsa sobre
 * o que o clique vai fazer.
 */
export async function lerSubmissoesDoEvento(
  cliente: ClienteDeConsulta,
  eventId: string,
): Promise<LeituraDasSubmissoes> {
  let resposta: { data: unknown; error: unknown };
  try {
    resposta = await (cliente
      .from("external_submissions")
      .select(COLUNAS_DA_SUBMISSAO)
      .eq("event_id", eventId) as PromiseLike<{ data: unknown; error: unknown }>);
  } catch (e) {
    return falhaDeLeitura(
      { message: e instanceof Error ? e.message : String(e) },
      "as submissoes externas do evento",
    );
  }
  if (resposta.error || !Array.isArray(resposta.data)) {
    return falhaDeLeitura(resposta.error, "as submissoes externas do evento");
  }
  const submissoes = (resposta.data as Record<string, unknown>[]).map(lerLinhaDeSubmissao);

  const ids = submissoes.map((s) => s.id);
  if (ids.length === 0) return { ok: true, submissoes, respostas: [] };

  let respostas: { data: unknown; error: unknown };
  try {
    const sel = cliente
      .from("quiz_responses")
      .select("external_submission_id, origem, stage_id, participant_id, submitted_at");
    respostas = await ((sel as unknown as {
      in(c: string, v: readonly unknown[]): PromiseLike<{ data: unknown; error: unknown }>;
    }).in("external_submission_id", ids));
  } catch (e) {
    return falhaDeLeitura(
      { message: e instanceof Error ? e.message : String(e) },
      "as respostas canonicas destas submissoes",
    );
  }
  if (respostas.error || !Array.isArray(respostas.data)) {
    return falhaDeLeitura(respostas.error, "as respostas canonicas destas submissoes");
  }

  return {
    ok: true,
    submissoes,
    respostas: (respostas.data as Record<string, unknown>[])
      .filter((r) => typeof r.external_submission_id === "string")
      .map((r) => ({
        external_submission_id: String(r.external_submission_id),
        origem: typeof r.origem === "string" ? r.origem : "",
        stage_id: Number(r.stage_id ?? 0),
        participant_id: typeof r.participant_id === "string" ? r.participant_id : "",
        submitted_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
      })),
  };
}

export type LeituraDosDerivados =
  | { ok: true; derivados: Map<string, DerivadosDoParticipante> }
  | { ok: false; codigo: Extract<CodigoDeErro, "IMPORT_DERIVATIVES_UNVERIFIABLE">; motivo: string };

/**
 * Le os DERIVADOS dos participantes do evento: prognosticos e pontuacoes.
 *
 * Falha NAO vira "nao ha derivado". Vira IMPORT_DERIVATIVES_UNVERIFIABLE, porque
 * "nao consegui verificar" e "verifiquei e nao ha" sao dois fatos, e o segundo
 * autorizaria a tela a prometer reversibilidade que ninguem conferiu.
 */
export async function lerDerivadosDosParticipantes(
  cliente: ClienteDeConsulta,
  participantIds: readonly string[],
): Promise<LeituraDosDerivados> {
  const derivados = new Map<string, DerivadosDoParticipante>();
  if (participantIds.length === 0) return { ok: true, derivados };

  const naoVerificado = (oQue: string, erro: unknown): LeituraDosDerivados => ({
    ok: false,
    codigo: "IMPORT_DERIVATIVES_UNVERIFIABLE",
    motivo: `falha ao ler ${oQue}: ${(erro as ErroRpcCru | null)?.message ?? "sem detalhe"}`,
  });

  const emLote = (tabela: string, colunas: string) =>
    (cliente.from(tabela).select(colunas) as unknown as {
      in(c: string, v: readonly unknown[]): PromiseLike<{ data: unknown; error: unknown }>;
    }).in("participant_id", participantIds);

  let docs: { data: unknown; error: unknown };
  try {
    docs = await emLote("prognostics", COLUNAS_DOS_DERIVADOS);
  } catch (e) {
    return naoVerificado("os documentos derivados", { message: e instanceof Error ? e.message : String(e) });
  }
  if (docs.error || !Array.isArray(docs.data)) return naoVerificado("os documentos derivados", docs.error);

  for (const bruto of docs.data as Record<string, unknown>[]) {
    const id = typeof bruto.participant_id === "string" ? bruto.participant_id : null;
    if (id === null) continue;
    const atual = derivados.get(id) ?? { ...SEM_DERIVADOS };
    const status = typeof bruto.status === "string" ? bruto.status : "";
    atual.documento = true;
    atual.gerado = atual.gerado || bruto.generated_at !== null || status !== "";
    atual.revisado = atual.revisado || bruto.reviewed_at !== null;
    atual.entregue = atual.entregue || bruto.delivered_at !== null || bruto.pdf_url !== null;
    atual.link_publico = atual.link_publico || bruto.public_share_token !== null;
    derivados.set(id, atual);
  }

  let scores: { data: unknown; error: unknown };
  try {
    scores = await emLote("participant_scores", "participant_id, computed_at");
  } catch (e) {
    return naoVerificado("as pontuacoes derivadas", { message: e instanceof Error ? e.message : String(e) });
  }
  if (scores.error || !Array.isArray(scores.data)) return naoVerificado("as pontuacoes derivadas", scores.error);

  for (const bruto of scores.data as Record<string, unknown>[]) {
    const id = typeof bruto.participant_id === "string" ? bruto.participant_id : null;
    if (id === null) continue;
    const atual = derivados.get(id) ?? { ...SEM_DERIVADOS };
    atual.pontuacao = true;
    derivados.set(id, atual);
  }

  return { ok: true, derivados };
}

function lerLinhaDeSubmissao(r: Record<string, unknown>): LinhaDeSubmissao {
  const via = r.identidade_via;
  const bloqueio = r.bloqueio;
  return {
    id: String(r.id ?? ""),
    submissao_id: String(r.submissao_id ?? ""),
    formulario_id: String(r.formulario_id ?? ""),
    formulario_nome: typeof r.formulario_nome === "string" ? r.formulario_nome : null,
    estado: String(r.estado ?? "") as EstadoNoBanco,
    email_coletado: typeof r.email_coletado === "string" ? r.email_coletado : null,
    email_verificado: r.email_verificado === true,
    nome_declarado: typeof r.nome_declarado === "string" ? r.nome_declarado : null,
    respostas_brutas:
      r.respostas_brutas !== null && typeof r.respostas_brutas === "object" && !Array.isArray(r.respostas_brutas)
        ? (r.respostas_brutas as Record<string, unknown>)
        : {},
    participant_id: typeof r.participant_id === "string" ? r.participant_id : null,
    identidade_via:
      via === "email_verificado" || via === "decisao_do_operador" ? via : null,
    quiz_version: typeof r.quiz_version === "number" ? r.quiz_version : Number(r.quiz_version ?? 0),
    questionario_impressao: String(r.questionario_impressao ?? ""),
    bloqueio:
      bloqueio !== null && typeof bloqueio === "object" && !Array.isArray(bloqueio)
        ? (bloqueio as { motivo?: string })
        : null,
  };
}

// ===========================================================================
// 3. A FICHA: o que o operador esta afirmando, e com base em que
// ===========================================================================

export interface FatosDaSubmissao {
  id: string;
  submissao_id: string;
  formulario_id: string;
  formulario_nome: string | null;
  estado: EstadoNoBanco;
  /** O e-mail como a coleta o entregou. Nunca usado para casar nada aqui. */
  email_coletado: string | null;
  /** O FORMULARIO confirmou a posse deste e-mail? Nunca se presume `true`. */
  email_verificado: boolean;
  nome_declarado: string | null;
  quiz_version: number;
  questionario_impressao: string;
  /** Por que ela esta retida, nas palavras que o planejador gravou. */
  motivo: string | null;
  /** Quantas perguntas a coleta trouxe. Serve para o operador ver que nao esta vazia. */
  respostas_coletadas: number;
}

export interface FatosDoParticipante {
  id: string;
  nome: string;
  email: string;
  /** Quantas respostas canonicas ele JA tem. Zero e o unico numero que libera. */
  respostas_canonicas: number;
  /** Outra submissao externa ativa dele, se houver. Nomeada, nao contada. */
  submissao_externa_ativa: string | null;
}

export type CodigoDeDivergencia =
  | "email_nao_declarado"
  | "email_nao_verificado"
  | "email_diferente_do_participante"
  | "participante_sem_email"
  | "participante_ja_tem_respostas"
  | "participante_ja_tem_submissao_ativa"
  | "submissao_ja_foi_revogada";

export interface Divergencia {
  codigo: CodigoDeDivergencia;
  /** O que NAO bate, escrito para o operador ler antes de clicar. */
  texto: string;
}

export interface Impedimento {
  codigo:
    | "participante_ocupado"
    | "estado_nao_decidivel"
    | "participante_de_outro_evento"
    /** Estado 3 do contrato: ha documento derivado, e desfazer simples esta bloqueado. */
    | "derivado_ja_gerado";
  texto: string;
  /** Para a resposta de erro da rota: o que a tela ja mostra, em campo declarado. */
  detalhes: DetalhesDeErro;
}

/**
 * O CONTRATO DE REVERSIBILIDADE, em tres estados -- e nao um botao de desfazer.
 *
 * Decisao da revisao, cumprida por este tipo:
 *   1. `correcao_simples`          identidade vinculada e nada derivado ainda:
 *      desfaz com um ato, mediante motivo e auditoria.
 *   2. `operacao_controlada`       ha registro gravado e nenhum documento: desfaz
 *      removendo os registros, preservando o historico e PROVANDO de quem era
 *      cada registro (o inventario da ficha de revogacao).
 *   3. `procedimento_excepcional`  ha documento gerado, revisado ou entregue:
 *      desfazer simples fica BLOQUEADO. Antes, invalidar os derivados e suspender
 *      o acesso indevido.
 *
 * E a exigencia de produto que vem junto: a tela informa isto PREVIAMENTE, por
 * submissao, e nao com um aviso igual em toda tela -- um aviso que aparece sempre
 * nao informa nada. Em todos os tres estados o registro cru da submissao
 * PERMANECE: corrigir identidade nunca apaga a evidencia de reconstruir o
 * ocorrido.
 */
export type EstadoDaReversibilidade =
  | "correcao_simples"
  | "operacao_controlada"
  | "procedimento_excepcional";

export interface Reversibilidade {
  estado: EstadoDaReversibilidade;
  /** O que acontece se esta decisao precisar ser desfeita. Lido ANTES do clique. */
  texto: string;
  /** O que NAO volta por acao simples. Vazio e uma afirmacao, nao uma omissao. */
  efeitos_nao_reversiveis: string[];
  /** Os derivados que existem HOJE para o participante envolvido. */
  derivados: DerivadosDoParticipante;
  /** Em qualquer dos tres estados: `true`. O payload cru nunca e apagado. */
  evidencia_preservada: true;
}

export interface ConsequenciaDaReconciliacao {
  etapas_a_gravar: number;
  itens_a_registrar: number;
  apto_para_pontuar: boolean;
  bloqueio: { motivo: string; perguntas: string[] } | null;
  /** Quantas respostas do participante seriam SOBRESCRITAS. Permitido so com 0. */
  respostas_sobrescritas: number;
  /**
   * `true` quando desfazer esta decisao devolve o estado anterior por completo.
   * Com `respostas_sobrescritas > 0` seria `false` -- e por isso a decisao e
   * recusada antes, em vez de avisada depois.
   */
  reversivel: boolean;
}

export interface FichaDeReconciliacao {
  ato: "reconciliar";
  submissao: FatosDaSubmissao;
  participante: FatosDoParticipante;
  /** A identidade automatica, que NAO resolveu: o motivo exato. */
  identidade_automatica: { estado: EstadoNoBanco; motivo: string | null };
  divergencias: Divergencia[];
  /** A frase que o operador esta assinando. Em primeira pessoa, sem eufemismo. */
  afirmacao: string;
  consequencia: ConsequenciaDaReconciliacao | null;
  /**
   * Em qual dos tres estados do contrato esta decisao cai, ANTES do clique.
   * `null` so quando nao da para afirmar o que seria gravado (ai a ficha tambem
   * nao e permitida): nunca se classifica reversibilidade por suposicao.
   */
  reversibilidade: Reversibilidade | null;
  /** `null` quando a decisao e permitida. */
  impedimento: Impedimento | null;
  permitida: boolean;
  impressao_da_ficha: string;
}

export interface FichaDeRevogacao {
  ato: "revogar";
  submissao: FatosDaSubmissao;
  /** Com quem ela esta ligada AGORA. */
  participante: { id: string; nome: string; email: string };
  identidade_via: "email_verificado" | "decisao_do_operador" | null;
  /** Quantas respostas canonicas a revogacao REMOVE. Medido, nao estimado. */
  respostas_canonicas_a_remover: number;
  /**
   * O INVENTARIO dos registros que serao removidos: qual etapa, de quem, de que
   * origem, de quando. E com ele que a reversao demonstra a titularidade em vez de
   * apenas somar linhas -- e ele viaja para o livro-razao junto da justificativa.
   */
  registros: { stage_id: number; participante: string; origem: string; submetida_em: string | null }[];
  /** Em qual dos tres estados do contrato esta revogacao cai. */
  reversibilidade: Reversibilidade;
  /**
   * Linhas de resposta ligadas a esta submissao que NAO tem origem 'externo'.
   * Deveria ser sempre 0; se nao for, a remocao apagaria linha que a importacao
   * sobrescreveu, e o aviso diz isso.
   */
  respostas_de_outra_origem: number;
  avisos: string[];
  impedimento: Impedimento | null;
  permitida: boolean;
  impressao_da_ficha: string;
}

export interface MesaDeDecisao {
  evento_id: string;
  quiz_version: number;
  questionario_impressao: string;
  /** As que esperam decisao humana: pendentes, conflitos e revogadas. */
  a_decidir: {
    submissao: FatosDaSubmissao;
    identidade_automatica: { estado: EstadoNoBanco; motivo: string | null };
    /** Toda a lista de participantes do evento, com o que nao bate em cada um. */
    candidatos: FichaDeReconciliacao[];
  }[];
  /** As reconciliacoes que podem ser revogadas, com o que a revogacao remove. */
  revogaveis: FichaDeRevogacao[];
  /** Quantas submissoes existem por estado. Numero, para o operador se situar. */
  por_estado: Partial<Record<EstadoNoBanco, number>>;
}

const ESTADOS_QUE_SE_DECIDEM: readonly EstadoNoBanco[] = ["pendente", "conflito", "revogada"];
const ESTADOS_ATIVOS: readonly EstadoNoBanco[] = ["importavel", "incompativel"];

function fatosDaSubmissao(s: LinhaDeSubmissao): FatosDaSubmissao {
  return {
    id: s.id,
    submissao_id: s.submissao_id,
    formulario_id: s.formulario_id,
    formulario_nome: s.formulario_nome,
    estado: s.estado,
    email_coletado: s.email_coletado,
    email_verificado: s.email_verificado,
    nome_declarado: s.nome_declarado,
    quiz_version: s.quiz_version,
    questionario_impressao: s.questionario_impressao,
    motivo: s.bloqueio?.motivo ?? null,
    respostas_coletadas: Object.keys(s.respostas_brutas).length,
  };
}

/**
 * A identidade ANTERIOR desta submissao, como o BANCO a registrou.
 *
 * NAO e recalculada: o veredito da reconciliacao automatica e de LOTE (duas
 * submissoes da mesma pessoa so aparecem olhando o lote), e o lote nao existe
 * mais na hora da decisao -- o que existe e a linha, onde o veredito ficou
 * gravado com o motivo escrito. Recalcular sobre uma submissao isolada daria
 * outra resposta, e seria a resposta errada: um conflito visto sozinho parece
 * reconciliavel.
 *
 * `revogada` entra como PENDENTE sem correspondencia, com a explicacao que o
 * banco gravou (que diz, com estas palavras, que houve revogacao). Nao e
 * aproximacao conveniente: depois de revogada a submissao nao esta ligada a
 * ninguem, e e isso que "pendente" quer dizer aqui. A palavra REVOGADA continua
 * aparecendo na ficha, nas divergencias e no historico.
 */
export function identidadeRegistrada(s: LinhaDeSubmissao): ResultadoDeIdentidade {
  const email = normalizarEmail(s.email_coletado);
  const explicacao = s.bloqueio?.motivo ?? "identidade nao resolvida";
  if (s.estado === "conflito") {
    return {
      estado: "conflito",
      submissao_id: s.submissao_id,
      motivo: "duas_submissoes_do_mesmo_email",
      email_normalizado: email,
      envolvidos: [],
      explicacao,
    };
  }
  return {
    estado: "pendente",
    submissao_id: s.submissao_id,
    motivo: email === null ? "email_ausente" : s.email_verificado ? "sem_correspondencia" : "email_nao_verificado",
    email_normalizado: email,
    explicacao,
  };
}

/** A impressao digital de uma ficha: SHA-256 da ficha sem o proprio campo. */
export function impressaoDaFicha(ficha: Omit<FichaDeReconciliacao, "impressao_da_ficha"> | Omit<FichaDeRevogacao, "impressao_da_ficha">): string {
  return createHash("sha256").update(JSON.stringify(ficha), "utf8").digest("hex");
}

/**
 * A FICHA e a mesma coisa que seria gravada agora?
 *
 * Tres desfechos, como no resto do projeto: bate, NAO bate, ou nao foi declarada
 * -- e "nao declarada" tambem recusa, porque confirmar sem dizer o que se viu e
 * confirmar no escuro. (A validacao do corpo ja exige o campo; isto fecha o
 * caminho para quem chamar a funcao de outro lugar.)
 */
export function conferirFicha(
  declarada: string | null,
  atual: string,
): { ok: true } | { ok: false; codigo: Extract<CodigoDeErro, "IMPORT_DECISION_STALE">; motivo: string } {
  if (declarada === null || declarada.trim() === "") {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_STALE",
      motivo:
        "a confirmacao nao declarou a impressao da ficha: sem ela nao da para afirmar que o que foi conferido e o que seria gravado",
    };
  }
  if (declarada.trim().toLowerCase() !== atual) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_STALE",
      motivo: `a ficha conferida (${declarada.trim().slice(0, 16)}...) nao corresponde a ficha atual (${atual.slice(0, 16)}...)`,
    };
  }
  return { ok: true };
}

function textoDoEstado(e: EstadoNoBanco): string {
  return e === "pendente"
    ? "PENDENTE (a reconciliacao automatica nao conseguiu decidir)"
    : e === "conflito"
      ? "em CONFLITO (ha mais de um candidato de um dos lados)"
      : e === "revogada"
        ? "REVOGADA (uma reconciliacao anterior foi desfeita)"
        : e === "importavel"
          ? "reconciliada e apta a pontuar"
          : "reconciliada e com DADO INCOMPATIVEL";
}

/**
 * O que NAO bate entre esta submissao e este participante. Lista completa e
 * nomeada: e isto que transforma "confirmar" em "afirmar sabendo o que falta".
 */
export function divergenciasEntre(
  s: LinhaDeSubmissao,
  p: FatosDoParticipante,
): Divergencia[] {
  const d: Divergencia[] = [];
  const emailDaColeta = normalizarEmail(s.email_coletado);
  const emailDoParticipante = normalizarEmail(p.email);

  if (emailDaColeta === null) {
    d.push({
      codigo: "email_nao_declarado",
      texto:
        "a submissao nao trouxe e-mail nenhum. Nao ha o que comparar: a unica base desta atribuicao e a sua decisao",
    });
  } else if (!s.email_verificado) {
    d.push({
      codigo: "email_nao_verificado",
      texto: `o formulario NAO confirmou a posse de ${emailDaColeta}. E-mail apenas digitado nao identifica ninguem`,
    });
  }
  if (emailDoParticipante === null) {
    d.push({
      codigo: "participante_sem_email",
      texto: `o participante ${p.nome} nao tem e-mail no cadastro deste evento`,
    });
  } else if (emailDaColeta !== null && emailDaColeta !== emailDoParticipante) {
    d.push({
      codigo: "email_diferente_do_participante",
      texto: `o e-mail da submissao (${emailDaColeta}) NAO e o do participante (${emailDoParticipante})`,
    });
  }
  if (p.respostas_canonicas > 0) {
    d.push({
      codigo: "participante_ja_tem_respostas",
      texto: `${p.nome} ja tem ${p.respostas_canonicas} resposta(s) gravada(s). Gravar por cima apagaria resposta existente, e revogar depois NAO a devolveria`,
    });
  }
  if (p.submissao_externa_ativa !== null) {
    d.push({
      codigo: "participante_ja_tem_submissao_ativa",
      texto: `${p.nome} ja tem a submissao externa ${p.submissao_externa_ativa} ligada a ele`,
    });
  }
  if (s.estado === "revogada") {
    d.push({
      codigo: "submissao_ja_foi_revogada",
      texto:
        "esta submissao ja teve uma reconciliacao revogada antes. Nao e impedimento, e e contexto: alguem ja decidiu e desfez",
    });
  }
  return d;
}

function afirmacaoDe(s: LinhaDeSubmissao, p: FatosDoParticipante, divergencias: Divergencia[]): string {
  const email = s.email_coletado === null
    ? "sem e-mail declarado"
    : `e-mail declarado ${s.email_coletado}${s.email_verificado ? ", verificado pelo formulario" : ", NAO verificado pelo formulario"}`;
  const nome = s.nome_declarado === null ? "sem nome declarado" : `nome declarado “${s.nome_declarado}”`;
  const quantas = divergencias.filter((x) => x.codigo !== "submissao_ja_foi_revogada").length;
  return (
    `Voce esta afirmando que a submissao “${s.submissao_id}” do formulario ${s.formulario_id} ` +
    `(${email}; ${nome}; ${s.estado === "revogada" ? "revogada" : textoDoEstado(s.estado)}) ` +
    `e de ${p.nome} <${p.email || "sem e-mail"}>. ` +
    (quantas === 0
      ? "O sistema nao verificou isso: a atribuicao passa a valer pela sua decisao, nao por verificacao. "
      : `O sistema NAO verificou isso, e ha ${quantas} ponto(s) que nao batem, listados abaixo. `) +
    "Este ato fica registrado com o seu nome, a data e a sua justificativa, e pode ser revogado -- a revogacao se soma ao historico, nao o apaga."
  );
}

function fatosDoParticipante(
  p: ContextoDoEvento["participantes"][number],
  ativaDoParticipante: Map<string, string>,
): FatosDoParticipante {
  return {
    id: p.id,
    nome: p.full_name,
    email: p.email,
    respostas_canonicas: p.respostas_existentes ?? 0,
    submissao_externa_ativa: ativaDoParticipante.get(p.id) ?? null,
  };
}

function listaDeDerivados(d: DerivadosDoParticipante): string {
  const partes: string[] = [];
  if (d.entregue) partes.push("documento ENTREGUE");
  else if (d.revisado) partes.push("documento REVISADO");
  else if (d.gerado || d.documento) partes.push("documento GERADO");
  if (d.link_publico) partes.push("link publico de compartilhamento ATIVO");
  if (d.pontuacao) partes.push("pontuacao calculada");
  return partes.join("; ");
}

/**
 * Em qual dos tres estados do contrato cai DESFAZER esta decisao.
 *
 * `registros` e quantos registros canonicos estariam em jogo (os que a
 * reconciliacao vai gravar, ou os que a revogacao vai remover).
 */
export function classificarReversibilidade(
  registros: number,
  derivados: DerivadosDoParticipante,
  ato: "reconciliar" | "revogar",
): Reversibilidade {
  // ESTADO 3: ha documento. Desfazer deixou de ser um ato.
  if (derivados.documento) {
    const efeitos = [
      `ja existe ${listaDeDerivados(derivados)} para este participante: desfazer nao invalida o documento nem suspende o acesso a ele`,
    ];
    if (derivados.link_publico) {
      efeitos.push(
        "o link publico continua funcionando depois de desfazer: suspender esse acesso e passo proprio, e nao acontece sozinho",
      );
    }
    return {
      estado: "procedimento_excepcional",
      texto:
        ato === "revogar"
          ? "DESFAZER SIMPLES ESTA BLOQUEADO: ha documento gerado a partir destas respostas. Remover as respostas deixaria o documento de pe, falando sobre a pessoa errada. O caminho e excepcional: invalidar o derivado, suspender o acesso indevido e so entao corrigir a identidade, com registro de quem autorizou."
          : "ATENCAO, LEIA ANTES DE CONFIRMAR: este participante JA TEM documento gerado. Confirmar aqui produz efeito que NAO se desfaz por acao simples -- o documento existente passa a nao corresponder as respostas, e corrigir depois exige invalidar o derivado e suspender o acesso a ele.",
      efeitos_nao_reversiveis: efeitos,
      derivados,
      evidencia_preservada: true,
    };
  }

  // ESTADO 1: nada gravado (ou nada a remover) e nada derivado.
  if (registros === 0 && !derivados.pontuacao) {
    return {
      estado: "correcao_simples",
      texto:
        ato === "revogar"
          ? "CORRECAO SIMPLES: nao ha registro canonico a remover. Desfazer e um ato, com motivo e auditoria, e nada mais sai."
          : "CORRECAO SIMPLES: nenhuma resposta canonica seria gravada por esta decisao, entao desfazer e um ato, com motivo e auditoria.",
      efeitos_nao_reversiveis: [],
      derivados,
      evidencia_preservada: true,
    };
  }

  // ESTADO 2: ha registro, nenhum documento.
  const efeitos: string[] = [];
  if (derivados.pontuacao) {
    efeitos.push(
      "a pontuacao ja calculada deste participante fica OBSOLETA: desfazer remove as respostas e nao recalcula nada sozinho",
    );
  }
  return {
    estado: "operacao_controlada",
    texto:
      ato === "revogar"
        ? `OPERACAO CONTROLADA: desfazer REMOVE ${registros} registro(s) canonico(s), preserva o historico e registra de quem era cada registro (o inventario abaixo). Nao ha documento gerado, entao nao ha derivado a invalidar.`
        : `OPERACAO CONTROLADA: esta decisao grava ${registros} registro(s) canonico(s). Desfazer depois e possivel e remove esses registros -- com motivo, auditoria e o inventario de quem era cada um --, e NAO devolve nada que tenha sido sobrescrito.`,
    efeitos_nao_reversiveis: efeitos,
    derivados,
    evidencia_preservada: true,
  };
}

function impedimentoDoAlvo(p: FatosDoParticipante): Impedimento | null {
  const temRespostas = p.respostas_canonicas > 0;
  const temAtiva = p.submissao_externa_ativa !== null;
  if (!temRespostas && !temAtiva) return null;
  const ocupacao: NonNullable<DetalhesDeErro["ocupacao"]> =
    temRespostas && temAtiva ? "ambos" : temRespostas ? "respostas_canonicas" : "submissao_externa_ativa";
  return {
    codigo: "participante_ocupado",
    texto:
      temRespostas
        ? `${p.nome} ja tem ${p.respostas_canonicas} resposta(s) gravada(s)` +
          (temAtiva ? ` e a submissao externa ${p.submissao_externa_ativa} ligada a ele` : "") +
          ". A gravacao escreveria por cima e a revogacao nao devolveria o que havia: nao ha volta, entao nao ha confirmacao. Revogue primeiro o que esta ligado a ele, ou escolha outro participante"
        : `${p.nome} ja tem a submissao externa ${p.submissao_externa_ativa} ligada a ele. Duas submissoes ativas para a mesma pessoa nao convivem: revogue a atual antes`,
    detalhes: { ocupacao, respostas_existentes: p.respostas_canonicas, ato: "reconciliar" },
  };
}

/**
 * Monta a MESA DE DECISAO inteira: o que espera decisao, com quem pode receber
 * cada submissao e o que nao bate em cada caso, e o que pode ser revogado com o
 * que a revogacao remove.
 *
 * Pura. A mesma funcao serve a rota de leitura (que mostra) e as duas rotas de
 * ato (que conferem a impressao da ficha antes de escrever) -- pelo mesmo motivo
 * que a previa e a aplicacao da importacao chamam `montarPlanoDaBorda`: duas
 * montagens divergem, e divergir aqui e a tela afirmar uma coisa e o banco gravar
 * outra.
 */
export function montarMesaDeDecisao(
  contexto: ContextoDoEvento,
  manifesto: ManifestoQuestionario,
  submissoes: readonly LinhaDeSubmissao[],
  respostas: readonly RespostaDaSubmissao[],
  operador: OperadorDaImportacao,
  /** Os derivados por participante (`lerDerivadosDosParticipantes`). */
  derivados: ReadonlyMap<string, DerivadosDoParticipante>,
): MesaDeDecisao {
  const registrosPorSubmissao = new Map<string, RespostaDaSubmissao[]>();
  for (const r of respostas) {
    const atual = registrosPorSubmissao.get(r.external_submission_id) ?? [];
    atual.push(r);
    registrosPorSubmissao.set(r.external_submission_id, atual);
  }
  const derivadoDe = (id: string | null): DerivadosDoParticipante =>
    (id === null ? undefined : derivados.get(id)) ?? { ...SEM_DERIVADOS };

  const ativaDoParticipante = new Map<string, string>();
  for (const s of submissoes) {
    if (s.participant_id !== null && ESTADOS_ATIVOS.includes(s.estado)) {
      ativaDoParticipante.set(s.participant_id, s.submissao_id);
    }
  }

  const porEstado: Partial<Record<EstadoNoBanco, number>> = {};
  for (const s of submissoes) porEstado[s.estado] = (porEstado[s.estado] ?? 0) + 1;

  const participantes = contexto.participantes.map((p) => fatosDoParticipante(p, ativaDoParticipante));
  const porId = new Map(participantes.map((p) => [p.id, p]));

  const a_decidir: MesaDeDecisao["a_decidir"] = [];
  const revogaveis: FichaDeRevogacao[] = [];

  for (const s of submissoes) {
    if (ESTADOS_QUE_SE_DECIDEM.includes(s.estado)) {
      a_decidir.push({
        submissao: fatosDaSubmissao(s),
        identidade_automatica: { estado: s.estado, motivo: s.bloqueio?.motivo ?? null },
        candidatos: participantes.map((p) =>
          montarFichaDeReconciliacao(contexto, manifesto, s, p, operador, derivadoDe(p.id)),
        ),
      });
      continue;
    }
    if (ESTADOS_ATIVOS.includes(s.estado) && s.participant_id !== null) {
      revogaveis.push(
        montarFichaDeRevogacao(
          s,
          porId.get(s.participant_id) ?? null,
          registrosPorSubmissao.get(s.id) ?? [],
          derivadoDe(s.participant_id),
        ),
      );
    }
  }

  return {
    evento_id: contexto.evento.id,
    quiz_version: contexto.evento.quiz_version,
    questionario_impressao: manifesto.impressao,
    a_decidir,
    revogaveis,
    por_estado: porEstado,
  };
}

/**
 * A ficha de UMA atribuicao: esta submissao para este participante.
 *
 * A CONSEQUENCIA (quantas etapas, quantos itens, se fica apta) nao e estimada
 * aqui: sai do plano que `planejarDecisaoDoOperador` monta, que e o MESMO plano
 * que seria gravado. Se o plano nao sai -- manifesto que mudou, versao divergente
 * --, a consequencia e `null` e a ficha diz que nao da para afirmar o que seria
 * gravado, em vez de mostrar um numero inventado.
 */
export function montarFichaDeReconciliacao(
  contexto: ContextoDoEvento,
  manifesto: ManifestoQuestionario,
  s: LinhaDeSubmissao,
  p: FatosDoParticipante,
  operador: OperadorDaImportacao,
  derivados: DerivadosDoParticipante = SEM_DERIVADOS,
): FichaDeReconciliacao {
  const divergencias = divergenciasEntre(s, p);
  const impedimentoDeEstado: Impedimento | null = ESTADOS_QUE_SE_DECIDEM.includes(s.estado)
    ? null
    : {
        codigo: "estado_nao_decidivel",
        texto: `esta submissao esta ${textoDoEstado(s.estado)}: ela ja esta reconciliada e nao se reconcilia de novo por cima. Revogue primeiro`,
        detalhes: { estado_da_submissao: s.estado, ato: "reconciliar" },
      };
  const impedimento = impedimentoDeEstado ?? impedimentoDoAlvo(p);

  const plano = planejarDecisaoDoOperador(
    {
      evento: contexto.evento,
      manifesto,
      origem: {
        formulario_id: s.formulario_id,
        formulario_nome: s.formulario_nome,
        // A impressao DECLARADA e a que ficou GRAVADA na submissao: a pergunta
        // deste portao e "o questionario que esta pessoa respondeu ainda e o do
        // sistema?". Se o questionario mudou depois da coleta, a decisao para
        // aqui, antes de mapear qualquer resposta.
        impressao_declarada: s.questionario_impressao,
      },
      submissoes: [
        {
          submissao_id: s.submissao_id,
          email: s.email_coletado,
          email_verificado: s.email_verificado,
          nome_declarado: s.nome_declarado,
          respostas: s.respostas_brutas,
        },
      ],
      // A lista de participantes NAO entra: a identidade anterior vem do estado
      // REGISTRADO (`identidadeRegistrada`), nao de uma reconciliacao refeita
      // sobre uma submissao isolada. Quem confere que o participante escolhido e
      // deste evento e a propria mesa, que so monta candidato a partir de
      // `contexto.participantes`.
      participantes: [],
      operador,
    },
    {
      submissao_id: s.submissao_id,
      participant_id: p.id,
      // A justificativa de verdade vem do operador na hora do ato. Aqui ela so
      // precisa existir para o plano ser montavel: a ficha mede consequencia, nao
      // registra decisao. O texto NAO entra na impressao da ficha por isso.
      justificativa: "ficha de conferencia (sem efeito)",
    },
    identidadeRegistrada(s),
  );

  const consequencia: ConsequenciaDaReconciliacao | null = plano.ok
    ? {
        etapas_a_gravar: plano.decidida.etapas.length,
        itens_a_registrar: plano.decidida.itens.length,
        apto_para_pontuar: plano.decidida.apto_para_pontuar,
        bloqueio: plano.decidida.bloqueio,
        respostas_sobrescritas: p.respostas_canonicas,
        reversivel: p.respostas_canonicas === 0,
      }
    : null;

  const semImpressao: Omit<FichaDeReconciliacao, "impressao_da_ficha"> = {
    ato: "reconciliar",
    submissao: fatosDaSubmissao(s),
    participante: p,
    identidade_automatica: { estado: s.estado, motivo: s.bloqueio?.motivo ?? null },
    divergencias,
    afirmacao: afirmacaoDe(s, p, divergencias),
    consequencia,
    // Sem consequencia nao se classifica reversibilidade: nao da para dizer o que
    // seria preciso desfazer quando nao se sabe o que seria gravado.
    reversibilidade:
      consequencia === null
        ? null
        : classificarReversibilidade(consequencia.etapas_a_gravar, derivados, "reconciliar"),
    impedimento,
    permitida: impedimento === null && consequencia !== null,
  };
  return { ...semImpressao, impressao_da_ficha: impressaoDaFicha(semImpressao) };
}

/**
 * A ficha de UMA revogacao: o que ela desfaz, e o que ela REMOVE.
 *
 * O numero de respostas removidas e o que o operador precisa ver antes do clique:
 * revogar nao apaga o historico nem o payload cru, mas apaga as respostas
 * canonicas que nasceram desta submissao, e isso e irreversivel pelo aplicativo.
 */
export function montarFichaDeRevogacao(
  s: LinhaDeSubmissao,
  p: FatosDoParticipante | null,
  registros: readonly RespostaDaSubmissao[],
  derivados: DerivadosDoParticipante = SEM_DERIVADOS,
): FichaDeRevogacao {
  const total = registros.length;
  const outraOrigem = registros.filter((r) => r.origem !== "externo").length;
  const reversibilidade = classificarReversibilidade(total, derivados, "revogar");

  const avisos: string[] = [
    `A revogacao REMOVE ${total} resposta(s) canonica(s) que nasceram desta submissao. O aplicativo nao as traz de volta: o que volta e a submissao externa, com o payload cru inteiro, para ser reconciliada outra vez.`,
    "A submissao NAO e apagada e o historico NAO e reescrito: a revogacao e um ato novo, que se soma aos anteriores.",
    reversibilidade.texto,
    ...reversibilidade.efeitos_nao_reversiveis.map((e) => `ATENCAO: ${e}.`),
  ];
  if (outraOrigem > 0) {
    avisos.push(
      `ATENCAO: ${outraOrigem} dessas linhas nao tem origem 'externo'. Isso indica resposta que a importacao sobrescreveu, e a remocao vai apagar essa linha tambem, sem devolver o conteudo anterior.`,
    );
  }

  // ESTADO 3 do contrato: desfazer simples BLOQUEADO. Nao e aviso, e recusa -- a
  // revisao pediu "bloquear desfazer simples", e um aviso que se pode clicar
  // atravessado nao bloqueia nada.
  const impedimento: Impedimento | null =
    p === null
      ? {
          codigo: "participante_de_outro_evento",
          texto:
            "a submissao aponta para um participante que nao esta na lista deste evento. Nao da para descrever o que a revogacao desfaz, entao ela nao e oferecida aqui",
          detalhes: { estado_da_submissao: s.estado, ato: "revogar" },
        }
      : reversibilidade.estado === "procedimento_excepcional"
        ? {
            codigo: "derivado_ja_gerado",
            texto: `ha ${listaDeDerivados(derivados)} para ${p.nome}. Desfazer aqui removeria as respostas e deixaria o derivado de pe: antes e preciso invalidar o derivado e suspender o acesso indevido, por procedimento excepcional registrado`,
            detalhes: {
              estado_da_submissao: s.estado,
              ato: "revogar",
              reversibilidade: "procedimento_excepcional",
            },
          }
        : null;

  const semImpressao: Omit<FichaDeRevogacao, "impressao_da_ficha"> = {
    ato: "revogar",
    submissao: fatosDaSubmissao(s),
    participante: { id: p?.id ?? "", nome: p?.nome ?? "", email: p?.email ?? "" },
    identidade_via: s.identidade_via,
    respostas_canonicas_a_remover: total,
    registros: [...registros]
      .sort((a, b) => a.stage_id - b.stage_id)
      .map((r) => ({
        stage_id: r.stage_id,
        participante: r.participant_id,
        origem: r.origem,
        submetida_em: r.submitted_at,
      })),
    reversibilidade,
    respostas_de_outra_origem: outraOrigem,
    avisos,
    impedimento,
    permitida: impedimento === null,
  };
  return { ...semImpressao, impressao_da_ficha: impressaoDaFicha(semImpressao) };
}

/**
 * A justificativa que vai para o livro-razao, com o INVENTARIO dos registros
 * removidos anexado pelo sistema.
 *
 * Por que anexar em texto: `importacao_externa_revogar` (022) grava a
 * justificativa e um `antes` resumido, e nao recebe inventario -- e esta unidade
 * nao escreve migration. O inventario e a forma de a reversao DEMONSTRAR de quem
 * era cada registro, e ele precisa ficar no livro-razao append-only, nao apenas na
 * resposta HTTP. Entao ele entra por aqui, depois de um separador que deixa claro
 * o que foi escrito pelo operador e o que foi escrito pelo sistema.
 */
export const SEPARADOR_DO_INVENTARIO = " || titularidade dos registros removidos (anexado pelo sistema): ";

export function justificativaComInventario(texto: string, ficha: FichaDeRevogacao): string {
  const quem = `participante ${ficha.participante.id} (${ficha.participante.nome}${ficha.participante.email ? `, ${ficha.participante.email}` : ""})`;
  const quais =
    ficha.registros.length === 0
      ? "nenhum registro canonico"
      : ficha.registros
          .map((r) => `etapa ${r.stage_id} [origem ${r.origem}${r.submetida_em ? `, submetida em ${r.submetida_em}` : ""}]`)
          .join("; ");
  return (
    `${texto.trim()}${SEPARADOR_DO_INVENTARIO}${quem}; ${ficha.registros.length} registro(s): ${quais}; ` +
    `submissao de origem ${ficha.submissao.submissao_id}; reversibilidade ${ficha.reversibilidade.estado}`
  );
}

// ===========================================================================
// 3b. A MESA, MONTADA UMA VEZ, PARA AS TRES ROTAS
// ===========================================================================

export type FalhaDaMesa = { codigo: CodigoDeErro; motivo: string; detalhes?: DetalhesDeErro };

export type PreparacaoDaMesa =
  | {
      ok: true;
      mesa: MesaDeDecisao;
      contexto: ContextoDoEvento;
      manifesto: ManifestoQuestionario;
      submissoes: LinhaDeSubmissao[];
    }
  | ({ ok: false } & FalhaDaMesa);

/**
 * Le o evento e as submissoes e monta a mesa. As TRES rotas desta borda chamam
 * ESTA funcao -- a que mostra e as duas que escrevem --, para que a ficha que o
 * operador ve e a ficha que a rota confere sejam a mesma coisa, montada pelo
 * mesmo codigo. E o mesmo desenho de `montarPlanoDaBorda` na borda da importacao.
 *
 * `lerContextoDoEvento` e reaproveitada inteira (borda.ts): ela ja traz evento,
 * etapas, manifesto, participantes e -- o que importa aqui -- QUANTAS respostas
 * cada participante ja tem, com falha de leitura virando recusa em vez de zero.
 */
export async function prepararMesaDeDecisao(
  cliente: ClienteDeConsulta & ClienteDeLeitura,
  eventId: string,
  operador: OperadorDaImportacao,
): Promise<PreparacaoDaMesa> {
  const contexto = await lerContextoDoEvento(cliente, eventId);
  if (!contexto.ok) {
    return { ok: false, codigo: contexto.codigo, motivo: contexto.motivo };
  }
  const lidas = await lerSubmissoesDoEvento(cliente, eventId);
  if (!lidas.ok) {
    return { ok: false, codigo: lidas.codigo, motivo: lidas.motivo };
  }
  // Os DERIVADOS, para a tela poder dizer PREVIAMENTE em qual dos tres estados do
  // contrato cada decisao cai. Falha aqui NAO vira "nao ha derivado": vira recusa.
  const derivados = await lerDerivadosDosParticipantes(
    cliente,
    contexto.contexto.participantes.map((p) => p.id),
  );
  if (!derivados.ok) {
    return { ok: false, codigo: derivados.codigo, motivo: derivados.motivo };
  }
  return {
    ok: true,
    mesa: montarMesaDeDecisao(
      contexto.contexto,
      contexto.manifesto,
      lidas.submissoes,
      lidas.respostas,
      operador,
      derivados.derivados,
    ),
    contexto: contexto.contexto,
    manifesto: contexto.manifesto,
    submissoes: lidas.submissoes,
  };
}

// ===========================================================================
// 4. ACHAR A FICHA QUE O PEDIDO NOMEIA
// ===========================================================================

export type FalhaDaBuscaDaFicha = {
  codigo: Extract<
    CodigoDeErro,
    | "IMPORT_SUBMISSION_NOT_FOUND"
    | "IMPORT_DECISION_REFUSED"
    | "IMPORT_TARGET_OCCUPIED"
    | "IMPORT_REVOKE_BLOCKED"
  >;
  motivo: string;
  detalhes?: DetalhesDeErro;
};

export type BuscaDaFicha<T> = { ok: true; ficha: T } | ({ ok: false } & FalhaDaBuscaDaFicha);

/**
 * A ficha da reconciliacao que o pedido nomeia, ou a recusa com o CODIGO do fato.
 *
 * Quatro fatos, quatro codigos: a submissao nao existe neste evento; o
 * participante nao e deste evento; o estado nao se decide (ja reconciliada); o
 * alvo esta ocupado. Colapsar os quatro em "nao autorizado" manda o operador
 * procurar a coisa errada -- e tres deles tem correcao diferente.
 */
export function acharFichaDeReconciliacao(
  mesa: MesaDeDecisao,
  submissoes: readonly LinhaDeSubmissao[],
  submissionId: string,
  participantId: string,
): BuscaDaFicha<FichaDeReconciliacao> {
  const linha = submissoes.find((s) => s.id === submissionId);
  if (linha === undefined) {
    return {
      ok: false,
      codigo: "IMPORT_SUBMISSION_NOT_FOUND",
      motivo: `a submissao ${submissionId} nao e deste evento`,
    };
  }
  const grupo = mesa.a_decidir.find((g) => g.submissao.id === submissionId);
  if (grupo === undefined) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo: `a submissao ${linha.submissao_id} esta ${textoDoEstado(linha.estado)}: nao ha decisao de identidade a tomar sobre ela`,
      detalhes: { estado_da_submissao: linha.estado, ato: "reconciliar" },
    };
  }
  const ficha = grupo.candidatos.find((c) => c.participante.id === participantId);
  if (ficha === undefined) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo: `o participante ${participantId} nao esta na lista deste evento`,
      detalhes: { estado_da_submissao: linha.estado, ato: "reconciliar" },
    };
  }
  if (!ficha.permitida) {
    const imp = ficha.impedimento;
    if (imp !== null && imp.codigo === "participante_ocupado") {
      return { ok: false, codigo: "IMPORT_TARGET_OCCUPIED", motivo: imp.texto, detalhes: imp.detalhes };
    }
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo:
        imp?.texto ??
        "nao da para afirmar o que seria gravado nesta decisao (o questionario da coleta nao confere com o do sistema)",
      detalhes: imp?.detalhes ?? { estado_da_submissao: linha.estado, ato: "reconciliar" },
    };
  }
  return { ok: true, ficha };
}

/** A ficha da revogacao que o pedido nomeia, ou a recusa com o codigo do fato. */
export function acharFichaDeRevogacao(
  mesa: MesaDeDecisao,
  submissoes: readonly LinhaDeSubmissao[],
  submissionId: string,
): BuscaDaFicha<FichaDeRevogacao> {
  const linha = submissoes.find((s) => s.id === submissionId);
  if (linha === undefined) {
    return {
      ok: false,
      codigo: "IMPORT_SUBMISSION_NOT_FOUND",
      motivo: `a submissao ${submissionId} nao e deste evento`,
    };
  }
  const ficha = mesa.revogaveis.find((r) => r.submissao.id === submissionId);
  // ESTADO 3 do contrato tem CODIGO PROPRIO: "ha documento gerado" nao e a mesma
  // coisa que "nao ha reconciliacao a revogar", e a correcao de uma nao serve
  // para a outra.
  if (ficha !== undefined && ficha.impedimento?.codigo === "derivado_ja_gerado") {
    return {
      ok: false,
      codigo: "IMPORT_REVOKE_BLOCKED",
      motivo: ficha.impedimento.texto,
      detalhes: ficha.impedimento.detalhes,
    };
  }
  if (ficha === undefined || !ficha.permitida) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo:
        ficha?.impedimento?.texto ??
        `a submissao ${linha.submissao_id} esta ${textoDoEstado(linha.estado)}: nao ha reconciliacao a revogar`,
      detalhes: ficha?.impedimento?.detalhes ?? { estado_da_submissao: linha.estado, ato: "revogar" },
    };
  }
  return { ok: true, ficha };
}

// ===========================================================================
// 5. AS DUAS ESCRITAS
// ===========================================================================

export interface ClienteDeEscrita {
  from(tabela: string): {
    insert(linhas: Record<string, unknown>[]): PromiseLike<{ data: unknown; error: ErroRpcCru | null }>;
  };
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: ErroRpcCru | null }>;
}

export interface AtoRegistrado {
  submission_id: string;
  acao: "reconciliada_pelo_operador";
  operador: string;
  justificativa: string;
}

export type RegistroDoAto =
  | { ok: true; ato: AtoRegistrado }
  | ({ ok: false } & FalhaDaLeitura);

/**
 * Registra o ATO do operador no historico append-only (`external_submission_events`).
 *
 * E a PRIMEIRA das duas escritas da reconciliacao, de proposito (ver o cabecalho
 * deste arquivo). O operador e o `operador` que esta funcao recebe, que vem da
 * sessao verificada da rota -- nunca do corpo do pedido.
 *
 * `detalhes` guarda a FICHA que foi confirmada, com a impressao dela: quem
 * auditar depois nao le so "reconciliou", le o que estava na tela quando
 * reconciliou, inclusive o que nao batia.
 */
export async function registrarAtoDoOperador(
  cliente: ClienteDeEscrita,
  entrada: {
    submission_id: string;
    operador: OperadorDaImportacao;
    justificativa: string;
    ficha: FichaDeReconciliacao;
  },
): Promise<RegistroDoAto> {
  const linha = {
    submission_id: entrada.submission_id,
    acao: "reconciliada_pelo_operador" as const,
    operador: entrada.operador.id,
    operador_email: entrada.operador.email ?? null,
    justificativa: entrada.justificativa,
    detalhes: {
      // O estado ANTES, para a auditoria nao depender da linha atual.
      antes: {
        estado: entrada.ficha.submissao.estado,
        motivo: entrada.ficha.submissao.motivo,
      },
      participante: {
        id: entrada.ficha.participante.id,
        nome: entrada.ficha.participante.nome,
        email: entrada.ficha.participante.email,
      },
      divergencias: entrada.ficha.divergencias,
      afirmacao: entrada.ficha.afirmacao,
      consequencia: entrada.ficha.consequencia,
      impressao_da_ficha: entrada.ficha.impressao_da_ficha,
      // A identidade passa a valer por DECISAO, e o registro diz isso com a
      // mesma palavra que a proveniencia vai gravar.
      identidade_via: "decisao_do_operador",
    },
  };

  let resposta: { data: unknown; error: ErroRpcCru | null };
  try {
    resposta = await cliente.from("external_submission_events").insert([linha]);
  } catch (e) {
    return falhaDeLeitura(
      { message: e instanceof Error ? e.message : String(e) },
      "o historico de atos do operador",
    );
  }
  if (resposta.error) {
    return falhaDeLeitura(resposta.error, "o historico de atos do operador");
  }
  return {
    ok: true,
    ato: {
      submission_id: entrada.submission_id,
      acao: "reconciliada_pelo_operador",
      operador: entrada.operador.id,
      justificativa: entrada.justificativa,
    },
  };
}

export interface ResumoDaRevogacao {
  submission_id: string;
  antes: { estado: string | null; participant_id: string | null; identidade_via: string | null };
  respostas_canonicas_removidas: number;
}

export type Revogacao =
  | { ok: true; resumo: ResumoDaRevogacao }
  | { ok: false; codigo: Extract<CodigoDeErro, "IMPORT_SCHEMA_MISSING" | "IMPORT_UNAVAILABLE">; motivo: string };

const FUNCAO_DE_REVOGACAO = "importacao_externa_revogar";

/**
 * Revoga a reconciliacao pela funcao da 022, que faz tudo numa transacao: desfaz
 * a ligacao, remove as respostas canonicas que nasceram dela e GRAVA o ato
 * 'revogada' com a justificativa. Uma escrita, nao duas -- e por isso a revogacao
 * nao tem o problema de ordem que a reconciliacao tem.
 */
export async function revogarReconciliacao(
  cliente: ClienteDeEscrita,
  entrada: { submission_id: string; operador: OperadorDaImportacao; justificativa: string },
): Promise<Revogacao> {
  let resposta: { data: unknown; error: ErroRpcCru | null };
  try {
    resposta = await cliente.rpc(FUNCAO_DE_REVOGACAO, {
      p_submission_id: entrada.submission_id,
      p_operador: entrada.operador.id,
      p_justificativa: entrada.justificativa,
    });
  } catch (e) {
    // Excecao ao falar com o banco NAO e ausencia de esquema: nao se manda
    // instalar nada com base num socket fechado.
    return {
      ok: false,
      codigo: "IMPORT_UNAVAILABLE",
      motivo: `excecao ao revogar: ${e instanceof Error ? e.name : typeof e}`,
    };
  }
  if (resposta.error) {
    return {
      ok: false,
      codigo: indicaEsquemaAusente(resposta.error) ? "IMPORT_SCHEMA_MISSING" : "IMPORT_UNAVAILABLE",
      motivo: resposta.error.message ?? "falha ao revogar a reconciliacao",
    };
  }
  const d = resposta.data as Record<string, unknown> | null;
  if (d === null || typeof d !== "object") {
    // Respondeu sem resumo: NAO da para afirmar o que foi removido. Dizer
    // "pronto" aqui seria afirmar um numero que nao se tem.
    return {
      ok: false,
      codigo: "IMPORT_UNAVAILABLE",
      motivo: "a funcao de revogacao respondeu sem resumo: nao da para afirmar o que foi desfeito",
    };
  }
  const antes = (d.antes ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    resumo: {
      submission_id: String(d.submission_id ?? entrada.submission_id),
      antes: {
        estado: typeof antes.estado === "string" ? antes.estado : null,
        participant_id: typeof antes.participant_id === "string" ? antes.participant_id : null,
        identidade_via: typeof antes.identidade_via === "string" ? antes.identidade_via : null,
      },
      respostas_canonicas_removidas: Number(d.respostas_canonicas_removidas ?? 0),
    },
  };
}

/**
 * O plano da decisao, para a rota gravar pelo MESMO caminho da importacao
 * (`aplicarPlano` -> `importacao_externa_aplicar`).
 *
 * A justificativa de verdade entra aqui, e e a mesma que foi registrada no ato.
 */
export function planoDaDecisao(
  contexto: ContextoDoEvento,
  manifesto: ManifestoQuestionario,
  s: LinhaDeSubmissao,
  participantId: string,
  justificativa: string,
  operador: OperadorDaImportacao,
): PlanoDeDecisao {
  return planejarDecisaoDoOperador(
    {
      evento: contexto.evento,
      manifesto,
      origem: {
        formulario_id: s.formulario_id,
        formulario_nome: s.formulario_nome,
        impressao_declarada: s.questionario_impressao,
      },
      submissoes: [
        {
          submissao_id: s.submissao_id,
          email: s.email_coletado,
          email_verificado: s.email_verificado,
          nome_declarado: s.nome_declarado,
          respostas: s.respostas_brutas,
        },
      ],
      // Mesma razao da ficha: a identidade anterior e a REGISTRADA.
      participantes: [],
      operador,
    },
    { submissao_id: s.submissao_id, participant_id: participantId, justificativa },
    identidadeRegistrada(s),
  );
}

/**
 * O BANCO recusou na hora de gravar? Qual recusa, com nome.
 *
 * A revalidacao da migration 024 roda DENTRO da transacao de
 * `importacao_externa_aplicar`, depois de todas as conferencias desta borda, e
 * recusa a submissao (sem gravar nada dela) quando a resposta canonica daquelas
 * etapas passou a ter outro dono. As DUAS camadas existem e NAO sao a mesma:
 *
 *   camada 1 (aqui, antes de escrever): `impedimentoDoAlvo` /
 *     IMPORT_TARGET_OCCUPIED -- o operador LE por que nao da, na ficha, antes do
 *     clique, e nenhuma escrita acontece;
 *   camada 2 (no banco, ultima linha): a revalidacao -- pega a corrida que a
 *     camada 1 nao tem como pegar, porque ela acontece DEPOIS da conferencia.
 *
 * Sem a camada 1 o operador descobriria o impedimento so depois de ter decidido.
 * Sem a camada 2 uma corrida no meio do caminho sobrescreveria resposta de
 * participante -- foi assim antes da 024, e esta medido na prova desta borda.
 */
export function recusaDaRevalidacao(
  resumo: {
    recusadas_na_revalidacao: { submissao_id: string; codigo: string; estado?: string | null }[];
  },
  submissaoDoFormulario: string,
): { codigo: CodigoDeErro; motivo: string; detalhes: DetalhesDeErro } | null {
  const r = resumo.recusadas_na_revalidacao.find((x) => x.submissao_id === submissaoDoFormulario);
  if (r === undefined) return null;
  const causa = ehCodigoDaRevalidacao(r.codigo) ? r.codigo : null;
  // O estado REAL da submissao no banco depois da recusa. `null` quando ela nunca
  // foi gravada -- e "nao existe linha" nao se escreve como "conflito".
  const estado = r.estado ?? null;
  const ESTADOS = ["importavel", "incompativel", "pendente", "conflito", "revogada"] as const;
  const nomeado = ESTADOS.find((e) => e === estado) ?? null;
  return {
    // Codigo desconhecido NAO vira "conferi e recusei": vira "o ato ficou
    // registrado e nao foi efetivado", que e o que se pode afirmar sem saber por que.
    codigo: causa !== null ? "IMPORT_REVALIDATION_REFUSED" : "IMPORT_ACT_NOT_APPLIED",
    motivo:
      `a revalidacao do banco recusou a gravacao (${r.codigo}); ` +
      (nomeado === null
        ? "a submissao nao ficou gravada em estado nenhum e nada foi gravado dela"
        : `a submissao ficou ${nomeado} e nada foi gravado dela`),
    detalhes: {
      ato: "reconciliar",
      ...(nomeado === null ? {} : { estado_da_submissao: nomeado }),
      ...(causa === null ? {} : { revalidacao: causa }),
    },
  };
}

/**
 * Os codigos de recusa que a revalidacao da 024 produz.
 *
 * A lista mora em lib/erros/codigos.ts, junto do tipo `CodigoDaRevalidacao`, e e
 * exaustiva por construcao. Reexportada aqui porque e por este nome que a borda
 * da decisao a conhece -- e porque uma SEGUNDA lista escrita a mao foi o que
 * deixou `versao_da_submissao_mudou` e `identidade_da_submissao_mudou` de fora.
 */
export { CODIGOS_DA_REVALIDACAO } from "../erros/codigos";

/** Qual codigo HTTP corresponde a cada recusa do plano da decisao. Uma tabela. */
export const CODIGO_DA_RECUSA_DA_DECISAO: Record<
  Extract<PlanoDeDecisao, { ok: false }>["codigo"],
  CodigoDeErro
> = {
  // CONFERIDO e NAO BATE: o questionario que esta pessoa respondeu nao e mais o
  // do sistema. Reconciliar agora mapearia as respostas dela contra outro
  // questionario.
  MANIFESTO_DIFERENTE: "IMPORT_MANIFEST_MISMATCH",
  // NAO DEU PARA CONFERIR. Nao e "bate" e nao e "nao bate".
  MANIFESTO_INDISPONIVEL: "IMPORT_MANIFEST_UNVERIFIABLE",
  OPERADOR_AUSENTE: "IMPORT_PLAN_REFUSED",
  ORIGEM_AUSENTE: "IMPORT_PLAN_REFUSED",
  VERSAO_DIVERGENTE: "IMPORT_PLAN_REFUSED",
  SUBMISSAO_FORA_DO_LOTE: "IMPORT_SUBMISSION_NOT_FOUND",
  DECISAO_RECUSADA: "IMPORT_DECISION_REFUSED",
};
