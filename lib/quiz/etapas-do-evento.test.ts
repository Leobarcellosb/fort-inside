import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { criarClienteFalso } from "../testing/cliente-falso";
import {
  verificarEtapasDoEvento,
  MENSAGEM_ETAPAS_INDISPONIVEIS,
  MENSAGEM_ETAPAS_INVALIDAS,
} from "./etapas-do-evento";

const EV = "e-1";

function etapas(versao: number, numeros: (number | null)[]) {
  return numeros.map((n, i) => ({ id: versao * 100 + i, quiz_version: versao, stage_number: n }));
}
const v1 = etapas(1, [1, 2, 3, 4, 5, 6]);
const v2 = etapas(2, [1, 2, 3, 4, 5]);

function cliente(evento: Record<string, unknown> | null, stages: Record<string, unknown>[]) {
  return criarClienteFalso({ events: evento ? [evento] : [], quiz_stages: stages });
}
const ev = (quiz_version: number, current_stage: number) => ({
  id: EV,
  quiz_version,
  current_stage,
  status: "live",
});

afterEach(() => vi.restoreAllMocks());

function clienteQuebrado(code: string) {
  return {
    from: () => ({
      select: () => {
        const q: any = {
          eq: () => q,
          maybeSingle: () => Promise.resolve({ data: null, error: { code } }),
          then: (ok: any) => Promise.resolve({ data: null, error: { code } }).then(ok),
        };
        return q;
      },
    }),
  };
}

