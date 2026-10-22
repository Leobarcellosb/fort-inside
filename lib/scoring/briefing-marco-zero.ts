// Camada entre o motor de pontuacao (marco-zero.ts) e qualquer texto entregue
// a pessoa (prompt de IA ou documento direto). Funcao pura: sem I/O, sem
// data/hora, sem aleatoriedade, sem IA.
//
// Principios, decididos pelo responsavel tecnico e tornados codigo aqui:
//  1. Tudo que o Marco Zero mede e AUTORRELATO. As situacionais sao escolhas
//     declaradas sobre hipoteses: nunca viram comportamento observado. O
//     maximo permitido e contrastar "como a pessoa se descreve" com "o que ela
//     escolheu", e como PERGUNTA.
//  2. Sem eixoDestacado nao se forca classificacao: mostra-se a distribuicao e
//     nao se afirma eixo predominante.
//  3. Dado ausente nao e zero, nao e resultado baixo e nao gera recomendacao.
//  4. Maior/menor pontuacao de elemento so com os 7 respondidos, e sempre
//     como nota ATRIBUIDA, nunca como forca ou fragilidade reais.
//  5. Nenhum eixo tem nome publico definido: os rotulos chegam de fora, por um
//     mapa injetado. Sem mapa, descreve-se sem nomear e a chave crua nunca
//     vaza para o texto.
//
// Garantia estrutural: quando o dado nao autoriza uma afirmacao, o campo vem
// como `indeterminado` (sem `eixoInterno`/`elementoInterno` e, quase sempre,
// sem texto), entao nao ha valor que o chamador possa usar por engano.
// Garantia de ultima linha: toda string gerada passa pela lista de
// expressoes vetadas antes de sair; se alguma passar, a funcao LANCA em vez de
// entregar a frase.

import {
  EIXOS,
  ELEMENTOS,
  ITENS_LIKERT,
  SITUACIONAIS,
  type AnaliseElementos,
  type Eixo,
  type Elemento,
  type MarcoZeroScores,
  type StatusDestaque,
} from "./marco-zero";

// ---------------------------------------------------------------------------
// Tipos publicos
// ---------------------------------------------------------------------------

/**
 * - fato_medido: o que a pessoa respondeu / o que a conta devolve, sem
 *   interpretacao.
 * - hipotese_a_validar: leitura interpretativa. Deve ser escrita como pergunta
 *   ou possibilidade e NUNCA tratada como requisito ou conclusao.
 * - indeterminado: o dado nao autoriza a afirmacao. Nao afirmar, nao inferir.
 */
export type Classificacao =
  | "fato_medido"
  | "hipotese_a_validar"
  | "indeterminado";

export type InstrumentoFonte = "likert" | "situacional" | "elementos";

export type StatusDoMotor = StatusDestaque | AnaliseElementos["status"];

/** Que instrumento produziu a afirmacao e com que completude. */
export interface Fonte {
  instrumento: InstrumentoFonte;
  /**
   * Todo instrumento aqui e autorrelato. `escolha_declarada_hipotetica` e o
   * caso das situacionais: o que a pessoa diz que escolheria, nao o que fez.
   */
  natureza: "autorrelato" | "escolha_declarada_hipotetica";
  respondidas: number;
  total: number;
  completo: boolean;
  statusDoMotor: StatusDoMotor;
}

export type MotivoIndeterminado =
  | "empate"
  | "margem_insuficiente"
  | "respostas_incompletas"
  | "algum_instrumento_sem_destaque"
  | "elementos_incompletos"
  | "elementos_insuficientes"
  | "empate_no_topo"
  | "empate_na_base"
  | "dados_inconsistentes";

export type IdAfirmacao =
  | "eixos.likert.destaque"
  | "eixos.situacional.destaque"
  | "eixos.situacional.distribuicao"
  | "eixos.cruzamento.contraste"
  | "eixos.cruzamento.convergencia"
  | "eixos.cruzamento.reflexao"
  | "eixos.cruzamento.indeterminado"
  | "elementos.media"
  | "elementos.maior"
  | "elementos.menor"
  | "elementos.notas";

interface AfirmacaoComum {
  id: IdAfirmacao;
  fontes: readonly Fonte[];
  /** Cabecalho de secao, quando o texto aprovado tem um. */
  titulo?: string;
  /**
   * Texto pronto para a pessoa. `null` = nao ha texto seguro para exibir
   * (dado so para renderizacao, ou falta rotulo). Nunca preencher por conta
   * propria a partir de outros campos.
   */
  texto: string | null;
}

export interface FatoMedido extends AfirmacaoComum {
  classificacao: "fato_medido";
}

export interface HipoteseAValidar extends AfirmacaoComum {
  classificacao: "hipotese_a_validar";
  texto: string;
}

export interface Indeterminado extends AfirmacaoComum {
  classificacao: "indeterminado";
  motivo: MotivoIndeterminado;
}

export type DestaqueLikert =
  | (FatoMedido & { eixoInterno: Eixo; texto: string })
  | Indeterminado;

export type DestaqueSituacional =
  | (FatoMedido & {
      eixoInterno: Eixo;
      /** Escolhas ligadas ao eixo citado e total de situacoes respondidas. */
      escolhas: number;
      de: number;
      texto: string;
    })
  | Indeterminado;

