import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MENSAGEM_GENERICA } from "../../../lib/erros/mensagens-host";
import {
  MENSAGEM_FILA_INDISPONIVEL,
  solicitarProcessamento,
  textoDoEnfileiramento,
  type Fetcher,
} from "./processar-evento";

function falso(resposta: () => Response | Promise<Response>) {
  const chamadas: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    chamadas.push({ url, init });
    return resposta();
  };
  return { fetcher, chamadas };
}
const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

describe("Processar = enfileirar (critério 1 e 8)", () => {
  it("sucesso: chama SOMENTE /api/jobs/enfileirar, com o evento, e nunca o lote", async () => {
    const f = falso(() => json(200, { ok: true, total_participantes: 4, criados: 4, reaproveitados: 0, com_erro: [] }));
    const r = await solicitarProcessamento("evt-1", f.fetcher);
    expect(r).toEqual({ tipo: "enfileirado", totalParticipantes: 4, criados: 4, reaproveitados: 0 });
    expect(f.chamadas.map((c) => c.url)).toEqual(["/api/jobs/enfileirar"]);
    expect(JSON.parse(String(f.chamadas[0].init?.body))).toEqual({ event_id: "evt-1" });
  });

  it("clique repetido: tudo reaproveitado, ninguém novo, e o texto diz isso", async () => {
    const f = falso(() => json(200, { ok: true, total_participantes: 4, criados: 0, reaproveitados: 4, com_erro: [] }));
    const r = await solicitarProcessamento("evt-1", f.fetcher);
    expect(textoDoEnfileiramento(r)).toBe("Ninguém novo entrou na fila: todos já estavam nela.");
  });

  it("QUEUE_SCHEMA_MISSING (503): única causa que manda aplicar a migration 018, e UMA chamada só, sem cair no lote", async () => {
    const f = falso(() => json(503, { error: "texto interno", code: "QUEUE_SCHEMA_MISSING", ocorrencia: "abc123def456" }));
    const r = await solicitarProcessamento("evt-1", f.fetcher, () => {});
    expect(r).toMatchObject({ tipo: "fila_indisponivel", codigo: "QUEUE_SCHEMA_MISSING", mensagem: MENSAGEM_FILA_INDISPONIVEL });
    expect(f.chamadas).toHaveLength(1);
    expect(f.chamadas.every((c) => !c.url.includes("batch-process"))).toBe(true);
    expect(MENSAGEM_FILA_INDISPONIVEL).toContain("migration 018");
    expect(MENSAGEM_FILA_INDISPONIVEL).toContain("lote foi descontinuado");
  });

  it.each([
    ["500 com o corpo genérico 'Erro'", () => json(500, { error: "Erro" })],
    ["502 de proxy, corpo não-JSON", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["503 sem código", () => json(503, { error: "falha qualquer" })],
  ])("SEM código do vocabulário (%s): mensagem genérica, nunca a da migration", async (_nome, resp) => {
    const f = falso(resp);
    const registros: unknown[] = [];
    const r = await solicitarProcessamento("evt-1", f.fetcher, (x) => registros.push(x));
    expect(r.tipo).toBe("erro_inesperado");
    if (r.tipo === "erro_inesperado") {
      expect(r.mensagem).toContain(MENSAGEM_GENERICA);
      expect(r.mensagem).toContain(r.ocorrencia);
      expect(r.mensagem.replace(/Ocorrência: [A-Za-z0-9_-]+\.?/g, "")).not.toMatch(/migration|018/);
    }
    expect(registros).toHaveLength(1);
    expect(f.chamadas).toHaveLength(1);
  });

  it("falha parcial é dita como parcial, com quantas pessoas ficaram de fora", async () => {
    const f = falso(() => json(200, { ok: false, total_participantes: 4, criados: 2, reaproveitados: 1, com_erro: [{}] }));
    const r = await solicitarProcessamento("evt-1", f.fetcher);
    expect(r).toEqual({ tipo: "parcial", criados: 2, reaproveitados: 1, semFila: 1 });
    expect(textoDoEnfileiramento(r)).toContain("1 não conseguiram entrar");
  });

  it("400/403 COM código são recusa (a mensagem vem do código, não do texto do servidor)", async () => {
    const a = await solicitarProcessamento("e", falso(() => json(400, { error: "Evento não completou as 6 etapas", code: "EVENT_INCOMPLETE", detalhes: { etapa_atual: 4, total_etapas: 6 } })).fetcher);
    expect(a.tipo).toBe("recusado");
    expect(a.tipo === "recusado" && a.mensagem).toContain("etapa 4 de 6");
    const b = await solicitarProcessamento("e", falso(() => json(403, { error: "Não autorizado", code: "ADMIN_FORBIDDEN" })).fetcher);
    expect(b).toMatchObject({ tipo: "recusado", codigo: "ADMIN_FORBIDDEN" });
  });

  it("sem rede: diz que nada foi enviado", async () => {
    const r = await solicitarProcessamento("e", async () => {
      throw new TypeError("fetch failed");
    });
    expect(r.tipo).toBe("sem_conexao");
    expect(textoDoEnfileiramento(r)).toContain("Nada foi enviado");
  });
});

describe("o lote antigo não é chamado por nenhum arquivo da tela (critério 1)", () => {
  const arquivos = ["LiveControlPanel.tsx", "SituacaoPrognosticos.tsx", "processar-evento.ts"];
  it.each(arquivos)("%s não referencia /api/batch-process como destino de requisição", (nome) => {
    const fonte = readFileSync(new URL(`./${nome}`, import.meta.url), "utf8");
    expect(fonte).not.toMatch(/["'`]\/api\/batch-process/);
    expect(fonte).not.toMatch(/fetch\([^)]*batch-process/);
  });
});
