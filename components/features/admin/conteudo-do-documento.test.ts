import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prognosticoLimpo } from "@/lib/ai/fixtures-prognostico";
import { pdfPermitido } from "@/lib/pdf/politica-do-pdf";
import { ehMarcoZero } from "@/lib/cinematic-map";
import { TEXTO_SEM_REVISAO_SALVA } from "./entrega-do-documento";
import {
  TEXTO_CONTEUDO_INDISPONIVEL,
  conteudoDaLinha,
  conteudoDoDocumentoValido,
  situacaoDaEntregaDoDocumento,
} from "./conteudo-do-documento";

const TRAVESSAO = /[—–]/;

// O que a tela de revisao fazia com o documento ANTES da Rodada 86: o grid lia
// `content?.analise_geral?.split(...)` e o editor percorria cada secao com
// `.map` e acessava `frase_ativacao.frase` direto. E o controle negativo: se
// estas funcoes lancam para a forma ruim, o validador esta protegendo de um
// travamento real, nao de um caso inventado.
function caminhoAntigoDoGrid(content: any) {
  return content?.analise_geral?.split(/\n\n+/)[0];
}
function caminhoAntigoDoEditor(content: any) {
  content.areas_chave.map((a: any) => a.nome);
  content.plano_30_dias.map((p: any) => p.objetivos.map((o: string) => o));
  content.praticas.map((p: any) => p.nome);
  return content.frase_ativacao.frase;
}

const semSecao = (campo: string) => {
  const c = { ...prognosticoLimpo() } as Record<string, unknown>;
  delete c[campo];
  return c;
};

// Cada forma ruim, com o motivo de existir. As de "texto antigo" sao as que o
// dado de teste velho realmente tem; as outras sao o que o JSON pode ser.
const FORMAS_RUINS: Array<[string, unknown]> = [
  ["null", null],
  ["undefined (coluna ausente)", undefined],
  ["objeto vazio {}", {}],
  ["lista vazia []", []],
  ["texto solto", "documento antigo"],
  ["numero", 0],
  ["sem areas_chave", semSecao("areas_chave")],
  ["sem plano_30_dias", semSecao("plano_30_dias")],
  ["sem praticas", semSecao("praticas")],
  ["sem frase_ativacao", semSecao("frase_ativacao")],
  ["sem trilha_recomendada", semSecao("trilha_recomendada")],
  ["sem justificativa_trilha", semSecao("justificativa_trilha")],
  ["sem analise_geral", semSecao("analise_geral")],
  ["analise_geral em branco", { ...prognosticoLimpo(), analise_geral: "   " }],
  ["analise_geral que nao e texto", { ...prognosticoLimpo(), analise_geral: 42 }],
  ["areas_chave vazia", { ...prognosticoLimpo(), areas_chave: [] }],
  ["areas_chave que nao e lista", { ...prognosticoLimpo(), areas_chave: "x" }],
  ["area_chave nula dentro da lista", { ...prognosticoLimpo(), areas_chave: [null] }],
  [
    "plano sem objetivos",
    {
      ...prognosticoLimpo(),
      plano_30_dias: [{ titulo: "t", acao: "a", resultado_esperado: "r" }],
    },
  ],
  [
    "plano com objetivos vazio",
    {
      ...prognosticoLimpo(),
      plano_30_dias: [{ titulo: "t", objetivos: [], acao: "a", resultado_esperado: "r" }],
    },
  ],
  ["frase_ativacao nula", { ...prognosticoLimpo(), frase_ativacao: null }],
  ["trilha fora da lista", { ...prognosticoLimpo(), trilha_recomendada: "Outra" }],
  // Forma de outra epoca: secoes com outros nomes.
  ["estrutura inesperada", { resumo: "x", secoes: [{ titulo: "a" }] }],
];

