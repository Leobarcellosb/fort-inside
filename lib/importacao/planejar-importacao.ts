// A PONTE: respostas coletadas FORA do aplicativo viram respostas canonicas.
//
// O PROBLEMA, nas palavras do responsavel tecnico: "se corrigirmos apenas o
// portao, poderemos terminar com uma fila perfeitamente funcional e NENHUM
// questionario externo elegivel para entrar nela". A coleta pre-evento do Marco
// Zero comecou por Google Forms, nao pelo aplicativo. Sem esta ponte, a fila e
// o motor de pontuacao ficam prontos e vazios.
//
// ESTE ARQUIVO NAO ESCREVE NADA. Ele PLANEJA: recebe o manifesto, as submissoes
// externas e os participantes, e devolve, para cada submissao, o que deve ser
// gravado e o que NAO pode ser gravado, com motivo. Quem grava e a migration 022
// (`importacao_externa_aplicar`), numa transacao, a partir deste plano. A
// separacao e deliberada: a decisao e testavel sem banco, e a escrita e atomica.
//
// A ORDEM DOS PORTOES IMPORTA, e e esta:
//
//   1. OPERADOR. Sem operador nomeado nao ha importacao. Regra 5: reconciliar
//      identidade e um ato de alguem, registrado -- nao efeito colateral.
//   2. ORIGEM. Sem formulario de origem identificado nao ha proveniencia, e sem
//      proveniencia nao se sabe de onde veio um dado que vai virar documento
//      sobre uma pessoa (regra 4).
//   3. MANIFESTO. A impressao declarada tem de bater com a do sistema. Se nao
//      bater, ou se nao der para conferir, PARA AQUI: nada e mapeado, nada e
//      pontuado, nada e gravado. Conferir depois de pontuar nao serve de nada.
//   4. IDENTIDADE, no lote inteiro (duas submissoes da mesma pessoa so aparecem
//      olhando o lote).
//   5. CORRESPONDENCIA das respostas, pergunta por pergunta.
//
// OS ESTADOS DE UMA SUBMISSAO, e por que sao quatro e nao dois:
//
//   importavel     identidade resolvida e nenhuma incompatibilidade em pergunta
//                  pontuada. Vira resposta canonica e e pontuavel.
//   incompativel   identidade resolvida, mas ALGUMA resposta pontuada falhou a
//                  correspondencia. As compativeis sao gravadas (dado coletado
//                  nao se joga fora) e a submissao fica MARCADA: nao e apta a
//                  pontuar. Isto e o oposto de pontuar zero.
//   pendente       identidade nao resolvida. Espera decisao humana.
//   conflito       mais de um candidato de um dos lados. Espera decisao humana.
//
// POR QUE A COMPATIVEL E GRAVADA MESMO COM UMA IRMA INCOMPATIVEL: nao gravar a
// etapa inteira transformaria UMA incompatibilidade em seis ausencias, que e
// justamente a confusao que a regra 2 proibe. O que protege a pontuacao nao e
// esconder o dado, e o campo `apto_para_pontuar` com `bloqueio` nomeado, que
// viaja no plano, na linha gravada e na visao de proveniencia.
//
// Funcoes puras: sem I/O, sem data/hora, sem aleatoriedade. O instante da
// importacao e o banco que crava (`now()` na migration 022).

import {
  conferirImpressao,
  type ManifestoQuestionario,
  type ResultadoDaConferencia,
} from "./manifesto-questionario";
import { mapearSubmissao, type ItemMapeado, type SubmissaoMapeada } from "./mapear-resposta";
import {
  reconciliarLote,
  type ParticipanteDoEvento,
  type ResultadoDeIdentidade,
  type SubmissaoExterna,
} from "./reconciliar-identidade";

