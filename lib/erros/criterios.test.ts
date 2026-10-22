// OS 7 CRITÉRIOS DE ACEITE DO RESPONSÁVEL TÉCNICO -- nível unitário.
//
// Aqui o servidor e a tela são COMPOSTOS em processo: a resposta REAL que o
// código do servidor monta (erroHttp/prepararProcessamento/diagnóstico) é entregue
// ao `solicitarProcessamento` da tela, que é quem decide o texto do host. Não há
// mensagem escrita à mão dos dois lados.
//
// Cada critério tem a NEGATIVA e, ao lado, o CONTROLE POSITIVO que prova que o
// fluxo legítimo continua funcionando no mesmo ambiente de teste. Negativa sem
// positivo pode estar medindo "tudo quebrado" em vez de "cada caso tratado".
//
// A prova com HTTP, banco e serviço de login reais (as duas rotas de verdade,
// funções da fila renomeadas no banco, GoTrue derrubado) está em
// lib/erros/provas/erros-http.test.ts.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  solicitarProcessamento,
  MENSAGEM_FILA_INDISPONIVEL,
  type ResultadoSolicitacao,
} from "../../components/features/admin/processar-evento";
import { criarClienteFalso } from "../testing/cliente-falso";
import {
  CODIGOS_DE_ERRO,
  DEFINICOES_DE_ERRO,
  ehCodigoDeErro,
  type CodigoDeErro,
} from "./codigos";
import { erroHttp } from "./resposta";
import { codigoDeFalhaDeFila, observarRpc } from "./falha-de-fila";
import { MENSAGEM_GENERICA, mensagemParaHost } from "./mensagens-host";
import { prepararProcessamento } from "./preparar-processamento";

const getUser = vi.fn();
vi.mock("../supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: (...a: unknown[]) => getUser(...a) } })),
}));
// A classificação de login é a REAL (lib/auth/require-admin.ts): só o cliente do
// Supabase é simulado, para o serviço de login "responder" o que cada caso pede.
import { classificarFalhaDeAuth, verificarAdmin } from "../auth/require-admin";
import { respostaDeRecusa } from "./resposta";

/** O que a rota faz: verificarAdmin() e, se não autorizou, respostaDeRecusa(). */
async function respostaDeRecusaDeAdmin() {
  return respostaDeRecusa(await verificarAdmin());
}
async function diagnosticarRecusaDeAdmin() {
  const r = await verificarAdmin();
  if (r.autorizado) throw new Error("esperava recusa");
  return r;
}
const classificarErroDeAuth = (e: Parameters<typeof classificarFalhaDeAuth>[0]) => {
  const r = classificarFalhaDeAuth(e);
  if (r.autorizado) throw new Error("esperava recusa");
  return r;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  getUser.mockReset();
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- aparelhagem
const UUID = "11111111-1111-4111-8111-111111111111";
const corpoDe = (event_id: unknown = UUID) => ({ json: async () => ({ event_id }) });

function etapas(versao: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: versao * 100 + i, quiz_version: versao, stage_number: i + 1 }));
}
function ambiente(opcoes: {
  current_stage?: number;
  quiz_version?: number;
  etapas?: Record<string, unknown>[];
  evento?: boolean;
  participantes?: { id: string; completed_at: string | null }[];
  participantesComErro?: boolean;
  leituraDeEtapasQuebrada?: boolean;
}) {
  const quiz_version = opcoes.quiz_version ?? 2;
  const evento = opcoes.evento === false ? [] : [{ id: UUID, quiz_version, current_stage: opcoes.current_stage ?? 5, status: "live", mode: "live", form_opens_at: null, form_closes_at: null }];
  const base = criarClienteFalso({ events: evento, quiz_stages: opcoes.etapas ?? [...etapas(1, 6), ...etapas(2, 5)] });
  const participantes = opcoes.participantes ?? [{ id: "p1", completed_at: "2026-01-01" }];
  return {
    from(tabela: string) {
      if (tabela === "participants") {
        return {
          select: () => ({
            eq: () => ({
              not: async () =>
                opcoes.participantesComErro
                  ? { data: null, error: { code: "57P03", message: 'relation "participants" internal' } }
                  : { data: participantes, error: null },
            }),
          }),
        };
      }
      if (tabela === "quiz_stages" && opcoes.leituraDeEtapasQuebrada) {
        return {
          select: () => {
            const q: any = {
              eq: () => q,
              then: (ok: any) => Promise.resolve({ data: null, error: { code: "57P01", message: "terminating connection" } }).then(ok),
            };
            return q;
          },
        };
      }
      return base.from(tabela);
    },
  } as never;
}

