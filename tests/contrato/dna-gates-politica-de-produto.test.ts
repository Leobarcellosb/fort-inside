// CONTRATO DE PRODUTO dos gates de publicacao do DNA Coletivo.
//
// POR QUE ESTE ARQUIVO EXISTE, SEPARADO DOS TESTES DO DNA
// -------------------------------------------------------
// Ja existe um teste que le o minimo de respostas DIRETO da migration 020, em
// tempo de execucao (MINIMO_RESPOSTAS_DO_BANCO, em
// components/features/marco-zero/dna-coletivo-fixtures.ts). Aquilo e bom e
// continua: prova que o TypeScript nao guarda uma copia do numero que possa
// derivar do banco.
//
// Mas prova SINCRONIZACAO TECNICA, nao POLITICA DE PRODUTO. Se alguem trocar a
// view de 30 para 12, um teste que le 12 automaticamente continua passando: os
// dois lados seguem de acordo, e o evento publica DNA Coletivo com 12 respostas.
// O buraco e exatamente esse.
//
// Este arquivo fecha o buraco escrevendo A REGRA POR EXTENSO, com os numeros
// APROVADOS literais, de proposito duplicados em relacao ao banco:
//
//   REGRA APROVADA: o DNA Coletivo quantitativo exige, SIMULTANEAMENTE,
//     (A) no minimo 30 respostas semanticamente validas, em contagem ABSOLUTA; e
//     (B) cobertura minima de 90% dos PRESENTES CONFIRMADOS (check-in fechado).
//   Uma condicao nunca compra a outra. Falhar qualquer uma recusa a publicacao.
//
// Sao DOIS testes com propositos diferentes e os dois ficam: o de fixtures
// pega deriva tecnica entre banco e codigo; este pega mudanca de politica de
// produto sem decisao registrada. Se este falhar, a pergunta nao e "conserta o
// teste", e "quem aprovou mudar a regra?".
//
// LOCALIZACAO: vive em tests/contrato/ e nao em components/features/marco-zero/
// por duas razoes -- a ordem desta unidade foi nao mexer nos arquivos de teste
// que o DNA ja tem, e um contrato de produto nao e detalhe de implementacao do
// modulo que ele restringe.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  COBERTURA_MINIMA_PERCENTUAL,
  atingeCoberturaMinima,
  gateDeVolumeDaCoberturaOficial,
  gerarDnaColetivo,
  type EntradaDna,
  type MotivoRelatorio,
  type ResultadoDna,
} from "../../components/features/marco-zero/dna-coletivo-modelo";
import {
  agregar,
  type ParticipanteDna,
} from "../../components/features/marco-zero/dna-coletivo-agregacao";
import {
  EIXOS,
  ELEMENTOS,
  ITENS_ELEMENTOS,
  ITENS_LIKERT,
  MAPA_SITUACIONAL,
  SITUACIONAIS,
  calcularMarcoZero,
  type Alternativa,
  type Eixo,
  type RespostasAchatadas,
} from "../../lib/scoring/marco-zero";

// ---------------------------------------------------------------------------
// A REGRA, escrita aqui e em lugar nenhum mais deste arquivo
// ---------------------------------------------------------------------------

/** (A) Minimo ABSOLUTO de respostas semanticamente validas. Decisao de produto. */
const MINIMO_RESPOSTAS_VALIDAS_APROVADO = 30;

/** (B) Cobertura minima, em percentual dos presentes confirmados. Decisao de produto. */
const COBERTURA_MINIMA_APROVADA = 90;

// ---------------------------------------------------------------------------
// Massa minima: participantes com a leitura de dimensoes completa, e sem ela
// ---------------------------------------------------------------------------
// Construida aqui, e nao importada das fixtures do DNA, para que este contrato
// nao dependa do helper que le a migration -- a independencia e o ponto.

const letraDoEixo = (q: (typeof SITUACIONAIS)[number], eixo: Eixo): Alternativa =>
  (["A", "B", "C", "D"] as Alternativa[]).find(
    (a) => MAPA_SITUACIONAL[q][a] === eixo,
  ) as Alternativa;

