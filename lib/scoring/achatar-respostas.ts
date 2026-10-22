// Camada entre `quiz_responses` (uma linha por etapa, cada uma com um objeto de
// respostas) e `calcularMarcoZero` (que recebe UM mapa plano id -> valor).
//
// POR QUE ELA EXISTE E POR QUE FALHA ALTO
// ---------------------------------------
// A interface grava, no tipo `select`, o TEXTO da opcao escolhida
// ("A. Organizar o problema e definir a prioridade antes de avancar."), e o
// motor le so a letra isolada ("A".."D"). Sem esta camada, as 6 situacionais
// voltavam `null` no motor, o status virava `incompleto` e metade do
// instrumento de 4 eixos sumia SEM nenhum erro. A decisao de desenho e que o
// motor continua estrito (contrato, nao heuristica de parsing) e a
// normalizacao acontece AQUI, uma vez, na borda.
//
// O mesmo defeito tem uma segunda face: o motor tambem devolve `null` para um
// Likert fora de 1..5 ou um elemento fora de 0..10, e trata isso como "nao
// respondido". Valor presente e nao normalizavel e ERRO DE DADOS, nao ausencia
// de resposta. Por isso esta camada distingue as duas coisas:
//   - pergunta ausente  -> fica fora do mapa; o motor a lista em `incompleto`
//   - pergunta presente mas ilegivel -> LANCA ErroNormalizacaoResposta, dizendo
//     qual pergunta e qual valor. Nunca devolve null em silencio.
//
// Funcao pura: sem I/O, sem data/hora. Importa os ids do motor (fonte unica);
// nao os redeclara.

import {
  ELEMENTOS,
  EIXOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  SITUACIONAIS,
  type RespostasAchatadas,
} from "./marco-zero";

/** Formato minimo de uma linha de `quiz_responses` que esta camada consome. */
export interface LinhaDeRespostas {
  stage_id: number;
  answers: unknown;
}

export class ErroNormalizacaoResposta extends Error {
  readonly perguntaId: string | null;
  readonly etapaId: number;
  readonly valor: unknown;

  constructor(
    etapaId: number,
    perguntaId: string | null,
    valor: unknown,
    motivo: string,
  ) {
    const onde =
      perguntaId === null
        ? `Etapa ${etapaId}`
        : `Pergunta ${perguntaId} (etapa ${etapaId})`;
    super(`${onde}: ${motivo}. Valor recebido: ${descrever(valor)}.`);
    this.name = "ErroNormalizacaoResposta";
    this.perguntaId = perguntaId;
    this.etapaId = etapaId;
    this.valor = valor;
  }
}

function descrever(valor: unknown): string {
  let texto: string;
  try {
    texto = JSON.stringify(valor) ?? String(valor);
  } catch {
    texto = String(valor);
  }
  return texto.length > 120 ? `${texto.slice(0, 117)}...` : texto;
}

const IDS_LIKERT: ReadonlySet<string> = new Set(
  EIXOS.flatMap((eixo) => ITENS_LIKERT[eixo]),
);
const IDS_ELEMENTOS: ReadonlySet<string> = new Set(
  ELEMENTOS.map((e) => ITENS_ELEMENTOS[e]),
);
const IDS_SITUACIONAIS: ReadonlySet<string> = new Set(SITUACIONAIS);

/**
 * Recupera a letra de uma alternativa situacional.
 *
 * Aceita exatamente dois formatos, e nenhum outro:
 *   1. a letra isolada ("A".."D", com trim e maiuscula/minuscula);
 *   2. o texto da opcao como a interface o grava: letra MAIUSCULA, ponto e
 *      espaco no inicio ("A. Organizar o problema ...").
 * Qualquer outra coisa ("A casa e grande", "E. ...", "", 3) nao e adivinhada:
 * lanca. "A casa..." comeca com A mas nao e uma alternativa.
 */
