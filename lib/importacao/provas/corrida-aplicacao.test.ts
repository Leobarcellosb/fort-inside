// PROVA DA CORRIDA: a janela entre a PREVIA e a APLICACAO da importacao
// externa, contra Postgres de verdade -- incluindo DISPUTA CONCORRENTE REAL
// entre os dois caminhos de escrita, nos dois sentidos.
//
// Como rodar:
//   PROVA_IMPORTACAO_URL="postgresql://...@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config lib/importacao/provas/vitest.prova.config.ts \
//       lib/importacao/provas/corrida-aplicacao.test.ts --reporter=verbose
//
// Sem PROVA_IMPORTACAO_URL o arquivo e PULADO, para `npx vitest run` continuar
// verde em maquina sem banco. GUARDA DE ALVO: a URL tem de ser 127.0.0.1,
// localhost ou [::1]. Nunca aponte para producao -- esta prova ESCREVE. Use um
// container descartavel PROPRIO, nao o banco local compartilhado do projeto:
// outras unidades escrevem nele e ja houve contaminacao medida. Evento e
// participantes desta prova tem ids proprios, que nao colidem com os das outras
// provas desta pasta.
//
// O DEFEITO QUE ELA MEDE
// ----------------------
// A decisao "este participante nao respondeu" era tomada ANTES da transacao
// (`lerContextoDoEvento` conta `respostas_existentes`; o planejador marca
// `importavel`) e a gravacao, dentro dela, sobrescrevia sem reconferir
// (`on conflict (participant_id, stage_id) do update set answers = excluded...`).
// Se a pessoa respondesse PELO APLICATIVO nesse intervalo, a resposta dela
// desaparecia, `origem` virava 'externo', e o conflito nao era detectado --
// porque foi avaliado num instante em que ainda nao existia.
//
// Contra as migrations 001..023 este arquivo fica VERMELHO. Com a 024, verde.
//
// A REGRA QUE ELA COBRA (ordem da revisao)
// ----------------------------------------
//   plano integro                            -> aplicacao atomica
//   respondeu pelo app depois da previa       -> RECUSAR O LOTE, resposta fica
//   outra importacao ocupou a identidade      -> RECUSAR O LOTE como conflito
//   previa nova sem os conflitos              -> aplica o novo conjunto
//   falha durante a transacao                 -> reverter todas as escritas
//
// O QUE ELA PROVA, nesta ordem:
//   1. A CORRIDA: resposta do aplicativo depois da previa continua intacta e o
//      LOTE e recusado -- e o conjunto de escrita da recusa e SO o registro de
//      auditoria (nenhuma submissao, nenhum item, nenhuma resposta canonica);
//   2. LOTE ATOMICO: uma submissao em conflito impede a submissao LEGITIMA do
//      mesmo lote de entrar. Nada parcial;
//   3. PROGRESSO: previa nova sem a conflitante aplica o conjunto elegivel;
//   4. CONTROLE POSITIVO: importacao limpa continua gravando;
//   5. CONTROLE POSITIVO: reimportar a MESMA submissao continua atualizando;
//   6. MESMA submissao exige VERSAO verificada: versao divergente e recusa;
//   7. linha de OUTRA submissao externa recusa o lote;
//   8. IDENTIDADE revalidada: participante de outro evento recusa o lote;
//   9. o registro DURAVEL da recusa, com codigo proprio, e o livro-razao da
//      submissao que ja existia;
//  10. resposta do aplicativo POR CIMA de linha importada devolve a linha para a
//      pessoa, e a reimportacao passa a ser recusada;
//  11. CONCORRENCIA REAL, sentido A: participante gravando e importacao
//      chegando no meio -- a importacao ESPERA e recusa o lote;
//  12. CONCORRENCIA REAL, sentido B: importacao gravando e participante
//      chegando no meio -- o participante ESPERA e a resposta dele nao e perdida.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  montarManifesto,
  type LinhaDeEtapa,
  type ManifestoQuestionario,
} from "../manifesto-questionario";
import { letraDeclarada } from "../mapear-resposta";
import { planejarImportacao } from "../planejar-importacao";
import type { ParticipanteDoEvento, SubmissaoExterna } from "../reconciliar-identidade";

const URL_ALVO = process.env.PROVA_IMPORTACAO_URL;

/** Recusa alvo que nao e local. A prova ESCREVE no banco. */
function exigirLocal(url: string): void {
  let host: string;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    host = u.hostname;
  } catch {
    throw new Error("PROVA_IMPORTACAO_URL nao e uma URL postgres valida");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `PROVA_IMPORTACAO_URL nao e local (host=${host}). Esta prova escreve: abortando.`,
    );
  }
}

const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-corrida-")) : "";

