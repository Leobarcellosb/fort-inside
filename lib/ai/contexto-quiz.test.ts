import { describe, expect, it } from "vitest";
import { criarClienteFalso } from "../testing/cliente-falso";
import { carregarContextoQuiz } from "./contexto-quiz";
import { buildUserPrompt } from "./prognostic-prompt";

const pergunta = (id: string, text: string) => ({ id, type: "text", text });

function banco(extraRespostas: Record<string, unknown>[] = []) {
  const v1 = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: n,
    quiz_version: 1,
    stage_number: n,
    title: `Etapa Fort Inside ${n}`,
    ambient_name: `Ambiente Fort ${n}`,
    description: null,
    questions: [pergunta(`f${n}`, `Pergunta do Fort Inside ${n}`)],
  }));
  const v2 = [101, 102, 103, 104, 105].map((id, i) => ({
    id,
    quiz_version: 2,
    stage_number: i + 1,
    title: `Etapa Marco Zero ${i + 1}`,
    ambient_name: "Marco Zero",
    description: "Contexto do Marco Zero",
    questions: [pergunta(`m${i + 1}`, `Pergunta do Marco Zero ${i + 1}`)],
  }));
  const respostas = (pid: string, stageIds: number[]) =>
    stageIds.map((stage_id) => ({
      id: `${pid}-${stage_id}`,
      participant_id: pid,
      stage_id,
      answers: { [stage_id <= 6 ? `f${stage_id}` : `m${stage_id - 100}`]: "texto" },
    }));
  return criarClienteFalso({
    events: [
      { id: "ev-fort", quiz_version: 1 },
      { id: "ev-marco", quiz_version: 2 },
    ],
    quiz_stages: [...v1, ...v2],
    quiz_responses: [
      ...respostas("p-fort", [1, 2, 3, 4, 5, 6]),
      ...respostas("p-marco", [101, 102, 103, 104, 105]),
      ...respostas("p-fort-parcial", [1, 2, 3]),
      ...extraRespostas,
    ],
  });
}

describe("carregarContextoQuiz", () => {
  it("participante da v1: recebe APENAS as 6 etapas da v1, nada da v2", async () => {
    const r = await carregarContextoQuiz(banco(), "p-fort", "ev-fort");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stages.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.stages.every((s) => s.quiz_version === 1)).toBe(true);
    expect(r.responses.map((x) => x.stage_id).sort()).toEqual([1, 2, 3, 4, 5, 6]);

    // O que de fato vai para o prompt.
    const prompt = buildUserPrompt("Ana", { responses: r.responses, stages: r.stages });
    expect(prompt).toContain("Pergunta do Fort Inside 1");
    expect(prompt).not.toContain("Marco Zero");
    expect(prompt).not.toMatch(/Etapa 10\d/);
  });

  it("participante da v2: recebe APENAS as 5 etapas da v2", async () => {
    const r = await carregarContextoQuiz(banco(), "p-marco", "ev-marco");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stages.map((s) => s.id)).toEqual([101, 102, 103, 104, 105]);
    const prompt = buildUserPrompt("Bia", { responses: r.responses, stages: r.stages });
    expect(prompt).toContain("Pergunta do Marco Zero 1");
    expect(prompt).not.toContain("Fort Inside");
  });

  it("resposta solta de outra versao nao entra nem conta para o gate", async () => {
    // Participante da v1 com uma linha de etapa 101 (nao deveria existir, a RLS
    // impede, mas a leitura nao pode depender disso).
    const c = banco([
      { id: "x", participant_id: "p-fort", stage_id: 101, answers: { m1: "intruso" } },
    ]);
    const r = await carregarContextoQuiz(c, "p-fort", "ev-fort");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.responses.map((x) => x.stage_id)).not.toContain(101);
    expect(JSON.stringify(r.responses)).not.toContain("intruso");
  });

  it("gate: v1 incompleta (3 de 6) continua recusada com 400", async () => {
    const r = await carregarContextoQuiz(banco(), "p-fort-parcial", "ev-fort");
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Participante não completou todas as etapas",
    });
  });

  it("gate: as respostas de uma v1 completa NAO bastam para um evento da v2", async () => {
    const r = await carregarContextoQuiz(banco(), "p-fort", "ev-marco");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("evento inexistente falha, nao devolve etapas de nenhuma versao", async () => {
    const r = await carregarContextoQuiz(banco(), "p-fort", "nao-existe");
    expect(r).toEqual({ ok: false, status: 500, error: "Erro ao buscar etapas" });
  });

  it("toda consulta a quiz_stages leva filtro de versao", async () => {
    const c = banco();
    await carregarContextoQuiz(c, "p-fort", "ev-fort");
    const deEtapas = c.consultas.filter((q) => q.tabela === "quiz_stages");
    expect(deEtapas.length).toBeGreaterThan(0);
    for (const q of deEtapas) expect(q.filtros).toContain("quiz_version=1");
  });

  it("v1 com contagem de etapas diferente de 6 e erro de configuracao", async () => {
    const c = criarClienteFalso({
      events: [{ id: "ev", quiz_version: 1 }],
      quiz_stages: [{ id: 1, quiz_version: 1, stage_number: 1, questions: [] }],
      quiz_responses: [],
    });
    const r = await carregarContextoQuiz(c, "p", "ev");
    expect(r).toEqual({ ok: false, status: 500, error: "Erro ao buscar etapas" });
  });
});