export interface ItemDistribuicao {
  eixoInterno: Eixo;
  /** null quando nenhum rotulo valido foi injetado para o eixo. */
  rotulo: string | null;
  contagem: number;
}

export type DistribuicaoSituacional =
  | (FatoMedido & {
      respondidas: number;
      /** Sempre na ordem fixa de EIXOS, nunca ordenada por valor. */
      itens: readonly ItemDistribuicao[];
    })
  | Indeterminado;

export type AfirmacaoCruzamento =
  | (FatoMedido & { id: "eixos.cruzamento.convergencia"; eixoInterno: Eixo; texto: string })
  | (HipoteseAValidar & {
      id: "eixos.cruzamento.contraste";
      eixoAutodescricaoInterno: Eixo;
      eixoEscolhasInterno: Eixo;
    })
  | (HipoteseAValidar & { id: "eixos.cruzamento.reflexao" })
  | (Indeterminado & { id: "eixos.cruzamento.indeterminado" });

export interface MediaElementos {
  valor: number;
  /** Quantos elementos entraram na conta. Sempre sai junto com a media. */
  denominador: number;
  de: number;
}

export type AfirmacaoMedia =
  | (FatoMedido & { media: MediaElementos; texto: string })
  | Indeterminado;

export type AfirmacaoExtremo =
  | (FatoMedido & { elementoInterno: Elemento; rotulo: string; texto: string })
  | Indeterminado;

export type NotaElemento =
  | { estado: "respondido"; nota: number }
  // Sem campo de valor: nao ha o que usar como zero ou como nota baixa.
  | { estado: "nao_respondido" };

export interface ItemNotaElemento {
  elementoInterno: Elemento;
  rotulo: string;
  resposta: NotaElemento;
}

/**
 * Dado so para exibicao (tabela, roda). Nao entra no prompt e nao autoriza
 * nenhuma comparacao entre elementos: comparacao so existe nas afirmacoes
 * `elementos.maior` e `elementos.menor`.
 */
export type AfirmacaoNotas =
  | (FatoMedido & { itens: readonly ItemNotaElemento[]; texto: null })
  | Indeterminado;

export type Afirmacao =
  | DestaqueLikert
  | DestaqueSituacional
  | DistribuicaoSituacional
  | AfirmacaoCruzamento
  | AfirmacaoMedia
  | AfirmacaoExtremo
  | AfirmacaoNotas;

export interface AvisoBriefing {
  codigo:
    | "rotulos_eixos_ausentes"
    | "rotulo_invalido_descartado"
    | "dados_inconsistentes";
  descricao: string;
}

export interface BriefingMarcoZero {
  versao: 1;
  /** Para quem monta o documento. Nunca e texto para a pessoa. */
  avisos: readonly AvisoBriefing[];
  /** Todas as afirmacoes, em ordem de apresentacao. */
  afirmacoes: readonly Afirmacao[];
  eixos: {
    likert: DestaqueLikert;
    situacional: DestaqueSituacional;
    distribuicaoSituacional: DistribuicaoSituacional;
    cruzamento: readonly AfirmacaoCruzamento[];
  };
  elementos: {
    media: AfirmacaoMedia;
    maior: AfirmacaoExtremo;
    menor: AfirmacaoExtremo;
    notas: AfirmacaoNotas;
  };
}

export interface OpcoesBriefing {
  /**
   * Rotulos publicos dos eixos, injetados por quem responde pela metodologia.
   * Este modulo NAO define nenhum. Ausente ou invalido => descreve sem nomear.
   */
  rotulosEixos?: Partial<Record<Eixo, string>>;
  /** Sobrescreve os nomes descritivos padrao dos elementos. */
  rotulosElementos?: Partial<Record<Elemento, string>>;
}

// ---------------------------------------------------------------------------
// Textos aprovados (constantes: alterar aqui e decisao de metodologia)
// ---------------------------------------------------------------------------

export const TITULO_SITUACIONAL = "Suas escolhas em diferentes situações";

export const TEXTO_SITUACIONAL_SEM_DESTAQUE = [
  "Nas seis situações apresentadas, suas escolhas se distribuíram entre diferentes dimensões, sem uma predominância suficientemente clara para destacar um único eixo.",
  "Isso não significa ausência de características marcantes. Significa apenas que esse conjunto de respostas não permite identificar uma preferência consistente entre os quatro eixos.",
  "Para refletir: o que costuma fazer você priorizar uma dimensão em vez de outra quando precisa tomar uma decisão?",
] as const;

export const FRASE_ELEMENTO_MAIOR =
  "Entre os sete elementos avaliados, este foi aquele ao qual você atribuiu a maior pontuação";

export const FRASE_ELEMENTO_MENOR =
  "Entre os sete elementos avaliados, este foi aquele ao qual você atribuiu a menor pontuação";

// Nomes DESCRITIVOS dos sete elementos (a chave em portugues corrente), nao
// marca. Podem ser sobrescritos por `rotulosElementos`.
export const ROTULOS_ELEMENTOS_PADRAO: Record<Elemento, string> = {
  desenvolvimento_intelectual: "Desenvolvimento intelectual",
  saude_energia: "Saúde e energia",
  equilibrio_emocional: "Equilíbrio emocional",
  recursos_financeiros: "Recursos financeiros",
  contribuicao_social: "Contribuição social",
  realizacao_proposito: "Realização e propósito",
  hobbies_diversao: "Hobbies e diversão",
};

