import { describe, expect, it } from "vitest";
import {
  QUIZ_VERSION_MARCO_ZERO,
  prepararBriefing,
} from "./briefing-prognostico";
import {
  buildSystemPromptMarcoZero,
  buildUserPromptMarcoZero,
} from "./prognostic-prompt";
import {
  COM_DESTAQUE_VISAO,
  ETAPAS_MARCO_ZERO,
  respostasMarcoZero,
  type OpcoesDeRespostas,
} from "./fixtures-marco-zero";
import {
  TEXTO_SITUACIONAL_SEM_DESTAQUE,
  textosDoParticipante,
} from "../scoring/briefing-marco-zero";
import { ROTULOS_DIMENSAO } from "../../components/features/marco-zero/catalogo-dimensoes";
import { validarTextoDeSaida } from "../../components/features/marco-zero/validacao-saida";

function montar(o?: OpcoesDeRespostas) {
  const respostas = respostasMarcoZero(o);
  const b = prepararBriefing(respostas);
  if (!b.ok) throw new Error(b.error);
  const user = buildUserPromptMarcoZero("Ana Souza", {
    responses: respostas,
    stages: ETAPAS_MARCO_ZERO,
    blocoBriefing: b.bloco,
  });
  return { respostas, b, user, system: buildSystemPromptMarcoZero([]) };
}

describe("a versao do Marco Zero", () => {
  it("e a 2", () => expect(QUIZ_VERSION_MARCO_ZERO).toBe(2));
});

describe("criterio 1: o prompt carrega o briefing, nao so as respostas cruas", () => {
  it("contem o bloco do briefing inteiro, verbatim", () => {
    const { b, user } = montar(COM_DESTAQUE_VISAO);
    expect(b.bloco).toContain("BRIEFING DO MARCO ZERO");
    expect(user).toContain(b.bloco);
  });

  it("os fragmentos medidos aparecem com a classificacao e o rotulo do catalogo", () => {
    const { user } = montar(COM_DESTAQUE_VISAO);
    expect(user).toContain("[FATO MEDIDO]");
    expect(user).toContain("[HIPÓTESE A VALIDAR]");
    expect(user).toContain(`“${ROTULOS_DIMENSAO[0]}”`);
    expect(user).toContain("Você se descreve com forte orientação à dimensão");
  });

  it("o valor cru de nenhuma pergunta pontuada chega ao modelo", () => {
    const { user } = montar(COM_DESTAQUE_VISAO);
    expect(user).not.toMatch(/PERGUNTA-PONTUADA/);
    // texto da opcao situacional gravado pela interface
    expect(user).not.toContain("Organizar o problema e definir a prioridade");
    // titulos das etapas que so tem pergunta pontuada
    expect(user).not.toContain("Perfil comportamental");
    expect(user).not.toContain("Como você reage na prática");
  });

  it("as respostas abertas chegam, e ficam separadas do briefing", () => {
    const { user } = montar();
    const [antes, abertas] = user.split("RESPOSTAS ABERTAS DE");
    expect(antes).toContain("BRIEFING DO MARCO ZERO");
    expect(abertas).toContain("Decidir se deixo a presidência da associação.");
    expect(abertas).toContain("Saúde e energia, porque tenho dormido mal");
    expect(abertas).not.toContain("BRIEFING DO MARCO ZERO");
  });
});

