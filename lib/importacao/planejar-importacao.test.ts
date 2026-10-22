import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calcularMarcoZero } from "../scoring/marco-zero";
import { achatarRespostas } from "../scoring/achatar-respostas";
import {
  impressaoDigital,
  montarManifesto,
  type EtapaCanonica,
  type LinhaDeEtapa,
} from "./manifesto-questionario";
import { letraDeclarada } from "./mapear-resposta";
import { planejarImportacao, verificarAptidaoParaPontuar } from "./planejar-importacao";
import type { ParticipanteDoEvento, SubmissaoExterna } from "./reconciliar-identidade";

const IMPRESSAO_V2 = "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

const CANONICO: EtapaCanonica[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "docs", "questionario-v2-canonico.json"), "utf8"),
);

function linhas(): LinhaDeEtapa[] {
  return CANONICO.map((e) => ({ id: 100 + e.n, stage_number: e.n, title: e.t, questions: e.q }));
}

const MANIFESTO = (() => {
  const r = montarManifesto(linhas(), 2);
  if (!r.ok) throw new Error(r.motivo);
  return r.manifesto;
})();

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`fixture: ${id}/${letra}`);
  return o;
}

function respostasCompletas(): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const p of MANIFESTO.perguntas) {
    if (p.type === "scale") r[p.id] = p.min === 0 ? 8 : 4;
    else if (p.type === "select") r[p.id] = p.options![0];
    else if (p.max_chars !== null) r[p.id] = "ok".slice(0, p.max_chars);
    else r[p.id] = "texto escrito pela pessoa";
  }
  r.q40 = alternativa("q40", "A");
  r.q41 = alternativa("q41", "C");
  r.q42 = alternativa("q42", "B");
  r.q43 = alternativa("q43", "D");
  r.q44 = alternativa("q44", "A");
  r.q45 = alternativa("q45", "D");
  return r;
}

const MARIA: ParticipanteDoEvento = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "maria@example.org",
  full_name: "Maria Souza",
};

function submissao(over: Partial<SubmissaoExterna> = {}): SubmissaoExterna {
  return {
    submissao_id: "resp-001",
    email: "maria@example.org",
    email_verificado: true,
    nome_declarado: "Maria Souza",
    respostas: respostasCompletas(),
    ...over,
  };
}

function entrada(over: Record<string, unknown> = {}) {
  return {
    evento: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", quiz_version: 2 },
    manifesto: MANIFESTO,
    origem: {
      formulario_id: "1FAIpQLSc-marco-zero-pre-evento",
      formulario_nome: "Marco Zero | Geração Preparada — pré-evento",
      impressao_declarada: IMPRESSAO_V2,
    },
    submissoes: [submissao()],
    participantes: [MARIA],
    operador: { id: "99999999-9999-4999-8999-999999999999", email: "host@fortinside.test" },
    ...over,
  } as Parameters<typeof planejarImportacao>[0];
}

