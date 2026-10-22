// O QUE A RECEPCAO DO FORMULARIO PUBLICO GARANTE.
//
// O banco e falso, mas as REGRAS dele nao: o duplo deste arquivo implementa as
// duas chaves unicas que a migration 001 cria -- `unique(event_id, email)` em
// `participants` e `unique(participant_id, stage_id)` em `quiz_responses` -- e
// sobrescreve SOMENTE as colunas enviadas no upsert, que e o comportamento do
// PostgREST. E isso que torna as provas de "reenviar nao duplica" e "reenviar nao
// apaga o vinculo com a conta" provas de verdade, e nao encenacao.

import { describe, expect, it } from "vitest";
import type { QuizQuestion } from "../../../types/database";
import {
  prazoDoFormulario,
  situacaoDoFormulario,
  receberFormulario,
  type ClienteDeRecepcao,
  type EntradaDoFormulario,
} from "./receber-formulario";

// ---------------------------------------------------------------------------
// O duplo do banco
// ---------------------------------------------------------------------------

interface LinhaParticipante {
  id: string;
  event_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  /** Existe para provar que o upsert do formulario NAO o toca. */
  user_id: string | null;
  course_or_moment: string | null;
  completed_at: string | null;
}

interface LinhaResposta {
  participant_id: string;
  stage_id: number;
  answers: Record<string, unknown>;
}

interface Tabelas {
  events: Record<string, unknown>[];
  quiz_stages: Record<string, unknown>[];
  participants: LinhaParticipante[];
  quiz_responses: LinhaResposta[];
  /** A mesa de decisao do operador (migration 022). */
  external_submissions: Record<string, unknown>[];
  /** O registro do evento (migration 001): onde a procedencia fica. */
  event_logs: Record<string, unknown>[];
}

class BancoFalso {
  readonly tabelas: Tabelas;
  /** Toda escrita, em ordem: serve para provar o que NAO foi escrito. */
  readonly escritas: string[] = [];
  private proximoId = 1;
  /** Falhas injetadas, por "tabela:operacao". */
  readonly falhas = new Map<string, { code: string; message: string }>();

  constructor(tabelas: Partial<Tabelas> = {}) {
    this.tabelas = {
      events: tabelas.events ?? [],
      quiz_stages: tabelas.quiz_stages ?? [],
      participants: tabelas.participants ?? [],
      quiz_responses: tabelas.quiz_responses ?? [],
      external_submissions: tabelas.external_submissions ?? [],
      event_logs: tabelas.event_logs ?? [],
    };
  }

  get cliente(): ClienteDeRecepcao {
    return { from: (tabela: string) => this.daTabela(tabela) };
  }

  private erroDe(chave: string) {
    return this.falhas.get(chave) ?? null;
  }

  private daTabela(tabela: keyof Tabelas | string) {
    const banco = this;
    const linhas = () => (banco.tabelas[tabela as keyof Tabelas] ?? []) as Record<string, unknown>[];

    return {
      select(colunas: string) {
        const filtros: [string, unknown][] = [];
        const resolver = () => {
          const erro = banco.erroDe(`${tabela}:select`);
          if (erro) return { data: null, error: erro };
          const achadas = linhas().filter((l) =>
            filtros.every(([c, v]) => l[c] === v),
          );
          // Devolve so as colunas pedidas: se o codigo passar a depender de uma
          // coluna que nao pediu, o teste quebra em vez de passar por acidente.
          const campos = colunas.split(",").map((c) => c.trim());
          return {
            data: achadas.map((l) =>
              Object.fromEntries(campos.map((c) => [c, l[c]])),
            ),
            error: null,
          };
        };
        const consulta = {
          eq(coluna: string, valor: unknown) {
            filtros.push([coluna, valor]);
            return consulta;
          },
          maybeSingle() {
            const r = resolver();
            return Promise.resolve(
              r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null },
            );
          },
          then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
            return Promise.resolve(resolver()).then(ok, falha);
          },
        };
        return consulta as never;
      },

