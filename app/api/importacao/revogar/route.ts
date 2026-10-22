import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { ClienteDeLeitura } from "@/lib/importacao/borda";
import {
  acharFichaDeRevogacao,
  conferirFicha,
  justificativaComInventario,
  lerPedidoDeRevogacao,
  prepararMesaDeDecisao,
  revogarReconciliacao,
  type ClienteDeConsulta,
  type ClienteDeEscrita,
} from "@/lib/importacao/decisao-do-operador";

/**
 * REVOGA uma reconciliacao: desfaz a afirmacao de que esta submissao e desta
 * pessoa.
 *
 * REVOGAR NAO APAGA O PASSADO. A funcao `importacao_externa_revogar` (migration
 * 022) grava uma linha nova de 'revogada' no historico append-only, mantem a
 * submissao com o payload cru inteiro, e so remove as RESPOSTAS CANONICAS que
 * nasceram dessa submissao -- porque elas afirmavam ser respostas daquela pessoa,
 * e isso deixou de ser verdade. Quem auditar depois ve a decisao, quem a tomou, e
 * que ela foi desfeita, por quem e por que.
 *
 * A ficha da revogacao diz, ANTES do clique, QUANTAS respostas serao removidas, e
 * que o aplicativo nao as traz de volta. Esse numero e contado no banco, nao
 * estimado: falha ao conta-lo recusa a operacao em vez de mostrar zero.
 *
 * Uma unica escrita, atomica (a funcao faz estado, remocao e historico na mesma
 * transacao) -- diferente da reconciliacao, que precisa de duas.
 *
 * O operador vem da sessao. O corpo que trouxer campo de operador e RECUSADO, e o
 * que trouxer `participant_id` tambem: a revogacao desfaz a ligacao que esta
 * GRAVADA, nunca uma informada pelo pedido.
 */
export async function POST(req: NextRequest) {
  try {
    return await revogar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function revogar(req: NextRequest) {
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

  const lido = lerPedidoDeRevogacao(corpo);
  if (!lido.ok) {
    return erroHttp(lido.codigo, { causa: lido.motivo });
  }
  const pedido = lido.pedido;

  const supabase = createAdminClient();
  const operador = { id: admin.user.id, email: admin.user.email ?? null };

  const preparada = await prepararMesaDeDecisao(
    supabase as unknown as ClienteDeConsulta & ClienteDeLeitura,
    pedido.event_id,
    operador,
  );
  if (!preparada.ok) {
    return erroHttp(preparada.codigo, { causa: preparada.motivo, detalhes: preparada.detalhes });
  }

  const achada = acharFichaDeRevogacao(preparada.mesa, preparada.submissoes, pedido.submission_id);
  if (!achada.ok) {
    return erroHttp(achada.codigo, { causa: achada.motivo, detalhes: achada.detalhes });
  }
  const ficha = achada.ficha;

  const conferida = conferirFicha(pedido.ficha_impressao, ficha.impressao_da_ficha);
  if (!conferida.ok) {
    return erroHttp(conferida.codigo, { causa: conferida.motivo });
  }

  // A justificativa vai para o livro-razao COM O INVENTARIO dos registros
  // removidos anexado pelo sistema: a reversao nao apenas conta quantas linhas
  // sairam, ela demonstra de quem era cada uma. O texto do operador fica
  // separado do que o sistema escreveu.
  const revogada = await revogarReconciliacao(supabase as unknown as ClienteDeEscrita, {
    submission_id: pedido.submission_id,
    operador,
    justificativa: justificativaComInventario(pedido.justificativa, ficha),
  });
  if (!revogada.ok) {
    return erroHttp(revogada.codigo, { causa: revogada.motivo, detalhes: { ato: "revogar" } });
  }

  return NextResponse.json({
    ok: true,
    ficha,
    revogado: revogada.resumo,
  });
}
