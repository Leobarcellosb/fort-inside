// Saúde da fila: três indicadores PERSISTIDOS, lidos do banco, mais a regra de
// alerta.
//
// O princípio que governa este arquivo é o mesmo do projeto inteiro: "não
// consegui verificar" NÃO é "está tudo bem". Por isso cada indicador carrega a
// sua PROCEDÊNCIA e, quando a evidência é indireta, diz isso em vez de se
// apresentar como medida direta.
//
// ===========================================================================
// LIMITAÇÃO CENTRAL, declarada em vez de disfarçada
// ===========================================================================
// O indicador 1 pedido é "último tick BEM-SUCEDIDO" -- registrar que um tick
// ocorreu E teve sucesso, não que a rota foi chamada. Registrar isso exige
// GRAVAR um fato novo ("o tick X terminou inteiro às T"), e a migration 018 não
// tem onde guardá-lo:
//
//   - `jobs` não aceita linha sintética: `event_id` e `participant_id` são NOT
//     NULL com FK, e `kind` tem CHECK em ('prognostico','pdf'). Não existe
//     linha de heartbeat possível.
//   - `event_logs` seria o único lugar gravável, e está DESCARTADO: a página
//     do evento lê as últimas 50 linhas de event_logs e as mostra como a linha
//     do tempo da operação. Um heartbeat a cada 45s expulsaria daquela janela
//     todo o histórico real (liberação de etapa, enfileiramento) em menos de uma
//     hora. Trocar visibilidade da fila por cegueira na operação não é troca.
//
// Então o indicador 1 aqui é DERIVADO de `jobs`, e chamado pelo que é:
// `ultimoProgressoDoWorker`. O que ele prova de fato está em `fonte` e
// `oQueProva`. O que falta para o indicador literal está em `docs/FILA-JOBS.md`.
//
// Por que o derivado ainda serve para a regra de alerta: ele FALHA PARA O LADO
// SEGURO. Se o agendador estiver indisponível, ninguém toca em `jobs`,
// `updated_at` envelhece e o alerta dispara. O caso em que ele difere do
// registro literal é o oposto -- um tick que reivindicou e estourou em seguida
// deixa `attempt_started_at` fresco e parece saudável por até um lease. Esse
// caso específico é pego pelo INDICADOR 3: o lease daquele job vence e ele
// aparece em `expirados`. Os três indicadores juntos fecham o buraco que o
// indicador 1 sozinho, derivado, deixaria aberto.

import {
  classificarBloqueioDeExcecao,
  type BloqueioDeOrcamento,
} from "./orcamento-indisponivel";
import type { ConfigFila } from "./config";
import { resumoConsumo, type ClienteFila, type KindJob, type StatusJob } from "./fila";

/**
 * Leitura de tabela que a saúde precisa. O cliente do Supabase a satisfaz
 * estruturalmente; o cliente de psql das provas a implementa.
 */
export interface ConsultaSaude extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(coluna: string, valor: string): ConsultaSaude;
  in(coluna: string, valores: readonly string[]): ConsultaSaude;
  gte(coluna: string, valor: string): ConsultaSaude;
  not(coluna: string, operador: "is", valor: null): ConsultaSaude;
  order(coluna: string, opcoes: { ascending: boolean }): ConsultaSaude;
  limit(n: number): ConsultaSaude;
}

/**
 * Precisa de `rpc` além de `from`: o portão do worker depende das FUNÇÕES de
 * orçamento, então o painel tem de sondar as FUNÇÕES também.
 *
 * Erro meu, pego na prova contra Postgres real: eu sondava a TABELA
 * `jobs_consumo_externo`. Com as funções derrubadas e a tabela de pé, o painel
 * dizia `orcamento: ok` enquanto o tick estava BLOQUEADO -- exatamente o falso
 * verde que este módulo existe para impedir. Sondando a mesma função que o
 * portão usa, painel e worker concordam por construção.
 */
export interface ClienteSaude extends ClienteFila {
  from(tabela: string): { select(colunas: string): ConsultaSaude };
}

export interface JobEmAtencao {
  jobId: string;
  participantId: string;
  eventId: string;
  status: StatusJob;
  tentativas: string;
  idadeSegundos: number;
  claimedBy: string | null;
  codigo: string | null;
  erro: string | null;
}

