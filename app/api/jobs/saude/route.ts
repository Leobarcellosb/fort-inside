import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizarAcionamento } from "@/lib/jobs/autorizacao";
import { lerConfigFila } from "@/lib/jobs/config";
import { lerSaudeDaFila, type ClienteSaude } from "@/lib/jobs/saude";

// Leitura barata; não precisa do teto longo.
export const maxDuration = 30;

// Painel de saúde da fila. Admin (para a operação) ou CRON_SECRET (para um
// monitor externo bater aqui de fora, sem sessão).
//
// Devolve 200 mesmo em alerta, com `alerta.ativo` explícito. A escolha é
// deliberada: um 5xx faria um monitor de uptime confundir "a fila está parada"
// (resposta correta, dado verdadeiro) com "a rota está quebrada" (nenhum dado).
// Quem monitora deve alertar por `alerta.ativo`, não por código HTTP. Só erro
// de LEITURA devolve 500 -- aí sim não há dado nenhum.
export async function GET(req: NextRequest) {
  const origem = await autorizarAcionamento(req.headers.get("authorization"));
  if (!origem) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  let config;
  try {
    config = lerConfigFila();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "configuração inválida" },
      { status: 500 }
    );
  }

  try {
    const saude = await lerSaudeDaFila(createAdminClient() as unknown as ClienteSaude, {
      kind: "prognostico",
      config,
    });

    return NextResponse.json({
      ok: true,
      concorrencia: config.concorrencia,
      ...saude,
    });
  } catch (err) {
    // Falha de leitura não pode ser respondida com indicadores zerados: zero
    // job pendente e zero expirado parecem saúde. Aqui é 500 e sem números.
    console.error("[jobs/saude] não consegui ler a saúde da fila", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "Não consegui ler a saúde da fila; os indicadores NÃO estão disponíveis",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
