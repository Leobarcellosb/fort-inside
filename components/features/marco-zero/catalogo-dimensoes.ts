// Catalogo FECHADO das quatro dimensoes do Marco Zero: rotulo publico +
// definicao oficial + versao. Artefato proprio, separado do motor de scoring
// (lib/scoring/marco-zero.ts), que continua usando so as chaves internas
// `visao`/`execucao`/`relacao`/`integridade` (nao renomeadas).
//
// STATUS DOS NOMES: "rotulos funcionais de apresentacao, para desbloquear o
// desenvolvimento". NAO sao nomes de perfis psicometricos validados nem a
// nomenclatura definitiva da metodologia; antes da publicacao o responsavel
// pela metodologia deve ratifica-los (`estado` fica "funcional_pendente_de_ratificacao" ate la). Sao nomes de
// DIMENSOES avaliadas, nunca de tipo de pessoa.
//
// REGRA: nenhum modelo de IA pode criar um quinto nome, renomear uma dimensao
// ou transformar uma dimensao em tipo de personalidade. Por isso:
//  - o catalogo e indexado por `Eixo` (as 4 chaves do motor) e congelado;
//  - nao ha funcao de registro/adicao; o unico acesso e `dimensaoDoEixo(eixo)`;
//  - o carregamento do modulo LANCA se as chaves divergirem das do motor.
// Mudar um texto aqui e decisao de metodologia e exige subir `versao`.

import { EIXOS, type Eixo } from "../../../lib/scoring/marco-zero";

// O conjunto de nomes e fechado NO TIPO: `RotuloDimensao` e a uniao dos quatro
// literais. Um quinto nome nao e expressavel em nenhum campo tipado como
// `RotuloDimensao` (erro de compilacao), e o varredor de saida
// (validacao-saida.ts) recusa em tempo de execucao qualquer texto que nomeie
// dimensao fora desta lista.
export const ROTULOS_DIMENSAO = [
  "Visão e Direção",
  "Execução e Consistência",
  "Relacionamento e Colaboração",
  "Integridade e Responsabilidade",
] as const;
export type RotuloDimensao = (typeof ROTULOS_DIMENSAO)[number];

export type EstadoDeRatificacao =
  | "funcional_pendente_de_ratificacao"
  | "ratificado";

export interface DimensaoDoCatalogo {
  /** Rotulo funcional de apresentacao. Unica forma de nomear a dimensao. */
  readonly rotulo: RotuloDimensao;
  /** Definicao oficial. Sempre de capacidade AUTODECLARADA. */
  readonly definicao: string;
  /** Perguntas Likert que medem a dimensao (informativo). */
  readonly perguntas: string;
}

export interface CatalogoDimensoes {
  readonly versao: string;
  /**
   * "funcional_pendente_de_ratificacao": liberado para desenvolvimento e
   * testes; PUBLICACAO oficial dos documentos so apos ratificacao editorial
   * pelo responsavel pela metodologia (ver `assertPublicavel`).
   */
  readonly estado: EstadoDeRatificacao;
  readonly dimensoes: Readonly<Record<Eixo, DimensaoDoCatalogo>>;
}

export const CATALOGO_DIMENSOES: CatalogoDimensoes = deepFreeze({
  versao: "0.1.0-funcional",
  estado: "funcional_pendente_de_ratificacao",
  dimensoes: {
    visao: {
      rotulo: "Visão e Direção",
      definicao:
        "Capacidade autodeclarada de identificar prioridades, analisar possibilidades, reconhecer padrões e orientar decisões considerando o futuro.",
      perguntas: "16 a 21",
    },
    execucao: {
      rotulo: "Execução e Consistência",
      definicao:
        "Capacidade autodeclarada de transformar ideias em ações, organizar entregas, cumprir compromissos e sustentar a execução.",
      perguntas: "22 a 27",
    },
    relacao: {
      rotulo: "Relacionamento e Colaboração",
      definicao:
        "Capacidade autodeclarada de escutar, comunicar, conectar pessoas, incluir perspectivas e lidar com diferenças.",
      perguntas: "28 a 33",
    },
    integridade: {
      rotulo: "Integridade e Responsabilidade",
      definicao:
        "Capacidade autodeclarada de preservar princípios, avaliar riscos, honrar compromissos, buscar qualidade e considerar consequências.",
      perguntas: "34 a 39",
    },
  },
});

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

// Fechamento: as chaves do catalogo sao exatamente as do motor, nem mais, nem
// menos, e cada rotulo e unico e nao vazio.
(function validarCatalogo() {
  const chaves = Object.keys(CATALOGO_DIMENSOES.dimensoes).sort();
  const esperadas = [...EIXOS].sort();
  if (chaves.join("|") !== esperadas.join("|")) {
    throw new Error(
      `Catalogo de dimensoes diverge dos eixos do motor: ${chaves.join(", ")}`,
    );
  }
  const rotulos = EIXOS.map((e) => CATALOGO_DIMENSOES.dimensoes[e].rotulo);
  if (
    new Set(rotulos).size !== rotulos.length ||
    [...rotulos].sort().join("|") !== [...ROTULOS_DIMENSAO].sort().join("|")
  ) {
    throw new Error("Catalogo de dimensoes diverge dos quatro rotulos fechados");
  }
})();

/** Barreira de publicacao: lanca enquanto os rotulos nao forem ratificados. */
export function assertPublicavel(): void {
  if (CATALOGO_DIMENSOES.estado !== "ratificado") {
    throw new Error(
      `Catalogo de dimensoes ${CATALOGO_DIMENSOES.versao} esta "${CATALOGO_DIMENSOES.estado}": os rotulos sao funcionais, a publicacao oficial exige ratificacao da metodologia.`,
    );
  }
}

export function rotuloDaDimensao(eixo: Eixo): RotuloDimensao {
  return CATALOGO_DIMENSOES.dimensoes[eixo].rotulo;
}

export function dimensaoDoEixo(eixo: Eixo): DimensaoDoCatalogo {
  return CATALOGO_DIMENSOES.dimensoes[eixo];
}

/** Mapa eixo -> rotulo, no formato que a camada de briefing espera. */
export const ROTULOS_EIXOS_MARCO_ZERO: Readonly<Record<Eixo, RotuloDimensao>> =
  Object.freeze(
    Object.fromEntries(
      EIXOS.map((e) => [e, CATALOGO_DIMENSOES.dimensoes[e].rotulo]),
    ) as Record<Eixo, RotuloDimensao>,
  );
