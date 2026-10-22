// A BORDA DA REGULARIZACAO DA SEGUNDA RESPOSTA DO FORMULARIO PUBLICO: tudo o que
// as rotas de regularizar, desconsiderar e confirmar destinatario decidem, SEM
// Next. A ultima palavra e do banco (migration 029); esta borda existe para o
// operador LER o caso antes de decidir, e para recusar cedo o que o banco
// recusaria tarde.
//
// O CASO
// ------
// O formulario publico recebe e-mail AUTODECLARADO. Quando chega uma segunda
// resposta com um e-mail que ja tem resposta gravada, ela NAO sobrescreve: vai
// inteira para `external_submissions` em 'conflito', sem participante, com o
// bloqueio SEGUNDA_RESPOSTA_MESMO_EMAIL (app/api/formulario-publico/
// receber-formulario.ts). O caso mais provavel e DUAS PESSOAS DIFERENTES: uma
// digitou o e-mail da outra. A mesa generica (decisao-do-operador.ts) recusa,
// corretamente, ligar a submissao a quem ja tem resposta -- e nao havia outra
// saida. Esta borda e a saida, em dois caminhos:
//
//   REGULARIZAR -- a organizacao confirma, por FONTE INDEPENDENTE do formulario,
//     quem e a pessoa; a submissao e ligada ao cadastro dela (se existe e nao tem
//     resposta) ou a um cadastro novo (so se NAO existe correspondente no
//     evento). As respostas entram pela importacao atomica (022/024).
//   DESCONSIDERAR -- a organizacao confirma que a PRIMEIRA e a valida; a segunda
//     sai da fila e fica preservada, imutavel, como registro historico.
//
// (A terceira saida -- a mesma pessoa querendo que a segunda SUBSTITUA a
// primeira -- NAO existe aqui de proposito: exige nova versao de respostas
// canonicas e invalidacao de documentos. Fica para correcao controlada futura.)
//
// A REGRA CENTRAL, da revisao, literal
// ------------------------------------
// "A declaracao do operador registra a conferencia. Ela nao pode ser confundida
// com a prova de que a conferencia realmente aconteceu." Entao:
//   - a FONTE e vocabulario fechado (FONTES_ACEITAS), nunca texto livre;
//   - a REFERENCIA tem de identificar a conferencia: "identidade conferida", ou
//     so o nome/e-mail que o proprio formulario trouxe, e RECUSADO
//     (`substanciaDaReferencia`, espelho de `regularizacao_substancia` na 029);
//   - nada promove o e-mail a verificado: `identidade_via` fica
//     'decisao_do_operador' e `email_verificado` fica false, e o banco PROIBE o
//     contrario por gatilho;
//   - IDENTIDADE CONFIRMADA e DESTINATARIO CONFIRMADO sao dois fatos, em dois
//     livros. O primeiro autoriza ligar as respostas e gerar o documento; so o
//     segundo autoriza ENTREGAR -- e o banco recusa a entrega sem ele.
//
// A EVIDENCIA PODE MORAR FORA DO SISTEMA
// --------------------------------------
// A lista oficial de convidados (`event_people`, 020) existe mas, medido, esta
// vazia e nao ha tela que a carregue. Exigir que a pessoa esteja nela tornaria
// a regularizacao impossivel -- e o jovem ficaria sem documento de novo. Entao:
// se a pessoa ESTA em `event_people`, ela aparece como evidencia na ficha (melhor
// caso) e o operador pode aponta-la; se NAO esta, a fonte e a lista/contato que
// a organizacao mantem fora daqui, declarada em vocabulario fechado e com
// referencia auditavel. A busca que IMPEDE duplicata e em `participants`.

import { createHash } from "node:crypto";
import type { CodigoDeErro, DetalhesDeErro } from "../erros/codigos";
import { indicaEsquemaAusente, type ErroRpcCru } from "../erros/falha-de-fila";
import type { ManifestoQuestionario } from "./manifesto-questionario";
import type { OperadorDaImportacao } from "./planejar-importacao";
import { lerContextoDoEvento, type ClienteDeLeitura, type ContextoDoEvento, type PlanoAceito } from "./borda";
import {
  CAMPOS_PROIBIDOS_NO_CORPO,
  lerDerivadosDosParticipantes,
  planoDaDecisao,
  SEM_DERIVADOS,
  type ClienteDeConsulta,
  type DerivadosDoParticipante,
  type LinhaDeSubmissao,
} from "./decisao-do-operador";
import { normalizarEmail } from "./reconciliar-identidade";

// ===========================================================================
// 1. O VOCABULARIO
// ===========================================================================

export const FORMULARIO_PUBLICO = "formulario-publico";
export const CODIGO_DA_SEGUNDA_RESPOSTA = "SEGUNDA_RESPOSTA_MESMO_EMAIL";

/**
 * AS TRES FONTES ACEITAS como fundamento da confirmacao de identidade. O mesmo
 * vocabulario do CHECK da 029. Nome/e-mail do proprio formulario, grupo de
 * WhatsApp e "identidade conferida" NAO estao aqui, e nao e esquecimento.
 */
export const FONTES_ACEITAS = {
  lista_oficial_previa: "Lista oficial preparada pela organização antes da coleta",
  confirmacao_presencial: "Confirmação presencial por responsável do evento",
  contato_previamente_conhecido: "Confirmação pelo responsável usando contato previamente conhecido",
} as const;
export type FonteAceita = keyof typeof FONTES_ACEITAS;

/**
 * Os canais que confirmam o DESTINATARIO (quem controla o endereco). A lista
 * oficial nao entra: ela diz quem pertence ao evento, nao quem le aquele e-mail.
 */
export const CANAIS_DO_DESTINATARIO = {
  confirmacao_presencial: "Confirmado pessoalmente com a pessoa, por responsável do evento",
  contato_previamente_conhecido: "Confirmado pelo responsável por contato previamente conhecido",
} as const;
export type CanalDoDestinatario = keyof typeof CANAIS_DO_DESTINATARIO;

export const MINIMO_DA_REFERENCIA = 20;
export const MINIMO_DA_SUBSTANCIA = 15;
export const MINIMO_DO_MOTIVO = 20;