describe("verificarEtapasDoEvento", () => {
  it("v2 (Marco Zero) em current_stage=5 libera: 5 etapas, nao 6", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(2, 5), [...v1, ...v2]), EV);
    expect(r).toMatchObject({ ok: true, totalEtapas: 5 });
  });

  it("v2 em current_stage=4 recusa citando 5 etapas", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(2, 4), [...v1, ...v2]), EV);
    expect(r).toMatchObject({ ok: false, status: 400, motivo: "etapas_incompletas" });
    expect(!r.ok && r.error).toBe("Evento não completou as 5 etapas");
  });

  it("v1 em current_stage=6 libera (nao-regressao)", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(1, 6), [...v1, ...v2]), EV);
    expect(r).toMatchObject({ ok: true, totalEtapas: 6 });
  });

  it("v1 em current_stage=5 recusa citando 6 etapas (nao-regressao)", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(1, 5), [...v1, ...v2]), EV);
    expect(!r.ok && r.error).toBe("Evento não completou as 6 etapas");
  });

  it("versao futura v3 com 8 etapas: a contagem vem do banco", async () => {
    const v3 = etapas(3, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await verificarEtapasDoEvento(cliente(ev(3, 7), [...v1, ...v3]), EV)).ok).toBe(false);
    expect(await verificarEtapasDoEvento(cliente(ev(3, 8), [...v1, ...v3]), EV)).toMatchObject({
      ok: true,
      totalEtapas: 8,
    });
  });

  it("conta so a versao do evento: etapas de outra versao nao entram", async () => {
    const c = cliente(ev(2, 5), [...v1, ...v2]);
    await verificarEtapasDoEvento(c, EV);
    const q = c.consultas.find((x) => x.tabela === "quiz_stages");
    expect(q?.filtros).toEqual(["quiz_version=2"]);
  });

  it("versao sem etapa nenhuma: INVALID (consultou e nao ha etapas), mesmo com current_stage alto", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await verificarEtapasDoEvento(cliente(ev(9, 99), [...v1, ...v2]), EV);
    expect(r).toMatchObject({
      ok: false,
      status: 503,
      codigo: "QUIZ_STAGES_INVALID",
      motivo: "etapas_invalidas",
    });
    expect(!r.ok && r.error).toBe(MENSAGEM_ETAPAS_INVALIDAS);
    expect(!r.ok && r.error).not.toMatch(/completou/);
  });

  it("regra, nao-consegui-consultar e consultei-e-esta-invalido sao tres respostas DIFERENTES", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const regra = await verificarEtapasDoEvento(cliente(ev(2, 4), v2), EV);
    const invalida = await verificarEtapasDoEvento(cliente(ev(9, 4), v2), EV);
    const quebrado = await verificarEtapasDoEvento(clienteQuebrado("XX000") as never, EV);
    expect(regra).toMatchObject({ status: 400, codigo: "EVENT_INCOMPLETE" });
    expect(invalida).toMatchObject({ status: 503, codigo: "QUIZ_STAGES_INVALID" });
    expect(quebrado).toMatchObject({ status: 503, codigo: "QUIZ_STAGES_UNAVAILABLE" });
    // Invalida e indisponivel dividem o status (503): so o codigo as separa.
    const textos = new Set([regra, invalida, quebrado].map((x) => !x.ok && x.error));
    expect(textos.size).toBe(3);
  });

  it("evento incompleto carrega a etapa atual e o total como detalhes estruturados", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(2, 3), [...v1, ...v2]), EV);
    expect(r).toMatchObject({ ok: false, codigo: "EVENT_INCOMPLETE", detalhes: { etapa_atual: 3, total_etapas: 5 } });
  });

  it("numeracao quebrada (nulo ou buraco) e INVALID, nao palpite", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const numeros of [[1, 2, null], [1, 2, 4], [2, 3, 4]]) {
      const r = await verificarEtapasDoEvento(cliente(ev(2, 9), etapas(2, numeros)), EV);
      expect(r).toMatchObject({ ok: false, status: 503, codigo: "QUIZ_STAGES_INVALID" });
    }
  });

  it("controle positivo da numeracao: 1..N sem buraco libera", async () => {
    const r = await verificarEtapasDoEvento(cliente(ev(2, 3), etapas(2, [1, 2, 3])), EV);
    expect(r).toMatchObject({ ok: true, totalEtapas: 3 });
  });

  it("v1 com contagem diferente de TOTAL_STAGES e INVALID (trava de sanidade)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await verificarEtapasDoEvento(cliente(ev(1, 9), v1.slice(0, 5)), EV);
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "QUIZ_STAGES_INVALID" });
  });

  it("evento inexistente: 404, nao confundido com etapas incompletas", async () => {
    const r = await verificarEtapasDoEvento(cliente(null, v2), EV);
    expect(r).toMatchObject({ ok: false, status: 404, codigo: "EVENT_NOT_FOUND", motivo: "evento_inexistente" });
  });

  it("erro de leitura do banco: UNAVAILABLE, nunca libera e nunca diz 'nao completou'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await verificarEtapasDoEvento(clienteQuebrado("XX000") as never, EV);
    expect(r).toMatchObject({
      ok: false,
      status: 503,
      codigo: "QUIZ_STAGES_UNAVAILABLE",
      motivo: "etapas_indisponiveis",
    });
    expect(!r.ok && r.error).toBe(MENSAGEM_ETAPAS_INDISPONIVEIS);
  });

  it("erro so na leitura das ETAPAS (o evento le bem): tambem UNAVAILABLE", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = cliente(ev(2, 5), v2);
    const so_etapas = {
      from: (t: string) =>
        t === "quiz_stages"
          ? {
              select: () => {
                const q: any = {
                  eq: () => q,
                  then: (ok: any) => Promise.resolve({ data: null, error: { code: "57P03" } }).then(ok),
                };
                return q;
              },
            }
          : base.from(t),
    };
    const r = await verificarEtapasDoEvento(so_etapas as never, EV);
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "QUIZ_STAGES_UNAVAILABLE" });
  });
});

// ======================================================================
// PORTAO DO PROCESSAMENTO COLETIVO -- depende do MODO do evento.
// Regra do responsavel tecnico (rodada 27): no assincrono o processamento
// "depende do ENCERRAMENTO DA COLETA e da ELEGIBILIDADE DOS PARTICIPANTES, nao de
// uma sexta etapa nem de uma liberacao presencial". Aqui: o encerramento da coleta
// (a elegibilidade por presenca e a 2a metade, a ligar quando a migration 020 for
// aplicada). Cada recusa tem o controle positivo ao lado.
// ======================================================================
import { verificarEventoParaProcessar, TOLERANCIA_DE_ENVIO_MS } from "./etapas-do-evento";
import { mensagemParaHost } from "../erros/mensagens-host";

