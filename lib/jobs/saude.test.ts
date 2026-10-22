import { describe, expect, it } from "vitest";
import { criarClienteDeFilaFalso } from "./cliente-falso";
import { lerSaudeDaFila, type ClienteSaude } from "./saude";
import type { ConfigFila } from "./config";

const AGORA = Date.parse("2026-10-21T12:00:00.000Z");
const atras = (s: number) => new Date(AGORA - s * 1000).toISOString();
const adiante = (s: number) => new Date(AGORA + s * 1000).toISOString();

const config = (over: Partial<ConfigFila> = {}): ConfigFila => ({
  concorrencia: 3,
  leaseSegundos: 180,
  renovarCadaMs: 60_000,
  backoffSegundos: 30,
  orcamentoTickMs: 240_000,
  maxJobsPorTick: 12,
  maxRecuperarPorTick: 100,
  alertaSemProgressoSegundos: 180,
  janelaFalhasHoras: 24,
  timeoutTentativaMs: 120_000,
  orcamentoChamadasPorTick: 200,
  // Os tetos REAIS: o painel de orçamento só tem o que verificar com o
  // disjuntor em vigor. O caso "desligado" sobrescreve para 0 no próprio teste.
  orcamentoTentativasPorEvento: 100,
  orcamentoTentativasPorParticipante: 3,
  intervaloDoAgendadorSegundos: 60,
  ...over,
});

type Linha = Record<string, unknown>;

function job(over: Linha = {}): Linha {
  return {
    id: `j-${Math.random().toString(16).slice(2, 8)}`,
    kind: "prognostico",
    event_id: "e-1",
    participant_id: `p-${Math.random().toString(16).slice(2, 6)}`,
    status: "pending",
    attempts: 0,
    max_attempts: 3,
    created_at: atras(10),
    available_at: atras(10),
    lease_expires_at: null,
    attempt_started_at: null,
    finished_at: null,
    updated_at: atras(10),
    claimed_by: null,
    last_error: null,
    last_error_code: null,
    ...over,
  };
}

const RPC_ORCAMENTO_OK = {
  jobs_consumo_resumo: () => ({
    data: [{ tentativas_externas: 0, requisicoes_despachadas: 0 }],
    error: null as { message: string } | null,
  }),
};

const ler = (jobs: Linha[], cfg = config(), heartbeat: Linha[] = []) =>
  lerSaudeDaFila(
    criarClienteDeFilaFalso(RPC_ORCAMENTO_OK, {
      jobs,
      jobs_worker_heartbeat: heartbeat,
    }) as unknown as ClienteSaude,
    { kind: "prognostico", config: cfg, agora: () => AGORA }
  );

const marca = (over: Linha = {}): Linha => ({
  kind: "prognostico",
  ultimo_tick_ok_em: atras(10),
  worker: "agendador:deploy-abc",
  duracao_ms: 1200,
  ticks_ok: 42,
  resumo: { reivindicados: 3, sucesso: 3 },
  ...over,
});

/** Cliente em que a tabela da 019 não existe (migration não aplicada). */
function clienteSem019(jobs: Linha[]): ClienteSaude {
  const real = criarClienteDeFilaFalso(RPC_ORCAMENTO_OK, { jobs }) as unknown as ClienteSaude;
  return {
    rpc: real.rpc.bind(real),
    from(tabela: string) {
      if (tabela !== "jobs_worker_heartbeat") return real.from(tabela);
      return {
        select() {
          const q = {
            eq: () => q,
            in: () => q,
            gte: () => q,
            not: () => q,
            order: () => q,
            limit: () => q,
            then: (ok: (v: { data: unknown; error: unknown }) => unknown) =>
              Promise.resolve({
                data: null,
                error: {
                  message:
                    "Could not find the table 'public.jobs_worker_heartbeat' in the schema cache",
                },
              }).then(ok),
          };
          return q as never;
        },
      };
    },
  };
}