const CARIMBO = new Set([
  "identidade", "conferida", "conferido", "confirmada", "confirmado", "verificada",
  "verificado", "checada", "checado", "validada", "validado", "ok", "okay", "sim",
  "pelo", "pela", "operador", "operadora", "foi", "esta", "e", "a", "o", "as", "os",
  "de", "da", "do", "das", "dos", "com", "ja", "tudo", "certo", "pessoa", "mesma",
  "aluno", "aluna", "jovem", "participante", "email", "e-mail", "nome", "formulario",
]);

function dobrar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * O que a referencia diz ALEM de carimbo e alem do nome/e-mail que a propria
 * submissao trouxe. ESPELHO de `public.regularizacao_substancia` (029): o banco
 * e quem decide; isto existe para a tela recusar antes de mandar.
 */
export function substanciaDaReferencia(texto: string, email: string | null, nome: string | null): string {
  let v = dobrar(texto.trim());
  const e = (email ?? "").trim().toLowerCase();
  if (e !== "") v = v.split(e).join(" ");
  v = v.replace(/[^a-z0-9]+/g, " ");
  const tokensDoNome = new Set(dobrar(nome ?? "").replace(/[^a-z0-9]+/g, " ").split(" "));
  return v
    .trim()
    .split(" ")
    .filter((w) => w !== "" && !CARIMBO.has(w) && !tokensDoNome.has(w))
    .join(" ");
}

export function referenciaSuficiente(texto: string, email: string | null, nome: string | null): boolean {
  return (
    texto.trim().length >= MINIMO_DA_REFERENCIA &&
    substanciaDaReferencia(texto, email, nome).length >= MINIMO_DA_SUBSTANCIA
  );
}

/** Nome comparavel: minusculas, sem acento, espacos colapsados. */
export function nomeComparavel(nome: string): string {
  return dobrar(nome).replace(/\s+/g, " ").trim();
}

// ===========================================================================
// 2. OS PEDIDOS
// ===========================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPRESSAO_HEX = /^[0-9a-f]{64}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type DestinoDaRegularizacao =
  | { tipo: "vincular"; participant_id: string }
  | { tipo: "criar"; nome: string; email: string; telefone: string | null };

export interface PedidoDeRegularizacao {
  event_id: string;
  submission_id: string;
  caso_impressao: string;
  destino: DestinoDaRegularizacao;
  convidado_id: string | null;
  fonte_tipo: FonteAceita;
  referencia: string;
  motivo: string;
}

export interface PedidoDeDesconsideracao {
  event_id: string;
  submission_id: string;
  caso_impressao: string;
  fonte_tipo: FonteAceita;
  referencia: string;
  motivo: string;
}

export interface PedidoDeDestinatario {
  event_id: string;
  participant_id: string;
  canal_tipo: CanalDoDestinatario;
  referencia: string;
  email_destinatario: string;
}

export type LeituraDoPedido<T> =
  | { ok: true; pedido: T }
  | { ok: false; codigo: Extract<CodigoDeErro, "INVALID_REQUEST">; motivo: string };

function recusa<T>(motivo: string): LeituraDoPedido<T> {
  return { ok: false, codigo: "INVALID_REQUEST", motivo };
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * O que os tres pedidos tem em comum: objeto, sem campo de operador, e um
 * event_id. O operador e a SESSAO verificada; quem pede nao escolhe quem decidiu.
 */
function comum(bruto: unknown): { ok: true; o: Record<string, unknown>; event_id: string } | { ok: false; motivo: string } {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "o corpo do pedido nao e um objeto JSON" };
  }
  const o = bruto as Record<string, unknown>;
  for (const proibido of [...CAMPOS_PROIBIDOS_NO_CORPO, "email_verificado", "identidade_via"]) {
    if (o[proibido] !== undefined) {
      return {
        ok: false,
        motivo: `o corpo traz \`${proibido}\`: o responsavel pela decisao e a sessao verificada, e a qualidade do e-mail nao e escolhida por quem pede`,
      };
    }
  }
  const event_id = texto(o.event_id);
  if (!UUID.test(event_id)) return { ok: false, motivo: "`event_id` ausente ou nao e um UUID" };
  return { ok: true, o, event_id };
}

function lerFonte(o: Record<string, unknown>): FonteAceita | null {
  const f = texto(o.fonte_tipo);
  return Object.prototype.hasOwnProperty.call(FONTES_ACEITAS, f) ? (f as FonteAceita) : null;
}

function lerFundamento(
  o: Record<string, unknown>,
): { ok: true; fonte_tipo: FonteAceita; referencia: string; motivo: string; caso_impressao: string; submission_id: string } | { ok: false; motivo: string } {
  const submission_id = texto(o.submission_id);
  if (!UUID.test(submission_id)) return { ok: false, motivo: "`submission_id` ausente ou nao e um UUID" };
  const caso = texto(o.caso_impressao);
  if (!IMPRESSAO_HEX.test(caso)) {
    return {
      ok: false,
      motivo: "`caso_impressao` ausente ou nao e um SHA-256: sem ela nao da para afirmar que o caso conferido e o que seria gravado",
    };
  }
  const fonte = lerFonte(o);
  if (fonte === null) {
    return {
      ok: false,
      motivo: `\`fonte_tipo\` fora do vocabulario: aceitas ${Object.keys(FONTES_ACEITAS).join(", ")}. Nome e e-mail do proprio formulario, grupo de WhatsApp ou "identidade conferida" nao sao fonte`,
    };
  }
  const referencia = texto(o.referencia);
  if (referencia.length < MINIMO_DA_REFERENCIA || referencia.length > 500) {
    return {
      ok: false,
      motivo: `\`referencia\` ausente, curta (minimo ${MINIMO_DA_REFERENCIA}) ou longa demais: ela identifica a conferencia para quem auditar`,
    };
  }
  const motivo = texto(o.motivo);
  if (motivo.length < MINIMO_DO_MOTIVO || motivo.length > 2000) {
    return { ok: false, motivo: `\`motivo\` ausente ou curto (minimo ${MINIMO_DO_MOTIVO}): explique a divergencia deste caso` };
  }
  return { ok: true, fonte_tipo: fonte, referencia, motivo, caso_impressao: caso.toLowerCase(), submission_id };
}

