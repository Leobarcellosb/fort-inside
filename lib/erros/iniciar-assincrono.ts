import type { CodigoDeErro, DetalhesDeErro } from "./codigos";
import { indicaEsquemaAusente, nomeDoObjetoAusente, type ErroRpcCru } from "./falha-de-fila";
import { fusoDoEvento, type EventoComFuso } from "../eventos/fuso";
import { TOLERANCIA_DE_ENVIO_MS } from "../quiz/etapas-do-evento";

// INICIO DO PROCESSAMENTO DE UM EVENTO ASSINCRONO -- a transicao protegida.
//
// Toda a decisao (a coleta encerrou? ha gravacao em voo no limite? qual e o
// conjunto de elegiveis?) acontece DENTRO do banco, em `jobs_iniciar_assincrono`
// (proposta de migration: lib/erros/sql/processamento_assincrono.sql). O motivo e
// a exigencia do responsavel tecnico: o relogio que vale e o do banco, e o
// conjunto processado tem de ser uma fotografia CONSISTENTE de respostas ja
// confirmadas. Fazer isso daqui, em passos separados (ler hora, ler participantes,
// enfileirar), abriria exatamente a janela da corrida.
//
// Este modulo so CHAMA a funcao e TRADUZ o desfecho para o vocabulario de codigos.
// Nada decide por hora do Node.

export interface ClienteDeInicio {
  rpc(
    nome: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: ErroRpcCru | null }>;
}

export interface InicioConfirmado {
  ok: true;
  /** Participantes elegiveis na fotografia. */
  total: number;
  criados: number;
  reaproveitados: number;
  /** Impressao digital da fotografia (ids, conclusao e respostas), para auditoria. */
  digest: string;
  /** Hora do BANCO em que a decisao foi tomada. */
  agoraDoBanco: string;
  /** Ids da fotografia (so preenchido no modo `somenteVerificar`). */
  ids: string[];
}

export interface InicioRecusado {
  ok: false;
  codigo: CodigoDeErro;
  detalhes?: DetalhesDeErro;
  causa: unknown;
}

export async function iniciarProcessamentoAssincrono(
  cliente: ClienteDeInicio,
  p: {
    eventId: string;
    evento: EventoComFuso;
    maxTentativas?: number;
    /** true = so confere e fotografa (usado pela rota do lote antigo, que gera em processo). */
    somenteVerificar?: boolean;
  }
): Promise<InicioConfirmado | InicioRecusado> {
  let r;
  try {
    r = await cliente.rpc("jobs_iniciar_assincrono", {
      p_event_id: p.eventId,
      p_kind: "prognostico",
      p_max_attempts: p.maxTentativas ?? 3,
      // Uma unica fonte da tolerancia: a constante do portao.
      p_tolerancia_segundos: Math.round(TOLERANCIA_DE_ENVIO_MS / 1000),
      p_somente_verificar: p.somenteVerificar ?? false,
    });
  } catch (e) {
    return { ok: false, codigo: "QUEUE_UNAVAILABLE", causa: e instanceof Error ? e.name : typeof e };
  }

  if (r.error) return { ok: false, codigo: codigoDoErro(r.error), causa: r.error };

  const d = r.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") {
    return { ok: false, codigo: "QUEUE_UNAVAILABLE", causa: "resposta da função em formato inesperado" };
  }

  if (d.ok === true) {
    return {
      ok: true,
      total: Number(d.total ?? 0),
      criados: Number(d.criados ?? 0),
      reaproveitados: Number(d.reaproveitados ?? 0),
      digest: String(d.digest ?? ""),
      agoraDoBanco: String(d.agora ?? ""),
      ids: Array.isArray(d.ids) ? (d.ids as unknown[]).map(String) : [],
    };
  }

  switch (d.motivo) {
    case "coleta_aberta": {
      const fuso = fusoDoEvento(p.evento);
      return {
        ok: false,
        codigo: "COLLECTION_OPEN",
        detalhes: {
          ...(typeof d.encerra_em === "string" ? { coleta_encerra_em: new Date(d.encerra_em).toISOString() } : {}),
          ...(fuso ? { fuso } : {}),
        },
        causa: d,
      };
    }
    // Havia gravacao em voo no limite, ou o banco nao deixa OBSERVAR se havia:
    // nao se processa sobre uma fotografia que nao se sabe completa.
    case "snapshot_instavel":
    case "observabilidade_indisponivel":
      return { ok: false, codigo: "SNAPSHOT_UNSTABLE", causa: d };
    case "janela_indeterminada":
      return { ok: false, codigo: "COLLECTION_WINDOW_UNDETERMINED", causa: d };
    case "modo_nao_assincrono":
      return { ok: false, codigo: "EVENT_MODE_UNDETERMINED", causa: d };
    case "evento_inexistente":
      return { ok: false, codigo: "EVENT_NOT_FOUND", causa: d };
    case "sem_elegiveis":
      return { ok: false, codigo: "NO_COMPLETED_PARTICIPANTS", causa: d };
    default:
      return { ok: false, codigo: "QUEUE_UNAVAILABLE", causa: d };
  }
}

/** Erro do RPC -> codigo. Separa "faltou a funcao que EU chamei" de "faltou algo que ELA usa". */
export function codigoDoErro(erro: ErroRpcCru): CodigoDeErro {
  const msg = erro.message ?? "";
  // A funcao levanta isto de proposito, para DESFAZER tudo, quando a fotografia mudou no meio.
  if (/SNAPSHOT_INSTAVEL/.test(msg)) return "SNAPSHOT_UNSTABLE";
  if (indicaEsquemaAusente(erro)) {
    const nome = nomeDoObjetoAusente(msg);
    if (nome !== null && nome.startsWith("jobs_iniciar_assincrono")) return "ASYNC_PROCESSING_MISSING";
    // PostgREST sem nome na mensagem: foi a funcao chamada.
    if (nome === null) return "ASYNC_PROCESSING_MISSING";
    // Faltou algo que a funcao usa por dentro (jobs_enfileirar, tabela jobs...): e a fila.
    return "QUEUE_SCHEMA_MISSING";
  }
  return "QUEUE_UNAVAILABLE";
}
