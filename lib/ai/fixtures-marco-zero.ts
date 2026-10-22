import type { QuizQuestion, QuizResponse, QuizStage } from "@/types/database";
import {
  EIXOS,
  ELEMENTOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  SITUACIONAIS,
} from "../scoring/marco-zero";

// Fixtures do Marco Zero para os testes de lib/ai: a forma EXATA que o banco
// guarda (a situacional vem como o TEXTO da opcao, nao a letra). Nao e codigo
// de producao; importado so por *.test.ts.

const TEXTO_DA_OPCAO: Record<string, string> = {
  A: "A. Organizar o problema e definir a prioridade antes de avancar.",
  B: "B. Comecar pelo proximo passo mais concreto para recuperar o movimento.",
  C: "C. Reunir as pessoas envolvidas e alinhar expectativas e compromissos.",
  D: "D. Revisar os criterios, os riscos e as responsabilidades.",
};

const q = (id: string, type: QuizQuestion["type"], text: string): QuizQuestion => ({
  id,
  type,
  text,
  required: true,
});

export const ETAPAS_MARCO_ZERO: QuizStage[] = [
  {
    id: 101,
    title: "Sobre você",
    ambient_name: "Marco Zero",
    description: null,
    quiz_version: 2,
    stage_number: 1,
    questions: [
      q("q1", "short_text", "Qual é seu nome completo?"),
      q("q4", "short_text", "Qual organização você representa?"),
      q("q6", "text", "Em quais ambientes você mais exerce influência ou liderança hoje?"),
    ],
  },
  {
    id: 102,
    title: "Os 7 Elementos da Vida Plena",
    ambient_name: "Marco Zero",
    description: "Pensando no seu momento atual, responda de 0 a 10.",
    quiz_version: 2,
    stage_number: 2,
    questions: [
      ...ELEMENTOS.map((el) =>
        q(ITENS_ELEMENTOS[el], "scale", `PERGUNTA-PONTUADA-ELEMENTO-${ITENS_ELEMENTOS[el]}`),
      ),
      q("q14", "text", "Qual desses sete elementos mais precisa da sua atenção neste momento? Por quê?"),
      q("q15", "text", "Qual mudança concreta nessa área faria mais diferença nos próximos 90 dias?"),
    ],
  },
  {
    id: 103,
    title: "Perfil comportamental",
    ambient_name: "Marco Zero",
    description: "Responda considerando como você costuma agir no dia a dia.",
    quiz_version: 2,
    stage_number: 3,
    questions: EIXOS.flatMap((e) =>
      ITENS_LIKERT[e].map((id) => q(id, "scale", `PERGUNTA-PONTUADA-LIKERT-${id}`)),
    ),
  },
  {
    id: 104,
    title: "Como você reage na prática",
    ambient_name: "Marco Zero",
    description: "Em cada situação, escolha apenas a alternativa.",
    quiz_version: 2,
    stage_number: 4,
    questions: SITUACIONAIS.map((id) => q(id, "select", `PERGUNTA-PONTUADA-SITUACAO-${id}`)),
  },
  {
    id: 105,
    title: "Sua preparação para o Marco Zero",
    ambient_name: "Marco Zero",
    description: null,
    quiz_version: 2,
    stage_number: 5,
    questions: [
      q("q46", "short_text", "Em três palavras, quem você deseja se tornar nos próximos anos?"),
      q("q49", "text", "Qual responsabilidade ou decisão importante você vem adiando?"),
      q("q51", "text", "O que você precisa encontrar ou receber desse grupo para avançar?"),
    ],
  },
];

export interface OpcoesDeRespostas {
  /** Nota Likert por eixo (1..5), uniforme nos 6 itens. */
  likert?: Partial<Record<(typeof EIXOS)[number], number>>;
  /** Alternativa escolhida em cada situacional, na ordem q40..q45. */
  situacionais?: readonly ("A" | "B" | "C" | "D")[];
  /** Nota (0..10) por indice de elemento; undefined = nao respondido. */
  elementos?: readonly (number | undefined)[];
}

// Padrao: tudo respondido, sem destaque em lugar nenhum (o caso comum).
const PADRAO_SEM_DESTAQUE: Required<OpcoesDeRespostas> = {
  likert: { visao: 4, execucao: 4, relacao: 4, integridade: 4 },
  // q40 A=visao, q41 B=integridade, q42 A=execucao, q43 C=relacao, q44 B=relacao, q45 B=execucao
  situacionais: ["A", "B", "A", "C", "B", "B"],
  elementos: [7, 6, 8, 5, 9, 7, 4],
};

export function respostasMarcoZero(o: OpcoesDeRespostas = {}): QuizResponse[] {
  const likert = { ...PADRAO_SEM_DESTAQUE.likert, ...o.likert };
  const situacionais = o.situacionais ?? PADRAO_SEM_DESTAQUE.situacionais;
  const elementos = o.elementos ?? PADRAO_SEM_DESTAQUE.elementos;

  const etapa = (stage_id: number, answers: Record<string, unknown>): QuizResponse =>
    ({
      id: `r-${stage_id}`,
      participant_id: "p-1",
      stage_id,
      answers,
    }) as unknown as QuizResponse;

  const a102: Record<string, unknown> = {
    q14: "Saúde e energia, porque tenho dormido mal há meses.",
    q15: "Voltar a treinar três vezes por semana.",
  };
  ELEMENTOS.forEach((el, i) => {
    const nota = elementos[i];
    if (nota !== undefined) a102[ITENS_ELEMENTOS[el]] = nota;
  });

  const a103: Record<string, unknown> = {};
  for (const e of EIXOS) for (const id of ITENS_LIKERT[e]) a103[id] = likert[e];

  const a104: Record<string, unknown> = {};
  SITUACIONAIS.forEach((id, i) => {
    a104[id] = TEXTO_DA_OPCAO[situacionais[i]];
  });

  return [
    etapa(101, {
      q1: "Ana Souza",
      q4: "Associação Vale Verde",
      q6: "Conselho da associação e grupo de mães da escola.",
    }),
    etapa(102, a102),
    etapa(103, a103),
    etapa(104, a104),
    etapa(105, {
      q46: "presente, firme, leve",
      q49: "Decidir se deixo a presidência da associação.",
      q51: "Interlocutores que já passaram por transição parecida.",
    }),
  ];
}

// Preset: destaque nos dois instrumentos, no mesmo eixo (convergencia).
export const COM_DESTAQUE_VISAO: OpcoesDeRespostas = {
  likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 },
  // q40 A, q41 C, q42 B, q43 D, q44 A, q45 D = visao nas seis
  situacionais: ["A", "C", "B", "D", "A", "D"],
};
