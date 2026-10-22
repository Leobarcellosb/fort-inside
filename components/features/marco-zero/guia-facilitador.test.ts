import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEMENTOS } from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import { ROTULOS_DIMENSAO, rotuloDaDimensao } from "./catalogo-dimensoes";
import { agregar } from "./dna-coletivo-agregacao";
import { validarTextoColetivo, validarTextosColetivos } from "./dna-coletivo-validacao";
import { validarTextosDeSaida } from "./validacao-saida";
import {
  PISO_DE_EXIBICAO,
  gerarDnaColetivo,
  textoDoRelatorioOperacional,
  type EntradaDna,
} from "./dna-coletivo-modelo";
import * as F from "./dna-coletivo-fixtures";
import {
  CAMPOS_DE_PARTICIPACAO,
  TEXTOS_GUIA,
  encontrarRetratoColetivo,
  exigirGuiaSemRetratoColetivo,
  exigirNumerosVerificados,
  gerarGuiaDoFacilitador,
  hashDoGuia,
  montarGuia,
  numerosDoTexto,
  projetarParticipacao,
  textoDoGuia,
  textosDoBloco,
  textosDoGuia,
  type GuiaDoFacilitador,
  type ResultadoGuia,
} from "./guia-facilitador-modelo";

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

const META = { nomeEvento: "Marco Zero | Geração Preparada", dataEvento: "2026-10-24" };

/** Grupo de teste: `completos` com leitura completa, mais as pendencias pedidas. */
function entradaDna(
  completos: number,
  opcoes: {
    parciais?: number;
    nada?: number;
    convidados?: number;
    checkinFechado?: boolean;
    /** Todas as respostas completas da MESMA especie (para o teste de invariancia). */
    especie?: F.Especie;
  } = {},
): EntradaDna {
  const {
    parciais = 0,
    nada = 0,
    convidados,
    checkinFechado = true,
    especie = { t: "sem_destaque" },
  } = opcoes;
  const participantes = [
    ...F.varias(completos, especie),
    ...F.varias(parciais, { t: "parcial" }),
    ...F.varias(nada, { t: "nada" }),
  ];
  return {
    meta: META,
    convidados: convidados ?? completos + parciais + nada,
    checkinFechado,
    participantes,
    gateDeVolume: F.gateVerificado(completos),
  };
}

function guia(r: ResultadoGuia): GuiaDoFacilitador {
  if (r.tipo !== "guia_do_facilitador") {
    throw new Error(`esperava guia, veio ${r.tipo}`);
  }
  return r.guia;
}
function naoGerado(r: ResultadoGuia) {
  if (r.tipo !== "guia_nao_gerado") throw new Error(`esperava recusa, veio ${r.tipo}`);
  return r;
}

const saida = process.env.GUIA_SAIDA;
if (saida) mkdirSync(saida, { recursive: true });
function gravar(nome: string, conteudo: string) {
  if (saida) writeFileSync(join(saida, nome), conteudo);
}

/** O grupo do enunciado: 12 pessoas, cobertura cheia, volume longe do minimo. */
function grupoDeDoze(): EntradaDna {
  return entradaDna(12, { convidados: 12 });
}

// ---------------------------------------------------------------------------
// 1. O grupo de 12 que nao tem DNA recebe um guia util
// ---------------------------------------------------------------------------

