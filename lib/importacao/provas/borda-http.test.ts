// PROVA DA BORDA: as ROTAS DE VERDADE (app/api/importacao/previa e .../aplicar),
// com a funcao do banco de verdade, contra Postgres de verdade, e com a TELA de
// verdade lendo as respostas.
//
// Como rodar:
//   PROVA_BORDA_URL="postgresql://...@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config lib/importacao/provas/vitest.prova.config.ts \
//       lib/importacao/provas/borda-http.test.ts --reporter=verbose
//
// Sem PROVA_BORDA_URL o arquivo e PULADO, para `npx vitest run` continuar verde em
// maquina sem banco. GUARDA DE ALVO: a URL tem de ser 127.0.0.1, localhost ou
// [::1]. Esta prova ESCREVE. Use um container descartavel proprio.
//
// O QUE E REAL AQUI, e o que e simulado
// -------------------------------------
// REAL: os dois handlers `POST` das rotas; `verificarAdmin()`; todo o
// `lib/importacao/*`; a funcao `importacao_externa_aplicar` e as tabelas da 022;
// as leituras de events/quiz_stages/participants/quiz_responses, que saem do banco
// por psql; e as funcoes da tela (`pedirPrevia`, `aplicarImportacao`,
// `conferirPreviaContraGravado`), que recebem as `Response` que as rotas montaram.
// SIMULADO: so o SERVICO DE LOGIN (`auth.getUser`), para cada cenario poder dizer
// quem esta batendo na porta -- que e justamente o que se quer variar.
//
// O QUE ELA PROVA, nesta ordem, cada negativa com CONTROLE POSITIVO:
//   1. o manifesto lido do banco tem a impressao PUBLICADA (o alicerce);
//   2. nao-admin e RECUSADO, e indisponibilidade de login NAO vira "sem permissao";
//   3. a previa NAO ESCREVE NADA;
//   4. importacao legitima -> resposta canonica PONTUAVEL;
//   5. uma palavra trocada -> DADO INCOMPATIVEL, na PREVIA e no banco, nunca zero;
//   6. hash diferente -> RECUSADO ANTES de pontuar (e hash ausente e OUTRO codigo);
//   7. identidade sem correspondencia -> PENDENTE na previa, nada gravado;
//   8. A PREVIA BATE COM O QUE A APLICACAO FAZ (os numeros, contados no banco);
//   9. previa vencida -> recusada, e nada gravado;
//  10. o recurso ausente no banco -> "nao esta instalado", nunca "nao respondeu".

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { calcularMarcoZero } from "../../scoring/marco-zero";
import { achatarRespostas } from "../../scoring/achatar-respostas";
import { montarManifesto, type LinhaDeEtapa, type ManifestoQuestionario } from "../manifesto-questionario";
import { letraDeclarada } from "../mapear-resposta";
import type { Previa } from "../borda";
import {
  aplicarImportacao,
  conferirPreviaContraGravado,
  pedirPrevia,
  type Desfecho,
  type PedidoDaTela,
} from "../../../components/features/admin/importar-respostas";

const URL_ALVO = process.env.PROVA_BORDA_URL;
const IMPRESSAO_PUBLICADA = "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

function exigirLocal(url: string): void {
  let host: string;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    host = u.hostname;
  } catch {
    throw new Error("PROVA_BORDA_URL nao e uma URL postgres valida");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`PROVA_BORDA_URL nao e local (host=${host}). Esta prova escreve: abortando.`);
  }
}

const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-borda-")) : "";

