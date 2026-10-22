// O GUIA SEM LISTA DE CONVIDADOS CONSOLIDADA (decisao do CTO, Rodada 69).
//
// Em producao a fotografia de convites (`event_invite_snapshots`) esta vazia em
// todos os eventos, e o Guia era recusado com INVITE_COUNT_UNDETERMINED. A regra
// nova: o Guia sai NEUTRO, com a populacao de convidados marcada como NAO
// VERIFICADA, e sem nenhum numero derivado de um total de convidados.
//
// O que este arquivo prova, cada um com o seu controle:
//
//   1. CONTROLE POSITIVO: evento sem convidados, com participantes e respostas
//      -> Guia gerado; a participacao diz que a populacao de convidados nao foi
//      verificada; nenhum "sem resposta" derivado de total e nenhum "%".
//   2. CONTROLE NEGATIVO: o banco falhando de verdade (cliente que devolve erro)
//      -> recusa por indisponibilidade, nunca o Guia neutro. Lista ausente e
//      informacao desconhecida; leitura que falhou e indisponibilidade.
//   3. REGRESSAO: com convidados consolidados, texto e hash IDENTICOS aos de
//      antes da mudanca. Os valores abaixo foram medidos no codigo ANTERIOR a
//      Rodada 69, com estas mesmas entradas.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as F from "./dna-coletivo-fixtures";
import { gerarDnaColetivo, type EntradaDna } from "./dna-coletivo-modelo";
import { validarTextosColetivos } from "./dna-coletivo-validacao";
import {
  CAMPOS_DE_PARTICIPACAO,
  encontrarRetratoColetivo,
  exigirNumerosVerificados,
  gerarGuiaDoFacilitador,
  numerosDoTexto,
  projetarParticipacao,
  textoDoGuia,
  textosDoBloco,
  textosDoGuia,
  type EntradaGuia,
  type GuiaDoFacilitador,
  type ResultadoGuia,
} from "./guia-facilitador-modelo";
import {
  prepararEntradaDoGuia,
  type ClienteDoGuia,
  type RespostaDeLeitura,
} from "../../../lib/marco-zero/entrada-do-guia";

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const META = { nomeEvento: "Marco Zero | Geração Preparada", dataEvento: "2026-10-24" };
const NAO_PUBLICADO = { publicacaoDoDna: { estado: "verificado", publicado: false } } as const;

function guia(r: ResultadoGuia): GuiaDoFacilitador {
  if (r.tipo !== "guia_do_facilitador") {
    throw new Error(`esperava guia, veio ${r.tipo}: ${"motivo" in r ? r.motivo : ""}`);
  }
  return r.guia;
}

