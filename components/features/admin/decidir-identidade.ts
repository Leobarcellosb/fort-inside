// A TELA DA DECISAO DO OPERADOR sobre identidade, sem React.
//
// O que ela existe para fazer: o operador LE o que esta afirmando ANTES de
// afirmar. Qual submissao, qual e-mail declarado, se o formulario verificou esse
// e-mail, qual participante, O QUE NAO BATE, e o que o clique vai gravar -- ou,
// na revogacao, o que o clique vai REMOVER.
//
// A CLASSIFICACAO DE ERRO NAO E ESCRITA AQUI. Ela e a de
// `importar-respostas.ts` (`desfechoDeErro`, `DESFECHO_DO_CODIGO`), importada.
// Uma segunda tabela "codigo -> qual dos tres fatos" divergiria da primeira, e e
// nessa divergencia que "nao consegui verificar" reaparece como "voce nao tem
// permissao".
//
// A IMPRESSAO DA FICHA viaja SEMPRE. `reconciliarSubmissao` e `revogarSubmissao`
// exigem a ficha recebida da mesa como argumento -- nao da para chamar nenhuma
// das duas sem ter uma ficha em maos, e a impressao que vai no corpo e a DA FICHA
// RECEBIDA, nunca uma recalculada aqui. A rota recusa (IMPORT_DECISION_STALE) se
// a ficha tiver mudado.
//
// Funcoes puras em torno de um `fetcher` injetavel, para provar o comportamento
// sem rede -- e, na prova, com as rotas de verdade contra Postgres de verdade.

import type { CodigoDeErro } from "../../../lib/erros/codigos";
import type {
  FichaDeReconciliacao,
  FichaDeRevogacao,
  MesaDeDecisao,
} from "../../../lib/importacao/decisao-do-operador";
import {
  MENSAGEM_SEM_CONEXAO,
  corpoDe,
  desfechoDeErro,
  ocorrenciaDaResposta,
  ocorrenciaLocal,
  registrarNoConsole,
  type Desfecho,
  type Fetcher,
  type Registrador,
} from "./importar-respostas";
import { MENSAGEM_GENERICA } from "../../../lib/erros/mensagens-host";

export const ROTA_DA_MESA = "/api/importacao/decisoes";
export const ROTA_DE_RECONCILIAR = "/api/importacao/reconciliar";
export const ROTA_DE_REVOGAR = "/api/importacao/revogar";

/** Os ramos de erro, reaproveitados inteiros da tela da importacao. */
export type DesfechoDeErro = Extract<
  Desfecho,
  { tipo: "recusado" } | { tipo: "nao_verificado" } | { tipo: "recurso_ausente" } | { tipo: "erro_inesperado" } | { tipo: "sem_conexao" }
>;

export type DesfechoDaMesa = { tipo: "mesa"; mesa: MesaDeDecisao } | DesfechoDeErro;

export interface AtoDoOperador {
  submission_id: string;
  acao: "reconciliada_pelo_operador";
  operador: string;
  justificativa: string;
}

export interface ResumoGravadoDaDecisao {
  linhas_de_resposta_gravadas: number;
  itens_registrados: number;
  importado_por: string;
  por_estado: Partial<Record<"importavel" | "incompativel" | "pendente" | "conflito", number>>;
}

export interface ResumoDaRevogacaoNaTela {
  submission_id: string;
  antes: { estado: string | null; participant_id: string | null; identidade_via: string | null };
  respostas_canonicas_removidas: number;
}

export type DesfechoDoAto =
  /** Reconciliada: o ATO registrado e o EFEITO gravado, os dois declarados. */
  | { tipo: "reconciliado"; ficha: FichaDeReconciliacao; ato: AtoDoOperador; gravado: ResumoGravadoDaDecisao }
  /** Revogada: o que foi desfeito e QUANTAS respostas sairam. */
  | { tipo: "revogado"; ficha: FichaDeRevogacao; revogado: ResumoDaRevogacaoNaTela }
  | DesfechoDeErro;

function inesperado(res: Response, corpo: Record<string, unknown>, registrar: Registrador): DesfechoDeErro {
  const ocorrencia = ocorrenciaDaResposta(res, corpo) ?? ocorrenciaLocal();
  registrar({ ocorrencia, status: res.status, codigo: null });
  return {
    tipo: "erro_inesperado",
    mensagem: `${MENSAGEM_GENERICA} Ocorrência: ${ocorrencia}.`,
    ocorrencia,
    status: res.status,
  };
}

