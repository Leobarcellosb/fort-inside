import { describe, expect, it } from "vitest";
import {
  contarPorGrupo,
  montarSituacao,
  resumoDaTurma,
  textoConfirmacao,
  type LinhaDocumento,
  type LinhaJob,
  type PessoaBase,
  type ResultadoLote,
} from "./situacao-prognostico";

const pessoa = (id: string, nome: string, quizConcluido = true): PessoaBase => ({ id, nome, quizConcluido });
const doc = (participant_id: string, status: string): LinhaDocumento => ({
  participant_id,
  status,
  generated_at: "2026-10-21T10:00:00Z",
});
const job = (participant_id: string, o: Partial<LinhaJob> = {}): LinhaJob => ({
  id: `job-${participant_id}`,
  participant_id,
  status: "succeeded",
  attempts: 1,
  max_attempts: 3,
  last_error: null,
  last_error_code: null,
  result: null,
  finished_at: "2026-10-21T10:05:00Z",
  updated_at: "2026-10-21T10:05:00Z",
  ...o,
});

describe("montarSituacao: estado do documento e resultado do processamento são coisas diferentes", () => {
  it("documento ENTREGUE pulado numa rodada posterior: estado entregue, resultado pulado, nenhum dos dois é erro", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "delivered")],
      jobs: [
        job("a", {
          status: "skipped",
          attempts: 2,
          result: { motivo: 'Prognóstico já está em "delivered"; não pode ser regerado.' },
        }),
      ],
    });
    expect(s.documento).toBe("delivered");
    expect(s.documentoRotulo).toBe("Entregue");
    expect(s.processamento.resultado).toBe("pulado");
    expect(s.processamento.erro).toBeNull();
    expect(s.processamento.motivo).toContain("entregue");
    expect(s.grupo).toBe("pulados");
    // Pulado não oferece "tentar de novo": não mudaria nada.
    expect(s.retentativa).toBeNull();
  });

  it("falhou sem documento: grupo de atenção, com retentativa pela fila e erro em português", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("b", "Bruno")],
      documentos: [],
      jobs: [
        job("b", {
          status: "failed",
          attempts: 3,
          last_error: "A IA recusou a geração para este participante",
          last_error_code: "http_502",
        }),
      ],
    });
    expect(s.documento).toBeNull();
    expect(s.processamento.resultado).toBe("falhou");
    expect(s.processamento.erro).toBe("A inteligência artificial recusou ou não respondeu.");
    expect(s.processamento.tentativas).toBe(3);
    expect(s.processamento.tentativasMax).toBe(3);
    expect(s.grupo).toBe("atencao");
    expect(s.retentativa).toEqual({ tipo: "fila", jobId: "job-b" });
  });

  it("pulado com documento em revisão: grupo preservado, sem retentativa", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("c", "Carla")],
      documentos: [doc("c", "in_review")],
      jobs: [job("c", { status: "skipped", result: { motivo: 'Prognóstico já está em "in_review"; não pode ser regerado.' } })],
    });
    expect(s.grupo).toBe("pulados");
    expect(s.processamento.motivo).toContain("em revisão");
    expect(s.retentativa).toBeNull();
  });

  it("pendente (na fila, sem documento): em andamento, sem alarme", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("d", "Diego")],
      documentos: [],
      jobs: [job("d", { status: "pending", attempts: 0, finished_at: null })],
    });
    expect(s.grupo).toBe("andamento");
    expect(s.processamento.resultado).toBe("na_fila");
    expect(s.processamento.erro).toBeNull();
    expect(s.retentativa).toBeNull();
  });

  it("pendente COM erro gravado é nova tentativa automática, não falha final", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("d", "Diego")],
      documentos: [],
      jobs: [job("d", { status: "pending", attempts: 1, last_error: "x", last_error_code: "http_502" })],
    });
    expect(s.grupo).toBe("andamento");
    expect(s.processamento.resultado).toBe("nova_tentativa");
    expect(s.retentativa).toBeNull();
  });
});

