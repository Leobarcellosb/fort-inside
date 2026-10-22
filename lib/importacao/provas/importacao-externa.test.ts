// PROVA DA PONTE: coleta FORA do aplicativo virando resposta canonica, contra
// Postgres de verdade, com as migrations 001..022 aplicadas.
//
// Como rodar:
//   PROVA_IMPORTACAO_URL="postgresql://...@127.0.0.1:PORTA/postgres" \
//     npx vitest run --config lib/importacao/provas/vitest.prova.config.ts --reporter=verbose
//
// Sem PROVA_IMPORTACAO_URL o arquivo e PULADO, para `npx vitest run` continuar
// verde em maquina sem banco. GUARDA DE ALVO: a URL tem de ser 127.0.0.1,
// localhost ou [::1]. Nunca aponte para producao -- esta prova ESCREVE. Use um
// container descartavel proprio, nao o banco local compartilhado do projeto:
// outras unidades escrevem nele e ja houve contaminacao medida.
//
// O QUE ELA PROVA, nesta ordem:
//   1. a impressao digital do manifesto, lida do BANCO, bate com a publicada;
//   2. importacao legitima ponta a ponta -> resposta canonica PONTUAVEL;
//   3. uma palavra trocada -> DADO INCOMPATIVEL, e NAO pontuacao zero;
//   4. questionario com hash diferente -> recusado ANTES de pontuar (e a
//      funcao do banco tambem recusa o plano recusado);
//   5. identidade sem correspondencia -> PENDENTE, nada gravado como de ninguem;
//   6. submissao duplicada -> CONFLITO explicito para as duas;
//   7. a proveniencia e legivel depois, por quem nao estava aqui;
//   8. a reconciliacao e REVERSIVEL sem apagar o historico.
// Cada negativa tem CONTROLE POSITIVO no mesmo cenario.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { calcularMarcoZero } from "../../scoring/marco-zero";
import { achatarRespostas } from "../../scoring/achatar-respostas";
import { montarManifesto, type LinhaDeEtapa, type ManifestoQuestionario } from "../manifesto-questionario";
import { letraDeclarada } from "../mapear-resposta";
import { casarColunas, lerPlanilha } from "../ler-planilha";
import { planejarImportacao } from "../planejar-importacao";
import type { ParticipanteDoEvento, SubmissaoExterna } from "../reconciliar-identidade";

const URL_ALVO = process.env.PROVA_IMPORTACAO_URL;
const IMPRESSAO_PUBLICADA =
  "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

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
    throw new Error(`PROVA_IMPORTACAO_URL nao e local (host=${host}). Esta prova escreve: abortando.`);
  }
}

const descreve = URL_ALVO ? describe : describe.skip;
const TRABALHO = URL_ALVO ? mkdtempSync(join(tmpdir(), "prova-importacao-")) : "";

