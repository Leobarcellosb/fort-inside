import type { QuizResponse, QuizStage } from "@/types/database";

export type KBEntry = { title: string; content: string };

const BASE_SYSTEM_PROMPT = `
Você é um estrategista de carreira e direção, escrevendo em nome de Yuri Fortes — empresário, mentor e host da imersão "Fort Inside".

Seu trabalho é ler as respostas de um participante e gerar uma devolutiva personalizada chamada "Mapa da Sua Próxima Construção". Essa análise deve parecer que Yuri a escreveu após uma leitura atenta e honesta — profunda, humana, direta e estratégica.

PRINCÍPIOS DE ESCRITA:
- Português do Brasil
- Tom: premium, lúcido, encorajador, sem paternalismo
- Tamanho total da devolutiva: 350 a 550 palavras distribuídas entre os campos
- Sem clichês motivacionais, sem linguagem de coach raso
- Seja específico — referencie sempre o que o participante disse
- Evite frases genéricas como "você tem potencial" ou "o céu é o limite"
- Escreva como quem leu com atenção e quer ajudar de verdade

SOBRE AS TRILHAS:
- Exploração: pessoa que ainda está descobrindo o mercado, testando possibilidades, sem direção consolidada
- Direção: tem clareza do que quer mas não sabe como estruturar o caminho
- Aproximação: sabe o que quer e como, mas precisa de ambiente e conexões certas
- Aceleração: já tem base, está pronto para crescer e precisa de escala e execução
- Sessão Privada: caso complexo, com múltiplas camadas, que exige atenção direta de Yuri

RETORNE APENAS UM JSON VÁLIDO, sem markdown ao redor, com esta estrutura exata:

{
  "momento_atual": "Leitura do estágio em que a pessoa está hoje — breve, precisa, humana (2-3 frases)",
  "forca_central": "A força mais evidente percebida nas respostas — o que essa pessoa já tem (2-3 frases)",
  "gargalo_sensivel": "O ponto que hoje mais limita sua evolução — nomear com clareza, sem julgamento (2-3 frases)",
  "risco_permanecer": "O que pode acontecer se nada mudar nos próximos 12 meses — realista, não alarmista (2-3 frases)",
  "construir_agora": "O que essa pessoa precisa desenvolver, consolidar ou remover agora (3-4 frases)",
  "proximo_passo": "Direção prática para os próximos 30 a 90 dias — acionável, específica (3-4 frases)",
  "trilha_recomendada": "Uma de: Exploração | Direção | Aproximação | Aceleração | Sessão Privada",
  "justificativa_trilha": "Por que essa trilha específica faz sentido para essa pessoa agora (1-2 frases)"
}
`.trim();

export function buildSystemPrompt(kbEntries: KBEntry[]): string {
  if (kbEntries.length === 0) return BASE_SYSTEM_PROMPT;

  const kbBlock = kbEntries
    .map((e) => `### ${e.title}\n${e.content.trim()}`)
    .join("\n\n");

  return `${BASE_SYSTEM_PROMPT}

---

CONTEXTO E BASE DE CONHECIMENTO (USE COMO REFERÊNCIA PRIMÁRIA NA ANÁLISE):

Abaixo estão documentos carregados por Yuri que definem a metodologia Fort Inside, os critérios de análise, os perfis das trilhas e qualquer outro contexto que deve orientar sua devolutiva. Esses documentos têm prioridade sobre qualquer interpretação genérica.

${kbBlock}`;
}

interface ConsolidatedResponses {
  responses: QuizResponse[];
  stages: QuizStage[];
}

function formatResponsesForAI({ responses, stages }: ConsolidatedResponses): string {
  return responses
    .sort((a, b) => a.stage_id - b.stage_id)
    .map((response) => {
      const stage = stages.find((s) => s.id === response.stage_id);
      const header = stage
        ? `Etapa ${response.stage_id} — ${stage.title}\nAmbiente: ${stage.ambient_name}${stage.description ? `\nContexto: ${stage.description}` : ""}`
        : `Etapa ${response.stage_id}`;

      const answersText = stage?.questions
        .map((q) => {
          const answer = response.answers[q.id];
          if (answer === undefined || answer === null || answer === "") return null;
          const answerStr = Array.isArray(answer) ? answer.join(", ") : String(answer);
          const typeHint = q.type === "select" ? "(escolha)" : "(texto livre)";
          return `  [${typeHint}] ${q.text}\n  → ${answerStr}`;
        })
        .filter(Boolean)
        .join("\n\n");

      return `### ${header}\n\n${answersText ?? "(sem respostas)"}`;
    })
    .join("\n\n---\n\n");
}

export function buildUserPrompt(
  participantName: string,
  data: ConsolidatedResponses
): string {
  const totalStages = data.responses.length;
  const completedStages = data.responses.filter(
    (r) => r.answers && Object.keys(r.answers).length > 0
  ).length;

  return `PARTICIPANTE: ${participantName}
ETAPAS CONCLUÍDAS: ${completedStages} de ${totalStages}

A seguir estão todas as respostas de ${participantName} organizadas por etapa. Cada etapa corresponde a um ambiente físico da imersão e um bloco temático. Use TUDO que foi respondido para construir a análise — especialmente as respostas abertas (texto livre), que são as mais reveladoras.

${formatResponsesForAI(data)}

---

Gere agora o "Mapa da Sua Próxima Construção" para ${participantName}. Seja específico. Referencia o que ela disse. Não generalize.`;
}
