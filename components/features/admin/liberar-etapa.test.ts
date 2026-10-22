// A TRAVA DA LIBERAÇÃO DE ETAPA (migration 028), do lado da tela.
//
// O que estes casos provam, e por que cada um existe:
//
//   1. Os TRÊS FATOS do banco chegam ao host como três textos diferentes, e
//      nenhum deles diz que o sistema quebrou. É a exigência que governa o
//      projeto: "não consegui verificar", "verifiquei e recusei" e "recusou e
//      não deu para saber por quê" mandam fazer coisas diferentes.
//   2. O VOCABULÁRIO em TypeScript é o mesmo do SQL da 028 -- comparado contra o
//      arquivo, não contra a memória de quem escreveu. Mesma disciplina do
//      vocabulário da revalidação da 024.
//   3. As PROPRIEDADES DE NÃO-QUEBRA da 028 estão no SQL: o gatilho é só de
//      UPDATE, acorda só quando a etapa MUDA, e a etapa 0 passa sempre. São elas
//      que garantem que aplicar a migration não trava nenhuma escrita que hoje
//      funciona, e por isso são verificadas e não confiadas.
//   4. Texto de banco NÃO chega à tela.
//
// A prova com Postgres de verdade (gravação direta recusada pelo gatilho, e o
// evento ao vivo da versão antiga liberando 1..6 no mesmo banco) é o controle
// desta unidade e está registrada no relatório; aqui se prova o lado puro.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODIGOS_DE_ERRO,
  CODIGOS_DE_LIBERACAO_DE_ETAPA,
  DEFINICOES_DE_ERRO,
  FATOS_DA_LIBERACAO,
  ehCodigoDeErro,
  ehCodigoDeLiberacaoDeEtapa,
  ehFatoDaLiberacaoDeEtapa,
  statusDoCodigo,
} from "../../../lib/erros/codigos";
import { MENSAGEM_GENERICA, mensagemParaHost } from "../../../lib/erros/mensagens-host";
import { classificarRecusaDeLiberacao } from "./liberar-etapa";

const SQL_028 = readFileSync(
  new URL("../../../supabase/migrations/028_liberacao_de_etapa_no_banco.sql", import.meta.url),
  "utf8",
);

/** O erro como o PostgREST o entrega quando o gatilho da 028 recusa. */
const recusaDoBanco = (detail: string, message = "Liberacao de etapa recusada: ...") => ({
  code: "23514",
  message,
  details: detail,
  hint: "...",
});

const CONTEXTO = { etapaPedida: 6, totalEtapas: 5, modo: "live" as string | null };

// Jargão que NUNCA pode chegar ao host (mesma lista de
// components/features/participant/textos-da-navegacao.test.ts, acrescida do que
// esta trava poderia vazar).
const JARGAO =
  /23514|SQLSTATE|PGRST|check_violation|current_stage|quiz_version|stage_number|quiz_stages|policy|RLS|trigger|gatilho|constraint|plpgsql/i;

