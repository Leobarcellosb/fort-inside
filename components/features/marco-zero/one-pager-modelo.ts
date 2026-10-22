// Modelo do one-pager individual do Marco Zero: tudo o que o documento diz, ja
// decidido, antes de qualquer pixel. Funcao pura (sem I/O, sem data/hora).
//
// REGRA DE OURO: o texto sobre os dados sai da camada de briefing
// (briefing-marco-zero.ts), nunca do motor. Este modulo so (a) escolhe quais
// fragmentos aprovados mostrar, (b) escreve a moldura (titulos, abertura,
// perguntas para levar, nota de leitura) e (c) repassa dados para as figuras.
//
// Os textos de moldura escritos AQUI estao todos em `TEXTOS_MOLDURA`, para a
// metodologia revisar num lugar so. Toda string do documento passa pelo
// verificador da camada de briefing antes de sair; se alguma for vetada, a
// montagem LANCA em vez de entregar o documento.

import {
  EIXOS,
  type Eixo,
  type MarcoZeroScores,
} from "../../../lib/scoring/marco-zero";
import {
  montarBriefingMarcoZero,
  type BriefingMarcoZero,
} from "../../../lib/scoring/briefing-marco-zero";
import { exigirTextosDeSaidaValidos } from "./validacao-saida";
import {
  CATALOGO_DIMENSOES,
  ROTULOS_EIXOS_MARCO_ZERO,
  dimensaoDoEixo,
  rotuloDaDimensao,
  type RotuloDimensao,
} from "./catalogo-dimensoes";

// ---------------------------------------------------------------------------
// Textos de moldura (escritos para o one-pager; revisao da metodologia)
// ---------------------------------------------------------------------------

export const TEXTOS_MOLDURA = {
  eyebrow: "Marco Zero",
  seloRevisao: "Versão para revisão · rótulos funcionais, pendentes de ratificação",
  titulo: "Seu ponto de partida",
  abertura:
    "Obrigado por responder com calma. Veja o que as suas respostas mostram e o que elas não permitem afirmar.",
  tituloAutodescricao: "Como você se descreve",
  // Textos DEFINIDOS pelo responsavel pela metodologia (nao sao meus):
  introAutodescricao:
    "As respostas às 24 afirmações mostram como você percebe suas próprias características nas quatro dimensões. Quando houver destaque válido, ele será identificado aqui pelo nome.",
  tituloSituacional: "Suas escolhas hipotéticas",
  introSituacional:
    "As seis situações mostram quais dimensões foram favorecidas em suas escolhas declaradas. Quando houver margem suficiente, a dimensão correspondente será nomeada.",
  tituloRefletir: "Para refletir",
  // Escritos por mim:
  legendaDestaque: "Dimensão em destaque",
  mancheteSemDestaque: "Sem destaque entre as dimensões",
  mancheteIncompleto: "Não foi possível destacar uma dimensão",
  legendaPontos: "Cada ponto é uma das suas escolhas.",
  tituloCruzamento: "Entre as duas leituras",
  legendaDuasLeituras: "Nas duas leituras",
  tituloElementos: "Os sete elementos",
  legendaElementos:
    "Notas de 0 a 10 que você atribuiu. Elemento sem resposta fica vazio: não é nota zero.",
  semResposta: "sem resposta",
  rotuloMaior: "Maior pontuação atribuída",
  rotuloMenor: "Menor pontuação atribuída",
  tituloDimensoes: "As quatro dimensões avaliadas",
  perguntaConfirmou:
    "Qual parte desta leitura confirmou o que você já pensava sobre si, e qual parte te surpreendeu?",
  perguntaConversa:
    "Quem conhece você bem reconheceria o que está aqui? Vale levar esta página para uma conversa.",
  fechamentoRefletir: "Não há resposta certa. As perguntas são um convite.",
  notaDeLeitura:
    "Como ler este documento: tudo aqui vem das suas próprias respostas (autorrelato) e nada foi observado no que você faz na prática. As dimensões descrevem o que você declara e não classificam quem você é; este documento não é um diagnóstico.",
} as const;

/** Pergunta condicionada a existir o elemento de menor pontuacao apresentavel. */
function perguntaSobreNota(rotulo: string): string {
  return `A nota que você deu a “${rotulo}” é onde você quer estar hoje, ou é algo que gostaria de mudar?`;
}

// ---------------------------------------------------------------------------
// Tipos do modelo
// ---------------------------------------------------------------------------

