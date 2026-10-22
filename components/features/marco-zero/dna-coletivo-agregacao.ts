// Agregacao do DNA Coletivo: classifica cada participante e CONTA. Nao escreve
// texto, nao decide o que sera exibido (isso e protecao e modelo). Funcao pura.
//
// Principio: so contagens de pessoas, e so de coisas que o motor individual ja
// afirma. Nada de media de Likert (o motor nao chama de diferente uma margem
// menor que 2 pontos brutos; uma media de grupo mostraria diferencas que o
// proprio instrumento recusa), nada de ranking, nada de perfil de grupo.
//
// Definicoes (todas explicitas, porque o numero oficial depende delas):
//  - PRESENTE: `presente === true`, informado por quem chama. O schema atual nao
//    tem check-in; este modulo nao infere presenca de nenhum outro campo.
//  - RESPONDENTE (base da cobertura oficial): presente com os 24 itens Likert e as
//    6 situacionais respondidos, isto e, com a leitura de dimensoes completa.
//    Quem respondeu so em parte NAO entra: contar "respondeu algo" como cobertura
//    inflaria o numero que libera o documento.
//  - Resposta de quem nao esteve presente: fora do calculo (so aparece no
//    relatorio operacional).

import {
  EIXOS,
  ELEMENTOS,
  ITENS_LIKERT,
  SITUACIONAIS,
  type Eixo,
  type Elemento,
  type MarcoZeroScores,
} from "../../../lib/scoring/marco-zero";

export interface ParticipanteDna {
  /** Identificador interno; nunca vai para o texto. */
  id: string;
  /** Opcional e SO para a checagem de vazamento (o texto nao pode conter). */
  nome?: string;
  presente: boolean;
  /** Saida do motor para as respostas da pessoa; null = sem nenhuma resposta. */
  scores: MarcoZeroScores | null;
}

export type SituacaoParticipante =
  | "ausente"
  | "sem_resposta"
  | "incompleto"
  | "completo";

const IDS_DIMENSOES: ReadonlySet<string> = new Set([
  ...EIXOS.flatMap((e) => ITENS_LIKERT[e]),
  ...SITUACIONAIS,
]);
const TOTAL_ITENS = IDS_DIMENSOES.size + ELEMENTOS.length;

export class DadosInconsistentesDna extends Error {
  /** Descricao SEM identificadores, segura para o relatorio do host. */
  readonly descricaoPublica: string;
  constructor(mensagem: string, descricaoPublica = "os dados de participantes não são coerentes entre si") {
    super(mensagem);
    this.name = "DadosInconsistentesDna";
    this.descricaoPublica = descricaoPublica;
  }
}

export function situacaoDe(p: ParticipanteDna): SituacaoParticipante {
  if (!p.presente) return "ausente";
  const s = p.scores;
  if (s === null) return "sem_resposta";
  if (new Set(s.incompleto).size >= TOTAL_ITENS) return "sem_resposta";
  const faltaDimensao = s.incompleto.some((id) => IDS_DIMENSOES.has(id));
  const statusIncompleto =
    s.analiseLikert.status === "incompleto" ||
    s.analiseSituacional.status === "incompleto";
  // Duas fontes independentes (ids faltantes e status do motor) precisam
  // concordar em "completo"; qualquer duvida cai para "incompleto".
  return faltaDimensao || statusIncompleto ? "incompleto" : "completo";
}

export type IdCruzamento = "convergencia" | "contraste" | "algum_sem_destaque";

export interface ContagemDestaque {
  /** Respondentes com uma dimensao destacada. */
  comDestaque: number;
  /** Respondentes sem dimensao destacada (empate ou margem insuficiente). */
  semDestaque: number;
  porDimensao: Record<Eixo, number>;
}

export interface Agregado {
  convidados: number;
  presentes: number;
  /** Presentes com a leitura de dimensoes completa. Base da cobertura oficial. */
  respondentes: number;
  presentesSemResposta: number;
  presentesIncompletos: number;
  /** Quem respondeu mas nao esteve presente: fora da conta. */
  respostasDeAusentes: number;
  ausentes: number;
  pendentes: { semResposta: readonly string[]; incompletos: readonly string[] };
  autodescricao: ContagemDestaque;
  situacional: ContagemDestaque;
  cruzamento: Record<IdCruzamento, number>;
  elementos: {
    /** Presentes com resposta a cada elemento (qualquer grau de completude). */
    responderam: Record<Elemento, number>;
    soma: Record<Elemento, number>;
    /** Presentes com os sete elementos respondidos. */
    completos: number;
    /** Entre os completos: quem tem UMA menor nota (por elemento). */
    menorNotaUnica: Record<Elemento, number>;
    /** Entre os completos: menor nota empatada. */
    menorNotaEmpatada: number;
  };
}

const zeroPorEixo = (): Record<Eixo, number> => ({
  visao: 0,
  execucao: 0,
  relacao: 0,
  integridade: 0,
});
const zeroPorElemento = (): Record<Elemento, number> =>
  Object.fromEntries(ELEMENTOS.map((e) => [e, 0])) as Record<Elemento, number>;

function eixoValido(v: unknown): v is Eixo {
  return typeof v === "string" && (EIXOS as readonly string[]).includes(v);
}

