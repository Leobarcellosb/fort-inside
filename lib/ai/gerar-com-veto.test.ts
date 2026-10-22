import { describe, expect, it, vi } from "vitest";
import {
  MAX_RODADAS_DE_CORRECAO,
  gerarComVeto,
  gerarSemVeto,
  montarPedidoDeCorrecao,
  type SaidaDoModelo,
} from "./gerar-com-veto";
import { verificarSaida } from "./saida-prognostico";
import { prognosticoLimpo } from "./fixtures-prognostico";
import type { PrognosticContent } from "@/types/database";

const json = (o: unknown): SaidaDoModelo => ({ texto: JSON.stringify(o), recusou: false });

function violando(): PrognosticContent {
  const c = prognosticoLimpo();
  c.analise_geral += " Seu eixo dominante é claro.";
  c.areas_chave[1].risco = "O risco é a fragilidade do sono.";
  return c;
}

function dependencias(opcoes: {
  gerada: SaidaDoModelo;
  correcao?: SaidaDoModelo | (() => SaidaDoModelo);
}) {
  const gerar = vi.fn(async () => opcoes.gerada);
  const corrigir = vi.fn(async () => {
    const c = opcoes.correcao;
    if (!c) throw new Error("corrigir nao deveria ter sido chamado");
    return typeof c === "function" ? c() : c;
  });
  return { gerar, corrigir };
}

describe("a politica custa no maximo uma geracao e uma correcao", () => {
  it("MAX_RODADAS_DE_CORRECAO e 1", () => expect(MAX_RODADAS_DE_CORRECAO).toBe(1));

  it("saida limpa: uma chamada, nenhuma correcao", async () => {
    const dep = dependencias({ gerada: json(prognosticoLimpo()) });
    const r = await gerarComVeto(dep);
    expect(r.ok).toBe(true);
    expect(r.chamadas).toEqual({ completas: 1, correcoes: 0 });
    expect(dep.corrigir).not.toHaveBeenCalled();
  });

  it("violou e a correcao limpou: duas chamadas, so os campos recusados mudam", async () => {
    const dep = dependencias({
      gerada: json(violando()),
      correcao: json({
        correcoes: [
          { campo: "analise_geral", texto: prognosticoLimpo().analise_geral },
          { campo: "areas_chave.1.risco", texto: "O risco é decidir cansada e depois rever tudo." },
        ],
      }),
    });
    const r = await gerarComVeto(dep);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chamadas).toEqual({ completas: 1, correcoes: 1 });
    expect(r.camposCorrigidos.sort()).toEqual(["analise_geral", "areas_chave.1.risco"]);
    expect(verificarSaida(r.content)).toEqual([]);
    expect(r.content.areas_chave[0]).toEqual(prognosticoLimpo().areas_chave[0]);
  });

  it("o pedido de correcao leva o campo, a frase culpada e o motivo, e o rascunho recusado", async () => {
    const gerada = json(violando());
    const dep = dependencias({
      gerada,
      correcao: json({ correcoes: [{ campo: "x", texto: "y" }] }),
    });
    await gerarComVeto(dep);
    const [rascunho, pedido] = dep.corrigir.mock.calls[0] as unknown as [string, string];
    expect(rascunho).toBe(gerada.texto);
    expect(pedido).toContain("Campo: analise_geral");
    expect(pedido).toContain("Seu eixo dominante é claro.");
    expect(pedido).toContain("afirma perfil/eixo dominante ou predominante");
    expect(pedido).toContain("Campo: areas_chave.1.risco");
  });

  it("a correcao ainda viola: RECUSA 422, e nao ha terceira chamada", async () => {
    const dep = dependencias({
      gerada: json(violando()),
      correcao: json({
        correcoes: [
          { campo: "analise_geral", texto: "Continua dominante." },
          { campo: "areas_chave.1.risco", texto: "O risco é a fragilidade." },
        ],
      }),
    });
    const r = await gerarComVeto(dep);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.chamadas).toEqual({ completas: 1, correcoes: 1 });
    expect(dep.gerar).toHaveBeenCalledTimes(1);
    expect(dep.corrigir).toHaveBeenCalledTimes(1);
    // o corpo da recusa nao carrega texto do participante
    expect(JSON.stringify(r.detail)).not.toContain("Continua dominante");
    expect(r.violacoes?.map((v) => v.campo).sort()).toEqual(["analise_geral", "areas_chave.1.risco"]);
  });

  it("um campo corrigido e outro ainda violando: recusa (documento so passa inteiro)", async () => {
    const dep = dependencias({
      gerada: json(violando()),
      correcao: json({
        correcoes: [
          { campo: "analise_geral", texto: "Texto limpo." },
          { campo: "areas_chave.1.risco", texto: "O risco é o pior cenário." },
        ],
      }),
    });
    const r = await gerarComVeto(dep);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.violacoes?.map((v) => v.campo)).toEqual(["areas_chave.1.risco"]);
  });

  it("correcao que nao cobre exatamente os campos pedidos: recusa", async () => {
    for (const correcoes of [
      [{ campo: "analise_geral", texto: "Limpo." }], // faltou um
      [
        { campo: "analise_geral", texto: "Limpo." },
        { campo: "areas_chave.1.risco", texto: "O risco é limpo." },
        { campo: "praticas.0.nome", texto: "Registrar" }, // sobrou um
      ],
      [
        { campo: "analise_geral", texto: "Limpo." },
        { campo: "analise_geral", texto: "Limpo de novo." }, // duplicado
      ],
    ]) {
      const dep = dependencias({ gerada: json(violando()), correcao: json({ correcoes }) });
      const r = await gerarComVeto(dep);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(422);
    }
  });

  it("correcao ilegivel ou fora do formato: recusa", async () => {
    for (const correcao of [
      { texto: "isto nao e json", recusou: false },
      json({ qualquer: "coisa" }),
    ]) {
      const dep = dependencias({ gerada: json(violando()), correcao });
      const r = await gerarComVeto(dep);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(422);
    }
  });

  it("o modelo recusa a correcao: 502, nada gravado", async () => {
    const dep = dependencias({
      gerada: json(violando()),
      correcao: { texto: "", recusou: true },
    });
    const r = await gerarComVeto(dep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(502);
  });
});

describe("falhas que NAO gastam correcao", () => {
  it("o modelo recusa a geracao: 502 sem correcao", async () => {
    const dep = dependencias({ gerada: { texto: "", recusou: true } });
    const r = await gerarComVeto(dep);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(dep.corrigir).not.toHaveBeenCalled();
  });

  it("JSON invalido: 500 sem correcao", async () => {
    const dep = dependencias({ gerada: { texto: "{nao e json", recusou: false } });
    const r = await gerarComVeto(dep);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(dep.corrigir).not.toHaveBeenCalled();
  });

  it("estrutura invalida: 500 sem correcao", async () => {
    const dep = dependencias({ gerada: json({ analise_geral: "x" }) });
    const r = await gerarComVeto(dep);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(dep.corrigir).not.toHaveBeenCalled();
  });
});

describe("gerarSemVeto (Fort Inside)", () => {
  it("nao verifica o veto: devolve o conteudo como veio", async () => {
    const r = await gerarSemVeto(async () => json(violando()));
    expect(r.ok).toBe(true);
    expect(r.chamadas).toEqual({ completas: 1, correcoes: 0 });
  });
});

describe("montarPedidoDeCorrecao", () => {
  it("nao inclui campos sem violacao", () => {
    const pedido = montarPedidoDeCorrecao(verificarSaida(violando()));
    expect(pedido).not.toContain("Campo: praticas.0");
  });
});
