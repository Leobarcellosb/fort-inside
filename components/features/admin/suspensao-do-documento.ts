// SUSPENDER UM DOCUMENTO JÁ ENTREGUE -- E DIZER, EM TEXTO QUE O OPERADOR LÊ,
// POR QUE CADA BOTÃO ESTÁ DO JEITO QUE ESTÁ.
//
// O PROBLEMA QUE ESTE ARQUIVO RESOLVE
// -----------------------------------
// Na segunda-feira alguém aponta um erro num documento que o jovem JÁ LEU. Até a
// migration 027, o operador não tinha botão: o banco recusa `delivered ->
// reviewed` (015) e, sem voltar a `reviewed`, o selo da 025 não se refaz e a
// reentrega também é recusada. O impasse era de propósito -- as mesmas travas
// impedem entregar conteúdo não aprovado -- e a revisão foi explícita em não
// reabrir a porta.
//
// A 027 abre um caminho PARA A FRENTE, e são DOIS atos em ordem:
//
//   1. SUSPENDER (o urgente). Um ato só, imediato, que NÃO depende de a correção
//      estar pronta: tira o documento do ar agora, porque o erro está exposto
//      agora. Exige motivo escrito, e o motivo fica no livro-razão.
//   2. RETIFICAR (o resto). Abrir em Editar, corrigir e salvar -- que é o ato de
//      aprovação da 025 -- e entregar de novo. O documento corrigido é uma versão
//      NOVA, com selo próprio, e o histórico passa a ter as duas.
//
// A REGRA DE INTERFACE QUE JÁ VALE NESTE PROJETO, e que vale aqui também
// ----------------------------------------------------------------------
// A razão de um controle estar desligado é CONTEÚDO da tela, nunca decoração de
// ponteiro (ver o cabeçalho de `entrega-do-documento.ts`: o texto vivia no
// `title` do botão, isto é, só no hover do mouse, e em celular não existe hover).
// Este arquivo segue o MESMO desenho daquele, de propósito e não por coincidência:
// textos exportados, `situacao*` pura, `idDaRazao*` por documento. Não há um
// segundo jeito de explicar um botão desligado nesta tela.
//
// Tudo aqui é função pura (sem rede, sem React) para poder ser provado em teste.

// ---------------------------------------------------------------------------
// O piso do motivo
// ---------------------------------------------------------------------------
/**
 * Mínimo de caracteres úteis no motivo da suspensão.
 *
 * É o MESMO piso que o banco impõe (CHECK `prognostics_suspensao_tem_autor_e_motivo`
 * e `prognostic_suspension_events_motivo_check`, migration 027). Está repetido
 * aqui para a tela não oferecer um envio que só pode ser recusado -- a garantia
 * continua sendo do banco; isto é só não deixar o operador escrever e perder o
 * texto.
 *
 * Dez, e não três como na 022: "erro" cabe em três caracteres e não diz nada a
 * quem for ler isso na segunda-feira com um jovem na frente.
 */
export const MINIMO_DO_MOTIVO = 10;

export const TEXTO_MOTIVO_OBRIGATORIO =
  "Escreva por que este documento está saindo do ar. Quem ler este registro depois precisa saber o que estava errado, e isso fica guardado como ato seu — não é um campo de formalidade.";

export const TEXTO_MOTIVO_CURTO = `O motivo precisa ter ao menos ${MINIMO_DO_MOTIVO} caracteres. "erro" não diz o que estava errado.`;

export type MotivoInvalido = "ausente" | "curto";

export type ValidacaoDoMotivo =
  | { valido: true; motivo: string }
  | { valido: false; problema: MotivoInvalido; texto: string };

/**
 * O motivo que o operador escreveu serve?
 *
 * Mede o motivo DEPOIS de tirar espaços das pontas, igual ao `length(btrim(...))`
 * do banco: um motivo de cinquenta espaços não é motivo, e a tela não pode
 * aceitar o que o banco vai recusar.
 */
export function validarMotivoDaSuspensao(bruto: string | null | undefined): ValidacaoDoMotivo {
  const motivo = (bruto ?? "").trim();
  if (motivo === "") {
    return { valido: false, problema: "ausente", texto: TEXTO_MOTIVO_OBRIGATORIO };
  }
  if (motivo.length < MINIMO_DO_MOTIVO) {
    return { valido: false, problema: "curto", texto: TEXTO_MOTIVO_CURTO };
  }
  return { valido: true, motivo };
}