export function agregar(
  convidados: number,
  participantes: readonly ParticipanteDna[],
): Agregado {
  const ids = new Set<string>();
  for (const p of participantes) {
    if (ids.has(p.id)) throw new DadosInconsistentesDna(`Participante repetido: ${p.id}`, "há participantes repetidos na lista");
    ids.add(p.id);
  }

  const ag: Agregado = {
    convidados,
    presentes: 0,
    respondentes: 0,
    presentesSemResposta: 0,
    presentesIncompletos: 0,
    respostasDeAusentes: 0,
    ausentes: 0,
    pendentes: { semResposta: [], incompletos: [] },
    autodescricao: { comDestaque: 0, semDestaque: 0, porDimensao: zeroPorEixo() },
    situacional: { comDestaque: 0, semDestaque: 0, porDimensao: zeroPorEixo() },
    cruzamento: { convergencia: 0, contraste: 0, algum_sem_destaque: 0 },
    elementos: {
      responderam: zeroPorElemento(),
      soma: zeroPorElemento(),
      completos: 0,
      menorNotaUnica: zeroPorElemento(),
      menorNotaEmpatada: 0,
    },
  };
  const semResposta: string[] = [];
  const incompletos: string[] = [];

  for (const p of participantes) {
    const sit = situacaoDe(p);
    if (sit === "ausente") {
      ag.ausentes += 1;
      if (p.scores !== null && p.scores.incompleto.length < TOTAL_ITENS) {
        ag.respostasDeAusentes += 1;
      }
      continue;
    }
    ag.presentes += 1;
    const s = p.scores;

    // Elementos: base propria (presentes), independente da leitura de dimensoes.
    if (s !== null) {
      for (const el of ELEMENTOS) {
        const e = s.elementos[el];
        if (e.status === "respondido" && e.valor !== null) {
          ag.elementos.responderam[el] += 1;
          ag.elementos.soma[el] += e.valor;
        }
      }
      if (s.analiseElementos.status === "completo") {
        const valores = ELEMENTOS.map((el) => s.elementos[el].valor);
        if (valores.some((v) => v === null)) {
          throw new DadosInconsistentesDna(
            `Elementos 'completo' com valor ausente (${p.id})`,
          );
        }
        const nums = valores as number[];
        const menor = Math.min(...nums);
        const quais = ELEMENTOS.filter((el) => s.elementos[el].valor === menor);
        ag.elementos.completos += 1;
        if (quais.length === 1) ag.elementos.menorNotaUnica[quais[0]] += 1;
        else ag.elementos.menorNotaEmpatada += 1;
      }
    }

    if (sit === "sem_resposta") {
      ag.presentesSemResposta += 1;
      semResposta.push(p.id);
      continue;
    }
    if (sit === "incompleto") {
      ag.presentesIncompletos += 1;
      incompletos.push(p.id);
      continue;
    }

    // Completo nas dimensoes: so aqui entram na leitura de dimensoes.
    const sc = s as MarcoZeroScores;
    ag.respondentes += 1;

    const l = sc.analiseLikert;
    const st = sc.analiseSituacional;
    const lDest = l.status === "destacado";
    const sDest = st.status === "destacado";
    if (lDest !== (l.eixoDestacado !== null) || (lDest && !eixoValido(l.eixoDestacado))) {
      throw new DadosInconsistentesDna(`Destaque Likert incoerente (${p.id})`);
    }
    if (sDest !== (st.eixoDestacado !== null) || (sDest && !eixoValido(st.eixoDestacado))) {
      throw new DadosInconsistentesDna(`Destaque situacional incoerente (${p.id})`);
    }
    if (lDest) {
      ag.autodescricao.comDestaque += 1;
      ag.autodescricao.porDimensao[l.eixoDestacado as Eixo] += 1;
    } else ag.autodescricao.semDestaque += 1;
    if (sDest) {
      ag.situacional.comDestaque += 1;
      ag.situacional.porDimensao[st.eixoDestacado as Eixo] += 1;
    } else ag.situacional.semDestaque += 1;

    let cruz: IdCruzamento;
    if (lDest && sDest) cruz = l.eixoDestacado === st.eixoDestacado ? "convergencia" : "contraste";
    else cruz = "algum_sem_destaque";
    const esperado =
      cruz === "convergencia" ? "convergencia" : cruz === "contraste" ? "contraste" : "inconclusivo";
    if (sc.relacaoEntreAutorrelatos !== esperado) {
      throw new DadosInconsistentesDna(
        `relacaoEntreAutorrelatos='${sc.relacaoEntreAutorrelatos}' diverge dos destaques (${p.id})`,
      );
    }
    ag.cruzamento[cruz] += 1;
  }

  ag.pendentes = { semResposta, incompletos };

  // Invariantes: toda particao fecha no total de respondentes.
  const somaDim = (c: ContagemDestaque) =>
    EIXOS.reduce((a, e) => a + c.porDimensao[e], 0);
  const fecha =
    ag.autodescricao.comDestaque + ag.autodescricao.semDestaque === ag.respondentes &&
    ag.situacional.comDestaque + ag.situacional.semDestaque === ag.respondentes &&
    somaDim(ag.autodescricao) === ag.autodescricao.comDestaque &&
    somaDim(ag.situacional) === ag.situacional.comDestaque &&
    ag.cruzamento.convergencia + ag.cruzamento.contraste + ag.cruzamento.algum_sem_destaque ===
      ag.respondentes &&
    ag.respondentes + ag.presentesIncompletos + ag.presentesSemResposta === ag.presentes &&
    ELEMENTOS.reduce((a, el) => a + ag.elementos.menorNotaUnica[el], 0) +
      ag.elementos.menorNotaEmpatada ===
      ag.elementos.completos;
  if (!fecha) throw new DadosInconsistentesDna("As contagens nao fecham no total");

  return ag;
}