// ---------------------------------------------------------------------------
// Lista de expressoes vetadas
// ---------------------------------------------------------------------------

export interface ExpressaoVetada {
  id: string;
  /** Aplicada sobre o texto normalizado (minusculo, sem acento). */
  padrao: RegExp;
  motivo: string;
}

export const EXPRESSOES_VETADAS: readonly ExpressaoVetada[] = [
  {
    id: "perfil_eixo_dominante",
    padrao: /\b(dominante|dominantes|predominante|predominantes)\b/,
    motivo: "afirma perfil/eixo dominante ou predominante",
  },
  {
    id: "voce_age",
    padrao:
      /\bvoce\s+(age|agiu|agira|reage|reagiu|reagira|se\s+comporta|se\s+comportou|costuma\s+(agir|reagir)|sempre|nunca)\b/,
    motivo: "afirma como a pessoa age",
  },
  {
    id: "comportamento",
    padrao:
      /\b(seu|sua|o)\s+comportamento\b|\bcomportamento\s+(observado|real|comprovado|demonstrado)\b|\b(sua|a)\s+(forma|maneira)\s+de\s+agir\b/,
    motivo: "trata autorrelato como comportamento",
  },
  {
    id: "sob_pressao",
    padrao: /\b(sob|em)\s+pressao\s+voce\b|\bvoce\s+(sob|em)\s+pressao\b/,
    motivo: "afirma reacao sob pressao",
  },
  {
    id: "forca_comprovada",
    padrao:
      /\bforca\s+(comprovada|real|demonstrada|verdadeira)\b|\bmaior\s+forca\b|\bpontos?\s+(mais\s+)?(forte|fortes|fraco|fracos)\b|\bpontos?\s+a\s+(melhorar|desenvolver)\b/,
    motivo: "afirma forca/fraqueza real em vez de nota autorrelatada",
  },
  {
    id: "fragilidade",
    padrao:
      /\b(fragilidade|fragilidades|fraqueza|fraquezas|deficiencia|deficiencias|carencia|carencias|vulnerabilidade|vulnerabilidades|pior|piores)\b/,
    motivo: "apresenta nota ou ausencia como fragilidade",
  },
  {
    id: "comprova",
    padrao: /\bcomprovad[ao]s?\b|\b(comprova|comprovam|prova|provam|demonstra|demonstram|revela|revelam)\s+que\s+voce\b/,
    motivo: "trata autorrelato como prova",
  },
  {
    id: "voce_e_uma_pessoa",
    padrao: /\bvoce\s+e\s+uma?\s+(pessoa|perfil|tipo|lider|executor|executora)\b/,
    motivo: "rotula a pessoa",
  },
  {
    id: "ausente_como_baixo",
    padrao:
      /\bnao\s+respondid[ao]s?\b[^.]{0,60}\b(menor|baix[ao]s?|fraco|fragil\w*)\b|\b(menor|baix[ao]s?|fraco|fragil\w*)\b[^.]{0,60}\bnao\s+respondid[ao]s?\b/,
    motivo: "trata dado ausente como resultado baixo",
  },
  {
    id: "valor_vazado",
    padrao: /\bundefined\b|\bnull\b|\bnan\b|\[object/,
    motivo: "valor tecnico vazou para o texto",
  },
];

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Ids das expressoes vetadas encontradas no texto (vazio = limpo). */
export function encontrarExpressoesVetadas(texto: string): string[] {
  const t = normalizar(texto);
  return EXPRESSOES_VETADAS.filter((e) => e.padrao.test(t)).map((e) => e.id);
}

const CHAVES_DE_EIXO = /\b(visao|execucao|relacao|integridade)\b/i;
const CHAVE_SNAKE = /\b[a-z]+(?:_[a-z]+)+\b/;
const ID_PERGUNTA = /\bq\d{1,2}\b/i;

/**
 * Chaves internas (de eixo, de elemento, ids de pergunta) que vazaram para o
 * texto. `rotulosPermitidos` sao removidos antes da checagem, para que um
 * rotulo legitimo (ex.: uma palavra comum) nao seja confundido com a chave.
 */
export function encontrarChavesVazadas(
  texto: string,
  rotulosPermitidos: readonly string[] = [],
): string[] {
  let t = texto;
  for (const r of [...rotulosPermitidos].sort((a, b) => b.length - a.length)) {
    t = t.split(r).join(" ");
  }
  const achados: string[] = [];
  const eixo = t.match(CHAVES_DE_EIXO);
  if (eixo) achados.push(eixo[0]);
  const snake = t.match(CHAVE_SNAKE);
  if (snake) achados.push(snake[0]);
  const q = t.match(ID_PERGUNTA);
  if (q) achados.push(q[0]);
  return achados;
}

// ---------------------------------------------------------------------------
// Rotulos
// ---------------------------------------------------------------------------

const TAMANHO_MAXIMO_ROTULO = 60;

// Um rotulo e texto que vai ser citado entre aspas na frase. Descarta o que
// nao e nome: vazio, longo, com quebra de linha/aspas, com sublinhado (chave
// de variavel), igual a propria chave, ou que ja contenha expressao vetada.
function sanitizarRotulo(valor: unknown, chave: string): string | null {
  if (typeof valor !== "string") return null;
  const r = valor.trim();
  if (r.length === 0 || r.length > TAMANHO_MAXIMO_ROTULO) return null;
  if (/[\n\r\t_"“”]/.test(r)) return null;
  if (r === chave) return null;
  if (encontrarExpressoesVetadas(r).length > 0) return null;
  if (CHAVE_SNAKE.test(r) || ID_PERGUNTA.test(r)) return null;
  return r;
}

interface Rotulos {
  eixo: Record<Eixo, string | null>;
  elemento: Record<Elemento, string>;
  descartados: string[];
}

function resolverRotulos(opcoes: OpcoesBriefing | undefined): Rotulos {
  const descartados: string[] = [];
  const eixo = {} as Record<Eixo, string | null>;
  for (const e of EIXOS) {
    const bruto = opcoes?.rotulosEixos?.[e];
    const limpo = sanitizarRotulo(bruto, e);
    if (bruto !== undefined && limpo === null) descartados.push(e);
    eixo[e] = limpo;
  }
  const elemento = {} as Record<Elemento, string>;
  for (const el of ELEMENTOS) {
    const bruto = opcoes?.rotulosElementos?.[el];
    const limpo = sanitizarRotulo(bruto, el);
    if (bruto !== undefined && limpo === null) descartados.push(el);
    elemento[el] = limpo ?? ROTULOS_ELEMENTOS_PADRAO[el];
  }
  return { eixo, elemento, descartados };
}

const aspas = (r: string) => `“${r}”`;

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

const IDS_LIKERT: ReadonlySet<string> = new Set(
  EIXOS.flatMap((e) => ITENS_LIKERT[e]),
);
const IDS_SITUACIONAIS: ReadonlySet<string> = new Set(SITUACIONAIS);
const TOTAL_LIKERT = IDS_LIKERT.size;
const TOTAL_SITUACIONAIS = SITUACIONAIS.length;
const TOTAL_ELEMENTOS = ELEMENTOS.length;

function fonteLikert(s: MarcoZeroScores): Fonte {
  const faltantes = s.incompleto.filter((id) => IDS_LIKERT.has(id)).length;
  return {
    instrumento: "likert",
    natureza: "autorrelato",
    respondidas: TOTAL_LIKERT - faltantes,
    total: TOTAL_LIKERT,
    completo: faltantes === 0,
    statusDoMotor: s.analiseLikert.status,
  };
}

function fonteSituacional(s: MarcoZeroScores): Fonte {
  const faltantes = s.incompleto.filter((id) => IDS_SITUACIONAIS.has(id)).length;
  return {
    instrumento: "situacional",
    natureza: "escolha_declarada_hipotetica",
    respondidas: TOTAL_SITUACIONAIS - faltantes,
    total: TOTAL_SITUACIONAIS,
    completo: faltantes === 0,
    statusDoMotor: s.analiseSituacional.status,
  };
}

function fonteElementos(s: MarcoZeroScores): Fonte {
  const n = s.analiseElementos.elementosRespondidos;
  return {
    instrumento: "elementos",
    natureza: "autorrelato",
    respondidas: n,
    total: TOTAL_ELEMENTOS,
    completo: n === TOTAL_ELEMENTOS,
    statusDoMotor: s.analiseElementos.status,
  };
}

function ehEixo(v: unknown): v is Eixo {
  return typeof v === "string" && (EIXOS as readonly string[]).includes(v);
}

function ehElemento(v: unknown): v is Elemento {
  return typeof v === "string" && (ELEMENTOS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Eixos
// ---------------------------------------------------------------------------

function motivoDeStatus(status: StatusDestaque): MotivoIndeterminado {
  if (status === "empate") return "empate";
  if (status === "margem_insuficiente") return "margem_insuficiente";
  if (status === "incompleto") return "respostas_incompletas";
  return "dados_inconsistentes";
}

function destaqueLikert(
  s: MarcoZeroScores,
  r: Rotulos,
  avisos: AvisoBriefing[],
): DestaqueLikert {
  const a = s.analiseLikert;
  const fonte = fonteLikert(s);
  const fontes = [fonte];

  if (a.status === "destacado") {
    if (ehEixo(a.eixoDestacado) && fonte.completo) {
      const rotulo = r.eixo[a.eixoDestacado];
      const texto = rotulo
        ? `Você se descreve com forte orientação à dimensão ${aspas(rotulo)}.`
        : "Você se descreve com forte orientação a uma das dimensões avaliadas.";
      return {
        id: "eixos.likert.destaque",
        classificacao: "fato_medido",
        fontes,
        eixoInterno: a.eixoDestacado,
        texto,
      };
    }
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao:
        "analiseLikert.status === 'destacado' sem eixo valido ou com itens faltando; destaque descartado.",
    });
    return {
      id: "eixos.likert.destaque",
      classificacao: "indeterminado",
      motivo: "dados_inconsistentes",
      fontes,
      texto: null,
    };
  }

  if (a.eixoDestacado !== null) {
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao:
        "analiseLikert tem eixoDestacado sem status 'destacado'; eixo descartado.",
    });
  }
  const motivo = motivoDeStatus(a.status);
  let texto: string | null;
  if (motivo === "respostas_incompletas") {
    texto = `Algumas das afirmações sobre como você se descreve ficaram sem resposta (${fonte.respondidas} de ${fonte.total} respondidas), então não é possível destacar uma dimensão.`;
  } else {
    texto =
      "Na forma como você se descreve, não houve uma diferença suficientemente clara entre as dimensões mais pontuadas para destacar uma única delas.";
  }
  return {
    id: "eixos.likert.destaque",
    classificacao: "indeterminado",
    motivo,
    fontes,
    texto,
  };
}

function textoSemDestaqueSituacional(respondidas: number): string {
  if (respondidas === 0) {
    return "Nenhuma das seis situações foi respondida, então não há escolhas para apresentar.";
  }
  const [p1, p2, p3] = TEXTO_SITUACIONAL_SEM_DESTAQUE;
  const primeiro =
    respondidas === TOTAL_SITUACIONAIS
      ? p1
      : `Você respondeu ${respondidas} das seis situações apresentadas. Com respostas faltando, as escolhas registradas não foram suficientes para destacar um único eixo.`;
  return [primeiro, p2, p3].join("\n\n");
}

function destaqueSituacional(
  s: MarcoZeroScores,
  r: Rotulos,
  avisos: AvisoBriefing[],
): DestaqueSituacional {
  const a = s.analiseSituacional;
  const fonte = fonteSituacional(s);
  const fontes = [fonte];
  const base = {
    id: "eixos.situacional.destaque" as const,
    fontes,
    titulo: TITULO_SITUACIONAL,
  };

  if (a.status === "destacado") {
    if (ehEixo(a.eixoDestacado) && fonte.completo) {
      const eixo = a.eixoDestacado;
      const rotulo = r.eixo[eixo];
      const alvo = rotulo
        ? `a dimensão ${aspas(rotulo)}`
        : "uma das dimensões avaliadas";
      const escolhas = a.contagens[eixo];
      const texto = `Nas seis situações hipotéticas, o maior número das suas escolhas declaradas (${escolhas} de ${fonte.respondidas}) favoreceu ${alvo}. São escolhas feitas sobre situações imaginadas; elas não descrevem o que ocorre na prática.`;
      return {
        ...base,
        classificacao: "fato_medido",
        eixoInterno: eixo,
        escolhas,
        de: fonte.respondidas,
        texto,
      };
    }
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao:
        "analiseSituacional.status === 'destacado' sem eixo valido ou com situacoes faltando; destaque descartado.",
    });
    return {
      ...base,
      classificacao: "indeterminado",
      motivo: "dados_inconsistentes",
      texto: null,
    };
  }

  if (a.eixoDestacado !== null) {
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao:
        "analiseSituacional tem eixoDestacado sem status 'destacado'; eixo descartado.",
    });
  }
  return {
    ...base,
    classificacao: "indeterminado",
    motivo: motivoDeStatus(a.status),
    texto: textoSemDestaqueSituacional(fonte.respondidas),
  };
}

