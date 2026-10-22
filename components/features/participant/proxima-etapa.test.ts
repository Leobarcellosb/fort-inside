import { describe, expect, it } from "vitest";
import { decidirDestino } from "./proxima-etapa";

const MIN = 60_000;
const T = Date.parse("2026-10-22T03:00:00Z");
const aberta = { abre: T - 3 * 86_400_000, fecha: T };
const base = { totalEtapas: 5, enviadas: [] as number[], iniciadas: [] as number[], agora: T - 3 * 60 * MIN, janela: aberta };

describe("decidirDestino (assincrono)", () => {
  it("navega da etapa 1 ate a ultima e conclui, sem depender de current_stage", () => {
    const enviadas: number[] = [];
    const trilha: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = decidirDestino({ ...base, enviadas });
      trilha.push(d.tipo === "etapa" ? `etapa ${d.numero}` : d.tipo);
      if (d.tipo !== "etapa") break;
      enviadas.push(d.numero);
    }
    expect(trilha).toEqual(["etapa 1", "etapa 2", "etapa 3", "etapa 4", "etapa 5", "concluido"]);
  });

  it("nao ha numero fixo: versao de 3 etapas conclui em 3, de 7 em 7", () => {
    expect(decidirDestino({ ...base, totalEtapas: 3, enviadas: [1, 2, 3] })).toEqual({ tipo: "concluido" });
    expect(decidirDestino({ ...base, totalEtapas: 3, enviadas: [1, 2] })).toEqual({ tipo: "etapa", numero: 3 });
    expect(decidirDestino({ ...base, totalEtapas: 7, enviadas: [1, 2, 3, 4, 5] })).toEqual({ tipo: "etapa", numero: 6 });
    expect(decidirDestino({ ...base, totalEtapas: 7, enviadas: [1, 2, 3, 4, 5, 6] })).toEqual({ tipo: "etapa", numero: 7 });
  });

  it("concluido so quando TODAS foram enviadas: 4 de 5 nao conclui", () => {
    expect(decidirDestino({ ...base, enviadas: [1, 2, 3, 4] })).toEqual({ tipo: "etapa", numero: 5 });
    expect(decidirDestino({ ...base, enviadas: [1, 2, 3, 5] })).toEqual({ tipo: "etapa", numero: 4 });
  });

  it("ordem livre: quem enviou a 5 primeiro volta para a menor que falta", () => {
    expect(decidirDestino({ ...base, enviadas: [5] })).toEqual({ tipo: "etapa", numero: 1 });
  });

  it("reta final: pula a etapa NAO iniciada e vai para a iniciada (nunca para uma que a janela nao deixa comecar)", () => {
    const d = decidirDestino({ ...base, agora: T - 10 * MIN, enviadas: [1], iniciadas: [1, 3] });
    expect(d).toEqual({ tipo: "etapa", numero: 3 });
  });

  it("tolerancia: etapa iniciada ainda vale; nenhuma iniciada = nada a fazer, motivo nao_inicia_mais", () => {
    expect(decidirDestino({ ...base, agora: T + 5 * MIN, enviadas: [1, 2], iniciadas: [1, 2, 4] })).toEqual({
      tipo: "etapa",
      numero: 4,
    });
    expect(decidirDestino({ ...base, agora: T + 5 * MIN, enviadas: [1, 2], iniciadas: [1, 2] })).toEqual({
      tipo: "nenhuma",
      motivo: "nao_inicia_mais",
      pendentes: [3, 4, 5],
    });
  });

  it("depois de T+15 nada vale, mesmo com etapa iniciada", () => {
    expect(decidirDestino({ ...base, agora: T + 16 * MIN, enviadas: [1], iniciadas: [1, 2] })).toEqual({
      tipo: "nenhuma",
      motivo: "encerrada",
      pendentes: [2, 3, 4, 5],
    });
  });

  it("depois de T+15 com tudo enviado continua concluido (nao vira 'encerrada')", () => {
    expect(decidirDestino({ ...base, agora: T + 99 * MIN, enviadas: [1, 2, 3, 4, 5] })).toEqual({ tipo: "concluido" });
  });

  it("antes de abrir: motivo ainda_nao_abriu", () => {
    expect(decidirDestino({ ...base, agora: aberta.abre - MIN })).toEqual({
      tipo: "nenhuma",
      motivo: "ainda_nao_abriu",
      pendentes: [1, 2, 3, 4, 5],
    });
  });

  it("contagem de etapas invalida nunca vira etapa 1: indisponivel", () => {
    for (const total of [0, -1, 2.5, NaN]) {
      expect(decidirDestino({ ...base, totalEtapas: total })).toEqual({ tipo: "indisponivel", motivo: "configuracao" });
    }
  });
});