/** Todos os 24 itens Likert, as 6 situacionais e os 7 elementos, no dominio. */
function respostasCompletas(i: number): RespostasAchatadas {
  const destaque = EIXOS[i % EIXOS.length];
  const outros = EIXOS.filter((e) => e !== destaque);
  const r: RespostasAchatadas = {};
  for (const eixo of EIXOS) {
    for (const id of ITENS_LIKERT[eixo]) r[id] = eixo === destaque ? 5 : 3;
  }
  SITUACIONAIS.forEach((q, k) => {
    r[q] = letraDoEixo(q, k < 4 ? destaque : outros[k % outros.length]);
  });
  ELEMENTOS.forEach((el, k) => {
    r[ITENS_ELEMENTOS[el]] = 2 + ((i + k) % 9); // 2..10
  });
  return r;
}

/** So os elementos: nenhuma dimensao respondida, logo nao e respondente. */
function respostasSemDimensoes(i: number): RespostasAchatadas {
  const r: RespostasAchatadas = {};
  ELEMENTOS.forEach((el, k) => {
    r[ITENS_ELEMENTOS[el]] = 1 + ((i + k) % 10);
  });
  return r;
}

let seq = 0;
function participante(completo: boolean, presente = true): ParticipanteDna {
  const i = seq++;
  return {
    id: `contrato-${String(i).padStart(4, "0")}`,
    presente,
    scores: calcularMarcoZero(
      completo ? respostasCompletas(i) : respostasSemDimensoes(i),
    ),
  };
}

/**
 * Monta o cenario: `presentes` pessoas com check-in ativo, das quais `validas`
 * tem a leitura de dimensoes completa. O veredito do gate de volume e o que a
 * funcao do banco devolveria -- com o minimo APROVADO deste arquivo, nao com o
 * que a migration disser.
 */
function cenario(presentes: number, validas: number): EntradaDna {
  const participantes: ParticipanteDna[] = [
    ...Array.from({ length: validas }, () => participante(true)),
    ...Array.from({ length: presentes - validas }, () => participante(false)),
  ];
  const ag = agregar(presentes, participantes);
  // Sanidade da propria massa: se ela nao produz o numero pedido, o teste
  // abaixo mediria outra coisa.
  expect(ag.presentes, "a massa nao tem os presentes pedidos").toBe(presentes);
  expect(ag.respondentes, "a massa nao tem as respostas validas pedidas").toBe(validas);
  return {
    convidados: presentes,
    checkinFechado: true,
    participantes,
    gateDeVolume: gateDeVolumeDaCoberturaOficial({
      status: "ok",
      motivo: null,
      respondentes_validos: validas,
      gate_minimo_respostas: validas >= MINIMO_RESPOSTAS_VALIDAS_APROVADO,
      minimo_respostas: MINIMO_RESPOSTAS_VALIDAS_APROVADO,
    }),
  };
}

const elegivel = (r: ResultadoDna) => r.tipo === "rascunho_para_revisao";
const motivoDaRecusa = (r: ResultadoDna): MotivoRelatorio | null =>
  r.tipo === "relatorio_operacional" ? r.motivo : null;

// ---------------------------------------------------------------------------

describe("contrato de produto: os numeros aprovados sao os que o sistema usa", () => {
  it("o codigo do gerador exige 90% de cobertura dos presentes", () => {
    // Nao "o que o codigo disser": o valor APROVADO. Mudar a politica tem de
    // esbarrar aqui, e nao passar por sincronizacao automatica.
    expect(COBERTURA_MINIMA_PERCENTUAL).toBe(COBERTURA_MINIMA_APROVADA);
  });

  it("a view marco_zero_parametros_dna publica o minimo de 30 e a cobertura de 90", () => {
    // O teste de fixtures LE estes numeros e os usa, qualquer que sejam -- por
    // isso ele sobrevive a uma troca de 30 para 12. Aqui eles sao CONFERIDOS
    // contra a politica escrita.
    const sql = readFileSync(
      new URL("../../supabase/migrations/020_presenca_convites.sql", import.meta.url),
      "utf8",
    );
    const minimo = /(\d+)\s+as\s+minimo_respostas_validas/.exec(sql);
    const cobertura = /(\d+)\s+as\s+cobertura_minima_percentual/.exec(sql);
    expect(minimo, "a view perdeu minimo_respostas_validas").not.toBeNull();
    expect(cobertura, "a view perdeu cobertura_minima_percentual").not.toBeNull();
    expect(
      Number(minimo?.[1]),
      "a view mudou o minimo de respostas validas: isso e mudanca de POLITICA DE PRODUTO, nao ajuste tecnico",
    ).toBe(MINIMO_RESPOSTAS_VALIDAS_APROVADO);
    expect(
      Number(cobertura?.[1]),
      "a view mudou a cobertura minima: isso e mudanca de POLITICA DE PRODUTO, nao ajuste tecnico",
    ).toBe(COBERTURA_MINIMA_APROVADA);
  });
});

