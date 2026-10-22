// A TELA DA IMPORTACAO decide por CODIGO, e os TRES FATOS chegam em TRES CLASSES.
//
// Aqui o servidor e a tela sao COMPOSTOS em processo: a resposta REAL que
// `erroHttp` monta (a mesma que as rotas devolvem) e entregue as funcoes da tela,
// que sao as que decidem o texto. Nao ha mensagem escrita a mao dos dois lados.
//
// A prova com HTTP, rotas de verdade e Postgres de verdade esta em
// lib/importacao/provas/borda-http.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODIGOS_DE_ERRO,
  DEFINICOES_DE_ERRO,
  type CodigoDeErro,
} from "../../../lib/erros/codigos";
import { erroHttp } from "../../../lib/erros/resposta";
import { MENSAGEM_GENERICA } from "../../../lib/erros/mensagens-host";
import type { Previa } from "../../../lib/importacao/borda";
import {
  DESFECHO_DO_CODIGO,
  TITULO_DO_AVISO,
  aplicarImportacao,
  conferirPreviaContraGravado,
  desfechoDeErro,
  linhaDaRecusa,
  pedirPrevia,
  porcentagem,
  resumoDaPrevia,
  ROTA_DA_APLICACAO,
  ROTA_DA_PREVIA,
  type Desfecho,
  type PedidoDaTela,
  type Registrador,
  type ResumoGravado,
} from "./importar-respostas";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const PEDIDO: PedidoDaTela = {
  event_id: "e1e1e1e1-1111-4111-8111-e1e1e1e1e1e1",
  formulario_id: "1FAIpQLSc-x",
  impressao_declarada: "a".repeat(64),
  cabecalhos: ["Endereço de e-mail", "P"],
  linhas: [{ celulas: ["maria@example.org", "x"], submissao_id: "resp-1" }],
  email_verificado: true,
};

const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const texto = (d: Desfecho) =>
  ("mensagem" in d ? d.mensagem : "").replace(/Ocorrência: [A-Za-z0-9_-]+\.?/g, "");

/** A tela recebendo a resposta REAL do servidor para um codigo. */
async function daTela(resposta: Response, registrar: Registrador = () => {}): Promise<Desfecho> {
  return pedirPrevia(PEDIDO, async () => resposta.clone(), registrar);
}

// --------------------------------------------------------------- uma previa
const PREVIA: Previa = {
  evento_id: PEDIDO.event_id,
  quiz_version: 2,
  questionario_impressao: "b".repeat(64),
  conferencia_do_manifesto: "igual",
  origem: { formulario_id: PEDIDO.formulario_id, formulario_nome: null },
  operador: { id: "op", email: "host@x" },
  entram: 2,
  retidas_por_identidade: {
    pendentes: 1,
    conflitos: 0,
    submissoes: [{ submissao_id: "resp-3", estado: "pendente", email: "n@x", motivo: "sem correspondencia" }],
  },
  com_dado_incompativel: {
    submissoes: 1,
    itens: 1,
    itens_pontuados: 1,
    perguntas: [
      {
        pergunta_id: "q41",
        enunciado: "Uma situacao",
        pontuada: true,
        instrumento: "situacionais",
        submissoes: 1,
        causas: { alternativa_desconhecida: 1 },
        exemplos: [{ submissao_id: "resp-2", respondido: "C. quase igual", motivo: "alternativa desconhecida" }],
      },
    ],
  },
  linhas_de_resposta_a_gravar: 10,
  itens_a_registrar: 135,
  cobertura: {
    base_de_submissoes: 3,
    perguntas_pontuadas: 45,
    por_instrumento: [
      { instrumento: "likert", perguntas: 32, compativeis: 96, incompativeis: 0, ausentes: 0, cobertura: 1 },
      { instrumento: "elementos", perguntas: 7, compativeis: 21, incompativeis: 0, ausentes: 0, cobertura: 1 },
      { instrumento: "situacionais", perguntas: 6, compativeis: 17, incompativeis: 1, ausentes: 0, cobertura: 17 / 18 },
    ],
    geral: 134 / 135,
  },
  submissoes: [
    { submissao_id: "resp-1", estado: "importavel", email: "a@x", nome_declarado: null, participant_id: "p1", identidade_via: "email_verificado", motivo_da_identidade: null, apto_para_pontuar: true, bloqueio: null, etapas_a_gravar: 5, contagens: { compativeis: 45, incompativeis: 0, incompativeis_pontuadas: 0, ausentes: 0, desconhecidas: 0 } },
    { submissao_id: "resp-2", estado: "incompativel", email: "b@x", nome_declarado: null, participant_id: "p2", identidade_via: "email_verificado", motivo_da_identidade: null, apto_para_pontuar: false, bloqueio: { motivo: "DADO INCOMPATIVEL em 1 pergunta(s)", perguntas: ["q41"] }, etapas_a_gravar: 5, contagens: { compativeis: 44, incompativeis: 1, incompativeis_pontuadas: 1, ausentes: 0, desconhecidas: 0 } },
    { submissao_id: "resp-3", estado: "pendente", email: "n@x", nome_declarado: null, participant_id: null, identidade_via: null, motivo_da_identidade: "sem correspondencia", apto_para_pontuar: false, bloqueio: { motivo: "identidade PENDENTE", perguntas: [] }, etapas_a_gravar: 0, contagens: { compativeis: 0, incompativeis: 0, incompativeis_pontuadas: 0, ausentes: 0, desconhecidas: 0 } },
  ],
  impressao_da_previa: "c".repeat(64),
};

