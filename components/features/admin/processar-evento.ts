// "Processar prognósticos" = ENFILEIRAR. Nada mais.
//
// O botão do painel deixou de chamar o lote antigo (/api/batch-process, que gera
// tudo dentro de UMA requisição e não deixa registro por pessoa). Agora ele cria
// jobs duráveis em /api/jobs/enfileirar e quem acompanha é a fila.
//
// REGRA DE OURO deste arquivo: nenhum caminho daqui chama o lote. Se a fila não
// está disponível, o resultado é `fila_indisponivel` e o botão fica bloqueado com
// uma mensagem que diz o que fazer. Cair de volta no lote em silêncio seria o pior
// dos mundos: o host acharia que está tudo bem e o resultado por pessoa evaporaria.
//
// ERROS: o servidor emite um CÓDIGO (lib/erros/codigos.ts) e esta tela o traduz
// para a mensagem do host (lib/erros/mensagens-host.ts). O STATUS HTTP é só a
// classe do problema; quem diz a causa é o código. Código desconhecido, ausente
// ou corpo genérico ("Erro") vira a mensagem genérica segura mais o número da
// ocorrência, que também é registrado. O texto `error` do corpo NUNCA é exibido, e
// a mensagem da migration 018 só sai para QUEUE_SCHEMA_MISSING.
//
// Funções puras em torno de um `fetcher` injetável, para provar o comportamento em
// teste sem rede e, no teste das duas sessões, com o cookie de cada administrador.

import {
  ehCodigoDeErro,
  type CodigoDeErro,
  type DetalhesDeErro,
} from "../../../lib/erros/codigos";
import {
  MENSAGEM_FILA_INDISPONIVEL,
  MENSAGEM_GENERICA,
  mensagemParaHost,
} from "../../../lib/erros/mensagens-host";

// A tela importava esta constante daqui; continua exportada.
export { MENSAGEM_FILA_INDISPONIVEL };

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Registro de uma ocorrência que a tela não soube explicar. Injetável para o teste enxergar. */
export type Registrador = (registro: {
  ocorrencia: string;
  status: number;
  codigo: string | null;
}) => void;

export type ResultadoSolicitacao =
  | {
      tipo: "enfileirado";
      /** Participantes com quiz concluído que a rota considerou. */
      totalParticipantes: number;
      /** Jobs criados agora. */
      criados: number;
      /** Jobs que já existiam e foram preservados (clique duplo, reprocessamento). */
      reaproveitados: number;
    }
  | { tipo: "parcial"; criados: number; reaproveitados: number; semFila: number }
  /** Regra ou permissão: o host sabe o que fazer (liberar etapa, entrar de novo). */
  | { tipo: "recusado"; codigo: CodigoDeErro; mensagem: string }
  /**
   * Não foi possível verificar, ou a configuração está quebrada: precisa de nova
   * tentativa ou da equipe técnica. NÃO é a fila ausente e NÃO bloqueia o botão.
   */
  | { tipo: "bloqueado"; codigo: CodigoDeErro; mensagem: string; ocorrencia: string | null }
  /** SOMENTE QUEUE_SCHEMA_MISSING: as funções da fila não existem no banco. */
  | { tipo: "fila_indisponivel"; codigo: "QUEUE_SCHEMA_MISSING"; mensagem: string; ocorrencia: string | null }
  /** Código desconhecido/ausente ou corpo genérico: mensagem genérica segura + ocorrência. */
  | { tipo: "erro_inesperado"; mensagem: string; ocorrencia: string; status: number }
  | { tipo: "sem_conexao"; mensagem: string };

export const MENSAGEM_SEM_CONEXAO =
  "Não foi possível falar com o servidor agora. Nada foi enviado para processar. Confira a conexão e tente de novo.";

function numero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Em qual das classes da tela cada código cai. Uma tabela, não um `if` por status. */
const CLASSE_DO_CODIGO: Record<CodigoDeErro, "recusado" | "bloqueado" | "fila_indisponivel" | "inesperado"> = {
  INVALID_REQUEST: "recusado",
  AUTH_REQUIRED: "recusado",
  ADMIN_FORBIDDEN: "recusado",
  EVENT_NOT_FOUND: "recusado",
  EVENT_INCOMPLETE: "recusado",
  COLLECTION_OPEN: "recusado",
  EVENT_MODE_UNDETERMINED: "bloqueado",
  COLLECTION_WINDOW_UNDETERMINED: "bloqueado",
  TIME_REFERENCE_UNAVAILABLE: "bloqueado",
  ASYNC_PROCESSING_MISSING: "bloqueado",
  SNAPSHOT_UNSTABLE: "bloqueado",
  BUDGET_MEASUREMENT_MISSING: "bloqueado",
  BUDGET_MEASUREMENT_UNAVAILABLE: "bloqueado",
  NO_COMPLETED_PARTICIPANTS: "recusado",
  AUTH_UNAVAILABLE: "bloqueado",
  PARTICIPANTS_UNAVAILABLE: "bloqueado",
  QUIZ_STAGES_UNAVAILABLE: "bloqueado",
  QUIZ_STAGES_INVALID: "bloqueado",
  QUEUE_UNAVAILABLE: "bloqueado",
  QUEUE_CONFIG_INVALID: "bloqueado",
  QUEUE_SCHEMA_MISSING: "fila_indisponivel",
  INTERNAL_ERROR: "inesperado",
};

const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