/**
 * SAÚDE DO AGENDADOR -- o cron executou, o handler CONCLUIU, e novas execuções
 * continuam chegando no intervalo esperado.
 *
 * Vem do marcador REGISTRADO pela migration 019 (`jobs_worker_heartbeat`),
 * gravado na última linha de `rodarTick`. Não é derivado de `jobs`, e por isso
 * responde certo também quando a fila está vazia -- caso em que `jobs` não tem
 * rastro algum de tick.
 *
 * `veredito` tem TRÊS estados de propósito. "não consegui verificar" não é
 * "está tudo bem": sem a 019 aplicada, o veredito é `indisponivel`, nunca `ok`.
 */
export interface SaudeDoAgendador {
  veredito: "ok" | "alerta" | "indisponivel";
  motivo: string;
  /** NUNCA fabricado. null quando não há registro ou não foi possível ler. */
  ultimoTickOkEm: string | null;
  idadeSegundos: number | null;
  /** Monotônico: duas leituras espaçadas dizem se novas execuções chegam. */
  ticksOk: number | null;
  worker: string | null;
  duracaoDoUltimoTickMs: number | null;
  resumoDoUltimoTick: unknown;
  intervaloEsperadoSegundos: number;
  /** Quantos disparos do agendador caberiam na idade do marcador. */
  disparosEsperadosPerdidos: number | null;
  limiarSegundos: number;
  fonte: string;
}

/**
 * SAÚDE DO ORÇAMENTO -- dá para verificar quanto já se gastou?
 *
 * Existe porque o disjuntor falha FECHADO: sem medição, o tick não processa. E
 * uma fila que apenas para de andar é indistinguível, no painel, de fila vazia
 * ou de agendador morto. Este bloco é o que nomeia a causa.
 *
 * `veredito`:
 *   ok        -> a medição responde; o processamento pode andar
 *   bloqueado -> NÃO dá para verificar o consumo; o processamento está PARADO
 *                por isso, e `mensagemParaOperacao` diz o que fazer
 *   desligado -> os dois tetos estão em 0 por configuração: não há disjuntor a
 *                verificar (não é bloqueio nem saúde, é ausência de regra)
 */
export interface SaudeDoOrcamento {
  veredito: "ok" | "bloqueado" | "desligado";
  motivo: string;
  codigo: BloqueioDeOrcamento["codigo"] | null;
  mensagemParaOperacao: string | null;
  detalhe: string | null;
  tetoEventoPadrao: number;
  tetoParticipantePadrao: number;
}

export interface SaudeDaFila {
  kind: KindJob;
  lidoEm: string;

  saudeDoAgendador: SaudeDoAgendador;

  saudeDoOrcamento: SaudeDoOrcamento;

  /**
   * INDICADOR 1 na forma DERIVADA. Coexiste com `saudeDoAgendador` e continua
   * se declarando derivado: ele mede saúde do PROCESSAMENTO (há trabalho
   * avançando), que é propriedade diferente de saúde do AGENDADOR e não a
   * substitui.
   */
  ultimoProgressoDoWorker: {
    em: string | null;
    idadeSegundos: number | null;
    fonte: string;
    oQueProva: string;
    /** Sempre false: este campo é derivado, nunca um tick registrado. */
    tickRegistrado: boolean;
    /** Onde está o registro literal, quando a 019 está aplicada. */
    registroLiteralEm: string;
  };

  /** INDICADOR 2 -- o processamento está progredindo? */
  jobMaisAntigoNaFila: {
    jobId: string;
    participantId: string;
    eventId: string;
    status: StatusJob;
    criadoEm: string;
    idadeSegundos: number;
    disponivelEm: string;
    aguardandoBackoff: boolean;
  } | null;

  /** INDICADOR 3 -- há necessidade de recuperação? */
  recuperacao: {
    /** 'running' com lease VENCIDO: tentativa sumiu, esperando retomada. */
    expirados: number;
    /** 'running' com lease vivo: trabalho de verdade em voo. */
    emVoo: number;
    /** 'pending' esperando o backoff da próxima tentativa. */
    aguardandoBackoff: number;
    /** 'pending' e já elegível: só falta worker. */
    prontosParaPegar: number;
    /** 'failed' dentro da janela (o total histórico não é sinal, é ruído). */
    falhosNaJanela: number;
    janelaFalhasHoras: number;
    /** 'running'/'pending' sem tentativa restante: não serão retomados. */
    semTentativaRestante: number;
    jobs: JobEmAtencao[];
  };

  pendentes: number;

