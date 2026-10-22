import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { ClienteDeLeitura } from "@/lib/importacao/borda";
import type { ClienteDeConsulta } from "@/lib/importacao/decisao-do-operador";
import {
  acharCaso,
  conferirReferencia,
  gravarDesconsideracao,
  lerPedidoDeDesconsideracao,
  prepararRegularizacao,
  type ClienteDeRpc,
} from "@/lib/importacao/regularizacao";

/**
 * DESCONSIDERA a segunda resposta -- "identidade conferida: a primeira e a
 * valida". A primeira fica intacta; a segunda sai da fila de conflitos ativos e
 * fica PRESERVADA (payload cru, e-mail digitado, nome, bloqueio original),
 * imutavel e inapagavel por gatilho (029), como registro restrito a admin.
 *
 * Operador da SESSAO; fonte em vocabulario fechado; referencia com substancia;
 * motivo; impressao do caso conferida; e o banco trava a linha e confere tudo de
 * novo. PROIBIDO apagar: nao ha DELETE em lugar nenhum deste caminho.
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await verificarAdmin();
    if (!admin.autorizado) {
      return respostaDeRecusa(admin);
    }
    let corpo: unknown;
    try {
      corpo = await req.json();
    } catch (err) {
      return erroHttp("INVALID_REQUEST", { causa: err });
    }
    const lido = lerPedidoDeDesconsideracao(corpo);
    if (!lido.ok) return erroHttp(lido.codigo, { causa: lido.motivo });
    const pedido = lido.pedido;

    const supabase = createAdminClient();
    const operador = { id: admin.user.id, email: admin.user.email ?? null };
    const prep = await prepararRegularizacao(
      supabase as unknown as ClienteDeConsulta & ClienteDeLeitura,
      pedido.event_id,
      operador,
    );
    if (!prep.ok) return erroHttp(prep.codigo, { causa: prep.motivo, detalhes: prep.detalhes });

    const achado = acharCaso(prep, pedido.submission_id, pedido.caso_impressao, "desconsiderar");
    if (!achado.ok) return erroHttp(achado.codigo, { causa: achado.motivo, detalhes: achado.detalhes });

    const ref = conferirReferencia(achado.valor.caso, pedido.referencia, "desconsiderar");
    if (!ref.ok) return erroHttp(ref.codigo, { causa: ref.motivo, detalhes: ref.detalhes });

    const gravado = await gravarDesconsideracao(supabase as unknown as ClienteDeRpc, {
      linha: achado.valor.linha,
      pedido,
      operador,
    });
    if (!gravado.ok) {
      return erroHttp(gravado.codigo, { causa: gravado.motivo, detalhes: gravado.detalhes });
    }
    return NextResponse.json({ ok: true, caso: achado.valor.caso, gravado: gravado.resumo });
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}