function ocorrenciaDaResposta(res: Response, corpo: Record<string, unknown>): string | null {
  if (typeof corpo.ocorrencia === "string" && ID_VALIDO.test(corpo.ocorrencia)) return corpo.ocorrencia;
  for (const h of ["x-request-id", "x-vercel-id"]) {
    const v = res.headers?.get?.(h);
    if (v && ID_VALIDO.test(v)) return v;
  }
  return null;
}

function ocorrenciaLocal(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}

const registrarNoConsole: Registrador = (r) => {
  console.error("[processar-evento] ocorrência", r);
};

function detalhesDe(corpo: Record<string, unknown>): DetalhesDeErro | undefined {
  const d = corpo.detalhes;
  if (!d || typeof d !== "object") return undefined;
  const { etapa_atual, total_etapas, coleta_encerra_em, fuso } = d as Record<string, unknown>;
  return {
    etapa_atual: typeof etapa_atual === "number" ? etapa_atual : undefined,
    total_etapas: typeof total_etapas === "number" ? total_etapas : undefined,
    coleta_encerra_em: typeof coleta_encerra_em === "string" ? coleta_encerra_em : undefined,
    fuso: typeof fuso === "string" ? fuso : undefined,
  };
}

function comOcorrencia(mensagem: string, ocorrencia: string | null): string {
  return ocorrencia ? `${mensagem} Ocorrência: ${ocorrencia}.` : mensagem;
}

export async function solicitarProcessamento(
  eventId: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole
): Promise<ResultadoSolicitacao> {
  let res: Response;
  try {
    res = await fetcher("/api/jobs/enfileirar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId }),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }

  let corpo: Record<string, unknown> = {};
  try {
    const lido = await res.json();
    if (lido && typeof lido === "object" && !Array.isArray(lido)) corpo = lido as Record<string, unknown>;
  } catch {
    /* corpo não-JSON */
  }

  if (!res.ok) {
    const ocorrenciaServidor = ocorrenciaDaResposta(res, corpo);

    // O CÓDIGO diz a causa. O status só diz que deu errado: sem um código do
    // vocabulário não há como saber se foi permissão, sessão, etapa ou banco, e
    // inventar uma causa (a migration, em especial) manda o host investigar a
    // coisa errada no meio de um evento.
    if (!ehCodigoDeErro(corpo.code)) {
      const ocorrencia = ocorrenciaServidor ?? ocorrenciaLocal();
      registrar({ ocorrencia, status: res.status, codigo: typeof corpo.code === "string" ? corpo.code : null });
      return {
        tipo: "erro_inesperado",
        mensagem: comOcorrencia(MENSAGEM_GENERICA, ocorrencia),
        ocorrencia,
        status: res.status,
      };
    }

    const codigo = corpo.code;
    const classe = CLASSE_DO_CODIGO[codigo];
    const mensagem = mensagemParaHost(codigo, detalhesDe(corpo));

    if (classe === "recusado") return { tipo: "recusado", codigo, mensagem };

    if (classe === "inesperado") {
      const ocorrencia = ocorrenciaServidor ?? ocorrenciaLocal();
      registrar({ ocorrencia, status: res.status, codigo });
      return { tipo: "erro_inesperado", mensagem: comOcorrencia(mensagem, ocorrencia), ocorrencia, status: res.status };
    }

    if (ocorrenciaServidor) registrar({ ocorrencia: ocorrenciaServidor, status: res.status, codigo });
    if (classe === "fila_indisponivel") {
      // Texto exato da migration: o painel mostra o mesmo texto no bloco fixo.
      return { tipo: "fila_indisponivel", codigo: "QUEUE_SCHEMA_MISSING", mensagem, ocorrencia: ocorrenciaServidor };
    }
    return { tipo: "bloqueado", codigo, mensagem: comOcorrencia(mensagem, ocorrenciaServidor), ocorrencia: ocorrenciaServidor };
  }

  const comErro = Array.isArray(corpo.com_erro) ? corpo.com_erro.length : 0;
  const criados = numero(corpo.criados);
  const reaproveitados = numero(corpo.reaproveitados);
  if (comErro > 0) {
    // Falha por pessoa que o servidor deixou passar como 200: dizemos quantas
    // ficaram de fora. NÃO se presume causa de infraestrutura -- se a fila
    // inteira falhasse, o servidor responderia com o código da causa.
    return { tipo: "parcial", criados, reaproveitados, semFila: comErro };
  }
  return {
    tipo: "enfileirado",
    totalParticipantes: numero(corpo.total_participantes),
    criados,
    reaproveitados,
  };
}

/** Texto curto para o aviso depois de enfileirar. */
export function textoDoEnfileiramento(r: ResultadoSolicitacao): string {
  switch (r.tipo) {
    case "enfileirado": {
      const novos =
        r.criados === 0
          ? "Ninguém novo entrou na fila: todos já estavam nela."
          : r.criados === 1
            ? "1 pessoa entrou na fila."
            : `${r.criados} pessoas entraram na fila.`;
      const antes =
        r.criados > 0 && r.reaproveitados > 0
          ? ` ${r.reaproveitados} já estava${r.reaproveitados === 1 ? "" : "m"} na fila e foi${r.reaproveitados === 1 ? "" : "ram"} preservada${r.reaproveitados === 1 ? "" : "s"}.`
          : "";
      return novos + antes;
    }
    case "parcial":
      return `${r.criados + r.reaproveitados} pessoas estão na fila, mas ${r.semFila} não conseguiram entrar. Veja a lista abaixo e tente de novo.`;
    default:
      return r.mensagem;
  }
}

/** Interpreta a resposta de /api/jobs/status: a fila está utilizável? */
export function filaUtilizavel(status: number | null): boolean {
  return status === 200;
}
