// Configuração do worker da fila. Tudo por variável de ambiente, com padrão
// seguro, porque nenhum destes números foi MEDIDO ainda.
//
// A concorrência inicial é 3 por decisão explícita do responsável técnico, para
// ser calibrada DEPOIS de medir três coisas que hoje não sabemos:
//   - o limite de requisições/tokens por minuto da organização na Anthropic;
//   - a distribuição real da latência por prognóstico (63s é a mediana de UMA
//     medição, não uma distribuição);
//   - a taxa de erro sob paralelismo (429 e 5xx aparecem com carga, não no teste
//     de um participante só).
// Enquanto isso não for medido, NENHUM prazo de conclusão para 50 participantes
// pode ser prometido. O que a fila garante é que o trabalho não se perde, não
// que termina em X minutos.

export interface ConfigFila {
  /** Teto GLOBAL de jobs com lease vivo, não teto por processo. Ver 018. */
  concorrencia: number;
  /** Validade do lease. O worker renova enquanto trabalha. */
  leaseSegundos: number;
  /**
   * Intervalo entre renovações. Precisa ser bem menor que o lease: se a
   * renovação acontecesse perto do vencimento, uma pausa de GC ou um pico de
   * latência no banco deixaria o lease vencer com o worker vivo, e outro worker
   * reivindicaria um job que ainda está sendo feito (trabalho pago em dobro).
   */
  renovarCadaMs: number;
  /** Espera antes de a tentativa seguinte ficar elegível. */
  backoffSegundos: number;
  /**
   * Quanto tempo o tick aceita trabalhar antes de devolver a resposta. Tem de
   * caber com folga no maxDuration da rota: o que estourar o teto da função é
   * cortado no meio, e o lease é que recupera -- mas recuperar custa uma
   * tentativa (e, no prognóstico, possivelmente crédito de IA). Melhor devolver
   * cedo e deixar o tick seguinte continuar.
   */
  orcamentoTickMs: number;
  /** Teto de jobs que um único tick leva até o fim. Limita o pior caso. */
  maxJobsPorTick: number;
  /** Teto de linhas varridas pela recuperação de lease vencido por tick. */
  maxRecuperarPorTick: number;
  /**
   * Limiar do alerta de saúde: havendo job pendente e NENHUM sinal de progresso
   * do worker por mais que isto, a fila é declarada em alerta.
   *
   * Configurável de propósito: vai ser reavaliado conforme a frequência efetiva
   * do agendador. Cravar 3 minutos como constante no meio do código tornaria o
   * limiar invisível justamente para quem precisa ajustá-lo.
   */
  alertaSemProgressoSegundos: number;
  /**
   * Janela da contagem de falhas no painel de saúde. Sem janela, a contagem de
   * `failed` seria o total histórico, que só cresce: um número que nunca zera
   * deixa de ser sinal e vira ruído.
   */
  janelaFalhasHoras: number;
  /**
   * MEDIDA 1 do controle de consumo: teto explícito de UMA tentativa, sempre
   * MENOR que o horizonte seguro do lease. A chamada ao modelo morre antes de o
   * lease vencer, em vez de o lease vencer com a chamada viva -- que é o caso
   * em que o fencing recusa o resultado mas a Anthropic já cobrou.
   */
  timeoutTentativaMs: number;
  /**
   * MEDIDA 4 (inferida): teto de chamadas que UM tick pode INICIAR. Diferente
   * de `maxJobsPorTick`, é reservado ANTES da reivindicação, então é teto duro.
   */
  orcamentoChamadasPorTick: number;
  /**
   * Disjuntor: TENTATIVAS EXTERNAS (que chegaram ao provedor) por evento.
   * Decisão do responsável técnico: 100, dimensionado para 50 participantes
   * elegíveis. É limite operacional inicial, NÃO teto monetário em dólares, e
   * deve ser recalibrado com a distribuição real de custo e duração.
   * 0 = desligado.
   */
  orcamentoTentativasPorEvento: number;
  /**
   * Disjuntor por PARTICIPANTE: 3 tentativas externas. Contado no livro-razão
   * da 021, não em `jobs.attempts` -- `jobs_reenfileirar(p_forcar)` zera
   * `attempts`, e um teto lido de lá seria decorativo. 0 = desligado.
   */
  orcamentoTentativasPorParticipante: number;
  /**
   * Intervalo em que se ESPERA que o agendador dispare. Serve ao painel para
   * dizer se "novas execuções continuam chegando", que é saúde do AGENDADOR --
   * coisa diferente de saúde do processamento.
   */
  intervaloDoAgendadorSegundos: number;
}

function inteiroDoAmbiente(nome: string, padrao: number, min: number, max: number): number {
  const bruto = process.env[nome];
  if (!bruto) return padrao;
  const n = Number.parseInt(bruto, 10);
  // Valor inválido não vira padrão silencioso: uma configuração errada que se
  // disfarça de padrão é exatamente o tipo de falha invisível que esta fila
  // existe para eliminar.
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(
      `${nome}="${bruto}" é inválido; esperado inteiro entre ${min} e ${max}`
    );
  }
  return n;
}