const GRAVADO: ResumoGravado = {
  evento_id: PREVIA.evento_id,
  formulario_id: PREVIA.origem.formulario_id,
  questionario_impressao: PREVIA.questionario_impressao,
  por_estado: { importavel: 1, incompativel: 1, pendente: 1 },
  linhas_de_resposta_gravadas: PREVIA.linhas_de_resposta_a_gravar,
  itens_registrados: PREVIA.itens_a_registrar,
  importado_por: PREVIA.operador.id,
};

// ================================================================= as 3 classes
describe("os tres fatos chegam em tres classes, com tres textos diferentes", () => {
  it("NEGATIVA: o recurso NAO ESTA INSTALADO -> recurso_ausente, e e a UNICA que manda instalar", async () => {
    const d = await daTela(erroHttp("IMPORT_SCHEMA_MISSING"));
    expect(d.tipo).toBe("recurso_ausente");
    if (d.tipo !== "recurso_ausente") return;
    expect(d.acao).toBe("instalar_no_banco");
    expect(texto(d)).toMatch(/migration 022/);
    expect(texto(d)).toMatch(/não está instalada/);
    expect(texto(d)).not.toMatch(/aguarde/i);
  });

  it("NEGATIVA PAREADA: o recurso NAO RESPONDEU -> nao_verificado, e NAO manda instalar nada", async () => {
    const d = await daTela(erroHttp("IMPORT_UNAVAILABLE"));
    expect(d.tipo).toBe("nao_verificado");
    if (d.tipo !== "nao_verificado") return;
    expect(d.acao).toBe("aguardar");
    expect(texto(d)).toMatch(/aguarde/i);
    expect(texto(d)).not.toMatch(/migration|instalar/i);
    // E nao acusa a planilha de quem esta operando.
    expect(texto(d)).toMatch(/não quer dizer que a planilha/i);
  });

  it("NEGATIVA PAREADA: CONFERI E NAO PERMITI -> recusado, com o que corrigir", async () => {
    const d = await daTela(erroHttp("IMPORT_MANIFEST_MISMATCH"));
    expect(d.tipo).toBe("recusado");
    if (d.tipo !== "recusado") return;
    expect(d.acao).toBe("corrigir_coleta");
    expect(texto(d)).toMatch(/NÃO é o que o sistema conhece/);
    expect(texto(d)).not.toMatch(/aguarde|migration/i);
  });

  it("os tres sao DIFERENTES, e os dois 503 nao se confundem apesar do mesmo status", async () => {
    const ausente = await daTela(erroHttp("IMPORT_SCHEMA_MISSING"));
    const indisponivel = await daTela(erroHttp("IMPORT_UNAVAILABLE"));
    const recusado = await daTela(erroHttp("IMPORT_MANIFEST_MISMATCH"));

    expect(DEFINICOES_DE_ERRO.IMPORT_SCHEMA_MISSING.status).toBe(503);
    expect(DEFINICOES_DE_ERRO.IMPORT_UNAVAILABLE.status).toBe(503);
    expect(ausente.tipo).not.toBe(indisponivel.tipo);
    expect(new Set([texto(ausente), texto(indisponivel), texto(recusado)]).size).toBe(3);
  });

  it("NEGATIVA: 'nao deu para conferir a impressao' e sua PROPRIA classe de fato -- nao e 'o questionario esta errado'", async () => {
    const naoConferiu = await daTela(erroHttp("IMPORT_MANIFEST_UNVERIFIABLE"));
    const conferiuEDivergiu = await daTela(erroHttp("IMPORT_MANIFEST_MISMATCH"));
    expect(naoConferiu.tipo).toBe("nao_verificado");
    expect(conferiuEDivergiu.tipo).toBe("recusado");
    expect(texto(naoConferiu)).toMatch(/NÃO quer dizer que o questionário está errado/);
    expect(texto(naoConferiu)).not.toBe(texto(conferiuEDivergiu));
  });
});

