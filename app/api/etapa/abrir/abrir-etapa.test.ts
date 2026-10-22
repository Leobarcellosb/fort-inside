import { describe, expect, it } from "vitest";
import { abrirEtapa, type ClienteDeAbertura } from "./abrir-etapa";

const MIN = 60_000;
const T = Date.parse("2026-10-22T03:00:00Z"); // 00h00 em Brasilia

type Linha = Record<string, unknown>;

// Banco falso: aplica eq de verdade; insert vai para a tabela, a menos que a
// regra injetada recuse (simulando a policy / o indice unico do banco).
function banco(opts: {
  mode?: "live" | "async";
  fecha?: number | null;
  abre?: number | null;
  sessoes?: Linha[];
  recusaInsert?: { code: string } | null;
  insertDuranteCorrida?: boolean;
}) {
  const t: Record<string, Linha[]> = {
    participants: [{ id: "p1", user_id: "u1", event_id: "e1" }],
    events: [
      {
        id: "e1",
        mode: opts.mode ?? "async",
        quiz_version: 2,
        form_opens_at: opts.abre === null ? null : new Date(opts.abre ?? T - 86_400_000).toISOString(),
        form_closes_at: opts.fecha === null ? null : new Date(opts.fecha ?? T).toISOString(),
      },
    ],
    quiz_stages: [101, 102, 103].map((id, i) => ({ id, quiz_version: 2, stage_number: i + 1 })),
    participant_stage_sessions: opts.sessoes ?? [],
  };
  const inserts: Linha[] = [];
  const cliente: ClienteDeAbertura = {
    from(tabela) {
      return {
        select() {
          let linhas = [...(t[tabela] ?? [])];
          const q = {
            eq(c: string, v: string | number) {
              linhas = linhas.filter((l) => l[c] === v);
              return q;
            },
            maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
            then: (ok: (v: { data: unknown; error: null }) => unknown) =>
              Promise.resolve({ data: linhas, error: null }).then(ok),
          };
          return q as never;
        },
        async insert(valores) {
          inserts.push(valores);
          if (opts.recusaInsert) {
            if (opts.insertDuranteCorrida) {
              t.participant_stage_sessions.push({
                ...valores,
                started_at: new Date(T - 20 * MIN).toISOString(),
                status: "open",
              });
            }
            return { error: { code: opts.recusaInsert.code, message: "texto interno do banco" } };
          }
          t.participant_stage_sessions.push({
            ...valores,
            started_at: new Date(T - 20 * MIN).toISOString(),
            status: "open",
          });
          return { error: null };
        },
      };
    },
  };
  return { cliente, inserts, t };
}

const entrada = (agora: number, numero = 1) => ({
  userId: "u1",
  participantId: "p1",
  numeroDaEtapa: numero,
  agora: () => agora,
});

