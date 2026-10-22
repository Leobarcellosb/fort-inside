// PROVA DA BORDA DA DECISAO DO OPERADOR: as ROTAS DE VERDADE
// (app/api/importacao/decisoes, .../reconciliar, .../revogar), com as funcoes do
// banco de verdade, contra Postgres de verdade, e com as funcoes da TELA de
// verdade lendo as respostas.
//
// Como rodar:
//   PROVA_DECISAO_URL="postgresql://...@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config lib/importacao/provas/vitest.prova.config.ts \
//       lib/importacao/provas/decisao-http.test.ts --reporter=verbose
//
// Sem PROVA_DECISAO_URL o arquivo e PULADO, para `npx vitest run` continuar verde
// em maquina sem banco. GUARDA DE ALVO: a URL tem de ser 127.0.0.1, localhost ou
// [::1]. Esta prova ESCREVE. Use um container descartavel proprio.
//
// O QUE E REAL AQUI, e o que e simulado
// -------------------------------------
// REAL: os tres handlers das rotas da decisao E os dois da importacao (que criam
// as pendencias); `verificarAdmin()`; todo o `lib/importacao/*`; as funcoes
// `importacao_externa_aplicar` e `importacao_externa_revogar` e as tabelas da 022;
// as leituras e a escrita no historico, que saem do banco por psql; e as funcoes
// da tela (`pedirMesa`, `reconciliarSubmissao`, `revogarSubmissao`,
// `conferirFichaContraGravado`), que recebem as `Response` que as rotas montaram.
// SIMULADO: so o SERVICO DE LOGIN (`auth.getUser`), para cada cenario poder dizer
// quem esta batendo na porta -- que e justamente o que se quer variar.
//
// O QUE ELA PROVA, nesta ordem, cada negativa com CONTROLE POSITIVO:
//   1. o alicerce: manifesto do banco, e a importacao criando PENDENCIA e CONFLITO;
//   2. NAO-ADMIN e recusado nas TRES rotas, e login fora do ar NAO vira "sem
//      permissao" (e, ao lado, o admin passa no mesmo ambiente);
//   3. a rota da mesa NAO ESCREVE NADA;
//   4. a FICHA mostra o que esta sendo afirmado e O QUE NAO BATE;
//   5. corpo com campo de OPERADOR e RECUSADO; o operador gravado e o da SESSAO
//      (e o mesmo corpo sem o campo e aceito);
//   6. pendencia RESOLVIDA -> resposta canonica, por decisao do operador;
//   7. a mesma decisao REVOGADA -> os dois atos no historico, nada apagado;
//   8. CONFLITO resolvido escolhendo UMA, a outra permanece recusada e rastreavel;
//   9. ALVO OCUPADO e recusado (e o alvo livre, no mesmo ato, e aceito);
//  10. ficha VENCIDA e recusada, e nada e escrito (e a ficha nova e aceita);
//  11. O CASO QUE MAIS MACHUCA, medido: sem o portao do alvo ocupado, a gravacao
//      sobrescreve a resposta que a pessoa tinha e a revogacao NAO a devolve;
//  12. o recurso ausente no banco -> "nao esta instalado", nunca "nao respondeu";
//  13. o CONTRATO DE REVERSIBILIDADE: os tres estados se comportam diferente, a
//      tela os informa PREVIAMENTE e por submissao, a titularidade dos registros
//      removidos fica provada no livro-razao, e a evidencia crua permanece nos
//      tres.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { montarManifesto, type LinhaDeEtapa, type ManifestoQuestionario } from "../manifesto-questionario";
import { letraDeclarada } from "../mapear-resposta";
import { planejarImportacao } from "../planejar-importacao";
import type { Previa } from "../borda";
import type { FichaDeReconciliacao, FichaDeRevogacao, MesaDeDecisao } from "../decisao-do-operador";
import {
  aplicarImportacao,
  pedirPrevia,
  type Desfecho,
  type PedidoDaTela,
} from "../../../components/features/admin/importar-respostas";
import {
  conferirFichaContraGravado,
  pedirMesa,
  reconciliarSubmissao,
  revogarSubmissao,
  type DesfechoDaMesa,
  type DesfechoDoAto,
} from "../../../components/features/admin/decidir-identidade";

const URL_ALVO = process.env.PROVA_DECISAO_URL;
const IMPRESSAO_PUBLICADA = "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

function exigirLocal(url: string): void {
  let host: string;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    host = u.hostname;
  } catch {
    throw new Error("PROVA_DECISAO_URL nao e uma URL postgres valida");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`PROVA_DECISAO_URL nao e local (host=${host}). Esta prova escreve: abortando.`);
  }
}

const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-decisao-")) : "";

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
// O CLIENTE DO BANCO, por psql. Implementa o que as rotas usam -- select com as
// colunas que elas pedem, insert no historico, e os dois rpc -- e NADA MAIS. O
// resultado e dado do banco de verdade, nao fixture: um filtro esquecido na rota
// aparece aqui.
// ---------------------------------------------------------------------------

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function literalJson(valor: unknown): string {
  const t = JSON.stringify(valor);
  if (t.includes("$j$")) throw new Error("o payload colide com o delimitador");
  return `$j$${t}$j$::jsonb`;
}

interface ErroSimulado {
  code?: string;
  message: string;
}

function erroDoPsql(e: unknown): ErroSimulado {
  const err = e as { stderr?: string; message?: string };
  return { message: (err.stderr ?? err.message ?? String(e)).trim() };
}

/** Ver o gancho em `rpc`. `null` fora do cenario da corrida. */
let noMeioDaGravacao: (() => void) | null = null;