      insert(valores: Record<string, unknown>) {
        const executar = () => {
          const erro = banco.erroDe(`${tabela}:insert`);
          if (erro) return { data: null, error: erro };
          banco.escritas.push(
            `${tabela}:insert(${Object.keys(valores).sort().join("+")})`,
          );
          // As chaves unicas da 022 que importam aqui: (event_id,
          // formulario_id, submissao_id). Duas submissoes com o mesmo
          // `submissao_id` ESTOURAM, em vez de a segunda sobrescrever a primeira.
          if (tabela === "external_submissions") {
            const igual = linhas().find(
              (l) =>
                l.event_id === valores.event_id &&
                l.formulario_id === valores.formulario_id &&
                l.submissao_id === valores.submissao_id,
            );
            if (igual) {
              return {
                data: null,
                error: {
                  code: "23505",
                  message: "duplicate key value violates external_submissions_natural_idx",
                },
              };
            }
            // Os CHECK da 022 que este caminho nao pode violar.
            const estado = valores.estado as string;
            if (
              (estado === "pendente" || estado === "conflito") &&
              valores.participant_id !== null
            ) {
              return {
                data: null,
                error: { code: "23514", message: "external_submissions_identidade_check" },
              };
            }
            if (valores.apto_para_pontuar === true && estado !== "importavel") {
              return {
                data: null,
                error: { code: "23514", message: "external_submissions_aptidao_check" },
              };
            }
            const bloqueio = valores.bloqueio as Record<string, unknown> | null;
            if (estado !== "importavel" && estado !== "revogada") {
              if (!bloqueio || bloqueio.motivo === undefined) {
                return {
                  data: null,
                  error: { code: "23514", message: "external_submissions_bloqueio_check" },
                };
              }
            }
            if (!/^[0-9a-f]{64}$/.test(String(valores.questionario_impressao))) {
              return {
                data: null,
                error: { code: "23514", message: "external_submissions_impressao_check" },
              };
            }
            const via = valores.identidade_via;
            if (via !== null && via !== "email_verificado" && via !== "decisao_do_operador") {
              return {
                data: null,
                error: { code: "23514", message: "external_submissions_via_check" },
              };
            }
            if (valores.importado_por === null || valores.importado_por === undefined) {
              return {
                data: null,
                error: { code: "23502", message: "importado_por is not null" },
              };
            }
          }
          const linha: Record<string, unknown> = { id: `id-${banco.proximoId++}`, ...valores };
          linhas().push(linha as never);
          return { data: [linha], error: null };
        };

        const insercao = {
          select() {
            return {
              single() {
                const r = executar();
                return Promise.resolve(
                  r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null },
                );
              },
            };
          },
          then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
            return Promise.resolve(executar()).then(ok, falha);
          },
        };
        return insercao as never;
      },

      upsert(
        valores: Record<string, unknown> | Record<string, unknown>[],
        opcoes: { onConflict: string },
      ) {
        const chave = opcoes.onConflict.split(",").map((c) => c.trim());
        const lote = Array.isArray(valores) ? valores : [valores];
        const gravadas: Record<string, unknown>[] = [];

        const executar = () => {
          const erro = banco.erroDe(`${tabela}:upsert`);
          if (erro) return { data: null, error: erro };
          for (const novo of lote) {
            banco.escritas.push(
              `${tabela}:upsert(${Object.keys(novo).sort().join("+")})`,
            );
            const existente = linhas().find((l) =>
              chave.every((c) => l[c] === novo[c]),
            );
            if (existente) {
              // PostgREST: `do update set col = excluded.col` SO para as colunas
              // enviadas. Coluna omitida fica como estava.
              Object.assign(existente, novo);
              gravadas.push(existente);
            } else {
              const linha: Record<string, unknown> = {
                id: `id-${banco.proximoId++}`,
                ...novo,
              };
              if (tabela === "participants") {
                // Defaults da migration 001 para o que o payload nao envia.
                linha.user_id ??= null;
                linha.course_or_moment ??= null;
                linha.completed_at ??= null;
              }
              linhas().push(linha as never);
              gravadas.push(linha);
            }
          }
          return { data: gravadas, error: null };
        };

        const upsert = {
          select() {
            return {
              single() {
                const r = executar();
                return Promise.resolve(
                  r.error ? r : { data: (r.data as unknown[])[0] ?? null, error: null },
                );
              },
            };
          },
          then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
            return Promise.resolve(executar()).then(ok, falha);
          },
        };
        return upsert as never;
      },

      update(valores: Record<string, unknown>) {
        return {
          eq(coluna: string, valor: unknown) {
            return {
              is(colunaNula: string, _nulo: null) {
                const erro = banco.erroDe(`${tabela}:update`);
                if (erro) return Promise.resolve({ error: erro });
                banco.escritas.push(
                  `${tabela}:update(${Object.keys(valores).sort().join("+")}) where ${colunaNula} is null`,
                );
                for (const l of linhas()) {
                  // O `.is(coluna, null)` do PostgREST: UPDATE condicional.
                  if (l[coluna] === valor && l[colunaNula] === null) {
                    Object.assign(l, valores);
                  }
                }
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// O cenario: um evento v2 com duas etapas (a forma do Marco Zero, em miniatura)
// ---------------------------------------------------------------------------

const EVENTO_ID = "evento-1";

function q(parcial: Partial<QuizQuestion> & Pick<QuizQuestion, "id" | "type">): QuizQuestion {
  return { text: `Enunciado ${parcial.id}`, ...parcial } as QuizQuestion;
}

const ETAPA_1 = {
  id: 101,
  stage_number: 1,
  title: "Sobre você",
  quiz_version: 2,
  questions: [
    q({ id: "p1", type: "short_text", required: true, text: "Sua idade" }),
    q({ id: "p2", type: "select", required: true, options: ["A. Sim", "B. Não"] }),
    q({ id: "p3", type: "short_text", text: "Opcional" }),
  ],
};

const ETAPA_2 = {
  id: 102,
  stage_number: 2,
  title: "Elementos",
  quiz_version: 2,
  questions: [
    q({ id: "p4", type: "scale", required: true, min: 0, max: 10 }),
    q({ id: "p5", type: "ranking", required: true, options: ["a", "b", "c"] }),
  ],
};

function bancoPadrao(extra: Partial<Tabelas> = {}) {
  return new BancoFalso({
    events: [
      { id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 2 },
    ],
    quiz_stages: [ETAPA_1, ETAPA_2],
    ...extra,
  });
}

const RESPOSTAS_COMPLETAS = {
  p1: "17",
  p2: "A. Sim",
  p4: 8,
  p5: ["b", "a", "c"],
};

function envio(parcial: Partial<EntradaDoFormulario> = {}): EntradaDoFormulario {
  return {
    eventCode: "MZTESTE",
    fullName: "Maria Silva",
    email: "maria@exemplo.com",
    respostas: RESPOSTAS_COMPLETAS,
    ...parcial,
  };
}

// ---------------------------------------------------------------------------

describe("envio completo", () => {
  it("cria o participante, grava uma linha por etapa e marca a conclusao", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(banco.cliente, envio());

    expect(r.tipo).toBe("ok");
    if (r.tipo !== "ok") return;
    expect(r.etapasGravadas).toBe(2);
    expect(r.concluido).toBe(true);

    expect(banco.tabelas.participants).toHaveLength(1);
    const p = banco.tabelas.participants[0];
    expect(p.full_name).toBe("Maria Silva");
    expect(p.email).toBe("maria@exemplo.com");
    expect(p.completed_at).not.toBeNull();

    expect(banco.tabelas.quiz_responses).toHaveLength(2);
    expect(banco.tabelas.quiz_responses.map((l) => l.stage_id).sort()).toEqual([101, 102]);
  });

  it("grava EXATAMENTE as colunas do fluxo autenticado, e questions_snapshot fica de fora", async () => {
    // A prova de "mesmo formato": se alguem acrescentar coluna aqui, este teste
    // quebra e a decisao tem de ser registrada. `questions_snapshot` nulo e o que
    // a tela autenticada deixa; quem le trata nulo lendo de `quiz_stages`.
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());

    const respostas = banco.escritas.filter((e) => e.startsWith("quiz_responses:upsert"));
    expect(respostas).toHaveLength(2);
    for (const escrita of respostas) {
      expect(escrita).toBe("quiz_responses:upsert(answers+participant_id+stage_id)");
    }
    for (const linha of banco.tabelas.quiz_responses) {
      // `id` nasce do default da tabela (gen_random_uuid), nao do payload.
      const enviadas = Object.keys(linha).filter((c) => c !== "id");
      expect(enviadas.sort()).toEqual(["answers", "participant_id", "stage_id"]);
    }
  });

  it("separa as respostas por etapa, cada linha so com as perguntas dela", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());

    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    const etapa2 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 102)!;
    expect(Object.keys(etapa1.answers).sort()).toEqual(["p1", "p2"]);
    expect(Object.keys(etapa2.answers).sort()).toEqual(["p4", "p5"]);
  });

  it("preserva os formatos que o motor de pontuacao consome", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());

    const etapa2 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 102)!;
    expect(etapa2.answers.p4).toBe(8);
    expect(etapa2.answers.p5).toEqual(["b", "a", "c"]);
    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    // `select` grava o TEXTO da opcao, como a tela autenticada.
    expect(etapa1.answers.p2).toBe("A. Sim");
  });

  it("e-mail vai para minusculas, e nome e telefone vazios viram nulo", async () => {
    const banco = bancoPadrao();
    await receberFormulario(
      banco.cliente,
      envio({ email: "  MARIA@Exemplo.COM ", fullName: "  Maria Silva  ", phone: "   " }),
    );
    const p = banco.tabelas.participants[0];
    expect(p.email).toBe("maria@exemplo.com");
    expect(p.full_name).toBe("Maria Silva");
    expect(p.phone).toBeNull();
  });

  it("id de pergunta que nao pertence ao questionario e ignorado, nao gravado", async () => {
    const banco = bancoPadrao();
    await receberFormulario(
      banco.cliente,
      envio({ respostas: { ...RESPOSTAS_COMPLETAS, inventada: "lixo", __proto__: "x" } }),
    );
    for (const linha of banco.tabelas.quiz_responses) {
      expect(Object.keys(linha.answers)).not.toContain("inventada");
    }
  });

  it("pergunta opcional em branco nao vai para answers", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    expect(etapa1.answers).not.toHaveProperty("p3");
  });
});