export function lerPedidoDeRegularizacao(bruto: unknown): LeituraDoPedido<PedidoDeRegularizacao> {
  const c = comum(bruto);
  if (!c.ok) return recusa(c.motivo);
  const f = lerFundamento(c.o);
  if (!f.ok) return recusa(f.motivo);

  const d = c.o.destino;
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    return recusa("`destino` ausente: diga se vincula a um cadastro existente ou cria um cadastro");
  }
  const dd = d as Record<string, unknown>;
  let destino: DestinoDaRegularizacao;
  if (dd.tipo === "vincular") {
    const pid = texto(dd.participant_id);
    if (!UUID.test(pid)) return recusa("`destino.participant_id` ausente ou nao e um UUID");
    destino = { tipo: "vincular", participant_id: pid };
  } else if (dd.tipo === "criar") {
    const nome = texto(dd.nome).replace(/\s+/g, " ");
    const email = texto(dd.email).toLowerCase();
    if (nome.length < 3 || nome.length > 200) return recusa("`destino.nome` ausente ou invalido");
    if (!EMAIL.test(email) || email.length > 320) return recusa("`destino.email` ausente ou invalido");
    const tel = texto(dd.telefone);
    destino = { tipo: "criar", nome, email, telefone: tel === "" ? null : tel.slice(0, 40) };
  } else {
    return recusa("`destino.tipo` tem de ser `vincular` ou `criar`");
  }

  const conv = c.o.convidado_id;
  let convidado_id: string | null = null;
  if (conv !== undefined && conv !== null && conv !== "") {
    if (!UUID.test(texto(conv))) return recusa("`convidado_id` nao e um UUID");
    convidado_id = texto(conv);
  }

  return {
    ok: true,
    pedido: {
      event_id: c.event_id,
      submission_id: f.submission_id,
      caso_impressao: f.caso_impressao,
      destino,
      convidado_id,
      fonte_tipo: f.fonte_tipo,
      referencia: f.referencia,
      motivo: f.motivo,
    },
  };
}

export function lerPedidoDeDesconsideracao(bruto: unknown): LeituraDoPedido<PedidoDeDesconsideracao> {
  const c = comum(bruto);
  if (!c.ok) return recusa(c.motivo);
  if (c.o.destino !== undefined || c.o.participant_id !== undefined) {
    return recusa("desconsiderar nao liga a submissao a ninguem: o corpo nao leva `destino` nem `participant_id`");
  }
  const f = lerFundamento(c.o);
  if (!f.ok) return recusa(f.motivo);
  return {
    ok: true,
    pedido: {
      event_id: c.event_id,
      submission_id: f.submission_id,
      caso_impressao: f.caso_impressao,
      fonte_tipo: f.fonte_tipo,
      referencia: f.referencia,
      motivo: f.motivo,
    },
  };
}

export function lerPedidoDeDestinatario(bruto: unknown): LeituraDoPedido<PedidoDeDestinatario> {
  const c = comum(bruto);
  if (!c.ok) return recusa(c.motivo);
  const pid = texto(c.o.participant_id);
  if (!UUID.test(pid)) return recusa("`participant_id` ausente ou nao e um UUID");
  const canal = texto(c.o.canal_tipo);
  if (!Object.prototype.hasOwnProperty.call(CANAIS_DO_DESTINATARIO, canal)) {
    return recusa(`\`canal_tipo\` fora do vocabulario: aceitos ${Object.keys(CANAIS_DO_DESTINATARIO).join(", ")}`);
  }
  const referencia = texto(c.o.referencia);
  if (referencia.length < MINIMO_DA_REFERENCIA || referencia.length > 500) {
    return recusa(`\`referencia\` ausente ou curta (minimo ${MINIMO_DA_REFERENCIA})`);
  }
  const email = texto(c.o.email_destinatario).toLowerCase();
  if (!EMAIL.test(email)) return recusa("`email_destinatario` ausente ou invalido");
  return {
    ok: true,
    pedido: {
      event_id: c.event_id,
      participant_id: pid,
      canal_tipo: canal as CanalDoDestinatario,
      referencia,
      email_destinatario: email,
    },
  };
}

// ===========================================================================
// 3. O CASO: o que o operador ve ANTES de decidir
// ===========================================================================

export interface ConvidadoDaLista {
  id: string;
  nome: string;
  email: string | null;
  participant_id: string | null;
  origem: string;
}

export interface CandidatoAoVinculo {
  id: string;
  nome: string;
  email: string;
  respostas_canonicas: number;
  submissao_externa_ativa: string | null;
  documento: boolean;
  e_o_dono_da_primeira: boolean;
  /** A linha da lista oficial NO SISTEMA ligada a este cadastro, se houver. */
  convidado: ConvidadoDaLista | null;
  /** 0..1: quanto o nome do cadastro se parece com o nome declarado na submissao. */
  semelhanca_do_nome: number;
  vinculavel: boolean;
  /** Por que NAO da para vincular, nomeado. `null` quando da. */
  impedimento: string | null;
}

export interface CasoDeSegundaResposta {
  submissao: {
    id: string;
    submissao_id: string;
    email_digitado: string | null;
    /** Sempre false aqui, e nada nesta borda o muda. */
    email_verificado: false;
    nome_declarado: string | null;
    respostas_coletadas: number;
    recebida_em: string | null;
    /** O instante que o banco confere: a decisao so vale sobre ESTA versao da linha. */
    atualizado_em: string;
    quiz_version: number;
  };
  /** POR QUE o conflito existe, nas palavras gravadas na recepcao. */
  porque: { codigo: string; texto: string; etapas_ja_respondidas: number | null };
  /** O dono da PRIMEIRA resposta, que fica intacta em qualquer decisao desta tela. */
  primeira: { participant_id: string; nome: string; email: string; respostas_canonicas: number } | null;
  resultado: "pendente";
  candidatos: CandidatoAoVinculo[];
  /** Convidados da lista oficial NO SISTEMA que ainda nao tem cadastro de participante. */
  convidados_sem_cadastro: ConvidadoDaLista[];
  /** Quantas pessoas a lista oficial tem DENTRO do sistema. Zero e o caso medido hoje. */
  lista_oficial_no_sistema: number;
  /** O que a regularizacao gravaria, do MESMO planejador da importacao. */
  consequencia: { etapas_a_gravar: number; itens_a_registrar: number; apto_para_pontuar: boolean } | null;
  efeitos: { vincular: string; criar: string; desconsiderar: string };
  procedencia: string;
  impressao_do_caso: string;
}

