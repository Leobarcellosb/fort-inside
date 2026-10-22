import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import { aplicarPlano, type ClienteDeAplicacao, type ClienteDeLeitura } from "@/lib/importacao/borda";
import {
  CODIGO_DA_RECUSA_DA_DECISAO,
  acharFichaDeReconciliacao,
  conferirFicha,
  lerPedidoDeReconciliacao,
  planoDaDecisao,
  prepararMesaDeDecisao,
  recusaDaRevalidacao,
  registrarAtoDoOperador,
  type ClienteDeConsulta,
  type ClienteDeEscrita,
} from "@/lib/importacao/decisao-do-operador";

/**
 * RESOLVE uma pendencia ou um conflito de identidade: o operador afirma que esta
 * submissao e deste participante.
 *
 * O OPERADOR VEM DA SESSAO, nunca do corpo. `lerPedidoDeReconciliacao` RECUSA o
 * corpo que traga `operador`, `operador_id`, `operador_email`, `importado_por`,
 * `decidido_por`, `acao` ou `criado_em`: auditoria escrita pelo auditado nao e
 * auditoria.
 *
 * A ORDEM, e nenhuma etapa dela e dispensavel:
 *   1. `verificarAdmin()` -- tres desfechos (401/403/503), e "nao consegui
 *      verificar" nunca vira "sem permissao";
 *   2. o corpo, validado, com justificativa escrita;
 *   3. a MESA, montada pela mesma funcao que a rota de leitura usa;
 *   4. a FICHA que o pedido nomeia -- e aqui que os quatro fatos se separam:
 *      submissao inexistente (404), estado que nao se decide, participante de
 *      outro evento, e ALVO OCUPADO (IMPORT_TARGET_OCCUPIED);
 *   5. `conferirFicha` -- a impressao da ficha que o operador VIU tem de ser a da
 *      ficha de agora. Divergiu? Recusa, e NADA foi escrito;
 *   6. o PLANO, pelo mesmo planejador da importacao (manifesto conferido antes de
 *      mapear qualquer resposta);
 *   7. o ATO, registrado no historico append-only COM a justificativa;
 *   8. a GRAVACAO, pela mesma `importacao_externa_aplicar` da importacao.
 *
 * Os passos 7 e 8 sao duas escritas, nesta ordem, porque a 022 nao tem uma funcao
 * que faca as duas coisas numa transacao e nao se escreve migration aqui. Se 7
 * falhar, nada e gravado. Se 8 falhar, o historico guarda o ATO SEM O EFEITO e a
 * resposta diz exatamente isso (IMPORT_ACT_NOT_APPLIED): a submissao continua sem
 * participante, e o par (ato, efeito) e como se le o que de fato pegou.
 */
export async function POST(req: NextRequest) {
  try {
    return await reconciliar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function reconciliar(req: NextRequest) {
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

  const lido = lerPedidoDeReconciliacao(corpo);
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

  const achada = acharFichaDeReconciliacao(
    preparada.mesa,
    preparada.submissoes,
    pedido.submission_id,
    pedido.participant_id,
  );
  if (!achada.ok) {
    return erroHttp(achada.codigo, { causa: achada.motivo, detalhes: achada.detalhes });
  }
  const ficha = achada.ficha;

  const conferida = conferirFicha(pedido.ficha_impressao, ficha.impressao_da_ficha);
  if (!conferida.ok) {
    // Nada foi escrito: nem o ato, nem a gravacao. A tela, ao ver este codigo,
    // recarrega a mesa e mostra a ficha nova -- em vez de so dizer "vencida".
    return erroHttp(conferida.codigo, { causa: conferida.motivo });
  }

  const linha = preparada.submissoes.find((s) => s.id === pedido.submission_id);
  if (linha === undefined) {
    // Inalcancavel: `acharFichaDeReconciliacao` ja achou a linha. Se acontecer, e
    // bug, nao recusa.
    return erroHttp("INTERNAL_ERROR", { causa: "a submissao desapareceu entre a ficha e o plano" });
  }

  const plano = planoDaDecisao(
    preparada.contexto,
    preparada.manifesto,
    linha,
    pedido.participant_id,
    pedido.justificativa,
    operador,
  );
  if (!plano.ok) {
    return erroHttp(CODIGO_DA_RECUSA_DA_DECISAO[plano.codigo], {
      causa: plano.motivo,
      detalhes: { ato: "reconciliar", estado_da_submissao: linha.estado },
    });
  }

  // 7. O ATO, ANTES do efeito. Falhou? Nada e gravado: ninguem fica ligado a
  // ninguem sem ato registrado.
  const registro = await registrarAtoDoOperador(supabase as unknown as ClienteDeEscrita, {
    submission_id: pedido.submission_id,
    operador,
    justificativa: pedido.justificativa,
    ficha,
  });
  if (!registro.ok) {
    return erroHttp(registro.codigo, { causa: registro.motivo });
  }

  // 8. O EFEITO, pelo mesmo caminho da importacao.
  const gravacao = await aplicarPlano(supabase as unknown as ClienteDeAplicacao, plano.plano);
  if (!gravacao.ok) {
    // 8b. O BANCO pode ter CONFERIDO NA HORA DE GRAVAR e recusado (revalidacao da
    // 024): entre a ficha e a confirmacao, aquelas etapas passaram a ter resposta
    // de outro dono. Isso NAO e "pronto" e NAO e "nao respondeu": e conferido e
    // recusado, com a resposta que ja existia INTACTA. O ato continua no
    // historico, junto da recusa.
    if (gravacao.recusa !== undefined) {
      const recusa = recusaDaRevalidacao(gravacao.recusa, linha.submissao_id);
      if (recusa !== null) {
        return erroHttp(recusa.codigo, { causa: recusa.motivo, detalhes: recusa.detalhes });
      }
      // O lote foi recusado e a recusa nao e desta submissao (o lote da decisao
      // tem UMA). Conferido e recusado continua sendo o fato -- nada foi gravado
      // --, e o que nao se afirma e a causa, que nao se tem.
      return erroHttp("IMPORT_REVALIDATION_REFUSED", {
        causa: gravacao.motivo,
        detalhes: { ato: "reconciliar" },
      });
    }
    // A resposta da gravacao se CONTRADIZ (recusa com escrita informada, ou
    // gravacao com recusas nomeadas): este codigo passa INTEIRO. Traduzi-lo para
    // IMPORT_ACT_NOT_APPLIED diria ao operador "nenhuma resposta foi gravada", que
    // e exatamente o que nao foi verificado.
    if (gravacao.codigo === "IMPORT_WRITE_UNVERIFIABLE") {
      return erroHttp("IMPORT_WRITE_UNVERIFIABLE", {
        causa: gravacao.motivo,
        detalhes: { ato: "reconciliar" },
      });
    }
    // O ato ESTA registrado e o efeito nao veio. Nao se diz "nada aconteceu"
    // (aconteceu: o registro) e nao se diz "pronto" (nao foi gravado).
    const codigo =
      gravacao.codigo === "IMPORT_SCHEMA_MISSING" ? "IMPORT_SCHEMA_MISSING" : "IMPORT_ACT_NOT_APPLIED";
    return erroHttp(codigo, { causa: gravacao.motivo, detalhes: { ato: "reconciliar" } });
  }

  return NextResponse.json({
    ok: true,
    // A ficha que foi confirmada, o ato que foi registrado e o resumo do que o
    // banco gravou. E com os tres lado a lado que se confere, depois, que um
    // correspondeu ao outro.
    ficha,
    ato: registro.ato,
    gravado: gravacao.resumo,
  });
}
