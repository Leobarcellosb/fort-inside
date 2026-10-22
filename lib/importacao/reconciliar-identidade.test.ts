import { describe, expect, it } from "vitest";
import {
  aplicarDecisaoDoOperador,
  normalizarEmail,
  reconciliarLote,
  type ParticipanteDoEvento,
  type SubmissaoExterna,
} from "./reconciliar-identidade";

function sub(over: Partial<SubmissaoExterna> = {}): SubmissaoExterna {
  return {
    submissao_id: "sub-1",
    email: "maria@example.org",
    email_verificado: true,
    nome_declarado: "Maria Souza",
    respostas: { q1: "Maria Souza" },
    ...over,
  };
}

const MARIA: ParticipanteDoEvento = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "maria@example.org",
  full_name: "Maria Souza",
};
const JOAO: ParticipanteDoEvento = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "joao@example.org",
  full_name: "João Pereira",
};

describe("normalizarEmail -- a UNICA normalizacao, declarada", () => {
  it("apara espaco e passa para minuscula", () => {
    expect(normalizarEmail("  Maria@Example.ORG ")).toBe("maria@example.org");
  });
  it("nao remove ponto nem sufixo +tag (isso seria inventar outro e-mail)", () => {
    expect(normalizarEmail("ma.ria+forms@example.org")).toBe("ma.ria+forms@example.org");
  });
  it("vazio e nao-texto viram null", () => {
    for (const v of ["", "   ", null, undefined, 42]) expect(normalizarEmail(v)).toBeNull();
  });
});

describe("CONTROLE POSITIVO: reconciliacao legitima", () => {
  it("e-mail verificado com correspondencia unica reconcilia", () => {
    const [r] = reconciliarLote([sub()], [MARIA, JOAO]);
    expect(r.estado).toBe("reconciliada");
    if (r.estado !== "reconciliada") return;
    expect(r.participant_id).toBe(MARIA.id);
    expect(r.via).toBe("email_verificado");
    expect(r.email_normalizado).toBe("maria@example.org");
  });

  it("diferenca de caixa no e-mail nao impede a reconciliacao", () => {
    const [r] = reconciliarLote([sub({ email: "MARIA@Example.org" })], [MARIA]);
    expect(r.estado).toBe("reconciliada");
  });
});

describe("PENDENTE -- nunca criada em silencio, nunca descartada em silencio", () => {
  it("e-mail que nao e de ninguem do evento fica PENDENTE (nao cria participante)", () => {
    const [r] = reconciliarLote([sub({ email: "ninguem@example.org" })], [MARIA, JOAO]);
    expect(r.estado).toBe("pendente");
    if (r.estado !== "pendente") return;
    expect(r.motivo).toBe("sem_correspondencia");
    expect(r.explicacao).toContain("Nao se cria participante");
  });

  it("e-mail NAO verificado fica PENDENTE mesmo casando com participante", () => {
    const [r] = reconciliarLote([sub({ email_verificado: false })], [MARIA]);
    expect(r.estado).toBe("pendente");
    if (r.estado !== "pendente") return;
    expect(r.motivo).toBe("email_nao_verificado");
  });

  it("submissao sem e-mail fica PENDENTE -- nome NAO e usado para casar", () => {
    const [r] = reconciliarLote(
      [sub({ email: null, nome_declarado: "Maria Souza" })],
      [MARIA],
    );
    expect(r.estado).toBe("pendente");
    if (r.estado !== "pendente") return;
    expect(r.motivo).toBe("email_ausente");
  });

  it("nome identico com e-mail diferente NAO reconcilia", () => {
    const [r] = reconciliarLote(
      [sub({ email: "maria.souza@outro.org", nome_declarado: "Maria Souza" })],
      [MARIA],
    );
    expect(r.estado).toBe("pendente");
  });
});