describe("o MESMO e-mail no MESMO evento, duas vezes", () => {
  // ESTE BLOCO E O DEFEITO CORRIGIDO. O comportamento anterior era "a segunda
  // substitui a primeira", e com e-mail autodeclarado isso dava a qualquer
  // pessoa o poder de apagar as 52 respostas de outra errando uma letra.

  it("a SEGUNDA NAO apaga a primeira: as respostas de quem respondeu antes ficam intactas", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio({ fullName: "Maria S." }));

    const r2 = await receberFormulario(
      banco.cliente,
      envio({
        fullName: "Joana Outra",
        respostas: { ...RESPOSTAS_COMPLETAS, p1: "18", p4: 3 },
      }),
    );

    expect(r2.tipo).toBe("segunda_resposta_guardada");

    // As respostas da PRIMEIRA, palavra por palavra.
    expect(banco.tabelas.quiz_responses).toHaveLength(2);
    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    const etapa2 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 102)!;
    expect(etapa1.answers.p1).toBe("17");
    expect(etapa2.answers.p4).toBe(8);
    expect(etapa2.answers.p5).toEqual(["b", "a", "c"]);

    // E o NOME de quem respondeu antes tambem nao foi trocado: renomear a
    // pessoa porque alguem errou o e-mail dela tambem e dano.
    expect(banco.tabelas.participants).toHaveLength(1);
    expect(banco.tabelas.participants[0].full_name).toBe("Maria S.");
  });

  it("a segunda nao escreve NADA em quiz_responses nem em participants -- so acrescenta", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    banco.escritas.length = 0;

    await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));

    // A prova pela borda: nenhuma escrita MENCIONOU as tabelas canonicas.
    expect(banco.escritas.filter((e) => e.startsWith("quiz_responses"))).toEqual([]);
    expect(banco.escritas.filter((e) => e.startsWith("participants"))).toEqual([]);
  });

  it("a segunda NAO se perde: vira linha na mesa de decisao, com o payload inteiro", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    await receberFormulario(
      banco.cliente,
      envio({ fullName: "Joana Outra", respostas: { ...RESPOSTAS_COMPLETAS, p1: "18" } }),
    );

    expect(banco.tabelas.external_submissions).toHaveLength(1);
    const s = banco.tabelas.external_submissions[0];
    // O estado que a mesa (ESTADOS_QUE_SE_DECIDEM) lista como "espera humano".
    expect(s.estado).toBe("conflito");
    expect(s.participant_id).toBeNull();
    expect(s.apto_para_pontuar).toBe(false);
    expect(s.nome_declarado).toBe("Joana Outra");
    expect(s.email_coletado).toBe("maria@exemplo.com");
    // As respostas da segunda, inteiras: e delas que a decisao vai ser tomada.
    expect(s.respostas_brutas).toEqual({ ...RESPOSTAS_COMPLETAS, p1: "18" });
    expect((s.bloqueio as Record<string, unknown>).codigo).toBe("SEGUNDA_RESPOSTA_MESMO_EMAIL");
  });

  it("DOIS envios equivocados viram DUAS linhas: a segunda nao sobrescreve a primeira na mesa", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    await receberFormulario(banco.cliente, envio({ fullName: "Joana" }));
    await receberFormulario(banco.cliente, envio({ fullName: "Pedro" }));

    expect(banco.tabelas.external_submissions).toHaveLength(2);
    expect(banco.tabelas.external_submissions.map((s) => s.nome_declarado)).toEqual([
      "Joana",
      "Pedro",
    ]);
  });

  it("o operador consegue ver que houve duas: o fato fica em event_logs", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));

    const log = banco.tabelas.event_logs.find(
      (l) => l.action === "formulario_publico_segunda_resposta",
    )!;
    expect(log).toBeDefined();
    const payload = log.payload as Record<string, unknown>;
    expect(payload.primeira_resposta_preservada).toBe(true);
    expect(payload.na_mesa_de_decisao).toBe(true);
    expect(payload.email_verificado).toBe(false);
  });

  it("se a mesa NAO confirmar, o desfecho e FALHA de gravacao -- e event_logs NAO vira reserva", async () => {
    // A revisao derrubou a reserva antiga ("o envio inteiro vai para
    // event_logs"): log operacional nao e deposito de resposta pessoal, e
    // "guardamos" so pode ser dito com o armazenamento proprio confirmando.
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    banco.falhas.set("external_submissions:insert", {
      code: "42P01",
      message: 'relation "external_submissions" does not exist',
    });

    const r = await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));
    expect(r.tipo).toBe("gravacao_indisponivel");
    if (r.tipo === "gravacao_indisponivel") expect(r.fase).toBe("mesa_de_decisao");

    // O FATO fica registrado, sem nada da pessoa.
    const log = banco.tabelas.event_logs.find(
      (l) => l.action === "formulario_publico_envio_nao_gravado",
    )!;
    expect(log).toBeDefined();
    const payload = log.payload as Record<string, unknown>;
    expect(payload.fase).toBe("mesa_de_decisao");
    expect(payload.codigo_do_banco).toBe("42P01");
    expect(payload.na_mesa_de_decisao).toBe(false);
    expect(payload).not.toHaveProperty("respostas");
    expect(payload).not.toHaveProperty("nome_declarado");
    expect(payload).not.toHaveProperty("email_coletado");
    // Nenhuma linha de "segunda resposta guardada" foi escrita.
    expect(
      banco.tabelas.event_logs.some((l) => String(l.action).startsWith("formulario_publico_segunda")),
    ).toBe(false);
    // E a primeira continua lá, intacta.
    expect(banco.tabelas.quiz_responses).toHaveLength(2);
  });

  it("se NEM a mesa NEM o log receberem, o desfecho continua FALHA, nunca 'guardado'", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    banco.falhas.set("external_submissions:insert", { code: "42P01", message: "sem tabela" });
    banco.falhas.set("event_logs:insert", { code: "42P01", message: "sem tabela" });

    const r = await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));
    expect(r.tipo).toBe("gravacao_indisponivel");
    // E mesmo assim: a primeira nao foi tocada.
    expect(banco.tabelas.quiz_responses).toHaveLength(2);
    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    expect(etapa1.answers.p1).toBe("17");
  });

  it("se a leitura das respostas anteriores falhar, RECUSA em vez de apostar", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    banco.falhas.set("quiz_responses:select", { code: "08006", message: "conexao caiu" });

    const r = await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));
    expect(r.tipo).toBe("erro");
    expect(banco.escritas.filter((e) => e.startsWith("quiz_responses:upsert"))).toHaveLength(2);
  });

  it("participante que existe mas NUNCA respondeu segue pelo caminho feliz", async () => {
    // Quem entrou pelo /join e nao respondeu nao tem nada a perder. Barrar essa
    // pessoa seria impedi-la de responder, sem proteger resposta nenhuma.
    const banco = bancoPadrao({
      participants: [
        {
          id: "p-sem-resposta",
          event_id: EVENTO_ID,
          email: "maria@exemplo.com",
          full_name: "Maria",
          phone: null,
          user_id: null,
          course_or_moment: null,
          completed_at: null,
        },
      ],
    });

    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");
    expect(banco.tabelas.quiz_responses).toHaveLength(2);
    expect(banco.tabelas.external_submissions).toHaveLength(0);
  });

  it("o MESMO envio de novo (mesmo nome, mesmas respostas) nao vai para a mesa: e reconhecido", async () => {
    // O botao "tentar de novo" reenvia o mesmo conteudo. Se a primeira tentativa
    // chegou a gravar e caiu depois, o reenvio nao pode virar "outra pessoa".
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    banco.escritas.length = 0;

    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");
    expect(banco.tabelas.external_submissions).toHaveLength(0);
    // Nada reescrito: nem respostas, nem participante (so o UPDATE condicional).
    expect(banco.escritas.filter((e) => e.startsWith("quiz_responses"))).toEqual([]);
    expect(banco.escritas.filter((e) => e.startsWith("participants:upsert"))).toEqual([]);
  });

  it("mesmas respostas com OUTRO nome continua sendo segunda resposta (vai para a mesa)", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    const r = await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));
    expect(r.tipo).toBe("segunda_resposta_guardada");
    expect(banco.tabelas.external_submissions).toHaveLength(1);
  });

  it("o instante da conclusao e o da PRIMEIRA vez -- reenviar nao o reescreve", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    const primeiro = banco.tabelas.participants[0].completed_at;
    expect(primeiro).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2));
    await receberFormulario(banco.cliente, envio());
    expect(banco.tabelas.participants[0].completed_at).toBe(primeiro);
  });

  it("reenviar NAO apaga o vinculo com a conta nem o campo que o formulario nao coleta", async () => {
    // O caso real: a pessoa entrou antes pelo fluxo autenticado (tem user_id) e
    // depois responde pelo link publico. Se o upsert enviasse `user_id`, ela
    // perderia o acesso a propria conta; se enviasse `course_or_moment`, perderia
    // o que escreveu.
    const banco = bancoPadrao({
      participants: [
        {
          id: "p-existente",
          event_id: EVENTO_ID,
          email: "maria@exemplo.com",
          full_name: "Maria",
          phone: null,
          user_id: "conta-da-maria",
          course_or_moment: "em transição de carreira",
          completed_at: null,
        },
      ],
    });

    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");
    if (r.tipo === "ok") expect(r.participantId).toBe("p-existente");

    const p = banco.tabelas.participants[0];
    expect(p.user_id).toBe("conta-da-maria");
    expect(p.course_or_moment).toBe("em transição de carreira");

    // E a prova pela borda: a escrita nao MENCIONOU essas colunas.
    const upsertDoParticipante = banco.escritas.find((e) => e.startsWith("participants:upsert"))!;
    expect(upsertDoParticipante).toBe("participants:upsert(email+event_id+full_name+phone)");
  });
});

