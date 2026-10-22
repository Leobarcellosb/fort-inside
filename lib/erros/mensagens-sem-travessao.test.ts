import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFINICOES_DE_ERRO, type DetalhesDeErro, type TodoCodigoDeErro } from "./codigos";
import { MENSAGEM_FILA_INDISPONIVEL, MENSAGEM_GENERICA, mensagemParaHost } from "./mensagens-host";

// Texto que alguem le nao tem travessao (pedido do dono: "pra nao ter cara de IA").
const TRAVESSAO = /[—–]/;

// As mensagens que dependem de detalhe mudam de texto conforme o detalhe:
// cada variante conhecida passa pela mesma regra.
const VARIANTES: (DetalhesDeErro | undefined)[] = [
  undefined,
  { etapa_atual: 1, total_etapas: 5 },
  { modo_do_evento: "async" } as DetalhesDeErro,
  { modo_do_evento: "desconhecido" } as DetalhesDeErro,
  { etapa_pedida: 6, total_etapas: 5 } as DetalhesDeErro,
];

describe("mensagens do host sem travessao", () => {
  it("nenhum codigo, em nenhuma variante de detalhe, devolve travessao", () => {
    const codigos = Object.keys(DEFINICOES_DE_ERRO) as TodoCodigoDeErro[];
    expect(codigos.length).toBeGreaterThan(20);
    const comTravessao = codigos.flatMap((c) =>
      VARIANTES.filter((d) => TRAVESSAO.test(mensagemParaHost(c, d))).map(() => c),
    );
    expect(comTravessao).toEqual([]);
    expect(MENSAGEM_GENERICA).not.toMatch(TRAVESSAO);
    expect(MENSAGEM_FILA_INDISPONIVEL).not.toMatch(TRAVESSAO);
  });

  it("evento assincrono: a recusa de liberar etapa diz o motivo, sem travessao", () => {
    const texto = mensagemParaHost("STAGE_RELEASE_MODE_MISMATCH", { modo_do_evento: "async" } as DetalhesDeErro);
    expect(texto).toContain("ele é assíncrono: as pessoas respondem por conta própria");
    expect(texto).toContain("Nenhuma etapa foi liberada e nada foi alterado.");
  });

  it("controle positivo: a regra pega o travessao quando ele existe", () => {
    expect("assíncrono — as pessoas").toMatch(TRAVESSAO);
  });

  it("nenhuma string do arquivo tem travessao (comentario pode ter)", () => {
    const fonte = readFileSync(new URL("./mensagens-host.ts", import.meta.url), "utf8");
    const linhas = fonte
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter((l) => TRAVESSAO.test(l));
    expect(linhas).toEqual([]);
  });
});
