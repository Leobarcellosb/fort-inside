import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { ClienteDeLeitura } from "@/lib/importacao/borda";
import type { ClienteDeConsulta } from "@/lib/importacao/decisao-do-operador";
import { prepararRegularizacao } from "@/lib/importacao/regularizacao";

/**
 * A MESA DA SEGUNDA RESPOSTA do formulario publico: os conflitos
 * SEGUNDA_RESPOSTA_MESMO_EMAIL deste evento, cada um com POR QUE existe, quem e o
 * dono da primeira resposta, quais cadastros sao candidatos (e por que cada um
 * pode ou nao receber), a lista oficial no sistema (quando houver) e o EFEITO de
 * cada decisao -- e quem foi regularizado e ainda espera a confirmacao do
 * destinatario.
 *
 * ESTA ROTA NAO ESCREVE NADA (nao importa nenhuma funcao de escrita). GET: nao ha
 * corpo, entao nao ha corpo capaz de trazer operador.
 */
export async function GET(req: NextRequest) {
  try {
    const admin = await verificarAdmin();
    if (!admin.autorizado) {
      return respostaDeRecusa(admin);
    }
    const eventId = (req.nextUrl.searchParams.get("event_id") ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
      return erroHttp("INVALID_REQUEST", { causa: "`event_id` ausente ou nao e um UUID" });
    }
    const prep = await prepararRegularizacao(
      createAdminClient() as unknown as ClienteDeConsulta & ClienteDeLeitura,
      eventId,
      { id: admin.user.id, email: admin.user.email ?? null },
    );
    if (!prep.ok) {
      return erroHttp(prep.codigo, { causa: prep.motivo, detalhes: prep.detalhes });
    }
    return NextResponse.json({ ok: true, mesa: prep.mesa });
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}