describe("obrigatoria em branco", () => {
  it("recusa dizendo QUAL pergunta falta, com etapa, numero e enunciado", async () => {
    const banco = bancoPadrao();
    const { p1: _fora, ...semP1 } = RESPOSTAS_COMPLETAS;
    const r = await receberFormulario(banco.cliente, envio({ respostas: semP1 }));

    expect(r.tipo).toBe("faltam_obrigatorias");
    if (r.tipo !== "faltam_obrigatorias") return;
    expect(r.etapas).toHaveLength(1);
    expect(r.etapas[0].etapa).toBe(1);
    expect(r.etapas[0].titulo).toBe("Sobre você");
    expect(r.etapas[0].faltando[0]).toMatchObject({
      id: "p1",
      numero: 1,
      texto: "Sua idade",
      motivo: "em_branco",
    });
    expect(r.resumo).toContain("Sua idade");
    expect(r.resumo).toContain("etapa 1");
  });

  it("NAO grava nada: nenhum participante pela metade no banco", async () => {
    const banco = bancoPadrao();
    const { p4: _fora, ...semP4 } = RESPOSTAS_COMPLETAS;
    await receberFormulario(banco.cliente, envio({ respostas: semP4 }));

    expect(banco.escritas).toEqual([]);
    expect(banco.tabelas.participants).toEqual([]);
    expect(banco.tabelas.quiz_responses).toEqual([]);
  });

  it("junta as faltas das varias etapas numa lista so", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(banco.cliente, envio({ respostas: {} }));
    expect(r.tipo).toBe("faltam_obrigatorias");
    if (r.tipo !== "faltam_obrigatorias") return;
    expect(r.etapas.map((e) => e.etapa)).toEqual([1, 2]);
    expect(r.etapas.flatMap((e) => e.faltando.map((f) => f.id))).toEqual([
      "p1",
      "p2",
      "p4",
      "p5",
    ]);
  });

  it("ranking pela metade conta como falta, com o motivo certo", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(
      banco.cliente,
      envio({ respostas: { ...RESPOSTAS_COMPLETAS, p5: ["a"] } }),
    );
    expect(r.tipo).toBe("faltam_obrigatorias");
    if (r.tipo !== "faltam_obrigatorias") return;
    expect(r.etapas[0].faltando[0].motivo).toBe("ranking_incompleto");
  });

  it("escala em zero E uma resposta: nao e recusada", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(
      banco.cliente,
      envio({ respostas: { ...RESPOSTAS_COMPLETAS, p4: 0 } }),
    );
    expect(r.tipo).toBe("ok");
    const etapa2 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 102)!;
    expect(etapa2.answers.p4).toBe(0);
  });
});

