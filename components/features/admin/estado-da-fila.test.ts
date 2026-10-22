import { describe, expect, it } from "vitest";
import { interpretarRespostaDaFila } from "./estado-da-fila";
import { CODIGOS_DE_ERRO, DEFINICOES_DE_ERRO } from "../../../lib/erros/codigos";
import { erroHttp } from "../../../lib/erros/resposta";
import { codigoDeFalhaDeFila } from "../../../lib/erros/falha-de-fila";

// O que o painel conclui da leitura da fila. Cada negativa vem COM o controle
// positivo ao lado: a mesma função, a mesma forma de chamada, o fluxo legítimo.

const ok = { event_id: "e", resumo: {}, atencao: [], jobs: [] };

describe("interpretarRespostaDaFila", () => {
  it("CONTROLE POSITIVO: 200 com jobs -> ok (inclusive lista vazia: 'ninguém na fila' não é falha)", () => {
    expect(interpretarRespostaDaFila(200, ok).fila).toBe("ok");
    expect(interpretarRespostaDaFila(200, { ...ok, jobs: [{ id: "j" }] }).fila).toBe("ok");
  });

  it("NEGATIVA: QUEUE_SCHEMA_MISSING é a ÚNICA causa que vira 'indisponivel' (mensagem da migration 018)", () => {
    const r = interpretarRespostaDaFila(503, { code: "QUEUE_SCHEMA_MISSING", error: "x", ocorrencia: "abc123" });
    expect(r).toEqual({ fila: "indisponivel", codigo: "QUEUE_SCHEMA_MISSING", ocorrencia: "abc123" });
  });

  it("NEGATIVA PAREADA: todo outro código do vocabulário vira 'sem_resposta', nunca 'indisponivel'", () => {
    const outros = CODIGOS_DE_ERRO.filter((c) => c !== "QUEUE_SCHEMA_MISSING");
    expect(outros.length).toBeGreaterThanOrEqual(13);
    for (const c of outros) {
      const r = interpretarRespostaDaFila(DEFINICOES_DE_ERRO[c].status, { code: c });
      expect(r.fila, c).toBe("sem_resposta");
    }
  });

  it.each([
    ["500 'Erro' sem código (a regra antiga mandava para a migration)", 500, { error: "Erro" }],
    ["503 sem código", 503, { error: "falha" }],
    ["502 de proxy, corpo não-JSON", 502, null],
    ["500 com texto de banco no corpo e sem código", 500, { error: 'relation "jobs" does not exist', detail: "42P01" }],
    ["código fora do vocabulário", 503, { code: "QUEUE_SCHEMA_MISSING_V2" }],
    ["401 sem código", 401, {}],
    ["200 com formato inesperado", 200, { jobs: "nao-e-lista" }],
    ["200 sem corpo", 200, null],
  ])("NEGATIVA: %s -> 'sem_resposta' (não inventa a migration)", (_n, status, corpo) => {
    expect(interpretarRespostaDaFila(status, corpo).fila).toBe("sem_resposta");
  });

  it("composição com o servidor real: o corpo que erroHttp monta, interpretado pela tela", async () => {
    const casos: [Parameters<typeof erroHttp>[0], string][] = [
      ["QUEUE_SCHEMA_MISSING", "indisponivel"],
      ["QUEUE_UNAVAILABLE", "sem_resposta"],
      ["AUTH_UNAVAILABLE", "sem_resposta"],
      ["AUTH_REQUIRED", "sem_resposta"],
      ["ADMIN_FORBIDDEN", "sem_resposta"],
      ["INTERNAL_ERROR", "sem_resposta"],
    ];
    for (const [c, esperado] of casos) {
      const resp = erroHttp(c);
      const corpo = await resp.json();
      expect(interpretarRespostaDaFila(resp.status, corpo).fila, c).toBe(esperado);
    }
  });

  it("a classificação da fila que a rota usa: função ou tabela ausente x resto", () => {
    expect(codigoDeFalhaDeFila({ code: "PGRST202", message: "Could not find the function public.jobs_resumo_evento" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDeFalhaDeFila({ code: "PGRST205", message: "Could not find the table 'public.jobs' in the schema cache" })).toBe("QUEUE_SCHEMA_MISSING");
    // pelo CÓDIGO, sem depender do texto da mensagem
    expect(codigoDeFalhaDeFila({ code: "PGRST205", message: "mensagem opaca" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDeFalhaDeFila({ code: "PGRST202", message: "mensagem opaca" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDeFalhaDeFila({ code: "57014", message: "statement timeout" })).toBe("QUEUE_UNAVAILABLE");
    expect(codigoDeFalhaDeFila({ code: "", message: "TypeError: fetch failed" })).toBe("QUEUE_UNAVAILABLE");
    expect(codigoDeFalhaDeFila(null)).toBe("QUEUE_UNAVAILABLE");
  });
});
