// Contagem de etapas da VERSAO 1 do quiz (Fort Inside). NAO e "o numero de
// etapas do sistema": cada versao define as suas no banco (v2 = Marco Zero = 5).
//
// Serve SOMENTE como trava de sanidade: se a v1 aparecer com outra contagem, o
// banco foi mexido e quem le para em vez de seguir (/api/complete-quiz,
// carregarContextoQuiz, verificarEtapasDoEvento). Nenhuma rota pode usa-la como
// criterio de "o evento terminou": quantas etapas o evento tem vem de
// `quiz_stages` na `quiz_version` do evento (lib/quiz/etapas-do-evento.ts).
export const TOTAL_STAGES = 6;