  /** true = o agendador, o processamento OU o orçamento está em alerta. */
  alertaAtivo: boolean;
  /**
   * true = o tick NÃO vai processar, porque não dá para verificar o consumo.
   * Distinto de `pendentes === 0` (nada a fazer) e de orçamento esgotado.
   */
  processamentoBloqueado: boolean;
  /** true = alguma propriedade não pôde ser verificada (não é "ok"). */
  naoVerificavel: boolean;

  /** Alerta do PROCESSAMENTO (há trabalho pendente e nada avançando). */
  alerta: {
    ativo: boolean;
    motivo: string;
    limiarSegundos: number;
    /** As três condições da regra, separadas, para a regra não ser caixa-preta. */
    condicoes: {
      temJobPendente: boolean;
      maisAntigoPassouDaCarencia: boolean;
      progressoDoWorkerVelhoOuAusente: boolean;
    };
  };
}

interface LinhaJob {
  id: string;
  event_id: string;
  participant_id: string;
  status: StatusJob;
  attempts: number;
  max_attempts: number;
  created_at: string;
  available_at: string;
  lease_expires_at: string | null;
  attempt_started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  claimed_by: string | null;
  last_error: string | null;
  last_error_code: string | null;
}

const COLUNAS =
  "id, event_id, participant_id, status, attempts, max_attempts, created_at, available_at, lease_expires_at, attempt_started_at, finished_at, updated_at, claimed_by, last_error, last_error_code";

async function linhas(consulta: ConsultaSaude, rotulo: string): Promise<LinhaJob[]> {
  const { data, error } = await consulta;
  // Erro de leitura NÃO pode virar "zero jobs": um painel que mostra zero
  // porque a consulta falhou é exatamente a operação aparentemente saudável
  // que este módulo existe para impedir.
  if (error) {
    const mensagem =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error(`saude/${rotulo}: ${mensagem}`);
  }
  return Array.isArray(data) ? (data as LinhaJob[]) : [];
}

const idadeSeg = (agoraMs: number, iso: string | null): number | null =>
  iso == null ? null : Math.max(0, Math.round((agoraMs - Date.parse(iso)) / 1000));

interface LinhaHeartbeat {
  kind: string;
  ultimo_tick_ok_em: string;
  worker: string;
  duracao_ms: number | null;
  ticks_ok: number;
  resumo: unknown;
}

/** A 019 não estar aplicada é um ESTADO CONHECIDO, não uma pane. */
function ehTabelaInexistente(mensagem: string): boolean {
  return (
    /42P01/.test(mensagem) ||
    /PGRST205/.test(mensagem) ||
    /does not exist/i.test(mensagem) ||
    /não existe/i.test(mensagem) ||
    /could not find the table/i.test(mensagem) ||
    /schema cache/i.test(mensagem)
  );
}

async function lerSaudeDoOrcamento(
  cliente: ClienteSaude,
  p: { kind: KindJob; config: ConfigFila }
): Promise<SaudeDoOrcamento> {
  const base = {
    tetoEventoPadrao: p.config.orcamentoTentativasPorEvento,
    tetoParticipantePadrao: p.config.orcamentoTentativasPorParticipante,
  };

  if (
    p.config.orcamentoTentativasPorEvento <= 0 &&
    p.config.orcamentoTentativasPorParticipante <= 0
  ) {
    return {
      ...base,
      veredito: "desligado",
      motivo:
        "os dois tetos estão em 0 por configuração: o disjuntor não está em vigor, " +
        "então não há medição a verificar",
      codigo: null,
      mensagemParaOperacao: null,
      detalhe: null,
    };
  }

  // Sonda independente do tick (o painel responde por conta própria), mas pela
  // MESMA função que o portão do worker usa -- é o que impede o painel de dizer
  // "ok" enquanto o tick se recusa a processar.
  try {
    await resumoConsumo(cliente, {
      eventId: "00000000-0000-0000-0000-000000000000",
      kind: p.kind,
    });
  } catch (err) {
    const bloqueio = classificarBloqueioDeExcecao(err);
    return {
      ...base,
      veredito: "bloqueado",
      // Nomeia as três coisas que NÃO são isto, porque confundi-las é o defeito.
      motivo:
        `${bloqueio.erro}. O processamento está BLOQUEADO por esta causa -- ` +
        `não por fila vazia e não por orçamento esgotado.`,
      codigo: bloqueio.codigo,
      mensagemParaOperacao: bloqueio.mensagemParaOperacao,
      detalhe: bloqueio.detalhe,
    };
  }

  return {
    ...base,
    veredito: "ok",
    motivo:
      `medição de consumo disponível; tetos padrão ${base.tetoEventoPadrao} por evento ` +
      `e ${base.tetoParticipantePadrao} por participante`,
    codigo: null,
    mensagemParaOperacao: null,
    detalhe: null,
  };
}

