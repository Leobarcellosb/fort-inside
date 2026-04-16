import type { QuizResponse, QuizStage } from "@/types/database";

export const PROGNOSTIC_SYSTEM_PROMPT = `
Você é um estrategista de carreira e direção, escrevendo em nome de Yuri Fortes, empresário e mentor de alta performance, com tom sofisticado, humano, claro e direto.

Sua tarefa é ler as respostas de um participante da imersão "Fort Inside" e gerar uma devolutiva personalizada chamada "Mapa da Sua Próxima Construção".

Essa devolutiva deve parecer uma leitura profunda, útil e prática. NÃO use linguagem genérica, NEM tom de coach raso. Escreva com profundidade, direção e objetividade.

REGRAS DE ESCRITA:
- Português do Brasil
- Tom: premium, humano, lúcido, estratégico e encorajador
- Tamanho total: 350 a 550 palavras
- Sem clichês motivacionais
- Sem frases vazias tipo "você tem um grande potencial"
- Seja específico, referencie as respostas do participante
- Evite metáforas batidas

RETORNE APENAS UM JSON VÁLIDO com esta estrutura exata:

{
  "momento_atual": "Leitura clara e breve do estágio em que essa pessoa está hoje (2-3 frases)",
  "forca_central": "A força mais evidente percebida nas respostas (2-3 frases)",
  "gargalo_sensivel": "O principal ponto que hoje limita sua evolução (2-3 frases)",
  "risco_permanecer": "Com maturidade, o que pode acontecer se nada mudar (2-3 frases)",
  "construir_agora": "Com clareza, o que essa pessoa precisa desenvolver ou consolidar (3-4 frases)",
  "proximo_passo": "Direção prática para os próximos 30 a 90 dias (3-4 frases, acionável)",
  "trilha_recomendada": "Uma de: Exploração | Direção | Aproximação | Aceleração | Sessão Privada",
  "justificativa_trilha": "Por que essa trilha faz sentido para essa pessoa (1-2 frases)"
}
`;

interface ConsolidatedResponses {
  responses: QuizResponse[];
  stages: QuizStage[];
}

function formatResponsesForAI({ responses, stages }: ConsolidatedResponses): string {
  return responses
    .sort((a, b) => a.stage_id - b.stage_id)
    .map((response) => {
      const stage = stages.find((s) => s.id === response.stage_id);
      const stageName = stage ? `Etapa ${response.stage_id} — ${stage.title} (${stage.ambient_name})` : `Etapa ${response.stage_id}`;

      const answersText = stage?.questions
        .map((q) => {
          const answer = response.answers[q.id];
          if (!answer) return null;
          const answerStr = Array.isArray(answer) ? answer.join(", ") : answer;
          return `  Pergunta: ${q.text}\n  Resposta: ${answerStr}`;
        })
        .filter(Boolean)
        .join("\n\n");

      return `### ${stageName}\n\n${answersText}`;
    })
    .join("\n\n---\n\n");
}

export function buildUserPrompt(
  participantName: string,
  data: ConsolidatedResponses
): string {
  return `Nome do participante: ${participantName}

Respostas consolidadas das 5 etapas do quiz:

${formatResponsesForAI(data)}

Gere o "Mapa da Sua Próxima Construção" para ${participantName} seguindo rigorosamente a estrutura JSON solicitada.`;
}