function sql(texto: string): string {
  const arquivo = join(TRABALHO, `q-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(arquivo, texto, "utf8");
  return execFileSync(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo],
    { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
  ).trim();
}

function um(texto: string): string {
  return sql(texto).split("\n")[0] ?? "";
}

function json<T>(texto: string): T {
  const bruto = um(texto);
  return JSON.parse(bruto === "" ? "null" : bruto) as T;
}

function numero(texto: string): number {
  return Number(um(texto));
}

// ---------------------------------------------------------------------------
// O CLIENTE DO BANCO, por psql. Implementa o pouco que as rotas usam -- as
// quatro leituras e o rpc -- e NADA MAIS. O resultado e dado do banco de
// verdade, nao fixture: um filtro esquecido na rota aparece aqui.
// ---------------------------------------------------------------------------

const COLUNAS: Record<string, string[]> = {
  events: ["id", "quiz_version"],
  quiz_stages: ["id", "stage_number", "title", "questions"],
  participants: ["id", "email", "full_name"],
  quiz_responses: ["participant_id"],
};

function lit(v: unknown): string {
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

interface ErroSimulado {
  code?: string;
  message: string;
}

function clienteViaPsql(): {
  from(t: string): { select(c: string): Record<string, unknown> };
  rpc(nome: string, args: Record<string, unknown>): Promise<{ data: unknown; error: ErroSimulado | null }>;
} {
  function consulta(tabela: string) {
    const condicoes: string[] = [];
    let ordem = "";
    const cols = COLUNAS[tabela];
    if (cols === undefined) throw new Error(`a rota consultou uma tabela que esta prova nao serve: ${tabela}`);

    const rodar = () => {
      const onde = condicoes.length > 0 ? `where ${condicoes.join(" and ")}` : "";
      const campos = cols.map((c) => `'${c}', ${c}`).join(", ");
      return json<unknown[]>(`
        select coalesce(json_agg(json_build_object(${campos})${ordem})::text, '[]')
          from public.${tabela} ${onde}
      `);
    };

    const q: Record<string, unknown> = {
      eq(coluna: string, valor: unknown) {
        condicoes.push(`${coluna} = ${lit(valor)}`);
        return q;
      },
      in(coluna: string, valores: readonly unknown[]) {
        condicoes.push(
          valores.length === 0 ? "false" : `${coluna} in (${valores.map(lit).join(", ")})`,
        );
        return q;
      },
      order(coluna: string) {
        ordem = ` order by ${coluna}`;
        return q;
      },
      maybeSingle() {
        const linhas = rodar();
        return Promise.resolve({ data: linhas[0] ?? null, error: null });
      },
      then<R>(ok: (v: { data: unknown; error: unknown }) => R) {
        return Promise.resolve({ data: rodar(), error: null }).then(ok);
      },
    };
    return q;
  }

  return {
    from(tabela: string) {
      return { select: () => consulta(tabela) };
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      const plano = JSON.stringify(args.plano);
      if (plano.includes("$plano$")) throw new Error("o payload colide com o delimitador");
      const arquivo = join(TRABALHO, `rpc-${Math.random().toString(36).slice(2)}.sql`);
      writeFileSync(arquivo, `select public.${nome}($plano$${plano}$plano$::jsonb)`, "utf8");
      try {
        const bruto = execFileSync(
          "psql",
          ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo],
          { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
        ).trim();
        return { data: JSON.parse(bruto === "" ? "null" : bruto), error: null };
      } catch (e) {
        // A mensagem do Postgres, crua, como o cliente do PostgREST a entregaria.
        // E ela que `codigoDeFalhaDaImportacao` tem de saber classificar.
        const err = e as { stderr?: string; message?: string };
        return { data: null, error: { message: (err.stderr ?? err.message ?? String(e)).trim() } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// O que e simulado: SO o servico de login e a fabrica do cliente.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  cliente: { atual: null as unknown },
}));

// Os caminhos sao RELATIVOS, nao `@/...`: o vitest.config.ts da raiz nao resolve
// o alias `@` (propriedade declarada por outra unidade, e nao se mexe nela por
// causa de uma prova). Resolvem para os MESMOS arquivos, e o vitest indexa mock
// por caminho resolvido.
vi.mock("../../supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: h.getUser } }),
}));
vi.mock("../../supabase/admin", () => ({
  createAdminClient: () => h.cliente.atual,
}));

import { NextRequest } from "next/server";

// As rotas DE VERDADE, carregadas SOB DEMANDA no `beforeAll`.
//
// Sob demanda porque elas importam `@/lib/...`, e `npx vitest run` (config da
// raiz, sem o alias) COLETA este arquivo. Com `import` estatico, a resolucao
// falharia na coleta -- antes de o `describe.skip` poder pular nada -- e a suite
// da maquina sem banco ficaria vermelha por um arquivo que nem deveria rodar.
const rotas: { previa?: Handler; aplicar?: Handler } = {};
type Handler = (r: NextRequest) => Promise<Response>;

async function carregarRotas(): Promise<void> {
  const previa = await import("../../../app/api/importacao/previa/route");
  const aplicar = await import("../../../app/api/importacao/aplicar/route");
  rotas.previa = previa.POST as Handler;
  rotas.aplicar = aplicar.POST as Handler;
}

const EVENTO = "bbbbbbbb-b0b0-4b0b-8b0b-bbbbbbbbbbbb";
const OPERADOR = "0ca0ca0c-0000-4000-8000-0ca0ca0c0ca0";
const FORMULARIO = "1FAIpQLSc-borda-http";
const COLUNA_DE_EMAIL = "Endereço de e-mail";

const ADMIN = {
  id: OPERADOR,
  email: "host@fortinside.test",
  app_metadata: { role: "admin" },
};
const PARTICIPANTE_SEM_PAPEL = { id: "9f9f9f9f-0000-4000-8000-9f9f9f9f9f9f", email: "jovem@x", app_metadata: {} };

// UM PARTICIPANTE POR CENARIO, e nenhum reaproveitado depois de ter respostas
// gravadas. Nao e zelo excessivo: participante que JA tem resposta faz
// `reconciliarLote` devolver CONFLITO (`participante_ja_tem_respostas`), de
// proposito -- importar por cima apagaria resposta existente. Reaproveitar um
// deles faria um cenario posterior medir aquele conflito achando que mede outra
// coisa. (Esta prova aprendeu isso errando: a primeira versao reusava
// `ausente` no cenario 10 e gravava 0 linhas.)
const P = {
  legit: "aa000001-0000-4000-8000-aa0000000001",
  trocada: "aa000002-0000-4000-8000-aa0000000002",
  hash: "aa000003-0000-4000-8000-aa0000000003",
  conta: "aa000004-0000-4000-8000-aa0000000004",
  conta2: "aa000005-0000-4000-8000-aa0000000005",
  vencida: "aa000006-0000-4000-8000-aa0000000006",
  ausente: "aa000007-0000-4000-8000-aa0000000007",
  recurso: "aa000008-0000-4000-8000-aa0000000008",
};
const EMAIL: Record<keyof typeof P, string> = {
  legit: "legit@example.org",
  trocada: "trocada@example.org",
  hash: "hash@example.org",
  conta: "conta@example.org",
  conta2: "conta2@example.org",
  vencida: "vencida@example.org",
  ausente: "ausente@example.org",
  recurso: "recurso@example.org",
};

let MANIFESTO: ManifestoQuestionario;

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`manifesto sem ${id}/${letra}`);
  return o;
}

/** UMA palavra reescrita. LANCA se nao mudou nada (teste vazio nao prova nada). */
function comUmaPalavraTrocada(texto: string): string {
  const p = texto.trimEnd().split(" ");
  p[p.length - 1] = `${p[p.length - 1]}s`;
  const t = p.join(" ");
  if (t === texto) throw new Error(`a troca nao mudou nada: ${texto}`);
  return t;
}

function cabecalhos(): string[] {
  return [COLUNA_DE_EMAIL, ...MANIFESTO.perguntas.map((p) => p.text)];
}

function linha(email: string, trocas: Record<string, unknown> = {}, id?: string) {
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
    submissao_id: id ?? `resp-${email.split("@")[0]}`,
    celulas: [email, ...MANIFESTO.perguntas.map((p) => porId[p.id])],
  };
}

function pedido(over: Partial<PedidoDaTela> = {}): PedidoDaTela {
  return {
    event_id: EVENTO,
    formulario_id: FORMULARIO,
    formulario_nome: "Marco Zero -- pre-evento (prova da borda)",
    impressao_declarada: MANIFESTO.impressao,
    cabecalhos: cabecalhos(),
    linhas: [],
    email_verificado: true,
    ...over,
  };
}

/** A tela falando com a ROTA DE VERDADE, em processo. */
const paraRota =
  (qual: "previa" | "aplicar", rota: string) =>
  async (_url: string, init?: RequestInit) => {
    const handler = rotas[qual];
    if (handler === undefined) throw new Error("as rotas nao foram carregadas");
    const req = new NextRequest(`http://localhost${rota}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: String(init?.body ?? "{}"),
    });
    return handler(req);
  };

