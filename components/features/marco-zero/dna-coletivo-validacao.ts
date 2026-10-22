// Validacao de SAIDA do DNA Coletivo. Reaproveita por inteiro o varredor do
// one-pager (catalogo fechado, expressoes vetadas, chaves vazadas) e acrescenta
// o que so existe no texto coletivo:
//   - afirmacao universal ("todos", "ninguem", "sempre", "em geral");
//   - o grupo/sala como sujeito de verbo ("a sala valoriza ...");
//   - quantificador sobre o conjunto ("maioria das pessoas", "metade do grupo")
//     em vez de "dos respondentes";
//   - qualquer reivindicacao de representatividade;
//   - identificacao de participante (nome ou id) no texto.
// Funcao pura. A regra e do codigo: ela vale para o texto que montamos e para
// qualquer texto que um modelo venha a escrever.

import {
  validarTextoDeSaida,
  type RecusaDeSaida,
} from "./validacao-saida";

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface ExpressaoVetadaColetiva {
  id: string;
  /** Aplicada sobre o texto normalizado (minusculo, sem acento). */
  padrao: RegExp;
  motivo: string;
}

const SUJEITO_COLETIVO =
  "(grupo|turma|sala|coletivo|equipe|time|comunidade|plateia|publico)";
const VERBO_DO_COLETIVO =
  "(e|eh|sao|esta|estao|tem|possui|apresenta|mostra|prefere|valoriza|busca|precisa|quer|age|demonstra|revela|indica|reflete|escolhe|pensa|sente|deseja|tende|tendem|costuma|costumam|privilegia|favorece|concentra|predomina|se\\s+\\w+)";

export const EXPRESSOES_VETADAS_COLETIVAS: readonly ExpressaoVetadaColetiva[] = [
  {
    id: "afirmacao_universal",
    padrao:
      /\b(todos|todas|todo\s+o|toda\s+a|ninguem|nenhum|nenhuma|sempre|nunca|unanim\w*|invariavelmente|em\s+geral|de\s+modo\s+geral|de\s+forma\s+geral|geralmente|tipicamente|naturalmente)\b/,
    motivo: "afirmacao universal sobre o conjunto de pessoas",
  },
  {
    id: "coletivo_como_sujeito",
    padrao: new RegExp(
      `\\b(o|a|este|esta|esse|essa|nosso|nossa|do|da)\\s+${SUJEITO_COLETIVO}\\s+${VERBO_DO_COLETIVO}\\b`,
    ),
    motivo: "atribui caracteristica ao grupo/sala como se fosse uma pessoa",
  },
  {
    id: "quantificador_sobre_o_conjunto",
    padrao:
      /\b(maioria|minoria|metade|maior\s+parte|menor\s+parte|boa\s+parte|grande\s+parte|parte\s+significativa|quase\s+todos?)\s+(do|da|dos|das|de)\s+(grupo|sala|turma|pessoas|participantes|presentes|convidados|publico)\b/,
    motivo: "quantifica o conjunto inteiro em vez dos respondentes",
  },
  {
    id: "representatividade",
    padrao:
      /\brepresentativ\w*|\bretrato\s+(fiel|do\s+grupo|da\s+sala|da\s+turma)\b|\bperfil\s+(do|da)\s+(grupo|sala|turma)\b|\brepresenta(m)?\s+(o|a|os|as)\s+(grupo|sala|turma)\b/,
    motivo: "reivindica representatividade ou retrato do grupo",
  },
  {
    id: "inferencia_sobre_nao_respondentes",
    padrao:
      /\bquem\s+nao\s+respondeu\s+(e|eh|tem|pensa|sente|se\s+descreve|se\s+descreveria\s+como|prefere)\b|\bos\s+(ausentes|faltantes)\s+(sao|tem|pensam)\b/,
    motivo: "afirma algo sobre quem nao respondeu",
  },
];

/** Recusa extra do coletivo, alem das do one-pager. */
export type RecusaColetiva = RecusaDeSaida;

/**
 * Valida UM texto do documento coletivo. `aprovados` sao fragmentos de redacao
 * fixa e ja revisada que podem conter palavras que o varredor, em outro
 * contexto, recusaria (hoje: nenhum; o parametro existe para a revisao poder
 * acrescentar um sem afrouxar a regra).
 */
export function validarTextoColetivo(
  texto: string,
  aprovados: readonly string[] = [],
): RecusaColetiva[] {
  const recusas: RecusaColetiva[] = [...validarTextoDeSaida(texto)];
  let t = texto;
  for (const a of [...aprovados].sort((x, y) => y.length - x.length)) {
    t = t.split(a).join(" ");
  }
  const norm = normalizar(t);
  for (const e of EXPRESSOES_VETADAS_COLETIVAS) {
    if (e.padrao.test(norm)) recusas.push({ motivo: e.id, detalhe: texto });
  }
  return recusas;
}

/** Identificadores (nome completo, id) que nao podem aparecer no texto. */
export function encontrarIdentificacao(
  texto: string,
  identificadores: readonly string[],
): string[] {
  const norm = normalizar(texto);
  const achados: string[] = [];
  for (const raw of identificadores) {
    const id = normalizar(raw.trim());
    if (id.length >= 3 && norm.includes(id)) achados.push(raw);
  }
  return achados;
}

export function validarTextosColetivos(
  textos: readonly string[],
  aprovados: readonly string[] = [],
): { texto: string; recusas: RecusaColetiva[] }[] {
  const saida: { texto: string; recusas: RecusaColetiva[] }[] = [];
  for (const texto of textos) {
    const recusas = validarTextoColetivo(texto, aprovados);
    if (recusas.length > 0) saida.push({ texto, recusas });
  }
  return saida;
}

/** Lanca se algum texto for recusado: o documento nao e produzido. */
export function exigirTextosColetivosValidos(
  textos: readonly string[],
  identificadores: readonly string[] = [],
  aprovados: readonly string[] = [],
): void {
  const achados = validarTextosColetivos(textos, aprovados);
  if (achados.length > 0) {
    const a = achados[0];
    throw new Error(
      `Texto do DNA Coletivo recusado pela validacao de saida (${a.recusas
        .map((r) => r.motivo)
        .join(", ")}): ${a.texto}`,
    );
  }
  for (const t of textos) {
    const ids = encontrarIdentificacao(t, identificadores);
    if (ids.length > 0) {
      throw new Error(
        `Texto do DNA Coletivo recusado pela validacao de saida (identificacao_de_participante): ${t}`,
      );
    }
  }
}