describe("saúde da fila: indicadores", () => {
  it("fila vazia: nenhum indicador inventado e nenhum alerta", async () => {
    const s = await ler([]);
    expect(s.pendentes).toBe(0);
    expect(s.jobMaisAntigoNaFila).toBeNull();
    expect(s.ultimoProgressoDoWorker.em).toBeNull();
    expect(s.alerta.ativo).toBe(false);
    expect(s.alerta.motivo).toMatch(/sem job pendente/);
  });

  it("INDICADOR 1 não confunde o INSERT do enfileiramento com progresso de worker", async () => {
    // Jobs recém-enfileirados têm updated_at = agora, mas nunca foram
    // reivindicados. Contar isso como progresso faria "enfileirei 50 com o
    // agendador morto" parecer saúde.
    const s = await ler([job({ updated_at: atras(1), attempt_started_at: null })]);
    expect(s.ultimoProgressoDoWorker.em).toBeNull();
    expect(s.ultimoProgressoDoWorker.idadeSegundos).toBeNull();
    expect(s.ultimoProgressoDoWorker.tickRegistrado).toBe(false);
  });

  it("INDICADOR 1 conta a escrita de um worker (linha já reivindicada)", async () => {
    const s = await ler([
      job({ status: "running", attempts: 1, attempt_started_at: atras(40), updated_at: atras(20) }),
      job({ updated_at: atras(2) }), // insert puro: tem de ser ignorado
    ]);
    expect(s.ultimoProgressoDoWorker.idadeSegundos).toBe(20);
    expect(s.ultimoProgressoDoWorker.fonte).toMatch(/updated_at/);
  });

  it("INDICADOR 2 mede a idade NA FILA (criação), não desde a última tentativa", async () => {
    // Se medisse desde a última tentativa, o job que mais retenta pareceria o
    // mais novo -- justamente o que não sai do lugar.
    const s = await ler([
      job({ id: "novo", created_at: atras(30) }),
      job({ id: "velho", created_at: atras(900), attempts: 2, attempt_started_at: atras(5), updated_at: atras(5) }),
    ]);
    expect(s.jobMaisAntigoNaFila?.jobId).toBe("velho");
    expect(s.jobMaisAntigoNaFila?.idadeSegundos).toBe(900);
  });

  it("INDICADOR 2 marca quando o mais antigo está só esperando backoff", async () => {
    const s = await ler([
      job({ created_at: atras(300), available_at: adiante(20), attempts: 1, attempt_started_at: atras(60), updated_at: atras(20) }),
    ]);
    expect(s.jobMaisAntigoNaFila?.aguardandoBackoff).toBe(true);
  });

  it("INDICADOR 3 separa lease vencido de trabalho em voo", async () => {
    const s = await ler([
      job({ status: "running", attempts: 1, attempt_started_at: atras(400), lease_expires_at: atras(10), updated_at: atras(300) }),
      job({ status: "running", attempts: 1, attempt_started_at: atras(30), lease_expires_at: adiante(150), updated_at: atras(5) }),
      job({ status: "pending", available_at: adiante(25) }),
      job({ status: "pending", available_at: atras(1) }),
    ]);
    expect(s.recuperacao.expirados).toBe(1);
    expect(s.recuperacao.emVoo).toBe(1);
    expect(s.recuperacao.aguardandoBackoff).toBe(1);
    expect(s.recuperacao.prontosParaPegar).toBe(1);
    expect(s.pendentes).toBe(4);
  });

  it("INDICADOR 3 conta falhas na JANELA, não o total histórico", async () => {
    // Um contador que nunca zera deixa de ser sinal e vira ruído.
    const s = await ler(
      [
        job({ status: "failed", attempts: 3, attempt_started_at: atras(100), finished_at: atras(60), last_error_code: "http_502", last_error: "recusa" }),
        job({ status: "failed", attempts: 3, attempt_started_at: atras(999999), finished_at: atras(400000) }),
      ],
      config({ janelaFalhasHoras: 24 })
    );
    expect(s.recuperacao.falhosNaJanela).toBe(1);
    expect(s.recuperacao.janelaFalhasHoras).toBe(24);
    expect(s.recuperacao.jobs.map((j) => j.codigo)).toContain("http_502");
  });

  it("INDICADOR 3 aponta job sem tentativa restante, que ninguém vai retomar", async () => {
    const s = await ler([
      job({ status: "running", attempts: 3, max_attempts: 3, attempt_started_at: atras(500), lease_expires_at: atras(20), updated_at: atras(400) }),
    ]);
    expect(s.recuperacao.semTentativaRestante).toBe(1);
    // Não duplica na lista por cair em dois critérios (expirado E sem tentativa).
    expect(s.recuperacao.jobs).toHaveLength(1);
  });
});