describe("montarSituacao: uma pessoa é uma pessoa", () => {
  it("duas tentativas registradas no mesmo job aparecem UMA vez, com 2 tentativas", () => {
    const r = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "generated")],
      jobs: [job("a", { attempts: 2 })],
    });
    expect(r).toHaveLength(1);
    expect(r[0].processamento.tentativas).toBe(2);
  });

  it("dois registros de job da mesma pessoa continuam sendo UMA pessoa; o mais recente decide o resultado e as tentativas somam", () => {
    const r = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "delivered")],
      jobs: [
        job("a", { id: "antigo", status: "succeeded", attempts: 1, updated_at: "2026-10-21T10:00:00Z" }),
        job("a", { id: "novo", status: "skipped", attempts: 1, updated_at: "2026-10-21T11:00:00Z", result: { motivo: 'em "delivered"' } }),
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0].processamento.resultado).toBe("pulado");
    expect(r[0].processamento.tentativas).toBe(2);
    expect(r[0].documento).toBe("delivered");
    expect(contarPorGrupo(r).pulados).toBe(1);
  });

  it("a soma dos grupos é sempre o número de pessoas", () => {
    const pessoas = [pessoa("a", "A"), pessoa("b", "B"), pessoa("c", "C"), pessoa("d", "D"), pessoa("e", "E", false)];
    const r = montarSituacao({
      pessoas,
      documentos: [doc("a", "delivered"), doc("c", "in_review")],
      jobs: [
        job("a", { status: "skipped", attempts: 2 }),
        job("b", { status: "failed", attempts: 3, last_error_code: "http_500" }),
        job("c", { status: "skipped" }),
        job("d", { status: "pending", attempts: 0 }),
      ],
    });
    const c = contarPorGrupo(r);
    expect(Object.values(c).reduce((x, y) => x + y, 0)).toBe(pessoas.length);
    expect(c).toMatchObject({ atencao: 1, andamento: 1, pulados: 2, quiz_aberto: 1 });
    expect(resumoDaTurma(r)).toBe("2 de 4 com prognóstico · 1 em andamento · 1 precisa de atenção");
  });
});

describe("retentativa só onde é legítima", () => {
  it("falha da última tentativa com documento já entregue: não é problema e não oferece refazer", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "delivered")],
      jobs: [job("a", { status: "failed", attempts: 3, last_error_code: "http_502" })],
    });
    expect(s.grupo).toBe("prontos");
    expect(s.aviso).toContain("já existia");
    expect(s.retentativa).toBeNull();
    expect(s.semRetentativa).toContain("entregue");
  });

  it("falha com documento só gerado (sem trabalho humano): fica em prontos com aviso e pode tentar de novo", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "generated")],
      jobs: [job("a", { status: "failed", attempts: 3, last_error_code: "http_502" })],
    });
    expect(s.grupo).toBe("prontos");
    expect(s.retentativa).toEqual({ tipo: "fila", jobId: "job-a" });
  });

  it("cancelado sem documento pode voltar para a fila", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [],
      jobs: [job("a", { status: "canceled" })],
    });
    expect(s.grupo).toBe("atencao");
    expect(s.retentativa).toEqual({ tipo: "fila", jobId: "job-a" });
  });

  it("gerado e em andamento não oferecem retentativa", () => {
    const r = montarSituacao({
      pessoas: [pessoa("a", "A"), pessoa("b", "B")],
      documentos: [doc("a", "generated")],
      jobs: [job("a"), job("b", { status: "running" })],
    });
    expect(r.map((s) => s.retentativa)).toEqual([null, null]);
  });

  it("a confirmação de retentativa nunca promete mexer em quem está protegido", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("b", "Bruno")],
      documentos: [],
      jobs: [job("b", { status: "failed", attempts: 3, last_error_code: "http_502" })],
    });
    const t = textoConfirmacao(s);
    expect(t?.corpo).toContain("Já houve 3 tentativas");
    expect(t?.corpo).toContain("não é afetado");
  });
});