/** Quem foi regularizado e ainda espera o SEGUNDO fato (destinatario). */
export interface AguardandoDestinatario {
  participant_id: string;
  nome: string;
  email_do_cadastro: string;
  regularizado_em: string;
  fonte_tipo: string;
  destinatario_confirmado: boolean;
}

export interface MesaDaRegularizacao {
  evento_id: string;
  casos: CasoDeSegundaResposta[];
  desconsideradas: { id: string; submissao_id: string; email_digitado: string | null; nome_declarado: string | null }[];
  aguardando_destinatario: AguardandoDestinatario[];
}

interface LinhaComTempo extends LinhaDeSubmissao {
  atualizado_em: string;
  criado_em: string | null;
}

function similaridade(a: string, b: string): number {
  const ta = new Set(nomeComparavel(a).split(" ").filter((x) => x.length > 1));
  const tb = new Set(nomeComparavel(b).split(" ").filter((x) => x.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let comuns = 0;
  for (const t of ta) if (tb.has(t)) comuns += 1;
  return Math.round((comuns / Math.max(ta.size, tb.size)) * 100) / 100;
}

export function impressaoDoCaso(caso: Omit<CasoDeSegundaResposta, "impressao_do_caso">): string {
  return createHash("sha256").update(JSON.stringify(caso), "utf8").digest("hex");
}

/** Id fixo e nulo so para MEDIR a consequencia: o plano nao depende de quem recebe. */
const ALVO_DE_MEDIDA = "00000000-0000-4000-8000-000000000000";

export function ehSegundaResposta(s: Pick<LinhaDeSubmissao, "formulario_id" | "bloqueio">): boolean {
  return (
    s.formulario_id === FORMULARIO_PUBLICO &&
    (s.bloqueio as { codigo?: unknown } | null)?.codigo === CODIGO_DA_SEGUNDA_RESPOSTA
  );
}

export function montarCaso(
  contexto: ContextoDoEvento,
  manifesto: ManifestoQuestionario,
  s: LinhaComTempo,
  ativas: ReadonlyMap<string, string>,
  derivados: ReadonlyMap<string, DerivadosDoParticipante>,
  convidados: readonly ConvidadoDaLista[],
  operador: OperadorDaImportacao,
): CasoDeSegundaResposta {
  const bloqueio = (s.bloqueio ?? {}) as Record<string, unknown>;
  const primeiraId = typeof bloqueio.participante_com_resposta === "string" ? bloqueio.participante_com_resposta : null;
  const p1 = primeiraId === null ? undefined : contexto.participantes.find((p) => p.id === primeiraId);
  const convidadoDe = new Map(convidados.filter((c) => c.participant_id !== null).map((c) => [c.participant_id as string, c]));

  const candidatos: CandidatoAoVinculo[] = contexto.participantes
    .map((p) => {
      const respostas = p.respostas_existentes ?? 0;
      const ativa = ativas.get(p.id) ?? null;
      const doc = (derivados.get(p.id) ?? SEM_DERIVADOS).documento;
      const ehPrimeira = p.id === primeiraId;
      const impedimento = ehPrimeira
        ? "é o dono da PRIMEIRA resposta: ligar a segunda a ele escreveria por cima do que ele respondeu"
        : respostas > 0
          ? `já tem ${respostas} resposta(s) gravada(s): vincular sobrescreveria, e isso não se faz`
          : ativa !== null
            ? `já tem a submissão externa ${ativa} ligada a ele`
            : doc
              ? "já tem documento gerado: vincular faria o documento não corresponder às respostas"
              : null;
      return {
        id: p.id,
        nome: p.full_name,
        email: p.email,
        respostas_canonicas: respostas,
        submissao_externa_ativa: ativa,
        documento: doc,
        e_o_dono_da_primeira: ehPrimeira,
        convidado: convidadoDe.get(p.id) ?? null,
        semelhanca_do_nome: similaridade(s.nome_declarado ?? "", p.full_name),
        vinculavel: impedimento === null,
        impedimento,
      };
    })
    .sort(
      (a, b) =>
        Number(b.vinculavel) - Number(a.vinculavel) ||
        b.semelhanca_do_nome - a.semelhanca_do_nome ||
        a.nome.localeCompare(b.nome),
    );

  const linha: LinhaDeSubmissao = s;
  const plano = planoDaDecisao(contexto, manifesto, linha, ALVO_DE_MEDIDA, "medida da consequencia (sem efeito)", operador);
  const consequencia = plano.ok
    ? {
        etapas_a_gravar: plano.decidida.etapas.length,
        itens_a_registrar: plano.decidida.itens.length,
        apto_para_pontuar: plano.decidida.apto_para_pontuar,
      }
    : null;

  const nomeP1 = p1?.full_name ?? "o dono da primeira resposta";
  const semCaso: Omit<CasoDeSegundaResposta, "impressao_do_caso"> = {
    submissao: {
      id: s.id,
      submissao_id: s.submissao_id,
      email_digitado: s.email_coletado,
      email_verificado: false,
      nome_declarado: s.nome_declarado,
      respostas_coletadas: Object.keys(s.respostas_brutas).length,
      recebida_em: s.criado_em,
      atualizado_em: s.atualizado_em,
      quiz_version: s.quiz_version,
    },
    porque: {
      codigo: CODIGO_DA_SEGUNDA_RESPOSTA,
      texto:
        typeof bloqueio.motivo === "string"
          ? bloqueio.motivo
          : "já existe resposta gravada para este e-mail neste evento, e o e-mail do formulário público é autodeclarado",
      etapas_ja_respondidas: typeof bloqueio.etapas_ja_respondidas === "number" ? bloqueio.etapas_ja_respondidas : null,
    },
    primeira:
      p1 === undefined
        ? null
        : { participant_id: p1.id, nome: p1.full_name, email: p1.email, respostas_canonicas: p1.respostas_existentes ?? 0 },
    resultado: "pendente",
    candidatos,
    convidados_sem_cadastro: convidados.filter((c) => c.participant_id === null),
    lista_oficial_no_sistema: convidados.length,
    consequencia,
    efeitos: {
      vincular:
        consequencia === null
          ? "Não dá para afirmar o que seria gravado (o questionário desta coleta não confere com o do sistema): a regularização não é oferecida."
          : `Liga esta submissão ao cadastro escolhido e grava ${consequencia.etapas_a_gravar} etapa(s) de resposta para ele, pela importação atômica. ${nomeP1} fica intacto. A identidade passa a valer por DECISÃO da organização, não por verificação; o e-mail digitado continua NÃO verificado. O documento pode ser gerado, mas a ENTREGA fica bloqueada até o destinatário ser confirmado por canal independente.`,
      criar:
        consequencia === null
          ? "Não dá para afirmar o que seria gravado: a criação não é oferecida."
          : `Cria um cadastro NOVO neste evento (sem conta de acesso, sem e-mail verificado) e grava ${consequencia.etapas_a_gravar} etapa(s) nele. Só é aceito se não houver, no evento, cadastro com o mesmo e-mail ou o mesmo nome. ${nomeP1} fica intacto. Entrega bloqueada até confirmar o destinatário.`,
      desconsiderar: `Encerra o conflito: a resposta de ${nomeP1} fica como está, e esta segunda submissão sai da fila e fica PRESERVADA (as respostas, o e-mail digitado, o nome), imutável, como registro restrito a administradores. Nada é apagado.`,
    },
    procedencia:
      "e-mail DIGITADO no formulário público, nunca verificado. Nenhuma decisão desta tela o marca como verificado.",
  };
  return { ...semCaso, impressao_do_caso: impressaoDoCaso(semCaso) };
}

// ===========================================================================
// 4. A LEITURA
// ===========================================================================

export type FalhaDaRegularizacao = { codigo: CodigoDeErro; motivo: string; detalhes?: DetalhesDeErro };

export type PreparacaoDaRegularizacao =
  | {
      ok: true;
      mesa: MesaDaRegularizacao;
      contexto: ContextoDoEvento;
      manifesto: ManifestoQuestionario;
      linhas: LinhaComTempo[];
    }
  | ({ ok: false } & FalhaDaRegularizacao);

type Resposta = { data: unknown; error: unknown };

async function ler(cliente: ClienteDeConsulta, tabela: string, colunas: string, eventId: string): Promise<Resposta> {
  try {
    return await (cliente.from(tabela).select(colunas).eq("event_id", eventId) as PromiseLike<Resposta>);
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}

function falha(erro: unknown, oQue: string): { ok: false } & FalhaDaRegularizacao {
  const cru = (erro ?? null) as ErroRpcCru | null;
  return {
    ok: false,
    codigo: indicaEsquemaAusente(cru) ? "IMPORT_SCHEMA_MISSING" : "IMPORT_UNAVAILABLE",
    motivo: `falha ao ler ${oQue}: ${cru?.message ?? "sem detalhe"}`,
  };
}

const COLUNAS = [
  "id", "submissao_id", "formulario_id", "formulario_nome", "estado", "email_coletado",
  "email_verificado", "nome_declarado", "respostas_brutas", "participant_id", "identidade_via",
  "quiz_version", "questionario_impressao", "bloqueio", "atualizado_em", "criado_em",
].join(", ");

export async function prepararRegularizacao(
  cliente: ClienteDeConsulta & ClienteDeLeitura,
  eventId: string,
  operador: OperadorDaImportacao,
): Promise<PreparacaoDaRegularizacao> {
  const ctx = await lerContextoDoEvento(cliente, eventId);
  if (!ctx.ok) return { ok: false, codigo: ctx.codigo, motivo: ctx.motivo };

  const subs = await ler(cliente, "external_submissions", COLUNAS, eventId);
  if (subs.error || !Array.isArray(subs.data)) return falha(subs.error, "as submissoes externas do evento");
  const linhas: LinhaComTempo[] = (subs.data as Record<string, unknown>[]).map((r) => ({
    id: String(r.id ?? ""),
    submissao_id: String(r.submissao_id ?? ""),
    formulario_id: String(r.formulario_id ?? ""),
    formulario_nome: typeof r.formulario_nome === "string" ? r.formulario_nome : null,
    estado: String(r.estado ?? "") as LinhaDeSubmissao["estado"],
    email_coletado: typeof r.email_coletado === "string" ? r.email_coletado : null,
    email_verificado: r.email_verificado === true,
    nome_declarado: typeof r.nome_declarado === "string" ? r.nome_declarado : null,
    respostas_brutas:
      r.respostas_brutas !== null && typeof r.respostas_brutas === "object" && !Array.isArray(r.respostas_brutas)
        ? (r.respostas_brutas as Record<string, unknown>)
        : {},
    participant_id: typeof r.participant_id === "string" ? r.participant_id : null,
    identidade_via:
      r.identidade_via === "email_verificado" || r.identidade_via === "decisao_do_operador" ? r.identidade_via : null,
    quiz_version: Number(r.quiz_version ?? 0),
    questionario_impressao: String(r.questionario_impressao ?? ""),
    bloqueio:
      r.bloqueio !== null && typeof r.bloqueio === "object" && !Array.isArray(r.bloqueio)
        ? (r.bloqueio as LinhaDeSubmissao["bloqueio"])
        : null,
    atualizado_em: String(r.atualizado_em ?? ""),
    criado_em: typeof r.criado_em === "string" ? r.criado_em : null,
  }));

  const conv = await ler(cliente, "event_people", "id, full_name, email, participant_id, origem", eventId);
  if (conv.error || !Array.isArray(conv.data)) return falha(conv.error, "a lista oficial de convidados do evento");
  const convidados: ConvidadoDaLista[] = (conv.data as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    nome: String(c.full_name ?? ""),
    email: typeof c.email === "string" ? c.email : null,
    participant_id: typeof c.participant_id === "string" ? c.participant_id : null,
    origem: String(c.origem ?? ""),
  }));

  const derivados = await lerDerivadosDosParticipantes(
    cliente,
    ctx.contexto.participantes.map((p) => p.id),
  );
  if (!derivados.ok) return { ok: false, codigo: derivados.codigo, motivo: derivados.motivo };

  const livro = await ler(
    cliente,
    "external_identity_resolutions",
    "pessoa_participant_id, ato, resultado, fonte_tipo, criado_em",
    eventId,
  );
  if (livro.error || !Array.isArray(livro.data)) return falha(livro.error, "o livro da regularizacao (migration 029)");
  const dest = await ler(cliente, "external_recipient_confirmations", "participant_id, email_destinatario", eventId);
  if (dest.error || !Array.isArray(dest.data)) return falha(dest.error, "as confirmacoes de destinatario (migration 029)");

  const ativas = new Map<string, string>();
  for (const s of linhas) {
    if (s.participant_id !== null && (s.estado === "importavel" || s.estado === "incompativel")) {
      ativas.set(s.participant_id, s.submissao_id);
    }
  }

  const casos = linhas
    .filter((s) => s.estado === "conflito" && ehSegundaResposta(s))
    .sort((a, b) => (a.criado_em ?? "").localeCompare(b.criado_em ?? ""))
    .map((s) => montarCaso(ctx.contexto, ctx.manifesto, s, ativas, derivados.derivados, convidados, operador));

  const confirmados = new Set(
    (dest.data as Record<string, unknown>[]).map((d) => `${String(d.participant_id)}|${String(d.email_destinatario)}`),
  );
  const aguardando: AguardandoDestinatario[] = [];
  for (const r of livro.data as Record<string, unknown>[]) {
    if (r.resultado !== "confirmado" || (r.ato !== "regularizar_vinculo" && r.ato !== "regularizar_criacao")) continue;
    const p = ctx.contexto.participantes.find((x) => x.id === r.pessoa_participant_id);
    if (p === undefined) continue;
    aguardando.push({
      participant_id: p.id,
      nome: p.full_name,
      email_do_cadastro: p.email,
      regularizado_em: String(r.criado_em ?? ""),
      fonte_tipo: String(r.fonte_tipo ?? ""),
      destinatario_confirmado: confirmados.has(`${p.id}|${(normalizarEmail(p.email) ?? "")}`),
    });
  }

  return {
    ok: true,
    mesa: {
      evento_id: ctx.contexto.evento.id,
      casos,
      desconsideradas: linhas
        .filter((s) => s.estado === "desconsiderada")
        .map((s) => ({ id: s.id, submissao_id: s.submissao_id, email_digitado: s.email_coletado, nome_declarado: s.nome_declarado })),
      aguardando_destinatario: aguardando,
    },
    contexto: ctx.contexto,
    manifesto: ctx.manifesto,
    linhas,
  };
}

// ===========================================================================
// 5. CONFERENCIAS ANTES DE ESCREVER (o banco confere de novo)
// ===========================================================================

export type Conferencia<T> = { ok: true; valor: T } | ({ ok: false } & FalhaDaRegularizacao);

export function acharCaso(
  prep: Extract<PreparacaoDaRegularizacao, { ok: true }>,
  submissionId: string,
  impressao: string,
  ato: "regularizar" | "desconsiderar",
): Conferencia<{ caso: CasoDeSegundaResposta; linha: LinhaComTempo }> {
  const linha = prep.linhas.find((s) => s.id === submissionId);
  if (linha === undefined) {
    return { ok: false, codigo: "IMPORT_SUBMISSION_NOT_FOUND", motivo: `a submissao ${submissionId} nao e deste evento` };
  }
  // Depois de regularizada, a linha perde o bloqueio original (a aplicacao do
  // plano o substitui): ela continua sendo do formulario publico, e o fato a
  // dizer e "ja decidida", nao "fora do escopo".
  if (linha.formulario_id !== FORMULARIO_PUBLICO || (linha.estado === "conflito" && !ehSegundaResposta(linha))) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo: "esta submissao nao e uma segunda resposta do formulario publico: ela se resolve na mesa generica",
      detalhes: { ato, fato_do_banco: "fora_do_escopo" },
    };
  }
  const caso = prep.mesa.casos.find((c) => c.submissao.id === submissionId);
  if (caso === undefined) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_STALE",
      motivo: `a submissao ${linha.submissao_id} ja foi decidida (estado ${linha.estado})`,
      detalhes: { ato, fato_do_banco: "submissao_ja_decidida" },
    };
  }
  if (caso.impressao_do_caso !== impressao) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_STALE",
      motivo: `o caso conferido (${impressao.slice(0, 16)}...) nao e o caso atual (${caso.impressao_do_caso.slice(0, 16)}...)`,
      detalhes: { ato, fato_do_banco: "caso_mudou" },
    };
  }
  return { ok: true, valor: { caso, linha } };
}