function sha(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

function grupo(
  completos: number,
  o: { parciais?: number; nada?: number; convidados?: number; checkinFechado?: boolean } = {},
): EntradaDna {
  const { parciais = 0, nada = 0, checkinFechado = true } = o;
  return {
    meta: META,
    convidados: o.convidados ?? completos + parciais + nada,
    checkinFechado,
    participantes: [
      ...F.varias(completos, { t: "sem_destaque" }),
      ...F.varias(parciais, { t: "parcial" }),
      ...F.varias(nada, { t: "nada" }),
    ],
    gateDeVolume: F.gateVerificado(completos),
  };
}

/** O mesmo grupo, sem a populacao de convidados verificada. */
function semConvidados(e: EntradaDna): EntradaGuia["dna"] {
  return { ...e, convidados: null };
}

/** Tudo o que o guia neutro NAO pode trazer: denominador de convidados e "%". */
function exigirNeutro(g: GuiaDoFacilitador): void {
  const todos = textosDoGuia(g).join("\n");
  expect(todos).not.toMatch(/%/);
  expect(todos).not.toMatch(/por\s*cento|percentua/i);
  expect(g.populacoes.convidados).toBeNull();
  expect(g.populacoes.semRespostaRegistrada).toBeNull();
  // Nenhuma linha da participacao tem numero ao lado de "convidados".
  for (const parte of g.participacao.partes) {
    if (!("linhas" in parte)) continue;
    for (const l of parte.linhas) {
      if (/convidad/i.test(l.rotulo)) expect(numerosDoTexto(l.valor)).toEqual([]);
    }
  }
}

// ---------------------------------------------------------------------------
// Um banco em memoria com a MESMA superficie que a camada de leitura usa
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;

interface Banco {
  tabelas: Record<string, Linha[]>;
  cobertura: Linha | (() => RespostaDeLeitura);
  /** Tabelas cuja leitura devolve ERRO (falha de verdade, como o Postgres faz). */
  falhar?: readonly string[];
}

function clienteEmMemoria(banco: Banco): ClienteDoGuia {
  function consulta(tabela: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    const rodar = (): RespostaDeLeitura => {
      if (banco.falhar?.includes(tabela)) {
        return { data: null, error: { message: `permission denied for table ${tabela}` } };
      }
      const linhas = banco.tabelas[tabela];
      if (linhas === undefined) throw new Error(`tabela nao servida: ${tabela}`);
      return { data: linhas.filter((l) => filtros.every((f) => f(l))), error: null };
    };
    const q = {
      eq(coluna: string, valor: string | number) {
        filtros.push((l) => l[coluna] === valor);
        return q;
      },
      in(coluna: string, valores: readonly (string | number)[]) {
        filtros.push((l) => valores.includes(l[coluna] as string | number));
        return q;
      },
      maybeSingle(): PromiseLike<RespostaDeLeitura> {
        const r = rodar();
        if (r.error) return Promise.resolve(r);
        return Promise.resolve({ data: (r.data as Linha[])[0] ?? null, error: null });
      },
      then<R1, R2>(
        ok?: ((v: RespostaDeLeitura) => R1 | PromiseLike<R1>) | null,
        falha?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
      ) {
        return Promise.resolve().then(rodar).then(ok, falha);
      },
    };
    return q;
  }
  return {
    from(tabela: string) {
      return { select: () => consulta(tabela) };
    },
    rpc(nome: string) {
      if (nome !== "marco_zero_cobertura") throw new Error(`rpc nao servido: ${nome}`);
      const c = banco.cobertura;
      if (typeof c === "function") return Promise.resolve().then(c);
      return Promise.resolve({ data: [c], error: null });
    },
  };
}

// As respostas sao as mesmas da semente da prova de borda (quiz_version 2,
// etapas 101..105): uma leitura completa por pessoa.
const RESPOSTA: Record<number, Record<string, unknown>> = {
  101: { q1: "x", q2: "x", q3: "x", q4: "x", q5: "x", q6: "x" },
  102: { q7: 10, q8: 9, q9: 8, q10: 7, q11: 6, q12: 5, q13: 4, q14: "x", q15: "x" },
  103: Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [`q${16 + i}`, i < 6 ? 5 : 1]),
  ),
  104: { q40: "A", q41: "C", q42: "B", q43: "D", q44: "A", q45: "D" },
  105: { q46: "x", q47: "x", q48: "x", q49: "x", q50: "x", q51: "x", q52: "x" },
};
const ETAPAS = [101, 102, 103, 104, 105];

const EVENTO = "e7000000-0000-4000-8000-000000000007";

/**
 * `n` participantes; `responderam` deles com a leitura completa. Todos com
 * check-in ativo. `cobertura` e a linha que `marco_zero_cobertura` devolveria.
 */
function banco(
  n: number,
  responderam: number,
  cobertura: Partial<Linha>,
  extra: Partial<Banco> = {},
): Banco {
  const ids = Array.from(
    { length: n },
    (_, i) => `a${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
  );
  const pessoas = ids.map((pid, i) => ({
    id: `b${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
    participant_id: pid,
    event_id: EVENTO,
  }));
  return {
    tabelas: {
      events: [{ id: EVENTO, name: "Marco Zero | Sem lista", event_date: "2026-11-14T13:00:00Z", quiz_version: 2 }],
      event_logs: [],
      participants: ids.map((id, i) => ({ id, full_name: `Pessoa ${i + 1}`, event_id: EVENTO })),
      event_people: pessoas,
      event_checkins: pessoas.map((p) => ({ person_id: p.id, estado: "ativo", event_id: EVENTO })),
      quiz_stages: ETAPAS.map((id) => ({ id, quiz_version: 2 })),
      quiz_responses: ids
        .slice(0, responderam)
        .flatMap((pid) => ETAPAS.map((s) => ({ participant_id: pid, stage_id: s, answers: RESPOSTA[s] }))),
    },
    cobertura: {
      status: "ok",
      motivo: null,
      respondentes_validos: responderam,
      gate_minimo_respostas: responderam >= F.MINIMO_RESPOSTAS_DO_BANCO,
      minimo_respostas: F.MINIMO_RESPOSTAS_DO_BANCO,
      checkin_fechado: true,
      convidados: null,
      motivo_convidados: "sem_snapshot_de_convites",
      aprovacao_invalidada: false,
      invalidacoes_pendentes: 0,
      ...cobertura,
    },
    ...extra,
  };
}

