// Executa UM job reivindicado: mantém o lease vivo enquanto o trabalho roda,
// grava o desfecho sob o token de execução e relata honestamente quando o
// resultado foi DESCARTADO pelo fencing.
//
// O trabalho em si é injetado. Isso não é só gosto de teste: é o que permite
// provar a fila (reivindicação, lease, fencing, recuperação) sem gastar um
// centavo de crédito de IA. O adaptador real está em `trabalho-prognostico.ts`.

import {
  ehErroDeAborto,
  ehProvedorPadrao,
  executarComAborto,
  novaMedicao,
  type MedicaoDeChamadas,
} from "./aborto";
import {
  concluirJob,
  falharJob,
  renovarLease,
  type ClienteFila,
  type DesfechoConclusivo,
  type JobReivindicado,
  type JsonValor,
  type StatusJob,
} from "./fila";

/**
 * Sinal de "você ainda é o dono deste job". Vira false quando uma renovação de
 * lease é RECUSADA pelo banco (outro worker reivindicou, ou o job foi
 * cancelado). Um trabalho caro deve consultá-lo entre etapas e desistir cedo:
 * continuar depois disso é gastar modelo para um resultado que o banco vai
 * recusar.
 */
export interface SinalDeLease {
  readonly perdido: boolean;
  /**
   * AbortSignal da tentativa. Aborta quando o lease é perdido ou quando o
   * timeout da tentativa estoura.
   *
   * Dentro de `executarJob` ele JÁ está amarrado a todo `fetch` feito pela
   * tentativa (ver `aborto.ts`), então a chamada ao modelo morre sozinha. Este
   * campo existe para um trabalho que queira abortar algo que não passe por
   * fetch, ou checar antes de começar.
   */
  readonly signal: AbortSignal;
}

export type ResultadoTrabalho =
  | { desfecho: "succeeded"; resultado?: JsonValor; aiUsage?: JsonValor }
  // 'skipped' NÃO é falha. É o 409 de generatePrognostic: o documento avançou
  // de estado e regerar foi recusado de propósito (migration 015). Contar como
  // falha inflaria o número em todo reprocessamento e esconderia falha real.
  | { desfecho: "skipped"; motivo: string }
  | { desfecho: "failed"; erro: string; codigo?: string };

export type Trabalho = (
  job: JobReivindicado,
  sinal: SinalDeLease
) => Promise<ResultadoTrabalho>;

export interface RelatorioJob {
  jobId: string;
  participantId: string;
  eventId: string;
  /** Número da tentativa (a 018 incrementa na reivindicação). */
  tentativa: number;
  desfecho: ResultadoTrabalho["desfecho"];
  /** true = o banco aceitou o desfecho desta tentativa. */
  gravado: boolean;
  /**
   * true = o UPDATE não casou nenhuma linha porque o run_token já não é o
   * vigente. O resultado desta tentativa foi descartado DE PROPÓSITO.
   */
  descartado: boolean;
  /** Status do job depois da gravação, quando o banco informa. */
  statusFinal: StatusJob | null;
  duracaoMs: number;
  /** true = alguma renovação de lease foi recusada durante o trabalho. */
  leasePerdido: boolean;
  /**
   * true = a chamada externa desta tentativa foi ABORTADA (por perda de lease
   * ou por timeout). É o indicador de consumo CORTADO, distinto de
   * `descartado`, que é consumo gasto e resultado recusado.
   */
  abortada: boolean;
  /**
   * Requisições ao provedor que esta tentativa DESPACHOU. É a unidade de
   * cobrança: > 0 significa que chegou ao provedor (ainda que abortada depois)
   * e portanto conta no orçamento. 0 significa que não abriu conexão.
   */
  chamadasAoProvedor: number;
  /** Requisições ao provedor recusadas antes de abrir (tentativa já abortada). */
  chamadasRecusadasAntesDeAbrir: number;
  erro?: string;
  codigo?: string;
}

export interface OpcoesExecucao {
  leaseSegundos: number;
  renovarCadaMs: number;
  backoffSegundos: number;
  /**
   * Teto de UMA tentativa. Ao estourar, a chamada externa é ABORTADA (não
   * apenas deixada de esperar) e a tentativa vira falha com código
   * `timeout_da_tentativa`. 0 ou ausente desliga o teto.
   */
  timeoutTentativaMs?: number;
  /** Relógio injetável só para o cálculo de duração do relatório. */
  agora?: () => number;
  /**
   * Decide se uma URL é do PROVEDOR que custa dinheiro. O padrão reconhece a
   * Anthropic; a prova com servidor local sobrescreve.
   */
  ehProvedor?: (url: string) => boolean;
}