export interface OrigemDaColeta {
  /** Identificador do formulario (id do Google Forms, ou nome do arquivo exportado). */
  formulario_id: string;
  /** Nome legivel do formulario, para quem le a proveniencia depois. */
  formulario_nome?: string | null;
  /** Impressao digital do questionario DECLARADA por quem montou a coleta. */
  impressao_declarada: unknown;
}

export interface OperadorDaImportacao {
  /** Quem responde pela importacao. Costuma ser o `auth.users.id` do admin. */
  id: string;
  email?: string | null;
}

export interface EntradaDaImportacao {
  evento: { id: string; quiz_version: number };
  manifesto: ManifestoQuestionario;
  origem: OrigemDaColeta;
  submissoes: readonly SubmissaoExterna[];
  participantes: readonly ParticipanteDoEvento[];
  operador: OperadorDaImportacao;
}

export type CodigoDeRecusaDoPlano =
  /** Conferido: o questionario da coleta NAO e o do sistema. */
  | "MANIFESTO_DIFERENTE"
  /** NAO deu para conferir o questionario. Nao e "bate" nem "nao bate". */
  | "MANIFESTO_INDISPONIVEL"
  /** Importacao sem operador responsavel. */
  | "OPERADOR_AUSENTE"
  /** Importacao sem formulario de origem identificado. */
  | "ORIGEM_AUSENTE"
  /** Manifesto de uma versao de questionario diferente da do evento. */
  | "VERSAO_DIVERGENTE";

export type EstadoDaSubmissao = "importavel" | "incompativel" | "pendente" | "conflito";

/** A proveniencia da regra 4, inteira, por submissao. */
export interface Proveniencia {
  formulario_id: string;
  formulario_nome: string | null;
  submissao_id: string;
  quiz_version: number;
  /** Impressao digital das perguntas que a pessoa respondeu, ja conferida. */
  questionario_impressao: string;
  participant_id: string | null;
  /** Como a identidade foi estabelecida. */
  identidade_via: "email_verificado" | "decisao_do_operador" | null;
  email_reconciliado: string | null;
  importado_por: string;
  importado_por_email: string | null;
}

export interface EtapaPlanejada {
  stage_id: number;
  stage_number: number;
  /** So valores COMPATIVEIS. Nenhum placeholder, nenhum zero. */
  answers: Record<string, string | number | string[]>;
  /** Ids das perguntas desta etapa que ficaram incompativeis. */
  incompativeis: string[];
  /** Ids desta etapa que ficaram sem resposta. */
  ausentes: string[];
}

export interface Bloqueio {
  motivo: string;
  /** As perguntas que causaram o bloqueio, nomeadas. */
  perguntas: string[];
}

/**
 * O que a coleta externa entregou, EXATAMENTE como entregou. Guardado junto do
 * resultado porque dado coletado de uma pessoa nao se joga fora: se amanha a
 * correspondencia for corrigida, e daqui que ela e refeita, sem pedir que 50
 * jovens respondam de novo.
 */
export interface ColetaCrua {
  email: string | null;
  email_verificado: boolean;
  nome_declarado: string | null;
  respostas_brutas: Readonly<Record<string, unknown>>;
}

export interface SubmissaoPlanejada {
  submissao_id: string;
  estado: EstadoDaSubmissao;
  identidade: ResultadoDeIdentidade;
  participant_id: string | null;
  coleta: ColetaCrua;
  /** Etapas a gravar. Vazio quando a identidade nao esta resolvida. */
  etapas: EtapaPlanejada[];
  itens: ItemMapeado[];
  /** `false` sempre que houver incompatibilidade em pergunta pontuada. */
  apto_para_pontuar: boolean;
  bloqueio: Bloqueio | null;
  proveniencia: Proveniencia;
  contagens: {
    compativeis: number;
    incompativeis: number;
    incompativeis_pontuadas: number;
    ausentes: number;
    desconhecidas: number;
  };
}

export interface ResumoDaImportacao {
  submissoes: number;
  importaveis: number;
  incompativeis: number;
  pendentes: number;
  conflitos: number;
  /** Total de respostas que falharam a correspondencia no lote. */
  itens_incompativeis: number;
}