describe("grupo de 12 sem DNA Coletivo", () => {
  it("nao tem DNA: o modulo do DNA recusa por volume", () => {
    const dna = gerarDnaColetivo(grupoDeDoze());
    expect(dna.tipo).toBe("relatorio_operacional");
    if (dna.tipo === "relatorio_operacional") {
      expect(dna.motivo).toBe("volume_insuficiente");
      // Controle positivo do limiar: 12 passa cobertura e piso, e cai no volume.
      expect(dna.numeros.respondentes).toBe(12);
      expect(dna.numeros.faltamParaOLimiar).toBeNull();
      expect(dna.numeros.faltamParaOVolume).toBeGreaterThan(0);
    }
  });

  it("recebe o guia, com o cabecalho que o CTO escreveu e as cinco secoes", () => {
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    expect(g.cabecalho.restricao).toBe("MARCO ZERO — MATERIAL RESTRITO AO FACILITADOR");
    expect(g.cabecalho.titulo).toBe("Guia de Preparação do Facilitador");
    expect(g.motivoSemDna).toBe("volume_insuficiente");
    expect([
      g.participacao.id,
      g.semDna.id,
      g.preparacao.id,
      g.leituras.id,
      g.limites.id,
    ]).toEqual(["participacao", "sem_dna", "preparacao", "leituras_individuais", "limites"]);
  });

  it("e util: traz sugestao para cada etapa do dia e perguntas em forma de convite", () => {
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    const prep = textosDoBloco(g.preparacao).join("\n");
    for (const marca of [
      "Abertura, sem celular e sem relógio",
      "matriz SWOT do pilar de cada Núcleo",
      "Pilar Mental",
      "Pilar Profissional",
      "Pilar Financeiro",
      "Pilar Moral",
      "Pilar Liderança",
      "O Caso",
      "Mural do Futuro",
      "missão de trinta dias",
      "Se a conversa não andar",
    ]) {
      expect(prep).toContain(marca);
    }
    // Sugestoes sao convites: cada linha pede algo de quem responde.
    const linhas = g.preparacao.partes.flatMap((p) => ("linhas" in p ? p.linhas : []));
    expect(linhas.length).toBeGreaterThanOrEqual(18);
    const convites = linhas.filter((l) =>
      /\b(Pergunte|Peça|Combine|Devolva|Deixe|Agradeça|Evite|Diga|A missão sai)/.test(l.valor),
    );
    expect(convites.length).toBe(linhas.length);
  });

  it("e congelado e tem hash estavel (funcao pura, sem relogio)", () => {
    const r1 = gerarGuiaDoFacilitador({ dna: grupoDeDoze() });
    const r2 = gerarGuiaDoFacilitador({ dna: grupoDeDoze() });
    if (r1.tipo !== "guia_do_facilitador" || r2.tipo !== "guia_do_facilitador") {
      throw new Error("esperava guia nas duas geracoes");
    }
    expect(r1.conteudoSha256).toBe(r2.conteudoSha256);
    expect(r1.conteudoSha256).toBe(hashDoGuia(r1.guia));
    expect(Object.isFrozen(r1.guia)).toBe(true);
    expect(Object.isFrozen(r1.guia.preparacao)).toBe(true);
  });

  it("EVIDENCIA: grava o guia do grupo de 12 e o relatorio do DNA ao lado", () => {
    const e = grupoDeDoze();
    const g = guia(gerarGuiaDoFacilitador({ dna: e }));
    const dna = gerarDnaColetivo(e);
    gravar("guia-12.txt", textoDoGuia(g));
    if (dna.tipo === "relatorio_operacional") {
      gravar("relatorio-dna-12.txt", textoDoRelatorioOperacional(dna));
    }
    expect(textoDoGuia(g).length).toBeGreaterThan(2000);
  });
});

// ---------------------------------------------------------------------------
// 2. O guia passa pelo MESMO varredor do DNA, sem nenhuma violacao
// ---------------------------------------------------------------------------

