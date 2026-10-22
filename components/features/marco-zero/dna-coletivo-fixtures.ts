// Grupos sinteticos para provar o DNA Coletivo. Nada aqui e dado real: os nomes
// sao ficticios e existem so para provar que NAO vazam para o texto.

import {
  EIXOS,
  ELEMENTOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  MAPA_SITUACIONAL,
  SITUACIONAIS,
  calcularMarcoZero,
  type Alternativa,
  type Eixo,
  type Elemento,
  type RespostasAchatadas,
} from "../../../lib/scoring/marco-zero";
import {
  gateDeVolumeDaCoberturaOficial,
  type EntradaDna,
  type GateDeVolume,
} from "./dna-coletivo-modelo";
import { agregar, type ParticipanteDna } from "./dna-coletivo-agregacao";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Gate de volume: o numero vem da migration, nao daqui
// ---------------------------------------------------------------------------
// Este arquivo e usado SO por teste. Ele le o minimo direto da migration 020,
// em vez de reescrever o numero, para que nao exista um segundo lugar onde o
// limiar possa divergir do banco: mudar a view muda estes testes no mesmo
// instante.

const MIGRATION_020 = new URL(
  "../../../supabase/migrations/020_presenca_convites.sql",
  import.meta.url,
);

/** `minimo_respostas_validas` da view `marco_zero_parametros_dna`. */
export const MINIMO_RESPOSTAS_DO_BANCO: number = (() => {
  const sql = readFileSync(MIGRATION_020, "utf8");
  const m = /(\d+)\s+as\s+minimo_respostas_validas/.exec(sql);
  if (!m) {
    throw new Error(
      "nao encontrei minimo_respostas_validas na migration 020: o gate de volume perdeu a fonte",
    );
  }
  return Number(m[1]);
})();

/** A linha que `marco_zero_cobertura` devolveria com `status = 'ok'`. */
export function gateVerificado(
  respondentesValidos: number,
  minimo: number = MINIMO_RESPOSTAS_DO_BANCO,
): GateDeVolume {
  return gateDeVolumeDaCoberturaOficial({
    status: "ok",
    motivo: null,
    respondentes_validos: respondentesValidos,
    gate_minimo_respostas: respondentesValidos >= minimo,
    minimo_respostas: minimo,
  });
}

/** Grupo com o gate derivado da propria contagem de respondentes do grupo. */
function comGateDoBanco(e: Omit<EntradaDna, "gateDeVolume">): EntradaDna {
  const ag = agregar(e.convidados, e.participantes);
  return { ...e, gateDeVolume: gateVerificado(ag.respondentes) };
}

const ALTS: Alternativa[] = ["A", "B", "C", "D"];
const alt = (q: (typeof SITUACIONAIS)[number], eixo: Eixo): Alternativa =>
  ALTS.find((a) => MAPA_SITUACIONAL[q][a] === eixo) as Alternativa;

interface Perfil {
  likert: Record<Eixo, number[]>;
  situacional: (Eixo | null)[];
  elementos: Partial<Record<Elemento, number>>;
}

export function montar(p: Perfil): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  for (const e of EIXOS) {
    ITENS_LIKERT[e].forEach((id, i) => {
      const v = p.likert[e][i];
      if (v !== undefined) r[id] = v;
    });
  }
  SITUACIONAIS.forEach((q, i) => {
    const e = p.situacional[i];
    if (e) r[q] = alt(q, e);
  });
  for (const el of ELEMENTOS) {
    const v = p.elementos[el];
    if (v !== undefined) r[ITENS_ELEMENTOS[el]] = v;
  }
  return r;
}

const fixo = (n: number) => [n, n, n, n, n, n];

/** Notas dos elementos com UM menor unico, que varia com `i`. */
function elementosVariados(i: number): Record<Elemento, number> {
  const menor = ELEMENTOS[i % ELEMENTOS.length];
  const out = {} as Record<Elemento, number>;
  ELEMENTOS.forEach((el, k) => {
    out[el] = el === menor ? 3 : 5 + ((i + k) % 5); // 5..9, nunca empata com 3
  });
  return out;
}

