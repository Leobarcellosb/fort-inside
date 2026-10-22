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
// O LIMIAR: 37 de 37, sem tolerancia em nenhum bloco
// ---------------------------------------------------------------------------
//
//   Likert (24 itens, q16-q39)   -> exige 24 de 24. ZERO tolerancia.
//   Situacionais (6, q40-q45)    -> exige 6 de 6.  ZERO tolerancia.
//   Elementos (7, q7-q13)        -> exige 7 de 7.  ZERO tolerancia.
//
// CORRECAO DE REVISAO, declarada. A versao anterior deste arquivo tolerava
// ausencia nos Elementos: o minimo era `MINIMO_ELEMENTOS_ANALISE_PARCIAL` (5),
// importado do motor. A revisao aprovou a arquitetura deste portao e RECUSOU a
// tolerancia, nestas palavras: "aprovo a arquitetura do novo portao, mas nao a
// flexibilizacao de perguntas obrigatorias".
//
// O argumento, e ele e sobre ONDE um numero vale:
//   as sete perguntas dos Elementos sao `required: true` no questionario
//   canonico. Uma regra de completude que tolera a ausencia de pergunta
//   OBRIGATORIA contradiz o contrato do proprio instrumento -- o questionario
//   afirma "sem isto a etapa nao se envia" e o portao respondia "sem duas
//   destas o documento ainda sai".
//   `MINIMO_ELEMENTOS_ANALISE_PARCIAL` nao estava errado; estava no lugar
//   errado. Ele existe no motor para uma decisao DENTRO da analise -- separar
//   leitura "parcial" de "insuficiente" nos Elementos -- e nao para decidir se
//   um documento pode EXISTIR. Reusa-lo aqui era um numero certo num lugar
//   errado, e por isso o import foi desfeito: este portao nao depende mais
//   daquele piso, e recalibrar o piso la nao afrouxa o portao aqui.
//
// O que a exigencia de 7 de 7 custa, medido antes de mudar: nada para quem
// respondeu pelo aplicativo. As 37 perguntas que o motor consome sao todas
// obrigatorias no questionario canonico (conferido em
// docs/questionario-v2-canonico.json: as 52 perguntas sao `required`, zero
// nao-obrigatorias) e a tela nao deixa enviar etapa com pergunta obrigatoria em
// branco. Quem cai neste portao vem de planilha incompleta, de perda de dado ou
// de linha escrita a mao -- exatamente os casos em que o numero seria mentira.
//
// ---------------------------------------------------------------------------
// AUDITORIA: as perguntas obrigatorias que este portao NAO cobre
// ---------------------------------------------------------------------------
// A segunda metade da ordem da revisao era "conferir todas as demais
// obrigatorias". Conferido, e o resultado esta declarado aqui porque e a
// resposta que faltava:
//
//   o questionario canonico da versao 2 tem 52 perguntas, TODAS obrigatorias.
//   Este portao cobre as 37 que o motor consome. As outras 15 sao
//   q1-q6 (etapa 1, "Sobre voce"), q14-q15 (etapa 2) e q46-q52 (etapa 5),
//   todas de texto livre.
//
// Elas ENTRAM no documento -- isto foi verificado, nao presumido: nenhum codigo
// as consome por id (o nome do cabecalho vem de `participants.full_name`, nao
// de q1), mas todas chegam ao modelo como RESPOSTAS ABERTAS, pela funcao
// `formatarRespostasAbertas` de lib/ai/prognostic-prompt.ts, e o prompt do
// Marco Zero autoriza recomendacao de foco nascida delas.
//
// VEREDITO, por grupo, e a razao de ele NAO ser "bloquear":
//   q1-q5 (nome, idade, cidade, organizacao, papel) -- contexto. A ausencia
//     tira uma linha de contexto do prompt e nada mais; nao produz afirmacao
//     nenhuma sobre a pessoa.
//   q6, q14, q15, q46-q52 -- o substrato interpretativo. A ausencia tira
//     material, e o documento sai MAIS CURTO.
//
// O criterio deste portao nao e "o documento ficaria mais pobre": e "o
// documento MENTIRIA". Nos tres blocos pontuados o item ausente nao vira
// ausencia -- vira ZERO na soma, e sai um eixo rebaixado que o texto afirma com
// autoridade. Numa resposta aberta ausente nao existe numero para sair errado:
// ela simplesmente nao aparece, e as tres camadas seguintes ja impedem que o
// modelo preencha a lacuna -- o briefing nao fala do que nao foi medido, a
// regra 3 do prompt ("Ausente nao e baixo") proibe tratar falta como fraqueza,
// e o verificador de saida (lib/ai/saida-prognostico.ts) devolve o texto que
// afirmar o que o briefing nao autorizou.
// E ha precedente MEDIDO neste repositorio para o desfecho desse caso, em
// lib/ai/prognostic-schema.ts: um participante que respondeu so as escalas e
// deixou as abertas vazias rendeu 2 areas-chave em vez de 3, e a decisao
// registrada ali foi "entregar um mapa mais curto e melhor que nao entregar".
// Bloquear as 15 aqui reverteria essa decisao de produto por efeito colateral
// de uma correcao de completude -- e seria tirar o documento de quem respondeu
// as 37 perguntas pontuadas, que e o oposto do que esta unidade foi corrigir.
//
// Entao o escopo do portao NAO muda, e a divergencia fica vigiada em vez de
// esquecida: um teste em completude-marco-zero.test.ts le o questionario
// canonico e afirma a lista EXATA das 15 obrigatorias nao cobertas. Se o
// questionario ganhar pergunta obrigatoria nova, ou se uma destas passar a ser
// consumida pelo motor, o teste quebra e a auditoria e refeita -- com decisao
// de produto, nao em silencio.
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
// Por que os Elementos tambem nao toleram nenhum, apesar de o motor saber
// conviver com a ausencia deles:
//   e verdade que ali o motor trata ausencia como ausencia de verdade
//   (`valor: null`, nunca 0; fora da media; fora do ranking) e que ele declara
//   a leitura "parcial" em vez de inventar numero. Isso faz do Elemento
//   ausente um problema menor DENTRO da analise -- e foi o que justificou a
//   tolerancia anterior. Nao e o que se decide aqui. Aqui se decide se o
//   documento EXISTE, e a pergunta e obrigatoria no instrumento: o portao nao
//   tem autoridade para dispensar o que o questionario exige. O motor segue
//   livre para dizer "parcial"; o que ele nao decide mais e a existencia do
//   documento.
//
// Por que o limiar inteiro nao deixa ninguem sem documento na segunda:
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
  // 7 de 7. Era `MINIMO_ELEMENTOS_ANALISE_PARCIAL` (5), importado do motor;
  // a revisao recusou a tolerancia e o import foi desfeito. Nao existe mais
  // numero de limiar fora de "todos" neste portao.
  elementos: { total: TOTAL_ELEMENTOS, minimo: TOTAL_ELEMENTOS },
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
