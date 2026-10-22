import { describe, expect, it } from "vitest";
import {
  aplicarCorrecoes,
  camposDeTexto,
  verificarSaida,
} from "./saida-prognostico";
import { prognosticoLimpo } from "./fixtures-prognostico";
import type { PrognosticContent } from "@/types/database";

function com(alteracao: (c: PrognosticContent) => void): PrognosticContent {
  const c = prognosticoLimpo();
  alteracao(c);
  return c;
}

describe("verificarSaida", () => {
  it("documento limpo nao tem violacao, inclusive com a trilha 'Direção' no texto", () => {
    expect(prognosticoLimpo().justificativa_trilha).toContain("Direção");
    expect(verificarSaida(prognosticoLimpo())).toEqual([]);
  });

  it("varre todos os campos de texto e nenhum enum", () => {
    const campos = camposDeTexto(prognosticoLimpo()).map((c) => c.campo);
    expect(campos).toContain("analise_geral");
    expect(campos).toContain("areas_chave.1.risco");
    expect(campos).toContain("plano_30_dias.0.objetivos.2");
    expect(campos).toContain("frase_ativacao.pergunta_pratica");
    expect(campos).toContain("justificativa_trilha");
    expect(campos).not.toContain("trilha_recomendada");
  });

  const casos: [string, (c: PrognosticContent) => void, string, string][] = [
    ["eixo dominante", (c) => (c.analise_geral += " Seu eixo dominante é claro."), "analise_geral", "perfil_eixo_dominante"],
    ["afirma como age", (c) => (c.areas_chave[0].diagnostico += " Você age por impulso."), "areas_chave.0.diagnostico", "voce_age"],
    ["comportamento", (c) => (c.praticas[0].descricao += " Seu comportamento mostra isso."), "praticas.0.descricao", "comportamento"],
    ["fragilidade", (c) => (c.areas_chave[1].risco = "O risco é a fragilidade do sono."), "areas_chave.1.risco", "fragilidade"],
    ["ponto fraco", (c) => (c.areas_chave[1].diagnostico += " É seu ponto fraco."), "areas_chave.1.diagnostico", "forca_comprovada"],
    ["rotula a pessoa", (c) => (c.analise_geral += " Você é uma pessoa executora."), "analise_geral", "voce_e_uma_pessoa"],
    ["dimensao como tipo", (c) => (c.analise_geral += " Seu perfil é de planejadora."), "analise_geral", "dimensao_como_tipo"],
    ["quinto nome entre aspas", (c) => (c.analise_geral += " Falta a dimensão “Liderança Estratégica”."), "analise_geral", "nome_fora_do_catalogo"],
    ["variacao de rotulo", (c) => (c.plano_30_dias[0].acao += " Trabalhe a execução diária."), "plano_30_dias.0.acao", "variacao_de_rotulo"],
    ["abreviacao de rotulo", (c) => (c.frase_ativacao.contexto = "Aparece na dimensão Visão."), "frase_ativacao.contexto", "variacao_de_rotulo"],
    ["chave interna vazada", (c) => (c.praticas[0].nome = "relacao"), "praticas.0.nome", "chave_vazada"],
    ["id de pergunta vazado", (c) => (c.plano_30_dias[0].objetivos[1] = "Revisar a q12"), "plano_30_dias.0.objetivos.1", "chave_vazada"],
    ["direcao em minuscula segue vetada", (c) => (c.analise_geral += " Na direção certa."), "analise_geral", "variacao_de_rotulo"],
    ["dimensao seguida de 'Direção' (nome de trilha nao cobre isso)", (c) => (c.analise_geral += " A dimensão Direção pesa."), "analise_geral", "nome_proprio_apos_dimensao"],
  ];

  it.each(casos)("recusa: %s", (_nome, alterar, campo, motivo) => {
    const v = verificarSaida(com(alterar));
    const achado = v.find((x) => x.campo === campo);
    expect(achado, JSON.stringify(v.map((x) => [x.campo, x.motivos]))).toBeDefined();
    expect(achado!.motivos).toContain(motivo);
  });

  it("aceita os quatro rotulos aprovados exatamente como escritos", () => {
    const c = com((x) => {
      x.analise_geral += " Você se descreve com forte orientação à dimensão “Execução e Consistência”.";
    });
    expect(verificarSaida(c)).toEqual([]);
  });

  it("recusa variacao do rotulo aprovado", () => {
    const c = com((x) => {
      x.analise_geral += " Você se descreve com forte orientação à dimensão “Execução”.";
    });
    expect(verificarSaida(c).length).toBeGreaterThan(0);
  });

  it("localiza a frase culpada, nao o campo inteiro", () => {
    const c = com((x) => {
      x.analise_geral = "Frase boa um. Você age por impulso. Frase boa dois.";
    });
    const [v] = verificarSaida(c);
    expect(v.trechos.map((t) => t.trecho)).toEqual(["Você age por impulso."]);
  });
});

describe("aplicarCorrecoes", () => {
  it("troca so o campo pedido e nao muta o original", () => {
    const original = prognosticoLimpo();
    const novo = aplicarCorrecoes(original, [{ campo: "areas_chave.0.risco", texto: "O risco é outro." }]);
    expect(novo.areas_chave[0].risco).toBe("O risco é outro.");
    expect(original.areas_chave[0].risco).not.toBe("O risco é outro.");
    expect(novo.areas_chave[1]).toEqual(original.areas_chave[1]);
  });

  it("nao cria campo", () => {
    expect(() =>
      aplicarCorrecoes(prognosticoLimpo(), [{ campo: "areas_chave.9.risco", texto: "x" }]),
    ).toThrow();
    expect(() =>
      aplicarCorrecoes(prognosticoLimpo(), [{ campo: "campo_novo", texto: "x" }]),
    ).toThrow();
  });
});