export function extrairLetraAlternativa(valor: unknown): "A" | "B" | "C" | "D" | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  const isolada = /^([A-Da-d])$/.exec(texto);
  if (isolada) return isolada[1].toUpperCase() as "A" | "B" | "C" | "D";
  const comPrefixo = /^([A-D])\.\s+\S/.exec(texto);
  if (comPrefixo) return comPrefixo[1] as "A" | "B" | "C" | "D";
  return null;
}

function inteiroEmFaixa(valor: unknown, min: number, max: number): number | null {
  let n: number | null = null;
  if (typeof valor === "number") n = Number.isInteger(valor) ? valor : null;
  else if (typeof valor === "string" && /^\s*-?\d+\s*$/.test(valor)) {
    n = Number.parseInt(valor, 10);
  }
  return n !== null && n >= min && n <= max ? n : null;
}

function valorGenerico(valor: unknown): string | number | string[] | null {
  if (typeof valor === "string") return valor;
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (Array.isArray(valor) && valor.every((v) => typeof v === "string")) {
    return valor as string[];
  }
  return null;
}

/**
 * Achata as linhas de `quiz_responses` num unico mapa id da pergunta -> valor,
 * pronto para `calcularMarcoZero`. Os ids de pergunta sao unicos no
 * questionario inteiro (migration 017), entao as 5 etapas cabem num so mapa.
 *
 * Normaliza as perguntas que o motor consome (situacional -> letra; Likert e
 * elementos -> inteiro) e repassa as demais sem alterar. Lanca
 * ErroNormalizacaoResposta ao encontrar valor que nao consegue normalizar,
 * pergunta repetida em duas etapas, etapa repetida ou `answers` que nao e um
 * objeto.
 */
export function achatarRespostas(
  linhas: readonly LinhaDeRespostas[],
): RespostasAchatadas {
  const achatado: RespostasAchatadas = {};
  const origem = new Map<string, number>();
  const etapasVistas = new Set<number>();

  for (const linha of linhas) {
    const etapaId = linha.stage_id;

    if (etapasVistas.has(etapaId)) {
      throw new ErroNormalizacaoResposta(
        etapaId,
        null,
        null,
        "a etapa aparece em mais de uma linha de respostas",
      );
    }
    etapasVistas.add(etapaId);

    const respostas = linha.answers;
    if (
      respostas === null ||
      typeof respostas !== "object" ||
      Array.isArray(respostas)
    ) {
      throw new ErroNormalizacaoResposta(
        etapaId,
        null,
        respostas,
        "o conjunto de respostas nao e um objeto",
      );
    }

    for (const [id, bruto] of Object.entries(respostas as Record<string, unknown>)) {
      const jaVista = origem.get(id);
      if (jaVista !== undefined) {
        throw new ErroNormalizacaoResposta(
          etapaId,
          id,
          bruto,
          `a pergunta ja foi respondida na etapa ${jaVista}`,
        );
      }

      let normalizado: string | number | string[] | null;
      let motivo: string;
      if (IDS_SITUACIONAIS.has(id)) {
        normalizado = extrairLetraAlternativa(bruto);
        motivo =
          'nao e uma alternativa reconhecivel (esperado "A".."D" ou o texto da opcao iniciado por "A. ")';
      } else if (IDS_LIKERT.has(id)) {
        normalizado = inteiroEmFaixa(bruto, 1, 5);
        motivo = "nao e um inteiro de 1 a 5";
      } else if (IDS_ELEMENTOS.has(id)) {
        normalizado = inteiroEmFaixa(bruto, 0, 10);
        motivo = "nao e um inteiro de 0 a 10";
      } else {
        normalizado = valorGenerico(bruto);
        motivo = "tipo de valor nao suportado (esperado texto, numero ou lista de textos)";
      }

      if (normalizado === null) {
        throw new ErroNormalizacaoResposta(etapaId, id, bruto, motivo);
      }

      achatado[id] = normalizado;
      origem.set(id, etapaId);
    }
  }

  return achatado;
}
