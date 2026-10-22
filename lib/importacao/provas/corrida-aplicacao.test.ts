// PROVA DA CORRIDA: a janela entre a PREVIA e a APLICACAO da importacao
// externa, contra Postgres de verdade.
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
// participantes desta prova tem ids proprios, que nao colidem com os da prova
// de importacao externa (`importacao-externa.test.ts`).
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
// Contra as migrations 001..023 este arquivo fica VERMELHO no cenario 1: e
// assim que ele prova que o defeito existe. Com a 024 aplicada, fica verde.
//
// O QUE ELA PROVA, nesta ordem:
//   1. A CORRIDA: resposta do aplicativo inserida DEPOIS da montagem do plano
//      continua intacta, e a importacao e recusada como CONFLITO;
//   2. CONTROLE POSITIVO: importacao de quem nao respondeu continua gravando
//      (a correcao nao e "recusa tudo");
//   3. CONTROLE POSITIVO: reimportacao da MESMA submissao continua atualizando;
//   4. linha existente de OUTRA submissao externa e CONFLITO, nao atualizacao;
//   5. o livro-razao mostra a recusa com ACAO PROPRIA, e e append-only;
//   6. resposta do aplicativo POR CIMA de linha importada devolve a linha para a
//      pessoa, e a reimportacao daquela submissao passa a ser recusada;
//   7. identidade revalidada: participante que nao e mais do evento nao grava, e
//      nao derruba o lote inteiro.

import { execFileSync } from "node:child_process";
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
  codigo: string | null;
  motivo: string | null;
}

