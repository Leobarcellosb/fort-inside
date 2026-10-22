import { TOTAL_STAGES } from "../constants";
import { statusDoCodigo, type CodigoDeErro, type DetalhesDeErro } from "../erros/codigos";
import { indicaEsquemaAusente, nomeDoObjetoAusente } from "../erros/falha-de-fila";
import { fusoDoEvento } from "../eventos/fuso";

// QUANTAS ETAPAS O EVENTO TEM -- derivado do banco, nunca de um numero fixo.
//
// Decisao do responsavel tecnico: "O servidor deve derivar as etapas da versao
// do questionario vinculada ao evento. Nenhuma rota pode conter um numero fixo
// de etapas." Fort Inside v1 = 6, Marco Zero v2 = 5, versoes futuras vN = o que
// o banco definir.
//
// POR QUE EXISTE: os portoes de /api/jobs/enfileirar e /api/batch-process
// comparavam `events.current_stage` com uma constante 6. O Marco Zero tem 5
// etapas, entao `current_stage` nunca chegava a 6 e "Processar prognosticos" era
// inalcancavel num evento conduzido normalmente. Os dois portoes agora chamam
// esta funcao e, por construcao, nao podem divergir entre si.
//
// FONTE DA CONTAGEM: as linhas de `quiz_stages` com o `quiz_version` do evento,
// o mesmo criterio de /api/complete-quiz. `current_stage` e comparado com
// `stage_number` no banco (010_programas.sql), entao a contagem so e uma medida
// valida se os `stage_number` da versao forem exatamente 1..N; qualquer outra
// coisa (nulo, buraco) e configuracao quebrada, e nao se adivinha.
//
// NAO HA FALLBACK. Se a contagem nao pode ser obtida ou nao e confiavel, o
// resultado BLOQUEIA: o chamador recusa. Nunca libera (liberaria processamento
// pago sem prova de que o evento terminou) e nunca finge ser a regra de negocio
// "o evento nao completou as etapas".
//
// DUAS causas de bloqueio, com CODIGOS DIFERENTES, porque exigem investigacoes
// diferentes (decisao do responsavel tecnico):
//   QUIZ_STAGES_UNAVAILABLE -- NAO conseguiu consultar (erro de leitura do banco).
//                              Investigar acesso/rede/permissao.
//   QUIZ_STAGES_INVALID     -- consultou e a versao e invalida: sem etapas,
//                              stage_number nulo ou com buraco, contagem da v1
//                              fora do esperado. Investigar os DADOS.
// Ambos sao 503 (o status e a classe; o codigo e a causa).
//
// `TOTAL_STAGES` continua aqui apenas como TRAVA DE SANIDADE da versao 1, igual a
// /api/complete-quiz e a carregarContextoQuiz: se a v1 aparecer com outra
// contagem, o banco foi mexido e a coisa certa e parar, nao seguir.

interface Consulta extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ClienteDeLeitura {
  from(tabela: string): { select(colunas: string): Consulta };
}

export interface EventoParaPortao {
  id: string;
  current_stage: number;
  status: string;
  quiz_version: number;
  /** 'live' | 'async' (migration 010). Ausente ou desconhecido => não se adivinha. */
  mode?: string | null;
  form_opens_at?: string | null;
  form_closes_at?: string | null;
}

/**
 * Tolerância de ENVIO depois do prazo (migration 010, REGRA 6): quem já abriu a
 * etapa antes do prazo ainda pode enviar até form_closes_at + 15min. A coleta só
 * está ENCERRADA de verdade depois disso; processar antes deixaria de fora uma
 * resposta que ainda pode chegar.
 */
export const TOLERANCIA_DE_ENVIO_MS = 15 * 60 * 1000;