const FETCH_PREVIA = paraRota("previa", "/api/importacao/previa");
const FETCH_APLICAR = paraRota("aplicar", "/api/importacao/aplicar");

async function previaDe(p: PedidoDaTela): Promise<Desfecho> {
  return pedirPrevia(p, FETCH_PREVIA, () => {});
}
async function aplicarDe(p: PedidoDaTela, previa: Previa): Promise<Desfecho> {
  return aplicarImportacao(p, previa, FETCH_APLICAR, () => {});
}

/** Fluxo inteiro: ve a previa e, se vier, grava a partir dela. */
async function conferirEGravar(p: PedidoDaTela) {
  const vista = await previaDe(p);
  if (vista.tipo !== "previa") return { vista, gravacao: null as Desfecho | null };
  const gravacao = await aplicarDe(p, vista.previa);
  return { vista, gravacao };
}

/** Quantas linhas as tabelas da 022 e quiz_responses tem AGORA, neste evento. */
function contarNoBanco() {
  return {
    submissoes: numero(`select count(*) from external_submissions where event_id = '${EVENTO}'`),
    itens: numero(`
      select count(*) from external_response_items i
        join external_submissions s on s.id = i.submission_id
       where s.event_id = '${EVENTO}'`),
    respostas: numero(`
      select count(*) from quiz_responses r
        join participants p on p.id = r.participant_id
       where p.event_id = '${EVENTO}'`),
    eventos: numero(`
      select count(*) from external_submission_events e
        join external_submissions s on s.id = e.submission_id
       where s.event_id = '${EVENTO}'`),
  };
}

describe("guarda de alvo", () => {
  it("a URL da prova, quando existe, e local", () => {
    if (URL_ALVO) exigirLocal(URL_ALVO);
    expect(true).toBe(true);
  });
});

