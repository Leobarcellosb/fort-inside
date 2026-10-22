import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { ClienteDeLeitura } from "@/lib/importacao/borda";
import {
  prepararMesaDeDecisao,
  type ClienteDeConsulta,
} from "@/lib/importacao/decisao-do-operador";

/**
 * A MESA DE DECISAO: o que espera decisao humana neste evento, e o que pode ser
 * revogado.
 *
 * ESTA ROTA NAO ESCREVE NADA. Ela nao importa `registrarAtoDoOperador`, nao
 * importa `aplicarPlano` e nao importa `revogarReconciliacao`: nao ha chamada de
 * escrita nenhuma para desligar aqui. E o mesmo desenho da previa da importacao,
 * e pelo mesmo motivo -- uma flag "so mostrar" seria uma condicao no meio de um
 * caminho que escreve.
 *
 * E GET de proposito: nao ha corpo, entao nao ha corpo capaz de trazer campo de
 * operador. O unico parametro aceito e `event_id`; qualquer outro e IGNORADO, e o
 * operador continua saindo de `verificarAdmin()`.
 *
 * Para cada submissao retida, a mesa traz a FICHA de cada participante do evento:
 * o que a coleta trouxe, o que o participante tem, O QUE NAO BATE entre os dois,
 * a consequencia medida (quantas etapas e itens seriam gravados, se ficaria apta)
 * e a impressao digital da ficha -- que e o que a confirmacao devolve. Sem essa
 * impressao nao se confirma nada: confirmar sem ver o que se confirma e o oposto
 * do que este projeto construiu.
 */
export async function GET(req: NextRequest) {
  try {
    return await mesa(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function mesa(req: NextRequest) {
  const admin = await verificarAdmin();
  if (!admin.autorizado) {
    return respostaDeRecusa(admin);
  }

  const eventId = (req.nextUrl.searchParams.get("event_id") ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return erroHttp("INVALID_REQUEST", { causa: "`event_id` ausente ou nao e um UUID" });
  }

  const supabase = createAdminClient();
  const preparada = await prepararMesaDeDecisao(
    supabase as unknown as ClienteDeConsulta & ClienteDeLeitura,
    eventId,
    { id: admin.user.id, email: admin.user.email ?? null },
  );
  if (!preparada.ok) {
    return erroHttp(preparada.codigo, { causa: preparada.motivo, detalhes: preparada.detalhes });
  }

  return NextResponse.json({ ok: true, mesa: preparada.mesa });
}
