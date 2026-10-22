// A RECUSA DA LIBERAÇÃO DE ETAPA, TRADUZIDA PARA QUEM CONDUZ O EVENTO.
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// O painel ao vivo não passa por rota de API para liberar etapa: ele grava
// `events.current_stage` DIRETO na tabela, pelo cliente do navegador
// (LiveControlPanel.tsx). Então não há `erroHttp` no caminho, não há corpo
// `{ error, code, ocorrencia }` montado pelo servidor, e não há `solicitarProcessamento`
// para ler esse corpo. O que chega à tela é o erro cru do PostgREST.
//
// A unidade anterior conteve a tela: num evento cujas etapas não são numeradas de
// 1 a N, o painel deixou de OFERECER "liberar etapa". A revisão aprovou e pediu
// mais -- "verificar expressamente o bloqueio por MODO no ENDPOINT" --, e a
// medição mostrou que ela tinha razão: não havia trava nenhuma no banco. Parar de
// oferecer não é impedir. A trava passou a existir na migration 028, e este
// arquivo é o lado da tela dela.
//
// A REGRA QUE ESTE ARQUIVO CUMPRE
// -------------------------------
// A recusa tem de dizer QUAL é o fato. "Não consegui verificar", "verifiquei e
// recusei" e "o banco recusou e não deu para saber por quê" são fatos
// diferentes, e cada um manda o host fazer uma coisa diferente. Colapsá-los em
// "Erro ao liberar etapa" -- que é literalmente o que esta tela dizia -- manda o
// host investigar a coisa errada: ele lê "erro", conclui que o sistema quebrou, e
// o fato pode ser que a operação simplesmente não se aplica ao evento dele.
//
// O NOME DO FATO vem do campo DETAIL da exceção do gatilho, não da prosa da
// MESSAGE: o PostgREST entrega DETAIL em `error.details`, então aqui se lê um
// nome fechado (`FatoDaLiberacaoDeEtapa`, em lib/erros/codigos.ts) em vez de
// interpretar texto de banco em português. Texto de banco NUNCA é exibido ao
// host; ele vai para o console do navegador, sob um número de ocorrência que o
// host pode citar.
//
// Tudo aqui é função pura (sem rede, sem React), para poder ser provado em teste.

import {
  ehFatoDaLiberacaoDeEtapa,
  novaOcorrencia,
  type CodigoDeLiberacaoDeEtapa,
  type DetalhesDeErro,
  type FatoDaLiberacaoDeEtapa,
  // Caminho relativo, e não o alias `@/`: este módulo é PURO e é carregado
  // direto pelo vitest, que não resolve o alias do Next (mesma razão em
  // processar-evento.ts, ao lado).
} from "../../../lib/erros/codigos";
import { mensagemParaHost } from "../../../lib/erros/mensagens-host";

/**
 * O erro cru, como o cliente do Supabase o entrega. Todos os campos são
 * opcionais de propósito: um erro de rede chega sem `code` e sem `details`, e
 * presumir que eles existem é como se afirma recusa sobre uma gravação que
 * talvez tenha passado.
 */
