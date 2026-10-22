// Caminho positivo da liberacao. O catalogo real ainda esta "pendente de
// ratificacao", entao aqui (e SO aqui) a terceira trava e simulada como
// ratificada. As outras duas travas (cobertura, revisao) seguem reais.

import { describe, expect, it, vi } from "vitest";

vi.mock("./catalogo-dimensoes", async (importOriginal) => {
  const real = await importOriginal<typeof import("./catalogo-dimensoes")>();
  return { ...real, assertPublicavel: () => undefined };
});

import * as F from "./dna-coletivo-fixtures";
import {
  TEXTOS_DNA,
  gerarDnaColetivo,
  liberarParaConducao,
  textoDoRascunho,
  textoParaConducao,
  textosDoModelo,
  type DnaColetivoRascunho,
  type RevisaoMetodologica,
} from "./dna-coletivo-modelo";
import { validarTextosColetivos } from "./dna-coletivo-validacao";

function rasc(e = F.grupoSuficiente()): DnaColetivoRascunho {
  const r = gerarDnaColetivo(e);
  if (r.tipo !== "rascunho_para_revisao") throw new Error("esperava rascunho");
  return r;
}
const revisaoDe = (d: DnaColetivoRascunho): RevisaoMetodologica => ({
  parecer: "aprovado",
  revisor: "Responsável pela metodologia",
  revisadoEm: "2026-11-10",
  conteudoSha256: d.conteudoSha256,
  catalogoVersao: d.modelo.catalogoVersao,
  observacoes: "Interpretação conferida.",
});

describe("liberacao para conducao (rotulos 'ratificados' apenas neste arquivo)", () => {
  it("com cobertura + revisao registrada + ratificacao, sai a versao para conduzir", () => {
    const d = rasc();
    const l = liberarParaConducao(d, revisaoDe(d));
    expect(l.tipo).toBe("liberado_para_conducao");
    const t = textoParaConducao(l);
    // o selo de rascunho some; entra o de revisao registrada
    expect(t).not.toContain(TEXTOS_DNA.seloRevisao);
    expect(t).toContain("Revisado por Responsável pela metodologia em 10 de novembro de 2026");
    expect(t).toContain(d.conteudoSha256.slice(0, 8));
    // o rascunho continua com o selo
    expect(textoDoRascunho(d)).toContain(TEXTOS_DNA.seloRevisao);
    // o conteudo e o mesmo que foi revisado, e continua limpo
    expect(validarTextosColetivos(textosDoModelo(l.modelo))).toEqual([]);
  });

  it("a revisao e do CONTEUDO: dados novos, hash novo, revisao antiga nao serve", () => {
    const antigo = rasc();
    const revisaoAntiga = revisaoDe(antigo);
    const e = F.grupoSuficiente();
    // chega mais uma resposta depois da revisao
    const novo = rasc({ ...e, participantes: [...e.participantes, F.pessoa({ t: "dois", eixo: "execucao" })] });
    expect(novo.conteudoSha256).not.toBe(antigo.conteudoSha256);
    expect(() => liberarParaConducao(novo, revisaoAntiga)).toThrow(/nao corresponde/);
  });

  it("a ratificacao sozinha nao libera: continua faltando a revisao", () => {
    const d = rasc();
    expect(() => liberarParaConducao(d, { ...revisaoDe(d), parecer: "pendente" })).toThrow(/parecer/);
  });

  it("a ratificacao nao contorna a cobertura: relatorio operacional nao tem o que liberar", () => {
    const r = gerarDnaColetivo(F.grupoInsuficiente());
    expect(r.tipo).toBe("relatorio_operacional");
    expect(() => liberarParaConducao(r as never, revisaoDe(rasc()))).toThrow(/nao emitido/);
  });

  it("o liberado e imutavel e o texto 'para conduzir' recusa copia", () => {
    const d = rasc();
    const l = liberarParaConducao(d, revisaoDe(d));
    expect(Object.isFrozen(l)).toBe(true);
    const copia = JSON.parse(JSON.stringify(l));
    expect(() => textoParaConducao(copia)).toThrow(/nao liberado/);
  });
});
