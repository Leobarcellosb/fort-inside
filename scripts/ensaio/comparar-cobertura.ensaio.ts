// comparar-cobertura.ensaio.ts -- o COMPARADOR do ensaio "banco vs scoring".
//
// Le o json que scripts/ensaio/extrair-cobertura.sql tirou do banco descartavel
// e decide, PARTICIPANTE POR PARTICIPANTE, se o que o BANCO considera resposta
// valida e o que o SCORING considera semanticamente valido sao a mesma coisa.
//
// POR QUE PARTICIPANTE POR PARTICIPANTE, E NAO DUAS CONTAGENS
// -----------------------------------------------------------
// Duas contagens agregadas iguais podem esconder dois defeitos que se cancelam:
// um participante que o banco conta e o scoring nao, e outro no inverso, dao o
// mesmo total. Este comparador emite a tabela por participante, a lista dos
// divergentes com o motivo de cada um, e -- de proposito -- o diagnostico de
// quantos divergem em CADA direcao, que e o numero que o agregado apaga.
//
// AS DUAS DEFINICOES, COMO ELAS ESTAO HOJE
// ----------------------------------------
// BANCO (public.marco_zero_respostas_validas, migration 020):
//   valido = (etapas respondidas == etapas da quiz_version do evento)
//            AND (todas as etapas com `answers` objeto NAO vazio)
//            AND participants.completed_at IS NOT NULL
//   Conta na cobertura quem, alem disso, tem check-in ATIVO.
// SCORING (lib/scoring/achatar-respostas.ts + lib/scoring/marco-zero.ts, lido
// por situacaoDe de dna-coletivo-agregacao.ts):
//   respondente = presente AND os 24 itens Likert (q16..q39, inteiros 1..5) e
//                 as 6 situacionais (q40..q45, "A".."D") presentes e DENTRO do
//                 dominio. Valor presente e fora do dominio nao e "ausente":
//                 achatarRespostas LANCA.
//
// ESTE ARQUIVO NAO REPROVA DIVERGENCIA. A divergencia e o FATO que o ensaio
// existe para descobrir; falhar aqui tornaria a medicao irrepetivel. O que ele
// reprova e o ensaio ter rodado mal: cenario ausente, export malformado,
// participante sem veredito dos dois lados.
//
// Nao entra na suite padrao (`npx vitest run`): depende de Docker e de um banco
// construido na hora. Roda pelo orquestrador, com config propria
// (scripts/ensaio/vitest.ensaio.config.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ErroNormalizacaoResposta,
  achatarRespostas,
  type LinhaDeRespostas,
} from "../../lib/scoring/achatar-respostas";
import {
  EIXOS,
  ITENS_LIKERT,
  SITUACIONAIS,
  calcularMarcoZero,
} from "../../lib/scoring/marco-zero";
import {
  situacaoDe,
  type SituacaoParticipante,
} from "../../components/features/marco-zero/dna-coletivo-agregacao";

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

interface VereditoDoBanco {
  etapas_exigidas: number | null;
  etapas_respondidas: number | null;
  completo: boolean | null;
  valido: boolean | null;
  tem_completed_at: boolean;
}

interface ParticipanteExportado {
  codigo: string;
  cenario: string;
  presente: boolean;
  banco: VereditoDoBanco;
  respostas_da_versao: LinhaDeRespostas[];
  respostas_todas: LinhaDeRespostas[];
}

interface Exportacao {
  evento: { quiz_version: number };
  etapas_da_versao: number[];
  cobertura: Record<string, unknown>;
  participantes: ParticipanteExportado[];
}

/** Os cenarios que a revisao e o dono exigiram presentes e identificaveis. */
const CENARIOS_EXIGIDOS = [
  "resposta-vazia",
  "alternativa-incompativel",
  "dimensao-incompleta",
  "completo-de-verdade",
  "conclusao-administrativa-indevida",
  // pedidos pelo dono da unidade
  "versao-de-quiz-diferente",
  "dimensao-inteira-faltando",
] as const;

const IDS_DIMENSOES: readonly string[] = [
  ...EIXOS.flatMap((e) => ITENS_LIKERT[e]),
  ...SITUACIONAIS,
];

function carregar(): Exportacao {
  const caminho = process.env.ENSAIO_EXPORT;
  if (!caminho) {
    throw new Error(
      "ENSAIO_EXPORT nao definido: rode por scripts/ensaio-cobertura-vs-scoring.sh, que constroi o banco e exporta o json.",
    );
  }
  return JSON.parse(readFileSync(caminho, "utf8")) as Exportacao;
}

// ---------------------------------------------------------------------------
// O lado do SCORING
// ---------------------------------------------------------------------------

type VeredictoScoring = SituacaoParticipante | "erro_de_normalizacao";