describe("CONFLITO -- explicito, nunca desempate automatico", () => {
  it("duas submissoes do mesmo e-mail viram CONFLITO para as DUAS", () => {
    const rs = reconciliarLote(
      [sub({ submissao_id: "sub-1" }), sub({ submissao_id: "sub-2" })],
      [MARIA],
    );
    expect(rs.map((r) => r.estado)).toEqual(["conflito", "conflito"]);
    for (const r of rs) {
      if (r.estado !== "conflito") continue;
      expect(r.motivo).toBe("duas_submissoes_do_mesmo_email");
      expect(r.envolvidos.sort()).toEqual(["sub-1", "sub-2"]);
      expect(r.explicacao).toContain("descartaria a outra em silencio");
    }
  });

  it("nao escolhe a ultima nem a mais completa", () => {
    const rs = reconciliarLote(
      [
        sub({ submissao_id: "antiga", respostas: { q1: "a" } }),
        sub({ submissao_id: "nova", respostas: { q1: "a", q2: "30", q3: "c" } }),
      ],
      [MARIA],
    );
    expect(rs.every((r) => r.estado === "conflito")).toBe(true);
    expect(rs.some((r) => r.estado === "reconciliada")).toBe(false);
  });

  it("e-mail que casa com dois participantes e CONFLITO, nao o primeiro da lista", () => {
    const gemeo: ParticipanteDoEvento = { ...MARIA, id: "33333333-3333-4333-8333-333333333333" };
    const [r] = reconciliarLote([sub()], [MARIA, gemeo]);
    expect(r.estado).toBe("conflito");
    if (r.estado !== "conflito") return;
    expect(r.motivo).toBe("email_casa_com_mais_de_um_participante");
    expect(r.envolvidos).toHaveLength(2);
  });

  it("participante que JA tem respostas e CONFLITO -- import nao sobrescreve", () => {
    const [r] = reconciliarLote([sub()], [{ ...MARIA, respostas_existentes: 5 }]);
    expect(r.estado).toBe("conflito");
    if (r.estado !== "conflito") return;
    expect(r.motivo).toBe("participante_ja_tem_respostas");
    expect(r.explicacao).toContain("apagaria resposta ja existente");
  });

  it("CONTROLE POSITIVO: participante com zero respostas existentes reconcilia", () => {
    const [r] = reconciliarLote([sub()], [{ ...MARIA, respostas_existentes: 0 }]);
    expect(r.estado).toBe("reconciliada");
  });
});

describe("duas submissoes de pessoas DIFERENTES nao se contaminam", () => {
  it("cada uma casa com a sua", () => {
    const rs = reconciliarLote(
      [sub({ submissao_id: "s1" }), sub({ submissao_id: "s2", email: "joao@example.org" })],
      [MARIA, JOAO],
    );
    expect(rs.map((r) => r.estado)).toEqual(["reconciliada", "reconciliada"]);
    expect(rs.map((r) => (r.estado === "reconciliada" ? r.participant_id : null))).toEqual([
      MARIA.id,
      JOAO.id,
    ]);
  });
});

describe("aplicarDecisaoDoOperador -- registro de um ato, nao desempate automatico", () => {
  const pendente = reconciliarLote([sub({ email: "ninguem@example.org" })], [MARIA])[0];

  it("CONTROLE POSITIVO: decisao completa reconcilia via decisao_do_operador", () => {
    const r = aplicarDecisaoDoOperador(pendente, {
      participant_id: MARIA.id,
      operador_id: "op-1",
      justificativa: "e-mail pessoal da Maria, confirmado por telefone",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resultado.estado).toBe("reconciliada");
    if (r.resultado.estado !== "reconciliada") return;
    expect(r.resultado.via).toBe("decisao_do_operador");
    expect(r.resultado.participant_id).toBe(MARIA.id);
  });

  it("recusa decisao SEM operador responsavel (seria efeito colateral de import)", () => {
    const r = aplicarDecisaoDoOperador(pendente, {
      participant_id: MARIA.id,
      operador_id: "  ",
      justificativa: "porque sim",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain("operador");
  });

  it("recusa decisao sem justificativa registrada", () => {
    const r = aplicarDecisaoDoOperador(pendente, {
      participant_id: MARIA.id,
      operador_id: "op-1",
      justificativa: "",
    });
    expect(r.ok).toBe(false);
  });

  it("recusa trocar uma reconciliacao ja feita sem revogar antes", () => {
    const feita = reconciliarLote([sub()], [MARIA])[0];
    const r = aplicarDecisaoDoOperador(feita, {
      participant_id: JOAO.id,
      operador_id: "op-1",
      justificativa: "mudei de ideia",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain("revogue");
  });
});
