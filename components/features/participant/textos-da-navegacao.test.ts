import { describe, expect, it } from "vitest";
import { MSG_NAVEGACAO_LOGIN, montarTelaDaNavegacao, type EstadoDaNavegacao } from "./textos-da-navegacao";

const MIN = 60_000;
const T = Date.parse("2026-10-22T03:00:00Z");
const janela = { abre: T - 5 * 86_400_000, fecha: T };
const JARGAO = /42501|permiss|rls|policy|postgres|constraint|row-level|erro de banco|null|current_stage/i;
const CULPA = /voc[eê] (n[aã]o |deveria|esqueceu|demorou|perdeu|atrasou)|sua culpa/i;

const nenhuma = (motivo: "ainda_nao_abriu" | "nao_inicia_mais" | "encerrada", agora: number, extra = {}): EstadoDaNavegacao => ({
  tipo: "nenhuma", motivo, pendentes: [3, 4, 5], enviadas: 2, total: 5, janela, agora, ...extra,
});
const tudo = (e: EstadoDaNavegacao) => {
  const t = montarTelaDaNavegacao(e);
  return [t.titulo, ...t.corpo].join(" ");
};

describe("textos da navegacao assincrona", () => {
  const estados: [string, EstadoDaNavegacao][] = [
    ["ainda nao abriu", nenhuma("ainda_nao_abriu", janela.abre - MIN)],
    ["nao inicia mais", nenhuma("nao_inicia_mais", T - 10 * MIN)],
    ["encerrada", nenhuma("encerrada", T + 20 * MIN)],
    ["leitura", { tipo: "indisponivel", causa: "leitura" }],
    ["configuracao", { tipo: "indisponivel", causa: "configuracao" }],
    ["conclusao", { tipo: "indisponivel", causa: "conclusao" }],
  ];
  it.each(estados)("%s: sem jargao e sem culpa", (_n, e) => {
    expect(tudo(e)).not.toMatch(JARGAO);
    expect(tudo(e)).not.toMatch(CULPA);
  });

  it("encerrada diz quantas enviou, quais faltam e que o enviado esta guardado", () => {
    const t = tudo(nenhuma("encerrada", T + 20 * MIN));
    expect(t).toMatch(/Você enviou 2 de 5 etapas/);
    expect(t).toMatch(/As etapas 3, 4 e 5 não foram enviadas/);
    expect(t).toMatch(/guardado/);
  });
  it("nao inicia mais: cita o limite e que as etapas nao tinham sido comecadas", () => {
    const t = tudo(nenhuma("nao_inicia_mais", T - 10 * MIN));
    expect(t).toMatch(/não tinham sido começadas/);
    expect(t).toMatch(/o limite era às 23h45/);
    expect(t).not.toMatch(/era até/);
  });
  it("singular e zero enviadas", () => {
    expect(tudo(nenhuma("encerrada", T + 20 * MIN, { pendentes: [5], enviadas: 4 }))).toMatch(/A etapa 5 não foi enviada/);
    expect(tudo(nenhuma("encerrada", T + 20 * MIN, { enviadas: 0 }))).toMatch(/ainda não enviou nenhuma etapa/);
  });
  it("so a falha de leitura e a de conclusao oferecem 'Tentar de novo'; configuracao nao (nao adianta)", () => {
    expect(montarTelaDaNavegacao({ tipo: "indisponivel", causa: "leitura" }).tentarDeNovo).toBe(true);
    expect(montarTelaDaNavegacao({ tipo: "indisponivel", causa: "conclusao" }).tentarDeNovo).toBe(true);
    expect(montarTelaDaNavegacao({ tipo: "indisponivel", causa: "configuracao" }).tentarDeNovo).toBe(false);
  });
  it("login ausente usa o texto de sessao expirada; os demais NAO", () => {
    expect(montarTelaDaNavegacao({ tipo: "indisponivel", causa: "login" }).titulo).toBe(MSG_NAVEGACAO_LOGIN);
    for (const [, e] of estados) expect(tudo(e)).not.toMatch(/sessão expirou/);
  });
  it("indisponibilidade nunca fala em 'etapa 1' nem sugere uma etapa", () => {
    for (const causa of ["leitura", "configuracao", "conclusao"] as const) {
      expect(tudo({ tipo: "indisponivel", causa })).not.toMatch(/etapa 1|próxima etapa é/i);
    }
  });
});