// =========================================== autenticacao x permissao
describe("falha de autenticacao nao aparece como falta de permissao", () => {
  it("NEGATIVA: AUTH_UNAVAILABLE (503) -> nao_verificado, e NAO diz 'sem permissao'", async () => {
    const d = await daTela(erroHttp("AUTH_UNAVAILABLE"));
    expect(d.tipo).toBe("nao_verificado");
    expect(texto(d)).not.toMatch(/não tem permissão/);
    expect(texto(d)).toMatch(/não respondeu/);
  });

  it("CONTROLE POSITIVO 1: ADMIN_FORBIDDEN (403) -> recusado, e e a UNICA que fala de permissao", async () => {
    const d = await daTela(erroHttp("ADMIN_FORBIDDEN"));
    expect(d.tipo).toBe("recusado");
    if (d.tipo === "recusado") expect(d.acao).toBe("entrar_de_novo");
    expect(texto(d)).toMatch(/não tem permissão de administrador/);
  });

  it("CONTROLE POSITIVO 2: AUTH_REQUIRED (401) -> recusado, 'entre de novo'", async () => {
    const d = await daTela(erroHttp("AUTH_REQUIRED"));
    expect(d.tipo).toBe("recusado");
    expect(texto(d)).toMatch(/sessão expirou/);
  });
});

// ============================================== o vocabulario e fechado
describe("o vocabulario inteiro e tratado, e nada interno de banco chega a tela", () => {
  it("todo codigo tem classe e acao, e nenhuma classe de 'nao instalado' sobra para quem nao e ausencia", () => {
    for (const c of CODIGOS_DE_ERRO) {
      expect(DESFECHO_DO_CODIGO[c], c).toBeDefined();
    }
    const ausentes = CODIGOS_DE_ERRO.filter((c) => DESFECHO_DO_CODIGO[c].classe === "recurso_ausente").sort();
    expect(ausentes).toEqual([
      "ASYNC_PROCESSING_MISSING",
      "BUDGET_MEASUREMENT_MISSING",
      "IMPORT_SCHEMA_MISSING",
      "QUEUE_SCHEMA_MISSING",
    ]);
  });

  it("qualquer codigo, com texto de banco no `error`, nao vaza nada para a tela", async () => {
    for (const c of CODIGOS_DE_ERRO) {
      const d = await daTela(
        json(DEFINICOES_DE_ERRO[c].status, {
          error: 'PGRST202 relation "external_submissions" does not exist (SQLSTATE 42P01)',
          code: c,
        }),
      );
      expect(texto(d), c).not.toMatch(/PGRST|SQLSTATE|relation|42P01|external_submissions/);
    }
  });

  it.each([
    ["codigo fora do vocabulario", { error: "Erro", code: "ALGO_NOVO" }],
    ["codigo de tipo errado", { error: "Erro", code: 503 }],
    ["codigo vazio", { error: "Erro", code: "" }],
    ["sem codigo", { error: "Erro" }],
    ["corpo que nem e objeto", "Erro"],
  ])("NEGATIVA (%s) -> generica segura + ocorrencia registrada; 'Erro' nao e exibido", async (_n, corpo) => {
    const registros: { ocorrencia: string }[] = [];
    const d = await daTela(json(503, corpo), (r) => { registros.push(r); });
    expect(d.tipo).toBe("erro_inesperado");
    expect(texto(d)).toContain(MENSAGEM_GENERICA);
    expect(texto(d)).not.toBe("Erro");
    expect(texto(d)).not.toMatch(/migration|instalar/i);
    expect(registros).toHaveLength(1);
    if (d.tipo === "erro_inesperado") expect(d.mensagem).toContain(registros[0].ocorrencia);
  });

  it("'Erro' NAO sobrescreve mensagem especifica: com codigo conhecido a mensagem e a do codigo", async () => {
    const d = await daTela(json(503, { error: "Erro", code: "IMPORT_SCHEMA_MISSING" }));
    expect(texto(d)).toMatch(/migration 022/);
  });

  it("NEGATIVA: 200 sem previa utilizavel NAO vira 'nada a importar'", async () => {
    const registros: unknown[] = [];
    const d = await daTela(json(200, { ok: true }), (r) => { registros.push(r); });
    expect(d.tipo).toBe("erro_inesperado");
    expect(registros).toHaveLength(1);
  });

  it("NEGATIVA: sem rede -> sem_conexao, e diz que nada foi gravado", async () => {
    const d = await pedirPrevia(PEDIDO, async () => {
      throw new Error("fetch failed");
    });
    expect(d.tipo).toBe("sem_conexao");
    expect(texto(d)).toMatch(/nada foi gravado/i);
  });

  it("CONTROLE POSITIVO: 200 com previa -> tipo `previa`, e nenhuma ocorrencia registrada", async () => {
    const registros: unknown[] = [];
    const d = await daTela(json(200, { ok: true, previa: PREVIA }), (r) => { registros.push(r); });
    expect(d.tipo).toBe("previa");
    if (d.tipo === "previa") expect(d.previa.impressao_da_previa).toBe(PREVIA.impressao_da_previa);
    expect(registros).toHaveLength(0);
  });
});

