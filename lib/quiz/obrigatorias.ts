// O QUE FALTA RESPONDER, COM NOME E NUMERO -- fonte unica do formulario publico.
//
// POR QUE ESTE MODULO EXISTE
// --------------------------
// A tela do fluxo autenticado (app/(participant)/quiz/[stageId]/page.tsx) decide
// "pode enviar?" com um `allValid` booleano montado dentro do componente. Para o
// formulario publico isso nao basta, por uma regra firme deste projeto: a razao de
// um envio ser recusado tem de ser CONTEUDO DA TELA, dizendo QUAL pergunta falta --
// nunca um botao cinza, nunca um `title` que so aparece no hover do mouse (ver
// tests/contrato/explicacao-nao-fica-no-hover.test.ts, que existe porque a doenca
// ja aconteceu). Um booleano nao tem como dizer qual pergunta falta.
//
// Entao este modulo responde a pergunta inteira: NAO "esta valido?", mas "o que
// exatamente falta, com o numero da pergunta, o enunciado e POR QUE falta".
//
// O MESMO modulo e usado nos dois lados do formulario publico -- no navegador,
// para a pessoa ler antes de enviar, e no servidor, que reconfere antes de gravar.
// Uma regra, um texto, dois lados: um pedido forjado nao entra por nao passar pelo
// navegador, e a recusa do servidor nunca contradiz a da tela.
//
// AS REGRAS SAO AS DO FLUXO AUTENTICADO, COPIADAS DE PROPOSITO
// ------------------------------------------------------------
// Cada caso abaixo reproduz o ramo correspondente do `allValid` daquela tela,
// inclusive as duas decisoes que surpreendem quem le rapido:
//
//   - `text` com `min_chars` exige o minimo MESMO SEM `required`. E assim no
//     fluxo autenticado, e mudar isso aqui faria o mesmo questionario aceitar no
//     link publico o que recusa no fluxo logado.
//   - `ranking` obrigatorio exige a ordenacao COMPLETA (ranking parcial nao serve
//     para nada); e, quando nao e obrigatorio, exige tudo ou nada.
//
// A tela autenticada NAO foi alterada para importar daqui. A decisao e deliberada:
// o fluxo autenticado esta no ar e funcionando, e trocar o motor de validacao dele
// no mesmo dia em que se publica um formulario novo e risco sem beneficio para
// hoje. O preco e haver duas copias da regra, e e por isso que
// `obrigatorias.test.ts` fixa a semantica caso por caso: se um dos lados mudar, o
// teste diz o que mudou.

import type { QuizQuestion } from "../../types/database";

/** Os tres formatos que `quiz_responses.answers` guarda, por pergunta. */
export type ValorDeResposta = string | string[] | number;

/** Mapa id da pergunta -> valor, no formato de `quiz_responses.answers`. */
export type MapaDeRespostas = Record<string, ValorDeResposta | undefined>;

/**
 * POR QUE a pergunta ainda nao esta respondida. Os tres fatos sao diferentes e
 * nao se colapsam num "invalido" generico: o que a pessoa precisa fazer em cada
 * um deles e outro.
 */
export type MotivoDaFalta =
  /** Nada foi preenchido/escolhido. */
  | "em_branco"
  /** Tem texto, mas abaixo do minimo de caracteres da pergunta. */
  | "curta"
  /** Ranking comecado e nao terminado: faltam opcoes para ordenar. */
  | "ranking_incompleto";

export interface PerguntaEmFalta {
  /** Id da pergunta em `quiz_stages.questions`. */
  id: string;
  /** Posicao da pergunta DENTRO da etapa, base 1 -- o numero que a tela mostra. */
  numero: number;
  /** Enunciado, como esta no banco. */
  texto: string;
  motivo: MotivoDaFalta;
  /** Minimo de caracteres, quando `motivo === "curta"`. */
  minimoDeCaracteres?: number;
  /** Quantas opcoes a ordenacao exige, quando `motivo === "ranking_incompleto"`. */
  opcoesParaOrdenar?: number;
}

function comoTexto(valor: ValorDeResposta | undefined): string {
  return typeof valor === "string" ? valor : "";
}

function comoLista(valor: ValorDeResposta | undefined): string[] {
  return Array.isArray(valor) ? valor : [];
}

/**
 * A pergunta esta respondida a contento? Espelha o `allValid` da tela
 * autenticada, caso por caso (ver o cabecalho deste arquivo).
 */
export function perguntaRespondida(
  pergunta: QuizQuestion,
  valor: ValorDeResposta | undefined,
): boolean {
  return oQueFaltaNaPergunta(pergunta, valor) === null;
}

/**
 * O motivo pelo qual a pergunta ainda nao esta respondida, ou `null` quando esta.
 * Nao recebe o numero nem monta texto: so o fato.
 */