describe("saúde do AGENDADOR (migration 019) -- propriedade diferente da do processamento", () => {
  it("sem a 019 aplicada: veredito INDISPONÍVEL, nunca 'ok', e NENHUM horário fabricado", async () => {
    // "Não consegui verificar" não é "está tudo bem". E o campo do último tick
    // fica NULL: nada de aproximar pelo sinal derivado.
    const s = await lerSaudeDaFila(clienteSem019([job({ created_at: atras(10) })]), {
      kind: "prognostico",
      config: config(),
      agora: () => AGORA,
    });

    expect(s.saudeDoAgendador.veredito).toBe("indisponivel");
    expect(s.saudeDoAgendador.ultimoTickOkEm).toBeNull();
    expect(s.saudeDoAgendador.idadeSegundos).toBeNull();
    expect(s.saudeDoAgendador.motivo).toMatch(/019 não aplicada/);
    expect(s.saudeDoAgendador.motivo).toMatch(/DERIVADO/);
    expect(s.naoVerificavel).toBe(true);
    // E o processamento continua sendo medido normalmente.
    expect(s.pendentes).toBe(1);
  });

  it("019 aplicada e NENHUM tick jamais terminou: alerta (não 'ok', não 'indisponível')", async () => {
    const s = await ler([job()], config(), []);
    expect(s.saudeDoAgendador.veredito).toBe("alerta");
    expect(s.saudeDoAgendador.ultimoTickOkEm).toBeNull();
    expect(s.saudeDoAgendador.ticksOk).toBe(0);
    expect(s.saudeDoAgendador.motivo).toMatch(/jamais terminou inteiro/);
    expect(s.alertaAtivo).toBe(true);
  });

  it("marcador fresco: veredito ok, com o registro LITERAL (não derivado)", async () => {
    const s = await ler([], config(), [marca({ ultimo_tick_ok_em: atras(30) })]);
    expect(s.saudeDoAgendador.veredito).toBe("ok");
    expect(s.saudeDoAgendador.ultimoTickOkEm).toBe(atras(30));
    expect(s.saudeDoAgendador.idadeSegundos).toBe(30);
    expect(s.saudeDoAgendador.ticksOk).toBe(42);
    expect(s.saudeDoAgendador.worker).toBe("agendador:deploy-abc");
    expect(s.saudeDoAgendador.fonte).toMatch(/019/);
  });

  it("marcador velho: alerta, com quantos disparos do agendador se perderam", async () => {
    const s = await ler([], config({ intervaloDoAgendadorSegundos: 60 }), [
      marca({ ultimo_tick_ok_em: atras(600) }),
    ]);
    expect(s.saudeDoAgendador.veredito).toBe("alerta");
    expect(s.saudeDoAgendador.idadeSegundos).toBe(600);
    expect(s.saudeDoAgendador.disparosEsperadosPerdidos).toBe(10);
    expect(s.saudeDoAgendador.motivo).toMatch(/CRON_SECRET/);
    expect(s.alertaAtivo).toBe(true);
  });

  it("agendador parado é detectado MESMO com a fila vazia (o derivado não detectaria)", async () => {
    // É a razão de a 019 existir: sem trabalho, `jobs` não tem rastro algum de
    // tick, então nenhum sinal derivado pode dizer se o cron está vivo.
    const s = await ler([], config(), [marca({ ultimo_tick_ok_em: atras(3600) })]);

    expect(s.pendentes).toBe(0);
    expect(s.alerta.ativo).toBe(false); // processamento: nada a processar
    expect(s.saudeDoAgendador.veredito).toBe("alerta"); // agendador: morto
    expect(s.alertaAtivo).toBe(true);
  });

  it("o campo derivado continua se declarando derivado, e aponta para o literal", async () => {
    const s = await ler(
      [job({ status: "running", attempts: 1, attempt_started_at: atras(40), updated_at: atras(20) })],
      config(),
      [marca()]
    );
    expect(s.ultimoProgressoDoWorker.tickRegistrado).toBe(false);
    expect(s.ultimoProgressoDoWorker.fonte).toMatch(/derivado/);
    expect(s.ultimoProgressoDoWorker.oQueProva).toMatch(/NÃO prova que um tick terminou inteiro/);
    expect(s.ultimoProgressoDoWorker.registroLiteralEm).toMatch(/saudeDoAgendador/);
    // Os dois coexistem, com valores independentes.
    expect(s.ultimoProgressoDoWorker.idadeSegundos).toBe(20);
    expect(s.saudeDoAgendador.ultimoTickOkEm).not.toBeNull();
  });

  it("processamento saudável NÃO encobre agendador morto (um não substitui o outro)", async () => {
    const s = await ler(
      [job({ status: "running", attempts: 1, attempt_started_at: atras(20), lease_expires_at: adiante(160), updated_at: atras(5) })],
      config(),
      [marca({ ultimo_tick_ok_em: atras(1800) })]
    );
    expect(s.alerta.ativo).toBe(false); // processamento avançando
    expect(s.saudeDoAgendador.veredito).toBe("alerta"); // agendador não entrega
    expect(s.alertaAtivo).toBe(true);
  });
});

