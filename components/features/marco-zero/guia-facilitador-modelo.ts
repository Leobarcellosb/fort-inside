// Guia de Preparacao do Facilitador do Marco Zero: o que o host recebe quando o
// evento NAO tem DNA Coletivo quantitativo. Decisao do CTO, nas palavras dele:
// "Para grupos pequenos, teremos um Guia de Preparacao do Facilitador, nao um
// DNA Coletivo reduzido. Ele tera outro objetivo: ajudar o Yuri a conduzir a
// experiencia, sem fazer afirmacoes estatisticas sobre os presentes."
//
// Funcao PURA, igual ao modulo do DNA: sem entrada e saida, sem relogio. A
// pureza e o que sustenta o hash do conteudo (o mesmo grupo produz sempre o
// mesmo guia, e qualquer mudanca de conteudo muda o hash).
//
// A TRAVA ANTI-CONTORNO, tambem nas palavras do CTO: "Nao usaremos esse guia
// para contornar o piso de privacidade. Se uma informacao nao poderia aparecer
// no DNA por risco de identificacao, nao podera reaparecer disfarcada de
// sintese coletiva." Aqui ela e MECANICA, em quatro camadas independentes:
//
//   1. CANAL ESTREITO (estrutural, cobrado pelo compilador). O guia e montado
//      por `montarGuia`, que recebe `ParticipacaoVerificada` -- oito contagens
//      de PARTICIPACAO -- e mais nada. Nenhum `Agregado`, nenhum `scores`,
//      nenhuma `MarcoZeroScores` chega ao texto: a distribuicao por dimensao, o
//      cruzamento entre as duas leituras e as medias dos elementos nao estao ao
//      alcance da funcao que escreve. Nao ha o que suprimir porque nao ha o que
//      vazar.
//   2. O MESMO VARREDOR DO DNA (`exigirTextosColetivosValidos`), sem versao
//      propria e sem lista de aprovados: afirmacao universal, grupo/sala como
//      sujeito, quantificador sobre o conjunto, representatividade, afirmacao
//      sobre quem nao respondeu e identificacao de participante. O guia que nao
//      passa nao e entregue: a montagem LANCA.
//   3. VOCABULARIO DE RETRATO (`exigirGuiaSemRetratoColetivo`). O guia nao
//      nomeia dimensao nem elemento, em lugar nenhum, com numero ou sem. Sem o
//      vocabulario do instrumento nao existe frase que reconstrua o que o DNA
//      suprimiu -- e, de lambuja, o guia nao depende da ratificacao dos rotulos
//      (`assertPublicavel`), que ainda nao aconteceu.
//   4. NUMEROS VERIFICADOS (`exigirNumerosVerificados`). Os unicos digitos do
//      guia sao as contagens de participacao. Fora da secao de participacao e
//      do nome do evento, o texto nao tem digito algum -- os numeros da
//      metodologia (piso, cobertura minima, volume minimo) nem aparecem, e
//      contagem de pessoas por caracteristica nao tem onde se esconder.
//
// O PONTO DIFICIL, que e a razao de o guia existir: ele fala do grupo sem fazer
// afirmacao sobre o grupo. "A sala tem dificuldade com prioridades" e uma
// afirmacao estatistica sobre pessoas identificaveis, e o varredor a recusa.
// "Pergunte a sala como cada um decide prioridades quando tudo parece urgente"
// convida a propria pessoa a revelar, e passa. Toda a secao de preparacao esta
// do segundo lado, e e REDACAO FIXA: identica para qualquer evento deste
// formato, nao escolhida a partir das respostas recebidas. Isso e testavel, e
// esta testado: dois grupos com respostas opostas produzem a mesma secao.
//
// O QUE O GUIA NAO FAZ. Nao substitui o DNA Coletivo, nao estima o que o DNA
// diria, nao traz os ids de quem falta (isso e o relatorio operacional) e nao
// decide nenhum limiar: quem decide se existe DNA e `gerarDnaColetivo`, que
// este modulo CHAMA em vez de reimplementar.
//
// A EXCLUSIVIDADE, e o que mudou nela. A regra antiga recusava o guia quando
// `gerarDnaColetivo` devolvia um RASCUNHO -- isto e, quando o DNA era apenas
// GERAVEL. A revisao derrubou isso, e com razao: um rascunho e um documento que
// ninguem recebeu. "Esta gerado e aguardando revisao", "indisponivel" e
// "invalidado" sao tres situacoes em que o facilitador ainda precisa ser
// preparado, e a mera existencia do registro nao pode tirar dele o guia.
//
// A regra VIGENTE, nas palavras da revisao: o guia nao pode ser publicado como
// alternativa simultanea a um DNA VALIDO, REVISADO e DISPONIBILIZADO para o
// mesmo conjunto de dados. O que aciona a recusa, portanto, nao e "existe um
// DNA" e sim "existe um DNA PUBLICADO". Rascunho nao e publicacao.
//
// COMO ESSE ESTADO CHEGA AQUI -- o mesmo desenho do gate de volume do DNA, e
// pelo mesmo motivo. O estado da revisao e da disponibilizacao do DNA mora no
// BANCO, e este modulo e funcao PURA, sem I/O e sem relogio: a pureza e o que
// sustenta o hash do conteudo e o canal estreito de oito numeros. Entao o
// veredito e INJETADO, calculado fora, em `EntradaGuia.publicacaoDoDna`, que e
// campo OBRIGATORIO de proposito -- o compilador cobra a decisao de cada
// chamador e nao existe valor-padrao que signifique "nao publicado".
//
// O CANAL NAO ALARGOU. O veredito e um discriminante (`estado`) mais um boolean
// (`publicado`) ou um motivo de enum. Nao carrega resposta, score, agregado nem
// contagem, e NAO chega a `montarGuia`: ele decide se o guia sai, e nao o que o
// guia diz. `montarGuia` continua recebendo as oito contagens de participacao,
// um motivo de enum e o nome do evento -- e o teste de invariancia (dois grupos
// com conteudo de resposta oposto, texto identico byte a byte e mesmo hash)
// continua valendo, porque nada do conteudo das respostas passou a influir.
//
// INDISPONIBILIDADE, a distincao que vale em todo este projeto: "nao consegui
// saber o estado do DNA" NAO e "nao ha DNA publicado". O primeiro e
// indisponibilidade e RECUSA o guia (`estado_do_dna_indeterminado`); so o
// segundo o libera. Falha de consulta nunca vira ausencia.
//
// O GUIA SEM LISTA DE CONVIDADOS (decisao do CTO, Rodada 69). Sem lista de
// convidados consolidada, o guia era recusado. Agora ele sai NEUTRO: o total de
// convidados chega como `null` (populacao NAO VERIFICADA, nunca estimativa) e o
// texto diz isso. Sem denominador valido nao ha "sem resposta" derivado de
// total, nao ha cobertura e nao ha proporcao alguma; ficam as contagens que de
// fato existem (respostas completas e iniciadas, presenca so com o check-in
// fechado, liberacoes). O canal continua com as MESMAS oito chaves: o que mudou
// e que duas delas (`convidados` e `semRespostaRegistrada`) passam a admitir
// `null`, do mesmo jeito que `presentes` ja admitia.
//
// "Lista ausente" e informacao desconhecida e e decidida por quem le o banco
// (`lib/marco-zero/entrada-do-guia.ts`); "nao consegui ler o banco" continua
// sendo indisponibilidade e nunca chega aqui como `null`. Com a lista
// consolidada, nada muda: mesmo texto e mesmo hash para a mesma entrada.

