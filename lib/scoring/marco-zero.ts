// Motor de pontuacao deterministico do Marco Zero. Funcoes puras: sem I/O,
// sem data/hora, sem aleatoriedade, sem IA.

export const EIXOS = ["visao", "execucao", "relacao", "integridade"] as const;
export type Eixo = (typeof EIXOS)[number];

export const ELEMENTOS = [
  "desenvolvimento_intelectual",
  "saude_energia",
  "equilibrio_emocional",
  "recursos_financeiros",
  "contribuicao_social",
  "realizacao_proposito",
  "hobbies_diversao",
] as const;
export type Elemento = (typeof ELEMENTOS)[number];

export type Alternativa = "A" | "B" | "C" | "D";
export type Resposta = string | string[] | number;
export type RespostasAchatadas = Record<string, Resposta>;

export const ITENS_LIKERT: Record<Eixo, readonly string[]> = {
  visao: ["q16", "q17", "q18", "q19", "q20", "q21"],
  execucao: ["q22", "q23", "q24", "q25", "q26", "q27"],
  relacao: ["q28", "q29", "q30", "q31", "q32", "q33"],
  integridade: ["q34", "q35", "q36", "q37", "q38", "q39"],
};

export const SITUACIONAIS = ["q40", "q41", "q42", "q43", "q44", "q45"] as const;

// Cada questao tem exatamente uma alternativa por eixo.
export const MAPA_SITUACIONAL: Record<
  (typeof SITUACIONAIS)[number],
  Record<Alternativa, Eixo>
> = {
  q40: { A: "visao", B: "execucao", C: "relacao", D: "integridade" },
  q41: { A: "relacao", B: "integridade", C: "visao", D: "execucao" },
  q42: { A: "execucao", B: "visao", C: "integridade", D: "relacao" },
  q43: { A: "integridade", B: "execucao", C: "relacao", D: "visao" },
  q44: { A: "visao", B: "relacao", C: "execucao", D: "integridade" },
  q45: { A: "relacao", B: "execucao", C: "integridade", D: "visao" },
};

export const ITENS_ELEMENTOS: Record<Elemento, string> = {
  desenvolvimento_intelectual: "q7",
  saude_energia: "q8",
  equilibrio_emocional: "q9",
  recursos_financeiros: "q10",
  contribuicao_social: "q11",
  realizacao_proposito: "q12",
  hobbies_diversao: "q13",
};

// Piso operacional PROVISORIO: minimo de elementos respondidos (de 7) para a
// leitura parcial dos Elementos da Vida Plena. NAO e um limiar validado
// cientificamente: e uma regra operacional que pode ser recalibrada aqui, em
// um unico lugar. Abaixo dele o status e "insuficiente".
export const MINIMO_ELEMENTOS_ANALISE_PARCIAL = 5;

// Margem minima (em pontos de contagem, de 6 situacionais) entre o 1o e o 2o
// eixo para existir eixo destacado. Com margem 1 (ex.: 3-2-1-0) uma unica
// resposta alteraria o resultado, entao nao ha destaque.
export const MARGEM_MINIMA_SITUACIONAL = 2;

// Margem minima, em pontos BRUTOS do Likert (soma de 6 itens de 1 a 5, faixa 6
// a 30), entre o 1o e o 2o eixo para existir eixo destacado. Valor provisorio
// APROVADO: 2 pontos brutos, o mesmo criterio da situacional. Deve ser
// recalibrado com as margens reais coletadas no primeiro piloto do Marco Zero.
// Nao afirmamos que 2 pontos brutos representem diferenca psicologicamente
// significativa: e heuristica operacional provisoria.
// A decisao de destaque e tomada sobre as somas brutas inteiras, nunca sobre o
// valor normalizado 0 a 100 (arredondado), que existe so para exibicao.
export const MARGEM_MINIMA_LIKERT_BRUTA = 2;

export type StatusDestaque =
  | "destacado"
  | "empate"
  | "margem_insuficiente"
  | "incompleto";

// As situacionais sao escolhas declaradas sobre hipoteses, ou seja, outro
// autorrelato: nao descrevem comportamento observado.
export type AnaliseSituacional = {
  contagens: Record<Eixo, number>;
  eixoDestacado: Eixo | null;
  margem: number; // contagem do 1o menos contagem do 2o
  status: StatusDestaque;
};

// Mesmo desenho para o Likert. Exige os 24 itens respondidos: so entao a soma
// bruta e confiavel (item ausente conta 0 na soma) e pode haver destaque.
export type AnaliseLikert = {
  pontuacoesBrutas: Record<Eixo, number>; // soma de 6 a 30; base da decisao
  pontuacoes0a100: Record<Eixo, number>; // so para exibicao
  eixoDestacado: Eixo | null;
  margem: number; // 1o menos 2o, em pontos BRUTOS
  status: StatusDestaque;
};

export type RelacaoEntreAutorrelatos =
  | "convergencia"
  | "contraste"
  | "inconclusivo";

export type PontuacaoElemento = {
  valor: number | null; // null = nao respondido (nunca 0)
  status: "respondido" | "incompleto";
};

