// Modelo do DNA Coletivo do Marco Zero: tudo o que o documento diz, decidido
// antes de qualquer pixel. Funcao pura (sem I/O, sem data/hora); o unico efeito
// e o registro, em memoria, de quais documentos este modulo emitiu.
//
// QUATRO TRAVAS INDEPENDENTES, TODAS NECESSARIAS PARA LER O DOCUMENTO NA SALA:
//   1. COBERTURA: >= 90% dos PRESENTES (check-in fechado) com a leitura de
//      dimensoes completa. Abaixo, `gerarDnaColetivo` devolve apenas o RELATORIO
//      OPERACIONAL privado; nao existe caminho que produza o titulo
//      "DNA Coletivo" sem a cobertura.
//   2. VOLUME MINIMO: a contagem ABSOLUTA de questionarios completos e validos
//      entre os presentes tem de alcancar o minimo que o banco publica (hoje 30,
//      na view `marco_zero_parametros_dna` da migration 020). Cobertura alta nao
//      compra volume: 12 presentes com 12 respostas e 100% de cobertura e, ao
//      mesmo tempo, base pequena demais para estatistica coletiva -- esse evento
//      NAO tem DNA Coletivo quantitativo. Ver "Gate de volume minimo" abaixo,
//      inclusive por que o numero 30 nao esta escrito neste arquivo.
//   3. REVISAO: o responsavel pela metodologia revisa o conteudo exato (hash) e
//      registra o parecer. Sem ela, o que existe e um RASCUNHO com selo visivel.
//   4. RATIFICACAO dos rotulos: `assertPublicavel()` do catalogo, como no
//      one-pager individual.
// Cobertura e volume sao condicao necessaria, nao suficiente: um criterio
// estatistico, sozinho, nao garante que a interpretacao esteja certa.
//
// REGRA DE OURO DA AGREGACAO: so se afirma algo sobre os RESPONDENTES, em
// contagens e percentuais, com a cobertura junto. Nunca sobre "o grupo". Todo
// recorte pequeno passa pela protecao (dna-coletivo-protecao.ts). Nenhuma
// resposta aberta, citacao ou nome entra aqui; nenhum modelo de IA escreve.
//
// Todas as strings que o documento mostra passam pelo varredor do one-pager e
// pelo varredor coletivo antes de sair; se alguma for recusada, a montagem LANCA.

import { createHash } from "node:crypto";
import {
  EIXOS,
  ELEMENTOS,
  type Eixo,
  type Elemento,
} from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import {
  CATALOGO_DIMENSOES,
  assertPublicavel,
  dimensaoDoEixo,
  rotuloDaDimensao,
} from "./catalogo-dimensoes";
import {
  DadosInconsistentesDna,
  agregar,
  type Agregado,
  type ContagemDestaque,
  type IdCruzamento,
  type ParticipanteDna,
} from "./dna-coletivo-agregacao";
import {
  PISO_DE_EXIBICAO,
  protegerDoisLados,
  protegerParticao,
  type ParticaoProtegida,
} from "./dna-coletivo-protecao";
import { exigirTextosColetivosValidos } from "./dna-coletivo-validacao";

// ---------------------------------------------------------------------------
// Parametros (decisoes de metodologia, num lugar so)
// ---------------------------------------------------------------------------

/** Cobertura minima, em percentual dos PRESENTES. Decisao do responsavel tecnico. */
export const COBERTURA_MINIMA_PERCENTUAL = 90;

// ---------------------------------------------------------------------------
// Textos de moldura (escritos por mim; revisao da metodologia)
// ---------------------------------------------------------------------------

export const TEXTOS_DNA = {
  eyebrow: "Marco Zero",
  titulo: "DNA Coletivo",
  tituloRelatorio: "Relatório operacional de cobertura",
  seloRevisao:
    "Rascunho para revisão metodológica · não usar na condução presencial antes da revisão registrada",
  seloCatalogo: "Rótulos funcionais, pendentes de ratificação",
  seloRelatorio:
    "Uso interno do host · não é o DNA Coletivo · não ler na sala",
  abertura:
    "Este documento resume as respostas das pessoas que fizeram a leitura completa do Marco Zero. Traz contagens e percentuais dessas pessoas, com a cobertura à vista, e não uma descrição de quem não respondeu.",
  tituloCobertura: "Quem está nesta leitura",
  tituloComoLer: "Como ler este documento",
  tituloAutodescricao: "Como as pessoas se descrevem",
  tituloSituacional: "Escolhas em seis situações hipotéticas",
  tituloCruzamento: "Entre as duas leituras",
  tituloElementos: "Os sete elementos",
  tituloConduzir: "Para conduzir",
  tituloDimensoes: "As quatro dimensões avaliadas",
  comoLer2:
    "Tudo vem de autorrelato: o que as pessoas declararam sobre si, e não o que foi observado. As dimensões descrevem o que a pessoa declara e não classificam quem ela é. Este documento não é um diagnóstico.",
  semDestaqueExplica:
    "Sem dimensão em destaque quer dizer que as respostas não mostraram diferença suficiente entre as dimensões mais pontuadas, por empate ou margem pequena. Não significa ausência de características marcantes, e não é possível atribuir a essas pessoas uma dimensão.",
  contrasteExplica:
    "Dimensões diferentes não indicam incoerência: são um convite para perguntar à própria pessoa o que a diferença significa.",
  mediaExplica:
    "A média resume notas muito diferentes entre si; ela não diz o que cada pessoa sente.",
  evitar:
    "Evite frases que atribuam uma característica à sala inteira. O documento só autoriza frases sobre as pessoas que responderam, ditas junto com a cobertura.",
  conduzir1:
    "Use as quatro dimensões como mapa de conversa, e não como etiqueta para as pessoas.",
  notaDeLeitura:
    "Este documento foi montado por contagem a partir das respostas fechadas do questionário, sem interpretação por modelo de IA e sem usar respostas abertas. Os números descrevem o dia e as pessoas que responderam; não são uma medição definitiva de cada pessoa.",
} as const;

const K = PISO_DE_EXIBICAO;

function textoSomadas(): string {
  return `Recortes com menos de ${K} pessoas não são exibidos isoladamente: aparecem somados a outros.`;
}
function textoOculto(objeto: string, feminino: boolean): string {
  return feminino
    ? `${objeto} não é exibida: com recortes de menos de ${K} pessoas, mostrá-la permitiria identificar quem são.`
    : `${objeto} não é exibido: com recortes de menos de ${K} pessoas, mostrá-lo permitiria identificar quem são.`;
}

// ---------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------

