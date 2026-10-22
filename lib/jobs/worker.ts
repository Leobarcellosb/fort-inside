// Um TICK do worker: recupera o que ficou para trás, reivindica o que couber no
// teto de concorrência, executa, grava desfecho e fecha o evento quando não
// sobra job.
//
// O tick é a unidade de trabalho que NÃO precisa sobreviver. Se a função for
// cortada no meio, o lease vence, o tick seguinte reivindica e o relatório do
// banco continua contando a verdade. É por isso que o acionamento pode ser
// burro (um cron que chama a rota de novo e de novo) sem que nada se perca.
//
// Pool rolante, não ondas. O lote de hoje processa em ondas de 10 e cada onda
// dura o tempo do MAIS LENTO dela. Aqui cada vaga (slot) reivindica um job
// assim que termina o anterior, então um prognóstico lento não segura os
// outros.

import {
  concluirJob,
  falharJob,
  fecharEventoSeConcluido,
  recuperarExpirados,
  registrarConsumo,
  registrarTickOk,
  reivindicarJobs,
  resumoConsumo,
  verificarOrcamento,
  type ClienteFila,
  type JobRecuperado,
  type KindJob,
  type TotaisDeConsumo,
} from "./fila";
import { executarJob, type RelatorioJob, type Trabalho } from "./executor";
import {
  classificarBloqueioDeExcecao,
  type BloqueioDeOrcamento,
} from "./orcamento-indisponivel";
import type { ConfigFila } from "./config";

/**
 * O worker precisa de uma leitura além das RPCs: QUAIS eventos estão em
 * 'processing'. Sem isso, fechar o evento dependeria de o worker que fez o
 * último job sobreviver para chamar o fechamento -- e é exatamente essa
 * dependência que a fila existe para remover. Com isso, QUALQUER tick fecha
 * QUALQUER evento que já terminou.
 */
export interface ClienteWorker extends ClienteFila {
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: string): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

export type MotivoDeParada =
  /** Nada mais a reivindicar: fila vazia OU teto global ocupado por outro tick. */
  | "nada_reivindicado"
  | "orcamento_de_tempo"
  | "max_jobs_por_tick"
  /** Teto de chamadas ao modelo que este tick podia INICIAR. */
  | "orcamento_de_chamadas"
  /** Recusou-se a processar: não foi possível verificar o consumo. */
  | "bloqueio_de_orcamento";

export interface RelatorioTick {
  worker: string;
  kind: KindJob;
  /** Jobs cujo lease havia vencido e foram retomados (ou encerrados). */
  recuperados: JobRecuperado[];
  jobs: RelatorioJob[];
  reivindicados: number;
  sucesso: number;
  pulados: number;
  falhas: number;
  /** Desfechos recusados pelo fencing: tentativa antiga voltando do limbo. */
  descartados: number;
  /** Eventos que ESTE tick levou de 'processing' para 'completed'. */
  eventosFechados: string[];
  motivoDeParada: MotivoDeParada;
  duracaoMs: number;
  /** Chamadas ao modelo que este tick INICIOU (reservadas antes de reivindicar). */
  chamadasIniciadas: number;
  /** Tentativas cuja chamada externa foi abortada (consumo CORTADO). */
  abortadas: number;
  /** Jobs recusados pelo disjuntor de consumo (não rodaram, não gastaram). */
  recusadosPorOrcamento: number;
  /** Tentativas que CHEGARAM ao provedor neste tick (inclusive abortadas). */
  tentativasExternas: number;
  /** Requisições ao provedor despachadas neste tick. */
  requisicoesAoProvedor: number;
  /**
   * Preenchido quando o tick se RECUSOU a processar por não conseguir verificar
   * o consumo. Falha FECHADA: sem teto verificável, não se gasta.
   *
   * Não é `null` discreto: é a causa NOMEADA, com o que a operação deve fazer.
   * Uma fila que só para de andar é indistinguível de fila vazia.
   */
  bloqueioDeOrcamento: BloqueioDeOrcamento | null;
  /**
   * true = `jobs_registrar_tick_ok` (migration 019) gravou o marcador. false
   * quando a 019 não está aplicada -- e nesse caso o painel de saúde declara
   * que só tem sinal DERIVADO, em vez de inventar um horário.
   */
  heartbeatRegistrado: boolean;
}

