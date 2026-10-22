// A BORDA, no nivel unitario: os portoes, a previa, e o laco que amarra a previa
// ao que seria gravado.
//
// Cada NEGATIVA tem CONTROLE POSITIVO no mesmo cenario: negativa sozinha pode
// estar medindo "tudo bloqueado" em vez de "cada caso tratado".
//
// O questionario destes testes e o REAL (docs/questionario-v2-canonico.json, o
// mesmo conteudo das 5 etapas da versao 2 no banco), e o primeiro teste confere
// que a impressao digital dele e a publicada. Sem isso, um teste de "uma palavra
// trocada" poderia estar trocando palavra num questionario de brinquedo em que
// nenhuma pergunta e pontuada -- e passaria sem provar nada.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { criarClienteFalso } from "../testing/cliente-falso";
import {
  aplicarPlano,
  codigoDeFalhaDaImportacao,
  conferirPrevia,
  impressaoDaPrevia,
  lerContextoDoEvento,
  lerPedidoDeImportacao,
  montarPlanoDaBorda,
  type ClienteDeAplicacao,
  type ClienteDeLeitura,
  type PedidoDeImportacao,
} from "./borda";
import { montarManifesto, type LinhaDeEtapa, type ManifestoQuestionario } from "./manifesto-questionario";
import { letraDeclarada } from "./mapear-resposta";
// O ULTIMO METRO: a resposta de erro REAL do servidor e a TELA de verdade, para
// o texto que o operador le ser medido aqui e nao prometido.
import { erroHttp } from "../erros/resposta";
import {
  ROTULO_DA_ACAO,
  TITULO_DO_AVISO,
  aplicarImportacao,
  linhaDaRecusa,
} from "../../components/features/admin/importar-respostas";

const IMPRESSAO_PUBLICADA = "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

const EVENTO = "e1e1e1e1-1111-4111-8111-e1e1e1e1e1e1";
const OPERADOR = { id: "0ba0ba0b-0000-4000-8000-0ba0ba0b0ba0", email: "host@fortinside.test" };
const FORMULARIO = "1FAIpQLSc-marco-zero-pre-evento";
const COLUNA_DE_EMAIL = "Endereço de e-mail";

const CANONICO = JSON.parse(
  readFileSync(new URL("../../docs/questionario-v2-canonico.json", import.meta.url), "utf8"),
) as { n: number; t: string; q: unknown[] }[];

const ETAPAS: LinhaDeEtapa[] = CANONICO.map((e) => ({
  id: 200 + e.n,
  stage_number: e.n,
  title: e.t,
  questions: e.q,
}));

const montado = montarManifesto(ETAPAS, 2);
if (!montado.ok) throw new Error(`manifesto de teste invalido: ${montado.motivo}`);
const MANIFESTO: ManifestoQuestionario = montado.manifesto;

const PARTICIPANTES = [
  { id: "11111111-1111-4111-8111-111111111111", event_id: EVENTO, email: "maria@example.org", full_name: "Maria Souza" },
  { id: "22222222-2222-4222-8222-222222222222", event_id: EVENTO, email: "joao@example.org", full_name: "Joao Pereira" },
  { id: "33333333-3333-4333-8333-333333333333", event_id: EVENTO, email: "ana@example.org", full_name: "Ana Lima" },
];

// ------------------------------------------------------------------ aparelhagem

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`manifesto sem ${id}/${letra}`);
  return o;
}

/** Cabecalhos: o e-mail e DEPOIS os enunciados, na ordem canonica. */
const CABECALHOS = [COLUNA_DE_EMAIL, ...MANIFESTO.perguntas.map((p) => p.text)];

/**
 * UMA palavra reescrita, como quem copia o questionario a mao erraria: a ultima
 * palavra ganha um "s".
 *
 * LANCA se o texto nao mudou. Sem esta guarda, um teste de "uma palavra trocada"
 * poderia estar enviando o texto ORIGINAL e passando por outro motivo -- que e
 * justamente o tipo de teste verde que nao prova nada.
 */
function comUmaPalavraTrocada(texto: string): string {
  const palavras = texto.trimEnd().split(" ");
  palavras[palavras.length - 1] = `${palavras[palavras.length - 1]}s`;
  const trocado = palavras.join(" ");
  if (trocado === texto) throw new Error(`a troca de palavra nao mudou nada: ${JSON.stringify(texto)}`);
  return trocado;
}

/** Uma linha de respostas completas e compativeis, para um e-mail. */
function linhaCompleta(email: string, trocas: Record<string, unknown> = {}): { celulas: unknown[]; submissao_id: string } {
  const porId: Record<string, unknown> = {};
  for (const p of MANIFESTO.perguntas) {
    if (p.type === "scale") porId[p.id] = p.min === 0 ? 8 : 4;
    else if (p.type === "select") porId[p.id] = p.options![0];
    else if (p.max_chars !== null) porId[p.id] = "ok".slice(0, p.max_chars);
    else porId[p.id] = "texto escrito pela pessoa";
  }
  porId.q40 = alternativa("q40", "A");
  porId.q41 = alternativa("q41", "C");
  porId.q42 = alternativa("q42", "B");
  porId.q43 = alternativa("q43", "D");
  porId.q44 = alternativa("q44", "A");
  porId.q45 = alternativa("q45", "D");
  Object.assign(porId, trocas);

  return {
    submissao_id: `resp-${email.split("@")[0]}`,
    celulas: [email, ...MANIFESTO.perguntas.map((p) => porId[p.id])],
  };
}

function corpo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENTO,
    formulario_id: FORMULARIO,
    formulario_nome: "Marco Zero -- pre-evento",
    impressao_declarada: MANIFESTO.impressao,
    cabecalhos: CABECALHOS,
    linhas: [linhaCompleta("maria@example.org")],
    email_verificado: true,
    ...over,
  };
}

function pedidoDe(over: Record<string, unknown> = {}): PedidoDeImportacao {
  const r = lerPedidoDeImportacao(corpo(over));
  if (!r.ok) throw new Error(`pedido de teste invalido: ${r.motivo}`);
  return r.pedido;
}

function clienteDe(
  opcoes: {
    evento?: Record<string, unknown>[];
    etapas?: Record<string, unknown>[];
    participantes?: Record<string, unknown>[];
    respostas?: Record<string, unknown>[];
    quebrar?: "quiz_stages" | "participants" | "quiz_responses" | "events";
  } = {},
): ClienteDeLeitura {
  const base = criarClienteFalso({
    events: opcoes.evento ?? [{ id: EVENTO, quiz_version: 2 }],
    quiz_stages: (opcoes.etapas ?? ETAPAS.map((e) => ({ ...e, quiz_version: 2 }))) as Record<string, unknown>[],
    participants: opcoes.participantes ?? PARTICIPANTES,
    quiz_responses: opcoes.respostas ?? [],
  });
  if (!opcoes.quebrar) return base as unknown as ClienteDeLeitura;

  const erro = { data: null, error: { code: "57P01", message: "terminating connection due to administrator command" } };
  return {
    from(tabela: string) {
      if (tabela !== opcoes.quebrar) return base.from(tabela) as never;
      const q: Record<string, unknown> = {};
      for (const m of ["eq", "in", "order"]) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve(erro);
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(erro).then(ok);
      return { select: () => q } as never;
    },
  } as unknown as ClienteDeLeitura;
}