describe("criterio 2: sem eixo destacado o prompt nao pede para escolher eixo", () => {
  it("o caso comum (indeterminado nos dois instrumentos) leva o texto aprovado", () => {
    const { b, user } = montar();
    expect(b.briefing.eixos.likert.classificacao).toBe("indeterminado");
    expect(b.briefing.eixos.situacional.classificacao).toBe("indeterminado");
    expect(user).toContain("[INDETERMINADO]");
    expect(user).toContain(TEXTO_SITUACIONAL_SEM_DESTAQUE[0]);
    expect(user).toContain("Não afirmar nem inferir");
  });

  it("nenhum fragmento afirma destaque ou tendencia", () => {
    const { user } = montar();
    expect(user).not.toContain("forte orientação");
    expect(user).not.toContain("favoreceu");
    expect(user).not.toContain("teve o maior destaque");
    // as REGRAS do bloco citam a etiqueta; so um FRAGMENTO comeca com ela
    expect(user.split("\n").filter((l) => l.startsWith("[HIPÓTESE A VALIDAR]"))).toEqual([]);
  });

  it("nenhuma linha do prompt manda escolher, identificar ou classificar eixo/dimensao sem negar", () => {
    const { user, system } = montar();
    const pede = /\b(escolh\w+|identifi\w+|determin\w+|defin\w+|indiqu\w+|aponte|classifi\w+|elej\w+)\b.*\b(eixo|eixos|dimens\w+|perfil)\b/i;
    for (const linha of `${system}\n${user}`.split("\n")) {
      if (pede.test(linha)) {
        expect(linha, `linha pede escolha de eixo sem negar: ${linha}`).toMatch(/\b(não|nunca|nada|sem)\b/i);
      }
    }
  });
});

describe("criterio 3: elemento nao respondido nao vira fragilidade", () => {
  const SEM_EQUILIBRIO: OpcoesDeRespostas = { elementos: [7, 6, undefined, 5, 9, 7, 4] };

  it("o nome do elemento ausente nao aparece em lugar nenhum do que vai ao modelo", () => {
    const { user, system } = montar(SEM_EQUILIBRIO);
    expect(user).not.toContain("Equilíbrio emocional");
    expect(system).not.toContain("Equilíbrio emocional");
  });

  it("com 6 de 7 nao ha maior nem menor; a media avisa que os demais nao entram na conta", () => {
    const { b, user } = montar(SEM_EQUILIBRIO);
    expect(b.briefing.elementos.maior.classificacao).toBe("indeterminado");
    expect(b.briefing.elementos.menor.classificacao).toBe("indeterminado");
    expect(user).not.toContain("Entre os sete elementos avaliados");
    expect(user).toContain("sem resposta e não entram na conta");
  });

  it("nenhum fragmento do usuario chama algo de fragilidade, lacuna ou nota baixa", () => {
    const { user } = montar(SEM_EQUILIBRIO);
    const [briefing] = user.split("RESPOSTAS ABERTAS DE");
    // o bloco de regras diz "Dado ausente não é nota baixa" (negacao); fora dela, nada
    const fragmentos = briefing
      .split("\n")
      .filter((l) => !l.startsWith("- "))
      .join("\n");
    expect(fragmentos).not.toMatch(/fragil|fraqueza|lacuna|nota baixa|pior/i);
  });

  it("o numero cru do elemento ausente nao existe: nada de 0 inventado", () => {
    const { user } = montar(SEM_EQUILIBRIO);
    expect(user).not.toMatch(/\b0 de 10\b|nota 0\b/);
  });
});

describe("o briefing nunca contradiz o veto", () => {
  const casos: [string, OpcoesDeRespostas][] = [
    ["sem destaque", {}],
    ["com destaque e convergencia", COM_DESTAQUE_VISAO],
    ["contraste", { likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 }, situacionais: ["B", "D", "A", "A", "C", "B"] }],
    ["elementos incompletos", { elementos: [7, undefined, undefined, 5, 9, 7, 4] }],
    ["poucos elementos", { elementos: [7, undefined, undefined, undefined, 9, undefined, undefined] }],
  ];
  it.each(casos)("todo texto do briefing passa pela validacao de saida (%s)", (_n, o) => {
    const { b } = montar(o);
    for (const t of textosDoParticipante(b.briefing)) {
      expect(validarTextoDeSaida(t), t).toEqual([]);
    }
  });
});

describe("falha antes de gastar modelo", () => {
  it("valor ilegivel numa pergunta pontuada e erro de dados, nao ausencia", () => {
    const respostas = respostasMarcoZero();
    (respostas[2].answers as Record<string, unknown>).q20 = "abc";
    const r = prepararBriefing(respostas);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain("q20");
      expect(r.error).not.toContain("abc");
    }
  });
});
