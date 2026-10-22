import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonizarPergunta,
  conferirImpressao,
  conteudoDaImpressao,
  impressaoDigital,
  montarManifesto,
  type EtapaCanonica,
  type LinhaDeEtapa,
} from "./manifesto-questionario";

/**
 * A IMPRESSAO PUBLICADA, em docs/FORMULARIO-MARCO-ZERO.md. Esta constante e o
 * contrato com o mundo de fora: quem montou o formulario guardou este numero.
 * Se um teste daqui quebrar porque alguem mexeu no questionario, a correcao NAO
 * e trocar este numero -- e regerar o documento e avisar quem coletou.
 */
const IMPRESSAO_V2 = "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

const CANONICO: EtapaCanonica[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "docs", "questionario-v2-canonico.json"), "utf8"),
);

/** Transforma as etapas canonicas de volta em linhas cruas de `quiz_stages`. */
function linhasDe(etapas: EtapaCanonica[]): LinhaDeEtapa[] {
  return etapas.map((e) => ({
    id: 100 + e.n,
    stage_number: e.n,
    title: e.t,
    questions: e.q,
  }));
}

describe("impressaoDigital", () => {
  it("reproduz a impressao PUBLICADA das 52 perguntas da versao 2", () => {
    expect(impressaoDigital(CANONICO)).toBe(IMPRESSAO_V2);
  });

  it("muda se UMA PALAVRA de uma alternativa mudar", () => {
    const mexido: EtapaCanonica[] = JSON.parse(JSON.stringify(CANONICO));
    const q40 = mexido[3].q[0];
    expect(q40.id).toBe("q40");
    q40.options![0] = q40.options![0].replace("prioridade", "urgência");
    expect(impressaoDigital(mexido)).not.toBe(IMPRESSAO_V2);
  });

  it("muda se a ORDEM das etapas mudar", () => {
    const trocado = [CANONICO[1], CANONICO[0], ...CANONICO.slice(2)];
    expect(impressaoDigital(trocado)).not.toBe(IMPRESSAO_V2);
  });

  it("muda se um ROTULO de escala mudar", () => {
    const mexido: EtapaCanonica[] = JSON.parse(JSON.stringify(CANONICO));
    mexido[1].q[0].max_label = "Muito satisfeito";
    expect(impressaoDigital(mexido)).not.toBe(IMPRESSAO_V2);
  });

  it("conteudoDaImpressao devolve o mesmo conteudo que gerou o numero", () => {
    expect(JSON.parse(conteudoDaImpressao(CANONICO))).toEqual(CANONICO);
  });
});