export type CodigoDoPortao = Extract<
  CodigoDeErro,
  | "EVENT_NOT_FOUND"
  | "EVENT_INCOMPLETE"
  | "COLLECTION_OPEN"
  | "EVENT_MODE_UNDETERMINED"
  | "COLLECTION_WINDOW_UNDETERMINED"
  | "TIME_REFERENCE_UNAVAILABLE"
  | "ASYNC_PROCESSING_MISSING"
  | "QUIZ_STAGES_UNAVAILABLE"
  | "QUIZ_STAGES_INVALID"
>;

export type ResultadoPortaoDeEtapas =
  | { ok: true; evento: EventoParaPortao; totalEtapas: number }
  | {
      ok: false;
      status: number;
      /** Texto curto para log/corpo cru. A interface traduz pelo `codigo`, nao por isto. */
      error: string;
      codigo: CodigoDoPortao;
      detalhes?: DetalhesDeErro;
      motivo: MotivoRecusa;
    };

export type MotivoRecusa =
  | "evento_inexistente"
  | "etapas_indisponiveis" // NAO deu para consultar (erro de leitura)
  | "etapas_invalidas" // consultou: a versao esta inconsistente
  | "etapas_incompletas" // verificado (live): o evento ainda nao chegou la
  | "coleta_aberta" // verificado (async): o prazo da coleta ainda nao passou
  | "modo_indeterminado" // nao deu para saber live x async
  | "janela_indeterminada" // async sem prazo utilizavel
  | "relogio_indisponivel" // async: nao deu para obter a hora DO BANCO
  | "assincrono_ausente"; // async: a funcao do relogio nao existe no banco

export const MENSAGEM_ETAPAS_INDISPONIVEIS =
  "Não foi possível verificar as etapas do questionário deste evento. O processamento não foi iniciado. Tente de novo em instantes; se persistir, avise a equipe técnica.";

export const MENSAGEM_ETAPAS_INVALIDAS =
  "As etapas do questionário deste evento foram consultadas, mas a versão está inconsistente. O processamento não foi iniciado. É um problema de configuração do questionário: tentar de novo não resolve, avise a equipe técnica.";

/** NAO conseguiu consultar. */
function indisponivel(detalhe: Record<string, unknown>): ResultadoPortaoDeEtapas {
  console.error("[etapas-do-evento] não foi possível consultar as etapas", detalhe);
  return {
    ok: false,
    status: statusDoCodigo("QUIZ_STAGES_UNAVAILABLE"),
    error: MENSAGEM_ETAPAS_INDISPONIVEIS,
    codigo: "QUIZ_STAGES_UNAVAILABLE",
    motivo: "etapas_indisponiveis",
  };
}

/** Consultou e encontrou uma configuracao invalida. */
function invalida(detalhe: Record<string, unknown>): ResultadoPortaoDeEtapas {
  console.error("[etapas-do-evento] as etapas consultadas são inválidas", detalhe);
  return {
    ok: false,
    status: statusDoCodigo("QUIZ_STAGES_INVALID"),
    error: MENSAGEM_ETAPAS_INVALIDAS,
    codigo: "QUIZ_STAGES_INVALID",
    motivo: "etapas_invalidas",
  };
}

type FalhaDoPortao = Exclude<ResultadoPortaoDeEtapas, { ok: true }>;

function modoIndeterminado(detalhe: Record<string, unknown>): FalhaDoPortao {
  console.error("[etapas-do-evento] não foi possível determinar o modo do evento", detalhe);
  return {
    ok: false,
    status: statusDoCodigo("EVENT_MODE_UNDETERMINED"),
    error: "Não foi possível determinar o modo do evento",
    codigo: "EVENT_MODE_UNDETERMINED",
    motivo: "modo_indeterminado",
  };
}

function janelaIndeterminada(detalhe: Record<string, unknown>): FalhaDoPortao {
  console.error("[etapas-do-evento] o prazo da coleta não está utilizável", detalhe);
  return {
    ok: false,
    status: statusDoCodigo("COLLECTION_WINDOW_UNDETERMINED"),
    error: "O prazo da coleta do evento não está definido ou não pôde ser lido",
    codigo: "COLLECTION_WINDOW_UNDETERMINED",
    motivo: "janela_indeterminada",
  };
}

