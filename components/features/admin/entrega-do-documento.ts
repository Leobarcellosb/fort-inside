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

/**
 * O texto que o operador le no cartao de um documento sem revisao salva.
 *
 * E a MESMA frase que vivia no `title` do botao: ela foi aprovada na revisao e
 * nao ha motivo para reescrever o que ja instrui. O que muda e o LUGAR.
 */
export const TEXTO_SEM_REVISAO_SALVA =
  "Este documento ainda não tem revisão salva. Abra em Editar, revise o texto e salve: a entrega é liberada em seguida.";

export type MotivoDeBloqueio = "sem_revisao_salva";

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
 */
export function situacaoDaEntrega(documento: {
  conteudo_aprovado_hash?: string | null;
}): SituacaoDaEntrega {
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
