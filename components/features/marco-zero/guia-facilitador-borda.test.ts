// A borda da TELA do guia: cada codigo do servidor chega na classe certa, e a
// classe de "nao deu para verificar" NAO e a de recusa.

import { describe, expect, it } from "vitest";
import { mensagemParaHost } from "../../../lib/erros/mensagens-host";
import { MENSAGEM_SEM_CONEXAO, pedirGuiaDoFacilitador } from "./guia-facilitador-borda";

const EVENTO = "11111111-1111-4111-8111-111111111111";

function resposta(status: number, corpo: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const GUIA_OK = {
  ok: true,
  conteudo_sha256: "a".repeat(64),
  motivo_sem_dna: "dna_nao_publicado",
  populacoes: { convidados: 36, leiturasIndividuaisLiberadas: 0 },
  acesso_individual: { idsLiberados: [] },
  texto: "MARCO ZERO: MATERIAL RESTRITO AO FACILITADOR\n...",
};

describe("borda da tela do guia do facilitador", () => {
  it("guia entregue: a tela recebe o texto e o hash", async () => {
    const d = await pedirGuiaDoFacilitador(EVENTO, resposta(200, GUIA_OK));
    expect(d.tipo).toBe("gerado");
    if (d.tipo !== "gerado") throw new Error("esperava gerado");
    expect(d.guia.conteudo_sha256).toBe("a".repeat(64));
    expect(d.guia.motivo_sem_dna).toBe("dna_nao_publicado");
  });

  it("200 com corpo fora de forma NAO passa por guia", async () => {
    for (const corpo of [{ ok: true }, { ...GUIA_OK, conteudo_sha256: "curto" }, { ok: false }]) {
      const d = await pedirGuiaDoFacilitador(EVENTO, resposta(200, corpo));
      expect(d.tipo, JSON.stringify(corpo)).toBe("erro_inesperado");
    }
  });

  it("cada motivo previsto chega na classe certa, com a mensagem do codigo", async () => {
    const casos = [
      ["GUIDE_DNA_PUBLISHED", 400, "recusado"],
      ["GUIDE_DATA_INCONSISTENT", 400, "recusado"],
      ["GUIDE_DNA_STATE_UNVERIFIABLE", 503, "bloqueado"],
      ["COVERAGE_UNAVAILABLE", 503, "bloqueado"],
      ["INVITE_COUNT_UNDETERMINED", 503, "bloqueado"],
      ["ADMIN_FORBIDDEN", 403, "recusado"],
      ["AUTH_REQUIRED", 401, "recusado"],
      ["AUTH_UNAVAILABLE", 503, "bloqueado"],
    ] as const;
    for (const [code, status, tipo] of casos) {
      const d = await pedirGuiaDoFacilitador(
        EVENTO,
        resposta(status, { error: "Erro", code, ocorrencia: "abc123def456" }),
      );
      expect(d.tipo, code).toBe(tipo);
      if (d.tipo !== "recusado" && d.tipo !== "bloqueado") throw new Error("classe errada");
      expect(d.mensagem).toBe(mensagemParaHost(code));
      expect(d.ocorrencia).toBe("abc123def456");
    }
  });

  it("a tela nunca exibe o texto do servidor, nem texto interno de banco", async () => {
    const d = await pedirGuiaDoFacilitador(
      EVENTO,
      resposta(503, {
        error: 'PGRST202 relation "event_logs" does not exist (SQLSTATE 42P01)',
        code: "GUIDE_DNA_STATE_UNVERIFIABLE",
      }),
    );
    if (d.tipo !== "bloqueado") throw new Error("esperava bloqueado");
    expect(d.mensagem).not.toMatch(/PGRST|SQLSTATE|relation/);
  });

  it("codigo desconhecido ou ausente vira mensagem generica segura", async () => {
    for (const corpo of [{ error: "Erro" }, { error: "Erro", code: "ALGO_NOVO" }]) {
      const d = await pedirGuiaDoFacilitador(EVENTO, resposta(500, corpo));
      expect(d.tipo).toBe("erro_inesperado");
    }
  });

  it("sem conexao: nada foi gerado, e a tela diz isso", async () => {
    const d = await pedirGuiaDoFacilitador(EVENTO, (async () => {
      throw new Error("falha de rede");
    }) as unknown as typeof fetch);
    expect(d).toEqual({ tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO });
  });
});
