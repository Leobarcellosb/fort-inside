import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import {
  aplicarPlano,
  conferirPrevia,
  lerContextoDoEvento,
  lerPedidoDeImportacao,
  montarPlanoDaBorda,
  type ClienteDeAplicacao,
  type ClienteDeLeitura,
} from "@/lib/importacao/borda";

/**
 * GRAVA a importacao de respostas coletadas FORA do aplicativo.
 *
 * O caminho e o MESMO da previa, funcao por funcao: `lerPedidoDeImportacao`,
 * `lerContextoDoEvento`, `montarPlanoDaBorda`. Depois, DUAS coisas que a previa
 * nao faz:
 *
 *   1. `conferirPrevia` -- a impressao do plano que o operador VIU tem de ser a
 *      do plano montado AGORA. Se divergiu, recusa (IMPORT_PREVIEW_STALE) e nada
 *      e gravado. Confirmar sem declarar o que se viu tambem recusa: previa que
 *      nao amarra nada nao serve para nada;
 *   2. `aplicarPlano` -- a funcao `importacao_externa_aplicar`, numa transacao.
 *      Ela nao decide nada (toda decisao esta no plano) e recusa plano que nao
 *      autoriza.
 *
 * O que NAO acontece aqui, em nenhum caminho: criar participante, escolher
 * participante por semelhanca, pontuar submissao com DADO INCOMPATIVEL, ou gravar
 * resposta de submissao cuja identidade nao foi resolvida. Nada disso tem codigo
 * nesta rota -- a decisao e do planejador e a recusa e do banco.
 */
export async function POST(req: NextRequest) {
  try {
    return await aplicar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function aplicar(req: NextRequest) {
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

  const montagem = montarPlanoDaBorda(contexto.contexto, contexto.manifesto, lido.pedido, {
    id: admin.user.id,
    email: admin.user.email ?? null,
  });
  if (!montagem.ok) {
    return erroHttp(montagem.codigo, { causa: montagem.motivo, detalhes: montagem.detalhes });
  }

  const conferida = conferirPrevia(lido.pedido.previa_impressao, montagem.plano);
  if (!conferida.ok) {
    // Nada foi gravado: a gravacao nem foi chamada. A resposta sai pelo MESMO
    // construtor de erro que o resto do projeto (nenhum corpo de erro montado a
    // mao, nenhum status solto aqui), e a tela, ao ver este codigo, pede a previa
    // de novo e mostra a nova -- em vez de so dizer "vencida".
    return erroHttp(conferida.codigo, { causa: conferida.motivo });
  }

  const gravacao = await aplicarPlano(
    supabase as unknown as ClienteDeAplicacao,
    montagem.plano,
  );
  if (!gravacao.ok) {
    return erroHttp(gravacao.codigo, { causa: gravacao.motivo });
  }

  return NextResponse.json({
    ok: true,
    // A previa que foi autorizada, junto do resumo do que o banco gravou. E com
    // os dois lado a lado que se confere, depois, que um correspondeu ao outro.
    previa: montagem.previa,
    gravado: gravacao.resumo,
  });
}