export type PlanoDeImportacao =
  | {
      ok: false;
      codigo: CodigoDeRecusaDoPlano;
      motivo: string;
      conferencia?: ResultadoDaConferencia;
    }
  | {
      ok: true;
      evento_id: string;
      quiz_version: number;
      questionario_impressao: string;
      conferencia: ResultadoDaConferencia;
      operador: OperadorDaImportacao;
      origem: Omit<OrigemDaColeta, "impressao_declarada"> & { impressao_declarada: string };
      submissoes: SubmissaoPlanejada[];
      resumo: ResumoDaImportacao;
    };

function recusa(
  codigo: CodigoDeRecusaDoPlano,
  motivo: string,
  conferencia?: ResultadoDaConferencia,
): PlanoDeImportacao {
  return { ok: false, codigo, motivo, conferencia };
}

/**
 * Planeja a importacao de um lote de submissoes externas.
 *
 * Nunca lanca. Nunca devolve numero aproximado: devolve recusa com motivo, ou um
 * plano em que cada submissao diz o que e e por que.
 */
export function planejarImportacao(entrada: EntradaDaImportacao): PlanoDeImportacao {
  const { evento, manifesto, origem, submissoes, participantes, operador } = entrada;

  // --- PORTAO 1: operador ---------------------------------------------------
  if (typeof operador?.id !== "string" || operador.id.trim() === "") {
    return recusa(
      "OPERADOR_AUSENTE",
      "importacao sem operador responsavel. A reconciliacao de identidade e um ato de alguem, registrado e reversivel, nao um efeito colateral de um import",
    );
  }

  // --- PORTAO 2: origem -----------------------------------------------------
  if (typeof origem?.formulario_id !== "string" || origem.formulario_id.trim() === "") {
    return recusa(
      "ORIGEM_AUSENTE",
      "importacao sem formulario de origem identificado. Sem proveniencia nao se sabe de onde veio um dado que vai virar documento sobre uma pessoa",
    );
  }

  if (manifesto.quiz_version !== evento.quiz_version) {
    return recusa(
      "VERSAO_DIVERGENTE",
      `o manifesto e da versao ${manifesto.quiz_version} do questionario e o evento esta na versao ${evento.quiz_version}`,
    );
  }

  // --- PORTAO 3: MANIFESTO, antes de qualquer pontuacao ---------------------
  const conferencia = conferirImpressao(origem.impressao_declarada, manifesto.impressao);
  if (conferencia.veredito === "diferente") {
    return recusa(
      "MANIFESTO_DIFERENTE",
      `${conferencia.motivo}. Declarada: ${conferencia.declarada}. Do sistema: ${conferencia.doSistema}. Nenhuma resposta foi mapeada, gravada ou pontuada`,
      conferencia,
    );
  }
  if (conferencia.veredito === "indisponivel") {
    return recusa(
      "MANIFESTO_INDISPONIVEL",
      `${conferencia.motivo}. Nenhuma resposta foi mapeada, gravada ou pontuada`,
      conferencia,
    );
  }

  // --- PORTAO 4: identidade, no lote ----------------------------------------
  const identidades = reconciliarLote(submissoes, participantes);
  const porSubmissao = new Map<string, ResultadoDeIdentidade>();
  for (const i of identidades) porSubmissao.set(i.submissao_id, i);

  // --- PORTAO 5: correspondencia das respostas ------------------------------
  const planejadas: SubmissaoPlanejada[] = [];
  for (const s of submissoes) {
    const identidade =
      porSubmissao.get(s.submissao_id) ??
      ({
        estado: "pendente",
        submissao_id: s.submissao_id,
        motivo: "email_ausente",
        email_normalizado: null,
        explicacao: "submissao sem resultado de reconciliacao",
      } satisfies ResultadoDeIdentidade);

    const mapeada = mapearSubmissao(manifesto, s.respostas);
    planejadas.push(
      montarSubmissao({
        submissao: s,
        identidade,
        mapeada,
        manifesto,
        origem,
        operador,
      }),
    );
  }

  const resumo: ResumoDaImportacao = {
    submissoes: planejadas.length,
    importaveis: planejadas.filter((p) => p.estado === "importavel").length,
    incompativeis: planejadas.filter((p) => p.estado === "incompativel").length,
    pendentes: planejadas.filter((p) => p.estado === "pendente").length,
    conflitos: planejadas.filter((p) => p.estado === "conflito").length,
    itens_incompativeis: planejadas.reduce((a, p) => a + p.contagens.incompativeis, 0),
  };

  return {
    ok: true,
    evento_id: evento.id,
    quiz_version: evento.quiz_version,
    questionario_impressao: manifesto.impressao,
    conferencia,
    operador,
    origem: {
      formulario_id: origem.formulario_id.trim(),
      formulario_nome: origem.formulario_nome ?? null,
      impressao_declarada: manifesto.impressao,
    },
    submissoes: planejadas,
    resumo,
  };
}