function distribuicaoSituacional(
  s: MarcoZeroScores,
  r: Rotulos,
  avisos: AvisoBriefing[],
): DistribuicaoSituacional {
  const fonte = fonteSituacional(s);
  const fontes = [fonte];
  const contagens = s.analiseSituacional.contagens;
  const soma = EIXOS.reduce((acc, e) => acc + contagens[e], 0);
  const id = "eixos.situacional.distribuicao" as const;

  if (fonte.respondidas === 0) {
    return { id, classificacao: "indeterminado", motivo: "respostas_incompletas", fontes, texto: null };
  }
  if (soma !== fonte.respondidas) {
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao:
        "A soma das contagens situacionais nao bate com as situacoes respondidas; distribuicao descartada.",
    });
    return { id, classificacao: "indeterminado", motivo: "dados_inconsistentes", fontes, texto: null };
  }

  const itens: ItemDistribuicao[] = EIXOS.map((e) => ({
    eixoInterno: e,
    rotulo: r.eixo[e],
    contagem: contagens[e],
  }));
  const todosRotulados = itens.every((i) => i.rotulo !== null);
  const texto = todosRotulados
    ? `Nas situações respondidas, suas escolhas se distribuíram assim: ${itens
        .map((i) => `${aspas(i.rotulo as string)}, ${i.contagem} de ${fonte.respondidas}`)
        .join("; ")}.`
    : null;
  return {
    id,
    classificacao: "fato_medido",
    fontes,
    respondidas: fonte.respondidas,
    itens,
    texto,
  };
}

