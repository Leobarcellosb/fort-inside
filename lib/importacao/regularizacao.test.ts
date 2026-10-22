import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANAIS_DO_DESTINATARIO,
  FONTES_ACEITAS,
  codigoDaRecusaNoTexto,
  lerPedidoDeDesconsideracao,
  lerPedidoDeDestinatario,
  lerPedidoDeRegularizacao,
  referenciaSuficiente,
  substanciaDaReferencia,
} from "./regularizacao";

const MIGRATION = readFileSync(
  join(__dirname, "../../supabase/migrations/029_regularizacao_da_segunda_resposta.sql"),
  "utf8",
);

const UUID = "11111111-1111-4111-8111-111111111111";
const IMPRESSAO = "a".repeat(64);
const BASE = {
  event_id: UUID,
  submission_id: UUID,
  caso_impressao: IMPRESSAO,
  fonte_tipo: "lista_oficial_previa",
  referencia: "Planilha da coordenacao de 12/10, aba Turma B, linha 23",
  motivo: "Lucas digitou o e-mail da Marina por engano no formulario",
};

describe("vocabulario fechado: o TypeScript diz o mesmo que o CHECK da 029", () => {
  it("as tres fontes aceitas sao exatamente as do CHECK", () => {
    const bloco = /external_identity_resolutions_fonte_check\s+check \(fonte_tipo in \(([\s\S]*?)\)\);/.exec(MIGRATION);
    expect(bloco).not.toBeNull();
    const doSql = [...(bloco as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(doSql).toEqual(Object.keys(FONTES_ACEITAS).sort());
  });
  it("os canais do destinatario sao exatamente os do CHECK, e a lista oficial NAO e canal", () => {
    const bloco = /external_recipient_confirmations_canal_check\s+check \(canal_tipo in \(([^)]*)\)\)/.exec(MIGRATION);
    const doSql = [...(bloco as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(doSql).toEqual(Object.keys(CANAIS_DO_DESTINATARIO).sort());
    expect(Object.keys(CANAIS_DO_DESTINATARIO)).not.toContain("lista_oficial_previa");
  });
});

describe("a referencia tem de dizer algo alem de carimbo e do proprio formulario", () => {
  it("'identidade conferida' e variantes sao recusadas", () => {
    for (const t of ["Identidade conferida pelo operador.", "ok, conferido, tudo certo com a pessoa", "IDENTIDADE CONFIRMADA E VERIFICADA"]) {
      expect(referenciaSuficiente(t, "marina@x.org", "Lucas Prado")).toBe(false);
    }
  });
  it("so o nome e o e-mail que a propria submissao trouxe sao recusados", () => {
    expect(referenciaSuficiente("Lucas Prado marina@x.org conferido ok", "marina@x.org", "Lucas Prado")).toBe(false);
  });
  it("uma referencia que identifica a conferencia passa", () => {
    expect(referenciaSuficiente(BASE.referencia, "marina@x.org", "Lucas Prado")).toBe(true);
    expect(substanciaDaReferencia("Lista da coordenação de 15/10, linha 23: Lucas Prado", "m@x.org", "Lucas Prado")).toBe(
      "lista coordenacao 15 10 linha 23",
    );
  });
});

describe("os pedidos", () => {
  it("regularizar: vincular e criar validos sao lidos", () => {
    const v = lerPedidoDeRegularizacao({ ...BASE, destino: { tipo: "vincular", participant_id: UUID } });
    expect(v.ok).toBe(true);
    const c = lerPedidoDeRegularizacao({ ...BASE, destino: { tipo: "criar", nome: " Joana   Lima ", email: "Joana@X.org" } });
    expect(c.ok && c.pedido.destino).toEqual({ tipo: "criar", nome: "Joana Lima", email: "joana@x.org", telefone: null });
  });
  it("fonte fora do vocabulario e recusada", () => {
    for (const f of ["grupo_whatsapp", "nome_no_formulario", "identidade conferida", "", undefined]) {
      expect(lerPedidoDeRegularizacao({ ...BASE, fonte_tipo: f, destino: { tipo: "vincular", participant_id: UUID } }).ok).toBe(false);
    }
  });
  it("operador, email_verificado ou identidade_via no corpo sao recusados", () => {
    for (const campo of ["operador", "operador_id", "decidido_por", "email_verificado", "identidade_via"]) {
      const r = lerPedidoDeRegularizacao({ ...BASE, [campo]: true, destino: { tipo: "vincular", participant_id: UUID } });
      expect(r.ok).toBe(false);
    }
  });
  it("referencia e motivo curtos sao recusados; caso sem impressao e recusado", () => {
    const d = { tipo: "vincular", participant_id: UUID };
    expect(lerPedidoDeRegularizacao({ ...BASE, destino: d, referencia: "conferido" }).ok).toBe(false);
    expect(lerPedidoDeRegularizacao({ ...BASE, destino: d, motivo: "erro" }).ok).toBe(false);
    expect(lerPedidoDeRegularizacao({ ...BASE, destino: d, caso_impressao: "x" }).ok).toBe(false);
  });
  it("desconsiderar nao aceita destino", () => {
    expect(lerPedidoDeDesconsideracao(BASE).ok).toBe(true);
    expect(lerPedidoDeDesconsideracao({ ...BASE, participant_id: UUID }).ok).toBe(false);
  });
  it("destinatario: so os canais independentes", () => {
    const b = { event_id: UUID, participant_id: UUID, referencia: "Liguei no celular da mae cadastrado em agosto", email_destinatario: "a@b.org" };
    expect(lerPedidoDeDestinatario({ ...b, canal_tipo: "contato_previamente_conhecido" }).ok).toBe(true);
    expect(lerPedidoDeDestinatario({ ...b, canal_tipo: "lista_oficial_previa" }).ok).toBe(false);
  });
  it("le o codigo da recusa na mensagem do banco", () => {
    expect(codigoDaRecusaNoTexto("ERROR: REGULARIZACAO_RECUSADA:referencia_sem_substancia. A referencia...")).toBe("referencia_sem_substancia");
    expect(codigoDaRecusaNoTexto("DESTINATARIO_RECUSADO:sem_regularizacao (x)")).toBe("sem_regularizacao");
    expect(codigoDaRecusaNoTexto("outra coisa")).toBeNull();
  });
});
