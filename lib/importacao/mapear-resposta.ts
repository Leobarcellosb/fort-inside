// CORRESPONDENCIA DE UMA RESPOSTA EXTERNA COM A PERGUNTA CANONICA.
//
// A REGRA QUE ESTE ARQUIVO EXISTE PARA CUMPRIR, nas palavras do responsavel
// tecnico: "Se uma palavra for alterada e a correspondencia falhar, o
// processamento deve registrar DADO INCOMPATIVEL, NUNCA pontuacao zero."
//
// O ACIDENTE QUE JA ACONTECEU NESTE PROJETO, e que esta regra impede de repetir:
// a interface gravava o TEXTO da opcao escolhida e o motor de pontuacao aceitava
// so a letra isolada ("A".."D"). As 6 situacionais voltavam `null`, o motor as
// listava como NAO RESPONDIDAS, e um instrumento situacional inteiro foi de 73%
// de cobertura a ZERO. Ninguem viu, porque zero parece um resultado.
//
// Daqui saem TRES ESTADOS, e eles nao se confundem:
//
//   compativel    a resposta corresponde a alternativa/escala declarada e tem
//                 valor canonico que o motor (lib/scoring/marco-zero.ts) aceita;
//   incompativel  a pessoa RESPONDEU e a correspondencia FALHOU. E dado, nao
//                 ausencia; e falha, nao zero. Carrega o valor bruto e o motivo.
//                 Nunca entra na pontuacao e nunca e convertido em 0;
//   ausente       a pessoa NAO respondeu. O motor ja sabe tratar ausencia (lista
//                 em `incompleto`, nunca soma 0 no lugar).
//
// "incompativel" e "ausente" NAO podem colapsar um no outro. Se colapsarem, o
// defeito volta: uma alternativa reescrita viraria "nao respondeu", e um
// instrumento sumiria em silencio outra vez.
//
// O QUE E PERMITIDO NORMALIZAR, e o que NAO e
// -------------------------------------------
// PERMITIDO: aparar espaco em branco nas pontas; ler um inteiro que veio como
// texto ("4"), porque exportacao de formulario em CSV entrega tudo como texto;
// aceitar a LETRA isolada de uma situacional, porque a letra e identificador
// exato da alternativa (e a impressao digital do manifesto ja garantiu que o
// texto por tras dela e o mesmo).
//
// NAO PERMITIDO, em nenhuma hipotese: comparar sem diferenciar maiuscula de
// minuscula, ignorar acento, ignorar pontuacao, casar por prefixo, casar por
// "contem", casar pela alternativa mais parecida, ou escolher a unica
// alternativa que sobrou. Tudo isso e adivinhar qual alternativa a pessoa quis
// dizer. Uma palavra trocada NAO casa, e e exatamente isso que tem de aparecer.
//
// Funcoes puras: sem I/O, sem data/hora, sem aleatoriedade.

import {
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  EIXOS,
  ELEMENTOS,
  MAPA_SITUACIONAL,
  SITUACIONAIS,
  type Alternativa,
} from "../scoring/marco-zero";
import type { ManifestoQuestionario, PerguntaCanonica } from "./manifesto-questionario";

export type EstadoDoItem = "compativel" | "incompativel" | "ausente";

/** Como a alternativa foi reconhecida. Vai para a proveniencia, nao decide nada. */
export type FormaDeCorrespondencia = "texto_exato" | "letra" | "inteiro";

export type ItemMapeado =
  | {
      pergunta_id: string;
      estado: "compativel";
      /** Valor no formato que `calcularMarcoZero` consome. */
      valor: string | number | string[];
      bruto: unknown;
      forma: FormaDeCorrespondencia;
    }
  | {
      pergunta_id: string;
      estado: "incompativel";
      bruto: unknown;
      /** Por que a correspondencia falhou, em texto que um operador entende. */
      motivo: string;
      /** Classe da falha, para contar e filtrar sem interpretar texto. */
      causa: CausaDeIncompatibilidade;
      /** Pontuada pelo motor? Uma situacional incompativel apaga meio instrumento. */
      pontuada: boolean;
    }
  | {
      pergunta_id: string;
      estado: "ausente";
      pontuada: boolean;
    };

