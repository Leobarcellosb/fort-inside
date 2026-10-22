// MANIFESTO CANONICO DO QUESTIONARIO, COM IMPRESSAO DIGITAL.
//
// POR QUE EXISTE
// --------------
// A coleta pre-evento do Marco Zero acontece FORA deste aplicativo (Google
// Forms). O questionario e copiado para la a mao. Se uma palavra for reescrita
// no caminho -- um enunciado, uma alternativa, um rotulo de escala -- as
// respostas que voltam deixam de ser respostas AO MESMO instrumento, e pontuar
// isso produz numero errado, nao erro.
//
// Este modulo transforma as perguntas que o SISTEMA conhece (linhas de
// `quiz_stages` de uma `quiz_version`) em um MANIFESTO: a lista canonica de
// perguntas na ordem canonica, com tudo que muda o significado de uma resposta
// -- enunciado, tipo, obrigatoriedade, alternativas, escalas e rotulos -- e uma
// IMPRESSAO DIGITAL SHA-256 desse conteudo.
//
// A EXPORTACAO leva o manifesto (quem monta o formulario copia dali e guarda a
// impressao). A IMPORTACAO confere a impressao declarada contra a do banco. Se
// nao baterem, a importacao RECUSA -- antes de qualquer pontuacao.
//
// TRES DESFECHOS NA CONFERENCIA, nunca dois (disciplina deste projeto):
//   igual         -- conferido e bate;
//   diferente     -- conferido e NAO bate. Veredito: recusa;
//   indisponivel  -- NAO deu para conferir (ninguem declarou impressao, ou o
//                   manifesto do banco nao pode ser montado). NAO e "bate" e
//                   NAO e "nao bate": e "nao consegui verificar", e bloqueia do
//                   mesmo jeito, com outro motivo.
//
// A IMPRESSAO E REPRODUZIVEL E JA FOI REPRODUZIDA: `impressaoDigital` aplicada
// as 5 etapas da versao 2 lidas do banco devolve
// 859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b, o mesmo
// numero publicado em docs/FORMULARIO-MARCO-ZERO.md e o mesmo conteudo de
// docs/questionario-v2-canonico.json. Este modulo NAO inventa um formato novo:
// adota o que ja foi publicado, para que o documento que foi para a rua e o
// codigo que vai conferir falem do mesmo numero.
//
// O ALGORITMO, por extenso, porque dele depende a recusa:
//   1. uma etapa por linha de `quiz_stages` da versao, ORDENADA por
//      `stage_number` (a ordem e parte do significado: "a 3a pergunta");
//      cada etapa vira { n: stage_number, t: title, q: [perguntas] };
//   2. cada pergunta vira um objeto com EXATAMENTE os 11 campos de
//      CAMPOS_DA_PERGUNTA, nessa ordem, com `null` no que nao se aplica.
//      Campo ausente e `null` sao a MESMA coisa: a impressao nao muda se o
//      banco gravar `"options": null` ou omitir `options`;
//   3. a impressao e o SHA-256 (hex) de JSON.stringify do array de etapas,
//      em UTF-8, sem espacos nem reordenacao de chaves.
//
// O que NAO entra na impressao: `id` da linha de `quiz_stages`, `description`,
// `ambient_name`, `placeholder` e `max_choices`. Sao apresentacao ou
// organizacao interna; nenhum deles muda como uma resposta e pontuada. Mudar
// esta lista MUDA a impressao de todo mundo: so se mexe aqui com a decisao
// registrada e o documento regerado.
//
// Puro, fora do `createHash` do Node: sem I/O, sem data/hora, sem aleatoriedade.
// Importes relativos de proposito (o vitest.config.ts nao resolve o alias `@/`).

import { createHash } from "node:crypto";

/**
 * Os campos de uma pergunta que ENTRAM na impressao digital, na ordem em que
 * entram. A ordem e significativa: JSON.stringify preserva a ordem de insercao.
 */
