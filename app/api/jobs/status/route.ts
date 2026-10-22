import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { resumoEvento, type ClienteFila } from "@/lib/jobs/fila";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import { codigoDeFalhaDeFila, observarRpc } from "@/lib/erros/falha-de-fila";

// Leitura barata; não precisa do teto longo.
export const maxDuration = 30;

const consulta = z.object({ event_id: z.string().uuid() });

// Visibilidade sem depender dos logs da Vercel. Tudo o que esta rota devolve
// está PERSISTIDO na tabela `jobs`: quem falhou, por quê, quantas tentativas,
// quanto tempo somado, quem estava com o job quando ele travou. A resposta
// continua correta depois de a função que fez o trabalho ter morrido -- que é
// justamente o que o lote atual não consegue oferecer.
type LinhaJob = {
  id: string;
  participant_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  available_at: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  first_attempt_at: string | null;
  attempt_started_at: string | null;
  finished_at: string | null;
  last_duration_ms: number | null;
  total_duration_ms: number;
  last_error: string | null;
  last_error_code: string | null;
  result: unknown;
  ai_usage: unknown;
  updated_at: string;
};

// ERROS: mesmo vocabulário das rotas de processamento (lib/erros/codigos.ts). O
// painel decide o que dizer ao host pelo CÓDIGO, não pelo status:
//   AUTH_REQUIRED 401 / ADMIN_FORBIDDEN 403 / AUTH_UNAVAILABLE 503  (verificarAdmin)
//   INVALID_REQUEST 400
//   QUEUE_SCHEMA_MISSING 503  a função ou a tabela da fila NÃO EXISTEM no banco
//                             (migration 018 ausente) -- a ÚNICA causa que o painel
//                             traduz como "falta aplicar a migration";
//   QUEUE_UNAVAILABLE 503     a fila existe e a leitura falhou (rede, banco, tempo);
//   INTERNAL_ERROR 500        o que ninguém previu.
// Antes, qualquer erro de leitura era 500 e o painel tratava todo 5xx como "a
// migration não foi aplicada": um soluço de banco mandava o host atrás da coisa errada.
export async function GET(req: NextRequest) {
  try {
    return await ler(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function ler(req: NextRequest) {
  const admin = await verificarAdmin();
  if (!admin.autorizado) {
    return respostaDeRecusa(admin);
  }

  const parsed = consulta.safeParse({
    event_id: req.nextUrl.searchParams.get("event_id"),
  });
  if (!parsed.success) {
    return erroHttp("INVALID_REQUEST");
  }
  const { event_id } = parsed.data;

  const supabase = createAdminClient();

  // O rpc é observado para não perder o CÓDIGO do PostgREST (ver falha-de-fila.ts).
  const observado = observarRpc(supabase as unknown as ClienteFila);
  let resumo;
  try {
    resumo = await resumoEvento(observado.cliente, {
      eventId: event_id,
      kind: "prognostico",
    });
  } catch (err) {
    return erroHttp(codigoDeFalhaDeFila(observado.ultimoErro()), {
      causa: observado.ultimoErro() ?? err,
    });
  }

  // `jobs` não está em types/database.ts (a tabela nasceu na 018 e o tipo
  // gerado ainda não a conhece). Mesmo recurso que lib/ai/generate-prognostic.ts
  // usa para as tabelas que o tipo não cobre.
  const { data, error } = (await (
    supabase.from("jobs") as unknown as {
      select(cols: string): {
        eq(c: string, v: string): {
          eq(c: string, v: string): {
            order(c: string, o: { ascending: boolean }): Promise<{
              data: LinhaJob[] | null;
              error: { message: string; code?: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select(
      "id, participant_id, status, attempts, max_attempts, priority, available_at, claimed_by, lease_expires_at, first_attempt_at, attempt_started_at, finished_at, last_duration_ms, total_duration_ms, last_error, last_error_code, result, ai_usage, updated_at"
    )
    .eq("event_id", event_id)
    .eq("kind", "prognostico")
    .order("created_at", { ascending: true })) as {
    data: LinhaJob[] | null;
    error: { message: string; code?: string } | null;
  };

  if (error) {
    // Tabela ausente (PGRST205/42P01) é esquema; qualquer outro erro é a fila
    // que não respondeu. A mensagem do banco fica no log, nunca no corpo.
    return erroHttp(codigoDeFalhaDeFila(error), { causa: error });
  }

  const jobs = data ?? [];

  return NextResponse.json({
    event_id,
    resumo,
    // O que a operação quer ver primeiro: o que falhou e o que está preso.
    atencao: jobs
      .filter((j) => j.status === "failed" || j.last_error_code === "lease_expirado")
      .map((j) => ({
        participant_id: j.participant_id,
        status: j.status,
        attempts: `${j.attempts}/${j.max_attempts}`,
        codigo: j.last_error_code,
        erro: j.last_error,
      })),
    jobs,
  });
}