export interface MetaOnePager {
  nomeParticipante: string;
  nomeEvento?: string | null;
  /** ISO "AAAA-MM-DD" (ou ISO completo). Opcional. */
  dataEvento?: string | null;
}

export interface BlocoAutodescricao {
  titulo: string;
  intro: string;
  legendaDestaque: string;
  /** Presente so quando o motor destacou um eixo E a camada validou. */
  destaque: { rotulo: RotuloDimensao } | null;
  /** Manchete quando nao ha destaque. Nunca presente junto com `destaque`. */
  manchete: string | null;
  /** Texto aprovado da camada de briefing; null quando nao ha o que dizer. */
  texto: string | null;
}

export interface PontosEixo {
  rotulo: RotuloDimensao;
  /** Quantas das escolhas declaradas cairam neste eixo. */
  contagem: number;
  /** Somente quando ha destaque validado nas situacionais. */
  destacado: boolean;
}

export interface BlocoSituacional {
  titulo: string;
  intro: string;
  /** null quando nao ha distribuicao confiavel (nenhuma respondida etc.). */
  pontos: { eixos: readonly PontosEixo[]; total: number; legenda: string } | null;
  /** Paragrafos aprovados da camada. */
  paragrafos: readonly string[];
}

export interface BlocoCruzamento {
  tipo: "contraste" | "convergencia";
  titulo: string;
  rotuloAutodescricao: RotuloDimensao;
  rotuloEscolhas: RotuloDimensao;
  /** Contraste: um unico texto. Convergencia: constatacao + pergunta. */
  paragrafos: readonly string[];
}

export interface NotaDoElemento {
  rotulo: string;
  /** null = nao respondido (nunca 0). */
  nota: number | null;
}

export interface BlocoElementos {
  titulo: string;
  legenda: string;
  /** Sempre na ordem do questionario, nunca ordenado por valor. null = sem tabela. */
  notas: readonly NotaDoElemento[] | null;
  /** Aviso aprovado quando ha poucos elementos respondidos (explica a ausencia de tabela). */
  textoAviso: string | null;
  maior: { rotulo: string; texto: string } | null;
  menor: { rotulo: string; texto: string } | null;
  semResposta: string;
}

