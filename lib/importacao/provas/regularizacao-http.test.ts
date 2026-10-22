// PROVA DA REGULARIZACAO DA SEGUNDA RESPOSTA DO FORMULARIO PUBLICO: as ROTAS DE
// VERDADE (app/api/importacao/segunda-resposta/**), a RECEPCAO DE VERDADE
// (receberFormulario), as funcoes e gatilhos da 029 e a importacao atomica da
// 022/024, contra Postgres de verdade -- com os PAPEIS do app.
//
// Como rodar:
//   PROVA_REGULARIZACAO_URL="postgresql://...@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config lib/importacao/provas/vitest.prova.config.ts \
//       lib/importacao/provas/regularizacao-http.test.ts --reporter=verbose
//
// O banco: container descartavel com a imagem do Supabase (papeis anon,
// authenticated, service_role) e as migrations 001..029 aplicadas
// (scripts/drift/reference-db.sh up). Sem a URL o arquivo e PULADO. GUARDA DE
// ALVO: so 127.0.0.1/localhost/[::1]. Cada execucao usa um evento NOVO (ids
// aleatorios): re-rodavel sem apagar nada -- e a 029 proibe apagar submissao
// desconsiderada, de qualquer forma.
//
// O QUE E REAL: o servidor fala com o banco COMO service_role, com o claim que o
// PostgREST poria (`request.jwt.claims = {"role":"service_role"}`); o anonimo e
// o participante falam como `anon` e `authenticated`. SIMULADO: so o servico de
// login (`auth.getUser`), para cada cenario dizer quem bate na porta.
//
// AS OITO PROVAS da revisao, e as quatro do contrato do operador:
//   1. Marina respondeu; outro jovem digitou o e-mail dela -> duas submissoes
//      preservadas, NENHUM dado de Marina alterado;
//   2. o segundo jovem tem cadastro -> vinculo ao cadastro verdadeiro, apos
//      confirmacao com fonte independente;
//   3. o segundo jovem nao tem cadastro mas e confirmado pela organizacao ->
//      criacao controlada (sem exigir event_people);
//   4. o e-mail "corrigido" ja pertence a outra pessoa -> recusa, sem criacao;
//   5. dois operadores ao mesmo tempo -> so uma resolucao efetiva (concorrencia
//      REAL, duas sessoes);
//   6. desconsiderar -> conflito encerrado, historico preservado, inapagavel;
//   7. substituir respostas existentes -> recusa efetiva NO BANCO (com a borda
//      contornada);
//   8. participante e anonimo -> negativa efetiva (rota e banco), com controle
//      positivo de admin;
//   C1. "identidade conferida" sozinho e RECUSADO;
//   C2. fonte fora do vocabulario e RECUSADA;
//   C3. confirmar identidade NAO libera entrega sem o segundo fato;
//   C4. nada marca e-mail como verificado;
//   C5. uma previa de importacao anterior fica invalida depois da regularizacao.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { montarManifesto, type LinhaDeEtapa, type ManifestoQuestionario } from "../manifesto-questionario";
import type { Previa } from "../borda";
import {
  planoDaRegularizacao,
  prepararRegularizacao,
  type CasoDeSegundaResposta,
  type MesaDaRegularizacao,
} from "../regularizacao";
import type { ClienteDeConsulta } from "../decisao-do-operador";
import type { ClienteDeLeitura } from "../borda";
import {
  receberFormulario,
  type ClienteDeRecepcao,
} from "../../../app/api/formulario-publico/receber-formulario";
import {
  confirmarDestinatario,
  desconsiderar,
  pedirMesaDaSegundaResposta,
  regularizar,
  type DesfechoDaSegundaResposta,
} from "../../../components/features/admin/regularizar-segunda-resposta";
import { aplicarImportacao, pedirPrevia, type PedidoDaTela } from "../../../components/features/admin/importar-respostas";
import { pedirMesa, reconciliarSubmissao } from "../../../components/features/admin/decidir-identidade";

const URL_ALVO = process.env.PROVA_REGULARIZACAO_URL;

function exigirLocal(url: string): void {
  const host = new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`PROVA_REGULARIZACAO_URL nao e local (host=${host}). Esta prova escreve: abortando.`);
  }
}

const descreve = URL_ALVO ? describe : describe.skip;
// Maquina compartilhada e carregada: teto generoso, para nao dar vermelho por impaciencia.
vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 600_000 });
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-regulariza-")) : "";

// ---------------------------------------------------------------------------
// psql, com PAPEL
// ---------------------------------------------------------------------------
type Papel = "postgres" | "service_role" | "authenticated" | "anon";

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

const CLAIM_DO_SERVIDOR = { role: "service_role" };

function prefixo(papel: Papel, claims: object | null): string {
  if (papel === "postgres") return "";
  return `set role ${papel};\n` + (claims ? `set request.jwt.claims = ${lit(JSON.stringify(claims))};\n` : "");
}

