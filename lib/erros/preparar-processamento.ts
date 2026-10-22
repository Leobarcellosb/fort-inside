import type { NextResponse } from "next/server";
import { erroHttp } from "./resposta";
import type { CorpoDeErro } from "./codigos";
import {
  verificarEventoParaProcessar,
  type ClienteComRelogio,
  type ClienteDeLeitura,
  type EventoParaPortao,
} from "../quiz/etapas-do-evento";
import { iniciarProcessamentoAssincrono, type ClienteDeInicio, type InicioConfirmado } from "./iniciar-assincrono";

// A parte COMUM de /api/jobs/enfileirar e /api/batch-process, depois da checagem
// de admin: ler o corpo, passar pelo portão de etapas, ler os participantes que
// concluíram o quiz.
//
// Existe para que as duas rotas, diante da mesma condição, devolvam o MESMO
// status e o MESMO código por construção, e não por duas listas de `if` que
// alguém precisa lembrar de manter iguais. A checagem de admin fica na rota (cada
// uma chama `getAdminUser()` e `respostaDeRecusaDeAdmin()`): é a porta de
// segurança e precisa estar à vista no arquivo da rota.
//
// ORDEM (idêntica nas duas): pedido -> evento/etapas -> participantes.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConsultaParticipantes {
  select(colunas: string): {
    eq(coluna: string, valor: string): {
      not(
        coluna: string,
        operador: string,
        valor: unknown
      ): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

interface ClienteDeParticipantes {
  from(tabela: string): ConsultaParticipantes;
}

export type PreparoDeProcessamento =
  | { ok: false; resposta: NextResponse<CorpoDeErro> }
  | {
      ok: true;
      eventId: string;
      evento: EventoParaPortao;
      /** Contagem de etapas da versão (live); `null` no assíncrono, onde o critério é o prazo. */
      totalEtapas: number | null;
      modo: "live" | "async";
      participantes: { id: string; completed_at: string | null }[];
      /**
       * Só no ASSÍNCRONO: o desfecho do início atômico no banco (fotografia
       * consistente, hora do banco, impressão digital). No presencial é `null`.
       */
      inicio: InicioConfirmado | null;
    };

export type ClienteDeProcessamento = ClienteDeLeitura & Partial<ClienteComRelogio>;

export interface OpcoesDePreparo {
  /**
   * O que fazer no ASSÍNCRONO depois do portão:
   *   "enfileirar" (padrão) -- /api/jobs/enfileirar: o banco enfileira a fotografia;
   *   "verificar"           -- /api/batch-process: o banco confere e fotografa, e a
   *                            rota gera em processo SOBRE esse conjunto.
   */
  assincrono?: "enfileirar" | "verificar";
}

export async function prepararProcessamento(
  req: Pick<Request, "json">,
  supabase: ClienteDeProcessamento,
  opcoes: OpcoesDePreparo = {}
): Promise<PreparoDeProcessamento> {
  // 1. pedido
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return { ok: false, resposta: erroHttp("INVALID_REQUEST") };
  }
  const eventId = (bruto as { event_id?: unknown } | null)?.event_id;
  if (typeof eventId !== "string" || !UUID.test(eventId)) {
    return { ok: false, resposta: erroHttp("INVALID_REQUEST") };
  }

  // 2. evento: no presencial, etapas (a contagem vem do banco, nunca de um número fixo);
  //    no assíncrono, o encerramento da coleta
  const portao = await verificarEventoParaProcessar(supabase, eventId);
  if (!portao.ok) {
    return {
      ok: false,
      resposta: erroHttp(portao.codigo, { detalhes: portao.detalhes, error: portao.error, causa: portao.motivo }),
    };
  }

  // 2b. ASSÍNCRONO: quem decide o conjunto é o BANCO, numa transação só (hora do
  //     banco, sem gravação em voo no limite, fotografia única validada no fim).
  //     Ler os participantes daqui, em passos separados, reabriria a corrida.
  if (portao.modo === "async") {
    const inicio = await iniciarProcessamentoAssincrono(supabase as unknown as ClienteDeInicio, {
      eventId,
      evento: portao.evento,
      somenteVerificar: opcoes.assincrono === "verificar",
    });
    if (!inicio.ok) {
      return {
        ok: false,
        resposta: erroHttp(inicio.codigo as Parameters<typeof erroHttp>[0], {
          detalhes: inicio.detalhes,
          causa: inicio.causa,
        }),
      };
    }
    return {
      ok: true,
      eventId,
      evento: portao.evento,
      totalEtapas: portao.totalEtapas,
      modo: portao.modo,
      participantes: inicio.ids.map((id) => ({ id, completed_at: null })),
      inicio,
    };
  }

  // 3. participantes que concluíram. Erro de LEITURA não é "ninguém concluiu".
  const { data, error } = (await (supabase as unknown as ClienteDeParticipantes)
    .from("participants")
    .select("id, completed_at")
    .eq("event_id", eventId)
    .not("completed_at", "is", null)) as {
    data: { id: string; completed_at: string | null }[] | null;
    error: unknown;
  };
  if (error || !data) {
    return { ok: false, resposta: erroHttp("PARTICIPANTS_UNAVAILABLE", { causa: error }) };
  }
  if (data.length === 0) {
    return { ok: false, resposta: erroHttp("NO_COMPLETED_PARTICIPANTS") };
  }

  return {
    ok: true,
    eventId,
    evento: portao.evento,
    totalEtapas: portao.totalEtapas,
    modo: portao.modo,
    participantes: data,
    inicio: null,
  };
}