describe("conteudoDoDocumentoValido", () => {
  // v1 (com PDF) e v2 (Marco Zero) guardam o MESMO formato de documento; o que
  // muda entre eles e so a tela. Prova-se nos dois lados do mesmo interruptor
  // que a tela usa (ehMarcoZero / pdfPermitido), para o teste falhar se alguem
  // um dia separar os formatos sem atualizar o validador.
  for (const quiz_version of [1, 2]) {
    const produto = ehMarcoZero(quiz_version) ? "v2 (Marco Zero)" : "v1";

    describe(`${produto}`, () => {
      it("documento completo e valido, e devolve o MESMO objeto (nada e copiado nem reescrito)", () => {
        const doc = prognosticoLimpo();
        const r = conteudoDoDocumentoValido(doc);
        expect(r.valido).toBe(true);
        if (r.valido) expect(r.conteudo).toBe(doc);
        expect(pdfPermitido({ quiz_version })).toBe(quiz_version === 1);
      });

      it("o caminho antigo funciona no documento valido (nada mudou para quem ja estava bom)", () => {
        const doc = prognosticoLimpo();
        expect(() => caminhoAntigoDoGrid(doc)).not.toThrow();
        expect(() => caminhoAntigoDoEditor(doc)).not.toThrow();
      });

      for (const [nome, ruim] of FORMAS_RUINS) {
        it(`${nome}: invalido, com o aviso e sem lancar`, () => {
          const r = conteudoDoDocumentoValido(ruim);
          expect(r.valido).toBe(false);
          if (r.valido) throw new Error("inalcancavel");
          expect(r.texto).toBe(TEXTO_CONTEUDO_INDISPONIVEL);
          expect(r.problemas.length).toBeGreaterThan(0);
        });
      }

      it("a linha inteira: edited_content ruim NAO cai no raw_ai_output para 'consertar' (sem reparo automatico)", () => {
        // `??` so cai para o raw quando o edited e null/undefined. Um edited `{}`
        // e dado ruim e fica ruim: nenhuma heuristica escolhe outro texto.
        const r = conteudoDaLinha({ edited_content: {}, raw_ai_output: prognosticoLimpo() });
        expect(r.valido).toBe(false);
      });

      it("a linha inteira: edited_content nulo usa o raw_ai_output, como sempre", () => {
        const r = conteudoDaLinha({ edited_content: null, raw_ai_output: prognosticoLimpo() });
        expect(r.valido).toBe(true);
      });
    });
  }

  it("CONTROLE NEGATIVO: toda forma ruim derrubava o caminho antigo; o validador recusa as mesmas", () => {
    let derrubavam = 0;
    for (const [, ruim] of FORMAS_RUINS) {
      let lancou = false;
      try {
        caminhoAntigoDoGrid(ruim);
        caminhoAntigoDoEditor(ruim);
      } catch {
        lancou = true;
      }
      if (lancou) derrubavam += 1;
      // Nao importa se o caminho antigo lancava ou nao: o validador recusa sempre.
      expect(conteudoDoDocumentoValido(ruim).valido).toBe(false);
    }
    // O caso original (a pagina caindo) existe de verdade nesta lista: se isto
    // virasse 0, o teste teria parado de reproduzir o defeito.
    expect(derrubavam).toBeGreaterThanOrEqual(10);
    expect(() => caminhoAntigoDoEditor({})).toThrow(TypeError);
    expect(() => caminhoAntigoDoEditor(null)).toThrow(TypeError);
    expect(() => caminhoAntigoDoGrid({ analise_geral: 42 })).toThrow(TypeError);
  });

  it("os problemas apontam QUAIS partes faltam, em palavras de quem opera", () => {
    const r = conteudoDoDocumentoValido(semSecao("areas_chave"));
    if (r.valido) throw new Error("inalcancavel");
    expect(r.problemas).toEqual(["faltam as áreas-chave"]);
    const vazio = conteudoDoDocumentoValido({});
    if (vazio.valido) throw new Error("inalcancavel");
    expect(vazio.problemas).toEqual(["o documento está vazio"]);
  });

  it("campo de texto em branco numa secao ainda abre (o operador conserta digitando)", () => {
    const doc = prognosticoLimpo();
    doc.areas_chave[0].risco = "";
    expect(conteudoDoDocumentoValido(doc).valido).toBe(true);
  });

  it("nao escreve nem completa nada: o objeto recebido continua como estava", () => {
    const ruim = { analise_geral: "texto" } as Record<string, unknown>;
    const antes = JSON.stringify(ruim);
    conteudoDoDocumentoValido(ruim);
    expect(JSON.stringify(ruim)).toBe(antes);
    expect(Object.keys(ruim)).toEqual(["analise_geral"]);
  });

  it("o texto do aviso nao tem travessao", () => {
    expect(TEXTO_CONTEUDO_INDISPONIVEL).not.toMatch(TRAVESSAO);
    for (const [, ruim] of FORMAS_RUINS) {
      const r = conteudoDoDocumentoValido(ruim);
      if (r.valido) continue;
      expect(`${r.texto}${r.problemas.join(" ")}`).not.toMatch(TRAVESSAO);
    }
  });
});