/**
 * Pede a MESA DE DECISAO. Nao escreve nada, e nao existe argumento nesta funcao
 * capaz de fazer com que escreva: ela so conhece a rota de leitura.
 */
export async function pedirMesa(
  eventId: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDaMesa> {
  let res: Response;
  try {
    res = await fetcher(`${ROTA_DA_MESA}?event_id=${encodeURIComponent(eventId)}`, { method: "GET" });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }
  const corpo = await corpoDe(res);
  if (!res.ok) return desfechoDeErro(res, corpo, registrar) as DesfechoDeErro;

  const mesa = corpo.mesa as MesaDeDecisao | undefined;
  if (!mesa || typeof mesa !== "object" || !Array.isArray(mesa.a_decidir)) {
    // 200 sem mesa utilizavel NAO e "nao ha nada a decidir": uma mesa que nao
    // chegou nao e uma mesa vazia. Mostrar "nenhuma pendencia" aqui faria o
    // operador ir embora achando que esta tudo resolvido.
    return inesperado(res, corpo, registrar);
  }
  return { tipo: "mesa", mesa };
}

/**
 * CONFIRMA a atribuicao de uma submissao a um participante.
 *
 * A assinatura exige a ficha: nao da para confirmar sem ter uma, e a impressao
 * que vai no corpo e a da ficha recebida.
 *
 * O corpo NAO leva operador. Se levasse, a rota recusaria -- e e assim que a
 * regra "a importacao nao impersona ninguem" fica verificada na borda, e nao
 * apenas prometida.
 */
export async function reconciliarSubmissao(
  entrada: { eventId: string; ficha: FichaDeReconciliacao; justificativa: string },
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDoAto> {
  let res: Response;
  try {
    res = await fetcher(ROTA_DE_RECONCILIAR, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: entrada.eventId,
        submission_id: entrada.ficha.submissao.id,
        participant_id: entrada.ficha.participante.id,
        justificativa: entrada.justificativa,
        ficha_impressao: entrada.ficha.impressao_da_ficha,
      }),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }
  const corpo = await corpoDe(res);
  if (!res.ok) return desfechoDeErro(res, corpo, registrar) as DesfechoDeErro;

  const ficha = corpo.ficha as FichaDeReconciliacao | undefined;
  const ato = corpo.ato as AtoDoOperador | undefined;
  const gravado = corpo.gravado as ResumoGravadoDaDecisao | undefined;
  if (!ficha || !ato || !gravado || typeof gravado.linhas_de_resposta_gravadas !== "number") {
    return inesperado(res, corpo, registrar);
  }
  return { tipo: "reconciliado", ficha, ato, gravado };
}

/**
 * REVOGA uma reconciliacao.
 *
 * Exige a ficha da revogacao, que e onde esta o numero de respostas que serao
 * removidas: a tela nao pede confirmacao de uma remocao cujo tamanho ela nao
 * mostrou.
 */
export async function revogarSubmissao(
  entrada: { eventId: string; ficha: FichaDeRevogacao; justificativa: string },
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDoAto> {
  let res: Response;
  try {
    res = await fetcher(ROTA_DE_REVOGAR, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: entrada.eventId,
        submission_id: entrada.ficha.submissao.id,
        justificativa: entrada.justificativa,
        ficha_impressao: entrada.ficha.impressao_da_ficha,
      }),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }
  const corpo = await corpoDe(res);
  if (!res.ok) return desfechoDeErro(res, corpo, registrar) as DesfechoDeErro;

  const ficha = corpo.ficha as FichaDeRevogacao | undefined;
  const revogado = corpo.revogado as ResumoDaRevogacaoNaTela | undefined;
  if (!ficha || !revogado || typeof revogado.respostas_canonicas_removidas !== "number") {
    return inesperado(res, corpo, registrar);
  }
  return { tipo: "revogado", ficha, revogado };
}

// ===========================================================================
// O QUE A TELA MOSTRA, em texto que nasce num lugar so
// ===========================================================================

/** O minimo de justificativa que a borda aceita. A tela usa o MESMO numero. */
export const MINIMO_DA_JUSTIFICATIVA = 10;

export function justificativaSuficiente(texto: string): boolean {
  return texto.trim().length >= MINIMO_DA_JUSTIFICATIVA;
}

/** Uma frase sobre a mesa: quantas esperam decisao e quantas podem ser revogadas. */
export function resumoDaMesa(mesa: MesaDeDecisao): string {
  const n = mesa.a_decidir.length;
  const r = mesa.revogaveis.length;
  const partes: string[] = [];
  partes.push(
    n === 0
      ? "Nenhuma submissão espera decisão de identidade"
      : `${n} submissã${n === 1 ? "o espera" : "es esperam"} decisão de identidade`,
  );
  partes.push(
    r === 0
      ? "nenhuma reconciliação registrada pode ser revogada"
      : `${r} reconciliaç${r === 1 ? "ão" : "ões"} pode${r === 1 ? "" : "m"} ser revogada${r === 1 ? "" : "s"}`,
  );
  return `${partes.join("; ")}.`;
}

/**
 * O que a tela diz depois do ato. Afirma o ATO e o EFEITO separadamente: foram
 * duas escritas, e juntar as duas numa frase esconderia o caso em que a primeira
 * pegou e a segunda nao.
 */
export function resumoDoAto(d: DesfechoDoAto): string | null {
  if (d.tipo === "reconciliado") {
    return (
      `Ato registrado no histórico (reconciliada pelo operador) e efetivado: ` +
      `${d.gravado.linhas_de_resposta_gravadas} etapa(s) de resposta gravada(s) e ${d.gravado.itens_registrados} item(ns) registrado(s) para ` +
      `${d.ficha.participante.nome}. A identidade passa a valer por decisão do operador, não por verificação, e isso está gravado na procedência. ` +
      (d.ficha.consequencia?.apto_para_pontuar === false
        ? "A submissão NÃO está apta a pontuar: há DADO INCOMPATÍVEL registrado, e isso não virou pontuação zero."
        : "A submissão está apta a pontuar.")
    );
  }
  if (d.tipo === "revogado") {
    return (
      `Reconciliação revogada: ${d.revogado.respostas_canonicas_removidas} resposta(s) canônica(s) removida(s). ` +
      `A submissão continua registrada, com o payload cru, e o histórico guarda os dois atos -- o anterior não foi apagado. ` +
      `Ela volta para a mesa e pode ser atribuída a outro participante.`
    );
  }
  return null;
}

/** A conferência depois: o que a ficha prometeu bate com o que o banco gravou? */
export type ConferenciaDoAto = { bate: true } | { bate: false; divergencias: string[] };

export function conferirFichaContraGravado(
  ficha: FichaDeReconciliacao,
  gravado: ResumoGravadoDaDecisao,
): ConferenciaDoAto {
  const divergencias: string[] = [];
  const c = ficha.consequencia;
  if (c === null) {
    return {
      bate: false,
      divergencias: ["a ficha não afirmava o que seria gravado, então não há o que conferir"],
    };
  }
  if (c.etapas_a_gravar !== gravado.linhas_de_resposta_gravadas) {
    divergencias.push(
      `etapas de resposta: a ficha disse ${c.etapas_a_gravar} e o banco gravou ${gravado.linhas_de_resposta_gravadas}`,
    );
  }
  if (c.itens_a_registrar !== gravado.itens_registrados) {
    divergencias.push(
      `itens de resposta: a ficha disse ${c.itens_a_registrar} e o banco registrou ${gravado.itens_registrados}`,
    );
  }
  const esperado = c.apto_para_pontuar ? "importavel" : "incompativel";
  if ((gravado.por_estado[esperado] ?? 0) !== 1) {
    divergencias.push(
      `estado da submissão: a ficha disse ${esperado} e o banco não gravou uma submissão nesse estado`,
    );
  }
  return divergencias.length === 0 ? { bate: true } : { bate: false, divergencias };
}

/** O rotulo de cada codigo que esta borda pode devolver. Para o titulo do aviso. */
export const TITULO_DO_CODIGO: Partial<Record<CodigoDeErro, string>> = {
  IMPORT_SUBMISSION_NOT_FOUND: "Submissão não encontrada neste evento",
  IMPORT_DECISION_REFUSED: "Conferido e não autorizado — nada foi alterado",
  IMPORT_DECISION_STALE: "A ficha na tela não é mais a atual — nada foi alterado",
  IMPORT_TARGET_OCCUPIED: "O participante escolhido já tem resposta — nada foi alterado",
  IMPORT_REVALIDATION_REFUSED: "O banco recusou na hora de gravar — nada foi gravado",
  IMPORT_ACT_NOT_APPLIED: "A decisão foi registrada e não foi efetivada",
};