export const CAMPOS_DA_PERGUNTA = [
  "id",
  "text",
  "type",
  "required",
  "options",
  "min",
  "max",
  "min_label",
  "max_label",
  "min_chars",
  "max_chars",
] as const;

export type CampoDaPergunta = (typeof CAMPOS_DA_PERGUNTA)[number];

/** Uma pergunta na forma canonica: os 11 campos, nessa ordem, `null` no vazio. */
export interface PerguntaCanonica {
  id: string;
  text: string;
  type: string;
  required: boolean | null;
  options: string[] | null;
  min: number | null;
  max: number | null;
  min_label: string | null;
  max_label: string | null;
  min_chars: number | null;
  max_chars: number | null;
}

/** Uma etapa na forma canonica. `n` e o `stage_number`, `t` o titulo. */
export interface EtapaCanonica {
  n: number;
  t: string;
  q: PerguntaCanonica[];
}

export interface ManifestoQuestionario {
  quiz_version: number;
  /** Etapas na ordem canonica (stage_number crescente). */
  etapas: EtapaCanonica[];
  /** `stage_id` real de cada etapa, por `stage_number`. NAO entra na impressao. */
  idsDasEtapas: Record<number, number>;
  /** Todas as perguntas na ordem canonica, achatadas. */
  perguntas: PerguntaCanonica[];
  /** Indice id da pergunta -> pergunta canonica. */
  porId: Record<string, PerguntaCanonica>;
  /** Em que `stage_number` cada pergunta vive. */
  etapaDaPergunta: Record<string, number>;
  /** SHA-256 hex das etapas canonicas. */
  impressao: string;
}

/** Forma minima de uma linha de `quiz_stages` que este modulo consome. */
export interface LinhaDeEtapa {
  id: number;
  stage_number: number | null;
  title: string | null;
  questions: unknown;
}

export type CodigoDeManifesto =
  /** NAO deu para montar o manifesto (nao consegui verificar). */
  | "MANIFESTO_INDISPONIVEL"
  /** Montou a leitura e os dados do questionario estao inconsistentes. */
  | "MANIFESTO_INVALIDO";

export type ResultadoManifesto =
  | { ok: true; manifesto: ManifestoQuestionario }
  | { ok: false; codigo: CodigoDeManifesto; motivo: string };

function falha(codigo: CodigoDeManifesto, motivo: string): ResultadoManifesto {
  return { ok: false, codigo, motivo };
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null;
}

function inteiro(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) ? valor : null;
}

/**
 * Normaliza UMA pergunta crua do jsonb para a forma canonica.
 *
 * Campo ausente, `null` e `undefined` sao a mesma coisa: `null`. Qualquer outro
 * tipo onde se espera texto/numero/lista NAO e normalizado em silencio: devolve
 * motivo, e o chamador transforma em MANIFESTO_INVALIDO. Um questionario que
 * nao da para descrever nao da para conferir.
 */
