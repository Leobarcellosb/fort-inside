import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEMENTOS } from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import { ROTULOS_DIMENSAO, ROTULOS_EIXOS_MARCO_ZERO } from "./catalogo-dimensoes";
import { validarTextosDeSaida } from "./validacao-saida";
import {
  EXPRESSOES_VETADAS_COLETIVAS,
  encontrarIdentificacao,
  validarTextoColetivo,
  validarTextosColetivos,
} from "./dna-coletivo-validacao";
import {
  PISO_DE_EXIBICAO,
  protegerDoisLados,
  protegerParticao,
} from "./dna-coletivo-protecao";
import { agregar, situacaoDe } from "./dna-coletivo-agregacao";
import {
  COBERTURA_MINIMA_PERCENTUAL,
  TEXTOS_DNA,
  atingeCoberturaMinima,
  avaliarGateDeVolume,
  gateDeVolumeDaCoberturaOficial,
  gerarDnaColetivo,
  liberarParaConducao,
  respostasNecessarias,
  textoDoRascunho,
  textoDoRelatorioOperacional,
  textoParaConducao,
  textosDoModelo,
  textosDoRelatorio,
  type DnaColetivoModelo,
  type GateDeVolume,
  type DnaColetivoRascunho,
  type EntradaDna,
  type RelatorioOperacional,
  type ResultadoDna,
} from "./dna-coletivo-modelo";
import * as F from "./dna-coletivo-fixtures";

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const APROVADOS = new Set<string>([
  ...ROTULOS_DIMENSAO,
  ...ELEMENTOS.map((el) => ROTULOS_ELEMENTOS_PADRAO[el]),
]);
const citados = (t: string) => [...t.matchAll(/“([^”]+)”/g)].map((m) => m[1]);

function textosDe(r: ResultadoDna): string[] {
  return r.tipo === "relatorio_operacional" ? textosDoRelatorio(r) : textosDoModelo(r.modelo);
}
function textoDe(r: ResultadoDna): string {
  return r.tipo === "relatorio_operacional" ? textoDoRelatorioOperacional(r) : textoDoRascunho(r);
}
function rascunho(r: ResultadoDna): DnaColetivoRascunho {
  if (r.tipo !== "rascunho_para_revisao") throw new Error(`esperava rascunho, veio ${r.tipo}`);
  return r;
}
function relatorio(r: ResultadoDna): RelatorioOperacional {
  if (r.tipo !== "relatorio_operacional") throw new Error(`esperava relatorio, veio ${r.tipo}`);
  return r;
}

/** Grupo de teste: `completos` com leitura completa, mais as pendencias pedidas. */
function entrada(
  completos: number,
  opcoes: {
    parciais?: number;
    nada?: number;
    convidados?: number;
    checkinFechado?: boolean;
    /** Veredito do gate; o padrao e o do banco sobre estes mesmos completos. */
    gate?: GateDeVolume;
  } = {},
): EntradaDna {
  const { parciais = 0, nada = 0, convidados, checkinFechado = true, gate } = opcoes;
  const presentes = completos + parciais + nada;
  return {
    convidados: convidados ?? presentes + 3,
    checkinFechado,
    gateDeVolume: gate ?? F.gateVerificado(completos),
    participantes: [
      ...F.varias(Math.ceil(completos / 2), { t: "sem_destaque" }),
      ...F.varias(Math.floor(completos / 2), { t: "dois", eixo: "visao" }),
      ...F.varias(parciais, { t: "parcial" }),
      ...F.varias(nada, { t: "nada" }),
    ],
  };
}

