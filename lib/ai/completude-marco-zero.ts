// PORTAO DE COMPLETUDE DO MARCO ZERO -- conta PERGUNTAS, nunca linhas de etapa.
//
// ---------------------------------------------------------------------------
// O defeito que este arquivo fecha
// ---------------------------------------------------------------------------
// O portao de `lib/ai/contexto-quiz.ts` comparava `responses.length` (LINHAS de
// `quiz_responses`) com `stages.length` (numero de etapas). Uma linha existe
// desde que a tela tenha gravado a etapa; ela nao diz NADA sobre quantas
// perguntas daquela etapa foram respondidas. Medido na cadeia pos-coleta: um
// participante com as 5 linhas presentes e as 30 perguntas que o motor consome
// AUSENTES passou pelo portao, o modelo foi chamado, a chamada foi gasta e o
// documento foi GRAVADO -- com os quatro eixos em zero e nenhum erro na tela.
// O jovem receberia, na segunda, um documento de direcionamento sobre a vida
// dele construido a partir de quase nada, com a mesma aparencia de autoridade
// do documento de quem respondeu tudo.
//
// A contagem de linhas segue onde esta (uma etapa faltando continua sendo
// recusa, e mais barata). Este portao e o SEGUNDO, e ele conta perguntas: a
// fonte e `calcularMarcoZero(...).incompleto`, o campo que o proprio motor
// preenche com os ids que faltaram. Nada e recontado aqui.
//
// ---------------------------------------------------------------------------
// O LIMIAR, e por que ele nao e um numero unico
// ---------------------------------------------------------------------------
// Decisao de produto desta unidade, declarada:
//
//   Likert (24 itens, q16-q39)   -> exige 24 de 24. ZERO tolerancia.
//   Situacionais (6, q40-q45)    -> exige 6 de 6.  ZERO tolerancia.
//   Elementos (7, q7-q13)        -> exige MINIMO_ELEMENTOS_ANALISE_PARCIAL (5).
//
// Por que os dois primeiros blocos nao toleram nem UM item:
//   nos dois, o item ausente nao vira "nao sei" -- ele vira ZERO. O motor soma
//   o Likert em bruto (`soma += valor`, ausente nao soma nada) e conta a
//   situacional por eixo (ausente nao conta). O resultado e um eixo REBAIXADO,
//   nao um eixo em branco: os quatro numeros de 0 a 100 continuam saindo, o
//   briefing continua mostrando-os, e o texto fala com autoridade sobre uma
//   medida que esta errada para baixo. O proprio motor ja recusa a parte
//   interpretativa nesse estado (`likertCompleto` e
//   `situacionaisRespondidas === SITUACIONAIS.length` sao pre-condicao para
//   existir eixo destacado) -- o que faltava era alguem recusar o DOCUMENTO.
//
// Por que os Elementos toleram ate dois ausentes:
//   ali o motor trata ausencia como ausencia de verdade (`valor: null`, nunca
//   0; fora da media; fora do ranking) e JA TEM um piso operacional declarado
//   em um unico lugar -- `MINIMO_ELEMENTOS_ANALISE_PARCIAL`, de onde sai o
//   status "parcial" (5 ou 6 respondidos) contra "insuficiente" (menos de 5).
//   Este portao nao inventa um segundo numero: ele IMPORTA aquele. Mudar o piso
//   la muda o portao aqui, e so la.
//
// Por que o lado rigido nao deixa ninguem sem documento na segunda:
//   as 37 perguntas que o motor consome sao todas `required: true` no
//   questionario canonico da versao 2, e a tela do quiz nao deixa enviar a
//   etapa enquanto houver pergunta `required` em branco
//   (`allValid` em app/(participant)/quiz/[stageId]/page.tsx). Quem respondeu
//   pelo aplicativo NAO pode cair neste portao. Cai quem veio por importacao
//   externa de planilha, quem perdeu dado, ou quem teve a linha escrita a mao
//   no banco -- exatamente os casos em que o numero seria mentira. O portao
//   rigido aqui nao custa documento de participante; ele custa documento FALSO.
//
// Puro de proposito: sem I/O, sem SDK, sem banco. Testavel sozinho.

import {
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  MINIMO_ELEMENTOS_ANALISE_PARCIAL,
  SITUACIONAIS,
  type MarcoZeroScores,
} from "../scoring/marco-zero";

/** Bloco do instrumento a que uma pergunta pertence. */
export type BlocoDoInstrumento = "likert" | "situacional" | "elementos";

