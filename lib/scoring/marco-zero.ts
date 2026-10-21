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

export interface MarcoZeroScores {
  eixos: Record<
    Eixo,
    { likertBruto: number; likert0a100: number; situacional: number }
  >;
  perfilDeclarado: Eixo; // eixo com maior likert0a100
  perfilDominante: Eixo; // eixo com maior contagem situacional
  divergencia: boolean; // perfilDeclarado !== perfilDominante
  elementos: Record<Elemento, number>;
  elementosMedia: number;
  elementoMaisBaixo: Elemento;
  elementoMaisAlto: Elemento;
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

// Escolhe o eixo vencedor: maximiza `primario`; no empate usa `secundario`;
// persistindo, vale a ordem fixa de EIXOS (visao > execucao > relacao >
// integridade). A ordem fixa existe so para o resultado ser reprodutivel: o
// mesmo input sempre gera o mesmo perfil, sem depender de ordem de iteracao.
function escolherEixo(
  primario: Record<Eixo, number>,
  secundario: Record<Eixo, number>,
): Eixo {
  let vencedor: Eixo = EIXOS[0];
  for (const eixo of EIXOS) {
    if (primario[eixo] > primario[vencedor]) {
      vencedor = eixo;
    } else if (
      primario[eixo] === primario[vencedor] &&
      secundario[eixo] > secundario[vencedor]
    ) {
      vencedor = eixo;
    }
  }
  return vencedor;
}

export function calcularMarcoZero(
  respostas: RespostasAchatadas,
): MarcoZeroScores {
  const incompleto: string[] = [];

  const eixos = {} as MarcoZeroScores["eixos"];
  for (const eixo of EIXOS) {
    let soma = 0;
    for (const id of ITENS_LIKERT[eixo]) {
      const valor = lerLikert(respostas[id]);
      if (valor === null) incompleto.push(id);
      else soma += valor;
    }
    eixos[eixo] = {
      likertBruto: soma,
      likert0a100: normalizar0a100(soma),
      situacional: 0,
    };
  }

  for (const id of SITUACIONAIS) {
    const alt = lerAlternativa(respostas[id]);
    if (alt === null) incompleto.push(id);
    else eixos[MAPA_SITUACIONAL[id][alt]].situacional += 1;
  }

  const likert = {} as Record<Eixo, number>;
  const situacional = {} as Record<Eixo, number>;
  for (const eixo of EIXOS) {
    likert[eixo] = eixos[eixo].likert0a100;
    situacional[eixo] = eixos[eixo].situacional;
  }

  const perfilDeclarado = escolherEixo(likert, situacional);
  const perfilDominante = escolherEixo(situacional, likert);

  const elementos = {} as Record<Elemento, number>;
  for (const elemento of ELEMENTOS) {
    const id = ITENS_ELEMENTOS[elemento];
    const valor = lerElemento(respostas[id]);
    if (valor === null) incompleto.push(id);
    elementos[elemento] = valor ?? 0;
  }

  let elementoMaisBaixo: Elemento = ELEMENTOS[0];
  let elementoMaisAlto: Elemento = ELEMENTOS[0];
  let totalElementos = 0;
  for (const elemento of ELEMENTOS) {
    totalElementos += elementos[elemento];
    if (elementos[elemento] < elementos[elementoMaisBaixo]) {
      elementoMaisBaixo = elemento;
    }
    if (elementos[elemento] > elementos[elementoMaisAlto]) {
      elementoMaisAlto = elemento;
    }
  }
  const elementosMedia =
    Math.round((totalElementos / ELEMENTOS.length) * 10) / 10;

  return {
    eixos,
    perfilDeclarado,
    perfilDominante,
    divergencia: perfilDeclarado !== perfilDominante,
    elementos,
    elementosMedia,
    elementoMaisBaixo,
    elementoMaisAlto,
    incompleto,
  };
}