// ---------------------------------------------------------------------------
// Quando o botão "Tirar do ar" existe, e por que ele não existe
// ---------------------------------------------------------------------------
/**
 * A razão quando o ato NÃO SE APLICA.
 *
 * DECLARADO: o cartão de um documento não entregue NÃO renderiza esta frase, e o
 * botão "Tirar do ar" simplesmente não aparece lá. Não é a regra do `title`
 * sendo quebrada -- a regra é sobre controle DESLIGADO, e aqui o controle é
 * AUSENTE, pelo mesmo motivo que "Copiar link" não aparece num documento que
 * ninguém entregou: o ato não existe para aquele documento. Renderizar a
 * explicação em todos os cinquenta cartões não entregues seria exatamente o
 * ruído que o cabeçalho de `entrega-do-documento.ts` manda evitar.
 *
 * A frase existe porque a função precisa dizer POR QUE recusou -- é o que o
 * teste lê, é o que quem for exibir o botão sempre vai renderizar, e é a mesma
 * condição que o banco impõe.
 */
export const TEXTO_SO_ENTREGUE_SUSPENDE =
  "Só um documento já entregue pode sair do ar: é o que o participante está lendo. Este ainda não foi entregue, então não há nada para tirar do ar — e entregar texto sem revisão salva já é impossível.";

export const TEXTO_JA_ESTA_FORA_DO_AR =
  "Este documento já está fora do ar. O participante que abrir o link dele vê um aviso dizendo que a versão corrigida está sendo preparada e que ele será avisado.";

export type MotivoSemSuspensao = "nao_entregue" | "ja_suspenso";

export type SituacaoDaSuspensao =
  | { disponivel: true }
  | { disponivel: false; motivo: MotivoSemSuspensao; texto: string };

/**
 * Este documento pode sair do ar agora?
 *
 * A cerca de verdade é do banco (gatilho `prognostics_suspensao`, migration 027):
 * suspender só é aceito a partir de `delivered`. Esta função NÃO reimplementa a
 * cerca -- ela traduz a mesma condição em instrução, para a tela não oferecer um
 * botão que só pode falhar.
 */
export function situacaoDaSuspensao(documento: { status?: string | null }): SituacaoDaSuspensao {
  const status = documento.status ?? null;
  if (status === "suspended") {
    return { disponivel: false, motivo: "ja_suspenso", texto: TEXTO_JA_ESTA_FORA_DO_AR };
  }
  if (status !== "delivered") {
    return { disponivel: false, motivo: "nao_entregue", texto: TEXTO_SO_ENTREGUE_SUSPENDE };
  }
  return { disponivel: true };
}

// ---------------------------------------------------------------------------
// O caminho de volta, escrito no cartão de quem está suspenso
// ---------------------------------------------------------------------------
/**
 * O que o operador lê no cartão de um documento fora do ar.
 *
 * "Está suspenso" não é instrução. O caminho é: Editar -> corrigir -> salvar
 * (que É a nova aprovação, migration 025) -> Entregar. E ele diz que a versão
 * anterior NÃO volta: o que vai ao ar é uma versão nova, com selo próprio, e o
 * histórico passa a ter as duas.
 *
 * É TAMBÉM a razão de "Entregar" estar desligado num documento suspenso, e
 * `entrega-do-documento.ts` lê esta constante em vez de escrever a dela: há UMA
 * frase por fato nesta tela. O cartão renderiza um parágrafo, não dois dizendo o
 * mesmo com palavras diferentes.
 */
export const TEXTO_CAMINHO_DA_RETIFICACAO =
  "Fora do ar: o participante não está lendo este documento. Para corrigir, toque em Revisar, ajuste o texto e salve: salvar é a nova aprovação. Depois disso o envio é liberado e o link que ele já tem volta a funcionar. A versão anterior não é reaberta: ela fica no histórico, com a data em que ele a leu.";

/**
 * Id do parágrafo que explica por que "Tirar do ar" está desligado, para ligar o
 * botão ao texto por `aria-describedby`.
 *
 * É um id DIFERENTE do de `entrega-do-documento.ts` (`idDaRazao`) de propósito:
 * num mesmo cartão os dois podem existir ao mesmo tempo e falam de botões
 * diferentes. Um id só faria o leitor de tela anunciar a razão do outro botão.
 */
export function idDaRazaoDaSuspensao(prognosticoId: string): string {
  return `suspensao-bloqueada-${prognosticoId}`;
}

// ---------------------------------------------------------------------------
// O que o operador lê quando a suspensão é recusada
// ---------------------------------------------------------------------------
/**
 * Rótulo do botão. "Tirar do ar" e não "Suspender": diz o que acontece com o
 * documento do ponto de vista de quem o está lendo, que é o que importa decidir.
 */
export const ROTULO_SUSPENDER = "Tirar do ar";

export const TITULO_DA_CONFIRMACAO = "Tirar este documento do ar";

/**
 * O que o ato faz e o que ele NÃO faz, no momento de confirmar.
 *
 * Diz as duas metades do princípio da 027, porque as duas são decisões que o
 * operador está tomando: o jovem para de ler agora, e nada é apagado.
 */
export const TEXTO_DA_CONFIRMACAO =
  "O participante para de ver este documento imediatamente, e quem abrir o link vê um aviso de que a versão corrigida está sendo preparada. Nada é apagado: o texto atual continua guardado e o histórico continua registrando o que ele leu e quando.";