function arquivoSql(texto: string): string {
  const arquivo = join(TRABALHO, `q-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(arquivo, texto, "utf8");
  return arquivo;
}

function sql(texto: string): string {
  return execFileSync(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivoSql(texto)],
    { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
  ).trim();
}

/**
 * A MESMA chamada, em OUTRA SESSAO, sem bloquear esta. E o que permite duas
 * transacoes concorrentes de verdade -- nao duas chamadas em fila.
 */
interface Concorrente {
  saida: string;
  erro: string;
  ms: number;
  codigo: number | null;
}

function sqlConcorrente(texto: string): Promise<Concorrente> {
  const arquivo = arquivoSql(texto);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(
      "psql",
      ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo],
      { env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
    );
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d) => (saida += String(d)));
    p.stderr.on("data", (d) => (erro += String(d)));
    p.on("close", (codigo) =>
      resolve({ saida: saida.trim(), erro: erro.trim(), ms: Date.now() - t0, codigo }),
    );
  });
}

function espera(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function um(texto: string): string {
  return sql(texto).split("\n")[0] ?? "";
}

function json<T>(texto: string): T {
  const bruto = um(texto);
  return JSON.parse(bruto === "" ? "null" : bruto) as T;
}

/** Embute um objeto como literal jsonb, sem interpolar nada perigoso. */
function literalJson(valor: unknown): string {
  const t = JSON.stringify(valor);
  if (t.includes("$plano$")) throw new Error("o payload colide com o delimitador");
  return `$plano$${t}$plano$::jsonb`;
}

/**
 * O estado das respostas canonicas de um participante, como QUALQUER humano
 * olharia: uma linha por etapa, com procedencia. E isto que e impresso ANTES e
 * DEPOIS de cada cenario -- a prova nao afirma nada que nao esteja neste select.
 */
interface LinhaCanonica {
  stage_id: number;
  origem: string;
  marca: string | null;
  submissao: string | null;
}

function respostasDe(participante: string): LinhaCanonica[] {
  return json<LinhaCanonica[]>(`
    select coalesce(json_agg(json_build_object(
             'stage_id', r.stage_id,
             'origem', r.origem,
             'marca', r.answers ->> 'q1',
             'submissao', es.submissao_id
           ) order by r.stage_id)::text, '[]')
      from quiz_responses r
      left join external_submissions es on es.id = r.external_submission_id
     where r.participant_id = '${participante}'
  `);
}

interface LinhaDeSubmissao {
  submissao_id: string;
  estado: string;
  participant_id: string | null;
  apto: boolean;
}

function submissaoNoBanco(submissaoId: string): LinhaDeSubmissao | null {
  return json<LinhaDeSubmissao | null>(`
    select coalesce(to_json(t)::text, 'null') from (
      select submissao_id, estado, participant_id::text as participant_id,
             apto_para_pontuar as apto
        from external_submissions where submissao_id = '${submissaoId}') t
  `);
}

interface Recusa {
  submissao_id: string;
  codigo: string;
  motivo: string;
  etapas_em_conflito: string[];
}

function recusasRegistradas(lote?: string): Recusa[] {
  const filtro = lote === undefined ? "" : `and r.lote_impressao = '${lote}'`;
  return json<Recusa[]>(`
    select coalesce(json_agg(json_build_object(
             'submissao_id', r.submissao_id, 'codigo', r.codigo,
             'motivo', r.motivo, 'etapas_em_conflito', r.etapas_em_conflito
           ) order by r.submissao_id)::text, '[]')
      from external_import_rejections r
     where r.event_id = '${EVENTO}' ${filtro}
  `);
}

function livroRazao(submissaoId: string): { acao: string; justificativa: string | null }[] {
  return json(`
    select coalesce(json_agg(json_build_object(
             'acao', ev.acao, 'justificativa', ev.justificativa
           ) order by ev.criado_em, ev.acao)::text, '[]')
      from external_submission_events ev
      join external_submissions es on es.id = ev.submission_id
     where es.submissao_id = '${submissaoId}'
  `);
}

/**
 * O CONJUNTO DE ESCRITA, contado: e com estes numeros que se afirma que a recusa
 * nao gravou nada do plano. Sem eles, "nada foi gravado" seria so uma frase.
 */
interface Contagens {
  submissoes: number;
  itens: number;
  respostas: number;
  recusas: number;
  razao: number;
}

function contagens(): Contagens {
  return json<Contagens>(`
    select to_json(t)::text from (
      select
        (select count(*) from external_submissions where event_id = '${EVENTO}') as submissoes,
        (select count(*) from external_response_items i
           join external_submissions es on es.id = i.submission_id
          where es.event_id = '${EVENTO}') as itens,
        (select count(*) from quiz_responses r
           join participants p on p.id = r.participant_id
          where p.event_id = '${EVENTO}') as respostas,
        (select count(*) from external_import_rejections where event_id = '${EVENTO}') as recusas,
        (select count(*) from external_submission_events ev
           join external_submissions es on es.id = ev.submission_id
          where es.event_id = '${EVENTO}') as razao) t
  `);
}

/** Imprime o estado real, para o relatorio ter saida colada e nao so asserts. */
function mostrar(titulo: string, valor: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`\n--- ${titulo} ---\n${JSON.stringify(valor, null, 2)}`);
}

const EVENTO = "c0dec0de-0024-4024-8024-c0dec0de0024";
const OPERADOR = "0ba0ba0b-0024-4024-8024-0ba0ba0b0024";
const FORMULARIO = "1FAIpQLSc-corrida-024";

const P = {
  maria: "a0000024-0001-4001-8001-a00000240001",
  joao: "a0000024-0002-4002-8002-a00000240002",
  ana: "a0000024-0003-4003-8003-a00000240003",
  bruno: "a0000024-0004-4004-8004-a00000240004",
  carla: "a0000024-0005-4005-8005-a00000240005",
  diego: "a0000024-0006-4006-8006-a00000240006",
  elisa: "a0000024-0007-4007-8007-a00000240007",
  fabio: "a0000024-0008-4008-8008-a00000240008",
  // Dedicados ao enxame do cenario 13: sem historico, para que os DOIS
  // desfechos do lote (aplicar inteiro ou recusar inteiro) sejam possiveis.
  gustavo: "a0000024-0010-4010-8010-a00000240010",
  helena: "a0000024-0011-4011-8011-a00000240011",
  igor: "a0000024-0012-4012-8012-a00000240012",
  julia: "a0000024-0013-4013-8013-a00000240013",
};
/** Existe no banco, mas em OUTRO evento: serve a revalidacao de identidade. */
const FORA_DO_EVENTO = "a0000024-0099-4099-8099-a00000240099";
const EVENTO_VIZINHO = "c0dec0de-0099-4099-8099-c0dec0de0099";

let MANIFESTO: ManifestoQuestionario;

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`manifesto sem ${id}/${letra}`);
  return o;
}

/**
 * Um conjunto completo de respostas. `marca` entra em q1 (texto livre da etapa 1)
 * e e por ela que se ve, no banco, QUAL dado esta na linha -- o da pessoa ou o
 * importado.
 */
function respostasCompletas(marca: string): Record<string, unknown> {
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
  r.q1 = marca;
  return r;
}

function submissao(over: Partial<SubmissaoExterna> & { submissao_id: string }): SubmissaoExterna {
  return {
    email: "maria@corrida024.test",
    email_verificado: true,
    nome_declarado: "Pessoa Declarada",
    respostas: respostasCompletas("IMPORTADO"),
    ...over,
  };
}

const PARTICIPANTES: ParticipanteDoEvento[] = [
  { id: P.maria, email: "maria@corrida024.test", full_name: "Maria Souza" },
  { id: P.joao, email: "joao@corrida024.test", full_name: "Joao Pereira" },
  { id: P.ana, email: "ana@corrida024.test", full_name: "Ana Lima" },
  { id: P.bruno, email: "bruno@corrida024.test", full_name: "Bruno Dias" },
  { id: P.carla, email: "carla@corrida024.test", full_name: "Carla Reis" },
  { id: P.diego, email: "diego@corrida024.test", full_name: "Diego Melo" },
  { id: P.elisa, email: "elisa@corrida024.test", full_name: "Elisa Rocha" },
  { id: P.fabio, email: "fabio@corrida024.test", full_name: "Fabio Nunes" },
  { id: P.gustavo, email: "gustavo@corrida024.test", full_name: "Gustavo Alves" },
  { id: P.helena, email: "helena@corrida024.test", full_name: "Helena Prado" },
  { id: P.igor, email: "igor@corrida024.test", full_name: "Igor Campos" },
  { id: P.julia, email: "julia@corrida024.test", full_name: "Julia Freitas" },
  { id: FORA_DO_EVENTO, email: "vizinho@corrida024.test", full_name: "Vizinho Dias" },
];

function entradaBase(submissoes: readonly SubmissaoExterna[]) {
  return {
    evento: { id: EVENTO, quiz_version: 2 },
    manifesto: MANIFESTO,
    origem: {
      formulario_id: FORMULARIO,
      formulario_nome: "Marco Zero | corrida previa x aplicacao",
      impressao_declarada: MANIFESTO.impressao,
    },
    submissoes,
    // `respostas_existentes` ausente = 0, que e EXATAMENTE o que a previa leu
    // antes de a pessoa responder no aplicativo. A prova nao mente para o
    // planejador: ela reproduz a leitura que ele de fato teve.
    participantes: PARTICIPANTES,
    operador: { id: OPERADOR, email: "host@corrida024.test" },
  } as Parameters<typeof planejarImportacao>[0];
}

interface Resultado {
  ok: boolean;
  codigo?: string;
  motivo?: string;
  lote_impressao: string;
  linhas_de_resposta_gravadas: number;
  por_estado: Record<string, number>;
  recusas_na_revalidacao: number;
  recusadas_na_revalidacao: {
    submissao_id: string;
    codigo: string;
    motivo: string;
    etapas_em_conflito: string[];
  }[];
}

function planoDe(entrada: Parameters<typeof planejarImportacao>[0]) {
  const plano = planejarImportacao(entrada);
  if (!plano.ok) throw new Error(`plano recusado: ${plano.codigo} ${plano.motivo}`);
  return plano;
}

function chamadaSql(plano: unknown): string {
  return `select public.importacao_externa_aplicar(${literalJson(plano)})`;
}

/** Planeja e APLICA no banco. Devolve o plano e o que a funcao devolveu. */
function aplicar(entrada: Parameters<typeof planejarImportacao>[0]) {
  const plano = planoDe(entrada);
  return { plano, resultado: json<Resultado>(chamadaSql(plano)) };
}

/** O aplicativo gravando, do jeito que o aplicativo grava: so as tres colunas. */
function escritaDoAplicativo(participante: string, stageId: number, marca: string): string {
  return `
    insert into quiz_responses (participant_id, stage_id, answers)
    values ('${participante}', ${stageId}, jsonb_build_object('q1', '${marca}'))
    on conflict (participant_id, stage_id) do update set answers = excluded.answers`;
}

function respondePeloAplicativo(participante: string, stageId: number, marca: string): void {
  sql(escritaDoAplicativo(participante, stageId, marca));
}

describe("guarda de alvo", () => {
  it("a URL da prova, quando existe, e local", () => {
    if (URL_ALVO) exigirLocal(URL_ALVO);
    expect(true).toBe(true);
  });
});

descreve("PROVA: a janela entre a previa e a aplicacao da importacao externa", () => {
  beforeAll(() => {
    exigirLocal(URL_ALVO as string);

    // RE-RODAVEL: apaga os PROPRIOS eventos antes de comecar (cascade leva
    // participantes, respostas e submissoes DESTES eventos, de nenhum outro).
    //
    // ORDEM IMPORTA: as respostas canonicas saem PRIMEIRO. Apagar a submissao
    // externa antes faria o `on delete set null` de `external_submission_id`
    // deixar uma linha com `origem = 'externo'` e submissao nula -- que o check
    // `quiz_responses_proveniencia_check` (corretamente) recusa, e a limpeza
    // morreria antes de comecar.
    sql(`
      delete from quiz_responses
       where participant_id in (
         select id from participants
          where event_id in ('${EVENTO}', '${EVENTO_VIZINHO}'));
      -- A tabela de recusas so existe com a 024 aplicada. A limpeza nao pode
      -- morrer num banco SEM a 024: senao esta prova ficaria verde-por-omissao
      -- justamente no banco onde ela tem de ficar VERMELHA, e o vermelho sairia
      -- do preparo em vez do comportamento medido.
      do $limpa$
      begin
        if to_regclass('public.external_import_rejections') is not null then
          delete from public.external_import_rejections
           where event_id in ('${EVENTO}', '${EVENTO_VIZINHO}');
        end if;
      end
      $limpa$;
      delete from events where id in ('${EVENTO}', '${EVENTO_VIZINHO}');
    `);

    const valores = PARTICIPANTES.filter((p) => p.id !== FORA_DO_EVENTO)
      .map((p) => `('${p.id}','${EVENTO}','${p.full_name}','${p.email}')`)
      .join(",");
    sql(`
      insert into events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
      values ('${EVENTO}', 'Prova 024 corrida da importacao', 'PROVA024',
              '2026-10-24T13:00:00Z', 'active', 5, 2, 'async',
              '2026-10-22T12:00:00Z', '2026-10-23T23:59:00Z'),
             ('${EVENTO_VIZINHO}', 'Prova 024 evento vizinho', 'PROVA024V',
              '2026-10-24T13:00:00Z', 'active', 5, 2, 'async',
              '2026-10-22T12:00:00Z', '2026-10-23T23:59:00Z')
      on conflict (id) do nothing;

      insert into participants (id, event_id, full_name, email)
      values ${valores},
             ('${FORA_DO_EVENTO}','${EVENTO_VIZINHO}','Vizinho Dias','vizinho@corrida024.test')
      on conflict (id) do nothing;
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

  // =========================================================================
  it("1. A CORRIDA: respondeu no aplicativo depois da previa -> LOTE recusado, resposta INTACTA, e o conjunto de escrita e SO a auditoria", () => {
    // O plano e montado AGORA, com Maria sem nenhuma resposta: o planejador
    // decide 'importavel', e e uma decisao CORRETA no instante em que e tomada.
    const plano = planoDe(
      entradaBase([submissao({ submissao_id: "corrida-maria", email: "maria@corrida024.test" })]),
    );
    expect(plano.submissoes[0].estado).toBe("importavel");
    expect(plano.submissoes[0].participant_id).toBe(P.maria);
    expect(respostasDe(P.maria)).toEqual([]);

    // AQUI ESTA A JANELA: a pessoa responde PELO APLICATIVO, depois de a previa
    // ter sido montada e antes de a funcao rodar. E ela responde a etapa 104 --
    // de proposito uma etapa QUALQUER, nao a primeira: proteger so a colisao da
    // mesma chave nao bastaria.
    respondePeloAplicativo(P.maria, 104, "RESPOSTA DA MARIA NO APLICATIVO");
    const antes = { respostas: respostasDe(P.maria), contagens: contagens() };
    mostrar("ANTES da aplicacao: Maria JA respondeu a etapa 104 no aplicativo", antes);
    expect(antes.respostas).toEqual([
      { stage_id: 104, origem: "app", marca: "RESPOSTA DA MARIA NO APLICATIVO", submissao: null },
    ]);

    // A impressao da previa continua CORRETA: o plano nao mudou. Quem mudou foi
    // o banco. E por isso que um hash correto nao pode ser a autorizacao final.
    const r = json<Resultado>(chamadaSql(plano));
    const depois = { respostas: respostasDe(P.maria), contagens: contagens() };
    mostrar("DEPOIS da aplicacao: o que a funcao devolveu", r);
    mostrar("DEPOIS da aplicacao: respostas de Maria e contagens", depois);

    // O LOTE FOI RECUSADO.
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe("LOTE_RECUSADO_NA_REVALIDACAO");
    expect(r.motivo).toContain("LOTE INTEIRO foi recusado");
    expect(r.motivo).toContain("previa nova");
    expect(r.linhas_de_resposta_gravadas).toBe(0);
    expect(r.por_estado).toEqual({});
    expect(r.recusas_na_revalidacao).toBe(1);
    expect(r.recusadas_na_revalidacao[0].codigo).toBe("resposta_do_aplicativo");
    expect(r.recusadas_na_revalidacao[0].etapas_em_conflito).toEqual(["104"]);

    // A RESPOSTA DELA FICA, exatamente como estava.
    expect(depois.respostas).toEqual(antes.respostas);

    // E O CONJUNTO DE ESCRITA DA RECUSA E SO O REGISTRO DE AUDITORIA: nenhuma
    // submissao, nenhum item, nenhuma resposta canonica. E por isso que o
    // registro nao precisa sobreviver a rollback nenhum -- nao ha rollback.
    expect(depois.contagens.submissoes).toBe(antes.contagens.submissoes);
    expect(depois.contagens.itens).toBe(antes.contagens.itens);
    expect(depois.contagens.respostas).toBe(antes.contagens.respostas);
    expect(depois.contagens.razao).toBe(antes.contagens.razao);
    expect(depois.contagens.recusas).toBe(antes.contagens.recusas + 1);
    expect(submissaoNoBanco("corrida-maria")).toBeNull();

    const registradas = recusasRegistradas(r.lote_impressao);
    mostrar("DEPOIS: o registro DURAVEL da recusa", registradas);
    expect(registradas).toHaveLength(1);
    expect(registradas[0].submissao_id).toBe("corrida-maria");
    expect(registradas[0].codigo).toBe("resposta_do_aplicativo");
    expect(registradas[0].motivo).toContain("LOTE RECUSADO NA REVALIDACAO");
  });

  // =========================================================================
  it("2. LOTE ATOMICO: uma submissao em conflito impede a LEGITIMA do mesmo lote de entrar", () => {
    const antes = {
      maria: respostasDe(P.maria),
      carla: respostasDe(P.carla),
      contagens: contagens(),
    };
    mostrar("ANTES: Maria com resposta do app; Carla sem nada", antes);
    expect(antes.carla).toEqual([]);

    // Lote com DUAS submissoes: a de Maria (em conflito desde o cenario 1) e a
    // de Carla, que e perfeitamente legitima.
    const { resultado } = aplicar(
      entradaBase([
        submissao({ submissao_id: "corrida-maria", email: "maria@corrida024.test" }),
        submissao({
          submissao_id: "carla-no-lote-recusado",
          email: "carla@corrida024.test",
          respostas: respostasCompletas("CARLA NAO DEVE ENTRAR AGORA"),
        }),
      ]),
    );
    const depois = {
      maria: respostasDe(P.maria),
      carla: respostasDe(P.carla),
      contagens: contagens(),
    };
    mostrar("DEPOIS: o que a funcao devolveu", resultado);
    mostrar("DEPOIS: respostas e contagens", depois);

    expect(resultado.ok).toBe(false);
    expect(resultado.linhas_de_resposta_gravadas).toBe(0);
    // A LEGITIMA NAO ENTROU. E isto que "lote atomico" quer dizer.
    expect(depois.carla).toEqual([]);
    expect(submissaoNoBanco("carla-no-lote-recusado")).toBeNull();
    expect(depois.maria).toEqual(antes.maria);
    expect(depois.contagens.submissoes).toBe(antes.contagens.submissoes);
    expect(depois.contagens.respostas).toBe(antes.contagens.respostas);
    // So a submissao conflitante gera registro de recusa; a legitima nao e
    // acusada de nada -- ela so nao entrou.
    expect(resultado.recusas_na_revalidacao).toBe(1);
    expect(recusasRegistradas(resultado.lote_impressao).map((x) => x.submissao_id)).toEqual([
      "corrida-maria",
    ]);
  });

  // =========================================================================
  it("3. PROGRESSO: previa NOVA sem a submissao conflitante aplica o conjunto elegivel", () => {
    const antes = respostasDe(P.carla);
    mostrar("ANTES: Carla continua sem resposta", antes);
    expect(antes).toEqual([]);

    // O caminho de progresso que a revisao manda existir: mesma coleta, previa
    // nova SEM a conflitante.
    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "carla-no-lote-recusado",
          email: "carla@corrida024.test",
          respostas: respostasCompletas("CARLA IMPORTADA NA PREVIA NOVA"),
        }),
      ]),
    );
    const depois = respostasDe(P.carla);
    mostrar("DEPOIS: o que a funcao devolveu", resultado);
    mostrar("DEPOIS: respostas de Carla", depois);

    expect(resultado.ok).toBe(true);
    expect(resultado.linhas_de_resposta_gravadas).toBe(5);
    expect(resultado.recusas_na_revalidacao).toBe(0);
    expect(resultado.por_estado).toEqual({ importavel: 1 });
    expect(depois.map((l) => l.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(depois.every((l) => l.origem === "externo")).toBe(true);
    expect(depois[0].marca).toBe("CARLA IMPORTADA NA PREVIA NOVA");
    // E Maria continua com a resposta dela, intacta, sem ter entrado em nada.
    expect(respostasDe(P.maria)).toEqual([
      { stage_id: 104, origem: "app", marca: "RESPOSTA DA MARIA NO APLICATIVO", submissao: null },
    ]);
  });

  // =========================================================================
  it("4. CONTROLE POSITIVO: quem nao respondeu continua entrando (a correcao nao e 'recusa tudo')", () => {
    expect(respostasDe(P.joao)).toEqual([]);
    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "limpa-joao",
          email: "joao@corrida024.test",
          respostas: respostasCompletas("IMPORTADO DO FORMULARIO"),
        }),
      ]),
    );
    const depois = respostasDe(P.joao);
    mostrar("DEPOIS: resultado e respostas de Joao", { resultado, respostas: depois });

    expect(resultado.ok).toBe(true);
    expect(resultado.linhas_de_resposta_gravadas).toBe(5);
    expect(depois.every((l) => l.origem === "externo")).toBe(true);
    expect(depois.every((l) => l.submissao === "limpa-joao")).toBe(true);
    expect(depois[0].marca).toBe("IMPORTADO DO FORMULARIO");
    expect(submissaoNoBanco("limpa-joao")?.apto).toBe(true);
    expect(livroRazao("limpa-joao").map((l) => l.acao)).toEqual(["importada"]);
  });

  // =========================================================================
  it("5. CONTROLE POSITIVO: reimportar a MESMA submissao continua ATUALIZANDO", () => {
    expect(respostasDe(P.joao)[0].marca).toBe("IMPORTADO DO FORMULARIO");

    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "limpa-joao",
          email: "joao@corrida024.test",
          respostas: respostasCompletas("REIMPORTADO APOS CORRECAO"),
        }),
      ]),
    );
    const depois = respostasDe(P.joao);
    mostrar("DEPOIS: resultado e respostas de Joao", { resultado, respostas: depois });

    expect(resultado.ok).toBe(true);
    expect(resultado.linhas_de_resposta_gravadas).toBe(5);
    expect(resultado.recusas_na_revalidacao).toBe(0);
    expect(depois[0].marca).toBe("REIMPORTADO APOS CORRECAO");
    expect(depois.every((l) => l.submissao === "limpa-joao")).toBe(true);
    // Nao duplicou linha: continuam 5 etapas, nao 10.
    expect(depois).toHaveLength(5);
    expect(livroRazao("limpa-joao").map((l) => l.acao)).toEqual(["importada", "importada"]);
  });

  // =========================================================================
  it("6. MESMA submissao exige VERSAO verificada: versao divergente recusa o lote", () => {
    // A submissao de Joao passa a estar gravada como de OUTRA versao de
    // questionario. O numero de protocolo e o mesmo; o questionario nao e.
    sql(`update external_submissions set quiz_version = 3 where submissao_id = 'limpa-joao'`);
    const antes = respostasDe(P.joao);
    mostrar("ANTES: a submissao gravada esta na versao 3; o plano vem na 2", antes);

    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "limpa-joao",
          email: "joao@corrida024.test",
          respostas: respostasCompletas("NAO DEVE SOBRESCREVER"),
        }),
      ]),
    );
    const depois = respostasDe(P.joao);
    mostrar("DEPOIS: resultado e respostas de Joao", { resultado, respostas: depois });

    expect(resultado.ok).toBe(false);
    expect(resultado.recusadas_na_revalidacao[0].codigo).toBe("versao_da_submissao_mudou");
    expect(resultado.linhas_de_resposta_gravadas).toBe(0);
    expect(depois[0].marca).toBe("REIMPORTADO APOS CORRECAO");

    // A submissao que JA EXISTIA tem a tentativa recusada no PROPRIO livro-razao.
    const razao = livroRazao("limpa-joao");
    mostrar("DEPOIS: livro-razao de limpa-joao", razao);
    expect(razao.map((l) => l.acao)).toEqual([
      "importada",
      "importada",
      "recusada_na_revalidacao",
    ]);
    expect(razao[2].justificativa).toContain("RECUSADA NA REVALIDACAO (LOTE INTEIRO)");
    expect(razao[2].justificativa).toContain("NADA do lote foi gravado");

    // Devolve o estado para os cenarios seguintes.
    sql(`update external_submissions set quiz_version = 2 where submissao_id = 'limpa-joao'`);
  });

  // =========================================================================
  it("7. linha de OUTRA submissao externa recusa o lote, nao atualiza em silencio", () => {
    aplicar(
      entradaBase([
        submissao({
          submissao_id: "coleta-A-ana",
          email: "ana@corrida024.test",
          respostas: respostasCompletas("COLETA A"),
        }),
      ]),
    );
    const antes = respostasDe(P.ana);
    mostrar("ANTES: respostas de Ana, vindas de coleta-A-ana", antes);
    expect(antes.every((l) => l.submissao === "coleta-A-ana")).toBe(true);

    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "coleta-B-ana",
          email: "ana@corrida024.test",
          respostas: respostasCompletas("COLETA B"),
        }),
      ]),
    );
    const depois = respostasDe(P.ana);
    mostrar("DEPOIS: resultado e respostas de Ana", { resultado, respostas: depois });

    expect(resultado.ok).toBe(false);
    expect(resultado.linhas_de_resposta_gravadas).toBe(0);
    expect(depois[0].marca).toBe("COLETA A");
    expect(depois.every((l) => l.submissao === "coleta-A-ana")).toBe(true);
    expect(submissaoNoBanco("coleta-B-ana")).toBeNull();
    // Qualquer das duas guardas estruturais serve, e as duas dizem conflito.
    expect(["outra_submissao_ativa_do_participante", "outra_submissao_externa"]).toContain(
      resultado.recusadas_na_revalidacao[0].codigo,
    );
  });

  // =========================================================================
  it("8. IDENTIDADE revalidada: participante que nao e deste evento recusa o lote", () => {
    const antes = { fora: respostasDe(FORA_DO_EVENTO), fabio: respostasDe(P.fabio) };
    expect(antes.fora).toEqual([]);
    expect(antes.fabio).toEqual([]);

    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "vizinho-fora",
          email: "vizinho@corrida024.test",
          respostas: respostasCompletas("NAO DEVE ENTRAR"),
        }),
        submissao({
          submissao_id: "fabio-legitima",
          email: "fabio@corrida024.test",
          respostas: respostasCompletas("FABIO NAO DEVE ENTRAR TAMBEM"),
        }),
      ]),
    );
    const depois = { fora: respostasDe(FORA_DO_EVENTO), fabio: respostasDe(P.fabio) };
    mostrar("DEPOIS: resultado e respostas", { resultado, respostas: depois });

    expect(resultado.ok).toBe(false);
    expect(resultado.recusadas_na_revalidacao[0].codigo).toBe("participante_fora_do_evento");
    expect(depois.fora).toEqual([]);
    // Lote atomico outra vez: a legitima do mesmo lote tambem nao entrou.
    expect(depois.fabio).toEqual([]);
  });

  // =========================================================================
  it("9. O REGISTRO DURAVEL: codigo proprio por recusa, agrupado por LOTE, e append-only", () => {
    const porLote = json<
      { lote: string; n: number; codigos: string[] }[]
    >(`
      select coalesce(json_agg(json_build_object(
               'lote', left(lote_impressao, 8), 'n', submissoes_recusadas,
               'codigos', (select json_agg(x ->> 'codigo') from jsonb_array_elements(recusas) x)
             ) order by recusado_em)::text, '[]')
        from v_importacoes_recusadas where event_id = '${EVENTO}'
    `);
    mostrar("v_importacoes_recusadas: um grupo por TENTATIVA", porLote);
    // Cenarios 1, 2, 6, 7 e 8 recusaram um lote cada.
    expect(porLote.length).toBeGreaterThanOrEqual(5);
    expect(porLote.every((l) => l.n >= 1)).toBe(true);
    const codigos = porLote.flatMap((l) => l.codigos);
    expect(codigos).toContain("resposta_do_aplicativo");
    expect(codigos).toContain("versao_da_submissao_mudou");
    expect(codigos).toContain("participante_fora_do_evento");

    // Append-only de verdade, nos dois historicos: nem anon, nem authenticated,
    // nem service_role tem UPDATE ou DELETE.
    const privilegios = sql(`
      select coalesce(string_agg(distinct table_name || ':' || grantee || ':' || privilege_type, ', '), 'nenhum')
        from information_schema.role_table_grants
       where table_name in ('external_submission_events', 'external_import_rejections')
         and privilege_type in ('UPDATE', 'DELETE')
         and grantee in ('anon', 'authenticated', 'service_role')
    `);
    mostrar("privilegios de UPDATE/DELETE nos dois historicos", privilegios);
    expect(privilegios).toBe("nenhum");

    // E a recusa nao apagou o passado de quem entrou.
    expect(livroRazao("limpa-joao").filter((l) => l.acao === "importada")).toHaveLength(2);
  });

  // =========================================================================
  it("10. resposta do aplicativo POR CIMA de linha importada devolve a linha para a pessoa, e a reimportacao passa a ser recusada", () => {
    aplicar(
      entradaBase([
        submissao({
          submissao_id: "bruno-importado",
          email: "bruno@corrida024.test",
          respostas: respostasCompletas("IMPORTADO"),
        }),
      ]),
    );
    expect(respostasDe(P.bruno).every((l) => l.origem === "externo")).toBe(true);

    // A pessoa responde a etapa 103 no aplicativo, por cima da linha importada.
    // O aplicativo grava SO `answers` (e e assim que ele grava): sem o gatilho de
    // proveniencia isso nao deixaria rastro nenhum, e `origem` continuaria
    // dizendo 'externo' -- afirmacao falsa sobre de quem e aquele dado.
    respondePeloAplicativo(P.bruno, 103, "BRUNO RESPONDEU NO APLICATIVO");
    const meio = respostasDe(P.bruno);
    mostrar("DEPOIS da resposta no aplicativo: a procedencia da etapa 103", meio);
    expect(meio.find((l) => l.stage_id === 103)).toEqual({
      stage_id: 103,
      origem: "app",
      marca: "BRUNO RESPONDEU NO APLICATIVO",
      submissao: null,
    });

    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "bruno-importado",
          email: "bruno@corrida024.test",
          respostas: respostasCompletas("REIMPORTADO POR CIMA"),
        }),
      ]),
    );
    const depois = respostasDe(P.bruno);
    mostrar("DEPOIS da reimportacao: resultado e respostas de Bruno", { resultado, respostas: depois });

    expect(resultado.ok).toBe(false);
    expect(resultado.recusadas_na_revalidacao[0].codigo).toBe("resposta_do_aplicativo");
    expect(depois.find((l) => l.stage_id === 103)?.marca).toBe("BRUNO RESPONDEU NO APLICATIVO");
    // E as outras etapas tambem NAO foram atualizadas: o lote e atomico.
    expect(depois.find((l) => l.stage_id === 101)?.marca).toBe("IMPORTADO");
  });

  // =========================================================================
  // CONCORRENCIA REAL. Duas sessoes, duas transacoes, disputando o mesmo
  // participante -- nao duas chamadas em fila. Os dois sentidos da corrida.
  // =========================================================================
  it("11. CONCORRENCIA, sentido A: participante gravando e importacao chegando no meio -> a importacao ESPERA e recusa o lote", async () => {
    const plano = planoDe(
      entradaBase([
        submissao({
          submissao_id: "corrida-diego",
          email: "diego@corrida024.test",
          respostas: respostasCompletas("IMPORTACAO PERDEU A CORRIDA"),
        }),
      ]),
    );
    expect(plano.submissoes[0].estado).toBe("importavel");
    const antes = respostasDe(P.diego);
    mostrar("ANTES: Diego sem resposta, plano decidido como importavel", {
      respostas: antes,
      estado_do_plano: plano.submissoes[0].estado,
    });
    expect(antes).toEqual([]);

    // Sessao 1: o participante grava a etapa 102 e SEGURA a transacao aberta.
    const participante = sqlConcorrente(`
      begin;
      ${escritaDoAplicativo(P.diego, 102, "DIEGO GANHOU A CORRIDA")};
      select pg_sleep(2.5);
      commit;
    `);
    // Sessao 2: a importacao chega NO MEIO da transacao do participante.
    await espera(500);
    const importacao = sqlConcorrente(chamadaSql(plano));

    const [rPart, rImp] = await Promise.all([participante, importacao]);
    const depois = respostasDe(P.diego);
    const resultado = JSON.parse(rImp.saida) as Resultado;
    mostrar("CONCORRENCIA sentido A", {
      participante: { ms: rPart.ms, erro: rPart.erro },
      importacao: { ms: rImp.ms, erro: rImp.erro },
      resultado,
      respostas: depois,
    });

    // A IMPORTACAO ESPEROU. Ela so pode ter visto a escrita do participante
    // depois do commit dele -- e e exatamente a etapa 102 que ela nomeia.
    expect(rPart.erro).toBe("");
    expect(rImp.erro).toBe("");
    expect(rImp.ms).toBeGreaterThan(1000);
    expect(resultado.ok).toBe(false);
    expect(resultado.recusadas_na_revalidacao[0].codigo).toBe("resposta_do_aplicativo");
    expect(resultado.recusadas_na_revalidacao[0].etapas_em_conflito).toEqual(["102"]);
    expect(resultado.linhas_de_resposta_gravadas).toBe(0);

    // A resposta do participante esta la, e NADA foi importado.
    expect(depois).toEqual([
      { stage_id: 102, origem: "app", marca: "DIEGO GANHOU A CORRIDA", submissao: null },
    ]);
    expect(submissaoNoBanco("corrida-diego")).toBeNull();
  });

  // =========================================================================
  it("12. CONCORRENCIA, sentido B: importacao gravando e participante chegando no meio -> o participante ESPERA e a resposta dele NAO e perdida", async () => {
    const plano = planoDe(
      entradaBase([
        submissao({
          submissao_id: "corrida-elisa",
          email: "elisa@corrida024.test",
          respostas: respostasCompletas("IMPORTACAO GANHOU A CORRIDA"),
        }),
      ]),
    );
    expect(respostasDe(P.elisa)).toEqual([]);

    // Sessao 1: a importacao grava o lote e SEGURA a transacao aberta.
    const importacao = sqlConcorrente(`
      begin;
      ${chamadaSql(plano)};
      select pg_sleep(2.5);
      commit;
    `);
    // Sessao 2: o participante grava a etapa 103 NO MEIO da importacao.
    await espera(500);
    const participante = sqlConcorrente(escritaDoAplicativo(P.elisa, 103, "ELISA CHEGOU DEPOIS"));

    const [rImp, rPart] = await Promise.all([importacao, participante]);
    const depois = respostasDe(P.elisa);
    mostrar("CONCORRENCIA sentido B", {
      importacao: { ms: rImp.ms, erro: rImp.erro, saida: rImp.saida.slice(0, 120) },
      participante: { ms: rPart.ms, erro: rPart.erro },
      respostas: depois,
    });

    // O PARTICIPANTE ESPEROU, e nao levou erro: a resposta dele entrou depois.
    expect(rImp.erro).toBe("");
    expect(rPart.erro).toBe("");
    expect(rPart.ms).toBeGreaterThan(1000);

    // A importacao entrou INTEIRA (5 etapas) e a resposta do participante NAO
    // foi perdida: a etapa 103 e dele, e volta a ser 'app'. Nenhuma escrita
    // perdida nos dois sentidos -- e o que serializacao quer dizer.
    expect(depois).toHaveLength(5);
    expect(depois.find((l) => l.stage_id === 103)).toEqual({
      stage_id: 103,
      origem: "app",
      marca: "ELISA CHEGOU DEPOIS",
      submissao: null,
    });
    expect(depois.find((l) => l.stage_id === 101)?.origem).toBe("externo");
    expect(depois.find((l) => l.stage_id === 101)?.marca).toBe("IMPORTACAO GANHOU A CORRIDA");

    // E a reimportacao da MESMA submissao agora e recusada, porque uma das
    // linhas deixou de ser dela.
    const { resultado } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "corrida-elisa",
          email: "elisa@corrida024.test",
          respostas: respostasCompletas("NAO DEVE SOBRESCREVER ELISA"),
        }),
      ]),
    );
    mostrar("DEPOIS: reimportacao da mesma submissao", resultado);
    expect(resultado.ok).toBe(false);
    expect(resultado.recusadas_na_revalidacao[0].codigo).toBe("resposta_do_aplicativo");
    expect(respostasDe(P.elisa).find((l) => l.stage_id === 103)?.marca).toBe("ELISA CHEGOU DEPOIS");
  });

  // =========================================================================
  it("13. SEM DEADLOCK: lote de varios participantes contra escritas simultaneas dos mesmos participantes", async () => {
    // Travar mais de um participante por transacao abre a porta para abraco
    // mortal. O desenho diz que nao pode acontecer (a importacao pega as chaves
    // em ORDEM CRESCENTE de id; cada transacao do aplicativo pega UMA chave --
    // conjunto ordenado contra detentor de recurso unico nao fecha ciclo). Isto
    // nao e um teste de "deu certo uma vez": e a verificacao do invariante que
    // importa, nos dois desfechos possiveis da corrida.
    const alvos = [P.gustavo, P.helena, P.igor, P.julia];
    const emails = [
      "gustavo@corrida024.test",
      "helena@corrida024.test",
      "igor@corrida024.test",
      "julia@corrida024.test",
    ];
    const plano = planoDe(
      entradaBase(
        emails.map((email, i) =>
          submissao({
            submissao_id: `enxame-${i}`,
            email,
            respostas: respostasCompletas(`ENXAME ${i}`),
          }),
        ),
      ),
    );
    const antes = alvos.map(respostasDe);
    mostrar("ANTES do enxame: quantas respostas cada um tem", antes.map((r) => r.length));

    // Uma importacao do lote inteiro e, ao mesmo tempo, uma escrita do
    // aplicativo para CADA participante do lote -- na ordem INVERSA da que a
    // importacao usa, que e o arranjo que mais convida ao abraco mortal.
    const tarefas: Promise<Concorrente>[] = [sqlConcorrente(chamadaSql(plano))];
    for (let i = alvos.length - 1; i >= 0; i--) {
      tarefas.push(
        sqlConcorrente(`
          begin;
          ${escritaDoAplicativo(alvos[i], 105, `ENXAME APP ${i}`)};
          select pg_sleep(0.2);
          commit;
        `),
      );
    }
    const r = await Promise.all(tarefas);
    const depois = alvos.map(respostasDe);
    mostrar("DEPOIS do enxame", {
      sessoes: r.map((x, i) => ({ sessao: i === 0 ? "importacao" : `app-${i - 1}`, ms: x.ms, erro: x.erro })),
      importacao: r[0].saida.slice(0, 160),
      etapa105: depois.map((linhas) => linhas.find((l) => l.stage_id === 105) ?? null),
    });

    // INVARIANTE 1: nenhuma sessao morreu, e NENHUM abraco mortal.
    for (const x of r) {
      expect(x.erro).not.toMatch(/deadlock/i);
      expect(x.erro).toBe("");
      expect(x.codigo).toBe(0);
    }

    // INVARIANTE 2: toda escrita do aplicativo que reportou sucesso ESTA LA, com
    // a procedencia dela. Nenhuma resposta de participante perdida, em nenhum
    // dos dois desfechos possiveis do lote.
    depois.forEach((linhas, i) => {
      const etapa = linhas.find((l) => l.stage_id === 105);
      expect(etapa).toBeDefined();
      expect(etapa?.origem).toBe("app");
      expect(etapa?.marca).toBe(`ENXAME APP ${i}`);
    });

    // INVARIANTE 3: o lote e tudo-ou-nada. Ou entrou inteiro (4 submissoes), ou
    // nenhuma submissao do enxame existe.
    const gravadas = Number(
      um(`select count(*) from external_submissions
           where event_id = '${EVENTO}' and submissao_id like 'enxame-%'`),
    );
    mostrar("DEPOIS do enxame: submissoes do enxame gravadas", gravadas);
    expect([0, alvos.length]).toContain(gravadas);
  });
});