describe("abrirEtapa", () => {
  it("controle positivo: janela aberta, cria a sessao e devolve o estado", async () => {
    const { cliente, inserts } = banco({});
    const r = await abrirEtapa(cliente, entrada(T - 3600_000, 2));
    expect(r.tipo).toBe("ok");
    if (r.tipo !== "ok") return;
    expect(inserts).toEqual([
      { event_id: "e1", participant_id: "p1", stage_id: 102, quiz_version: 2 },
    ]);
    expect(r.resposta.recem_criada).toBe(true);
    expect(r.resposta.sessao?.status).toBe("open");
    expect(r.resposta.etapas_iniciadas).toEqual([2]);
    expect(r.resposta.total_etapas).toBe(3);
    expect(r.resposta.motivo_recusa).toBeNull();
  });

  it("o cliente nao informa started_at nem status: o insert so leva as 4 colunas permitidas", async () => {
    const { cliente, inserts } = banco({});
    await abrirEtapa(cliente, entrada(T - 3600_000));
    expect(Object.keys(inserts[0]).sort()).toEqual(
      ["event_id", "participant_id", "quiz_version", "stage_id"].sort(),
    );
  });

  it("abrir de novo devolve o MESMO registro e nem tenta inserir (nao renova prazo)", async () => {
    const { cliente, inserts } = banco({});
    const a = await abrirEtapa(cliente, entrada(T - 3600_000));
    const b = await abrirEtapa(cliente, entrada(T - 3000_000));
    if (a.tipo !== "ok" || b.tipo !== "ok") throw new Error("esperava ok");
    expect(inserts).toHaveLength(1);
    expect(b.resposta.recem_criada).toBe(false);
    expect(b.resposta.sessao?.iniciada_em).toBe(a.resposta.sessao?.iniciada_em);
  });

  it("sessao existente continua valendo depois de T-15 (reta final) e depois de T (tolerancia)", async () => {
    const { cliente, inserts } = banco({
      sessoes: [{ participant_id: "p1", event_id: "e1", stage_id: 101, started_at: new Date(T - 20 * MIN).toISOString(), status: "open" }],
    });
    for (const agora of [T - 10 * MIN, T + 5 * MIN, T + 30 * MIN]) {
      const r = await abrirEtapa(cliente, entrada(agora));
      if (r.tipo !== "ok") throw new Error("esperava ok");
      expect(r.resposta.sessao).not.toBeNull();
      expect(r.resposta.motivo_recusa).toBeNull();
    }
    expect(inserts).toHaveLength(0);
  });

  it("caso canonico: 23h50 sem sessao e recusado (e nem vai ao banco)", async () => {
    const { cliente, inserts } = banco({});
    const r = await abrirEtapa(cliente, entrada(T - 10 * MIN));
    if (r.tipo !== "ok") throw new Error("esperava ok");
    expect(r.resposta.sessao).toBeNull();
    expect(r.resposta.motivo_recusa).toBe("nao_inicia_mais");
    expect(inserts).toHaveLength(0);
  });

  it("depois de T+15 e antes de abrir, com motivos proprios", async () => {
    const { cliente } = banco({});
    const tarde = await abrirEtapa(cliente, entrada(T + 16 * MIN));
    const cedo = await abrirEtapa(cliente, entrada(T - 2 * 86_400_000));
    if (tarde.tipo !== "ok" || cedo.tipo !== "ok") throw new Error("esperava ok");
    expect(tarde.resposta.motivo_recusa).toBe("encerrada");
    expect(cedo.resposta.motivo_recusa).toBe("ainda_nao_abriu");
  });

  it("o banco recusa (42501) onde o relogio local achava que cabia: vira motivo, nunca erro cru", async () => {
    const { cliente } = banco({ recusaInsert: { code: "42501" } });
    const r = await abrirEtapa(cliente, entrada(T - 15 * MIN)); // exatamente no limite
    expect(r.tipo).toBe("ok");
    if (r.tipo !== "ok") return;
    expect(r.resposta.sessao).toBeNull();
    expect(r.resposta.motivo_recusa).not.toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/42501|texto interno/);
  });

  it("corrida: 23505 no insert e sucesso (outra requisicao criou a mesma sessao)", async () => {
    const { cliente } = banco({ recusaInsert: { code: "23505" }, insertDuranteCorrida: true });
    const r = await abrirEtapa(cliente, entrada(T - 3600_000));
    if (r.tipo !== "ok") throw new Error("esperava ok");
    expect(r.resposta.sessao).not.toBeNull();
    expect(r.resposta.recem_criada).toBe(false);
  });

  it("erro inesperado do banco nao vaza: tipo 'erro' (a rota responde 500 generico)", async () => {
    const { cliente } = banco({ recusaInsert: { code: "XX000" } });
    const r = await abrirEtapa(cliente, entrada(T - 3600_000));
    expect(r.tipo).toBe("erro");
  });

  it("modo live: nao cria nada, nao devolve janela", async () => {
    const { cliente, inserts } = banco({ mode: "live", fecha: null, abre: null });
    const r = await abrirEtapa(cliente, entrada(T));
    if (r.tipo !== "ok") throw new Error("esperava ok");
    expect(inserts).toHaveLength(0);
    expect(r.resposta.modo).toBe("live");
    expect(r.resposta.janela).toBeNull();
  });

  it("sem form_closes_at a janela nao fecha", async () => {
    const { cliente } = banco({ fecha: null });
    const r = await abrirEtapa(cliente, entrada(T + 999 * 86_400_000));
    if (r.tipo !== "ok") throw new Error("esperava ok");
    expect(r.resposta.sessao).not.toBeNull();
  });

  it("participante de outra pessoa e inexistente recebem a MESMA resposta; etapa inexistente e 404", async () => {
    const { cliente } = banco({});
    const alheio = await abrirEtapa(cliente, { ...entrada(T), userId: "outro" });
    const inexistente = await abrirEtapa(cliente, { ...entrada(T), participantId: "zzz" });
    expect(alheio).toEqual({ tipo: "nao_autorizado" });
    expect(inexistente).toEqual({ tipo: "nao_autorizado" });
    const etapa9 = await abrirEtapa(cliente, entrada(T - 3600_000, 9));
    expect(etapa9).toEqual({ tipo: "nao_encontrado" });
  });
});
