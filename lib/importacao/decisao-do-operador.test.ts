// A BORDA DA DECISAO DO OPERADOR, nivel unitario: sem banco, sem HTTP, sem rede.
//
// A prova com as rotas de verdade, as funcoes da 022 e Postgres de verdade esta em
// lib/importacao/provas/decisao-http.test.ts. Aqui ficam as decisoes puras, cada
// negativa com o controle positivo ao lado.

import { describe, expect, it } from "vitest";
import {
  CODIGO_DA_RECUSA_DA_DECISAO,
  acharFichaDeReconciliacao,
  acharFichaDeRevogacao,
  conferirFicha,
  divergenciasEntre,
  identidadeRegistrada,
  impressaoDaFicha,
  lerPedidoDeReconciliacao,
  lerPedidoDeRevogacao,
  montarFichaDeReconciliacao,
  montarMesaDeDecisao,
  type FatosDoParticipante,
  type LinhaDeSubmissao,
} from "./decisao-do-operador";
import type { ContextoDoEvento } from "./borda";
import { montarManifesto, type LinhaDeEtapa } from "./manifesto-questionario";

const EVENTO = "dddddddd-d0d0-4d0d-8d0d-dddddddddddd";
const SUB = "aaaaaaaa-0000-4000-8000-aaaaaaaa0001";
const PART = "bbbbbbbb-0000-4000-8000-bbbbbbbb0001";
const OUTRO = "bbbbbbbb-0000-4000-8000-bbbbbbbb0002";
const OPERADOR = { id: "0da0da0d-0000-4000-8000-0da0da0d0da0", email: "host@fortinside.test" };
const IMPRESSAO = "a".repeat(64);

// Um questionario minimo, montado pelo montador de verdade: uma etapa, duas
// perguntas, uma delas de escala.
const ETAPAS: LinhaDeEtapa[] = [
  {
    id: 201,
    stage_number: 1,
    title: "Etapa unica",
    questions: [
      { id: "p1", text: "Como voce se sente?", type: "scale", min: 1, max: 5 },
      { id: "p2", text: "Escreva uma palavra", type: "text" },
    ],
  } as unknown as LinhaDeEtapa,
];
const montado = montarManifesto(ETAPAS, 7);
if (!montado.ok) throw new Error(`manifesto de teste invalido: ${montado.motivo}`);
const MANIFESTO = montado.manifesto;

function contexto(participantes: ContextoDoEvento["participantes"]): ContextoDoEvento {
  return { evento: { id: EVENTO, quiz_version: 7 }, etapas: ETAPAS, participantes };
}

function submissao(over: Partial<LinhaDeSubmissao> = {}): LinhaDeSubmissao {
  return {
    id: SUB,
    submissao_id: "resp-001",
    formulario_id: "form-teste",
    formulario_nome: null,
    estado: "pendente",
    email_coletado: "ninguem@example.org",
    email_verificado: true,
    nome_declarado: "Quem Respondeu",
    respostas_brutas: { p1: 4, p2: "palavra" },
    participant_id: null,
    identidade_via: null,
    quiz_version: 7,
    questionario_impressao: MANIFESTO.impressao,
    bloqueio: { motivo: "identidade PENDENTE (sem_correspondencia): nao e de ninguem deste evento" },
    ...over,
  };
}

const PARTICIPANTE: FatosDoParticipante = {
  id: PART,
  nome: "Pessoa Livre",
  email: "livre@example.org",
  respostas_canonicas: 0,
  submissao_externa_ativa: null,
};

const CORPO_LEGITIMO = {
  event_id: EVENTO,
  submission_id: SUB,
  participant_id: PART,
  justificativa: "conferido na lista do credenciamento",
  ficha_impressao: IMPRESSAO,
};