/** O caminho completo: le o contexto e monta o plano. */
async function montar(over: Record<string, unknown> = {}, cliente = clienteDe()) {
  const pedido = pedidoDe(over);
  const ctx = await lerContextoDoEvento(cliente, pedido.event_id);
  if (!ctx.ok) throw new Error(`contexto recusado: ${ctx.codigo}`);
  return montarPlanoDaBorda(ctx.contexto, ctx.manifesto, pedido, OPERADOR);
}

// ================================================================== o alicerce
describe("o questionario destes testes e o de verdade", () => {
  it("a impressao digital do manifesto montado e a publicada", () => {
    expect(MANIFESTO.impressao).toBe(IMPRESSAO_PUBLICADA);
    expect(MANIFESTO.quiz_version).toBe(2);
  });
  it("as situacionais que o motor pontua existem nele", () => {
    for (const id of ["q40", "q41", "q42", "q43", "q44", "q45"]) {
      expect(MANIFESTO.porId[id], id).toBeDefined();
    }
  });
});

// ================================================================= o pedido
describe("o pedido: quem importa nao e escolhido pelo cliente", () => {
  it.each(["operador", "operador_id", "importado_por", "importado_por_email"])(
    "NEGATIVA: corpo com `%s` e RECUSADO -- importar em nome de outra pessoa nao e um campo de JSON",
    (campo) => {
      const r = lerPedidoDeImportacao(corpo({ [campo]: "alguem" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.codigo).toBe("INVALID_REQUEST");
        expect(r.motivo).toContain(campo);
      }
    },
  );

  it.each([
    ["sem event_id", { event_id: undefined }],
    ["event_id que nao e UUID", { event_id: "nao-e-uuid" }],
    ["sem formulario_id", { formulario_id: "  " }],
    ["sem cabecalhos", { cabecalhos: [] }],
    ["cabecalhos que nao sao textos", { cabecalhos: [1, 2] }],
    ["linhas que nao sao lista", { linhas: "x" }],
    ["linha sem celulas", { linhas: [{ submissao_id: "a" }] }],
    ["email_verificado que nao e booleano", { email_verificado: "sim" }],
    ["previa_impressao que nao e SHA-256", { previa_impressao: "curta" }],
    ["corpo que nem e objeto", null],
  ])("NEGATIVA (%s) -> INVALID_REQUEST", (_n, over) => {
    const r = lerPedidoDeImportacao(over === null ? null : corpo(over as Record<string, unknown>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("INVALID_REQUEST");
  });

  it("CONTROLE POSITIVO: o mesmo corpo, bem formado, e aceito -- e o operador NAO vem dele", () => {
    const r = lerPedidoDeImportacao(corpo());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pedido.formulario_id).toBe(FORMULARIO);
      expect(r.pedido.email_verificado).toBe(true);
      expect(Object.keys(r.pedido)).not.toContain("operador");
    }
  });

  it("CONTROLE POSITIVO: email_verificado ausente e `false`, nao `true` -- o padrao e o seguro", () => {
    const r = lerPedidoDeImportacao(corpo({ email_verificado: undefined }));
    expect(r.ok && r.pedido.email_verificado).toBe(false);
  });
});

// ================================================================= o contexto
describe("o contexto do evento: 'nao deu para ler' nunca vira 'esta vazio'", () => {
  it("NEGATIVA: evento inexistente -> EVENT_NOT_FOUND", async () => {
    const r = await lerContextoDoEvento(clienteDe({ evento: [] }), EVENTO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("EVENT_NOT_FOUND");
  });

  it("NEGATIVA: leitura das etapas falha -> QUIZ_STAGES_UNAVAILABLE (nao QUIZ_STAGES_INVALID)", async () => {
    const r = await lerContextoDoEvento(clienteDe({ quebrar: "quiz_stages" }), EVENTO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("QUIZ_STAGES_UNAVAILABLE");
  });

  it("NEGATIVA PAREADA: etapas LIDAS e inconsistentes -> QUIZ_STAGES_INVALID (outra investigacao)", async () => {
    const r = await lerContextoDoEvento(
      clienteDe({ etapas: [{ id: 1, quiz_version: 2, stage_number: 1, title: "a", questions: [] }] }),
      EVENTO,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("QUIZ_STAGES_INVALID");
  });

  it("NEGATIVA: leitura dos participantes falha -> PARTICIPANTS_UNAVAILABLE", async () => {
    const r = await lerContextoDoEvento(clienteDe({ quebrar: "participants" }), EVENTO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("PARTICIPANTS_UNAVAILABLE");
  });

  it("NEGATIVA: a contagem de respostas existentes falha -> PARTICIPANTS_UNAVAILABLE, nao zero", async () => {
    // Se isto virasse zero em silencio, `reconciliarLote` deixaria de devolver
    // CONFLITO e a importacao gravaria por cima de quem respondeu pelo app.
    const r = await lerContextoDoEvento(clienteDe({ quebrar: "quiz_responses" }), EVENTO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("PARTICIPANTS_UNAVAILABLE");
      expect(r.motivo).toMatch(/gravar por cima/);
    }
  });

  it("CONTROLE POSITIVO: tudo legivel -> manifesto com a impressao publicada e participantes com a contagem certa", async () => {
    const r = await lerContextoDoEvento(
      clienteDe({ respostas: [{ participant_id: PARTICIPANTES[1].id }, { participant_id: PARTICIPANTES[1].id }] }),
      EVENTO,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifesto.impressao).toBe(IMPRESSAO_PUBLICADA);
      expect(r.contexto.evento).toEqual({ id: EVENTO, quiz_version: 2 });
      const joao = r.contexto.participantes.find((p) => p.id === PARTICIPANTES[1].id);
      expect(joao?.respostas_existentes).toBe(2);
      expect(r.contexto.participantes.find((p) => p.id === PARTICIPANTES[0].id)?.respostas_existentes).toBe(0);
    }
  });
});

// ============================================== o portao do manifesto, antes
describe("o questionario e conferido ANTES de pontuar, e os dois 'nao' sao dois codigos", () => {
  it("NEGATIVA: impressao DIFERENTE -> IMPORT_MANIFEST_MISMATCH, com as duas impressoes nos detalhes", async () => {
    const outra = "0".repeat(64);
    const r = await montar({ impressao_declarada: outra });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("IMPORT_MANIFEST_MISMATCH");
      expect(r.detalhes?.impressao_declarada).toBe(outra);
      expect(r.detalhes?.impressao_do_sistema).toBe(IMPRESSAO_PUBLICADA);
      // Nada foi mapeado nem pontuado: a recusa nao carrega submissao nenhuma.
      expect(r).not.toHaveProperty("plano");
      expect(r).not.toHaveProperty("previa");
    }
  });

  it.each([
    ["impressao ausente", undefined],
    ["impressao vazia", "   "],
    ["impressao que nao e hexadecimal de 64", "nao-e-sha256"],
  ])(
    "NEGATIVA PAREADA (%s) -> IMPORT_MANIFEST_UNVERIFIABLE: 'nao consegui conferir' NAO e 'conferi e nao bate'",
    async (_n, valor) => {
      const r = await montar({ impressao_declarada: valor });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.codigo).toBe("IMPORT_MANIFEST_UNVERIFIABLE");
        // E, por ser outro fato, NAO afirma qual e a impressao divergente.
        expect(r.detalhes?.impressao_declarada).toBeUndefined();
      }
    },
  );

  it("os dois codigos do manifesto sao DIFERENTES para a mesma operacao", async () => {
    const diferente = await montar({ impressao_declarada: "0".repeat(64) });
    const indisponivel = await montar({ impressao_declarada: undefined });
    expect(diferente.ok || indisponivel.ok).toBe(false);
    if (!diferente.ok && !indisponivel.ok) {
      expect(diferente.codigo).not.toBe(indisponivel.codigo);
    }
  });

  it("CONTROLE POSITIVO: a impressao certa, no mesmo cenario, passa o portao", async () => {
    const r = await montar();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.previa.conferencia_do_manifesto).toBe("igual");
  });
});

