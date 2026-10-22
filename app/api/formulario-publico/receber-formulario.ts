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
//      escrita nao pode virar leitor do banco: e por isso que o reenvio com
//      e-mail repetido SOBRESCREVE em silencio em vez de responder "este e-mail
//      ja respondeu" -- essa frase transformaria o link publico num oraculo de
//      quem participou.
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

/**
 * A fatia do cliente Supabase que esta funcao usa. Injetada para que o teste
 * prove o COMPORTAMENTO (ordem das escritas, idempotencia, recusa) sem banco.
 */
export interface ClienteDeRecepcao {
  from(tabela: string): {
    select(colunas: string): Consulta;
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
  | { tipo: "evento_nao_encontrado" }
  | { tipo: "evento_encerrado" }
  | { tipo: "questionario_indisponivel"; detalhe: string }
  | { tipo: "faltam_obrigatorias"; etapas: FaltaNaEtapa[]; resumo: string }
  | { tipo: "resposta_invalida"; perguntaId: string; etapa: number }
  | { tipo: "erro"; causa: unknown };

interface LinhaDeEvento {
  id: string;
  status: string;
  quiz_version: number;
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

export async function receberFormulario(
  supabase: ClienteDeRecepcao,
  entrada: EntradaDoFormulario,
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
      .select("id, status, quiz_version")
      .eq("event_code", eventCode)
      .maybeSingle()) as { data: LinhaDeEvento | null; error: ErroDoBanco | null };
    if (ev.error) return { tipo: "erro", causa: ev.error };
    if (!ev.data) return { tipo: "evento_nao_encontrado" };
    const evento = ev.data;

    // Imersao concluida nao recebe mais resposta -- mesma decisao da pagina
    // /join. `max_participants` NAO e verificado aqui, e isso e deliberado: ver
    // o comentario no topo de route.ts.
    if (evento.status === "completed") return { tipo: "evento_encerrado" };

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
    if (up.error) return { tipo: "erro", causa: up.error };
    if (!up.data?.id) return { tipo: "erro", causa: "upsert de participante sem id" };
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
    if (resp.error) return { tipo: "erro", causa: resp.error };

    // 6. A CONCLUSAO. Conferida NO BANCO, nunca presumida do que acabou de ser
    //    enviado: se uma linha nao entrou, a pessoa NAO e marcada como concluida
    //    (melhor aparecer como pendente do que entrar na geracao sem respostas).
    const lidas = (await supabase
      .from("quiz_responses")
      .select("stage_id")
      .eq("participant_id", participantId)) as {
      data: { stage_id: number }[] | null;
      error: ErroDoBanco | null;
    };
    if (lidas.error) return { tipo: "erro", causa: lidas.error };
    const respondidas = new Set((lidas.data ?? []).map((r) => r.stage_id));
    const todas = etapas.every((e) => respondidas.has(e.id));

    if (!todas) {
      return {
        tipo: "erro",
        causa: `respostas gravadas (${respondidas.size}) nao cobrem as ${etapas.length} etapas do evento`,
      };
    }

    // `.is("completed_at", null)` torna o UPDATE condicional: reenviar nao
    // reescreve o instante da primeira conclusao, e dois envios simultaneos nao
    // se atropelam. Mesma disciplina de /api/complete-quiz.
    const fim = await supabase
      .from("participants")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", participantId)
      .is("completed_at", null);
    if (fim.error) return { tipo: "erro", causa: fim.error };

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
