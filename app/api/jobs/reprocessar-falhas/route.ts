import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import { reenfileirarJob, type ClienteFila } from "@/lib/jobs/fila";

export const maxDuration = 30;

// REPROCESSAR AS FALHAS DE UM EVENTO, EM LOTE (Rodada 69 do CTO).
//
// Se a chave da IA falhar na segunda, as 50 geracoes terminam em `failed`, e o
// unico caminho era "Tentar de novo" pessoa por pessoa, cada um com
// confirmacao. Esta rota faz o mesmo ato -- `jobs_reenfileirar`, a funcao do
// banco que o botao individual ja usa -- para todos os jobs FALHOS do evento,
// numa operacao so, autorizada e confirmada na tela.
//
// O QUE ELA NAO FAZ, de proposito:
//   - nao toca job em sucesso nem pulado: sem `p_forcar`, o banco recusa
//     desfazer desfecho bom, entao documento ja gerado nao e refeito;
//   - nao zera o livro de consumo: o teto por evento e por participante
//     (migration 021) e contado no livro-razao, que reenfileirar nao apaga. Se o
//     teto acabou, o worker recusa e o job termina cancelado pelo disjuntor;
//   - nao reabre a coleta nem muda o status do evento.
//
// A resposta diz quantos voltaram e, por job, por que algum nao voltou.

export async function POST(req: NextRequest) {
  const admin = await verificarAdmin();
  if (!admin.autorizado) return respostaDeRecusa(admin);

  let eventId: unknown;
  try {
    eventId = ((await req.json()) as { event_id?: unknown } | null)?.event_id;
  } catch {
    return erroHttp("INVALID_REQUEST");
  }
  if (typeof eventId !== "string" || !/^[0-9a-f-]{36}$/i.test(eventId)) {
    return erroHttp("INVALID_REQUEST");
  }

  const supabase = createAdminClient();
  const { data, error } = (await (supabase.from("jobs") as unknown as {
    select(c: string): {
      eq(c: string, v: string): {
        eq(c: string, v: string): {
          eq(c: string, v: string): Promise<{ data: { id: string }[] | null; error: unknown }>;
        };
      };
    };
  })
    .select("id")
    .eq("event_id", eventId)
    .eq("kind", "prognostico")
    .eq("status", "failed"));
  if (error || !data) return erroHttp("QUEUE_UNAVAILABLE", { causa: error });

  const cliente = supabase as unknown as ClienteFila;
  let reenfileirados = 0;
  const naoVoltaram: { job_id: string; motivo: string }[] = [];
  for (const { id } of data) {
    try {
      const r = await reenfileirarJob(cliente, { id });
      if (r.aplicado) reenfileirados++;
      else naoVoltaram.push({ job_id: id, motivo: r.motivo });
    } catch (err) {
      naoVoltaram.push({ job_id: id, motivo: err instanceof Error ? err.message : "falha ao reenfileirar" });
    }
  }

  return NextResponse.json({
    ok: true,
    falhas_encontradas: data.length,
    reenfileirados,
    nao_voltaram: naoVoltaram,
  });
}