/** Roda a parte comum das duas rotas e entrega a resposta REAL à tela. */
async function servidorParaTela(opcoes: Parameters<typeof ambiente>[0]) {
  const preparo = await prepararProcessamento(corpoDe(), ambiente(opcoes));
  if (preparo.ok) return { preparo, resultado: null as ResultadoSolicitacao | null };
  const resultado = await solicitarProcessamento("e", async () => preparo.resposta.clone(), () => {});
  return { preparo, resultado, resposta: preparo.resposta };
}

async function daTela(resposta: Response): Promise<ResultadoSolicitacao> {
  return solicitarProcessamento("e", async () => resposta.clone(), () => {});
}
// Sem o número da ocorrência: é aleatório e pode conter "018" por acaso; não é texto de causa.
const texto = (r: ResultadoSolicitacao) => ("mensagem" in r ? r.mensagem : "").replace(/Ocorrência: [A-Za-z0-9_-]+\.?/g, "");
const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

// ================================================================= CRITÉRIO 1
describe("critério 1 -- as duas rotas retornam códigos equivalentes para as mesmas condições", () => {
  const fonte = (c: string) => readFileSync(new URL(`../../${c}`, import.meta.url), "utf8");
  const rotas = ["app/api/jobs/enfileirar/route.ts", "app/api/batch-process/route.ts", "app/api/jobs/status/route.ts"];

  it.each(rotas)("%s usa a MESMA verificação e a MESMA resposta de recusa de admin (por construção, não por cópia)", (rota) => {
    const f = fonte(rota);
    if (!rota.includes("status")) expect(f).toContain("prepararProcessamento(");
    // Uma única classificação de login: verificarAdmin(), nunca getAdminUser()
    // (que descarta o motivo da recusa).
    expect(f).toContain("await verificarAdmin()");
    expect(f).toContain("if (!admin.autorizado) {");
    expect(f).toContain("respostaDeRecusa(admin)");
    expect(f).not.toContain("getAdminUser");
    // Nenhuma resposta de erro montada à mão com status solto.
    expect(f).not.toMatch(/NextResponse\.json\(\s*\{\s*error/);
    expect(f).not.toMatch(/status:\s*(400|401|403|404|500|503)\b/);
  });

  it("o preparo comum devolve status e código IGUAIS para a mesma condição, e eles saem da tabela única", async () => {
    // A mesma função serve às duas rotas; aqui confere-se que cada condição cai
    // no par (status, código) da tabela e em nenhum outro.
    const casos: [string, Parameters<typeof ambiente>[0], CodigoDeErro][] = [
      ["evento inexistente", { evento: false }, "EVENT_NOT_FOUND"],
      ["evento incompleto", { current_stage: 4 }, "EVENT_INCOMPLETE"],
      ["etapas ilegíveis", { leituraDeEtapasQuebrada: true }, "QUIZ_STAGES_UNAVAILABLE"],
      ["etapas inválidas", { quiz_version: 9, etapas: [{ quiz_version: 9, stage_number: 1 }, { quiz_version: 9, stage_number: 3 }] }, "QUIZ_STAGES_INVALID"],
      ["ninguém concluiu", { participantes: [] }, "NO_COMPLETED_PARTICIPANTS"],
      ["participantes ilegíveis", { participantesComErro: true }, "PARTICIPANTS_UNAVAILABLE"],
    ];
    for (const [, opc, codigo] of casos) {
      const a = await servidorParaTela(opc);
      const b = await servidorParaTela(opc);
      expect(a.preparo.ok).toBe(false);
      if (!a.preparo.ok && !b.preparo.ok) {
        for (const r of [a.preparo.resposta, b.preparo.resposta]) {
          expect(r.status).toBe(DEFINICOES_DE_ERRO[codigo].status);
          expect((await r.clone().json()).code).toBe(codigo);
        }
      }
    }
  });

  it("controle positivo: o mesmo preparo, com tudo em ordem, libera", async () => {
    const r = await prepararProcessamento(corpoDe(), ambiente({ current_stage: 5 }));
    expect(r).toMatchObject({ ok: true, eventId: UUID, totalEtapas: 5 });
  });
});

// ================================================================= CRITÉRIO 2
describe("critério 2 -- evento incompleto mostra etapa pendente, não migration", () => {
  it("NEGATIVA: evento na etapa 3 de 5 -> 400 EVENT_INCOMPLETE -> 'etapa pendente'", async () => {
    const { resultado, resposta } = await servidorParaTela({ current_stage: 3 });
    expect(resposta!.status).toBe(400);
    expect(resultado).toMatchObject({ tipo: "recusado", codigo: "EVENT_INCOMPLETE" });
    expect(texto(resultado!)).toMatch(/etapa pendente/);
    expect(texto(resultado!)).toContain("etapa 3 de 5");
    expect(texto(resultado!)).not.toMatch(/migration|018|fila/i);
  });
  it("CONTROLE POSITIVO: o MESMO evento, na etapa 5 de 5, passa pelo portão", async () => {
    const { preparo } = await servidorParaTela({ current_stage: 5 });
    expect(preparo.ok).toBe(true);
  });
});

// ================================================================= CRITÉRIO 3
describe("critério 3 -- indisponibilidade na leitura das etapas mostra erro de verificação", () => {
  it("NEGATIVA: leitura de quiz_stages falha -> 503 QUIZ_STAGES_UNAVAILABLE -> 'verificar as etapas'", async () => {
    const { resultado, resposta } = await servidorParaTela({ leituraDeEtapasQuebrada: true });
    expect(resposta!.status).toBe(503);
    expect(resultado).toMatchObject({ tipo: "bloqueado", codigo: "QUIZ_STAGES_UNAVAILABLE" });
    expect(texto(resultado!)).toMatch(/verificar as etapas/);
    expect(texto(resultado!)).not.toMatch(/migration|018|pendente/i);
    // Texto interno do banco nunca chega ao corpo nem à tela.
    const corpo = JSON.stringify(await resposta!.clone().json());
    expect(corpo).not.toMatch(/terminating connection|57P01/);
    expect(texto(resultado!)).not.toMatch(/terminating connection|57P01/);
  });
  it("NEGATIVA PAREADA: leu e a numeração é inválida -> OUTRO código, OUTRA investigação", async () => {
    const inval = await servidorParaTela({ quiz_version: 9, etapas: [{ quiz_version: 9, stage_number: 1 }, { quiz_version: 9, stage_number: 3 }] });
    const indis = await servidorParaTela({ leituraDeEtapasQuebrada: true });
    expect(inval.resultado).toMatchObject({ tipo: "bloqueado", codigo: "QUIZ_STAGES_INVALID" });
    expect(inval.resposta!.status).toBe(indis.resposta!.status); // ambos 503
    expect(texto(inval.resultado!)).not.toBe(texto(indis.resultado!));
    expect(texto(inval.resultado!)).toMatch(/configuração/);
  });
  it("CONTROLE POSITIVO: sem falha de leitura, as mesmas etapas liberam", async () => {
    expect((await servidorParaTela({})).preparo.ok).toBe(true);
  });
});

// ================================================================= CRITÉRIO 4
describe("critério 4 -- ausência real das funções da fila produz QUEUE_SCHEMA_MISSING", () => {
  function rpcQueFalha(erro: { code?: string; message: string } | null) {
    return { rpc: async (_nome: string, _args: Record<string, unknown>) => ({ data: erro ? null : [{ id: "j", status: "pending", criado: true }], error: erro }) };
  }
  async function observa(erro: { code?: string; message: string } | null) {
    const o = observarRpc(rpcQueFalha(erro));
    await o.cliente.rpc("jobs_enfileirar", {});
    return codigoDeFalhaDeFila(o.ultimoErro());
  }

  it.each([
    ["PostgREST: função não está no schema cache", { code: "PGRST202", message: "Could not find the function public.jobs_enfileirar(p_kind) in the schema cache" }],
    ["Postgres: undefined_function", { code: "42883", message: "function public.jobs_enfileirar does not exist" }],
    ["Postgres: undefined_table", { code: "42P01", message: 'relation "jobs" does not exist' }],
    ["sem código, só a mensagem do PostgREST", { message: "Could not find the function public.jobs_enfileirar in the schema cache" }],
  ])("NEGATIVA (%s) -> QUEUE_SCHEMA_MISSING -> a tela mostra a migration 018", async (_n, erro) => {
    expect(await observa(erro)).toBe("QUEUE_SCHEMA_MISSING");
    const r = await daTela(erroHttp("QUEUE_SCHEMA_MISSING", { causa: erro.message }));
    expect(r).toMatchObject({ tipo: "fila_indisponivel", codigo: "QUEUE_SCHEMA_MISSING", mensagem: MENSAGEM_FILA_INDISPONIVEL });
    expect(texto(r)).toContain("migration 018");
  });

  it.each([
    ["statement timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["rede caída", { code: "", message: "TypeError: fetch failed" }],
    ["JWT recusado", { code: "PGRST301", message: "JWT expired" }],
    ["violação de unicidade", { code: "23505", message: "duplicate key value violates unique constraint" }],
  ])("NEGATIVA PAREADA (a fila existe mas falhou: %s) -> QUEUE_UNAVAILABLE -> NÃO manda aplicar migration", async (_n, erro) => {
    expect(await observa(erro)).toBe("QUEUE_UNAVAILABLE");
    const r = await daTela(erroHttp("QUEUE_UNAVAILABLE", { causa: erro.message }));
    expect(r.tipo).toBe("bloqueado");
    expect(texto(r)).not.toMatch(/migration|018/i);
    expect(texto(r)).not.toContain(erro.message);
  });

  it("CONTROLE POSITIVO: a mesma chamada, sem erro, não é classificada como falha de fila", async () => {
    const o = observarRpc(rpcQueFalha(null));
    const r = await o.cliente.rpc("jobs_enfileirar", {});
    expect(r.error).toBeNull();
    expect(o.ultimoErro()).toBeNull();
  });
});

// ================================================================= CRITÉRIO 5
describe("critério 5 -- falha de autenticação não aparece como falta de permissão", () => {
  const admin = { id: "u", app_metadata: { role: "admin" } };
  const participante = { id: "u", app_metadata: {} };

  it("NEGATIVA: serviço de login fora do ar (AuthRetryableFetchError) -> 503 AUTH_UNAVAILABLE, NUNCA 403", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } });
    const resposta = await respostaDeRecusaDeAdmin();
    expect(resposta.status).toBe(503);
    expect((await resposta.clone().json()).code).toBe("AUTH_UNAVAILABLE");
    const r = await daTela(resposta);
    expect(r).toMatchObject({ tipo: "bloqueado", codigo: "AUTH_UNAVAILABLE" });
    expect(texto(r)).not.toMatch(/não tem permissão/);
    expect(texto(r)).toMatch(/não respondeu/);
  });
  it.each([
    ["500 do serviço de login", { name: "AuthApiError", status: 500, message: "boom" }],
    ["erro sem forma conhecida", { message: "???" }],
    ["503", { name: "AuthApiError", status: 503, message: "unavailable" }],
  ])("NEGATIVA (%s) também é AUTH_UNAVAILABLE", (_n, erro) => {
    expect(classificarErroDeAuth(erro).codigo).toBe("AUTH_UNAVAILABLE");
  });
  it("NEGATIVA: getUser lança -> AUTH_UNAVAILABLE", async () => {
    getUser.mockRejectedValue(new Error("socket hang up"));
    expect((await diagnosticarRecusaDeAdmin()).codigo).toBe("AUTH_UNAVAILABLE");
  });
  it("CONTROLE POSITIVO 0: admin de verdade é autorizado (a classificação não bloqueia tudo)", async () => {
    getUser.mockResolvedValue({ data: { user: admin }, error: null });
    expect((await verificarAdmin()).autorizado).toBe(true);
  });
  it("CONTROLE POSITIVO 1: sem sessão -> 401 AUTH_REQUIRED (recusa de verdade continua recusa)", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" } });
    const resposta = await respostaDeRecusaDeAdmin();
    expect(resposta.status).toBe(401);
    const r = await daTela(resposta);
    expect(r).toMatchObject({ tipo: "recusado", codigo: "AUTH_REQUIRED" });
    expect(texto(r)).toMatch(/sessão expirou/);
  });
  it("CONTROLE POSITIVO 2: token recusado pelo serviço (401) -> AUTH_REQUIRED", () => {
    expect(classificarErroDeAuth({ name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" }).codigo).toBe("AUTH_REQUIRED");
  });
  it("CONTROLE POSITIVO 3: sessão de quem não é admin -> 403 ADMIN_FORBIDDEN (a única 'falta de permissão')", async () => {
    getUser.mockResolvedValue({ data: { user: participante }, error: null });
    const resposta = await respostaDeRecusaDeAdmin();
    expect(resposta.status).toBe(403);
    const r = await daTela(resposta);
    expect(r).toMatchObject({ tipo: "recusado", codigo: "ADMIN_FORBIDDEN" });
    expect(texto(r)).toMatch(/não tem permissão de administrador/);
  });
});

// ================================================================= CRITÉRIO 6
describe("critério 6 -- resposta genérica 'Erro' não substitui mensagem específica nem aparece sem tratamento", () => {
  it("NEGATIVA: { error: 'Erro' } sem código -> mensagem genérica segura + ocorrência registrada; 'Erro' não é exibido", async () => {
    const registros: { ocorrencia: string; status: number }[] = [];
    const r = await solicitarProcessamento("e", async () => json(500, { error: "Erro" }), (x) => registros.push(x));
    expect(r.tipo).toBe("erro_inesperado");
    expect(texto(r)).not.toBe("Erro");
    expect(texto(r)).toContain(MENSAGEM_GENERICA);
    expect(texto(r)).not.toMatch(/migration|018/i);
    expect(registros).toHaveLength(1);
    expect(r.tipo === "erro_inesperado" && r.mensagem).toContain(registros[0].ocorrencia);
  });
  it("NEGATIVA: a ocorrência do servidor é a registrada e a mostrada", async () => {
    const registros: { ocorrencia: string }[] = [];
    const r = await solicitarProcessamento("e", async () => json(500, { error: "Erro", ocorrencia: "oc-abc12345" }), (x) => registros.push(x));
    expect(registros[0].ocorrencia).toBe("oc-abc12345");
    expect(r.tipo === "erro_inesperado" && r.mensagem).toContain("oc-abc12345");
  });
  it.each([
    ["código fora do vocabulário", { error: "Erro", code: "ALGO_NOVO_DO_SERVIDOR" }],
    ["código de tipo errado", { error: "Erro", code: 503 }],
    ["código vazio", { error: "Erro", code: "" }],
    ["corpo que nem é objeto", "Erro"],
    ["texto interno de banco no error, sem código", { error: 'relation "jobs" does not exist' }],
  ])("NEGATIVA (%s) -> genérica; o texto do servidor não aparece", async (_n, corpo) => {
    const r = await solicitarProcessamento("e", async () => json(503, corpo), () => {});
    expect(r.tipo).toBe("erro_inesperado");
    expect(texto(r)).not.toContain("jobs");
    expect(texto(r)).not.toMatch(/ALGO_NOVO|migration/i);
  });
  it("'Erro' NÃO sobrescreve mensagem específica: com código conhecido a mensagem é a do código", async () => {
    const r = await solicitarProcessamento("e", async () => json(503, { error: "Erro", code: "QUIZ_STAGES_UNAVAILABLE" }), () => {});
    expect(r).toMatchObject({ tipo: "bloqueado", codigo: "QUIZ_STAGES_UNAVAILABLE" });
    expect(texto(r)).toMatch(/verificar as etapas/);
    expect(texto(r)).not.toBe("Erro");
    const e = await solicitarProcessamento("e", async () => json(400, { error: "Erro", code: "EVENT_INCOMPLETE" }), () => {});
    expect(texto(e)).toMatch(/etapa pendente/);
  });
  it("CONTROLE POSITIVO: resposta específica bem formada não cai no genérico e não registra ocorrência inesperada", async () => {
    const registros: unknown[] = [];
    const r = await solicitarProcessamento("e", async () => daFilaOk(), (x) => registros.push(x));
    expect(r.tipo).toBe("enfileirado");
    expect(registros).toHaveLength(0);
  });
});
function daFilaOk() {
  return json(200, { ok: true, total_participantes: 2, criados: 2, reaproveitados: 0, com_erro: [] });
}

// ================================================================= CRITÉRIO 7
describe("critério 7 -- cada erro tem controle positivo ao lado", () => {
  it("o vocabulário é fechado: cada código tem status, texto do servidor e mensagem do host, e a tela o reconhece", () => {
    expect(CODIGOS_DE_ERRO.length).toBeGreaterThanOrEqual(22);
    for (const c of CODIGOS_DE_ERRO) {
      expect(ehCodigoDeErro(c)).toBe(true);
      expect([400, 401, 403, 404, 500, 503]).toContain(DEFINICOES_DE_ERRO[c].status);
      expect(DEFINICOES_DE_ERRO[c].error.length).toBeGreaterThan(3);
      expect(mensagemParaHost(c, { etapa_atual: 1, total_etapas: 5 }).length).toBeGreaterThan(20);
    }
    expect(ehCodigoDeErro("toString")).toBe(false);
    expect(ehCodigoDeErro("__proto__")).toBe(false);
  });

  it("cada migration é citada SÓ pela mensagem do seu próprio código", () => {
    const quem = (re: RegExp) => CODIGOS_DE_ERRO.filter((c) => re.test(mensagemParaHost(c)));
    // O número da migration 018 (fila) só em QUEUE_SCHEMA_MISSING; o da 021 (medição)
    // só em BUDGET_MEASUREMENT_MISSING; o da 022 (importação externa) só em
    // IMPORT_SCHEMA_MISSING. Mandar instalar a coisa errada é investigar a coisa errada.
    expect(quem(/\b018\b/)).toEqual(["QUEUE_SCHEMA_MISSING"]);
    expect(quem(/\b021\b/)).toEqual(["BUDGET_MEASUREMENT_MISSING"]);
    expect(quem(/\b022\b/)).toEqual(["IMPORT_SCHEMA_MISSING"]);
    // A palavra "migration" em geral: só nas que têm número.
    expect(quem(/migration/i).sort()).toEqual([
      "BUDGET_MEASUREMENT_MISSING",
      "IMPORT_SCHEMA_MISSING",
      "QUEUE_SCHEMA_MISSING",
    ]);
  });

  it("só as mensagens de AUSÊNCIA mandam APLICAR; as de indisponibilidade mandam aguardar (mandar aplicar o que não falta é investigar a coisa errada)", () => {
    const mandaAplicar = CODIGOS_DE_ERRO.filter((c) => /\baplicar\b|\baplicada\b/i.test(mensagemParaHost(c))).sort();
    expect(mandaAplicar).toEqual([
      "ASYNC_PROCESSING_MISSING",
      "BUDGET_MEASUREMENT_MISSING",
      "IMPORT_SCHEMA_MISSING",
      "QUEUE_SCHEMA_MISSING",
    ]);
    for (const c of ["BUDGET_MEASUREMENT_UNAVAILABLE", "QUEUE_UNAVAILABLE", "TIME_REFERENCE_UNAVAILABLE", "SNAPSHOT_UNSTABLE", "AUTH_UNAVAILABLE", "IMPORT_UNAVAILABLE", "IMPORT_MANIFEST_UNVERIFIABLE"] as const) {
      expect(mensagemParaHost(c), c).toMatch(/aguarde|tent(e|ar) de novo/i);
    }
  });

  it("os três fatos da importação externa não compartilham texto: instalar, aguardar e corrigir são mensagens diferentes", () => {
    const ausente = mensagemParaHost("IMPORT_SCHEMA_MISSING");
    const indisponivel = mensagemParaHost("IMPORT_UNAVAILABLE");
    const naoConferido = mensagemParaHost("IMPORT_MANIFEST_UNVERIFIABLE");
    const recusado = mensagemParaHost("IMPORT_MANIFEST_MISMATCH");

    // "não está instalado" é a ÚNICA que manda instalar.
    expect(ausente).toMatch(/migration 022/);
    for (const m of [indisponivel, naoConferido, recusado]) {
      expect(m).not.toMatch(/migration|aplicar a atualização/i);
    }
    // "não respondeu" e "não deu para conferir" mandam esperar e NÃO acusam a planilha.
    expect(indisponivel).toMatch(/aguarde/i);
    expect(indisponivel).toMatch(/não quer dizer que a planilha/i);
    expect(naoConferido).toMatch(/NÃO quer dizer que o questionário está errado/);
    // "conferi e recusei" é a única que afirma que o questionário divergiu.
    expect(recusado).toMatch(/NÃO é o que o sistema conhece/);
    expect(recusado).not.toMatch(/aguarde/i);
    // Nenhuma das quatro é igual a outra.
    expect(new Set([ausente, indisponivel, naoConferido, recusado]).size).toBe(4);
  });

  it("nenhum texto interno de banco chega à tela, qualquer que seja o código", async () => {
    for (const c of CODIGOS_DE_ERRO) {
      const r = await solicitarProcessamento(
        "e",
        async () => json(DEFINICOES_DE_ERRO[c].status, { error: 'PGRST202 relation "jobs" does not exist (SQLSTATE 42P01)', code: c }),
        () => {}
      );
      expect(texto(r)).not.toMatch(/PGRST|SQLSTATE|relation|42P01/);
    }
  });

  it("cada código chega à classe certa da tela (recusa x bloqueio x fila ausente x inesperado)", async () => {
    const esperado: Record<CodigoDeErro, ResultadoSolicitacao["tipo"]> = {
      INVALID_REQUEST: "recusado",
      AUTH_REQUIRED: "recusado",
      ADMIN_FORBIDDEN: "recusado",
      EVENT_NOT_FOUND: "recusado",
      EVENT_INCOMPLETE: "recusado",
      COLLECTION_OPEN: "recusado",
      EVENT_MODE_UNDETERMINED: "bloqueado",
      COLLECTION_WINDOW_UNDETERMINED: "bloqueado",
      TIME_REFERENCE_UNAVAILABLE: "bloqueado",
      ASYNC_PROCESSING_MISSING: "bloqueado",
      SNAPSHOT_UNSTABLE: "bloqueado",
      BUDGET_MEASUREMENT_MISSING: "bloqueado",
      BUDGET_MEASUREMENT_UNAVAILABLE: "bloqueado",
      NO_COMPLETED_PARTICIPANTS: "recusado",
      AUTH_UNAVAILABLE: "bloqueado",
      PARTICIPANTS_UNAVAILABLE: "bloqueado",
      QUIZ_STAGES_UNAVAILABLE: "bloqueado",
      QUIZ_STAGES_INVALID: "bloqueado",
      QUEUE_UNAVAILABLE: "bloqueado",
      QUEUE_CONFIG_INVALID: "bloqueado",
      QUEUE_SCHEMA_MISSING: "fila_indisponivel",
      IMPORT_SCHEMA_MISSING: "bloqueado",
      IMPORT_UNAVAILABLE: "bloqueado",
      IMPORT_WRITE_UNVERIFIABLE: "bloqueado",
      IMPORT_MANIFEST_MISMATCH: "recusado",
      IMPORT_MANIFEST_UNVERIFIABLE: "bloqueado",
      IMPORT_SPREADSHEET_INVALID: "recusado",
      IMPORT_PLAN_REFUSED: "recusado",
      IMPORT_PREVIEW_STALE: "recusado",
      IMPORT_SUBMISSION_NOT_FOUND: "recusado",
      IMPORT_DECISION_REFUSED: "recusado",
      IMPORT_DECISION_STALE: "recusado",
      IMPORT_TARGET_OCCUPIED: "recusado",
      IMPORT_ACT_NOT_APPLIED: "bloqueado",
      IMPORT_REVALIDATION_REFUSED: "recusado",
      IMPORT_REVOKE_BLOCKED: "recusado",
      IMPORT_DERIVATIVES_UNVERIFIABLE: "bloqueado",
      // Guia de Preparação do Facilitador: duas recusas conferidas e três
      // indisponibilidades. "Não deu para saber se há DNA disponibilizado"
      // bloqueia, e não é recusa.
      GUIDE_DNA_PUBLISHED: "recusado",
      GUIDE_DATA_INCONSISTENT: "recusado",
      GUIDE_DNA_STATE_UNVERIFIABLE: "bloqueado",
      COVERAGE_UNAVAILABLE: "bloqueado",
      INVITE_COUNT_UNDETERMINED: "bloqueado",
      INTERNAL_ERROR: "erro_inesperado",
    };
    for (const c of CODIGOS_DE_ERRO) {
      const r = await daTela(erroHttp(c));
      expect(r.tipo, c).toBe(esperado[c]);
    }
  });

  it("CONTROLE POSITIVO de TODOS os erros do servidor: o caminho legítimo do mesmo ambiente passa", async () => {
    // Um único ambiente sem falha nenhuma: pedido válido, evento existente e
    // completo, etapas legíveis e válidas, participantes legíveis e não vazios.
    const ok = await prepararProcessamento(corpoDe(), ambiente({ current_stage: 5 }));
    expect(ok.ok).toBe(true);
    // ...e a tela entende o sucesso do servidor.
    expect((await daTela(daFilaOk())).tipo).toBe("enfileirado");
  });
});