function cruzamento(
  s: MarcoZeroScores,
  likert: DestaqueLikert,
  situacional: DestaqueSituacional,
  r: Rotulos,
  avisos: AvisoBriefing[],
): AfirmacaoCruzamento[] {
  const fontes = [fonteLikert(s), fonteSituacional(s)];
  const indeterminado = (
    motivo: MotivoIndeterminado,
  ): AfirmacaoCruzamento[] => [
    {
      id: "eixos.cruzamento.indeterminado",
      classificacao: "indeterminado",
      motivo,
      fontes,
      texto: null,
    },
  ];

  // Calculado SOMENTE sobre destaques ja validados, nunca por confianca cega
  // em `relacaoEntreAutorrelatos`.
  if (
    likert.classificacao !== "fato_medido" ||
    situacional.classificacao !== "fato_medido"
  ) {
    if (s.relacaoEntreAutorrelatos !== "inconclusivo") {
      avisos.push({
        codigo: "dados_inconsistentes",
        descricao:
          "relacaoEntreAutorrelatos indica cruzamento sem os dois destaques validos; cruzamento descartado.",
      });
      return indeterminado("dados_inconsistentes");
    }
    return indeterminado("algum_instrumento_sem_destaque");
  }

  const eixoL = likert.eixoInterno;
  const eixoS = situacional.eixoInterno;
  const esperado = eixoL === eixoS ? "convergencia" : "contraste";
  if (s.relacaoEntreAutorrelatos !== esperado) {
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao: `relacaoEntreAutorrelatos='${s.relacaoEntreAutorrelatos}' diverge dos destaques (esperado '${esperado}'); cruzamento descartado.`,
    });
    return indeterminado("dados_inconsistentes");
  }

  const rotL = r.eixo[eixoL];
  const rotS = r.eixo[eixoS];

  if (esperado === "contraste") {
    const p1 = rotL
      ? `Você se descreve com forte orientação à dimensão ${aspas(rotL)}.`
      : "Você se descreve com forte orientação a uma das dimensões avaliadas.";
    const p2 = rotS
      ? `Nas situações hipotéticas, porém, suas escolhas favoreceram a dimensão ${aspas(rotS)}.`
      : "Nas situações hipotéticas, porém, suas escolhas favoreceram outra dimensão.";
    const p3 = "O que essa diferença pode revelar sobre suas prioridades?";
    return [
      {
        id: "eixos.cruzamento.contraste",
        classificacao: "hipotese_a_validar",
        fontes,
        eixoAutodescricaoInterno: eixoL,
        eixoEscolhasInterno: eixoS,
        texto: `${p1} ${p2} ${p3}`,
      },
    ];
  }

  const alvo = rotL ? `a dimensão ${aspas(rotL)}` : "a mesma dimensão";
  return [
    {
      id: "eixos.cruzamento.convergencia",
      classificacao: "fato_medido",
      fontes,
      eixoInterno: eixoL,
      texto: `Tanto na forma como você se descreve quanto nas escolhas que declarou para as situações hipotéticas, ${alvo} teve o maior destaque. As duas leituras vêm das suas próprias respostas (autorrelato); nenhuma delas observa o que você faz na prática.`,
    },
    {
      id: "eixos.cruzamento.reflexao",
      classificacao: "hipotese_a_validar",
      fontes,
      texto:
        "Em quais momentos da sua rotina essa coincidência se confirma, e em quais ela não aparece?",
    },
  ];
}

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