export type CausaDeIncompatibilidade =
  /** Alternativa que nao e NENHUMA das declaradas no manifesto. */
  | "alternativa_desconhecida"
  /** Alternativa reconhecida, mas a letra nao pertence ao mapa do motor. */
  | "alternativa_fora_do_mapa"
  /** Escala: nao e inteiro, ou esta fora da faixa declarada. */
  | "fora_da_escala"
  /** Texto mais longo que o limite declarado no manifesto. */
  | "acima_do_limite_de_caracteres"
  /** Tipo de valor que a pergunta nao aceita (ex.: lista onde se espera texto). */
  | "tipo_invalido"
  /** A resposta veio para uma pergunta que nao existe no manifesto. */
  | "pergunta_desconhecida";

/** Ids que o motor de pontuacao realmente consome. Fonte unica: lib/scoring. */
export const IDS_LIKERT: ReadonlySet<string> = new Set(
  EIXOS.flatMap((eixo) => ITENS_LIKERT[eixo]),
);
export const IDS_ELEMENTOS: ReadonlySet<string> = new Set(
  ELEMENTOS.map((e) => ITENS_ELEMENTOS[e]),
);
export const IDS_SITUACIONAIS: ReadonlySet<string> = new Set(SITUACIONAIS);

/** `true` se o motor pontua esta pergunta. Falha nela e perda de instrumento. */
export function ehPontuada(perguntaId: string): boolean {
  return (
    IDS_SITUACIONAIS.has(perguntaId) ||
    IDS_LIKERT.has(perguntaId) ||
    IDS_ELEMENTOS.has(perguntaId)
  );
}

function ehSituacional(id: string): id is (typeof SITUACIONAIS)[number] {
  return IDS_SITUACIONAIS.has(id);
}

/**
 * A letra declarada no inicio de uma alternativa do manifesto ("A. ..." -> "A").
 * Nao adivinha: a alternativa precisa comecar com letra de A a D, ponto e
 * espaco, e ter texto depois.
 */
export function letraDeclarada(opcao: string): Alternativa | null {
  const m = /^([A-D])\.\s+\S/.exec(opcao);
  return m ? (m[1] as Alternativa) : null;
}

function inteiroEstrito(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isInteger(valor) ? valor : null;
  // Exportacao de formulario entrega numero como texto. Ler "4" nao e adivinhar.
  if (typeof valor === "string" && /^\s*-?\d+\s*$/.test(valor)) {
    return Number.parseInt(valor.trim(), 10);
  }
  return null;
}

