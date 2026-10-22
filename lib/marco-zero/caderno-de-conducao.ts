// O MONTADOR DO CADERNO DE CONDUCAO. Funcao PURA: recebe a entrada estatica
// versionada (`lib/marco-zero/roteiro-oficial.ts`) e devolve o Caderno, o texto
// para papel, a pagina para impressao e o HASH do conteudo.
//
// O QUE ELE NAO RECEBE, e e a definicao do artefato: nao recebe cliente de
// banco, nao recebe resposta de questionario, nao recebe pontuacao, nao recebe
// contagem de participacao e nao chama o gerador do Guia. A unica entrada e
// conteudo estatico aprovado do evento. E por isso que o Caderno SAI COM ZERO
// RESPOSTAS NO BANCO -- que e o cenario que ele existe para atender, porque o
// envio do questionario esta bloqueado e e bem possivel que nenhum participante
// responda antes do evento.
//
// HASH PROPRIO, VERSAO PROPRIA. O Caderno nao herda o hash do Guia: ele tem
// versao (`VERSAO_DO_ROTEIRO`) e hash do proprio conteudo. O hash e o que
// permite dizer, depois do evento, QUAL versao do Caderno estava na mao de quem
// conduziu -- e o cabecalho impresso carrega os dois.
//
// NUMEROS: o Caderno IMPRIME numero operacional (horario, quantidade de
// material, minutagem das fases). Isso e deliberado e e a divisao de trabalho
// com o Guia: o gerador do Guia nao imprime digito fora da secao de
// participacao, e essa regra dele continua intacta. Numero operacional pertence
// ao Caderno. Por isso `exigirNumerosVerificados` do Guia NAO e aplicada aqui:
// ela recusaria "9h40 as 10h20", que e exatamente o que quem conduz precisa ler.
//
// AS DUAS CAMADAS DO VARREDOR, e por que uma nao basta.
// -----------------------------------------------------
// CAMADA 1, REAPROVEITADA do Guia: `encontrarRetratoColetivo`
// (components/features/marco-zero/guia-facilitador-modelo.ts). Ela recusa
// vocabulario de RETRATO COLETIVO -- percentual, media, distribuicao,
// "maioria/minoria/metade/maior parte", "dimensao/eixo" e os rotulos do
// instrumento. Serve ao Caderno e e importada como esta. UMA colisao, declarada:
// a palavra "distribuicao" e retrato no Guia e vocabulario comum de operacao no
// roteiro do evento ("a distribuicao de pilares em roda"); o Caderno diz "a roda
// dos pilares" para o mesmo fato.
//
// CAMADA 2, NOVA, porque a camada 1 NAO basta. O varredor do Guia nao pega
// "Os jovens apresentam dificuldade de decisao": nao ha percentual, nao ha
// media, nao ha rotulo de dimensao. No Guia isso nao era problema porque todo o
// texto dele e prosa fixa revisada; aqui o risco e outro -- o Caderno transcreve
// roteiro e descreve procedimento, e e justamente nesse tipo de frase que uma
// atribuicao se infiltra. Entao `encontrarAfirmacaoSobreOsJovens` recusa
// SUJEITO-NA-SALA seguido de PREDICADO DE ATRIBUICAO. A lista de predicados e
// FECHADA e nao inclui verbo de processo: "o Nucleo abre o envelope" passa,
// "o Nucleo tem dificuldade de decidir" nao passa.
//
// As duas rodam sobre TODA string do Caderno na montagem, e a montagem LANCA.

import { createHash } from "node:crypto";
import { encontrarRetratoColetivo } from "../../components/features/marco-zero/guia-facilitador-modelo";
import {
  FONTES,
  MOMENTOS_OBRIGATORIOS,
  ROTEIRO_OFICIAL,
  VERSAO_DO_ROTEIRO,
  type ClasseDeLacuna,
  type ItemDoRoteiro,
  type MomentoId,
  type Proveniencia,
  type RoteiroOficial,
} from "./roteiro-oficial";

