import { describe, expect, it, vi } from "vitest";
import { criarClienteDeFilaFalso, type Manipulador } from "./cliente-falso";
import { rodarTick, type ClienteWorker } from "./worker";
import type { ConfigFila } from "./config";
import type { Trabalho } from "./executor";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = (over: Partial<ConfigFila> = {}): ConfigFila => ({
  concorrencia: 3,
  leaseSegundos: 60,
  renovarCadaMs: 0,
  backoffSegundos: 30,
  orcamentoTickMs: 60_000,
  maxJobsPorTick: 100,
  maxRecuperarPorTick: 100,
  alertaSemProgressoSegundos: 180,
  janelaFalhasHoras: 24,
  timeoutTentativaMs: 120_000,
  orcamentoChamadasPorTick: 200,
  orcamentoTentativasPorEvento: 0,
  orcamentoTentativasPorParticipante: 0,
  intervaloDoAgendadorSegundos: 60,
  ...over,
});

/**
 * Fila falsa que entrega jobs de um em um até acabar. Não imita o teto de
 * concorrência do banco de propósito: assim, se o POOL do worker estivesse
 * errado, ele reivindicaria mais que a concorrência e o teste veria.
 */
function filaCom(quantidade: number, extras: Record<string, Manipulador> = {}) {
  let proximo = 0;
  return criarClienteDeFilaFalso(
    {
      jobs_recuperar_expirados: () => ({ data: [], error: null }),
      jobs_concluir: () => ({ data: true, error: null }),
      jobs_falhar: () => ({
        data: [{ aplicado: true, status: "pending", attempts: 1 }],
        error: null,
      }),
      jobs_renovar_lease: () => ({ data: true, error: null }),
      jobs_fechar_evento_se_concluido: () => ({ data: false, error: null }),
      jobs_registrar_tick_ok: () => ({
        data: [{ ultimo_tick_ok_em: new Date().toISOString(), ticks_ok: 1 }],
        error: null,
      }),
      jobs_orcamento_verificar: () => ({
        data: [
          {
            permitido: true,
            motivo: "dentro do orçamento",
            teto_evento: 100,
            teto_participante: 3,
            tentativas_evento: 0,
            tentativas_participante: 0,
            requisicoes_evento: 0,
            teto_persistido: false,
          },
        ],
        error: null,
      }),
      jobs_consumo_registrar: () => ({
        data: [{ tentativas_evento: 1, tentativas_participante: 1, requisicoes_evento: 1 }],
        error: null,
      }),
      jobs_consumo_resumo: () => ({
        data: [
          {
            tentativas_externas: 0,
            tentativas_abortadas: 0,
            tentativas_sem_conexao: 0,
            requisicoes_despachadas: 0,
            participantes_tocados: 0,
            participantes_no_teto: 0,
          },
        ],
        error: null,
      }),
      jobs_reivindicar: () => {
        if (proximo >= quantidade) return { data: [], error: null };
        const i = proximo++;
        return {
          data: [
            {
              id: `job-${i}`,
              participant_id: `p-${i}`,
              event_id: "e-1",
              run_token: `tok-${i}`,
              attempts: 1,
              max_attempts: 3,
              lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
          error: null,
        };
      },
      ...extras,
    },
    { events: [{ id: "e-1", status: "processing" }] }
  ) as unknown as ClienteWorker & { ordem: string[]; chamadas: { funcao: string; args: Record<string, unknown> }[] };
}

const sucesso: Trabalho = async () => ({ desfecho: "succeeded" });

describe("worker: um tick", () => {
  it("recupera lease vencido ANTES de reivindicar", async () => {
    // Ordem importa: um job 'running' com lease vencido e tentativas no teto
    // ficaria preso para sempre se a recuperação não rodasse primeiro.
    const c = filaCom(1);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 1 }),
    });

    expect(c.ordem[0]).toBe("jobs_recuperar_expirados");
    expect(c.ordem.indexOf("jobs_recuperar_expirados")).toBeLessThan(
      c.ordem.indexOf("jobs_reivindicar")
    );
    expect(rel.sucesso).toBe(1);
    expect(c.chamadas[0].args).toEqual({ p_kind: "prognostico", p_limit: 100 });
  });

  it("relata os jobs recuperados, separando reagendados de encerrados", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = filaCom(0, {
      jobs_recuperar_expirados: () => ({
        data: [
          { id: "j1", novo_status: "pending", attempts: 1 },
          { id: "j2", novo_status: "failed", attempts: 3 },
        ],
        error: null,
      }),
    });
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config(),
    });
    expect(rel.recuperados).toHaveLength(2);
    expect(rel.recuperados.filter((r) => r.novoStatus === "failed")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("pool rolante: nunca passa da concorrência, e um job lento NÃO segura os outros", async () => {
    const c = filaCom(12);
    let emVoo = 0;
    let maximoEmVoo = 0;
    let terminadosEnquantoOLentoRodava = 0;
    let lentoRodando = false;

    const trabalho: Trabalho = async (job) => {
      emVoo++;
      maximoEmVoo = Math.max(maximoEmVoo, emVoo);
      const lento = job.id === "job-0";
      if (lento) lentoRodando = true;
      await dormir(lento ? 220 : 10);
      if (lento) lentoRodando = false;
      else if (lentoRodando) terminadosEnquantoOLentoRodava++;
      emVoo--;
      return { desfecho: "succeeded" };
    };

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho,
      config: config({ concorrencia: 3 }),
    });

    expect(maximoEmVoo).toBe(3);
    expect(rel.reivindicados).toBe(12);
    expect(rel.sucesso).toBe(12);
    // É isto que diferencia pool rolante de ondas: com ondas de 3, só 2 jobs
    // teriam terminado durante o lento (os da mesma onda).
    expect(terminadosEnquantoOLentoRodava).toBeGreaterThan(2);
  });

  it("o teto de jobs por tick é DURO: reservado antes de reivindicar", async () => {
    // Antes era mole: as `concorrencia` vagas passavam juntas pela checagem e o
    // tick podia estourar o teto em até concorrencia-1. Como toda tentativa de
    // 'prognostico' chama o modelo, um teto mole é um teto de CUSTO mole.
    const c = filaCom(50);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 3, maxJobsPorTick: 7 }),
    });
    expect(rel.reivindicados).toBe(7);
    expect(rel.chamadasIniciadas).toBe(7);
    expect(rel.motivoDeParada).toBe("max_jobs_por_tick");
  });

  it("orçamento de chamadas do tick corta antes do teto de jobs, e diz qual limite valeu", async () => {
    const c = filaCom(50);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 3, maxJobsPorTick: 20, orcamentoChamadasPorTick: 4 }),
    });
    expect(rel.chamadasIniciadas).toBe(4);
    expect(rel.motivoDeParada).toBe("orcamento_de_chamadas");
  });

  it("fila vazia não consome orçamento (a reserva é devolvida)", async () => {
    const c = filaCom(2);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 3, orcamentoChamadasPorTick: 5 }),
    });
    expect(rel.chamadasIniciadas).toBe(2);
    expect(rel.motivoDeParada).toBe("nada_reivindicado");
  });

  it("disjuntor recusa o job SEM chamar o provedor, e encerra como canceled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let chamouOTrabalho = 0;
    const c = filaCom(3, {
      jobs_orcamento_verificar: () => ({
        data: [
          {
            permitido: false,
            motivo: "participante já consumiu 3 de 3 tentativa(s) externa(s) permitidas",
            teto_evento: 100,
            teto_participante: 3,
            tentativas_evento: 7,
            tentativas_participante: 3,
            requisicoes_evento: 9,
            teto_persistido: true,
          },
        ],
        error: null,
      }),
    });

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: async () => {
        chamouOTrabalho++;
        return { desfecho: "succeeded" };
      },
      config: config({ concorrencia: 1, orcamentoTentativasPorEvento: 100 }),
    });

    // Nenhuma chamada ao provedor: é isso que o disjuntor existe para impedir.
    expect(chamouOTrabalho).toBe(0);
    expect(rel.recusadosPorOrcamento).toBeGreaterThan(0);
    expect(rel.reivindicados).toBe(0);
    expect(rel.tentativasExternas).toBe(0);
    // Encerrado como 'canceled': terminal e visível, não "falhou".
    const conclusoes = c.chamadas.filter((x) => x.funcao === "jobs_concluir");
    expect(conclusoes.length).toBeGreaterThan(0);
    expect(conclusoes[0].args.p_status).toBe("canceled");
    // O motivo gravado diz o teto e o quanto já foi gasto.
    expect(conclusoes[0].args.p_result).toMatchObject({
      recusado_por_orcamento: true,
      teto_participante: 3,
      tentativas_participante: 3,
    });
    vi.restoreAllMocks();
  });

  it("disjuntor desligado (0 e 0) não consulta o orçamento", async () => {
    const c = filaCom(2);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({
        concorrencia: 1,
        orcamentoTentativasPorEvento: 0,
        orcamentoTentativasPorParticipante: 0,
      }),
    });
    expect(rel.sucesso).toBe(2);
    expect(rel.recusadosPorOrcamento).toBe(0);
    expect(c.ordem).not.toContain("jobs_orcamento_verificar");
  });

  it("021 ausente: FALHA FECHADA -- não reivindica, não gasta, e NOMEIA a causa", async () => {
    // Decisão do CTO, revertendo a minha: sem teto verificável, não se gasta.
    // E a recusa tem de ser ruidosa: uma fila que só para de andar é
    // indistinguível de fila vazia para quem olha o painel.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let chamouOTrabalho = 0;
    const c = filaCom(2, {
      jobs_consumo_resumo: () => ({
        data: null,
        error: { message: "Could not find the function public.jobs_consumo_resumo" },
      }),
    });

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: async () => {
        chamouOTrabalho++;
        return { desfecho: "succeeded" };
      },
      config: config({ concorrencia: 1, orcamentoTentativasPorEvento: 100 }),
    });

    expect(chamouOTrabalho).toBe(0);
    expect(rel.reivindicados).toBe(0);
    expect(rel.tentativasExternas).toBe(0);
    expect(rel.motivoDeParada).toBe("bloqueio_de_orcamento");
    // A causa é NOMEADA, com o que fazer.
    expect(rel.bloqueioDeOrcamento?.codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    expect(rel.bloqueioDeOrcamento?.mensagemParaOperacao).toMatch(/migration 021/);
    expect(rel.bloqueioDeOrcamento?.mensagemParaOperacao).toMatch(/NÃO é fila vazia/);
    // NÃO reivindicou nada: nenhum `attempts` foi queimado por falta de migration.
    expect(c.ordem).not.toContain("jobs_reivindicar");
    // E um tick que se recusou a trabalhar NÃO é prova de agendador saudável.
    expect(rel.heartbeatRegistrado).toBe(false);
    expect(c.ordem).not.toContain("jobs_registrar_tick_ok");
    vi.restoreAllMocks();
  });

  it("021 presente: o fluxo legítimo processa normalmente (controle positivo)", async () => {
    // Sem este controle, a prova acima seria só "não processa nada".
    const c = filaCom(2);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 1, orcamentoTentativasPorEvento: 100 }),
    });
    expect(rel.sucesso).toBe(2);
    expect(rel.bloqueioDeOrcamento).toBeNull();
    expect(rel.motivoDeParada).toBe("nada_reivindicado");
    expect(c.ordem).toContain("jobs_consumo_resumo"); // a sonda rodou
    expect(rel.heartbeatRegistrado).toBe(true);
  });

  it("medição que some NO MEIO do tick: fecha, devolve o job à fila e para", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let chamouOTrabalho = 0;
    const c = filaCom(5, {
      // A sonda passa; a verificação do job falha.
      jobs_orcamento_verificar: () => ({
        data: null,
        error: { message: "could not find the function jobs_orcamento_verificar" },
      }),
    });

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: async () => {
        chamouOTrabalho++;
        return { desfecho: "succeeded" };
      },
      config: config({ concorrencia: 1, orcamentoTentativasPorEvento: 100 }),
    });

    expect(chamouOTrabalho).toBe(0);
    expect(rel.tentativasExternas).toBe(0);
    expect(rel.motivoDeParada).toBe("bloqueio_de_orcamento");
    expect(rel.bloqueioDeOrcamento?.codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    // O job volta à fila com a causa gravada, em vez de ficar preso em running.
    const falhas = c.chamadas.filter((x) => x.funcao === "jobs_falhar");
    expect(falhas).toHaveLength(1);
    expect(falhas[0].args.p_codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    // Parou de reivindicar: só UM job foi tocado, não os cinco.
    expect(c.chamadas.filter((x) => x.funcao === "jobs_reivindicar")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("lança no livro-razão o que a tentativa mandou ao provedor, inclusive zero", async () => {
    const c = filaCom(2);
    await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      // Trabalho simulado não faz fetch: chamadasAoProvedor = 0. A linha de
      // zero é registrada (serve à medição) e não conta no teto.
      trabalho: sucesso,
      config: config({ concorrencia: 1, orcamentoTentativasPorEvento: 100 }),
    });
    const lancamentos = c.chamadas.filter((x) => x.funcao === "jobs_consumo_registrar");
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos[0].args).toMatchObject({ p_chamadas: 0, p_abortada: false });
  });

  it("para quando o orçamento de tempo acaba (não espera o teto da função cortar)", async () => {
    const c = filaCom(50);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: async () => {
        await dormir(30);
        return { desfecho: "succeeded" };
      },
      config: config({ concorrencia: 1, orcamentoTickMs: 60 }),
    });
    expect(rel.motivoDeParada).toBe("orcamento_de_tempo");
    expect(rel.reivindicados).toBeLessThan(50);
  });

  it("fila vazia: tick barato, sem desfecho nenhum", async () => {
    const c = filaCom(0);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config(),
    });
    expect(rel.reivindicados).toBe(0);
    expect(rel.motivoDeParada).toBe("nada_reivindicado");
  });

  it("fecha o evento varrendo os que estão em 'processing', sem depender de quem fez o último job", async () => {
    // A garantia: QUALQUER tick fecha QUALQUER evento concluído. Se dependesse
    // do worker que gravou o último desfecho, a morte dele deixaria o evento
    // preso em 'processing' -- o defeito que originou esta fila.
    const c = filaCom(0, {
      jobs_fechar_evento_se_concluido: () => ({ data: true, error: null }),
    });
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "tick-que-nao-fez-nada",
      trabalho: sucesso,
      config: config(),
    });
    expect(rel.reivindicados).toBe(0);
    expect(rel.eventosFechados).toEqual(["e-1"]);
  });

  it("falha ao listar eventos não derruba o tick (o trabalho já foi gravado)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = filaCom(2);
    const c = {
      ...base,
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: "sem conexão" } }),
        }),
      }),
    } as unknown as ClienteWorker;

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config(),
    });
    expect(rel.sucesso).toBe(2);
    expect(rel.eventosFechados).toEqual([]);
    vi.restoreAllMocks();
  });

  it("registra o tick ok na ÚLTIMA operação, depois de tudo o mais", async () => {
    // É nisso que está a diferença entre "a rota foi chamada" e "o tick teve
    // sucesso": o marcador é a última coisa que acontece.
    const c = filaCom(2);
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 1 }),
    });
    expect(rel.heartbeatRegistrado).toBe(true);
    expect(c.ordem[c.ordem.length - 1]).toBe("jobs_registrar_tick_ok");
    const registro = c.chamadas.find((x) => x.funcao === "jobs_registrar_tick_ok")!;
    expect(registro.args).toMatchObject({ p_kind: "prognostico", p_worker: "w" });
    expect(registro.args.p_resumo).toMatchObject({ reivindicados: 2, sucesso: 2 });
  });

  it("tick que ESTOURA no meio NÃO registra tick ok", async () => {
    // O marcador precisa continuar apontando para o último tick que terminou
    // inteiro; um tick cortado não pode se passar por sinal de saúde.
    const c = filaCom(5, {
      jobs_reivindicar: (() => {
        let n = 0;
        return () =>
          ++n >= 2
            ? { data: null, error: { message: "conexão caiu no meio do tick" } }
            : {
                data: [
                  {
                    id: "job-0",
                    participant_id: "p-0",
                    event_id: "e-1",
                    run_token: "tok-0",
                    attempts: 1,
                    max_attempts: 3,
                    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
                  },
                ],
                error: null,
              };
      })(),
    });

    await expect(
      rodarTick(c, {
        kind: "prognostico",
        worker: "w",
        trabalho: sucesso,
        config: config({ concorrencia: 1 }),
      })
    ).rejects.toThrow(/conexão caiu/);

    expect(c.ordem).not.toContain("jobs_registrar_tick_ok");
  });

  it("019 não aplicada: o tick funciona e só marca heartbeatRegistrado = false", async () => {
    // Um marcador de saúde ausente não pode derrubar o processamento de
    // prognósticos. E o painel, vendo false, declara que só tem sinal derivado.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = filaCom(2, {
      jobs_registrar_tick_ok: () => ({
        data: null,
        error: { message: 'Could not find the function public.jobs_registrar_tick_ok' },
      }),
    });
    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho: sucesso,
      config: config({ concorrencia: 1 }),
    });
    expect(rel.sucesso).toBe(2);
    expect(rel.heartbeatRegistrado).toBe(false);
    vi.restoreAllMocks();
  });

  it("conta sucesso, pulado, falha e descartado separadamente", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = filaCom(4, {
      // O terceiro desfecho é recusado pelo fencing.
      jobs_concluir: (() => {
        let n = 0;
        return () => ({ data: ++n !== 3, error: null });
      })(),
    });

    const trabalho: Trabalho = async (job) => {
      if (job.id === "job-1") return { desfecho: "skipped", motivo: "delivered" };
      if (job.id === "job-3") return { desfecho: "failed", erro: "boom", codigo: "x" };
      return { desfecho: "succeeded" };
    };

    const rel = await rodarTick(c, {
      kind: "prognostico",
      worker: "w",
      trabalho,
      config: config({ concorrencia: 1 }),
    });

    expect(rel.reivindicados).toBe(4);
    expect(rel.falhas).toBe(1);
    expect(rel.descartados).toBe(1);
    // O descartado NÃO entra em sucesso nem em pulado: não foi gravado.
    expect(rel.sucesso + rel.pulados).toBe(2);
    vi.restoreAllMocks();
  });
});