describe("CONTROLE POSITIVO: importacao legitima ponta a ponta", () => {
  const plano = planejarImportacao(entrada());

  it("o plano e aceito", () => {
    expect(plano.ok).toBe(true);
  });

  it("a submissao e IMPORTAVEL e APTA a pontuar", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const s = plano.submissoes[0];
    expect(s.estado).toBe("importavel");
    expect(s.apto_para_pontuar).toBe(true);
    expect(s.bloqueio).toBeNull();
    expect(s.participant_id).toBe(MARIA.id);
    expect(s.contagens).toEqual({
      compativeis: 52,
      incompativeis: 0,
      incompativeis_pontuadas: 0,
      ausentes: 0,
      desconhecidas: 0,
    });
  });

  it("as 5 etapas sao planejadas com os stage_id reais da versao 2", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const etapas = plano.submissoes[0].etapas;
    expect(etapas.map((e) => e.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(etapas.map((e) => Object.keys(e.answers).length)).toEqual([6, 9, 24, 6, 7]);
  });

  it("as respostas planejadas, achatadas, PONTUAM de verdade", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const achatado = achatarRespostas(
      plano.submissoes[0].etapas.map((e) => ({ stage_id: e.stage_id, answers: e.answers })),
    );
    const scores = calcularMarcoZero(achatado);
    expect(scores.incompleto).toHaveLength(0);
    const situacional = Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0);
    expect(situacional).toBe(6);
    expect(scores.analiseElementos.status).toBe("completo");
    expect(scores.analiseLikert.status).not.toBe("incompleto");
  });

  it("a proveniencia esta completa (regra 4)", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes[0].proveniencia).toEqual({
      formulario_id: "1FAIpQLSc-marco-zero-pre-evento",
      formulario_nome: "Marco Zero | Geração Preparada — pré-evento",
      submissao_id: "resp-001",
      quiz_version: 2,
      questionario_impressao: IMPRESSAO_V2,
      participant_id: MARIA.id,
      identidade_via: "email_verificado",
      email_reconciliado: "maria@example.org",
      importado_por: "99999999-9999-4999-8999-999999999999",
      importado_por_email: "host@fortinside.test",
    });
  });

  it("a coleta crua e preservada inteira", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const c = plano.submissoes[0].coleta;
    expect(c.email_verificado).toBe(true);
    expect(Object.keys(c.respostas_brutas)).toHaveLength(52);
  });

  it("verificarAptidaoParaPontuar libera", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(verificarAptidaoParaPontuar(plano.submissoes[0])).toEqual({ pode: true });
  });
});

