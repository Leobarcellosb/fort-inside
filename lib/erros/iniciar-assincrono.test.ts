import { describe, expect, it } from "vitest";
import { codigoDoErro, iniciarProcessamentoAssincrono, type ClienteDeInicio } from "./iniciar-assincrono";
import type { ErroRpcCru } from "./falha-de-fila";

const EVENTO = { quiz_version: 2 };
const EV = "33333333-3333-4333-8333-333333333333";

function cliente(resposta: { data?: unknown; error?: ErroRpcCru | null } | Error) {
  const chamadas: { nome: string; args: Record<string, unknown> }[] = [];
  const c: ClienteDeInicio = {
    rpc: async (nome, args) => {
      chamadas.push({ nome, args });
      if (resposta instanceof Error) throw resposta;
      return { data: resposta.data ?? null, error: resposta.error ?? null };
    },
  };
  return { c, chamadas };
}
const iniciar = (c: ClienteDeInicio, extra: { somenteVerificar?: boolean } = {}) =>
  iniciarProcessamentoAssincrono(c, { eventId: EV, evento: EVENTO, ...extra });

describe("iniciarProcessamentoAssincrono -- tradução do desfecho do banco", () => {
  it("CONTROLE POSITIVO: ok do banco -> contagens, impressão digital e hora do BANCO", async () => {
    const { c, chamadas } = cliente({ data: { ok: true, total: 3, criados: 2, reaproveitados: 1, digest: "abc", agora: "2026-11-07T15:16:00Z" } });
    const r = await iniciar(c);
    expect(r).toEqual({ ok: true, total: 3, criados: 2, reaproveitados: 1, digest: "abc", agoraDoBanco: "2026-11-07T15:16:00Z", ids: [] });
    // A tolerância vem da MESMA constante do portão (15 min), não de um número solto.
    expect(chamadas[0]).toMatchObject({ nome: "jobs_iniciar_assincrono", args: { p_event_id: EV, p_tolerancia_segundos: 900, p_somente_verificar: false } });
  });

  it("modo somenteVerificar devolve os ids da fotografia (usado pelo lote)", async () => {
    const { c, chamadas } = cliente({ data: { ok: true, total: 2, criados: 0, reaproveitados: 0, digest: "d", agora: "x", ids: ["a", "b"] } });
    const r = await iniciar(c, { somenteVerificar: true });
    expect(r).toMatchObject({ ok: true, ids: ["a", "b"] });
    expect(chamadas[0].args.p_somente_verificar).toBe(true);
  });

  it.each([
    ["coleta_aberta", { motivo: "coleta_aberta", encerra_em: "2026-11-07T15:00:00+00:00" }, "COLLECTION_OPEN"],
    ["snapshot_instavel", { motivo: "snapshot_instavel", transacoes_abertas: 1 }, "SNAPSHOT_UNSTABLE"],
    ["observabilidade_indisponivel (não dá para observar => não afirma)", { motivo: "observabilidade_indisponivel" }, "SNAPSHOT_UNSTABLE"],
    ["janela_indeterminada", { motivo: "janela_indeterminada" }, "COLLECTION_WINDOW_UNDETERMINED"],
    ["modo_nao_assincrono", { motivo: "modo_nao_assincrono", modo: "live" }, "EVENT_MODE_UNDETERMINED"],
    ["evento_inexistente", { motivo: "evento_inexistente" }, "EVENT_NOT_FOUND"],
    ["sem_elegiveis", { motivo: "sem_elegiveis" }, "NO_COMPLETED_PARTICIPANTS"],
    ["motivo desconhecido", { motivo: "algo_novo" }, "QUEUE_UNAVAILABLE"],
  ])("recusa %s -> %s", async (_n, d, codigo) => {
    const r = await iniciar(cliente({ data: { ok: false, ...d } }).c);
    expect(r).toMatchObject({ ok: false, codigo });
  });

  it("coleta aberta carrega o prazo e o FUSO DO EVENTO (v2 = São Paulo)", async () => {
    const r = await iniciar(cliente({ data: { ok: false, motivo: "coleta_aberta", encerra_em: "2026-11-07T15:00:00+00:00" } }).c);
    expect(r).toMatchObject({ ok: false, detalhes: { coleta_encerra_em: "2026-11-07T15:00:00.000Z", fuso: "America/Sao_Paulo" } });
  });

  it("resposta em formato inesperado -> indisponibilidade, nunca sucesso", async () => {
    expect(await iniciar(cliente({ data: "ok" }).c)).toMatchObject({ ok: false, codigo: "QUEUE_UNAVAILABLE" });
    expect(await iniciar(cliente({ data: null }).c)).toMatchObject({ ok: false, codigo: "QUEUE_UNAVAILABLE" });
    expect(await iniciar(cliente(new Error("boom")).c)).toMatchObject({ ok: false, codigo: "QUEUE_UNAVAILABLE" });
  });
});

describe("codigoDoErro -- quem faltou, e a fotografia que mudou", () => {
  it("a exceção do banco que DESFAZ tudo (fotografia mudou no meio) -> SNAPSHOT_UNSTABLE", () => {
    expect(codigoDoErro({ code: "P0001", message: "SNAPSHOT_INSTAVEL: o conjunto de respostas confirmadas mudou durante o início do processamento (evento x)" })).toBe("SNAPSHOT_UNSTABLE");
  });
  it.each([
    ["PostgREST, a função chamada", { code: "PGRST202", message: "Could not find the function public.jobs_iniciar_assincrono(p_event_id, p_kind) in the schema cache" }],
    ["Postgres cru, a função chamada (assinatura com espaço)", { code: "42883", message: "function public.jobs_iniciar_assincrono(uuid, text, integer, integer, boolean) does not exist" }],
  ])("faltou a função que EU chamei (%s) -> ASYNC_PROCESSING_MISSING", (_n, erro) => {
    expect(codigoDoErro(erro)).toBe("ASYNC_PROCESSING_MISSING");
  });
  it("faltou algo que ELA usa por dentro (jobs_enfileirar) -> QUEUE_SCHEMA_MISSING, a migration da FILA", () => {
    expect(codigoDoErro({ code: "42883", message: "function public.jobs_enfileirar(text, uuid, uuid, integer, integer) does not exist" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDoErro({ code: "42P01", message: 'relation "public.jobs" does not exist' })).toBe("QUEUE_SCHEMA_MISSING");
  });
  it("CONTROLE: timeout / rede -> QUEUE_UNAVAILABLE (a fila existe e não respondeu)", () => {
    expect(codigoDoErro({ code: "57014", message: "canceling statement due to statement timeout" })).toBe("QUEUE_UNAVAILABLE");
    expect(codigoDoErro({ message: "TypeError: fetch failed" })).toBe("QUEUE_UNAVAILABLE");
  });
});
