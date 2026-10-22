import { janelaDeIso } from "../../../../components/features/participant/janela-da-etapa";
import {
  decidirDestino,
  type RespostaProxima,
} from "../../../../components/features/participant/proxima-etapa";
import { verificarEtapasDoEvento } from "../../../../lib/quiz/etapas-do-evento";

// QUAL E A PROXIMA ETAPA DESTA PESSOA (so modo assincrono). Ver proxima-etapa.ts
// do componente para a regra. Aqui ficam as LEITURAS, com a sessao do proprio
// participante (RLS valendo; nada de service_role).
//
// Contagem de etapas: `verificarEtapasDoEvento` (lib/quiz/etapas-do-evento.ts) e
// a fonte, como nos portoes de processamento. Ela foi escrita para o portao do
// "Processar prognosticos" e por isso tambem compara `current_stage` com o
// total; no assincrono `current_stage` nao anda, entao aqui a resposta
// "etapas_incompletas" e a normal e o total vem de `detalhes.total_etapas`
// (a mesma validacao 1..N e a mesma trava da v1 ja foram feitas por ela).
//
// NAO HA PALPITE. Qualquer leitura que falhe, ou versao inconsistente, vira
// destino `indisponivel` (com causa propria) -- nunca "etapa 1".

interface ErroDoBanco {
  code?: string;
}
interface Consulta extends PromiseLike<{ data: unknown; error: ErroDoBanco | null }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: ErroDoBanco | null }>;
}
export interface ClienteDeProxima {
  from(tabela: string): { select(colunas: string): Consulta };
}

export type ResultadoDaProxima =
  | { tipo: "ok"; resposta: RespostaProxima }
  | { tipo: "nao_autorizado" }
  | { tipo: "nao_encontrado" }
  | { tipo: "erro"; causa: unknown };

export async function calcularProximaEtapa(
  supabase: ClienteDeProxima,
  entrada: { userId: string; participantId: string; agora?: () => number },
): Promise<ResultadoDaProxima> {
  const agora = entrada.agora ?? Date.now;
  try {
    const p = (await supabase
      .from("participants")
      .select("id, user_id, event_id")
      .eq("id", entrada.participantId)
      .maybeSingle()) as {
      data: { id: string; user_id: string | null; event_id: string } | null;
      error: ErroDoBanco | null;
    };
    if (p.error) return { tipo: "erro", causa: p.error };
    if (!p.data || p.data.user_id !== entrada.userId) return { tipo: "nao_autorizado" };
    const eventId = p.data.event_id;

    const ev = (await supabase
      .from("events")
      .select("id, mode, quiz_version, form_opens_at, form_closes_at")
      .eq("id", eventId)
      .maybeSingle()) as {
      data: {
        mode: "live" | "async";
        quiz_version: number;
        form_opens_at: string | null;
        form_closes_at: string | null;
      } | null;
      error: ErroDoBanco | null;
    };
    if (ev.error) return { tipo: "erro", causa: ev.error };
    if (!ev.data) return { tipo: "nao_encontrado" };
    const evento = ev.data;

    const base = {
      agora: new Date(agora()).toISOString(),
    };

    // LIVE: esta rota nao decide nada. current_stage continua mandando, no cliente.
    if (evento.mode === "live") {
      return {
        tipo: "ok",
        resposta: {
          modo: "live",
          ...base,
          janela: null,
          total_etapas: null,
          etapas_enviadas: [],
          etapas_iniciadas: [],
          destino: null,
        },
      };
    }

    const resposta = (
      parcial: Pick<RespostaProxima, "destino"> &
        Partial<Pick<RespostaProxima, "total_etapas" | "etapas_enviadas" | "etapas_iniciadas">>,
    ): ResultadoDaProxima => ({
      tipo: "ok",
      resposta: {
        modo: "async",
        ...base,
        janela: { abre: evento.form_opens_at, fecha: evento.form_closes_at },
        total_etapas: parcial.total_etapas ?? null,
        etapas_enviadas: parcial.etapas_enviadas ?? [],
        etapas_iniciadas: parcial.etapas_iniciadas ?? [],
        destino: parcial.destino,
      },
    });

    // 1. Quantas etapas a versao tem (fonte unica).
    const v = await verificarEtapasDoEvento(supabase, eventId);
    let total: number;
    if (v.ok) total = v.totalEtapas;
    else if (v.motivo === "etapas_incompletas" && typeof v.detalhes?.total_etapas === "number") {
      total = v.detalhes.total_etapas;
    } else if (v.motivo === "etapas_invalidas") {
      return resposta({ destino: { tipo: "indisponivel", motivo: "configuracao" } });
    } else if (v.motivo === "evento_inexistente") {
      return { tipo: "nao_encontrado" };
    } else {
      return resposta({ destino: { tipo: "indisponivel", motivo: "leitura" } });
    }

    // 2. id <-> numero das etapas da versao, e o que a pessoa ja tem gravado.
    const et = (await supabase
      .from("quiz_stages")
      .select("id, stage_number")
      .eq("quiz_version", evento.quiz_version)) as unknown as {
      data: { id: number; stage_number: number | null }[] | null;
      error: ErroDoBanco | null;
    };
    if (et.error || !et.data) {
      return resposta({ total_etapas: total, destino: { tipo: "indisponivel", motivo: "leitura" } });
    }
    if (et.data.length !== total) {
      return resposta({ total_etapas: total, destino: { tipo: "indisponivel", motivo: "configuracao" } });
    }
    const numeroPorId = new Map(et.data.map((s) => [s.id, s.stage_number as number]));

    const [respostas, sessoes] = (await Promise.all([
      supabase.from("quiz_responses").select("stage_id").eq("participant_id", entrada.participantId),
      supabase
        .from("participant_stage_sessions")
        .select("stage_id")
        .eq("participant_id", entrada.participantId)
        .eq("event_id", eventId),
    ])) as unknown as {
      data: { stage_id: number }[] | null;
      error: ErroDoBanco | null;
    }[];
    if (respostas.error || !respostas.data || sessoes.error || !sessoes.data) {
      return resposta({ total_etapas: total, destino: { tipo: "indisponivel", motivo: "leitura" } });
    }
    const numeros = (linhas: { stage_id: number }[]) =>
      linhas
        .map((l) => numeroPorId.get(l.stage_id))
        .filter((n): n is number => typeof n === "number")
        .sort((a, b) => a - b);
    const enviadas = numeros(respostas.data);
    const iniciadas = numeros(sessoes.data);

    // 3. Decide pela janela (mesma funcao da tela da etapa).
    const destino = decidirDestino({
      totalEtapas: total,
      enviadas,
      iniciadas,
      agora: agora(),
      janela: janelaDeIso(evento.form_opens_at, evento.form_closes_at),
    });
    return resposta({
      total_etapas: total,
      etapas_enviadas: enviadas,
      etapas_iniciadas: iniciadas,
      destino,
    });
  } catch (causa) {
    return { tipo: "erro", causa };
  }
}