// ---------------------------------------------------------------------------
// Moldura (textos escritos aqui: sao sobre o PROPRIO documento, nao sobre o evento)
// ---------------------------------------------------------------------------

export const TEXTOS_CADERNO = {
  restricao: "MARCO ZERO — CADERNO DE CONDUÇÃO · USO INTERNO DA ORGANIZAÇÃO",
  titulo: "Caderno de Condução",
  abertura:
    "Este Caderno responde a UMA pergunta: como conduzir o dia. Ele não afirma nada sobre as pessoas que estarão na sala e não depende de questionário respondido — existe com zero resposta digital, é montado de conteúdo estático e foi feito para ser impresso e usado sem internet.",
  tituloComoLer: "Como ler este Caderno",
  comoLer: [
    "[OFICIAL] — conteúdo do roteiro oficial do evento. A fonte vem ao lado, com o endereço e a seção de onde saiu. É verificável.",
    "[OPERAÇÃO] — procedimento escrito por quem montou este Caderno: conferência de material, guarda, contagem, digitalização, registro de quem levou o que, o que fazer sem internet. É operação, não é planejamento pedagógico e não substitui nenhum.",
    "[FALTA] — lacuna. Não há conteúdo oficial para este item. O Caderno diz o que falta e de quem tem de vir, e NÃO preenche o espaço. Um item [FALTA] é uma coisa a buscar antes de sábado, não uma coisa a improvisar na sala.",
  ],
  tituloRegra: "A regra de redação deste Caderno",
  regraDeRedacao:
    "Pergunta de condução é instrução de processo. “Como vocês chegaram a essa decisão?” pode. Frase que atribui característica a quem está na sala não aparece em nenhum momento deste Caderno, e não deve aparecer no que for acrescentado a ele: a identidade do movimento é construída pelos jovens durante a imersão, não antecipada por um documento.",
  tituloLacunas: "Lista das lacunas: o que falta, e de quem",
  tituloLimites: "Limites deste Caderno",
  limites:
    "Este Caderno não é o planejamento pedagógico do evento. Ele não escreve o conteúdo das três missões, não escreve as perguntas da SWOT, não escreve o método de construção do Manifesto e não escreve os objetivos declarados do movimento: isso é de quem planejou, e o que não chegou está marcado [FALTA], item por item, com nome de quem tem de entregar. Este Caderno também não recebe resposta de questionário, não recebe pontuação e não lê banco de dados: ele é montado de uma entrada estática versionada, e a versão e o hash do cabeçalho dizem exatamente qual Caderno estava na mão de quem conduziu.",
} as const;

// ---------------------------------------------------------------------------
// Camada 2 do varredor: afirmacao sobre quem esta na sala
// ---------------------------------------------------------------------------

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Quem esta na sala, como um documento se refere a eles. */
const SUJEITOS_NA_SALA: readonly RegExp[] = [
  /\b(os|as) (jovens|participantes|nucleos|selecionados)\b/g,
  /\b(o|este|esse|aquele) grupo\b/g,
  /\b(a|esta|essa) turma\b/g,
  /\b(a|esta|essa|nossa) geracao\b/g,
  /\b(cada|o|este|esse) nucleo\b/g,
  /\b(eles|elas|os 50)\b/g,
];

/**
 * EXPRESSOES QUE JA SAO ATRIBUICAO, sem precisar de sujeito antes nem de verbo
 * depois. "O perfil do grupo pede conducao mais firme" nao tem predicado DEPOIS
 * do sujeito -- a afirmacao esta na propria expressao, e o teste de proximidade
 * a deixaria passar. Conjunto FECHADO, recusado por si.
 */