function formatarNota(n: number): string {
  return n.toFixed(1).replace(".", ",");
}

// Reverifica, direto nos dados brutos, o que o motor afirma: todos os 7
// respondidos e o extremo ser unico. Se algo divergir, nada e apresentado.
function extremoVerificado(
  s: MarcoZeroScores,
  elemento: Elemento,
  sentido: "maior" | "menor",
): boolean {
  if (s.analiseElementos.status !== "completo") return false;
  if (s.analiseElementos.elementosRespondidos !== TOTAL_ELEMENTOS) return false;
  const valores: number[] = [];
  for (const el of ELEMENTOS) {
    const p = s.elementos[el];
    if (p.status !== "respondido" || p.valor === null) return false;
    valores.push(p.valor);
  }
  const alvo = s.elementos[elemento].valor;
  if (alvo === null) return false;
  const extremo = sentido === "maior" ? Math.max(...valores) : Math.min(...valores);
  return alvo === extremo && valores.filter((v) => v === extremo).length === 1;
}

function mediaElementos(s: MarcoZeroScores): AfirmacaoMedia {
  const fonte = fonteElementos(s);
  const fontes = [fonte];
  const id = "elementos.media" as const;
  const { valor, denominador } = s.elementosMedia;

  if (
    s.analiseElementos.status === "insuficiente" ||
    valor === null ||
    denominador !== fonte.respondidas
  ) {
    const consistente = denominador === fonte.respondidas;
    return {
      id,
      classificacao: "indeterminado",
      motivo: consistente ? "elementos_insuficientes" : "dados_inconsistentes",
      fontes,
      texto: consistente
        ? `Você respondeu ${fonte.respondidas} dos sete elementos. Com poucas respostas, não apresentamos média nem comparação entre eles.`
        : null,
    };
  }

  const complemento =
    denominador === TOTAL_ELEMENTOS
      ? ""
      : ` Os demais ficaram sem resposta e não entram na conta.`;
  return {
    id,
    classificacao: "fato_medido",
    fontes,
    media: { valor, denominador, de: TOTAL_ELEMENTOS },
    texto: `A média das notas que você atribuiu aos elementos foi ${formatarNota(valor)} (em uma escala de 0 a 10), calculada sobre ${denominador} de ${TOTAL_ELEMENTOS} elementos respondidos.${complemento}`,
  };
}