describe("o mesmo varredor do DNA", () => {
  const grupos: [string, () => EntradaDna][] = [
    ["12 completos", grupoDeDoze],
    ["12 completos e 3 parciais", () => entradaDna(12, { parciais: 3, convidados: 20 })],
    ["5 completos (piso exato)", () => entradaDna(5, { convidados: 8, nada: 2 })],
    ["4 completos (abaixo do piso)", () => entradaDna(4, { convidados: 6 })],
    ["cobertura insuficiente", () => entradaDna(10, { parciais: 5, convidados: 15 })],
    ["check-in aberto", () => entradaDna(12, { convidados: 20, checkinFechado: false })],
    ["destaque em todas as quatro", () => entradaDna(12, { convidados: 12, especie: { t: "dois", eixo: "visao" } })],
    ["contraste entre as leituras", () => entradaDna(12, { convidados: 12, especie: { t: "contraste", l: "integridade", s: "relacao" } })],
  ];

  it.each(grupos)("%s: zero recusa do varredor coletivo", (_nome, montar) => {
    const g = guia(gerarGuiaDoFacilitador({ dna: montar() }));
    const textos = textosDoGuia(g);
    expect(validarTextosColetivos(textos)).toEqual([]);
    expect(validarTextosDeSaida(textos)).toEqual([]);
  });

  it("CONTROLE POSITIVO: o varredor recusa a afirmacao e aceita o convite", () => {
    // A linha que define a unidade, nas palavras do CTO.
    const proibido = "A sala tem dificuldade com prioridades.";
    const permitido = "Pergunte à sala como cada um decide prioridades quando tudo parece urgente.";
    expect(validarTextoColetivo(proibido).map((r) => r.motivo)).toContain(
      "coletivo_como_sujeito",
    );
    expect(validarTextoColetivo(permitido)).toEqual([]);
    // E a forma permitida e exatamente a que esta no guia.
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    expect(textosDoBloco(g.preparacao).join("\n")).toContain(permitido);
  });

  it("CONTROLE POSITIVO: o varredor pega cada familia de violacao", () => {
    const casos: [string, string][] = [
      ["Todos os presentes priorizam a entrega.", "afirmacao_universal"],
      ["O grupo precisa de mais tempo para decidir.", "coletivo_como_sujeito"],
      ["A maioria das pessoas prefere decidir junto.", "quantificador_sobre_o_conjunto"],
      ["Este guia é um retrato fiel da sala.", "representatividade"],
      ["Quem não respondeu prefere a segunda alternativa.", "inferencia_sobre_nao_respondentes"],
    ];
    for (const [texto, motivo] of casos) {
      expect(validarTextoColetivo(texto).map((r) => r.motivo)).toContain(motivo);
    }
  });

  it("CONTROLE POSITIVO: identificador de participante no texto e recusado", () => {
    const e = grupoDeDoze();
    const alvo = e.participantes[0];
    const g = guia(gerarGuiaDoFacilitador({ dna: e }));
    const textos = textosDoGuia(g);
    // Nome e id nao aparecem no guia...
    for (const t of textos) {
      expect(t).not.toContain(alvo.id);
      expect(t).not.toContain(alvo.nome);
    }
    // ...e o id liberado fica FORA do texto, em campo estruturado.
    const r = guia(
      gerarGuiaDoFacilitador({
        dna: e,
        autorizacoes: [{ participanteId: alvo.id, autorizado: true }],
      }),
    );
    expect(r.acessoIndividual.idsLiberados).toEqual([alvo.id]);
    expect(textosDoGuia(r).join("\n")).not.toContain(alvo.id);
  });
});

// ---------------------------------------------------------------------------
// 3. A TRAVA ANTI-CONTORNO: o que o DNA suprime nao reaparece no guia
// ---------------------------------------------------------------------------