function clienteViaPsql() {
  function consulta(tabela: string, colunas: string) {
    const cols = colunas
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    const condicoes: string[] = [];
    let ordem = "";

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
        condicoes.push(valores.length === 0 ? "false" : `${coluna} in (${valores.map(lit).join(", ")})`);
        return q;
      },
      order(coluna: string) {
        ordem = ` order by ${coluna}`;
        return q;
      },
      maybeSingle() {
        try {
          const linhas = rodar();
          return Promise.resolve({ data: linhas[0] ?? null, error: null });
        } catch (e) {
          return Promise.resolve({ data: null, error: erroDoPsql(e) });
        }
      },
      then<R>(ok: (v: { data: unknown; error: unknown }) => R) {
        let r: { data: unknown; error: unknown };
        try {
          r = { data: rodar(), error: null };
        } catch (e) {
          r = { data: null, error: erroDoPsql(e) };
        }
        return Promise.resolve(r).then(ok);
      },
    };
    return q;
  }

  return {
    from(tabela: string) {
      return {
        select: (colunas: string) => consulta(tabela, colunas),
        insert(linhas: Record<string, unknown>[]) {
          try {
            for (const l of linhas) {
              const colunas = Object.keys(l);
              const valores = colunas.map((c) => {
                const v = l[c];
                return v !== null && typeof v === "object" ? literalJson(v) : lit(v);
              });
              sql(
                `insert into public.${tabela} (${colunas.join(", ")}) values (${valores.join(", ")})`,
              );
            }
            return Promise.resolve({ data: null, error: null });
          } catch (e) {
            return Promise.resolve({ data: null, error: erroDoPsql(e) });
          }
        },
      };
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      // O GANCHO DA CORRIDA. Serve a um proposito so: fazer a escrita concorrente
      // acontecer DEPOIS de a rota ter lido a mesa e montado o plano, e ANTES de a
      // funcao do banco gravar. E a unica forma de exercitar a segunda camada do
      // portao -- se a escrita concorrente acontecesse antes do pedido, a PRIMEIRA
      // camada a pegaria, e o teste mediria a camada errada.
      if (noMeioDaGravacao !== null) {
        const f = noMeioDaGravacao;
        noMeioDaGravacao = null;
        f();
      }
      try {
        const chamada =
          nome === "importacao_externa_aplicar"
            ? `select public.${nome}(${literalJson(args.plano)})`
            : `select public.${nome}(${lit(args.p_submission_id)}::uuid, ${lit(args.p_operador)}::uuid, ${lit(args.p_justificativa)})`;
        const bruto = um(chamada);
        return { data: JSON.parse(bruto === "" ? "null" : bruto), error: null };
      } catch (e) {
        // A mensagem do Postgres, crua, como o cliente do PostgREST a entregaria.
        return { data: null, error: erroDoPsql(e) };
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

vi.mock("../../supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: h.getUser } }),
}));
vi.mock("../../supabase/admin", () => ({
  createAdminClient: () => h.cliente.atual,
}));

import { NextRequest } from "next/server";

type Handler = (r: NextRequest) => Promise<Response>;
const rotas: {
  previa?: Handler;
  aplicar?: Handler;
  mesa?: Handler;
  reconciliar?: Handler;
  revogar?: Handler;
} = {};

async function carregarRotas(): Promise<void> {
  rotas.previa = (await import("../../../app/api/importacao/previa/route")).POST as Handler;
  rotas.aplicar = (await import("../../../app/api/importacao/aplicar/route")).POST as Handler;
  rotas.mesa = (await import("../../../app/api/importacao/decisoes/route")).GET as Handler;
  rotas.reconciliar = (await import("../../../app/api/importacao/reconciliar/route")).POST as Handler;
  rotas.revogar = (await import("../../../app/api/importacao/revogar/route")).POST as Handler;
}

const EVENTO = "dddddddd-d0d0-4d0d-8d0d-dddddddddddd";
const OPERADOR = "0da0da0d-0000-4000-8000-0da0da0d0da0";
const FORMULARIO = "1FAIpQLSc-decisao-do-operador";
const COLUNA_DE_EMAIL = "Endereço de e-mail";

const ADMIN = { id: OPERADOR, email: "host@fortinside.test", app_metadata: { role: "admin" } };
const PARTICIPANTE_SEM_PAPEL = {
  id: "9e9e9e9e-0000-4000-8000-9e9e9e9e9e9e",
  email: "jovem@x",
  app_metadata: {},
};

// Um participante por cenario. Participante que JA tem resposta muda o desfecho
// da reconciliacao de proposito (e o portao do alvo ocupado), entao reaproveitar
// um deles faria um cenario medir aquele portao achando que mede outra coisa.
const P = {
  orfa: "dd000001-0000-4000-8000-dd0000000001",
  dupla: "dd000002-0000-4000-8000-dd0000000002",
  livre: "dd000003-0000-4000-8000-dd0000000003",
  ocupado: "dd000004-0000-4000-8000-dd0000000004",
  vencida: "dd000005-0000-4000-8000-dd0000000005",
  adulterada: "dd000006-0000-4000-8000-dd0000000006",
  machuca: "dd000007-0000-4000-8000-dd0000000007",
};
const EMAIL: Record<keyof typeof P, string> = {
  orfa: "orfa@example.org",
  dupla: "dupla@example.org",
  livre: "livre@example.org",
  ocupado: "ocupado@example.org",
  vencida: "vencida@example.org",
  adulterada: "adulterada@example.org",
  machuca: "machuca@example.org",
};

let MANIFESTO: ManifestoQuestionario;

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`manifesto sem ${id}/${letra}`);
  return o;
}

function cabecalhos(): string[] {
  return [COLUNA_DE_EMAIL, ...MANIFESTO.perguntas.map((p) => p.text)];
}

function respostasPorId(trocas: Record<string, unknown> = {}): Record<string, unknown> {
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
  return { ...porId, ...trocas };
}

function linha(email: string, id: string, trocas: Record<string, unknown> = {}) {
  const porId = respostasPorId(trocas);
  return { submissao_id: id, celulas: [email, ...MANIFESTO.perguntas.map((p) => porId[p.id])] };
}

function pedidoDeImportacao(linhas: ReturnType<typeof linha>[]): PedidoDaTela {
  return {
    event_id: EVENTO,
    formulario_id: FORMULARIO,
    formulario_nome: "Marco Zero -- pre-evento (prova da decisao)",
    impressao_declarada: MANIFESTO.impressao,
    cabecalhos: cabecalhos(),
    linhas,
    email_verificado: true,
  };
}

/** A tela falando com a ROTA DE VERDADE, em processo. */
const paraRota =
  (qual: keyof typeof rotas, caminho: string) =>
  async (url: string, init?: RequestInit) => {
    const handler = rotas[qual];
    if (handler === undefined) throw new Error("as rotas nao foram carregadas");
    const metodo = (init?.method ?? "POST").toUpperCase();
    // A rota da mesa e GET: a URL que a tela montou (com event_id) e a que chega.
    const alvo = url.startsWith("/") ? `http://localhost${url}` : `http://localhost${caminho}`;
    const req = new NextRequest(alvo, {
      method: metodo,
      headers: { "content-type": "application/json" },
      ...(metodo === "GET" ? {} : { body: String(init?.body ?? "{}") }),
    });
    return handler(req);
  };

const FETCH_PREVIA = paraRota("previa", "/api/importacao/previa");
const FETCH_APLICAR = paraRota("aplicar", "/api/importacao/aplicar");
const FETCH_MESA = paraRota("mesa", "/api/importacao/decisoes");
const FETCH_RECONCILIAR = paraRota("reconciliar", "/api/importacao/reconciliar");
const FETCH_REVOGAR = paraRota("revogar", "/api/importacao/revogar");

async function importar(linhas: ReturnType<typeof linha>[]): Promise<Desfecho> {
  const p = pedidoDeImportacao(linhas);
  const vista = await pedirPrevia(p, FETCH_PREVIA, () => {});
  if (vista.tipo !== "previa") return vista;
  return aplicarImportacao(p, vista.previa as Previa, FETCH_APLICAR, () => {});
}

async function mesa(): Promise<MesaDeDecisao> {
  const d = await pedirMesa(EVENTO, FETCH_MESA, () => {});
  if (d.tipo !== "mesa") throw new Error(`a mesa nao veio: ${JSON.stringify(d)}`);
  return d.mesa;
}

