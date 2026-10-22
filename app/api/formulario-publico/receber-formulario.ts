// RECEBE O FORMULARIO PUBLICO E GRAVA, COM A CHAVE DE SERVICO.
//
// ===========================================================================
// POR QUE ESTA ROTA GRAVA SEM SESSAO -- LEIA ANTES DE "CONSERTAR"
// ===========================================================================
// O link publico (/formulario/[eventCode]) existe porque o questionario de
// preparacao vai por WhatsApp para dezenas de adolescentes. Nao ha login, nao ha
// codigo por e-mail, nao ha sessao -- por decisao do dono, e porque o envio de
// e-mail do plano esta bloqueado, o que deixava o fluxo /join inutilizavel.
//
// Sem sessao, o NAVEGADOR nao consegue gravar: as policies de `quiz_responses`
// (002/010) exigem `auth.uid()` dono do participante. Entao a gravacao acontece
// AQUI, no servidor, com `service_role` -- que passa por cima de RLS.
//
// O QUE ISSO CUSTA, DECLARADO SEM MAQUIAGEM: quem tem o codigo do evento pode
// cadastrar um participante e um questionario preenchido nele. Nao ha como ser
// diferente num formulario aberto: a unica prova possivel de identidade seria o
// codigo por e-mail, que e justamente o que foi retirado. O que esta rota NAO
// entrega, e nao pode passar a entregar:
//
//   1. NAO cria conta no Auth, NAO devolve senha, token, cookie ou link de
//      acesso, e NAO abre sessao. Nada na resposta serve de credencial.
//      (A regra que /api/join-event documenta em letras maiusculas continua
//      valendo: digitar um e-mail nao prova que a pessoa e dona dele. Esta rota
//      nao contradiz isso -- ela nao AUTENTICA ninguem, so RECEBE respostas.)
//   2. NAO escreve `participants.user_id`. A linha nasce com `user_id` nulo, que
//      e um estado que o sistema ja conhece e trata: se a pessoa depois provar o
//      e-mail por codigo, /api/entrar/verificar reaproveita exatamente essa
//      linha e a vincula a conta. Preencher `user_id` aqui, sem prova, seria
//      pre-sequestrar a conta dela.
//   3. NAO LE NADA DE VOLTA para quem envia. A resposta e `{ ok: true }` e o id
//      do participante criado. Nunca o conteudo de respostas ja gravadas, nunca
//      a lista de quem se inscreveu, nunca o prognostico. Um formulario de
//      escrita nao pode virar leitor do banco.
//
// ===========================================================================
// A SEGUNDA RESPOSTA NAO APAGA A PRIMEIRA -- E O DEFEITO QUE ESTE ARQUIVO JA TEVE
// ===========================================================================
// Esta rota foi construida com "e-mail repetido SUBSTITUI a resposta anterior".
// Isso era defensavel quando o e-mail era VERIFICADO por codigo: quem reenviava
// era, comprovadamente, a mesma pessoa. Com o e-mail AUTODECLARADO -- digitado,
// nunca provado -- a mesma regra virou outra coisa:
//
//   QUALQUER PESSOA PODERIA APAGAR AS RESPOSTAS DE OUTRA, digitando o e-mail
//   dela. Nao e preciso ma fe: um erro de digitacao basta. Uma adolescente
//   responde 52 perguntas, um colega erra uma letra do e-mail, e as 52 respostas
//   dela deixam de existir -- sem aviso e sem rastro, porque `quiz_responses`
//   NAO tem historico.
//
// Entao a regra agora e esta, e ela nao tem excecao: se o participante daquele
// e-mail JA TEM resposta gravada, esta rota NAO escreve em `quiz_responses` e
// NAO escreve em `participants` (nem o nome, nem o telefone -- renomear a Maria
// porque alguem errou o e-mail dela tambem e dano).
//
// E a segunda resposta NAO e descartada: dado coletado de um adolescente que
// respondeu 52 perguntas nao se joga fora para proteger o primeiro. Ela e
// GRAVADA em `external_submissions` com `estado = 'conflito'` e
// `participant_id` NULO -- que e exatamente o estado que a MESA DE DECISAO DO
// OPERADOR (lib/importacao/decisao-do-operador.ts, ESTADOS_QUE_SE_DECIDEM) lista
// como "espera humano". Nao se inventa mecanismo novo aqui: a mesa existe para
// "duas submissoes para a mesma pessoa, alguem decide qual vale", e esta e
// literalmente essa situacao.
//
// Por que 'conflito' e nao 'pendente': 'pendente' quer dizer "o e-mail nao casou
// com ninguem". Aqui o e-mail CASOU -- com alguem que ja respondeu. O que nao se
// sabe e se as duas submissoes sao da mesma pessoa, e e disso que 'conflito'
// fala.
//
// O QUE A MESA FAZ COM ELA, declarado sem maquiagem: a propria borda da decisao
// RECUSA (IMPORT_TARGET_OCCUPIED) atribuir esta submissao ao participante que ja
// tem resposta propria, e isso e correto -- aplicar gravaria por cima, que e o
// defeito de novo. O operador VE os dois envios, com as duas listas de respostas,
// e decide fora do clique automatico. O que esta rota garante e o que importava:
// a primeira resposta fica intacta, a segunda nao se perde, e ninguem precisa
// descobrir na segunda-feira que o documento nao fala da propria vida.
//
// ===========================================================================
// O E-MAIL DAQUI NUNCA E "VERIFICADO" -- EM NENHUMA COLUNA
// ===========================================================================
// `external_submissions` tem as colunas que descrevem essa qualidade, e esta
// rota as preenche dizendo o FATO:
//   email_verificado = false   (foi DIGITADO, nao provado)
//   identidade_via   = null    (nao e 'email_verificado' nem 'decisao_do_operador')
//   participant_id   = null    (ninguem foi ligado a ninguem aqui)
// E a procedencia de TODO envio publico -- inclusive o caminho feliz -- fica
// registrada em `event_logs`, para que quem olhar na segunda saiba a qualidade
// do dado: 'email_digitado_nao_verificado', nunca "pessoa confirmada".
//
// ===========================================================================
// `event_logs` RECEBE METADADOS, NUNCA CONTEUDO PESSOAL -- E NAO E RESERVA
// ===========================================================================
// Decisao da revisao, literal: "logs operacionais nao podem ser utilizados como
// deposito alternativo de respostas pessoais completas." `event_logs` e um
// registro operacional generico, lido por sete partes do sistema (batch-process,
// jobs/enfileirar, generate-prognostic, entrada-do-guia, a pagina do evento e o
// painel ao vivo, que carrega a linha do tempo no navegador do host). Entao:
//
//   - o que vai para la e `MetadadosDoEnvio` (tipo fechado, abaixo): formulario,
//     qualidade da identidade, contagens, ids internos, fase de uma falha.
//     NUNCA nome, e-mail, telefone ou conteudo de resposta;
//   - ele NAO e reserva de nada. Esta rota ja teve um caminho em que, se a mesa
//     de decisao falhasse, o envio INTEIRO ia para `event_logs` e a tela dizia
//     "guardamos inteiro". Esse caminho foi REMOVIDO. Se o armazenamento proprio
//     (participants/quiz_responses, ou `external_submissions`) nao confirma a
//     gravacao, o desfecho e `gravacao_indisponivel` -- a rota responde 503
//     PUBLIC_FORM_WRITE_UNAVAILABLE, a tela mantem o rascunho e pede para tentar
//     de novo. "Nao consegui gravar" e um fato diferente de "gravei" e de
//     "recusei", e nenhum dos dois pode ser dito no lugar dele.
//
// `quiz_responses.origem` continua 'app', e nao por descuido: o CHECK da 022
// aceita so 'app' e 'externo', e 'externo' EXIGE `external_submission_id`. Dizer
// 'externo' num envio que a pessoa fez nesta aplicacao seria falso, e criar um
// terceiro valor exigiria migration -- que esta entrega nao escreve. A
// procedencia fina mora em `event_logs`, onde cabe sem mentir.
//
// ===========================================================================
// O FORMATO GRAVADO E O MESMO DO FLUXO AUTENTICADO -- ISTO NAO E DETALHE
// ===========================================================================
// O resto do sistema (pontuacao, briefing, documento individual) le
// `quiz_responses` sem saber por onde a resposta entrou. Entao esta rota grava
// EXATAMENTE as mesmas colunas que app/(participant)/quiz/[stageId]/page.tsx:
//
//   participant_id, stage_id, answers        -- uma linha por etapa,
//   upsert com onConflict "participant_id,stage_id"
//
// `answers` e o mapa id da pergunta -> valor, com os mesmos formatos por tipo
// (select/texto -> string, scale -> number, multi_select/ranking -> string[]),
// que e o que `lib/scoring/achatar-respostas.ts` consome.
//
// `questions_snapshot` fica NULO, como no fluxo autenticado (quem le trata nulo
// lendo o enunciado de `quiz_stages`). So o caminho de importacao externa
// (022/024) preenche essa coluna.
//
// E A CONCLUSAO E MARCADA. Sem `participants.completed_at` a pessoa nao entra em
// `batch-process` e nao existe documento para ela na segunda-feira -- ela teria
// respondido 52 perguntas para nada. A conclusao segue a disciplina de
// /api/complete-quiz: NAO se confia no que foi enviado, se CONFERE no banco que
// toda etapa da versao do evento tem linha de resposta, e o UPDATE e condicional
// (`completed_at is null`), entao reenviar nao reescreve o instante original.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { montarManifesto } from "../../../lib/importacao/manifesto-questionario";
import {
  obrigatoriasEmFalta,
  resumoDoQueFalta,
  type FaltaNaEtapa,
  type MapaDeRespostas,
  type ValorDeResposta,
} from "../../../lib/quiz/obrigatorias";
import type { QuizQuestion, QuizStage } from "../../../types/database";