describe("situacaoDaEntregaDoDocumento: sem conteudo, nao entrega", () => {
  const COM_SELO = { status: "reviewed", conteudo_aprovado_hash: "a3f9c1" };

  it("documento valido e com selo: liberada, igual a antes", () => {
    const s = situacaoDaEntregaDoDocumento({
      ...COM_SELO,
      edited_content: null,
      raw_ai_output: prognosticoLimpo(),
    });
    expect(s).toEqual({ liberada: true });
  });

  it("documento valido sem selo: o motivo continua sendo o da revisao salva", () => {
    const s = situacaoDaEntregaDoDocumento({
      status: "generated",
      conteudo_aprovado_hash: null,
      raw_ai_output: prognosticoLimpo(),
    });
    expect(s).toEqual({
      liberada: false,
      motivo: "sem_revisao_salva",
      texto: TEXTO_SEM_REVISAO_SALVA,
    });
  });

  for (const [nome, ruim] of FORMAS_RUINS) {
    it(`${nome}: bloqueada MESMO com selo de aprovacao, e a razao e a do conteudo`, () => {
      const s = situacaoDaEntregaDoDocumento({
        ...COM_SELO,
        edited_content: null,
        raw_ai_output: ruim,
      });
      expect(s.liberada).toBe(false);
      if (s.liberada) throw new Error("inalcancavel");
      expect(s.motivo).toBe("conteudo_indisponivel");
      expect(s.texto).toBe(TEXTO_CONTEUDO_INDISPONIVEL);
    });
  }
});

describe("a tela esta ligada ao validador (leitura da fonte, como o resto do repo)", () => {
  const dialogo = readFileSync(new URL("./EditPrognosticDialog.tsx", import.meta.url), "utf8");
  const grade = readFileSync(new URL("./PrognosticReviewGrid.tsx", import.meta.url), "utf8");

  it("o editor confere o conteudo antes de montar o formulario e nao oferece salvar sem ele", () => {
    expect(dialogo).toContain("conteudoDoDocumentoValido(props.initialContent)");
    // O botao de salvar existe uma vez, dentro do editor; o aviso nao o tem.
    const aviso = dialogo.slice(
      dialogo.indexOf("function ConteudoIndisponivel"),
      dialogo.indexOf("function EditorDoPrognostico"),
    );
    expect(aviso).not.toContain("handleSave");
    expect(aviso).not.toContain("Salvar");
  });

  it("a grade nao le campo de documento sem conferir, e nao entrega sem conteudo", () => {
    expect(grade).not.toMatch(/content\?\.analise_geral/);
    expect(grade).toContain("situacaoDaEntregaDoDocumento(prog)");
    expect(grade).toContain("conteudoDaLinha(prog)");
    expect(grade).toMatch(/disabled=\{saving \|\| !entrega\.liberada\}/);
  });

  it("nenhum texto novo da tela tem travessao (comentarios podem ter)", () => {
    const texto = dialogo
      .slice(dialogo.indexOf("function ConteudoIndisponivel"), dialogo.indexOf("type PropsDoEditor"))
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
      .join("\n");
    expect(texto).not.toMatch(TRAVESSAO);
  });
});