// ==================================================== previa x aplicacao
describe("a previa e a aplicacao sao duas rotas, e a confirmacao leva a previa vista", () => {
  it("`pedirPrevia` so conhece a rota da previa -- nao ha como ela gravar", async () => {
    const urls: string[] = [];
    await pedirPrevia(PEDIDO, async (u) => {
      urls.push(u);
      return json(200, { ok: true, previa: PREVIA });
    });
    expect(urls).toEqual([ROTA_DA_PREVIA]);
  });

  it("`aplicarImportacao` envia a impressao DA PREVIA RECEBIDA, nao uma recalculada", async () => {
    let corpoEnviado: Record<string, unknown> = {};
    let url = "";
    await aplicarImportacao(PEDIDO, PREVIA, async (u, init) => {
      url = u;
      corpoEnviado = JSON.parse(String(init?.body));
      return json(200, { ok: true, previa: PREVIA, gravado: GRAVADO });
    });
    expect(url).toBe(ROTA_DA_APLICACAO);
    expect(corpoEnviado.previa_impressao).toBe(PREVIA.impressao_da_previa);
    // E o pedido vai inteiro: a rota monta o MESMO plano a partir dele.
    expect(corpoEnviado.cabecalhos).toEqual(PEDIDO.cabecalhos);
    expect(corpoEnviado.impressao_declarada).toBe(PEDIDO.impressao_declarada);
  });

  it("NEGATIVA: previa vencida -> recusado IMPORT_PREVIEW_STALE, e a mensagem manda conferir de novo", async () => {
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () => erroHttp("IMPORT_PREVIEW_STALE").clone());
    expect(d.tipo).toBe("recusado");
    if (d.tipo !== "recusado") return;
    expect(d.codigo).toBe("IMPORT_PREVIEW_STALE");
    expect(d.acao).toBe("refazer_previa");
    expect(texto(d)).toMatch(/Nada foi gravado/);
    expect(texto(d)).toMatch(/Gere a prévia outra vez/);
  });

  it("NEGATIVA: 200 sem resumo do que foi gravado NAO vira 'gravado'", async () => {
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () => json(200, { ok: true, previa: PREVIA }), () => {});
    expect(d.tipo).toBe("erro_inesperado");
  });

  it("CONTROLE POSITIVO: 200 com previa e resumo -> aplicado", async () => {
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () => json(200, { ok: true, previa: PREVIA, gravado: GRAVADO }));
    expect(d.tipo).toBe("aplicado");
  });

  it("CONTROLE POSITIVO: o lote legitimo continua dizendo que GRAVOU, e a previa bate", async () => {
    // O que impede esta correcao de ser "recusa tudo": o mesmo caminho, com um
    // lote integro, chega a tela como gravacao -- com o titulo de gravacao, nao de
    // recusa -- e a conferencia previa-contra-gravado bate.
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () =>
      json(200, { ok: true, previa: PREVIA, gravado: GRAVADO }),
    );
    expect(d.tipo).toBe("aplicado");
    if (d.tipo !== "aplicado") return;
    expect(TITULO_DO_AVISO[d.tipo]).toBe("Importação gravada");
    expect(TITULO_DO_AVISO[d.tipo]).not.toMatch(/recusad/i);
    expect(d.gravado.linhas_de_resposta_gravadas).toBe(PREVIA.linhas_de_resposta_a_gravar);
    expect(conferirPreviaContraGravado(d.previa, d.gravado)).toEqual({ bate: true });
  });
});

