// Camada fina sobre as funções da migration 018. Nada de lógica de fila aqui: a
// fila MORA no banco, de propósito. Reivindicar, renovar, concluir e falhar são
// um único UPDATE condicional cada um, e é essa condição (status + run_token)
// que torna a exclusão mútua e o fencing verdadeiros mesmo com dois workers em
// instâncias diferentes da Vercel, que não compartilham memória nenhuma.
//
// O que este arquivo acrescenta:
//   1. tipos TypeScript para as linhas que as funções devolvem;
//   2. tradução do contrato do PostgREST (função que devolve TABLE vira ARRAY,
//      função escalar vira valor) para algo que o chamador não precisa adivinhar;
//   3. ERRO VISÍVEL: toda falha de RPC vira exceção com o nome da função. Um
//      `{ error }` ignorado aqui recriaria o defeito original -- falha que não
//      aparece em lugar nenhum.

export type KindJob = "prognostico" | "pdf";

export type StatusJob =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

/** Desfechos que `jobs_concluir` aceita. 'failed' vai por `jobs_falhar`. */
export type DesfechoConclusivo = "succeeded" | "skipped" | "canceled";

export type JsonValor =
  | string
  | number
  | boolean
  | null
  | JsonValor[]
  | { [chave: string]: JsonValor };