export type AnaliseElementos = {
  elementosRespondidos: number;
  status: "completo" | "parcial" | "insuficiente";
  // So existe com os 7 respondidos e menor valor unico. Nunca decidido pela
  // ordem do array.
  elementoDeMenorPontuacao: string | null;
};

// Elemento de maior pontuacao. E a maior nota AUTORRELATADA entre os sete, nao
// necessariamente a maior forca real da pessoa: qualquer texto deve dizer algo
// como "entre os sete elementos avaliados, aquele ao qual voce atribuiu a maior
// pontuacao", e so quando status === "apresentavel".
//   apresentavel     7 de 7 respondidos e maior valor unico.
//   somente_interno  5 ou 6 respondidos: `elemento` e o maior entre os
//                    respondidos, so para uso interno; NAO apresentar.
//   empate           empate no topo: `elemento` e null (valores seguem em
//                    `elementos`).
//   indisponivel     menos de 5 respondidos: nenhuma interpretacao comparativa.
export type ElementoDeMaiorPontuacao = {
  elemento: Elemento | null;
  status: "apresentavel" | "somente_interno" | "empate" | "indisponivel";
};

export interface MarcoZeroScores {
  eixos: Record<
    Eixo,
    { likertBruto: number; likert0a100: number; situacional: number }
  >;
  analiseLikert: AnaliseLikert;
  analiseSituacional: AnaliseSituacional;
  relacaoEntreAutorrelatos: RelacaoEntreAutorrelatos;
  elementos: Record<Elemento, PontuacaoElemento>;
  // Media apenas dos respondidos; `denominador` e quantos entraram na conta.
  elementosMedia: { valor: number | null; denominador: number };
  elementoDeMaiorPontuacao: ElementoDeMaiorPontuacao;
  analiseElementos: AnaliseElementos;
  incompleto: string[]; // ids das perguntas que faltaram
}

const LIKERT_MIN = 1;
const LIKERT_MAX = 5;
const ITENS_POR_EIXO = 6;
const SOMA_MIN = ITENS_POR_EIXO * LIKERT_MIN; // 6
const SOMA_MAX = ITENS_POR_EIXO * LIKERT_MAX; // 30

// Aceita numero ou string numerica ("4"), pois respostas vindas de formulario
// ou JSON podem chegar em qualquer um dos dois formatos.
function paraInteiro(valor: Resposta | undefined): number | null {
  if (typeof valor === "number") {
    return Number.isInteger(valor) ? valor : null;
  }
  if (typeof valor === "string" && /^\s*-?\d+\s*$/.test(valor)) {
    return Number.parseInt(valor, 10);
  }
  return null;
}

function lerLikert(valor: Resposta | undefined): number | null {
  const n = paraInteiro(valor);
  return n !== null && n >= LIKERT_MIN && n <= LIKERT_MAX ? n : null;
}

function lerElemento(valor: Resposta | undefined): number | null {
  const n = paraInteiro(valor);
  return n !== null && n >= 0 && n <= 10 ? n : null;
}

function lerAlternativa(valor: Resposta | undefined): Alternativa | null {
  if (typeof valor !== "string") return null;
  const v = valor.trim().toUpperCase();
  return v === "A" || v === "B" || v === "C" || v === "D" ? v : null;
}

function normalizar0a100(soma: number): number {
  const valor = Math.round(((soma - SOMA_MIN) / (SOMA_MAX - SOMA_MIN)) * 100);
  // Itens ausentes contam 0 na soma e poderiam levar a valor negativo.
  return Math.min(100, Math.max(0, valor));
}

// Destaque entre eixos: compara o 1o e o 2o maiores valores. Empate no topo
// NUNCA e resolvido pela ordem de EIXOS: vira status "empate" sem vencedor.
function analisarDestaque(
  valores: Record<Eixo, number>,
  margemMinima: number,
  completo: boolean,
): { eixoDestacado: Eixo | null; margem: number; status: StatusDestaque } {
  const ordenados = [...EIXOS].sort((x, y) => valores[y] - valores[x]);
  const margem = valores[ordenados[0]] - valores[ordenados[1]];
  let status: StatusDestaque;
  if (!completo) status = "incompleto";
  else if (margem === 0) status = "empate";
  else if (margem < margemMinima) status = "margem_insuficiente";
  else status = "destacado";
  return {
    eixoDestacado: status === "destacado" ? ordenados[0] : null,
    margem,
    status,
  };
}

function relacionar(
  likert: AnaliseLikert,
  situacional: AnaliseSituacional,
): RelacaoEntreAutorrelatos {
  if (likert.eixoDestacado === null || situacional.eixoDestacado === null) {
    return "inconclusivo";
  }
  return likert.eixoDestacado === situacional.eixoDestacado
    ? "convergencia"
    : "contraste";
}