export function canonizarPergunta(
  bruto: unknown,
): { ok: true; pergunta: PerguntaCanonica } | { ok: false; motivo: string } {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "pergunta que nao e um objeto" };
  }
  const o = bruto as Record<string, unknown>;

  const id = texto(o.id);
  if (id === null || id.trim() === "") {
    return { ok: false, motivo: "pergunta sem `id` de texto" };
  }
  const text = texto(o.text);
  if (text === null) return { ok: false, motivo: `pergunta ${id} sem \`text\`` };
  const type = texto(o.type);
  if (type === null) return { ok: false, motivo: `pergunta ${id} sem \`type\`` };

  let required: boolean | null = null;
  if (o.required !== undefined && o.required !== null) {
    if (typeof o.required !== "boolean") {
      return { ok: false, motivo: `pergunta ${id}: \`required\` nao e booleano` };
    }
    required = o.required;
  }

  let options: string[] | null = null;
  if (o.options !== undefined && o.options !== null) {
    if (!Array.isArray(o.options) || !o.options.every((v) => typeof v === "string")) {
      return { ok: false, motivo: `pergunta ${id}: \`options\` nao e lista de textos` };
    }
    options = o.options as string[];
  }

  const numericos: Record<string, number | null> = {};
  for (const campo of ["min", "max", "min_chars", "max_chars"] as const) {
    if (o[campo] === undefined || o[campo] === null) {
      numericos[campo] = null;
      continue;
    }
    const n = inteiro(o[campo]);
    if (n === null) {
      return { ok: false, motivo: `pergunta ${id}: \`${campo}\` nao e inteiro` };
    }
    numericos[campo] = n;
  }

  const rotulos: Record<string, string | null> = {};
  for (const campo of ["min_label", "max_label"] as const) {
    if (o[campo] === undefined || o[campo] === null) {
      rotulos[campo] = null;
      continue;
    }
    const t = texto(o[campo]);
    if (t === null) {
      return { ok: false, motivo: `pergunta ${id}: \`${campo}\` nao e texto` };
    }
    rotulos[campo] = t;
  }

  // Construcao na ORDEM de CAMPOS_DA_PERGUNTA: e a ordem que a impressao ve.
  const pergunta: PerguntaCanonica = {
    id,
    text,
    type,
    required,
    options,
    min: numericos.min,
    max: numericos.max,
    min_label: rotulos.min_label,
    max_label: rotulos.max_label,
    min_chars: numericos.min_chars,
    max_chars: numericos.max_chars,
  };
  return { ok: true, pergunta };
}

/**
 * SHA-256 (hex) das etapas canonicas. Reproduz a impressao publicada em
 * docs/FORMULARIO-MARCO-ZERO.md para a versao 2.
 */
export function impressaoDigital(etapas: readonly EtapaCanonica[]): string {
  return createHash("sha256").update(JSON.stringify(etapas), "utf8").digest("hex");
}

/**
 * O conteudo exato que gerou a impressao, para publicar ao lado dela. Mesmo
 * texto que `docs/questionario-v2-canonico.json` guarda, so indentado.
 */
export function conteudoDaImpressao(etapas: readonly EtapaCanonica[]): string {
  return JSON.stringify(etapas, null, 2);
}

/**
 * Monta o manifesto a partir das linhas de `quiz_stages` de uma versao.
 *
 * Recusa (MANIFESTO_INVALIDO) em vez de adivinhar quando: nao ha etapas,
 * `stage_number` e nulo ou repetido, a numeracao nao e 1..N, `questions` nao e
 * um array, uma pergunta nao da para canonizar, ou um id de pergunta se repete
 * no questionario (os ids tem de ser unicos no questionario inteiro -- e o que
 * permite achatar as etapas num unico mapa, ver lib/scoring/achatar-respostas).
 */