export interface OpcoesTick {
  kind: KindJob;
  worker: string;
  trabalho: Trabalho;
  config: ConfigFila;
  agora?: () => number;
  /**
   * Reconhece a URL do provedor que custa dinheiro. O padrão (Anthropic) serve
   * à produção; as provas apontam para um servidor local, porque é proibido
   * gastar token de verdade aqui.
   */
  ehProvedor?: (url: string) => boolean;
}

async function eventosEmProcessamento(cliente: ClienteWorker): Promise<string[]> {
  const { data, error } = await cliente.from("events").select("id").eq("status", "processing");
  if (error) {
    // Não é fatal: o trabalho já foi gravado. O fechamento do evento é
    // retentado em todo tick seguinte, de qualquer worker.
    console.error("[jobs] não consegui listar eventos em processamento", { error });
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .map((l) => (l as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
}

export async function rodarTick(
  cliente: ClienteWorker,
  opcoes: OpcoesTick
): Promise<RelatorioTick> {
  const { kind, worker, trabalho, config } = opcoes;
  const agora = opcoes.agora ?? (() => Date.now());
  const inicio = agora();

  // 1. Primeiro a recuperação. Um job com lease vencido não é candidato a nada
  //    enquanto continuar 'running' com attempts no teto: devolvê-lo para
  //    'pending' (ou encerrá-lo como 'failed' quando não há mais tentativa) é o
  //    que impede o estado "preso para sempre".
  const recuperados = await recuperarExpirados(cliente, {
    kind,
    limite: config.maxRecuperarPorTick,
  });
  if (recuperados.length > 0) {
    console.warn("[jobs] retomei jobs com lease vencido", {
      worker,
      total: recuperados.length,
      reagendados: recuperados.filter((r) => r.novoStatus === "pending").length,
      encerrados: recuperados.filter((r) => r.novoStatus === "failed").length,
    });
  }

  // =========================================================================
  // PORTÃO DE ORÇAMENTO, ANTES DE REIVINDICAR QUALQUER COISA
  // =========================================================================
  // Falha FECHADA: sem teto verificável, não se gasta. A sonda vem ANTES da
  // reivindicação de propósito -- reivindicar já incrementa `attempts`, e um
  // ambiente sem a 021 queimaria as 3 tentativas de todos os jobs sem ter
  // chamado o provedor uma vez, transformando "falta migration" em "todos os
  // participantes falharam". Sondando antes, um tick bloqueado custa UMA
  // consulta e não deixa marca em job nenhum.
  const disjuntorLigado =
    config.orcamentoTentativasPorEvento > 0 || config.orcamentoTentativasPorParticipante > 0;

  if (disjuntorLigado) {
    try {
      // `jobs_consumo_resumo` é `stable` e devolve zeros para um evento que não
      // existe: é a sonda mais barata possível de "a medição existe e responde".
      await resumoConsumo(cliente, {
        eventId: "00000000-0000-0000-0000-000000000000",
        kind,
      });
    } catch (err) {
      const bloqueio = classificarBloqueioDeExcecao(err);
      console.error(
        "[jobs] TICK BLOQUEADO: não consegui verificar o consumo de IA. " +
          "Nada foi reivindicado e nada foi gasto.",
        {
          worker,
          kind,
          codigo: bloqueio.codigo,
          detalhe: bloqueio.detalhe,
          o_que_fazer: bloqueio.mensagemParaOperacao,
        }
      );
      // Sai sem reivindicar, sem executar e SEM registrar tick ok: um tick que
      // se recusou a trabalhar não é prova de agendador saudável.
      return {
        worker,
        kind,
        recuperados: [],
        jobs: [],
        reivindicados: 0,
        sucesso: 0,
        pulados: 0,
        falhas: 0,
        descartados: 0,
        abortadas: 0,
        recusadosPorOrcamento: 0,
        tentativasExternas: 0,
        requisicoesAoProvedor: 0,
        chamadasIniciadas: 0,
        eventosFechados: [],
        motivoDeParada: "bloqueio_de_orcamento",
        duracaoMs: agora() - inicio,
        heartbeatRegistrado: false,
        bloqueioDeOrcamento: bloqueio,
      };
    }
  }

  const jobs: RelatorioJob[] = [];
  let motivoDeParada: MotivoDeParada = "nada_reivindicado";
  let paradaGlobal = false;
  let recusadosPorOrcamento = 0;
  let consumoRegistrado = 0;
  let tentativasExternas = 0;
  let bloqueioDeOrcamento: BloqueioDeOrcamento | null = null;
  let ultimoTotalDoEvento: TotaisDeConsumo | null = null;

  const orcamentoEsgotado = () => agora() - inicio >= config.orcamentoTickMs;

  // Teto DURO de chamadas iniciadas neste tick. É reservado ANTES de
  // reivindicar, e devolvido se nada foi reivindicado -- diferente de contar
  // depois, que deixava as `concorrencia` vagas passarem juntas pelo teto
  // (`maxJobsPorTick` era mole por isso). Como toda tentativa de 'prognostico'
  // chama o modelo, este contador é o teto de consumo do tick.
  const tetoDeInicios = Math.min(config.maxJobsPorTick, config.orcamentoChamadasPorTick);
  const motivoDoTeto: MotivoDeParada =
    config.orcamentoChamadasPorTick < config.maxJobsPorTick
      ? "orcamento_de_chamadas"
      : "max_jobs_por_tick";
  let inicios = 0;

  // 2. Pool rolante: `concorrencia` vagas, cada uma reivindicando de uma em uma.
  //    O teto é contado no BANCO (p_concorrencia_max), então dois ticks
  //    sobrepostos somam para o mesmo teto em vez de multiplicá-lo.
  const vaga = async (): Promise<void> => {
    for (;;) {
      if (paradaGlobal) return;
      if (orcamentoEsgotado()) {
        motivoDeParada = "orcamento_de_tempo";
        paradaGlobal = true;
        return;
      }
      // RESERVA antes de reivindicar: nenhuma vaga chega ao modelo sem caber no
      // teto. Sem isso, as `concorrencia` vagas passam juntas pela checagem.
      if (inicios >= tetoDeInicios) {
        motivoDeParada = motivoDoTeto;
        paradaGlobal = true;
        return;
      }
      inicios++;

      const reivindicados = await reivindicarJobs(cliente, {
        kind,
        worker,
        leaseSegundos: config.leaseSegundos,
        limite: 1,
        concorrenciaMax: config.concorrencia,
      });

      const job = reivindicados[0];
      if (!job) {
        inicios--; // não reivindicou nada: devolve a reserva
        return; // fila vazia ou teto global ocupado: esta vaga encerra
      }

      // ---------------------------------------------------------------------
      // DISJUNTOR DE CONSUMO (migration 021), antes de gastar.
      // ---------------------------------------------------------------------
      // Conta TENTATIVAS QUE CHEGARAM AO PROVEDOR, do livro-razão append-only
      // -- não `jobs.attempts`, que conta reivindicações e é ZERADO por
      // `jobs_reenfileirar(p_forcar)`. É isso que faz o teto por participante
      // sobreviver ao reprocessamento forçado em vez de ser decorativo.
      if (
        config.orcamentoTentativasPorEvento > 0 ||
        config.orcamentoTentativasPorParticipante > 0
      ) {
        try {
          const veredito = await verificarOrcamento(cliente, {
            kind,
            eventId: job.eventId,
            participantId: job.participantId,
            tetoEventoPadrao: config.orcamentoTentativasPorEvento,
            tetoParticipantePadrao: config.orcamentoTentativasPorParticipante,
          });

          if (!veredito.permitido) {
            // 'canceled': não foi o trabalho que falhou, foi a decisão de não
            // fazer. Terminal, visível, e SEM chamar o modelo.
            const motivo = `${veredito.motivo}. Nenhuma chamada ao provedor foi feita.`;
            const gravado = await concluirJob(cliente, {
              id: job.id,
              runToken: job.runToken,
              status: "canceled",
              resultado: {
                recusado_por_orcamento: true,
                motivo,
                teto_evento: veredito.tetoEvento,
                teto_participante: veredito.tetoParticipante,
                tentativas_evento: veredito.tentativasEvento,
                tentativas_participante: veredito.tentativasParticipante,
                teto_persistido: veredito.tetoPersistido,
              },
            });
            recusadosPorOrcamento++;
            inicios--; // não houve chamada ao provedor: a reserva volta
            console.warn("[jobs] job recusado pelo disjuntor de consumo", {
              job_id: job.id,
              event_id: job.eventId,
              participant_id: job.participantId,
              motivo: veredito.motivo,
              teto_evento: veredito.tetoEvento,
              teto_participante: veredito.tetoParticipante,
              teto_persistido: veredito.tetoPersistido,
              gravado,
            });
            continue;
          }
        } catch (err) {
          // A sonda do início passou, mas a verificação DESTE job falhou (falha
          // que apareceu no meio do tick). Fecha igual: NÃO executa, devolve o
          // job à fila com a causa gravada, e para de reivindicar.
          //
          // A tentativa já foi consumida pela reivindicação e não há como
          // devolvê-la (a 018 não tem função de "desreivindicar"); por isso a
          // sonda do início existe -- ela faz este caminho ser a exceção, não a
          // regra. O backoff dá tempo de a causa ser resolvida.
          bloqueioDeOrcamento = classificarBloqueioDeExcecao(err);
          const r = await falharJob(cliente, {
            id: job.id,
            runToken: job.runToken,
            erro: `${bloqueioDeOrcamento.erro}: ${bloqueioDeOrcamento.detalhe ?? "sem detalhe"}`,
            codigo: bloqueioDeOrcamento.codigo,
            backoffSegundos: Math.max(config.backoffSegundos, 30),
          });
          inicios--; // não houve chamada ao provedor
          paradaGlobal = true;
          motivoDeParada = "bloqueio_de_orcamento";
          console.error(
            "[jobs] TICK BLOQUEADO no meio: não consegui verificar o consumo deste job. " +
              "Nada foi gasto; o job volta à fila.",
            {
              job_id: job.id,
              codigo: bloqueioDeOrcamento.codigo,
              detalhe: bloqueioDeOrcamento.detalhe,
              job_voltou_para: r.status,
              o_que_fazer: bloqueioDeOrcamento.mensagemParaOperacao,
            }
          );
          continue;
        }
      }

      const relatorio = await executarJob(cliente, job, trabalho, {
        leaseSegundos: config.leaseSegundos,
        renovarCadaMs: config.renovarCadaMs,
        backoffSegundos: config.backoffSegundos,
        timeoutTentativaMs: config.timeoutTentativaMs,
        ehProvedor: opcoes.ehProvedor,
        agora,
      });
      jobs.push(relatorio);

      // Lançamento no livro-razão, o mais cedo possível depois da tentativa:
      // a janela entre o despacho ao provedor e este INSERT é a única em que
      // consumo real pode deixar de ser contabilizado (limitação 1 da 021).
      //
      // Registra SEMPRE, inclusive com `chamadas = 0`: a linha de zero serve à
      // medição ("existiu uma tentativa que não abriu conexão") e não conta no
      // teto, porque o teto soma só linhas com chamadas > 0.
      try {
        const totais = await registrarConsumo(cliente, {
          kind,
          eventId: job.eventId,
          participantId: job.participantId,
          chamadas: relatorio.chamadasAoProvedor,
          abortada: relatorio.abortada,
          motivo: relatorio.codigo ?? relatorio.desfecho,
          jobId: job.id,
          runToken: job.runToken,
        });
        consumoRegistrado += relatorio.chamadasAoProvedor;
        if (relatorio.chamadasAoProvedor > 0) tentativasExternas++;
        ultimoTotalDoEvento = totais;
      } catch (err) {
        // Aqui o gasto JÁ ACONTECEU: o desfecho do job foi gravado e jogar o
        // trabalho fora não devolveria o dinheiro. O que se fecha é o FUTURO --
        // para de reivindicar, porque não se inicia gasto novo sem conseguir
        // contabilizar o anterior.
        bloqueioDeOrcamento = classificarBloqueioDeExcecao(err);
        paradaGlobal = true;
        motivoDeParada = "bloqueio_de_orcamento";
        console.error(
          "[jobs] TICK BLOQUEADO: não consegui lançar o consumo no livro-razão. " +
            "Este gasto FICOU FORA do teto e nenhum job novo será iniciado.",
          {
            job_id: job.id,
            chamadas_ao_provedor: relatorio.chamadasAoProvedor,
            codigo: bloqueioDeOrcamento.codigo,
            detalhe: bloqueioDeOrcamento.detalhe,
            o_que_fazer: bloqueioDeOrcamento.mensagemParaOperacao,
          }
        );
      }
    }
  };

  await Promise.all(Array.from({ length: config.concorrencia }, () => vaga()));

  // 3. Fechamento do evento. Independe de quem fez o último job: o tick varre
  //    os eventos em 'processing' e deixa o banco decidir quais já acabaram.
  const eventosFechados: string[] = [];
  for (const eventId of await eventosEmProcessamento(cliente)) {
    try {
      if (await fecharEventoSeConcluido(cliente, { eventId, kind })) {
        eventosFechados.push(eventId);
      }
    } catch (err) {
      console.error("[jobs] falha ao tentar fechar evento", {
        event_id: eventId,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const relatorio: RelatorioTick = {
    worker,
    kind,
    recuperados,
    jobs,
    reivindicados: jobs.length,
    sucesso: jobs.filter((j) => j.desfecho === "succeeded" && j.gravado).length,
    pulados: jobs.filter((j) => j.desfecho === "skipped" && j.gravado).length,
    falhas: jobs.filter((j) => j.desfecho === "failed" && j.gravado).length,
    descartados: jobs.filter((j) => j.descartado).length,
    abortadas: jobs.filter((j) => j.abortada).length,
    recusadosPorOrcamento,
    tentativasExternas,
    requisicoesAoProvedor: consumoRegistrado,
    bloqueioDeOrcamento,
    chamadasIniciadas: jobs.length,
    eventosFechados,
    motivoDeParada,
    duracaoMs: agora() - inicio,
    heartbeatRegistrado: false,
  };

  console.info("[jobs] tick concluído", {
    worker,
    kind,
    reivindicados: relatorio.reivindicados,
    sucesso: relatorio.sucesso,
    pulados: relatorio.pulados,
    falhas: relatorio.falhas,
    descartados: relatorio.descartados,
    abortadas: relatorio.abortadas,
    recusados_por_orcamento: relatorio.recusadosPorOrcamento,
    tentativas_externas: relatorio.tentativasExternas,
    requisicoes_ao_provedor: relatorio.requisicoesAoProvedor,
    consumo_do_evento: ultimoTotalDoEvento,
    bloqueio_de_orcamento: relatorio.bloqueioDeOrcamento?.codigo ?? null,
    recuperados: recuperados.length,
    eventos_fechados: eventosFechados,
    motivo_de_parada: relatorio.motivoDeParada,
    duracao_ms: relatorio.duracaoMs,
  });

  // =========================================================================
  // ÚLTIMA LINHA DO TICK -- e é nisso que está toda a diferença entre "a rota
  // foi chamada" e "o tick teve sucesso" (migration 019).
  // =========================================================================
  // Qualquer exceção acima -- na recuperação, na reivindicação, na execução, no
  // fechamento do evento -- impede esta gravação, e o marcador continua
  // apontando para o último tick que de fato terminou inteiro.
  //
  // Best-effort DE PROPÓSITO: a 019 pode não estar aplicada, e um marcador de
  // saúde ausente não pode derrubar o processamento de prognósticos. Quando
  // falha, `heartbeatRegistrado` fica false e o painel declara que só tem sinal
  // DERIVADO -- nunca um horário inventado.
  try {
    const marca = await registrarTickOk(cliente, {
      kind,
      worker,
      duracaoMs: relatorio.duracaoMs,
      resumo: {
        reivindicados: relatorio.reivindicados,
        sucesso: relatorio.sucesso,
        pulados: relatorio.pulados,
        falhas: relatorio.falhas,
        descartados: relatorio.descartados,
        abortadas: relatorio.abortadas,
        tentativas_externas: relatorio.tentativasExternas,
        requisicoes_ao_provedor: relatorio.requisicoesAoProvedor,
        recuperados: recuperados.length,
        motivo_de_parada: relatorio.motivoDeParada,
      },
    });
    relatorio.heartbeatRegistrado = true;
    console.info("[jobs] tick ok registrado", {
      worker,
      ultimo_tick_ok_em: marca.ultimoTickOkEm,
      ticks_ok: marca.ticksOk,
    });
  } catch (err) {
    console.warn(
      "[jobs] não consegui registrar o tick ok (migration 019 aplicada?); a saúde do agendador fica DERIVADA",
      { worker, erro: err instanceof Error ? err.message : String(err) }
    );
  }

  return relatorio;
}
