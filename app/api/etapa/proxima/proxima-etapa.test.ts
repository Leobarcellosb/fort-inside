import { describe, expect, it } from "vitest";
import { calcularProximaEtapa, type ClienteDeProxima } from "./proxima-etapa";

const MIN = 60_000;
const T = Date.parse("2026-10-22T03:00:00Z");
type Linha = Record<string, unknown>;

function banco(o: {
  mode?: "live" | "async";
  versao?: number;
  etapas?: Linha[];
  respostas?: number[];
  sessoes?: number[];
  falha?: string[]; // tabelas cuja leitura falha
  currentStage?: number;
}) {
  const etapas =
    o.etapas ??
    [101, 102, 103, 104, 105].map((id, i) => ({ id, quiz_version: 2, stage_number: i + 1 }));
  const t: Record<string, Linha[]> = {
    participants: [{ id: "p1", user_id: "u1", event_id: "e1" }],
    events: [
      {
        id: "e1",
        mode: o.mode ?? "async",
        quiz_version: o.versao ?? 2,
        current_stage: o.currentStage ?? 0, // no async nunca anda: 0
        status: "live",
        form_opens_at: new Date(T - 3 * 86_400_000).toISOString(),
        form_closes_at: new Date(T).toISOString(),
      },
    ],
    quiz_stages: etapas,
    quiz_responses: (o.respostas ?? []).map((n) => ({ participant_id: "p1", stage_id: 100 + n })),
    participant_stage_sessions: (o.sessoes ?? []).map((n) => ({ participant_id: "p1", event_id: "e1", stage_id: 100 + n })),
  };
  const cliente: ClienteDeProxima = {
    from(tabela) {
      return {
        select() {
          let linhas = [...(t[tabela] ?? [])];
          const falha = (o.falha ?? []).includes(tabela);
          const q = {
            eq(c: string, v: string | number) {
              linhas = linhas.filter((l) => l[c] === v);
              return q;
            },
            maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: falha ? { code: "XX000" } : null }),
            then: (ok: (v: { data: unknown; error: unknown }) => unknown) =>
              Promise.resolve({ data: falha ? null : linhas, error: falha ? { code: "XX000" } : null }).then(ok),
          };
          return q as never;
        },
      };
    },
  };
  return cliente;
}
const chamar = (c: ClienteDeProxima, agora: number) =>
  calcularProximaEtapa(c, { userId: "u1", participantId: "p1", agora: () => agora });
const destino = async (c: ClienteDeProxima, agora: number) => {
  const r = await chamar(c, agora);
  if (r.tipo !== "ok") throw new Error("esperava ok, veio " + r.tipo);
  return r.resposta;
};