function sqlComo(papel: Papel, claims: object | null, texto: string): string {
  const arquivo = join(TRABALHO, `q-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(arquivo, prefixo(papel, claims) + texto, "utf8");
  return execFileSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo], {
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "120", PGCLIENTENCODING: "UTF8" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Inspecao (le tudo, nao e caminho da aplicacao). */
const sql = (t: string) => sqlComo("postgres", null, t);
/** O servidor da aplicacao: service_role com o claim do PostgREST. */
const servidor = (t: string) => sqlComo("service_role", CLAIM_DO_SERVIDOR, t);

function um(t: string): string {
  return sql(t).split("\n")[0] ?? "";
}
function numero(t: string): number {
  return Number(um(t));
}
function erroDe(f: () => unknown): string {
  try {
    f();
    return "(sem erro)";
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return (err.stderr ?? err.message ?? String(e)).trim().split("\n")[0];
  }
}

function log(prova: string, ...linhas: unknown[]): void {
  for (const l of linhas) console.log(`[${prova}] ${typeof l === "string" ? l : JSON.stringify(l)}`);
}

// ---------------------------------------------------------------------------
// O cliente do servidor (rotas + recepcao), por psql, COMO service_role
// ---------------------------------------------------------------------------
function erroDoPsql(e: unknown): { message: string; code?: string } {
  const err = e as { stderr?: string; message?: string };
  return { message: (err.stderr ?? err.message ?? String(e)).trim() };
}

function valorSql(v: unknown): string {
  return v !== null && typeof v === "object" ? literalJson(v) : lit(v);
}

function clienteDoServidor() {
  function consulta(tabela: string, colunas: string) {
    const cols = colunas.split(",").map((c) => c.trim()).filter((c) => c !== "");
    const cond: string[] = [];
    let ordem = "";
    const rodar = () => {
      const onde = cond.length ? `where ${cond.join(" and ")}` : "";
      const campos = cols.map((c) => `'${c}', ${c}`).join(", ");
      const t = servidor(`select coalesce(json_agg(json_build_object(${campos})${ordem})::text, '[]') from public.${tabela} ${onde}`);
      return JSON.parse(t.split("\n").pop() || "[]") as unknown[];
    };
    const q: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        cond.push(`${c} = ${lit(v)}`);
        return q;
      },
      in(c: string, vs: readonly unknown[]) {
        cond.push(vs.length === 0 ? "false" : `${c} in (${vs.map(lit).join(", ")})`);
        return q;
      },
      is(c: string, v: null) {
        cond.push(`${c} is ${v === null ? "null" : lit(v)}`);
        return q;
      },
      not(c: string, op: string, v: unknown) {
        cond.push(`not (${c} ${op} ${v === null ? "null" : lit(v)})`);
        return q;
      },
      order(c: string) {
        ordem = ` order by ${c}`;
        return q;
      },
      maybeSingle() {
        try {
          return Promise.resolve({ data: rodar()[0] ?? null, error: null });
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

  function escrita(executar: () => string) {
    let feito: { data: unknown; error: unknown } | null = null;
    const vai = () => {
      if (feito) return feito;
      try {
        const t = executar();
        const ult = t.split("\n").pop() ?? "";
        feito = { data: ult.startsWith("{") ? JSON.parse(ult) : null, error: null };
      } catch (e) {
        feito = { data: null, error: erroDoPsql(e) };
      }
      return feito;
    };
    const p = {
      select() {
        return { single: () => Promise.resolve(vai()) };
      },
      then<R>(ok: (v: { data: unknown; error: unknown }) => R) {
        return Promise.resolve(vai()).then(ok);
      },
    };
    return p;
  }

  function inserir(tabela: string, valores: Record<string, unknown> | Record<string, unknown>[], conflito?: string) {
    const linhas = Array.isArray(valores) ? valores : [valores];
    return escrita(() => {
      let ultimo = "";
      for (const l of linhas) {
        const cols = Object.keys(l);
        const onConflict = conflito
          ? ` on conflict (${conflito}) do update set ${cols
              .filter((c) => !conflito.split(",").includes(c))
              .map((c) => `${c} = excluded.${c}`)
              .join(", ")}`
          : "";
        ultimo = servidor(
          `with x as (insert into public.${tabela} (${cols.join(", ")}) values (${cols
            .map((c) => valorSql(l[c]))
            .join(", ")})${onConflict} returning id) select row_to_json(x)::text from x`,
        );
      }
      return ultimo;
    });
  }

  return {
    from(tabela: string) {
      return {
        select: (colunas: string) => consulta(tabela, colunas),
        insert: (v: Record<string, unknown> | Record<string, unknown>[]) => inserir(tabela, v),
        upsert: (v: Record<string, unknown> | Record<string, unknown>[], o: { onConflict: string }) =>
          inserir(tabela, v, o.onConflict),
        update(valores: Record<string, unknown>) {
          const sets = Object.entries(valores).map(([c, v]) => `${c} = ${valorSql(v)}`).join(", ");
          return {
            eq(c: string, v: string) {
              return {
                is(c2: string, _v: null) {
                  return escrita(() => servidor(`update public.${tabela} set ${sets} where ${c} = ${lit(v)} and ${c2} is null`));
                },
              };
            },
          };
        },
      };
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      try {
        const lista = Object.entries(args).map(([k, v]) => `${k} => ${valorSql(v)}`).join(", ");
        const t = servidor(`select public.${nome}(${lista})::text`);
        const ult = t.split("\n").pop() ?? "";
        return { data: JSON.parse(ult === "" ? "null" : ult), error: null };
      } catch (e) {
        return { data: null, error: erroDoPsql(e) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Login simulado; rotas de verdade
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({ getUser: vi.fn(), cliente: { atual: null as unknown } }));
vi.mock("../../supabase/server", () => ({ createClient: async () => ({ auth: { getUser: h.getUser } }) }));
vi.mock("../../supabase/admin", () => ({ createAdminClient: () => h.cliente.atual }));

import { NextRequest } from "next/server";

type Handler = (r: NextRequest) => Promise<Response>;
const rotas: Record<string, Handler> = {};

async function carregarRotas(): Promise<void> {
  rotas.mesa = (await import("../../../app/api/importacao/segunda-resposta/route")).GET as Handler;
  rotas.regularizar = (await import("../../../app/api/importacao/segunda-resposta/regularizar/route")).POST as Handler;
  rotas.desconsiderar = (await import("../../../app/api/importacao/segunda-resposta/desconsiderar/route")).POST as Handler;
  rotas.destinatario = (await import("../../../app/api/importacao/segunda-resposta/destinatario/route")).POST as Handler;
  rotas.previa = (await import("../../../app/api/importacao/previa/route")).POST as Handler;
  rotas.aplicar = (await import("../../../app/api/importacao/aplicar/route")).POST as Handler;
  rotas.decisoes = (await import("../../../app/api/importacao/decisoes/route")).GET as Handler;
  rotas.reconciliar = (await import("../../../app/api/importacao/reconciliar/route")).POST as Handler;
}

const CAMINHO: Record<string, string> = {
  mesa: "/api/importacao/segunda-resposta",
  regularizar: "/api/importacao/segunda-resposta/regularizar",
  desconsiderar: "/api/importacao/segunda-resposta/desconsiderar",
  destinatario: "/api/importacao/segunda-resposta/destinatario",
  previa: "/api/importacao/previa",
  aplicar: "/api/importacao/aplicar",
  decisoes: "/api/importacao/decisoes",
  reconciliar: "/api/importacao/reconciliar",
};

const paraRota = (qual: string) => async (url: string, init?: RequestInit) => {
  const metodo = (init?.method ?? "POST").toUpperCase();
  const alvo = url.startsWith("/") ? `http://localhost${url}` : `http://localhost${CAMINHO[qual]}`;
  return rotas[qual](
    new NextRequest(alvo, {
      method: metodo,
      headers: { "content-type": "application/json" },
      ...(metodo === "GET" ? {} : { body: String(init?.body ?? "{}") }),
    }),
  );
};

async function cru(qual: string, corpo: unknown): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const res = await rotas[qual](
    new NextRequest(`http://localhost${CAMINHO[qual]}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
  );
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// O evento desta execucao
// ---------------------------------------------------------------------------
const EVENTO = randomUUID();
const CODIGO = `REG${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const OPERADOR_A = { id: randomUUID(), email: "coordenacao-a@fortinside.test", app_metadata: { role: "admin" } };
const OPERADOR_B = { id: randomUUID(), email: "coordenacao-b@fortinside.test", app_metadata: { role: "admin" } };
const JOVEM_SEM_PAPEL = { id: randomUUID(), email: "jovem@x.test", app_metadata: {} };

const P = {
  marina: randomUUID(),
  lucas: randomUUID(),
  pedro: randomUUID(),
  teoA: randomUUID(),
  teoB: randomUUID(),
};
const EMAIL_MARINA = "marina.souza@exemplo.org";
const EMAIL_PEDRO = "pedro.alves@exemplo.org";
const EMAIL_LUCAS = "lucas.prado@exemplo.org";
const EMAIL_JOANA = "joana.lima@exemplo.org";
const CONVIDADO_LUCAS = randomUUID();

let MANIFESTO: ManifestoQuestionario;
let FONTE_DA_MARINA = "";

function respostasDoFormulario(autor: string): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const p of MANIFESTO.perguntas) {
    if (p.type === "scale") r[p.id] = p.min === 0 ? 8 : 4;
    else if (p.type === "select") r[p.id] = p.options![0];
    else if (p.type === "short_text") r[p.id] = p.max_chars !== null && p.max_chars < 10 ? "15" : autor.slice(0, p.max_chars ?? 60);
    else r[p.id] = `Resposta escrita por ${autor}, com as palavras dela.`;
  }
  return r;
}

async function enviarFormulario(nome: string, email: string, autorDasRespostas: string = nome) {
  return receberFormulario(h.cliente.atual as unknown as ClienteDeRecepcao, {
    eventCode: CODIGO,
    fullName: nome,
    email,
    respostas: respostasDoFormulario(autorDasRespostas) as never,
  });
}

/** Fotografia de TUDO que e da Marina: cadastro e respostas, byte a byte. */
function fotografiaDaMarina(): string {
  return um(`
    select md5(coalesce((select row_to_json(p)::text from participants p where p.id = '${P.marina}'), '') ||
               coalesce((select string_agg(r.stage_id || ':' || r.answers::text || ':' || r.origem || ':' ||
                                           coalesce(r.external_submission_id::text,'-') || ':' || r.submitted_at::text,
                                           '|' order by r.stage_id)
                           from quiz_responses r where r.participant_id = '${P.marina}'), ''))`);
}

async function mesa(): Promise<MesaDaRegularizacao> {
  const d = await pedirMesaDaSegundaResposta(EVENTO, paraRota("mesa"), () => {});
  if (d.tipo !== "mesa") throw new Error(`a mesa nao veio: ${JSON.stringify(d)}`);
  return d.mesa;
}

async function casoDe(nomeDeclarado: string): Promise<CasoDeSegundaResposta> {
  const c = (await mesa()).casos.find((x) => x.submissao.nome_declarado === nomeDeclarado);
  if (!c) throw new Error(`a mesa nao tem caso de ${nomeDeclarado}`);
  return c;
}

const FUNDAMENTO_LISTA = {
  fonte_tipo: "lista_oficial_previa" as const,
  referencia: "Planilha de inscritos da coordenação enviada em 12/10, aba Turma B, linha 23",
};
const FUNDAMENTO_PRESENCIAL = {
  fonte_tipo: "confirmacao_presencial" as const,
  referencia: "Coordenadora Ana confirmou na reunião de pais de 21/10, presencialmente, com a mãe",
};

function resumo(d: DesfechoDaSegundaResposta): unknown {
  return d.tipo === "gravado" ? { tipo: d.tipo, ...d.resumo } : d;
}

function livro(submissionId: string): string {
  return sql(`
    select ato || ' | ' || resultado || ' | ' || coalesce(recusa_codigo, '-') || ' | fonte=' || fonte_tipo ||
           ' | pessoa=' || coalesce(pessoa_participant_id::text, '-') || ' | criada=' || pessoa_criada ||
           ' | operador=' || operador_email || ' | em=' || to_char(criado_em, 'HH24:MI:SS.MS')
      from external_identity_resolutions where submission_id = '${submissionId}' order by sequencia`);
}

describe("guarda de alvo", () => {
  it("a URL da prova, quando existe, e local", () => {
    if (URL_ALVO) exigirLocal(URL_ALVO);
    expect(true).toBe(true);
  });
});

descreve("PROVA: regularizacao da segunda resposta, contra Postgres real com os papeis do app", () => {
  beforeAll(async () => {
    exigirLocal(URL_ALVO as string);
    await carregarRotas();
    h.cliente.atual = clienteDoServidor();
    h.getUser.mockResolvedValue({ data: { user: OPERADOR_A }, error: null });

    sql(`
      insert into events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
      values ('${EVENTO}', 'Marco Zero (prova da regularizacao)', '${CODIGO}', '2026-10-24T13:00:00Z', 'active', 0, 2, 'async',
              '2026-10-20T12:00:00Z', '2026-10-23T23:59:00Z');
      insert into participants (id, event_id, full_name, email) values
        ('${P.marina}', '${EVENTO}', 'Marina Souza', '${EMAIL_MARINA}'),
        ('${P.lucas}',  '${EVENTO}', 'Lucas Prado',  '${EMAIL_LUCAS}'),
        ('${P.pedro}',  '${EVENTO}', 'Pedro Alves',  '${EMAIL_PEDRO}'),
        ('${P.teoA}',   '${EVENTO}', 'Teo Ramos',    'teo.ramos@exemplo.org'),
        ('${P.teoB}',   '${EVENTO}', 'Teodoro Reis', 'teodoro.reis@exemplo.org');
      insert into event_people (id, event_id, participant_id, full_name, email, origem)
      values ('${CONVIDADO_LUCAS}', '${EVENTO}', '${P.lucas}', 'Lucas Prado', '${EMAIL_LUCAS}', 'lista_convite');
    `);
    const linhas = JSON.parse(
      um(`select json_agg(json_build_object('id', id, 'stage_number', stage_number, 'title', title, 'questions', questions)
                 order by stage_number)::text from quiz_stages where quiz_version = 2`),
    ) as LinhaDeEtapa[];
    const r = montarManifesto(linhas, 2);
    if (!r.ok) throw new Error(`manifesto invalido: ${r.codigo}`);
    MANIFESTO = r.manifesto;
  });

  // =========================================================================
  it("1. Marina respondeu; outros jovens digitaram o e-mail dela -> submissoes preservadas, NENHUM dado de Marina alterado", async () => {
    const m = await enviarFormulario("Marina Souza", EMAIL_MARINA);
    expect(m.tipo).toBe("ok");
    const p = await enviarFormulario("Pedro Alves", EMAIL_PEDRO);
    expect(p.tipo).toBe("ok");
    FONTE_DA_MARINA = fotografiaDaMarina();

    // Quatro jovens erram o e-mail e digitam o da Marina.
    const segundas = [];
    // (A Marina "de novo" responde DIFERENTE: reenvio identico nao e conflito.)
    for (const [nome, autor] of [["Lucas Prado", "Lucas Prado"], ["Joana Lima", "Joana Lima"], ["Marina Souza", "Marina, segunda vez"], ["Teo", "Teo"]]) {
      segundas.push(await enviarFormulario(nome, EMAIL_MARINA, autor));
    }
    for (const s of segundas) expect(s.tipo).toBe("segunda_resposta_guardada");

    const preservadas = sql(`
      select nome_declarado || ' | estado=' || estado || ' | participant_id=' || coalesce(participant_id::text, 'NULO') ||
             ' | email_verificado=' || email_verificado || ' | respostas=' ||
             (select count(*) from jsonb_object_keys(respostas_brutas)) || ' | bloqueio=' || (bloqueio->>'codigo')
        from external_submissions where event_id = '${EVENTO}' order by criado_em`);
    log("PROVA 1", "Marina e Pedro responderam (caminho feliz); quatro segundas respostas com o e-mail da Marina:", ...preservadas.split("\n"));
    expect(preservadas.split("\n")).toHaveLength(4);
    expect(preservadas).not.toMatch(/participant_id=[0-9a-f]/);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);
    log("PROVA 1", `fotografia md5 do cadastro+respostas da Marina antes e depois das 4 segundas: ${FONTE_DA_MARINA} == ${fotografiaDaMarina()}`);

    // O operador VE por que, quem e a primeira, os candidatos e o efeito.
    const caso = await casoDe("Lucas Prado");
    log(
      "PROVA 1",
      `caso na mesa: porque=${caso.porque.codigo}; primeira=${caso.primeira?.nome} (${caso.primeira?.respostas_canonicas} etapas); resultado=${caso.resultado}`,
      `candidatos: ${caso.candidatos.map((c) => `${c.nome}[${c.vinculavel ? "vinculavel" : "NAO: " + c.impedimento?.slice(0, 40)}]`).join("; ")}`,
      `efeito de vincular: ${caso.efeitos.vincular.slice(0, 160)}...`,
    );
    expect(caso.primeira?.participant_id).toBe(P.marina);
    expect(caso.candidatos.find((c) => c.id === P.marina)?.vinculavel).toBe(false);
    expect(caso.candidatos.find((c) => c.id === P.lucas)?.vinculavel).toBe(true);
    expect(caso.candidatos.find((c) => c.id === P.lucas)?.convidado?.id).toBe(CONVIDADO_LUCAS);
  });

  // =========================================================================
  it("C5 (antes) + 2. segundo jovem TEM cadastro -> vinculo ao cadastro verdadeiro; previa anterior invalidada", async () => {
    // Uma previa de importacao montada ANTES, com uma linha para o Lucas.
    const pedido: PedidoDaTela = {
      event_id: EVENTO,
      formulario_id: "1FAIpQL-prova-regularizacao",
      formulario_nome: "Planilha antiga",
      impressao_declarada: MANIFESTO.impressao,
      cabecalhos: ["Endereço de e-mail", ...MANIFESTO.perguntas.map((q) => q.text)],
      linhas: [
        {
          submissao_id: "planilha-lucas-1",
          celulas: [EMAIL_LUCAS, ...MANIFESTO.perguntas.map((q) => respostasDoFormulario("Lucas na planilha")[q.id])],
        },
      ],
      email_verificado: true,
    };
    const vista = await pedirPrevia(pedido, paraRota("previa"), () => {});
    expect(vista.tipo).toBe("previa");

    const caso = await casoDe("Lucas Prado");
    const d = await regularizar(
      {
        eventId: EVENTO,
        caso,
        destino: { tipo: "vincular", participant_id: P.lucas },
        convidado_id: CONVIDADO_LUCAS,
        ...FUNDAMENTO_LISTA,
        motivo: "Lucas digitou o e-mail da Marina por engano; o nome declarado e o da lista, linha 23, turma B",
      },
      paraRota("regularizar"),
      () => {},
    );
    log("PROVA 2", "regularizar (vincular a Lucas, fonte lista_oficial_previa, convidado da lista no sistema):", resumo(d));
    expect(d.tipo).toBe("gravado");

    const gravado = sql(`
      select 'submissao: estado=' || estado || ' participant=' || participant_id || ' identidade_via=' || identidade_via ||
             ' email_verificado=' || email_verificado || ' email_coletado=' || email_coletado
        from external_submissions where id = '${caso.submissao.id}';
      select 'respostas do Lucas: ' || count(*) || ' etapas, origem=' || string_agg(distinct origem, ',') ||
             ', identidade_via na proveniencia=' || string_agg(distinct importacao->>'identidade_via', ',') ||
             ', email_reconciliado=' || coalesce(string_agg(distinct importacao->>'email_reconciliado', ','), 'NULO')
        from quiz_responses where participant_id = '${P.lucas}';
      select 'Lucas: user_id=' || coalesce(user_id::text, 'NULO') || ' completed_at=' || coalesce(completed_at::text, 'NULO')
        from participants where id = '${P.lucas}';`);
    log("PROVA 2", ...gravado.split("\n"), `livro: ${livro(caso.submissao.id)}`);
    expect(gravado).toMatch(/identidade_via=decisao_do_operador email_verificado=false/);
    expect(gravado).toMatch(/respostas do Lucas: 5 etapas, origem=externo/);
    expect(gravado).toMatch(/email_reconciliado=NULO/);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);

    // C5: a previa ANTIGA nao aplica mais nada.
    const aplicada = await aplicarImportacao(pedido, (vista as { previa: Previa }).previa, paraRota("aplicar"), () => {});
    log("PROVA C5", `previa montada antes da regularizacao, aplicada depois: ${JSON.stringify(aplicada).slice(0, 260)}`);
    expect(aplicada.tipo).not.toBe("aplicado");
    expect(numero(`select count(*) from quiz_responses where participant_id = '${P.lucas}' and importacao->>'submissao_id' = 'planilha-lucas-1'`)).toBe(0);

    // E o caso velho (impressao de antes) e recusado: o caso mudou.
    const velho = await regularizar(
      { eventId: EVENTO, caso, destino: { tipo: "vincular", participant_id: P.teoA }, convidado_id: null, ...FUNDAMENTO_LISTA, motivo: "tentativa com o caso velho, depois de decidido" },
      paraRota("regularizar"),
      () => {},
    );
    log("PROVA C5", "caso velho reenviado depois da decisao:", velho);
    expect(velho.tipo).toBe("recusado");
    if (velho.tipo === "recusado") expect(velho.codigo).toBe("IMPORT_DECISION_STALE");
  });

  // =========================================================================
  it("C1 + C2: 'identidade conferida' sozinho e fonte fora do vocabulario sao RECUSADOS (rota e banco)", async () => {
    const caso = await casoDe("Joana Lima");
    const corpo = {
      event_id: EVENTO,
      submission_id: caso.submissao.id,
      caso_impressao: caso.impressao_do_caso,
      destino: { tipo: "criar", nome: "Joana Lima", email: EMAIL_JOANA },
      motivo: "Joana digitou o e-mail da Marina; confirmada como inscrita pela organizacao",
    };
    const carimbo = await cru("regularizar", { ...corpo, fonte_tipo: "confirmacao_presencial", referencia: "Identidade conferida pelo operador." });
    const soFormulario = await cru("regularizar", { ...corpo, fonte_tipo: "lista_oficial_previa", referencia: `Joana Lima ${EMAIL_MARINA} conferido ok` });
    const whatsapp = await cru("regularizar", { ...corpo, fonte_tipo: "grupo_whatsapp", referencia: "Ela esta no grupo de WhatsApp da turma B desde agosto" });
    const comOperador = await cru("regularizar", { ...corpo, ...FUNDAMENTO_PRESENCIAL, operador_id: OPERADOR_B.id });
    const comVerificado = await cru("regularizar", { ...corpo, ...FUNDAMENTO_PRESENCIAL, email_verificado: true });
    log(
      "PROVA C1/C2 rota",
      `"Identidade conferida pelo operador." -> ${carimbo.status} ${carimbo.corpo.code} ${JSON.stringify(carimbo.corpo.detalhes)}`,
      `so nome+e-mail do proprio formulario -> ${soFormulario.status} ${soFormulario.corpo.code} ${JSON.stringify(soFormulario.corpo.detalhes)}`,
      `fonte_tipo=grupo_whatsapp -> ${whatsapp.status} ${whatsapp.corpo.code}`,
      `corpo com operador_id -> ${comOperador.status} ${comOperador.corpo.code}`,
      `corpo com email_verificado=true -> ${comVerificado.status} ${comVerificado.corpo.code}`,
    );
    expect(carimbo.status).toBe(400);
    expect((carimbo.corpo.detalhes as { fato_do_banco: string }).fato_do_banco).toBe("referencia_sem_substancia");
    expect((soFormulario.corpo.detalhes as { fato_do_banco: string }).fato_do_banco).toBe("referencia_sem_substancia");
    expect(whatsapp.corpo.code).toBe("INVALID_REQUEST");
    expect(comOperador.corpo.code).toBe("INVALID_REQUEST");
    expect(comVerificado.corpo.code).toBe("INVALID_REQUEST");

    // NO BANCO, com a borda contornada (service_role chamando a funcao direto).
    const base = `p_submission_id => '${caso.submissao.id}', p_atualizado_em_visto => '${caso.submissao.atualizado_em}',
      p_operador => '${OPERADOR_A.id}', p_operador_email => 'x', p_modo => 'criar', p_participant_id => '${randomUUID()}',
      p_novo_nome => 'Joana Lima', p_novo_email => '${EMAIL_JOANA}', p_novo_telefone => null, p_convidado_id => null,
      p_motivo => 'Joana digitou o e-mail da Marina por engano', p_plano => '{}'::jsonb`;
    const e1 = erroDe(() => servidor(`select public.formulario_publico_regularizar(${base}, p_fonte_tipo => 'confirmacao_presencial', p_referencia => 'Identidade conferida pelo operador.')`));
    const e2 = erroDe(() => servidor(`select public.formulario_publico_regularizar(${base}, p_fonte_tipo => 'grupo_whatsapp', p_referencia => 'Ela esta no grupo de WhatsApp da turma B desde agosto')`));
    const e3 = erroDe(() => sql(`insert into external_identity_resolutions (event_id, submission_id, submissao_id, ato, resultado, fonte_tipo, referencia, motivo, estado_anterior, operador)
      values ('${EVENTO}', '${caso.submissao.id}', 'x', 'desconsiderar', 'confirmado', 'nome_no_formulario', 'referencia qualquer com mais de vinte', 'motivo qualquer com mais de vinte', '{}', '${OPERADOR_A.id}')`));
    log("PROVA C1/C2 banco", `funcao, "identidade conferida": ${e1}`, `funcao, grupo_whatsapp: ${e2}`, `CHECK da tabela (como superusuario), fonte fora do vocabulario: ${e3}`);
    expect(e1).toMatch(/referencia_sem_substancia/);
    expect(e2).toMatch(/fonte_fora_do_vocabulario/);
    expect(e3).toMatch(/external_identity_resolutions_fonte_check/);
    expect(numero(`select count(*) from participants where event_id = '${EVENTO}' and email = '${EMAIL_JOANA}'`)).toBe(0);
  });

  // =========================================================================
  it("4. e-mail 'corrigido' ja pertence a outra pessoa -> recusa, sem criacao duplicada", async () => {
    const antes = numero(`select count(*) from participants where event_id = '${EVENTO}'`);
    const caso = await casoDe("Joana Lima");
    const porEmail = await regularizar(
      { eventId: EVENTO, caso, destino: { tipo: "criar", nome: "Joana Lima", email: EMAIL_PEDRO, telefone: null }, convidado_id: null, ...FUNDAMENTO_PRESENCIAL, motivo: "operador achou que o e-mail certo era o do Pedro" },
      paraRota("regularizar"),
      () => {},
    );
    const porNome = await regularizar(
      { eventId: EVENTO, caso, destino: { tipo: "criar", nome: "lucas  PRADO", email: "outro.lucas@exemplo.org", telefone: null }, convidado_id: null, ...FUNDAMENTO_PRESENCIAL, motivo: "criar de novo alguem que ja tem cadastro" },
      paraRota("regularizar"),
      () => {},
    );
    log("PROVA 4 rota", `criar com o e-mail do Pedro: ${JSON.stringify(porEmail)}`, `criar 'lucas  PRADO' (ja cadastrado): ${JSON.stringify(porNome)}`);
    expect(porEmail.tipo).toBe("recusado");
    expect(porNome.tipo).toBe("recusado");

    // NO BANCO, com a borda contornada: o plano e montado certo, o destino e o e-mail do Pedro.
    const prep = await prepararRegularizacao(h.cliente.atual as unknown as ClienteDeConsulta & ClienteDeLeitura, EVENTO, { id: OPERADOR_A.id, email: null });
    if (!prep.ok) throw new Error("prep");
    const linha = prep.linhas.find((l) => l.id === caso.submissao.id)!;
    const novo = randomUUID();
    const plano = planoDaRegularizacao(prep, linha, novo, "x".repeat(20), { id: OPERADOR_A.id, email: null });
    if (!plano.ok) throw new Error("plano");
    const r = await (h.cliente.atual as ReturnType<typeof clienteDoServidor>).rpc("formulario_publico_regularizar", {
      p_submission_id: linha.id, p_atualizado_em_visto: linha.atualizado_em, p_operador: OPERADOR_A.id, p_operador_email: OPERADOR_A.email,
      p_modo: "criar", p_participant_id: novo, p_novo_nome: "Joana Lima", p_novo_email: EMAIL_PEDRO.toUpperCase(), p_novo_telefone: null,
      p_convidado_id: null, ...{ p_fonte_tipo: FUNDAMENTO_PRESENCIAL.fonte_tipo, p_referencia: FUNDAMENTO_PRESENCIAL.referencia },
      p_motivo: "tentativa direta no banco com o e-mail do Pedro", p_plano: plano.plano,
    });
    log("PROVA 4 banco", `funcao direta, e-mail do Pedro em maiusculas: ${JSON.stringify(r.data ?? r.error)}`, `livro: ${livro(caso.submissao.id)}`);
    expect((r.data as { codigo: string }).codigo).toBe("email_ja_cadastrado");
    expect(numero(`select count(*) from participants where event_id = '${EVENTO}'`)).toBe(antes);
    expect(numero(`select count(*) from participants where id = '${novo}'`)).toBe(0);
    expect(um(`select estado from external_submissions where id = '${caso.submissao.id}'`)).toBe("conflito");
  });

  // =========================================================================
  it("3. segundo jovem SEM cadastro, confirmado pela organizacao -> criacao controlada (sem event_people)", async () => {
    const caso = await casoDe("Joana Lima");
    expect(caso.candidatos.some((c) => c.nome.toLowerCase().includes("joana"))).toBe(false);
    const d = await regularizar(
      {
        eventId: EVENTO,
        caso,
        destino: { tipo: "criar", nome: "Joana Lima", email: EMAIL_JOANA, telefone: null },
        convidado_id: null,
        ...FUNDAMENTO_PRESENCIAL,
        motivo: "Joana digitou o e-mail da Marina; nao ha cadastro dela no evento, e a coordenacao confirmou que ela e inscrita",
      },
      paraRota("regularizar"),
      () => {},
    );
    log("PROVA 3", "regularizar (criar Joana, fonte confirmacao_presencial, lista oficial NAO no sistema):", resumo(d));
    expect(d.tipo).toBe("gravado");
    const id = (d as unknown as { resumo: { participant_id: string } }).resumo.participant_id;
    const estado = sql(`
      select 'Joana criada: ' || full_name || ' <' || email || '> user_id=' || coalesce(user_id::text, 'NULO') ||
             ' completed_at=' || coalesce(completed_at::text, 'NULO') from participants where id = '${id}';
      select 'respostas da Joana: ' || count(*) from quiz_responses where participant_id = '${id}';
      select 'auth.users com o e-mail da Joana: ' || count(*) from auth.users where email = '${EMAIL_JOANA}';`);
    log("PROVA 3", ...estado.split("\n"), `livro: ${livro(caso.submissao.id)}`);
    expect(estado).toMatch(/user_id=NULO/);
    expect(estado).toMatch(/respostas da Joana: 5/);
    expect(estado).toMatch(/auth.users com o e-mail da Joana: 0/);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);
  });

  // =========================================================================
  it("5. dois operadores decidem ao MESMO TEMPO (duas sessoes reais) -> so uma resolucao efetiva", async () => {
    const caso = await casoDe("Teo");
    const prep = await prepararRegularizacao(h.cliente.atual as unknown as ClienteDeConsulta & ClienteDeLeitura, EVENTO, { id: OPERADOR_A.id, email: null });
    if (!prep.ok) throw new Error("prep");
    const linha = prep.linhas.find((l) => l.id === caso.submissao.id)!;
    const chamada = (op: typeof OPERADOR_A, alvo: string) => {
      const pl = planoDaRegularizacao(prep, linha, alvo, "dois operadores", { id: op.id, email: op.email });
      if (!pl.ok) throw new Error("plano");
      return `select public.formulario_publico_regularizar(
        p_submission_id => '${linha.id}', p_atualizado_em_visto => '${linha.atualizado_em}',
        p_operador => '${op.id}', p_operador_email => '${op.email}', p_modo => 'vincular', p_participant_id => '${alvo}',
        p_novo_nome => null, p_novo_email => null, p_novo_telefone => null, p_convidado_id => null,
        p_fonte_tipo => 'contato_previamente_conhecido',
        p_referencia => 'Liguei para o telefone da ficha de inscricao de agosto e falei com o responsavel',
        p_motivo => 'Teo digitou o e-mail da Marina; operador ${op.email} decidiu', p_plano => ${literalJson(pl.plano)})::text`;
    };
    const rodar = (texto: string) =>
      new Promise<{ saida: string; ms: number }>((ok) => {
        const t0 = Date.now();
        const arquivo = join(TRABALHO, `c-${Math.random().toString(36).slice(2)}.sql`);
        writeFileSync(arquivo, prefixo("service_role", CLAIM_DO_SERVIDOR) + texto, "utf8");
        const ps = spawn("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo]);
        let saida = "";
        ps.stdout.on("data", (b) => (saida += String(b)));
        ps.stderr.on("data", (b) => (saida += String(b)));
        ps.on("close", () => ok({ saida: saida.trim(), ms: Date.now() - t0 }));
      });
    // A: decide e SEGURA a transacao 2s. B: chega 0,5s depois, para outro destino.
    const pA = rodar(`begin;\n${chamada(OPERADOR_A, P.teoA)};\nselect pg_sleep(2);\ncommit;`);
    await new Promise((r) => setTimeout(r, 500));
    const pB = rodar(`${chamada(OPERADOR_B, P.teoB)};`);
    const [a, b] = await Promise.all([pA, pB]);
    log("PROVA 5", `operador A (Teo Ramos): ${a.ms}ms -> ${a.saida.split("\n")[0]}`, `operador B (Teodoro Reis), entrou 0,5s depois: ${b.ms}ms (ESPEROU a trava) -> ${b.saida}`);
    expect(a.saida).toMatch(/"ok" ?: ?true/);
    expect(b.saida).toMatch(/submissao_ja_decidida/);
    expect(b.ms).toBeGreaterThan(1200);
    const final = sql(`
      select 'submissao: participant=' || participant_id || ' estado=' || estado from external_submissions where id = '${linha.id}';
      select 'respostas Teo Ramos=' || (select count(*) from quiz_responses where participant_id = '${P.teoA}') ||
             ' Teodoro Reis=' || (select count(*) from quiz_responses where participant_id = '${P.teoB}');`);
    log("PROVA 5", ...final.split("\n"), `livro: ${livro(linha.id)}`);
    expect(final).toMatch(new RegExp(`participant=${P.teoA}`));
    expect(final).toMatch(/Teodoro Reis=0/);

    // E pela rota: o segundo operador com o caso que ele tinha na tela.
    h.getUser.mockResolvedValue({ data: { user: OPERADOR_B }, error: null });
    const tarde = await regularizar(
      { eventId: EVENTO, caso, destino: { tipo: "vincular", participant_id: P.teoB }, convidado_id: null, fonte_tipo: "contato_previamente_conhecido", referencia: "Liguei para o telefone da ficha de inscricao de agosto", motivo: "operador B, com a tela antiga aberta" },
      paraRota("regularizar"),
      () => {},
    );
    h.getUser.mockResolvedValue({ data: { user: OPERADOR_A }, error: null });
    log("PROVA 5 rota", `operador B pela tela, depois: ${JSON.stringify(tarde)}`);
    expect(tarde.tipo).toBe("recusado");
    if (tarde.tipo === "recusado") expect(tarde.codigo).toBe("IMPORT_DECISION_STALE");
  });

  // =========================================================================
  it("6. desconsiderar -> conflito encerrado, primeira intacta, segunda PRESERVADA, imutavel e inapagavel", async () => {
    const caso = await casoDe("Marina Souza");
    const d = await desconsiderar(
      { eventId: EVENTO, caso, fonte_tipo: "contato_previamente_conhecido", referencia: "Mensagem para o celular da Marina cadastrado na inscricao (agosto); ela confirmou que reenviou", motivo: "A propria Marina reenviou o formulario; a primeira resposta e a valida" },
      paraRota("desconsiderar"),
      () => {},
    );
    log("PROVA 6", "desconsiderar:", resumo(d));
    expect(d.tipo).toBe("gravado");
    const id = caso.submissao.id;
    const linha = um(`select 'estado=' || estado || ' participant=' || coalesce(participant_id::text,'NULO') || ' respostas_brutas=' ||
                        (select count(*) from jsonb_object_keys(respostas_brutas)) || ' email=' || email_coletado || ' bloqueio=' || (bloqueio->>'codigo')
                        from external_submissions where id = '${id}'`);
    const hist = sql(`select acao || ' por ' || coalesce(operador_email,'-') from external_submission_events where submission_id = '${id}' order by criado_em`);
    const apagar = erroDe(() => sql(`delete from external_submissions where id = '${id}'`));
    const mudar = erroDe(() => sql(`update external_submissions set respostas_brutas = '{}' where id = '${id}'`));
    const naFila = (await mesa()).casos.some((c) => c.submissao.id === id);
    log(
      "PROVA 6",
      `linha: ${linha}`,
      `historico: ${hist.split("\n").join(" -> ")}`,
      `livro: ${livro(id)}`,
      `DELETE (como superusuario): ${apagar}`,
      `UPDATE do payload (como superusuario): ${mudar}`,
      `ainda na fila de conflitos ativos? ${naFila}`,
    );
    expect(linha).toMatch(/estado=desconsiderada participant=NULO respostas_brutas=52/);
    expect(apagar).toMatch(/DESCONSIDERADA e e registro historico/);
    expect(mudar).toMatch(/nao muda mais/);
    expect(naFila).toBe(false);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);
  });

  // =========================================================================
  it("7. substituir respostas existentes -> recusa efetiva NO BANCO, com a borda contornada", async () => {
    // Uma quinta segunda resposta, para tentar por cima de quem ja respondeu.
    await enviarFormulario("Bruno Teste", EMAIL_MARINA);
    const caso = await casoDe("Bruno Teste");
    const pedroAntes = um(`select md5(string_agg(answers::text || origem, '|' order by stage_id)) from quiz_responses where participant_id = '${P.pedro}'`);

    // (a) pela rota: vincular a Marina e ao Pedro.
    const aMarina = await regularizar({ eventId: EVENTO, caso, destino: { tipo: "vincular", participant_id: P.marina }, convidado_id: null, ...FUNDAMENTO_PRESENCIAL, motivo: "tentar ligar a segunda na dona da primeira" }, paraRota("regularizar"), () => {});
    const aoPedro = await regularizar({ eventId: EVENTO, caso, destino: { tipo: "vincular", participant_id: P.pedro }, convidado_id: null, ...FUNDAMENTO_PRESENCIAL, motivo: "tentar ligar a quem ja tem respostas proprias" }, paraRota("regularizar"), () => {});

    // (b) a borda contornada: a FUNCAO, com plano montado certo, mirando o Pedro e a Marina.
    const prep = await prepararRegularizacao(h.cliente.atual as unknown as ClienteDeConsulta & ClienteDeLeitura, EVENTO, { id: OPERADOR_A.id, email: null });
    if (!prep.ok) throw new Error("prep");
    const linha = prep.linhas.find((l) => l.id === caso.submissao.id)!;
    const direto = async (alvo: string) => {
      const pl = planoDaRegularizacao(prep, linha, alvo, "direto no banco", { id: OPERADOR_A.id, email: null });
      if (!pl.ok) throw new Error("plano");
      return (h.cliente.atual as ReturnType<typeof clienteDoServidor>).rpc("formulario_publico_regularizar", {
        p_submission_id: linha.id, p_atualizado_em_visto: linha.atualizado_em, p_operador: OPERADOR_A.id, p_operador_email: OPERADOR_A.email,
        p_modo: "vincular", p_participant_id: alvo, p_novo_nome: null, p_novo_email: null, p_novo_telefone: null, p_convidado_id: null,
        p_fonte_tipo: "confirmacao_presencial", p_referencia: FUNDAMENTO_PRESENCIAL.referencia,
        p_motivo: "tentativa direta de gravar por cima de respostas existentes", p_plano: pl.plano,
      });
    };
    const bPedro = await direto(P.pedro);
    const bMarina = await direto(P.marina);

    // (c) mais fundo: a importacao atomica chamada direto, e o UPDATE direto da linha.
    const pl = planoDaRegularizacao(prep, linha, P.pedro, "direto", { id: OPERADOR_A.id, email: null });
    if (!pl.ok) throw new Error("plano");
    const cAplicar = await (h.cliente.atual as ReturnType<typeof clienteDoServidor>).rpc("importacao_externa_aplicar", { plano: pl.plano });
    const cUpdate = erroDe(() => servidor(`update external_submissions set estado = 'importavel', participant_id = '${P.pedro}', bloqueio = null where id = '${linha.id}'`));

    // (d) a reconciliacao GENERICA (so justificativa) tambem nao resolve esta submissao.
    const mesaGenerica = await pedirMesa(EVENTO, paraRota("decisoes"), () => {});
    let generica: unknown = "sem ficha";
    if (mesaGenerica.tipo === "mesa") {
      const g = mesaGenerica.mesa.a_decidir.find((x) => x.submissao.id === linha.id);
      const ficha = g?.candidatos.find((c) => c.participante.nome === "Teodoro Reis");
      log("PROVA 7", `mesa generica, ficha do Teodoro (livre): permitida=${ficha?.permitida} impedimento=${ficha?.impedimento?.codigo}`);
      expect(ficha?.permitida).toBe(false);
      if (ficha) generica = await reconciliarSubmissao({ eventId: EVENTO, ficha, justificativa: "so justificativa, sem fonte" }, paraRota("reconciliar"), () => {});
    }

    log(
      "PROVA 7",
      `(a) rota, vincular a Marina: ${JSON.stringify(aMarina)}`,
      `(a) rota, vincular ao Pedro: ${JSON.stringify(aoPedro)}`,
      `(b) funcao direta -> Pedro: ${JSON.stringify(bPedro.data ?? bPedro.error)}`,
      `(b) funcao direta -> Marina: ${JSON.stringify(bMarina.data ?? bMarina.error)}`,
      `(c) importacao_externa_aplicar direto -> Pedro: ${JSON.stringify(cAplicar.data ?? cAplicar.error).slice(0, 300)}`,
      `(c) UPDATE direto como service_role: ${cUpdate}`,
      `(d) reconciliacao generica: ${JSON.stringify(generica)}`,
    );
    expect(aMarina.tipo).toBe("recusado");
    expect(aoPedro.tipo).toBe("recusado");
    expect((bPedro.data as { codigo: string }).codigo).toBe("alvo_tem_respostas");
    expect((bMarina.data as { codigo: string }).codigo).toBe("alvo_e_o_dono_da_primeira");
    expect((cAplicar.data as { ok: boolean } | null)?.ok ?? false).toBe(false);
    expect(cUpdate).toMatch(/so e resolvida por formulario_publico_regularizar/);
    expect(um(`select md5(string_agg(answers::text || origem, '|' order by stage_id)) from quiz_responses where participant_id = '${P.pedro}'`)).toBe(pedroAntes);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);
    expect(um(`select estado from external_submissions where id = '${linha.id}'`)).toBe("conflito");
  });

  // =========================================================================
  it("8. participante e anonimo -> negativa efetiva (rota E banco), com controle positivo de admin", async () => {
    const caso = await casoDe("Bruno Teste");
    const livroAntes = numero(`select count(*) from external_identity_resolutions where event_id = '${EVENTO}'`);
    const corpo = { event_id: EVENTO, submission_id: caso.submissao.id, caso_impressao: caso.impressao_do_caso, destino: { tipo: "vincular", participant_id: P.teoB }, ...FUNDAMENTO_PRESENCIAL, motivo: "tentativa de quem nao e administrador" };

    const resultados: string[] = [];
    for (const [quem, user] of [["participante", JOVEM_SEM_PAPEL], ["anonimo", null]] as const) {
      h.getUser.mockResolvedValue({ data: { user }, error: null });
      for (const rota of ["regularizar", "desconsiderar", "destinatario"]) {
        const r = await cru(rota, corpo);
        resultados.push(`${quem} POST ${rota} -> ${r.status} ${r.corpo.code}`);
        expect(r.status).toBe(user ? 403 : 401);
      }
      const m = await pedirMesaDaSegundaResposta(EVENTO, paraRota("mesa"), () => {});
      resultados.push(`${quem} GET mesa -> ${m.tipo} ${"codigo" in m ? m.codigo : ""}`);
      expect(m.tipo).toBe("recusado");
    }
    h.getUser.mockResolvedValue({ data: { user: OPERADOR_A }, error: null });

    // EXECUTE nas tres funcoes, lido do CATALOGO (autoritativo). A chamada direta
    // como anon/authenticated sem EXECUTE derruba o backend NESTA IMAGEM
    // (supabase/postgres 17.6.1.106, reproduzido com uma funcao SQL trivial sem
    // relacao com a 029 -- ver relatorio): por isso a negativa de EXECUTE e
    // provada pelo catalogo, e a de TABELA por chamada real.
    const fns = [
      "public.formulario_publico_regularizar(uuid,timestamptz,uuid,text,text,uuid,text,text,text,uuid,text,text,text,jsonb)",
      "public.formulario_publico_desconsiderar(uuid,timestamptz,uuid,text,text,text,text)",
      "public.formulario_publico_confirmar_destinatario(uuid,uuid,text,text,text,text)",
    ];
    const privilegios = sql(
      fns
        .map(
          (f) =>
            `select '${f.split("(")[0]}: anon=' || has_function_privilege('anon', '${f}', 'execute') || ' authenticated=' || has_function_privilege('authenticated', '${f}', 'execute') || ' public=' || coalesce((select bool_or(a.grantee = 0) from pg_proc p, aclexplode(p.proacl) a where p.oid = '${f}'::regprocedure and a.privilege_type = 'EXECUTE'), false) || ' service_role=' || has_function_privilege('service_role', '${f}', 'execute');`,
        )
        .join("\n"),
    );
    const desc = `select public.formulario_publico_desconsiderar(p_submission_id => '${caso.submissao.id}', p_atualizado_em_visto => '${caso.submissao.atualizado_em}', p_operador => '${JOVEM_SEM_PAPEL.id}', p_operador_email => 'x', p_fonte_tipo => 'confirmacao_presencial', p_referencia => '${FUNDAMENTO_PRESENCIAL.referencia}', p_motivo => 'tentativa direta de quem nao e admin')`;
    const banco = [
      ...privilegios.split("\n"),
      `authenticated le o livro: ${erroDe(() => sqlComo("authenticated", { role: "authenticated", sub: JOVEM_SEM_PAPEL.id }, "select count(*) from external_identity_resolutions"))}`,
      `anon le as submissoes: ${erroDe(() => sqlComo("anon", { role: "anon" }, "select count(*) from external_submissions"))}`,
      `authenticated tenta UPDATE direto na submissao: ${erroDe(() => sqlComo("authenticated", { role: "authenticated", app_metadata: { role: "admin" } }, `update external_submissions set estado = 'desconsiderada' where id = '${caso.submissao.id}'`))}`,
      `service_role SEM claim de admin executa: ${erroDe(() => sqlComo("service_role", null, desc))}`,
      `service_role tenta INSERT no livro: ${erroDe(() => servidor(`insert into external_identity_resolutions (event_id, submission_id, submissao_id, ato, resultado, fonte_tipo, referencia, motivo, estado_anterior, operador) values ('${EVENTO}', '${caso.submissao.id}', 'x', 'desconsiderar', 'confirmado', 'confirmacao_presencial', 'referencia forjada com mais de vinte', 'motivo forjado com mais de vinte', '{}', '${OPERADOR_A.id}')`))}`,
      `service_role tenta UPDATE/DELETE/TRUNCATE no livro: ${erroDe(() => servidor(`update external_identity_resolutions set motivo = motivo`))} / ${erroDe(() => servidor(`delete from external_identity_resolutions`))} / ${erroDe(() => servidor(`truncate external_identity_resolutions`))}`,
    ];
    log("PROVA 8", ...resultados, ...banco);
    for (const l of banco.slice(0, 3)) expect(l).toMatch(/anon=false authenticated=false public=false service_role=true/);
    expect(banco[3]).toMatch(/permission denied/);
    expect(banco[4]).toMatch(/permission denied/);
    expect(banco[5]).toMatch(/permission denied/);
    expect(banco[6]).toMatch(/apenas administrador/);
    expect(banco[7]).toMatch(/permission denied/);
    expect(banco[8]).toMatch(/permission denied.*permission denied.*permission denied/);
    expect(numero(`select count(*) from external_identity_resolutions where event_id = '${EVENTO}'`)).toBe(livroAntes);

    // CONTROLE POSITIVO: o admin, no mesmo ambiente, le e decide.
    const ok = await desconsiderar(
      { eventId: EVENTO, caso: await casoDe("Bruno Teste"), fonte_tipo: "confirmacao_presencial", referencia: "Bruno confirmou com a coordenadora Ana no ensaio de 22/10 que digitou errado", motivo: "Bruno e um teste de digitacao confirmado: o envio foi feito por engano" },
      paraRota("desconsiderar"),
      () => {},
    );
    log("PROVA 8", `controle positivo, admin desconsidera: ${JSON.stringify(resumo(ok))}`);
    expect(ok.tipo).toBe("gravado");
  });

  // =========================================================================
  it("C3 + C4: identidade confirmada NAO libera entrega sem o destinatario; nada marca e-mail como verificado", async () => {
    // Um documento revisado para o Lucas (regularizado na prova 2).
    const doc = randomUUID();
    sql(`
      insert into prognostics (id, participant_id, raw_ai_output, status, generated_at)
      values ('${doc}', '${P.lucas}', '{"texto":"documento do Lucas"}', 'generated', now());
      update prognostics set status = 'reviewed', reviewed_at = now() where id = '${doc}';`);
    const entregarSemDestinatario = erroDe(() =>
      sql(`update prognostics set status = 'delivered', delivered_at = now(), final_content = raw_ai_output where id = '${doc}'`),
    );

    // O segundo fato pela rota: canal fora do vocabulario e e-mail errado sao recusados.
    const canalRuim = await cru("destinatario", { event_id: EVENTO, participant_id: P.lucas, canal_tipo: "lista_oficial_previa", referencia: "Lista oficial da coordenacao, linha 23", email_destinatario: EMAIL_LUCAS });
    const emailRuim = await confirmarDestinatario({ event_id: EVENTO, participant_id: P.lucas, canal_tipo: "contato_previamente_conhecido", referencia: "Liguei no celular da mae cadastrado em agosto; ela confirmou", email_destinatario: EMAIL_MARINA }, paraRota("destinatario"), () => {});
    const naoRegularizado = await confirmarDestinatario({ event_id: EVENTO, participant_id: P.pedro, canal_tipo: "contato_previamente_conhecido", referencia: "Liguei no celular do Pedro cadastrado em agosto; ele confirmou", email_destinatario: EMAIL_PEDRO }, paraRota("destinatario"), () => {});
    const certo = await confirmarDestinatario({ event_id: EVENTO, participant_id: P.lucas, canal_tipo: "contato_previamente_conhecido", referencia: "Liguei no celular da mae cadastrado em agosto; ela confirmou o endereco do Lucas", email_destinatario: EMAIL_LUCAS }, paraRota("destinatario"), () => {});
    const entregarComDestinatario = erroDe(() =>
      sql(`update prognostics set status = 'delivered', delivered_at = now(), final_content = raw_ai_output where id = '${doc}'`),
    );

    const verificados = sql(`
      select 'formulario-publico com email_verificado=true: ' || count(*) filter (where email_verificado) ||
             ' ; com identidade_via=email_verificado: ' || count(*) filter (where identidade_via = 'email_verificado') ||
             ' ; total: ' || count(*)
        from external_submissions where event_id = '${EVENTO}';
      select 'participantes do evento com user_id: ' || count(*) filter (where user_id is not null) from participants where event_id = '${EVENTO}';
      select 'auth.users criados: ' || count(*) from auth.users where email like '%@exemplo.org';`);
    const forcar = erroDe(() => sql(`update external_submissions set email_verificado = true where event_id = '${EVENTO}' and formulario_id = 'formulario-publico' and estado <> 'desconsiderada'`));
    const forcarVia = erroDe(() => servidor(`update external_submissions set identidade_via = 'email_verificado' where event_id = '${EVENTO}' and formulario_id = 'formulario-publico' and estado <> 'desconsiderada'`));

    log(
      "PROVA C3",
      `entregar o documento do Lucas SEM destinatario confirmado: ${entregarSemDestinatario}`,
      `destinatario por canal 'lista_oficial_previa': ${canalRuim.status} ${canalRuim.corpo.code}`,
      `destinatario com e-mail que nao e o do cadastro: ${JSON.stringify(emailRuim)}`,
      `destinatario de quem NAO foi regularizado: ${JSON.stringify(naoRegularizado)}`,
      `destinatario confirmado: ${JSON.stringify(resumo(certo))}`,
      `entregar DEPOIS do segundo fato: ${entregarComDestinatario} -> status=${um(`select status from prognostics where id = '${doc}'`)}`,
    );
    log("PROVA C4", ...verificados.split("\n"), `superusuario tenta email_verificado=true: ${forcar}`, `service_role tenta identidade_via=email_verificado: ${forcarVia}`);
    expect(entregarSemDestinatario).toMatch(/DESTINATARIO .* nao foi confirmado/);
    expect(canalRuim.corpo.code).toBe("INVALID_REQUEST");
    expect(emailRuim.tipo).toBe("recusado");
    expect(naoRegularizado.tipo).toBe("recusado");
    expect(certo.tipo).toBe("gravado");
    expect((certo as unknown as { resumo: { email_verificado: boolean } }).resumo.email_verificado).toBe(false);
    expect(entregarComDestinatario).toBe("(sem erro)");
    expect(verificados).toMatch(/email_verificado=true: 0 ; com identidade_via=email_verificado: 0/);
    expect(verificados).toMatch(/com user_id: 0/);
    expect(verificados).toMatch(/auth.users criados: 0/);
    expect(forcar).toMatch(/AUTODECLARADO/);
    expect(forcarVia).toMatch(/AUTODECLARADO/);
  });

  // =========================================================================
  it("FIM: o livro inteiro do evento, e Marina intacta do comeco ao fim", () => {
    const tudo = sql(`
      select to_char(criado_em, 'HH24:MI:SS.MS') || ' | ' || submissao_id || ' | ' || ato || ' | ' || resultado ||
             ' | ' || coalesce(recusa_codigo, '-') || ' | fonte=' || fonte_tipo || ' | operador=' || operador_email ||
             ' | referencia="' || left(referencia, 40) || '..."'
        from external_identity_resolutions where event_id = '${EVENTO}' order by sequencia`);
    log("LIVRO", ...tudo.split("\n"));
    log("FIM", `Marina: ${FONTE_DA_MARINA} == ${fotografiaDaMarina()}`);
    expect(fotografiaDaMarina()).toBe(FONTE_DA_MARINA);
  });
});