// =========================================================================
describe("o corpo do pedido: o operador NUNCA vem do cliente", () => {
  it.each([
    "operador",
    "operador_id",
    "operador_email",
    "importado_por",
    "importado_por_email",
    "decidido_por",
    "acao",
    "criado_em",
  ])("NEGATIVA: corpo com `%s` e recusado", (campo) => {
    const r = lerPedidoDeReconciliacao({ ...CORPO_LEGITIMO, [campo]: "qualquer coisa" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codigo).toBe("INVALID_REQUEST");
      expect(r.motivo).toContain(campo);
      expect(r.motivo).toMatch(/sessao verificada/);
    }
  });

  it("CONTROLE POSITIVO: o mesmo corpo, sem campo de operador, e aceito", () => {
    const r = lerPedidoDeReconciliacao(CORPO_LEGITIMO);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pedido.participant_id).toBe(PART);
      expect(r.pedido.justificativa).toBe("conferido na lista do credenciamento");
      expect(r.pedido.ficha_impressao).toBe(IMPRESSAO);
    }
  });

  it.each([
    ["sem justificativa", { justificativa: undefined }],
    ["justificativa curta", { justificativa: "ok" }],
    ["sem impressao da ficha", { ficha_impressao: undefined }],
    ["impressao que nao e SHA-256", { ficha_impressao: "nao-e-hash" }],
    ["submission_id que nao e UUID", { submission_id: "123" }],
    ["participant_id que nao e UUID", { participant_id: "456" }],
    ["event_id que nao e UUID", { event_id: "789" }],
  ])("NEGATIVA: %s e recusado", (_nome, troca) => {
    const r = lerPedidoDeReconciliacao({ ...CORPO_LEGITIMO, ...troca });
    expect(r.ok).toBe(false);
  });

  it("a revogacao NAO aceita participant_id: ela desfaz o que esta gravado", () => {
    const comAlvo = lerPedidoDeRevogacao({ ...CORPO_LEGITIMO });
    expect(comAlvo.ok).toBe(false);
    if (!comAlvo.ok) expect(comAlvo.motivo).toMatch(/participant_id/);

    // CONTROLE POSITIVO: sem ele, passa.
    const { participant_id: _ignorado, ...semAlvo } = CORPO_LEGITIMO;
    void _ignorado;
    expect(lerPedidoDeRevogacao(semAlvo).ok).toBe(true);
  });
});

// =========================================================================
describe("a ficha mostra o que esta sendo afirmado", () => {
  it("as divergencias sao nomeadas, e o e-mail nao verificado e uma delas", () => {
    const d = divergenciasEntre(submissao({ email_verificado: false }), PARTICIPANTE);
    expect(d.map((x) => x.codigo)).toEqual([
      "email_nao_verificado",
      "email_diferente_do_participante",
    ]);

    // CONTROLE POSITIVO: e-mail igual e verificado nao gera divergencia nenhuma.
    const semDivergencia = divergenciasEntre(
      submissao({ email_coletado: PARTICIPANTE.email }),
      PARTICIPANTE,
    );
    expect(semDivergencia).toEqual([]);
  });

  it("submissao sem e-mail diz que nao ha o que comparar, e nao finge que bate", () => {
    const d = divergenciasEntre(submissao({ email_coletado: null }), PARTICIPANTE);
    expect(d.map((x) => x.codigo)).toContain("email_nao_declarado");
    expect(d.find((x) => x.codigo === "email_nao_declarado")?.texto).toMatch(/sua decisao/);
  });

  it("a afirmacao e em primeira pessoa, nomeia a pessoa e diz que o sistema NAO verificou", () => {
    const ficha = montarFichaDeReconciliacao(
      contexto([{ id: PART, email: PARTICIPANTE.email, full_name: PARTICIPANTE.nome, respostas_existentes: 0 }]),
      MANIFESTO,
      submissao(),
      PARTICIPANTE,
      OPERADOR,
    );
    expect(ficha.afirmacao).toMatch(/Voce esta afirmando/);
    expect(ficha.afirmacao).toContain("ninguem@example.org");
    expect(ficha.afirmacao).toContain("Pessoa Livre");
    expect(ficha.afirmacao).toMatch(/NAO verificou/);
    expect(ficha.afirmacao).toMatch(/pode ser revogado/);

    // A consequencia sai do PLANO, nao de estimativa: uma etapa, dois itens.
    expect(ficha.consequencia).toEqual({
      etapas_a_gravar: 1,
      itens_a_registrar: 2,
      apto_para_pontuar: true,
      bloqueio: null,
      respostas_sobrescritas: 0,
      reversivel: true,
    });
    expect(ficha.permitida).toBe(true);
  });

  it("NEGATIVA: participante que JA TEM resposta nao e permitido, e a ficha diz que nao tem volta", () => {
    const ocupado: FatosDoParticipante = { ...PARTICIPANTE, respostas_canonicas: 3 };
    const ficha = montarFichaDeReconciliacao(
      contexto([{ id: PART, email: ocupado.email, full_name: ocupado.nome, respostas_existentes: 3 }]),
      MANIFESTO,
      submissao(),
      ocupado,
      OPERADOR,
    );
    expect(ficha.permitida).toBe(false);
    expect(ficha.impedimento?.codigo).toBe("participante_ocupado");
    expect(ficha.impedimento?.detalhes).toEqual({
      ocupacao: "respostas_canonicas",
      respostas_existentes: 3,
      ato: "reconciliar",
    });
    expect(ficha.consequencia?.reversivel).toBe(false);
    expect(ficha.impedimento?.texto).toMatch(/nao devolveria|nao ha volta/);
  });

  it("NEGATIVA: questionario que mudou desde a coleta -> a ficha NAO afirma consequencia nenhuma", () => {
    const ficha = montarFichaDeReconciliacao(
      contexto([{ id: PART, email: PARTICIPANTE.email, full_name: PARTICIPANTE.nome, respostas_existentes: 0 }]),
      MANIFESTO,
      // A submissao guarda a impressao do questionario que a pessoa respondeu.
      submissao({ questionario_impressao: "b".repeat(64) }),
      PARTICIPANTE,
      OPERADOR,
    );
    expect(ficha.consequencia).toBeNull();
    expect(ficha.permitida).toBe(false);
  });
});