const AGORA = new Date("2026-11-07T15:00:00.000Z");
const iso = (deslocMs: number) => new Date(AGORA.getTime() + deslocMs).toISOString();
const MIN = 60_000;

type LinhaEv = Record<string, unknown>;
const evMode = (o: LinhaEv) => ({ id: EV, quiz_version: 2, current_stage: 0, status: "live", ...o });
function porModo(evento: LinhaEv, stages = [...v1, ...v2]) {
  return cliente(evento, stages);
}

describe("verificarEventoParaProcessar -- modo live (NAO-REGRESSAO)", () => {
  it("live com current_stage abaixo do total: recusa EXATAMENTE como a funcao original (mesmo status, codigo, texto e detalhes)", async () => {
    const dados = evMode({ mode: "live", current_stage: 3 });
    const novo = await verificarEventoParaProcessar(porModo(dados), EV, { agora: AGORA });
    const antigo = await verificarEtapasDoEvento(porModo(dados), EV);
    expect(novo).toEqual(antigo);
    expect(novo).toMatchObject({ ok: false, status: 400, codigo: "EVENT_INCOMPLETE", error: "Evento não completou as 5 etapas", detalhes: { etapa_atual: 3, total_etapas: 5 } });
  });

  it("CONTROLE POSITIVO: live completo (current_stage = total) libera", async () => {
    const r = await verificarEventoParaProcessar(porModo(evMode({ mode: "live", current_stage: 5 })), EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: true, modo: "live", totalEtapas: 5 });
  });

  it("live ignora a janela: coleta 'encerrada' nao libera um live incompleto", async () => {
    const r = await verificarEventoParaProcessar(
      porModo(evMode({ mode: "live", current_stage: 2, form_opens_at: iso(-9999 * MIN), form_closes_at: iso(-9000 * MIN) })),
      EV,
      { agora: AGORA }
    );
    expect(r).toMatchObject({ ok: false, codigo: "EVENT_INCOMPLETE" });
  });

  it("live com numeracao quebrada continua QUIZ_STAGES_INVALID e leitura quebrada, QUIZ_STAGES_UNAVAILABLE", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await verificarEventoParaProcessar(porModo(evMode({ mode: "live", quiz_version: 9, current_stage: 9 }), etapas(9, [1, 2, 4])), EV, { agora: AGORA });
    expect(a).toMatchObject({ ok: false, codigo: "QUIZ_STAGES_INVALID" });
    const b = await verificarEventoParaProcessar(clienteQuebrado("XX000") as never, EV, { agora: AGORA });
    expect(b).toMatchObject({ ok: false, codigo: "QUIZ_STAGES_UNAVAILABLE" });
  });
});