describe("formato de resposta incompativel com o tipo da pergunta", () => {
  it("recusa em vez de gravar lixo que o motor de pontuacao rejeitaria depois", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(
      banco.cliente,
      envio({ respostas: { ...RESPOSTAS_COMPLETAS, p4: "oito" } }),
    );
    expect(r.tipo).toBe("resposta_invalida");
    if (r.tipo === "resposta_invalida") {
      expect(r.perguntaId).toBe("p4");
      expect(r.etapa).toBe(2);
    }
    expect(banco.escritas).toEqual([]);
  });

  it("lista com algo que nao e texto tambem e recusada", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(
      banco.cliente,
      envio({ respostas: { ...RESPOSTAS_COMPLETAS, p5: ["a", 2 as unknown as string, "c"] } }),
    );
    expect(r.tipo).toBe("resposta_invalida");
  });
});

describe("o evento", () => {
  it("codigo inexistente: nao encontrado, e nada e escrito", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(banco.cliente, envio({ eventCode: "NAOEXISTE" }));
    expect(r.tipo).toBe("evento_nao_encontrado");
    expect(banco.escritas).toEqual([]);
  });

  it("codigo e lido sem diferenciar maiuscula de minuscula", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(banco.cliente, envio({ eventCode: " mzteste " }));
    expect(r.tipo).toBe("ok");
  });

  it("imersao concluida nao recebe mais resposta", async () => {
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "completed", quiz_version: 2 }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("evento_encerrado");
    expect(banco.escritas).toEqual([]);
  });

  it("um segundo depois do prazo o servidor recusa, e nada e escrito", async () => {
    const fecha = "2026-10-24T02:59:00.000Z"; // sexta 23h59 em Sao Paulo
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 2, form_closes_at: fecha }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    const depois = () => new Date(new Date(fecha).getTime() + 1000);
    const r = await receberFormulario(banco.cliente, envio(), depois);
    expect(r.tipo).toBe("prazo_encerrado");
    expect(banco.escritas).toEqual([]);
  });

  it("prazo rigido: seis minutos depois tambem recusa (nao ha tolerancia sem prova de inicio)", async () => {
    const fecha = "2026-10-24T02:59:00.000Z";
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 2, form_closes_at: fecha }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    const seisMinutosDepois = () => new Date(new Date(fecha).getTime() + 6 * 60 * 1000);
    expect((await receberFormulario(banco.cliente, envio(), seisMinutosDepois)).tipo).toBe("prazo_encerrado");
  });

  it("um instante antes do prazo recebe; no instante do prazo ja recusa", async () => {
    const fecha = "2026-10-24T03:00:00.000Z"; // meia-noite em Sao Paulo: o minuto 23h59 inteiro aberto
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 2, form_closes_at: fecha }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    const antes = () => new Date(new Date(fecha).getTime() - 1);
    expect((await receberFormulario(banco.cliente, envio(), antes)).tipo).toBe("ok");
    const outro = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 2, form_closes_at: fecha }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    expect((await receberFormulario(outro.cliente, envio(), () => new Date(fecha))).tipo).toBe("prazo_encerrado");
    expect(outro.escritas).toEqual([]);
  });

  it("prazo: sem data ou ilegivel e indeterminado, nunca 'aberto' nem 'encerrado'", () => {
    const t = new Date("2026-10-24T03:00:00.000Z").getTime();
    expect(prazoDoFormulario(null, new Date(t + 9e9))).toBe("indeterminado");
    expect(prazoDoFormulario(undefined, new Date(t))).toBe("indeterminado");
    expect(prazoDoFormulario("nao e data", new Date(t + 9e9))).toBe("indeterminado");
    expect(prazoDoFormulario("2026-10-24T03:00:00.000Z", new Date(t - 1))).toBe("aberto");
    expect(prazoDoFormulario("2026-10-24T03:00:00.000Z", new Date(t))).toBe("encerrado");
  });

  it("prazo: a tabela da Rodada 78, em horario de Sao Paulo (UTC-3), sem tolerancia", () => {
    type Linha = [string, string, "aberto" | "encerrado"];
    // Valor recomendado: 03:00:00Z, aberto ate 23h59min59s.
    const recomendado: Linha[] = [
      ["23/10 23h58min59s", "2026-10-24T02:58:59.000Z", "aberto"],
      ["23/10 23h59min00s", "2026-10-24T02:59:00.000Z", "aberto"],
      ["23/10 23h59min30s", "2026-10-24T02:59:30.000Z", "aberto"],
      ["23/10 23h59min59s", "2026-10-24T02:59:59.000Z", "aberto"],
      ["23/10 23h59min59.999s", "2026-10-24T02:59:59.999Z", "aberto"],
      ["24/10 00h00min00s", "2026-10-24T03:00:00.000Z", "encerrado"],
      ["24/10 00h05", "2026-10-24T03:05:00.000Z", "encerrado"],
      ["24/10 00h15min01s (fim da antiga tolerancia)", "2026-10-24T03:15:01.000Z", "encerrado"],
    ];
    for (const [rotulo, quando, esperado] of recomendado) {
      expect(prazoDoFormulario("2026-10-24T03:00:00.000Z", new Date(quando)), rotulo).toBe(esperado);
    }
    // Valor antigo: 02:59:00Z fecha no INICIO do minuto 23h59.
    const antigo: Linha[] = [
      ["23/10 23h58min59.999s", "2026-10-24T02:58:59.999Z", "aberto"],
      ["23/10 23h59min00s", "2026-10-24T02:59:00.000Z", "encerrado"],
      ["23/10 23h59min30s", "2026-10-24T02:59:30.000Z", "encerrado"],
    ];
    for (const [rotulo, quando, esperado] of antigo) {
      expect(prazoDoFormulario("2026-10-24T02:59:00.000Z", new Date(quando)), rotulo).toBe(esperado);
    }
  });

  it("situacao: assincrono sem prazo legivel recusa; ao vivo sem prazo segue aberto", () => {
    const agora = new Date("2026-10-23T12:00:00.000Z");
    expect(situacaoDoFormulario({ status: "live", mode: "async", form_closes_at: null }, agora)).toBe("prazo_indeterminado");
    expect(situacaoDoFormulario({ status: "live", mode: "async", form_closes_at: "nao e data" }, agora)).toBe("prazo_indeterminado");
    expect(situacaoDoFormulario({ status: "live", mode: "live", form_closes_at: null }, agora)).toBe("aberto");
    expect(situacaoDoFormulario({ status: "live", mode: null, form_closes_at: null }, agora)).toBe("aberto");
    expect(situacaoDoFormulario({ status: "live", mode: "async", form_closes_at: "2026-10-24T03:00:00.000Z" }, agora)).toBe("aberto");
  });

  it("situacao: estado encerrado pela administracao recusa mesmo dentro do prazo", () => {
    const agora = new Date("2026-10-23T12:00:00.000Z");
    const prazo = "2026-10-24T03:00:00.000Z";
    for (const status of ["completed", "processing"]) {
      expect(situacaoDoFormulario({ status, mode: "async", form_closes_at: prazo }, agora), status).toBe("evento_encerrado");
    }
    for (const status of ["draft", "live"]) {
      expect(situacaoDoFormulario({ status, mode: "async", form_closes_at: prazo }, agora), status).toBe("aberto");
    }
  });

  it("evento assincrono sem prazo: recusa sem escrever e sem dizer que o prazo terminou", async () => {
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", mode: "async", quiz_version: 2, form_closes_at: null }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("prazo_indeterminado");
    expect(banco.escritas).toEqual([]);
  });

  it("o prazo e decidido UMA vez, no recebimento: gravacao que atravessa o limite termina", async () => {
    const fecha = new Date("2026-10-24T03:00:00.000Z").getTime();
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", mode: "async", quiz_version: 2, form_closes_at: new Date(fecha).toISOString() }],
      quiz_stages: [ETAPA_1, ETAPA_2],
    });
    // O relogio diz "antes" na primeira leitura e "depois" em qualquer outra.
    let leituras = 0;
    const relogio = () => new Date(leituras++ === 0 ? fecha - 1 : fecha + 60_000);
    const r = await receberFormulario(banco.cliente, envio(), relogio);
    expect(r.tipo).toBe("ok");
    expect(leituras).toBe(1);
    expect(banco.escritas.length).toBeGreaterThan(0);
  });

  it("as etapas vem da VERSAO do evento, nunca de um numero fixo", async () => {
    // Etapas da v1 no banco junto com as da v2: so as da versao do evento entram.
    const banco = bancoPadrao();
    banco.tabelas.quiz_stages.push({
      id: 1,
      stage_number: 1,
      title: "Etapa da v1",
      quiz_version: 1,
      questions: [q({ id: "v1a", type: "short_text", required: true })],
    });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");
    expect(banco.tabelas.quiz_responses.map((l) => l.stage_id).sort()).toEqual([101, 102]);
  });
});