const EXPRESSOES_DE_ATRIBUICAO: readonly { id: string; padrao: RegExp }[] = [
  {
    id: "perfil_atribuido",
    padrao:
      /\b(perfil|retrato|caracteristica|caracteristicas|tracos?|nivel|jeito)\s+(do|dos|da|das|deste|desta|desse|dessa)\s+(grupo|turma|geracao|nucleo|nucleos|jovens|participantes)\b/,
  },
  {
    id: "como_o_grupo_e",
    padrao:
      /\bcomo\s+(o grupo|a turma|a geracao|os jovens|os participantes|os nucleos)\s+(e|sao|esta|estao)\b/,
  },
];

/**
 * PREDICADOS DE ATRIBUICAO. Lista FECHADA, e de proposito sem verbo de
 * processo: o Caderno e cheio de "o Nucleo entrega", "o Nucleo abre", "cada
 * Nucleo escolhe" -- instrucao de processo, que passa. O que nao passa e o
 * documento afirmando um traco, uma tendencia ou uma falta.
 */
const PREDICADOS_DE_ATRIBUICAO: readonly { id: string; padrao: RegExp }[] = [
  { id: "traco_afirmado", padrao: /\b(apresenta|apresentam|demonstra|demonstram|revela|revelam|manifesta|manifestam|evidencia|evidenciam)\b/ },
  { id: "tendencia", padrao: /\b(tende|tendem|costuma|costumam|em geral|normalmente|tipicamente|na maioria das vezes)\b/ },
  { id: "deficit_afirmado", padrao: /\b(tem dificuldade|tem pouca|tem pouco|tem baixa|tem baixo|carece|carecem|sofre|sofrem|nao sabem|nao sabe|nao conseguem|nao costumam)\b/ },
  { id: "posse_de_traco", padrao: /\b(possui|possuem|sao (mais|menos|muito|pouco|bastante)|e um grupo que|sao um grupo que)\b/ },
];

/** Distancia maxima, em caracteres normalizados, entre sujeito e predicado. */
const JANELA = 60;

export interface RecusaDeAfirmacao {
  motivo: string;
  sujeito: string;
  predicado: string;
  trecho: string;
}

/**
 * Devolve as recusas de UM texto (vazio = limpo). Um sujeito-na-sala seguido,
 * dentro de `JANELA` caracteres, de um predicado de atribuicao.
 */
export function encontrarAfirmacaoSobreOsJovens(texto: string): RecusaDeAfirmacao[] {
  const norm = normalizar(texto);
  const recusas: RecusaDeAfirmacao[] = [];
  for (const expressao of EXPRESSOES_DE_ATRIBUICAO) {
    const achou = expressao.padrao.exec(norm);
    if (achou) {
      recusas.push({
        motivo: expressao.id,
        sujeito: achou[0],
        predicado: achou[0],
        trecho: achou[0],
      });
    }
  }
  for (const sujeito of SUJEITOS_NA_SALA) {
    const re = new RegExp(sujeito.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm)) !== null) {
      const inicio = m.index + m[0].length;
      const janela = norm.slice(inicio, inicio + JANELA);
      for (const p of PREDICADOS_DE_ATRIBUICAO) {
        const achou = p.padrao.exec(janela);
        if (achou) {
          recusas.push({
            motivo: p.id,
            sujeito: m[0],
            predicado: achou[0],
            trecho: norm.slice(m.index, inicio + JANELA),
          });
        }
      }
    }
  }
  return recusas;
}

/**
 * Lanca se algum texto do Caderno trouxer retrato coletivo (camada 1, do Guia)
 * ou afirmacao sobre quem esta na sala (camada 2, daqui).
 */