describe("saúde da fila: a regra de alerta", () => {
  it("DISPARA: jobs pendentes, o mais antigo passou do limiar, worker nunca reivindicou", async () => {
    const s = await ler([job({ created_at: atras(600), available_at: atras(600) })]);
    expect(s.alerta.ativo).toBe(true);
    expect(s.alerta.motivo).toMatch(/NENHUM worker jamais reivindicou/);
    expect(s.alerta.motivo).toMatch(/CRON_SECRET/);
    expect(s.alerta.condicoes).toEqual({
      temJobPendente: true,
      maisAntigoPassouDaCarencia: true,
      progressoDoWorkerVelhoOuAusente: true,
    });
  });

  it("DISPARA: havia progresso, mas envelheceu além do limiar", async () => {
    const s = await ler([
      job({ created_at: atras(900), attempts: 1, attempt_started_at: atras(800), updated_at: atras(700) }),
    ]);
    expect(s.alerta.ativo).toBe(true);
    expect(s.alerta.motivo).toMatch(/nenhum progresso de worker há 700s/);
  });

  it("NÃO dispara dentro da carência: job recém-enfileirado, worker ainda não teve tempo", async () => {
    const s = await ler([job({ created_at: atras(20), available_at: atras(20) })]);
    expect(s.alerta.ativo).toBe(false);
    expect(s.alerta.motivo).toMatch(/dentro da carência/);
    expect(s.alerta.condicoes.maisAntigoPassouDaCarencia).toBe(false);
  });

  it("NÃO dispara com fila longa sendo processada: 3 em voo renovando lease, 47 esperando", async () => {
    // Fila grande legitimamente leva muito mais que o limiar para escoar. O
    // alerta é sobre AUSÊNCIA de progresso, não sobre tamanho da fila.
    const emVoo = [1, 2, 3].map(() =>
      job({
        status: "running",
        attempts: 1,
        created_at: atras(1800),
        attempt_started_at: atras(40),
        lease_expires_at: adiante(140),
        updated_at: atras(10), // renovação de lease recente
      })
    );
    const esperando = Array.from({ length: 47 }, () => job({ created_at: atras(1800) }));
    const s = await ler([...emVoo, ...esperando]);

    expect(s.pendentes).toBe(50);
    expect(s.jobMaisAntigoNaFila?.idadeSegundos).toBe(1800);
    expect(s.alerta.ativo).toBe(false);
    expect(s.alerta.condicoes.maisAntigoPassouDaCarencia).toBe(true);
    expect(s.alerta.condicoes.progressoDoWorkerVelhoOuAusente).toBe(false);
  });

  it("NÃO dispara sem trabalho pendente, mesmo sem progresso algum há dias", async () => {
    const s = await ler([
      job({ status: "succeeded", attempts: 1, attempt_started_at: atras(400000), finished_at: atras(399000), updated_at: atras(399000) }),
    ]);
    expect(s.alerta.ativo).toBe(false);
    expect(s.alerta.condicoes.temJobPendente).toBe(false);
  });

  it("o limiar é configurável, e muda o veredito com os mesmos dados", async () => {
    const jobs = [job({ created_at: atras(300), attempts: 1, attempt_started_at: atras(250), updated_at: atras(240) })];

    expect((await ler(jobs, config({ alertaSemProgressoSegundos: 180 }))).alerta.ativo).toBe(true);
    expect((await ler(jobs, config({ alertaSemProgressoSegundos: 600 }))).alerta.ativo).toBe(false);
    expect(
      (await ler(jobs, config({ alertaSemProgressoSegundos: 600 }))).alerta.limiarSegundos
    ).toBe(600);
  });

  it("erro de LEITURA estoura em vez de devolver indicadores zerados", async () => {
    // Zero pendente e zero expirado parecem saúde. Se a consulta falhou, a
    // resposta honesta é "não sei", não "está tudo bem".
    const quebrado = {
      from: () => ({
        select: () => {
          const q = {
            eq: () => q,
            in: () => q,
            gte: () => q,
            not: () => q,
            order: () => q,
            limit: () => q,
            then: (ok: (v: { data: unknown; error: unknown }) => unknown) =>
              Promise.resolve({ data: null, error: { message: "conexão caiu" } }).then(ok),
          };
          return q;
        },
      }),
    } as unknown as ClienteSaude;

    await expect(
      lerSaudeDaFila(quebrado, { kind: "prognostico", config: config(), agora: () => AGORA })
    ).rejects.toThrow(/conexão caiu/);
  });
});