interface ErroDoBanco {
  code?: string;
  message?: string;
}

interface Consulta extends PromiseLike<{ data: unknown; error: ErroDoBanco | null }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: ErroDoBanco | null }>;
}

interface Upsert extends PromiseLike<{ data: unknown; error: ErroDoBanco | null }> {
  select(colunas: string): {
    single(): PromiseLike<{ data: unknown; error: ErroDoBanco | null }>;
  };
}

interface Insercao extends PromiseLike<{ data: unknown; error: ErroDoBanco | null }> {
  select(colunas: string): {
    single(): PromiseLike<{ data: unknown; error: ErroDoBanco | null }>;
  };
}

/**
 * A fatia do cliente Supabase que esta funcao usa. Injetada para que o teste
 * prove o COMPORTAMENTO (ordem das escritas, idempotencia, recusa) sem banco.
 */
export interface ClienteDeRecepcao {
  from(tabela: string): {
    select(colunas: string): Consulta;
    insert(valores: Record<string, unknown>): Insercao;
    upsert(
      valores: Record<string, unknown> | Record<string, unknown>[],
      opcoes: { onConflict: string },
    ): Upsert;
    update(valores: Record<string, unknown>): {
      eq(
        coluna: string,
        valor: string,
      ): { is(coluna: string, valor: null): PromiseLike<{ error: ErroDoBanco | null }> };
    };
  };
}