const SEM_LISTA = { convidados: null, motivo_convidados: "sem_snapshot_de_convites" };

// ---------------------------------------------------------------------------
// 1. CONTROLE POSITIVO: sem lista de convidados, o guia sai neutro
// ---------------------------------------------------------------------------

describe("sem lista de convidados consolidada: guia neutro", () => {
  it("do banco ao texto: 14 participantes, 12 respostas, nenhum convidado cadastrado -> guia gerado", async () => {
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(banco(14, 12, SEM_LISTA)), EVENTO);
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    expect(preparo.entrada.dna.convidados).toBeNull();

    const g = guia(gerarGuiaDoFacilitador(preparo.entrada));
    exigirNeutro(g);
    expect(g.populacoes.respostasCompletas).toBe(12);
    expect(g.populacoes.respostasIncompletas).toBe(0);
    expect(g.populacoes.presentes).toBe(14);
    expect(g.populacoes.respostasCompletasDePresentes).toBe(12);

    const participacao = textosDoBloco(g.participacao).join("\n");
    expect(participacao).toContain("não verificada");
    expect(participacao).toContain("não há lista de convidados consolidada");
    // As quatro camadas continuam de pe sobre o texto neutro.
    expect(validarTextosColetivos(textosDoGuia(g))).toEqual([]);
    for (const t of textosDoGuia(g)) expect(encontrarRetratoColetivo(t)).toEqual([]);
    expect(() => exigirNumerosVerificados(g)).not.toThrow();

    const render = textoDoGuia(g);
    const secao = render.slice(render.indexOf("PARTICIPAÇÃO VERIFICADA"), render.indexOf("POR QUE NÃO HÁ"));
    console.log(`\n--- SECAO DE PARTICIPACAO (guia neutro) ---\n${secao}`);
  });

  it("o canal continua estreito: as mesmas oito chaves, com convidados e sem-resposta nulos", () => {
    const { participacao } = projetarParticipacao({ ...NAO_PUBLICADO, dna: semConvidados(grupo(12)) });
    expect(Object.keys(participacao).sort()).toEqual([...CAMPOS_DE_PARTICIPACAO].sort());
    expect(participacao.convidados).toBeNull();
    expect(participacao.semRespostaRegistrada).toBeNull();
  });

  it("cada motivo de limiar continua nomeado, sem digito e sem retrato", () => {
    const casos: [string, EntradaDna][] = [
      ["volume_insuficiente", grupo(12)],
      ["cobertura_insuficiente", grupo(10, { parciais: 5 })],
      ["base_pequena_demais", grupo(4)],
      ["checkin_aberto", grupo(12, { checkinFechado: false })],
    ];
    for (const [motivo, e] of casos) {
      const g = guia(gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(e) }));
      expect(g.motivoSemDna).toBe(motivo);
      exigirNeutro(g);
      expect(numerosDoTexto(textosDoBloco(g.semDna).join("\n"))).toEqual([]);
    }
  });

  it("grupo que passaria nos limiares: o motivo e a populacao nao verificada, nao um DNA 'gerado'", () => {
    const g = guia(gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(F.grupoSuficiente()) }));
    expect(g.motivoSemDna).toBe("convidados_nao_verificados");
    const t = textosDoBloco(g.semDna).join("\n");
    expect(t).not.toContain("gerado e ainda não disponibilizado");
    expect(numerosDoTexto(t)).toEqual([]);
    exigirNeutro(g);
  });

  it("a decisao de limiar do DNA nao depende do parametro neutro: qualquer teto a partir dos presentes da o mesmo veredito", () => {
    // Sem lista, o modulo do DNA recebe o numero de participantes registrados
    // so para que a porta "mais presentes do que convidados" nao dispare. A
    // prova de que isso nao decide nada: com o teto minimo (os presentes), com
    // o registrados e com um teto absurdo, o veredito e o mesmo.
    const grupos: EntradaDna[] = [
      grupo(12),
      grupo(10, { parciais: 5 }),
      grupo(4),
      grupo(12, { checkinFechado: false }),
      grupo(12, { parciais: 2, nada: 1 }),
      F.grupoSuficiente(),
      F.grupoInsuficiente(),
    ];
    for (const e of grupos) {
      const presentes = e.participantes.filter((p) => p.presente).length;
      const veredito = (convidados: number) => {
        const r = gerarDnaColetivo({ ...e, convidados });
        return r.tipo === "relatorio_operacional" ? r.motivo : r.tipo;
      };
      const comRegistrados = veredito(e.participantes.length);
      expect(veredito(presentes)).toBe(comRegistrados);
      expect(veredito(e.participantes.length + 1000)).toBe(comRegistrados);
    }
    // E o parametro neutro nao vaza para o texto: com tres registrados que nao
    // vieram, o numero de registrados (18) difere de toda contagem impressa.
    const base = grupo(12, { parciais: 2, nada: 1 });
    const e: EntradaDna = {
      ...base,
      participantes: [...base.participantes, ...F.varias(3, { t: "nada" }, false)],
    };
    expect(e.participantes.length).toBe(18);
    const neutro = gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(e) });
    if (neutro.tipo !== "guia_do_facilitador") throw new Error("sem guia");
    expect(textosDoGuia(neutro.guia).flatMap(numerosDoTexto)).not.toContain("18");
  });

  it("dois grupos com conteudo de resposta oposto, sem lista: mesmo texto e mesmo hash", () => {
    const base = (especie: F.Especie): EntradaDna => ({
      meta: META,
      convidados: 0,
      checkinFechado: true,
      participantes: F.varias(12, especie),
      gateDeVolume: F.gateVerificado(12),
    });
    const ra = gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(base({ t: "sem_destaque" })) });
    const rb = gerarGuiaDoFacilitador({
      ...NAO_PUBLICADO,
      dna: semConvidados(base({ t: "dois", eixo: "integridade" })),
    });
    if (ra.tipo !== "guia_do_facilitador" || rb.tipo !== "guia_do_facilitador") throw new Error("sem guia");
    expect(textoDoGuia(ra.guia)).toBe(textoDoGuia(rb.guia));
    expect(ra.conteudoSha256).toBe(rb.conteudoSha256);
  });

  it("DNA PUBLICADO continua recusando o guia, com ou sem lista", () => {
    const r = gerarGuiaDoFacilitador({
      publicacaoDoDna: { estado: "verificado", publicado: true },
      dna: semConvidados(F.grupoSuficiente()),
    });
    expect(r.tipo).toBe("guia_nao_gerado");
    if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("dna_publicado");
  });

  it("estado do DNA indeterminado continua recusando o guia sem lista", () => {
    const r = gerarGuiaDoFacilitador({
      publicacaoDoDna: { estado: "indeterminado", motivo: "consulta_nao_respondeu" },
      dna: semConvidados(grupo(12)),
    });
    expect(r.tipo).toBe("guia_nao_gerado");
    if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("estado_do_dna_indeterminado");
  });
});