function extremo(
  s: MarcoZeroScores,
  r: Rotulos,
  sentido: "maior" | "menor",
  avisos: AvisoBriefing[],
): AfirmacaoExtremo {
  const fonte = fonteElementos(s);
  const fontes = [fonte];
  const id = sentido === "maior" ? ("elementos.maior" as const) : ("elementos.menor" as const);
  const indeterminado = (motivo: MotivoIndeterminado): AfirmacaoExtremo => ({
    id,
    classificacao: "indeterminado",
    motivo,
    fontes,
    texto: null,
  });

  let candidato: unknown;
  let motivoSemElemento: MotivoIndeterminado;
  if (sentido === "maior") {
    const m = s.elementoDeMaiorPontuacao;
    if (m.status === "indisponivel") return indeterminado("elementos_insuficientes");
    if (m.status === "somente_interno") return indeterminado("elementos_incompletos");
    if (m.status === "empate") return indeterminado("empate_no_topo");
    candidato = m.elemento;
    motivoSemElemento = "dados_inconsistentes";
  } else {
    const status = s.analiseElementos.status;
    if (status === "insuficiente") return indeterminado("elementos_insuficientes");
    if (status === "parcial") return indeterminado("elementos_incompletos");
    candidato = s.analiseElementos.elementoDeMenorPontuacao;
    motivoSemElemento = "empate_na_base";
    if (candidato === null) return indeterminado(motivoSemElemento);
  }

  if (!ehElemento(candidato) || !extremoVerificado(s, candidato, sentido)) {
    avisos.push({
      codigo: "dados_inconsistentes",
      descricao: `Elemento de ${sentido} pontuacao informado pelo motor nao se sustenta nos dados brutos; descartado.`,
    });
    return indeterminado("dados_inconsistentes");
  }

  const rotulo = r.elemento[candidato];
  const frase = sentido === "maior" ? FRASE_ELEMENTO_MAIOR : FRASE_ELEMENTO_MENOR;
  const ressalva =
    " É a nota que você atribuiu, e não uma medição externa.";
  return {
    id,
    classificacao: "fato_medido",
    fontes,
    elementoInterno: candidato,
    rotulo,
    texto: `${frase}: ${aspas(rotulo)}.${ressalva}`,
  };
}

function notasElementos(s: MarcoZeroScores, r: Rotulos): AfirmacaoNotas {
  const fonte = fonteElementos(s);
  const fontes = [fonte];
  const id = "elementos.notas" as const;
  if (s.analiseElementos.status === "insuficiente") {
    return {
      id,
      classificacao: "indeterminado",
      motivo: "elementos_insuficientes",
      fontes,
      texto: null,
    };
  }
  const itens: ItemNotaElemento[] = ELEMENTOS.map((el) => {
    const p = s.elementos[el];
    return {
      elementoInterno: el,
      rotulo: r.elemento[el],
      resposta:
        p.status === "respondido" && p.valor !== null
          ? { estado: "respondido", nota: p.valor }
          : { estado: "nao_respondido" },
    };
  });
  return { id, classificacao: "fato_medido", fontes, itens, texto: null };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === "object" && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    for (const v of Object.values(valor as Record<string, unknown>)) congelar(v);
  }
  return valor;
}

/** Cada string que sai para a pessoa: titulos e textos, na ordem. */
export function textosDoParticipante(b: BriefingMarcoZero): string[] {
  const saida: string[] = [];
  for (const a of b.afirmacoes) {
    if (a.texto === null) continue;
    if (a.titulo) saida.push(a.titulo);
    saida.push(a.texto);
  }
  return saida;
}

/** Documento corrido, pronto para renderizar. */
export function textoDoParticipante(b: BriefingMarcoZero): string {
  return textosDoParticipante(b).join("\n\n");
}

export function montarBriefingMarcoZero(
  scores: MarcoZeroScores,
  opcoes?: OpcoesBriefing,
): BriefingMarcoZero {
  const r = resolverRotulos(opcoes);
  const avisos: AvisoBriefing[] = [];

  const likert = destaqueLikert(scores, r, avisos);
  const situacional = destaqueSituacional(scores, r, avisos);
  const distribuicao = distribuicaoSituacional(scores, r, avisos);
  const cruz = cruzamento(scores, likert, situacional, r, avisos);
  const media = mediaElementos(scores);
  const maior = extremo(scores, r, "maior", avisos);
  const menor = extremo(scores, r, "menor", avisos);
  const notas = notasElementos(scores, r);

  const eixosSemRotulo = EIXOS.filter((e) => r.eixo[e] === null);
  if (eixosSemRotulo.length > 0) {
    avisos.unshift({
      codigo: "rotulos_eixos_ausentes",
      descricao: `Sem rotulo valido para: ${eixosSemRotulo.join(", ")}. Os textos descrevem sem nomear esses eixos.`,
    });
  }
  if (r.descartados.length > 0) {
    avisos.unshift({
      codigo: "rotulo_invalido_descartado",
      descricao: `Rotulos descartados por serem invalidos (vazios, longos, com aspas/sublinhado, iguais a chave ou com expressao vetada): ${r.descartados.join(", ")}.`,
    });
  }

  const afirmacoes: Afirmacao[] = [
    likert,
    situacional,
    distribuicao,
    ...cruz,
    media,
    maior,
    menor,
    notas,
  ];

  const briefing: BriefingMarcoZero = {
    versao: 1,
    avisos,
    afirmacoes,
    eixos: {
      likert,
      situacional,
      distribuicaoSituacional: distribuicao,
      cruzamento: cruz,
    },
    elementos: { media, maior, menor, notas },
  };

  // Ultima linha de defesa: nenhuma string vetada sai deste modulo.
  const permitidos = [
    ...EIXOS.flatMap((e) => (r.eixo[e] ? [r.eixo[e] as string] : [])),
    ...ELEMENTOS.map((el) => r.elemento[el]),
  ];
  for (const t of textosDoParticipante(briefing)) {
    const vetadas = encontrarExpressoesVetadas(t);
    const chaves = encontrarChavesVazadas(t, permitidos);
    if (vetadas.length > 0 || chaves.length > 0) {
      throw new Error(
        `Briefing do Marco Zero gerou texto proibido (${[...vetadas, ...chaves].join(", ")}): ${t}`,
      );
    }
  }

  return congelar(briefing);
}