describe("vocabulário da liberação de etapa", () => {
  it("são os cinco códigos da família, e nenhum deles está na família das telas de processamento", () => {
    expect([...CODIGOS_DE_LIBERACAO_DE_ETAPA].sort()).toEqual([
      "STAGE_RELEASE_MODE_MISMATCH",
      "STAGE_RELEASE_REFUSED_UNNAMED",
      "STAGE_RELEASE_STAGES_UNUSABLE",
      "STAGE_RELEASE_STAGE_ABSENT",
      "STAGE_RELEASE_UNAVAILABLE",
    ]);
    // Os mapas exaustivos de processar-evento.ts e importar-respostas.ts são
    // indexados por `CodigoDeErro`; uma chave que eles não têm devolveria
    // `undefined` em execução. Por isso esta família fica fora dele, como a do
    // documento individual.
    for (const c of CODIGOS_DE_LIBERACAO_DE_ETAPA) {
      expect(ehCodigoDeErro(c)).toBe(false);
      expect(ehCodigoDeLiberacaoDeEtapa(c)).toBe(true);
      expect(CODIGOS_DE_ERRO).not.toContain(c as never);
    }
    for (const c of CODIGOS_DE_ERRO) {
      expect(ehCodigoDeLiberacaoDeEtapa(c)).toBe(false);
    }
  });

  it("os fatos nomeados pelo banco são EXATAMENTE os que o SQL da 028 emite", () => {
    // O lado do banco: todo `detail  = '...'` do gatilho.
    const noSql = [...SQL_028.matchAll(/detail\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(noSql.length, "nenhum DETAIL encontrado na 028").toBeGreaterThan(0);
    expect([...FATOS_DA_LIBERACAO].sort()).toEqual([...new Set(noSql)].sort());
    // E cada fato é reconhecido pelo guarda: vocabulário declarado e não
    // reconhecido seria promessa sem leitor.
    for (const f of FATOS_DA_LIBERACAO) expect(ehFatoDaLiberacaoDeEtapa(f)).toBe(true);
    expect(ehFatoDaLiberacaoDeEtapa("fato_que_o_banco_inventou")).toBe(false);
  });

  it("cada código tem status, texto curto do servidor e mensagem própria do host", () => {
    for (const c of CODIGOS_DE_LIBERACAO_DE_ETAPA) {
      expect([400, 503]).toContain(DEFINICOES_DE_ERRO[c].status);
      expect(statusDoCodigo(c)).toBe(DEFINICOES_DE_ERRO[c].status);
      expect(DEFINICOES_DE_ERRO[c].error.length).toBeGreaterThan(3);
      const msg = mensagemParaHost(c, { etapa_pedida: 6, total_etapas: 5 });
      expect(msg.length).toBeGreaterThan(40);
      expect(msg).not.toBe(MENSAGENS_GENERICA_SENTINELA);
      // Nenhuma mensagem desta família manda APLICAR migration: nenhuma delas
      // significa "o recurso não está instalado" -- e esse fato, de propósito,
      // não tem código aqui (a ausência da 028 não produz erro, produz sucesso).
      expect(msg).not.toMatch(/\baplicar\b|\baplicada\b|migration/i);
      expect(msg, c).not.toMatch(JARGAO);
    }
  });

  it("os fatos VERIFICADOS são 400 e as INDISPONIBILIDADES são 503", () => {
    expect(statusDoCodigo("STAGE_RELEASE_MODE_MISMATCH")).toBe(400);
    expect(statusDoCodigo("STAGE_RELEASE_STAGE_ABSENT")).toBe(400);
    // "não deu para verificar" e "não deu para gravar" nunca viram recusa.
    expect(statusDoCodigo("STAGE_RELEASE_STAGES_UNUSABLE")).toBe(503);
    expect(statusDoCodigo("STAGE_RELEASE_REFUSED_UNNAMED")).toBe(503);
    expect(statusDoCodigo("STAGE_RELEASE_UNAVAILABLE")).toBe(503);
  });
});

// `MENSAGEM_GENERICA` renomeada só para deixar a asserção acima legível.
const MENSAGENS_GENERICA_SENTINELA = MENSAGEM_GENERICA;

describe("a recusa do banco, traduzida para quem conduz o evento", () => {
  it("MODO: o evento assíncrono recebe 'não se aplica', e a mensagem não fala de defeito", () => {
    const r = classificarRecusaDeLiberacao(recusaDoBanco("modo_nao_libera_etapa"), {
      ...CONTEXTO,
      etapaPedida: 3,
      modo: "async",
    });
    expect(r.codigo).toBe("STAGE_RELEASE_MODE_MISMATCH");
    expect(r.detalhes.modo_do_evento).toBe("async");
    expect(r.mensagem).toContain("não se aplica");
    expect(r.mensagem).toContain("assíncrono");
    expect(r.mensagem).toContain("Nenhuma etapa foi liberada");
    // O host não pode sair pensando que o sistema quebrou.
    expect(r.mensagem).not.toMatch(/\berro\b|quebr|falh/i);
  });

  it("MODO com a cópia da tela VELHA: o modo fica 'desconhecido', não 'assíncrono'", () => {
    // A tela achava que era `live` e o banco recusou por modo: afirmar
    // "é assíncrono" seria afirmar o que esta tela não sabe.
    const r = classificarRecusaDeLiberacao(recusaDoBanco("modo_nao_libera_etapa"), {
      ...CONTEXTO,
      modo: "live",
    });
    expect(r.codigo).toBe("STAGE_RELEASE_MODE_MISMATCH");
    expect(r.detalhes.modo_do_evento).toBe("desconhecido");
    expect(r.mensagem).toContain("não se aplica");
    expect(r.mensagem).not.toContain("ele é assíncrono");
  });

  it("ETAPA INEXISTENTE: a mensagem diz QUAL etapa e QUANTAS o evento tem, e manda recarregar", () => {
    const r = classificarRecusaDeLiberacao(recusaDoBanco("etapa_fora_da_versao_do_evento"), CONTEXTO);
    expect(r.codigo).toBe("STAGE_RELEASE_STAGE_ABSENT");
    expect(r.detalhes).toMatchObject({ etapa_pedida: 6, total_etapas: 5 });
    expect(r.mensagem).toContain("etapa 6");
    expect(r.mensagem).toContain("5 etapas");
    expect(r.mensagem).toContain("recarregue a página");
    expect(r.mensagem).toContain("Nada foi alterado");
  });

  it("ETAPA INEXISTENTE sem leitura de total: a mensagem não inventa número", () => {
    const r = classificarRecusaDeLiberacao(recusaDoBanco("etapa_fora_da_versao_do_evento"), {
      ...CONTEXTO,
      totalEtapas: null,
    });
    expect(r.detalhes.total_etapas).toBeUndefined();
    expect(r.mensagem).toContain("não existe no questionário deste evento");
    expect(r.mensagem).not.toMatch(/\d+ etapas?/);
  });

  it("VERSÃO SEM ETAPAS UTILIZÁVEIS: é indisponibilidade, e diz que tentar de novo NÃO resolve", () => {
    const r = classificarRecusaDeLiberacao(recusaDoBanco("versao_sem_etapas_utilizaveis"), CONTEXTO);
    expect(r.codigo).toBe("STAGE_RELEASE_STAGES_UNUSABLE");
    expect(r.mensagem).toContain("não resolve");
    expect(r.mensagem).toContain("equipe técnica");
    expect(r.mensagem).toContain("Nada foi alterado");
  });

  it("RECUSOU E NÃO NOMEOU: afirma a recusa (nada gravado) e NÃO afirma a causa", () => {
    // O banco com uma versão da trava mais nova que esta tela.
    const r = classificarRecusaDeLiberacao(recusaDoBanco("fato_que_a_tela_nao_conhece"), CONTEXTO);
    expect(r.codigo).toBe("STAGE_RELEASE_REFUSED_UNNAMED");
    expect(r.detalhes.fato_do_banco).toBe("fato_que_a_tela_nao_conhece");
    expect(r.mensagem).toContain("RECUSADA");
    expect(r.mensagem).toContain("nada foi gravado");
    expect(r.mensagem).toContain("fato_que_a_tela_nao_conhece");
  });

  it("RECUSOU E NÃO NOMEOU com PROSA de banco no lugar do nome: a prosa não chega à tela", () => {
    const r = classificarRecusaDeLiberacao(
      {
        code: "23514",
        message: 'new row for relation "events" violates check constraint',
        details: 'Failing row contains (uuid, ..., current_stage=6, quiz_version=2).',
        hint: null,
      },
      CONTEXTO,
    );
    expect(r.codigo).toBe("STAGE_RELEASE_REFUSED_UNNAMED");
    // Nome não citável => não é citado. A prosa fica no console, não no toast.
    expect(r.detalhes.fato_do_banco).toBeUndefined();
    expect(r.mensagem).not.toContain("Failing row");
    expect(r.mensagem).not.toMatch(JARGAO);
  });

  it("NÃO DEU PARA GRAVAR: não se afirma recusa, porque não se sabe se a gravação passou", () => {
    for (const erro of [
      null,
      undefined,
      {},
      { message: "TypeError: Failed to fetch" },
      { code: "PGRST301", message: "JWT expired" },
    ]) {
      const r = classificarRecusaDeLiberacao(erro, CONTEXTO);
      expect(r.codigo, JSON.stringify(erro)).toBe("STAGE_RELEASE_UNAVAILABLE");
      // A frase tem de NEGAR as duas afirmações, como PROGNOSTIC_WRITE_UNAVAILABLE
      // faz: não afirma que foi recusada e não afirma que passou. Dizer "a etapa
      // não foi liberada" aqui seria afirmar o que não se sabe -- e afirmação
      // falsa é pior que o enigma, porque deixa quem lê tranquilo.
      expect(r.mensagem, JSON.stringify(erro)).toContain("não deu para saber");
      expect(r.mensagem).toContain("NÃO quer dizer que a liberação foi recusada");
      expect(r.mensagem).toContain("não quer dizer que ela passou");
      expect(r.mensagem).toContain("Recarregue a página");
      expect(r.mensagem).not.toMatch(JARGAO);
    }
  });

  it("os cinco desfechos têm textos DIFERENTES entre si (nenhum colapso)", () => {
    const textos = new Set(
      CODIGOS_DE_LIBERACAO_DE_ETAPA.map((c) =>
        mensagemParaHost(c, { etapa_pedida: 6, total_etapas: 5, modo_do_evento: "async" }),
      ),
    );
    expect(textos.size).toBe(CODIGOS_DE_LIBERACAO_DE_ETAPA.length);
  });

  it("o nome do fato é achado mesmo se o cliente concatenar os campos do erro", () => {
    const r = classificarRecusaDeLiberacao(
      { code: "23514", message: "recusado (DETAIL: modo_nao_libera_etapa)", details: null },
      { ...CONTEXTO, modo: "async" },
    );
    expect(r.codigo).toBe("STAGE_RELEASE_MODE_MISMATCH");
  });

  it("toda ocorrência é um identificador curto e citável, e nunca carrega dado do erro", () => {
    const r = classificarRecusaDeLiberacao(recusaDoBanco("modo_nao_libera_etapa"), CONTEXTO);
    expect(r.ocorrencia).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("as propriedades de NÃO-QUEBRA da migration 028, lidas do SQL", () => {
  it("o gatilho é BEFORE UPDATE e NÃO dispara no INSERT (semeadura e restauração de dump seguem passando)", () => {
    const def = /create trigger events_liberacao_de_etapa([\s\S]*?);/.exec(SQL_028);
    expect(def, "o gatilho da 028 não foi encontrado").not.toBeNull();
    const corpo = def?.[1] ?? "";
    expect(corpo).toMatch(/before\s+update\s+on\s+public\.events/);
    expect(corpo).not.toMatch(/\binsert\b/);
  });

  it("o gatilho acorda só quando a etapa MUDA de valor: nenhuma linha existente fica inatualizável", () => {
    const def = /create trigger events_liberacao_de_etapa([\s\S]*?);/.exec(SQL_028);
    expect(def?.[1] ?? "").toMatch(
      /when\s*\(\s*old\.current_stage\s+is\s+distinct\s+from\s+new\.current_stage\s*\)/,
    );
    // `update of coluna` dispararia só por a coluna ser MENCIONADA, ainda que com
    // o mesmo valor -- foi esse o defeito do gatilho da 015, trocado na 025.
    expect(def?.[1] ?? "").not.toMatch(/update\s+of\s+current_stage/);
  });

  it("a etapa 0 passa sempre, em qualquer modo: é o default da coluna e o caminho de reparo", () => {
    expect(SQL_028).toMatch(/if\s+new\.current_stage\s*=\s*0\s+then\s+return\s+new;/);
  });

  it("o critério da etapa é stage_number dentro da quiz_version do evento -- nunca o id da linha nem a constante 6", () => {
    const corpoDaFuncao =
      /create or replace function public\.events_valida_liberacao_de_etapa\(\)([\s\S]*?)\$\$;/.exec(
        SQL_028,
      )?.[1] ?? "";
    expect(corpoDaFuncao).toMatch(/s\.stage_number\s*=\s*new\.current_stage/);
    expect(corpoDaFuncao).toMatch(/s\.quiz_version\s*=\s*new\.quiz_version/);
    // Nenhuma comparação com `s.id` e nenhum total de etapas escrito à mão.
    expect(corpoDaFuncao).not.toMatch(/s\.id\s*=\s*new\.current_stage/);
    expect(corpoDaFuncao).not.toMatch(/current_stage\s*(<=?|>=?|=)\s*6\b/);
  });

  it("a recusa por modo julga pelo modo NOVO da linha, e falha FECHADA para modo ausente ou desconhecido", () => {
    expect(SQL_028).toMatch(/if\s+new\.mode\s+is\s+distinct\s+from\s+'live'\s+then/);
  });
});