// Quatro formas de resposta completa de dimensoes.
export function semDestaque(i: number): RespostasAchatadas {
  // Likert: margem entre o 1o e o 2o menor que 2 pontos brutos; situacional 2-2-1-1.
  return montar({
    likert: {
      visao: [4, 4, 4, 4, 4, 4],
      execucao: [4, 4, 4, 4, 4, 3],
      relacao: [4, 4, 4, 4, 3, 3],
      integridade: [4, 4, 4, 4, 4, 4],
    },
    situacional: ["visao", "execucao", "relacao", "integridade", "visao", "execucao"],
    elementos: elementosVariados(i),
  });
}
export function destaqueNosDois(eixo: Eixo, i: number): RespostasAchatadas {
  const likert = { visao: fixo(3), execucao: fixo(3), relacao: fixo(3), integridade: fixo(3) };
  likert[eixo] = fixo(5);
  const outros = EIXOS.filter((e) => e !== eixo);
  return montar({
    likert,
    situacional: [eixo, eixo, eixo, eixo, outros[0], outros[1]],
    elementos: elementosVariados(i),
  });
}
export function destaqueSoNoLikert(eixo: Eixo, i: number): RespostasAchatadas {
  const likert = { visao: fixo(3), execucao: fixo(3), relacao: fixo(3), integridade: fixo(3) };
  likert[eixo] = fixo(5);
  return montar({
    likert,
    situacional: ["visao", "visao", "execucao", "execucao", "relacao", "integridade"],
    elementos: elementosVariados(i),
  });
}
export function contraste(eixoLikert: Eixo, eixoSit: Eixo, i: number): RespostasAchatadas {
  const likert = { visao: fixo(3), execucao: fixo(3), relacao: fixo(3), integridade: fixo(3) };
  likert[eixoLikert] = fixo(5);
  const outros = EIXOS.filter((e) => e !== eixoSit);
  return montar({
    likert,
    situacional: [eixoSit, eixoSit, eixoSit, eixoSit, outros[0], outros[1]],
    elementos: elementosVariados(i),
  });
}
export function parcial(i: number): RespostasAchatadas {
  // 3 itens de Likert e 2 situacionais sem resposta; elementos completos.
  return montar({
    likert: {
      visao: [4, 4, 4, undefined as unknown as number, 4, 4],
      execucao: [undefined as unknown as number, 3, 3, 3, 3, 3],
      relacao: [3, 3, undefined as unknown as number, 3, 3, 3],
      integridade: fixo(3),
    },
    situacional: ["visao", "visao", null, null, "relacao", "visao"],
    elementos: elementosVariados(i),
  });
}
export function soElementos(i: number): RespostasAchatadas {
  return montar({
    likert: {
      visao: [], execucao: [], relacao: [], integridade: [],
    },
    situacional: [null, null, null, null, null, null],
    elementos: elementosVariados(i),
  });
}

export type Especie =
  | { t: "sem_destaque" }
  | { t: "dois"; eixo: Eixo }
  | { t: "likert"; eixo: Eixo }
  | { t: "contraste"; l: Eixo; s: Eixo }
  | { t: "parcial" }
  | { t: "so_elementos" }
  | { t: "nada" };

let seq = 0;
const NOMES = [
  "Marina Albuquerque", "Rafael Tavares", "Camila Duarte", "Bruno Siqueira",
  "Helena Prado", "Tiago Moreira", "Luciana Faria", "Otavio Nunes",
];
export function pessoa(especie: Especie, presente = true): ParticipanteDna {
  const i = seq++;
  const id = `p-${String(i).padStart(4, "0")}-${Math.abs(i * 7919) % 9973}`;
  const nome = `${NOMES[i % NOMES.length]} ${String.fromCharCode(65 + (i % 26))}ilva${i}`;
  let respostas: RespostasAchatadas | null;
  switch (especie.t) {
    case "sem_destaque": respostas = semDestaque(i); break;
    case "dois": respostas = destaqueNosDois(especie.eixo, i); break;
    case "likert": respostas = destaqueSoNoLikert(especie.eixo, i); break;
    case "contraste": respostas = contraste(especie.l, especie.s, i); break;
    case "parcial": respostas = parcial(i); break;
    case "so_elementos": respostas = soElementos(i); break;
    case "nada": respostas = null; break;
  }
  return {
    id,
    nome,
    presente,
    scores: respostas === null ? null : calcularMarcoZero(respostas),
  };
}