import { createHash } from "node:crypto";
import { ELEMENTOS } from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import { ROTULOS_DIMENSAO } from "./catalogo-dimensoes";
import {
  DadosInconsistentesDna,
  agregar,
  situacaoDe,
  type ParticipanteDna,
} from "./dna-coletivo-agregacao";
import {
  gerarDnaColetivo,
  type BlocoDna,
  type EntradaDna,
  type LinhaDna,
  type MetaDna,
  type MotivoRelatorio,
  type ParteDna,
} from "./dna-coletivo-modelo";
import { exigirTextosColetivosValidos } from "./dna-coletivo-validacao";

// ---------------------------------------------------------------------------
// Cabecalho e moldura (textos escritos aqui; revisao da metodologia)
// ---------------------------------------------------------------------------

export const TEXTOS_GUIA = {
  eyebrow: "Marco Zero",
  /** Cabecalho escrito pelo CTO, palavra por palavra. */
  restricao: "MARCO ZERO — MATERIAL RESTRITO AO FACILITADOR",
  titulo: "Guia de Preparação do Facilitador",
  abertura:
    "Este material é seu, para preparar a condução. Ele não descreve as pessoas que estarão na sala: traz a participação verificada, sugestões de pergunta e de atividade que fazem cada pessoa falar por si, e o caminho para abrir as leituras individuais liberadas.",
  tituloParticipacao: "Participação verificada",
  tituloSemDna: "Por que não há DNA Coletivo neste evento",
  tituloPreparacao: "Preparação da condução",
  tituloLeituras: "Leituras individuais",
  tituloLimites: "Limites deste guia",
  notaDeLeitura:
    "Como ler este guia: a seção de participação vem de contagem verificada, e a seção de preparação é redação fixa, igual para qualquer evento deste formato. Não há interpretação por modelo de IA, não há resposta aberta e não há conteúdo das respostas individuais.",
} as const;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * CANAL ESTREITO. Tudo o que a montagem do guia sabe sobre este evento. Oito
 * contagens de PARTICIPACAO e o nome do evento -- nada sobre o conteudo das
 * respostas. Acrescentar um campo aqui e abrir o canal, e o teste de estrutura
 * quebra de proposito quando isso acontece.
 *
 * As TRES POPULACOES sao nomeadas separadamente e nunca se substituem:
 * convidados (quem foi chamado), presentes (quem esteve no dia, e so existe com
 * o check-in fechado) e respondentes (quem entregou a leitura completa).
 */
export interface ParticipacaoVerificada {
  /**
   * Convidados: quem foi chamado. Informado por quem organiza. `null` quer dizer
   * populacao de convidados NAO VERIFICADA (nao ha lista consolidada): o guia
   * diz isso em vez de imprimir um total, e nada e derivado dele.
   */
  convidados: number | null;
  /** Respostas completas recebidas, de convidados, independente de presença. */
  respostasCompletas: number;
  /** Respostas iniciadas e não concluídas. */
  respostasIncompletas: number;
  /**
   * Convidados menos as respostas recebidas (completas e incompletas). `null`
   * quando `convidados` e `null`: sem denominador nao ha subtracao.
   */
  semRespostaRegistrada: number | null;
  /**
   * Presentes: só existe depois do check-in fechado. `null` quer dizer
   * população ainda não verificada, e o guia diz isso em vez de imprimir um
   * número no lugar dela.
   */
  presentes: number | null;
  /** Respostas completas de quem esteve presente. `null` sem check-in fechado. */
  respostasCompletasDePresentes: number | null;
  /** Leituras individuais liberadas pela própria pessoa, com resposta registrada. */
  leiturasIndividuaisLiberadas: number;
  /** Liberações de leitura de quem não deixou resposta: não há documento. */
  liberacoesSemRespostaRegistrada: number;
}

/** As chaves que o canal estreito admite. Fonte do teste de estrutura. */
export const CAMPOS_DE_PARTICIPACAO = [
  "convidados",
  "respostasCompletas",
  "respostasIncompletas",
  "semRespostaRegistrada",
  "presentes",
  "respostasCompletasDePresentes",
  "leiturasIndividuaisLiberadas",
  "liberacoesSemRespostaRegistrada",
] as const;

/** Liberação declarada pela própria pessoa para o facilitador ler o documento dela. */
export interface AutorizacaoDeLeitura {
  /** Id do participante. NUNCA entra no texto do guia. */
  participanteId: string;
  autorizado: boolean;
}

// ---------------------------------------------------------------------------
// Veredito de PUBLICACAO do DNA (injetado; ver o cabecalho do arquivo)
// ---------------------------------------------------------------------------

/**
 * Causas previstas de nao se saber o estado de publicacao do DNA. Conjunto
 * FECHADO: cada uma tem texto proprio, e nenhum codigo cru de banco vaza.
 */
export type MotivoPublicacaoIndeterminada =
  /** A leitura do registro de disponibilizacao nao respondeu. */
  | "consulta_nao_respondeu"
  /** A linha veio em forma inesperada (sem o veredito, ou com tipo errado). */
  | "registro_ilegivel"
  /**
   * Ha disponibilizacao registrada e NAO se sabe se a aprovacao daquele
   * fechamento continua valendo (os sinais de invalidacao nao vieram).
   */
  | "invalidacao_indeterminada";

/**
 * O veredito. `publicado: true` quer dizer, e so quer dizer: existe um DNA
 * Coletivo VALIDO, REVISADO e DISPONIBILIZADO para ESTE conjunto de dados.
 * Estabelecer isso e trabalho de quem tem o banco -- exatamente como no gate de
 * volume, onde quem tem o cliente do banco traduz a linha oficial.
 */
export type PublicacaoDoDna =
  | { estado: "verificado"; publicado: boolean }
  | { estado: "indeterminado"; motivo: MotivoPublicacaoIndeterminada };

/**
 * Forma minima do registro de disponibilizacao que o tradutor consome. Quem
 * chama passa `null` quando a consulta nao respondeu.
 *
 * `liberado` e o fato "houve revisao metodologica aprovada e o documento foi
 * disponibilizado". Os dois outros campos sao os sinais de CADUCIDADE que o
 * banco publica (`marco_zero_cobertura.aprovacao_invalidada` e
 * `invalidacoes_pendentes`, migration 020): correcao de presenca ou de
 * elegibilidade depois do fechamento invalida a aprovacao e o hash do DNA
 * daquele fechamento -- e DNA invalidado nao e DNA publicado.
 */
export interface RegistroDePublicacaoDoDna {
  liberado: boolean | null;
  aprovacaoInvalidada: boolean | null;
  invalidacoesPendentes: number | null;
}

/**
 * Traduz o registro para o veredito. Qualquer forma inesperada fecha a porta:
 * vira indeterminacao, nunca "nao publicado" -- publicar o guia por omissao
 * seria o mesmo erro que publicar o DNA por omissao.
 *
 * Quando `liberado === false` nao se pergunta pela invalidacao: nao ha o que
 * invalidar, e exigir o sinal faria o guia depender de um dado irrelevante.
 */
export function publicacaoDoDnaDoRegistro(
  registro: RegistroDePublicacaoDoDna | null | undefined,
): PublicacaoDoDna {
  if (registro === null || registro === undefined || typeof registro !== "object") {
    return { estado: "indeterminado", motivo: "consulta_nao_respondeu" };
  }
  if (typeof registro.liberado !== "boolean") {
    return { estado: "indeterminado", motivo: "registro_ilegivel" };
  }
  if (!registro.liberado) return { estado: "verificado", publicado: false };
  if (
    typeof registro.aprovacaoInvalidada !== "boolean" ||
    !Number.isInteger(registro.invalidacoesPendentes) ||
    (registro.invalidacoesPendentes as number) < 0
  ) {
    return { estado: "indeterminado", motivo: "invalidacao_indeterminada" };
  }
  const caducou =
    registro.aprovacaoInvalidada || (registro.invalidacoesPendentes as number) > 0;
  return { estado: "verificado", publicado: !caducou };
}