// ======================================= o LOTE RECUSADO na revalidacao, na tela
//
// Um lote recusado NAO E ERRO: e um desfecho previsto que protegeu a resposta de
// alguem. A tela tem de dizer isso, dizer que NADA foi gravado, dizer QUAL
// submissao causou e por que, e dizer o que fazer -- previa nova sem as
// conflitantes. Nada disso pode aparecer como falha de conexao nem como erro
// interno, e nenhum numero estranho pode aparecer como sucesso parcial.
describe("o LOTE RECUSADO na revalidacao e um desfecho PREVISTO, nomeado na tela", () => {
  const detalhesDoLote = (
    recusadas: unknown[],
    revalidacao: string | undefined = "resposta_do_aplicativo",
  ) => ({ ato: "importar_lote", ...(revalidacao ? { revalidacao } : {}), recusadas });

  const recusada = (over: Record<string, unknown> = {}) => ({
    submissao_id: "resp-1",
    codigo: "resposta_do_aplicativo",
    etapas_em_conflito: ["104"],
    etapas_nao_gravadas: 5,
    ...over,
  });

  const respostaDaRota = (detalhes: unknown) =>
    erroHttp("IMPORT_REVALIDATION_REFUSED", { detalhes: detalhes as never }).clone();

  it("NEGATIVA: a recusa chega como `lote_recusado`, com a lista e a acao -- nunca como sucesso", async () => {
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () =>
      respostaDaRota(detalhesDoLote([recusada()])),
    );
    expect(d.tipo).toBe("lote_recusado");
    if (d.tipo !== "lote_recusado") return;
    expect(d.codigo).toBe("IMPORT_REVALIDATION_REFUSED");
    expect(d.acao).toBe("refazer_previa_sem_as_recusadas");
    expect(d.recusadas).toHaveLength(1);

    // A CLASSE continua saindo da tabela unica: conferido e nao permitido.
    expect(DESFECHO_DO_CODIGO.IMPORT_REVALIDATION_REFUSED.classe).toBe("recusado");

    // O texto: lote inteiro, nada gravado, resposta intacta, e a instrucao.
    expect(texto(d)).toMatch(/LOTE INTEIRO foi recusado/);
    expect(texto(d)).toMatch(/NADA foi gravado/);
    expect(texto(d)).toMatch(/continua intacta/);
    expect(texto(d)).toMatch(/PRÉVIA NOVA sem elas/);
    // E NAO diz que algo quebrou, nem manda esperar, nem manda instalar nada.
    expect(texto(d)).not.toMatch(/erro|defeito|falhou|sem conexão/i);
    expect(texto(d)).not.toMatch(/aguarde|instalar|migration/i);
    // O titulo diz, na primeira linha, as duas coisas que importam.
    expect(TITULO_DO_AVISO[d.tipo]).toMatch(/NADA foi gravado/);
    // E a submissao e nomeada, com a causa, por uma funcao so.
    expect(linhaDaRecusa(d.recusadas[0], PREVIA)).toMatch(
      /^resp-1 \(a@x\): o participante respondeu PELO APLICATIVO/,
    );
  });

  it("NEGATIVA: lista VAZIA ou ILEGIVEL num corpo que diz recusa e INDISPONIBILIDADE, nao 'recusa sem motivo'", async () => {
    // Nao se afirma recusa sem poder dizer o que tirar da planilha. E
    // indisponibilidade: o recurso existe, respondeu, e o que respondeu nao da
    // para ler. Nem recusa, nem "o recurso nao esta instalado".
    const corpos = [
      detalhesDoLote([]),
      detalhesDoLote([{ codigo: "resposta_do_aplicativo" }]), // sem submissao_id
      detalhesDoLote([{ submissao_id: "   " }], undefined), // sem id utilizavel
      detalhesDoLote(["resp-1"] as unknown[]), // nem objeto
      {}, // sem detalhes nenhum
    ];
    for (const detalhes of corpos) {
      const d = await aplicarImportacao(PEDIDO, PREVIA, async () => respostaDaRota(detalhes), () => {});
      expect(d.tipo).toBe("nao_verificado");
      if (d.tipo !== "nao_verificado") return;
      expect(d.codigo).toBe("IMPORT_UNAVAILABLE");
      expect(d.acao).toBe("aguardar");
      expect(texto(d)).toMatch(/não respondeu/);
      expect(texto(d)).toMatch(/aguarde/i);
      // NAO afirma recusa e NAO manda mexer no banco.
      expect(texto(d)).not.toMatch(/recusad/i);
      expect(texto(d)).not.toMatch(/migration|instalar/i);
    }
  });

  it("causa com nome que a tela nao conhece: a recusa continua afirmada, a CAUSA nao e inventada", async () => {
    const d = await aplicarImportacao(PEDIDO, PREVIA, async () =>
      respostaDaRota(detalhesDoLote([recusada({ codigo: "algo_que_ninguem_previu" })], undefined)),
    );
    expect(d.tipo).toBe("lote_recusado");
    if (d.tipo !== "lote_recusado") return;
    // O FATO (lote recusado, nada gravado) foi verificado e e afirmado.
    expect(texto(d)).toMatch(/LOTE INTEIRO foi recusado/);
    // A CAUSA nao: ela nao e traduzida por semelhanca nem omitida em silencio.
    expect(d.recusadas[0].codigo).toBeNull();
    expect(linhaDaRecusa(d.recusadas[0], PREVIA)).toMatch(/nome que esta versão da tela ainda não conhece/);
  });

  it("resposta que SE CONTRADIZ: a tela nao afirma nem que gravou nem que nao gravou", async () => {
    // A guarda da borda (lib/importacao/borda.ts) ja impede este corpo de ser
    // lido como recusa; aqui se mede o que a TELA diz quando o codigo chega.
    const d = await aplicarImportacao(
      PEDIDO,
      PREVIA,
      async () => erroHttp("IMPORT_WRITE_UNVERIFIABLE").clone(),
      () => {},
    );
    expect(d.tipo).toBe("estado_incerto");
    if (d.tipo !== "estado_incerto") return;
    expect(d.codigo).toBe("IMPORT_WRITE_UNVERIFIABLE");
    // Indisponibilidade na classificacao, mas a acao NAO e esperar: esperar e
    // tentar de novo convidaria a gravar duas vezes o que talvez ja esteja lá.
    expect(DESFECHO_DO_CODIGO.IMPORT_WRITE_UNVERIFIABLE.classe).toBe("nao_verificado");
    expect(d.acao).toBe("conferir_o_que_esta_gravado");

    const naTela = `${TITULO_DO_AVISO[d.tipo]} ${texto(d)}`;
    // Nenhum dos dois lados e AFIRMADO -- nem o titulo o afirma. (A mensagem
    // RELATA o que o banco disse, inclusive a palavra "RECUSADO"; relatar a
    // contradicao e o oposto de afirmar um dos lados dela.)
    expect(naTela).not.toMatch(/nada foi gravado/i);
    expect(naTela).not.toMatch(/O LOTE INTEIRO foi recusado/);
    expect(naTela).not.toMatch(/importação gravada/i);
    expect(TITULO_DO_AVISO[d.tipo]).not.toMatch(/recusad/i);
    // E diz o que se sabe, com a instrucao de conferir antes de repetir.
    expect(TITULO_DO_AVISO[d.tipo]).toMatch(/se contradiz/);
    expect(texto(d)).toMatch(/não dá para dizer que o lote entrou, e não dá para dizer que ele não entrou/);
    expect(texto(d)).toMatch(/NÃO repita a importação antes de conferir/);
    expect(texto(d)).not.toMatch(/aguarde/i);
    expect(texto(d)).not.toMatch(/instalar|migration/i);
  });

  it("o MESMO codigo, na decisao sobre UMA submissao, continua pedindo a ficha nova", async () => {
    // Um codigo, dois atos, duas acoes -- e uma so tabela de classificacao. A
    // tela da decisao usa `desfechoDeErro`, que nao sabe de lote: ela pede a mesa.
    const d = desfechoDeErro(
      erroHttp("IMPORT_REVALIDATION_REFUSED", {
        detalhes: { ato: "reconciliar", revalidacao: "resposta_do_aplicativo" },
      }).clone(),
      { code: "IMPORT_REVALIDATION_REFUSED", detalhes: { ato: "reconciliar", revalidacao: "resposta_do_aplicativo" } },
      () => {},
    );
    expect(d.tipo).toBe("recusado");
    if (d.tipo !== "recusado") return;
    expect(d.acao).toBe("refazer_ficha");
    expect(texto(d)).toMatch(/Recarregue a mesa/);
    expect(texto(d)).not.toMatch(/LOTE INTEIRO/);
  });
});

