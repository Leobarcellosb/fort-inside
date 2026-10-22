import { describe, expect, it } from "vitest";
import { criarClienteFalso } from "../testing/cliente-falso";
import { carregarEtapa, lerNumeroDaEtapa, rotuloDaEtapa } from "./carregar-etapa";

const perguntas = (ids: string[]) => ids.map((id) => ({ id, type: "text", text: id }));

// Reproduz a situacao de producao APOS a 017: as duas versoes no mesmo banco.
// A v1 tem stage_number = id; a v2 tem ids 101..105 e stage_number 1..5.
function banco() {
  const v1 = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: n,
    quiz_version: 1,
    stage_number: n,
    title: `Fort ${n}`,
    ambient_name: `Ambiente ${n}`,
    questions: perguntas([`f${n}a`, `f${n}b`]),
  }));
  const v2 = [101, 102, 103, 104, 105].map((id, i) => ({
    id,
    quiz_version: 2,
    stage_number: i + 1,
    title: `Marco ${i + 1}`,
    ambient_name: "Marco Zero",
    questions: perguntas([`m${i + 1}`]),
  }));
  return criarClienteFalso({
    events: [
      { id: "ev-fort", quiz_version: 1 },
      { id: "ev-marco", quiz_version: 2 },
    ],
    quiz_stages: [...v1, ...v2],
  });
}

describe("lerNumeroDaEtapa / rotuloDaEtapa", () => {
  it("aceita so inteiro positivo sem sufixo", () => {
    expect(lerNumeroDaEtapa("1")).toBe(1);
    expect(lerNumeroDaEtapa("5")).toBe(5);
    for (const ruim of ["0", "-1", "01", "1abc", "1.5", "", "abc"]) {
      expect(lerNumeroDaEtapa(ruim)).toBeNull();
    }
  });

  it("o rotulo usa o total da versao", () => {
    expect(rotuloDaEtapa(1, 5)).toBe("Etapa 1 de 5");
    expect(rotuloDaEtapa(6, 6)).toBe("Etapa 6 de 6");
  });
});

describe("carregarEtapa: evento da v2 (Marco Zero)", () => {
  it("a etapa 1 abre como id 101, com 'Etapa 1 de 5'", async () => {
    const r = await carregarEtapa(banco(), "ev-marco", 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.etapa.id).toBe(101);
    expect(r.etapa.stage_number).toBe(1);
    expect(r.totalEtapas).toBe(5);
    expect(rotuloDaEtapa(1, r.totalEtapas)).toBe("Etapa 1 de 5");
  });

  it("as cinco etapas abrem, nenhuma sexta", async () => {
    const ids: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await carregarEtapa(banco(), "ev-marco", n);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.etapa.id);
    }
    expect(ids).toEqual([101, 102, 103, 104, 105]);
    expect(await carregarEtapa(banco(), "ev-marco", 6)).toEqual({
      ok: false,
      motivo: "etapa_inexistente",
    });
  });

  it("o id cru nao abre: /quiz/101 e etapa inexistente", async () => {
    expect(await carregarEtapa(banco(), "ev-marco", 101)).toEqual({
      ok: false,
      motivo: "etapa_inexistente",
    });
  });
});

describe("carregarEtapa: evento da v1 (Fort Inside), controle de nao-regressao", () => {
  it("as seis etapas abrem com id = numero e 'Etapa N de 6'", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const r = await carregarEtapa(banco(), "ev-fort", n);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.etapa.id).toBe(n);
      expect(r.etapa.quiz_version).toBe(1);
      expect(r.etapa.title).toBe(`Fort ${n}`);
      expect(r.totalEtapas).toBe(6);
      expect(rotuloDaEtapa(n, r.totalEtapas)).toBe(`Etapa ${n} de 6`);
    }
  });

  it("nao enxerga etapa da v2 nem pelo id 101", async () => {
    expect(await carregarEtapa(banco(), "ev-fort", 101)).toEqual({
      ok: false,
      motivo: "etapa_inexistente",
    });
    expect(await carregarEtapa(banco(), "ev-fort", 7)).toEqual({
      ok: false,
      motivo: "etapa_inexistente",
    });
  });
});

describe("carregarEtapa: entradas invalidas", () => {
  it("evento inexistente", async () => {
    expect(await carregarEtapa(banco(), "nao-existe", 1)).toEqual({
      ok: false,
      motivo: "evento_inexistente",
    });
  });

  it("numero invalido nem consulta o banco", async () => {
    const c = banco();
    expect(await carregarEtapa(c, "ev-fort", Number.NaN)).toEqual({
      ok: false,
      motivo: "numero_invalido",
    });
    expect(await carregarEtapa(c, "ev-fort", 0)).toEqual({
      ok: false,
      motivo: "numero_invalido",
    });
    expect(c.consultas).toHaveLength(0);
  });

  it("toda consulta a quiz_stages leva filtro de versao", async () => {
    const c = banco();
    await carregarEtapa(c, "ev-marco", 2);
    const deEtapas = c.consultas.filter((q) => q.tabela === "quiz_stages");
    expect(deEtapas.length).toBeGreaterThan(0);
    for (const q of deEtapas) expect(q.filtros).toContain("quiz_version=2");
  });
});