function oQueFaltaNaPergunta(
  pergunta: QuizQuestion,
  valor: ValorDeResposta | undefined,
): Pick<PerguntaEmFalta, "motivo" | "minimoDeCaracteres" | "opcoesParaOrdenar"> | null {
  const obrigatoria = pergunta.required === true;

  switch (pergunta.type) {
    case "select":
    case "short_text":
    case "dilemma": {
      const texto = comoTexto(valor);
      if (texto.length > 0) return null;
      return obrigatoria ? { motivo: "em_branco" } : null;
    }

    case "text": {
      const texto = comoTexto(valor);
      const minimo = pergunta.min_chars ?? 0;
      // Com minimo declarado, o minimo manda -- mesmo sem `required`. Igual a
      // tela autenticada.
      if (minimo > 0) {
        const tamanho = texto.trim().length;
        if (tamanho >= minimo) return null;
        return tamanho === 0
          ? { motivo: "em_branco", minimoDeCaracteres: minimo }
          : { motivo: "curta", minimoDeCaracteres: minimo };
      }
      if (texto.trim().length > 0) return null;
      return obrigatoria ? { motivo: "em_branco" } : null;
    }

    case "scale": {
      if (typeof valor === "number") return null;
      return obrigatoria ? { motivo: "em_branco" } : null;
    }

    case "multi_select": {
      if (comoLista(valor).length > 0) return null;
      return obrigatoria ? { motivo: "em_branco" } : null;
    }

    case "ranking": {
      // Ranking parcial nao serve para nada: ou ordena tudo, ou nao responde.
      const escolhidas = comoLista(valor);
      const total = pergunta.options?.length ?? 0;
      if (total > 0 && escolhidas.length === total) return null;
      if (!obrigatoria && escolhidas.length === 0) return null;
      return escolhidas.length === 0
        ? { motivo: "em_branco", opcoesParaOrdenar: total }
        : { motivo: "ranking_incompleto", opcoesParaOrdenar: total };
    }

    default:
      // Tipo que esta versao do codigo nao conhece: nao inventa exigencia. Igual
      // ao `default: return true` da tela autenticada.
      return null;
  }
}

/**
 * A lista do que falta numa etapa, na ORDEM EM QUE A PESSOA VE as perguntas --
 * para que o primeiro item da lista seja o primeiro campo da tela, e nao o
 * primeiro id do objeto.
 */
export function obrigatoriasEmFalta(
  perguntas: readonly QuizQuestion[],
  respostas: MapaDeRespostas,
): PerguntaEmFalta[] {
  const faltando: PerguntaEmFalta[] = [];
  perguntas.forEach((pergunta, indice) => {
    const falta = oQueFaltaNaPergunta(pergunta, respostas[pergunta.id]);
    if (!falta) return;
    faltando.push({
      id: pergunta.id,
      numero: indice + 1,
      texto: pergunta.text,
      ...falta,
    });
  });
  return faltando;
}

/** Uma frase dizendo o que falta NAQUELA pergunta, para o aviso ao lado do campo. */
export function textoDaFalta(falta: PerguntaEmFalta): string {
  switch (falta.motivo) {
    case "curta":
      return `Escreva pelo menos ${falta.minimoDeCaracteres} caracteres nesta resposta.`;
    case "ranking_incompleto":
      return `Ordene todas as ${falta.opcoesParaOrdenar} opções desta pergunta.`;
    case "em_branco":
    default:
      return "Esta pergunta é obrigatória.";
  }
}

/** Uma etapa e o que falta nela. */
export interface FaltaNaEtapa {
  /** Numero da etapa (1..N), como a pessoa a ve. */
  etapa: number;
  /** Titulo da etapa, para que o aviso diga onde voltar. */
  titulo: string;
  faltando: PerguntaEmFalta[];
}

/**
 * O resumo que a pessoa LE na tela (e que o servidor devolve no corpo da recusa).
 *
 * Diz o numero e o enunciado de cada pergunta que falta -- nunca "preencha os
 * campos obrigatorios", que obriga a pessoa a procurar. Com muitas pendencias o
 * texto cita as primeiras e conta o resto, para nao virar uma parede de texto num
 * celular; a lista completa continua marcada campo por campo na tela.
 */
export function resumoDoQueFalta(etapas: readonly FaltaNaEtapa[], limite = 3): string {
  const itens = etapas.flatMap((e) =>
    e.faltando.map((f) => ({ etapa: e.etapa, numero: f.numero, texto: f.texto })),
  );
  if (itens.length === 0) return "";

  const citar = itens.slice(0, limite);
  const trechos = citar.map(
    (i) => `etapa ${i.etapa}, pergunta ${i.numero} (${encurtar(i.texto)})`,
  );
  const restantes = itens.length - citar.length;

  if (itens.length === 1) {
    return `Falta responder ${trechos[0]}.`;
  }
  const lista = juntar(trechos);
  return restantes > 0
    ? `Faltam ${itens.length} perguntas obrigatórias: ${lista} e outras ${restantes}.`
    : `Faltam ${itens.length} perguntas obrigatórias: ${lista}.`;
}

function encurtar(texto: string, maximo = 60): string {
  const limpo = texto.trim();
  return limpo.length <= maximo ? limpo : `${limpo.slice(0, maximo - 1).trimEnd()}…`;
}

function juntar(partes: readonly string[]): string {
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join("; ")} e ${partes[partes.length - 1]}`;
}