export interface EntradaDoFormulario {
  eventCode: string;
  fullName: string;
  email: string;
  phone?: string | null;
  /**
   * Mapa PLANO id da pergunta -> valor, das 5 etapas juntas. Os ids sao unicos
   * no questionario inteiro (migration 017), entao nao ha ambiguidade -- e e o
   * mesmo formato que `achatarRespostas` produz do outro lado.
   */
  respostas: MapaDeRespostas;
}

export type ResultadoDaRecepcao =
  | { tipo: "ok"; participantId: string; etapasGravadas: number; concluido: boolean }
  /**
   * Ja havia resposta gravada para este e-mail neste evento. A PRIMEIRA ficou
   * intacta (nada foi escrito em `quiz_responses` nem em `participants`) e esta
   * SEGUNDA foi GRAVADA em `external_submissions`, que a mesa de decisao do
   * operador lista. Este desfecho so existe DEPOIS de o insert na mesa voltar
   * sem erro: `naMesa` e `true` no tipo, porque nao ha outro lugar onde a
   * segunda resposta possa estar. Mesa que falhou e `gravacao_indisponivel`.
   */
  | {
      tipo: "segunda_resposta_guardada";
      etapasJaRespondidas: number;
      naMesa: true;
      submissaoId: string;
    }
  /**
   * O ARMAZENAMENTO PROPRIO NAO CONFIRMOU A GRAVACAO. Nada foi dado como
   * recebido; a pessoa reenvia o mesmo conteudo. `fase` diz onde parou, para o
   * log -- nunca para a tela.
   */
  | { tipo: "gravacao_indisponivel"; fase: FaseDaGravacao; causa: unknown }
  | { tipo: "evento_nao_encontrado" }
  | { tipo: "evento_encerrado" }
  /** Passou de `events.form_closes_at` (prazo rigido, relogio do servidor). */
  | { tipo: "prazo_encerrado" }
  /**
   * Evento assincrono sem prazo legivel. Nao se sabe se o prazo passou, entao
   * nao se recebe e nao se diz que terminou (Rodada 78).
   */
  | { tipo: "prazo_indeterminado" }
  | { tipo: "questionario_indisponivel"; detalhe: string }
  | { tipo: "faltam_obrigatorias"; etapas: FaltaNaEtapa[]; resumo: string }
  | { tipo: "resposta_invalida"; perguntaId: string; etapa: number }
  | { tipo: "erro"; causa: unknown };

/**
 * Onde a gravacao duravel parou. `conferencia` e a releitura de
 * `quiz_responses` depois do upsert: sem ela confirmada nao se pode dizer
 * "gravei", entao ela e fase de gravacao, nao de leitura.
 */
export type FaseDaGravacao =
  | "participante"
  | "respostas"
  | "conferencia"
  | "conclusao"
  | "mesa_de_decisao";

interface LinhaDeEvento {
  id: string;
  status: string;
  quiz_version: number;
  mode?: string | null;
  form_closes_at?: string | null;
}

/**
 * O formulario ainda recebe? Decidido pelo SERVIDOR com o relogio do servidor
 * (Rodada 68 do CTO: "servidor recusa novos envios apos o prazo aprovado").
 * Antes disto so `status = completed` fechava, e isso dependia de alguem
 * lembrar de encerrar o evento no painel a meia-noite de sexta.
 *
 * PRAZO RIGIDO, sem tolerancia (Rodada 69). A tolerancia da migration 010 vale
 * para quem ABRIU uma etapa antes do prazo, e o banco sabe quando abriu. No
 * formulario publico o servidor nao tem prova nenhuma de quando a pessoa
 * comecou -- so o que o navegador dissesse -- e uma tolerancia sem prova seria
 * uma janela aberta para qualquer um comecar depois do prazo. Quem nao enviou a
 * tempo le o motivo, e o rascunho continua no aparelho.
 *
 * `form_closes_at` e o PRIMEIRO instante recusado (Rodada 78). "Aberto ate
 * sexta, 23h59" com o minuto 23h59 inteiro e 2026-10-24T03:00:00Z (meia-noite
 * em Sao Paulo); com 02:59:00Z o minuto 23h59 fica de fora. A escolha do valor
 * e do proprietario; a regra e uma so.
 *
 * Decidido UMA vez, no recebimento: um envio aceito antes do prazo termina de
 * gravar mesmo que a gravacao atravesse o limite. O relogio e o do servidor;
 * o corpo do pedido nao traz horario nenhum.
 *
 * Sem prazo, ou prazo ilegivel: "indeterminado". Quem chama decide: evento
 * assincrono (o Marco Zero) recusa; evento ao vivo segue aberto como antes.
 */
export function prazoDoFormulario(
  fechaEm: string | null | undefined,
  agora: Date,
): "aberto" | "encerrado" | "indeterminado" {
  if (!fechaEm) return "indeterminado";
  const limite = new Date(fechaEm).getTime();
  if (Number.isNaN(limite)) return "indeterminado";
  return agora.getTime() >= limite ? "encerrado" : "aberto";
}

