// A TROCA EDITORIAL DO CADERNO (Rodada 72): sem travessao no texto que alguem
// le, e NADA mais mudou.
//
// A versao 1 do modelo foi gravada em `fixtures/` ANTES da troca, pelo proprio
// montador: o texto corrido (o que vai para o .txt), a pagina para imprimir (o
// que vai para o .html) e a lista de textos que forma o hash. A autenticidade
// das gravacoes e provada pelo hash registrado da versao 1. A prova de que so
// os travessoes mudaram: aplicar `semTravessao` a versao 1 (e trocar o hash
// impresso no cabecalho, que e derivado do texto) da a versao 2 byte a byte.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HASHES_DO_CADERNO_POR_VERSAO,
  TEXTOS_CADERNO,
  VERSAO_DO_MODELO_DO_CADERNO,
  cadernoDeConducao,
  hashDoCaderno,
  montarCaderno,
  paginaImprimivelDoCaderno,
  semTravessao,
  textosDoCaderno,
} from "./caderno-de-conducao";
import { ROTEIRO_OFICIAL } from "./roteiro-oficial";

const FIXTURES = join(__dirname, "fixtures");
const V1 = {
  texto: readFileSync(join(FIXTURES, "caderno-de-conducao-v1.txt"), "utf8"),
  html: readFileSync(join(FIXTURES, "caderno-de-conducao-v1.html"), "utf8"),
  textos: JSON.parse(readFileSync(join(FIXTURES, "caderno-de-conducao-v1.textos.json"), "utf8")) as string[],
};
const HASH_V1 = HASHES_DO_CADERNO_POR_VERSAO[1];
const HASH_V2 = HASHES_DO_CADERNO_POR_VERSAO[2];
const TRAVESSAO = /[—–]/;

function sha(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

describe("versao do modelo do Caderno", () => {
  it("a versao vigente e a 2, com hash proprio, e a 1 continua registrada", () => {
    const c = cadernoDeConducao();
    expect(VERSAO_DO_MODELO_DO_CADERNO).toBe(2);
    expect(c.versaoDoModelo).toBe(2);
    expect(c.conteudoSha256).toBe(HASH_V2);
    expect(HASH_V1).toBe("a71bd62321d09d292f2f34e82e14ce800f8713eb15f1adf3ff5fb4dc15164ae5");
    expect(HASH_V1).not.toBe(HASH_V2);
    // A versao do ROTEIRO (conteudo) nao mudou: so a do modelo.
    expect(c.versao).toBe("roteiro-oficial-marco-zero-2026-10-22");
  });

  it("as gravacoes da versao 1 sao autenticas: o hash delas e o registrado", () => {
    expect(sha(V1.textos.join("\n␟\n"))).toBe(HASH_V1);
    expect(V1.texto).toContain(`conteúdo ${HASH_V1}`);
    expect(V1.html).toContain(`conteúdo ${HASH_V1}`);
    // E elas TEM travessao: a troca tinha o que trocar.
    expect(V1.texto).toContain("MARCO ZERO — CADERNO DE CONDUÇÃO · USO INTERNO DA ORGANIZAÇÃO");
    expect(TRAVESSAO.test(V1.texto)).toBe(true);
  });
});

describe("a unica diferenca entre a versao 1 e a 2 e o travessao", () => {
  const c = cadernoDeConducao();

  it("lista de textos (a base do hash): semTravessao(v1) === v2, item por item", () => {
    const v2 = textosDoCaderno(c.caderno);
    expect(v2).toHaveLength(V1.textos.length);
    expect(V1.textos.map(semTravessao)).toEqual(v2);
    // So os itens que tinham travessao mudaram.
    V1.textos.forEach((antigo, i) => {
      if (!TRAVESSAO.test(antigo)) expect(v2[i]).toBe(antigo);
      else expect(v2[i]).not.toBe(antigo);
    });
  });

  it("texto corrido (Baixar em texto): v1 com o travessao trocado e o hash novo === v2", () => {
    const normalizado = semTravessao(V1.texto.split(HASH_V1).join(HASH_V2));
    expect(normalizado).toBe(c.texto);
  });

  it("pagina para imprimir (Baixar para imprimir): mesma prova", () => {
    const normalizado = semTravessao(V1.html.split(HASH_V1).join(HASH_V2));
    expect(normalizado).toBe(paginaImprimivelDoCaderno(c.caderno));
  });

  it("a troca e so de pontuacao: travessao vira dois pontos, meia-risca de horario vira 'às'", () => {
    expect(semTravessao("MARCO ZERO — CADERNO")).toBe("MARCO ZERO: CADERNO");
    expect(semTravessao("9h40–10h20")).toBe("9h40 às 10h20");
    expect(semTravessao("sem travessao: igual")).toBe("sem travessao: igual");
    // Tirando a pontuacao trocada, as letras e digitos sao os mesmos.
    const soConteudo = (t: string) => t.replace(/[—–:]|às| /g, "");
    expect(soConteudo(c.texto.split(HASH_V2).join(""))).toBe(soConteudo(V1.texto.split(HASH_V1).join("")));
  });
});

describe("nenhum travessao no que o Caderno entrega", () => {
  const c = cadernoDeConducao();

  it("texto, pagina, textos do hash, campos que a tela mostra e moldura fixa", () => {
    expect(TRAVESSAO.test(c.texto)).toBe(false);
    expect(TRAVESSAO.test(paginaImprimivelDoCaderno(c.caderno))).toBe(false);
    for (const t of textosDoCaderno(c.caderno)) expect(TRAVESSAO.test(t), t).toBe(false);
    // A tela do Caderno mostra lacunas e titulos de momento vindos do objeto.
    expect(TRAVESSAO.test(JSON.stringify(c.caderno))).toBe(false);
    for (const t of Object.values(TEXTOS_CADERNO).flat()) expect(TRAVESSAO.test(t), t).toBe(false);
    expect(c.texto.startsWith("MARCO ZERO: CADERNO DE CONDUÇÃO · USO INTERNO DA ORGANIZAÇÃO\n")).toBe(true);
  });

  it("CONTROLE: travessao em forma nao prevista no roteiro faz a montagem LANCAR", () => {
    const m0 = ROTEIRO_OFICIAL.momentos[0];
    const roteiro = {
      ...ROTEIRO_OFICIAL,
      momentos: [{ ...m0, titulo: `${m0.titulo}—sem espaco` }, ...ROTEIRO_OFICIAL.momentos.slice(1)],
    };
    expect(() => montarCaderno(roteiro)).toThrow(/travessao em forma nao prevista/);
    // E o roteiro oficial monta, com o hash da versao 2.
    expect(hashDoCaderno(montarCaderno())).toBe(HASH_V2);
  });
});