export function conferirReferencia(
  caso: CasoDeSegundaResposta,
  referencia: string,
  ato: "regularizar" | "desconsiderar",
): Conferencia<null> {
  if (!referenciaSuficiente(referencia, caso.submissao.email_digitado, caso.submissao.nome_declarado)) {
    return {
      ok: false,
      codigo: "IMPORT_DECISION_REFUSED",
      motivo:
        'a referencia nao identifica conferencia nenhuma: diga qual lista e qual linha, quem confirmou presencialmente e quando, ou qual contato previamente conhecido foi usado. "Identidade conferida", ou o nome/e-mail do proprio formulario, nao e referencia',
      detalhes: { ato, fato_do_banco: "referencia_sem_substancia" },
    };
  }
  return { ok: true, valor: null };
}

/** A conferencia do destino, ANTES de escrever. O banco faz de novo, sob trava. */
export function conferirDestino(
  prep: Extract<PreparacaoDaRegularizacao, { ok: true }>,
  caso: CasoDeSegundaResposta,
  pedido: PedidoDeRegularizacao,
): Conferencia<null> {
  const recusar = (codigo: CodigoDeErro, fato: string, motivo: string): Conferencia<null> => ({
    ok: false,
    codigo,
    motivo,
    detalhes: { ato: "regularizar", fato_do_banco: fato },
  });

  if (caso.consequencia === null) {
    return recusar("IMPORT_MANIFEST_MISMATCH", "plano_nao_corresponde", "nao da para afirmar o que seria gravado");
  }

  const convidado =
    pedido.convidado_id === null
      ? null
      : caso.convidados_sem_cadastro.find((c) => c.id === pedido.convidado_id) ??
        caso.candidatos.map((c) => c.convidado).find((c) => c?.id === pedido.convidado_id) ??
        null;
  if (pedido.convidado_id !== null && convidado === null) {
    return recusar("IMPORT_DECISION_REFUSED", "convidado_inexistente", "o convidado apontado nao esta na lista oficial deste evento");
  }

  if (pedido.destino.tipo === "vincular") {
    const pid = pedido.destino.participant_id;
    const alvo = caso.candidatos.find((c) => c.id === pid);
    if (alvo === undefined) {
      return recusar("IMPORT_DECISION_REFUSED", "alvo_de_outro_evento", "o cadastro escolhido nao e deste evento");
    }
    if (!alvo.vinculavel) {
      const fato = alvo.e_o_dono_da_primeira
        ? "alvo_e_o_dono_da_primeira"
        : alvo.respostas_canonicas > 0
          ? "alvo_tem_respostas"
          : alvo.submissao_externa_ativa !== null
            ? "alvo_tem_submissao_ativa"
            : "alvo_tem_documento";
      const codigo: CodigoDeErro =
        fato === "alvo_tem_respostas" || fato === "alvo_tem_submissao_ativa" || fato === "alvo_e_o_dono_da_primeira"
          ? "IMPORT_TARGET_OCCUPIED"
          : "IMPORT_DECISION_REFUSED";
      return recusar(codigo, fato, alvo.impedimento ?? "cadastro nao vinculavel");
    }
    if (convidado !== null && convidado.participant_id !== null && convidado.participant_id !== pid) {
      return recusar("IMPORT_DECISION_REFUSED", "convidado_de_outra_pessoa", "o convidado apontado ja esta ligado a outro cadastro");
    }
    if (convidado?.email && normalizarEmail(convidado.email) !== normalizarEmail(alvo.email)) {
      return recusar("IMPORT_DECISION_REFUSED", "convidado_com_outro_email", "o convidado apontado tem outro e-mail na lista oficial");
    }
    return { ok: true, valor: null };
  }

  // CRIAR: so quando NAO existe cadastro correspondente no evento. Procura-se
  // SEMPRE primeiro nos participantes ja cadastrados -- por e-mail e por nome
  // (sem acento, sem caixa). Achou? Nao se cria: vincula-se, ou desconsidera-se.
  const email = pedido.destino.email;
  if (email === normalizarEmail(caso.submissao.email_digitado)) {
    return recusar(
      "IMPORT_DECISION_REFUSED",
      "email_e_o_digitado",
      "o e-mail do novo cadastro e o mesmo que foi digitado, que ja pertence ao dono da primeira resposta: isso nao e outra pessoa",
    );
  }
  const porEmail = prep.contexto.participantes.find((p) => normalizarEmail(p.email) === email);
  if (porEmail !== undefined) {
    return recusar(
      "IMPORT_DECISION_REFUSED",
      "email_ja_cadastrado",
      `ja existe cadastro neste evento com este e-mail (${porEmail.full_name}): nao se cria uma segunda pessoa para contornar o conflito`,
    );
  }
  const nome = nomeComparavel(pedido.destino.nome);
  const porNome = prep.contexto.participantes.find((p) => nomeComparavel(p.full_name) === nome);
  if (porNome !== undefined) {
    return recusar(
      "IMPORT_DECISION_REFUSED",
      "nome_ja_cadastrado",
      `ja existe cadastro neste evento com este nome (${porNome.full_name}): se e a mesma pessoa, vincule a ele`,
    );
  }
  if (convidado !== null && convidado.participant_id !== null) {
    return recusar("IMPORT_DECISION_REFUSED", "convidado_de_outra_pessoa", "o convidado apontado ja tem cadastro");
  }
  if (convidado?.email && normalizarEmail(convidado.email) !== email) {
    return recusar("IMPORT_DECISION_REFUSED", "convidado_com_outro_email", "o convidado apontado tem outro e-mail na lista oficial");
  }
  return { ok: true, valor: null };
}