describe("calcularProximaEtapa (assincrono)", () => {
  it("current_stage = 0 (nunca anda no async) e a pessoa e levada a etapa 1; depois a 2, ...; por fim concluido", async () => {
    const trilha: string[] = [];
    const enviadas: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await destino(banco({ respostas: enviadas }), T - 3 * 60 * MIN);
      const d = r.destino!;
      trilha.push(d.tipo === "etapa" ? `etapa ${d.numero}` : d.tipo);
      if (d.tipo !== "etapa") break;
      enviadas.push(d.numero);
    }
    expect(trilha).toEqual(["etapa 1", "etapa 2", "etapa 3", "etapa 4", "etapa 5", "concluido"]);
  });

  it("current_stage alto no async e IGNORADO (nao libera nem bloqueia nada)", async () => {
    const r = await destino(banco({ currentStage: 6, respostas: [1] }), T - 3 * 60 * MIN);
    expect(r.destino).toEqual({ tipo: "etapa", numero: 2 });
  });

  it("a contagem vem da versao do quiz (3 etapas => conclui com 3)", async () => {
    const tres = [101, 102, 103].map((id, i) => ({ id, quiz_version: 2, stage_number: i + 1 }));
    const r = await destino(banco({ etapas: tres, respostas: [1, 2, 3] }), T - 3 * 60 * MIN);
    expect(r.destino).toEqual({ tipo: "concluido" });
    expect(r.total_etapas).toBe(3);
  });

  it("janela: na reta final so vale a etapa ja iniciada (a nao iniciada nunca e destino)", async () => {
    const r = await destino(banco({ respostas: [1], sessoes: [1, 3] }), T - 10 * MIN);
    expect(r.destino).toEqual({ tipo: "etapa", numero: 3 });
    const sem = await destino(banco({ respostas: [1], sessoes: [1] }), T - 10 * MIN);
    expect(sem.destino).toEqual({ tipo: "nenhuma", motivo: "nao_inicia_mais", pendentes: [2, 3, 4, 5] });
  });

  it("depois de T+15 com pendentes: nenhuma/encerrada; com tudo enviado: concluido", async () => {
    const a = await destino(banco({ respostas: [1, 2] , sessoes: [1,2,3]}), T + 16 * MIN);
    expect(a.destino).toMatchObject({ tipo: "nenhuma", motivo: "encerrada", pendentes: [3, 4, 5] });
    const b = await destino(banco({ respostas: [1, 2, 3, 4, 5] }), T + 16 * MIN);
    expect(b.destino).toEqual({ tipo: "concluido" });
  });

  it("NAO DA PARA DETERMINAR: leitura de respostas falha => indisponivel/leitura (nunca etapa 1)", async () => {
    const r = await destino(banco({ falha: ["quiz_responses"] }), T - 3 * 60 * MIN);
    expect(r.destino).toEqual({ tipo: "indisponivel", motivo: "leitura" });
  });
  it("NAO DA PARA DETERMINAR: leitura das sessoes falha => indisponivel/leitura", async () => {
    const r = await destino(banco({ falha: ["participant_stage_sessions"] }), T - 3 * 60 * MIN);
    expect(r.destino).toEqual({ tipo: "indisponivel", motivo: "leitura" });
  });
  it("NAO DA PARA DETERMINAR: leitura das etapas da versao falha => indisponivel/leitura", async () => {
    const r = await destino(banco({ falha: ["quiz_stages"] }), T - 3 * 60 * MIN);
    expect(r.destino).toEqual({ tipo: "indisponivel", motivo: "leitura" });
  });
  it("NAO DA PARA DETERMINAR: versao inconsistente (buraco na numeracao / sem etapas) => indisponivel/configuracao", async () => {
    const buraco = [101, 103].map((id, i) => ({ id, quiz_version: 2, stage_number: i === 0 ? 1 : 3 }));
    expect((await destino(banco({ etapas: buraco }), T - 3 * 60 * MIN)).destino).toEqual({ tipo: "indisponivel", motivo: "configuracao" });
    expect((await destino(banco({ etapas: [] }), T - 3 * 60 * MIN)).destino).toEqual({ tipo: "indisponivel", motivo: "configuracao" });
  });
  it("leitura do evento falha => erro (a rota responde 5xx), nunca palpite", async () => {
    expect((await chamar(banco({ falha: ["events"] }), T)).tipo).toBe("erro");
    expect((await chamar(banco({ falha: ["participants"] }), T)).tipo).toBe("erro");
  });

  it("LIVE: a rota nao decide nada (destino null); current_stage continua mandando no cliente", async () => {
    const r = await destino(banco({ mode: "live", versao: 1, currentStage: 2 }), T);
    expect(r.modo).toBe("live");
    expect(r.destino).toBeNull();
    expect(r.janela).toBeNull();
  });

  it("participante alheio/inexistente recebe a mesma recusa", async () => {
    const c = banco({});
    expect(await calcularProximaEtapa(c, { userId: "outro", participantId: "p1" })).toEqual({ tipo: "nao_autorizado" });
    expect(await calcularProximaEtapa(c, { userId: "u1", participantId: "zzz" })).toEqual({ tipo: "nao_autorizado" });
  });
});