const pessoas = (n: number) => (n === 1 ? "1 pessoa" : `${n} pessoas`);
const virgula = (x: number) => x.toFixed(1).replace(".", ",");
/** Arredonda (so para distribuicoes; nunca decide limiar). */
function pct(n: number, d: number): string {
  return `${virgula(Math.round((n * 1000) / d) / 10)}%`;
}
/** Trunca: 89,96% nunca pode aparecer como "90,0%". */
function pctPiso(n: number, d: number): string {
  return `${virgula(Math.floor((n * 1000) / d) / 10)}%`;
}
function listar(itens: readonly string[]): string {
  if (itens.length <= 1) return itens.join("");
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}
const aspas = (r: string) => `“${r}”`;

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
function formatarData(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes} de ${m[1]}` : null;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface LinhaDna {
  rotulo: string;
  valor: string;
}
export type ParteDna = { paragrafo: string } | { linhas: readonly LinhaDna[] };
export interface BlocoDna {
  id: string;
  titulo: string;
  /** Em ordem de leitura: paragrafos e tabelas intercalados. */
  partes: readonly ParteDna[];
}

export interface NumerosDeCobertura {
  convidados: number;
  presentes: number;
  respondentes: number;
  /** Percentual exibido (truncado) dos respondentes sobre os presentes. */
  coberturaOficial: string;
  /** Percentual exibido (arredondado) dos respondentes sobre os convidados. */
  participacaoConvidados: string;
}

export interface DnaColetivoModelo {
  cabecalho: { eyebrow: string; titulo: string; linhaEvento: string | null };
  abertura: string;
  cobertura: BlocoDna;
  comoLer: BlocoDna;
  blocos: readonly BlocoDna[]; // autodescricao, situacional, cruzamento, elementos
  conduzir: BlocoDna;
  dimensoes: {
    titulo: string;
    itens: readonly { rotulo: string; definicao: string }[];
  };
  notaDeLeitura: string;
  numeros: NumerosDeCobertura;
  /** Algum recorte deixou de ser exibido por causa do piso. */
  recortesOcultos: boolean;
  catalogoVersao: string;
}

export interface MetaDna {
  nomeEvento?: string | null;
  /** ISO "AAAA-MM-DD". */
  dataEvento?: string | null;
}

export interface EntradaDna {
  meta?: MetaDna;
  /** Total de convidados (nao existe no schema atual; informado por quem chama). */
  convidados: number;
  /** O check-in foi encerrado? Sem isso nao ha universo oficial. */
  checkinFechado: boolean;
  participantes: readonly ParticipanteDna[];
  /**
   * Veredito do gate de volume minimo, vindo da funcao
   * `public.marco_zero_cobertura` (migration 020) e traduzido por
   * `gateDeVolumeDaCoberturaOficial()`.
   *
   * OBRIGATORIO de proposito: o compilador cobra a decisao de cada chamador, e
   * nao existe valor-padrao que signifique "aprovado". Sem veredito utilizavel
   * o resultado e o relatorio operacional com motivo
   * `gate_de_volume_indisponivel` -- nunca publicacao por omissao.
   */
  gateDeVolume: GateDeVolume;
}

export type MotivoRelatorio =
  | "checkin_aberto"
  | "sem_presentes"
  | "cobertura_insuficiente"
  | "base_pequena_demais"
  /** Gate de volume AVALIADO e reprovado: ha menos respostas que o minimo. */
  | "volume_insuficiente"
  /**
   * Gate de volume NAO avaliavel. Categoria propria, distinta de aprovado e de
   * reprovado: nao se publica, e o motivo e nomeado.
   */
  | "gate_de_volume_indisponivel"
  | "dados_inconsistentes";

export interface RelatorioOperacional {
  tipo: "relatorio_operacional";
  motivo: MotivoRelatorio;
  cabecalho: { eyebrow: string; titulo: string; selo: string; linhaEvento: string | null };
  paragrafos: readonly string[];
  linhas: readonly LinhaDna[];
  acoes: readonly string[];
  /** Ids (nao nomes) de quem ainda falta, para o host cobrar. */
  pendentes: { semResposta: readonly string[]; incompletos: readonly string[] };
  numeros: {
    convidados: number;
    presentes: number;
    respondentes: number;
    /** Respostas que faltam para o limiar de COBERTURA (90%). */
    faltamParaOLimiar: number | null;
    /** Respostas que faltam para o limiar de VOLUME (o minimo do banco). */
    faltamParaOVolume: number | null;
  };
}

export interface DnaColetivoRascunho {
  tipo: "rascunho_para_revisao";
  modelo: DnaColetivoModelo;
  selos: readonly string[];
  conteudoSha256: string;
}

export type ResultadoDna = RelatorioOperacional | DnaColetivoRascunho;

export interface RevisaoMetodologica {
  parecer: "aprovado" | "reprovado" | "pendente";
  revisor: string;
  /** ISO "AAAA-MM-DD" (ou ISO completo). */
  revisadoEm: string;
  /** Hash do conteudo revisado; qualquer mudanca nos dados invalida a revisao. */
  conteudoSha256: string;
  catalogoVersao: string;
  observacoes?: string;
}

export interface DnaColetivoLiberado {
  tipo: "liberado_para_conducao";
  modelo: DnaColetivoModelo;
  revisao: RevisaoMetodologica;
  selos: readonly string[];
  conteudoSha256: string;
}

// ---------------------------------------------------------------------------
// Cobertura
// ---------------------------------------------------------------------------

/** Aritmetica inteira: sem ponto flutuante na decisao. */
export function atingeCoberturaMinima(respondentes: number, presentes: number): boolean {
  return presentes > 0 && respondentes * 100 >= COBERTURA_MINIMA_PERCENTUAL * presentes;
}

/** Quantas respostas completas sao necessarias para o limiar. */
export function respostasNecessarias(presentes: number): number {
  return Math.ceil((COBERTURA_MINIMA_PERCENTUAL * presentes) / 100);
}

// ---------------------------------------------------------------------------
// Gate de volume minimo
// ---------------------------------------------------------------------------
// DECISAO DE PROJETO -- opcao (a): o numero do minimo NAO esta escrito neste
// arquivo. A regra mora em UM lugar so, o banco: a view
// `public.marco_zero_parametros_dna` publica `minimo_respostas_validas` e a
// funcao `public.marco_zero_cobertura` devolve `gate_minimo_respostas` ja
// decidido em aritmetica inteira (migration 020). Aqui chega o VEREDITO.
//
// Por que nao duplicar o numero em TypeScript -- opcao (b): dois lugares com o
// mesmo numero divergem no dia em que um deles muda, e o teste que compara os
// dois so pega a divergencia enquanto alguem se lembrar de mante-lo. Regra
// duplicada ja custou caro neste projeto (o classificador de auth duplicado).
//
// Por que o veredito e INJETADO em vez de consultado daqui de dentro: este
// modulo e funcao pura, sem I/O e sem data/hora (ver o cabecalho do arquivo), e
// o hash do conteudo revisado depende dessa pureza. Quem tem o cliente do banco
// faz a consulta e traduz a linha por `gateDeVolumeDaCoberturaOficial()`. O
// banco continua a unica fonte do numero; o gerador continua testavel sem banco
// e o mesmo veredito produz sempre o mesmo documento.
//
// INDISPONIBILIDADE: "nao consegui verificar" e categoria PROPRIA. Veredito que
// nao chega, chega incompleto, se contradiz ou discorda da contagem dos dados
// recebidos NAO vira aprovacao nem reprovacao: vira o relatorio operacional com
// motivo `gate_de_volume_indisponivel`, que nomeia a causa.

/** Causas previstas de indisponibilidade do gate. Conjunto FECHADO: cada uma
 *  tem texto proprio em `PROSA_INDISPONIBILIDADE`, e nenhum codigo cru do banco
 *  vaza para o documento. */
export type MotivoGateIndisponivel =
  | "consulta_nao_respondeu"
  | "quiz_sem_etapas"
  | "checkin_aberto"
  | "sem_presentes"
  | "veredito_ausente"
  | "parametro_invalido"
  | "contagem_divergente"
  | "veredito_contraditorio"
  | "motivo_nao_previsto";

export type GateDeVolume =
  | {
      estado: "verificado";
      /** `gate_minimo_respostas` da funcao do banco. */
      aprovado: boolean;
      /** `minimo_respostas` da funcao do banco. Unica fonte do numero. */
      minimoExigido: number;
      /** `respondentes_validos` contados pelo banco. */
      respondentesValidos: number;
    }
  | { estado: "indisponivel"; motivo: MotivoGateIndisponivel };

/** Subconjunto, com os nomes do SQL, da linha de `marco_zero_cobertura`. */
export interface LinhaCoberturaOficial {
  status: string | null;
  motivo: string | null;
  respondentes_validos: number | null;
  gate_minimo_respostas: boolean | null;
  minimo_respostas: number | null;
}

/** Motivos de `status = 'indisponivel'` que a funcao do banco documenta. */
const MOTIVOS_DO_BANCO: readonly MotivoGateIndisponivel[] = [
  "quiz_sem_etapas",
  "checkin_aberto",
  "sem_presentes",
];

/**
 * Traduz a linha de `public.marco_zero_cobertura` para o veredito do gate.
 * Quem chama passa `null` quando a consulta nao respondeu -- funcao ausente,
 * sem permissao, falha de conexao. Qualquer forma inesperada da linha fecha a
 * porta: vira indisponibilidade, nunca aprovacao.
 */
export function gateDeVolumeDaCoberturaOficial(
  linha: LinhaCoberturaOficial | null | undefined,
): GateDeVolume {
  if (linha === null || linha === undefined || typeof linha !== "object") {
    return { estado: "indisponivel", motivo: "consulta_nao_respondeu" };
  }
  if (linha.status !== "ok") {
    const previsto = MOTIVOS_DO_BANCO.find((m) => m === linha.motivo);
    return { estado: "indisponivel", motivo: previsto ?? "motivo_nao_previsto" };
  }
  if (
    typeof linha.gate_minimo_respostas !== "boolean" ||
    !Number.isInteger(linha.respondentes_validos) ||
    (linha.respondentes_validos as number) < 0
  ) {
    return { estado: "indisponivel", motivo: "veredito_ausente" };
  }
  if (!Number.isInteger(linha.minimo_respostas) || (linha.minimo_respostas as number) < 1) {
    return { estado: "indisponivel", motivo: "parametro_invalido" };
  }
  return {
    estado: "verificado",
    aprovado: linha.gate_minimo_respostas,
    minimoExigido: linha.minimo_respostas as number,
    respondentesValidos: linha.respondentes_validos as number,
  };
}

export type VeredictoDeVolume =
  | { resultado: "aprovado"; minimoExigido: number }
  | { resultado: "reprovado"; minimoExigido: number; faltam: number }
  | { resultado: "indisponivel"; motivo: MotivoGateIndisponivel };

/**
 * Cruza o veredito do banco com a contagem dos dados que ESTE modulo recebeu.
 * Os dois tem de concordar sobre o limiar: o documento descreve a populacao da
 * entrada, e aprovar com base numa contagem diferente seria decidir sobre outra
 * populacao. A tolerancia e sobre o veredito, nao sobre o numero -- contagens
 * que discordam do limiar dao INDISPONIBILIDADE, nao reprovacao, porque o que
 * falta e a certeza de ter verificado a mesma coisa.
 */
export function avaliarGateDeVolume(
  gate: GateDeVolume,
  respondentesNaEntrada: number,
): VeredictoDeVolume {
  if (gate.estado === "indisponivel") {
    return { resultado: "indisponivel", motivo: gate.motivo };
  }
  const minimo = gate.minimoExigido;
  // A propria linha do banco tem de ser coerente: veredito que nao bate com as
  // contagens que ele mesmo devolveu nao e veredito.
  if (gate.aprovado !== gate.respondentesValidos >= minimo) {
    return { resultado: "indisponivel", motivo: "veredito_contraditorio" };
  }
  if (gate.aprovado !== respondentesNaEntrada >= minimo) {
    return { resultado: "indisponivel", motivo: "contagem_divergente" };
  }
  return gate.aprovado
    ? { resultado: "aprovado", minimoExigido: minimo }
    : {
        resultado: "reprovado",
        minimoExigido: minimo,
        faltam: minimo - respondentesNaEntrada,
      };
}

/** Texto de cada causa. Sem codigo cru: nada com sublinhado sai no documento. */
const PROSA_INDISPONIBILIDADE: Record<MotivoGateIndisponivel, string> = {
  consulta_nao_respondeu:
    "a consulta oficial de cobertura do banco não respondeu nesta geração, por ausência da função, falta de permissão ou falha de conexão",
  quiz_sem_etapas:
    "a versão de questionário deste evento não tem etapa cadastrada, e sem isso não existe definição de questionário completo para contar",
  checkin_aberto:
    "o banco ainda não considera o check-in fechado, e o veredito seria provisório",
  sem_presentes: "o banco não encontrou presença registrada para este evento",
  veredito_ausente: "o banco devolveu a linha de cobertura sem o veredito do volume",
  parametro_invalido:
    "o mínimo de respostas publicado pelo banco não veio como uma contagem utilizável",
  contagem_divergente:
    "a contagem de questionários completos do banco e a dos dados recebidos discordam sobre o limiar, e a decisão seria tomada sobre populações diferentes",
  veredito_contraditorio: "a linha de cobertura do banco contradiz as próprias contagens",
  motivo_nao_previsto:
    "o banco recusou o cálculo com um motivo fora da lista prevista por este módulo",
};

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

function linhaEvento(meta: MetaDna | undefined): string | null {
  const partes = [meta?.nomeEvento?.trim() || null, formatarData(meta?.dataEvento)].filter(
    (p): p is string => p !== null,
  );
  return partes.length > 0 ? partes.join("  ·  ") : null;
}

/** Construtor de bloco: preserva a ordem em que paragrafos e tabelas aparecem. */
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

function blocoCobertura(ag: Agregado, num: NumerosDeCobertura): BlocoDna {
  const fora = ag.presentes - ag.respondentes;
  const b = novoBloco("cobertura", TEXTOS_DNA.tituloCobertura);
  b.l([
    { rotulo: "Convidados", valor: String(ag.convidados) },
    {
      rotulo: "Presentes, com o check-in fechado",
      valor: `${ag.presentes} (${pct(ag.presentes, ag.convidados)} dos convidados)`,
    },
    {
      rotulo: "Convidados que não estiveram presentes",
      valor: String(ag.convidados - ag.presentes),
    },
    {
      rotulo: "Presentes com a leitura completa das dimensões",
      valor: String(ag.respondentes),
    },
    {
      rotulo: "Cobertura oficial, sobre os presentes",
      valor: `${ag.respondentes} de ${ag.presentes} · ${num.coberturaOficial}`,
    },
    { rotulo: "Mínimo exigido", valor: `${COBERTURA_MINIMA_PERCENTUAL}% dos presentes` },
    {
      rotulo: "Participação sobre o total de convidados",
      valor: `${ag.respondentes} de ${ag.convidados} · ${num.participacaoConvidados}`,
    },
  ]);
  b.p(
    "A cobertura oficial usa só os presentes. A participação sobre o total de convidados aparece ao lado para que a diferença entre quem foi convidado e quem esteve no evento não fique escondida.",
  );
  b.p(
    fora > 0
      ? `${pessoas(fora)} presentes ${fora === 1 ? "não entra" : "não entram"} na leitura das dimensões por não terem respondido ou terem respondido só em parte. Nada neste documento é afirmado sobre as dimensões ${fora === 1 ? "dessa pessoa" : "dessas pessoas"}.`
      : "Não há pessoas presentes fora da leitura das dimensões.",
  );
  return b.fim();
}

function blocoComoLer(n: number): BlocoDna {
  const b = novoBloco("como_ler", TEXTOS_DNA.tituloComoLer);
  b.p(
    `Os números deste documento descrevem apenas as ${n} pessoas que fizeram a leitura completa. Mesmo com a cobertura acima do mínimo, a taxa de resposta, sozinha, não permite saber como seria a leitura de quem não respondeu; por isso nada aqui vale como afirmação sobre o conjunto de presentes.`,
  );
  b.p(TEXTOS_DNA.comoLer2);
  b.p(
    `Contagens de 1 a ${K - 1} pessoas não são exibidas isoladamente nem podem ser deduzidas por subtração: quando isso ocorre, o texto avisa. Respostas abertas e trechos de respostas individuais não são usados aqui.`,
  );
  return b.fim();
}

function linhasDeParticao<Id extends string>(
  p: ParticaoProtegida<Id>,
  rotuloDe: (id: Id) => string,
  valorDe: (contagem: number) => string,
): LinhaDna[] {
  return p.linhas.map((l) =>
    l.tipo === "celula"
      ? { rotulo: rotuloDe(l.id), valor: valorDe(l.contagem) }
      : {
          rotulo: `${listar(l.ids.map(rotuloDe))}, somadas`,
          valor: valorDe(l.contagem),
        },
  );
}

interface ResultadoBloco {
  bloco: BlocoDna;
  ocultou: boolean;
  /** Para "Para conduzir": numero de pessoas sem destaque, se foi exibido. */
  semDestaqueExibido: number | null;
}

function blocoDestaque(
  id: string,
  titulo: string,
  intro: string,
  c: ContagemDestaque,
  n: number,
): ResultadoBloco {
  const b = novoBloco(id, titulo);
  b.p(intro);
  let ocultou = false;
  const valor = (x: number) => `${pessoas(x)} (${pct(x, n)} dos respondentes)`;

  const dois = protegerDoisLados(c.comDestaque, c.semDestaque);
  if (!dois.exibir) {
    b.p(
      dois.ladoPequeno === "com"
        ? `Menos de ${K} respondentes têm uma dimensão em destaque. O número exato, o de quem está sem destaque e a distribuição entre as dimensões não são exibidos, porque um revelaria o outro por subtração.`
        : `Menos de ${K} respondentes estão sem dimensão em destaque. O número exato, o de quem tem destaque e a distribuição entre as dimensões não são exibidos, porque um revelaria o outro por subtração.`,
    );
    return { bloco: b.fim(), ocultou: true, semDestaqueExibido: null };
  }

  b.l([
    { rotulo: "Com uma dimensão em destaque", valor: valor(c.comDestaque) },
    { rotulo: "Sem dimensão em destaque", valor: valor(c.semDestaque) },
  ]);
  if (c.semDestaque > 0) b.p(TEXTOS_DNA.semDestaqueExplica);

  if (c.comDestaque > 0) {
    const p = protegerParticao(EIXOS.map((e) => ({ id: e, contagem: c.porDimensao[e] })));
    if (p.oculta) {
      ocultou = true;
      b.p(textoOculto("A distribuição entre as dimensões", true));
    } else {
      b.p(
        "Entre as pessoas com uma dimensão em destaque, a distribuição foi esta (cada pessoa conta uma vez).",
      );
      b.l(linhasDeParticao(p, (e: Eixo) => aspas(rotuloDaDimensao(e)), valor));
      if (p.agrupou) {
        ocultou = true;
        b.p(textoSomadas());
      }
    }
  }
  return { bloco: b.fim(), ocultou, semDestaqueExibido: c.semDestaque };
}

const ROTULO_CRUZAMENTO: Record<IdCruzamento, string> = {
  convergencia: "Mesma dimensão em destaque nas duas leituras",
  contraste: "Dimensões diferentes em destaque nas duas leituras",
  algum_sem_destaque: "Pelo menos uma das leituras sem dimensão em destaque",
};

/**
 * Tabela 2x2 (autodescricao x escolhas, com/sem destaque). As duas margens ja
 * saem nas secoes anteriores; se o cruzamento mostrasse a celula "ambas", as
 * outras tres sairiam por subtracao. Por isso o bloco so e exibido quando as
 * QUATRO celulas sao zero ou >= piso.
 */
export function celulasDaJuncao(ag: Agregado): number[] {
  const n = ag.respondentes;
  const cL = ag.autodescricao.comDestaque;
  const cS = ag.situacional.comDestaque;
  const ambas = ag.cruzamento.convergencia + ag.cruzamento.contraste;
  return [ambas, cL - ambas, cS - ambas, n - cL - cS + ambas];
}

function blocoCruzamento(ag: Agregado): { bloco: BlocoDna; ocultou: boolean } {
  const n = ag.respondentes;
  const ids: IdCruzamento[] = ["convergencia", "contraste", "algum_sem_destaque"];
  const b = novoBloco("cruzamento", TEXTOS_DNA.tituloCruzamento);
  b.p(
    `Base: ${n} respondentes. Compara, pessoa a pessoa, a dimensão destacada na autodescrição com a das escolhas hipotéticas. Só há comparação quando as duas leituras têm destaque.`,
  );
  const valor = (x: number) => `${pessoas(x)} (${pct(x, n)} dos respondentes)`;

  const juncao = celulasDaJuncao(ag);
  if (juncao.some((x) => x < 0)) {
    throw new DadosInconsistentesDna("Juncao do cruzamento com celula negativa");
  }
  const juncaoSegura = juncao.every((x) => x === 0 || x >= K);
  if (!juncaoSegura) {
    b.p(
      `O cruzamento não é exibido: somado aos números das seções anteriores, ele revelaria por subtração recortes de menos de ${K} pessoas.`,
    );
    return { bloco: b.fim(), ocultou: true };
  }

  const p = protegerParticao(ids.map((i) => ({ id: i, contagem: ag.cruzamento[i] })));
  let ocultou = false;
  if (p.oculta) {
    ocultou = true;
    b.p(textoOculto("O cruzamento entre as duas leituras", false));
  } else {
    b.l(linhasDeParticao(p, (i: IdCruzamento) => ROTULO_CRUZAMENTO[i], valor));
    if (p.agrupou) {
      ocultou = true;
      b.p(textoSomadas());
    }
    const contrasteVisivel = p.linhas.some(
      (l) => l.tipo === "celula" && l.id === "contraste" && l.contagem > 0,
    );
    if (contrasteVisivel) b.p(TEXTOS_DNA.contrasteExplica);
  }
  return { bloco: b.fim(), ocultou };
}

function passaBase(base: number, presentes: number): boolean {
  return base >= K && base * 100 >= COBERTURA_MINIMA_PERCENTUAL * presentes;
}

function blocoElementos(ag: Agregado): {
  bloco: BlocoDna;
  ocultou: boolean;
  algumaMedia: boolean;
} {
  const P = ag.presentes;
  const b = novoBloco("elementos", TEXTOS_DNA.tituloElementos);
  b.p(
    "Notas de 0 a 10 que cada pessoa atribuiu a si mesma. Os elementos aparecem na ordem do questionário, sem ordenar por valor e sem dar destaque a um deles.",
  );
  b.p(
    `A base desta seção não é a das dimensões: considera os presentes que responderam cada elemento, mesmo sem a leitura completa das dimensões. Cada média só aparece se pelo menos ${COBERTURA_MINIMA_PERCENTUAL}% dos presentes a responderam.`,
  );
  let ocultou = false;
  let algumaMedia = false;

  const medias: LinhaDna[] = [];
  for (const el of ELEMENTOS) {
    const ne = ag.elementos.responderam[el];
    if (passaBase(ne, P)) {
      algumaMedia = true;
      medias.push({
        rotulo: ROTULOS_ELEMENTOS_PADRAO[el],
        valor: `média ${virgula(Math.round((ag.elementos.soma[el] * 10) / ne) / 10)} (${ne} de ${P} presentes responderam)`,
      });
    } else {
      ocultou = true;
      medias.push({
        rotulo: ROTULOS_ELEMENTOS_PADRAO[el],
        valor: `média não exibida: ${ne} de ${P} presentes responderam`,
      });
    }
  }
  b.l(medias);
  if (algumaMedia) b.p(TEXTOS_DNA.mediaExplica);

  const m = ag.elementos.completos;
  if (!passaBase(m, P)) {
    ocultou = true;
    b.p(
      `A contagem de quem atribuiu a menor nota a cada elemento não é exibida: ${m} de ${P} presentes responderam os sete elementos.`,
    );
  } else {
    const p = protegerParticao<Elemento | "empate">([
      ...ELEMENTOS.map((el) => ({ id: el, contagem: ag.elementos.menorNotaUnica[el] })),
      { id: "empate" as const, contagem: ag.elementos.menorNotaEmpatada },
    ]);
    const rotuloDe = (id: Elemento | "empate") =>
      id === "empate" ? "Menor nota empatada entre elementos" : ROTULOS_ELEMENTOS_PADRAO[id];
    if (p.oculta) {
      ocultou = true;
      b.p(textoOculto("A contagem de quem atribuiu a menor nota a cada elemento", true));
    } else {
      b.p(
        `Entre as ${m} pessoas que responderam os sete elementos, quantas atribuíram a menor nota a cada um (cada pessoa conta uma vez). É uma nota atribuída, e não uma medição externa; não indica o que a pessoa precisa.`,
      );
      b.l(linhasDeParticao(p, rotuloDe, (x) => `${pessoas(x)} (${pct(x, m)} de ${m})`));
      if (p.agrupou) {
        ocultou = true;
        b.p(textoSomadas());
      }
    }
  }
  return { bloco: b.fim(), ocultou, algumaMedia };
}

// ---------------------------------------------------------------------------
// Montagem do modelo
// ---------------------------------------------------------------------------

function montarModelo(ag: Agregado, meta: MetaDna | undefined): DnaColetivoModelo {
  const n = ag.respondentes;
  const num: NumerosDeCobertura = {
    convidados: ag.convidados,
    presentes: ag.presentes,
    respondentes: n,
    coberturaOficial: pctPiso(n, ag.presentes),
    participacaoConvidados: pct(n, ag.convidados),
  };

  const auto = blocoDestaque(
    "autodescricao",
    TEXTOS_DNA.tituloAutodescricao,
    `Base: ${n} respondentes. As 24 afirmações mostram como cada pessoa percebe suas próprias características nas quatro dimensões; uma dimensão só é destacada quando há margem suficiente sobre as demais.`,
    ag.autodescricao,
    n,
  );
  const sit = blocoDestaque(
    "situacional",
    TEXTOS_DNA.tituloSituacional,
    `Base: ${n} respondentes. Em cada uma das seis situações a pessoa escolhe entre quatro alternativas, uma para cada dimensão. São escolhas declaradas sobre situações imaginadas; não descrevem o que as pessoas fazem na prática.`,
    ag.situacional,
    n,
  );
  const cruz = blocoCruzamento(ag);
  const elem = blocoElementos(ag);

  // Para conduzir: sugestoes condicionais ao que de fato foi exibido.
  const cond = novoBloco("conduzir", TEXTOS_DNA.tituloConduzir);
  cond.p(TEXTOS_DNA.conduzir1);
  cond.p(
    `Antes de citar qualquer número em voz alta, diga a cobertura: ${n} de ${ag.presentes} presentes, ${num.coberturaOficial}.`,
  );
  const semDestaque: string[] = [];
  if (auto.semDestaqueExibido !== null && auto.semDestaqueExibido * 2 >= n) {
    semDestaque.push(`${auto.semDestaqueExibido} na autodescrição`);
  }
  if (sit.semDestaqueExibido !== null && sit.semDestaqueExibido * 2 >= n) {
    semDestaque.push(`${sit.semDestaqueExibido} nas escolhas hipotéticas`);
  }
  if (semDestaque.length > 0) {
    cond.p(
      `Entre os ${n} respondentes, ficaram sem dimensão em destaque ${listar(semDestaque)}. Por isso, não abra a conversa com uma tese sobre quem está na sala. Peça que cada pessoa diga qual das quatro dimensões prioriza primeiro quando precisa decidir, e por quê: é assim que a conversa obtém o que o questionário não distinguiu.`,
    );
  }
  const algumOculto = auto.ocultou || sit.ocultou || cruz.ocultou || elem.ocultou;
  if (algumOculto) {
    cond.p(
      `Alguns recortes não aparecem porque teriam menos de ${K} pessoas. Se quiser mais detalhe, pergunte na sala; quem quiser responde em voz alta, por escolha própria.`,
    );
  }
  if (elem.algumaMedia) {
    cond.p(
      "Se a conversa for para os sete elementos, pergunte antes de afirmar: a média resume notas muito diferentes entre si.",
    );
  }
  cond.p(
    `Frase segura para ler na sala: estas contagens são das ${n} pessoas que responderam, ${num.coberturaOficial} dos ${ag.presentes} presentes. Elas não dizem quem cada pessoa é e não valem para quem não respondeu.`,
  );
  cond.p(TEXTOS_DNA.evitar);

  const modelo: DnaColetivoModelo = {
    cabecalho: {
      eyebrow: TEXTOS_DNA.eyebrow,
      titulo: TEXTOS_DNA.titulo,
      linhaEvento: linhaEvento(meta),
    },
    abertura: TEXTOS_DNA.abertura,
    cobertura: blocoCobertura(ag, num),
    comoLer: blocoComoLer(n),
    blocos: [auto.bloco, sit.bloco, cruz.bloco, elem.bloco],
    conduzir: cond.fim(),
    dimensoes: {
      titulo: TEXTOS_DNA.tituloDimensoes,
      itens: EIXOS.map((e) => ({
        rotulo: dimensaoDoEixo(e).rotulo,
        definicao: dimensaoDoEixo(e).definicao,
      })),
    },
    notaDeLeitura: TEXTOS_DNA.notaDeLeitura,
    numeros: num,
    recortesOcultos: algumOculto,
    catalogoVersao: CATALOGO_DIMENSOES.versao,
  };
  return modelo;
}

// ---------------------------------------------------------------------------
// Textos do modelo (para verificar e para hashear)
// ---------------------------------------------------------------------------

function textosDoBloco(b: BlocoDna): string[] {
  return [
    b.titulo,
    ...b.partes.flatMap((p) =>
      "paragrafo" in p ? [p.paragrafo] : p.linhas.map((l) => `${l.rotulo}: ${l.valor}`),
    ),
  ];
}

/** TODA string de conteudo do documento (sem selos). Base do hash da revisao. */
export function textosDoModelo(m: DnaColetivoModelo): string[] {
  const t: string[] = [m.cabecalho.eyebrow, m.cabecalho.titulo, m.abertura];
  t.push(...textosDoBloco(m.cobertura), ...textosDoBloco(m.comoLer));
  for (const b of m.blocos) t.push(...textosDoBloco(b));
  t.push(...textosDoBloco(m.conduzir));
  t.push(m.dimensoes.titulo);
  for (const d of m.dimensoes.itens) t.push(d.rotulo, d.definicao);
  t.push(m.notaDeLeitura);
  return t;
}

function identificadoresDe(participantes: readonly ParticipanteDna[]): string[] {
  return participantes.flatMap((p) => [p.id, ...(p.nome ? [p.nome] : [])]);
}

export function hashDoConteudo(m: DnaColetivoModelo): string {
  return createHash("sha256").update(textosDoModelo(m).join("\n␟\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Relatorio operacional (privado)
// ---------------------------------------------------------------------------

export function textosDoRelatorio(r: RelatorioOperacional): string[] {
  return [
    r.cabecalho.eyebrow,
    r.cabecalho.titulo,
    r.cabecalho.selo,
    ...r.paragrafos,
    ...r.linhas.map((l) => `${l.rotulo}: ${l.valor}`),
    ...r.acoes,
  ];
}

function montarRelatorio(
  motivo: MotivoRelatorio,
  ag: Agregado | null,
  entrada: EntradaDna,
  descricaoInconsistencia?: string,
  volume?: VeredictoDeVolume,
): RelatorioOperacional {
  const convidados = ag?.convidados ?? entrada.convidados;
  const presentes = ag?.presentes ?? 0;
  const n = ag?.respondentes ?? 0;
  const paragrafos: string[] = [];
  const acoes: string[] = [];
  const linhas: LinhaDna[] = [];
  let faltam: number | null = null;
  let faltamVolume: number | null = null;

  if (ag) {
    linhas.push(
      { rotulo: "Convidados", valor: String(convidados) },
      {
        rotulo: "Presentes",
        valor: `${presentes}${convidados > 0 ? ` (${pct(presentes, convidados)} dos convidados)` : ""}`,
      },
      {
        rotulo: "Convidados que não estiveram presentes",
        valor: String(Math.max(0, convidados - presentes)),
      },
      { rotulo: "Presentes com a leitura completa das dimensões", valor: String(n) },
      { rotulo: "Presentes que responderam só em parte", valor: String(ag.presentesIncompletos) },
      { rotulo: "Presentes que não responderam nada", valor: String(ag.presentesSemResposta) },
      {
        rotulo: "Respostas de quem não esteve presente (fora da conta)",
        valor: String(ag.respostasDeAusentes),
      },
    );
    if (presentes > 0) {
      linhas.push({
        rotulo: "Cobertura oficial, sobre os presentes",
        valor: `${n} de ${presentes} · ${pctPiso(n, presentes)}`,
      });
      linhas.push({
        rotulo: "Participação sobre o total de convidados",
        valor:
          convidados > 0
            ? `${n} de ${convidados} · ${pctPiso(n, convidados)}`
            : "sem convidados informados",
      });
      linhas.push({
        rotulo: "Mínimo exigido",
        valor: `${COBERTURA_MINIMA_PERCENTUAL}% dos presentes`,
      });
    }
    if (volume !== undefined && volume.resultado !== "indisponivel") {
      linhas.push({
        rotulo: "Volume mínimo exigido",
        valor: `${volume.minimoExigido} leituras completas entre os presentes`,
      });
    }
  }

  switch (motivo) {
    case "checkin_aberto":
      paragrafos.push(
        "O check-in ainda não foi fechado. A cobertura oficial usa como universo as pessoas efetivamente presentes, depois do fechamento do check-in; sem isso não há cálculo oficial e o documento não é gerado.",
      );
      acoes.push("Feche o check-in e gere o documento de novo.");
      break;
    case "sem_presentes":
      paragrafos.push(
        "Não há presentes registrados. Sem universo não existe cobertura, e o documento não é gerado.",
      );
      acoes.push("Confira o registro de presença e gere o documento de novo.");
      break;
    case "dados_inconsistentes":
      paragrafos.push(
        `Os dados recebidos não fecham${descricaoInconsistencia ? `: ${descricaoInconsistencia}` : ""}. Por isso o documento não é gerado.`,
      );
      acoes.push("Corrija os dados de origem e gere o documento de novo.");
      break;
    case "base_pequena_demais":
      paragrafos.push(
        `Há ${pessoas(n)} com a leitura completa. Abaixo de ${K} pessoas qualquer contagem aponta indivíduos, e por isso o DNA Coletivo não é gerado.`,
      );
      acoes.push(
        "Para a condução, use os one-pagers individuais; eles não dependem da cobertura do conjunto.",
      );
      break;
    case "cobertura_insuficiente": {
      const necessarias = respostasNecessarias(presentes);
      faltam = necessarias - n;
      paragrafos.push(
        `A cobertura oficial é ${pctPiso(n, presentes)} (${n} de ${presentes} presentes). O mínimo é ${COBERTURA_MINIMA_PERCENTUAL}%, o que exige ${necessarias} leituras completas; faltam ${faltam}. Por isso o DNA Coletivo não foi gerado: abaixo do mínimo o sistema não produz esse documento.`,
        "Este relatório não traz retrato algum das dimensões. A ausência do DNA Coletivo é um resultado previsto pela regra de cobertura, e não uma falha do sistema.",
      );
      acoes.push(
        `Se houver tempo, peça às ${ag!.presentesIncompletos + ag!.presentesSemResposta} pessoas presentes sem leitura completa que concluam o questionário; com ${faltam} a mais o limiar é atingido. A cobertura é recalculada a cada geração.`,
        "Para a condução, use os one-pagers individuais; eles não dependem da cobertura do conjunto.",
      );
      break;
    }
    case "volume_insuficiente": {
      // Chegar aqui com outro veredito seria publicar um motivo sem a conta que
      // o sustenta. Lancar e preferivel a imprimir um numero inventado.
      if (volume === undefined || volume.resultado !== "reprovado") {
        throw new Error(
          "Relatorio de volume insuficiente exige o veredito reprovado do gate de volume.",
        );
      }
      faltamVolume = volume.faltam;
      paragrafos.push(
        `Há ${pessoas(n)} com a leitura completa entre os presentes, e o volume mínimo para o DNA Coletivo é de ${volume.minimoExigido} leituras completas: faltam ${volume.faltam}. Por isso o DNA Coletivo não foi gerado.`,
        `A cobertura oficial deste evento é ${pctPiso(n, presentes)} (${n} de ${presentes} presentes) e cumpre o mínimo de ${COBERTURA_MINIMA_PERCENTUAL}%, o que não substitui o volume: com poucas leituras, cobertura alta ainda deixa uma base pequena demais para sustentar contagem e percentual sobre o conjunto. A ausência do DNA Coletivo aqui é um resultado previsto pela regra de volume, e não uma falha do sistema.`,
        "Este relatório não traz retrato algum das dimensões.",
      );
      acoes.push(
        `O volume é contagem absoluta, e não proporção: enquanto houver menos de ${volume.minimoExigido} leituras completas entre os presentes, este evento não tem DNA Coletivo quantitativo, e não há revisão nem ratificação que dispense o limiar.`,
        "Para a condução, use os one-pagers individuais; eles não dependem da cobertura nem do volume do conjunto.",
      );
      break;
    }
    case "gate_de_volume_indisponivel": {
      const causa =
        volume !== undefined && volume.resultado === "indisponivel"
          ? volume.motivo
          : "consulta_nao_respondeu";
      paragrafos.push(
        `O gate de volume mínimo não pôde ser avaliado: ${PROSA_INDISPONIBILIDADE[causa]}.`,
        "Não ter conseguido verificar é categoria diferente de ter verificado e aprovado, e também de ter verificado e reprovado. Sem o veredito, o DNA Coletivo não é gerado, e este relatório não afirma que o volume estaria aprovado nem que estaria reprovado.",
        "Este relatório não traz retrato algum das dimensões.",
      );
      acoes.push(
        "Restabeleça a consulta oficial de cobertura do banco e gere o documento de novo: o veredito é recalculado a cada geração.",
        "Para a condução, use os one-pagers individuais; eles não dependem da cobertura nem do volume do conjunto.",
      );
      break;
    }
  }

  return {
    tipo: "relatorio_operacional",
    motivo,
    cabecalho: {
      eyebrow: TEXTOS_DNA.eyebrow,
      titulo: TEXTOS_DNA.tituloRelatorio,
      selo: TEXTOS_DNA.seloRelatorio,
      linhaEvento: linhaEvento(entrada.meta),
    },
    paragrafos,
    linhas,
    acoes,
    pendentes: ag
      ? { semResposta: ag.pendentes.semResposta, incompletos: ag.pendentes.incompletos }
      : { semResposta: [], incompletos: [] },
    numeros: {
      convidados,
      presentes,
      respondentes: n,
      faltamParaOLimiar: faltam,
      faltamParaOVolume: faltamVolume,
    },
  };
}

// ---------------------------------------------------------------------------
// Geracao
// ---------------------------------------------------------------------------

const EMITIDOS = new WeakSet<object>();
const LIBERADOS = new WeakSet<object>();

function congelar<T>(valor: T): T {
  if (valor !== null && typeof valor === "object" && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    for (const v of Object.values(valor as Record<string, unknown>)) congelar(v);
  }
  return valor;
}

/** Selos do rascunho: o da revisao SEMPRE; o do catalogo enquanto nao ratificado. */
function selosDoRascunho(): string[] {
  return [
    TEXTOS_DNA.seloRevisao,
    ...(CATALOGO_DIMENSOES.estado === "ratificado" ? [] : [TEXTOS_DNA.seloCatalogo]),
  ];
}

/**
 * Ponto de entrada. Devolve OU o relatorio operacional privado OU um rascunho
 * para revisao. Nunca devolve algo liberado para a sala: isso so
 * `liberarParaConducao` faz.
 */
export function gerarDnaColetivo(entrada: EntradaDna): ResultadoDna {
  const ids = identificadoresDe(entrada.participantes);

  const finalizarRelatorio = (r: RelatorioOperacional): RelatorioOperacional => {
    exigirTextosColetivosValidos(textosDoRelatorio(r), ids);
    return congelar(r);
  };

  if (!Number.isInteger(entrada.convidados) || entrada.convidados < 0) {
    return finalizarRelatorio(
      montarRelatorio("dados_inconsistentes", null, entrada, "o total de convidados é inválido"),
    );
  }
  if (!entrada.checkinFechado) {
    let ag: Agregado | null = null;
    try {
      ag = agregar(entrada.convidados, entrada.participantes);
    } catch (e) {
      if (!(e instanceof DadosInconsistentesDna)) throw e;
    }
    return finalizarRelatorio(montarRelatorio("checkin_aberto", ag, entrada));
  }

  let ag: Agregado;
  try {
    ag = agregar(entrada.convidados, entrada.participantes);
  } catch (e) {
    if (!(e instanceof DadosInconsistentesDna)) throw e;
    return finalizarRelatorio(montarRelatorio("dados_inconsistentes", null, entrada, e.descricaoPublica));
  }

  if (ag.presentes === 0) return finalizarRelatorio(montarRelatorio("sem_presentes", ag, entrada));
  if (ag.presentes > ag.convidados) {
    return finalizarRelatorio(
      montarRelatorio(
        "dados_inconsistentes",
        ag,
        entrada,
        `há mais presentes (${ag.presentes}) do que convidados (${ag.convidados})`,
      ),
    );
  }
  if (!atingeCoberturaMinima(ag.respondentes, ag.presentes)) {
    return finalizarRelatorio(montarRelatorio("cobertura_insuficiente", ag, entrada));
  }
  if (ag.respondentes < PISO_DE_EXIBICAO) {
    return finalizarRelatorio(montarRelatorio("base_pequena_demais", ag, entrada));
  }
  // Quarta porta: VOLUME ABSOLUTO. O limiar vem do banco (ver "Gate de volume
  // minimo"). Vem depois da cobertura e do piso de privacidade porque esses dois
  // tem recusa mais especifica para o mesmo grupo; vem ANTES de montar qualquer
  // retrato porque indisponibilidade nao e aprovacao.
  const volume = avaliarGateDeVolume(entrada.gateDeVolume, ag.respondentes);
  if (volume.resultado === "indisponivel") {
    return finalizarRelatorio(
      montarRelatorio("gate_de_volume_indisponivel", ag, entrada, undefined, volume),
    );
  }
  if (volume.resultado === "reprovado") {
    return finalizarRelatorio(
      montarRelatorio("volume_insuficiente", ag, entrada, undefined, volume),
    );
  }

  const modelo = montarModelo(ag, entrada.meta);
  exigirTextosColetivosValidos(textosDoModelo(modelo), ids);
  const rascunho: DnaColetivoRascunho = congelar({
    tipo: "rascunho_para_revisao" as const,
    modelo,
    selos: selosDoRascunho(),
    conteudoSha256: hashDoConteudo(modelo),
  });
  EMITIDOS.add(rascunho);
  return rascunho;
}

// ---------------------------------------------------------------------------
// Revisao e liberacao
// ---------------------------------------------------------------------------

/**
 * Registra a revisao metodologica e devolve a versao "para conduzir". Lanca se
 * qualquer trava faltar: rascunho que este modulo nao emitiu (cobertura), parecer
 * diferente de "aprovado", revisor ou data invalidos, hash que nao e o do
 * conteudo (dados mudaram depois da revisao), versao de catalogo diferente, ou
 * catalogo nao ratificado.
 */
export function liberarParaConducao(
  rascunho: DnaColetivoRascunho,
  revisao: RevisaoMetodologica,
): DnaColetivoLiberado {
  if (!EMITIDOS.has(rascunho)) {
    throw new Error(
      "Documento nao emitido por gerarDnaColetivo: sem cobertura comprovada nao ha DNA Coletivo para liberar.",
    );
  }
  if (revisao.parecer !== "aprovado") {
    throw new Error(`Revisao metodologica com parecer "${revisao.parecer}": o documento nao e liberado.`);
  }
  if (typeof revisao.revisor !== "string" || revisao.revisor.trim().length < 3) {
    throw new Error("Revisao metodologica sem revisor identificado.");
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(revisao.revisadoEm) || Number.isNaN(Date.parse(revisao.revisadoEm))) {
    throw new Error("Revisao metodologica sem data valida.");
  }
  const hashAtual = hashDoConteudo(rascunho.modelo);
  if (hashAtual !== rascunho.conteudoSha256 || revisao.conteudoSha256 !== hashAtual) {
    throw new Error(
      "A revisao nao corresponde ao conteudo atual do documento (os dados mudaram depois da revisao): revise de novo.",
    );
  }
  if (revisao.catalogoVersao !== CATALOGO_DIMENSOES.versao) {
    throw new Error("A revisao foi feita sobre outra versao do catalogo de dimensoes.");
  }
  // Terceira trava: a mesma do one-pager individual.
  assertPublicavel();

  const data = formatarData(revisao.revisadoEm);
  const liberado: DnaColetivoLiberado = congelar({
    tipo: "liberado_para_conducao" as const,
    modelo: rascunho.modelo,
    revisao: { ...revisao },
    selos: [
      `Revisado por ${revisao.revisor.trim()}${data ? ` em ${data}` : ""} · conteúdo ${hashAtual.slice(0, 8)}`,
    ],
    conteudoSha256: hashAtual,
  });
  LIBERADOS.add(liberado);
  return liberado;
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

function renderModelo(m: DnaColetivoModelo, selos: readonly string[]): string {
  const cab = [
    m.cabecalho.eyebrow.toUpperCase(),
    m.cabecalho.titulo,
    ...(m.cabecalho.linhaEvento ? [m.cabecalho.linhaEvento] : []),
    ...selos.map((s) => `[${s}]`),
  ].join("\n");
  return [
    cab,
    m.abertura,
    renderBloco(m.cobertura),
    renderBloco(m.comoLer),
    ...m.blocos.map(renderBloco),
    renderBloco(m.conduzir),
    [
      m.dimensoes.titulo.toUpperCase(),
      ...m.dimensoes.itens.map((d) => `  - ${aspas(d.rotulo)}: ${d.definicao}`),
    ].join("\n\n"),
    m.notaDeLeitura,
  ].join("\n\n");
}

/** Texto do rascunho: sempre com o selo de revisao pendente. */
export function textoDoRascunho(d: DnaColetivoRascunho): string {
  if (!EMITIDOS.has(d)) throw new Error("Rascunho nao emitido por gerarDnaColetivo.");
  return renderModelo(d.modelo, d.selos);
}

/** Texto "para conduzir": so existe para o que `liberarParaConducao` emitiu. */
export function textoParaConducao(d: DnaColetivoLiberado): string {
  if (!LIBERADOS.has(d)) {
    throw new Error(
      "Documento nao liberado: a versao para conduzir exige revisao metodologica registrada.",
    );
  }
  return renderModelo(d.modelo, d.selos);
}

export function textoDoRelatorioOperacional(r: RelatorioOperacional): string {
  return [
    r.cabecalho.eyebrow.toUpperCase(),
    r.cabecalho.titulo,
    ...(r.cabecalho.linhaEvento ? [r.cabecalho.linhaEvento] : []),
    `[${r.cabecalho.selo}]`,
    ...r.paragrafos,
    ...(r.linhas.length > 0 ? [r.linhas.map((l) => `  - ${l.rotulo}: ${l.valor}`).join("\n")] : []),
    "O QUE FAZER\n" + r.acoes.map((a) => `  - ${a}`).join("\n"),
  ].join("\n\n");
}

export { PISO_DE_EXIBICAO };