// =========================================================================
describe("a impressao da ficha amarra a decisao ao que foi conferido", () => {
  const ctx = contexto([
    { id: PART, email: PARTICIPANTE.email, full_name: PARTICIPANTE.nome, respostas_existentes: 0 },
  ]);

  it("a mesma ficha da a mesma impressao, e qualquer mudanca muda a impressao", () => {
    const a = montarFichaDeReconciliacao(ctx, MANIFESTO, submissao(), PARTICIPANTE, OPERADOR);
    const b = montarFichaDeReconciliacao(ctx, MANIFESTO, submissao(), PARTICIPANTE, OPERADOR);
    expect(a.impressao_da_ficha).toBe(b.impressao_da_ficha);
    expect(a.impressao_da_ficha).toMatch(/^[0-9a-f]{64}$/);

    // O e-mail do participante mudou no cadastro: outra ficha, outra impressao.
    const c = montarFichaDeReconciliacao(
      ctx,
      MANIFESTO,
      submissao(),
      { ...PARTICIPANTE, email: "outro@example.org" },
      OPERADOR,
    );
    expect(c.impressao_da_ficha).not.toBe(a.impressao_da_ficha);

    // E a impressao NAO depende da justificativa (ela nao esta na ficha).
    const { impressao_da_ficha: _h, ...semImpressao } = a;
    void _h;
    expect(impressaoDaFicha(semImpressao)).toBe(a.impressao_da_ficha);
  });

  it("conferirFicha: bate, NAO bate, e nao declarada -- e as duas ultimas recusam", () => {
    expect(conferirFicha(IMPRESSAO, IMPRESSAO)).toEqual({ ok: true });
    expect(conferirFicha(IMPRESSAO.toUpperCase(), IMPRESSAO)).toEqual({ ok: true });

    const outra = conferirFicha("b".repeat(64), IMPRESSAO);
    expect(outra.ok).toBe(false);
    if (!outra.ok) expect(outra.codigo).toBe("IMPORT_DECISION_STALE");

    for (const vazia of [null, "", "   "]) {
      const r = conferirFicha(vazia, IMPRESSAO);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toMatch(/nao declarou/);
    }
  });
});