describe("questionario em estado inutilizavel", () => {
  it("versao sem etapa nenhuma: recusa sem escrever", async () => {
    const banco = new BancoFalso({
      events: [{ id: EVENTO_ID, event_code: "MZTESTE", status: "live", quiz_version: 9 }],
      quiz_stages: [ETAPA_1],
    });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("questionario_indisponivel");
    expect(banco.escritas).toEqual([]);
  });

  it("numeracao com buraco: recusa (nao se sabe quantas etapas o evento tem)", async () => {
    const banco = bancoPadrao();
    banco.tabelas.quiz_stages = [
      ETAPA_1,
      { ...ETAPA_2, stage_number: 5 },
    ];
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("questionario_indisponivel");
  });

  it("stage_number nulo: recusa", async () => {
    const banco = bancoPadrao();
    banco.tabelas.quiz_stages = [ETAPA_1, { ...ETAPA_2, stage_number: null }];
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("questionario_indisponivel");
  });
});

describe("quando o banco recusa", () => {
  it("falha ao gravar respostas: NAO marca a conclusao", async () => {
    // A propriedade que importa: melhor a pessoa aparecer como pendente, e ser
    // procurada, do que entrar na geracao de segunda-feira sem respostas.
    const banco = bancoPadrao();
    banco.falhas.set("quiz_responses:upsert", { code: "42501", message: "recusado" });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("gravacao_indisponivel");
    if (r.tipo === "gravacao_indisponivel") expect(r.fase).toBe("respostas");
    expect(banco.escritas.some((e) => e.startsWith("participants:update"))).toBe(false);
  });

  it("falha ao gravar o participante: FALHA de gravacao, nada de respostas", async () => {
    const banco = bancoPadrao();
    banco.falhas.set("participants:upsert", { code: "08006", message: "conexao caiu" });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("gravacao_indisponivel");
    if (r.tipo === "gravacao_indisponivel") expect(r.fase).toBe("participante");
    expect(banco.tabelas.quiz_responses).toHaveLength(0);
  });

  it("falha na conclusao, e o MESMO envio reenviado conclui -- sem cair na mesa", async () => {
    const banco = bancoPadrao();
    banco.falhas.set("participants:update", { code: "08006", message: "conexao caiu" });
    const r1 = await receberFormulario(banco.cliente, envio());
    expect(r1.tipo).toBe("gravacao_indisponivel");
    if (r1.tipo === "gravacao_indisponivel") expect(r1.fase).toBe("conclusao");
    expect(banco.tabelas.participants[0].completed_at).toBeNull();

    banco.falhas.delete("participants:update");
    const r2 = await receberFormulario(banco.cliente, envio());
    expect(r2.tipo).toBe("ok");
    expect(banco.tabelas.participants[0].completed_at).not.toBeNull();
    expect(banco.tabelas.external_submissions).toHaveLength(0);
  });

  it("respostas gravadas que nao cobrem todas as etapas: NAO marca a conclusao", async () => {
    const banco = bancoPadrao();
    // Uma etapa a mais no questionario depois do upsert: a releitura nao cobre tudo.
    const cliente = banco.cliente;
    const original = cliente.from.bind(cliente);
    let jaGravou = false;
    const espiao: ClienteDeRecepcao = {
      from(tabela: string) {
        const t = original(tabela);
        if (tabela === "quiz_responses") {
          const upsert = t.upsert.bind(t);
          t.upsert = ((v: never, o: never) => {
            jaGravou = true;
            return upsert(v, o);
          }) as typeof t.upsert;
        }
        if (tabela === "quiz_responses" && jaGravou) {
          banco.tabelas.quiz_responses = [];
        }
        return t;
      },
    };
    const r = await receberFormulario(espiao, envio());
    expect(r.tipo).toBe("gravacao_indisponivel");
    if (r.tipo === "gravacao_indisponivel") expect(r.fase).toBe("conferencia");
    expect(banco.escritas.some((e) => e.startsWith("participants:update"))).toBe(false);
  });

  it("falha de leitura do evento vira erro, nao 'evento nao encontrado'", async () => {
    // Nao saber nao e saber que nao existe: a pessoa receberia "confira o link"
    // para um link perfeitamente correto.
    const banco = bancoPadrao();
    banco.falhas.set("events:select", { code: "08006", message: "conexao caiu" });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("erro");
  });
});