/**
 * A entrada do DNA Coletivo como o guia a recebe: igual a `EntradaDna`, com uma
 * diferenca so. `convidados` pode ser `null`, que quer dizer populacao de
 * convidados NAO VERIFICADA (o evento nao tem lista consolidada). `null` e
 * desconhecido, e nao zero nem estimativa; falha de leitura do banco NAO chega
 * aqui como `null` (quem le o banco recusa antes).
 */
export type EntradaDnaDoGuia = Omit<EntradaDna, "convidados"> & {
  convidados: number | null;
};

export interface EntradaGuia {
  /** A mesma entrada do DNA Coletivo: quem decide o limiar é o módulo do DNA. */
  dna: EntradaDnaDoGuia;
  /**
   * Veredito do estado de publicacao do DNA Coletivo deste conjunto de dados.
   *
   * OBRIGATORIO de proposito, igual a `EntradaDna.gateDeVolume`: o compilador
   * cobra a decisao de cada chamador, e nao existe valor-padrao que signifique
   * "nao publicado". Sem veredito utilizavel o guia NAO e gerado.
   */
  publicacaoDoDna: PublicacaoDoDna;
  autorizacoes?: readonly AutorizacaoDeLeitura[];
}

export interface GuiaDoFacilitador {
  cabecalho: {
    eyebrow: string;
    restricao: string;
    titulo: string;
    linhaEvento: string | null;
  };
  abertura: string;
  participacao: BlocoDna;
  semDna: BlocoDna;
  preparacao: BlocoDna;
  leituras: BlocoDna;
  limites: BlocoDna;
  notaDeLeitura: string;
  /** As contagens, para quem consome o modelo sem reler o texto. */
  populacoes: ParticipacaoVerificada;
  /**
   * Ids liberados, FORA do texto (como `pendentes` no relatório operacional do
   * DNA): o varredor recusaria identificador dentro do texto.
   */
  acessoIndividual: { idsLiberados: readonly string[] };
  /** Motivo de não existir DNA Coletivo PUBLICADO aqui. */
  motivoSemDna: MotivoSemDnaPublicado;
}

/**
 * Por que este evento nao tem DNA Coletivo PUBLICADO. Os motivos de limiar vem
 * do modulo do DNA (`MotivoRelatorio`) e nao sao reimplementados aqui; o unico
 * acrescimo e o caso novo que a revisao abriu: o DNA e geravel, existe em
 * rascunho, e nao foi disponibilizado.
 *
 * Todos sao strings de enum, sem numero: e por isso que este tipo pode atravessar
 * o canal estreito ate `montarGuia`.
 */
export type MotivoSemDnaPublicado =
  | MotivoRelatorio
  | "dna_nao_publicado"
  /**
   * Os limiares nao recusariam o DNA, e a populacao de convidados nao foi
   * verificada: sem ela o DNA Coletivo nao tem a participacao sobre quem foi
   * chamado, e por isso nao e gerado. Nao se diz "DNA gerado" sobre um
   * documento cujo denominador nao existe.
   */
  | "convidados_nao_verificados";

export type MotivoSemGuia =
  /** Ha DNA valido, revisado e disponibilizado para este conjunto de dados. */
  | "dna_publicado"
  /** NAO se sabe o estado de publicacao do DNA. Nao e "nao ha DNA publicado". */
  | "estado_do_dna_indeterminado"
  | "dados_inconsistentes";

export type ResultadoGuia =
  | { tipo: "guia_do_facilitador"; guia: GuiaDoFacilitador; conteudoSha256: string }
  | {
      tipo: "guia_nao_gerado";
      motivo: MotivoSemGuia;
      paragrafos: readonly string[];
      acoes: readonly string[];
    };

// ---------------------------------------------------------------------------
// Camada 3: vocabulario de retrato
// ---------------------------------------------------------------------------

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Rotulos do instrumento. Nomear um deles no guia seria abrir a porta para a
 * frase que o DNA recusou ("tal dimensao, tantas pessoas"); por isso o guia nao
 * nomeia dimensao nem elemento em lugar nenhum, com numero ou sem.
 */
const ROTULOS_DO_INSTRUMENTO: readonly string[] = [
  ...ROTULOS_DIMENSAO,
  ...ELEMENTOS.map((el) => ROTULOS_ELEMENTOS_PADRAO[el]),
];

/** Palavras que anunciam retrato coletivo mesmo sem nomear rotulo. */
const VOCABULARIO_DE_RETRATO: readonly { id: string; padrao: RegExp }[] = [
  { id: "percentual", padrao: /%|\bpor\s*cento\b|\bpercentuais\b/ },
  { id: "media", padrao: /\bmedia\b|\bmedias\b/ },
  { id: "distribuicao", padrao: /\bdistribuicao\b|\bdistribuicoes\b|\bproporcao\s+de\s+pessoas\b/ },
  { id: "quantificador_solto", padrao: /\bmaioria\b|\bminoria\b|\bmetade\b|\bmaior\s+parte\b/ },
  { id: "dimensao_nomeada", padrao: /\b(dimensao|dimensoes|eixo|eixos)\b/ },
];

export interface RecusaDeRetrato {
  motivo: string;
  detalhe: string;
}

/** Devolve as recusas de vocabulário de retrato de UM texto (vazio = limpo). */
export function encontrarRetratoColetivo(texto: string): RecusaDeRetrato[] {
  const norm = normalizar(texto);
  const recusas: RecusaDeRetrato[] = [];
  for (const r of ROTULOS_DO_INSTRUMENTO) {
    if (norm.includes(normalizar(r))) {
      recusas.push({ motivo: "rotulo_do_instrumento", detalhe: r });
    }
  }
  for (const v of VOCABULARIO_DE_RETRATO) {
    const m = v.padrao.exec(norm);
    if (m) recusas.push({ motivo: v.id, detalhe: m[0] });
  }
  return recusas;
}