/** Roda SQL e devolve as linhas em texto cru, separadas por tab. */
function sql(texto: string): string {
  const arquivo = join(TRABALHO, `q-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(arquivo, texto, "utf8");
  return execFileSync(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", URL_ALVO as string, "-f", arquivo],
    { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
  ).trim();
}

/** Uma linha, uma coluna. */
function um(texto: string): string {
  return sql(texto).split("\n")[0] ?? "";
}

function json<T>(texto: string): T {
  const bruto = um(texto);
  return JSON.parse(bruto === "" ? "null" : bruto) as T;
}

/** Roda SQL esperando ERRO. Devolve a mensagem. Falha se der certo. */
function sqlFalha(texto: string): string {
  try {
    sql(texto);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return (err.stderr ?? err.message ?? String(e)).trim();
  }
  throw new Error("o comando deveria ter falhado e nao falhou");
}

/** Embute um objeto como literal jsonb, sem interpolar nada perigoso. */
function literalJson(valor: unknown): string {
  const t = JSON.stringify(valor);
  if (t.includes("$plano$")) throw new Error("o payload colide com o delimitador");
  return `$plano$${t}$plano$::jsonb`;
}

const EVENTO = "e1e1e1e1-1111-4111-8111-e1e1e1e1e1e1";
const OPERADOR = "0ba0ba0b-0000-4000-8000-0ba0ba0b0ba0";
const FORMULARIO = "1FAIpQLSc-marco-zero-pre-evento";

const P = {
  maria: "11111111-1111-4111-8111-111111111111",
  joao: "22222222-2222-4222-8222-222222222222",
  ana: "33333333-3333-4333-8333-333333333333",
  bruno: "44444444-4444-4444-8444-444444444444",
  carla: "55555555-5555-4555-8555-555555555555",
  diego: "66666666-6666-4666-8666-666666666666",
};

let MANIFESTO: ManifestoQuestionario;

function alternativa(id: string, letra: string): string {
  const o = MANIFESTO.porId[id].options?.find((x) => letraDeclarada(x) === letra);
  if (o === undefined) throw new Error(`manifesto sem ${id}/${letra}`);
  return o;
}

function respostasCompletas(): Record<string, unknown> {
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
  return r;
}

const PARTICIPANTES: ParticipanteDoEvento[] = [
  { id: P.maria, email: "maria@example.org", full_name: "Maria Souza" },
  { id: P.joao, email: "joao@example.org", full_name: "Joao Pereira" },
  { id: P.ana, email: "ana@example.org", full_name: "Ana Lima" },
  { id: P.bruno, email: "bruno@example.org", full_name: "Bruno Dias" },
  { id: P.carla, email: "carla@example.org", full_name: "Carla Reis" },
  { id: P.diego, email: "diego@example.org", full_name: "Diego Melo" },
];

function submissao(over: Partial<SubmissaoExterna>): SubmissaoExterna {
  return {
    submissao_id: "resp-000",
    email: "maria@example.org",
    email_verificado: true,
    nome_declarado: "Maria Souza",
    respostas: respostasCompletas(),
    ...over,
  };
}

function entradaBase(over: Record<string, unknown> = {}) {
  return {
    evento: { id: EVENTO, quiz_version: 2 },
    manifesto: MANIFESTO,
    origem: {
      formulario_id: FORMULARIO,
      formulario_nome: "Marco Zero | Geracao Preparada -- pre-evento",
      impressao_declarada: MANIFESTO.impressao,
    },
    submissoes: [],
    participantes: PARTICIPANTES,
    operador: { id: OPERADOR, email: "host@fortinside.test" },
    ...over,
  } as Parameters<typeof planejarImportacao>[0];
}

/** Planeja e APLICA no banco. Devolve o resumo que a funcao SQL retornou. */
function aplicar(entrada: Parameters<typeof planejarImportacao>[0]) {
  const plano = planejarImportacao(entrada);
  if (!plano.ok) throw new Error(`plano recusado: ${plano.codigo} ${plano.motivo}`);
  const resumo = json<Record<string, unknown>>(
    `select public.importacao_externa_aplicar(${literalJson(plano)})`,
  );
  return { plano, resumo };
}

describe("guarda de alvo", () => {
  it("a URL da prova, quando existe, e local", () => {
    if (URL_ALVO) exigirLocal(URL_ALVO);
    expect(true).toBe(true);
  });
});

descreve("PROVA: importacao externa contra Postgres real", () => {
  beforeAll(() => {
    exigirLocal(URL_ALVO as string);

    // A prova e RE-RODAVEL: apaga o PROPRIO evento antes de comecar (cascade
    // leva participantes, respostas e submissoes DESTE evento, de nenhum outro).
    // Sem isto, a segunda rodada encontraria a reconciliacao do cenario 8 ja
    // revogada e o indice de submissao ativa estouraria -- um vermelho que seria
    // artefato da rodada anterior, nao defeito do produto.
    sql(`delete from events where id = '${EVENTO}'`);

    // Massa propria, com ids proprios. Nada de reutilizar dado de outra unidade.
    const valores = PARTICIPANTES.map(
      (p) => `('${p.id}','${EVENTO}','${p.full_name}','${p.email}')`,
    ).join(",");
    sql(`
      insert into events (id, name, event_code, event_date, status, current_stage, quiz_version, mode, form_opens_at, form_closes_at)
      values ('${EVENTO}', 'Prova 022 importacao externa', 'PROVA022',
              '2026-10-24T13:00:00Z', 'active', 0, 2, 'async',
              '2026-10-22T12:00:00Z', '2026-10-23T23:59:00Z')
      on conflict (id) do nothing;

      insert into participants (id, event_id, full_name, email)
      values ${valores}
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
  it("1. o MANIFESTO lido do banco tem a impressao digital PUBLICADA", () => {
    expect(MANIFESTO.impressao).toBe(IMPRESSAO_PUBLICADA);
    expect(MANIFESTO.perguntas).toHaveLength(52);
    expect(MANIFESTO.etapas.map((e) => e.n)).toEqual([1, 2, 3, 4, 5]);
    expect(MANIFESTO.idsDasEtapas).toEqual({ 1: 101, 2: 102, 3: 103, 4: 104, 5: 105 });
  });

  // =========================================================================
  it("2. CONTROLE POSITIVO: importacao legitima vira resposta canonica PONTUAVEL", () => {
    const { plano, resumo } = aplicar(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-maria", email: "maria@example.org" })],
      }),
    );
    expect(plano.ok && plano.submissoes[0].estado).toBe("importavel");
    expect(resumo.linhas_de_resposta_gravadas).toBe(5);

    // O banco gravou 5 etapas, de origem externa, com proveniencia.
    const linhas = json<{ stage_id: number; origem: string; n: number }[]>(`
      select json_agg(json_build_object('stage_id', stage_id, 'origem', origem,
                                        'n', jsonb_object_keys_count) order by stage_id)::text
        from (select stage_id, origem,
                     (select count(*) from jsonb_object_keys(answers)) as jsonb_object_keys_count
                from quiz_responses where participant_id = '${P.maria}') t
    `);
    expect(linhas.map((l) => l.stage_id)).toEqual([101, 102, 103, 104, 105]);
    expect(linhas.every((l) => l.origem === "externo")).toBe(true);
    expect(linhas.map((l) => l.n)).toEqual([6, 9, 24, 6, 7]);

    // E O QUE IMPORTA: o motor pontua essas linhas, lidas do banco.
    const doBanco = json<{ stage_id: number; answers: Record<string, unknown> }[]>(`
      select json_agg(json_build_object('stage_id', stage_id, 'answers', answers)
                      order by stage_id)::text
        from quiz_responses where participant_id = '${P.maria}'
    `);
    const scores = calcularMarcoZero(achatarRespostas(doBanco as never));
    expect(scores.incompleto).toEqual([]);
    const situacional = Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0);
    expect(situacional).toBe(6);
    expect(scores.analiseElementos.status).toBe("completo");
    expect(scores.analiseLikert.status).not.toBe("incompleto");

    // A submissao esta apta, e a visao de aptidao concorda.
    const apt = json<{ pode_pontuar: boolean; codigo: string | null }>(`
      select to_json(t)::text from (
        select pode_pontuar, codigo from v_aptidao_pontuacao_externa
         where participant_id = '${P.maria}') t
    `);
    expect(apt.pode_pontuar).toBe(true);
    expect(apt.codigo).toBeNull();
  });

  // =========================================================================
  it("3. UMA PALAVRA TROCADA: DADO INCOMPATIVEL no banco, e NAO pontuacao zero", () => {
    const r = respostasCompletas();
    const original = alternativa("q43", "D");
    r.q43 = original.replace("prioridades", "prioridade");
    expect(r.q43).not.toBe(original);

    const { resumo } = aplicar(
      entradaBase({
        submissoes: [
          submissao({ submissao_id: "resp-joao", email: "joao@example.org", respostas: r }),
        ],
      }),
    );
    expect(resumo.linhas_de_resposta_gravadas).toBe(5);

    // 3a. A submissao e INCOMPATIVEL e NAO apta. Nao e "pendente" e nao e "ok".
    const sub = json<{ estado: string; apto: boolean; motivo: string }>(`
      select to_json(t)::text from (
        select estado, apto_para_pontuar as apto, bloqueio ->> 'motivo' as motivo
          from external_submissions where submissao_id = 'resp-joao') t
    `);
    expect(sub.estado).toBe("incompativel");
    expect(sub.apto).toBe(false);
    expect(sub.motivo).toContain("DADO INCOMPATIVEL");

    // 3b. O ITEM existe, com estado proprio, SEM valor canonico, com o bruto.
    const item = json<{
      estado: string;
      valor_canonico: unknown;
      valor_bruto: string;
      causa: string;
      pontuada: boolean;
    }>(`
      select to_json(t)::text from (
        select i.estado, i.valor_canonico, i.valor_bruto, i.causa, i.pontuada
          from external_response_items i
          join external_submissions s on s.id = i.submission_id
         where s.submissao_id = 'resp-joao' and i.pergunta_id = 'q43') t
    `);
    expect(item.estado).toBe("incompativel");
    expect(item.valor_canonico).toBeNull(); // nunca 0, nunca "A", nunca ""
    expect(item.valor_bruto).toBe(r.q43);
    expect(item.causa).toBe("alternativa_desconhecida");
    expect(item.pontuada).toBe(true);

    // 3c. A visao de aptidao diz DADO_INCOMPATIVEL, nomeando a pergunta.
    const apt = json<{
      pode_pontuar: boolean;
      codigo: string;
      perguntas: string[];
      incompativeis: { pergunta_id: string; respondido: string }[];
    }>(`
      select to_json(t)::text from (
        select pode_pontuar, codigo, perguntas, incompativeis
          from v_aptidao_pontuacao_externa where participant_id = '${P.joao}') t
    `);
    expect(apt.pode_pontuar).toBe(false);
    expect(apt.codigo).toBe("DADO_INCOMPATIVEL");
    expect(apt.perguntas).toEqual(["q43"]);
    expect(apt.incompativeis[0].pergunta_id).toBe("q43");
    expect(apt.incompativeis[0].respondido).toBe(r.q43);

    // 3d. A LINHA CANONICA carrega a incompatibilidade: nao da para pontuar sem ver.
    const etapa = json<{ incompativeis: string[]; apto: boolean; chaves: number }>(`
      select to_json(t)::text from (
        select importacao -> 'incompativeis' as incompativeis,
               (importacao ->> 'apto_para_pontuar')::boolean as apto,
               (select count(*) from jsonb_object_keys(answers)) as chaves
          from quiz_responses where participant_id = '${P.joao}' and stage_id = 104) t
    `);
    expect(etapa.incompativeis).toEqual(["q43"]);
    expect(etapa.apto).toBe(false);
    // 3e. UMA incompatibilidade NAO virou SEIS ausencias: as 5 irmas estao la.
    expect(etapa.chaves).toBe(5);

    // 3f. O BANCO PROIBE o contrario: gravar incompativel com valor pontuavel.
    const erro = sqlFalha(`
      update external_response_items i set valor_canonico = '0'::jsonb
        from external_submissions s
       where s.id = i.submission_id and s.submissao_id = 'resp-joao'
         and i.pergunta_id = 'q43'
    `);
    expect(erro).toContain("external_response_items_valor_check");

    // 3g. E proibe marcar apta uma submissao incompativel.
    const erro2 = sqlFalha(`
      update external_submissions set apto_para_pontuar = true where submissao_id = 'resp-joao'
    `);
    expect(erro2).toContain("external_submissions_aptidao_check");
  });

  // =========================================================================
  it("4. HASH DIFERENTE: recusado ANTES de pontuar, e o banco tambem recusa", () => {
    const antes = Number(um("select count(*) from external_submissions"));

    const plano = planejarImportacao(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-ana", email: "ana@example.org" })],
        origem: {
          formulario_id: FORMULARIO,
          formulario_nome: "formulario reescrito",
          impressao_declarada:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
      }),
    );
    expect(plano.ok).toBe(false);
    if (plano.ok) return;
    expect(plano.codigo).toBe("MANIFESTO_DIFERENTE");
    expect(plano.motivo).toContain("Nenhuma resposta foi mapeada, gravada ou pontuada");

    // Nada foi gravado, e a funcao do banco RECUSA o plano recusado.
    const erro = sqlFalha(
      `select public.importacao_externa_aplicar(${literalJson(plano)})`,
    );
    expect(erro).toContain("plano recusado");
    expect(erro).toContain("MANIFESTO_DIFERENTE");
    expect(Number(um("select count(*) from external_submissions"))).toBe(antes);
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.ana}'`))).toBe(0);

    // CONTROLE POSITIVO: a MESMA submissao, com a impressao certa, entra.
    const { plano: bom } = aplicar(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-ana", email: "ana@example.org" })],
      }),
    );
    expect(bom.ok && bom.submissoes[0].estado).toBe("importavel");
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.ana}'`))).toBe(5);
  });

  // =========================================================================
  it("5. IDENTIDADE SEM CORRESPONDENCIA: PENDENTE, nada gravado como de ninguem", () => {
    const { plano } = aplicar(
      entradaBase({
        submissoes: [
          submissao({ submissao_id: "resp-orfa", email: "ninguem@example.org" }),
        ],
      }),
    );
    expect(plano.ok && plano.submissoes[0].estado).toBe("pendente");

    const sub = json<{
      estado: string;
      participant_id: string | null;
      apto: boolean;
      motivo: string;
      email: string;
      brutas: number;
    }>(`
      select to_json(t)::text from (
        select estado, participant_id, apto_para_pontuar as apto,
               bloqueio ->> 'motivo' as motivo, email_coletado as email,
               (select count(*) from jsonb_object_keys(respostas_brutas)) as brutas
          from external_submissions where submissao_id = 'resp-orfa') t
    `);
    expect(sub.estado).toBe("pendente");
    expect(sub.participant_id).toBeNull(); // nao foi criado participante nenhum
    expect(sub.apto).toBe(false);
    expect(sub.motivo).toContain("PENDENTE");
    expect(sub.motivo).toContain("sem_correspondencia");
    // NAO foi descartada: as 52 respostas estao guardadas.
    expect(sub.brutas).toBe(52);

    // Nenhum participante novo nasceu do import.
    expect(Number(um(`select count(*) from participants where event_id = '${EVENTO}'`))).toBe(
      PARTICIPANTES.length,
    );
    // E nenhuma resposta canonica foi criada sem dono.
    expect(
      Number(
        um(`select count(*) from quiz_responses qr
              join external_submissions s on s.id = qr.external_submission_id
             where s.submissao_id = 'resp-orfa'`),
      ),
    ).toBe(0);

    // O banco PROIBE pendente apontando para alguem.
    const erro = sqlFalha(`
      update external_submissions set participant_id = '${P.bruno}'
       where submissao_id = 'resp-orfa'
    `);
    expect(erro).toContain("external_submissions_identidade_check");

    // CONTROLE POSITIVO: a mesma pessoa com e-mail que casa reconcilia.
    const { plano: bom } = aplicar(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-bruno", email: "bruno@example.org" })],
      }),
    );
    expect(bom.ok && bom.submissoes[0].estado).toBe("importavel");
  });

  // =========================================================================
  it("6. SUBMISSAO DUPLICADA: conflito explicito para as DUAS, nenhuma escolhida", () => {
    const { plano } = aplicar(
      entradaBase({
        submissoes: [
          submissao({ submissao_id: "resp-carla-1", email: "carla@example.org" }),
          submissao({ submissao_id: "resp-carla-2", email: "carla@example.org" }),
        ],
      }),
    );
    if (!plano.ok) throw new Error("plano recusado");
    expect(plano.submissoes.map((s) => s.estado)).toEqual(["conflito", "conflito"]);

    const subs = json<{ submissao_id: string; estado: string; motivo: string }[]>(`
      select json_agg(to_json(t) order by t.submissao_id)::text from (
        select submissao_id, estado, bloqueio ->> 'motivo' as motivo
          from external_submissions where submissao_id like 'resp-carla-%') t
    `);
    expect(subs.map((s) => s.estado)).toEqual(["conflito", "conflito"]);
    for (const s of subs) {
      expect(s.motivo).toContain("duas_submissoes_do_mesmo_email");
      expect(s.motivo).toContain("resp-carla-1");
      expect(s.motivo).toContain("resp-carla-2");
    }
    // Nenhuma resposta canonica foi gravada para a Carla: nao se escolhe por ela.
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.carla}'`))).toBe(0);

    // O BANCO tambem nao deixaria as duas serem importadas: indice unico de
    // submissao ativa por participante.
    const erro = sqlFalha(`
      insert into external_submissions
        (event_id, formulario_id, submissao_id, quiz_version, questionario_impressao,
         respostas_brutas, participant_id, estado, importado_por)
      values
        ('${EVENTO}','${FORMULARIO}','dup-a',2,'${IMPRESSAO_PUBLICADA}','{}'::jsonb,
         '${P.diego}','importavel','${OPERADOR}'),
        ('${EVENTO}','${FORMULARIO}','dup-b',2,'${IMPRESSAO_PUBLICADA}','{}'::jsonb,
         '${P.diego}','importavel','${OPERADOR}')
    `);
    expect(erro).toContain("external_submissions_participante_ativo_idx");

    // CONTROLE POSITIVO: uma unica submissao da Carla reconcilia.
    sql(`delete from external_submissions where submissao_id = 'resp-carla-2'`);
    const { plano: bom } = aplicar(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-carla-1", email: "carla@example.org" })],
      }),
    );
    expect(bom.ok && bom.submissoes[0].estado).toBe("importavel");
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.carla}'`))).toBe(5);
  });

  // =========================================================================
  it("7. a PROVENIENCIA e legivel depois, por quem nao estava aqui", () => {
    const linha = json<Record<string, unknown>>(`
      select to_json(t)::text from (
        select participante, participante_email, etapa, stage_number, origem,
               formulario_id, formulario_nome, submissao_id, quiz_version,
               questionario_impressao, email_coletado, email_verificado,
               email_reconciliado, identidade_via, estado_da_submissao,
               apto_para_pontuar, importado_por, importado_por_email,
               perguntas_incompativeis, itens
          from v_proveniencia_respostas_externas
         where participant_id = '${P.maria}' and stage_id = 104) t
    `);
    expect(linha).toMatchObject({
      participante: "Maria Souza",
      participante_email: "maria@example.org",
      stage_number: 4,
      origem: "externo",
      formulario_id: FORMULARIO,
      submissao_id: "resp-maria",
      quiz_version: 2,
      questionario_impressao: IMPRESSAO_PUBLICADA,
      email_coletado: "maria@example.org",
      email_verificado: true,
      email_reconciliado: "maria@example.org",
      identidade_via: "email_verificado",
      estado_da_submissao: "importavel",
      apto_para_pontuar: true,
      importado_por: OPERADOR,
      importado_por_email: "host@fortinside.test",
      perguntas_incompativeis: [],
    });
    expect(linha.itens).toEqual({ compativeis: 52, incompativeis: 0, ausentes: 0 });

    // E o historico de atos do operador existe para cada submissao.
    const eventos = json<{ submissao_id: string; acao: string }[]>(`
      select json_agg(to_json(t) order by t.submissao_id, t.criado_em)::text from (
        select s.submissao_id, e.acao, e.criado_em, e.operador
          from external_submission_events e
          join external_submissions s on s.id = e.submission_id) t
    `);
    const porSub = new Map(eventos.map((e) => [e.submissao_id, e.acao]));
    expect(porSub.get("resp-maria")).toBe("importada");
    expect(porSub.get("resp-joao")).toBe("retida_incompativel");
    expect(porSub.get("resp-orfa")).toBe("retida_pendente");
    expect(porSub.get("resp-carla-1")).toBeDefined();

    // Historico e APPEND-ONLY: nem o dono reescreve pela aplicacao.
    const erro = sqlFalha(`
      insert into external_submission_events (submission_id, acao, operador)
      select id, 'revogada', '${OPERADOR}' from external_submissions
       where submissao_id = 'resp-maria'
    `);
    expect(erro).toContain("external_submission_events_justificativa_check");
  });

  // =========================================================================
  it("8. a reconciliacao e REVERSIVEL, e a revogacao nao apaga o passado", () => {
    const id = um(`select id from external_submissions where submissao_id = 'resp-bruno'`);
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.bruno}'`))).toBe(5);

    // Revogacao sem justificativa e RECUSADA (controle negativo).
    const erro = sqlFalha(
      `select public.importacao_externa_revogar('${id}'::uuid, '${OPERADOR}'::uuid, '')`,
    );
    expect(erro).toContain("justificativa");

    // Com justificativa: desfaz a ligacao e remove as respostas canonicas.
    const r = json<{ respostas_canonicas_removidas: number; antes: Record<string, unknown> }>(
      `select public.importacao_externa_revogar('${id}'::uuid, '${OPERADOR}'::uuid,
                'e-mail do Bruno pertence a outra pessoa; reconciliacao errada')`,
    );
    expect(r.respostas_canonicas_removidas).toBe(5);
    expect(r.antes.participant_id).toBe(P.bruno);

    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.bruno}'`))).toBe(0);

    // A SUBMISSAO continua la, com o payload cru: nada foi perdido.
    const sub = json<{ estado: string; participant_id: string | null; brutas: number }>(`
      select to_json(t)::text from (
        select estado, participant_id,
               (select count(*) from jsonb_object_keys(respostas_brutas)) as brutas
          from external_submissions where id = '${id}') t
    `);
    expect(sub.estado).toBe("revogada");
    expect(sub.participant_id).toBeNull();
    expect(sub.brutas).toBe(52);

    // O HISTORICO tem os dois atos, em ordem: importada e depois revogada.
    const acoes = sql(
      `select acao from external_submission_events
        where submission_id = '${id}' order by criado_em, acao`,
    ).split("\n");
    expect(acoes).toEqual(["importada", "revogada"]);

    // CONTROLE POSITIVO: depois de revogar, da para reconciliar de novo.
    const { plano } = aplicar(
      entradaBase({
        submissoes: [submissao({ submissao_id: "resp-bruno-2", email: "bruno@example.org" })],
      }),
    );
    expect(plano.ok && plano.submissoes[0].estado).toBe("importavel");
    expect(Number(um(`select count(*) from quiz_responses where participant_id = '${P.bruno}'`))).toBe(5);
  });

  // =========================================================================
  it("9. a importacao NAO IMPERSONA o participante", () => {
    // Nenhuma resposta externa foi gravada como se a pessoa tivesse respondido
    // aqui: todas carregam origem 'externo' e quem as importou.
    const resumo = json<{ total: number; externas: number; sem_operador: number; com_user: number }>(`
      select to_json(t)::text from (
        select
          (select count(*) from quiz_responses) as total,
          (select count(*) from quiz_responses where origem = 'externo') as externas,
          (select count(*) from quiz_responses qr
             join external_submissions s on s.id = qr.external_submission_id
            where s.importado_por is null) as sem_operador,
          (select count(*) from participants
            where event_id = '${EVENTO}' and user_id is not null) as com_user) t
    `);
    expect(resumo.total).toBe(resumo.externas); // toda resposta desta prova veio de fora
    expect(resumo.sem_operador).toBe(0);
    // A importacao nunca ligou participante a login nenhum.
    expect(resumo.com_user).toBe(0);
    // E nenhum usuario de autenticacao foi criado.
    expect(Number(um("select count(*) from auth.users"))).toBe(0);

    // O banco PROIBE resposta 'externo' sem a submissao que a originou.
    const erro = sqlFalha(`
      insert into quiz_responses (participant_id, stage_id, answers, origem)
      values ('${P.diego}', 101, '{}'::jsonb, 'externo')
    `);
    expect(erro).toContain("quiz_responses_proveniencia_check");
  });

  // =========================================================================
  it("10. O CAMINHO DO OPERADOR INTEIRO: planilha do Forms -> resposta pontuavel", () => {
    // O cabecalho que o Google Forms gera: carimbo, e-mail e os 52 ENUNCIADOS.
    const cabecalhos = [
      "Carimbo de data/hora",
      "Endereço de e-mail",
      ...MANIFESTO.perguntas.map((p) => p.text),
    ];

    const casado = casarColunas(MANIFESTO, cabecalhos);
    expect(casado.ok).toBe(true);
    if (!casado.ok) return;
    expect(Object.keys(casado.casamento.porPerguntaId)).toHaveLength(52);

    const respostas = respostasCompletas();
    const celulas: unknown[] = new Array(cabecalhos.length).fill("");
    celulas[0] = "22/10/2026 09:14:02";
    celulas[1] = "diego@example.org";
    for (const [id, i] of Object.entries(casado.casamento.porPerguntaId)) {
      celulas[i] = String(respostas[id]);
    }

    const lido = lerPlanilha(
      casado.casamento,
      [{ celulas, submissao_id: "planilha-linha-2" }],
      // Declarado por quem opera: o formulario foi configurado com respondentes
      // restritos e e-mail verificado (ver docs/FORMULARIO-MARCO-ZERO.md).
      { emailVerificado: true, colunaDoNome: "q1" },
    );
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;

    const { plano, resumo } = aplicar(entradaBase({ submissoes: lido.submissoes }));
    expect(plano.ok && plano.submissoes[0].estado).toBe("importavel");
    expect(resumo.linhas_de_resposta_gravadas).toBe(5);

    const doBanco = json<{ stage_id: number; answers: Record<string, unknown> }[]>(`
      select json_agg(json_build_object('stage_id', stage_id, 'answers', answers)
                      order by stage_id)::text
        from quiz_responses where participant_id = '${P.diego}'
    `);
    const scores = calcularMarcoZero(achatarRespostas(doBanco as never));
    expect(scores.incompleto).toEqual([]);
    expect(Object.values(scores.eixos).reduce((a, e) => a + e.situacional, 0)).toBe(6);
    expect(scores.analiseElementos.status).toBe("completo");

    // CONTROLE NEGATIVO no mesmo caminho: um enunciado renomeado na planilha
    // NAO vira resposta na pergunta parecida -- a leitura recusa antes.
    const mexido = [...cabecalhos];
    const alvo = mexido.findIndex((c) => c === MANIFESTO.porId.q40.text);
    mexido[alvo] = mexido[alvo].replace("importante", "urgente");
    const quebrado = casarColunas(MANIFESTO, mexido);
    expect(quebrado.ok).toBe(false);
    if (quebrado.ok) return;
    expect(quebrado.codigo).toBe("COLUNA_DESCONHECIDA");
    expect(quebrado.casamento.porPerguntaId.q40).toBeUndefined();
    expect(quebrado.casamento.perguntasSemColuna).toEqual(["q40"]);
  });
});