function montarSubmissao(args: {
  submissao: SubmissaoExterna;
  identidade: ResultadoDeIdentidade;
  mapeada: SubmissaoMapeada;
  manifesto: ManifestoQuestionario;
  origem: OrigemDaColeta;
  operador: OperadorDaImportacao;
}): SubmissaoPlanejada {
  const { submissao, identidade, mapeada, manifesto, origem, operador } = args;

  const participant_id = identidade.estado === "reconciliada" ? identidade.participant_id : null;

  const proveniencia: Proveniencia = {
    formulario_id: origem.formulario_id.trim(),
    formulario_nome: origem.formulario_nome ?? null,
    submissao_id: submissao.submissao_id,
    quiz_version: manifesto.quiz_version,
    questionario_impressao: manifesto.impressao,
    participant_id,
    identidade_via: identidade.estado === "reconciliada" ? identidade.via : null,
    email_reconciliado: identidade.email_normalizado,
    importado_por: operador.id.trim(),
    importado_por_email: operador.email ?? null,
  };

  const contagens = {
    compativeis: mapeada.compativeis,
    incompativeis: mapeada.incompativeis.length,
    incompativeis_pontuadas: mapeada.incompativeisPontuadas.length,
    ausentes: mapeada.ausentes.length,
    desconhecidas: mapeada.desconhecidas.length,
  };

  const coleta: ColetaCrua = {
    email: submissao.email,
    email_verificado: submissao.email_verificado,
    nome_declarado: submissao.nome_declarado ?? null,
    respostas_brutas: submissao.respostas,
  };

  // Identidade nao resolvida: NADA e gravado como resposta de ninguem. As
  // respostas ficam retidas na submissao externa (migration 022), nunca
  // descartadas -- so nao viram resposta canonica de participante nenhum.
  if (identidade.estado !== "reconciliada") {
    return {
      submissao_id: submissao.submissao_id,
      estado: identidade.estado,
      identidade,
      participant_id: null,
      coleta,
      etapas: [],
      itens: mapeada.itens,
      apto_para_pontuar: false,
      bloqueio: {
        motivo:
          identidade.estado === "pendente"
            ? `identidade PENDENTE (${identidade.motivo}): ${identidade.explicacao}`
            : `identidade em CONFLITO (${identidade.motivo}): ${identidade.explicacao}`,
        perguntas: [],
      },
      proveniencia,
      contagens,
    };
  }

  // Agrupa as compativeis por etapa, na ordem canonica das etapas.
  const porEtapa = new Map<number, EtapaPlanejada>();
  for (const etapa of manifesto.etapas) {
    porEtapa.set(etapa.n, {
      stage_id: manifesto.idsDasEtapas[etapa.n],
      stage_number: etapa.n,
      answers: {},
      incompativeis: [],
      ausentes: [],
    });
  }

  for (const item of mapeada.itens) {
    const n = manifesto.etapaDaPergunta[item.pergunta_id];
    // `pergunta_desconhecida` nao tem etapa: fica so no registro de itens.
    if (n === undefined) continue;
    const alvo = porEtapa.get(n);
    if (alvo === undefined) continue;
    if (item.estado === "compativel") alvo.answers[item.pergunta_id] = item.valor;
    else if (item.estado === "incompativel") alvo.incompativeis.push(item.pergunta_id);
    else alvo.ausentes.push(item.pergunta_id);
  }

  // Etapa sem nenhuma resposta compativel nao gera linha: uma linha de
  // `answers: {}` afirmaria que a pessoa respondeu a etapa e nao respondeu nada.
  const etapas = [...porEtapa.values()].filter((e) => Object.keys(e.answers).length > 0);

  const pontuadasQuebradas = mapeada.incompativeisPontuadas.map((i) => i.pergunta_id);
  const apto = pontuadasQuebradas.length === 0;

  return {
    submissao_id: submissao.submissao_id,
    estado: apto ? "importavel" : "incompativel",
    identidade,
    participant_id,
    coleta,
    etapas,
    itens: mapeada.itens,
    apto_para_pontuar: apto,
    bloqueio: apto
      ? null
      : {
          motivo: `DADO INCOMPATIVEL em ${pontuadasQuebradas.length} pergunta(s) que o motor pontua: a resposta existe e a correspondencia com a alternativa declarada falhou. NAO e pontuacao zero e NAO e falta de resposta. Pontuar assim apagaria instrumento em silencio`,
          perguntas: pontuadasQuebradas,
        },
    proveniencia,
    contagens,
  };
}

