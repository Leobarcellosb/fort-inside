// O QUE O JOVEM LÊ QUANDO ABRE O LINK DE UM DOCUMENTO QUE SAIU DO AR.
//
// POR QUE ESTE ARQUIVO EXISTE SEPARADO DA TELA
// --------------------------------------------
// Porque este texto é a parte da suspensão que uma pessoa de 16 anos lê, sozinha,
// no celular, sobre o documento que fala da vida dela. Ele merece ser lido,
// revisado e PROVADO como qualquer outra regra do produto -- e um texto solto
// dentro de JSX não é nenhuma das três coisas.
//
// A SITUAÇÃO, exatamente
// ----------------------
// Ele clicou num link que FUNCIONAVA. Ele não fez nada. Enquanto isso, a
// organização descobriu um erro no documento e o tirou do ar (migration 027).
// Antes desta unidade, esse clique caía em `notFound()`: uma página de erro cru,
// que não explica nada e faz parecer que ele quebrou alguma coisa ou que o
// documento dele não existe.
//
// AS REGRAS DO TEXTO, e cada uma é verificada em teste
// ---------------------------------------------------
// 1. NÃO É CULPA DELE, e isso é dito em palavras, não insinuado.
// 2. NÃO É SEGREDO: diz o que aconteceu de verdade -- nós encontramos um erro e
//    nós tiramos do ar. Voz ativa, sujeito nomeado. "O documento está
//    indisponível" esconde quem agiu, e esconder é o que assusta.
// 3. SEM ALARME: nada de "erro", "falha", "problema no sistema". O que aconteceu
//    é uma correção em andamento, não um incidente.
// 4. SEM JARGÃO: "suspenso", "status", "token", "indisponível", "404" não são
//    palavras dele. Nem aparecem.
// 5. DIZ QUE ELE SERÁ AVISADO. É a única coisa que ele precisa saber para parar
//    de recarregar a página.
// 6. DIZ QUE O LINK É O MESMO. A decisão de produto da 027 é não revogar o
//    `public_share_token`: o mesmo link volta a abrir o documento corrigido. Se
//    o texto não disser isso, ele vai achar que perdeu o acesso.
// 7. NÃO MOSTRA O MOTIVO INTERNO. `prognostics.suspensao_motivo` é escrito pelo
//    operador para o operador ("a trilha saiu trocada", "o nome está errado") e
//    esta tela NUNCA o recebe -- não é informação dele, e lida fora de contexto
//    assustaria mais do que explicaria. Quem precisa dessa conversa é o host, e
//    o texto manda procurá-lo.
//
// Tudo aqui é dado puro (sem React, sem rede) para poder ser provado em teste.

/** Título da página. Fala do documento, não do sistema. */
export const TITULO_DOCUMENTO_SUSPENSO = "Seu documento está fora do ar por enquanto";

/**
 * O corpo, em parágrafos. Na ordem em que são lidos, e a ordem importa: a
 * primeira frase que ele lê tem de ser a que tira o peso dele.
 */
export const PARAGRAFOS_DOCUMENTO_SUSPENSO: readonly string[] = [
  "Você não fez nada errado, e o link que você tem continua sendo o seu.",
  "Nós encontramos algo incorreto no texto deste documento e tiramos ele do ar por nossa conta. Ele fala da sua vida, e a gente não quer que você leia uma versão com algo errado nela.",
  "A equipe já está preparando a versão corrigida. Quando ela estiver pronta, nós vamos avisar você, e este mesmo link volta a abrir o seu documento — você não vai precisar de um link novo.",
  "Nada do que você respondeu foi perdido.",
  "Se quiser conversar sobre isso antes, fale com quem conduziu o encontro com você.",
];

/** Linha curta embaixo do corpo, para quem chegou aqui recarregando a página. */
export const RODAPE_DOCUMENTO_SUSPENSO =
  "Não precisa ficar recarregando esta página: o aviso vai chegar até você.";

/**
 * Palavras que NÃO podem aparecer no que o jovem lê.
 *
 * Duas famílias, e as duas estão aqui pelo mesmo motivo -- ele não deve precisar
 * de tradução nem de calma extra para entender a própria página:
 *   JARGÃO do sistema ("suspenso", "status", "token") -- não são palavras dele;
 *   ALARME ("erro", "falha", "problema") -- descrevem um incidente, e o que está
 *     acontecendo é uma correção em andamento.
 *
 * `erro` fica na lista mesmo sendo a palavra mais natural em português: "um erro
 * no seu documento" é exatamente a frase que faz um adolescente pensar que o
 * documento sobre ele está errado por culpa dele, ou que o site quebrou. O texto
 * diz "algo incorreto no texto", que é o mesmo fato sem o susto.
 */
export const PALAVRAS_QUE_NAO_ENTRAM: readonly string[] = [
  "suspenso",
  "suspensão",
  "suspensao",
  "status",
  "token",
  "indisponível",
  "indisponivel",
  "erro",
  "falha",
  "problema",
  "sistema",
  "banco de dados",
  "404",
];

/** Tudo o que a página mostra, em um texto só -- é o que o teste inspeciona. */
export function textoIntegralDoAviso(): string {
  return [
    TITULO_DOCUMENTO_SUSPENSO,
    ...PARAGRAFOS_DOCUMENTO_SUSPENSO,
    RODAPE_DOCUMENTO_SUSPENSO,
  ].join("\n");
}