/** Estados em que a coleta acabou por decisao administrativa, prazo a parte. */
const ESTADOS_SEM_COLETA = new Set(["completed", "processing"]);

/** O formulario publico recebe agora? Uma regra so, para a rota e para a pagina. */
export function situacaoDoFormulario(
  evento: { status: string; mode?: string | null; form_closes_at?: string | null },
  agora: Date,
): "aberto" | "evento_encerrado" | "prazo_encerrado" | "prazo_indeterminado" {
  if (ESTADOS_SEM_COLETA.has(evento.status)) return "evento_encerrado";
  const prazo = prazoDoFormulario(evento.form_closes_at, agora);
  if (prazo === "encerrado") return "prazo_encerrado";
  if (prazo === "indeterminado" && evento.mode === "async") return "prazo_indeterminado";
  return "aberto";
}

type LinhaDeEtapa = Pick<QuizStage, "id" | "stage_number" | "title" | "questions">;

/**
 * O valor tem o formato que o tipo da pergunta grava? Esta e a unica barreira
 * contra `answers` com lixo: o motor de pontuacao e ESTRITO de proposito
 * (achatar-respostas.ts LANCA diante de valor presente e ilegivel), entao gravar
 * um numero onde se espera texto nao daria erro agora -- daria erro na
 * segunda-feira, ao gerar o documento, quando ninguem mais pode consertar.
 */
function formatoCompativel(pergunta: QuizQuestion, valor: ValorDeResposta): boolean {
  switch (pergunta.type) {
    case "scale":
      return typeof valor === "number" && Number.isFinite(valor);
    case "multi_select":
    case "ranking":
      return Array.isArray(valor) && valor.every((v) => typeof v === "string");
    case "select":
    case "short_text":
    case "text":
    case "dilemma":
      return typeof valor === "string";
    default:
      // Tipo que esta versao nao conhece: aceita os tres formatos de `answers`.
      return (
        typeof valor === "string" ||
        (typeof valor === "number" && Number.isFinite(valor)) ||
        (Array.isArray(valor) && valor.every((v) => typeof v === "string"))
      );
  }
}

/**
 * A lista de etapas da versao e utilizavel? MESMO criterio do gatilho da
 * migration 028 e de `avaliarEtapas()`: os `stage_number` tem de ser exatamente
 * 1..N, sem nulo, sem repetido e sem buraco. Sem isso nao se sabe quantas etapas
 * o evento tem, e "respondeu tudo" seria verdade vazia.
 */
function avaliarEtapas(etapas: LinhaDeEtapa[]): string | null {
  if (etapas.length === 0) return "a versão do questionário deste evento não tem etapas";
  const numeros = etapas.map((e) => e.stage_number);
  if (numeros.some((n) => n === null || n === undefined)) {
    return "há etapa sem stage_number na versão do questionário deste evento";
  }
  const ordenados = [...(numeros as number[])].sort((a, b) => a - b);
  const esperado = Array.from({ length: etapas.length }, (_, i) => i + 1);
  if (ordenados.join(",") !== esperado.join(",")) {
    return "os números das etapas da versão do questionário deste evento não formam 1..N";
  }
  if (etapas.some((e) => !Array.isArray(e.questions) || e.questions.length === 0)) {
    return "há etapa sem perguntas na versão do questionário deste evento";
  }
  return null;
}

/**
 * NAO HOUVE OPERADOR. `external_submissions.importado_por` e NOT NULL porque
 * toda importacao da 022 e um ato de alguem; um envio do link publico nao e ato
 * de ninguem da equipe. O uuid nulo (e o e-mail abaixo) dizem isso em vez de
 * atribuir o envio a um humano que nao o fez -- que seria pior do que uma coluna
 * estranha: seria auditoria falsa.
 */
const SEM_OPERADOR = "00000000-0000-0000-0000-000000000000";
const SEM_OPERADOR_EMAIL = "formulario-publico (sem operador: ninguem importou)";

/** O `formulario_id` da proveniencia: de onde esta submissao veio. */
const FORMULARIO_PUBLICO = "formulario-publico";
const FORMULARIO_PUBLICO_NOME = "Formulário público (link sem login, e-mail autodeclarado)";

/** A qualidade do dado, numa palavra, igual em todos os registros desta rota. */
const PROCEDENCIA = "email_digitado_nao_verificado";

/**
 * O QUE PODE IR PARA `event_logs`. Tipo FECHADO, de proposito: um literal com
 * qualquer outra chave (nome, e-mail, telefone, respostas) nao compila. So
 * contagens, booleanos, ids internos e nomes fechados de fase/codigo.
 */
export interface MetadadosDoEnvio {
  etapas_gravadas?: number;
  primeira_resposta?: boolean;
  /** Reenvio do MESMO conteudo de quem ja respondeu: nada foi reescrito. */
  reenvio_identico?: boolean;
  /** Id da linha em `external_submissions` (`publico:<uuid>`), nao conteudo. */
  submissao_id?: string;
  etapas_ja_respondidas?: number;
  /** Uuid interno do participante que ja tinha resposta. Nao e nome nem e-mail. */
  participante_com_resposta?: string;
  primeira_resposta_preservada?: boolean;
  na_mesa_de_decisao?: boolean;
  /** Texto FIXO desta rota, igual para todo envio. */
  motivo?: string;
  /** Onde a gravacao parou, quando nao foi confirmada. */
  fase?: FaseDaGravacao;
  /** SQLSTATE/codigo do PostgREST, quando houver. Nunca a mensagem do banco. */
  codigo_do_banco?: string | null;
}