interface LeituraDoScoring {
  situacao: VeredictoScoring;
  /** Ids de dimensao que o motor nao conseguiu ler (ausentes ou fora do dominio). */
  dimensoesFaltando: string[];
  /** Mensagem de achatarRespostas, quando ele recusou os dados. */
  erro: string | null;
}

function lerPeloScoring(
  presente: boolean,
  linhas: readonly LinhaDeRespostas[],
): LeituraDoScoring {
  if (!presente) {
    return { situacao: "ausente", dimensoesFaltando: [], erro: null };
  }
  let achatadas;
  try {
    achatadas = achatarRespostas(linhas);
  } catch (e) {
    if (e instanceof ErroNormalizacaoResposta) {
      // Valor presente e ilegivel e ERRO DE DADOS, nao ausencia de resposta:
      // o caminho de producao (lib/ai/briefing-prognostico.ts) recusa em 422.
      return {
        situacao: "erro_de_normalizacao",
        dimensoesFaltando: [],
        erro: e.message,
      };
    }
    throw e;
  }
  if (linhas.length === 0) {
    return { situacao: "sem_resposta", dimensoesFaltando: [...IDS_DIMENSOES], erro: null };
  }
  const scores = calcularMarcoZero(achatadas);
  const faltando = IDS_DIMENSOES.filter((id) => scores.incompleto.includes(id));
  return {
    situacao: situacaoDe({ id: "ensaio", presente: true, scores }),
    dimensoesFaltando: faltando,
    erro: null,
  };
}

// ---------------------------------------------------------------------------
// A comparacao
// ---------------------------------------------------------------------------

interface Comparacao {
  codigo: string;
  cenario: string;
  presente: boolean;
  /** `valido` cru da funcao do banco, sem o filtro de presenca. */
  bancoValido: boolean | null;
  /** O que o banco de fato SOMA na cobertura: presente E valido. */
  bancoConta: boolean;
  estrito: LeituraDoScoring;
  ingenuo: LeituraDoScoring;
  /** O que o scoring de fato SOMA em `respondentes` (adaptador estrito). */
  scoringConta: boolean;
  concordam: boolean;
  motivo: string;
}

function motivoDaDivergencia(c: Omit<Comparacao, "motivo">, b: VereditoDoBanco): string {
  if (c.concordam) return "";
  const etapas = `${b.etapas_respondidas ?? "?"}/${b.etapas_exigidas ?? "?"} etapas`;
  if (c.bancoConta && !c.scoringConta) {
    if (c.estrito.situacao === "erro_de_normalizacao") {
      return `banco conta (${etapas} nao vazias + completed_at) e o scoring RECUSA os dados: ${c.estrito.erro}`;
    }
    const n = c.estrito.dimensoesFaltando.length;
    return (
      `banco conta (${etapas} nao vazias + completed_at) e o scoring nao: ` +
      `${n} de ${IDS_DIMENSOES.length} itens de dimensao ilegiveis ou ausentes ` +
      `(${c.estrito.dimensoesFaltando.slice(0, 8).join(", ")}${n > 8 ? ", ..." : ""})`
    );
  }
  const porque = !b.tem_completed_at
    ? "participants.completed_at e NULL"
    : `so ${etapas} gravadas`;
  return (
    `scoring conta (as ${IDS_DIMENSOES.length} dimensoes presentes e no dominio) ` +
    `e o banco nao: ${porque}`
  );
}

function comparar(p: ParticipanteExportado): Comparacao {
  const estrito = lerPeloScoring(p.presente, p.respostas_da_versao);
  const ingenuo = lerPeloScoring(p.presente, p.respostas_todas);
  const bancoConta = p.presente && p.banco.valido === true;
  const scoringConta = estrito.situacao === "completo";
  const parcial = {
    codigo: p.codigo,
    cenario: p.cenario,
    presente: p.presente,
    bancoValido: p.banco.valido,
    bancoConta,
    estrito,
    ingenuo,
    scoringConta,
    concordam: bancoConta === scoringConta,
  };
  return { ...parcial, motivo: motivoDaDivergencia(parcial, p.banco) };
}