const saida = process.env.DNA_SAIDA;
if (saida) mkdirSync(saida, { recursive: true });
function gravar(nome: string, conteudo: string) {
  if (saida) writeFileSync(join(saida, nome), conteudo);
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Protecao de privacidade
// ---------------------------------------------------------------------------

describe("protecao: piso e complementar", () => {
  it("o piso e 5", () => {
    expect(PISO_DE_EXIBICAO).toBe(5);
  });

  it("celulas todas >= piso ou zero passam como estao", () => {
    const p = protegerParticao([
      { id: "a", contagem: 12 },
      { id: "b", contagem: 0 },
      { id: "c", contagem: 5 },
    ]);
    expect(p.agrupou).toBe(false);
    expect(p.oculta).toBe(false);
    expect(p.linhas).toEqual([
      { tipo: "celula", id: "a", contagem: 12 },
      { tipo: "celula", id: "b", contagem: 0 },
      { tipo: "celula", id: "c", contagem: 5 },
    ]);
  });

  it("celula pequena nunca fica escondida sozinha: e somada a outra", () => {
    const p = protegerParticao([
      { id: "a", contagem: 20 },
      { id: "b", contagem: 3 },
      { id: "c", contagem: 9 },
    ]);
    expect(p.agrupou).toBe(true);
    // b (pequena) + c (a menor grande) somadas; a continua visivel
    expect(p.linhas).toEqual([
      { tipo: "celula", id: "a", contagem: 20 },
      { tipo: "agrupada", ids: ["b", "c"], contagem: 12 },
    ]);
  });

  it("caso 'n-1 de n': uma unica celula pequena nao e recuperavel por subtracao", () => {
    // 39 + 1: se o 1 fosse escondido sozinho, 40 - 39 o devolveria.
    const p = protegerParticao([
      { id: "com", contagem: 39 },
      { id: "sem", contagem: 1 },
    ]);
    expect(p.oculta).toBe(true);
    expect(p.linhas).toEqual([]);
  });

  it("soma extrema (4+4=8, 1+1+1+1+1=5) nao entrega os membros: soma-se uma grande", () => {
    const p = protegerParticao([
      { id: "a", contagem: 4 },
      { id: "b", contagem: 4 },
      { id: "c", contagem: 6 },
      { id: "d", contagem: 10 },
    ]);
    const g = p.linhas.find((l) => l.tipo === "agrupada");
    expect(g && g.tipo === "agrupada" && g.ids).toEqual(["a", "b", "c"]);
    expect(g?.contagem).toBe(14);
  });

  it("se agrupar tudo o que e positivo nao diz nada alem do total, oculta", () => {
    const p = protegerParticao([
      { id: "a", contagem: 6 },
      { id: "b", contagem: 4 },
      { id: "c", contagem: 3 },
      { id: "d", contagem: 2 },
      { id: "e", contagem: 0 },
    ]);
    expect(p.oculta).toBe(true);
    expect(p.linhas).toEqual([]);
  });

  it("propriedade (2000 particoes aleatorias): nada pequeno aparece, nada pequeno e deduzivel", () => {
    const rnd = mulberry32(7);
    let comAgrupamento = 0;
    let ocultas = 0;
    for (let k = 0; k < 2000; k++) {
      const m = 2 + Math.floor(rnd() * 7);
      const celulas = Array.from({ length: m }, (_, i) => ({
        id: `c${i}`,
        contagem: rnd() < 0.25 ? 0 : Math.floor(rnd() * (rnd() < 0.5 ? 8 : 40)),
      }));
      const total = celulas.reduce((s, c) => s + c.contagem, 0);
      const p = protegerParticao(celulas);
      if (p.oculta) {
        ocultas++;
        expect(p.linhas).toEqual([]);
        continue;
      }
      const vistos = new Set<string>();
      let soma = 0;
      for (const l of p.linhas) {
        if (l.tipo === "celula") {
          expect(l.contagem === 0 || l.contagem >= PISO_DE_EXIBICAO, JSON.stringify(celulas)).toBe(true);
          expect(l.contagem).toBe(celulas.find((c) => c.id === l.id)!.contagem);
          expect(vistos.has(l.id)).toBe(false);
          vistos.add(l.id);
          soma += l.contagem;
        } else {
          comAgrupamento++;
          // sempre >= 2 membros e soma >= piso: nenhum membro e deduzivel por subtracao
          expect(l.ids.length).toBeGreaterThanOrEqual(2);
          expect(l.contagem).toBeGreaterThanOrEqual(PISO_DE_EXIBICAO);
          const esperado = l.ids.reduce((s, id) => s + celulas.find((c) => c.id === id)!.contagem, 0);
          expect(l.contagem).toBe(esperado);
          for (const id of l.ids) {
            expect(vistos.has(id)).toBe(false);
            vistos.add(id);
          }
          soma += l.contagem;
        }
      }
      // fecha no total e cobre todas as celulas (ou so omite celulas dentro de agrupamento)
      expect(soma).toBe(total);
      expect(vistos.size).toBe(celulas.length);
    }
    // garante que o fuzz exercitou os caminhos
    expect(comAgrupamento).toBeGreaterThan(100);
    expect(ocultas).toBeGreaterThan(50);
  });

  it("dois lados: lado entre 1 e piso-1 esconde os dois numeros exatos", () => {
    expect(protegerDoisLados(15, 41)).toEqual({ exibir: true });
    expect(protegerDoisLados(0, 40)).toEqual({ exibir: true });
    expect(protegerDoisLados(40, 0)).toEqual({ exibir: true });
    expect(protegerDoisLados(5, 35)).toEqual({ exibir: true });
    expect(protegerDoisLados(4, 36)).toEqual({ exibir: false, ladoPequeno: "com" });
    expect(protegerDoisLados(36, 1)).toEqual({ exibir: false, ladoPequeno: "sem" });
  });
});

// ---------------------------------------------------------------------------
// 2. Cobertura: aritmetica inteira, universo de presentes
// ---------------------------------------------------------------------------

describe("cobertura", () => {
  it("90% e inclusivo; nada de ponto flutuante", () => {
    expect(atingeCoberturaMinima(27, 30)).toBe(true);
    expect(atingeCoberturaMinima(26, 29)).toBe(false); // 89,65%
    expect(atingeCoberturaMinima(9, 10)).toBe(true);
    expect(atingeCoberturaMinima(10, 12)).toBe(false); // 83,3% (a unica medicao real)
    expect(atingeCoberturaMinima(0, 0)).toBe(false);
    expect(respostasNecessarias(12)).toBe(11);
    expect(respostasNecessarias(30)).toBe(27);
    expect(COBERTURA_MINIMA_PERCENTUAL).toBe(90);
  });

  it("89,96% nunca aparece como 90,0%: o percentual exibido trunca", () => {
    // 26 de 29 = 89,655...%; o relatorio mostra 89,6%, nunca 89,7% nem 90%
    const r = relatorio(gerarDnaColetivo(entrada(26, { nada: 3 })));
    expect(r.motivo).toBe("cobertura_insuficiente");
    const t = textoDoRelatorioOperacional(r);
    expect(t).toContain("89,6%");
    expect(t).not.toContain("89,7%");
    expect(t).not.toContain("90,0%");
  });

  it("exatos 90,0% geram o rascunho (limite inclusivo)", () => {
    // 36 de 40: 90,0% exatos E acima do minimo de volume, que e outra trava.
    const r = rascunho(gerarDnaColetivo(entrada(36, { parciais: 4 })));
    expect(r.modelo.numeros.coberturaOficial).toBe("90,0%");
  });

  it("o universo e o de PRESENTES: resposta de quem nao foi nao entra e nao ajuda", () => {
    const base = entrada(10, { nada: 2, convidados: 20 });
    const ausenteRespondeu = F.varias(5, { t: "dois", eixo: "visao" }, false);
    const r = relatorio(
      gerarDnaColetivo({ ...base, participantes: [...base.participantes, ...ausenteRespondeu] }),
    );
    expect(r.motivo).toBe("cobertura_insuficiente");
    expect(r.numeros.presentes).toBe(12);
    expect(r.numeros.respondentes).toBe(10);
    expect(textoDoRelatorioOperacional(r)).toContain(
      "Respostas de quem não esteve presente (fora da conta): 5",
    );
  });

  it("so entra na cobertura quem tem as dimensoes COMPLETAS (parcial nao conta)", () => {
    const e = entrada(8, { parciais: 4 });
    const ag = agregar(e.convidados, e.participantes);
    expect(ag.respondentes).toBe(8);
    expect(ag.presentesIncompletos).toBe(4);
    for (const p of e.participantes) {
      expect(["completo", "incompleto"]).toContain(situacaoDe(p));
    }
    expect(relatorio(gerarDnaColetivo(e)).motivo).toBe("cobertura_insuficiente");
  });
});

// ---------------------------------------------------------------------------
// 2b. Gate de volume minimo: o limiar mora no banco
// ---------------------------------------------------------------------------
// Cada negativa vem com o controle positivo do MESMO grupo: se o grupo so nao
// publica porque o veredito mudou, a trava e o veredito -- e nao um acidente do
// grupo.

describe("gate de volume: o limiar vem do banco, nao deste arquivo", () => {
  it("o minimo lido da migration 020 e 30 (se o banco mudar, este teste denuncia)", () => {
    expect(F.MINIMO_RESPOSTAS_DO_BANCO).toBe(30);
  });

  it("o gerador obedece o minimo que RECEBE: nao ha numero escrito no TypeScript", () => {
    // mesmos 45 respondentes, mesma cobertura; muda so o limiar do banco
    const com40 = gerarDnaColetivo(entrada(45, { gate: F.gateVerificado(45, 40) }));
    expect(com40.tipo).toBe("rascunho_para_revisao");

    const com50 = relatorio(gerarDnaColetivo(entrada(45, { gate: F.gateVerificado(45, 50) })));
    expect(com50.motivo).toBe("volume_insuficiente");
    expect(com50.numeros.faltamParaOVolume).toBe(5);
    const t = textoDoRelatorioOperacional(com50);
    expect(t).toContain("o volume mínimo para o DNA Coletivo é de 50 leituras completas: faltam 5");
    expect(t).toContain("Volume mínimo exigido: 50 leituras completas entre os presentes");
  });

  it("o gate e obrigatorio em EntradaDna: o compilador cobra a decisao de quem chama", () => {
    const semVeredito = { convidados: 1, checkinFechado: true, participantes: [] };
    // @ts-expect-error falta `gateDeVolume`: nao existe entrada que signifique "aprovado por omissao"
    const e: EntradaDna = semVeredito;
    expect(e.convidados).toBe(1);
  });
});

describe("gate de volume: REPROVADO (verificado e abaixo do minimo)", () => {
  it("12 presentes com 12 respostas: 100% de cobertura e, ainda assim, nao publica", () => {
    const r = gerarDnaColetivo(entrada(12));
    const rel = relatorio(r);

    // o motivo e o VOLUME, nao a cobertura: a cobertura esta em 100%
    expect(rel.motivo).toBe("volume_insuficiente");
    expect(rel.numeros.presentes).toBe(12);
    expect(rel.numeros.respondentes).toBe(12);
    expect(rel.numeros.faltamParaOLimiar).toBeNull();
    expect(rel.numeros.faltamParaOVolume).toBe(18);
    expect(atingeCoberturaMinima(12, 12)).toBe(true);

    const t = textoDoRelatorioOperacional(rel);
    expect(t).toContain("Cobertura oficial, sobre os presentes: 12 de 12 · 100,0%");
    expect(t).toContain("o volume mínimo para o DNA Coletivo é de 30 leituras completas: faltam 18");
    expect(t).toContain("cumpre o mínimo de 90%");
    // o paragrafo de recusa POR COBERTURA nao aparece: nao e ela que reprovou
    expect(t).not.toContain("abaixo do mínimo o sistema não produz esse documento");
    expect(rel.cabecalho.titulo).not.toBe(TEXTOS_DNA.titulo);
    expect(rel.cabecalho.titulo).toBe(TEXTOS_DNA.tituloRelatorio);
    expect(r).not.toHaveProperty("modelo");
    expect(validarTextosColetivos(textosDoRelatorio(rel))).toEqual([]);
    gravar("5-volume-12-de-12.txt", t);
  });

  it("CONTROLE POSITIVO: os mesmos 12, com o limiar do banco em 10, publicam", () => {
    const r = gerarDnaColetivo(entrada(12, { gate: F.gateVerificado(12, 10) }));
    expect(r.tipo).toBe("rascunho_para_revisao");
    expect(rascunho(r).modelo.numeros.coberturaOficial).toBe("100,0%");
  });

  it("30 presentes com 29 respostas: cobertura 96,6% aprovada, volume reprovado", () => {
    const rel = relatorio(gerarDnaColetivo(entrada(29, { nada: 1 })));
    expect(rel.motivo).toBe("volume_insuficiente");
    expect(atingeCoberturaMinima(29, 30)).toBe(true);
    const t = textoDoRelatorioOperacional(rel);
    expect(t).toContain("Cobertura oficial, sobre os presentes: 29 de 30 · 96,6%");
    expect(t).toContain("faltam 1");
    expect(validarTextosColetivos(textosDoRelatorio(rel))).toEqual([]);
    gravar("6-volume-29-de-30.txt", t);
  });

  it("CONTROLE POSITIVO: uma resposta a mais nos mesmos 30 presentes publica", () => {
    const r = gerarDnaColetivo(entrada(30));
    expect(r.tipo).toBe("rascunho_para_revisao");
    expect(rascunho(r).modelo.numeros.respondentes).toBe(30);
  });

  it("50 presentes com 29 respostas: nao publica (aqui as DUAS travas reprovam)", () => {
    const rel = relatorio(gerarDnaColetivo(entrada(29, { nada: 21 })));
    expect(rel.numeros.presentes).toBe(50);
    expect(rel.numeros.respondentes).toBe(29);
    // 29/50 = 58%: a cobertura reprova de verdade, e e ela que o relatorio nomeia
    expect(atingeCoberturaMinima(29, 50)).toBe(false);
    expect(avaliarGateDeVolume(F.gateVerificado(29), 29).resultado).toBe("reprovado");
    expect(rel.motivo).toBe("cobertura_insuficiente");
    expect(rel.tipo).toBe("relatorio_operacional");
  });

  it("50 presentes com 45 respostas: passa os dois limiares numericos", () => {
    const d = rascunho(gerarDnaColetivo(entrada(45, { nada: 5 })));
    expect(d.modelo.numeros.presentes).toBe(50);
    expect(d.modelo.numeros.respondentes).toBe(45);
    expect(d.modelo.numeros.coberturaOficial).toBe("90,0%");
    expect(atingeCoberturaMinima(45, 50)).toBe(true);
    expect(avaliarGateDeVolume(F.gateVerificado(45), 45)).toEqual({
      resultado: "aprovado",
      minimoExigido: 30,
    });
    // os dois limiares NUMERICOS, e so eles: o documento sai como RASCUNHO
    expect(d.tipo).toBe("rascunho_para_revisao");
    expect(textoDoRascunho(d)).toContain(TEXTOS_DNA.seloRevisao);
    gravar("7-volume-45-de-50.txt", textoDoRascunho(d));
  });
});

describe("gate de volume: INDISPONIVEL e categoria propria (nem aprovado, nem reprovado)", () => {
  const indisponiveis: [string, GateDeVolume][] = [
    ["consulta ausente", gateDeVolumeDaCoberturaOficial(null)],
    [
      "quiz sem etapas",
      gateDeVolumeDaCoberturaOficial({
        status: "indisponivel",
        motivo: "quiz_sem_etapas",
        respondentes_validos: null,
        gate_minimo_respostas: null,
        minimo_respostas: 30,
      }),
    ],
    [
      "veredito nulo com status ok",
      gateDeVolumeDaCoberturaOficial({
        status: "ok",
        motivo: null,
        respondentes_validos: 45,
        gate_minimo_respostas: null,
        minimo_respostas: 30,
      }),
    ],
    [
      "minimo invalido",
      gateDeVolumeDaCoberturaOficial({
        status: "ok",
        motivo: null,
        respondentes_validos: 45,
        gate_minimo_respostas: true,
        minimo_respostas: 0,
      }),
    ],
    [
      "motivo fora da lista",
      gateDeVolumeDaCoberturaOficial({
        status: "indisponivel",
        motivo: "algo_que_este_modulo_nao_conhece",
        respondentes_validos: null,
        gate_minimo_respostas: null,
        minimo_respostas: 30,
      }),
    ],
    [
      "linha que contradiz as proprias contagens",
      { estado: "verificado", aprovado: true, minimoExigido: 30, respondentesValidos: 4 },
    ],
    [
      "banco e entrada discordam do limiar",
      { estado: "verificado", aprovado: true, minimoExigido: 30, respondentesValidos: 31 },
    ],
  ];

  for (const [nome, gate] of indisponiveis) {
    it(`${nome}: nao publica, nomeia o motivo e nao se declara aprovado`, () => {
      // o grupo seria publicavel: 45 de 50 presentes, 90,0%
      const r = gerarDnaColetivo(entrada(29, { nada: 1, gate }));
      const rel = relatorio(r);
      expect(rel.motivo).toBe("gate_de_volume_indisponivel");
      expect(r).not.toHaveProperty("modelo");
      expect(rel.numeros.faltamParaOVolume).toBeNull();

      const t = textoDoRelatorioOperacional(rel);
      expect(t).toContain("O gate de volume mínimo não pôde ser avaliado:");
      expect(t).toMatch(
        /Não ter conseguido verificar é categoria diferente de ter verificado e aprovado/,
      );
      // nao ha veredito escondido num numero: nem aprovado, nem reprovado
      expect(t).not.toContain("faltam");
      expect(t).not.toContain("Volume mínimo exigido");
      expect(t).not.toBe(TEXTOS_DNA.titulo);
      expect(rel.cabecalho.titulo).toBe(TEXTOS_DNA.tituloRelatorio);
      // nenhum codigo cru do banco vaza para o documento
      expect(t).not.toMatch(/[a-z]+_[a-z]+/);
      expect(validarTextosColetivos(textosDoRelatorio(rel))).toEqual([]);
      expect(() => textoDoRascunho(r as never)).toThrow();
      gravar(`8-volume-indisponivel-${nome.replace(/\s+/g, "-")}.txt`, t);
    });
  }

  it("CONTROLE POSITIVO: o MESMO grupo, com o veredito do banco, publica", () => {
    const r = gerarDnaColetivo(entrada(29, { nada: 1, gate: F.gateVerificado(29, 29) }));
    expect(r.tipo).toBe("rascunho_para_revisao");
    expect(rascunho(r).modelo.numeros.respondentes).toBe(29);
  });

  it("indisponibilidade nao e liberavel: nao existe rascunho para revisar", () => {
    const r = gerarDnaColetivo(entrada(45, { nada: 5, gate: gateDeVolumeDaCoberturaOficial(null) }));
    expect(relatorio(r).motivo).toBe("gate_de_volume_indisponivel");
    expect(() =>
      liberarParaConducao(r as never, {
        parecer: "aprovado",
        revisor: "Responsável pela metodologia",
        revisadoEm: "2026-11-10",
        conteudoSha256: "0".repeat(64),
        catalogoVersao: "qualquer",
      }),
    ).toThrow(/nao emitido/);
  });

  it("a traducao da linha do banco e fechada: cada forma inesperada vira indisponibilidade", () => {
    expect(gateDeVolumeDaCoberturaOficial(undefined)).toEqual({
      estado: "indisponivel",
      motivo: "consulta_nao_respondeu",
    });
    expect(
      gateDeVolumeDaCoberturaOficial({
        status: "indisponivel",
        motivo: "checkin_aberto",
        respondentes_validos: 40,
        gate_minimo_respostas: true,
        minimo_respostas: 30,
      }),
    ).toEqual({ estado: "indisponivel", motivo: "checkin_aberto" });
    expect(
      gateDeVolumeDaCoberturaOficial({
        status: "ok",
        motivo: null,
        respondentes_validos: 31,
        gate_minimo_respostas: true,
        minimo_respostas: 30,
      }),
    ).toEqual({
      estado: "verificado",
      aprovado: true,
      minimoExigido: 30,
      respondentesValidos: 31,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Cenarios do responsavel tecnico
// ---------------------------------------------------------------------------

describe("cenario: cobertura INSUFICIENTE (83,3%, a unica medicao real)", () => {
  const r = gerarDnaColetivo(F.grupoInsuficiente());

  it("nenhum documento publico: so o relatorio operacional privado", () => {
    expect(r.tipo).toBe("relatorio_operacional");
    const rel = relatorio(r);
    expect(rel.motivo).toBe("cobertura_insuficiente");
    expect(rel.cabecalho.titulo).not.toBe(TEXTOS_DNA.titulo);
    expect(rel.cabecalho.titulo).toBe(TEXTOS_DNA.tituloRelatorio);
    expect(rel.cabecalho.selo).toBe(TEXTOS_DNA.seloRelatorio);
    expect(r).not.toHaveProperty("modelo");
    expect(() => textoDoRascunho(r as never)).toThrow();
  });

  it("nao traz retrato algum das dimensoes", () => {
    const t = textoDoRelatorioOperacional(relatorio(r));
    for (const rot of ROTULOS_DIMENSAO) expect(t).not.toContain(rot);
    expect(t).not.toMatch(/em destaque/);
    expect(t).not.toMatch(/média/);
  });

  it("mostra a diferenca presentes x convidados e o que falta", () => {
    const t = textoDoRelatorioOperacional(relatorio(r));
    expect(t).toContain("Convidados: 15");
    expect(t).toContain("Presentes: 12 (80,0% dos convidados)");
    expect(t).toContain("Convidados que não estiveram presentes: 3");
    expect(t).toContain("10 de 12 · 83,3%");
    expect(t).toContain("faltam 1");
    gravar("1-insuficiente.txt", t);
  });

  it("devolve ids (nao nomes) de quem falta, para o host cobrar", () => {
    const rel = relatorio(r);
    expect(rel.pendentes.incompletos).toHaveLength(1);
    expect(rel.pendentes.semResposta).toHaveLength(1);
    expect(validarTextosColetivos(textosDoRelatorio(rel))).toEqual([]);
  });
});

describe("cenario: cobertura SUFICIENTE", () => {
  const r = gerarDnaColetivo(F.grupoSuficiente());
  const d = rascunho(r);
  const textos = textosDoModelo(d.modelo);
  const texto = textoDoRascunho(d);

  it("gera rascunho (nao a versao para conduzir) com selos visiveis", () => {
    expect(d.tipo).toBe("rascunho_para_revisao");
    expect(texto).toContain(TEXTOS_DNA.seloRevisao);
    expect(texto).toContain(TEXTOS_DNA.seloCatalogo);
    gravar("2-suficiente.txt", texto);
  });

  it("cobertura explicita no proprio texto e contagens dos RESPONDENTES", () => {
    expect(texto).toContain("37 de 40 · 92,5%");
    expect(texto).toContain("Base: 37 respondentes");
    expect(texto).toContain("dos respondentes)");
    expect(texto).toContain("descrevem apenas as 37 pessoas");
    expect(texto).toMatch(/nada aqui vale como afirmação sobre o conjunto de presentes/);
  });

  it("presentes x convidados aparecem lado a lado", () => {
    expect(texto).toContain("Convidados: 50");
    expect(texto).toContain("Presentes, com o check-in fechado: 40 (80,0% dos convidados)");
    expect(texto).toContain("Convidados que não estiveram presentes: 10");
    expect(texto).toContain("Participação sobre o total de convidados: 37 de 50 · 74,0%");
  });

  it("nenhuma afirmacao universal nem representatividade", () => {
    expect(validarTextosColetivos(textos)).toEqual([]);
    expect(texto).not.toMatch(/representativ/i);
    expect(texto).not.toMatch(/\b(todos|todas|ninguém|nenhum|sempre|nunca)\b/i);
  });

  it("nenhuma contagem entre 1 e 4 pessoas aparece nos recortes", () => {
    for (const b of d.modelo.blocos) {
      for (const parte of b.partes) {
        if (!("linhas" in parte)) continue;
        for (const l of parte.linhas) {
          const m = /^(\d+) pessoas?\b/.exec(l.valor);
          if (m) {
            const x = Number(m[1]);
            expect(x === 0 || x >= PISO_DE_EXIBICAO, `${l.rotulo}: ${l.valor}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("cenario: MUITOS INDETERMINADOS (o caso mais provavel, 73,2% sem destaque)", () => {
  const r = gerarDnaColetivo(F.grupoMuitosIndeterminados());
  const d = rascunho(r);
  const texto = textoDoRascunho(d);

  it("diz a proporcao sem destaque e nao inventa um perfil", () => {
    gravar("3-muitos-indeterminados.txt", texto);
    expect(texto).toContain("Sem dimensão em destaque: 41 pessoas (73,2% dos respondentes)");
    expect(texto).toContain("Com uma dimensão em destaque: 15 pessoas (26,8% dos respondentes)");
    expect(texto).toContain("não é possível atribuir a essas pessoas uma dimensão");
    expect(texto).toMatch(/não abra a conversa com uma tese sobre quem está na sala/);
  });

  it("a distribuicao que identificaria alguem e omitida e o texto avisa", () => {
    // 15 com destaque = 6 + 4 + 3 + 2: tres celulas pequenas
    expect(texto).toContain("A distribuição entre as dimensões não é exibida");
    expect(d.modelo.recortesOcultos).toBe(true);
  });

  it("o cruzamento so mostra o que nao revela por subtracao", () => {
    expect(texto).toContain("somadas: 8 pessoas");
    expect(validarTextosColetivos(textosDoModelo(d.modelo))).toEqual([]);
  });
});

describe("cenario: DADOS INCOMPLETOS (pessoas que responderam parte)", () => {
  const e = F.grupoComDadosIncompletos();
  const r = gerarDnaColetivo(e);
  const d = rascunho(r);
  const texto = textoDoRascunho(d);

  it("parte do questionario nao entra na leitura de dimensoes nem na cobertura", () => {
    gravar("4-dados-incompletos.txt", texto);
    expect(d.modelo.numeros.respondentes).toBe(36);
    expect(d.modelo.numeros.presentes).toBe(40);
    expect(texto).toContain("Cobertura oficial, sobre os presentes: 36 de 40 · 90,0%");
    expect(texto).toContain("Base: 36 respondentes");
    expect(texto).toContain(
      "4 pessoas presentes não entram na leitura das dimensões por não terem respondido ou terem respondido só em parte. Nada neste documento é afirmado sobre as dimensões dessas pessoas.",
    );
  });

  it("a secao de elementos diz que a base e outra, e usa o que essas pessoas de fato responderam", () => {
    expect(texto).toContain("A base desta seção não é a das dimensões");
    expect(texto).toContain("(40 de 40 presentes responderam)");
  });

  it("nao inventa: cada pessoa parcial segue sem dimensao atribuida, em qualquer secao", () => {
    const ag = agregar(e.convidados, e.participantes);
    // 36 completos, e as soma de com/sem fecha em 36 (os 4 parciais nao estao em nenhuma)
    expect(ag.autodescricao.comDestaque + ag.autodescricao.semDestaque).toBe(36);
    expect(ag.situacional.comDestaque + ag.situacional.semDestaque).toBe(36);
    expect(ag.presentesIncompletos).toBe(4);
    expect(ag.pendentes.incompletos).toHaveLength(4);
  });

  it("quem respondeu, mas nao esteve presente, fica fora de tudo", () => {
    const ag = agregar(e.convidados, e.participantes);
    expect(ag.ausentes).toBe(1);
    expect(ag.respostasDeAusentes).toBe(1);
    expect(ag.presentes).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 4. Outros caminhos que fecham a porta
// ---------------------------------------------------------------------------

describe("caminhos que nunca geram o DNA Coletivo", () => {
  it("check-in aberto: nao ha universo oficial, mesmo com 100% de respostas", () => {
    const rel = relatorio(gerarDnaColetivo(entrada(20, { checkinFechado: false })));
    expect(rel.motivo).toBe("checkin_aberto");
    expect(textoDoRelatorioOperacional(rel)).toMatch(/check-in ainda não foi fechado/);
  });

  it("sem presentes", () => {
    const rel = relatorio(
      gerarDnaColetivo({
        convidados: 10,
        checkinFechado: true,
        gateDeVolume: F.gateVerificado(0),
        participantes: F.varias(3, { t: "sem_destaque" }, false),
      }),
    );
    expect(rel.motivo).toBe("sem_presentes");
  });

  it("base pequena demais: 4 de 4 presentes (100%) ainda nao gera", () => {
    const rel = relatorio(gerarDnaColetivo(entrada(4)));
    expect(rel.motivo).toBe("base_pequena_demais");
    expect(textoDoRelatorioOperacional(rel)).toMatch(/Abaixo de 5 pessoas/);
  });

  it("mais presentes que convidados: dados inconsistentes, nao inventa participacao > 100%", () => {
    const rel = relatorio(gerarDnaColetivo(entrada(20, { convidados: 10 })));
    expect(rel.motivo).toBe("dados_inconsistentes");
  });

  it("participante repetido ou total de convidados invalido: dados inconsistentes", () => {
    const e = entrada(10);
    const dup = relatorio(
      gerarDnaColetivo({ ...e, participantes: [...e.participantes, e.participantes[0]] }),
    );
    expect(dup.motivo).toBe("dados_inconsistentes");
    expect(relatorio(gerarDnaColetivo({ ...e, convidados: -1 })).motivo).toBe("dados_inconsistentes");
  });
});

// ---------------------------------------------------------------------------
// 5. Cruzamento: juncao 2x2 e subtracao entre secoes
// ---------------------------------------------------------------------------

describe("cruzamento entre secoes", () => {
  it("se 'ambas' revelasse, por subtracao das margens, um recorte < 5, o cruzamento some", () => {
    // 21 com destaque nos dois + 3 so no Likert => Likert-sem-situacional = 3
    const e: EntradaDna = {
      convidados: 50,
      checkinFechado: true,
      gateDeVolume: F.gateVerificado(40),
      participantes: [
        ...F.varias(21, { t: "dois", eixo: "visao" }),
        ...F.varias(3, { t: "likert", eixo: "relacao" }),
        ...F.varias(16, { t: "sem_destaque" }),
      ],
    };
    const t = textoDoRascunho(rascunho(gerarDnaColetivo(e)));
    expect(t).toContain("O cruzamento não é exibido: somado aos números das seções anteriores");
    expect(t).not.toContain("Mesma dimensão em destaque nas duas leituras:");
  });
});

// ---------------------------------------------------------------------------
// 6. Varredor: nada vetado, nada fora do catalogo, nada universal
// ---------------------------------------------------------------------------

describe("varredor de saida sobre os documentos gerados", () => {
  const todos: [string, ResultadoDna][] = [
    ["insuficiente", gerarDnaColetivo(F.grupoInsuficiente())],
    ["suficiente", gerarDnaColetivo(F.grupoSuficiente())],
    ["muitos-indeterminados", gerarDnaColetivo(F.grupoMuitosIndeterminados())],
    ["dados-incompletos", gerarDnaColetivo(F.grupoComDadosIncompletos())],
  ];

  for (const [nome, r] of todos) {
    it(`${nome}: varredor do one-pager + varredor coletivo = zero recusas`, () => {
      const t = textosDe(r);
      expect(validarTextosDeSaida(t)).toEqual([]);
      expect(validarTextosColetivos(t)).toEqual([]);
      for (const s of t) {
        for (const c of citados(s)) expect(APROVADOS.has(c), `fora do catalogo: ${c}`).toBe(true);
      }
    });

    it(`${nome}: nenhum id ou nome de participante vaza para o texto`, () => {
      const e =
        nome === "insuficiente"
          ? F.grupoInsuficiente()
          : nome === "suficiente"
            ? F.grupoSuficiente()
            : nome === "muitos-indeterminados"
              ? F.grupoMuitosIndeterminados()
              : F.grupoComDadosIncompletos();
      const ids = e.participantes.flatMap((p) => [p.id, ...(p.nome ? [p.nome] : [])]);
      for (const s of textosDe(r)) expect(encontrarIdentificacao(s, ids)).toEqual([]);
    });
  }

  it("so os quatro rotulos do catalogo aparecem como nome de dimensao", () => {
    const vistos = new Set<string>();
    for (const [, r] of todos) {
      for (const s of textosDe(r)) for (const c of citados(s)) vistos.add(c);
    }
    for (const v of vistos) expect(APROVADOS.has(v)).toBe(true);
    for (const rot of Object.values(ROTULOS_EIXOS_MARCO_ZERO)) expect(vistos.has(rot)).toBe(true);
  });
});

describe("varredor coletivo: anti-vacuidade (cada violacao e recusada)", () => {
  const violacoes: [string, string, string][] = [
    ["universal: todos", "Todos os presentes valorizam “Visão e Direção”.", "afirmacao_universal"],
    ["universal: ninguem", "Ninguém na sala se descreve com foco em “Execução e Consistência”.", "afirmacao_universal"],
    ["universal: sempre", "As pessoas sempre escolhem “Visão e Direção”.", "afirmacao_universal"],
    ["universal: em geral", "Em geral, as pessoas se descrevem assim.", "afirmacao_universal"],
    ["grupo como sujeito", "O grupo valoriza “Relacionamento e Colaboração”.", "coletivo_como_sujeito"],
    ["sala como sujeito", "A sala prefere decidir rápido.", "coletivo_como_sujeito"],
    ["o grupo e", "O grupo é “Integridade e Responsabilidade”.", "coletivo_como_sujeito"],
    ["maioria do conjunto", "A maioria das pessoas do grupo tem destaque.", "quantificador_sobre_o_conjunto"],
    ["metade dos presentes", "Metade dos presentes tem destaque.", "quantificador_sobre_o_conjunto"],
    ["representatividade", "Este retrato é representativo do evento.", "representatividade"],
    ["retrato do grupo", "O retrato do grupo mostra equilíbrio.", "representatividade"],
    ["inferencia sobre nao respondentes", "Quem não respondeu pensa do mesmo jeito.", "inferencia_sobre_nao_respondentes"],
    ["quinto nome", "A maior concentração está em “Estratégia e Foco”.", "nome_fora_do_catalogo"],
    ["rotulo renomeado", "A dimensão “Visão Estratégica” aparece em 12 pessoas.", "nome_fora_do_catalogo"],
    ["rotulo abreviado", "12 pessoas têm destaque em Execução.", "variacao_de_rotulo"],
    ["tipo de personalidade", "O perfil do grupo é executor.", "dimensao_como_tipo"],
    ["dominante", "A dimensão dominante é “Visão e Direção”.", "perfil_eixo_dominante"],
    ["fragilidade", "Recursos financeiros é a fragilidade da sala.", "fragilidade"],
  ];
  for (const [nome, frase, id] of violacoes) {
    it(`recusa: ${nome}`, () => {
      const r = validarTextoColetivo(frase);
      expect(r.map((x) => x.motivo), frase).toContain(id);
    });
  }

  it("a lista de vetos coletivos tem todos os ids exercitados acima", () => {
    for (const e of EXPRESSOES_VETADAS_COLETIVAS) {
      expect(violacoes.some(([, , id]) => id === e.id), e.id).toBe(true);
    }
  });

  it("identifica nome e id de participante", () => {
    expect(encontrarIdentificacao("A Marina Albuquerque tem destaque.", ["Marina Albuquerque"])).toEqual([
      "Marina Albuquerque",
    ]);
    expect(encontrarIdentificacao("registro p-0001-77", ["p-0001-77"])).toEqual(["p-0001-77"]);
  });

  it("sem falso positivo nas frases honestas que o documento usa", () => {
    const honestas = [
      "Estas contagens são das 56 pessoas que responderam, 93,3% dos 60 presentes. Elas não dizem quem cada pessoa é e não valem para quem não respondeu.",
      "Evite frases que atribuam uma característica à sala inteira. O documento só autoriza frases sobre as pessoas que responderam, ditas junto com a cobertura.",
      "Entre os 56 respondentes, ficaram sem dimensão em destaque 41 na autodescrição e 48 nas escolhas hipotéticas.",
      "Sem dimensão em destaque: 41 pessoas (73,2% dos respondentes)",
      "0 pessoas (0,0% dos respondentes)",
      ...Object.values(TEXTOS_DNA),
    ];
    for (const h of honestas) expect(validarTextoColetivo(h), h).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Fuzz: 300 grupos aleatorios, invariantes de privacidade e de texto
// ---------------------------------------------------------------------------

describe("fuzz do gerador", () => {
  it("300 grupos aleatorios: cobertura honrada, textos limpos, nenhuma contagem 1-4 nos recortes", () => {
    const rnd = mulberry32(20261021);
    const especies = [
      () => ({ t: "sem_destaque" as const }),
      () => ({ t: "dois" as const, eixo: (["visao", "execucao", "relacao", "integridade"] as const)[Math.floor(rnd() * 4)] }),
      () => ({ t: "likert" as const, eixo: (["visao", "execucao", "relacao", "integridade"] as const)[Math.floor(rnd() * 4)] }),
      () => ({ t: "contraste" as const, l: "visao" as const, s: "relacao" as const }),
    ];
    let rascunhos = 0;
    let relatorios = 0;
    for (let k = 0; k < 300; k++) {
      const n = 4 + Math.floor(rnd() * 60);
      const participantes = [
        ...Array.from({ length: n }, () => F.pessoa(especies[Math.floor(rnd() * especies.length)]())),
        ...F.varias(Math.floor(rnd() * 6), { t: "parcial" }),
        ...F.varias(Math.floor(rnd() * 4), { t: "nada" }),
        ...F.varias(Math.floor(rnd() * 3), { t: "dois", eixo: "visao" }, false),
      ];
      const presentes = participantes.filter((p) => p.presente).length;
      const r = gerarDnaColetivo({
        convidados: presentes + Math.floor(rnd() * 10),
        checkinFechado: rnd() > 0.05,
        // o banco conta os mesmos completos: `n` especies completas
        gateDeVolume: F.gateVerificado(n),
        participantes,
      });
      expect(validarTextosColetivos(textosDe(r)), `caso ${k}`).toEqual([]);
      if (r.tipo === "rascunho_para_revisao") {
        rascunhos++;
        const { respondentes, presentes: P } = r.modelo.numeros;
        expect(atingeCoberturaMinima(respondentes, P), `caso ${k}`).toBe(true);
        // nenhum documento publicado abaixo do volume minimo do banco
        expect(respondentes, `caso ${k}`).toBeGreaterThanOrEqual(F.MINIMO_RESPOSTAS_DO_BANCO);
        for (const b of r.modelo.blocos) {
          for (const parte of b.partes) {
            if (!("linhas" in parte)) continue;
            for (const l of parte.linhas) {
              const m = /^(\d+) pessoas?\b/.exec(l.valor);
              if (m) {
                const x = Number(m[1]);
                expect(x === 0 || x >= PISO_DE_EXIBICAO, `caso ${k}: ${l.rotulo}: ${l.valor}`).toBe(true);
              }
            }
          }
        }
      } else {
        relatorios++;
        expect(r.cabecalho.titulo).not.toBe(TEXTOS_DNA.titulo);
      }
    }
    expect(rascunhos).toBeGreaterThan(20);
    expect(relatorios).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 8. Travas: revisao e ratificacao (a cobertura sozinha NAO libera para a sala)
// ---------------------------------------------------------------------------

describe("travas independentes (sem ratificacao dos rotulos, como hoje)", () => {
  const d = rascunho(gerarDnaColetivo(F.grupoSuficiente()));
  const revisaoBoa = {
    parecer: "aprovado" as const,
    revisor: "Responsável pela metodologia",
    revisadoEm: "2026-11-10",
    conteudoSha256: d.conteudoSha256,
    catalogoVersao: d.modelo.catalogoVersao,
  };

  it("cobertura suficiente + revisao boa NAO bastam: o catalogo segue nao ratificado", () => {
    expect(() => liberarParaConducao(d, revisaoBoa)).toThrow(/ratifica/);
  });

  it("sem revisao valida nao ha versao para conduzir (cada defeito e recusado)", () => {
    const casos: [string, Partial<typeof revisaoBoa>, RegExp][] = [
      ["parecer reprovado", { parecer: "reprovado" as never }, /parecer/],
      ["parecer pendente", { parecer: "pendente" as never }, /parecer/],
      ["sem revisor", { revisor: "  " }, /revisor/],
      ["data invalida", { revisadoEm: "ontem" }, /data/],
      ["hash de outro conteudo", { conteudoSha256: "0".repeat(64) }, /não corresponde|nao corresponde/],
      ["outra versao do catalogo", { catalogoVersao: "9.9.9" }, /catalogo/],
    ];
    for (const [nome, defeito, esperado] of casos) {
      expect(() => liberarParaConducao(d, { ...revisaoBoa, ...defeito }), nome).toThrow(esperado);
    }
  });

  it("nao da para forjar o rascunho: o que gerarDnaColetivo nao emitiu e recusado", () => {
    const falso = JSON.parse(JSON.stringify(d)) as DnaColetivoRascunho;
    expect(() => liberarParaConducao(falso, revisaoBoa)).toThrow(/nao emitido/);
    expect(() => textoDoRascunho(falso)).toThrow(/nao emitido/);
  });

  it("nao da para renderizar 'para conduzir' sem liberacao", () => {
    expect(() => textoParaConducao(d as never)).toThrow(/nao liberado/);
    expect(() =>
      textoParaConducao({ tipo: "liberado_para_conducao", modelo: d.modelo, revisao: revisaoBoa, selos: [], conteudoSha256: d.conteudoSha256 }),
    ).toThrow(/nao liberado/);
  });

  it("o rascunho e imutavel", () => {
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.modelo)).toBe(true);
    expect(() => {
      (d.modelo as unknown as { abertura: string }).abertura = "x";
    }).toThrow();
  });

  it("o hash cobre o conteudo: outro grupo, outro hash", () => {
    const outro = rascunho(gerarDnaColetivo(F.grupoMuitosIndeterminados()));
    expect(outro.conteudoSha256).not.toBe(d.conteudoSha256);
    expect(() => liberarParaConducao(outro, revisaoBoa)).toThrow(/não corresponde|nao corresponde/);
  });
});

// ---------------------------------------------------------------------------
// 9. Violacao plantada no modelo: o verificador derruba (prova em memoria)
// ---------------------------------------------------------------------------

describe("verificacao do texto final sobre um modelo adulterado", () => {
  const d = rascunho(gerarDnaColetivo(F.grupoSuficiente()));
  const adulterar = (frase: string): DnaColetivoModelo => ({
    ...d.modelo,
    conduzir: {
      ...d.modelo.conduzir,
      partes: [...d.modelo.conduzir.partes, { paragrafo: frase }],
    },
  });

  it("afirmacao universal plantada e recusada", () => {
    const m = adulterar("Todos os presentes valorizam “Visão e Direção”.");
    expect(validarTextosColetivos(textosDoModelo(m)).length).toBeGreaterThan(0);
  });

  it("quinto nome plantado e recusado", () => {
    const m = adulterar("O grupo concentra “Estratégia e Foco”.");
    const r = validarTextosColetivos(textosDoModelo(m));
    expect(r.flatMap((x) => x.recusas.map((y) => y.motivo))).toContain("nome_fora_do_catalogo");
  });

  it("o modelo original segue limpo", () => {
    expect(validarTextosColetivos(textosDoModelo(d.modelo))).toEqual([]);
  });
});
