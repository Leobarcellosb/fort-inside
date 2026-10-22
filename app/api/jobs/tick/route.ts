import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizarAcionamento } from "@/lib/jobs/autorizacao";
import { lerConfigFila } from "@/lib/jobs/config";
import { rodarTick, type ClienteWorker } from "@/lib/jobs/worker";
import { trabalhoPrognostico } from "@/lib/jobs/trabalho-prognostico";

// O teto de 300s continua aqui, mas com um significado diferente do lote atual.
// No lote, 300s é o PRAZO: o que não terminar dentro dele é perdido. Aqui é só o
// tamanho da fatia: o tick trabalha até o orçamento (240s, config) e devolve.
// O que não couber fica na fila, com estado gravado, para o tick seguinte.
export const maxDuration = 300;

// Desde o Next 15 o GET de route handler é dinâmico por padrão (antes era
// estático), então o agendador não recebe resposta cacheada. A rota lê
// cabeçalhos de qualquer forma, o que já a tornaria dinâmica.

/**
 * Aciona um tick do worker.
 *
 * COMO ESTA ROTA É CHAMADA (a decisão, e o porquê)
 * ------------------------------------------------
 * Repetidamente e sem estado: um agendador bate aqui de minuto em minuto. Cada
 * chamada é independente e idempotente -- não existe "a requisição que precisa
 * sobreviver". Se um tick for cortado no meio, os jobs que ele tinha em mão
 * ficam com lease vencido e o tick SEGUINTE os retoma; o relatório de quem
 * falhou está no banco, não no log da função.
 *
 * Por que não uma requisição longa que processa tudo: é exatamente o defeito
 * que esta fila existe para remover. Com 50 participantes, 3 de concorrência e
 * ~63s por prognóstico, o trabalho total passa de 15 minutos -- não cabe em
 * NENHUM teto de função. Tem de ser fatiado, e a fatia tem de poder morrer.
 *
 * Por que não auto-chamada em cadeia (o tick chamando o próximo): a cadeia
 * quebra no primeiro elo que falhar, e ninguém reinicia. O agendador é burro e
 * é por isso que é confiável.
 *
 * GET e POST fazem a mesma coisa: o Vercel Cron chama com GET; a operação chama
 * com POST pelo painel.
 *
 * O QUE PRECISA SER CONFIGURADO NA VERCEL (não configurado por mim)
 * -----------------------------------------------------------------
 * Ver `docs/FILA-JOBS.md`, seção "Acionamento". Em resumo: `crons` no
 * vercel.json apontando para `/api/jobs/tick`, e a variável CRON_SECRET.
 * Enquanto isso não existir, a fila funciona acionada à mão pelo admin, e
 * NADA se perde -- só não anda sozinha.
 */
async function acionar(req: NextRequest) {
  const origem = await autorizarAcionamento(req.headers.get("authorization"));
  if (!origem) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  let config;
  try {
    config = lerConfigFila();
  } catch (err) {
    // Configuração inválida é erro de deploy, não de requisição. Falhar alto
    // aqui é melhor que rodar com um teto de concorrência que ninguém escolheu.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "configuração inválida" },
      { status: 500 }
    );
  }

  // Identidade do worker só para rastro: aparece em jobs.claimed_by e responde
  // "quem estava com este job quando ele travou".
  const worker = `${origem}:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${crypto.randomUUID().slice(0, 8)}`;

  const cliente = createAdminClient() as unknown as ClienteWorker;

  try {
    const relatorio = await rodarTick(cliente, {
      kind: "prognostico",
      worker,
      trabalho: trabalhoPrognostico,
      config,
    });

    // RECUSA NOMEADA: o tick não processou porque não deu para verificar o
    // consumo. 503 de propósito -- um tick bloqueado é falha operacional e
    // precisa aparecer VERMELHO no log do agendador, não como 200 silencioso.
    // (O /api/jobs/saude faz o contrário, e por um motivo diferente: lá um 5xx
    // faria o monitor confundir "a fila está parada" com "a rota quebrou".)
    if (relatorio.bloqueioDeOrcamento) {
      const b = relatorio.bloqueioDeOrcamento;
      return NextResponse.json(
        {
          ok: false,
          bloqueado: true,
          codigo: b.codigo,
          error: b.erro,
          // O texto que a operação lê. Diz o que fazer para destravar.
          mensagem_para_a_operacao: b.mensagemParaOperacao,
          detalhe: b.detalhe,
          // Explícito para ninguém confundir recusa com fila vazia.
          reivindicados: relatorio.reivindicados,
          tentativas_externas: relatorio.tentativasExternas,
          requisicoes_ao_provedor: relatorio.requisicoesAoProvedor,
          nada_foi_gasto: relatorio.requisicoesAoProvedor === 0,
          motivo_de_parada: relatorio.motivoDeParada,
          duracao_ms: relatorio.duracaoMs,
        },
        { status: b.status }
      );
    }

    return NextResponse.json({
      ok: true,
      worker: relatorio.worker,
      concorrencia: config.concorrencia,
      reivindicados: relatorio.reivindicados,
      sucesso: relatorio.sucesso,
      pulados: relatorio.pulados,
      falhas: relatorio.falhas,
      descartados: relatorio.descartados,
      // Consumo CORTADO (chamada abortada por lease perdido ou timeout), que é
      // diferente de `descartados` -- consumo gasto e resultado recusado.
      abortadas: relatorio.abortadas,
      recusados_por_orcamento: relatorio.recusadosPorOrcamento,
      chamadas_iniciadas: relatorio.chamadasIniciadas,
      teto_de_chamadas_do_tick: Math.min(config.maxJobsPorTick, config.orcamentoChamadasPorTick),
      timeout_da_tentativa_ms: config.timeoutTentativaMs,
      recuperados: relatorio.recuperados.length,
      eventos_fechados: relatorio.eventosFechados,
      motivo_de_parada: relatorio.motivoDeParada,
      duracao_ms: relatorio.duracaoMs,
      // false = migration 019 não aplicada: a saúde do agendador fica apenas
      // DERIVADA, e o painel declara isso em vez de inventar um horário.
      heartbeat_registrado: relatorio.heartbeatRegistrado,
      // Detalhe por job: o que o log da Vercel perdia quando a função morria.
      // A fonte de verdade continua sendo a tabela `jobs`; isto é conveniência.
      jobs: relatorio.jobs.map((j) => ({
        job_id: j.jobId,
        participant_id: j.participantId,
        tentativa: j.tentativa,
        desfecho: j.desfecho,
        gravado: j.gravado,
        descartado: j.descartado,
        status_final: j.statusFinal,
        duracao_ms: j.duracaoMs,
        abortada: j.abortada,
        lease_perdido: j.leasePerdido,
        erro: j.erro,
        codigo: j.codigo,
      })),
    });
  } catch (err) {
    // Um tick que estoura NÃO perde trabalho: o que estava reivindicado tem
    // lease, e o lease vence. Devolver 500 faz o agendador registrar a falha.
    console.error("[jobs/tick] tick estourou", {
      worker,
      erro: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Tick falhou; os jobs em voo serão retomados por lease" },
      { status: 500 }
    );
  }
}

export function GET(req: NextRequest) {
  return acionar(req);
}

export function POST(req: NextRequest) {
  return acionar(req);
}