export function lerConfigFila(): ConfigFila {
  const concorrencia = inteiroDoAmbiente("JOBS_CONCURRENCY", 3, 1, 50);
  const leaseSegundos = inteiroDoAmbiente("JOBS_LEASE_SECONDS", 180, 30, 900);
  const backoffSegundos = inteiroDoAmbiente("JOBS_BACKOFF_SECONDS", 30, 0, 3600);
  // 180s = os 3 minutos da regra inicial do responsável técnico.
  const alertaSemProgressoSegundos = inteiroDoAmbiente(
    "JOBS_ALERT_NO_PROGRESS_SECONDS",
    180,
    30,
    3600
  );

  // O limiar TEM de ser maior que o backoff. Uma fila esperando legitimamente o
  // backoff da próxima tentativa não escreve nada no banco; com limiar menor que
  // o backoff, essa espera normal viraria alerta e o alerta perderia o sentido.
  if (alertaSemProgressoSegundos <= backoffSegundos) {
    throw new Error(
      `JOBS_ALERT_NO_PROGRESS_SECONDS (${alertaSemProgressoSegundos}s) tem de ser maior que ` +
        `JOBS_BACKOFF_SECONDS (${backoffSegundos}s), senão a espera normal de backoff vira alerta`
    );
  }

  // Um terço do lease: duas renovações podem falhar e ainda sobra margem.
  const renovarCadaMs = Math.max(5_000, Math.floor((leaseSegundos * 1000) / 3));
  const maxJobsPorTick = inteiroDoAmbiente("JOBS_MAX_PER_TICK", 12, 1, 200);

  // HORIZONTE SEGURO DO LEASE: se as renovações pararem agora, o lease ainda
  // vale por `lease` a partir da última renovação bem-sucedida. Travar a
  // tentativa em `lease - renovarCada` garante que a chamada morre ANTES de o
  // lease poder vencer com ela viva, mesmo no pior caso de renovação perdida.
  const horizonteSeguroMs = leaseSegundos * 1000 - renovarCadaMs;
  const timeoutTentativaMs = inteiroDoAmbiente(
    "JOBS_ATTEMPT_TIMEOUT_MS",
    horizonteSeguroMs,
    5_000,
    900_000
  );

  if (timeoutTentativaMs > horizonteSeguroMs) {
    throw new Error(
      `JOBS_ATTEMPT_TIMEOUT_MS (${timeoutTentativaMs}ms) tem de ser <= ao horizonte seguro do lease ` +
        `(${horizonteSeguroMs}ms = JOBS_LEASE_SECONDS ${leaseSegundos}s menos o intervalo de renovação ` +
        `${renovarCadaMs}ms). Acima disso, o lease pode vencer com a chamada ao modelo ainda viva, ` +
        `que é exatamente o consumo que não queremos`
    );
  }

  return {
    alertaSemProgressoSegundos,
    janelaFalhasHoras: inteiroDoAmbiente("JOBS_HEALTH_FAILURE_WINDOW_HOURS", 24, 1, 720),
    backoffSegundos,
    renovarCadaMs,
    maxJobsPorTick,
    timeoutTentativaMs,
    orcamentoChamadasPorTick: inteiroDoAmbiente(
      "JOBS_BUDGET_CALLS_PER_TICK",
      maxJobsPorTick,
      1,
      500
    ),
    // 100 por evento e 3 por participante: números decididos pelo responsável
    // técnico para o evento de 24/10/2026 com 50 elegíveis, depois de eu ter
    // deixado o disjuntor desligado por não ter número medido. Continuam
    // configuráveis, e o teto EFETIVO pode ser elevado por evento com
    // liberação auditada (migration 021) -- que persiste e deixa rastro,
    // diferente de mexer na variável de ambiente.
    orcamentoTentativasPorEvento: inteiroDoAmbiente("JOBS_BUDGET_ATTEMPTS_PER_EVENT", 100, 0, 10_000),
    orcamentoTentativasPorParticipante: inteiroDoAmbiente(
      "JOBS_BUDGET_ATTEMPTS_PER_PARTICIPANT",
      3,
      0,
      100
    ),
    intervaloDoAgendadorSegundos: inteiroDoAmbiente("JOBS_SCHEDULER_INTERVAL_SECONDS", 60, 10, 86_400),
    concorrencia,
    leaseSegundos,
    // 240s dentro de maxDuration = 300: 60s de folga para fechar o evento,
    // gravar os desfechos e serializar a resposta.
    orcamentoTickMs: inteiroDoAmbiente("JOBS_TICK_BUDGET_MS", 240_000, 1_000, 280_000),
    maxRecuperarPorTick: inteiroDoAmbiente("JOBS_MAX_RECOVER_PER_TICK", 100, 1, 1000),
  };
}
