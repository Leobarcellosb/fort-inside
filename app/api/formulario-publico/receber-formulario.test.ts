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
  it("nao cria pessoa duplicada: a segunda substitui a primeira", async () => {
    const banco = bancoPadrao();
    await receberFormulario(banco.cliente, envio({ fullName: "Maria S." }));
    const r2 = await receberFormulario(
      banco.cliente,
      envio({
        fullName: "Maria Silva Souza",
        respostas: { ...RESPOSTAS_COMPLETAS, p1: "18", p4: 3 },
      }),
    );

    expect(r2.tipo).toBe("ok");
    expect(banco.tabelas.participants).toHaveLength(1);
    expect(banco.tabelas.quiz_responses).toHaveLength(2);

    const p = banco.tabelas.participants[0];
    expect(p.full_name).toBe("Maria Silva Souza");
    const etapa1 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 101)!;
    const etapa2 = banco.tabelas.quiz_responses.find((l) => l.stage_id === 102)!;
    expect(etapa1.answers.p1).toBe("18");
    expect(etapa2.answers.p4).toBe(3);
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
    expect(r.tipo).toBe("erro");
    expect(banco.escritas.some((e) => e.startsWith("participants:update"))).toBe(false);
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
    expect(r.tipo).toBe("erro");
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