// ---------------------------------------------------------------------------
// Serializacao para prompt de IA
// ---------------------------------------------------------------------------

const DESCRICAO_NEUTRA: Record<IdAfirmacao, string> = {
  "eixos.likert.destaque": "dimensão em destaque na autodescrição",
  "eixos.situacional.destaque": "dimensão em destaque nas escolhas situacionais",
  "eixos.situacional.distribuicao": "distribuição das escolhas situacionais",
  "eixos.cruzamento.contraste": "relação entre autodescrição e escolhas situacionais",
  "eixos.cruzamento.convergencia": "coincidência entre autodescrição e escolhas situacionais",
  "eixos.cruzamento.reflexao": "reflexão sobre a coincidência",
  "eixos.cruzamento.indeterminado": "relação entre autodescrição e escolhas situacionais",
  "elementos.media": "média das notas dos elementos",
  "elementos.maior": "elemento de maior pontuação",
  "elementos.menor": "elemento de menor pontuação",
  "elementos.notas": "notas por elemento",
};

const MOTIVO_NEUTRO: Record<MotivoIndeterminado, string> = {
  empate: "empate no topo",
  margem_insuficiente: "margem insuficiente",
  respostas_incompletas: "respostas faltando",
  algum_instrumento_sem_destaque: "um dos instrumentos não tem destaque",
  elementos_incompletos: "nem todos os elementos foram respondidos",
  elementos_insuficientes: "poucos elementos respondidos",
  empate_no_topo: "empate no topo",
  empate_na_base: "empate na base",
  dados_inconsistentes: "dados inconsistentes",
};

const STATUS_NEUTRO: Record<StatusDoMotor, string> = {
  destacado: "com destaque",
  empate: "empate no topo",
  margem_insuficiente: "margem insuficiente",
  incompleto: "incompleto",
  completo: "completo",
  parcial: "parcial",
  insuficiente: "insuficiente",
};

function descreverFonte(f: Fonte): string {
  const nome =
    f.instrumento === "likert"
      ? "autodescrição"
      : f.instrumento === "situacional"
        ? "escolhas declaradas em situações hipotéticas"
        : "notas dos elementos";
  return `${nome}, ${f.respondidas} de ${f.total} respondidas, situação: ${STATUS_NEUTRO[f.statusDoMotor]}`;
}

const REGRAS_PROMPT = [
  "Tudo abaixo vem de AUTORRELATO. Nada foi observado no comportamento real da pessoa.",
  "Use SOMENTE os fragmentos abaixo. Não acrescente fatos, números, comparações, rankings, diagnósticos nem recomendações.",
  "[FATO MEDIDO]: pode ser escrito como constatação, sempre como algo que a pessoa respondeu ou atribuiu.",
  "[HIPÓTESE A VALIDAR]: escreva como pergunta ou possibilidade para reflexão, nunca como conclusão.",
  "[INDETERMINADO]: não afirme, não sugira e não infira nada sobre o assunto. Dado ausente não é nota baixa.",
  "Se um fragmento não nomeia uma dimensão, não invente nome para ela.",
];

/**
 * Bloco de texto para colocar no prompt. Leva so os fragmentos autorizados,
 * cada um com sua classificacao e sua base, e descreve os indeterminados sem
 * expor valor algum. Nao use JSON.stringify(briefing) no prompt: use esta.
 */
export function briefingParaPrompt(b: BriefingMarcoZero): string {
  const linhas: string[] = ["BRIEFING DO MARCO ZERO", "", ...REGRAS_PROMPT.map((x) => `- ${x}`), ""];
  for (const a of b.afirmacoes) {
    const base = a.fontes.map(descreverFonte).join(" | ");
    if (a.classificacao === "indeterminado") {
      linhas.push(
        `[INDETERMINADO] ${DESCRICAO_NEUTRA[a.id]} (${MOTIVO_NEUTRO[a.motivo]}; base: ${base}). Não afirmar nem inferir.`,
      );
      if (a.texto !== null) {
        linhas.push(`  Texto aprovado para este caso:\n${indentar(a.texto)}`);
      }
      continue;
    }
    if (a.texto === null) continue; // dado so para exibicao
    const tag = a.classificacao === "fato_medido" ? "[FATO MEDIDO]" : "[HIPÓTESE A VALIDAR]";
    const titulo = a.titulo ? `${a.titulo}\n` : "";
    linhas.push(`${tag} (base: ${base})\n${indentar(titulo + a.texto)}`);
  }
  return linhas.join("\n");
}

function indentar(texto: string): string {
  return texto
    .split("\n")
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join("\n");
}