// ============================== a previa bateu com o que foi gravado?
describe("a conferencia da previa contra o que o banco gravou", () => {
  it("CONTROLE POSITIVO: numeros e estados iguais -> bate", () => {
    expect(conferirPreviaContraGravado(PREVIA, GRAVADO)).toEqual({ bate: true });
  });

  it.each([
    ["uma linha de resposta a menos", { linhas_de_resposta_gravadas: 9 }],
    ["um item a mais", { itens_registrados: 136 }],
    ["outro operador", { importado_por: "outro" }],
    ["outra impressao de questionario", { questionario_impressao: "f".repeat(64) }],
    ["outro formulario", { formulario_id: "outro" }],
    ["um estado a menos", { por_estado: { importavel: 1, incompativel: 1 } }],
  ])("NEGATIVA (%s) -> NAO bate, e a divergencia e nomeada", (_n, over) => {
    const r = conferirPreviaContraGravado(PREVIA, { ...GRAVADO, ...over } as ResumoGravado);
    expect(r.bate).toBe(false);
    if (!r.bate) {
      expect(r.divergencias.length).toBeGreaterThan(0);
      expect(r.divergencias[0]).toMatch(/a prévia disse .* e o banco gravou/);
    }
  });

  it("NEGATIVA: estado AUSENTE no resumo do banco conta como 0, nao como 'igual'", () => {
    // Um estado que o banco nao reportou e um estado que nao foi gravado. Se isto
    // passasse como "igual", uma submissao perdida no caminho ficaria invisivel.
    const r = conferirPreviaContraGravado(PREVIA, { ...GRAVADO, por_estado: {} });
    expect(r.bate).toBe(false);
    if (!r.bate) expect(r.divergencias.join(" ")).toMatch(/submissões pendente/);
  });
});