export async function executarJob(
  cliente: ClienteFila,
  job: JobReivindicado,
  trabalho: Trabalho,
  opcoes: OpcoesExecucao
): Promise<RelatorioJob> {
  const agora = opcoes.agora ?? (() => Date.now());
  const inicio = agora();

  let perdido = false;
  let encerrado = false;
  let estourouTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerTimeout: ReturnType<typeof setTimeout> | undefined;

  // O controlador da tentativa. Abortar aqui fecha a CONEXÃO da chamada ao
  // modelo -- é o que corta o consumo de tokens, coisa que o fencing não faz
  // (ele só recusa o resultado depois de a Anthropic já ter cobrado).
  const controlador = new AbortController();

  const sinal: SinalDeLease = {
    get perdido() {
      return perdido;
    },
    signal: controlador.signal,
  };

  // Medição do que esta tentativa manda para fora. Mutável de propósito: o
  // invólucro de fetch escreve aqui durante a execução e lemos no fim.
  const medicao: MedicaoDeChamadas = novaMedicao();

  const pulsar = async (): Promise<void> => {
    if (encerrado) return;
    try {
      const vivo = await renovarLease(cliente, {
        id: job.id,
        runToken: job.runToken,
        leaseSegundos: opcoes.leaseSegundos,
      });
      if (!vivo) {
        // Recusa do BANCO é informação definitiva: o job não é mais meu.
        // Daqui para frente, cada token gasto é token jogado fora -- o
        // resultado vai ser recusado pelo fencing. Então ABORTA a chamada, em
        // vez de só acender uma flag e esperar que alguém a consulte.
        perdido = true;
        controlador.abort(
          new DOMException(
            `lease perdido: o job ${job.id} foi reivindicado por outro worker`,
            "AbortError"
          )
        );
        console.warn("[jobs] lease perdido durante a execução; chamada externa abortada", {
          job_id: job.id,
          participant_id: job.participantId,
          tentativa: job.attempts,
        });
        return; // não reagenda: não há nada a renovar
      }
    } catch (err) {
      // Falha de REDE no heartbeat não prova que o lease venceu. Marcar
      // 'perdido' aqui abortaria trabalho bom por causa de um soluço de
      // conexão. Loga, e tenta de novo no próximo intervalo; se o lease
      // realmente venceu, o fencing recusa a gravação no fim e o relatório
      // mostra 'descartado'.
      console.error("[jobs] renovação de lease falhou (vou tentar de novo)", {
        job_id: job.id,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
    if (!encerrado) timer = setTimeout(pulsar, opcoes.renovarCadaMs);
  };

  if (opcoes.renovarCadaMs > 0) {
    timer = setTimeout(pulsar, opcoes.renovarCadaMs);
  }

  // Teto da tentativa. Vence ANTES do horizonte seguro do lease (a config
  // garante isso), então o caso "lease venceu com a chamada viva" deixa de
  // acontecer por tempo de execução.
  if (opcoes.timeoutTentativaMs && opcoes.timeoutTentativaMs > 0) {
    timerTimeout = setTimeout(() => {
      estourouTimeout = true;
      controlador.abort(
        new DOMException(
          `tentativa excedeu ${opcoes.timeoutTentativaMs}ms e foi abortada`,
          "AbortError"
        )
      );
    }, opcoes.timeoutTentativaMs);
  }

  let resultado: ResultadoTrabalho;
  try {
    // Promessa que NUNCA rejeita: o erro vira dado, para poder ser corrido
    // contra o aborto sem risco de rejeição não tratada.
    const doTrabalho = executarComAborto(
      controlador.signal,
      `${job.id} (tentativa ${job.attempts})`,
      () => trabalho(job, sinal),
      medicao,
      opcoes.ehProvedor ?? ehProvedorPadrao
    ).then(
      (r) => ({ tipo: "pronto" as const, r }),
      (e: unknown) => ({ tipo: "erro" as const, e })
    );

    // Corrida contra o aborto: um trabalho que IGNORE o signal não pode
    // prender o executor até o fim da chamada. Se o aborto vence, o desfecho é
    // decidido agora; a conexão já está fechada e o que sobrar da promessa é
    // descartado sem rejeição pendente (ela nunca rejeita, por construção).
    const doAborto = new Promise<{ tipo: "abortado" }>((resolve) => {
      if (controlador.signal.aborted) resolve({ tipo: "abortado" });
      else
        controlador.signal.addEventListener("abort", () => resolve({ tipo: "abortado" }), {
          once: true,
        });
    });

    const vencedor = await Promise.race([doTrabalho, doAborto]);

    if (vencedor.tipo === "abortado") {
      resultado = estourouTimeout
        ? {
            desfecho: "failed",
            erro: `tentativa abortada por timeout de ${opcoes.timeoutTentativaMs}ms; a chamada externa foi encerrada`,
            codigo: "timeout_da_tentativa",
          }
        : {
            desfecho: "failed",
            erro: "tentativa abortada por perda do lease; a chamada externa foi encerrada",
            codigo: "lease_perdido_abortado",
          };
    } else if (vencedor.tipo === "erro") {
      const err = vencedor.e;
      // Aborto que chega como exceção do próprio trabalho (o caminho normal
      // quando o fetch é cancelado) é classificado pela CAUSA, não como
      // "exceção genérica": o motivo importa para quem lê o rastro.
      if (ehErroDeAborto(err) && (estourouTimeout || perdido)) {
        resultado = estourouTimeout
          ? {
              desfecho: "failed",
              erro: `tentativa abortada por timeout de ${opcoes.timeoutTentativaMs}ms; a chamada externa foi encerrada`,
              codigo: "timeout_da_tentativa",
            }
          : {
              desfecho: "failed",
              erro: "tentativa abortada por perda do lease; a chamada externa foi encerrada",
              codigo: "lease_perdido_abortado",
            };
      } else {
        // Exceção não tratada do trabalho é FALHA, não desaparecimento. Virar
        // falha registrada é a diferença entre "o participante X falhou por
        // isto" e o log que morre com a função.
        resultado = {
          desfecho: "failed",
          erro: err instanceof Error ? err.message : String(err),
          codigo: "excecao",
        };
      }
    } else {
      resultado = vencedor.r;
    }
  } finally {
    encerrado = true;
    if (timer) clearTimeout(timer);
    if (timerTimeout) clearTimeout(timerTimeout);
  }

  const duracaoMs = agora() - inicio;

  const base = {
    jobId: job.id,
    participantId: job.participantId,
    eventId: job.eventId,
    tentativa: job.attempts,
    duracaoMs,
    leasePerdido: perdido,
    abortada: controlador.signal.aborted,
    chamadasAoProvedor: medicao.aoProvedor,
    chamadasRecusadasAntesDeAbrir: medicao.recusadasAntesDeAbrir,
  };

  try {
    if (resultado.desfecho === "failed") {
      const r = await falharJob(cliente, {
        id: job.id,
        runToken: job.runToken,
        erro: resultado.erro,
        codigo: resultado.codigo ?? null,
        backoffSegundos: opcoes.backoffSegundos,
      });
      if (!r.aplicado) {
        console.warn("[jobs] falha DESCARTADA pelo fencing (token já não é o vigente)", {
          job_id: job.id,
          participant_id: job.participantId,
          tentativa: job.attempts,
        });
      }
      return {
        ...base,
        desfecho: "failed",
        gravado: r.aplicado,
        descartado: !r.aplicado,
        statusFinal: r.status,
        erro: resultado.erro,
        codigo: resultado.codigo,
      };
    }

    const status: DesfechoConclusivo =
      resultado.desfecho === "succeeded" ? "succeeded" : "skipped";

    const gravado = await concluirJob(cliente, {
      id: job.id,
      runToken: job.runToken,
      status,
      resultado:
        resultado.desfecho === "succeeded"
          ? (resultado.resultado ?? null)
          : { motivo: resultado.motivo },
      aiUsage: resultado.desfecho === "succeeded" ? (resultado.aiUsage ?? null) : null,
    });

    if (!gravado) {
      // ESTE é o caso central do fencing: a tentativa antiga voltou do limbo
      // com um resultado e o banco recusou, preservando o da tentativa nova.
      console.warn("[jobs] desfecho DESCARTADO pelo fencing (token já não é o vigente)", {
        job_id: job.id,
        participant_id: job.participantId,
        tentativa: job.attempts,
        desfecho: resultado.desfecho,
      });
    }

    return {
      ...base,
      desfecho: resultado.desfecho,
      gravado,
      descartado: !gravado,
      statusFinal: gravado ? status : null,
    };
  } catch (err) {
    // A gravação do desfecho falhou. A tentativa fica sem desfecho e o LEASE é
    // quem recupera: vence, outro worker reivindica. É o preço da entrega "ao
    // menos uma vez" -- e fica registrado no relatório do tick em vez de
    // sumir.
    const mensagem = err instanceof Error ? err.message : String(err);
    console.error("[jobs] não consegui gravar o desfecho; o lease vai recuperar", {
      job_id: job.id,
      participant_id: job.participantId,
      desfecho_pretendido: resultado.desfecho,
      erro: mensagem,
    });
    return {
      ...base,
      desfecho: resultado.desfecho,
      gravado: false,
      descartado: false,
      statusFinal: null,
      erro: mensagem,
      codigo: "gravacao_do_desfecho",
    };
  }
}