async function lerSaudeDoAgendador(
  cliente: ClienteSaude,
  p: { kind: KindJob; agoraMs: number; limiar: number; intervalo: number }
): Promise<SaudeDoAgendador> {
  const base = {
    intervaloEsperadoSegundos: p.intervalo,
    limiarSegundos: p.limiar,
    fonte: "jobs_worker_heartbeat (registrado pela migration 019)",
  };
  const indisponivel = (motivo: string): SaudeDoAgendador => ({
    ...base,
    veredito: "indisponivel",
    motivo,
    // Nada de horário aproximado: o campo fica NULL e quem lê sabe que não sabe.
    ultimoTickOkEm: null,
    idadeSegundos: null,
    ticksOk: null,
    worker: null,
    duracaoDoUltimoTickMs: null,
    resumoDoUltimoTick: null,
    disparosEsperadosPerdidos: null,
  });

  let linha: LinhaHeartbeat | undefined;
  try {
    const { data, error } = await cliente
      .from("jobs_worker_heartbeat")
      .select("kind, ultimo_tick_ok_em, worker, duracao_ms, ticks_ok, resumo")
      .eq("kind", p.kind);

    if (error) {
      const mensagem =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : JSON.stringify(error);
      return indisponivel(
        ehTabelaInexistente(mensagem)
          ? "migration 019 não aplicada: o tick bem-sucedido ainda não é REGISTRADO. " +
              "Use `ultimoProgressoDoWorker`, que é sinal DERIVADO e se declara como tal."
          : `não consegui ler jobs_worker_heartbeat: ${mensagem}`
      );
    }
    linha = (Array.isArray(data) ? (data as LinhaHeartbeat[]) : [])[0];
  } catch (err) {
    return indisponivel(
      `não consegui ler jobs_worker_heartbeat: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!linha) {
    // 019 aplicada, mas NENHUM tick jamais terminou. Isso é verificável e é
    // alerta: o agendador não entregou nada. É também o estado esperado nos
    // primeiros segundos depois de aplicar a 019, antes do primeiro tick.
    return {
      ...base,
      veredito: "alerta",
      motivo:
        `nenhum tick de '${p.kind}' jamais terminou inteiro (a tabela da 019 existe e está vazia). ` +
        `Se a 019 acabou de ser aplicada, isto se resolve no primeiro tick; caso contrário, ` +
        `o agendador não está executando: verifique o cron em /api/jobs/tick e CRON_SECRET.`,
      ultimoTickOkEm: null,
      idadeSegundos: null,
      ticksOk: 0,
      worker: null,
      duracaoDoUltimoTickMs: null,
      resumoDoUltimoTick: null,
      disparosEsperadosPerdidos: null,
    };
  }

  const idade = idadeSeg(p.agoraMs, linha.ultimo_tick_ok_em) ?? 0;
  const perdidos = Math.floor(idade / p.intervalo);
  const velho = idade > p.limiar;

  return {
    ...base,
    veredito: velho ? "alerta" : "ok",
    motivo: velho
      ? `último tick bem-sucedido há ${idade}s (limiar ${p.limiar}s; cerca de ${perdidos} disparo(s) ` +
        `de ${p.intervalo}s perdidos). O agendador não está entregando: verifique o cron em ` +
        `/api/jobs/tick e CRON_SECRET.`
      : `último tick bem-sucedido há ${idade}s (limiar ${p.limiar}s), ${linha.ticks_ok} tick(s) ok acumulados`,
    ultimoTickOkEm: linha.ultimo_tick_ok_em,
    idadeSegundos: idade,
    ticksOk: Number(linha.ticks_ok),
    worker: linha.worker,
    duracaoDoUltimoTickMs: linha.duracao_ms,
    resumoDoUltimoTick: linha.resumo,
    disparosEsperadosPerdidos: perdidos,
  };
}

export async function lerSaudeDaFila(
  cliente: ClienteSaude,
  p: { kind: KindJob; config: ConfigFila; agora?: () => number }
): Promise<SaudeDaFila> {
  const { kind, config } = p;
  const agoraMs = (p.agora ?? (() => Date.now()))();
  const agoraIso = new Date(agoraMs).toISOString();

  const desde = new Date(agoraMs - config.janelaFalhasHoras * 3600_000).toISOString();

  // Três leituras, todas limitadas: as não-terminais são o trabalho vivo
  // (poucas linhas), as falhas são recortadas pela janela, e o progresso é uma
  // linha só. Nenhuma varredura da tabela inteira.
  const [naoTerminais, falhas, ultimoProgresso, agendador, orcamento] = await Promise.all([
    linhas(
      cliente.from("jobs").select(COLUNAS).eq("kind", kind).in("status", ["pending", "running"]),
      "nao_terminais"
    ),
    linhas(
      cliente
        .from("jobs")
        .select(COLUNAS)
        .eq("kind", kind)
        .eq("status", "failed")
        .gte("finished_at", desde)
        .order("finished_at", { ascending: false })
        .limit(50),
      "falhas_na_janela"
    ),
    // `attempt_started_at is not null` é essencial: sem ele, o próprio INSERT
    // do enfileiramento (que grava updated_at = now()) passaria por "progresso
    // do worker", e enfileirar 50 jobs com o agendador morto pareceria saúde.
    // Com o filtro, só conta linha que ALGUM worker reivindicou -- e aí
    // updated_at daquela linha reflete reivindicação, renovação de lease ou
    // desfecho, que são escritas de worker.
    linhas(
      cliente
        .from("jobs")
        .select(COLUNAS)
        .eq("kind", kind)
        .not("attempt_started_at", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1),
      "ultimo_progresso"
    ),
    // Saúde do AGENDADOR: trata os próprios erros, porque "019 não aplicada" é
    // estado conhecido e não pode derrubar o resto do painel.
    lerSaudeDoAgendador(cliente, {
      kind,
      agoraMs,
      limiar: config.alertaSemProgressoSegundos,
      intervalo: config.intervaloDoAgendadorSegundos,
    }),
    lerSaudeDoOrcamento(cliente, { kind, config }),
  ]);

  const venceu = (l: LinhaJob) =>
    l.lease_expires_at != null && Date.parse(l.lease_expires_at) <= agoraMs;

  const expirados = naoTerminais.filter((l) => l.status === "running" && venceu(l));
  const emVoo = naoTerminais.filter((l) => l.status === "running" && !venceu(l));
  const pendentesEsperando = naoTerminais.filter(
    (l) => l.status === "pending" && Date.parse(l.available_at) > agoraMs
  );
  const pendentesProntos = naoTerminais.filter(
    (l) => l.status === "pending" && Date.parse(l.available_at) <= agoraMs
  );
  const semTentativa = naoTerminais.filter((l) => l.attempts >= l.max_attempts);

  // INDICADOR 2: o mais antigo pela CRIAÇÃO, que é a idade real na fila (e não
  // "desde a última tentativa", que reiniciaria a cada retentativa e esconderia
  // justamente o job que não sai do lugar).
  const maisAntigo = [...naoTerminais].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  )[0];

  const progressoIso = ultimoProgresso[0]?.updated_at ?? null;
  const progressoIdade = idadeSeg(agoraMs, progressoIso);

  const emAtencao = (l: LinhaJob): JobEmAtencao => ({
    jobId: l.id,
    participantId: l.participant_id,
    eventId: l.event_id,
    status: l.status,
    tentativas: `${l.attempts}/${l.max_attempts}`,
    idadeSegundos: idadeSeg(agoraMs, l.created_at) ?? 0,
    claimedBy: l.claimed_by,
    codigo: l.last_error_code,
    erro: l.last_error,
  });

  const pendentes = naoTerminais.length;

  // ===========================================================================
  // A REGRA DE ALERTA
  // ===========================================================================
  // Dispara quando TRÊS coisas valem ao mesmo tempo:
  //   (a) existe job pendente -- sem trabalho não há o que progredir;
  //   (b) o job mais antigo já espera MAIS que o limiar -- é a carência: nos
  //       primeiros segundos depois do enfileiramento, nenhum worker teve
  //       tempo ainda, e alertar ali seria ruído garantido;
  //   (c) o worker não dá sinal de progresso dentro do limiar (ou nunca deu).
  //
  // (c) sozinho não serve: 3 jobs em voo renovando lease mantêm o sinal fresco
  // enquanto 47 esperam, e isso é progresso de verdade, não alerta. (b) sozinho
  // também não: uma fila grande legitimamente leva muito mais que o limiar para
  // escoar. O alerta é a CONJUNÇÃO -- há trabalho, ele está velho, e ninguém
  // está mexendo nele.
  //
  // "Nunca deu sinal" conta como alerta, nunca como silêncio tranquilizador:
  // é a diferença entre "não consegui verificar" e "está tudo bem".
  const limiar = config.alertaSemProgressoSegundos;
  const idadeMaisAntigo = maisAntigo ? (idadeSeg(agoraMs, maisAntigo.created_at) ?? 0) : null;
  const progressoVelho = progressoIdade == null || progressoIdade > limiar;

  let ativo = false;
  let motivo: string;

  if (pendentes === 0) {
    motivo = "sem job pendente: não há o que progredir";
  } else if (idadeMaisAntigo != null && idadeMaisAntigo <= limiar) {
    motivo =
      `${pendentes} job(s) pendente(s), o mais antigo há ${idadeMaisAntigo}s ` +
      `(dentro da carência de ${limiar}s)`;
  } else if (progressoIdade == null) {
    ativo = true;
    motivo =
      `${pendentes} job(s) pendente(s), o mais antigo há ${idadeMaisAntigo}s, e NENHUM worker ` +
      `jamais reivindicou qualquer job deste tipo. Não é possível afirmar que o agendador ` +
      `está executando: verifique o cron em /api/jobs/tick e a variável CRON_SECRET.`;
  } else if (progressoVelho) {
    ativo = true;
    motivo =
      `${pendentes} job(s) pendente(s), o mais antigo há ${idadeMaisAntigo}s, e nenhum ` +
      `progresso de worker há ${progressoIdade}s (limiar ${limiar}s). O agendador ` +
      `provavelmente não está executando: verifique o cron em /api/jobs/tick e CRON_SECRET.`;
  } else {
    motivo =
      `${pendentes} job(s) pendente(s), com progresso de worker há ${progressoIdade}s ` +
      `(limiar ${limiar}s)`;
  }

  return {
    kind,
    lidoEm: agoraIso,

    saudeDoAgendador: agendador,

    saudeDoOrcamento: orcamento,

    ultimoProgressoDoWorker: {
      em: progressoIso,
      idadeSegundos: progressoIdade,
      fonte: "derivado de max(jobs.updated_at)",
      oQueProva:
        "que um worker escreveu na fila (reivindicação, renovação de lease ou desfecho). " +
        "É saúde do PROCESSAMENTO; NÃO prova que um tick terminou inteiro, e não substitui " +
        "a saúde do AGENDADOR.",
      tickRegistrado: false,
      registroLiteralEm: "saudeDoAgendador.ultimoTickOkEm (migration 019)",
    },

    jobMaisAntigoNaFila: maisAntigo
      ? {
          jobId: maisAntigo.id,
          participantId: maisAntigo.participant_id,
          eventId: maisAntigo.event_id,
          status: maisAntigo.status,
          criadoEm: maisAntigo.created_at,
          idadeSegundos: idadeSeg(agoraMs, maisAntigo.created_at) ?? 0,
          disponivelEm: maisAntigo.available_at,
          aguardandoBackoff: Date.parse(maisAntigo.available_at) > agoraMs,
        }
      : null,

    recuperacao: {
      expirados: expirados.length,
      emVoo: emVoo.length,
      aguardandoBackoff: pendentesEsperando.length,
      prontosParaPegar: pendentesProntos.length,
      falhosNaJanela: falhas.length,
      janelaFalhasHoras: config.janelaFalhasHoras,
      semTentativaRestante: semTentativa.length,
      jobs: [...expirados, ...semTentativa, ...falhas]
        // Um job pode cair em duas listas (expirado E sem tentativa restante).
        .filter((l, i, todas) => todas.findIndex((o) => o.id === l.id) === i)
        .map(emAtencao),
    },

    pendentes,

    // Bloqueio de orçamento é alerta ATIVO, não "não verificável": aqui se sabe
    // exatamente o que está errado, e o processamento está parado por isso.
    alertaAtivo:
      ativo || agendador.veredito === "alerta" || orcamento.veredito === "bloqueado",
    naoVerificavel: agendador.veredito === "indisponivel",
    processamentoBloqueado: orcamento.veredito === "bloqueado",

    alerta: {
      ativo,
      motivo,
      limiarSegundos: limiar,
      condicoes: {
        temJobPendente: pendentes > 0,
        maisAntigoPassouDaCarencia: idadeMaisAntigo != null && idadeMaisAntigo > limiar,
        progressoDoWorkerVelhoOuAusente: progressoVelho,
      },
    },
  };
}