descreve("PROVA: a borda HTTP da importacao externa, contra Postgres real", () => {
  beforeAll(async () => {
    exigirLocal(URL_ALVO as string);
    await carregarRotas();
    h.cliente.atual = clienteViaPsql();
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });

    // Re-rodavel: apaga o PROPRIO evento (cascade leva participantes, respostas e
    // submissoes DESTE evento, de nenhum outro).
    sql(`delete from events where id = '${EVENTO}'`);

    const valores = (Object.keys(P) as (keyof typeof P)[])
      .map((k) => `('${P[k]}','${EVENTO}','Pessoa ${k}','${EMAIL[k]}')`)
      .join(",");
    sql(`
      insert into events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
      values ('${EVENTO}', 'Prova da borda HTTP', 'PROVABORDA',
              '2026-10-24T13:00:00Z', 'active', 0, 2, 'async',
              '2026-10-22T12:00:00Z', '2026-10-23T23:59:00Z');
      insert into participants (id, event_id, full_name, email) values ${valores};
    `);

    const linhas = json<LinhaDeEtapa[]>(`
      select coalesce(json_agg(json_build_object(
               'id', id, 'stage_number', stage_number, 'title', title, 'questions', questions
             ) order by stage_number)::text, 'null')
        from quiz_stages where quiz_version = 2
    `);
    const r = montarManifesto(linhas, 2);
    if (!r.ok) throw new Error(`manifesto do banco invalido: ${r.codigo} ${r.motivo}`);
    MANIFESTO = r.manifesto;
  });

  afterAll(() => {
    if (URL_ALVO) sql(`delete from events where id = '${EVENTO}'`);
  });

  // =======================================================================
  it("1. ALICERCE: o manifesto que as rotas usam vem do BANCO e tem a impressao PUBLICADA", () => {
    expect(MANIFESTO.impressao).toBe(IMPRESSAO_PUBLICADA);
    expect(MANIFESTO.perguntas).toHaveLength(52);
    expect(MANIFESTO.etapas.map((e) => e.n)).toEqual([1, 2, 3, 4, 5]);
  });

  // =======================================================================
  it("2. NEGATIVA: NAO-ADMIN e recusado nas DUAS rotas, e nada e gravado", async () => {
    const antes = contarNoBanco();
    h.getUser.mockResolvedValue({ data: { user: PARTICIPANTE_SEM_PAPEL }, error: null });

    const p = pedido({ linhas: [linha(EMAIL.legit)] });
    const vista = await previaDe(p);
    expect(vista.tipo).toBe("recusado");
    if (vista.tipo === "recusado") {
      expect(vista.codigo).toBe("ADMIN_FORBIDDEN");
      expect(vista.mensagem).toMatch(/não tem permissão de administrador/);
    }

    // E a rota que GRAVA recusa igual: o portao nao esta so na previa.
    const gravacao = await aplicarImportacao(
      p,
      { impressao_da_previa: "f".repeat(64) } as Previa,
      FETCH_APLICAR,
      () => {},
    );
    expect(gravacao.tipo).toBe("recusado");
    if (gravacao.tipo === "recusado") expect(gravacao.codigo).toBe("ADMIN_FORBIDDEN");

    expect(contarNoBanco()).toEqual(antes);
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });
  });

  it("2b. NEGATIVA PAREADA: servico de login FORA DO AR nao vira 'sem permissao'", async () => {
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
    });
    const vista = await previaDe(pedido({ linhas: [linha(EMAIL.legit)] }));
    expect(vista.tipo).toBe("nao_verificado");
    if (vista.tipo === "nao_verificado") {
      expect(vista.codigo).toBe("AUTH_UNAVAILABLE");
      expect(vista.mensagem).not.toMatch(/não tem permissão/);
      expect(vista.mensagem).toMatch(/não respondeu/);
    }
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });
  });

  it("2c. NEGATIVA PAREADA: sem sessao -> AUTH_REQUIRED (recusa de verdade continua recusa)", async () => {
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" },
    });
    const vista = await previaDe(pedido({ linhas: [linha(EMAIL.legit)] }));
    expect(vista.tipo).toBe("recusado");
    if (vista.tipo === "recusado") expect(vista.codigo).toBe("AUTH_REQUIRED");
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });
  });

  it("2d. CONTROLE POSITIVO: o MESMO pedido, com sessao de administrador, passa o portao", async () => {
    const vista = await previaDe(pedido({ linhas: [linha(EMAIL.legit)] }));
    expect(vista.tipo).toBe("previa");
    if (vista.tipo === "previa") expect(vista.previa.operador.id).toBe(OPERADOR);
  });

  // =======================================================================
  it("3. A PREVIA NAO ESCREVE NADA -- nem a legitima, nem a problematica", async () => {
    const antes = contarNoBanco();
    for (const linhas of [
      [linha(EMAIL.legit)],
      [linha(EMAIL.trocada, { q41: comUmaPalavraTrocada(alternativa("q41", "C")) })],
      [linha("ninguem@example.org")],
    ]) {
      const vista = await previaDe(pedido({ linhas }));
      expect(vista.tipo).toBe("previa");
    }
    expect(contarNoBanco()).toEqual(antes);
  });

  // =======================================================================
  it("4. CONTROLE POSITIVO: importacao legitima vira resposta canonica PONTUAVEL", async () => {
    const p = pedido({ linhas: [linha(EMAIL.legit)] });
    const { vista, gravacao } = await conferirEGravar(p);
    expect(vista.tipo).toBe("previa");
    expect(gravacao?.tipo).toBe("aplicado");
    if (vista.tipo !== "previa" || gravacao?.tipo !== "aplicado") return;

    expect(vista.previa.entram).toBe(1);
    expect(vista.previa.submissoes[0].estado).toBe("importavel");
    expect(vista.previa.submissoes[0].apto_para_pontuar).toBe(true);
    expect(vista.previa.cobertura.geral).toBe(1);
    expect(gravacao.gravado.linhas_de_resposta_gravadas).toBe(5);

    // O banco gravou 5 etapas, de origem externa, com proveniencia completa.
    const linhas = json<{ stage_id: number; origem: string }[]>(`
      select coalesce(json_agg(json_build_object('stage_id', stage_id, 'origem', origem)
                               order by stage_id)::text, '[]')
        from quiz_responses where participant_id = '${P.legit}'
    `);
    expect(linhas).toHaveLength(5);
    expect(linhas.every((l) => l.origem === "externo")).toBe(true);

    const prov = json<Record<string, unknown>>(`
      select coalesce((select importacao::text from quiz_responses
                        where participant_id = '${P.legit}' order by stage_id limit 1), 'null')
    `);
    expect(prov.formulario_id).toBe(FORMULARIO);
    expect(prov.questionario_impressao).toBe(IMPRESSAO_PUBLICADA);
    expect(prov.quiz_version).toBe(2);
    expect(prov.identidade_via).toBe("email_verificado");
    expect(prov.importado_por).toBe(OPERADOR);
    expect(prov.apto_para_pontuar).toBe(true);

    // E O QUE IMPORTA: o motor pontua essas linhas, lidas do banco.
    const doBanco = json<{ stage_id: number; answers: Record<string, unknown> }[]>(`
      select coalesce(json_agg(json_build_object('stage_id', stage_id, 'answers', answers)
                               order by stage_id)::text, '[]')
        from quiz_responses where participant_id = '${P.legit}'
    `);
    const scores = calcularMarcoZero(achatarRespostas(doBanco as never));
    expect(scores.incompleto).toEqual([]);
    expect(Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0)).toBe(6);
    expect(scores.analiseElementos.status).toBe("completo");

    // A visao de aptidao do banco concorda com a previa.
    const apt = json<{ pode_pontuar: boolean; codigo: string | null }>(`
      select coalesce((select to_json(t)::text from (
        select pode_pontuar, codigo from v_aptidao_pontuacao_externa
         where participant_id = '${P.legit}') t), 'null')
    `);
    expect(apt.pode_pontuar).toBe(true);
    expect(apt.codigo).toBeNull();
  });

  // =======================================================================
  it("5. UMA PALAVRA TROCADA: DADO INCOMPATIVEL na PREVIA e no banco, e NUNCA zero", async () => {
    const original = alternativa("q43", "D");
    const reescrita = comUmaPalavraTrocada(original);
    expect(reescrita).not.toBe(original);

    const p = pedido({ linhas: [linha(EMAIL.trocada, { q43: reescrita })] });
    const { vista, gravacao } = await conferirEGravar(p);
    expect(vista.tipo).toBe("previa");
    if (vista.tipo !== "previa") return;

    // 5a. APARECE NA PREVIA, na pergunta certa, com o que a pessoa respondeu.
    const inc = vista.previa.com_dado_incompativel;
    expect(inc.submissoes).toBe(1);
    expect(inc.itens_pontuados).toBe(1);
    expect(inc.perguntas.map((q) => q.pergunta_id)).toEqual(["q43"]);
    expect(inc.perguntas[0].pontuada).toBe(true);
    expect(inc.perguntas[0].instrumento).toBe("situacionais");
    expect(inc.perguntas[0].enunciado).toBe(MANIFESTO.porId.q43.text);
    expect(inc.perguntas[0].exemplos[0].respondido).toBe(reescrita);
    expect(vista.previa.submissoes[0].estado).toBe("incompativel");
    expect(vista.previa.submissoes[0].apto_para_pontuar).toBe(false);
    expect(vista.previa.submissoes[0].bloqueio?.perguntas).toEqual(["q43"]);
    // A previa NAO mostra zero nem ausencia para q43.
    expect(JSON.stringify(vista.previa)).not.toMatch(/"q43":\s*0/);
    expect(vista.previa.entram).toBe(0);
    // E a cobertura caiu SO nas situacionais.
    const porInst = Object.fromEntries(vista.previa.cobertura.por_instrumento.map((i) => [i.instrumento, i]));
    expect(porInst.situacionais.incompativeis).toBe(1);
    expect(porInst.likert.cobertura).toBe(1);

    expect(gravacao?.tipo).toBe("aplicado");
    if (gravacao?.tipo !== "aplicado") return;

    // 5b. NO BANCO: estado proprio, e as COMPATIVEIS gravadas (1 falha nao vira 6 ausencias).
    const sub = json<{ estado: string; apto: boolean; motivo: string }>(`
      select coalesce((select to_json(t)::text from (
        select estado, apto_para_pontuar as apto, bloqueio ->> 'motivo' as motivo
          from external_submissions
         where event_id = '${EVENTO}' and submissao_id = 'resp-trocada') t), 'null')
    `);
    expect(sub.estado).toBe("incompativel");
    expect(sub.apto).toBe(false);
    expect(sub.motivo).toMatch(/DADO INCOMPATIVEL/);
    expect(sub.motivo).toMatch(/NAO e pontuacao zero/);

    const item = json<{ estado: string; canonico: unknown; bruto: unknown; pontuada: boolean }>(`
      select coalesce((select to_json(t)::text from (
        select i.estado, i.valor_canonico as canonico, i.valor_bruto as bruto, i.pontuada
          from external_response_items i
          join external_submissions s on s.id = i.submission_id
         where s.event_id = '${EVENTO}' and s.submissao_id = 'resp-trocada'
           and i.pergunta_id = 'q43') t), 'null')
    `);
    expect(item.estado).toBe("incompativel");
    // NAO e zero e NAO e ausente: nao ha valor canonico, e o bruto foi guardado.
    expect(item.canonico).toBeNull();
    expect(item.bruto).toBe(reescrita);
    expect(item.pontuada).toBe(true);

    // 5c. A etapa foi gravada com as compativeis, e q43 NAO esta em `answers`.
    // A etapa e a que o MANIFESTO diz que contem q43, nao um numero chutado: um
    // numero fixo aqui faria este teste medir a etapa errada e passar vazio.
    const etapaDeQ43 = MANIFESTO.etapaDaPergunta.q43;
    expect(etapaDeQ43).toBeGreaterThan(0);
    const etapa = json<{ tem_q43: boolean; n: number; incompativeis: string[] }>(`
      select coalesce((select to_json(t)::text from (
        select (answers ? 'q43') as tem_q43,
               (select count(*) from jsonb_object_keys(answers)) as n,
               (importacao -> 'incompativeis') as incompativeis
          from quiz_responses
         where participant_id = '${P.trocada}'
           and stage_id = (select id from quiz_stages
                            where quiz_version = 2 and stage_number = ${etapaDeQ43})) t), 'null')
    `);
    expect(etapa.tem_q43).toBe(false);
    expect(etapa.n).toBeGreaterThan(0);
    expect(etapa.incompativeis).toEqual(["q43"]);

    // 5d. E o banco RECUSA pontuar: com codigo proprio, nao com um numero.
    const apt = json<{ pode_pontuar: boolean; codigo: string | null }>(`
      select coalesce((select to_json(t)::text from (
        select pode_pontuar, codigo from v_aptidao_pontuacao_externa
         where participant_id = '${P.trocada}') t), 'null')
    `);
    expect(apt.pode_pontuar).toBe(false);
    expect(apt.codigo).toBe("DADO_INCOMPATIVEL");
  });

  // =======================================================================
  it("6. HASH DIFERENTE: recusado ANTES de pontuar, e nada e gravado", async () => {
    const antes = contarNoBanco();
    const outra = "0".repeat(64);
    const vista = await previaDe(pedido({ linhas: [linha(EMAIL.hash)], impressao_declarada: outra }));

    expect(vista.tipo).toBe("recusado");
    if (vista.tipo !== "recusado") return;
    expect(vista.codigo).toBe("IMPORT_MANIFEST_MISMATCH");
    expect(vista.acao).toBe("corrigir_coleta");
    expect(vista.mensagem).toMatch(/NÃO é o que o sistema conhece/);
    expect(vista.mensagem).toMatch(/recusada ANTES de pontuar/);
    // As duas impressoes chegam a tela, para o operador comparar.
    expect(vista.mensagem).toContain(outra);
    expect(vista.mensagem).toContain(IMPRESSAO_PUBLICADA);

    // Tentar GRAVAR direto, por cima, tambem recusa: o portao nao e da previa.
    const gravacao = await aplicarImportacao(
      pedido({ linhas: [linha(EMAIL.hash)], impressao_declarada: outra }),
      { impressao_da_previa: "a".repeat(64) } as Previa,
      FETCH_APLICAR,
      () => {},
    );
    expect(gravacao.tipo).toBe("recusado");
    if (gravacao.tipo === "recusado") expect(gravacao.codigo).toBe("IMPORT_MANIFEST_MISMATCH");

    expect(contarNoBanco()).toEqual(antes);
    expect(numero(`select count(*) from quiz_responses where participant_id = '${P.hash}'`)).toBe(0);
  });

  it("6b. NEGATIVA PAREADA: hash AUSENTE e OUTRO codigo -- 'nao conferi' nao e 'nao bate'", async () => {
    const semHash = await previaDe(pedido({ linhas: [linha(EMAIL.hash)], impressao_declarada: "" }));
    const diferente = await previaDe(
      pedido({ linhas: [linha(EMAIL.hash)], impressao_declarada: "0".repeat(64) }),
    );
    expect(semHash.tipo).toBe("nao_verificado");
    expect(diferente.tipo).toBe("recusado");
    if (semHash.tipo === "nao_verificado") {
      expect(semHash.codigo).toBe("IMPORT_MANIFEST_UNVERIFIABLE");
      expect(semHash.mensagem).toMatch(/NÃO quer dizer que o questionário está errado/);
    }
    if (semHash.tipo === "nao_verificado" && diferente.tipo === "recusado") {
      expect(semHash.mensagem).not.toBe(diferente.mensagem);
    }
  });

  it("6c. CONTROLE POSITIVO: o MESMO lote, com o hash do sistema, passa o portao", async () => {
    const vista = await previaDe(pedido({ linhas: [linha(EMAIL.hash)] }));
    expect(vista.tipo).toBe("previa");
    if (vista.tipo === "previa") expect(vista.previa.conferencia_do_manifesto).toBe("igual");
  });

  // =======================================================================
  it("7. IDENTIDADE SEM CORRESPONDENCIA: PENDENTE na previa, e nada gravado como de ninguem", async () => {
    const p = pedido({
      linhas: [linha("ninguem@example.org", {}, "resp-ninguem"), linha(EMAIL.ausente)],
    });
    const { vista, gravacao } = await conferirEGravar(p);
    expect(vista.tipo).toBe("previa");
    if (vista.tipo !== "previa") return;

    // 7a. Listada como pendente, com o motivo por extenso.
    expect(vista.previa.retidas_por_identidade.pendentes).toBe(1);
    expect(vista.previa.retidas_por_identidade.submissoes.map((s) => s.submissao_id)).toEqual(["resp-ninguem"]);
    expect(vista.previa.retidas_por_identidade.submissoes[0].motivo).toMatch(
      /nao e o e-mail de nenhum participante/,
    );
    // 7b. CONTROLE POSITIVO no MESMO lote: quem casa entra.
    expect(vista.previa.entram).toBe(1);
    expect(vista.previa.cobertura.base_de_submissoes).toBe(1);

    expect(gravacao?.tipo).toBe("aplicado");
    if (gravacao?.tipo !== "aplicado") return;

    // 7c. No banco: retida, sem participante, e NAO descartada (o bruto ficou).
    const sub = json<{ estado: string; participant_id: string | null; tem_bruto: boolean; acao: string }>(`
      select coalesce((select to_json(t)::text from (
        select s.estado, s.participant_id,
               (s.respostas_brutas <> '{}'::jsonb) as tem_bruto,
               (select e.acao from external_submission_events e
                 where e.submission_id = s.id order by e.criado_em desc limit 1) as acao
          from external_submissions s
         where s.event_id = '${EVENTO}' and s.submissao_id = 'resp-ninguem') t), 'null')
    `);
    expect(sub.estado).toBe("pendente");
    expect(sub.participant_id).toBeNull();
    expect(sub.tem_bruto).toBe(true);
    expect(sub.acao).toBe("retida_pendente");

    // 7d. E NENHUM participante foi criado a partir dela.
    expect(numero(`select count(*) from participants where event_id = '${EVENTO}' and email = 'ninguem@example.org'`)).toBe(0);
    expect(numero(`select count(*) from quiz_responses r join external_submissions s on s.id = r.external_submission_id where s.submissao_id = 'resp-ninguem'`)).toBe(0);
  });

  // =======================================================================
  it("8. A PREVIA BATE COM O QUE A APLICACAO FAZ -- conferido contra o banco", async () => {
    const antes = contarNoBanco();
    const p = pedido({
      linhas: [
        linha(EMAIL.conta),
        linha(EMAIL.conta2, { q41: comUmaPalavraTrocada(alternativa("q41", "C")) }),
        linha("outro-ninguem@example.org", {}, "resp-outro-ninguem"),
      ],
    });
    const { vista, gravacao } = await conferirEGravar(p);
    expect(vista.tipo).toBe("previa");
    expect(gravacao?.tipo).toBe("aplicado");
    if (vista.tipo !== "previa" || gravacao?.tipo !== "aplicado") return;

    // 8a. A conferencia da propria tela: previa x resumo do banco.
    const c = conferirPreviaContraGravado(vista.previa, gravacao.gravado);
    expect(c).toEqual({ bate: true });

    // 8b. E, independentemente da tela, contado NO BANCO.
    const depois = contarNoBanco();
    expect(depois.respostas - antes.respostas).toBe(vista.previa.linhas_de_resposta_a_gravar);
    expect(depois.itens - antes.itens).toBe(vista.previa.itens_a_registrar);
    expect(depois.submissoes - antes.submissoes).toBe(vista.previa.submissoes.length);

    // 8c. E estado por estado, como a previa disse.
    const porEstado = json<Record<string, number>>(`
      select coalesce((select json_object_agg(estado, n)::text from (
        select estado, count(*) as n from external_submissions
         where event_id = '${EVENTO}' and formulario_id = '${FORMULARIO}'
           and submissao_id in ('resp-conta', 'resp-conta2', 'resp-outro-ninguem')
         group by estado) t), '{}')
    `);
    expect(porEstado).toEqual({ importavel: 1, incompativel: 1, pendente: 1 });
    expect(vista.previa.entram).toBe(1);
    expect(vista.previa.com_dado_incompativel.submissoes).toBe(1);
    expect(vista.previa.retidas_por_identidade.pendentes).toBe(1);
  });

  // =======================================================================
  it("9. PREVIA VENCIDA: recusada, e nada e gravado", async () => {
    const p = pedido({ linhas: [linha(EMAIL.vencida)] });
    const vista = await previaDe(p);
    expect(vista.tipo).toBe("previa");
    if (vista.tipo !== "previa") return;

    // O lote muda depois da conferencia: a previa na mao deixa de descrever isto.
    // A linha extra e de um e-mail que nao e de ninguem, para este cenario medir
    // SO o vencimento da previa, e nao um conflito de identidade por tabela.
    const outro = pedido({
      linhas: [linha(EMAIL.vencida), linha("extra-ninguem@example.org", {}, "resp-extra")],
    });
    const antes = contarNoBanco();
    const gravacao = await aplicarDe(outro, vista.previa);

    expect(gravacao.tipo).toBe("recusado");
    if (gravacao.tipo === "recusado") {
      expect(gravacao.codigo).toBe("IMPORT_PREVIEW_STALE");
      expect(gravacao.acao).toBe("refazer_previa");
      expect(gravacao.mensagem).toMatch(/Nada foi gravado/);
    }
    expect(contarNoBanco()).toEqual(antes);

    // CONTROLE POSITIVO: a previa do pedido CERTO grava.
    const ok = await aplicarDe(p, vista.previa);
    expect(ok.tipo).toBe("aplicado");
    expect(contarNoBanco().respostas).toBe(antes.respostas + 5);
  });

  // =======================================================================
  it("10. RECURSO AUSENTE no banco: 'nao esta instalado', nunca 'nao respondeu'", async () => {
    const p = pedido({ linhas: [linha(EMAIL.recurso)] });
    const vista = await previaDe(p);
    expect(vista.tipo).toBe("previa");
    if (vista.tipo !== "previa") return;

    // A funcao sai de cena, como num ambiente onde a 022 nao foi aplicada.
    sql(`alter function public.importacao_externa_aplicar(jsonb) rename to importacao_externa_aplicar_guardada`);
    try {
      const semRecurso = await aplicarDe(p, vista.previa);
      expect(semRecurso.tipo).toBe("recurso_ausente");
      if (semRecurso.tipo === "recurso_ausente") {
        expect(semRecurso.codigo).toBe("IMPORT_SCHEMA_MISSING");
        expect(semRecurso.acao).toBe("instalar_no_banco");
        expect(semRecurso.mensagem).toMatch(/migration 022/);
        expect(semRecurso.mensagem).not.toMatch(/aguarde/i);
      }
    } finally {
      sql(`alter function public.importacao_externa_aplicar_guardada(jsonb) rename to importacao_externa_aplicar`);
    }

    // NEGATIVA PAREADA: a funcao EXISTE e a chamada falha -> outro codigo, outro
    // texto. Mandar instalar aqui seria mandar investigar a coisa errada.
    const naoRespondeu = await (async () => {
      const guardado = h.cliente.atual;
      h.cliente.atual = {
        ...(guardado as Record<string, unknown>),
        rpc: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }),
      };
      try {
        return await aplicarDe(p, vista.previa);
      } finally {
        h.cliente.atual = guardado;
      }
    })();
    expect(naoRespondeu.tipo).toBe("nao_verificado");
    if (naoRespondeu.tipo === "nao_verificado") {
      expect(naoRespondeu.codigo).toBe("IMPORT_UNAVAILABLE");
      expect(naoRespondeu.mensagem).toMatch(/aguarde/i);
      expect(naoRespondeu.mensagem).not.toMatch(/migration|instalar/i);
      // E o texto interno do banco nao chega a tela.
      expect(naoRespondeu.mensagem).not.toMatch(/statement timeout|57014/);
    }

    // CONTROLE POSITIVO: com a funcao de volta, a MESMA chamada grava.
    const ok = await aplicarDe(p, vista.previa);
    expect(ok.tipo).toBe("aplicado");
    if (ok.tipo === "aplicado") expect(ok.gravado.linhas_de_resposta_gravadas).toBe(5);
  });
});