function instante(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * MODO ASSINCRONO. Decisao do responsavel tecnico (rodada 27): "nesse modo, o
 * processamento coletivo depende do ENCERRAMENTO DA COLETA e da ELEGIBILIDADE DOS
 * PARTICIPANTES, nao de uma sexta etapa nem de uma liberacao presencial".
 *
 * Nenhum host libera etapa no modo assincrono, entao `current_stage` fica parado e
 * o criterio do live recusaria PARA SEMPRE. Aqui vale o prazo: coleta encerrada =
 * agora >= form_closes_at + tolerancia de envio (15 min, migration 010).
 *
 * SEGUNDA METADE DO CRITERIO, AINDA NAO LIGADA: a elegibilidade por presenca nasceu
 * na migration 020, que nao esta aplicada em lugar nenhum. Depender dela agora
 * trocaria um bloqueio por outro; liga-se quando a 020 for aplicada.
 *
 * Prazo ausente ou ilegivel NAO libera e NAO diz "coleta aberta": e
 * COLLECTION_WINDOW_UNDETERMINED (nao consegui verificar).
 */
export interface ClienteComRelogio {
  rpc(
    nome: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/**
 * A HORA DE REFERENCIA, DO BANCO. Decisao do responsavel tecnico: "O banco deve
 * fornecer a referencia temporal de autorizacao, evitando diferencas entre o
 * relogio do navegador, do servidor Next.js e do PostgreSQL." `form_closes_at` e um
 * instante gravado pelo banco; compara-lo com o `new Date()` de OUTRA maquina
 * (a funcao na Vercel) decidiria o inicio do processamento por divergencia de
 * relogio.
 *
 * Se a hora nao vem do banco, e INDISPONIBILIDADE (503, codigo proprio). NAO ha
 * queda para o relogio local "so dessa vez": seria a decisao errada vestida de
 * resiliencia. Funcao inexistente (atualizacao do banco nao aplicada) e outro
 * codigo, porque a acao muda: aplicar x aguardar.
 */
async function lerRelogioDoBanco(
  supabase: Partial<ClienteComRelogio>
): Promise<{ agora: Date } | { falha: FalhaDoPortao }> {
  const indisponivel = (causa: Record<string, unknown>): { falha: FalhaDoPortao } => {
    console.error("[etapas-do-evento] não foi possível obter a hora de referência do banco", causa);
    return {
      falha: {
        ok: false,
        status: statusDoCodigo("TIME_REFERENCE_UNAVAILABLE"),
        error: "Não foi possível obter a hora de referência do banco",
        codigo: "TIME_REFERENCE_UNAVAILABLE",
        motivo: "relogio_indisponivel",
      },
    };
  };
  if (typeof supabase.rpc !== "function") return indisponivel({ motivo: "cliente sem rpc" });
  let r;
  try {
    r = await supabase.rpc("referencia_temporal_do_banco", {});
  } catch (e) {
    return indisponivel({ excecao: e instanceof Error ? e.name : typeof e });
  }
  if (r.error) {
    const msg = r.error.message ?? "";
    const nome = nomeDoObjetoAusente(msg);
    // A funcao QUE EU CHAMEI nao existe: atualizacao do banco ausente.
    if (indicaEsquemaAusente(r.error) && (nome === null || nome.startsWith("referencia_temporal"))) {
      console.error("[etapas-do-evento] a função da hora de referência não existe no banco", { code: r.error.code });
      return {
        falha: {
          ok: false,
          status: statusDoCodigo("ASYNC_PROCESSING_MISSING"),
          error: "O processamento assíncrono não está instalado no banco",
          codigo: "ASYNC_PROCESSING_MISSING",
          motivo: "assincrono_ausente",
        },
      };
    }
    return indisponivel({ code: r.error.code });
  }
  const t = typeof r.data === "string" ? new Date(r.data) : null;
  if (!t || Number.isNaN(t.getTime())) return indisponivel({ motivo: "valor ilegível", tipo: typeof r.data });
  return { agora: t };
}

/** `null` = coleta encerrada (libera). */
function verificarColeta(evento: EventoParaPortao, agora: Date): FalhaDoPortao | null {
  const fusoDoPrazo = fusoDoEvento(evento);
  const fecha = instante(evento.form_closes_at);
  if (fecha === null) {
    return janelaIndeterminada({ event_id: evento.id, form_closes_at: evento.form_closes_at ?? null });
  }
  // form_opens_at, quando existe, tem de ser legivel e anterior ao fechamento.
  if (evento.form_opens_at !== null && evento.form_opens_at !== undefined) {
    const abre = instante(evento.form_opens_at);
    if (abre === null || abre > fecha) {
      return janelaIndeterminada({
        event_id: evento.id,
        form_opens_at: evento.form_opens_at,
        form_closes_at: evento.form_closes_at,
        motivo: abre === null ? "form_opens_at ilegivel" : "abertura depois do fechamento",
      });
    }
  }
  if (agora.getTime() < fecha + TOLERANCIA_DE_ENVIO_MS) {
    return {
      ok: false,
      status: statusDoCodigo("COLLECTION_OPEN"),
      error: "A coleta do evento ainda não encerrou",
      codigo: "COLLECTION_OPEN",
      detalhes: {
        coleta_encerra_em: new Date(fecha).toISOString(),
        ...(fusoDoPrazo ? { fuso: fusoDoPrazo } : {}),
      },
      motivo: "coleta_aberta",
    };
  }
  return null;
}

async function lerEvento(
  supabase: ClienteDeLeitura,
  eventId: string,
): Promise<{ evento: EventoParaPortao } | { falha: ResultadoPortaoDeEtapas }> {
  const { data: evento, error: eErr } = (await supabase
    .from("events")
    .select("id, current_stage, status, quiz_version, mode, form_opens_at, form_closes_at")
    .eq("id", eventId)
    .maybeSingle()) as {
    data: EventoParaPortao | null;
    error: { code?: string } | null;
  };

  if (eErr) return { falha: indisponivel({ event_id: eventId, etapa: "evento", code: eErr.code }) };
  if (!evento) {
    return {
      falha: {
        ok: false,
        status: statusDoCodigo("EVENT_NOT_FOUND"),
        error: "Evento não encontrado",
        codigo: "EVENT_NOT_FOUND",
        motivo: "evento_inexistente",
      },
    };
  }
  return { evento };
}

/** O criterio do PRESENCIAL: conta as etapas da versao do quiz e compara com current_stage. */
async function avaliarEtapas(
  supabase: ClienteDeLeitura,
  evento: EventoParaPortao,
): Promise<ResultadoPortaoDeEtapas> {
  const eventId = evento.id;
  const { data: etapas, error: sErr } = (await supabase
    .from("quiz_stages")
    .select("stage_number")
    .eq("quiz_version", evento.quiz_version)) as {
    data: { stage_number: number | null }[] | null;
    error: { code?: string } | null;
  };

  if (sErr || !etapas) {
    return indisponivel({
      event_id: eventId,
      quiz_version: evento.quiz_version,
      etapa: "quiz_stages",
      code: sErr?.code,
    });
  }

  const totalEtapas = etapas.length;

  // Zero etapas: "completou todas" seria verdade vazia (current_stage >= 0
  // liberaria qualquer evento). A consulta funcionou e o dado esta errado.
  if (totalEtapas === 0) {
    return invalida({
      event_id: eventId,
      quiz_version: evento.quiz_version,
      motivo: "versao sem etapas cadastradas",
    });
  }

  // current_stage e comparado com stage_number: a contagem so vale se for 1..N.
  const numeros = etapas.map((e) => e.stage_number).sort((a, b) => (a ?? 0) - (b ?? 0));
  const numeracaoOk = numeros.every((n, i) => n === i + 1);
  if (!numeracaoOk) {
    return invalida({
      event_id: eventId,
      quiz_version: evento.quiz_version,
      motivo: "stage_number da versao nao e 1..N",
      stage_numbers: numeros,
    });
  }

  // Trava de sanidade da v1 (mesma de /api/complete-quiz).
  if (evento.quiz_version === 1 && totalEtapas !== TOTAL_STAGES) {
    return invalida({
      event_id: eventId,
      quiz_version: evento.quiz_version,
      encontradas: totalEtapas,
      esperadas_v1: TOTAL_STAGES,
    });
  }

  if (evento.current_stage < totalEtapas) {
    return {
      ok: false,
      status: statusDoCodigo("EVENT_INCOMPLETE"),
      error: `Evento não completou as ${totalEtapas} etapas`,
      codigo: "EVENT_INCOMPLETE",
      detalhes: { etapa_atual: evento.current_stage, total_etapas: totalEtapas },
      motivo: "etapas_incompletas",
    };
  }

  return { ok: true, evento, totalEtapas };
}

/**
 * Le o evento e a contagem de etapas da versao dele e decide se o evento
 * completou todas as etapas. Contrato ORIGINAL, preservado: nao olha o modo.
 *
 * Quem a usa por esse contrato: a rota da proxima etapa do participante
 * (app/api/etapa/proxima), que no modo assincrono precisa da CONTAGEM de etapas e
 * le `detalhes.total_etapas` da recusa "etapas_incompletas". Por isso esta funcao
 * nao muda de comportamento; os portoes de PROCESSAMENTO usam
 * `verificarEventoParaProcessar`, abaixo.
 */
export async function verificarEtapasDoEvento(
  supabase: ClienteDeLeitura,
  eventId: string,
): Promise<ResultadoPortaoDeEtapas> {
  const lido = await lerEvento(supabase, eventId);
  if ("falha" in lido) return lido.falha;
  return avaliarEtapas(supabase, lido.evento);
}

export type ResultadoDoPortaoDeProcessamento =
  | FalhaDoPortao
  | { ok: true; evento: EventoParaPortao; modo: "live"; totalEtapas: number }
  | { ok: true; evento: EventoParaPortao; modo: "async"; totalEtapas: null };

/**
 * O PORTAO DO PROCESSAMENTO COLETIVO ("Processar prognosticos"), usado pelas duas
 * rotas. O criterio depende do MODO do evento:
 *   live  : `current_stage` >= total de etapas da versao (como sempre foi);
 *   async : coleta ENCERRADA (form_closes_at + tolerancia de envio), sem etapa.
 *   modo ausente/desconhecido: nao se adivinha -> EVENT_MODE_UNDETERMINED (503).
 */
export async function verificarEventoParaProcessar(
  supabase: ClienteDeLeitura & Partial<ClienteComRelogio>,
  eventId: string,
  /**
   * `agora` e INJETAVEL so para teste. Em producao (sem `agora`) a hora vem do
   * BANCO; o caminho de producao nunca le o relogio do Node.
   */
  opcoes: { agora?: Date } = {},
): Promise<ResultadoDoPortaoDeProcessamento> {
  const lido = await lerEvento(supabase, eventId);
  if ("falha" in lido) return lido.falha as FalhaDoPortao;
  const { evento } = lido;

  if (evento.mode === "async") {
    const ref = opcoes.agora ? { agora: opcoes.agora } : await lerRelogioDoBanco(supabase);
    if ("falha" in ref) return ref.falha;
    return verificarColeta(evento, ref.agora) ?? { ok: true, evento, modo: "async", totalEtapas: null };
  }
  if (evento.mode !== "live") {
    return modoIndeterminado({ event_id: eventId, mode: evento.mode ?? null });
  }

  const r = await avaliarEtapas(supabase, evento);
  return r.ok ? { ok: true, evento, modo: "live", totalEtapas: r.totalEtapas } : r;
}