export interface RespostaRpc {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Forma mínima do cliente. O cliente real do Supabase a satisfaz
 * estruturalmente, mas o tipo gerado em `types/database.ts` declara
 * `Functions: Record<string, never>`, então o chamador faz
 * `cliente as unknown as ClienteFila` na borda -- mesmo padrão de
 * `ClienteDeLeitura` em `lib/ai/contexto-quiz.ts`. O ganho é testar esta
 * camada inteira sem rede e sem banco.
 */
export interface ClienteFila {
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<RespostaRpc>;
}

export class ErroDeFila extends Error {
  constructor(
    readonly funcao: string,
    mensagem: string
  ) {
    super(`fila/${funcao}: ${mensagem}`);
    this.name = "ErroDeFila";
  }
}

async function chamar(
  cliente: ClienteFila,
  funcao: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const { data, error } = await cliente.rpc(funcao, args);
  if (error) throw new ErroDeFila(funcao, error.message);
  return data;
}

/** Função que devolve TABLE: o PostgREST entrega array (vazio = nenhuma linha). */
async function chamarLinhas(
  cliente: ClienteFila,
  funcao: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const data = await chamar(cliente, funcao, args);
  if (data == null) return [];
  if (!Array.isArray(data)) {
    throw new ErroDeFila(funcao, `esperava array de linhas, recebi ${typeof data}`);
  }
  return data as Record<string, unknown>[];
}

/** Função escalar: o PostgREST entrega o valor cru. */
async function chamarBooleano(
  cliente: ClienteFila,
  funcao: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const data = await chamar(cliente, funcao, args);
  if (typeof data !== "boolean") {
    throw new ErroDeFila(funcao, `esperava boolean, recebi ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Enfileirar
// ---------------------------------------------------------------------------

export interface ResultadoEnfileirar {
  id: string;
  status: StatusJob;
  /** false = a linha já existia; o histórico de tentativas dela foi preservado. */
  criado: boolean;
}

export async function enfileirarJob(
  cliente: ClienteFila,
  p: {
    kind: KindJob;
    eventId: string;
    participantId: string;
    prioridade?: number;
    maxTentativas?: number;
  }
): Promise<ResultadoEnfileirar> {
  const linhas = await chamarLinhas(cliente, "jobs_enfileirar", {
    p_kind: p.kind,
    p_event_id: p.eventId,
    p_participant_id: p.participantId,
    p_priority: p.prioridade ?? 0,
    p_max_attempts: p.maxTentativas ?? 3,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_enfileirar", "nenhuma linha devolvida");
  return {
    id: String(l.id),
    status: l.status as StatusJob,
    criado: l.criado === true,
  };
}

// ---------------------------------------------------------------------------
// Reivindicar
// ---------------------------------------------------------------------------

export interface JobReivindicado {
  id: string;
  participantId: string;
  eventId: string;
  /**
   * Token de execução DESTA tentativa, gerado pelo banco na reivindicação.
   * É a credencial para gravar o desfecho: sem ele, nenhum UPDATE casa.
   */
  runToken: string;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: string;
}

export async function reivindicarJobs(
  cliente: ClienteFila,
  p: {
    kind: KindJob;
    worker: string;
    leaseSegundos: number;
    limite: number;
    concorrenciaMax: number;
  }
): Promise<JobReivindicado[]> {
  const linhas = await chamarLinhas(cliente, "jobs_reivindicar", {
    p_kind: p.kind,
    p_worker: p.worker,
    p_lease_seconds: p.leaseSegundos,
    p_limit: p.limite,
    p_concorrencia_max: p.concorrenciaMax,
  });
  return linhas.map((l) => ({
    id: String(l.id),
    participantId: String(l.participant_id),
    eventId: String(l.event_id),
    runToken: String(l.run_token),
    attempts: Number(l.attempts),
    maxAttempts: Number(l.max_attempts),
    leaseExpiresAt: String(l.lease_expires_at),
  }));
}

// ---------------------------------------------------------------------------
// Lease, desfecho e falha
// ---------------------------------------------------------------------------

/**
 * false = o worker PERDEU o job (lease tomado por outro, ou job já encerrado).
 * Quem recebe false deve parar: o resultado dele vai ser recusado de todo jeito.
 */
export function renovarLease(
  cliente: ClienteFila,
  p: { id: string; runToken: string; leaseSegundos: number }
): Promise<boolean> {
  return chamarBooleano(cliente, "jobs_renovar_lease", {
    p_id: p.id,
    p_run_token: p.runToken,
    p_lease_seconds: p.leaseSegundos,
  });
}

/**
 * false = NADA foi gravado, porque o run_token não é mais o da tentativa em
 * vigor. É o fencing da 018 em ação: o worker que voltou do limbo não
 * sobrescreve o resultado da tentativa mais recente. Quem chama precisa tratar
 * esse false como "meu resultado foi descartado", não como sucesso.
 */
export function concluirJob(
  cliente: ClienteFila,
  p: {
    id: string;
    runToken: string;
    status: DesfechoConclusivo;
    resultado?: JsonValor;
    aiUsage?: JsonValor;
  }
): Promise<boolean> {
  return chamarBooleano(cliente, "jobs_concluir", {
    p_id: p.id,
    p_run_token: p.runToken,
    p_status: p.status,
    p_result: p.resultado ?? null,
    p_ai_usage: p.aiUsage ?? null,
  });
}

export interface ResultadoFalhar {
  /** false = fencing: a falha era de uma tentativa que já não vale. */
  aplicado: boolean;
  /** 'pending' (reagendado) ou 'failed' (terminal). null quando não aplicado. */
  status: StatusJob | null;
  attempts: number | null;
}

export async function falharJob(
  cliente: ClienteFila,
  p: {
    id: string;
    runToken: string;
    erro: string;
    codigo?: string | null;
    backoffSegundos: number;
  }
): Promise<ResultadoFalhar> {
  const linhas = await chamarLinhas(cliente, "jobs_falhar", {
    p_id: p.id,
    p_run_token: p.runToken,
    p_erro: p.erro,
    p_codigo: p.codigo ?? null,
    p_backoff_seconds: p.backoffSegundos,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_falhar", "nenhuma linha devolvida");
  return {
    aplicado: l.aplicado === true,
    status: (l.status as StatusJob | null) ?? null,
    attempts: l.attempts == null ? null : Number(l.attempts),
  };
}

// ---------------------------------------------------------------------------
// Recuperação e operação manual
// ---------------------------------------------------------------------------

export interface JobRecuperado {
  id: string;
  /** 'pending' quando ainda há tentativa; 'failed' quando acabaram. */
  novoStatus: StatusJob;
  attempts: number;
}

export async function recuperarExpirados(
  cliente: ClienteFila,
  p: { kind: KindJob; limite: number }
): Promise<JobRecuperado[]> {
  const linhas = await chamarLinhas(cliente, "jobs_recuperar_expirados", {
    p_kind: p.kind,
    p_limit: p.limite,
  });
  return linhas.map((l) => ({
    id: String(l.id),
    novoStatus: l.novo_status as StatusJob,
    attempts: Number(l.attempts),
  }));
}

export interface ResultadoReenfileirar {
  aplicado: boolean;
  statusAnterior: StatusJob | null;
  motivo: string;
}

export async function reenfileirarJob(
  cliente: ClienteFila,
  p: { id: string; forcar?: boolean }
): Promise<ResultadoReenfileirar> {
  const linhas = await chamarLinhas(cliente, "jobs_reenfileirar", {
    p_id: p.id,
    p_forcar: p.forcar === true,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_reenfileirar", "nenhuma linha devolvida");
  return {
    aplicado: l.aplicado === true,
    statusAnterior: (l.status_anterior as StatusJob | null) ?? null,
    motivo: String(l.motivo ?? ""),
  };
}

export function cancelarJob(
  cliente: ClienteFila,
  p: { id: string; motivo?: string }
): Promise<boolean> {
  return chamarBooleano(cliente, "jobs_cancelar", {
    p_id: p.id,
    p_motivo: p.motivo ?? null,
  });
}

// ---------------------------------------------------------------------------
// Orçamento de consumo externo (migration 021)
// ---------------------------------------------------------------------------

export interface VereditoDeOrcamento {
  permitido: boolean;
  motivo: string;
  tetoEvento: number;
  tetoParticipante: number;
  tentativasEvento: number;
  tentativasParticipante: number;
  requisicoesEvento: number;
  /** true = o teto veio da linha PERSISTIDA do evento, não do padrão do worker. */
  tetoPersistido: boolean;
}

/**
 * O disjuntor, consultado ANTES de gastar. Conta tentativas que CHEGARAM ao
 * provedor (livro-razão da 021), não `jobs.attempts` -- que conta
 * reivindicações e é zerado por `jobs_reenfileirar(p_forcar)`.
 */
export async function verificarOrcamento(
  cliente: ClienteFila,
  p: {
    kind: KindJob;
    eventId: string;
    participantId: string;
    tetoEventoPadrao: number;
    tetoParticipantePadrao: number;
  }
): Promise<VereditoDeOrcamento> {
  const linhas = await chamarLinhas(cliente, "jobs_orcamento_verificar", {
    p_kind: p.kind,
    p_event_id: p.eventId,
    p_participant_id: p.participantId,
    p_teto_evento_padrao: p.tetoEventoPadrao,
    p_teto_participante_padrao: p.tetoParticipantePadrao,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_orcamento_verificar", "nenhuma linha devolvida");
  return {
    permitido: l.permitido === true,
    motivo: String(l.motivo ?? ""),
    tetoEvento: Number(l.teto_evento ?? 0),
    tetoParticipante: Number(l.teto_participante ?? 0),
    tentativasEvento: Number(l.tentativas_evento ?? 0),
    tentativasParticipante: Number(l.tentativas_participante ?? 0),
    requisicoesEvento: Number(l.requisicoes_evento ?? 0),
    tetoPersistido: l.teto_persistido === true,
  };
}

export interface TotaisDeConsumo {
  tentativasEvento: number;
  tentativasParticipante: number;
  requisicoesEvento: number;
}

/** Lança no livro-razão append-only o que a tentativa mandou para o provedor. */
export async function registrarConsumo(
  cliente: ClienteFila,
  p: {
    kind: KindJob;
    eventId: string;
    participantId: string;
    chamadas: number;
    abortada: boolean;
    motivo?: string | null;
    jobId?: string | null;
    runToken?: string | null;
  }
): Promise<TotaisDeConsumo> {
  const linhas = await chamarLinhas(cliente, "jobs_consumo_registrar", {
    p_kind: p.kind,
    p_event_id: p.eventId,
    p_participant_id: p.participantId,
    p_chamadas: p.chamadas,
    p_abortada: p.abortada,
    p_motivo: p.motivo ?? null,
    p_job_id: p.jobId ?? null,
    p_run_token: p.runToken ?? null,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_consumo_registrar", "nenhuma linha devolvida");
  return {
    tentativasEvento: Number(l.tentativas_evento ?? 0),
    tentativasParticipante: Number(l.tentativas_participante ?? 0),
    requisicoesEvento: Number(l.requisicoes_evento ?? 0),
  };
}

export interface LiberacaoDeOrcamento {
  liberacaoId: string;
  tetoAnteriorEvento: number | null;
  tetoNovoEvento: number;
  usadoNoMomento: number;
}

/**
 * Liberação excepcional AUDITADA: é a única porta de alteração do teto, e o
 * banco recusa sem quem e por quê (CHECK de tamanho mínimo na trilha).
 */
export async function liberarOrcamento(
  cliente: ClienteFila,
  p: {
    eventId: string;
    tetoEvento: number;
    tetoParticipante: number;
    liberadoPor: string;
    motivo: string;
    kind?: KindJob;
  }
): Promise<LiberacaoDeOrcamento> {
  const linhas = await chamarLinhas(cliente, "jobs_orcamento_liberar", {
    p_event_id: p.eventId,
    p_teto_evento: p.tetoEvento,
    p_teto_participante: p.tetoParticipante,
    p_liberado_por: p.liberadoPor,
    p_motivo: p.motivo,
    p_kind: p.kind ?? "prognostico",
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_orcamento_liberar", "nenhuma linha devolvida");
  return {
    liberacaoId: String(l.liberacao_id),
    tetoAnteriorEvento: l.teto_anterior_evento == null ? null : Number(l.teto_anterior_evento),
    tetoNovoEvento: Number(l.teto_novo_evento),
    usadoNoMomento: Number(l.usado_no_momento ?? 0),
  };
}

export interface ResumoDeConsumo {
  tentativasExternas: number;
  tentativasAbortadas: number;
  tentativasSemConexao: number;
  requisicoesDespachadas: number;
  participantesTocados: number;
  participantesNoTeto: number;
  primeiraEm: string | null;
  ultimaEm: string | null;
}

export async function resumoConsumo(
  cliente: ClienteFila,
  p: { eventId: string; kind: KindJob }
): Promise<ResumoDeConsumo> {
  const linhas = await chamarLinhas(cliente, "jobs_consumo_resumo", {
    p_event_id: p.eventId,
    p_kind: p.kind,
  });
  const l = linhas[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0);
  return {
    tentativasExternas: n(l.tentativas_externas),
    tentativasAbortadas: n(l.tentativas_abortadas),
    tentativasSemConexao: n(l.tentativas_sem_conexao),
    requisicoesDespachadas: n(l.requisicoes_despachadas),
    participantesTocados: n(l.participantes_tocados),
    participantesNoTeto: n(l.participantes_no_teto),
    primeiraEm: (l.primeira_em as string | null) ?? null,
    ultimaEm: (l.ultima_em as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Heartbeat do worker (migration 019)
// ---------------------------------------------------------------------------

export interface MarcaDeTickOk {
  ultimoTickOkEm: string;
  ticksOk: number;
}

/**
 * Grava que um tick terminou INTEIRO. Chamada na ÚLTIMA linha de `rodarTick`:
 * é por isso que um tick cortado no meio nunca a alcança, e é isso que separa
 * "a rota foi chamada" de "o tick teve sucesso".
 *
 * Lança quando a 019 não está aplicada (a função não existe). Quem chama trata
 * isso como "saúde do agendador indisponível", NUNCA como horário fictício.
 */
export async function registrarTickOk(
  cliente: ClienteFila,
  p: { kind: KindJob; worker: string; duracaoMs?: number; resumo?: JsonValor }
): Promise<MarcaDeTickOk> {
  const linhas = await chamarLinhas(cliente, "jobs_registrar_tick_ok", {
    p_kind: p.kind,
    p_worker: p.worker,
    p_duracao_ms: p.duracaoMs ?? null,
    p_resumo: p.resumo ?? null,
  });
  const l = linhas[0];
  if (!l) throw new ErroDeFila("jobs_registrar_tick_ok", "nenhuma linha devolvida");
  return {
    ultimoTickOkEm: String(l.ultimo_tick_ok_em),
    ticksOk: Number(l.ticks_ok),
  };
}

// ---------------------------------------------------------------------------
// Visibilidade
// ---------------------------------------------------------------------------

export interface ResumoEvento {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  canceled: number;
  /** pending + running: o que ainda não tem desfecho. */
  pendentes: number;
  /** Soma das durações de TODAS as tentativas: o custo real de tempo. */
  totalDuracaoMs: number;
  /** Soma das tentativas: o piso de chamadas de IA potencialmente cobradas. */
  tentativasTotal: number;
}

export async function resumoEvento(
  cliente: ClienteFila,
  p: { eventId: string; kind: KindJob }
): Promise<ResumoEvento> {
  const linhas = await chamarLinhas(cliente, "jobs_resumo_evento", {
    p_event_id: p.eventId,
    p_kind: p.kind,
  });
  const l = linhas[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0);
  return {
    total: n(l.total),
    pending: n(l.pending),
    running: n(l.running),
    succeeded: n(l.succeeded),
    failed: n(l.failed),
    skipped: n(l.skipped),
    canceled: n(l.canceled),
    pendentes: n(l.pendentes),
    totalDuracaoMs: n(l.total_duration_ms),
    tentativasTotal: n(l.attempts_total),
  };
}

/**
 * true = este tick foi o que fechou o evento (processing -> completed).
 * false = ou ainda falta job, ou o evento já não estava em 'processing'.
 * Chamável por qualquer worker, quantas vezes quiser: é o oposto de "a última
 * linha da requisição grava completed", que é justamente a linha que não roda
 * quando a função é cortada.
 */
export function fecharEventoSeConcluido(
  cliente: ClienteFila,
  p: { eventId: string; kind: KindJob }
): Promise<boolean> {
  return chamarBooleano(cliente, "jobs_fechar_evento_se_concluido", {
    p_event_id: p.eventId,
    p_kind: p.kind,
  });
}
