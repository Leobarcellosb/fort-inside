import { describe, expect, it } from "vitest";
import {
  codigoDeFalhaDeFila,
  indicaEsquemaAusente,
  mensagemDeObjetoAusente,
  nomeDoObjetoAusente,
} from "./falha-de-fila";

// Lacuna medida por outra unidade: `function [^ ]+ does not exist` não casava o
// Postgres CRU, porque a assinatura traz espaço. Cada forma abaixo vem com o seu
// controle positivo (o erro que NÃO é de esquema continua sendo indisponibilidade).

describe("mensagemDeObjetoAusente -- Postgres cru, PostgREST e português", () => {
  it.each([
    ["Postgres cru, assinatura com ESPAÇO (a lacuna medida)", "function public.jobs_consumo_resumo(uuid, text) does not exist"],
    ["Postgres cru, assinatura simples", "function public.jobs_enfileirar(text) does not exist"],
    ["Postgres cru, função sem esquema", "function jobs_enfileirar() does not exist"],
    ["Postgres com SQLERRM e dica", 'ERROR:  function public.f(uuid, text) does not exist\nHINT:  No function matches the given name and argument types.'],
    ["Postgres: relação", 'relation "public.jobs" does not exist'],
    ["Postgres: tabela", 'table "jobs" does not exist'],
    ["Postgres: coluna de relação", 'column "x" of relation "jobs" does not exist'],
    ["PostgREST: função", "Could not find the function public.jobs_enfileirar(p_kind, p_event_id) in the schema cache"],
    ["PostgREST: tabela", "Could not find the table 'public.jobs' in the schema cache"],
    ["português: função", "a função public.jobs_consumo_resumo(uuid, text) não existe"],
    ["português: relação", 'a relação "public.jobs" não existe'],
    ["português: tabela", 'a tabela "jobs" não existe'],
  ])("%s -> objeto ausente", (_n, msg) => {
    expect(mensagemDeObjetoAusente(msg)).toBe(true);
    expect(indicaEsquemaAusente({ message: msg })).toBe(true);
    expect(codigoDeFalhaDeFila({ message: msg })).toBe("QUEUE_SCHEMA_MISSING");
  });

  it("o padrão ANTIGO falharia na mensagem medida (prova de que o ajuste fecha a lacuna)", () => {
    const antigo = /function [^ ]+ does not exist/i;
    expect(antigo.test("function public.jobs_consumo_resumo(uuid, text) does not exist")).toBe(false);
    expect(mensagemDeObjetoAusente("function public.jobs_consumo_resumo(uuid, text) does not exist")).toBe(true);
  });

  it.each([
    ["statement timeout", "canceling statement due to statement timeout"],
    ["rede", "TypeError: fetch failed"],
    ["JWT", "JWT expired"],
    ["unicidade", "duplicate key value violates unique constraint"],
    ["role inexistente (não é objeto de fila)", 'role "foo" does not exist'],
    ["banco inexistente", 'database "foo" does not exist'],
    ["texto qualquer", "alguma coisa que não existe no mundo"],
    ["vazio", ""],
  ])("CONTROLE: %s -> NÃO é esquema ausente (continua indisponibilidade)", (_n, msg) => {
    expect(mensagemDeObjetoAusente(msg)).toBe(false);
    expect(codigoDeFalhaDeFila({ message: msg })).toBe("QUEUE_UNAVAILABLE");
  });

  it("os SQLSTATE continuam valendo mesmo com mensagem opaca (42883, 42P01)", () => {
    expect(codigoDeFalhaDeFila({ code: "42883", message: "opaca" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDeFalhaDeFila({ code: "42P01", message: "opaca" })).toBe("QUEUE_SCHEMA_MISSING");
    expect(codigoDeFalhaDeFila({ code: "57014", message: "opaca" })).toBe("QUEUE_UNAVAILABLE");
  });
});

describe("nomeDoObjetoAusente", () => {
  it.each([
    ["function public.jobs_consumo_resumo(uuid, text) does not exist", "jobs_consumo_resumo"],
    ["Could not find the function public.jobs_enfileirar(p_kind, p_event_id) in the schema cache", "jobs_enfileirar"],
    ["a função public.f_x(uuid, text) não existe", "f_x"],
    ['relation "public.jobs" does not exist', "jobs"],
    ["Could not find the table 'public.jobs' in the schema cache", "jobs"],
  ])("%s -> %s", (msg, nome) => expect(nomeDoObjetoAusente(msg)).toBe(nome));
  it("sem nome -> null", () => expect(nomeDoObjetoAusente("deu ruim")).toBeNull());
});