// =========================================================================
describe("a identidade anterior e a REGISTRADA, nao uma recalculada", () => {
  it("conflito continua conflito: e por isso que a decisao do operador nao e recusada por 'ja reconciliada'", () => {
    const i = identidadeRegistrada(submissao({ estado: "conflito" }));
    expect(i.estado).toBe("conflito");
    if (i.estado === "conflito") expect(i.motivo).toBe("duas_submissoes_do_mesmo_email");
  });

  it("revogada entra como pendente, e a explicacao gravada continua visivel", () => {
    const i = identidadeRegistrada(
      submissao({ estado: "revogada", bloqueio: { motivo: "reconciliacao REVOGADA pelo operador: erro" } }),
    );
    expect(i.estado).toBe("pendente");
    if (i.estado === "pendente") expect(i.explicacao).toMatch(/REVOGADA/);
  });

  it("os tres motivos de pendencia saem do que a coleta trouxe", () => {
    expect(identidadeRegistrada(submissao({ email_coletado: null })).estado).toBe("pendente");
    const semEmail = identidadeRegistrada(submissao({ email_coletado: null }));
    if (semEmail.estado === "pendente") expect(semEmail.motivo).toBe("email_ausente");
    const naoVerificado = identidadeRegistrada(submissao({ email_verificado: false }));
    if (naoVerificado.estado === "pendente") expect(naoVerificado.motivo).toBe("email_nao_verificado");
    const semDono = identidadeRegistrada(submissao());
    if (semDono.estado === "pendente") expect(semDono.motivo).toBe("sem_correspondencia");
  });
});