describe("trava anti-contorno", () => {
  it("camada 1 (estrutural): o canal do guia so admite as oito contagens de participacao", () => {
    const { participacao } = projetarParticipacao({ dna: grupoDeDoze() });
    expect(Object.keys(participacao).sort()).toEqual([...CAMPOS_DE_PARTICIPACAO].sort());
    // Nada de conteudo de resposta no canal: os nomes proibidos nao existem.
    for (const proibido of [
      "autodescricao",
      "situacional",
      "cruzamento",
      "elementos",
      "porDimensao",
      "comDestaque",
      "semDestaque",
      "scores",
    ]) {
      expect(Object.keys(participacao)).not.toContain(proibido);
    }
  });

  it("uma informacao suprimida no DNA por piso de privacidade NAO reaparece no guia", () => {
    // Grupo de 12 com celulas pequenas: 3 destacam uma dimensao, 4 outra, 5 sem
    // destaque. No DNA, 3 e 4 estao abaixo do piso e seriam suprimidos; aqui o
    // DNA nem e gerado (volume), e o guia tambem nao pode trazer isso.
    const e: EntradaDna = {
      meta: META,
      convidados: 12,
      checkinFechado: true,
      participantes: [
        ...F.varias(3, { t: "dois", eixo: "visao" }),
        ...F.varias(4, { t: "dois", eixo: "execucao" }),
        ...F.varias(5, { t: "sem_destaque" }),
      ],
      gateDeVolume: F.gateVerificado(12),
    };
    const ag = agregar(e.convidados, e.participantes);
    // O que o piso suprimiria: as celulas de 1 a PISO-1.
    const suprimidas = ROTULOS_DIMENSAO.map((_, i) => i)
      .map((i) => ag.autodescricao.porDimensao[(["visao", "execucao", "relacao", "integridade"] as const)[i]])
      .filter((n) => n > 0 && n < PISO_DE_EXIBICAO);
    expect(suprimidas).toEqual([3, 4]); // o fato existe e e pequeno: nao pode sair

    const g = guia(gerarGuiaDoFacilitador({ dna: e }));
    const textos = textosDoGuia(g);

    // (a) o rotulo da dimensao nao aparece em lugar nenhum do guia;
    for (const rotulo of ROTULOS_DIMENSAO) {
      expect(textos.join("\n")).not.toContain(rotulo);
    }
    for (const el of ELEMENTOS) {
      expect(textos.join("\n")).not.toContain(ROTULOS_ELEMENTOS_PADRAO[el]);
    }
    // (b) o guia nao traz nenhum digito fora da secao de participacao;
    const foraDaParticipacao = [
      g.abertura,
      ...textosDoBloco(g.semDna),
      ...textosDoBloco(g.preparacao),
      ...textosDoBloco(g.leituras),
      ...textosDoBloco(g.limites),
      g.notaDeLeitura,
    ];
    expect(foraDaParticipacao.flatMap(numerosDoTexto)).toEqual([]);
    // (c) e os digitos da secao de participacao sao exatamente as contagens
    //     verificadas -- 3 e 4 nao estao entre elas.
    const verificados = new Set(
      CAMPOS_DE_PARTICIPACAO.map((c) => g.populacoes[c])
        .filter((v): v is number => v !== null)
        .map(String),
    );
    for (const n of textosDoBloco(g.participacao).flatMap(numerosDoTexto)) {
      expect(verificados.has(n)).toBe(true);
    }
    expect(verificados.has("3")).toBe(false);
    expect(verificados.has("4")).toBe(false);
  });

  it("CONTROLE POSITIVO: a mesma informacao, escrita no guia, e recusada", () => {
    const frase = `${rotuloDaDimensao("visao")}: 3 pessoas (25% dos respondentes)`;
    // O detector de vocabulario de retrato pega o rotulo e o percentual.
    const recusas = encontrarRetratoColetivo(frase).map((r) => r.motivo);
    expect(recusas).toContain("rotulo_do_instrumento");
    expect(recusas).toContain("percentual");
    expect(() => exigirGuiaSemRetratoColetivo([frase])).toThrow(/rotulo_do_instrumento/);

    // E o guia inteiro, com a frase injetada, tambem e recusado.
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    const adulterado: GuiaDoFacilitador = {
      ...g,
      limites: {
        ...g.limites,
        partes: [...g.limites.partes, { paragrafo: frase }],
      },
    };
    expect(() => exigirGuiaSemRetratoColetivo(textosDoGuia(adulterado))).toThrow();
    expect(() => exigirNumerosVerificados(adulterado)).toThrow(/Dígito fora da seção/);
  });

  it("CONTROLE POSITIVO: o detector esta vivo para media, distribuicao e eixo", () => {
    expect(encontrarRetratoColetivo("A média do grupo ficou alta.").map((r) => r.motivo)).toContain("media");
    expect(encontrarRetratoColetivo("Veja a distribuição entre as quatro.").map((r) => r.motivo)).toContain("distribuicao");
    expect(encontrarRetratoColetivo("Metade escolheu a segunda.").map((r) => r.motivo)).toContain("quantificador_solto");
    expect(encontrarRetratoColetivo("O eixo mais pontuado foi o primeiro.").map((r) => r.motivo)).toContain("dimensao_nomeada");
    // E o guia real passa limpo.
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    for (const t of textosDoGuia(g)) expect(encontrarRetratoColetivo(t)).toEqual([]);
  });

  it("CONTROLE POSITIVO: numero nao verificado na secao de participacao e recusado", () => {
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    expect(() => exigirNumerosVerificados(g)).not.toThrow();
    const adulterado: GuiaDoFacilitador = {
      ...g,
      participacao: {
        ...g.participacao,
        partes: [
          ...g.participacao.partes,
          { linhas: [{ rotulo: "Pessoas com destaque", valor: "7" }] },
        ],
      },
    };
    expect(() => exigirNumerosVerificados(adulterado)).toThrow(/Número não verificado/);
  });

  it("as sugestoes de conducao nao dependem das respostas: dois grupos opostos, guia identico", () => {
    // Mesmas populacoes, conteudo de resposta oposto.
    const a = entradaDna(12, { convidados: 12, especie: { t: "sem_destaque" } });
    const b = entradaDna(12, { convidados: 12, especie: { t: "dois", eixo: "integridade" } });
    const ga = guia(gerarGuiaDoFacilitador({ dna: a }));
    const gb = guia(gerarGuiaDoFacilitador({ dna: b }));
    // O conteudo das respostas e de fato oposto...
    const agA = agregar(a.convidados, a.participantes);
    const agB = agregar(b.convidados, b.participantes);
    expect(agA.autodescricao.semDestaque).toBe(12);
    expect(agB.autodescricao.comDestaque).toBe(12);
    // ...e o guia e o MESMO, byte a byte, hash incluso.
    expect(textoDoGuia(ga)).toBe(textoDoGuia(gb));
    expect(hashDoGuia(ga)).toBe(hashDoGuia(gb));
  });

  it("grupos com populacoes diferentes: muda a participacao, nao a preparacao", () => {
    const g1 = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    const g2 = guia(gerarGuiaDoFacilitador({ dna: entradaDna(9, { parciais: 2, convidados: 20 }) }));
    expect(textosDoBloco(g1.participacao)).not.toEqual(textosDoBloco(g2.participacao));
    expect(textosDoBloco(g1.preparacao)).toEqual(textosDoBloco(g2.preparacao));
    expect(textosDoBloco(g1.leituras)).toEqual(textosDoBloco(g2.leituras));
    expect(textosDoBloco(g1.limites)).toEqual(textosDoBloco(g2.limites));
  });
});

