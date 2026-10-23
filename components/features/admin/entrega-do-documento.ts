// POR QUE O BOTAO "ENTREGAR" ESTA DESLIGADO -- EM TEXTO QUE O OPERADOR LE.
//
// O PROBLEMA QUE ESTE ARQUIVO RESOLVE
// -----------------------------------
// Desde a migration 025 entregar documento NAO REVISADO deixou de ser possivel:
// `delivered` exige `conteudo_aprovado_hash` com a impressao digital do texto
// que a ultima revisao humana aprovou. A tela de revisao desliga o botao
// "Entregar" enquanto esse selo nao existe, porque um botao que so pode falhar e
// pior do que um botao desligado.
//
// A garantia esta certa. O que estava errado era a INFORMACAO: a explicacao
// existia so no atributo `title` do botao, isto é, so no hover do mouse. Em tela
// de toque nao existe hover -- o operador com o telefone na mao via um botao
// cinza e NENHUMA palavra dizendo por que. Leitor de tela tambem nao resolve com
// `title`: um botao desabilitado nem entra na ordem de foco, e a descricao nunca
// e anunciada. Resultado: a protecao nova era lida como botao quebrado.
//
// A REGRA ADOTADA
// ---------------
// A razao de um controle estar desligado e CONTEUDO da tela, nao decoracao de
// ponteiro. Ela aparece no cartao do documento afetado -- nao num aviso global,
// que repetido em cinquenta cartoes vira ruido e ninguem le -- e desaparece
// sozinha quando aquele documento e liberado, porque e calculada a partir do
// estado DAQUELE documento.
//
// E tem de dizer o CAMINHO. "Nao da" nao e instrucao; "abra em Editar, revise o
// texto e salve" e.
//
// Tudo aqui e funcao pura (sem rede, sem React) para poder ser provado em teste.

import { TEXTO_CAMINHO_DA_RETIFICACAO } from "./suspensao-do-documento";

/**
 * O texto que o operador le no cartao de um documento sem revisao salva.
 *
 * E a MESMA frase que vivia no `title` do botao: ela foi aprovada na revisao e
 * nao ha motivo para reescrever o que ja instrui. O que muda e o LUGAR.
 */
export const TEXTO_SEM_REVISAO_SALVA =
  "Ainda sem revisão. Toque em Revisar, leia o texto inteiro e salve: o envio é liberado em seguida.";

/**
 * O SEGUNDO motivo, acrescentado com a migration 027.
 *
 * Um documento fora do ar CONTINUA com o selo da última aprovação -- o selo é
 * imutável fora do ato de aprovação (025) e a suspensão não o toca. Então, para
 * esta função, "tem selo" continuaria verdadeiro e o botão "Entregar" ficaria
 * LIGADO sobre um documento suspenso. O banco recusaria (a 027 só aceita sair de
 * `suspended` para nova revisão), mas um botão que só pode falhar é exatamente o
 * que este módulo existe para não ter.
 *
 * E a razão da recusa é a parte que importa do produto: reentregar sem nova
 * revisão devolveria ao ar o MESMO texto errado, porque o conteúdo não mudou e o
 * selo bateria. O caminho é para a frente: corrigir, salvar (nova aprovação) e
 * entregar.
 *
 * O TEXTO vem de `suspensao-do-documento.ts` e NÃO é reescrito aqui: há UMA frase
 * por fato nesta tela. Duas redações do mesmo bloqueio divergiriam na primeira
 * vez que alguém corrigisse uma delas.
 */
export type MotivoDeBloqueio = "sem_revisao_salva" | "suspenso_aguardando_nova_revisao";

export type SituacaoDaEntrega =
  | { liberada: true }
  | { liberada: false; motivo: MotivoDeBloqueio; texto: string };

/**
 * A entrega deste documento esta liberada?
 *
 * O selo (`conteudo_aprovado_hash`) e escrito pelo gatilho do banco quando a
 * revisao e salva. Esta funcao NAO o calcula e NAO o escreve: ela so traduz a
 * ausencia dele em instrucao. A garantia continua sendo do banco -- se esta tela
 * errasse e oferecesse o botao, a entrega seria recusada la (check_violation
 * 23514), e nao entregue sem revisao.
 *
 * Hash vazio ou so com espacos conta como ausente: um selo em branco nao e selo.
 *
 * A SUSPENSAO e conferida ANTES do selo, de proposito: um documento fora do ar
 * TEM selo (a suspensao nao o toca), e perguntar primeiro pelo selo responderia
 * "liberada" para ele. A ordem das duas perguntas e a diferenca entre um botao
 * que explica e um botao que mente.
 */
export function situacaoDaEntrega(documento: {
  status?: string | null;
  conteudo_aprovado_hash?: string | null;
}): SituacaoDaEntrega {
  if (documento.status === "suspended") {
    return {
      liberada: false,
      motivo: "suspenso_aguardando_nova_revisao",
      texto: TEXTO_CAMINHO_DA_RETIFICACAO,
    };
  }
  const selo = documento.conteudo_aprovado_hash;
  const temSelo = typeof selo === "string" && selo.trim() !== "";
  return temSelo
    ? { liberada: true }
    : { liberada: false, motivo: "sem_revisao_salva", texto: TEXTO_SEM_REVISAO_SALVA };
}

/** Id do paragrafo que explica o bloqueio, para ligar o botao ao texto por `aria-describedby`. */
export function idDaRazao(prognosticoId: string): string {
  return `entrega-bloqueada-${prognosticoId}`;
}