// ---------------------------------------------------------------------------
// 2. CONTROLE NEGATIVO: falha de leitura NAO vira "lista ausente"
// ---------------------------------------------------------------------------

describe("banco indisponivel continua sendo indisponibilidade", () => {
  it("a consulta de cobertura devolvendo ERRO -> COVERAGE_UNAVAILABLE, nunca guia neutro", async () => {
    const b = banco(14, 12, SEM_LISTA, {
      cobertura: () => ({ data: null, error: { message: "permission denied for function marco_zero_cobertura" } }),
    });
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(b), EVENTO);
    expect(preparo.ok).toBe(false);
    if (!preparo.ok) expect(preparo.codigo).toBe("COVERAGE_UNAVAILABLE");
  });

  it("a consulta de cobertura LANCANDO (conexao caiu) -> COVERAGE_UNAVAILABLE", async () => {
    const b = banco(14, 12, SEM_LISTA, {
      cobertura: () => {
        throw new Error("fetch failed");
      },
    });
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(b), EVENTO);
    expect(preparo.ok).toBe(false);
    if (!preparo.ok) expect(preparo.codigo).toBe("COVERAGE_UNAVAILABLE");
  });

  it("leitura de participantes/presenca devolvendo ERRO -> PARTICIPANTS_UNAVAILABLE, nunca guia neutro", async () => {
    for (const tabela of ["participants", "event_people", "event_checkins", "quiz_responses"]) {
      const preparo = await prepararEntradaDoGuia(
        clienteEmMemoria(banco(14, 12, SEM_LISTA, { falhar: [tabela] })),
        EVENTO,
      );
      expect(preparo.ok, tabela).toBe(false);
      if (!preparo.ok) expect(preparo.codigo, tabela).toBe("PARTICIPANTS_UNAVAILABLE");
    }
  });

  it("registro de disponibilizacao do DNA ilegivel (erro) -> o guia NAO sai, mesmo sem lista", async () => {
    const preparo = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(14, 12, SEM_LISTA, { falhar: ["event_logs"] })),
      EVENTO,
    );
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    const r = gerarGuiaDoFacilitador(preparo.entrada);
    expect(r.tipo).toBe("guia_nao_gerado");
    if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("estado_do_dna_indeterminado");
  });

  it("fotografia de convites INCONSISTENTE nao e lista ausente: continua INVITE_COUNT_UNDETERMINED", async () => {
    const preparo = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(14, 12, { convidados: null, motivo_convidados: "snapshot_inconsistente" })),
      EVENTO,
    );
    expect(preparo.ok).toBe(false);
    if (!preparo.ok) expect(preparo.codigo).toBe("INVITE_COUNT_UNDETERMINED");
  });

  it("total nulo sem motivo, motivo fora da lista ou total invalido -> INVITE_COUNT_UNDETERMINED", async () => {
    for (const linha of [
      { convidados: null, motivo_convidados: null },
      { convidados: null, motivo_convidados: "outra_coisa" },
      { convidados: -1, motivo_convidados: null },
      { convidados: 3.5, motivo_convidados: null },
      { convidados: "14", motivo_convidados: null },
      // Ausencia declarada COM numero ao lado: a linha se contradiz.
      { convidados: 14, motivo_convidados: "sem_snapshot_de_convites" },
    ]) {
      const preparo = await prepararEntradaDoGuia(clienteEmMemoria(banco(14, 12, linha)), EVENTO);
      expect(preparo.ok, JSON.stringify(linha)).toBe(false);
      if (!preparo.ok) expect(preparo.codigo, JSON.stringify(linha)).toBe("INVITE_COUNT_UNDETERMINED");
    }
  });

  it("CONTROLE POSITIVO do negativo: o mesmo banco, sem a falha, entrega o guia", async () => {
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(banco(14, 12, SEM_LISTA)), EVENTO);
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    expect(gerarGuiaDoFacilitador(preparo.entrada).tipo).toBe("guia_do_facilitador");
  });
});