// ---------------------------------------------------------------------------
// Saida
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}~` : s.padEnd(n));
const sim = (b: boolean) => (b ? "SIM" : "nao");

function imprimir(x: Exportacao, cs: readonly Comparacao[]): void {
  const linhas: string[] = [];
  const p = (s = "") => linhas.push(s);

  p();
  p("=".repeat(118));
  p("ENSAIO -- O QUE O BANCO CONTA COMO RESPOSTA VALIDA x O QUE O SCORING CONTA COMO SEMANTICAMENTE VALIDA");
  p("=".repeat(118));
  p(`banco descartavel construido pelas mesmas migrations de supabase/migrations/ | quiz_version do evento: ${x.evento.quiz_version}`);
  p(`etapas da versao: ${x.etapas_da_versao.join(", ")} | itens de dimensao exigidos pelo scoring: ${IDS_DIMENSOES.length}`);
  p();
  p("-".repeat(118));
  p(
    `${pad("cod", 5)}${pad("cenario", 36)}${pad("presente", 10)}${pad("BANCO", 9)}${pad("SCORING", 24)}${pad("CONCORDAM", 11)}`,
  );
  p("-".repeat(118));
  for (const c of cs) {
    p(
      pad(c.codigo, 5) +
        pad(c.cenario, 36) +
        pad(sim(c.presente), 10) +
        pad(c.bancoConta ? "conta" : "NAO", 9) +
        pad(c.estrito.situacao, 24) +
        pad(c.concordam ? "sim" : ">>> NAO <<<", 11),
    );
  }
  p("-".repeat(118));

  const divergentes = cs.filter((c) => !c.concordam);
  p();
  p(`DIVERGENTES: ${divergentes.length} de ${cs.length} participantes`);
  if (divergentes.length === 0) {
    p("  (nenhum)");
  } else {
    for (const c of divergentes) {
      p(`  ${c.codigo} ${c.cenario}`);
      p(`      ${c.motivo}`);
    }
  }

  const bancoSim = cs.filter((c) => !c.concordam && c.bancoConta).length;
  const scoringSim = cs.filter((c) => !c.concordam && c.scoringConta).length;
  const totalBanco = cs.filter((c) => c.bancoConta).length;
  const totalScoring = cs.filter((c) => c.scoringConta).length;

  p();
  p("POR QUE A CONTAGEM AGREGADA NAO BASTA");
  p(`  o banco conta   ${totalBanco} respostas validas entre os presentes`);
  p(`  o scoring conta ${totalScoring} respostas semanticamente validas entre os presentes`);
  p(`  diferenca dos AGREGADOS: ${Math.abs(totalBanco - totalScoring)}`);
  p(`  participantes de fato CLASSIFICADOS DIFERENTE: ${divergentes.length}`);
  p(`    ${bancoSim} que o banco conta e o scoring nao`);
  p(`    ${scoringSim} que o scoring conta e o banco nao`);
  p(
    `  os ${scoringSim} do segundo grupo CANCELAM ${scoringSim} do primeiro no agregado: com ` +
      `${bancoSim} e ${bancoSim} os dois totais seriam iguais e ${bancoSim * 2} participantes ` +
      "seguiriam classificados errado. E por isso que a ordem era comparar por participante.",
  );

  p();
  p("ADAPTADOR QUE ESQUECE O FILTRO DE VERSAO DO QUESTIONARIO");
  p("  (producao filtra por quiz_version em lib/ai/contexto-quiz.ts; este e o efeito de nao filtrar)");
  const mudam = cs.filter((c) => c.estrito.situacao !== c.ingenuo.situacao);
  if (mudam.length === 0) p("  nenhum participante muda de veredito");
  for (const c of mudam) {
    p(`  ${c.codigo} ${c.cenario}: com filtro = ${c.estrito.situacao} | sem filtro = ${c.ingenuo.situacao}`);
  }

  p();
  p("LINHA OFICIAL DE public.marco_zero_cobertura (o agregado do banco)");
  for (const k of [
    "status",
    "presentes",
    "respondentes_validos",
    "cobertura_percentual",
    "minimo_respostas",
    "cobertura_minima_percentual",
    "gate_minimo_respostas",
    "gate_cobertura",
  ]) {
    p(`  ${pad(k, 30)} ${String(x.cobertura[k])}`);
  }
  p("=".repeat(118));
  p();

  // eslint-disable-next-line no-console
  console.log(linhas.join("\n"));
}

// ---------------------------------------------------------------------------

describe("ensaio: definicao de resposta completa, banco x scoring, participante por participante", () => {
  const x = carregar();
  const cs = x.participantes.map(comparar);

  it("emite a tabela por participante, a lista de divergentes e o diagnostico do agregado", () => {
    imprimir(x, cs);
    expect(cs.length).toBeGreaterThan(0);
  });

  it("contem todos os cenarios exigidos, identificaveis na saida", () => {
    const presentes = new Set(cs.map((c) => c.cenario));
    for (const cenario of CENARIOS_EXIGIDOS) {
      expect(presentes, `cenario exigido ausente da massa: ${cenario}`).toContain(cenario);
    }
  });

  it("tem os dois vereditos para cada participante (sem isso nao houve comparacao)", () => {
    for (const c of cs) {
      expect(c.bancoValido, `${c.codigo}: o banco nao devolveu veredito`).not.toBeNull();
      expect(
        ["ausente", "sem_resposta", "incompleto", "completo", "erro_de_normalizacao"],
        `${c.codigo}: veredito de scoring fora do conjunto previsto`,
      ).toContain(c.estrito.situacao);
    }
  });

  it("a cobertura do banco e oficial (check-in fechado), senao o ensaio nao mediu nada", () => {
    expect(x.cobertura.status).toBe("ok");
  });
});