/**
 * A procedencia de UM envio publico, em `event_logs`. SO METADADOS.
 *
 * NAO FALHA O ENVIO. Se o log nao entrar, as respostas ja estao gravadas e
 * devolver erro faria a pessoa reenviar. O que se perde e procedencia; o que se
 * protege e a resposta. E o inverso tambem vale: o log ENTRAR nao faz de nada
 * um envio recebido -- ele nao guarda resposta nenhuma.
 */
async function registrarProcedencia(
  supabase: ClienteDeRecepcao,
  linha: {
    eventId: string;
    participantId: string | null;
    acao: string;
    payload: MetadadosDoEnvio;
  },
): Promise<{ error: ErroDoBanco | null }> {
  try {
    const r = await supabase.from("event_logs").insert({
      event_id: linha.eventId,
      participant_id: linha.participantId,
      action: linha.acao,
      payload: {
        formulario: FORMULARIO_PUBLICO,
        // As tres afirmacoes que o operador precisa para julgar o dado na
        // segunda-feira, escritas na linha e nao deduzidas de ausencia.
        email_verificado: false,
        identidade: PROCEDENCIA,
        identidade_via: null,
        ...linha.payload,
      },
    });
    return { error: r.error ?? null };
  } catch (causa) {
    return { error: { message: String(causa) } };
  }
}

/** O codigo do erro do banco, se houver. NUNCA a mensagem: ela pode citar valores. */
function codigoDoBanco(causa: unknown): string | null {
  if (causa && typeof causa === "object" && "code" in causa) {
    const c = (causa as { code?: unknown }).code;
    return typeof c === "string" ? c : null;
  }
  return null;
}

/**
 * NAO CONSEGUI GRAVAR. Registra o FATO em `event_logs` -- fase e codigo, sem
 * nada da pessoa -- para que um envio perdido nao seja invisivel para a equipe,
 * e devolve o desfecho que a rota traduz em 503. Se ate o log falhar, o desfecho
 * e o mesmo: o log nunca muda o que a pessoa ouve.
 */
async function falhaDeGravacao(
  supabase: ClienteDeRecepcao,
  eventId: string,
  fase: FaseDaGravacao,
  causa: unknown,
  extra: MetadadosDoEnvio = {},
): Promise<ResultadoDaRecepcao> {
  const log = await registrarProcedencia(supabase, {
    eventId,
    participantId: null,
    acao: "formulario_publico_envio_nao_gravado",
    payload: { ...extra, fase, codigo_do_banco: codigoDoBanco(causa) },
  });
  if (log.error) {
    console.error("[formulario-publico] falha de gravacao sem registro em event_logs", {
      fase,
      causa: log.error,
    });
  }
  return { tipo: "gravacao_indisponivel", fase, causa };
}

