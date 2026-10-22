// Validacao de SAIDA do one-pager: todo texto destinado ao participante passa
// por aqui antes de virar documento. Mesma mecanica de
// lib/scoring/briefing-marco-zero.ts (lista de expressoes vetadas + chaves
// vazadas + lancar em vez de entregar), acrescida das regras do catalogo
// fechado de dimensoes:
//   1. nenhuma dimensao pode ser nomeada fora dos quatro rotulos aprovados
//      (nem um quinto nome, nem variacao/abreviacao de um dos quatro);
//   2. nenhuma dimensao pode virar tipo de personalidade ("seu perfil e ...").
// Vale para o texto que a nossa camada monta e para qualquer texto que um
// modelo venha a gerar: a regra e do codigo, nao de uma instrucao de prompt.
//
// Funcao pura: sem I/O, sem data/hora.

import { ELEMENTOS } from "../../../lib/scoring/marco-zero";
import {
  ROTULOS_ELEMENTOS_PADRAO,
  encontrarChavesVazadas,
  encontrarExpressoesVetadas,
  type ExpressaoVetada,
} from "../../../lib/scoring/briefing-marco-zero";
import { CATALOGO_DIMENSOES, ROTULOS_DIMENSAO } from "./catalogo-dimensoes";

export type { ExpressaoVetada };

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Radicais que, fora dos rotulos e das definicoes aprovados, indicam que uma
// dimensao esta sendo nomeada de outro jeito (renomeada, abreviada, variada).
const RADICAIS_DE_DIMENSAO =
  /\b(visao|direcao|execucao|consistencia|relacionamento|colaboracao|integridade|responsabilidade)\b/;

const ALVO_DE_IDENTIDADE =
  "(visao|direcao|execucao|consistencia|relacionamento|colaboracao|integridade|responsabilidade)";

/** Expressoes vetadas especificas do catalogo de dimensoes (sobre texto normalizado). */
export const EXPRESSOES_VETADAS_DIMENSOES: readonly ExpressaoVetada[] = [
  {
    id: "dimensao_como_tipo",
    padrao:
      /\b(perfil|perfis|arquetipo|arquetipos|personalidade|tipologia)\b|\btipo\s+de\s+(pessoa|personalidade|lider|perfil)\b|\bdo\s+tipo\b/,
    motivo: "trata dimensao como tipo de personalidade",
  },
  {
    id: "identidade_pela_dimensao",
    padrao: new RegExp(
      `\\bvoce\\s+(e|sera|pertence)\\s+(um|uma|do|da|de|ao|a|o)?\\s*[“"]?\\s*${ALVO_DE_IDENTIDADE}`,
    ),
    motivo: "afirma que a pessoa E uma dimensao",
  },
  {
    id: "dimensao_principal",
    padrao: /\b(dimensao|eixo)\s+(principal|dominante|predominante|unica)\b/,
    motivo: "elege uma dimensao como a da pessoa",
  },
];

export type MotivoDeRecusa =
  | "nome_fora_do_catalogo"
  | "variacao_de_rotulo"
  | "nome_proprio_apos_dimensao"
  | string; // ids de expressoes vetadas / chaves vazadas

export interface RecusaDeSaida {
  motivo: MotivoDeRecusa;
  detalhe: string;
}

const NOMES_DE_ELEMENTO: readonly string[] = ELEMENTOS.map(
  (el) => ROTULOS_ELEMENTOS_PADRAO[el],
);
const APROVADOS_ENTRE_ASPAS: ReadonlySet<string> = new Set([
  ...ROTULOS_DIMENSAO,
  ...NOMES_DE_ELEMENTO,
]);
const DEFINICOES_APROVADAS: readonly string[] = Object.values(
  CATALOGO_DIMENSOES.dimensoes,
).map((d) => d.definicao);

// Remove, do texto, as strings aprovadas (rotulos e definicoes), mais longas
// primeiro, para sobrar so o que seria um nome "novo".
function semAprovados(texto: string): string {
  let t = texto;
  for (const a of [...DEFINICOES_APROVADAS, ...ROTULOS_DIMENSAO].sort(
    (x, y) => y.length - x.length,
  )) {
    t = t.split(a).join(" ");
  }
  return t;
}

/**
 * Valida UM texto de saida. Devolve as recusas (vazio = pode sair). Combina:
 * expressoes vetadas e chaves vazadas da camada de briefing; as vetadas do
 * catalogo; e a regra do catalogo fechado.
 */
export function validarTextoDeSaida(texto: string): RecusaDeSaida[] {
  const recusas: RecusaDeSaida[] = [];

  for (const id of encontrarExpressoesVetadas(texto)) {
    recusas.push({ motivo: id, detalhe: texto });
  }
  for (const k of encontrarChavesVazadas(texto, [
    ...ROTULOS_DIMENSAO,
    ...NOMES_DE_ELEMENTO,
  ])) {
    recusas.push({ motivo: "chave_vazada", detalhe: k });
  }

  const norm = normalizar(texto);
  for (const e of EXPRESSOES_VETADAS_DIMENSOES) {
    if (e.padrao.test(norm)) recusas.push({ motivo: e.id, detalhe: texto });
  }

  // 1. Nome entre aspas que nao e dimensao nem elemento aprovado.
  for (const m of texto.matchAll(/[“"]([^”"]+)[”"]/g)) {
    if (!APROVADOS_ENTRE_ASPAS.has(m[1])) {
      recusas.push({ motivo: "nome_fora_do_catalogo", detalhe: m[1] });
    }
  }

  // 2. Variacao ou abreviacao de rotulo: radical de dimensao solto.
  const resto = semAprovados(texto);
  const solto = RADICAIS_DE_DIMENSAO.exec(normalizar(resto));
  if (solto) recusas.push({ motivo: "variacao_de_rotulo", detalhe: solto[0] });

  // 3. "dimensao"/"eixo" seguido de nome proprio (inicial maiuscula).
  for (const m of resto.matchAll(
    /\b(?:[Dd]imens(?:ão|ões)|[Ee]ixos?)\s+(?:(?:de|da|do|das|dos)\s+)?([A-ZÀ-Ú][\p{L}]+)/gu,
  )) {
    recusas.push({ motivo: "nome_proprio_apos_dimensao", detalhe: m[0] });
  }

  return recusas;
}

/** Valida uma lista de textos; devolve so os que tem recusa. */
export function validarTextosDeSaida(
  textos: readonly string[],
): { texto: string; recusas: RecusaDeSaida[] }[] {
  const saida: { texto: string; recusas: RecusaDeSaida[] }[] = [];
  for (const texto of textos) {
    const recusas = validarTextoDeSaida(texto);
    if (recusas.length > 0) saida.push({ texto, recusas });
  }
  return saida;
}

/** Lanca se algum texto for recusado: o documento nao e produzido. */
export function exigirTextosDeSaidaValidos(textos: readonly string[]): void {
  const achados = validarTextosDeSaida(textos);
  if (achados.length > 0) {
    const a = achados[0];
    throw new Error(
      `Texto do one-pager recusado pela validacao de saida (${a.recusas
        .map((r) => r.motivo)
        .join(", ")}): ${a.texto}`,
    );
  }
}