export interface ErroDeGravacao {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** SQLSTATE 23514. É o errcode com que o gatilho da 028 recusa (como a 015 e a 025). */
const CHECK_VIOLATION = "23514";

/**
 * A forma de um NOME DE FATO: minúsculas e sublinhado, curto. Serve para decidir
 * se o que veio em `details` pode ser mostrado ao host como um nome citável.
 *
 * Existe porque STAGE_RELEASE_REFUSED_UNNAMED quer que o host consiga NOMEAR ao
 * técnico a causa que esta versão da tela não conhece -- e, ao mesmo tempo, a
 * regra do projeto é que texto de banco não chega à tela. Um nome nesta forma é
 * identificador, não prosa; qualquer coisa fora dela é tratada como texto de
 * banco e omitida.
 */
const FORMA_DE_NOME_DE_FATO = /^[a-z][a-z0-9_]{2,63}$/;

const CODIGO_DO_FATO: Record<FatoDaLiberacaoDeEtapa, CodigoDeLiberacaoDeEtapa> = {
  modo_nao_libera_etapa: "STAGE_RELEASE_MODE_MISMATCH",
  etapa_fora_da_versao_do_evento: "STAGE_RELEASE_STAGE_ABSENT",
  versao_sem_etapas_utilizaveis: "STAGE_RELEASE_STAGES_UNUSABLE",
};

export interface ContextoDaLiberacao {
  /** A etapa que o painel tentou liberar. */
  etapaPedida: number;
  /** Quantas etapas o painel conseguiu ler deste evento. `null` quando não sabe. */
  totalEtapas: number | null;
  /** O modo que o painel recebeu do servidor ao carregar a página. Pode estar velho. */
  modo: string | null | undefined;
}

export interface RecusaDaLiberacao {
  codigo: CodigoDeLiberacaoDeEtapa;
  detalhes: DetalhesDeErro;
  /** O texto que o host lê. Nasce em lib/erros/mensagens-host.ts, nunca aqui. */
  mensagem: string;
  /** Identificador curto e citável desta ocorrência. Vai junto ao log do console. */
  ocorrencia: string;
}

/**
 * Acha o nome do fato dentro do erro cru.
 *
 * Olha `details` primeiro, que é onde o PostgREST põe o DETAIL da exceção, e
 * depois `hint` e `message` -- não porque o gatilho os use para isso, mas porque
 * clientes e proxies no caminho às vezes concatenam os campos, e perder o nome
 * por causa disso rebaixaria uma recusa nomeada a "recusa sem nome".
 *
 * Casa por IGUALDADE sobre o campo aparado antes de tentar substring: assim um
 * `details` que seja exatamente o nome do fato é reconhecido sem ambiguidade, e
 * um texto maior que o contenha também.
 */
function fatoDoErro(erro: ErroDeGravacao): FatoDaLiberacaoDeEtapa | null {
  const campos = [erro.details, erro.hint, erro.message];
  for (const campo of campos) {
    if (typeof campo !== "string") continue;
    const limpo = campo.trim();
    if (ehFatoDaLiberacaoDeEtapa(limpo)) return limpo;
  }
  for (const campo of campos) {
    if (typeof campo !== "string") continue;
    for (const fato of Object.keys(CODIGO_DO_FATO) as FatoDaLiberacaoDeEtapa[]) {
      if (campo.includes(fato)) return fato;
    }
  }
  return null;
}

/** O nome que o banco deu, quando esta versão da tela não o conhece e ele é citável. */
function nomeCitavel(erro: ErroDeGravacao): string | undefined {
  const d = typeof erro.details === "string" ? erro.details.trim() : "";
  return FORMA_DE_NOME_DE_FATO.test(d) ? d : undefined;
}

/**
 * Classifica o erro de uma tentativa de liberar etapa.
 *
 * As três saídas, e por que são três:
 *
 *   1. O banco nomeou o fato -> o código daquele fato. Recusa verificada (ou
 *      indisponibilidade verificada, no caso da versão sem etapas utilizáveis).
 *   2. O banco recusou (SQLSTATE 23514) e NÃO nomeou um fato deste vocabulário
 *      -> STAGE_RELEASE_REFUSED_UNNAMED. A recusa é FATO (nada foi gravado), a
 *      causa NÃO é: a tela não a inventa. Acontece quando o banco tem uma versão
 *      da trava mais nova que esta tela.
 *   3. Qualquer outra coisa -> STAGE_RELEASE_UNAVAILABLE. Rede caída, sessão
 *      perdida, timeout. NÃO se afirma recusa, porque não se sabe se a gravação
 *      passou; a mensagem manda recarregar para ver a etapa atual.
 *
 * Nunca devolve "a trava não está instalada": a ausência da migration 028 não
 * produz erro, produz uma gravação que PASSA. Esse fato não é observável a partir
 * de um sucesso, e quem o cobre é o guarda de drift -- não esta função.
 */
export function classificarRecusaDeLiberacao(
  erro: ErroDeGravacao | null | undefined,
  contexto: ContextoDaLiberacao,
): RecusaDaLiberacao {
  const e = erro ?? {};
  const fato = fatoDoErro(e);

  const detalhes: DetalhesDeErro = { etapa_pedida: contexto.etapaPedida };
  if (typeof contexto.totalEtapas === "number") detalhes.total_etapas = contexto.totalEtapas;

  let codigo: CodigoDeLiberacaoDeEtapa;
  if (fato) {
    codigo = CODIGO_DO_FATO[fato];
    if (fato === "modo_nao_libera_etapa") {
      // O modo que a mensagem cita é o que ESTA TELA recebeu ao carregar. Se ela
      // achava que era `live` e o banco recusou por modo, a cópia dela está
      // velha -- e então o honesto é "desconhecido", não "é assíncrono": afirmar
      // o modo errado manda o host conferir a coisa errada.
      detalhes.modo_do_evento = contexto.modo === "async" ? "async" : "desconhecido";
    }
  } else if (e.code === CHECK_VIOLATION) {
    codigo = "STAGE_RELEASE_REFUSED_UNNAMED";
    const nome = nomeCitavel(e);
    if (nome) detalhes.fato_do_banco = nome;
  } else {
    codigo = "STAGE_RELEASE_UNAVAILABLE";
  }

  return {
    codigo,
    detalhes,
    mensagem: mensagemParaHost(codigo, detalhes),
    ocorrencia: novaOcorrencia(),
  };
}