describe("saúde do ORÇAMENTO -- o painel tem de nomear o bloqueio", () => {
  /** Cliente em que as FUNÇÕES de orçamento não existem (021 não aplicada). */
  function clienteSem021(jobs: Linha[]): ClienteSaude {
    const real = criarClienteDeFilaFalso(
      {
        jobs_consumo_resumo: () => ({
          data: null,
          error: { message: "function public.jobs_consumo_resumo(uuid, text) does not exist" },
        }),
      },
      { jobs }
    ) as unknown as ClienteSaude;
    return real;
  }

  it("021 ausente: veredito BLOQUEADO, causa nomeada, e distinta de fila vazia", async () => {
    const s = await lerSaudeDaFila(clienteSem021([job({ created_at: atras(600) })]), {
      kind: "prognostico",
      config: config(),
      agora: () => AGORA,
    });

    expect(s.saudeDoOrcamento.veredito).toBe("bloqueado");
    expect(s.saudeDoOrcamento.codigo).toBe("BUDGET_MEASUREMENT_MISSING");
    expect(s.processamentoBloqueado).toBe(true);
    expect(s.alertaAtivo).toBe(true);
    // Nomeia o que NÃO é, porque confundir as três é o defeito.
    expect(s.saudeDoOrcamento.motivo).toMatch(/não por fila vazia/);
    expect(s.saudeDoOrcamento.motivo).toMatch(/não por orçamento esgotado/);
    // E diz o que fazer.
    expect(s.saudeDoOrcamento.mensagemParaOperacao).toMatch(/migration 021/);
    // Fila vazia é OUTRA coisa: aqui há trabalho pendente.
    expect(s.pendentes).toBe(1);
  });

  it("021 existe mas não responde: UNAVAILABLE, e NÃO manda aplicar migration", async () => {
    // Mandar aplicar migration quando o problema é rede é mandar a operação
    // investigar a coisa errada.
    const cliente = criarClienteDeFilaFalso(
      { jobs_consumo_resumo: () => ({ data: null, error: { message: "timeout de conexão" } }) },
      { jobs: [job()] }
    ) as unknown as ClienteSaude;

    const s = await lerSaudeDaFila(cliente, {
      kind: "prognostico",
      config: config(),
      agora: () => AGORA,
    });

    expect(s.saudeDoOrcamento.veredito).toBe("bloqueado");
    expect(s.saudeDoOrcamento.codigo).toBe("BUDGET_MEASUREMENT_UNAVAILABLE");
    expect(s.saudeDoOrcamento.mensagemParaOperacao).not.toMatch(/migration/);
    expect(s.saudeDoOrcamento.mensagemParaOperacao).toMatch(/Aguarde/);
  });

  it("disjuntor desligado nos dois tetos: DESLIGADO, nem bloqueio nem saúde", async () => {
    const s = await ler(
      [job()],
      config({ orcamentoTentativasPorEvento: 0, orcamentoTentativasPorParticipante: 0 })
    );
    expect(s.saudeDoOrcamento.veredito).toBe("desligado");
    expect(s.processamentoBloqueado).toBe(false);
    expect(s.saudeDoOrcamento.codigo).toBeNull();
  });

  it("medição disponível: veredito ok, com os tetos em vigor", async () => {
    const s = await ler([job()]);
    expect(s.saudeDoOrcamento.veredito).toBe("ok");
    expect(s.saudeDoOrcamento.tetoEventoPadrao).toBe(100);
    expect(s.saudeDoOrcamento.tetoParticipantePadrao).toBe(3);
    expect(s.processamentoBloqueado).toBe(false);
  });
});