/**
 * O LIMIAR, em um lugar so. `minimo` e quantas perguntas daquele bloco tem de
 * estar respondidas para o documento poder existir.
 */
const TOTAL_LIKERT = Object.values(ITENS_LIKERT).reduce(
  (a, itens) => a + itens.length,
  0,
); // 24
const TOTAL_SITUACIONAL = SITUACIONAIS.length; // 6
const TOTAL_ELEMENTOS = Object.keys(ITENS_ELEMENTOS).length; // 7

export const EXIGENCIA_DE_COMPLETUDE: Record<
  BlocoDoInstrumento,
  { total: number; minimo: number }
> = {
  // 4 eixos x 6 itens = 24, todos.
  likert: { total: TOTAL_LIKERT, minimo: TOTAL_LIKERT },
  // 6 de 6.
  situacional: { total: TOTAL_SITUACIONAL, minimo: TOTAL_SITUACIONAL },
  // 7 itens, piso IMPORTADO do motor (hoje 5): o unico numero do limiar que
  // nao e "todos", e ele nao e redeclarado aqui.
  elementos: { total: TOTAL_ELEMENTOS, minimo: MINIMO_ELEMENTOS_ANALISE_PARCIAL },
};

const PERGUNTAS_POR_BLOCO: Record<BlocoDoInstrumento, ReadonlySet<string>> = {
  likert: new Set(Object.values(ITENS_LIKERT).flat()),
  situacional: new Set(SITUACIONAIS),
  elementos: new Set(Object.values(ITENS_ELEMENTOS)),
};

/** Quantas perguntas o motor de pontuacao consome, somando os tres blocos. */
export const PERGUNTAS_QUE_O_MOTOR_CONSOME = Object.values(
  PERGUNTAS_POR_BLOCO,
).reduce((a, s) => a + s.size, 0);

export interface BlocoAvaliado {
  bloco: BlocoDoInstrumento;
  total: number;
  minimo: number;
  respondidas: number;
  /** Ids ausentes DESTE bloco, nomeados -- nao contados. */
  faltando: string[];
  suficiente: boolean;
}

export type Completude =
  | { suficiente: true; blocos: BlocoAvaliado[] }
  | {
      suficiente: false;
      blocos: BlocoAvaliado[];
      /** Os blocos que ficaram abaixo do minimo. */
      insuficientes: BlocoDoInstrumento[];
      /** Todos os ids ausentes dos blocos insuficientes, em ordem canonica. */
      faltando: string[];
    };

/**
 * Le `incompleto` do motor e decide se as respostas bastam para o documento
 * existir. NAO reconta respostas: a lista de ausentes e a que o motor produziu.
 */
export function avaliarCompletude(scores: MarcoZeroScores): Completude {
  const ausentes = new Set(scores.incompleto);

  const blocos: BlocoAvaliado[] = (
    ["likert", "situacional", "elementos"] as const
  ).map((bloco) => {
    const exigencia = EXIGENCIA_DE_COMPLETUDE[bloco];
    const faltando = [...PERGUNTAS_POR_BLOCO[bloco]].filter((id) =>
      ausentes.has(id),
    );
    const respondidas = exigencia.total - faltando.length;
    return {
      bloco,
      total: exigencia.total,
      minimo: exigencia.minimo,
      respondidas,
      faltando,
      suficiente: respondidas >= exigencia.minimo,
    };
  });

  const insuficientes = blocos.filter((b) => !b.suficiente);
  if (insuficientes.length === 0) return { suficiente: true, blocos };

  return {
    suficiente: false,
    blocos,
    insuficientes: insuficientes.map((b) => b.bloco),
    faltando: insuficientes.flatMap((b) => b.faltando),
  };
}

const NOME_DO_BLOCO: Record<BlocoDoInstrumento, string> = {
  likert: "autoavaliação dos quatro eixos",
  situacional: "questões situacionais",
  elementos: "Elementos da Vida Plena",
};

/**
 * A mensagem da recusa: diz O QUE FALTA, em quantidade e em qual bloco. Nunca
 * carrega texto de resposta do participante.
 */
export function mensagemDeCompletude(c: Completude): string {
  if (c.suficiente) return "";
  const partes = c.blocos
    .filter((b) => !b.suficiente)
    .map(
      (b) =>
        `${NOME_DO_BLOCO[b.bloco]}: ${b.respondidas} de ${b.total} respondidas (mínimo ${b.minimo})`,
    );
  return `O questionário não tem respostas suficientes para gerar o documento -- ${partes.join("; ")}. O documento não foi gerado.`;
}