describe("contrato de produto: as duas condicoes valem SIMULTANEAMENTE", () => {
  // A tabela aprovada na revisao, linha por linha. Cada linha e exercitada pelo
  // gerador de verdade (gerarDnaColetivo), nao por uma reimplementacao da regra.
  const TABELA: readonly {
    presentes: number;
    validas: number;
    cobertura: string;
    esperado: "ELEGIVEL" | "RECUSADO";
    /** Qual das duas condicoes reprova (null quando as duas passam). */
    recusadoPor: MotivoRelatorio | null;
  }[] = [
    { presentes: 50, validas: 30, cobertura: "60%",   esperado: "RECUSADO", recusadoPor: "cobertura_insuficiente" },
    { presentes: 50, validas: 44, cobertura: "88%",   esperado: "RECUSADO", recusadoPor: "cobertura_insuficiente" },
    { presentes: 50, validas: 45, cobertura: "90%",   esperado: "ELEGIVEL", recusadoPor: null },
    { presentes: 33, validas: 30, cobertura: "90,9%", esperado: "ELEGIVEL", recusadoPor: null },
    { presentes: 12, validas: 12, cobertura: "100%",  esperado: "RECUSADO", recusadoPor: "volume_insuficiente" },
  ];

  for (const linha of TABELA) {
    const rotulo =
      `${linha.presentes} presentes, ${linha.validas} validas, cobertura ${linha.cobertura} ` +
      `-> ${linha.esperado}`;

    it(rotulo, () => {
      const r = gerarDnaColetivo(cenario(linha.presentes, linha.validas));

      if (linha.esperado === "ELEGIVEL") {
        expect(
          motivoDaRecusa(r),
          `${rotulo}: o gerador recusou um caso ELEGIVEL (motivo acima)`,
        ).toBeNull();
        expect(elegivel(r), `${rotulo}: devia produzir o documento`).toBe(true);
        return;
      }

      // RECUSADO: nao basta nao estar liberado -- NAO pode existir documento.
      expect(
        elegivel(r),
        `${rotulo}: DEFEITO -- o gerador APROVOU uma linha marcada RECUSADO`,
      ).toBe(false);
      expect(r.tipo).toBe("relatorio_operacional");
      expect(
        motivoDaRecusa(r),
        `${rotulo}: recusado, mas pelo motivo errado`,
      ).toBe(linha.recusadoPor);
    });
  }

  it("volume suficiente NAO compra cobertura: 50 presentes e 44 validas e recusado", () => {
    // 44 >= 30 (condicao A passa) e 88% < 90% (condicao B falha).
    expect(44).toBeGreaterThanOrEqual(MINIMO_RESPOSTAS_VALIDAS_APROVADO);
    expect(atingeCoberturaMinima(44, 50)).toBe(false);
    expect(elegivel(gerarDnaColetivo(cenario(50, 44)))).toBe(false);
  });

  it("cobertura suficiente NAO compra volume: 12 presentes e 12 validas e recusado", () => {
    // 100% >= 90% (condicao B passa) e 12 < 30 (condicao A falha).
    expect(atingeCoberturaMinima(12, 12)).toBe(true);
    expect(12).toBeLessThan(MINIMO_RESPOSTAS_VALIDAS_APROVADO);
    const r = gerarDnaColetivo(cenario(12, 12));
    expect(elegivel(r)).toBe(false);
    expect(motivoDaRecusa(r)).toBe("volume_insuficiente");
  });

  it("o menor grupo ELEGIVEL possivel tem 30 validas e pelo menos 90% de cobertura", () => {
    // Com o minimo de 30, 33 presentes e o maior denominador que 30 validas
    // ainda cobrem (30/34 = 88,2%). O par (33, 30) e a fronteira exata da regra.
    expect(atingeCoberturaMinima(30, 33)).toBe(true);
    expect(atingeCoberturaMinima(30, 34)).toBe(false);
    expect(elegivel(gerarDnaColetivo(cenario(33, 30)))).toBe(true);
    expect(motivoDaRecusa(gerarDnaColetivo(cenario(34, 30)))).toBe("cobertura_insuficiente");
  });

  it("29 validas com 100% de cobertura ainda e recusado por volume", () => {
    const r = gerarDnaColetivo(cenario(29, 29));
    expect(elegivel(r)).toBe(false);
    expect(motivoDaRecusa(r)).toBe("volume_insuficiente");
  });
});
