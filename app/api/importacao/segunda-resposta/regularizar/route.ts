import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { ClienteDeLeitura } from "@/lib/importacao/borda";
import type { ClienteDeConsulta } from "@/lib/importacao/decisao-do-operador";
import {
  acharCaso,
  conferirDestino,
  conferirReferencia,
  gravarRegularizacao,
  lerPedidoDeRegularizacao,
  planoDaRegularizacao,
  prepararRegularizacao,
  type ClienteDeRpc,
} from "@/lib/importacao/regularizacao";

/**
 * REGULARIZA a segunda resposta do formulario publico: a organizacao confirmou,
 * por FONTE INDEPENDENTE do formulario, quem e a pessoa, e as respostas dela vao
 * para o cadastro dela -- existente e sem resposta, ou criado agora se NAO ha
 * correspondente no evento.
 *
 * A ORDEM:
 *   1. `verificarAdmin()` -- o OPERADOR vem da sessao, nunca do corpo (o corpo
 *      com campo de operador, `email_verificado` ou `identidade_via` e RECUSADO);
 *   2. o corpo: destino, fonte em VOCABULARIO FECHADO, referencia, motivo;
 *   3. o CASO, montado pela mesma funcao que a tela leu, e conferido pela
 *      impressao digital (IMPORT_DECISION_STALE se mudou -- inclusive porque
 *      outro operador decidiu antes);
 *   4. a referencia tem substancia (nao e "identidade conferida");
 *   5. o destino: cadastro vinculavel, ou criacao sem duplicata por e-mail/nome;
 *   6. o PLANO, pelo mesmo planejador da importacao;
 *   7. UMA chamada ao banco (029), que trava a submissao, confere TUDO de novo,
 *      grava pela importacao atomica (022/024) e registra no livro -- na mesma
 *      transacao. Nao ha "ato registrado sem efeito" aqui: ou os dois, ou a recusa
 *      registrada.
 *
 * O que esta rota NUNCA faz: marcar e-mail como verificado, criar conta, abrir
 * sessao, sobrescrever resposta existente, liberar entrega.
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
    const lido = lerPedidoDeRegularizacao(corpo);
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

    const achado = acharCaso(prep, pedido.submission_id, pedido.caso_impressao, "regularizar");
    if (!achado.ok) return erroHttp(achado.codigo, { causa: achado.motivo, detalhes: achado.detalhes });
    const { caso, linha } = achado.valor;

    const ref = conferirReferencia(caso, pedido.referencia, "regularizar");
    if (!ref.ok) return erroHttp(ref.codigo, { causa: ref.motivo, detalhes: ref.detalhes });

    const destino = conferirDestino(prep, caso, pedido);
    if (!destino.ok) return erroHttp(destino.codigo, { causa: destino.motivo, detalhes: destino.detalhes });

    // O id do cadastro NOVO nasce aqui so para o plano poder nomea-lo; quem cria
    // a linha e o banco, depois de conferir que nao ha correspondente.
    const participantId = pedido.destino.tipo === "vincular" ? pedido.destino.participant_id : randomUUID();

    const plano = planoDaRegularizacao(prep, linha, participantId, pedido.motivo, operador);
    if (!plano.ok) return erroHttp(plano.codigo, { causa: plano.motivo, detalhes: plano.detalhes });

    const gravado = await gravarRegularizacao(supabase as unknown as ClienteDeRpc, {
      linha,
      pedido,
      participantId,
      plano: plano.plano,
      operador,
    });
    if (!gravado.ok) {
      return erroHttp(gravado.codigo, { causa: gravado.motivo, detalhes: gravado.detalhes });
    }
    return NextResponse.json({ ok: true, caso, gravado: gravado.resumo });
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}