describe("o e-mail autodeclarado NUNCA e marcado como verificado", () => {
  // A revisao proibiu nominalmente "e-mail autodeclarado como verificado". Estes
  // testes sao a varredura do caminho publico inteiro: tudo o que significa
  // "este e-mail foi provado" tem de sair FALSO ou NULO.

  it("o caminho feliz nao escreve user_id, nem qualquer coluna de verificacao", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());

    for (const escrita of banco.escritas) {
      expect(escrita).not.toContain("user_id");
      expect(escrita).not.toContain("email_verificado");
      expect(escrita).not.toContain("identidade_via");
      expect(escrita).not.toContain("email_confirmed");
    }
    expect(banco.tabelas.participants[0].user_id).toBeNull();
  });

  it("a procedencia do caminho feliz diz que o e-mail foi DIGITADO, nao verificado", async () => {
    const banco = bancoPadrao();
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");

    const log = banco.tabelas.event_logs.find(
      (l) => l.action === "formulario_publico_recebido",
    )!;
    expect(log).toBeDefined();
    const payload = log.payload as Record<string, unknown>;
    expect(payload.email_verificado).toBe(false);
    expect(payload.identidade).toBe("email_digitado_nao_verificado");
    expect(payload.identidade_via).toBeNull();
    expect(payload.formulario).toBe("formulario-publico");
  });

  it("a linha da mesa nasce com email_verificado FALSE e identidade_via NULA", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio());
    await receberFormulario(banco.cliente, envio({ fullName: "Joana Outra" }));

    const s = banco.tabelas.external_submissions[0];
    expect(s.email_verificado).toBe(false);
    expect(s.identidade_via).toBeNull();
    expect(s.email_reconciliado).toBeNull();
    expect(s.participant_id).toBeNull();
    // E a proveniencia diz de onde veio, para quem olhar depois.
    expect(s.formulario_id).toBe("formulario-publico");
  });

  it("a procedencia nao pode derrubar o envio: log que falha nao perde resposta", async () => {
    // Se o log falhasse o envio, a pessoa reenviaria -- e o reenvio agora cai na
    // mesa de decisao. Perder procedencia e ruim; empurrar a pessoa para a mesa
    // por causa de um log e pior.
    const banco = bancoPadrao();
    banco.falhas.set("event_logs:insert", { code: "42P01", message: "sem tabela" });
    const r = await receberFormulario(banco.cliente, envio());
    expect(r.tipo).toBe("ok");
    expect(banco.tabelas.quiz_responses).toHaveLength(2);
    expect(banco.tabelas.participants[0].completed_at).not.toBeNull();
  });
});