/**
 * O plano que vai para o banco: o MESMO planejador da decisao do operador
 * (`planoDaDecisao`), com uma correcao de verdade na proveniencia -- o
 * `email_reconciliado` sai NULO. Numa regularizacao, o e-mail digitado e o de
 * OUTRA pessoa (e por isso houve conflito): grava-lo como "e-mail pelo qual esta
 * identidade foi reconciliada" seria afirmar o oposto do que aconteceu. O banco
 * confere todo o resto do plano contra a submissao preservada.
 */
export function planoDaRegularizacao(
  prep: Extract<PreparacaoDaRegularizacao, { ok: true }>,
  linha: LinhaDeSubmissao,
  participantId: string,
  motivo: string,
  operador: OperadorDaImportacao,
): { ok: true; plano: PlanoAceito } | ({ ok: false } & FalhaDaRegularizacao) {
  const p = planoDaDecisao(prep.contexto, prep.manifesto, linha, participantId, motivo, operador);
  if (!p.ok) {
    return { ok: false, codigo: "IMPORT_PLAN_REFUSED", motivo: p.motivo, detalhes: { ato: "regularizar" } };
  }
  const plano = JSON.parse(JSON.stringify(p.plano)) as PlanoAceito & {
    submissoes: { proveniencia?: Record<string, unknown> }[];
  };
  for (const s of plano.submissoes) {
    if (s.proveniencia) s.proveniencia.email_reconciliado = null;
  }
  return { ok: true, plano };
}