// ---------------------------------------------------------------------------
// 4. As tres populacoes, sem confusao
// ---------------------------------------------------------------------------

describe("tres populacoes", () => {
  it("convidados, presentes e respondentes aparecem separados e com nome", () => {
    // 20 convidados; 14 presentes; 9 completas; 2 parciais; 1 completa de ausente.
    const participantes = [
      ...F.varias(9, { t: "sem_destaque" }),
      ...F.varias(2, { t: "parcial" }),
      ...F.varias(3, { t: "nada" }),
      ...F.varias(1, { t: "dois", eixo: "visao" }, false),
    ];
    const e: EntradaDna = {
      meta: META,
      convidados: 20,
      checkinFechado: true,
      participantes,
      gateDeVolume: F.gateVerificado(9),
    };
    const g = guia(gerarGuiaDoFacilitador({ dna: e }));
    const p = g.populacoes;
    expect(p.convidados).toBe(20);
    expect(p.presentes).toBe(14); // 9 + 2 + 3 presentes
    expect(p.respostasCompletas).toBe(10); // 9 presentes + 1 de quem nao esteve
    expect(p.respostasCompletasDePresentes).toBe(9); // a populacao da cobertura
    expect(p.respostasIncompletas).toBe(2);
    expect(p.semRespostaRegistrada).toBe(8); // 20 - 10 - 2

    // As tres populacoes sao numeros DIFERENTES, e o guia nomeia cada uma.
    expect(new Set([p.convidados, p.presentes, p.respostasCompletasDePresentes]).size).toBe(3);
    const linhas = g.participacao.partes.flatMap((x) => ("linhas" in x ? x.linhas : []));
    const porRotulo = new Map(linhas.map((l) => [l.rotulo, l.valor]));
    expect(porRotulo.get("Convidados, quem foi chamado")).toBe("20");
    expect(porRotulo.get("Presentes, com o check-in fechado")).toBe("14");
    expect(porRotulo.get("Respostas completas recebidas")).toBe("10");
    expect(porRotulo.get("Respostas completas de quem esteve presente")).toBe("9");
    expect(porRotulo.get("Respostas iniciadas e não concluídas")).toBe("2");
    expect(porRotulo.get("Convidados sem resposta registrada")).toBe("8");
    // E diz, em prosa, que uma nao substitui a outra.
    expect(textosDoBloco(g.participacao).join("\n")).toContain(
      "uma proporção calculada sobre a população errada diz outra coisa",
    );
    gravar("guia-populacoes.txt", textoDoGuia(g));
  });

  it("a resposta de quem nao esteve presente nao infla a populacao de presentes", () => {
    const comAusente = entradaDna(9, { convidados: 20 });
    const participantes = [...comAusente.participantes, ...F.varias(4, { t: "sem_destaque" }, false)];
    const g = guia(
      gerarGuiaDoFacilitador({
        dna: { ...comAusente, participantes, gateDeVolume: F.gateVerificado(9) },
      }),
    );
    expect(g.populacoes.respostasCompletas).toBe(13);
    expect(g.populacoes.respostasCompletasDePresentes).toBe(9);
    expect(g.populacoes.presentes).toBe(9);
  });

  it("sem check-in fechado, a populacao de presentes nao e inventada", () => {
    const g = guia(
      gerarGuiaDoFacilitador({ dna: entradaDna(12, { convidados: 20, checkinFechado: false }) }),
    );
    expect(g.populacoes.presentes).toBeNull();
    expect(g.populacoes.respostasCompletasDePresentes).toBeNull();
    expect(g.motivoSemDna).toBe("checkin_aberto");
    const t = textosDoBloco(g.participacao).join("\n");
    expect(t).toContain("população ainda não verificada: o check-in não foi fechado");
    expect(t).toContain("em vez de imprimir estimativa");
    gravar("guia-checkin-aberto.txt", textoDoGuia(g));
  });

  it("CONTROLE POSITIVO: populacao incoerente recusa o guia em vez de arredondar", () => {
    // Mais respostas do que convidados informados.
    const e = entradaDna(12, { convidados: 5 });
    const r = naoGerado(gerarGuiaDoFacilitador({ dna: e }));
    expect(r.motivo).toBe("dados_inconsistentes");
    expect(r.paragrafos.join("\n")).toMatch(/não fecham|não permitiram avaliar/);
  });
});