describe("verificarEventoParaProcessar -- modo assincrono", () => {
  const fechada = (min: number) => ({ mode: "async", current_stage: 0, form_opens_at: iso(-60 * 24 * MIN), form_closes_at: iso(-min * MIN) });

  it("NEGATIVA: coleta ABERTA recusa com COLLECTION_OPEN, mesmo com current_stage alto (etapa nao conta)", async () => {
    for (const cs of [0, 5, 99]) {
      const r = await verificarEventoParaProcessar(porModo(evMode({ mode: "async", current_stage: cs, form_opens_at: iso(-60 * MIN), form_closes_at: iso(120 * MIN) })), EV, { agora: AGORA });
      expect(r).toMatchObject({ ok: false, status: 400, codigo: "COLLECTION_OPEN", motivo: "coleta_aberta", detalhes: { coleta_encerra_em: iso(120 * MIN), fuso: "America/Sao_Paulo" } });
    }
  });

  it("a mensagem do host fala de PRAZO, nao de etapa", async () => {
    const r = await verificarEventoParaProcessar(porModo(evMode({ mode: "async", form_closes_at: iso(120 * MIN) })), EV, { agora: AGORA });
    if (r.ok) throw new Error("esperava recusa");
    const m = mensagemParaHost(r.codigo, r.detalhes);
    expect(m).toMatch(/prazo/);
    expect(m).toMatch(/coleta/);
    expect(m).not.toMatch(/libere todas|etapa pendente|etapa \d+ de \d+/i);
    expect(m).toMatch(/Não há etapa para liberar/);
    // O prazo sai no FUSO DO EVENTO, identificado: 17:00Z em 07/11/2026 = 14:00 em Sao Paulo.
    expect(m).toContain("07/11/2026 14:00 (America/Sao_Paulo, GMT-03:00)");
  });

  it("NEGATIVA: dentro da tolerancia de envio (ate 15 min depois do prazo) ainda recusa", async () => {
    const r = await verificarEventoParaProcessar(porModo(evMode(fechada(5))), EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: false, codigo: "COLLECTION_OPEN" });
    const limite = await verificarEventoParaProcessar(porModo(evMode(fechada(14.9))), EV, { agora: AGORA });
    expect(limite).toMatchObject({ ok: false, codigo: "COLLECTION_OPEN" });
  });

  it("CONTROLE POSITIVO: coleta ENCERRADA (prazo + tolerancia vencidos) libera, com current_stage em 0", async () => {
    const r = await verificarEventoParaProcessar(porModo(evMode(fechada(15))), EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: true, modo: "async", totalEtapas: null });
    expect((await verificarEventoParaProcessar(porModo(evMode(fechada(60 * 24))), EV, { agora: AGORA })).ok).toBe(true);
    expect(TOLERANCIA_DE_ENVIO_MS).toBe(15 * MIN);
  });

  it("assincrono NAO le quiz_stages: quiz_stages ilegivel ou invalido nao bloqueia (nao e o criterio)", async () => {
    const c = porModo(evMode(fechada(60)), []);
    expect((await verificarEventoParaProcessar(c, EV, { agora: AGORA })).ok).toBe(true);
    expect(c.consultas.some((q) => q.tabela === "quiz_stages")).toBe(false);
  });

  it("prazo sem form_opens_at (nulo) e valido: so o fechamento importa", async () => {
    const r = await verificarEventoParaProcessar(porModo(evMode({ mode: "async", form_opens_at: null, form_closes_at: iso(-60 * MIN) })), EV, { agora: AGORA });
    expect(r.ok).toBe(true);
  });
});

describe("verificarEventoParaProcessar -- INDETERMINADO nunca libera e nunca vira 'etapa pendente'", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));

  it.each([
    ["mode ausente", {}],
    ["mode nulo", { mode: null }],
    ["mode desconhecido", { mode: "hibrido" }],
    ["mode vazio", { mode: "" }],
    ["mode em maiusculas (nao e o valor do banco)", { mode: "ASYNC" }],
  ])("%s -> 503 EVENT_MODE_UNDETERMINED", async (_n, extra) => {
    const r = await verificarEventoParaProcessar(porModo(evMode({ current_stage: 99, form_closes_at: iso(-9999 * MIN), ...extra })), EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "EVENT_MODE_UNDETERMINED", motivo: "modo_indeterminado" });
    expect(!r.ok && r.codigo).not.toBe("EVENT_INCOMPLETE");
  });

  it.each([
    ["sem form_closes_at", { form_closes_at: null }],
    ["form_closes_at ausente", {}],
    ["form_closes_at ilegivel", { form_closes_at: "amanha de manha" }],
    ["form_closes_at vazio", { form_closes_at: "  " }],
    ["form_opens_at ilegivel", { form_opens_at: "lixo", form_closes_at: iso(-60 * MIN) }],
    ["abertura DEPOIS do fechamento", { form_opens_at: iso(10 * MIN), form_closes_at: iso(-60 * MIN) }],
  ])("assincrono, %s -> 503 COLLECTION_WINDOW_UNDETERMINED (nao 'coleta aberta', nao libera)", async (_n, extra) => {
    const r = await verificarEventoParaProcessar(porModo(evMode({ mode: "async", ...extra })), EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "COLLECTION_WINDOW_UNDETERMINED", motivo: "janela_indeterminada" });
    expect(!r.ok && r.codigo).not.toBe("COLLECTION_OPEN");
  });

  it("evento que nao da para LER continua sendo indisponibilidade da leitura, nao 'modo indeterminado'", async () => {
    const r = await verificarEventoParaProcessar(clienteQuebrado("XX000") as never, EV, { agora: AGORA });
    expect(r).toMatchObject({ ok: false, codigo: "QUIZ_STAGES_UNAVAILABLE" });
    expect((await verificarEventoParaProcessar(cliente(null, v2), EV, { agora: AGORA }))).toMatchObject({ codigo: "EVENT_NOT_FOUND" });
  });

  it("as mensagens do host dos dois casos indeterminados sao diferentes entre si e nao falam de etapa para liberar", () => {
    const a = mensagemParaHost("EVENT_MODE_UNDETERMINED");
    const b = mensagemParaHost("COLLECTION_WINDOW_UNDETERMINED");
    expect(a).not.toBe(b);
    for (const m of [a, b]) expect(m).not.toMatch(/libere|pendente|migration|018/i);
    expect(b).toMatch(/prazo/);
  });
});