// ===========================================================================
// 6. AS TRES ESCRITAS: uma chamada ao banco cada, e o banco decide
// ===========================================================================

export interface ClienteDeRpc {
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: ErroRpcCru | null }>;
}

export const FUNCAO_REGULARIZAR = "formulario_publico_regularizar";
export const FUNCAO_DESCONSIDERAR = "formulario_publico_desconsiderar";
export const FUNCAO_DESTINATARIO = "formulario_publico_confirmar_destinatario";

export type Escrita = { ok: true; resumo: Record<string, unknown> } | ({ ok: false } & FalhaDaRegularizacao);

/** "REGULARIZACAO_RECUSADA:<codigo>" ou "DESTINATARIO_RECUSADO:<codigo>" -> o codigo. */
export function codigoDaRecusaNoTexto(mensagem: string | undefined): string | null {
  const m = /(?:REGULARIZACAO_RECUSADA|DESTINATARIO_RECUSADO):([a-z_]+)/.exec(mensagem ?? "");
  return m ? m[1] : null;
}

const RECUSA_DE_OCUPACAO = new Set(["alvo_tem_respostas", "alvo_tem_submissao_ativa", "alvo_e_o_dono_da_primeira"]);
const RECUSA_DE_TEMPO = new Set(["submissao_ja_decidida", "submissao_mudou"]);