export function exigirCadernoSemAfirmacaoSobreOsJovens(textos: readonly string[]): void {
  for (const t of textos) {
    const retrato = encontrarRetratoColetivo(t);
    if (retrato.length > 0) {
      throw new Error(
        `Texto do Caderno recusado pelo varredor de retrato coletivo (${retrato
          .map((r) => `${r.motivo}: ${r.detalhe}`)
          .join(", ")}): ${t}`,
      );
    }
    const afirmacoes = encontrarAfirmacaoSobreOsJovens(t);
    if (afirmacoes.length > 0) {
      throw new Error(
        `Texto do Caderno recusado por afirmar algo sobre quem estará na sala (${afirmacoes
          .map((a) => `${a.motivo}: "${a.sujeito} ... ${a.predicado}"`)
          .join(", ")}): ${t}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tipos do Caderno montado
// ---------------------------------------------------------------------------

export type MarcaDeItem = "OFICIAL" | "OPERAÇÃO" | "FALTA";

export interface ItemDoCaderno {
  readonly marca: MarcaDeItem;
  readonly rotulo: string;
  readonly corpo: string;
  /** A linha de proveniencia impressa. `null` só em operação sem fato de apoio. */
  readonly fonte: string | null;
  /** Só em [FALTA]: de quem o conteúdo tem de vir. */
  readonly deQuem: string | null;
  /** Só em [FALTA]: a classe da lacuna, impressa em palavras. */
  readonly porQue: string | null;
}

export interface ContagemDeItens {
  readonly oficial: number;
  readonly operacao: number;
  readonly lacuna: number;
}

export interface MomentoDoCaderno {
  readonly id: MomentoId;
  readonly numero: number;
  readonly titulo: string;
  readonly quando: string | null;
  readonly itens: readonly ItemDoCaderno[];
  readonly contagem: ContagemDeItens;
}

export interface LacunaListada {
  readonly momento: MomentoId;
  readonly momentoNumero: number;
  readonly momentoTitulo: string;
  readonly rotulo: string;
  readonly falta: string;
  readonly deQuem: string;
  readonly classe: ClasseDeLacuna;
  readonly conferidoEm: readonly string[];
}

export interface CadernoDeConducao {
  readonly cabecalho: {
    readonly restricao: string;
    readonly titulo: string;
    readonly linhaEvento: string;
    readonly versao: string;
  };
  readonly abertura: string;
  readonly comoLer: readonly string[];
  readonly regraDeRedacao: string;
  readonly momentos: readonly MomentoDoCaderno[];
  readonly lacunas: readonly LacunaListada[];
  readonly limites: string;
  readonly contagem: ContagemDeItens;
  readonly fontes: readonly string[];
}

/**
 * A LINHA DO EVENTO do cabecalho. Vem do roteiro oficial (primeiro item do
 * momento 1) e nao e escrita aqui -- data, hora e local sao fato do evento.
 */
export const LINHA_DO_EVENTO =
  "Marco Zero · Geração Preparada · sábado, 24 de outubro de 2026 · 9h às 17h · Distrito Itaqui · 50 jovens em 5 Núcleos de 10";

const PALAVRAS_DA_CLASSE: Record<ClasseDeLacuna, string> = {
  pendencia_declarada:
    "o próprio roteiro oficial lista isto como pendência ou ponto a validar",
  existe_fora_do_meu_alcance:
    "o roteiro diz que o conteúdo existe em outro material, que não foi obtido para montar este Caderno",
  ausente_nas_fontes:
    "as fontes disponíveis foram conferidas e não há conteúdo oficial para isto",
};

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

function linhaDeFonte(p: Proveniencia): string {
  const f = FONTES[p.fonte];
  if (!f) throw new Error(`Proveniência aponta para fonte desconhecida: ${String(p.fonte)}`);
  return `${f.onde} · ${p.secao}`;
}

function itemDoCaderno(item: ItemDoRoteiro): ItemDoCaderno {
  if (item.tipo === "oficial") {
    if (item.texto.trim().length === 0) {
      throw new Error(`Item oficial sem texto: ${item.rotulo}`);
    }
    return {
      marca: "OFICIAL",
      rotulo: item.rotulo,
      corpo: item.texto,
      fonte: `roteiro oficial — ${linhaDeFonte(item.proveniencia)}`,
      deQuem: null,
      porQue: null,
    };
  }
  if (item.tipo === "operacao") {
    if (item.texto.trim().length === 0) {
      throw new Error(`Item de operação sem texto: ${item.rotulo}`);
    }
    const apoio = item.apoiadoEm ?? [];
    return {
      marca: "OPERAÇÃO",
      rotulo: item.rotulo,
      corpo: item.texto,
      fonte:
        apoio.length === 0
          ? "procedimento escrito para este Caderno; não é planejamento pedagógico"
          : `procedimento escrito para este Caderno; fatos de apoio no roteiro oficial — ${apoio
              .map(linhaDeFonte)
              .join(" ; ")}`,
      deQuem: null,
      porQue: null,
    };
  }
  // lacuna
  if (item.falta.trim().length === 0) throw new Error(`Lacuna sem descrição: ${item.rotulo}`);
  if (item.deQuem.trim().length === 0) throw new Error(`Lacuna sem responsável: ${item.rotulo}`);
  if (item.conferidoEm.length === 0) {
    throw new Error(`Lacuna sem registro de onde foi conferida: ${item.rotulo}`);
  }
  return {
    marca: "FALTA",
    rotulo: item.rotulo,
    corpo: item.falta,
    fonte: `conferido em — ${item.conferidoEm.map(linhaDeFonte).join(" ; ")}`,
    deQuem: item.deQuem,
    porQue: PALAVRAS_DA_CLASSE[item.classe],
  };
}

function contar(itens: readonly ItemDoCaderno[]): ContagemDeItens {
  return {
    oficial: itens.filter((i) => i.marca === "OFICIAL").length,
    operacao: itens.filter((i) => i.marca === "OPERAÇÃO").length,
    lacuna: itens.filter((i) => i.marca === "FALTA").length,
  };
}

function somar(cs: readonly ContagemDeItens[]): ContagemDeItens {
  return {
    oficial: cs.reduce((s, c) => s + c.oficial, 0),
    operacao: cs.reduce((s, c) => s + c.operacao, 0),
    lacuna: cs.reduce((s, c) => s + c.lacuna, 0),
  };
}

/**
 * Monta o Caderno. LANCA quando a entrada estatica nao fecha: momento faltando,
 * momento repetido, momento fora da lista fechada, item sem proveniencia, lacuna
 * sem responsavel -- ou texto que afirma algo sobre quem estara na sala.
 */
export function montarCaderno(roteiro: RoteiroOficial = ROTEIRO_OFICIAL): CadernoDeConducao {
  const ids = roteiro.momentos.map((m) => m.id);
  const faltando = MOMENTOS_OBRIGATORIOS.filter((id) => !ids.includes(id));
  if (faltando.length > 0) {
    throw new Error(`Caderno incompleto: momentos ausentes (${faltando.join(", ")})`);
  }
  const sobrando = ids.filter((id) => !MOMENTOS_OBRIGATORIOS.includes(id));
  if (sobrando.length > 0) {
    throw new Error(`Caderno com momento fora da lista fechada (${sobrando.join(", ")})`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Caderno com momento repetido");
  }
  if (ids.join("|") !== MOMENTOS_OBRIGATORIOS.join("|")) {
    throw new Error("Caderno com os oito momentos fora da ordem");
  }

  const momentos: MomentoDoCaderno[] = roteiro.momentos.map((m) => {
    if (m.itens.length === 0) throw new Error(`Momento sem item algum: ${m.id}`);
    const itens = m.itens.map(itemDoCaderno);
    return {
      id: m.id,
      numero: m.numero,
      titulo: m.titulo,
      quando: m.quando,
      itens,
      contagem: contar(itens),
    };
  });

  const lacunas: LacunaListada[] = [];
  for (const m of roteiro.momentos) {
    const doCaderno = momentos.find((x) => x.id === m.id);
    for (const item of m.itens) {
      if (item.tipo !== "lacuna") continue;
      lacunas.push({
        momento: m.id,
        momentoNumero: m.numero,
        momentoTitulo: doCaderno ? doCaderno.titulo : m.titulo,
        rotulo: item.rotulo,
        falta: item.falta,
        deQuem: item.deQuem,
        classe: item.classe,
        conferidoEm: item.conferidoEm.map(linhaDeFonte),
      });
    }
  }

  const caderno: CadernoDeConducao = {
    cabecalho: {
      restricao: TEXTOS_CADERNO.restricao,
      titulo: TEXTOS_CADERNO.titulo,
      linhaEvento: LINHA_DO_EVENTO,
      versao: roteiro.versao,
    },
    abertura: TEXTOS_CADERNO.abertura,
    comoLer: TEXTOS_CADERNO.comoLer,
    regraDeRedacao: TEXTOS_CADERNO.regraDeRedacao,
    momentos,
    lacunas,
    limites: TEXTOS_CADERNO.limites,
    contagem: somar(momentos.map((m) => m.contagem)),
    fontes: Object.values(FONTES).map((f) => `${f.titulo} — ${f.onde} (lido em ${f.lidoEm})`),
  };

  // O VARREDOR, nas duas camadas, sobre TODA string do Caderno. Lanca.
  exigirCadernoSemAfirmacaoSobreOsJovens(textosDoCaderno(caderno));

  return caderno;
}

// ---------------------------------------------------------------------------
// Textos, hash e papel
// ---------------------------------------------------------------------------

/** TODA string de conteudo do Caderno. Base do varredor e do hash. */
export function textosDoCaderno(c: CadernoDeConducao): string[] {
  const fora: string[] = [
    c.cabecalho.restricao,
    c.cabecalho.titulo,
    c.cabecalho.linhaEvento,
    c.cabecalho.versao,
    c.abertura,
    ...c.comoLer,
    c.regraDeRedacao,
  ];
  for (const m of c.momentos) {
    fora.push(`${m.numero}. ${m.titulo}`);
    if (m.quando) fora.push(m.quando);
    for (const i of m.itens) {
      fora.push(`[${i.marca}] ${i.rotulo}`);
      fora.push(i.corpo);
      if (i.deQuem) fora.push(`De quem: ${i.deQuem}`);
      if (i.porQue) fora.push(`Por que falta: ${i.porQue}`);
      if (i.fonte) fora.push(i.fonte);
    }
  }
  for (const l of c.lacunas) {
    fora.push(`${l.momentoNumero}. ${l.momentoTitulo} — ${l.rotulo}`);
    fora.push(l.falta);
    fora.push(`De quem: ${l.deQuem}`);
    fora.push(...l.conferidoEm);
  }
  fora.push(c.limites);
  fora.push(...c.fontes);
  return fora;
}

export function hashDoCaderno(c: CadernoDeConducao): string {
  return createHash("sha256").update(textosDoCaderno(c).join("\n␟\n")).digest("hex");
}

/** O Caderno em texto corrido: e isto que vai para o arquivo e para o papel. */
export function textoDoCaderno(c: CadernoDeConducao): string {
  const hash = hashDoCaderno(c);
  const partes: string[] = [
    [
      c.cabecalho.restricao,
      c.cabecalho.titulo,
      c.cabecalho.linhaEvento,
      `Versão ${c.cabecalho.versao} · conteúdo ${hash}`,
    ].join("\n"),
    c.abertura,
    [
      TEXTOS_CADERNO.tituloComoLer.toUpperCase(),
      ...c.comoLer.map((l) => `  ${l}`),
      "",
      `  Neste Caderno: ${c.contagem.oficial} itens [OFICIAL], ${c.contagem.operacao} itens [OPERAÇÃO], ${c.contagem.lacuna} itens [FALTA].`,
    ].join("\n"),
    [TEXTOS_CADERNO.tituloRegra.toUpperCase(), c.regraDeRedacao].join("\n\n"),
  ];

  for (const m of c.momentos) {
    const cab = `MOMENTO ${m.numero} — ${m.titulo.toUpperCase()}${m.quando ? `\n(${m.quando})` : ""}`;
    const corpo = m.itens.map((i) => {
      const linhas = [`[${i.marca}] ${i.rotulo}`, `  ${i.corpo}`];
      if (i.deQuem) linhas.push(`  DE QUEM: ${i.deQuem}`);
      if (i.porQue) linhas.push(`  POR QUE FALTA: ${i.porQue}`);
      if (i.fonte) linhas.push(`  FONTE: ${i.fonte}`);
      return linhas.join("\n");
    });
    partes.push([cab, ...corpo].join("\n\n"));
  }

  partes.push(
    [
      TEXTOS_CADERNO.tituloLacunas.toUpperCase(),
      ...c.lacunas.map(
        (l, n) =>
          `${n + 1}. (momento ${l.momentoNumero}, ${l.momentoTitulo}) ${l.rotulo}\n   FALTA: ${l.falta}\n   DE QUEM: ${l.deQuem}\n   CONFERIDO EM: ${l.conferidoEm.join(" ; ")}`,
      ),
    ].join("\n\n"),
  );

  partes.push([TEXTOS_CADERNO.tituloLimites.toUpperCase(), c.limites].join("\n\n"));
  partes.push(["FONTES", ...c.fontes.map((f) => `  - ${f}`)].join("\n"));
  return partes.join("\n\n");
}

// ---------------------------------------------------------------------------
// A pagina para imprimir: HTML autocontido, sem rede, sem script
// ---------------------------------------------------------------------------

function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * HTML AUTOCONTIDO: sem script, sem fonte externa, sem imagem, nada de rede.
 * Baixado uma vez, abre e imprime sem internet -- que e o requisito do artefato.
 */
export function paginaImprimivelDoCaderno(c: CadernoDeConducao): string {
  const hash = hashDoCaderno(c);
  const e = escaparHtml;
  const momentos = c.momentos
    .map((m) => {
      const itens = m.itens
        .map((i) => {
          const extras: string[] = [];
          if (i.deQuem) extras.push(`<p class="meta"><strong>De quem:</strong> ${e(i.deQuem)}</p>`);
          if (i.porQue) extras.push(`<p class="meta"><strong>Por que falta:</strong> ${e(i.porQue)}</p>`);
          if (i.fonte) extras.push(`<p class="fonte">${e(i.fonte)}</p>`);
          const classe = i.marca === "FALTA" ? "item falta" : i.marca === "OPERAÇÃO" ? "item operacao" : "item oficial";
          return `<div class="${classe}"><p class="rotulo"><span class="marca">[${e(i.marca)}]</span> ${e(i.rotulo)}</p><p class="corpo">${e(i.corpo)}</p>${extras.join("")}</div>`;
        })
        .join("");
      return `<section class="momento"><h2>Momento ${m.numero} — ${e(m.titulo)}</h2>${m.quando ? `<p class="quando">${e(m.quando)}</p>` : ""}${itens}</section>`;
    })
    .join("");

  const lacunas = c.lacunas
    .map(
      (l, n) =>
        `<li><strong>${n + 1}. ${e(l.rotulo)}</strong> <span class="quando">(momento ${l.momentoNumero}, ${e(l.momentoTitulo)})</span><p class="corpo">${e(l.falta)}</p><p class="meta"><strong>De quem:</strong> ${e(l.deQuem)}</p><p class="fonte">conferido em — ${e(l.conferidoEm.join(" ; "))}</p></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.cabecalho.titulo)} — Marco Zero</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #fff; color: #111;
         font: 11pt/1.5 Georgia, "Times New Roman", serif; max-width: 48rem; }
  header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 20px; }
  .restricao { font: 700 9pt/1.3 Arial, Helvetica, sans-serif; letter-spacing: .08em; margin: 0 0 6px; }
  h1 { font-size: 20pt; margin: 0 0 6px; }
  .evento { margin: 0 0 4px; }
  .versao { font: 8.5pt/1.4 "Courier New", monospace; color: #444; margin: 0; word-break: break-all; }
  h2 { font-size: 13pt; margin: 0 0 2px; border-bottom: 1px solid #bbb; padding-bottom: 3px; }
  h3 { font-size: 11pt; margin: 20px 0 6px; text-transform: uppercase; letter-spacing: .05em; }
  .quando { font: italic 9.5pt/1.4 Georgia, serif; color: #555; margin: 0 0 10px; }
  .momento { margin: 0 0 22px; page-break-inside: avoid; break-inside: avoid; }
  .item { margin: 0 0 12px; padding-left: 10px; border-left: 3px solid #ccc; page-break-inside: avoid; break-inside: avoid; }
  .item.falta { border-left-color: #111; background: #f4f4f4; padding: 8px 10px; }
  .item.operacao { border-left-color: #888; }
  .rotulo { font-weight: 700; margin: 0 0 3px; }
  .marca { font: 700 8.5pt Arial, Helvetica, sans-serif; letter-spacing: .06em; }
  .corpo { margin: 0 0 4px; }
  .meta { margin: 0 0 3px; font-size: 10pt; }
  .fonte { margin: 0; font: 8.5pt/1.4 Arial, Helvetica, sans-serif; color: #555; word-break: break-word; }
  ol.lacunas { padding-left: 1.4rem; }
  ol.lacunas li { margin-bottom: 12px; page-break-inside: avoid; break-inside: avoid; }
  ul.como-ler { padding-left: 1.2rem; }
  footer { border-top: 1px solid #bbb; margin-top: 20px; padding-top: 10px; font-size: 9.5pt; }
  @page { margin: 16mm; }
  @media print {
    body { padding: 0; max-width: none; }
    a[href]:after { content: ""; }
  }
</style>
</head>
<body>
<header>
  <p class="restricao">${e(c.cabecalho.restricao)}</p>
  <h1>${e(c.cabecalho.titulo)}</h1>
  <p class="evento">${e(c.cabecalho.linhaEvento)}</p>
  <p class="versao">Versão ${e(c.cabecalho.versao)} · conteúdo ${e(hash)}</p>
</header>
<p>${e(c.abertura)}</p>
<h3>${e(TEXTOS_CADERNO.tituloComoLer)}</h3>
<ul class="como-ler">${c.comoLer.map((l) => `<li>${e(l)}</li>`).join("")}</ul>
<p class="meta">Neste Caderno: ${c.contagem.oficial} itens [OFICIAL], ${c.contagem.operacao} itens [OPERAÇÃO], ${c.contagem.lacuna} itens [FALTA].</p>
<h3>${e(TEXTOS_CADERNO.tituloRegra)}</h3>
<p>${e(c.regraDeRedacao)}</p>
${momentos}
<h3>${e(TEXTOS_CADERNO.tituloLacunas)}</h3>
<ol class="lacunas">${lacunas}</ol>
<h3>${e(TEXTOS_CADERNO.tituloLimites)}</h3>
<p>${e(c.limites)}</p>
<footer>
  <p><strong>Fontes</strong></p>
  <ul>${c.fontes.map((f) => `<li>${e(f)}</li>`).join("")}</ul>
</footer>
</body>
</html>`;
}

/** O Caderno de hoje, pronto. Conveniência para a rota e para os testes. */
export function cadernoDeConducao(): {
  caderno: CadernoDeConducao;
  conteudoSha256: string;
  texto: string;
  versao: string;
} {
  const caderno = montarCaderno(ROTEIRO_OFICIAL);
  return {
    caderno,
    conteudoSha256: hashDoCaderno(caderno),
    texto: textoDoCaderno(caderno),
    versao: VERSAO_DO_ROTEIRO,
  };
}