describe("a funcao ORIGINAL segue intacta (a rota da proxima etapa do participante depende dela no assincrono)", () => {
  it("assincrono com current_stage=0: ainda devolve etapas_incompletas COM total_etapas, como app/api/etapa/proxima espera", async () => {
    const r = await verificarEtapasDoEvento(porModo(evMode({ mode: "async", current_stage: 0, form_closes_at: iso(-9999 * MIN) })), EV);
    expect(r).toMatchObject({ ok: false, motivo: "etapas_incompletas", detalhes: { etapa_atual: 0, total_etapas: 5 } });
  });
});

// ======================================================================
// A HORA DE REFERENCIA VEM DO BANCO. "O banco deve fornecer a referencia temporal
// de autorizacao, evitando diferencas entre o relogio do navegador, do servidor
// Next.js e do PostgreSQL." Em producao (sem `agora` injetado) o relogio do Node
// nunca decide. Sem a hora do banco: indisponibilidade, nunca o relogio local.
// ======================================================================
describe("verificarEventoParaProcessar -- a hora de referencia e a do BANCO", () => {
  const fechada = evMode({ mode: "async", form_opens_at: iso(-3 * 24 * 60 * MIN), form_closes_at: iso(-20 * MIN) }); // venceu ha 20 min (+15 de tolerancia = encerrada)
  const aberta = evMode({ mode: "async", form_opens_at: iso(-3 * 24 * 60 * MIN), form_closes_at: iso(120 * MIN) });

  function comRelogio(evento: LinhaEv, rpc: (nome: string) => Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown }) {
    const base = porModo(evento);
    const chamadas: string[] = [];
    return {
      chamadas,
      cliente: {
        consultas: base.consultas,
        from: base.from,
        rpc: async (nome: string) => {
          chamadas.push(nome);
          return rpc(nome) as never;
        },
      },
    };
  }
  const doBanco = () => ({ data: AGORA.toISOString(), error: null });

  afterEach(() => vi.useRealTimers());
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));

  it("a decisao usa a hora que o BANCO devolve, e so ela", async () => {
    const c = comRelogio(fechada, doBanco);
    const r = await verificarEventoParaProcessar(c.cliente as never, EV);
    expect(r).toMatchObject({ ok: true, modo: "async" });
    expect(c.chamadas).toEqual(["referencia_temporal_do_banco"]);
  });

  it("NODE com relogio MUITO ATRASADO (ano 2000): coleta encerrada segundo o BANCO libera -- o Node nao manda", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    const r = await verificarEventoParaProcessar(comRelogio(fechada, doBanco).cliente as never, EV);
    expect(r.ok).toBe(true);
  });

  it("NODE com relogio MUITO ADIANTADO (ano 2099): coleta ABERTA segundo o BANCO recusa -- o Node nao libera", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const r = await verificarEventoParaProcessar(comRelogio(aberta, doBanco).cliente as never, EV);
    expect(r).toMatchObject({ ok: false, codigo: "COLLECTION_OPEN" });
  });

  it("CONTROLE: o relogio do banco adiantado libera a mesma coleta que estava aberta", async () => {
    const adiantado = () => ({ data: iso(121 * MIN + 15 * MIN), error: null });
    const r = await verificarEventoParaProcessar(comRelogio(aberta, adiantado).cliente as never, EV);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["erro do banco (timeout)", () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })],
    ["rede", () => ({ data: null, error: { message: "TypeError: fetch failed" } })],
    ["sem dado e sem erro", () => ({ data: null, error: null })],
    ["valor ilegivel", () => ({ data: "ontem a noite", error: null })],
    ["tipo errado", () => ({ data: 12345, error: null })],
    ["excecao ao chamar", () => Promise.reject(new Error("socket hang up"))],
  ])("sem a hora do banco (%s): 503 TIME_REFERENCE_UNAVAILABLE -- NAO cai no relogio local", async (_n, rpc) => {
    // O Node diria "encerrada" (2099): se houvesse queda para o relogio local, LIBERARIA.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const r = await verificarEventoParaProcessar(comRelogio(fechada, rpc as never).cliente as never, EV);
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "TIME_REFERENCE_UNAVAILABLE", motivo: "relogio_indisponivel" });
    expect(!r.ok && r.codigo).not.toBe("COLLECTION_OPEN");
  });

  it("cliente sem rpc (nao ha como perguntar ao banco): indisponibilidade, nunca liberacao", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const r = await verificarEventoParaProcessar(porModo(fechada), EV);
    expect(r).toMatchObject({ ok: false, codigo: "TIME_REFERENCE_UNAVAILABLE" });
  });

  it.each([
    ["PostgREST", { code: "PGRST202", message: "Could not find the function public.referencia_temporal_do_banco in the schema cache" }],
    ["Postgres cru", { code: "42883", message: "function public.referencia_temporal_do_banco() does not exist" }],
    ["PostgREST sem nome na mensagem", { code: "PGRST202", message: "opaca" }],
  ])("a funcao NAO EXISTE no banco (%s): ASYNC_PROCESSING_MISSING (mandar aplicar), diferente de indisponibilidade", async (_n, erro) => {
    const r = await verificarEventoParaProcessar(comRelogio(fechada, () => ({ data: null, error: erro })).cliente as never, EV);
    expect(r).toMatchObject({ ok: false, status: 503, codigo: "ASYNC_PROCESSING_MISSING", motivo: "assincrono_ausente" });
  });

  it("falta de OUTRA coisa nao e a funcao do relogio: continua indisponibilidade (nao manda aplicar o que nao e)", async () => {
    const erro = { code: "42883", message: "function public.outra_coisa(uuid, text) does not exist" };
    const r = await verificarEventoParaProcessar(comRelogio(fechada, () => ({ data: null, error: erro })).cliente as never, EV);
    expect(r).toMatchObject({ ok: false, codigo: "TIME_REFERENCE_UNAVAILABLE" });
  });

  it("o modo LIVE nunca pergunta a hora ao banco (nao-regressao: o presencial nao depende da atualizacao)", async () => {
    const c = comRelogio(evMode({ mode: "live", current_stage: 5 }), () => {
      throw new Error("live nao pode chamar o relogio");
    });
    const r = await verificarEventoParaProcessar(c.cliente as never, EV);
    expect(r).toMatchObject({ ok: true, modo: "live" });
    expect(c.chamadas).toEqual([]);
  });

  it("modo indeterminado nao chama o relogio (nao ha o que perguntar)", async () => {
    const c = comRelogio(evMode({ mode: "hibrido" }), doBanco);
    expect(await verificarEventoParaProcessar(c.cliente as never, EV)).toMatchObject({ codigo: "EVENT_MODE_UNDETERMINED" });
    expect(c.chamadas).toEqual([]);
  });

  it("o parametro `agora` continua injetavel (so para teste) e dispensa a chamada ao banco", async () => {
    const c = comRelogio(fechada, () => {
      throw new Error("com agora injetado nao se pergunta ao banco");
    });
    expect((await verificarEventoParaProcessar(c.cliente as never, EV, { agora: AGORA })).ok).toBe(true);
    expect(c.chamadas).toEqual([]);
  });
});