function descrever(valor: unknown): string {
  let t: string;
  try {
    t = JSON.stringify(valor) ?? String(valor);
  } catch {
    t = String(valor);
  }
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** Ausencia de resposta: chave faltando, nulo, ou texto so com espaco. */
export function ehAusente(valor: unknown): boolean {
  if (valor === undefined || valor === null) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

function incompativel(
  pergunta_id: string,
  bruto: unknown,
  causa: CausaDeIncompatibilidade,
  motivo: string,
): ItemMapeado {
  return {
    pergunta_id,
    estado: "incompativel",
    bruto,
    causa,
    motivo,
    pontuada: ehPontuada(pergunta_id),
  };
}

/**
 * Mapeia UMA resposta externa para a forma canonica, segundo a pergunta
 * canonica do manifesto.
 *
 * Nunca lanca e nunca devolve `null` ambiguo: devolve sempre um dos tres
 * estados.
 */
export function mapearResposta(
  pergunta: PerguntaCanonica,
  bruto: unknown,
): ItemMapeado {
  const id = pergunta.id;

  if (ehAusente(bruto)) {
    return { pergunta_id: id, estado: "ausente", pontuada: ehPontuada(id) };
  }

  // --- ALTERNATIVAS (select) ------------------------------------------------
  if (pergunta.type === "select") {
    if (typeof bruto !== "string") {
      return incompativel(
        id,
        bruto,
        "tipo_invalido",
        `esperada UMA alternativa em texto; veio ${typeof bruto === "object" ? "estrutura" : typeof bruto}`,
      );
    }
    const opcoes = pergunta.options;
    if (opcoes === null || opcoes.length === 0) {
      return incompativel(
        id,
        bruto,
        "pergunta_desconhecida",
        "a pergunta e de alternativa mas o manifesto nao declara nenhuma alternativa",
      );
    }

    const texto = bruto.trim();

    // 1) Correspondencia EXATA com o texto da alternativa (so trim).
    const exata = opcoes.findIndex((o) => o.trim() === texto);
    if (exata >= 0) {
      return resolverAlternativa(pergunta, opcoes[exata], bruto, "texto_exato");
    }

    // 2) A LETRA isolada, conferida contra as alternativas declaradas. Nao e
    //    adivinhar: a letra identifica a alternativa, e a impressao digital do
    //    manifesto ja garantiu que o texto por tras dela e o mesmo.
    if (/^[A-Da-d]$/.test(texto)) {
      const letra = texto.toUpperCase() as Alternativa;
      const porLetra = opcoes.find((o) => letraDeclarada(o) === letra);
      if (porLetra !== undefined) {
        return resolverAlternativa(pergunta, porLetra, bruto, "letra");
      }
      return incompativel(
        id,
        bruto,
        "alternativa_desconhecida",
        `a letra "${letra}" nao corresponde a nenhuma alternativa declarada desta pergunta`,
      );
    }

    // 3) Nao casou. NAO se procura a alternativa mais parecida.
    return incompativel(
      id,
      bruto,
      "alternativa_desconhecida",
      `a alternativa respondida nao e NENHUMA das ${opcoes.length} declaradas (nao se adivinha a mais parecida). Recebido: ${descrever(bruto)}`,
    );
  }

  // --- ESCALAS (scale) ------------------------------------------------------
  if (pergunta.type === "scale") {
    const n = inteiroEstrito(bruto);
    if (n === null) {
      return incompativel(
        id,
        bruto,
        "fora_da_escala",
        `esperado um inteiro da escala declarada; o valor nao e inteiro: ${descrever(bruto)}`,
      );
    }
    const min = pergunta.min;
    const max = pergunta.max;
    if (min === null || max === null) {
      return incompativel(
        id,
        bruto,
        "pergunta_desconhecida",
        "a pergunta e de escala mas o manifesto nao declara `min`/`max`",
      );
    }
    if (n < min || n > max) {
      return incompativel(
        id,
        bruto,
        "fora_da_escala",
        `${n} esta fora da escala declarada ${min} a ${max}`,
      );
    }
    return { pergunta_id: id, estado: "compativel", valor: n, bruto, forma: "inteiro" };
  }

  // --- TEXTO (short_text, text e qualquer outro tipo textual) ---------------
  if (typeof bruto !== "string") {
    if (Array.isArray(bruto) && bruto.every((v) => typeof v === "string")) {
      // Multipla escolha sem `options` no manifesto: repassa a lista como esta.
      return {
        pergunta_id: id,
        estado: "compativel",
        valor: bruto as string[],
        bruto,
        forma: "texto_exato",
      };
    }
    return incompativel(
      id,
      bruto,
      "tipo_invalido",
      `esperado texto; veio ${typeof bruto === "object" ? "estrutura" : typeof bruto}`,
    );
  }

  const valor = bruto.trim();
  const limite = pergunta.max_chars;
  if (limite !== null && valor.length > limite) {
    // Cortar em `limite` seria inventar a resposta; aceitar em silencio seria
    // afirmar que o campo coletado e o campo declarado. Nenhuma das duas.
    return incompativel(
      id,
      bruto,
      "acima_do_limite_de_caracteres",
      `a resposta tem ${valor.length} caracteres e o manifesto declara no maximo ${limite}; nao se corta o texto de ninguem`,
    );
  }
  return { pergunta_id: id, estado: "compativel", valor, bruto, forma: "texto_exato" };
}

/**
 * Resolve a alternativa JA casada: para as 6 situacionais devolve a LETRA (e o
 * motor so aceita letra), e confere que essa letra existe no mapa do motor. Para
 * as outras devolve o texto exato da alternativa declarada.
 */
function resolverAlternativa(
  pergunta: PerguntaCanonica,
  opcaoDeclarada: string,
  bruto: unknown,
  forma: FormaDeCorrespondencia,
): ItemMapeado {
  const id = pergunta.id;
  if (!ehSituacional(id)) {
    return {
      pergunta_id: id,
      estado: "compativel",
      valor: opcaoDeclarada.trim(),
      bruto,
      forma,
    };
  }

  const letra = letraDeclarada(opcaoDeclarada);
  if (letra === null) {
    return incompativel(
      id,
      bruto,
      "alternativa_fora_do_mapa",
      `a alternativa declarada no manifesto nao comeca com "A. ".."D. ", entao nao da para saber a que eixo ela pertence: ${descrever(opcaoDeclarada)}`,
    );
  }
  const mapa = MAPA_SITUACIONAL[id];
  if (mapa[letra] === undefined) {
    return incompativel(
      id,
      bruto,
      "alternativa_fora_do_mapa",
      `a letra "${letra}" nao tem eixo no mapa situacional de ${id}`,
    );
  }
  return { pergunta_id: id, estado: "compativel", valor: letra, bruto, forma };
}

export interface SubmissaoMapeada {
  itens: ItemMapeado[];
  /** Por `pergunta_id`, para consulta direta. */
  porId: Record<string, ItemMapeado>;
  compativeis: number;
  /** Quantas respostas falharam a correspondencia. NUNCA contadas como zero. */
  incompativeis: ItemMapeado[];
  ausentes: string[];
  /** Incompativeis em pergunta que o motor pontua. Bloqueiam a pontuacao. */
  incompativeisPontuadas: ItemMapeado[];
  /** Respostas que vieram para perguntas que o manifesto nao tem. */
  desconhecidas: ItemMapeado[];
}

/**
 * Mapeia uma submissao inteira contra o manifesto.
 *
 * Percorre as perguntas DO MANIFESTO (nao as chaves da submissao), para que
 * pergunta sem resposta apareca como `ausente` em vez de desaparecer. Depois
 * percorre as chaves que sobraram: resposta para pergunta que o manifesto nao
 * conhece e `incompativel` com causa `pergunta_desconhecida` -- nunca
 * descartada em silencio.
 */
export function mapearSubmissao(
  manifesto: ManifestoQuestionario,
  respostas: Readonly<Record<string, unknown>>,
): SubmissaoMapeada {
  const itens: ItemMapeado[] = [];
  const porId: Record<string, ItemMapeado> = {};

  for (const pergunta of manifesto.perguntas) {
    const item = mapearResposta(
      pergunta,
      Object.prototype.hasOwnProperty.call(respostas, pergunta.id)
        ? respostas[pergunta.id]
        : undefined,
    );
    itens.push(item);
    porId[item.pergunta_id] = item;
  }

  const desconhecidas: ItemMapeado[] = [];
  for (const chave of Object.keys(respostas)) {
    if (manifesto.porId[chave] !== undefined) continue;
    if (ehAusente(respostas[chave])) continue; // coluna vazia da planilha
    const item = incompativel(
      chave,
      respostas[chave],
      "pergunta_desconhecida",
      "veio resposta para uma pergunta que nao existe no questionario do sistema",
    );
    itens.push(item);
    porId[chave] = item;
    desconhecidas.push(item);
  }

  const incompativeis = itens.filter((i) => i.estado === "incompativel");
  return {
    itens,
    porId,
    compativeis: itens.filter((i) => i.estado === "compativel").length,
    incompativeis,
    ausentes: itens.filter((i) => i.estado === "ausente").map((i) => i.pergunta_id),
    incompativeisPontuadas: incompativeis.filter(
      (i) => i.estado === "incompativel" && i.pontuada,
    ),
    desconhecidas,
  };
}