describe("lote desta sessão (sem registro por pessoa na fila)", () => {
  const lote = (resultado: ResultadoLote["resultado"], estadoAntes: string | null = null) =>
    new Map<string, ResultadoLote>([["a", { resultado, estadoAntes, em: "2026-10-21T12:00:00Z" }]]);

  it("falha do lote sem documento: grupo de atenção, retentativa direta, tentativas desconhecidas", () => {
    const [s] = montarSituacao({ pessoas: [pessoa("a", "Ana")], documentos: [], jobs: [], lote: lote("falhou") });
    expect(s.grupo).toBe("atencao");
    expect(s.processamento.fonte).toBe("lote");
    expect(s.processamento.tentativas).toBeNull();
    expect(s.retentativa).toEqual({ tipo: "direta" });
  });

  it("pulo do lote vira preservado e cita o estado que o documento tinha", () => {
    const [s] = montarSituacao({ pessoas: [pessoa("a", "Ana")], documentos: [doc("a", "reviewed")], jobs: [], lote: lote("pulado", "reviewed") });
    expect(s.grupo).toBe("pulados");
    expect(s.processamento.motivo).toContain("revisado");
  });

  it("sem registro nenhum e sem documento: aguardando; com documento antigo: pronto", () => {
    const r = montarSituacao({
      pessoas: [pessoa("a", "A"), pessoa("b", "B")],
      documentos: [doc("b", "generated")],
      jobs: [],
    });
    expect(r.map((s) => s.grupo)).toEqual(["aguardando", "prontos"]);
    expect(r[0].processamento.resultado).toBe("nunca");
  });

  it("registro de fila mais novo que o lote vence o lote", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [],
      jobs: [job("a", { status: "running", updated_at: "2026-10-21T13:00:00Z" })],
      lote: lote("falhou"),
    });
    expect(s.processamento.resultado).toBe("gerando");
  });
});

describe("rótulos honestos", () => {
  it("documento existente sem registro de rodada não é 'não processado'", () => {
    const [s] = montarSituacao({ pessoas: [pessoa("e", "Elisa")], documentos: [doc("e", "reviewed")], jobs: [] });
    expect(s.processamento.rotulo).toBe("Sem registro");
    expect(s.grupo).toBe("prontos");
  });
});

describe("erros em português", () => {
  it("traduz os códigos que a geração realmente grava, sem vazar texto técnico como explicação", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("b", "Bruno")],
      documentos: [],
      jobs: [job("b", { status: "failed", attempts: 3, last_error_code: "http_400", last_error: "Participante não completou todas as etapas" })],
    });
    expect(s.processamento.erro).toContain("incompletas");
    expect(s.processamento.detalheTecnico).toBe("Participante não completou todas as etapas");
  });
});

describe("revisão corrente: o máximo histórico não vale", () => {
  it("versão antiga ENTREGUE e versão nova EM REVISÃO: não mostra 'Entregue' nem 'Em revisão' como se soubesse; diz que há mais de uma versão", () => {
    const [s] = montarSituacao({
      pessoas: [pessoa("a", "Ana")],
      documentos: [doc("a", "delivered"), doc("a", "in_review")],
      jobs: [],
    });
    expect(s.documento).toBeNull();
    expect(s.documentoRotulo).toBe("Mais de uma versão");
    expect(s.documentoRotulo).not.toBe("Entregue");
    expect(s.versoesDoDocumento).toBe(2);
    expect(s.grupo).toBe("indeterminado");
    expect(s.aviso).toContain("mais de uma versão");
    expect(s.retentativa).toBeNull();
  });

  it("a ordem das linhas não muda nada (nenhuma heurística por posição ou por maior estado)", () => {
    const a = montarSituacao({ pessoas: [pessoa("a", "Ana")], documentos: [doc("a", "delivered"), doc("a", "generated")], jobs: [] });
    const b = montarSituacao({ pessoas: [pessoa("a", "Ana")], documentos: [doc("a", "generated"), doc("a", "delivered")], jobs: [] });
    expect(a[0].grupo).toBe("indeterminado");
    expect(b[0].grupo).toBe("indeterminado");
    expect(a[0].documentoRotulo).toBe(b[0].documentoRotulo);
  });

  it("uma única linha é a corrente, qualquer que seja o estado", () => {
    const [s] = montarSituacao({ pessoas: [pessoa("a", "Ana")], documentos: [doc("a", "in_review")], jobs: [] });
    expect(s.documento).toBe("in_review");
    expect(s.versoesDoDocumento).toBe(1);
  });

  it("a pessoa indeterminada entra na soma dos grupos e no resumo", () => {
    const r = montarSituacao({
      pessoas: [pessoa("a", "Ana"), pessoa("b", "Bia")],
      documentos: [doc("a", "delivered"), doc("a", "in_review"), doc("b", "generated")],
      jobs: [],
    });
    const c = contarPorGrupo(r);
    expect(Object.values(c).reduce((x, y) => x + y, 0)).toBe(2);
    expect(resumoDaTurma(r)).toContain("1 com mais de uma versão");
  });
});
