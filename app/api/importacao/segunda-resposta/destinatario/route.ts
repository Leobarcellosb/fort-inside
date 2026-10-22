import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import {
  gravarDestinatario,
  lerPedidoDeDestinatario,
  type ClienteDeRpc,
} from "@/lib/importacao/regularizacao";

/**
 * O SEGUNDO FATO: o destinatario do documento foi confirmado por CANAL
 * INDEPENDENTE (presencial, ou contato previamente conhecido).
 *
 * Distinto da regularizacao, de proposito: "a submissao e da Joana" nao prova
 * que "a Joana controla este e-mail". Sem este registro o banco RECUSA entregar o
 * documento de pessoa regularizada (gatilho da 029). E este registro NAO marca
 * e-mail como verificado, nao cria conta e nao toca `user_id`: ele so libera a
 * entrega para o endereco que o cadastro tem AGORA.
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
    const lido = lerPedidoDeDestinatario(corpo);
    if (!lido.ok) return erroHttp(lido.codigo, { causa: lido.motivo });

    const gravado = await gravarDestinatario(createAdminClient() as unknown as ClienteDeRpc, {
      pedido: lido.pedido,
      operador: { id: admin.user.id, email: admin.user.email ?? null },
    });
    if (!gravado.ok) {
      return erroHttp(gravado.codigo, { causa: gravado.motivo, detalhes: gravado.detalhes });
    }
    return NextResponse.json({ ok: true, gravado: gravado.resumo });
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}
