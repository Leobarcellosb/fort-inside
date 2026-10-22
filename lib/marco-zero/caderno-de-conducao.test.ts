// O QUE ESTE ARQUIVO PROVA, e por que cada prova existe.
//
//  1. OS OITO MOMENTOS estao presentes, na ordem, com os ids fechados -- e falta
//     ou sobra de momento QUEBRA a montagem;
//  2. TODO item carrega PROVENIENCIA: oficial aponta para uma fonte registrada,
//     lacuna aponta para onde foi conferida e para quem tem de entrega-la;
//  3. NENHUMA LACUNA E PREENCHIDA. A garantia e estrutural: o tipo da lacuna nao
//     tem campo de conteudo. O teste prende isso;
//  4. AS QUATRO AREAS PEDAGOGICAS que esta unidade nao pode escrever (perguntas
//     da SWOT, instrucoes do Mural, metodo do Manifesto, objetivos do movimento)
//     estao declaradas como lacuna -- e nao como texto;
//  5. O VARREDOR recusa afirmacao sobre quem estara na sala, nas DUAS camadas,
//     com CONTROLE POSITIVO: frases que devem passar passam;
//  6. O HASH e estavel e muda com o conteudo;
//  7. O Caderno IMPRIME numero operacional (a divergencia deliberada da regra do
//     Guia) e NAO depende de resposta alguma: duas montagens sao identicas;
//  8. A pagina de impressao e AUTOCONTIDA: sem script, sem recurso de rede.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FONTES,
  MOMENTOS_OBRIGATORIOS,
  ROTEIRO_OFICIAL,
  VERSAO_DO_ROTEIRO,
  type MomentoDoRoteiro,
  type RoteiroOficial,
} from "./roteiro-oficial";
import {
  cadernoDeConducao,
  encontrarAfirmacaoSobreOsJovens,
  hashDoCaderno,
  montarCaderno,
  paginaImprimivelDoCaderno,
  textoDoCaderno,
  textosDoCaderno,
} from "./caderno-de-conducao";

const AQUI = join(__dirname);

function momento(id: string): MomentoDoRoteiro {
  const m = ROTEIRO_OFICIAL.momentos.find((x) => x.id === id);
  if (!m) throw new Error(`momento ausente no teste: ${id}`);
  return m;
}

/** Um roteiro valido minimo, para os testes que precisam ADULTERAR a entrada. */
function roteiroComTexto(texto: string): RoteiroOficial {
  return {
    versao: "teste",
    momentos: MOMENTOS_OBRIGATORIOS.map((id, i) => ({
      id,
      numero: i + 1,
      titulo: `Momento ${i + 1}`,
      quando: null,
      itens: [{ tipo: "operacao" as const, rotulo: "item", texto: i === 0 ? texto : "procedimento" }],
    })),
  };
}