// ---------------------------------------------------------------------------
// 5. Quando o guia NAO existe
// ---------------------------------------------------------------------------

describe("recusas do guia", () => {
  it("evento COM DNA Coletivo nao recebe guia: o guia nao e um DNA reduzido", () => {
    const r = naoGerado(gerarGuiaDoFacilitador({ dna: F.grupoSuficiente() }));
    expect(r.motivo).toBe("dna_disponivel");
    expect(r.acoes.join("\n")).toContain("DNA Coletivo");
  });

  it("os demais motivos de ausencia de DNA geram guia, com o motivo nomeado", () => {
    const casos: [string, EntradaDna][] = [
      ["volume_insuficiente", grupoDeDoze()],
      ["cobertura_insuficiente", entradaDna(10, { parciais: 5, convidados: 15 })],
      ["base_pequena_demais", entradaDna(4, { convidados: 6 })],
      ["checkin_aberto", entradaDna(12, { convidados: 20, checkinFechado: false })],
      [
        "gate_de_volume_indisponivel",
        {
          ...grupoDeDoze(),
          gateDeVolume: { estado: "indisponivel", motivo: "consulta_nao_respondeu" },
        },
      ],
    ];
    for (const [motivo, e] of casos) {
      const g = guia(gerarGuiaDoFacilitador({ dna: e }));
      expect(g.motivoSemDna).toBe(motivo);
      // O motivo e dito em prosa, sem numero nenhum.
      const t = textosDoBloco(g.semDna).join("\n");
      expect(numerosDoTexto(t)).toEqual([]);
      expect(t).toContain("não é um DNA Coletivo reduzido");
    }
  });

  it("sem presentes, com check-in fechado: guia com populacao de presentes zero", () => {
    const e: EntradaDna = {
      meta: META,
      convidados: 12,
      checkinFechado: true,
      participantes: F.varias(3, { t: "sem_destaque" }, false),
      gateDeVolume: F.gateVerificado(0),
    };
    const g = guia(gerarGuiaDoFacilitador({ dna: e }));
    expect(g.motivoSemDna).toBe("sem_presentes");
    expect(g.populacoes.presentes).toBe(0);
    expect(g.populacoes.respostasCompletas).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Leituras individuais: acesso controlado
// ---------------------------------------------------------------------------

describe("leituras individuais", () => {
  it("conta so quem liberou, e quem liberou sem resposta entra em linha propria", () => {
    const e = entradaDna(9, { nada: 3, convidados: 12 });
    const completos = e.participantes.filter((p) => p.scores !== null);
    const semResposta = e.participantes.filter((p) => p.scores === null);
    const g = guia(
      gerarGuiaDoFacilitador({
        dna: e,
        autorizacoes: [
          { participanteId: completos[0].id, autorizado: true },
          { participanteId: completos[1].id, autorizado: true },
          { participanteId: completos[2].id, autorizado: false },
          { participanteId: semResposta[0].id, autorizado: true },
        ],
      }),
    );
    expect(g.populacoes.leiturasIndividuaisLiberadas).toBe(2);
    expect(g.populacoes.liberacoesSemRespostaRegistrada).toBe(1);
    expect(g.acessoIndividual.idsLiberados).toEqual([completos[0].id, completos[1].id]);
    expect(textosDoBloco(g.leituras).join("\n")).toContain(
      "não vira frase sobre as pessoas presentes",
    );
  });

  it("sem liberacao, o guia nao abre leitura nenhuma", () => {
    const g = guia(gerarGuiaDoFacilitador({ dna: grupoDeDoze() }));
    expect(g.populacoes.leiturasIndividuaisLiberadas).toBe(0);
    expect(g.acessoIndividual.idsLiberados).toEqual([]);
  });

  it("CONTROLE POSITIVO: liberacao para quem nao esta na lista recusa o guia", () => {
    const r = naoGerado(
      gerarGuiaDoFacilitador({
        dna: grupoDeDoze(),
        autorizacoes: [{ participanteId: "p-fora-da-lista", autorizado: true }],
      }),
    );
    expect(r.motivo).toBe("dados_inconsistentes");
    expect(r.paragrafos.join("\n")).toContain("não está na lista de participantes");
  });

  it("CONTROLE POSITIVO: liberacao repetida recusa o guia", () => {
    const e = grupoDeDoze();
    const id = e.participantes[0].id;
    const r = naoGerado(
      gerarGuiaDoFacilitador({
        dna: e,
        autorizacoes: [
          { participanteId: id, autorizado: true },
          { participanteId: id, autorizado: false },
        ],
      }),
    );
    expect(r.motivo).toBe("dados_inconsistentes");
  });
});

// ---------------------------------------------------------------------------
// 7. A moldura, revisavel num lugar so
// ---------------------------------------------------------------------------

describe("moldura", () => {
  it("todo texto de moldura passa pelos dois varredores", () => {
    const textos = Object.values(TEXTOS_GUIA);
    expect(validarTextosColetivos(textos)).toEqual([]);
    for (const t of textos) expect(encontrarRetratoColetivo(t)).toEqual([]);
  });

  it("montarGuia nao aceita canal alem das oito contagens (compilacao) e nomeia o evento", () => {
    const { participacao, idsLiberados } = projetarParticipacao({ dna: grupoDeDoze() });
    const g = montarGuia(participacao, "volume_insuficiente", "Marco Zero | Itaqui", idsLiberados);
    expect(g.cabecalho.linhaEvento).toBe("Marco Zero | Itaqui");
    expect(() => exigirNumerosVerificados(g)).not.toThrow();
    expect(montarGuia(participacao, "volume_insuficiente", null, []).cabecalho.linhaEvento).toBeNull();
  });
});