export interface OnePagerModelo {
  cabecalho: {
    eyebrow: string;
    titulo: string;
    nome: string;
    linhaEvento: string | null;
    /** Visivel enquanto o catalogo nao esta ratificado; null depois. */
    selo: string | null;
  };
  abertura: string;
  autodescricao: BlocoAutodescricao;
  situacional: BlocoSituacional;
  cruzamento: BlocoCruzamento | null;
  elementos: BlocoElementos;
  paraRefletir: { titulo: string; perguntas: readonly string[]; fechamento: string };
  dimensoes: {
    titulo: string;
    itens: readonly { rotulo: RotuloDimensao; definicao: string }[];
  };
  notaDeLeitura: string;
  /** Versao do catalogo de dimensoes usado (rastreabilidade). */
  catalogoVersao: string;
  catalogoEstado: string;
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function formatarData(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const mes = MESES[Number(m[2]) - 1];
  if (!mes) return null;
  return `${Number(m[3])} de ${mes} de ${m[1]}`;
}

function linhaEvento(meta: MetaOnePager): string | null {
  const partes = [meta.nomeEvento?.trim() || null, formatarData(meta.dataEvento)].filter(
    (p): p is string => p !== null,
  );
  return partes.length > 0 ? partes.join("  ·  ") : null;
}

function paragrafos(texto: string | null): string[] {
  return texto === null ? [] : texto.split("\n\n").filter((p) => p.length > 0);
}

export function montarModeloOnePager(
  scores: MarcoZeroScores,
  meta: MetaOnePager,
): OnePagerModelo {
  const briefing: BriefingMarcoZero = montarBriefingMarcoZero(scores, {
    rotulosEixos: ROTULOS_EIXOS_MARCO_ZERO,
  });
  const { likert, situacional, distribuicaoSituacional, cruzamento } = briefing.eixos;
  const rotuloEixo = (e: Eixo): RotuloDimensao => rotuloDaDimensao(e);

  // --- Autodescricao (Likert) ---------------------------------------------
  let autodescricao: BlocoAutodescricao;
  if (likert.classificacao === "fato_medido") {
    autodescricao = {
      titulo: TEXTOS_MOLDURA.tituloAutodescricao,
      intro: TEXTOS_MOLDURA.introAutodescricao,
      legendaDestaque: TEXTOS_MOLDURA.legendaDestaque,
      destaque: { rotulo: rotuloEixo(likert.eixoInterno) },
      manchete: null,
      texto: likert.texto,
    };
  } else {
    autodescricao = {
      titulo: TEXTOS_MOLDURA.tituloAutodescricao,
      intro: TEXTOS_MOLDURA.introAutodescricao,
      legendaDestaque: TEXTOS_MOLDURA.legendaDestaque,
      destaque: null,
      manchete:
        likert.motivo === "respostas_incompletas"
          ? TEXTOS_MOLDURA.mancheteIncompleto
          : TEXTOS_MOLDURA.mancheteSemDestaque,
      texto: likert.texto,
    };
  }

  // --- Cruzamento ----------------------------------------------------------
  let bloco: BlocoCruzamento | null = null;
  const contraste = cruzamento.find((c) => c.id === "eixos.cruzamento.contraste");
  const convergencia = cruzamento.find((c) => c.id === "eixos.cruzamento.convergencia");
  const reflexao = cruzamento.find((c) => c.id === "eixos.cruzamento.reflexao");
  if (
    contraste &&
    contraste.id === "eixos.cruzamento.contraste" &&
    situacional.classificacao === "fato_medido"
  ) {
    bloco = {
      tipo: "contraste",
      titulo: TEXTOS_MOLDURA.tituloCruzamento,
      rotuloAutodescricao: rotuloEixo(contraste.eixoAutodescricaoInterno),
      rotuloEscolhas: rotuloEixo(contraste.eixoEscolhasInterno),
      paragrafos: [contraste.texto],
    };
  } else if (convergencia && convergencia.id === "eixos.cruzamento.convergencia") {
    bloco = {
      tipo: "convergencia",
      titulo: TEXTOS_MOLDURA.tituloCruzamento,
      rotuloAutodescricao: rotuloEixo(convergencia.eixoInterno),
      rotuloEscolhas: rotuloEixo(convergencia.eixoInterno),
      paragrafos: [convergencia.texto, ...(reflexao ? [reflexao.texto] : [])],
    };
  }

  // O texto do cruzamento ja contem a constatacao da autodescricao (no
  // contraste, repete a frase literalmente; na convergencia, a cobre): nao se
  // escreve duas vezes. O rotulo destacado continua na manchete.
  if (
    bloco !== null &&
    autodescricao.texto !== null &&
    (bloco.tipo === "convergencia" ||
      bloco.paragrafos[0].startsWith(autodescricao.texto))
  ) {
    autodescricao = { ...autodescricao, texto: null };
  }

  // --- Situacionais --------------------------------------------------------
  const destacadoSit =
    situacional.classificacao === "fato_medido" ? situacional.eixoInterno : null;
  const pontos: BlocoSituacional["pontos"] =
    distribuicaoSituacional.classificacao === "fato_medido"
      ? {
          // `itens` ja vem na ordem fixa de EIXOS (nunca ordenado por valor).
          eixos: distribuicaoSituacional.itens.map((i) => ({
            rotulo: rotuloEixo(i.eixoInterno),
            contagem: i.contagem,
            destacado: i.eixoInterno === destacadoSit,
          })),
          total: distribuicaoSituacional.respondidas,
          legenda: TEXTOS_MOLDURA.legendaPontos,
        }
      : null;
  const blocoSituacional: BlocoSituacional = {
    titulo: TEXTOS_MOLDURA.tituloSituacional,
    intro: TEXTOS_MOLDURA.introSituacional,
    pontos,
    paragrafos: paragrafos(situacional.texto),
  };

  // --- Elementos -----------------------------------------------------------
  // A media (briefing.elementos.media) nao entra no one-pager quando e fato
  // medido (ver relatorio); so o aviso de "poucos elementos respondidos" entra.
  const { media, maior, menor, notas } = briefing.elementos;
  const blocoElementos: BlocoElementos = {
    titulo: TEXTOS_MOLDURA.tituloElementos,
    legenda: TEXTOS_MOLDURA.legendaElementos,
    notas:
      notas.classificacao === "fato_medido"
        ? notas.itens.map((i) => ({
            rotulo: i.rotulo,
            nota: i.resposta.estado === "respondido" ? i.resposta.nota : null,
          }))
        : null,
    textoAviso: media.classificacao === "indeterminado" ? media.texto : null,
    maior:
      maior.classificacao === "fato_medido"
        ? { rotulo: maior.rotulo, texto: maior.texto }
        : null,
    menor:
      menor.classificacao === "fato_medido"
        ? { rotulo: menor.rotulo, texto: menor.texto }
        : null,
    semResposta: TEXTOS_MOLDURA.semResposta,
  };

  // --- Para levar ----------------------------------------------------------
  const perguntas: string[] = [
    TEXTOS_MOLDURA.perguntaConfirmou,
    TEXTOS_MOLDURA.perguntaConversa,
  ];
  if (menor.classificacao === "fato_medido") {
    perguntas.splice(1, 0, perguntaSobreNota(menor.rotulo));
  }

  const modelo: OnePagerModelo = {
    cabecalho: {
      eyebrow: TEXTOS_MOLDURA.eyebrow,
      titulo: TEXTOS_MOLDURA.titulo,
      nome: meta.nomeParticipante.trim(),
      linhaEvento: linhaEvento(meta),
      selo:
        CATALOGO_DIMENSOES.estado === "ratificado" ? null : TEXTOS_MOLDURA.seloRevisao,
    },
    abertura: TEXTOS_MOLDURA.abertura,
    autodescricao,
    situacional: blocoSituacional,
    cruzamento: bloco,
    elementos: blocoElementos,
    paraRefletir: {
      titulo: TEXTOS_MOLDURA.tituloRefletir,
      perguntas,
      fechamento: TEXTOS_MOLDURA.fechamentoRefletir,
    },
    dimensoes: {
      titulo: TEXTOS_MOLDURA.tituloDimensoes,
      itens: EIXOS.map((e) => ({
        rotulo: dimensaoDoEixo(e).rotulo,
        definicao: dimensaoDoEixo(e).definicao,
      })),
    },
    notaDeLeitura: TEXTOS_MOLDURA.notaDeLeitura,
    catalogoVersao: CATALOGO_DIMENSOES.versao,
    catalogoEstado: CATALOGO_DIMENSOES.estado,
  };

  verificarModelo(modelo);
  return modelo;
}

// ---------------------------------------------------------------------------
// Verificacao do texto final
// ---------------------------------------------------------------------------

/**
 * TODA string que o documento mostra ao participante, exceto os dados que a
 * pessoa/o evento forneceram (nome, evento, data). Inclui os rotulos exibidos
 * nas figuras, para que nada fora do verificador chegue ao papel.
 */
export function textosDoOnePager(m: OnePagerModelo): string[] {
  const t: string[] = [
    m.cabecalho.eyebrow,
    m.cabecalho.titulo,
    ...(m.cabecalho.selo ? [m.cabecalho.selo] : []),
    m.abertura,
    m.autodescricao.titulo,
    m.autodescricao.intro,
  ];
  if (m.autodescricao.destaque) {
    t.push(m.autodescricao.legendaDestaque, m.autodescricao.destaque.rotulo);
  }
  if (m.autodescricao.manchete) t.push(m.autodescricao.manchete);
  if (m.autodescricao.texto) t.push(m.autodescricao.texto);

  t.push(m.situacional.titulo, m.situacional.intro);
  if (m.situacional.pontos) {
    for (const e of m.situacional.pontos.eixos) t.push(e.rotulo);
    t.push(m.situacional.pontos.legenda);
  }
  t.push(...m.situacional.paragrafos);

  if (m.cruzamento) {
    t.push(
      m.cruzamento.titulo,
      TEXTOS_MOLDURA.legendaDuasLeituras,
      m.cruzamento.rotuloAutodescricao,
      m.cruzamento.rotuloEscolhas,
      ...m.cruzamento.paragrafos,
    );
  }

  t.push(m.elementos.titulo, m.elementos.legenda, m.elementos.semResposta);
  for (const n of m.elementos.notas ?? []) t.push(n.rotulo);
  if (m.elementos.textoAviso) t.push(m.elementos.textoAviso);
  if (m.elementos.maior) t.push(TEXTOS_MOLDURA.rotuloMaior, m.elementos.maior.texto);
  if (m.elementos.menor) t.push(TEXTOS_MOLDURA.rotuloMenor, m.elementos.menor.texto);

  t.push(m.paraRefletir.titulo, ...m.paraRefletir.perguntas, m.paraRefletir.fechamento);
  t.push(m.dimensoes.titulo);
  for (const d of m.dimensoes.itens) t.push(d.rotulo, d.definicao);
  t.push(m.notaDeLeitura);
  return t;
}

/** Valida o texto final do documento (validacao de saida). Lanca se recusar. */
export function verificarModelo(m: OnePagerModelo): void {
  exigirTextosDeSaidaValidos(textosDoOnePager(m));
}