describe("1. os oito momentos", () => {
  it("são oito, na ordem, com os ids fechados", () => {
    const c = montarCaderno();
    expect(c.momentos.map((m) => m.id)).toEqual([
      "antes_da_recepcao",
      "abertura",
      "tres_missoes",
      "swot_em_grupo",
      "mural_do_futuro",
      "manifesto",
      "encerramento",
      "contingencias",
    ]);
    expect(c.momentos.map((m) => m.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("todos têm título e pelo menos um item", () => {
    for (const m of montarCaderno().momentos) {
      expect(m.titulo.length).toBeGreaterThan(0);
      expect(m.itens.length).toBeGreaterThan(0);
    }
  });

  it("falta de momento QUEBRA a montagem", () => {
    const r = roteiroComTexto("procedimento");
    const sete = { ...r, momentos: r.momentos.slice(0, 7) };
    expect(() => montarCaderno(sete)).toThrow(/momentos ausentes.*contingencias/);
  });

  it("momento fora da lista fechada QUEBRA a montagem", () => {
    const r = roteiroComTexto("procedimento");
    const nono = {
      ...r,
      momentos: [
        ...r.momentos,
        { ...r.momentos[0], id: "aquecimento" as never, numero: 9 },
      ],
    };
    expect(() => montarCaderno(nono)).toThrow(/fora da lista fechada/);
  });

  it("os oito fora de ordem QUEBRAM a montagem", () => {
    const r = roteiroComTexto("procedimento");
    const trocado = { ...r, momentos: [r.momentos[1], r.momentos[0], ...r.momentos.slice(2)] };
    expect(() => montarCaderno(trocado)).toThrow(/fora da ordem/);
  });
});

describe("2. proveniência por item", () => {
  it("todo item oficial aponta para uma fonte REGISTRADA", () => {
    const enderecos = Object.values(FONTES).map((f) => f.onde);
    let oficiais = 0;
    for (const m of montarCaderno().momentos) {
      for (const i of m.itens.filter((x) => x.marca === "OFICIAL")) {
        oficiais++;
        expect(i.fonte).toMatch(/^roteiro oficial — /);
        expect(enderecos.some((e) => i.fonte!.includes(e))).toBe(true);
        expect(i.corpo.trim().length).toBeGreaterThan(0);
      }
    }
    expect(oficiais).toBeGreaterThan(30);
  });

  it("proveniência para fonte desconhecida QUEBRA a montagem", () => {
    const r = roteiroComTexto("procedimento");
    const adulterado: RoteiroOficial = {
      ...r,
      momentos: r.momentos.map((m, i) =>
        i === 0
          ? {
              ...m,
              itens: [
                {
                  tipo: "oficial" as const,
                  rotulo: "x",
                  texto: "y",
                  proveniencia: { fonte: "site_que_nao_existe" as never, secao: "#z" },
                },
              ],
            }
          : m,
      ),
    };
    expect(() => montarCaderno(adulterado)).toThrow(/fonte desconhecida/);
  });

  it("todo item de operação se declara como procedimento, e não como roteiro", () => {
    for (const m of montarCaderno().momentos) {
      for (const i of m.itens.filter((x) => x.marca === "OPERAÇÃO")) {
        expect(i.fonte).toMatch(/^procedimento escrito para este Caderno/);
        expect(i.fonte).not.toMatch(/^roteiro oficial/);
      }
    }
  });

  it("toda lacuna diz o que falta, de quem, por que e onde foi conferida", () => {
    const c = montarCaderno();
    expect(c.lacunas.length).toBeGreaterThan(0);
    for (const m of c.momentos) {
      for (const i of m.itens.filter((x) => x.marca === "FALTA")) {
        expect(i.corpo.trim().length).toBeGreaterThan(0);
        expect(i.deQuem).toBeTruthy();
        expect(i.porQue).toBeTruthy();
        expect(i.fonte).toMatch(/^conferido em — /);
      }
    }
    for (const l of c.lacunas) {
      expect(l.deQuem.trim().length).toBeGreaterThan(0);
      expect(l.conferidoEm.length).toBeGreaterThan(0);
    }
  });

  it("lacuna sem responsável QUEBRA a montagem", () => {
    const r = roteiroComTexto("procedimento");
    const adulterado: RoteiroOficial = {
      ...r,
      momentos: r.momentos.map((m, i) =>
        i === 0
          ? {
              ...m,
              itens: [
                {
                  tipo: "lacuna" as const,
                  rotulo: "x",
                  falta: "falta algo",
                  deQuem: "   ",
                  classe: "ausente_nas_fontes" as const,
                  conferidoEm: [{ fonte: "site_roteiro" as const, secao: "#a" }],
                },
              ],
            }
          : m,
      ),
    };
    expect(() => montarCaderno(adulterado)).toThrow(/Lacuna sem responsável/);
  });
});

describe("3. nenhuma lacuna é preenchida", () => {
  it("o item de lacuna NÃO tem campo de conteúdo (garantia estrutural)", () => {
    for (const m of ROTEIRO_OFICIAL.momentos) {
      for (const item of m.itens) {
        if (item.tipo !== "lacuna") continue;
        expect(Object.keys(item)).not.toContain("texto");
        expect(Object.keys(item).sort()).toEqual([
          "classe",
          "conferidoEm",
          "deQuem",
          "falta",
          "rotulo",
          "tipo",
        ]);
      }
    }
  });

  it("a lacuna impressa é uma cobrança, e não uma instrução de atividade", () => {
    for (const l of montarCaderno().lacunas) {
      // Quem vai conduzir tem de ler O QUE FALTA e DE QUEM -- as duas coisas.
      expect(l.falta.length).toBeGreaterThan(40);
      expect(l.deQuem.length).toBeGreaterThan(2);
    }
  });
});

describe("4. as quatro áreas pedagógicas aparecem como lacuna", () => {
  const casos: readonly [string, RegExp][] = [
    ["swot_em_grupo", /perguntas da matriz SWOT/i],
    ["swot_em_grupo", /perguntas de condução da SWOT/i],
    ["mural_do_futuro", /instruções do Mural do Futuro/i],
    ["manifesto", /método de construção coletiva do Manifesto/i],
    ["abertura", /objetivos declarados do movimento/i],
    ["abertura", /propósito do Marco Zero/i],
  ];

  for (const [id, padrao] of casos) {
    it(`${id}: ${padrao.source}`, () => {
      const m = momento(id);
      const achado = m.itens.find((i) => padrao.test(i.rotulo));
      expect(achado, `nenhum item com rótulo ${padrao.source}`).toBeDefined();
      expect(achado!.tipo).toBe("lacuna");
    });
  }

  it("nenhuma das três missões, nem a SWOT, traz item de operação que escreva conteúdo de atividade", () => {
    // Operação pode falar de conferência, guarda, tempo e registro. Não pode
    // trazer a palavra "pergunta" seguida de pergunta -- isso seria pedagogia.
    for (const id of ["tres_missoes", "swot_em_grupo"]) {
      for (const i of momento(id).itens.filter((x) => x.tipo === "operacao")) {
        expect(i.tipo === "operacao" && i.texto).not.toMatch(/\?/);
      }
    }
  });
});

describe("5. o varredor: nada afirmado sobre quem estará na sala", () => {
  it("o Caderno real passa pelas duas camadas", () => {
    expect(() => montarCaderno()).not.toThrow();
  });

  it("todo texto do Caderno real está limpo na camada 2", () => {
    for (const t of textosDoCaderno(montarCaderno())) {
      expect(encontrarAfirmacaoSobreOsJovens(t), t).toEqual([]);
    }
  });

  const recusadas = [
    "Os jovens apresentam dificuldade de decisão.",
    "O grupo tem dificuldade de se organizar sozinho.",
    "A geração carece de disciplina.",
    "Os participantes tendem a evitar conflito.",
    "Os Núcleos são mais fechados do que o esperado.",
    "Este grupo demonstra pouca iniciativa.",
    "Eles não conseguem decidir sem ajuda.",
    "O perfil do grupo pede condução mais firme.",
  ];
  for (const frase of recusadas) {
    it(`CONTROLE POSITIVO camada 2 — recusa: ${frase}`, () => {
      expect(encontrarAfirmacaoSobreOsJovens(frase).length).toBeGreaterThan(0);
      expect(() => montarCaderno(roteiroComTexto(frase))).toThrow(
        /afirmar algo sobre quem estará na sala/,
      );
    });
  }

  const aceitas = [
    "Como vocês chegaram a essa decisão?",
    "O Núcleo abre o envelope e organiza as cartas.",
    "Cada Núcleo escolhe o Líder e se organiza como quiser.",
    "Os participantes não veem horário em lugar nenhum.",
    "Os 50 participam da construção da marca.",
  ];
  for (const frase of aceitas) {
    it(`CONTROLE POSITIVO camada 2 — aceita: ${frase}`, () => {
      expect(encontrarAfirmacaoSobreOsJovens(frase)).toEqual([]);
    });
  }

  const retrato = [
    "Metade do grupo respondeu.",
    "A média do evento foi alta.",
    "A distribuição de pilares em roda.",
    "A dimensão Visão e Direção.",
    "Trinta por cento concluíram.",
  ];
  for (const frase of retrato) {
    it(`CONTROLE POSITIVO camada 1 (varredor do Guia) — recusa: ${frase}`, () => {
      expect(() => montarCaderno(roteiroComTexto(frase))).toThrow(/retrato coletivo/);
    });
  }
});

describe("6. versão e hash próprios", () => {
  it("o hash é estável entre montagens", () => {
    expect(hashDoCaderno(montarCaderno())).toBe(hashDoCaderno(montarCaderno()));
    expect(hashDoCaderno(montarCaderno())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o hash MUDA quando o conteúdo muda", () => {
    const a = hashDoCaderno(montarCaderno(roteiroComTexto("procedimento A")));
    const b = hashDoCaderno(montarCaderno(roteiroComTexto("procedimento B")));
    expect(a).not.toBe(b);
  });

  it("a versão do roteiro vai no cabeçalho e no texto impresso", () => {
    const c = montarCaderno();
    expect(c.cabecalho.versao).toBe(VERSAO_DO_ROTEIRO);
    expect(textoDoCaderno(c)).toContain(VERSAO_DO_ROTEIRO);
    expect(textoDoCaderno(c)).toContain(hashDoCaderno(c));
  });
});

describe("7. independência de resposta, e números operacionais", () => {
  it("o Caderno sai IDÊNTICO em montagens repetidas: não há canal de entrada de dados", () => {
    const a = cadernoDeConducao();
    const b = cadernoDeConducao();
    expect(a.conteudoSha256).toBe(b.conteudoSha256);
    expect(a.texto).toBe(b.texto);
  });

  it("o montador não recebe, em assinatura alguma, cliente de banco ou resposta", () => {
    const fonte = readFileSync(join(AQUI, "caderno-de-conducao.ts"), "utf8");
    for (const proibido of [
      "createAdminClient",
      "createClient",
      "quiz_responses",
      "participants",
      "marco_zero_cobertura",
      "supabase",
      "gerarGuiaDoFacilitador",
      "EntradaGuia",
    ]) {
      expect(fonte, `o montador menciona ${proibido}`).not.toContain(proibido);
    }
  });

  it("a entrada estática não menciona banco nem resposta de questionário", () => {
    const fonte = readFileSync(join(AQUI, "roteiro-oficial.ts"), "utf8");
    for (const proibido of ["supabase", "createClient", "quiz_responses", "select("]) {
      expect(fonte, `a entrada estática menciona ${proibido}`).not.toContain(proibido);
    }
  });

  it("IMPRIME número operacional -- a divergência deliberada da regra do Guia", () => {
    const t = textoDoCaderno(montarCaderno());
    for (const n of ["8h15", "9h40", "10h20", "11h50", "13h10", "16h05", "17h00", "50 Murais"]) {
      expect(t).toContain(n);
    }
  });
});

describe("8. a página de impressão é autocontida", () => {
  const html = paginaImprimivelDoCaderno(montarCaderno());

  it("não tem script nem recurso de rede: abre e imprime offline", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("traz os oito momentos, a lista de lacunas e as regras de impressão", () => {
    for (const m of montarCaderno().momentos) {
      expect(html).toContain(`Momento ${m.numero} —`);
    }
    expect(html).toContain("@page");
    expect(html).toContain("@media print");
    expect(html).toContain("Lista das lacunas");
  });

  it("escapa o conteúdo: nada do texto pode virar marcação", () => {
    const comTag = montarCaderno(roteiroComTexto("procedimento <b>x</b> & \"y\""));
    const saida = paginaImprimivelDoCaderno(comTag);
    expect(saida).toContain("&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
    expect(saida).not.toContain("<b>x</b>");
  });
});