// ---------------------------------------------------------------------------
// 3. REGRESSAO: com convidados consolidados, nada muda
// ---------------------------------------------------------------------------

function autorizado(e: EntradaDna): EntradaGuia {
  const comResposta = e.participantes.filter((p) => p.scores !== null);
  const semResposta = e.participantes.filter((p) => p.scores === null);
  return {
    ...NAO_PUBLICADO,
    dna: e,
    autorizacoes: [
      { participanteId: comResposta[0].id, autorizado: true },
      { participanteId: comResposta[1].id, autorizado: false },
      { participanteId: semResposta[0].id, autorizado: true },
    ],
  };
}

const CASOS_DE_REGRESSAO: [string, () => EntradaGuia][] = [
  ["doze, volume", () => ({ ...NAO_PUBLICADO, dna: grupo(12) })],
  ["doze e tres parciais de vinte", () => ({ ...NAO_PUBLICADO, dna: grupo(12, { parciais: 3, convidados: 20 }) })],
  ["check-in aberto", () => ({ ...NAO_PUBLICADO, dna: grupo(12, { convidados: 20, checkinFechado: false }) })],
  ["base pequena", () => ({ ...NAO_PUBLICADO, dna: grupo(4, { convidados: 6 }) })],
  ["cobertura insuficiente", () => ({ ...NAO_PUBLICADO, dna: grupo(10, { parciais: 5, convidados: 15 }) })],
  ["dna em rascunho", () => ({ ...NAO_PUBLICADO, dna: F.grupoSuficiente() })],
  ["sem nome de evento", () => ({ ...NAO_PUBLICADO, dna: { ...grupo(9, { nada: 3 }), meta: undefined } })],
  ["com liberacoes", () => autorizado(grupo(9, { nada: 3, convidados: 12 }))],
];