async function chamar(
  cliente: ClienteDeRpc,
  nome: string,
  args: Record<string, unknown>,
  ato: "regularizar" | "desconsiderar" | "confirmar_destinatario",
): Promise<Escrita> {
  let r: { data: unknown; error: ErroRpcCru | null };
  try {
    r = await cliente.rpc(nome, args);
  } catch (e) {
    return { ok: false, codigo: "IMPORT_UNAVAILABLE", motivo: `excecao ao gravar: ${e instanceof Error ? e.name : typeof e}` };
  }
  if (r.error) {
    const fato = codigoDaRecusaNoTexto(r.error.message);
    if (fato !== null) {
      // CONFERIDO E RECUSADO no banco, antes de escrever qualquer coisa.
      return {
        ok: false,
        codigo: fato === "submissao_inexistente" ? "IMPORT_SUBMISSION_NOT_FOUND" : "IMPORT_DECISION_REFUSED",
        motivo: r.error.message ?? fato,
        detalhes: { ato, fato_do_banco: fato },
      };
    }
    if (indicaEsquemaAusente(r.error)) {
      return { ok: false, codigo: "IMPORT_SCHEMA_MISSING", motivo: r.error.message ?? "funcao ausente (migration 029)" };
    }
    return { ok: false, codigo: "IMPORT_UNAVAILABLE", motivo: r.error.message ?? "falha ao gravar" };
  }
  const d = r.data as Record<string, unknown> | null;
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, codigo: "IMPORT_WRITE_UNVERIFIABLE", motivo: "o banco respondeu sem resumo: nao da para afirmar o que foi gravado" };
  }
  if (d.ok === true) return { ok: true, resumo: d };
  const fato = typeof d.codigo === "string" ? d.codigo : "desconhecido";
  return {
    ok: false,
    codigo: RECUSA_DE_OCUPACAO.has(fato)
      ? "IMPORT_TARGET_OCCUPIED"
      : RECUSA_DE_TEMPO.has(fato)
        ? "IMPORT_DECISION_STALE"
        : fato === "recusada_na_revalidacao"
          ? "IMPORT_REVALIDATION_REFUSED"
          : "IMPORT_DECISION_REFUSED",
    motivo: `o banco recusou (${fato}); a recusa ficou registrada no livro da regularizacao e nada mais foi gravado`,
    detalhes: { ato, fato_do_banco: fato },
  };
}

export function gravarRegularizacao(
  cliente: ClienteDeRpc,
  e: {
    linha: LinhaComTempo;
    pedido: PedidoDeRegularizacao;
    participantId: string;
    plano: PlanoAceito;
    operador: OperadorDaImportacao;
  },
): Promise<Escrita> {
  const criar = e.pedido.destino.tipo === "criar" ? e.pedido.destino : null;
  return chamar(
    cliente,
    FUNCAO_REGULARIZAR,
    {
      p_submission_id: e.linha.id,
      p_atualizado_em_visto: e.linha.atualizado_em,
      p_operador: e.operador.id,
      p_operador_email: e.operador.email ?? null,
      p_modo: e.pedido.destino.tipo,
      p_participant_id: e.participantId,
      p_novo_nome: criar?.nome ?? null,
      p_novo_email: criar?.email ?? null,
      p_novo_telefone: criar?.telefone ?? null,
      p_convidado_id: e.pedido.convidado_id,
      p_fonte_tipo: e.pedido.fonte_tipo,
      p_referencia: e.pedido.referencia,
      p_motivo: e.pedido.motivo,
      p_plano: e.plano,
    },
    "regularizar",
  );
}

export function gravarDesconsideracao(
  cliente: ClienteDeRpc,
  e: { linha: LinhaComTempo; pedido: PedidoDeDesconsideracao; operador: OperadorDaImportacao },
): Promise<Escrita> {
  return chamar(
    cliente,
    FUNCAO_DESCONSIDERAR,
    {
      p_submission_id: e.linha.id,
      p_atualizado_em_visto: e.linha.atualizado_em,
      p_operador: e.operador.id,
      p_operador_email: e.operador.email ?? null,
      p_fonte_tipo: e.pedido.fonte_tipo,
      p_referencia: e.pedido.referencia,
      p_motivo: e.pedido.motivo,
    },
    "desconsiderar",
  );
}

export function gravarDestinatario(
  cliente: ClienteDeRpc,
  e: { pedido: PedidoDeDestinatario; operador: OperadorDaImportacao },
): Promise<Escrita> {
  return chamar(
    cliente,
    FUNCAO_DESTINATARIO,
    {
      p_participant_id: e.pedido.participant_id,
      p_operador: e.operador.id,
      p_operador_email: e.operador.email ?? null,
      p_canal_tipo: e.pedido.canal_tipo,
      p_referencia: e.pedido.referencia,
      p_email_destinatario: e.pedido.email_destinatario,
    },
    "confirmar_destinatario",
  );
}
