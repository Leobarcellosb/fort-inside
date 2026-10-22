// A causa "NÃO CONSEGUI VERIFICAR O CONSUMO", nomeada.
//
// ===========================================================================
// Por que falhar FECHADO, e qual risco isso cria
// ===========================================================================
// Decisão do CTO, revertendo a minha: sem teto verificável, NÃO SE GASTA. Eu
// havia escolhido falhar aberto (processar e gritar), argumentando que travar a
// fila no dia do evento era pior; a decisão foi a oposta e vale.
//
// Mas falhar fechado traz um risco que falhar aberto não tinha: uma fila que
// simplesmente não processa é, para quem olha o painel, IDÊNTICA a uma fila
// vazia e a um agendador morto. Então a regra deste arquivo é: a recusa tem de
// ser RUIDOSA e NOMEADA. Três coisas distintas, três respostas distintas:
//
//   "não consegui verificar o consumo"  -> BLOQUEIO, com esta causa e o que fazer
//   "não há nada a processar"           -> fila vazia (pendentes = 0)
//   "o orçamento acabou"                -> teto atingido (job vira 'canceled'
//                                          com `recusado_por_orcamento`)
//
// Confundir as três é o defeito que este projeto inteiro persegue.
//
// ===========================================================================
// Onde estes códigos DEVERIAM morar
// ===========================================================================
// O vocabulário canônico é `lib/erros/codigos.ts` + `lib/erros/mensagens-host.ts`,
// que são de OUTRA unidade e estão fora do meu escopo -- e o tipo lá é
// `Record<CodigoDeErro, Mensagem>`, então acrescentar código sem mensagem não
// compila, de propósito. Por isso estes dois códigos nascem aqui, no mesmo
// estilo, e o relatório pede a adoção deles lá.
//
// Reaproveito de `lib/erros/falha-de-fila.ts` (leitura) a distinção que aquela
// unidade já resolveu para a 018: "o objeto não existe" não é "o objeto não
// respondeu". Mandar a operação aplicar migration quando o problema é rede
// seria mandá-la investigar a coisa errada.

import { indicaEsquemaAusente, type ErroRpcCru } from "../erros/falha-de-fila";

export type CodigoDeOrcamento =
  /** As funções de orçamento NÃO EXISTEM no banco: migration 021 ausente. */
  | "BUDGET_MEASUREMENT_MISSING"
  /** Elas existem, mas a consulta falhou (rede, timeout, permissão). */
  | "BUDGET_MEASUREMENT_UNAVAILABLE";

export const DEFINICOES_DE_ORCAMENTO = {
  BUDGET_MEASUREMENT_MISSING: {
    status: 503,
    error: "A medição de consumo de IA não está instalada no banco",
  },
  BUDGET_MEASUREMENT_UNAVAILABLE: {
    status: 503,
    error: "A medição de consumo de IA não respondeu",
  },
} as const satisfies Record<CodigoDeOrcamento, { status: number; error: string }>;

// Mensagem para quem está conduzindo o evento. Mesmo formato da
// MENSAGEM_FILA_INDISPONIVEL da outra unidade: diz o que está bloqueado, POR
// QUÊ, o que fazer para destravar, e o que NÃO vai acontecer no lugar.
//
// A migration 021 é citada SÓ em BUDGET_MEASUREMENT_MISSING, que é a única
// causa que significa isso -- mesma regra que aquela unidade aplica à 018.
export const MENSAGENS_DE_ORCAMENTO: Record<CodigoDeOrcamento, string> = {
  BUDGET_MEASUREMENT_MISSING:
    "O processamento está BLOQUEADO porque o controle de consumo de IA não está instalado neste " +
    "ambiente, e sem ele não é possível saber quanto já foi gasto. Nada foi processado e nada foi " +
    "gasto. Avise a equipe técnica: falta aplicar a atualização do banco do orçamento " +
    "(migration 021). Depois de aplicada, o processamento volta a andar sozinho. Isto NÃO é fila " +
    "vazia e NÃO é orçamento esgotado.",
  BUDGET_MEASUREMENT_UNAVAILABLE:
    "O processamento está BLOQUEADO porque o controle de consumo de IA não respondeu agora, e sem " +
    "ele não é possível saber quanto já foi gasto. Nada foi processado e nada foi gasto. Aguarde " +
    "alguns instantes: se for uma falha passageira, o processamento volta a andar sozinho. Se " +
    "persistir, avise a equipe técnica. Isto NÃO é fila vazia e NÃO é orçamento esgotado.",
};

export interface BloqueioDeOrcamento {
  codigo: CodigoDeOrcamento;
  /** Texto do servidor (log, resposta de API). */
  erro: string;
  /** Texto que a operação lê na tela. Diz o que fazer. */
  mensagemParaOperacao: string;
  status: number;
  /** A mensagem crua do banco, para a equipe técnica. */
  detalhe: string | null;
}

/**
 * Formas que o POSTGRES/psql usa para "o objeto não existe", que a frase do
 * PostgREST não cobre.
 *
 * `indicaEsquemaAusente` (de `lib/erros`) reconhece o texto do PostgREST
 * ("Could not find the function ...") e o padrão
 * `function [^ ]+ does not exist`. Esse `[^ ]+` NÃO casa a mensagem do
 * Postgres cru, porque ela traz a assinatura com espaço:
 *
 *   function public.jobs_consumo_resumo(uuid, text) does not exist
 *                                            ^ espaço aqui
 *
 * Medido na prova contra Postgres real: sem este complemento, "migration 021
 * ausente" era classificada como "não respondeu", e a operação seria mandada
 * investigar rede quando o que falta é aplicar migration -- exatamente o erro
 * que aquele módulo existe para evitar. Complemento aqui, no meu escopo;
 * `lib/erros` é de outra unidade e o relatório pede o ajuste lá.
 */
function indicaObjetoAusenteNoPostgres(erro: ErroRpcCru | null | undefined): boolean {
  if (!erro) return false;
  if (erro.code === "42883" || erro.code === "42P01") return true;
  const m = erro.message ?? "";
  return (
    /\b(function|relation|table|column)\b[\s\S]*\bdoes not exist\b/i.test(m) ||
    /\b(42883|42P01)\b/.test(m) ||
    /\bnão existe\b/i.test(m)
  );
}

export function classificarBloqueioDeOrcamento(
  erroCru: ErroRpcCru | null | undefined,
  detalhe?: string | null
): BloqueioDeOrcamento {
  const ausente = indicaEsquemaAusente(erroCru) || indicaObjetoAusenteNoPostgres(erroCru);
  const codigo: CodigoDeOrcamento = ausente
    ? "BUDGET_MEASUREMENT_MISSING"
    : "BUDGET_MEASUREMENT_UNAVAILABLE";
  const d = DEFINICOES_DE_ORCAMENTO[codigo];
  return {
    codigo,
    erro: d.error,
    status: d.status,
    mensagemParaOperacao: MENSAGENS_DE_ORCAMENTO[codigo],
    detalhe: detalhe ?? erroCru?.message ?? null,
  };
}

/**
 * Mesma classificação a partir de uma exceção já embrulhada por `fila.ts` (que
 * perde o `code` do PostgREST e deixa só a mensagem). `indicaEsquemaAusente`
 * também casa por mensagem, então o caminho degradado continua distinguindo
 * "não existe" de "não respondeu".
 */
export function classificarBloqueioDeExcecao(err: unknown): BloqueioDeOrcamento {
  const mensagem = err instanceof Error ? err.message : String(err);
  return classificarBloqueioDeOrcamento({ message: mensagem }, mensagem);
}
