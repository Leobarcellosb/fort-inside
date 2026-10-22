import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import {
  lerContextoDoEvento,
  lerPedidoDeImportacao,
  montarPlanoDaBorda,
  type ClienteDeLeitura,
} from "@/lib/importacao/borda";

/**
 * A PREVIA da importacao de respostas coletadas FORA do aplicativo.
 *
 * ESTA ROTA NAO ESCREVE NADA. Ela monta o plano e devolve o que aconteceria:
 * quantas submissoes entram, quantas ficam retidas por identidade, quantas tem
 * DADO INCOMPATIVEL e em quais perguntas, e qual seria a cobertura resultante.
 *
 * Por que a previa e uma rota, e nao um trecho de /aplicar com uma flag: uma flag
 * "so simular" e uma condicao no meio de um caminho que escreve, e condicao no
 * meio de caminho que escreve e como se grava sem querer. Aqui nao ha chamada de
 * gravacao nenhuma para desligar -- esta rota nao importa `aplicarPlano`.
 *
 * A previa devolve `impressao_da_previa`. /aplicar exige essa impressao de volta
 * e recusa (IMPORT_PREVIEW_STALE) se o plano tiver mudado. E assim que "a previa
 * bate com o que a aplicacao faz" para de ser promessa e passa a ser conferido.
 */
export async function POST(req: NextRequest) {
  try {
    return await previa(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function previa(req: NextRequest) {
  // Rota de administrador. `verificarAdmin()` devolve os TRES desfechos
  // (AUTH_REQUIRED 401, ADMIN_FORBIDDEN 403, AUTH_UNAVAILABLE 503): o serviço de
  // login fora do ar NAO vira "sem permissao", porque a segunda conclusao manda o
  // operador tentar outra credencial que vai falhar igual.
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

  const lido = lerPedidoDeImportacao(corpo);
  if (!lido.ok) {
    return erroHttp(lido.codigo, { causa: lido.motivo });
  }

  const supabase = createAdminClient();
  const contexto = await lerContextoDoEvento(
    supabase as unknown as ClienteDeLeitura,
    lido.pedido.event_id,
  );
  if (!contexto.ok) {
    return erroHttp(contexto.codigo, { causa: contexto.motivo });
  }

  // O OPERADOR e a sessao verificada, nunca um campo do pedido (regra 3 e 5).
  const montagem = montarPlanoDaBorda(contexto.contexto, contexto.manifesto, lido.pedido, {
    id: admin.user.id,
    email: admin.user.email ?? null,
  });
  if (!montagem.ok) {
    return erroHttp(montagem.codigo, { causa: montagem.motivo, detalhes: montagem.detalhes });
  }

  return NextResponse.json({ ok: true, previa: montagem.previa });
}