describe("VARREDURA: event_logs nunca recebe nome, e-mail, telefone ou resposta", () => {
  // Decisao da revisao: "logs operacionais nao podem ser utilizados como
  // deposito alternativo de respostas pessoais completas." Os valores abaixo
  // sao unicos de proposito: se qualquer um aparecer em QUALQUER linha de
  // `event_logs`, em qualquer profundidade do payload, o teste quebra.
  const PESSOAL = {
    nome: "Nomeunico Sobrenomeunico",
    email: "emailunico.varredura@exemplo.com",
    telefone: "11987654329",
    respostas: {
      p1: "respostaunica-p1",
      p2: "A. Sim",
      p3: "respostaunica-p3-opcional",
      p4: 7,
      p5: ["c", "b", "a"],
    },
  };
  const SEGUNDO = {
    nome: "Outronomeunico Diferente",
    respostas: { ...PESSOAL.respostas, p1: "respostaunica-segunda-p1" },
  };
  const proibidos = [
    PESSOAL.nome,
    PESSOAL.email,
    PESSOAL.telefone,
    PESSOAL.respostas.p1,
    PESSOAL.respostas.p3,
    SEGUNDO.nome,
    SEGUNDO.respostas.p1,
  ];
  const envioPessoal = (o: Partial<EntradaDoFormulario> = {}) =>
    envio({
      fullName: PESSOAL.nome,
      email: PESSOAL.email,
      phone: PESSOAL.telefone,
      respostas: PESSOAL.respostas,
      ...o,
    });
  const segundoEnvio = () =>
    envioPessoal({ fullName: SEGUNDO.nome, respostas: SEGUNDO.respostas });

  function varrer(banco: BancoFalso) {
    const texto = JSON.stringify(banco.tabelas.event_logs).toLowerCase();
    for (const p of proibidos) expect(texto).not.toContain(p.toLowerCase());
    // E a forma: nenhuma chave que carregue conteudo pessoal.
    for (const l of banco.tabelas.event_logs) {
      const payload = l.payload as Record<string, unknown>;
      for (const chave of [
        "respostas",
        "answers",
        "email",
        "email_coletado",
        "nome",
        "nome_declarado",
        "full_name",
        "phone",
        "telefone",
      ]) {
        expect(payload).not.toHaveProperty(chave);
      }
    }
  }

  const cenarios: [string, (b: BancoFalso) => Promise<unknown>][] = [
    ["caminho feliz", async (b) => receberFormulario(b.cliente, envioPessoal())],
    [
      "segunda resposta na mesa",
      async (b) => {
        await receberFormulario(b.cliente, envioPessoal());
        return receberFormulario(b.cliente, segundoEnvio());
      },
    ],
    [
      "reenvio identico",
      async (b) => {
        await receberFormulario(b.cliente, envioPessoal());
        return receberFormulario(b.cliente, envioPessoal());
      },
    ],
    [
      "mesa falhou",
      async (b) => {
        await receberFormulario(b.cliente, envioPessoal());
        b.falhas.set("external_submissions:insert", { code: "42501", message: "permission denied" });
        return receberFormulario(b.cliente, segundoEnvio());
      },
    ],
    [
      "participante falhou",
      async (b) => {
        b.falhas.set("participants:upsert", { code: "42501", message: "permission denied" });
        return receberFormulario(b.cliente, envioPessoal());
      },
    ],
    [
      "respostas falharam",
      async (b) => {
        b.falhas.set("quiz_responses:upsert", { code: "42501", message: "permission denied" });
        return receberFormulario(b.cliente, envioPessoal());
      },
    ],
    [
      "conclusao falhou",
      async (b) => {
        b.falhas.set("participants:update", { code: "42501", message: "permission denied" });
        return receberFormulario(b.cliente, envioPessoal());
      },
    ],
  ];

  for (const [nome, rodar] of cenarios) {
    it(`${nome}: nenhum dado pessoal em event_logs`, async () => {
      const banco = bancoPadrao();
      await rodar(banco);
      // O cenario de fato registrou algo -- senao a varredura seria vazia.
      expect(banco.tabelas.event_logs.length).toBeGreaterThan(0);
      varrer(banco);
    });
  }
});