function submissaoNoBanco(submissaoId: string): LinhaDeSubmissao {
  return json<LinhaDeSubmissao>(`
    select coalesce(to_json(t)::text, 'null') from (
      select submissao_id, estado, participant_id::text as participant_id,
             apto_para_pontuar as apto,
             bloqueio ->> 'codigo' as codigo, bloqueio ->> 'motivo' as motivo
        from external_submissions where submissao_id = '${submissaoId}') t
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
    nome_declarado: "Maria Souza",
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

interface Resumo {
  linhas_de_resposta_gravadas: number;
  por_estado: Record<string, number>;
  recusas_na_revalidacao?: number;
  recusadas_na_revalidacao?: { submissao_id: string; codigo: string; motivo: string }[];
}

/** Planeja e APLICA no banco. Devolve o plano e o resumo que a funcao devolveu. */
function aplicar(entrada: Parameters<typeof planejarImportacao>[0]) {
  const plano = planejarImportacao(entrada);
  if (!plano.ok) throw new Error(`plano recusado: ${plano.codigo} ${plano.motivo}`);
  const resumo = json<Resumo>(`select public.importacao_externa_aplicar(${literalJson(plano)})`);
  return { plano, resumo };
}

/** O aplicativo gravando, do jeito que o aplicativo grava: so as tres colunas. */
function respondePeloAplicativo(participante: string, stageId: number, marca: string): void {
  sql(`
    insert into quiz_responses (participant_id, stage_id, answers)
    values ('${participante}', ${stageId}, jsonb_build_object('q1', '${marca}'))
    on conflict (participant_id, stage_id) do update set answers = excluded.answers
  `);
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
  it("1. A CORRIDA: respondeu no aplicativo depois da previa -> resposta INTACTA e importacao recusada como CONFLITO", () => {
    // O plano e montado AGORA, com Maria sem nenhuma resposta: o planejador
    // decide 'importavel', e e uma decisao CORRETA no instante em que e tomada.
    const entrada = entradaBase([
      submissao({ submissao_id: "corrida-maria", email: "maria@corrida024.test" }),
    ]);
    const plano = planejarImportacao(entrada);
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes[0].estado).toBe("importavel");
    expect(plano.submissoes[0].participant_id).toBe(P.maria);
    mostrar("ANTES: respostas de Maria (nenhuma) e o que o plano decidiu", {
      respostas: respostasDe(P.maria),
      estado_do_plano: plano.submissoes[0].estado,
      etapas_a_gravar: plano.submissoes[0].etapas.length,
    });
    expect(respostasDe(P.maria)).toEqual([]);

    // AQUI ESTA A JANELA: a pessoa responde PELO APLICATIVO, depois de a previa
    // ter sido montada e antes de a funcao rodar.
    respondePeloAplicativo(P.maria, 101, "RESPOSTA DA MARIA NO APLICATIVO");
    const antes = respostasDe(P.maria);
    mostrar("ANTES da aplicacao: Maria JA respondeu a etapa 101 no aplicativo", antes);
    expect(antes).toEqual([
      { stage_id: 101, origem: "app", marca: "RESPOSTA DA MARIA NO APLICATIVO", submissao: null },
    ]);

    // A impressao da previa continua CORRETA: o plano nao mudou. Quem mudou foi
    // o banco. E por isso que um hash correto nao pode ser a autorizacao final.
    const resumo = json<Resumo>(
      `select public.importacao_externa_aplicar(${literalJson(plano)})`,
    );
    const depois = respostasDe(P.maria);
    mostrar("DEPOIS da aplicacao: resumo e respostas de Maria", { resumo, respostas: depois });

    // A RESPOSTA DELA FICA. Nenhuma linha dela virou 'externo'.
    expect(depois).toEqual([
      { stage_id: 101, origem: "app", marca: "RESPOSTA DA MARIA NO APLICATIVO", submissao: null },
    ]);
    expect(resumo.linhas_de_resposta_gravadas).toBe(0);

    // E A IMPORTACAO E RECUSADA COMO CONFLITO, com nome e motivo.
    const sub = submissaoNoBanco("corrida-maria");
    mostrar("DEPOIS: a submissao no banco", sub);
    expect(sub.estado).toBe("conflito");
    expect(sub.participant_id).toBeNull();
    expect(sub.apto).toBe(false);
    expect(sub.codigo).toBe("resposta_do_aplicativo");
    expect(sub.motivo).toContain("RECUSADA NA REVALIDACAO");
    expect(resumo.por_estado.importavel ?? 0).toBe(0);
    expect(resumo.por_estado.conflito).toBe(1);
    expect(resumo.recusas_na_revalidacao).toBe(1);
    expect(resumo.recusadas_na_revalidacao?.[0].submissao_id).toBe("corrida-maria");

    // O payload cru NAO foi descartado: dado coletado de uma pessoa nao se joga
    // fora so porque a gravacao foi recusada.
    const itens = Number(
      um(`select count(*) from external_response_items i
            join external_submissions es on es.id = i.submission_id
           where es.submissao_id = 'corrida-maria'`),
    );
    expect(itens).toBeGreaterThan(0);

    // A visao de aptidao nao finge que foi identidade nao resolvida.
    const apt = json<{ pode_pontuar: boolean; codigo: string }>(`
      select to_json(t)::text from (
        select pode_pontuar, codigo from v_aptidao_pontuacao_externa
         where submission_id = (select id from external_submissions where submissao_id = 'corrida-maria')) t
    `);
    mostrar("DEPOIS: v_aptidao_pontuacao_externa", apt);
    expect(apt.pode_pontuar).toBe(false);
    expect(apt.codigo).toBe("RECUSADA_NA_REVALIDACAO");
  });

  // =========================================================================
  it("2. CONTROLE POSITIVO: quem nao respondeu continua entrando (a correcao nao e 'recusa tudo')", () => {
    const antes = respostasDe(P.joao);
    mostrar("ANTES: respostas de Joao", antes);
    expect(antes).toEqual([]);

    const { plano, resumo } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "limpa-joao",
          email: "joao@corrida024.test",
          respostas: respostasCompletas("IMPORTADO DO FORMULARIO"),
        }),
      ]),
    );
    expect(plano.ok && plano.submissoes[0].estado).toBe("importavel");

    const depois = respostasDe(P.joao);
    mostrar("DEPOIS: resumo e respostas de Joao", { resumo, respostas: depois });
    expect(resumo.linhas_de_resposta_gravadas).toBe(5);
    expect(resumo.recusas_na_revalidacao).toBe(0);
    expect(depois.map((l) => l.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(depois.every((l) => l.origem === "externo")).toBe(true);
    expect(depois.every((l) => l.submissao === "limpa-joao")).toBe(true);
    expect(depois[0].marca).toBe("IMPORTADO DO FORMULARIO");

    const sub = submissaoNoBanco("limpa-joao");
    mostrar("DEPOIS: a submissao no banco", sub);
    expect(sub.estado).toBe("importavel");
    expect(sub.apto).toBe(true);
    expect(livroRazao("limpa-joao").map((l) => l.acao)).toEqual(["importada"]);
  });

  // =========================================================================
  it("3. CONTROLE POSITIVO: reimportar a MESMA submissao continua ATUALIZANDO", () => {
    const antes = respostasDe(P.joao);
    mostrar("ANTES: respostas de Joao, vindas de limpa-joao", antes);
    expect(antes[0].marca).toBe("IMPORTADO DO FORMULARIO");

    // Mesmo formulario, MESMO submissao_id, conteudo corrigido.
    const { resumo } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "limpa-joao",
          email: "joao@corrida024.test",
          respostas: respostasCompletas("REIMPORTADO APOS CORRECAO"),
        }),
      ]),
    );
    const depois = respostasDe(P.joao);
    mostrar("DEPOIS: resumo e respostas de Joao", { resumo, respostas: depois });

    expect(resumo.linhas_de_resposta_gravadas).toBe(5);
    expect(resumo.recusas_na_revalidacao).toBe(0);
    expect(depois[0].marca).toBe("REIMPORTADO APOS CORRECAO");
    expect(depois.every((l) => l.origem === "externo")).toBe(true);
    expect(depois.every((l) => l.submissao === "limpa-joao")).toBe(true);
    // Nao duplicou linha: continuam 5 etapas, nao 10.
    expect(depois).toHaveLength(5);
    expect(livroRazao("limpa-joao").map((l) => l.acao)).toEqual(["importada", "importada"]);
  });

  // =========================================================================
  it("4. OUTRA submissao externa sobre a mesma linha e CONFLITO, nao atualizacao silenciosa", () => {
    // Ana entra por uma coleta.
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
    expect(antes[0].marca).toBe("COLETA A");

    // Outra submissao, mesmo e-mail, OUTRO submissao_id. O planejador, com a
    // leitura de respostas que a previa teve (zero), decide 'importavel'.
    const { plano, resumo } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "coleta-B-ana",
          email: "ana@corrida024.test",
          respostas: respostasCompletas("COLETA B"),
        }),
      ]),
    );
    expect(plano.ok && plano.submissoes[0].estado).toBe("importavel");

    const depois = respostasDe(P.ana);
    mostrar("DEPOIS: resumo e respostas de Ana", { resumo, respostas: depois });

    // A coleta A fica. A B e recusada.
    expect(depois.every((l) => l.submissao === "coleta-A-ana")).toBe(true);
    expect(depois[0].marca).toBe("COLETA A");
    expect(resumo.linhas_de_resposta_gravadas).toBe(0);
    expect(resumo.recusas_na_revalidacao).toBe(1);

    const sub = submissaoNoBanco("coleta-B-ana");
    mostrar("DEPOIS: a submissao B no banco", sub);
    expect(sub.estado).toBe("conflito");
    expect(sub.participant_id).toBeNull();
    // Qualquer das duas guardas estruturais serve, e as duas dizem CONFLITO: a
    // submissao A ja esta ativa para este participante, e a linha canonica nao e
    // da B. O que NAO se aceita e a B passar por cima em silencio.
    expect(["outra_submissao_ativa_do_participante", "outra_submissao_externa"]).toContain(
      sub.codigo,
    );
    expect(sub.motivo).toContain("CONFLITO");
  });

  // =========================================================================
  it("5. O LIVRO-RAZAO mostra a recusa com ACAO PROPRIA, e continua append-only", () => {
    const razao = livroRazao("corrida-maria");
    mostrar("LIVRO-RAZAO de corrida-maria", razao);
    expect(razao.map((l) => l.acao)).toEqual(["recusada_na_revalidacao"]);
    expect(razao[0].justificativa).toContain("RECUSADA NA REVALIDACAO");

    const razaoB = livroRazao("coleta-B-ana");
    mostrar("LIVRO-RAZAO de coleta-B-ana", razaoB);
    expect(razaoB.map((l) => l.acao)).toEqual(["recusada_na_revalidacao"]);

    // A acao nova NAO e um dos nomes antigos reaproveitados.
    expect(razao[0].acao).not.toBe("retida_conflito");

    // Append-only de verdade: nem o dono do banco reescreve isto por caminho de
    // aplicacao. `anon`/`authenticated`/`service_role` nao tem update nem delete.
    const privilegios = sql(`
      select coalesce(string_agg(distinct grantee || ':' || privilege_type, ', '), 'nenhum')
        from information_schema.role_table_grants
       where table_name = 'external_submission_events'
         and privilege_type in ('UPDATE', 'DELETE')
         and grantee in ('anon', 'authenticated', 'service_role')
    `);
    mostrar("privilegios de UPDATE/DELETE no livro-razao", privilegios);
    expect(privilegios).toBe("nenhum");

    // E a recusa nao apagou o passado de quem entrou: as duas importacoes de
    // Joao continuam escritas.
    expect(livroRazao("limpa-joao")).toHaveLength(2);
  });

  // =========================================================================
  it("6. resposta do aplicativo POR CIMA de linha importada devolve a linha para a pessoa, e a reimportacao passa a ser recusada", () => {
    // Bruno entra por importacao legitima.
    aplicar(
      entradaBase([
        submissao({
          submissao_id: "bruno-importado",
          email: "bruno@corrida024.test",
          respostas: respostasCompletas("IMPORTADO"),
        }),
      ]),
    );
    const antes = respostasDe(P.bruno);
    mostrar("ANTES: respostas de Bruno, importadas", antes);
    expect(antes.every((l) => l.origem === "externo")).toBe(true);

    // Agora a pessoa responde a etapa 103 no aplicativo, por cima da linha
    // importada. O aplicativo grava SO `answers` (e e assim que ele grava): sem a
    // 024 isso nao deixaria rastro nenhum, e `origem` continuaria dizendo
    // 'externo' -- uma afirmacao falsa sobre de quem e aquele dado.
    respondePeloAplicativo(P.bruno, 103, "BRUNO RESPONDEU NO APLICATIVO");
    const meio = respostasDe(P.bruno);
    mostrar("DEPOIS da resposta no aplicativo: a procedencia da etapa 103", meio);
    const etapa103 = meio.find((l) => l.stage_id === 103);
    expect(etapa103).toEqual({
      stage_id: 103,
      origem: "app",
      marca: "BRUNO RESPONDEU NO APLICATIVO",
      submissao: null,
    });

    // E a reimportacao da MESMA submissao, que no caso limpo e legitima, agora e
    // recusada -- porque uma das linhas deixou de ser dela.
    const { resumo } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "bruno-importado",
          email: "bruno@corrida024.test",
          respostas: respostasCompletas("REIMPORTADO POR CIMA"),
        }),
      ]),
    );
    const depois = respostasDe(P.bruno);
    mostrar("DEPOIS da reimportacao: resumo e respostas de Bruno", { resumo, respostas: depois });

    expect(resumo.linhas_de_resposta_gravadas).toBe(0);
    expect(resumo.recusas_na_revalidacao).toBe(1);
    expect(depois.find((l) => l.stage_id === 103)?.marca).toBe("BRUNO RESPONDEU NO APLICATIVO");
    // E as outras etapas tambem NAO foram atualizadas: a unidade de atomicidade
    // e a submissao inteira.
    expect(depois.find((l) => l.stage_id === 101)?.marca).toBe("IMPORTADO");
    expect(submissaoNoBanco("bruno-importado").codigo).toBe("resposta_do_aplicativo");
  });

  // =========================================================================
  it("7. IDENTIDADE revalidada: participante que nao e deste evento nao grava, e nao derruba o lote", () => {
    const antes = {
      fora_do_evento: respostasDe(FORA_DO_EVENTO),
      carla: respostasDe(P.carla),
    };
    mostrar("ANTES: respostas do participante de outro evento e de Carla", antes);
    expect(antes.fora_do_evento).toEqual([]);
    expect(antes.carla).toEqual([]);

    // Lote com DUAS submissoes: uma que o plano reconcilia com alguem que nao e
    // deste evento, e uma legitima. A legitima tem de entrar.
    const { resumo } = aplicar(
      entradaBase([
        submissao({
          submissao_id: "vizinho-fora",
          email: "vizinho@corrida024.test",
          respostas: respostasCompletas("NAO DEVE ENTRAR"),
        }),
        submissao({
          submissao_id: "carla-legitima",
          email: "carla@corrida024.test",
          respostas: respostasCompletas("CARLA IMPORTADA"),
        }),
      ]),
    );
    const depois = {
      fora_do_evento: respostasDe(FORA_DO_EVENTO),
      carla: respostasDe(P.carla),
    };
    mostrar("DEPOIS: resumo e respostas", { resumo, respostas: depois });

    expect(depois.fora_do_evento).toEqual([]);
    expect(depois.carla).toHaveLength(5);
    expect(depois.carla[0].marca).toBe("CARLA IMPORTADA");
    expect(resumo.linhas_de_resposta_gravadas).toBe(5);
    expect(resumo.recusas_na_revalidacao).toBe(1);

    const sub = submissaoNoBanco("vizinho-fora");
    mostrar("DEPOIS: a submissao recusada por identidade", sub);
    expect(sub.estado).toBe("pendente");
    expect(sub.participant_id).toBeNull();
    expect(sub.codigo).toBe("participante_fora_do_evento");
    expect(livroRazao("vizinho-fora").map((l) => l.acao)).toEqual(["recusada_na_revalidacao"]);
    expect(livroRazao("carla-legitima").map((l) => l.acao)).toEqual(["importada"]);
  });
});