describe("montarManifesto", () => {
  it("monta a versao 2 a partir das linhas de quiz_stages e chega na impressao publicada", () => {
    const r = montarManifesto(linhasDe(CANONICO), 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifesto.impressao).toBe(IMPRESSAO_V2);
    expect(r.manifesto.perguntas).toHaveLength(52);
    expect(r.manifesto.etapas).toHaveLength(5);
    expect(r.manifesto.idsDasEtapas).toEqual({ 1: 101, 2: 102, 3: 103, 4: 104, 5: 105 });
    expect(r.manifesto.etapaDaPergunta.q40).toBe(4);
    expect(r.manifesto.porId.q7.max).toBe(10);
  });

  it("nao se importa com a ordem em que as linhas chegam do banco", () => {
    const desordenadas = [...linhasDe(CANONICO)].reverse();
    const r = montarManifesto(desordenadas, 2);
    expect(r.ok && r.manifesto.impressao).toBe(IMPRESSAO_V2);
  });

  it("campo ausente e campo null dao a MESMA impressao", () => {
    const comNulls = linhasDe(CANONICO);
    const semNulls = linhasDe(CANONICO).map((l) => ({
      ...l,
      questions: (l.questions as Record<string, unknown>[]).map((q) => {
        const limpo: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(q)) if (v !== null) limpo[k] = v;
        return limpo;
      }),
    }));
    const a = montarManifesto(comNulls, 2);
    const b = montarManifesto(semNulls, 2);
    expect(a.ok && b.ok && a.manifesto.impressao === b.manifesto.impressao).toBe(true);
    expect(b.ok && b.manifesto.impressao).toBe(IMPRESSAO_V2);
  });

  it("linhas NAO LIDAS (null) sao MANIFESTO_INDISPONIVEL, nao manifesto vazio", () => {
    const r = montarManifesto(null, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("MANIFESTO_INDISPONIVEL");
  });

  it("versao sem etapas e MANIFESTO_INVALIDO (consultou e o dado esta errado)", () => {
    const r = montarManifesto([], 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("MANIFESTO_INVALIDO");
  });

  it("recusa stage_number com buraco em vez de montar na ordem que vier", () => {
    const linhas = linhasDe(CANONICO);
    linhas[4].stage_number = 9;
    const r = montarManifesto(linhas, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.codigo).toBe("MANIFESTO_INVALIDO");
    expect(r.motivo).toContain("1..N");
  });

  it("recusa stage_number nulo", () => {
    const linhas = linhasDe(CANONICO);
    linhas[0].stage_number = null;
    expect(montarManifesto(linhas, 2).ok).toBe(false);
  });

  it("recusa id de pergunta repetido em duas etapas", () => {
    const linhas = linhasDe(CANONICO);
    linhas[1].questions = [
      ...(linhas[1].questions as unknown[]),
      { id: "q1", text: "duplicada", type: "text" },
    ];
    const r = montarManifesto(linhas, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain("q1");
    expect(r.motivo).toContain("unicos");
  });

  it("recusa questions que nao e lista", () => {
    const linhas = linhasDe(CANONICO);
    linhas[0].questions = { q1: "oi" };
    expect(montarManifesto(linhas, 2).ok).toBe(false);
  });
});

describe("canonizarPergunta", () => {
  it("normaliza ausente/null para null, sem inventar valor", () => {
    const r = canonizarPergunta({ id: "qX", text: "t", type: "text" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pergunta).toEqual({
      id: "qX",
      text: "t",
      type: "text",
      required: null,
      options: null,
      min: null,
      max: null,
      min_label: null,
      max_label: null,
      min_chars: null,
      max_chars: null,
    });
  });

  it("recusa options que nao e lista de textos", () => {
    const r = canonizarPergunta({ id: "qX", text: "t", type: "select", options: [1, 2] });
    expect(r.ok).toBe(false);
  });

  it("recusa escala com min que nao e inteiro", () => {
    const r = canonizarPergunta({ id: "qX", text: "t", type: "scale", min: 1.5, max: 5 });
    expect(r.ok).toBe(false);
  });
});

describe("conferirImpressao -- TRES desfechos, nunca dois", () => {
  it("IGUAL: a coleta declarou a mesma impressao do sistema", () => {
    const r = conferirImpressao(IMPRESSAO_V2, IMPRESSAO_V2);
    expect(r.veredito).toBe("igual");
  });

  it("IGUAL aceita espaco nas pontas e maiuscula (uma impressao e um numero)", () => {
    expect(conferirImpressao(`  ${IMPRESSAO_V2.toUpperCase()} `, IMPRESSAO_V2).veredito).toBe(
      "igual",
    );
  });

  it("DIFERENTE: questionario alterado. Veredito de recusa, com os dois numeros", () => {
    const outra = impressaoDigital([{ n: 1, t: "x", q: [] }]);
    const r = conferirImpressao(outra, IMPRESSAO_V2);
    expect(r.veredito).toBe("diferente");
    if (r.veredito !== "diferente") return;
    expect(r.declarada).toBe(outra);
    expect(r.doSistema).toBe(IMPRESSAO_V2);
    expect(r.motivo).toContain("NAO e o que o sistema conhece");
  });

  it("INDISPONIVEL: ninguem declarou impressao. NAO e igual e NAO e diferente", () => {
    for (const vazio of [undefined, null, "", "   ", 42, {}]) {
      const r = conferirImpressao(vazio, IMPRESSAO_V2);
      expect(r.veredito).toBe("indisponivel");
    }
  });

  it("INDISPONIVEL: impressao que nao e SHA-256 hexadecimal de 64 digitos", () => {
    for (const lixo of ["abc", IMPRESSAO_V2.slice(0, 63), `${IMPRESSAO_V2}00", "zz`]) {
      expect(conferirImpressao(lixo, IMPRESSAO_V2).veredito).toBe("indisponivel");
    }
  });

  it("nunca devolve IGUAL por acidente de normalizacao", () => {
    // Um digito trocado e DIFERENTE, nao "quase igual".
    const quase = `0${IMPRESSAO_V2.slice(1)}`;
    expect(conferirImpressao(quase, IMPRESSAO_V2).veredito).toBe("diferente");
  });
});