// ========================================================= os textos
describe("os textos da previa: nenhuma ausencia de base aparece como zero", () => {
  it("cobertura sem base e '—', nunca '0,0%'", () => {
    expect(porcentagem(null)).toBe("—");
    expect(porcentagem(0)).toBe("0,0%");
    expect(porcentagem(1)).toBe("100,0%");
    expect(porcentagem(17 / 18)).toBe("94,4%");
  });

  it("o resumo diz o que entra, o que fica retido, onde ha incompativel e a cobertura", () => {
    const t = resumoDaPrevia(PREVIA);
    expect(t).toMatch(/2 submissões entram como resposta pontuável/);
    expect(t).toMatch(/1 fica retida por identidade \(1 pendente, 0 em conflito\)/);
    expect(t).toMatch(/1 tem DADO INCOMPATÍVEL em 1 pergunta/);
    expect(t).toMatch(/cobertura pontuável resultante: 99\.3%/);
  });

  it("sem base, o resumo diz que nao ha o que medir -- e nao diz 0%", () => {
    const vazia: Previa = {
      ...PREVIA,
      entram: 0,
      cobertura: { ...PREVIA.cobertura, base_de_submissoes: 0, geral: null },
    };
    const t = resumoDaPrevia(vazia);
    expect(t).toMatch(/não há base para medir/);
    expect(t).not.toMatch(/0\.0%|0,0%/);
  });
});

// Garante que o tipo exportado cobre o vocabulario inteiro (se um codigo novo
// entrar em codigos.ts sem entrada aqui, isto nao compila).
const _exaustivo: Record<CodigoDeErro, unknown> = DESFECHO_DO_CODIGO;
void _exaustivo;