export function varias(n: number, e: Especie, presente = true): ParticipanteDna[] {
  return Array.from({ length: n }, () => pessoa(e, presente));
}

const META = { nomeEvento: "Marco Zero | Geração Preparada", dataEvento: "2026-11-14" };

/** Insuficiente: 12 presentes, 10 completos = 83,3% (o numero real medido antes). */
export function grupoInsuficiente(): EntradaDna {
  return comGateDoBanco({
    meta: META,
    convidados: 15,
    checkinFechado: true,
    participantes: [
      ...varias(4, { t: "sem_destaque" }),
      ...varias(3, { t: "dois", eixo: "visao" }),
      ...varias(3, { t: "likert", eixo: "relacao" }),
      pessoa({ t: "parcial" }),
      pessoa({ t: "nada" }),
      // respondeu mas nao foi: nao entra na conta
      pessoa({ t: "dois", eixo: "execucao" }, false),
    ],
  });
}

/** Suficiente: 44 presentes, 41 completos (93,2%), com celulas grandes e pequenas. */
export function grupoSuficiente(): EntradaDna {
  return comGateDoBanco({
    meta: META,
    convidados: 50,
    checkinFechado: true,
    participantes: [
      ...varias(13, { t: "sem_destaque" }),
      ...varias(10, { t: "dois", eixo: "visao" }),
      ...varias(6, { t: "dois", eixo: "execucao" }),
      ...varias(5, { t: "likert", eixo: "relacao" }),
      ...varias(3, { t: "contraste", l: "integridade", s: "relacao" }),
      ...varias(2, { t: "parcial" }),
      pessoa({ t: "nada" }),
    ],
  });
}

/** O caso mais provavel: 56 completos de 60 presentes e 41 (73,2%) sem destaque. */
export function grupoMuitosIndeterminados(): EntradaDna {
  return comGateDoBanco({
    meta: META,
    convidados: 70,
    checkinFechado: true,
    participantes: [
      ...varias(41, { t: "sem_destaque" }),
      ...varias(6, { t: "dois", eixo: "visao" }),
      ...varias(4, { t: "likert", eixo: "execucao" }),
      ...varias(3, { t: "likert", eixo: "relacao" }),
      ...varias(2, { t: "contraste", l: "integridade", s: "visao" }),
      ...varias(3, { t: "parcial" }),
      pessoa({ t: "nada" }),
    ],
  });
}

/**
 * Dados incompletos: 40 presentes, 36 completos (exatos 90,0%), 4 so em parte.
 * Dimensionado ACIMA do minimo de volume do banco de proposito: este grupo
 * existe para provar o comportamento das respostas parciais DENTRO de um
 * documento publicado, e nao o gate de volume (esse tem cenario proprio).
 */
export function grupoComDadosIncompletos(): EntradaDna {
  return comGateDoBanco({
    meta: META,
    convidados: 45,
    checkinFechado: true,
    participantes: [
      ...varias(16, { t: "sem_destaque" }),
      ...varias(11, { t: "dois", eixo: "visao" }),
      ...varias(9, { t: "likert", eixo: "execucao" }),
      // parciais: tres com elementos completos, uma so com elementos e nada de dimensoes
      pessoa({ t: "parcial" }),
      pessoa({ t: "parcial" }),
      pessoa({ t: "parcial" }),
      pessoa({ t: "so_elementos" }),
      pessoa({ t: "dois", eixo: "relacao" }, false),
    ],
  });
}