describe("MANIFESTO: recusa ANTES de qualquer pontuacao", () => {
  it("impressao DIFERENTE recusa o lote inteiro, sem mapear nada", () => {
    const outra = impressaoDigital([{ n: 1, t: "formulario reescrito", q: [] }]);
    const plano = planejarImportacao(
      entrada({
        origem: { formulario_id: "f", formulario_nome: null, impressao_declarada: outra },
      }),
    );
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("MANIFESTO_DIFERENTE");
    expect(plano.motivo).toContain("Nenhuma resposta foi mapeada, gravada ou pontuada");
    expect(plano.motivo).toContain(IMPRESSAO_V2);
    // E nao existe nenhuma submissao planejada: nao ha o que gravar.
    expect("submissoes" in plano).toBe(false);
  });

  it("impressao AUSENTE e MANIFESTO_INDISPONIVEL, nao MANIFESTO_DIFERENTE", () => {
    const plano = planejarImportacao(
      entrada({
        origem: { formulario_id: "f", formulario_nome: null, impressao_declarada: null },
      }),
    );
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("MANIFESTO_INDISPONIVEL");
  });

  it("uma PALAVRA trocada no questionario do sistema muda a impressao e recusa", () => {
    const mexido: EtapaCanonica[] = JSON.parse(JSON.stringify(CANONICO));
    mexido[3].q[0].options![0] = mexido[3].q[0].options![0].replace("prioridade", "urgência");
    const outro = montarManifesto(
      mexido.map((e) => ({ id: 100 + e.n, stage_number: e.n, title: e.t, questions: e.q })),
      2,
    );
    if (!outro.ok) throw new Error("fixture");
    const plano = planejarImportacao(entrada({ manifesto: outro.manifesto }));
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("MANIFESTO_DIFERENTE");
  });

  it("versao do manifesto diferente da do evento recusa", () => {
    const plano = planejarImportacao(
      entrada({ evento: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", quiz_version: 3 } }),
    );
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("VERSAO_DIVERGENTE");
  });
});

describe("OPERADOR e ORIGEM: sem eles nao ha importacao", () => {
  it("sem operador recusa (regra 5)", () => {
    const plano = planejarImportacao(entrada({ operador: { id: "   " } }));
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("OPERADOR_AUSENTE");
    expect(plano.motivo).toContain("nao um efeito colateral de um import");
  });

  it("sem formulario de origem recusa (regra 4)", () => {
    const plano = planejarImportacao(
      entrada({
        origem: { formulario_id: "", formulario_nome: null, impressao_declarada: IMPRESSAO_V2 },
      }),
    );
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("ORIGEM_AUSENTE");
  });
});

describe("DADO INCOMPATIVEL: estado proprio, nunca pontuacao zero", () => {
  const r = respostasCompletas();
  const original = alternativa("q43", "D");
  r.q43 = original.replace("prioridades", "prioridade");
  const plano = planejarImportacao(entrada({ submissoes: [submissao({ respostas: r })] }));

  it("a submissao fica INCOMPATIVEL, nao importavel e nao pendente", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes[0].estado).toBe("incompativel");
  });

  it("NAO e apta a pontuar, e o bloqueio NOMEIA a pergunta", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const s = plano.submissoes[0];
    expect(s.apto_para_pontuar).toBe(false);
    expect(s.bloqueio?.perguntas).toEqual(["q43"]);
    expect(s.bloqueio?.motivo).toContain("DADO INCOMPATIVEL");
    expect(s.bloqueio?.motivo).toContain("NAO e pontuacao zero");
  });

  it("nenhum valor foi inventado para q43 nas respostas a gravar", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const etapa104 = plano.submissoes[0].etapas.find((e) => e.stage_id === 104);
    expect(etapa104).toBeDefined();
    expect(etapa104!.answers.q43).toBeUndefined();
    expect(etapa104!.incompativeis).toEqual(["q43"]);
    // As 5 irmas continuam gravadas: UMA incompatibilidade nao vira SEIS ausencias.
    expect(Object.keys(etapa104!.answers).sort()).toEqual([
      "q40",
      "q41",
      "q42",
      "q44",
      "q45",
    ]);
  });

  it("o item guarda o que a pessoa respondeu, intacto", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const item = plano.submissoes[0].itens.find((i) => i.pergunta_id === "q43");
    expect(item?.estado).toBe("incompativel");
    if (item?.estado !== "incompativel") return;
    expect(item.bruto).toBe(r.q43);
    expect(item.causa).toBe("alternativa_desconhecida");
    expect(item.pontuada).toBe(true);
  });

  it("verificarAptidaoParaPontuar devolve DADO_INCOMPATIVEL, nao um numero", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const a = verificarAptidaoParaPontuar(plano.submissoes[0]);
    expect(a.pode).toBe(false);
    if (a.pode) return;
    expect(a.codigo).toBe("DADO_INCOMPATIVEL");
    expect(a.perguntas).toEqual(["q43"]);
  });

  it("incompativel em pergunta ABERTA nao bloqueia a pontuacao (nao apaga instrumento)", () => {
    const abertas = respostasCompletas();
    abertas.q1 = "x".repeat(200); // acima do max_chars 120
    const p = planejarImportacao(entrada({ submissoes: [submissao({ respostas: abertas })] }));
    if (!p.ok) throw new Error("plano recusado");
    const s = p.submissoes[0];
    expect(s.contagens.incompativeis).toBe(1);
    expect(s.contagens.incompativeis_pontuadas).toBe(0);
    expect(s.estado).toBe("importavel");
    expect(s.apto_para_pontuar).toBe(true);
  });

  it("ausencia e INCOMPATIBILIDADE se contam separado", () => {
    const mix = respostasCompletas();
    delete mix.q30; // nao respondeu
    mix.q31 = 9; // respondeu fora da escala 1..5
    const p = planejarImportacao(entrada({ submissoes: [submissao({ respostas: mix })] }));
    if (!p.ok) throw new Error("plano recusado");
    expect(p.submissoes[0].contagens.ausentes).toBe(1);
    expect(p.submissoes[0].contagens.incompativeis).toBe(1);
    const etapa103 = p.submissoes[0].etapas.find((e) => e.stage_id === 103)!;
    expect(etapa103.ausentes).toEqual(["q30"]);
    expect(etapa103.incompativeis).toEqual(["q31"]);
  });
});

