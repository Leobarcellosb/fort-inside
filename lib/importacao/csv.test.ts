// A LEITURA DO ARQUIVO EXPORTADO: separador declarado, aspas respeitadas, e linha
// curta NUNCA completada com vazio.
//
// Linha curta completada com vazio e o mesmo defeito da unidade anterior, um nivel
// abaixo: transformaria colunas perdidas em respostas ausentes, em silencio, para
// a pessoa daquela linha. Aqui ela sai curta, e `lerPlanilha` a recusa dizendo
// qual.

import { describe, expect, it } from "vitest";
import { identificarSubmissoes, lerCsv } from "./csv";

describe("o separador e declarado, nunca adivinhado", () => {
  it("CONTROLE POSITIVO: virgula", () => {
    const r = lerCsv("a,b\n1,2\n", ",");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cabecalhos).toEqual(["a", "b"]);
      expect(r.linhas).toEqual([{ numero: 2, celulas: ["1", "2"] }]);
    }
  });

  it("CONTROLE POSITIVO: ponto e virgula e tabulacao", () => {
    expect(lerCsv("a;b\n1;2", ";")).toMatchObject({ ok: true, cabecalhos: ["a", "b"] });
    expect(lerCsv("a\tb\n1\t2", "\t")).toMatchObject({ ok: true, cabecalhos: ["a", "b"] });
  });

  it("NEGATIVA: o MESMO arquivo lido com o separador errado NAO e remendado -- sai uma coluna so", () => {
    // Nao ha deteccao automatica de proposito: um palpite errado aqui leria a
    // resposta de uma pergunta como se fosse de outra.
    const r = lerCsv("a;b\n1;2", ",");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cabecalhos).toEqual(["a;b"]);
    // E e `casarColunas` que vai recusar isso, nomeando a coluna desconhecida.
  });
});

describe("aspas, quebras e BOM", () => {
  it("campo entre aspas com o separador dentro", () => {
    const r = lerCsv('a,b\n"x, y",2', ",");
    expect(r.ok && r.linhas[0].celulas).toEqual(["x, y", "2"]);
  });

  it("aspas duplicadas valem uma aspa literal", () => {
    const r = lerCsv('a\n"ele disse ""oi"""', ",");
    expect(r.ok && r.linhas[0].celulas).toEqual(['ele disse "oi"']);
  });

  it("quebra de linha DENTRO de campo entre aspas nao parte a submissao", () => {
    const r = lerCsv('a,b\n"linha 1\nlinha 2",fim', ",");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.linhas).toHaveLength(1);
      expect(r.linhas[0].celulas).toEqual(["linha 1\nlinha 2", "fim"]);
    }
  });

  it("CRLF e CR solto contam como uma quebra", () => {
    expect(lerCsv("a,b\r\n1,2\r\n", ",")).toMatchObject({ ok: true });
    const r = lerCsv("a,b\r\n1,2", ",");
    expect(r.ok && r.linhas[0].celulas).toEqual(["1", "2"]);
  });

  it("BOM no inicio nao entra no primeiro cabecalho", () => {
    const r = lerCsv("﻿Endereço de e-mail,b\nx,y", ",");
    expect(r.ok && r.cabecalhos[0]).toBe("Endereço de e-mail");
  });

  it("NEGATIVA: aspas abertas e nunca fechadas -> ASPAS_ABERTAS, nao 'uma resposta gigante'", () => {
    const r = lerCsv('a,b\n"nunca fecha,2\n3,4', ",");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("ASPAS_ABERTAS");
  });
});

describe("o que nao e submissao", () => {
  it.each([
    ["arquivo vazio", "", "ARQUIVO_VAZIO"],
    ["so espaco", "   \n  ", "ARQUIVO_VAZIO"],
    ["so cabecalho", "a,b\n", "SO_CABECALHO"],
    ["cabecalho e linhas vazias", "a,b\n\n,\n", "SO_CABECALHO"],
  ])("NEGATIVA (%s) -> %s", (_n, conteudo, codigo) => {
    const r = lerCsv(conteudo, ",");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe(codigo);
  });

  it("linha vazia no meio e descartada, nao tratada como alguem que respondeu em branco", () => {
    const r = lerCsv("a,b\n1,2\n\n3,4", ",");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.linhas).toHaveLength(2);
      expect(r.linhas.map((l) => l.numero)).toEqual([2, 4]);
    }
  });
});

describe("linha curta NAO e completada com vazio", () => {
  it("NEGATIVA: a linha sai com as celulas que tem, e o numero da linha e preservado", () => {
    const r = lerCsv("a,b,c\n1,2\n", ",");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cabecalhos).toHaveLength(3);
      expect(r.linhas[0].celulas).toEqual(["1", "2"]);
      expect(r.linhas[0].celulas).not.toHaveLength(3);
      expect(r.linhas[0].numero).toBe(2);
    }
  });

  it("CONTROLE POSITIVO: a linha completa sai completa", () => {
    const r = lerCsv("a,b,c\n1,2,3", ",");
    expect(r.ok && r.linhas[0].celulas).toEqual(["1", "2", "3"]);
  });
});

describe("o identificador da submissao nao e inventado", () => {
  const linhas = [
    { numero: 2, celulas: ["2026-10-20 10:00:00", "maria@x"] },
    { numero: 3, celulas: ["", "joao@x"] },
  ];

  it("sem coluna apontada, o identificador declara que veio da POSICAO na planilha", () => {
    const r = identificarSubmissoes(linhas, null);
    expect(r.map((x) => x.submissao_id)).toEqual(["linha-2", "linha-3"]);
  });

  it("com coluna apontada, usa o valor dela -- e cai para a posicao quando a celula esta vazia", () => {
    const r = identificarSubmissoes(linhas, 0);
    expect(r[0].submissao_id).toBe("2026-10-20 10:00:00");
    // Celula vazia NAO vira id vazio (que `lerPlanilha` recusaria sem dizer de
    // onde veio): vira a posicao, e fica legivel na proveniencia qual foi.
    expect(r[1].submissao_id).toBe("linha-3");
  });

  it("as celulas atravessam intactas", () => {
    expect(identificarSubmissoes(linhas, 0)[0].celulas).toEqual(linhas[0].celulas);
  });
});