/** Lança se algum texto trouxer vocabulário de retrato coletivo. */
export function exigirGuiaSemRetratoColetivo(textos: readonly string[]): void {
  for (const t of textos) {
    const recusas = encontrarRetratoColetivo(t);
    if (recusas.length > 0) {
      throw new Error(
        `Texto do Guia do Facilitador recusado (${recusas
          .map((r) => `${r.motivo}: ${r.detalhe}`)
          .join(", ")}): ${t}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Camada 4: numeros verificados
// ---------------------------------------------------------------------------

export function numerosDoTexto(texto: string): string[] {
  return [...texto.matchAll(/\d+/g)].map((m) => m[0]);
}

/**
 * Os unicos digitos do guia sao (a) as contagens de participacao, dentro da
 * secao de participacao, e (b) o que estiver no nome do evento, no cabecalho.
 * Qualquer outro digito e numero que nao foi verificado -- e o jeito mais facil
 * de contrabandear uma contagem de pessoas e escrevendo o numero. Lanca.
 */
export function exigirNumerosVerificados(guia: GuiaDoFacilitador): void {
  const verificados = new Set(
    CAMPOS_DE_PARTICIPACAO.map((c) => guia.populacoes[c]).
      filter((v): v is number => v !== null).
      map((v) => String(v)),
  );
  for (const n of numerosDoTexto(guia.participacao.titulo)) {
    if (!verificados.has(n)) {
      throw new Error(`Número não verificado no título da participação: ${n}`);
    }
  }
  for (const t of textosDoBloco(guia.participacao).slice(1)) {
    for (const n of numerosDoTexto(t)) {
      if (!verificados.has(n)) {
        throw new Error(`Número não verificado na seção de participação (${n}): ${t}`);
      }
    }
  }
  const nome = guia.cabecalho.linhaEvento ?? "";
  for (const n of numerosDoTexto(nome)) {
    if (!nome.includes(n)) {
      throw new Error(`Número fora do nome do evento no cabeçalho: ${n}`);
    }
  }
  const fora = [
    guia.cabecalho.eyebrow,
    guia.cabecalho.restricao,
    guia.cabecalho.titulo,
    guia.abertura,
    ...textosDoBloco(guia.semDna),
    ...textosDoBloco(guia.preparacao),
    ...textosDoBloco(guia.leituras),
    ...textosDoBloco(guia.limites),
    guia.notaDeLeitura,
  ];
  for (const t of fora) {
    const n = numerosDoTexto(t);
    if (n.length > 0) {
      throw new Error(`Dígito fora da seção de participação (${n.join(", ")}): ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Construtor de bloco (mesmo desenho do DNA: ordem de leitura preservada)
// ---------------------------------------------------------------------------

function novoBloco(id: string, titulo: string) {
  const partes: ParteDna[] = [];
  return {
    p(texto: string) {
      partes.push({ paragrafo: texto });
    },
    l(linhas: readonly LinhaDna[]) {
      if (linhas.length > 0) partes.push({ linhas });
    },
    fim(): BlocoDna {
      return { id, titulo, partes };
    },
  };
}

export function textosDoBloco(b: BlocoDna): string[] {
  return [
    b.titulo,
    ...b.partes.flatMap((p) =>
      "paragrafo" in p ? [p.paragrafo] : p.linhas.map((l) => `${l.rotulo}: ${l.valor}`),
    ),
  ];
}

/** TODA string de conteúdo do guia. Base do varredor e do hash. */
export function textosDoGuia(g: GuiaDoFacilitador): string[] {
  return [
    g.cabecalho.eyebrow,
    g.cabecalho.restricao,
    g.cabecalho.titulo,
    ...(g.cabecalho.linhaEvento ? [g.cabecalho.linhaEvento] : []),
    g.abertura,
    ...textosDoBloco(g.participacao),
    ...textosDoBloco(g.semDna),
    ...textosDoBloco(g.preparacao),
    ...textosDoBloco(g.leituras),
    ...textosDoBloco(g.limites),
    g.notaDeLeitura,
  ];
}

export function hashDoGuia(g: GuiaDoFacilitador): string {
  return createHash("sha256").update(textosDoGuia(g).join("\n␟\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Secao PARTICIPACAO: as tres populacoes, nomeadas uma por uma
// ---------------------------------------------------------------------------

const NAO_VERIFICADO = "população ainda não verificada: o check-in não foi fechado";
const SO_COM_CHECKIN = "só existe depois do check-in fechado";

function blocoParticipacao(p: ParticipacaoVerificada): BlocoDna {
  // Sem populacao de convidados verificada, a secao e outra (ver abaixo). Com
  // ela, o texto e exatamente o de antes da Rodada 69, e o hash tambem.
  if (p.convidados === null) return blocoParticipacaoSemConvidados(p);
  const b = novoBloco("participacao", TEXTOS_GUIA.tituloParticipacao);
  b.p(
    "Os números desta seção são de participação, e cada linha diz qual população está sendo contada. Convidados, presentes e respondentes são populações diferentes: uma proporção calculada sobre a população errada diz outra coisa.",
  );
  b.l([
    { rotulo: "Convidados, quem foi chamado", valor: String(p.convidados) },
    { rotulo: "Respostas completas recebidas", valor: String(p.respostasCompletas) },
    {
      rotulo: "Respostas iniciadas e não concluídas",
      valor: String(p.respostasIncompletas),
    },
    {
      rotulo: "Convidados sem resposta registrada",
      valor: String(p.semRespostaRegistrada),
    },
    {
      rotulo: "Presentes, com o check-in fechado",
      valor: p.presentes === null ? NAO_VERIFICADO : String(p.presentes),
    },
    {
      rotulo: "Respostas completas de quem esteve presente",
      valor:
        p.respostasCompletasDePresentes === null
          ? SO_COM_CHECKIN
          : String(p.respostasCompletasDePresentes),
    },
    {
      rotulo: "Leituras individuais liberadas pela própria pessoa",
      valor: String(p.leiturasIndividuaisLiberadas),
    },
    {
      rotulo: "Liberações de leitura sem resposta registrada",
      valor: String(p.liberacoesSemRespostaRegistrada),
    },
  ]);
  b.p(
    "Convidados sem resposta registrada é a subtração entre quem foi chamado e as respostas que chegaram: entra aí quem não abriu o questionário e quem não consta na lista de respostas.",
  );
  b.p(
    p.presentes === null
      ? "Enquanto o check-in não é fechado, a população de presentes não existe verificada. Este guia deixa a linha em branco em vez de imprimir estimativa, porque uma proporção sobre presentes estimados não é uma proporção verificada."
      : "Presentes é a população do dia, depois do check-in fechado, e respondentes é quem entregou a leitura completa. A primeira não vira a segunda por aproximação, e a diferença entre as duas é o que este guia mantém à vista.",
  );
  return b.fim();
}

const CONVIDADOS_NAO_VERIFICADOS =
  "população não verificada: não há lista de convidados consolidada";
const SEM_DENOMINADOR =
  "não calculado: depende da população de convidados, que não foi verificada";

/**
 * A secao de participacao do GUIA NEUTRO: a populacao de convidados nao foi
 * verificada. As linhas sao as mesmas oito, na mesma ordem, para que a falta
 * fique a vista em vez de sumir; as duas que dependem do total de convidados
 * dizem por que estao sem numero. Nenhum numero desta secao sai do total de
 * convidados, e nenhuma proporcao e escrita.
 */
function blocoParticipacaoSemConvidados(p: ParticipacaoVerificada): BlocoDna {
  const b = novoBloco("participacao", TEXTOS_GUIA.tituloParticipacao);
  b.p(
    "Os números desta seção são de participação, e cada linha diz qual população está sendo contada. A população de convidados deste evento não foi verificada: não há lista de convidados consolidada. Por isso esta seção não traz total de convidados, não traz quem ficou sem resposta entre eles e não traz proporção alguma.",
  );
  b.l([
    { rotulo: "Convidados, quem foi chamado", valor: CONVIDADOS_NAO_VERIFICADOS },
    { rotulo: "Respostas completas recebidas", valor: String(p.respostasCompletas) },
    {
      rotulo: "Respostas iniciadas e não concluídas",
      valor: String(p.respostasIncompletas),
    },
    { rotulo: "Convidados sem resposta registrada", valor: SEM_DENOMINADOR },
    {
      rotulo: "Presentes, com o check-in fechado",
      valor: p.presentes === null ? NAO_VERIFICADO : String(p.presentes),
    },
    {
      rotulo: "Respostas completas de quem esteve presente",
      valor:
        p.respostasCompletasDePresentes === null
          ? SO_COM_CHECKIN
          : String(p.respostasCompletasDePresentes),
    },
    {
      rotulo: "Leituras individuais liberadas pela própria pessoa",
      valor: String(p.leiturasIndividuaisLiberadas),
    },
    {
      rotulo: "Liberações de leitura sem resposta registrada",
      valor: String(p.liberacoesSemRespostaRegistrada),
    },
  ]);
  b.p(
    "As respostas contadas acima são de participantes registrados neste evento, na versão de questionário do evento: completa é a leitura com o questionário inteiro respondido, e iniciada é a que tem resposta registrada e ficou incompleta. Elas dizem quem respondeu, e não quem foi chamado.",
  );
  b.p(
    "Sem a lista de convidados, não se sabe quantas pessoas foram chamadas e não responderam. Este guia deixa essas linhas sem número em vez de estimar, porque um total estimado não é população verificada.",
  );
  b.p(
    p.presentes === null
      ? "Enquanto o check-in não é fechado, a população de presentes não existe verificada. Este guia deixa a linha em branco em vez de imprimir estimativa, porque uma proporção sobre presentes estimados não é uma proporção verificada."
      : "Presentes é a população do dia, depois do check-in fechado, e respondentes é quem entregou a leitura completa. A primeira não vira a segunda por aproximação, e a diferença entre as duas é o que este guia mantém à vista.",
  );
  return b.fim();
}

// ---------------------------------------------------------------------------
// Secao POR QUE NAO HA DNA: o motivo vem do modulo do DNA, sem numero
// ---------------------------------------------------------------------------

const PROSA_SEM_DNA: Record<
  Exclude<MotivoSemDnaPublicado, "dados_inconsistentes">,
  string
> = {
  // O caso que a revisao abriu: o DNA e geravel e NAO foi disponibilizado.
  // Redacao sem digito e sem vocabulario de retrato, como as demais -- e sem
  // antecipar nada do que o rascunho vier a dizer.
  dna_nao_publicado:
    "Este evento tem um DNA Coletivo gerado e ainda não disponibilizado: enquanto a revisão metodológica não é registrada e o documento não é liberado, não existe DNA Coletivo para conduzir a experiência. Um rascunho é um documento que ainda não foi entregue a quem conduz.",
  volume_insuficiente:
    "As respostas completas recebidas não alcançam o volume mínimo exigido para o DNA Coletivo. Volume é contagem absoluta: uma taxa de resposta alta não substitui a contagem, e não existe revisão nem ratificação que dispense o limiar.",
  cobertura_insuficiente:
    "A cobertura sobre as pessoas presentes ficou abaixo do mínimo exigido para o DNA Coletivo. A ausência do documento aqui é resultado previsto pela regra, e não falha do sistema.",
  base_pequena_demais:
    "A quantidade de leituras completas é pequena o bastante para que qualquer contagem aponte pessoas específicas. Por isso o DNA Coletivo não é gerado.",
  gate_de_volume_indisponivel:
    "A verificação do volume mínimo não pôde ser concluída nesta geração. Não ter conseguido verificar é categoria diferente de ter verificado e aprovado, e também de ter verificado e reprovado.",
  checkin_aberto:
    "O check-in ainda não foi fechado, e sem a população de presentes não existe cobertura oficial para calcular.",
  sem_presentes:
    "Não há presença registrada para este evento, e sem população não existe cobertura.",
  convidados_nao_verificados:
    "A população de convidados deste evento não foi verificada, porque não há lista de convidados consolidada. O DNA Coletivo traz a participação sobre quem foi chamado, e sem essa população ele não é gerado. As respostas recebidas não substituem a lista: elas dizem quem respondeu, e não quem foi chamado.",
};

function blocoSemDna(motivo: MotivoSemDnaPublicado): BlocoDna {
  const b = novoBloco("sem_dna", TEXTOS_GUIA.tituloSemDna);
  b.p(
    PROSA_SEM_DNA[motivo as Exclude<MotivoSemDnaPublicado, "dados_inconsistentes">] ??
      PROSA_SEM_DNA.gate_de_volume_indisponivel,
  );
  b.p(
    "Este guia ocupa esse lugar com outro objetivo: ajudar você a conduzir a experiência. Ele não é um DNA Coletivo reduzido, não estima o que o DNA Coletivo diria e não afirma nada sobre as pessoas que estarão na sala.",
  );
  b.p(
    "Os números do limiar e as pendências por pessoa ficam no relatório operacional, que é o documento de cobrança da coleta. Este guia é o de condução.",
  );
  return b.fim();
}

// ---------------------------------------------------------------------------
// Secao PREPARACAO DA CONDUCAO: redacao FIXA
// ---------------------------------------------------------------------------
// Nao depende de nenhum dado do evento -- nem das contagens de participacao. E
// a mesma secao para qualquer evento deste formato, e esta aqui como constante
// justamente para que isso seja verificavel: dois grupos com respostas opostas
// produzem esta secao identica, byte a byte.
//
// Toda sugestao esta na forma que CONVIDA a propria pessoa a revelar. Nenhuma
// atribui previamente necessidade, prioridade ou caracteristica a quem vai
// estar na sala.

function blocoPreparacao(): BlocoDna {
  const b = novoBloco("preparacao", TEXTOS_GUIA.tituloPreparacao);
  b.p(
    "As sugestões abaixo são as mesmas para qualquer evento deste formato. Elas não foram escolhidas a partir das respostas recebidas, e por isso não atribuem necessidade nem prioridade a quem vai estar na sala. O trabalho delas é abrir espaço para que cada pessoa diga a sua.",
  );
  b.p(
    "A regra para escrever uma pergunta: troque a afirmação sobre quem está presente por um convite para a própria pessoa responder, e espere a resposta. Afirmar economiza tempo e entrega a conclusão de quem conduz; perguntar gasta tempo e entrega o que a pessoa trouxe.",
  );

  b.p("Abertura, sem celular e sem relógio.");
  b.l([
    {
      rotulo: "Marcação do tempo",
      valor:
        "Diga em voz alta como o dia vai marcar o tempo e combine o sinal de início e de fim de cada etapa, para que a falta de relógio não vire ansiedade.",
    },
    {
      rotulo: "Primeira linha no papel",
      valor:
        "Peça que cada pessoa escreva em uma linha o que quer levar do dia, e guarde o papel para o fim da tarde.",
    },
    {
      rotulo: "Combinado da sala",
      valor:
        "Combine que o que é dito na sala fica na sala, e que falar é escolha de cada um. Quem preferir escrever em vez de falar entrega no papel.",
    },
  ]);

  b.p(
    "Manhã, a matriz SWOT do pilar de cada Núcleo, a partir da própria vida. Uma pergunta por pilar, para fazer o exemplo aparecer antes da matriz.",
  );
  b.l([
    {
      rotulo: "Pilar Mental",
      valor:
        "Pergunte o que ocupa a cabeça de cada um na hora de estudar ou de se concentrar, e peça um exemplo da semana passada.",
    },
    {
      rotulo: "Pilar Profissional",
      valor:
        "Pergunte qual porta cada um quer abrir nos próximos meses e o que falta na mão para abrir.",
    },
    {
      rotulo: "Pilar Financeiro",
      valor:
        "Peça que cada um conte uma decisão recente sobre dinheiro, sem dizer valor, e o que pesou na escolha.",
    },
    {
      rotulo: "Pilar Moral",
      valor:
        "Pergunte quando fazer o certo saiu caro, e o que segurou a pessoa naquele momento.",
    },
    {
      rotulo: "Pilar Liderança",
      valor:
        "Peça que cada um lembre de uma vez em que alguém o seguiu, e pergunte a quem seguiu qual foi o motivo.",
    },
    {
      rotulo: "Antes de preencher a matriz",
      valor:
        "Combine que cada linha da matriz sai de um exemplo da vida de quem escreve, e não de uma opinião sobre a juventude.",
    },
  ]);

  b.p("Tarde, O Caso, com as matrizes dos outros Núcleos na mesa.");
  b.l([
    {
      rotulo: "Regra antes da troca",
      valor:
        "Combine que quem lê a matriz de outro Núcleo faz perguntas antes de concluir, e que a conclusão é dita por quem escreveu.",
    },
    {
      rotulo: "Pergunta que abre",
      valor:
        "Pergunte o que vocês veem nessa matriz que quem escreveu talvez não esteja vendo, e devolva a palavra para quem escreveu.",
    },
    {
      rotulo: "Fechamento da rodada",
      valor:
        "Peça uma frase por Núcleo sobre o que levou da matriz do outro, dita por quem leu e confirmada ou corrigida por quem escreveu.",
    },
    {
      rotulo: "O que evitar",
      valor:
        "Evite resumir no lugar deles. O resumo de quem conduz vira a versão oficial, e a versão oficial cala a correção.",
    },
  ]);

  b.p("Fim do dia, o Mural do Futuro individual e a missão de trinta dias.");
  b.l([
    {
      rotulo: "De onde sai a missão",
      valor:
        "A missão sai de cada um. Evite oferecer a missão pronta, inclusive quando a pessoa pedir, e ofereça perguntas no lugar.",
    },
    {
      rotulo: "Primeiro passo",
      valor:
        "Pergunte qual é o primeiro passo que cabe em trinta dias e o que acontece na segunda-feira de manhã.",
    },
    {
      rotulo: "Testemunha",
      valor: "Pergunte quem vai saber que a pessoa começou, e quando essa pessoa vai saber.",
    },
    {
      rotulo: "O dia difícil",
      valor: "Pergunte o que a pessoa vai fazer no dia em que não der vontade.",
    },
    {
      rotulo: "Volta ao papel da manhã",
      valor:
        "Devolva a linha escrita na abertura e pergunte o que mudou entre a manhã e agora.",
    },
  ]);

  b.p("Se a conversa não andar.");
  b.l([
    {
      rotulo: "Prioridades",
      valor: "Pergunte à sala como cada um decide prioridades quando tudo parece urgente.",
    },
    {
      rotulo: "Uma hora livre",
      valor: "Pergunte onde cada um gastaria uma hora livre que aparecesse amanhã, e por quê.",
    },
    {
      rotulo: "Silêncio",
      valor:
        "Deixe o silêncio durar. Repita a pergunta uma vez, sem reformular, antes de responder você mesmo.",
    },
    {
      rotulo: "Quando alguém fala pelos outros",
      valor:
        "Agradeça e devolva a pergunta para quem ainda não falou, uma pessoa por vez, sem cobrar resposta.",
    },
  ]);
  return b.fim();
}

/** A secao de preparacao e constante: montada uma vez, congelada, reusada. */
const PREPARACAO = blocoPreparacao();

// ---------------------------------------------------------------------------
// Secao LEITURAS INDIVIDUAIS
// ---------------------------------------------------------------------------

function blocoLeituras(): BlocoDna {
  const b = novoBloco("leituras_individuais", TEXTOS_GUIA.tituloLeituras);
  b.p(
    "Uma leitura individual é o documento de uma pessoa, e é assim que ela se lê: uma por vez, com o nome de quem respondeu à vista, para preparar a sua conversa com essa pessoa.",
  );
  b.p(
    "Abra apenas as leituras que a própria pessoa liberou. A lista de liberações acompanha este guia fora do texto, por identificador, e quem não liberou não entra nela. Liberação é da pessoa, não do evento.",
  );
  b.p(
    "O que está em uma leitura individual não vira frase sobre as pessoas presentes. Somar as leituras de cabeça e dizer o resultado em voz alta produz exatamente o documento que o limiar recusou, com a diferença de que agora ele não passou por revisão e a conta não pode ser conferida.",
  );
  b.p(
    "Na conversa com a pessoa, use a leitura dela como pauta de pergunta, e não como laudo: o documento diz o que ela declarou sobre si, e ela é quem corrige.",
  );
  return b.fim();
}

const LEITURAS = blocoLeituras();

// ---------------------------------------------------------------------------
// Secao LIMITES
// ---------------------------------------------------------------------------

function blocoLimites(): BlocoDna {
  const b = novoBloco("limites", TEXTOS_GUIA.tituloLimites);
  b.p(
    "Este guia não traz contagem nem taxa sobre como as pessoas responderam, e não cruza as respostas de pessoas diferentes.",
  );
  b.p(
    "Os números deste guia são de participação. Eles dizem quantos foram chamados, quantas respostas chegaram e em que estado, e não dizem o que as respostas contêm.",
  );
  b.p(
    "Quando o limiar recusa o DNA Coletivo, o que falta é base para afirmar algo sobre quem está presente. Isso não se resolve escrevendo a mesma afirmação com outras palavras, nem chamando a afirmação de síntese da sala.",
  );
  b.p(
    "Se durante o dia você quiser mais detalhe sobre quem está ali, pergunte ali mesmo: quem quiser responde em voz alta, por escolha própria.",
  );
  return b.fim();
}

const LIMITES = blocoLimites();

/**
 * Os limites do guia NEUTRO. Muda uma frase so: o guia sem lista de convidados
 * nao diz quantos foram chamados, e o texto fixo de `LIMITES` afirmaria isso.
 * `LIMITES` continua intocado para o evento com lista, e o hash dele tambem.
 */
function blocoLimitesSemConvidados(): BlocoDna {
  const b = novoBloco("limites", TEXTOS_GUIA.tituloLimites);
  b.p(
    "Este guia não traz contagem nem taxa sobre como as pessoas responderam, e não cruza as respostas de pessoas diferentes.",
  );
  b.p(
    "Os números deste guia são de participação. Eles dizem quantas respostas chegaram e em que estado, e não dizem o que as respostas contêm. Quantos foram chamados este guia não diz, porque a lista de convidados não foi consolidada.",
  );
  b.p(
    "Quando o limiar recusa o DNA Coletivo, o que falta é base para afirmar algo sobre quem está presente. Isso não se resolve escrevendo a mesma afirmação com outras palavras, nem chamando a afirmação de síntese da sala.",
  );
  b.p(
    "Se durante o dia você quiser mais detalhe sobre quem está ali, pergunte ali mesmo: quem quiser responde em voz alta, por escolha própria.",
  );
  return b.fim();
}

const LIMITES_SEM_CONVIDADOS = blocoLimitesSemConvidados();

// ---------------------------------------------------------------------------
// Projecao: do que entrou para as oito contagens
// ---------------------------------------------------------------------------

/**
 * Completude SEM a porta da presenca. `situacaoDe` responde "ausente" para quem
 * nao esteve presente, o que esconderia a resposta dessa pessoa; perguntar a ela
 * com `presente: true` reusa a MESMA regra de completude do DNA (24 itens e 6
 * situacionais) sem reescreve-la aqui.
 */
function completudeDe(p: ParticipanteDna): "sem_resposta" | "incompleto" | "completo" {
  const s = situacaoDe({ ...p, presente: true });
  return s === "ausente" ? "sem_resposta" : s;
}

export class ParticipacaoInconsistente extends Error {
  readonly descricaoPublica: string;
  constructor(descricaoPublica: string) {
    super(descricaoPublica);
    this.name = "ParticipacaoInconsistente";
    this.descricaoPublica = descricaoPublica;
  }
}

export interface Projecao {
  participacao: ParticipacaoVerificada;
  idsLiberados: readonly string[];
}

export function projetarParticipacao(
  entrada: EntradaGuia,
): Projecao {
  const { convidados, checkinFechado, participantes } = entrada.dna;
  // `null` e populacao NAO VERIFICADA, e so `null`: qualquer outro valor que
  // nao seja inteiro nao negativo continua sendo dado invalido.
  if (convidados !== null && (!Number.isInteger(convidados) || convidados < 0)) {
    throw new ParticipacaoInconsistente("o total de convidados é inválido");
  }

  let respostasCompletas = 0;
  let respostasIncompletas = 0;
  let presentes = 0;
  let completasDePresentes = 0;
  const porId = new Map<string, ParticipanteDna>();
  for (const p of participantes) {
    if (porId.has(p.id)) {
      throw new ParticipacaoInconsistente("há participantes repetidos na lista");
    }
    porId.set(p.id, p);
    const c = completudeDe(p);
    if (c === "completo") respostasCompletas += 1;
    else if (c === "incompleto") respostasIncompletas += 1;
    if (p.presente) {
      presentes += 1;
      if (c === "completo") completasDePresentes += 1;
    }
  }
  // Sem populacao de convidados verificada nao ha subtracao, e as duas
  // conferencias contra o total nao tem contra o que conferir.
  const semResposta =
    convidados === null ? null : convidados - respostasCompletas - respostasIncompletas;
  if (convidados !== null && (semResposta as number) < 0) {
    throw new ParticipacaoInconsistente(
      "chegaram mais respostas do que o total de convidados informado",
    );
  }
  if (convidados !== null && checkinFechado && presentes > convidados) {
    throw new ParticipacaoInconsistente(
      "há mais pessoas presentes do que convidados informados",
    );
  }

  let liberadas = 0;
  let liberacoesSemResposta = 0;
  const idsLiberados: string[] = [];
  const vistos = new Set<string>();
  for (const a of entrada.autorizacoes ?? []) {
    if (vistos.has(a.participanteId)) {
      throw new ParticipacaoInconsistente("há liberação de leitura repetida");
    }
    vistos.add(a.participanteId);
    const p = porId.get(a.participanteId);
    if (p === undefined) {
      throw new ParticipacaoInconsistente(
        "há liberação de leitura para quem não está na lista de participantes",
      );
    }
    if (!a.autorizado) continue;
    if (p.scores === null) liberacoesSemResposta += 1;
    else {
      liberadas += 1;
      idsLiberados.push(p.id);
    }
  }

  return {
    participacao: {
      convidados,
      respostasCompletas,
      respostasIncompletas,
      semRespostaRegistrada: semResposta,
      presentes: checkinFechado ? presentes : null,
      respostasCompletasDePresentes: checkinFechado ? completasDePresentes : null,
      leiturasIndividuaisLiberadas: liberadas,
      liberacoesSemRespostaRegistrada: liberacoesSemResposta,
    },
    idsLiberados,
  };
}

// ---------------------------------------------------------------------------
// Montagem: o canal estreito em acao
// ---------------------------------------------------------------------------

/**
 * UNICA funcao que escreve o guia. Recebe as oito contagens, o motivo (uma
 * string de enum, sem numero) e o nome do evento. Nao ha parametro por onde
 * passar resposta, score ou agregado: e por isso que a trava anti-contorno e
 * estrutural e nao depende de boa vontade de quem edita este arquivo depois.
 */
export function montarGuia(
  participacao: ParticipacaoVerificada,
  motivoSemDna: MotivoSemDnaPublicado,
  nomeEvento: string | null,
  idsLiberados: readonly string[],
): GuiaDoFacilitador {
  return {
    cabecalho: {
      eyebrow: TEXTOS_GUIA.eyebrow,
      restricao: TEXTOS_GUIA.restricao,
      titulo: TEXTOS_GUIA.titulo,
      linhaEvento: nomeEvento,
    },
    abertura: TEXTOS_GUIA.abertura,
    participacao: blocoParticipacao(participacao),
    semDna: blocoSemDna(motivoSemDna),
    preparacao: PREPARACAO,
    leituras: LEITURAS,
    limites: participacao.convidados === null ? LIMITES_SEM_CONVIDADOS : LIMITES,
    notaDeLeitura: TEXTOS_GUIA.notaDeLeitura,
    populacoes: participacao,
    acessoIndividual: { idsLiberados },
    motivoSemDna,
  };
}

function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === "object" && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    for (const v of Object.values(valor as Record<string, unknown>)) congelar(v);
  }
  return valor;
}

function nomeDoEvento(meta: MetaDna | undefined): string | null {
  const n = meta?.nomeEvento?.trim();
  return n ? n : null;
}

function naoGerado(
  motivo: MotivoSemGuia,
  paragrafos: readonly string[],
  acoes: readonly string[],
): ResultadoGuia {
  return congelar({ tipo: "guia_nao_gerado" as const, motivo, paragrafos, acoes });
}

/** Texto de cada causa de indeterminacao. Sem codigo cru de banco. */
const PROSA_PUBLICACAO_INDETERMINADA: Record<MotivoPublicacaoIndeterminada, string> = {
  consulta_nao_respondeu:
    "a consulta ao registro de disponibilização do DNA Coletivo não respondeu nesta geração",
  registro_ilegivel:
    "o registro de disponibilização do DNA Coletivo veio sem o veredito, ou em forma que este módulo não reconhece",
  invalidacao_indeterminada:
    "há disponibilização registrada e não foi possível saber se a aprovação daquele fechamento continua valendo",
};

/**
 * O que o modulo do DNA recebe para decidir os LIMIARES. Com a populacao de
 * convidados verificada, e a propria entrada, intocada.
 *
 * Sem ela (`convidados === null`), `gerarDnaColetivo` continua sendo quem decide
 * presenca, cobertura, piso e volume, e nao e reimplementado aqui. Ele exige um
 * inteiro em `convidados`, e nesses limiares so o usa numa porta: "ha mais
 * presentes do que convidados". O parametro passado e o numero de participantes
 * REGISTRADOS na entrada, que por construcao e teto dos presentes (todo presente
 * e um participante da lista), e por isso deixa essa porta sem efeito.
 *
 * Esse numero NAO e total de convidados e nao e tratado como tal: ele nao chega
 * a `projetarParticipacao` nem a `montarGuia`, nao entra no texto nem no hash, e
 * o documento que o modulo do DNA montar com ele e descartado (o motivo vira
 * `convidados_nao_verificados`). A independencia da decisao em relacao a esse
 * parametro e testada.
 */
function entradaDoLimiar(dna: EntradaDnaDoGuia): EntradaDna {
  if (dna.convidados !== null) return dna as EntradaDna;
  const registrados = Array.isArray(dna.participantes) ? dna.participantes.length : 0;
  return { ...dna, convidados: registrados };
}

/**
 * Ponto de entrada. O guia existe para o evento que NAO tem DNA Coletivo
 * PUBLICADO. Quem decide os limiares continua sendo `gerarDnaColetivo`, chamado
 * aqui; quem decide a publicacao e o veredito INJETADO em
 * `entrada.publicacaoDoDna` (ver o cabecalho do arquivo).
 *
 * ORDEM, e o motivo de ela ser esta: o estado de publicacao e a PRIMEIRA porta,
 * antes de qualquer avaliacao dos dados. Nao se monta documento algum sem saber
 * se ja existe um publicado, e "nao consegui saber" bloqueia como recusa.
 */
export function gerarGuiaDoFacilitador(entrada: EntradaGuia): ResultadoGuia {
  // O veredito tem de estar na forma prevista. O compilador ja cobra o campo;
  // esta checagem defende de JavaScript nao tipado (corpo de rota, JSON) que
  // chegue aqui sem ele -- e a falta dele NAO e "nao publicado".
  const publicacao: PublicacaoDoDna = ((p: unknown): PublicacaoDoDna => {
    if (p === null || typeof p !== "object") {
      return { estado: "indeterminado", motivo: "consulta_nao_respondeu" };
    }
    const e = (p as { estado?: unknown }).estado;
    if (e === "verificado") {
      const pub = (p as { publicado?: unknown }).publicado;
      return typeof pub === "boolean"
        ? { estado: "verificado", publicado: pub }
        : { estado: "indeterminado", motivo: "registro_ilegivel" };
    }
    if (e === "indeterminado") return p as PublicacaoDoDna;
    return { estado: "indeterminado", motivo: "consulta_nao_respondeu" };
  })(entrada.publicacaoDoDna);

  if (publicacao.estado === "indeterminado") {
    return naoGerado(
      "estado_do_dna_indeterminado",
      [
        `Não foi possível saber se este evento já tem um DNA Coletivo disponibilizado: ${PROSA_PUBLICACAO_INDETERMINADA[publicacao.motivo] ?? PROSA_PUBLICACAO_INDETERMINADA.consulta_nao_respondeu}.`,
        "Não ter conseguido verificar é categoria diferente de ter verificado e encontrado que não há DNA disponibilizado, e só a segunda libera este guia. Gerar o guia aqui poderia colocá-lo ao lado de um DNA Coletivo que o facilitador já recebeu.",
      ],
      ["Restabeleça a consulta ao registro de disponibilização e gere o guia de novo."],
    );
  }

  const dnaDoLimiar = entradaDoLimiar(entrada.dna);
  const convidadosNaoVerificados = entrada.dna.convidados === null;

  let dna;
  try {
    dna = gerarDnaColetivo(dnaDoLimiar);
  } catch {
    return naoGerado(
      "dados_inconsistentes",
      [
        "Os dados recebidos não permitiram avaliar se este evento tem DNA Coletivo, e por isso o guia não é gerado: sem essa avaliação o guia não pode dizer por que o DNA não existe.",
      ],
      ["Corrija os dados de origem e gere o guia de novo."],
    );
  }

  if (publicacao.publicado) {
    // CONTRADICAO verificavel sem banco: um DNA valido e disponibilizado nao
    // pode existir para um conjunto de dados que hoje nao sustenta nenhum DNA.
    // O veredito e os dados discordam, e discordancia nao e liberacao.
    if (dna.tipo === "relatorio_operacional") {
      return naoGerado(
        "estado_do_dna_indeterminado",
        [
          "O veredito diz que este evento tem DNA Coletivo disponibilizado, e os dados recebidos hoje não sustentam nenhum DNA Coletivo. Os dois discordam, e por isso não se sabe a qual conjunto de dados o documento disponibilizado se refere.",
          "Enquanto essa divergência existir, o guia não é gerado: ele poderia ser entregue ao lado de um DNA Coletivo ainda válido, e é exatamente isso que a exclusividade existe para impedir.",
        ],
        [
          "Confira o registro de disponibilização e os sinais de invalidação deste evento.",
          "Para a conversa individual, use os one-pagers individuais.",
        ],
      );
    }
    return naoGerado(
      "dna_publicado",
      [
        "Este evento tem DNA Coletivo válido, revisado e disponibilizado para este mesmo conjunto de dados. O Guia de Preparação do Facilitador existe para o evento que não tem esse documento, e entregar os dois ao mesmo tempo convidaria a ler um como complemento do outro.",
      ],
      [
        "Use o DNA Coletivo disponibilizado, com a revisão metodológica registrada.",
        "Para a conversa individual, use os one-pagers individuais.",
      ],
    );
  }

  // Daqui para baixo: VERIFICADO que nao ha DNA disponibilizado. O guia sai
  // mesmo que o DNA seja geravel -- rascunho nao e publicacao. Sem populacao de
  // convidados verificada, o "rascunho" saiu sobre o parametro neutro de
  // `entradaDoLimiar` e NAO e um DNA: o motivo e a populacao nao verificada.
  const motivoSemDna: MotivoSemDnaPublicado =
    dna.tipo === "relatorio_operacional"
      ? dna.motivo
      : convidadosNaoVerificados
        ? "convidados_nao_verificados"
        : "dna_nao_publicado";

  if (motivoSemDna === "dados_inconsistentes") {
    return naoGerado(
      "dados_inconsistentes",
      [
        "Os dados recebidos não fecham, e o relatório operacional do DNA Coletivo já nomeia a inconsistência. Enquanto ela existir, as contagens de participação deste guia também não são confiáveis, e o guia não é gerado.",
      ],
      ["Corrija os dados de origem e gere o guia de novo."],
    );
  }

  let projecao: Projecao;
  try {
    agregar(dnaDoLimiar.convidados, entrada.dna.participantes);
    projecao = projetarParticipacao(entrada);
  } catch (e) {
    if (e instanceof DadosInconsistentesDna || e instanceof ParticipacaoInconsistente) {
      return naoGerado(
        "dados_inconsistentes",
        [
          `As contagens de participação não fecham: ${e.descricaoPublica}. Um guia com população errada diria a coisa errada sobre o que foi verificado, e por isso ele não é gerado.`,
        ],
        ["Corrija os dados de origem e gere o guia de novo."],
      );
    }
    throw e;
  }

  const guia = montarGuia(
    projecao.participacao,
    motivoSemDna,
    nomeDoEvento(entrada.dna.meta),
    projecao.idsLiberados,
  );

  // As quatro camadas, nesta ordem. Qualquer uma que recuse interrompe a
  // entrega: o guia que nao passa nao existe.
  const textos = textosDoGuia(guia);
  const identificadores = entrada.dna.participantes.flatMap((p) => [
    p.id,
    ...(p.nome ? [p.nome] : []),
  ]);
  exigirTextosColetivosValidos(textos, identificadores);
  exigirGuiaSemRetratoColetivo(textos);
  exigirNumerosVerificados(guia);

  return congelar({
    tipo: "guia_do_facilitador" as const,
    guia,
    conteudoSha256: hashDoGuia(guia),
  });
}

// ---------------------------------------------------------------------------
// Renderizacao em texto
// ---------------------------------------------------------------------------

function renderBloco(b: BlocoDna): string {
  const partes = [b.titulo.toUpperCase()];
  for (const p of b.partes) {
    partes.push(
      "paragrafo" in p
        ? p.paragrafo
        : p.linhas.map((l) => `  - ${l.rotulo}: ${l.valor}`).join("\n"),
    );
  }
  return partes.join("\n\n");
}

export function textoDoGuia(g: GuiaDoFacilitador): string {
  const cab = [
    g.cabecalho.restricao,
    g.cabecalho.titulo,
    ...(g.cabecalho.linhaEvento ? [g.cabecalho.linhaEvento] : []),
  ].join("\n");
  return [
    cab,
    g.abertura,
    renderBloco(g.participacao),
    renderBloco(g.semDna),
    renderBloco(g.preparacao),
    renderBloco(g.leituras),
    renderBloco(g.limites),
    g.notaDeLeitura,
  ].join("\n\n");
}

export function textoDoGuiaNaoGerado(
  r: Extract<ResultadoGuia, { tipo: "guia_nao_gerado" }>,
): string {
  return [
    TEXTOS_GUIA.restricao,
    `Guia não gerado · ${r.motivo}`,
    ...r.paragrafos,
    "O QUE FAZER\n" + r.acoes.map((a) => `  - ${a}`).join("\n"),
  ].join("\n\n");
}