/**
 * O PORTAO DE PONTUACAO para respostas de origem externa. Tres desfechos, como
 * o resto do projeto: pode pontuar, NAO pode (com motivo), ou nao deu para
 * saber.
 *
 * Existe porque `calcularMarcoZero` nao tem como distinguir, olhando so o mapa
 * de respostas, uma pergunta que ninguem respondeu de uma cuja alternativa foi
 * reescrita: as duas chegam ausentes. Quem pontua resposta importada CONSULTA
 * isto antes.
 */
export function verificarAptidaoParaPontuar(
  submissao: Pick<SubmissaoPlanejada, "estado" | "apto_para_pontuar" | "bloqueio"> | null | undefined,
):
  | { pode: true }
  | { pode: false; codigo: "DADO_INCOMPATIVEL" | "IDENTIDADE_NAO_RESOLVIDA"; motivo: string; perguntas: string[] }
  | { pode: false; codigo: "APTIDAO_INDETERMINADA"; motivo: string; perguntas: string[] } {
  if (submissao === null || submissao === undefined) {
    return {
      pode: false,
      codigo: "APTIDAO_INDETERMINADA",
      motivo:
        "nao ha registro de importacao para estas respostas: nao da para afirmar que a correspondencia com o questionario foi conferida",
      perguntas: [],
    };
  }
  if (submissao.apto_para_pontuar) return { pode: true };
  if (submissao.estado === "pendente" || submissao.estado === "conflito") {
    return {
      pode: false,
      codigo: "IDENTIDADE_NAO_RESOLVIDA",
      motivo: submissao.bloqueio?.motivo ?? "identidade nao resolvida",
      perguntas: [],
    };
  }
  if (submissao.estado === "incompativel") {
    return {
      pode: false,
      codigo: "DADO_INCOMPATIVEL",
      motivo: submissao.bloqueio?.motivo ?? "dado incompativel",
      perguntas: submissao.bloqueio?.perguntas ?? [],
    };
  }
  return {
    pode: false,
    codigo: "APTIDAO_INDETERMINADA",
    motivo: `estado de importacao nao reconhecido: ${JSON.stringify(submissao.estado)}`,
    perguntas: [],
  };
}