export function montarManifesto(
  linhas: readonly LinhaDeEtapa[] | null | undefined,
  quizVersion: number,
): ResultadoManifesto {
  if (linhas === null || linhas === undefined) {
    return falha(
      "MANIFESTO_INDISPONIVEL",
      "as etapas do questionario nao foram lidas (nenhuma linha recebida)",
    );
  }
  if (linhas.length === 0) {
    return falha(
      "MANIFESTO_INVALIDO",
      `a versao ${quizVersion} do questionario nao tem etapas cadastradas`,
    );
  }

  const numeros = linhas.map((l) => l.stage_number);
  if (numeros.some((n) => n === null || !Number.isInteger(n))) {
    return falha(
      "MANIFESTO_INVALIDO",
      `a versao ${quizVersion} tem etapa com \`stage_number\` nulo ou nao inteiro`,
    );
  }
  const ordenadas = [...linhas].sort(
    (a, b) => (a.stage_number as number) - (b.stage_number as number),
  );
  const esperado = ordenadas.every((l, i) => l.stage_number === i + 1);
  if (!esperado) {
    return falha(
      "MANIFESTO_INVALIDO",
      `o \`stage_number\` da versao ${quizVersion} nao e 1..N: [${numeros.join(", ")}]`,
    );
  }

  const etapas: EtapaCanonica[] = [];
  const idsDasEtapas: Record<number, number> = {};
  const porId: Record<string, PerguntaCanonica> = {};
  const etapaDaPergunta: Record<string, number> = {};
  const perguntas: PerguntaCanonica[] = [];

  for (const linha of ordenadas) {
    const n = linha.stage_number as number;
    const title = texto(linha.title);
    if (title === null) {
      return falha("MANIFESTO_INVALIDO", `a etapa ${n} nao tem titulo de texto`);
    }
    if (!Array.isArray(linha.questions)) {
      return falha("MANIFESTO_INVALIDO", `a etapa ${n} tem \`questions\` que nao e lista`);
    }
    if (linha.questions.length === 0) {
      return falha("MANIFESTO_INVALIDO", `a etapa ${n} nao tem perguntas`);
    }

    const q: PerguntaCanonica[] = [];
    for (const bruto of linha.questions) {
      const r = canonizarPergunta(bruto);
      if (!r.ok) return falha("MANIFESTO_INVALIDO", `etapa ${n}: ${r.motivo}`);
      const anterior = etapaDaPergunta[r.pergunta.id];
      if (anterior !== undefined) {
        return falha(
          "MANIFESTO_INVALIDO",
          `a pergunta ${r.pergunta.id} aparece na etapa ${anterior} e na etapa ${n}; os ids tem de ser unicos no questionario`,
        );
      }
      q.push(r.pergunta);
      perguntas.push(r.pergunta);
      porId[r.pergunta.id] = r.pergunta;
      etapaDaPergunta[r.pergunta.id] = n;
    }

    etapas.push({ n, t: title, q });
    idsDasEtapas[n] = linha.id;
  }

  return {
    ok: true,
    manifesto: {
      quiz_version: quizVersion,
      etapas,
      idsDasEtapas,
      perguntas,
      porId,
      etapaDaPergunta,
      impressao: impressaoDigital(etapas),
    },
  };
}

export type VeredictoDaConferencia = "igual" | "diferente" | "indisponivel";

export type ResultadoDaConferencia =
  | { veredito: "igual"; impressao: string }
  | { veredito: "diferente"; declarada: string; doSistema: string; motivo: string }
  | { veredito: "indisponivel"; motivo: string };

const IMPRESSAO_HEX = /^[0-9a-f]{64}$/;

/**
 * Confere a impressao que veio COM a coleta externa contra a do sistema.
 *
 * Nao normaliza nada alem de aparar espaco e aceitar maiuscula em hexadecimal:
 * uma impressao e um numero, nao um texto para interpretar. Impressao ausente,
 * vazia ou que nao e hexadecimal de 64 digitos e `indisponivel` -- "nao
 * consegui verificar" --, nunca `diferente` e jamais `igual`.
 */
export function conferirImpressao(
  declarada: unknown,
  doSistema: string,
): ResultadoDaConferencia {
  if (typeof declarada !== "string" || declarada.trim() === "") {
    return {
      veredito: "indisponivel",
      motivo:
        "a coleta externa nao declarou a impressao digital do questionario; nao da para afirmar que as perguntas respondidas sao as que o sistema conhece",
    };
  }
  const limpa = declarada.trim().toLowerCase();
  if (!IMPRESSAO_HEX.test(limpa)) {
    return {
      veredito: "indisponivel",
      motivo: `a impressao declarada nao e um SHA-256 hexadecimal de 64 digitos: ${JSON.stringify(declarada.trim().slice(0, 80))}`,
    };
  }
  if (limpa !== doSistema) {
    return {
      veredito: "diferente",
      declarada: limpa,
      doSistema,
      motivo:
        "o questionario usado na coleta NAO e o que o sistema conhece: enunciado, alternativa, escala ou ordem foi alterado. Pontuar estas respostas produziria numero errado",
    };
  }
  return { veredito: "igual", impressao: doSistema };
}