describe("IDENTIDADE PENDENTE: retida, nunca gravada como de ninguem", () => {
  const plano = planejarImportacao(
    entrada({ submissoes: [submissao({ email: "desconhecido@example.org" })] }),
  );

  it("fica PENDENTE e sem participante", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const s = plano.submissoes[0];
    expect(s.estado).toBe("pendente");
    expect(s.participant_id).toBeNull();
    expect(s.apto_para_pontuar).toBe(false);
  });

  it("NENHUMA etapa e planejada para gravacao", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes[0].etapas).toHaveLength(0);
  });

  it("mas as respostas NAO sao descartadas: ficam na coleta crua e nos itens", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const s = plano.submissoes[0];
    expect(Object.keys(s.coleta.respostas_brutas)).toHaveLength(52);
    expect(s.contagens.compativeis).toBe(52);
  });

  it("a aptidao devolve IDENTIDADE_NAO_RESOLVIDA", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const a = verificarAptidaoParaPontuar(plano.submissoes[0]);
    expect(a.pode).toBe(false);
    if (a.pode) return;
    expect(a.codigo).toBe("IDENTIDADE_NAO_RESOLVIDA");
  });
});

describe("SUBMISSAO DUPLICADA: conflito explicito para as duas", () => {
  const plano = planejarImportacao(
    entrada({
      submissoes: [
        submissao({ submissao_id: "resp-001" }),
        submissao({ submissao_id: "resp-002" }),
      ],
    }),
  );

  it("as DUAS ficam em conflito; nenhuma e escolhida", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes.map((s) => s.estado)).toEqual(["conflito", "conflito"]);
    expect(plano.submissoes.every((s) => s.participant_id === null)).toBe(true);
    expect(plano.submissoes.every((s) => s.etapas.length === 0)).toBe(true);
  });

  it("o bloqueio nomeia as duas submissoes envolvidas", () => {
    if (!plano.ok) throw new Error("plano recusado");
    for (const s of plano.submissoes) {
      expect(s.bloqueio?.motivo).toContain("CONFLITO");
      expect(s.bloqueio?.motivo).toContain("resp-001");
      expect(s.bloqueio?.motivo).toContain("resp-002");
    }
  });

  it("o resumo conta 2 conflitos e 0 importaveis", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.resumo).toEqual({
      submissoes: 2,
      importaveis: 0,
      incompativeis: 0,
      pendentes: 0,
      conflitos: 2,
      itens_incompativeis: 0,
    });
  });
});

describe("verificarAptidaoParaPontuar sem registro de importacao", () => {
  it("nao devolve 'pode': devolve APTIDAO_INDETERMINADA", () => {
    for (const v of [null, undefined]) {
      const a = verificarAptidaoParaPontuar(v);
      expect(a.pode).toBe(false);
      if (a.pode) continue;
      expect(a.codigo).toBe("APTIDAO_INDETERMINADA");
    }
  });
});

describe("LOTE MISTO: cada submissao com o seu desfecho, no mesmo plano", () => {
  const JOAO: ParticipanteDoEvento = {
    id: "22222222-2222-4222-8222-222222222222",
    email: "joao@example.org",
    full_name: "João Pereira",
  };
  const quebrada = respostasCompletas();
  quebrada.q41 = alternativa("q41", "C").replace("causa", "origem");

  const plano = planejarImportacao(
    entrada({
      participantes: [MARIA, JOAO],
      submissoes: [
        submissao({ submissao_id: "ok" }),
        submissao({ submissao_id: "quebrada", email: "joao@example.org", respostas: quebrada }),
        submissao({ submissao_id: "orfa", email: "ninguem@example.org" }),
      ],
    }),
  );

  it("um importavel, um incompativel, um pendente", () => {
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes.map((s) => [s.submissao_id, s.estado])).toEqual([
      ["ok", "importavel"],
      ["quebrada", "incompativel"],
      ["orfa", "pendente"],
    ]);
    expect(plano.resumo.importaveis).toBe(1);
    expect(plano.resumo.incompativeis).toBe(1);
    expect(plano.resumo.pendentes).toBe(1);
    expect(plano.resumo.itens_incompativeis).toBe(1);
  });

  it("o incompativel de um NAO contamina o importavel do outro", () => {
    if (!plano.ok) throw new Error("plano recusado");
    const ok = plano.submissoes[0];
    expect(ok.apto_para_pontuar).toBe(true);
    expect(ok.contagens.incompativeis).toBe(0);
  });
});