// Menor/maior valor unico entre os pares recebidos; empate => null.
function extremoUnico(
  pares: [Elemento, number][],
  sentido: "menor" | "maior",
): Elemento | null {
  if (pares.length === 0) return null;
  const valores = pares.map(([, v]) => v);
  const alvo = sentido === "menor" ? Math.min(...valores) : Math.max(...valores);
  const candidatos = pares.filter(([, v]) => v === alvo);
  return candidatos.length === 1 ? candidatos[0][0] : null;
}

export function calcularMarcoZero(
  respostas: RespostasAchatadas,
): MarcoZeroScores {
  const incompleto: string[] = [];

  let likertCompleto = true;
  const eixos = {} as MarcoZeroScores["eixos"];
  for (const eixo of EIXOS) {
    let soma = 0;
    for (const id of ITENS_LIKERT[eixo]) {
      const valor = lerLikert(respostas[id]);
      if (valor === null) {
        incompleto.push(id);
        likertCompleto = false;
      } else soma += valor;
    }
    eixos[eixo] = {
      likertBruto: soma,
      likert0a100: normalizar0a100(soma),
      situacional: 0,
    };
  }

  let situacionaisRespondidas = 0;
  for (const id of SITUACIONAIS) {
    const alt = lerAlternativa(respostas[id]);
    if (alt === null) incompleto.push(id);
    else {
      eixos[MAPA_SITUACIONAL[id][alt]].situacional += 1;
      situacionaisRespondidas += 1;
    }
  }

  const pontuacoesBrutas = {} as Record<Eixo, number>;
  const pontuacoes0a100 = {} as Record<Eixo, number>;
  const contagens = {} as Record<Eixo, number>;
  for (const eixo of EIXOS) {
    pontuacoesBrutas[eixo] = eixos[eixo].likertBruto;
    pontuacoes0a100[eixo] = eixos[eixo].likert0a100;
    contagens[eixo] = eixos[eixo].situacional;
  }

  const analiseLikert: AnaliseLikert = {
    pontuacoesBrutas,
    pontuacoes0a100,
    // Destaque sobre o bruto inteiro e so com os 24 itens respondidos; com item
    // ausente a soma bruta (que o conta como 0) nao e usada para decidir nada.
    ...analisarDestaque(
      pontuacoesBrutas,
      MARGEM_MINIMA_LIKERT_BRUTA,
      likertCompleto,
    ),
  };
  const analiseSituacional: AnaliseSituacional = {
    contagens,
    ...analisarDestaque(
      contagens,
      MARGEM_MINIMA_SITUACIONAL,
      situacionaisRespondidas === SITUACIONAIS.length,
    ),
  };

  // Elementos: resposta ausente e null, nunca 0, e nao entra em media nem
  // ranking.
  const elementos = {} as Record<Elemento, PontuacaoElemento>;
  const respondidos: [Elemento, number][] = [];
  let somaElementos = 0;
  for (const elemento of ELEMENTOS) {
    const id = ITENS_ELEMENTOS[elemento];
    const valor = lerElemento(respostas[id]);
    if (valor === null) {
      incompleto.push(id);
      elementos[elemento] = { valor: null, status: "incompleto" };
    } else {
      elementos[elemento] = { valor, status: "respondido" };
      respondidos.push([elemento, valor]);
      somaElementos += valor;
    }
  }

  const elementosRespondidos = respondidos.length;
  const elementosMedia = {
    valor:
      elementosRespondidos > 0
        ? Math.round((somaElementos / elementosRespondidos) * 10) / 10
        : null,
    denominador: elementosRespondidos,
  };

  let statusElementos: AnaliseElementos["status"];
  if (elementosRespondidos === ELEMENTOS.length) statusElementos = "completo";
  else if (elementosRespondidos >= MINIMO_ELEMENTOS_ANALISE_PARCIAL) {
    statusElementos = "parcial";
  } else statusElementos = "insuficiente";

  // Identificar o menor entre os sete exige os sete respondidos.
  const elementoDeMenorPontuacao =
    statusElementos === "completo" ? extremoUnico(respondidos, "menor") : null;

  // Maior pontuacao: calculada entre os respondidos so com >= piso; apresentavel
  // apenas com os 7 respondidos. Empate no topo nunca e decidido pela ordem.
  const maior =
    statusElementos === "insuficiente"
      ? null
      : extremoUnico(respondidos, "maior");
  let statusMaior: ElementoDeMaiorPontuacao["status"];
  if (statusElementos === "insuficiente") statusMaior = "indisponivel";
  else if (maior === null) statusMaior = "empate";
  else if (statusElementos === "completo") statusMaior = "apresentavel";
  else statusMaior = "somente_interno";
  const elementoDeMaiorPontuacao: ElementoDeMaiorPontuacao = {
    elemento: maior,
    status: statusMaior,
  };

  return {
    eixos,
    analiseLikert,
    analiseSituacional,
    relacaoEntreAutorrelatos: relacionar(analiseLikert, analiseSituacional),
    elementos,
    elementosMedia,
    elementoDeMaiorPontuacao,
    analiseElementos: {
      elementosRespondidos,
      status: statusElementos,
      elementoDeMenorPontuacao,
    },
    incompleto,
  };
}
