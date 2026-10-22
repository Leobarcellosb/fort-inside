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
//   4. CAMINHO EXPLICITO DE POPULACAO DESCONHECIDA (Rodada 71): sem lista, a
//      avaliacao de elegibilidade do DNA NAO e chamada. Prova por ESPIAO: o
//      modulo do DNA e o de agregacao sao substituidos por eles mesmos,
//      embrulhados em `vi.fn`, e o teste conta as chamadas.
//   5. VERSAO 2 DO MODELO (Rodada 71): a troca editorial dos travessoes, com
//      os hashes das duas versoes registrados, a prova de que desfazer a troca
//      devolve o texto da versao 1 byte a byte, e o texto que o host baixa.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as F from "./dna-coletivo-fixtures";
import { gerarDnaColetivo, type EntradaDna } from "./dna-coletivo-modelo";
import { agregar } from "./dna-coletivo-agregacao";
import { validarTextosColetivos } from "./dna-coletivo-validacao";
import {
  CAMPOS_DE_PARTICIPACAO,
  encontrarRetratoColetivo,
  exigirNumerosVerificados,
  gerarGuiaDoFacilitador,
  numerosDoTexto,
  projetarParticipacao,
  TEXTOS_GUIA,
  VERSAO_DO_MODELO_DO_GUIA,
  hashDoGuia,
  textoDoGuia,
  textoDoGuiaNaoGerado,
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
import { pedirGuiaDoFacilitador } from "./guia-facilitador-borda";
import { NextRequest } from "next/server";

// Os ESPIOES: o comportamento real, contado. O gerador do guia importa estes
// mesmos modulos, entao o que ele chamar passa por aqui.
vi.mock("./dna-coletivo-modelo", async (original) => {
  const real = await original<typeof import("./dna-coletivo-modelo")>();
  return { ...real, gerarDnaColetivo: vi.fn(real.gerarDnaColetivo) };
});
vi.mock("./dna-coletivo-agregacao", async (original) => {
  const real = await original<typeof import("./dna-coletivo-agregacao")>();
  return { ...real, agregar: vi.fn(real.agregar) };
});
const espiaoDoDna = vi.mocked(gerarDnaColetivo);
const espiaoDaAgregacao = vi.mocked(agregar);

// A ROTA, para a prova do "Baixar em texto": so o login e a fabrica do cliente
// sao simulados; o cliente e o banco em memoria deste arquivo.
const h = vi.hoisted(() => ({ cliente: null as unknown }));
vi.mock("../../../lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u-admin", app_metadata: { role: "admin" } } },
        error: null,
      }),
    },
  }),
}));
vi.mock("../../../lib/supabase/admin", () => ({
  createAdminClient: () => h.cliente,
}));
// A configuracao de teste padrao nao resolve o atalho "@/" que a rota usa.
// Cada atalho aponta para o MODULO REAL (nada simulado alem do login e da
// fabrica do cliente, acima).
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.cliente }));
vi.mock("@/lib/auth/require-admin", () => import("../../../lib/auth/require-admin"));
vi.mock("@/lib/erros/resposta", () => import("../../../lib/erros/resposta"));
vi.mock("@/lib/erros/codigos", () => import("../../../lib/erros/codigos"));
vi.mock("@/lib/marco-zero/entrada-do-guia", () => import("../../../lib/marco-zero/entrada-do-guia"));
vi.mock("@/components/features/marco-zero/guia-facilitador-modelo", () => import("./guia-facilitador-modelo"));