/** Igualdade de valor JSON, sem depender da ordem das chaves de objeto. */
function mesmoJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => mesmoJson(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join("\u0000") !== kb.join("\u0000")) return false;
    return ka.every((k) =>
      mesmoJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * CONFERE NO BANCO E MARCA A CONCLUSAO. Usada pelo caminho feliz e pelo reenvio
 * identico. Conferida NO BANCO, nunca presumida do que acabou de ser enviado:
 * se uma linha nao entrou, a pessoa NAO e marcada como concluida (melhor
 * aparecer como pendente do que entrar na geracao sem respostas).
 */
async function conferirEConcluir(
  supabase: ClienteDeRecepcao,
  eventId: string,
  participantId: string,
  etapas: LinhaDeEtapa[],
): Promise<ResultadoDaRecepcao | null> {
  const lidas = (await supabase
    .from("quiz_responses")
    .select("stage_id")
    .eq("participant_id", participantId)) as {
    data: { stage_id: number }[] | null;
    error: ErroDoBanco | null;
  };
  if (lidas.error) return falhaDeGravacao(supabase, eventId, "conferencia", lidas.error);
  const respondidas = new Set((lidas.data ?? []).map((r) => r.stage_id));
  const todas = etapas.every((e) => respondidas.has(e.id));

  if (!todas) {
    return falhaDeGravacao(
      supabase,
      eventId,
      "conferencia",
      `respostas gravadas (${respondidas.size}) nao cobrem as ${etapas.length} etapas do evento`,
    );
  }

  // `.is("completed_at", null)` torna o UPDATE condicional: reenviar nao
  // reescreve o instante da primeira conclusao, e dois envios simultaneos nao
  // se atropelam. Mesma disciplina de /api/complete-quiz.
  const fim = await supabase
    .from("participants")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", participantId)
    .is("completed_at", null);
  if (fim.error) return falhaDeGravacao(supabase, eventId, "conclusao", fim.error);
  return null;
}

export async function receberFormulario(
  supabase: ClienteDeRecepcao,
  entrada: EntradaDoFormulario,
  agora: () => Date = () => new Date(),
): Promise<ResultadoDaRecepcao> {
  try {
    // O GoTrue guarda e-mail em minusculas; a mesma forma aqui mantem
    // `participants.email` consistente com `auth.users.email`, para que um
    // retorno futuro por codigo encontre ESTA linha.
    const email = entrada.email.trim().toLowerCase();
    const fullName = entrada.fullName.trim();
    const telefone = entrada.phone?.trim() ? entrada.phone.trim() : null;
    const eventCode = entrada.eventCode.trim().toUpperCase();

    // 1. O EVENTO. Lido pelo codigo, que e o que vem na URL do link.
    const ev = (await supabase
      .from("events")
      .select("id, status, quiz_version, mode, form_closes_at")
      .eq("event_code", eventCode)
      .maybeSingle()) as { data: LinhaDeEvento | null; error: ErroDoBanco | null };
    if (ev.error) return { tipo: "erro", causa: ev.error };
    if (!ev.data) return { tipo: "evento_nao_encontrado" };
    const evento = ev.data;

    // Imersao concluida nao recebe mais resposta -- mesma decisao da pagina
    // /join. `max_participants` NAO e verificado aqui, e isso e deliberado: ver
    // o comentario no topo de route.ts.
    // O relogio e lido UMA vez, aqui, antes de qualquer escrita.
    const situacao = situacaoDoFormulario(evento, agora());
    if (situacao !== "aberto") return { tipo: situacao };

    // 2. AS ETAPAS DA VERSAO DO EVENTO. Nunca uma constante: a v2 tem 5 etapas
    //    com ids 101..105, a v1 tem 6 com ids 1..6.
    const et = (await supabase
      .from("quiz_stages")
      .select("id, stage_number, title, questions")
      .eq("quiz_version", evento.quiz_version)) as {
      data: LinhaDeEtapa[] | null;
      error: ErroDoBanco | null;
    };
    if (et.error) return { tipo: "erro", causa: et.error };
    if (!et.data) return { tipo: "erro", causa: "quiz_stages devolveu vazio" };
    const etapas = [...et.data].sort(
      (a, b) => (a.stage_number ?? a.id) - (b.stage_number ?? b.id),
    );
    const problema = avaliarEtapas(etapas);
    if (problema) return { tipo: "questionario_indisponivel", detalhe: problema };

    // 3. SEPARA AS RESPOSTAS POR ETAPA e confere formato e obrigatoriedade.
    //    Id que nao pertence a nenhuma etapa desta versao e IGNORADO: nao vai
    //    para o banco. `answers` guarda o questionario, nao o que o cliente
    //    quiser mandar.
    const porEtapa: { etapa: LinhaDeEtapa; answers: MapaDeRespostas }[] = [];
    const faltas: FaltaNaEtapa[] = [];

    for (const etapa of etapas) {
      const numero = etapa.stage_number as number;
      const answers: MapaDeRespostas = {};
      for (const pergunta of etapa.questions) {
        const valor = entrada.respostas[pergunta.id];
        if (valor === undefined || valor === null) continue;
        if (!formatoCompativel(pergunta, valor)) {
          return { tipo: "resposta_invalida", perguntaId: pergunta.id, etapa: numero };
        }
        answers[pergunta.id] = valor;
      }
      const faltando = obrigatoriasEmFalta(etapa.questions, answers);
      if (faltando.length > 0) {
        faltas.push({ etapa: numero, titulo: etapa.title, faltando });
      }
      porEtapa.push({ etapa, answers });
    }

    // A recusa vem ANTES de qualquer escrita: um envio incompleto nao deixa
    // participante pela metade no banco.
    if (faltas.length > 0) {
      return { tipo: "faltam_obrigatorias", etapas: faltas, resumo: resumoDoQueFalta(faltas) };
    }

    // 3.5. JA EXISTE RESPOSTA PARA ESTE E-MAIL NESTE EVENTO?
    //
    //      Esta pergunta vem ANTES de qualquer escrita, e e a trava do defeito
    //      descrito no topo. Se a resposta for sim, NADA e sobrescrito: nem as
    //      respostas, nem o nome, nem o telefone do participante que ja esta la.
    //
    //      O criterio e "tem resposta gravada", nao "existe participante". Quem
    //      entrou pelo /join e nunca respondeu nao tem nada a perder, e continua
    //      pelo caminho feliz -- barrar essa pessoa seria impedir que ela
    //      respondesse, sem proteger resposta nenhuma.
    const ja = (await supabase
      .from("participants")
      .select("id, full_name")
      .eq("event_id", evento.id)
      .eq("email", email)
      .maybeSingle()) as {
      data: { id: string; full_name: string | null } | null;
      error: ErroDoBanco | null;
    };
    if (ja.error) return { tipo: "erro", causa: ja.error };

    if (ja.data?.id) {
      const anteriores = (await supabase
        .from("quiz_responses")
        .select("stage_id, answers")
        .eq("participant_id", ja.data.id)) as {
        data: { stage_id: number; answers: unknown }[] | null;
        error: ErroDoBanco | null;
      };
      // Um erro de LEITURA aqui nao autoriza seguir: sem saber se ha resposta
      // anterior, gravar seria apostar as 52 respostas de alguem numa consulta
      // que falhou. Recusa, a pessoa reenvia, a tela continua preenchida.
      if (anteriores.error) return { tipo: "erro", causa: anteriores.error };
      const gravadas = anteriores.data ?? [];
      const etapasJaRespondidas = gravadas.length;

      // 3.6. E O MESMO ENVIO, DE NOVO? O botao "tentar de novo" da tela reenvia
      //      EXATAMENTE o mesmo conteudo. Se a primeira tentativa chegou a gravar
      //      as respostas e caiu depois (na conferencia, na conclusao, ou na
      //      volta pela rede), o reenvio encontraria "ja ha resposta" e iria para
      //      a mesa como se fosse outra pessoa -- e a pessoa ficaria sem
      //      conclusao. O criterio e estrito: mesmo nome E as mesmas respostas em
      //      TODAS as etapas, nenhuma a mais nem a menos. Nesse caso nada e
      //      reescrito (nem `participants`, nem `quiz_responses`): so se confere
      //      e se conclui, com o UPDATE condicional de sempre.
      const mesmoNome =
        (ja.data.full_name ?? "").trim().toLowerCase() === fullName.toLowerCase();
      const mesmasRespostas =
        etapasJaRespondidas === porEtapa.length &&
        porEtapa.every(({ etapa, answers }) => {
          const linha = gravadas.find((g) => g.stage_id === etapa.id);
          return linha !== undefined && mesmoJson(linha.answers, answers);
        });
      if (etapasJaRespondidas > 0 && mesmoNome && mesmasRespostas) {
        const participantId = ja.data.id;
        const falha = await conferirEConcluir(supabase, evento.id, participantId, etapas);
        if (falha) return falha;
        const log = await registrarProcedencia(supabase, {
          eventId: evento.id,
          participantId,
          acao: "formulario_publico_recebido",
          payload: {
            etapas_gravadas: 0,
            primeira_resposta: false,
            reenvio_identico: true,
          },
        });
        if (log.error) {
          console.error("[formulario-publico] procedencia nao registrada", {
            participantId,
            causa: log.error,
          });
        }
        return { tipo: "ok", participantId, etapasGravadas: 0, concluido: true };
      }

      if (etapasJaRespondidas > 0) {
        return await guardarSegundaResposta(supabase, {
          evento,
          etapas,
          email,
          fullName,
          respostas: entrada.respostas,
          participantIdExistente: ja.data.id,
          etapasJaRespondidas,
        });
      }
    }

    // 4. O PARTICIPANTE. `onConflict: "event_id,email"` e a chave unica da
    //    migration 001 (`unique(event_id, email)`): o MESMO e-mail no MESMO
    //    evento volta na MESMA linha, em vez de criar pessoa duplicada ou
    //    estourar 23505.
    //
    //    O payload NAO inclui `user_id` nem `course_or_moment`, de proposito: num
    //    conflito, o PostgREST so sobrescreve as colunas enviadas. Quem entrou
    //    antes pelo fluxo autenticado nao perde o vinculo com a conta nem o que
    //    escreveu naquele campo por ter reenviado o formulario publico.
    const up = (await supabase
      .from("participants")
      .upsert(
        { event_id: evento.id, full_name: fullName, email, phone: telefone },
        { onConflict: "event_id,email" },
      )
      .select("id")
      .single()) as { data: { id: string } | null; error: ErroDoBanco | null };
    if (up.error) return falhaDeGravacao(supabase, evento.id, "participante", up.error);
    if (!up.data?.id) {
      return falhaDeGravacao(supabase, evento.id, "participante", "upsert de participante sem id");
    }
    const participantId = up.data.id;

    // 5. AS RESPOSTAS. Uma linha por etapa, com `onConflict` na chave unica
    //    (participant_id, stage_id) -- exatamente como a tela autenticada, e pela
    //    mesma razao documentada la: sem nomear a constraint o PostgREST infere a
    //    chave primaria e o reenvio viraria erro de duplicidade.
    const linhas = porEtapa.map(({ etapa, answers }) => ({
      participant_id: participantId,
      stage_id: etapa.id,
      answers,
    }));
    const resp = await supabase
      .from("quiz_responses")
      .upsert(linhas, { onConflict: "participant_id,stage_id" });
    if (resp.error) return falhaDeGravacao(supabase, evento.id, "respostas", resp.error);

    // 6. A CONCLUSAO, conferida no banco (ver `conferirEConcluir`).
    const falha = await conferirEConcluir(supabase, evento.id, participantId, etapas);
    if (falha) return falha;

    // 7. A PROCEDENCIA. Nao muda uma virgula do que foi gravado acima -- so
    //    escreve, ao lado, a qualidade do dado: este e-mail foi DIGITADO. Quem
    //    abrir o evento na segunda consegue separar "provou o e-mail" de
    //    "digitou o e-mail" sem adivinhar pela ausencia de `user_id`.
    const log = await registrarProcedencia(supabase, {
      eventId: evento.id,
      participantId,
      acao: "formulario_publico_recebido",
      // SO METADADOS: nome e e-mail ja estao em `participants`, que e o lugar
      // deles. Repeti-los aqui os espalharia por uma tabela que sete partes do
      // sistema leem.
      payload: {
        etapas_gravadas: linhas.length,
        primeira_resposta: true,
      },
    });
    if (log.error) {
      console.error("[formulario-publico] procedencia nao registrada", {
        participantId,
        causa: log.error,
      });
    }

    return {
      tipo: "ok",
      participantId,
      etapasGravadas: linhas.length,
      concluido: true,
    };
  } catch (causa) {
    return { tipo: "erro", causa };
  }
}

/**
 * GUARDA A SEGUNDA RESPOSTA, sem tocar na primeira.
 *
 * Nenhuma escrita desta funcao chega perto de `quiz_responses` ou de
 * `participants`: ela so ACRESCENTA. A ordem e deliberada:
 *
 *   1. `external_submissions` com `estado = 'conflito'` e `participant_id` nulo
 *      -- a linha que a MESA DE DECISAO lista como "espera humano". E o UNICO
 *      lugar onde a segunda resposta e gravada;
 *   2. `event_logs`, so METADADOS (id da submissao, contagens), para que o fato
 *      ("houve dois envios com este e-mail") apareca na linha do tempo.
 *
 * Se a (1) falhar -- tabela ausente, impressao do questionario nao montavel,
 * banco fora --, o desfecho e `gravacao_indisponivel`: a rota responde 503, a
 * tela mantem o rascunho e pede para tentar de novo. NAO ha reserva em
 * `event_logs` para o conteudo (ver o topo do arquivo): o log de falha diz so a
 * fase e o codigo, e nunca faz a tela dizer "guardamos".
 */
async function guardarSegundaResposta(
  supabase: ClienteDeRecepcao,
  dados: {
    evento: LinhaDeEvento;
    etapas: LinhaDeEtapa[];
    email: string;
    fullName: string;
    respostas: MapaDeRespostas;
    participantIdExistente: string;
    etapasJaRespondidas: number;
  },
): Promise<ResultadoDaRecepcao> {
  const { evento, etapas, email, fullName, respostas, etapasJaRespondidas } = dados;
  const metadados: MetadadosDoEnvio = {
    etapas_ja_respondidas: etapasJaRespondidas,
    participante_com_resposta: dados.participantIdExistente,
    primeira_resposta_preservada: true,
  };

  // O identificador desta submissao na proveniencia. A chave natural da 022 e
  // (event_id, formulario_id, submissao_id): um id novo por envio e o que faz
  // DOIS envios equivocados virarem DUAS linhas, em vez de a segunda sobrescrever
  // a primeira -- o mesmo defeito, um nivel acima.
  const submissaoId = `publico:${randomUUID()}`;

  const motivo =
    "já existe resposta gravada para este e-mail neste evento, e o e-mail do formulário público é autodeclarado: não há como afirmar que os dois envios são da mesma pessoa. A primeira resposta NÃO foi sobrescrita; esta segunda espera decisão humana.";

  const bloqueio = {
    motivo,
    codigo: "SEGUNDA_RESPOSTA_MESMO_EMAIL",
    procedencia: PROCEDENCIA,
    email_verificado: false,
    etapas_ja_respondidas: etapasJaRespondidas,
    // O participante que JA tinha resposta. Fica no bloqueio, e NAO em
    // `participant_id`: a coluna significa "esta submissao e desta pessoa", e e
    // precisamente o que ninguem verificou. O CHECK da 022 tambem exigiria o
    // estado 'importavel' se ela fosse preenchida.
    participante_com_resposta: dados.participantIdExistente,
  };

  // A impressao digital do questionario respondido. Sem ela a linha nao entra
  // (o CHECK exige SHA-256), e com ela a mesa consegue dizer, daqui a um mes, a
  // que versao do questionario esta pessoa respondeu.
  const manifesto = montarManifesto(etapas, evento.quiz_version);
  if (!manifesto.ok) {
    return falhaDeGravacao(
      supabase,
      evento.id,
      "mesa_de_decisao",
      `${manifesto.codigo}: ${manifesto.motivo}`,
      { ...metadados, submissao_id: submissaoId, na_mesa_de_decisao: false },
    );
  }

  let erroDaMesa: unknown = null;
  try {
    const ins = await supabase.from("external_submissions").insert({
      event_id: evento.id,
      formulario_id: FORMULARIO_PUBLICO,
      formulario_nome: FORMULARIO_PUBLICO_NOME,
      submissao_id: submissaoId,
      quiz_version: evento.quiz_version,
      questionario_impressao: manifesto.manifesto.impressao,
      email_coletado: email,
      // O FATO, nao a conveniencia: ninguem verificou este e-mail.
      email_verificado: false,
      nome_declarado: fullName,
      respostas_brutas: respostas,
      participant_id: null,
      identidade_via: null,
      email_reconciliado: null,
      estado: "conflito",
      apto_para_pontuar: false,
      bloqueio,
      importado_por: SEM_OPERADOR,
      importado_por_email: SEM_OPERADOR_EMAIL,
    });
    if (ins.error) erroDaMesa = ins.error;
  } catch (causa) {
    erroDaMesa = causa ?? "insert na mesa lancou";
  }

  if (erroDaMesa !== null) {
    // A mesa nao confirmou. Nao ha outro lugar onde esta resposta possa ficar:
    // a primeira continua intacta (nada foi escrito), e a pessoa reenvia.
    return falhaDeGravacao(supabase, evento.id, "mesa_de_decisao", erroDaMesa, {
      ...metadados,
      submissao_id: submissaoId,
      na_mesa_de_decisao: false,
    });
  }

  const log = await registrarProcedencia(supabase, {
    eventId: evento.id,
    // O participante existente NAO e apontado aqui como autor deste envio: ele
    // e o dono da PRIMEIRA resposta, e dizer que esta e dele seria afirmar a
    // identidade que ninguem verificou.
    participantId: null,
    acao: "formulario_publico_segunda_resposta",
    payload: {
      ...metadados,
      submissao_id: submissaoId,
      na_mesa_de_decisao: true,
      motivo,
    },
  });
  if (log.error) {
    console.error("[formulario-publico] segunda resposta sem registro em event_logs", {
      submissaoId,
      causa: log.error,
    });
  }

  return { tipo: "segunda_resposta_guardada", etapasJaRespondidas, naMesa: true, submissaoId };
}