/** Medido no codigo ANTERIOR a Rodada 69: [conteudoSha256, sha256 do texto renderizado]. */
const ESPERADO: Record<string, [string, string]> = {
  "doze, volume": ["a2ebe29ff6becd74973be3433b09311608018e732fe85d6f5474616eaa8ed8de", "967af07906ad70814b80332dbb31ff14ce05a15ced2fc51263fd71678323e283"],
  "doze e tres parciais de vinte": ["998e4470a364bcf5437db19b2b0bf44c209213f673f7e950db0edf135ff48b9f", "121f7944a043863db84b31ae9750445826698dd708d099b3d2a5403de21d36f0"],
  "check-in aberto": ["9deb427bef876e1a41d275fecdaf22d5ca8878e502c50ef4e0c531022f00d2e0", "df974045c4744e925fc15ed8091af8b8cb43a6cf833c67ad708c4b37b809a074"],
  "base pequena": ["099d7d8ae6f0a76b3ddcacf9c2e6a72a078a24dbb08703e1e0046eca24173701", "4456599cce62561efe9b5645b5267c3c67b10a9c456012a91e98a521cd4cd2b3"],
  "cobertura insuficiente": ["41076d8012c8dd961eb17d8e7c3e83bce80f568bda8dd1ed750af72d9b3c2fef", "abed360b400e1fb81bfeca0d2d7810290fe905b4462fcf73995e141f90233dda"],
  "dna em rascunho": ["fac2916d93c73270b4c178308c4f2edc6456f8803a2a721189f554540141366e", "6542895b556571b9a015751dc492c4bd123d301be7f8c125c125538eb0d55ede"],
  "sem nome de evento": ["9e71cc73a7988fe3e9c3e3a2dc0a3644c5c661b5afabbabe500d01fad85779c5", "79a3350d3000595a1ca1bd47a41b84e5c00f54724b47e8c3ba634f277e8dd5ab"],
  "com liberacoes": ["19f45cbed648ac16c420dea802dbab330906fd840ba087bea846a2200fb28be5", "8b8a684cefc00d239d89cd11b4afa3b745832deec78a60a99c938b2d2eb1e19c"],
  "do banco": ["5a26cb3402515e7afa9e34a801a7b36c2d2402153a4f766340a82bd6e6aebfbb", "10db944d9a5878db3f47995192c2f267c753895d366902c1d30fe55fa81b1aa8"],
};

describe("regressao: convidados consolidados, mesmo texto e mesmo hash de antes", () => {
  for (const [nome, entrada] of CASOS_DE_REGRESSAO) {
    it(nome, () => {
      const r = gerarGuiaDoFacilitador(entrada());
      if (r.tipo !== "guia_do_facilitador") throw new Error(`sem guia: ${r.motivo}`);
      const medido: [string, string] = [r.conteudoSha256, sha(textoDoGuia(r.guia))];
      if (process.env.GUIA_MEDIR_LINHA_DE_BASE) {
        console.log(`MEDIDO ${JSON.stringify(nome)}: ${JSON.stringify(medido)},`);
        return;
      }
      expect(medido).toEqual(ESPERADO[nome]);
    });
  }

  it("do banco ao texto: convidados consolidados na linha oficial -> mesmo hash de antes", async () => {
    const preparo = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(14, 12, { convidados: 20, motivo_convidados: null })),
      EVENTO,
    );
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    expect(preparo.entrada.dna.convidados).toBe(20);
    const r = gerarGuiaDoFacilitador(preparo.entrada);
    if (r.tipo !== "guia_do_facilitador") throw new Error(`sem guia: ${r.motivo}`);
    const medido: [string, string] = [r.conteudoSha256, sha(textoDoGuia(r.guia))];
    if (process.env.GUIA_MEDIR_LINHA_DE_BASE) {
      console.log(`MEDIDO "do banco": ${JSON.stringify(medido)},`);
      return;
    }
    expect(medido).toEqual(ESPERADO["do banco"]);
    expect(r.guia.populacoes.convidados).toBe(20);
    expect(r.guia.populacoes.semRespostaRegistrada).toBe(8);
  });
});