beforeEach(() => {
  espiaoDoDna.mockClear();
  espiaoDaAgregacao.mockClear();
});

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

  it("sem lista, o motivo e sempre a populacao nao verificada: nenhum limiar e avaliado", () => {
    const grupos: EntradaDna[] = [
      grupo(12),
      grupo(10, { parciais: 5 }),
      grupo(4),
      grupo(12, { checkinFechado: false }),
      F.grupoSuficiente(),
    ];
    // A fixture do grupo suficiente usa `agregar` para montar o gate: zera a
    // contagem antes de chamar o gerador.
    espiaoDaAgregacao.mockClear();
    for (const e of grupos) {
      const g = guia(gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(e) }));
      expect(g.motivoSemDna).toBe("convidados_nao_verificados");
      exigirNeutro(g);
      const t = textosDoBloco(g.semDna).join("\n");
      expect(numerosDoTexto(t)).toEqual([]);
      expect(t).toContain("a cobertura fica desconhecida");
      expect(t).not.toContain("gerado e ainda não disponibilizado");
    }
    expect(espiaoDoDna).not.toHaveBeenCalled();
    expect(espiaoDaAgregacao).not.toHaveBeenCalled();
  });

  it("RODADA 71: sem lista, 30 registrados e 30 presentes -> guia neutro, cobertura desconhecida, e gerarDnaColetivo NAO e chamado", async () => {
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(banco(30, 30, SEM_LISTA)), EVENTO);
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    expect(preparo.entrada.dna.convidados).toBeNull();
    expect(preparo.entrada.dna.participantes).toHaveLength(30);

    const g = guia(gerarGuiaDoFacilitador(preparo.entrada));
    // Nenhuma avaliacao de elegibilidade com denominador ficticio: nem o
    // modulo do DNA nem a agregacao (que tambem recebe um total) foram chamados.
    expect(espiaoDoDna).not.toHaveBeenCalled();
    expect(espiaoDaAgregacao).not.toHaveBeenCalled();

    expect(g.motivoSemDna).toBe("convidados_nao_verificados");
    exigirNeutro(g);
    expect(g.populacoes.presentes).toBe(30);
    expect(g.populacoes.respostasCompletasDePresentes).toBe(30);
    const todos = textosDoGuia(g).join("\n");
    expect(todos).toContain("a cobertura fica desconhecida");
    // "Cobertura" so aparece para dizer que e desconhecida: sem valor ao lado.
    expect(todos).not.toMatch(/cobertura (cheia|completa|total|de\s*\d)/i);
    expect(todos).not.toMatch(/100/);
  });

  it("CONTROLE POSITIVO do espiao: com lista consolidada, a avaliacao de elegibilidade E chamada", async () => {
    const preparo = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(30, 30, { convidados: 30, motivo_convidados: null })),
      EVENTO,
    );
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    guia(gerarGuiaDoFacilitador(preparo.entrada));
    expect(espiaoDoDna).toHaveBeenCalledTimes(1);
    expect(espiaoDoDna.mock.calls[0][0].convidados).toBe(30);
    expect(espiaoDaAgregacao).toHaveBeenCalled();
  });

  it("RODADA 71: sem lista e DNA PUBLICADO no registro do banco -> recusado, sem avaliar elegibilidade", async () => {
    const b = banco(30, 30, SEM_LISTA);
    b.tabelas.event_logs = [
      { event_id: EVENTO, action: "dna_coletivo_disponibilizado", created_at: "2026-11-14T18:00:00Z" },
    ];
    const preparo = await prepararEntradaDoGuia(clienteEmMemoria(b), EVENTO);
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    expect(preparo.publicacao).toEqual({ estado: "verificado", publicado: true });
    const r = gerarGuiaDoFacilitador(preparo.entrada);
    expect(r.tipo).toBe("guia_nao_gerado");
    if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("dna_publicado");
    expect(espiaoDoDna).not.toHaveBeenCalled();
  });

  it("RODADA 71: sem lista e estado do DNA impossivel de verificar -> recusado", async () => {
    // (a) a leitura do registro de disponibilizacao FALHA no banco;
    const falha = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(30, 30, SEM_LISTA, { falhar: ["event_logs"] })),
      EVENTO,
    );
    // (b) ha disponibilizacao e os sinais de invalidacao nao vieram.
    const b = banco(30, 30, { ...SEM_LISTA, aprovacao_invalidada: null, invalidacoes_pendentes: null });
    b.tabelas.event_logs = [
      { event_id: EVENTO, action: "dna_coletivo_disponibilizado", created_at: "2026-11-14T18:00:00Z" },
    ];
    const semSinal = await prepararEntradaDoGuia(clienteEmMemoria(b), EVENTO);
    for (const preparo of [falha, semSinal]) {
      if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
      expect(preparo.publicacao.estado).toBe("indeterminado");
      const r = gerarGuiaDoFacilitador(preparo.entrada);
      expect(r.tipo).toBe("guia_nao_gerado");
      if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("estado_do_dna_indeterminado");
    }
    expect(espiaoDoDna).not.toHaveBeenCalled();
  });

  it("sem lista, contagens que nao fecham continuam recusando (participante repetido)", () => {
    const e = grupo(6);
    const r = gerarGuiaDoFacilitador({
      ...NAO_PUBLICADO,
      dna: semConvidados({ ...e, participantes: [...e.participantes, e.participantes[0]] }),
    });
    expect(r.tipo).toBe("guia_nao_gerado");
    if (r.tipo === "guia_nao_gerado") expect(r.motivo).toBe("dados_inconsistentes");
    expect(espiaoDoDna).not.toHaveBeenCalled();
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

// REGISTRO DE HASHES POR VERSAO DO MODELO. [conteudoSha256, sha256 do texto
// renderizado], com as mesmas entradas de `CASOS_DE_REGRESSAO`.
//
// VERSAO 1: medido no codigo ANTERIOR a Rodada 69, e conferido de novo depois
// do ajuste 1 da Rodada 71 (caminho de populacao desconhecida), antes da troca
// editorial. E o que foi emitido ate a Rodada 71: NAO apagar.
const ESPERADO_V1: Record<string, [string, string]> = {
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

// VERSAO 2 (Rodada 71): a unica mudanca e editorial, o travessao do cabecalho
// virou dois pontos. A prova de que so isso mudou esta em "troca editorial".
const ESPERADO_V2: Record<string, [string, string]> = {
  "doze, volume": ["7ad014e306f8b0b5e6a8238c5aa7a526ba8cac028fad30dfc991ed28c29fa713", "25c8481546239e1a16f639011f70d5db002a3c78373cc1c728b2213fbad3cb82"],
  "doze e tres parciais de vinte": ["edb9fa540199819e662a4d678673dc07fe34ca7331b57de018857233f1f121ad", "1d43627fcd5009450c608d6c3fd09380925298cf5fd1a71242c69c9075488855"],
  "check-in aberto": ["b5fc815838de01d086c0b390115f378256353f564a5d9bea4eced7aa9d2771aa", "0df05adb6fcb432ab6a0f8dc73453dc6cd71a3d93f7a7020dc14e91088fd1619"],
  "base pequena": ["2dbe6e5cf8bf278b6f17e5316ebdeb6a835d10bc77fd9d876c8b11b584b280a9", "3caa7fad0d022734bd42584c9cafaa08caa02efd55a9b83999340707874b34a3"],
  "cobertura insuficiente": ["705624cbbb0f2321034e547dacde1d8235ab11ad0f43636b03b462214123548a", "98fcbd20acbc456c7da01f0dd40a621079d5d6e55f35e4279c2ca6be4a58a264"],
  "dna em rascunho": ["3d7a450b093a70b2a644662e9f4b8c58d919618527533666f12a9ad82c00a091", "3d1387c37f9f3d0f371f0645d1fce200ed5232f139e644c57123a9c2a146f3b5"],
  "sem nome de evento": ["4a8f633cdff3f13993d821f2808bb8eaa0c92dd8a181d3e8c6d557c956ff4b30", "cac42dc5c806160bb1a6c3636d54d1a6e602db9d8adc1c50edffd48540f185a3"],
  "com liberacoes": ["cfe1fa0eec9a2ebb43558a0d328e9b8c58489247e4389215caa02157b20a6b73", "4d4b90054f096c005fde6a337eb6e639f4fb74098beafef088cfce9694ef8ba2"],
  "do banco": ["16f70e2768b816e68ccf99bd81e4ac48cb37a2285eb8526b043b448435623cb5", "d8bd711e8ed52d358a6de1899d5b59d1c8d05a59468fb76678e55e9d0d71f5d1"],
};

const HASHES_POR_VERSAO_DO_MODELO: Record<number, Record<string, [string, string]>> = {
  1: ESPERADO_V1,
  2: ESPERADO_V2,
};

/**
 * As trocas editoriais da versao 2, no sentido NOVO -> ANTIGO. Desfazer estas
 * trocas no texto novo tem de devolver o texto antigo byte a byte (hash da
 * versao 1). Se qualquer outra coisa tivesse mudado, o hash nao bateria.
 */
const TROCAS_DA_VERSAO_2: readonly [string, string][] = [
  ["MARCO ZERO: MATERIAL RESTRITO AO FACILITADOR", "MARCO ZERO — MATERIAL RESTRITO AO FACILITADOR"],
];

function desfazerTrocas(texto: string): string {
  let t = texto;
  for (const [novo, antigo] of TROCAS_DA_VERSAO_2) t = t.split(novo).join(antigo);
  return t;
}

function hashDosTextos(textos: readonly string[]): string {
  return sha(textos.join("\n␟\n"));
}

const TRAVESSAO = /[—–]/;

/** O guia de cada caso, inclusive o do banco (via camada de leitura). */
async function guiaDoCaso(nome: string): Promise<GuiaDoFacilitador> {
  if (nome === "do banco") {
    const preparo = await prepararEntradaDoGuia(
      clienteEmMemoria(banco(14, 12, { convidados: 20, motivo_convidados: null })),
      EVENTO,
    );
    if (!preparo.ok) throw new Error(`esperava entrada, veio ${preparo.codigo}`);
    return guia(gerarGuiaDoFacilitador(preparo.entrada));
  }
  const caso = CASOS_DE_REGRESSAO.find(([n]) => n === nome);
  if (!caso) throw new Error(`caso desconhecido: ${nome}`);
  return guia(gerarGuiaDoFacilitador(caso[1]()));
}

const NOMES_DOS_CASOS = [...CASOS_DE_REGRESSAO.map(([n]) => n), "do banco"];

describe("regressao: convidados consolidados, hash registrado da versao vigente do modelo", () => {
  for (const nome of NOMES_DOS_CASOS) {
    it(nome, async () => {
      const g = await guiaDoCaso(nome);
      const medido: [string, string] = [hashDoGuia(g), sha(textoDoGuia(g))];
      if (process.env.GUIA_MEDIR_LINHA_DE_BASE) {
        console.log(`MEDIDO ${JSON.stringify(nome)}: ${JSON.stringify(medido)},`);
        return;
      }
      expect(g.versaoDoModelo).toBe(VERSAO_DO_MODELO_DO_GUIA);
      expect(medido).toEqual(HASHES_POR_VERSAO_DO_MODELO[VERSAO_DO_MODELO_DO_GUIA][nome]);
    });
  }

  it("do banco ao texto: convidados consolidados chegam inteiros ao guia", async () => {
    const g = await guiaDoCaso("do banco");
    expect(g.populacoes.convidados).toBe(20);
    expect(g.populacoes.semRespostaRegistrada).toBe(8);
  });

  it("os hashes das duas versoes estao registrados e nunca coincidem", () => {
    expect(VERSAO_DO_MODELO_DO_GUIA).toBe(2);
    const v1 = new Set(Object.values(ESPERADO_V1).flat());
    const v2 = Object.values(ESPERADO_V2).flat();
    expect(Object.keys(ESPERADO_V1).sort()).toEqual([...NOMES_DOS_CASOS].sort());
    expect(Object.keys(ESPERADO_V2).sort()).toEqual([...NOMES_DOS_CASOS].sort());
    for (const h of v2) expect(v1.has(h)).toBe(false);
  });
});

describe("troca editorial da versao 2: so os travessoes mudaram", () => {
  for (const nome of NOMES_DOS_CASOS) {
    it(`${nome}: desfazer a troca devolve o texto da versao 1 byte a byte`, async () => {
      const g = await guiaDoCaso(nome);
      const [conteudoV1, renderV1] = ESPERADO_V1[nome];
      // O texto NOVO, com as trocas desfeitas, e exatamente o ANTIGO.
      const antigoDosTextos = textosDoGuia(g).map(desfazerTrocas);
      const antigoRender = desfazerTrocas(textoDoGuia(g));
      expect(hashDosTextos(antigoDosTextos)).toBe(conteudoV1);
      expect(sha(antigoRender)).toBe(renderV1);
      // E a normalizacao da troca (travessao entre espacos -> dois pontos)
      // aplicada ao antigo da o novo: nao ha outra diferenca.
      const normalizar = (t: string) => t.replace(/ [—–] /g, ": ");
      expect(normalizar(antigoRender)).toBe(textoDoGuia(g));
      expect(antigoRender).not.toBe(textoDoGuia(g));
    });
  }

  it("nenhum travessao no texto renderizado inteiro: com lista, sem lista e recusa", async () => {
    const renders: string[] = [];
    for (const nome of NOMES_DOS_CASOS) renders.push(textoDoGuia(await guiaDoCaso(nome)));
    renders.push(
      textoDoGuia(guia(gerarGuiaDoFacilitador({ ...NAO_PUBLICADO, dna: semConvidados(grupo(12)) }))),
    );
    for (const r of [
      gerarGuiaDoFacilitador({ publicacaoDoDna: { estado: "verificado", publicado: true }, dna: F.grupoSuficiente() }),
      gerarGuiaDoFacilitador({ publicacaoDoDna: { estado: "indeterminado", motivo: "registro_ilegivel" }, dna: grupo(12) }),
    ]) {
      if (r.tipo !== "guia_nao_gerado") throw new Error("esperava recusa");
      renders.push(textoDoGuiaNaoGerado(r));
    }
    for (const t of renders) {
      expect(t).toContain("MARCO ZERO: MATERIAL RESTRITO AO FACILITADOR");
      expect(TRAVESSAO.test(t), t.split("\n").find((l) => TRAVESSAO.test(l))).toBe(false);
    }
    // E nenhum texto fixo do modelo carrega travessao.
    for (const t of Object.values(TEXTOS_GUIA)) expect(TRAVESSAO.test(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O que o host BAIXA: "Baixar em texto" do GuiaDoFacilitadorCard grava em
// arquivo `desfecho.guia.texto`, que e o `texto` da rota passado adiante por
// `pedirGuiaDoFacilitador`. Aqui a cadeia real: rota -> borda da tela.
// ---------------------------------------------------------------------------

describe("Baixar em texto: o arquivo baixado e o texto da versao vigente", () => {
  for (const [nome, cobertura] of [
    ["com lista", { convidados: 20, motivo_convidados: null }],
    ["sem lista", SEM_LISTA],
  ] as const) {
    it(`${nome}: o texto que vai para o arquivo nao tem travessao e e o mesmo da previa`, async () => {
      h.cliente = clienteEmMemoria(banco(14, 12, cobertura));
      const { POST } = await import("../../../app/api/marco-zero/guia-facilitador/route");
      const buscar = (async (_url: string, init?: RequestInit) =>
        POST(
          new NextRequest("http://localhost/api/marco-zero/guia-facilitador", {
            method: init?.method,
            headers: init?.headers,
            body: init?.body as string,
          }),
        )) as unknown as typeof fetch;
      const desfecho = await pedirGuiaDoFacilitador(EVENTO, buscar);
      if (desfecho.tipo !== "gerado") throw new Error(`esperava guia, veio ${desfecho.tipo}`);

      // O MESMO valor alimenta a previa (<pre>) e o Blob do download.
      const baixado = desfecho.guia.texto;
      expect(TRAVESSAO.test(baixado)).toBe(false);
      expect(baixado.startsWith("MARCO ZERO: MATERIAL RESTRITO AO FACILITADOR\n")).toBe(true);

      // E e o texto do gerador, com o hash registrado da versao vigente.
      const preparo = await prepararEntradaDoGuia(clienteEmMemoria(banco(14, 12, cobertura)), EVENTO);
      if (!preparo.ok) throw new Error(preparo.codigo);
      const g = guia(gerarGuiaDoFacilitador(preparo.entrada));
      expect(baixado).toBe(textoDoGuia(g));
      expect(desfecho.guia.conteudo_sha256).toBe(hashDoGuia(g));
      if (nome === "com lista") {
        expect([desfecho.guia.conteudo_sha256, sha(baixado)]).toEqual(ESPERADO_V2["do banco"]);
      }
    });
  }
});