// =========================================================================
describe("a mesa separa o que se decide do que se revoga, e cada recusa tem o seu codigo", () => {
  const participantes: ContextoDoEvento["participantes"] = [
    { id: PART, email: PARTICIPANTE.email, full_name: PARTICIPANTE.nome, respostas_existentes: 0 },
    { id: OUTRO, email: "outro@example.org", full_name: "Pessoa Dois", respostas_existentes: 5 },
  ];
  const ctx = contexto(participantes);

  const pendente = submissao();
  const ativa = submissao({
    id: "aaaaaaaa-0000-4000-8000-aaaaaaaa0002",
    submissao_id: "resp-002",
    estado: "importavel",
    participant_id: OUTRO,
    identidade_via: "decisao_do_operador",
    bloqueio: null,
  });

  const mesa = montarMesaDeDecisao(
    ctx,
    MANIFESTO,
    [pendente, ativa],
    [
      { external_submission_id: ativa.id, origem: "externo" },
      { external_submission_id: ativa.id, origem: "app" },
    ],
    OPERADOR,
  );

  it("a pendente entra em a_decidir com um candidato por participante; a ativa entra em revogaveis", () => {
    expect(mesa.a_decidir.map((g) => g.submissao.submissao_id)).toEqual(["resp-001"]);
    expect(mesa.a_decidir[0].candidatos.map((c) => c.participante.id)).toEqual([PART, OUTRO]);
    expect(mesa.revogaveis.map((r) => r.submissao.submissao_id)).toEqual(["resp-002"]);
    expect(mesa.por_estado).toEqual({ pendente: 1, importavel: 1 });
  });

  it("a ficha da revogacao conta o que SAI, e avisa sobre a linha de outra origem", () => {
    const r = mesa.revogaveis[0];
    expect(r.respostas_canonicas_a_remover).toBe(2);
    expect(r.respostas_de_outra_origem).toBe(1);
    expect(r.avisos.join(" ")).toMatch(/REMOVE 2 resposta/);
    expect(r.avisos.join(" ")).toMatch(/ATENCAO/);
    expect(r.avisos.join(" ")).toMatch(/historico NAO e reescrito/);
    expect(r.permitida).toBe(true);
  });

  it("os quatro fatos de recusa tem CODIGOS diferentes", () => {
    const linhas = [pendente, ativa];

    // submissao que nao e deste evento -> 404
    const naoExiste = acharFichaDeReconciliacao(mesa, linhas, "ffffffff-0000-4000-8000-ffffffffffff", PART);
    expect(naoExiste.ok).toBe(false);
    if (!naoExiste.ok) expect(naoExiste.codigo).toBe("IMPORT_SUBMISSION_NOT_FOUND");

    // submissao JA reconciliada -> nao se reconcilia por cima
    const jaReconciliada = acharFichaDeReconciliacao(mesa, linhas, ativa.id, PART);
    expect(jaReconciliada.ok).toBe(false);
    if (!jaReconciliada.ok) {
      expect(jaReconciliada.codigo).toBe("IMPORT_DECISION_REFUSED");
      expect(jaReconciliada.detalhes?.estado_da_submissao).toBe("importavel");
    }

    // participante que nao e do evento
    const foraDoEvento = acharFichaDeReconciliacao(mesa, linhas, pendente.id, "cccccccc-0000-4000-8000-cccccccc0001");
    expect(foraDoEvento.ok).toBe(false);
    if (!foraDoEvento.ok) expect(foraDoEvento.codigo).toBe("IMPORT_DECISION_REFUSED");

    // alvo OCUPADO -> codigo proprio, com o numero no detalhe
    const ocupado = acharFichaDeReconciliacao(mesa, linhas, pendente.id, OUTRO);
    expect(ocupado.ok).toBe(false);
    if (!ocupado.ok) {
      expect(ocupado.codigo).toBe("IMPORT_TARGET_OCCUPIED");
      expect(ocupado.detalhes?.respostas_existentes).toBe(5);
    }

    // CONTROLE POSITIVO: o alvo livre, na mesma mesa, passa.
    const ok = acharFichaDeReconciliacao(mesa, linhas, pendente.id, PART);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.ficha.participante.id).toBe(PART);

    // revogar o que nao esta reconciliado -> recusa com o ato nomeado
    const semNada = acharFichaDeRevogacao(mesa, linhas, pendente.id);
    expect(semNada.ok).toBe(false);
    if (!semNada.ok) {
      expect(semNada.codigo).toBe("IMPORT_DECISION_REFUSED");
      expect(semNada.detalhes?.ato).toBe("revogar");
    }
    // CONTROLE POSITIVO: a reconciliada passa.
    expect(acharFichaDeRevogacao(mesa, linhas, ativa.id).ok).toBe(true);
  });

  it("participante que ja tem submissao ativa aparece com a submissao NOMEADA", () => {
    const candidato = mesa.a_decidir[0].candidatos.find((c) => c.participante.id === OUTRO);
    expect(candidato?.participante.submissao_externa_ativa).toBe("resp-002");
    expect(candidato?.divergencias.map((d) => d.codigo)).toContain("participante_ja_tem_submissao_ativa");
  });
});

// =========================================================================
describe("a tabela de recusas do plano cobre todas as recusas, e nenhuma vira 'nao instalado'", () => {
  it("cada recusa do planejador tem codigo HTTP proprio", () => {
    expect(CODIGO_DA_RECUSA_DA_DECISAO).toEqual({
      MANIFESTO_DIFERENTE: "IMPORT_MANIFEST_MISMATCH",
      MANIFESTO_INDISPONIVEL: "IMPORT_MANIFEST_UNVERIFIABLE",
      OPERADOR_AUSENTE: "IMPORT_PLAN_REFUSED",
      ORIGEM_AUSENTE: "IMPORT_PLAN_REFUSED",
      VERSAO_DIVERGENTE: "IMPORT_PLAN_REFUSED",
      SUBMISSAO_FORA_DO_LOTE: "IMPORT_SUBMISSION_NOT_FOUND",
      DECISAO_RECUSADA: "IMPORT_DECISION_REFUSED",
    });
    // Nenhuma recusa de decisao manda instalar atualizacao de banco: "o recurso
    // nao esta instalado" e OUTRO fato, e so a leitura do banco o produz.
    expect(Object.values(CODIGO_DA_RECUSA_DA_DECISAO)).not.toContain("IMPORT_SCHEMA_MISSING");
  });
});