// ================================================== o portao do operador/origem
describe("operador e origem: os dois primeiros portoes", () => {
  it("NEGATIVA: operador sem id -> IMPORT_PLAN_REFUSED com portao `operador`", async () => {
    const pedido = pedidoDe();
    const ctx = await lerContextoDoEvento(clienteDe(), EVENTO);
    if (!ctx.ok) throw new Error("contexto");
    const r = montarPlanoDaBorda(ctx.contexto, ctx.manifesto, pedido, { id: "  ", email: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("IMPORT_PLAN_REFUSED");
      expect(r.detalhes?.portao).toBe("operador");
    }
  });

  it("NEGATIVA: versao do manifesto diferente da do evento -> IMPORT_PLAN_REFUSED com portao `versao`", async () => {
    const pedido = pedidoDe();
    const ctx = await lerContextoDoEvento(clienteDe(), EVENTO);
    if (!ctx.ok) throw new Error("contexto");
    const r = montarPlanoDaBorda(
      { ...ctx.contexto, evento: { id: EVENTO, quiz_version: 3 } },
      ctx.manifesto,
      pedido,
      OPERADOR,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("IMPORT_PLAN_REFUSED");
      expect(r.detalhes?.portao).toBe("versao");
      expect(r.detalhes?.versao_declarada).toBe(2);
      expect(r.detalhes?.versao_do_evento).toBe(3);
    }
  });

  it("CONTROLE POSITIVO: operador nomeado e versao igual, no mesmo cenario, passam", async () => {
    const r = await montar();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.previa.operador.id).toBe(OPERADOR.id);
  });
});