/** A ficha de (submissao do formulario -> participante), lida da mesa de verdade. */
async function fichaPara(submissaoDoForm: string, participantId: string): Promise<FichaDeReconciliacao> {
  const m = await mesa();
  const grupo = m.a_decidir.find((g) => g.submissao.submissao_id === submissaoDoForm);
  if (grupo === undefined) throw new Error(`a mesa nao tem ${submissaoDoForm} a decidir`);
  const ficha = grupo.candidatos.find((c) => c.participante.id === participantId);
  if (ficha === undefined) throw new Error(`a mesa nao tem candidato ${participantId}`);
  return ficha;
}

async function fichaDeRevogacao(submissaoDoForm: string): Promise<FichaDeRevogacao> {
  const m = await mesa();
  const f = m.revogaveis.find((r) => r.submissao.submissao_id === submissaoDoForm);
  if (f === undefined) throw new Error(`a mesa nao tem ${submissaoDoForm} a revogar`);
  return f;
}

async function reconciliar(ficha: FichaDeReconciliacao, justificativa: string): Promise<DesfechoDoAto> {
  return reconciliarSubmissao({ eventId: EVENTO, ficha, justificativa }, FETCH_RECONCILIAR, () => {});
}

/** Um corpo CRU na rota de reconciliar, para provar o que ela recusa. */
async function reconciliarCru(corpo: Record<string, unknown>): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const res = await (rotas.reconciliar as Handler)(
    new NextRequest("http://localhost/api/importacao/reconciliar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
  );
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

function contarNoBanco() {
  return {
    submissoes: numero(`select count(*) from external_submissions where event_id = '${EVENTO}'`),
    respostas: numero(`
      select count(*) from quiz_responses r
        join participants p on p.id = r.participant_id
       where p.event_id = '${EVENTO}'`),
    atos: numero(`
      select count(*) from external_submission_events e
        join external_submissions s on s.id = e.submission_id
       where s.event_id = '${EVENTO}'`),
  };
}

function historicoDe(submissaoDoForm: string): string[] {
  const t = sql(`
    select e.acao from external_submission_events e
      join external_submissions s on s.id = e.submission_id
     where s.event_id = '${EVENTO}' and s.submissao_id = '${submissaoDoForm}'
     order by e.criado_em, e.acao`);
  return t === "" ? [] : t.split("\n");
}

describe("guarda de alvo", () => {
  it("a URL da prova, quando existe, e local", () => {
    if (URL_ALVO) exigirLocal(URL_ALVO);
    expect(true).toBe(true);
  });
});

descreve("PROVA: a borda da DECISAO DO OPERADOR, contra Postgres real", () => {
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
      values ('${EVENTO}', 'Prova da decisao do operador', 'PROVADEC',
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
  it("1. ALICERCE: o manifesto vem do BANCO, e a importacao cria PENDENCIA e CONFLITO de verdade", async () => {
    expect(MANIFESTO.impressao).toBe(IMPRESSAO_PUBLICADA);
    expect(MANIFESTO.perguntas).toHaveLength(52);

    // `ocupado` tem resposta PROPRIA, do aplicativo: e o alvo ocupado do cenario 9.
    sql(`
      insert into quiz_responses (participant_id, stage_id, answers, origem)
      values ('${P.ocupado}', 101, '{"q1": "resposta que a pessoa deu no aplicativo"}'::jsonb, 'app')
    `);

    const d = await importar([
      // e-mail verificado que nao e de participante nenhum -> PENDENTE
      linha("ninguem@example.org", "resp-sem-dono"),
      linha("outro-ninguem@example.org", "resp-vencida"),
      linha("terceiro-ninguem@example.org", "resp-adulterada"),
      // duas submissoes com o MESMO e-mail verificado -> CONFLITO para as duas
      linha(EMAIL.dupla, "resp-dupla-1"),
      linha(EMAIL.dupla, "resp-dupla-2"),
    ]);
    expect(d.tipo).toBe("aplicado");
    if (d.tipo !== "aplicado") return;
    expect(d.gravado.por_estado).toEqual({ pendente: 3, conflito: 2 });
    // Nada entrou como resposta de ninguem: identidade nao resolvida nao grava.
    expect(d.gravado.linhas_de_resposta_gravadas).toBe(0);

    const estados = json<{ submissao_id: string; estado: string; participante: string | null }[]>(`
      select json_agg(json_build_object('submissao_id', submissao_id, 'estado', estado,
                                        'participante', participant_id) order by submissao_id)::text
        from external_submissions where event_id = '${EVENTO}'`);
    expect(estados.map((e) => `${e.submissao_id}=${e.estado}`)).toEqual([
      "resp-adulterada=pendente",
      "resp-dupla-1=conflito",
      "resp-dupla-2=conflito",
      "resp-sem-dono=pendente",
      "resp-vencida=pendente",
    ]);
    expect(estados.every((e) => e.participante === null)).toBe(true);
  });

  // =======================================================================
  it("2. NEGATIVA: NAO-ADMIN e recusado nas TRES rotas da decisao, e nada e escrito", async () => {
    const antes = contarNoBanco();
    const ficha = await fichaPara("resp-sem-dono", P.orfa); // com admin, para ter a ficha

    h.getUser.mockResolvedValue({ data: { user: PARTICIPANTE_SEM_PAPEL }, error: null });

    const m = await pedirMesa(EVENTO, FETCH_MESA, () => {});
    expect(m.tipo).toBe("recusado");
    if (m.tipo === "recusado") {
      expect(m.codigo).toBe("ADMIN_FORBIDDEN");
      expect(m.mensagem).toMatch(/não tem permissão de administrador/);
    }

    const r = await reconciliar(ficha, "tentativa de quem nao e administrador");
    expect(r.tipo).toBe("recusado");
    if (r.tipo === "recusado") expect(r.codigo).toBe("ADMIN_FORBIDDEN");

    const v = await revogarSubmissao(
      { eventId: EVENTO, ficha: { submissao: { id: ficha.submissao.id } } as FichaDeRevogacao, justificativa: "tentativa sem papel" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(v.tipo).toBe("recusado");
    if (v.tipo === "recusado") expect(v.codigo).toBe("ADMIN_FORBIDDEN");

    expect(contarNoBanco()).toEqual(antes);
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });

    // CONTROLE POSITIVO, no mesmo ambiente: o admin le a mesa.
    const comAdmin = await pedirMesa(EVENTO, FETCH_MESA, () => {});
    expect(comAdmin.tipo).toBe("mesa");
  });

  it("2b. NEGATIVA PAREADA: servico de login FORA DO AR nao vira 'sem permissao'", async () => {
    h.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
    });
    const m: DesfechoDaMesa = await pedirMesa(EVENTO, FETCH_MESA, () => {});
    expect(m.tipo).toBe("nao_verificado");
    if (m.tipo === "nao_verificado") {
      expect(m.codigo).toBe("AUTH_UNAVAILABLE");
      expect(m.mensagem).not.toMatch(/não tem permissão/);
      expect(m.mensagem).toMatch(/não respondeu/);
    }
    h.getUser.mockResolvedValue({ data: { user: ADMIN }, error: null });
  });

  // =======================================================================
  it("3. a rota da MESA nao escreve NADA", async () => {
    const antes = contarNoBanco();
    const m = await mesa();
    expect(m.a_decidir).toHaveLength(5);
    expect(m.revogaveis).toHaveLength(0);
    expect(m.por_estado).toEqual({ pendente: 3, conflito: 2 });
    expect(contarNoBanco()).toEqual(antes);
  });

  // =======================================================================
  it("4. a FICHA mostra o que esta sendo afirmado e O QUE NAO BATE", async () => {
    const ficha = await fichaPara("resp-sem-dono", P.orfa);

    // Qual submissao, qual e-mail declarado, se foi verificado, qual participante.
    expect(ficha.submissao.submissao_id).toBe("resp-sem-dono");
    expect(ficha.submissao.email_coletado).toBe("ninguem@example.org");
    expect(ficha.submissao.email_verificado).toBe(true);
    expect(ficha.submissao.respostas_coletadas).toBe(52);
    expect(ficha.participante.id).toBe(P.orfa);
    expect(ficha.participante.email).toBe(EMAIL.orfa);
    expect(ficha.participante.respostas_canonicas).toBe(0);

    // O QUE NAO BATE, nomeado.
    expect(ficha.divergencias.map((d) => d.codigo)).toEqual(["email_diferente_do_participante"]);
    expect(ficha.divergencias[0].texto).toContain("ninguem@example.org");
    expect(ficha.divergencias[0].texto).toContain(EMAIL.orfa);

    // A afirmacao, em primeira pessoa e sem eufemismo.
    expect(ficha.afirmacao).toMatch(/Voce esta afirmando/);
    expect(ficha.afirmacao).toMatch(/NAO verificou/);
    expect(ficha.afirmacao).toContain("Pessoa orfa");

    // A consequencia MEDIDA, nao estimada: e o mesmo plano que seria gravado.
    expect(ficha.consequencia).not.toBeNull();
    expect(ficha.consequencia?.etapas_a_gravar).toBe(5);
    expect(ficha.consequencia?.itens_a_registrar).toBe(52);
    expect(ficha.consequencia?.apto_para_pontuar).toBe(true);
    expect(ficha.consequencia?.respostas_sobrescritas).toBe(0);
    expect(ficha.consequencia?.reversivel).toBe(true);
    expect(ficha.permitida).toBe(true);
    expect(ficha.impressao_da_ficha).toMatch(/^[0-9a-f]{64}$/);

    // E a ficha do participante OCUPADO, na mesma mesa, ja diz que nao da -- ANTES
    // de qualquer clique.
    const ocupada = await fichaPara("resp-sem-dono", P.ocupado);
    expect(ocupada.permitida).toBe(false);
    expect(ocupada.impedimento?.codigo).toBe("participante_ocupado");
    expect(ocupada.consequencia?.reversivel).toBe(false);
    expect(ocupada.divergencias.map((d) => d.codigo)).toContain("participante_ja_tem_respostas");
  });

  // =======================================================================
  it("5. NEGATIVA: corpo com campo de OPERADOR e recusado; o operador gravado e o da SESSAO", async () => {
    const antes = contarNoBanco();
    const ficha = await fichaPara("resp-adulterada", P.adulterada);
    const corpoLegitimo = {
      event_id: EVENTO,
      submission_id: ficha.submissao.id,
      participant_id: P.adulterada,
      justificativa: "conferido com a lista de inscritos impressa no credenciamento",
      ficha_impressao: ficha.impressao_da_ficha,
    };

    // Cada campo de operador, um por um: todos recusados, e nada escrito.
    for (const campo of [
      "operador",
      "operador_id",
      "operador_email",
      "importado_por",
      "decidido_por",
      "acao",
      "criado_em",
    ]) {
      const r = await reconciliarCru({
        ...corpoLegitimo,
        [campo]: campo === "criado_em" ? "2020-01-01T00:00:00Z" : "ffffffff-0000-4000-8000-ffffffffffff",
      });
      expect(r.status, campo).toBe(400);
      expect(r.corpo.code, campo).toBe("INVALID_REQUEST");
    }
    expect(contarNoBanco()).toEqual(antes);

    // CONTROLE POSITIVO: o MESMO corpo, sem o campo, e aceito...
    const ok = await reconciliarCru(corpoLegitimo);
    expect(ok.status).toBe(200);

    // ...e o operador gravado e o da SESSAO, nos DOIS registros (o ato e a linha).
    const gravado = json<{ operador: string; email: string; importado_por: string; justificativa: string }>(`
      select to_json(t)::text from (
        select e.operador, e.operador_email as email, s.importado_por, e.justificativa
          from external_submission_events e
          join external_submissions s on s.id = e.submission_id
         where s.submissao_id = 'resp-adulterada' and e.acao = 'reconciliada_pelo_operador') t`);
    expect(gravado.operador).toBe(OPERADOR);
    expect(gravado.email).toBe(ADMIN.email);
    expect(gravado.importado_por).toBe(OPERADOR);
    expect(gravado.justificativa).toContain("credenciamento");
  });

  // =======================================================================
  it("6. CONTROLE POSITIVO: a pendencia RESOLVIDA vira resposta canonica, por DECISAO do operador", async () => {
    const ficha = await fichaPara("resp-sem-dono", P.orfa);
    const d = await reconciliar(
      ficha,
      "a pessoa respondeu com o e-mail pessoal; confirmei a identidade no credenciamento",
    );
    expect(d.tipo).toBe("reconciliado");
    if (d.tipo !== "reconciliado") return;

    // O ato e o efeito, declarados separadamente.
    expect(d.ato.acao).toBe("reconciliada_pelo_operador");
    expect(d.ato.operador).toBe(OPERADOR);
    expect(d.gravado.linhas_de_resposta_gravadas).toBe(5);
    expect(conferirFichaContraGravado(ficha, d.gravado)).toEqual({ bate: true });

    // O BANCO: cinco etapas, de origem externa, do participante escolhido.
    const linhas = json<{ stage_id: number; origem: string; via: string; por: string }[]>(`
      select json_agg(json_build_object('stage_id', stage_id, 'origem', origem,
               'via', importacao ->> 'identidade_via', 'por', importacao ->> 'importado_por')
             order by stage_id)::text
        from quiz_responses where participant_id = '${P.orfa}'`);
    expect(linhas.map((l) => l.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(linhas.every((l) => l.origem === "externo")).toBe(true);
    // A PROVENIENCIA diz DECISAO DO OPERADOR, e nao "e-mail verificado": ninguem
    // vai ler depois que o sistema verificou, porque nao verificou.
    expect(linhas.every((l) => l.via === "decisao_do_operador")).toBe(true);
    expect(linhas.every((l) => l.por === OPERADOR)).toBe(true);

    const sub = json<{ estado: string; apto: boolean; via: string; participante: string }>(`
      select to_json(t)::text from (
        select estado, apto_para_pontuar as apto, identidade_via as via, participant_id as participante
          from external_submissions where submissao_id = 'resp-sem-dono') t`);
    expect(sub).toEqual({
      estado: "importavel",
      apto: true,
      via: "decisao_do_operador",
      participante: P.orfa,
    });

    // O HISTORICO: a retencao, o ato do operador e o efeito. Em ordem.
    expect(historicoDe("resp-sem-dono")).toEqual([
      "retida_pendente",
      "reconciliada_pelo_operador",
      "importada",
    ]);

    // E ela sai da mesa de pendencias e entra na de revogaveis.
    const m = await mesa();
    expect(m.a_decidir.map((g) => g.submissao.submissao_id)).not.toContain("resp-sem-dono");
    expect(m.revogaveis.map((r) => r.submissao.submissao_id)).toContain("resp-sem-dono");
  });

  // =======================================================================
  it("7. a mesma decisao REVOGADA: o historico mostra os dois atos, e nada e apagado", async () => {
    const ficha = await fichaDeRevogacao("resp-sem-dono");
    // A ficha AVISA, antes do clique, quantas respostas a revogacao remove.
    expect(ficha.respostas_canonicas_a_remover).toBe(5);
    expect(ficha.respostas_de_outra_origem).toBe(0);
    expect(ficha.identidade_via).toBe("decisao_do_operador");
    expect(ficha.avisos.join(" ")).toMatch(/REMOVE 5 resposta/);
    expect(ficha.avisos.join(" ")).toMatch(/historico NAO e reescrito/);

    const d = await revogarSubmissao(
      { eventId: EVENTO, ficha, justificativa: "era outra pessoa: o e-mail pessoal pertence a um homonimo" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(d.tipo).toBe("revogado");
    if (d.tipo !== "revogado") return;
    expect(d.revogado.respostas_canonicas_removidas).toBe(5);
    expect(d.revogado.antes.participant_id).toBe(P.orfa);
    expect(d.revogado.antes.identidade_via).toBe("decisao_do_operador");

    // As respostas canonicas sairam; a SUBMISSAO continua, com o payload cru.
    expect(numero(`select count(*) from quiz_responses where participant_id = '${P.orfa}'`)).toBe(0);
    const sub = json<{ estado: string; participante: string | null; brutas: number; motivo: string }>(`
      select to_json(t)::text from (
        select estado, participant_id as participante, bloqueio ->> 'motivo' as motivo,
               (select count(*) from jsonb_object_keys(respostas_brutas)) as brutas
          from external_submissions where submissao_id = 'resp-sem-dono') t`);
    expect(sub.estado).toBe("revogada");
    expect(sub.participante).toBeNull();
    expect(sub.brutas).toBe(52);
    expect(sub.motivo).toMatch(/REVOGADA pelo operador/);

    // O HISTORICO tem OS QUATRO atos, em ordem: a revogacao SE SOMOU.
    expect(historicoDe("resp-sem-dono")).toEqual([
      "retida_pendente",
      "reconciliada_pelo_operador",
      "importada",
      "revogada",
    ]);
    const atos = json<{ acao: string; justificativa: string | null }[]>(`
      select json_agg(json_build_object('acao', e.acao, 'justificativa', e.justificativa)
                      order by e.criado_em, e.acao)::text
        from external_submission_events e
        join external_submissions s on s.id = e.submission_id
       where s.submissao_id = 'resp-sem-dono'`);
    // As DUAS decisoes humanas continuam legiveis, cada uma com a sua razao.
    expect(atos.find((a) => a.acao === "reconciliada_pelo_operador")?.justificativa).toMatch(
      /credenciamento/,
    );
    expect(atos.find((a) => a.acao === "revogada")?.justificativa).toMatch(/homonimo/);

    // E ela volta para a mesa: da para decidir de novo.
    const m = await mesa();
    expect(m.a_decidir.map((g) => g.submissao.submissao_id)).toContain("resp-sem-dono");
    const voltou = await fichaPara("resp-sem-dono", P.orfa);
    expect(voltou.divergencias.map((d2) => d2.codigo)).toContain("submissao_ja_foi_revogada");

    // NEGATIVA PAREADA: revogar o que nao esta reconciliado e RECUSADO.
    const denovo = await revogarSubmissao(
      { eventId: EVENTO, ficha, justificativa: "tentativa de revogar duas vezes" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(denovo.tipo).toBe("recusado");
    if (denovo.tipo === "recusado") {
      expect(denovo.codigo).toBe("IMPORT_DECISION_REFUSED");
      expect(denovo.mensagem).toMatch(/Não há reconciliação a revogar/);
    }
    expect(historicoDe("resp-sem-dono")).toHaveLength(4);
  });

  // =======================================================================
  it("8. CONFLITO resolvido escolhendo UMA; a outra permanece recusada e rastreavel", async () => {
    const m0 = await mesa();
    const conflitos = m0.a_decidir.filter((g) => g.submissao.estado === "conflito");
    expect(conflitos.map((g) => g.submissao.submissao_id).sort()).toEqual([
      "resp-dupla-1",
      "resp-dupla-2",
    ]);
    // O motivo nomeia as duas submissoes: o operador ve o conflito inteiro.
    expect(conflitos[0].identidade_automatica.motivo).toMatch(/resp-dupla-1, resp-dupla-2/);

    // Escolhe UMA. O alvo e um participante LIVRE.
    const ficha = await fichaPara("resp-dupla-1", P.livre);
    const d = await reconciliar(ficha, "a pessoa respondeu duas vezes; esta e a submissao completa");
    expect(d.tipo).toBe("reconciliado");
    if (d.tipo !== "reconciliado") return;
    expect(d.gravado.linhas_de_resposta_gravadas).toBe(5);

    // A OUTRA continua em CONFLITO, sem participante, com o motivo registrado.
    const outra = json<{ estado: string; participante: string | null; motivo: string }>(`
      select to_json(t)::text from (
        select estado, participant_id as participante, bloqueio ->> 'motivo' as motivo
          from external_submissions where submissao_id = 'resp-dupla-2') t`);
    expect(outra.estado).toBe("conflito");
    expect(outra.participante).toBeNull();
    expect(outra.motivo).toMatch(/identidade em CONFLITO/);
    // RASTREAVEL: o payload cru continua la e o historico diz por que ela ficou.
    expect(
      numero(`select count(*) from jsonb_object_keys(
        (select respostas_brutas from external_submissions where submissao_id = 'resp-dupla-2'))`),
    ).toBe(52);
    expect(historicoDe("resp-dupla-2")).toEqual(["retida_conflito"]);
    // E ela continua NA MESA, esperando decisao -- nao foi descartada.
    const m1 = await mesa();
    expect(m1.a_decidir.map((g) => g.submissao.submissao_id)).toContain("resp-dupla-2");
  });

  // =======================================================================
  it("9. NEGATIVA: ALVO OCUPADO e recusado nas duas formas, e nada e escrito", async () => {
    const antes = contarNoBanco();

    // 9a. participante com resposta PROPRIA (do aplicativo).
    const comResposta = await fichaPara("resp-dupla-2", P.ocupado);
    const r1 = await reconciliar(comResposta, "tentativa de atribuir a quem ja respondeu no aplicativo");
    expect(r1.tipo).toBe("recusado");
    if (r1.tipo === "recusado") {
      expect(r1.codigo).toBe("IMPORT_TARGET_OCCUPIED");
      expect(r1.mensagem).toMatch(/já tem resposta registrada/);
      expect(r1.mensagem).toMatch(/não tem volta|não devolveria|some para sempre/);
      expect(r1.acao).toBe("escolher_outro_alvo");
    }

    // 9b. participante que JA recebeu uma submissao externa (o do cenario 8).
    const comSubmissao = await fichaPara("resp-dupla-2", P.livre);
    expect(comSubmissao.permitida).toBe(false);
    expect(comSubmissao.participante.submissao_externa_ativa).toBe("resp-dupla-1");
    const r2 = await reconciliar(comSubmissao, "tentativa de atribuir a mesma pessoa duas vezes");
    expect(r2.tipo).toBe("recusado");
    if (r2.tipo === "recusado") expect(r2.codigo).toBe("IMPORT_TARGET_OCCUPIED");

    expect(contarNoBanco()).toEqual(antes);

    // CONTROLE POSITIVO, no mesmo ato e no mesmo ambiente: alvo LIVRE e aceito.
    // (`vencida` ainda nao tem nada; e usada aqui e no cenario 10.)
    const livre = await fichaPara("resp-vencida", P.vencida);
    expect(livre.permitida).toBe(true);
  });

  // =======================================================================
  it("10. NEGATIVA: ficha VENCIDA e recusada, e nada e escrito (e a ficha nova e aceita)", async () => {
    const antes = contarNoBanco();
    const velha = await fichaPara("resp-vencida", P.vencida);

    // Algo muda entre a conferencia e a confirmacao: o cadastro do participante.
    sql(`update participants set email = 'vencida-novo@example.org' where id = '${P.vencida}'`);

    const r = await reconciliar(velha, "confirmando a partir da tela que ja nao vale");
    expect(r.tipo).toBe("recusado");
    if (r.tipo === "recusado") {
      expect(r.codigo).toBe("IMPORT_DECISION_STALE");
      expect(r.mensagem).toMatch(/não descreve mais o que seria gravado/);
      expect(r.acao).toBe("refazer_ficha");
    }
    expect(contarNoBanco()).toEqual(antes);

    // CONTROLE POSITIVO: a ficha NOVA, da mesa recarregada, e aceita.
    const nova = await fichaPara("resp-vencida", P.vencida);
    expect(nova.impressao_da_ficha).not.toBe(velha.impressao_da_ficha);
    expect(nova.participante.email).toBe("vencida-novo@example.org");
    const ok = await reconciliar(nova, "cadastro corrigido; identidade confirmada no credenciamento");
    expect(ok.tipo).toBe("reconciliado");
    expect(historicoDe("resp-vencida")).toEqual([
      "retida_pendente",
      "reconciliada_pelo_operador",
      "importada",
    ]);
  });

  // =======================================================================
  it("11. O CASO QUE MAIS MACHUCA: DUAS CAMADAS de portao, provadas separadamente", async () => {
    // O caso: o operador atribui a submissao da pessoa A ao participante B, e B
    // ja tem resposta. A gravacao escreveria por cima (upsert por
    // (participant_id, stage_id)) e a revogacao removeria a linha inteira: a
    // resposta anterior nao voltaria. MEDIDO AQUI, nesta prova, antes da
    // migration 024 existir: a linha de B virava `origem='externo'` com outro
    // conteudo, e depois da revogacao B ficava com ZERO resposta.
    //
    // Hoje ha DUAS camadas, e elas nao sao a mesma coisa duplicada:
    //
    //   CAMADA 1 -- esta borda, ANTES de escrever. O alvo ocupado aparece na
    //     FICHA (`permitida: false`, impedimento nomeado) e a rota recusa com
    //     IMPORT_TARGET_OCCUPIED, com mensagem que o operador le e sabe o que
    //     fazer. Nada e escrito: nem resposta, nem ato no historico.
    //   CAMADA 2 -- a revalidacao DENTRO da transacao (migration 024), que pega a
    //     CORRIDA que a camada 1 nao tem como pegar: a pessoa responde pelo
    //     aplicativo DEPOIS da ficha ter sido gerada e ANTES da confirmacao. A
    //     submissao e retida como conflito, nada dela e gravado, e a resposta que
    //     ja existia fica INTACTA.
    //
    // As duas sao provadas abaixo, uma por vez.

    // --- CAMADA 1: recusa ANTES de escrever, sem tocar no historico ----------
    const antesDaCamada1 = contarNoBanco();
    const ocupada = await fichaPara("resp-dupla-2", P.ocupado);
    expect(ocupada.permitida).toBe(false);
    expect(ocupada.consequencia?.respostas_sobrescritas).toBe(1);
    expect(ocupada.consequencia?.reversivel).toBe(false);

    const r1 = await reconciliar(ocupada, "tentativa de atribuir a quem ja respondeu no aplicativo");
    expect(r1.tipo).toBe("recusado");
    if (r1.tipo === "recusado") expect(r1.codigo).toBe("IMPORT_TARGET_OCCUPIED");
    // Nada escrito -- e, em especial, NENHUM ato no historico: a camada 1 recusa
    // antes de o ato ser registrado.
    expect(contarNoBanco()).toEqual(antesDaCamada1);
    expect(historicoDe("resp-dupla-2")).toEqual(["retida_conflito"]);
    // E a resposta de quem ja havia respondido continua la, do aplicativo.
    const intactaDepoisDa1 = json<{ origem: string; answers: Record<string, unknown> }>(`
      select to_json(t)::text from (
        select origem, answers from quiz_responses
         where participant_id = '${P.ocupado}' and stage_id = 101) t`);
    expect(intactaDepoisDa1.origem).toBe("app");
    expect(String(intactaDepoisDa1.answers.q1)).toMatch(/no aplicativo/);

    // --- CAMADA 2: a CORRIDA, que so o banco pode pegar ----------------------
    // A ficha e gerada quando `machuca` ainda nao tem resposta nenhuma: a camada 1
    // permite, e esta certa -- naquele instante nao havia nada por cima.
    // E-mail que nao e de participante nenhum: ela chega PENDENTE, para a decisao
    // do operador ser a unica coisa que a liga a alguem.
    const importada = await importar([linha("corrida@example.org", "resp-machuca")]);
    expect(importada.tipo).toBe("aplicado");
    const corrida = await fichaPara("resp-machuca", P.machuca);
    expect(corrida.permitida).toBe(true);
    expect(corrida.consequencia?.respostas_sobrescritas).toBe(0);
    expect(corrida.consequencia?.reversivel).toBe(true);

    // A CORRIDA: a pessoa responde PELO APLICATIVO depois de a rota ter lido a
    // mesa e registrado o ato, e antes de a funcao do banco gravar. E a janela que
    // a camada 1 nao tem como fechar, porque ela conferiu antes de a linha existir.
    noMeioDaGravacao = () => {
      sql(`
        insert into quiz_responses (participant_id, stage_id, answers, origem)
        values ('${P.machuca}', 101, '{"q1": "ANTES: isto a pessoa respondeu no aplicativo"}'::jsonb, 'app')
      `);
    };

    const r2 = await reconciliar(corrida, "confirmando a atribuicao conferida no credenciamento");
    expect(noMeioDaGravacao).toBeNull(); // o gancho rodou: a corrida aconteceu
    // O banco conferiu NA HORA DE GRAVAR e recusou. Nao e "pronto" e nao e
    // "nao respondeu": e conferido e recusado, com codigo proprio.
    expect(r2.tipo).toBe("recusado");
    if (r2.tipo === "recusado") {
      expect(r2.codigo).toBe("IMPORT_REVALIDATION_REFUSED");
      expect(r2.mensagem).toMatch(/respondeu PELO APLICATIVO/);
      expect(r2.mensagem).toMatch(/NENHUMA resposta foi gravada/);
      expect(r2.acao).toBe("refazer_ficha");
    }

    // A RESPOSTA DA PESSOA FICA. E este o ponto inteiro: ela nao foi sobrescrita.
    const sobreviveu = json<{ origem: string; answers: Record<string, unknown>; n: number }>(`
      select to_json(t)::text from (
        select origem, answers,
               (select count(*) from quiz_responses where participant_id = '${P.machuca}') as n
          from quiz_responses where participant_id = '${P.machuca}' and stage_id = 101) t`);
    expect(sobreviveu.origem).toBe("app");
    expect(String(sobreviveu.answers.q1)).toMatch(/^ANTES:/);
    // Nenhuma etapa da submissao entrou: nao e "gravei 4 de 5".
    expect(sobreviveu.n).toBe(1);

    // A SUBMISSAO fica retida como CONFLITO, com o codigo da recusa, e rastreavel.
    const retida = json<{ estado: string; participante: string | null; codigo: string; pretendido: string }>(`
      select to_json(t)::text from (
        select estado, participant_id as participante, bloqueio ->> 'codigo' as codigo,
               bloqueio -> 'revalidacao' ->> 'participante_pretendido' as pretendido
          from external_submissions where submissao_id = 'resp-machuca') t`);
    expect(retida.estado).toBe("conflito");
    expect(retida.participante).toBeNull();
    expect(retida.codigo).toBe("resposta_do_aplicativo");
    // O participante pretendido nao se perde: fica nomeado dentro do bloqueio.
    expect(retida.pretendido).toBe(P.machuca);

    // O HISTORICO guarda o ATO e a RECUSA, os dois. A decisao do operador nao e
    // apagada por nao ter pego, e fica escrito que nao pegou.
    expect(historicoDe("resp-machuca")).toEqual([
      "retida_pendente",
      "reconciliada_pelo_operador",
      "recusada_na_revalidacao",
    ]);
    const recusa = json<{ justificativa: string; etapas: number }>(`
      select to_json(t)::text from (
        select e.justificativa, (e.detalhes ->> 'etapas_gravadas')::int as etapas
          from external_submission_events e
          join external_submissions s on s.id = e.submission_id
         where s.submissao_id = 'resp-machuca' and e.acao = 'recusada_na_revalidacao') t`);
    expect(recusa.justificativa).toMatch(/RECUSADA NA REVALIDACAO/);
    expect(recusa.etapas).toBe(0);
  });


  // =======================================================================
  it("12. NEGATIVA: recurso AUSENTE no banco -> 'nao esta instalado', nunca 'nao respondeu'", async () => {
    // CONTROLE POSITIVO primeiro, no mesmo ambiente.
    expect((await pedirMesa(EVENTO, FETCH_MESA, () => {})).tipo).toBe("mesa");

    sql(`alter table public.external_submissions rename to external_submissions_fora`);
    try {
      const m = await pedirMesa(EVENTO, FETCH_MESA, () => {});
      expect(m.tipo).toBe("recurso_ausente");
      if (m.tipo === "recurso_ausente") {
        expect(m.codigo).toBe("IMPORT_SCHEMA_MISSING");
        expect(m.mensagem).toMatch(/migration 022/);
        expect(m.acao).toBe("instalar_no_banco");
      }
    } finally {
      sql(`alter table public.external_submissions_fora rename to external_submissions`);
    }

    // E o ambiente volta: o recurso existe outra vez.
    expect((await pedirMesa(EVENTO, FETCH_MESA, () => {})).tipo).toBe("mesa");
  });

  // =======================================================================
  it("13. O CONTRATO DE REVERSIBILIDADE: os tres estados se comportam DIFERENTE, e a tela sabe ANTES", async () => {
    // A exigencia da revisao: "A tela deve informar previamente quando a resolucao
    // puder produzir efeitos que nao sao reversiveis por uma acao simples" -- e os
    // tres estados sao tres coisas distintas, nao um aviso generico:
    //   1. correcao_simples        nada derivado: desfaz com um ato;
    //   2. operacao_controlada     ha registro: desfaz removendo, com historico e
    //                              TITULARIDADE provada;
    //   3. procedimento_excepcional ha documento: desfazer simples BLOQUEADO.
    // Em todos: o registro cru da submissao permanece.

    // --- ESTADO 2: ha registro, nenhum documento -----------------------------
    const estado2 = await fichaDeRevogacao("resp-vencida");
    expect(estado2.reversibilidade.estado).toBe("operacao_controlada");
    expect(estado2.permitida).toBe(true);
    expect(estado2.respostas_canonicas_a_remover).toBe(5);
    // INVENTARIO, nao contagem: cada registro nomeado, com etapa, dono e origem.
    expect(estado2.registros.map((r) => r.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(estado2.registros.every((r) => r.participante === P.vencida && r.origem === "externo")).toBe(true);
    expect(estado2.reversibilidade.efeitos_nao_reversiveis).toEqual([]);

    const r2 = await revogarSubmissao(
      { eventId: EVENTO, ficha: estado2, justificativa: "conferido depois: a submissao era de outra turma" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(r2.tipo).toBe("revogado");
    if (r2.tipo === "revogado") expect(r2.revogado.respostas_canonicas_removidas).toBe(5);

    // A TITULARIDADE fica PROVADA no livro-razao: o texto do operador, o separador
    // do sistema, e o inventario dos registros removidos.
    const registrada = um(`
      select e.justificativa from external_submission_events e
        join external_submissions s on s.id = e.submission_id
       where s.submissao_id = 'resp-vencida' and e.acao = 'revogada'`);
    expect(registrada).toMatch(/^conferido depois: a submissao era de outra turma/);
    expect(registrada).toContain("titularidade dos registros removidos");
    expect(registrada).toContain(P.vencida);
    expect(registrada).toContain("etapa 101");
    expect(registrada).toContain("etapa 105");
    expect(registrada).toContain("5 registro(s)");
    expect(registrada).toContain("reversibilidade operacao_controlada");
    // A EVIDENCIA permanece: o payload cru inteiro continua la.
    expect(
      numero(`select count(*) from jsonb_object_keys(
        (select respostas_brutas from external_submissions where submissao_id = 'resp-vencida'))`),
    ).toBe(52);

    // --- ESTADO 3: ha documento gerado -> desfazer simples BLOQUEADO ---------
    // `resp-dupla-1` esta reconciliada com `livre` desde o cenario 8.
    sql(`
      insert into prognostics (participant_id, raw_ai_output, status, generated_at, delivered_at, public_share_token)
      values ('${P.livre}', '{"texto": "prognostico gerado e entregue"}'::jsonb, 'delivered',
              now(), now(), 'token-publico-de-prova')
    `);
    const antesDoEstado3 = contarNoBanco();
    const estado3 = await fichaDeRevogacao("resp-dupla-1");
    expect(estado3.reversibilidade.estado).toBe("procedimento_excepcional");
    expect(estado3.permitida).toBe(false);
    expect(estado3.impedimento?.codigo).toBe("derivado_ja_gerado");
    // A tela nomeia O QUE existe, e nomeia o acesso que precisaria ser suspenso.
    expect(estado3.reversibilidade.efeitos_nao_reversiveis.join(" ")).toMatch(/documento ENTREGUE/);
    expect(estado3.reversibilidade.efeitos_nao_reversiveis.join(" ")).toMatch(/link publico/);

    const r3 = await revogarSubmissao(
      { eventId: EVENTO, ficha: estado3, justificativa: "tentativa de desfazer com documento ja entregue" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(r3.tipo).toBe("recusado");
    if (r3.tipo === "recusado") {
      expect(r3.codigo).toBe("IMPORT_REVOKE_BLOCKED");
      expect(r3.mensagem).toMatch(/já existe documento gerado/);
      expect(r3.mensagem).toMatch(/invalidar o documento derivado/);
      expect(r3.acao).toBe("falar_com_equipe");
    }
    // NADA foi alterado, e as respostas continuam onde estavam.
    expect(contarNoBanco()).toEqual(antesDoEstado3);
    expect(numero(`select count(*) from quiz_responses where participant_id = '${P.livre}'`)).toBe(5);
    expect(um(`select estado from external_submissions where submissao_id = 'resp-dupla-1'`)).toBe("importavel");

    // CONTROLE POSITIVO: invalidado o derivado, a MESMA revogacao passa a ser
    // operacao controlada e e permitida.
    sql(`delete from prognostics where participant_id = '${P.livre}'`);
    const semDerivado = await fichaDeRevogacao("resp-dupla-1");
    expect(semDerivado.reversibilidade.estado).toBe("operacao_controlada");
    expect(semDerivado.permitida).toBe(true);
    const r3b = await revogarSubmissao(
      { eventId: EVENTO, ficha: semDerivado, justificativa: "derivado invalidado antes; corrigindo a identidade" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(r3b.tipo).toBe("revogado");
    if (r3b.tipo === "revogado") expect(r3b.revogado.respostas_canonicas_removidas).toBe(5);

    // --- A RECONCILIACAO tambem avisa PREVIAMENTE, e por submissao -----------
    // `orfa` esta livre (a reconciliacao dela foi revogada no cenario 7) e passa a
    // ter um documento. A ficha avisa ANTES do clique, nesta submissao -- e a de
    // outro participante, na mesma mesa, continua dizendo operacao controlada.
    sql(`
      insert into prognostics (participant_id, raw_ai_output, status, generated_at)
      values ('${P.orfa}', '{"texto": "prognostico gerado"}'::jsonb, 'generated', now())
    `);
    const comDocumento = await fichaPara("resp-sem-dono", P.orfa);
    expect(comDocumento.reversibilidade?.estado).toBe("procedimento_excepcional");
    expect(comDocumento.reversibilidade?.texto).toMatch(/LEIA ANTES DE CONFIRMAR/);
    const semDocumento = await fichaPara("resp-sem-dono", P.vencida);
    expect(semDocumento.reversibilidade?.estado).toBe("operacao_controlada");
    expect(semDocumento.reversibilidade?.texto).not.toBe(comDocumento.reversibilidade?.texto);
    sql(`delete from prognostics where participant_id = '${P.orfa}'`);

    // --- ESTADO 1: nada a remover -> correcao simples ------------------------
    // `livre` voltou a ter zero resposta; `resp-dupla-2` pode ser atribuida a ele.
    const nova = await fichaPara("resp-dupla-2", P.livre);
    expect(nova.permitida).toBe(true);
    expect((await reconciliar(nova, "escolhida a submissao completa das duas da mesma pessoa")).tipo).toBe(
      "reconciliado",
    );
    // Uma limpeza administrativa remove as respostas por fora (e o unico jeito de
    // chegar ao estado 1 neste sistema, onde vincular e gravar sao o mesmo ato).
    sql(`delete from quiz_responses where participant_id = '${P.livre}'`);
    const estado1 = await fichaDeRevogacao("resp-dupla-2");
    expect(estado1.reversibilidade.estado).toBe("correcao_simples");
    expect(estado1.respostas_canonicas_a_remover).toBe(0);
    expect(estado1.registros).toEqual([]);
    expect(estado1.permitida).toBe(true);

    const r1 = await revogarSubmissao(
      { eventId: EVENTO, ficha: estado1, justificativa: "correcao simples: nao havia registro canonico" },
      FETCH_REVOGAR,
      () => {},
    );
    expect(r1.tipo).toBe("revogado");
    if (r1.tipo === "revogado") expect(r1.revogado.respostas_canonicas_removidas).toBe(0);
    const inventarioVazio = um(`
      select e.justificativa from external_submission_events e
        join external_submissions s on s.id = e.submission_id
       where s.submissao_id = 'resp-dupla-2' and e.acao = 'revogada'`);
    expect(inventarioVazio).toContain("nenhum registro canonico");
    expect(inventarioVazio).toContain("reversibilidade correcao_simples");

    // E A EVIDENCIA PERMANECE NOS TRES ESTADOS.
    const brutas = sql(`
      select submissao_id || '=' || (select count(*) from jsonb_object_keys(respostas_brutas))
        from external_submissions where event_id = '${EVENTO}' order by submissao_id`);
    expect(brutas.split("\n").every((l) => l.endsWith("=52"))).toBe(true);
  });

});