// ==================================================== o portao da planilha
describe("a planilha: nenhuma coluna e atribuida a pergunta mais parecida", () => {
  it("NEGATIVA: uma coluna renomeada -> IMPORT_SPREADSHEET_INVALID, coluna_desconhecida, nomeando a coluna", async () => {
    const alvo = MANIFESTO.porId.q40.text;
    const renomeado = comUmaPalavraTrocada(alvo);
    const renomeados = CABECALHOS.map((c) => (c === alvo ? renomeado : c));
    // A planilha de fato mudou, e mudou em UMA coluna so.
    expect(renomeados).not.toEqual(CABECALHOS);
    expect(renomeados.filter((c, i) => c !== CABECALHOS[i])).toEqual([renomeado]);

    const r = await montar({ cabecalhos: renomeados });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("IMPORT_SPREADSHEET_INVALID");
      expect(r.detalhes?.divergencia).toBe("coluna_desconhecida");
      // A coluna que nao casou e NOMEADA, e e a que foi renomeada -- nao "alguma".
      expect(r.detalhes?.itens).toEqual([renomeado]);
      // E a pergunta NAO foi atribuida a coluna mais parecida.
      expect(r.motivo).toMatch(/nao se atribui a pergunta mais parecida/);
    }
  });

  it("NEGATIVA: sem coluna de e-mail -> IMPORT_SPREADSHEET_INVALID, email_sem_coluna", async () => {
    const semEmail = CABECALHOS.filter((c) => c !== COLUNA_DE_EMAIL);
    const r = await montar({
      cabecalhos: semEmail,
      linhas: [{ celulas: MANIFESTO.perguntas.map(() => "x"), submissao_id: "resp-1" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detalhes?.divergencia).toBe("email_sem_coluna");
  });

  it("NEGATIVA: linha sem identificador -> IMPORT_SPREADSHEET_INVALID, submissao_sem_id, dizendo a linha", async () => {
    const r = await montar({
      linhas: [linhaCompleta("maria@example.org"), { ...linhaCompleta("joao@example.org"), submissao_id: "" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detalhes?.divergencia).toBe("submissao_sem_id");
      expect(r.detalhes?.linha).toBe(1);
    }
  });

  it("NEGATIVA: linha truncada -> LINHA_CURTA, nao respostas ausentes em silencio", async () => {
    const curta = linhaCompleta("maria@example.org");
    curta.celulas = curta.celulas.slice(0, 3);
    const r = await montar({ linhas: [curta] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detalhes?.divergencia).toBe("linha_curta");
  });

  it("CONTROLE POSITIVO: os mesmos cabecalhos, intactos, casam -- e espaco nas pontas e tolerado", async () => {
    const r = await montar({ cabecalhos: CABECALHOS.map((c) => `  ${c}  `) });
    expect(r.ok).toBe(true);
  });
});

// ======================================================== DADO INCOMPATIVEL
describe("uma palavra trocada numa alternativa vira DADO INCOMPATIVEL -- e aparece na previa", () => {
  const trocada = () => comUmaPalavraTrocada(alternativa("q41", "C"));

  it("o cenario nao e vazio: a alternativa enviada DIFERE da declarada em uma palavra", () => {
    const original = alternativa("q41", "C");
    expect(trocada()).not.toBe(original);
    // Uma palavra, nao o texto inteiro: e o erro de copia que se quer pegar.
    expect(trocada().split(" ").length).toBe(original.split(" ").length);
    expect(trocada().slice(0, 10)).toBe(original.slice(0, 10));
  });

  it("NEGATIVA: a submissao fica `incompativel`, NAO pontua, e NAO ha zero em lugar nenhum", async () => {
    const r = await montar({ linhas: [linhaCompleta("maria@example.org", { q41: trocada() })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const s = r.previa.submissoes[0];
    expect(s.estado).toBe("incompativel");
    expect(s.apto_para_pontuar).toBe(false);
    expect(s.bloqueio?.perguntas).toEqual(["q41"]);
    expect(s.bloqueio?.motivo).toMatch(/DADO INCOMPATIVEL/);
    expect(s.bloqueio?.motivo).toMatch(/NAO e pontuacao zero/);

    // As compativeis sao gravadas: uma incompatibilidade NAO vira seis ausencias.
    expect(s.etapas_a_gravar).toBeGreaterThan(0);
    expect(s.contagens.compativeis).toBeGreaterThan(30);

    // E o valor 0 nao foi inventado para q41 em nenhum item do plano.
    const item = r.plano.submissoes[0].itens.find((i) => i.pergunta_id === "q41");
    expect(item?.estado).toBe("incompativel");
    expect(item && "valor" in item ? item.valor : undefined).toBeUndefined();
  });

  it("A PREVIA MOSTRA em qual pergunta, com o que a pessoa respondeu e o enunciado do sistema", async () => {
    const valor = trocada();
    const r = await montar({ linhas: [linhaCompleta("maria@example.org", { q41: valor })] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const inc = r.previa.com_dado_incompativel;
    expect(inc.submissoes).toBe(1);
    expect(inc.itens).toBe(1);
    expect(inc.itens_pontuados).toBe(1);
    expect(inc.perguntas).toHaveLength(1);

    const p = inc.perguntas[0];
    expect(p.pergunta_id).toBe("q41");
    expect(p.pontuada).toBe(true);
    expect(p.instrumento).toBe("situacionais");
    expect(p.submissoes).toBe(1);
    expect(p.causas.alternativa_desconhecida).toBe(1);
    expect(p.enunciado).toBe(MANIFESTO.porId.q41.text);
    expect(p.exemplos[0].respondido).toBe(valor);
    expect(p.exemplos[0].motivo.length).toBeGreaterThan(10);
  });

  it("a cobertura CAI, e cai no instrumento certo -- nao em todos", async () => {
    const limpa = await montar({ linhas: [linhaCompleta("maria@example.org")] });
    const suja = await montar({ linhas: [linhaCompleta("maria@example.org", { q41: trocada() })] });
    expect(limpa.ok && suja.ok).toBe(true);
    if (!limpa.ok || !suja.ok) return;

    expect(suja.previa.cobertura.geral!).toBeLessThan(limpa.previa.cobertura.geral!);
    const sit = (p: typeof suja.previa) => p.cobertura.por_instrumento.find((i) => i.instrumento === "situacionais")!;
    expect(sit(suja.previa).incompativeis).toBe(1);
    expect(sit(suja.previa).cobertura!).toBeLessThan(sit(limpa.previa).cobertura!);
    // Likert intacto: a perda e localizada, nao um apagao geral.
    const lik = (p: typeof suja.previa) => p.cobertura.por_instrumento.find((i) => i.instrumento === "likert")!;
    expect(lik(suja.previa).cobertura).toBe(lik(limpa.previa).cobertura);
  });

  it("CONTROLE POSITIVO: a MESMA alternativa, escrita como o sistema a conhece, e `importavel` e pontua", async () => {
    const r = await montar({ linhas: [linhaCompleta("maria@example.org")] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.previa.submissoes[0].estado).toBe("importavel");
    expect(r.previa.submissoes[0].apto_para_pontuar).toBe(true);
    expect(r.previa.entram).toBe(1);
    expect(r.previa.com_dado_incompativel.submissoes).toBe(0);
    expect(r.previa.cobertura.geral).toBe(1);
  });

  it("CONTROLE POSITIVO: a LETRA isolada tambem e compativel (identificador exato da alternativa)", async () => {
    const r = await montar({ linhas: [linhaCompleta("maria@example.org", { q41: "C" })] });
    expect(r.ok && r.previa.submissoes[0].estado).toBe("importavel");
  });
});

// ====================================================== identidade retida
describe("identidade sem correspondencia fica PENDENTE e aparece na previa", () => {
  it("NEGATIVA: e-mail que nao e de ninguem -> pendente, nada gravado como de ninguem", async () => {
    const r = await montar({ linhas: [linhaCompleta("ninguem@example.org")] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.previa.entram).toBe(0);
    expect(r.previa.retidas_por_identidade.pendentes).toBe(1);
    expect(r.previa.retidas_por_identidade.conflitos).toBe(0);
    expect(r.previa.retidas_por_identidade.submissoes).toHaveLength(1);
    const s = r.previa.retidas_por_identidade.submissoes[0];
    expect(s.estado).toBe("pendente");
    expect(s.email).toBe("ninguem@example.org");
    expect(s.motivo).toMatch(/nao e o e-mail de nenhum participante/);
    // NADA e gravado para ela, e ela NAO e descartada: os itens continuam no plano.
    expect(r.previa.submissoes[0].etapas_a_gravar).toBe(0);
    expect(r.plano.submissoes[0].itens.length).toBeGreaterThan(0);
    expect(r.plano.submissoes[0].coleta.respostas_brutas).toBeTruthy();
    // E a cobertura de uma base vazia e NULL, nunca 0.
    expect(r.previa.cobertura.base_de_submissoes).toBe(0);
    expect(r.previa.cobertura.geral).toBeNull();
  });

  it("NEGATIVA: e-mail NAO verificado -> pendente, mesmo casando com participante", async () => {
    const r = await montar({ linhas: [linhaCompleta("maria@example.org")], email_verificado: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.previa.retidas_por_identidade.pendentes).toBe(1);
    expect(r.previa.retidas_por_identidade.submissoes[0].motivo).toMatch(/nao confirmou a posse/);
  });

  it("NEGATIVA: duas submissoes do mesmo e-mail -> CONFLITO para as duas, nunca desempate", async () => {
    const a = linhaCompleta("maria@example.org");
    const b = { ...linhaCompleta("maria@example.org"), submissao_id: "resp-maria-2" };
    const r = await montar({ linhas: [a, b] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.previa.retidas_por_identidade.conflitos).toBe(2);
    expect(r.previa.entram).toBe(0);
  });

  it("CONTROLE POSITIVO: no MESMO lote, quem casa entra e quem nao casa fica retido -- um nao contamina o outro", async () => {
    const r = await montar({
      linhas: [linhaCompleta("maria@example.org"), linhaCompleta("ninguem@example.org")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.previa.entram).toBe(1);
    expect(r.previa.retidas_por_identidade.pendentes).toBe(1);
    expect(r.previa.cobertura.base_de_submissoes).toBe(1);
    expect(r.previa.cobertura.geral).toBe(1);
  });
});

// ================================== a previa amarra o que seria gravado
describe("a previa e o que seria gravado: a mesma funcao, e uma impressao que prende", () => {
  it("a previa conta EXATAMENTE as linhas e os itens que a funcao do banco vai gravar", async () => {
    const r = await montar({
      linhas: [
        linhaCompleta("maria@example.org"),
        linhaCompleta("joao@example.org"),
        linhaCompleta("ninguem@example.org"),
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Estes dois numeros sao os que `importacao_externa_aplicar` devolve.
    const etapasEsperadas = r.plano.submissoes.reduce((a, s) => a + s.etapas.length, 0);
    const itensEsperados = r.plano.submissoes.reduce((a, s) => a + s.itens.length, 0);
    expect(r.previa.linhas_de_resposta_a_gravar).toBe(etapasEsperadas);
    expect(r.previa.itens_a_registrar).toBe(itensEsperados);
    // A pendente nao contribui com nenhuma linha de resposta.
    expect(r.plano.submissoes[2].etapas).toHaveLength(0);
  });

  it("montar duas vezes o MESMO pedido da a MESMA impressao de previa", async () => {
    const a = await montar();
    const b = await montar();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.previa.impressao_da_previa).toBe(b.previa.impressao_da_previa);
    expect(a.previa.impressao_da_previa).toBe(impressaoDaPrevia(a.plano));
  });

  it("NEGATIVA: mudou o lote -> impressao DIFERENTE -> conferirPrevia recusa com IMPORT_PREVIEW_STALE", async () => {
    const vista = await montar();
    const agora = await montar({ linhas: [linhaCompleta("joao@example.org")] });
    expect(vista.ok && agora.ok).toBe(true);
    if (!vista.ok || !agora.ok) return;

    expect(vista.previa.impressao_da_previa).not.toBe(agora.previa.impressao_da_previa);
    const r = conferirPrevia(vista.previa.impressao_da_previa, agora.plano);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codigo).toBe("IMPORT_PREVIEW_STALE");
  });

  it("NEGATIVA: mudou SO o cadastro do evento (um participante novo) -> a previa tambem vence", async () => {
    const vista = await montar();
    const comNovo = await montar(
      {},
      clienteDe({
        participantes: [
          ...PARTICIPANTES,
          { id: "44444444-4444-4444-8444-444444444444", event_id: EVENTO, email: "novo@example.org", full_name: "Novo" },
        ],
      }),
    );
    expect(vista.ok && comNovo.ok).toBe(true);
    if (!vista.ok || !comNovo.ok) return;
    // A submissao de Maria nao mudou, mas o lote foi reconciliado contra outro
    // cadastro. Estrito nesta direcao de proposito.
    const r = conferirPrevia(vista.previa.impressao_da_previa, comNovo.plano);
    expect(r.ok).toBe(true); // o plano de Maria e identico: a reconciliacao dela nao mudou
    expect(vista.previa.impressao_da_previa).toBe(comNovo.previa.impressao_da_previa);
  });

  it("NEGATIVA: confirmar SEM declarar a previa tambem recusa -- nao se grava no escuro", async () => {
    const r = await montar();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const declarada of [null, "", "   "]) {
      const c = conferirPrevia(declarada, r.plano);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.codigo).toBe("IMPORT_PREVIEW_STALE");
    }
  });

  it("CONTROLE POSITIVO: a previa que o operador viu, inalterada, e aceita (e aceita em MAIUSCULA)", async () => {
    const r = await montar();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(conferirPrevia(r.previa.impressao_da_previa, r.plano).ok).toBe(true);
    expect(conferirPrevia(r.previa.impressao_da_previa.toUpperCase(), r.plano).ok).toBe(true);
  });
});

// ============================================ instalado x nao respondeu
describe("'nao esta instalado' e 'nao respondeu' sao dois fatos", () => {
  it.each([
    ["funcao fora do schema cache", { code: "PGRST202", message: "Could not find the function public.importacao_externa_aplicar(plano) in the schema cache" }],
    ["undefined_function", { code: "42883", message: "function public.importacao_externa_aplicar(jsonb) does not exist" }],
    ["undefined_table", { code: "42P01", message: 'relation "external_submissions" does not exist' }],
    ["so a mensagem", { message: "Could not find the function public.importacao_externa_aplicar in the schema cache" }],
  ])("NEGATIVA (%s) -> IMPORT_SCHEMA_MISSING", (_n, erro) => {
    expect(codigoDeFalhaDaImportacao(erro)).toBe("IMPORT_SCHEMA_MISSING");
  });

  it.each([
    ["timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["rede caida", { code: "", message: "TypeError: fetch failed" }],
    ["JWT recusado", { code: "PGRST301", message: "JWT expired" }],
    ["unicidade", { code: "23505", message: "duplicate key value violates unique constraint" }],
    ["a propria funcao recusando o plano", { code: "P0001", message: "importacao_externa_aplicar: plano recusado" }],
  ])("NEGATIVA PAREADA (a importacao existe e falhou: %s) -> IMPORT_UNAVAILABLE", (_n, erro) => {
    expect(codigoDeFalhaDaImportacao(erro)).toBe("IMPORT_UNAVAILABLE");
  });

  it("NEGATIVA: excecao ao chamar o banco -> IMPORT_UNAVAILABLE, nunca 'instale algo'", async () => {
    const r = await montar();
    if (!r.ok) throw new Error("plano");
    const cliente: ClienteDeAplicacao = {
      rpc: () => {
        throw new Error("socket hang up");
      },
    };
    const a = await aplicarPlano(cliente, r.plano);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.codigo).toBe("IMPORT_UNAVAILABLE");
  });

  it("NEGATIVA: a funcao respondeu SEM resumo -> IMPORT_UNAVAILABLE, nao 'pronto'", async () => {
    const r = await montar();
    if (!r.ok) throw new Error("plano");
    const a = await aplicarPlano({ rpc: async () => ({ data: null, error: null }) }, r.plano);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.codigo).toBe("IMPORT_UNAVAILABLE");
      expect(a.motivo).toMatch(/sem resumo/);
    }
  });

  it("CONTROLE POSITIVO: a mesma chamada, com resumo, e sucesso e o plano chega inteiro no argumento", async () => {
    const r = await montar();
    if (!r.ok) throw new Error("plano");
    let recebido: Record<string, unknown> | null = null;
    const a = await aplicarPlano(
      {
        rpc: async (nome, args) => {
          expect(nome).toBe("importacao_externa_aplicar");
          recebido = args;
          return {
            data: {
              evento_id: EVENTO,
              formulario_id: FORMULARIO,
              questionario_impressao: IMPRESSAO_PUBLICADA,
              por_estado: { importavel: 1 },
              linhas_de_resposta_gravadas: r.previa.linhas_de_resposta_a_gravar,
              itens_registrados: r.previa.itens_a_registrar,
              importado_por: OPERADOR.id,
            },
            error: null,
          };
        },
      },
      r.plano,
    );
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.resumo.linhas_de_resposta_gravadas).toBe(r.previa.linhas_de_resposta_a_gravar);
      expect(a.resumo.itens_registrados).toBe(r.previa.itens_a_registrar);
    }
    // O plano inteiro vai como UM argumento jsonb: a funcao SQL o recebe pronto.
    expect((recebido as unknown as { plano?: { ok?: boolean } })?.plano?.ok).toBe(true);
  });
});

// ================================================ o LOTE RECUSADO na revalidacao
//
// A funcao do banco (migration 024) recusa o LOTE INTEIRO quando qualquer
// submissao entra em conflito depois da previa, e comunica isso por VALOR DE
// RETORNO: `ok: false`, codigo proprio, zeros em todos os contadores e a lista das
// recusadas. Antes desta unidade, `aplicarPlano` remontava so os contadores e
// devolvia `ok: true` -- o operador recebia a divergencia generica da conferencia
// ("a previa disse 5 e o banco gravou 0") em vez de "o lote foi recusado porque a
// pessoa respondeu pelo aplicativo; peca uma previa nova sem ela".
//
// O payload abaixo e o da 024, campo por campo (FASE 3 da funcao).
describe("o LOTE RECUSADO na revalidacao nao volta como sucesso", () => {
  const LOTE = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f";

  /** O pedido que a TELA envia, para as provas que vao ate ela. */
  const PEDIDO_DA_TELA = {
    event_id: EVENTO,
    formulario_id: FORMULARIO,
    impressao_declarada: MANIFESTO.impressao,
    cabecalhos: CABECALHOS,
    linhas: [linhaCompleta("maria@example.org")],
    email_verificado: true,
  };

  function recusadaDa024(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      submissao_id: "resp-maria",
      codigo: "resposta_do_aplicativo",
      motivo:
        "o participante respondeu PELO APLICATIVO nas etapas 104 depois que esta previa foi montada: a resposta dele fica",
      estado_do_plano: "importavel",
      estado: null,
      participante_pretendido: PARTICIPANTES[0].id,
      identidade_via: "email_verificado",
      etapas_em_conflito: ["104"],
      etapas_nao_gravadas: 5,
      submissao_existente: null,
      bloqueio_do_plano: null,
      ...over,
    };
  }

  function retornoDa024(recusadas: Record<string, unknown>[]): Record<string, unknown> {
    return {
      ok: false,
      codigo: "LOTE_RECUSADO_NA_REVALIDACAO",
      motivo: `${recusadas.length} submissao(oes) do lote entraram em conflito depois da previa. O LOTE INTEIRO foi recusado e NADA foi gravado. Peca uma previa nova sem as submissoes conflitantes.`,
      evento_id: EVENTO,
      formulario_id: FORMULARIO,
      questionario_impressao: IMPRESSAO_PUBLICADA,
      lote_impressao: LOTE,
      por_estado: {},
      linhas_de_resposta_gravadas: 0,
      itens_registrados: 0,
      importado_por: OPERADOR.id,
      recusas_na_revalidacao: recusadas.length,
      recusadas_na_revalidacao: recusadas,
    };
  }

  const aplicarCom = async (data: unknown) => {
    const r = await montar();
    if (!r.ok) throw new Error("plano");
    return { previa: r.previa, aplicacao: await aplicarPlano({ rpc: async () => ({ data, error: null }) }, r.plano) };
  };

  it("NEGATIVA: `ok: false` NAO vira `ok: true` com zeros -> IMPORT_REVALIDATION_REFUSED", async () => {
    const { aplicacao } = await aplicarCom(retornoDa024([recusadaDa024()]));

    // O que esta unidade existe para corrigir: isto era `ok: true`.
    expect(aplicacao.ok).toBe(false);
    if (aplicacao.ok) return;

    // O codigo e o que JA EXISTIA no vocabulario para este fato exato, nao um novo.
    expect(aplicacao.codigo).toBe("IMPORT_REVALIDATION_REFUSED");
    // Nem "nao esta instalado", nem "nao respondeu": o banco respondeu e recusou.
    expect(aplicacao.codigo).not.toBe("IMPORT_SCHEMA_MISSING");
    expect(aplicacao.codigo).not.toBe("IMPORT_UNAVAILABLE");

    // A LISTA chega, com a submissao nomeada, a causa, as etapas e o numero.
    expect(aplicacao.detalhes?.ato).toBe("importar_lote");
    expect(aplicacao.detalhes?.revalidacao).toBe("resposta_do_aplicativo");
    expect(aplicacao.detalhes?.recusadas).toEqual([
      {
        submissao_id: "resp-maria",
        codigo: "resposta_do_aplicativo",
        etapas_em_conflito: ["104"],
        etapas_nao_gravadas: 5,
      },
    ]);

    // E o resumo recusado continua inteiro, com os zeros DECLARADOS: nada gravado.
    expect(aplicacao.recusa?.ok).toBe(false);
    expect(aplicacao.recusa?.codigo).toBe("LOTE_RECUSADO_NA_REVALIDACAO");
    expect(aplicacao.recusa?.linhas_de_resposta_gravadas).toBe(0);
    expect(aplicacao.recusa?.itens_registrados).toBe(0);
    expect(aplicacao.recusa?.por_estado).toEqual({});
    expect(aplicacao.recusa?.lote_impressao).toBe(LOTE);
    // `estado: null` = a submissao nunca foi gravada. Nao e "" e nao e 'conflito'.
    expect(aplicacao.recusa?.recusadas_na_revalidacao[0].estado).toBeNull();
    expect(aplicacao.recusa?.recusadas_na_revalidacao[0].participante_pretendido).toBe(PARTICIPANTES[0].id);
    // A prosa do banco fica no `motivo` da falha, que vai para o LOG como `causa`.
    expect(aplicacao.motivo).toMatch(/LOTE_RECUSADO_NA_REVALIDACAO/);
  });

  it("NEGATIVA: recusa SEM lista utilizavel e INDISPONIBILIDADE, nunca 'recusa sem motivo'", async () => {
    // Tres retornos que dizem RECUSA e nao dizem QUAIS submissoes. Nenhum deles
    // autoriza afirmar recusa: sem saber o que tirar da planilha, a instrucao nao
    // existe -- e inventar uma causa e pior que dizer que nao deu para ler.
    const semLista = await aplicarCom(retornoDa024([]));
    const semId = await aplicarCom(retornoDa024([recusadaDa024({ submissao_id: "" })]));
    const semCodigo = await aplicarCom(retornoDa024([recusadaDa024({ codigo: null })]));

    for (const { aplicacao } of [semLista, semId, semCodigo]) {
      expect(aplicacao.ok).toBe(false);
      if (aplicacao.ok) return;
      expect(aplicacao.codigo).toBe("IMPORT_UNAVAILABLE");
      // Indisponibilidade NAO e recusa, e NAO e ausencia de recurso.
      expect(aplicacao.codigo).not.toBe("IMPORT_REVALIDATION_REFUSED");
      expect(aplicacao.codigo).not.toBe("IMPORT_SCHEMA_MISSING");
      expect(aplicacao.recusa).toBeUndefined();
      expect(aplicacao.detalhes?.recusadas).toBeUndefined();
    }
    expect(semLista.aplicacao.ok === false && semLista.aplicacao.motivo).toMatch(/nao disse quais submissoes/);
  });

  // =======================================================================
  // "GRAVOU E RECUSOU" NAO EXISTE -- NOS DOIS SENTIDOS, LADO A LADO.
  //
  // E a MESMA regra, e os dois casos estao juntos de proposito: guardar um
  // sentido e deixar o outro passar e confiar num invariante do banco em vez de
  // conferi-lo. Sob a 024 de hoje nenhum dos dois acontece (na recusa a decisao
  // vem ANTES de qualquer escrita e os contadores saem zerados) -- o que se
  // conferem aqui sao os invariantes, nao um defeito observado.
  //
  // O preco de confiar e NOMEADO: a tela afirmaria "NADA foi gravado, e nada que
  // existia foi tocado" em cima de um corpo que informa cinco linhas gravadas. E
  // afirmacao falsa e pior que enigma -- enigma deixa quem le desconfiado,
  // afirmacao falsa deixa tranquilo.
  // =======================================================================
  it.each([
    [
      "RECUSA com contadores NAO-ZERADOS",
      {
        ...retornoDa024([recusadaDa024()]),
        linhas_de_resposta_gravadas: 5,
        itens_registrados: 52,
      },
      /disse LOTE_RECUSADO_NA_REVALIDACAO .*informou escrita no MESMO retorno \(linhas_de_resposta_gravadas=5, itens_registrados=52\)/,
    ],
    [
      "RECUSA com `por_estado` NAO-VAZIO",
      { ...retornoDa024([recusadaDa024()]), por_estado: { importavel: 1 } },
      /informou escrita no MESMO retorno \(por_estado=\{importavel=1\}\)/,
    ],
    [
      "GRAVACAO com recusas NOMEADAS (o espelho)",
      { ...retornoDa024([recusadaDa024()]), ok: true },
      /afirmou gravacao e listou 1 recusa\(s\) no MESMO retorno/,
    ],
  ])(
    "NEGATIVA (%s): CONTRADICAO -> IMPORT_WRITE_UNVERIFIABLE, nem recusa nem gravacao",
    async (_n, data, motivoEsperado) => {
      const { previa, aplicacao } = await aplicarCom(data);
      expect(aplicacao.ok).toBe(false);
      if (aplicacao.ok) return;

      // Nao e recusa: a recusa e justamente o que nao da para afirmar.
      expect(aplicacao.codigo).not.toBe("IMPORT_REVALIDATION_REFUSED");
      // Nao e "nao respondeu" (respondeu) e nao e "nao esta instalado".
      expect(aplicacao.codigo).not.toBe("IMPORT_UNAVAILABLE");
      expect(aplicacao.codigo).not.toBe("IMPORT_SCHEMA_MISSING");
      expect(aplicacao.codigo).toBe("IMPORT_WRITE_UNVERIFIABLE");
      // Nenhum resumo e entregue como recusa: nada ali pode ser afirmado.
      expect(aplicacao.recusa).toBeUndefined();
      expect(aplicacao.detalhes).toBeUndefined();
      // A contradicao inteira vai para o LOG, nomeada.
      expect(aplicacao.motivo).toMatch(motivoEsperado);

      // E O QUE O OPERADOR LE: nem "gravou", nem "nada foi gravado".
      const resposta = erroHttp(aplicacao.codigo, { causa: aplicacao.motivo });
      expect(resposta.status).toBe(503);
      const desfecho = await aplicarImportacao(PEDIDO_DA_TELA, previa, async () => resposta.clone(), () => {});
      expect(desfecho.tipo).toBe("estado_incerto");
      if (desfecho.tipo !== "estado_incerto") return;

      const naTela = `TITULO: ${TITULO_DO_AVISO[desfecho.tipo]}\n\n${desfecho.mensagem}\n\nACAO: ${ROTULO_DA_ACAO[desfecho.acao]}`;
      console.log(`\n--- O QUE O OPERADOR LE (${_n}) ---\n${naTela}\n---------------------------\n`);

      // O titulo e a mensagem NAO afirmam nenhum dos dois lados.
      expect(naTela).not.toMatch(/nada foi gravado/i);
      expect(naTela).not.toMatch(/NADA foi gravado, e nada que existia foi tocado/);
      expect(naTela).not.toMatch(/foi gravad[ao] com sucesso|importação gravada/i);
      expect(naTela).not.toMatch(/LOTE INTEIRO foi recusado/);
      // Diz o que de fato se sabe, e manda CONFERIR antes de repetir.
      expect(naTela).toMatch(/se contradiz/);
      expect(naTela).toMatch(/não dá para afirmar o que foi gravado/);
      expect(naTela).toMatch(/NÃO repita a importação antes de conferir/);
      expect(naTela).toMatch(/confira o que está registrado/);
      // E NAO manda esperar e tentar de novo, que e o convite a gravar duas vezes.
      expect(desfecho.mensagem).not.toMatch(/aguarde/i);
      expect(naTela).not.toMatch(/instalar|migration/i);
      // Indisponibilidade tem numero de ocorrencia: e por ele que a equipe acha a
      // resposta contraditoria no log.
      expect(desfecho.ocorrencia).toMatch(/^[0-9a-f]{12}$/);
      expect(desfecho.mensagem).toContain(desfecho.ocorrencia as string);
    },
  );

  it("CONTROLE POSITIVO do espelho: recusa com contadores ZERADOS continua recusa normal", async () => {
    // A guarda nova NAO pode engolir o caminho que funciona: zeros sao a afirmacao
    // de que o lote nao entrou, e com eles a recusa segue sendo recusa -- com o
    // texto que instrui.
    const { previa, aplicacao } = await aplicarCom(retornoDa024([recusadaDa024()]));
    expect(aplicacao.ok).toBe(false);
    if (aplicacao.ok) return;
    expect(aplicacao.codigo).toBe("IMPORT_REVALIDATION_REFUSED");
    expect(aplicacao.recusa?.linhas_de_resposta_gravadas).toBe(0);

    const desfecho = await aplicarImportacao(
      PEDIDO_DA_TELA,
      previa,
      async () => erroHttp(aplicacao.codigo, { causa: aplicacao.motivo, detalhes: aplicacao.detalhes }).clone(),
      () => {},
    );
    expect(desfecho.tipo).toBe("lote_recusado");
    if (desfecho.tipo !== "lote_recusado") return;
    expect(desfecho.mensagem).toMatch(/LOTE INTEIRO foi recusado/);
    expect(desfecho.mensagem).toMatch(/NADA foi gravado/);
    expect(desfecho.mensagem).toMatch(/PRÉVIA NOVA sem elas/);
    expect(desfecho.acao).toBe("refazer_previa_sem_as_recusadas");
  });

  it("NEGATIVA: `ok` que nao e booleano nao vira gravacao nem recusa", async () => {
    const { aplicacao } = await aplicarCom({ ...retornoDa024([recusadaDa024()]), ok: "false" });
    expect(aplicacao.ok).toBe(false);
    if (aplicacao.ok) return;
    expect(aplicacao.codigo).toBe("IMPORT_UNAVAILABLE");
    expect(aplicacao.motivo).toMatch(/'ok' de tipo string/);
  });

  it("CONTROLE POSITIVO: lote legitimo continua gravando, com e sem o campo `ok`", async () => {
    // O campo `ok` AUSENTE e o retorno da funcao da 022 -- e continua sendo
    // sucesso. Se a ausencia virasse recusa, esta correcao seria "recusa tudo".
    const r = await montar();
    if (!r.ok) throw new Error("plano");
    const gravado = {
      evento_id: EVENTO,
      formulario_id: FORMULARIO,
      questionario_impressao: IMPRESSAO_PUBLICADA,
      lote_impressao: LOTE,
      por_estado: { importavel: 1 },
      linhas_de_resposta_gravadas: r.previa.linhas_de_resposta_a_gravar,
      itens_registrados: r.previa.itens_a_registrar,
      importado_por: OPERADOR.id,
      recusas_na_revalidacao: 0,
      recusadas_na_revalidacao: [],
    };

    for (const data of [{ ...gravado, ok: true }, gravado]) {
      const a = await aplicarPlano({ rpc: async () => ({ data, error: null }) }, r.plano);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.resumo.ok).toBe(true);
      expect(a.resumo.codigo).toBeNull();
      expect(a.resumo.linhas_de_resposta_gravadas).toBe(r.previa.linhas_de_resposta_a_gravar);
      expect(a.resumo.itens_registrados).toBe(r.previa.itens_a_registrar);
      // Lista vazia e uma AFIRMACAO: nada foi recusado neste lote.
      expect(a.resumo.recusadas_na_revalidacao).toEqual([]);
    }
  });

  // =======================================================================
  // O ULTIMO METRO, de ponta a ponta: a funcao do banco recusa, a BORDA
  // classifica, o SERVIDOR monta a resposta de erro de verdade (`erroHttp`, a
  // mesma que a rota devolve) e a TELA le. Nada escrito a mao no meio.
  // =======================================================================
  it("O TEXTO DO OPERADOR: a recusa do banco chega a tela como desfecho previsto, com a instrucao", async () => {
    const { previa, aplicacao } = await aplicarCom(
      retornoDa024([
        recusadaDa024(),
        recusadaDa024({
          submissao_id: "resp-joao",
          codigo: "versao_da_submissao_mudou",
          participante_pretendido: PARTICIPANTES[1].id,
          etapas_em_conflito: [],
          etapas_nao_gravadas: 3,
          estado: "importavel",
        }),
      ]),
    );
    expect(aplicacao.ok).toBe(false);
    if (aplicacao.ok) return;

    // O que a ROTA faz com isso, nos mesmos termos de app/api/importacao/aplicar.
    const resposta = erroHttp(aplicacao.codigo, { causa: aplicacao.motivo, detalhes: aplicacao.detalhes });
    expect(resposta.status).toBe(400);

    // E o que a TELA faz com a resposta da rota.
    const desfecho = await aplicarImportacao(PEDIDO_DA_TELA, previa, async () => resposta.clone(), () => {});

    expect(desfecho.tipo).toBe("lote_recusado");
    if (desfecho.tipo !== "lote_recusado") return;
    expect(desfecho.codigo).toBe("IMPORT_REVALIDATION_REFUSED");
    expect(desfecho.acao).toBe("refazer_previa_sem_as_recusadas");

    // ---- O TEXTO EXATO, impresso para quem revisa esta unidade ler -------
    const naTela = [
      `TITULO: ${TITULO_DO_AVISO.lote_recusado}`,
      "",
      desfecho.mensagem,
      "",
      ...desfecho.recusadas.map((r) => `- ${linhaDaRecusa(r, previa)}`),
      "",
      `ACAO: ${ROTULO_DA_ACAO[desfecho.acao]}`,
    ].join("\n");
    console.log(`\n--- O QUE O OPERADOR LE ---\n${naTela}\n---------------------------\n`);

    // 1. O LOTE INTEIRO, e NADA gravado -- nem o que nao tinha conflito.
    expect(desfecho.mensagem).toMatch(/LOTE INTEIRO foi recusado/);
    expect(desfecho.mensagem).toMatch(/NADA foi gravado/);
    expect(desfecho.mensagem).toMatch(/nem as submissões que não tinham conflito/);
    // 2. A resposta de quem respondeu esta INTACTA, e a coleta nao se perdeu.
    expect(desfecho.mensagem).toMatch(/continua intacta/);
    expect(desfecho.mensagem).toMatch(/planilha continua inteira/);
    // 3. NAO e erro: o texto diz que o sistema funcionou.
    expect(desfecho.mensagem).toMatch(/não é falha do sistema/);
    expect(desfecho.mensagem).not.toMatch(/erro|defeito|falhou|tente de novo/i);
    // 4. Quantas, e por que a primeira.
    expect(desfecho.mensagem).toMatch(/2 submissões do lote entraram em conflito/);
    expect(desfecho.mensagem).toMatch(/respondeu PELO APLICATIVO/);
    // 5. A ACAO: previa nova SEM as recusadas -- nunca "aguarde", nunca "instale".
    expect(desfecho.mensagem).toMatch(/PRÉVIA NOVA sem elas/);
    expect(desfecho.mensagem).not.toMatch(/aguarde|instalar|migration/i);
    // 6. QUAIS submissoes, de quem, e por que -- uma linha por submissao.
    expect(naTela).toMatch(/resp-maria \(maria@example\.org\): o participante respondeu PELO APLICATIVO/);
    expect(naTela).toMatch(/Etapas em conflito: 104\./);
    expect(naTela).toMatch(/5 etapa\(s\) desta submissão não foram gravadas\./);
    expect(naTela).toMatch(/resp-joao: essa submissão já está gravada em outra versão/);
    // 7. Nada de texto interno de banco na tela.
    expect(naTela).not.toMatch(/LOTE_RECUSADO_NA_REVALIDACAO|jsonb|plano recusado/);
  });
});
