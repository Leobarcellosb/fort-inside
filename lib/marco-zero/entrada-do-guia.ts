// DO BANCO PARA O CANAL ESTREITO: a camada que le o evento e monta a
// `EntradaGuia` do Guia de Preparacao do Facilitador.
//
// POR QUE ELA EXISTE SEPARADA DA ROTA. `components/features/marco-zero/
// guia-facilitador-modelo.ts` e funcao PURA: sem I/O, sem relogio, sem banco. A
// pureza e o que sustenta o hash do conteudo e o canal estreito de oito
// contagens. Dar um cliente de banco ao gerador do guia destruiria as duas
// coisas. Entao o banco e lido AQUI, e o gerador recebe:
//
//   - as oito contagens, derivadas por `projetarParticipacao` da lista de
//     participantes (quem esteve presente, quem respondeu, em que estado);
//   - o veredito do GATE DE VOLUME, traduzido da linha oficial de
//     `public.marco_zero_cobertura` por `gateDeVolumeDaCoberturaOficial()`;
//   - o veredito do ESTADO DE PUBLICACAO do DNA, traduzido do registro de
//     disponibilizacao por `publicacaoDoDnaDoRegistro()`.
//
// Os dois vereditos sao INJETADOS, calculados aqui, e sao campos OBRIGATORIOS
// nos tipos de entrada: o compilador cobra a decisao de cada chamador e nao
// existe valor-padrao que signifique "aprovado" ou "nao publicado".
//
// AS TRES CATEGORIAS, em todas as leituras deste arquivo: "verifiquei e o fato e
// X", "verifiquei e o fato NAO e X" e "NAO consegui verificar". A terceira nunca
// vira a segunda. Em particular, falha ao ler o registro de disponibilizacao do
// DNA NAO vira "nao ha DNA publicado": vira indeterminacao, e a indeterminacao
// RECUSA o guia.
//
// ONDE MORA O ESTADO DE PUBLICACAO DO DNA -- e o que falta no banco.
// -------------------------------------------------------------------
// O banco de hoje NAO tem tabela do documento coletivo: nem o modelo, nem a
// revisao metodologica (parecer, revisor, data, hash), nem a data de
// disponibilizacao. O que ele tem, da migration 020, sao os sinais de
// CADUCIDADE: `event_checkin_closures.invalidado_em`, a tabela
// `event_dna_invalidations` e, prontos para ler, os campos
// `aprovacao_invalidada` e `invalidacoes_pendentes` da linha de
// `marco_zero_cobertura`.
//
// Esta unidade NAO cria migration (restricao declarada do escopo). O fato
// "houve revisao aprovada e o documento foi disponibilizado" e lido do unico
// lugar que existe e que e por evento: `public.event_logs`, o registro de atos
// do evento que esta aplicacao ja usa (`jobs_enfileirados` e os demais). Duas
// acoes, nomeadas aqui para que QUEM construir a publicacao do DNA grave
// exatamente estas:
//
//   dna_coletivo_disponibilizado  -> o documento foi liberado para conducao;
//   dna_coletivo_revogado         -> a disponibilizacao foi retirada.
//
// Vale o ultimo ato registrado. Ler a tabela com sucesso e nao encontrar ato
// algum e "verifiquei e NAO ha disponibilizacao" -- hoje isso e verdade por
// construcao, porque nenhum caminho da aplicacao publica DNA Coletivo. No dia em
// que esse caminho existir, ele TEM de gravar a acao acima; caso contrario esta
// leitura passara a responder "nao publicado" para um evento publicado. Isso
// esta declarado no relatorio da unidade como o que ainda falta no banco.
//
// O que NAO e usado para decidir: o `payload` dessas linhas. Linha de log e
// dado, nao instrucao -- so o nome da acao, comparado contra o conjunto fechado
// acima, entra na decisao.

import { calcularMarcoZero } from "../scoring/marco-zero";
import { achatarRespostas, type LinhaDeRespostas } from "../scoring/achatar-respostas";
import type { CodigoDeErro } from "../erros/codigos";
import type { ParticipanteDna } from "../../components/features/marco-zero/dna-coletivo-agregacao";
import {
  gateDeVolumeDaCoberturaOficial,
  type LinhaCoberturaOficial,
} from "../../components/features/marco-zero/dna-coletivo-modelo";
import {
  publicacaoDoDnaDoRegistro,
  type EntradaGuia,
  type PublicacaoDoDna,
} from "../../components/features/marco-zero/guia-facilitador-modelo";

export const ACAO_DNA_DISPONIBILIZADO = "dna_coletivo_disponibilizado";
export const ACAO_DNA_REVOGADO = "dna_coletivo_revogado";

/** Conjunto FECHADO de atos que mudam o estado de publicacao do DNA. */
export const ACOES_DE_PUBLICACAO_DO_DNA: readonly string[] = [
  ACAO_DNA_DISPONIBILIZADO,
  ACAO_DNA_REVOGADO,
];

// ---------------------------------------------------------------------------
// O pouco do cliente do banco que esta camada usa
// ---------------------------------------------------------------------------

export interface RespostaDeLeitura {
  data: unknown;
  error: unknown;
}

export interface ConsultaDoGuia extends PromiseLike<RespostaDeLeitura> {
  eq(coluna: string, valor: string | number): ConsultaDoGuia;
  in(coluna: string, valores: readonly (string | number)[]): ConsultaDoGuia;
  maybeSingle(): PromiseLike<RespostaDeLeitura>;
}

export interface ClienteDoGuia {
  from(tabela: string): { select(colunas: string): ConsultaDoGuia };
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<RespostaDeLeitura>;
}

export type PreparoDoGuia =
  | { ok: false; codigo: CodigoDeErro; causa?: unknown }
  | {
      ok: true;
      entrada: EntradaGuia;
      /** Para o log do servidor: de onde saiu o veredito de publicacao. */
      publicacao: PublicacaoDoDna;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ehUuid(valor: unknown): valor is string {
  return typeof valor === "string" && UUID.test(valor);
}

function linhas(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

// ---------------------------------------------------------------------------
// Estado de publicacao do DNA
// ---------------------------------------------------------------------------

/**
 * Le o ultimo ato de publicacao registrado para o evento e o cruza com os
 * sinais de caducidade da linha de cobertura. Devolve o VEREDITO.
 *
 * `cobertura` e `null` quando a linha oficial nao veio: nesse caso, se houver
 * disponibilizacao registrada, nao se sabe se ela caducou -- indeterminacao.
 */
export async function lerPublicacaoDoDna(
  supabase: ClienteDoGuia,
  eventId: string,
  cobertura: LinhaDeCobertura | null,
): Promise<PublicacaoDoDna> {
  const { data, error } = await supabase
    .from("event_logs")
    .select("action, created_at")
    .eq("event_id", eventId)
    .in("action", ACOES_DE_PUBLICACAO_DO_DNA);

  // Leitura que falhou NAO e ausencia de registro.
  if (error) return publicacaoDoDnaDoRegistro(null);
  if (!Array.isArray(data)) return publicacaoDoDnaDoRegistro(null);

  let ultimo: { acao: string; quando: number } | null = null;
  for (const l of linhas(data)) {
    const acao = l.action;
    if (typeof acao !== "string" || !ACOES_DE_PUBLICACAO_DO_DNA.includes(acao)) continue;
    const bruto = l.created_at;
    const quando = typeof bruto === "string" ? Date.parse(bruto) : Number.NaN;
    // Ato registrado sem instante utilizavel: nao da para saber qual e o ultimo.
    if (Number.isNaN(quando)) {
      return { estado: "indeterminado", motivo: "registro_ilegivel" };
    }
    if (ultimo === null || quando >= ultimo.quando) ultimo = { acao, quando };
  }

  const liberado = ultimo !== null && ultimo.acao === ACAO_DNA_DISPONIBILIZADO;
  return publicacaoDoDnaDoRegistro({
    liberado,
    aprovacaoInvalidada: cobertura?.aprovacao_invalidada ?? null,
    invalidacoesPendentes: cobertura?.invalidacoes_pendentes ?? null,
  });
}

// ---------------------------------------------------------------------------
// A linha oficial de cobertura
// ---------------------------------------------------------------------------

/** O subconjunto de `public.marco_zero_cobertura` que esta camada consome. */
export interface LinhaDeCobertura extends LinhaCoberturaOficial {
  checkin_fechado: boolean | null;
  convidados: number | null;
  aprovacao_invalidada: boolean | null;
  invalidacoes_pendentes: number | null;
}

/** `null` quando a consulta nao respondeu. Nunca uma linha inventada. */
export async function lerCobertura(
  supabase: ClienteDoGuia,
  eventId: string,
): Promise<{ linha: LinhaDeCobertura | null; erro: unknown }> {
  let resposta: RespostaDeLeitura;
  try {
    resposta = await supabase.rpc("marco_zero_cobertura", { p_event_id: eventId });
  } catch (e) {
    return { linha: null, erro: e };
  }
  if (resposta.error) return { linha: null, erro: resposta.error };
  const bruto = Array.isArray(resposta.data) ? resposta.data[0] : resposta.data;
  if (bruto === null || bruto === undefined || typeof bruto !== "object") {
    return { linha: null, erro: "a consulta de cobertura devolveu linha em forma inesperada" };
  }
  return { linha: bruto as LinhaDeCobertura, erro: null };
}

// ---------------------------------------------------------------------------
// A lista de participantes: presenca e scores
// ---------------------------------------------------------------------------

interface ParticipanteBruto {
  id: string;
  full_name?: string | null;
}

/**
 * Monta `ParticipanteDna[]`. `presente` sai de `event_checkins` ATIVO cruzado
 * com `event_people` (e nunca inferido de outro campo); `scores` sai do motor
 * individual aplicado as respostas da versao de questionario DO EVENTO.
 *
 * Devolve `inconsistencia` quando uma resposta nao pode ser normalizada: contar
 * essa pessoa como "sem resposta" faria o guia imprimir uma contagem errada, e
 * o guia existe justamente para nao imprimir numero que nao foi verificado.
 */
export async function lerParticipantes(
  supabase: ClienteDoGuia,
  eventId: string,
  quizVersion: number,
): Promise<
  | { ok: true; participantes: ParticipanteDna[] }
  | { ok: false; codigo: CodigoDeErro; causa?: unknown }
> {
  const pes = await supabase
    .from("participants")
    .select("id, full_name")
    .eq("event_id", eventId);
  if (pes.error) return { ok: false, codigo: "PARTICIPANTS_UNAVAILABLE", causa: pes.error };
  const participantes = linhas(pes.data)
    .filter((l): l is ParticipanteBruto & Record<string, unknown> => typeof l.id === "string")
    .map((l) => ({ id: l.id as string, full_name: l.full_name as string | null }));

  // PRESENCA: event_people liga a pessoa do evento ao participante, e
  // event_checkins ATIVO e o registro que conta.
  const pessoas = await supabase
    .from("event_people")
    .select("id, participant_id")
    .eq("event_id", eventId);
  if (pessoas.error) return { ok: false, codigo: "PARTICIPANTS_UNAVAILABLE", causa: pessoas.error };
  const checkins = await supabase
    .from("event_checkins")
    .select("person_id, estado")
    .eq("event_id", eventId);
  if (checkins.error) {
    return { ok: false, codigo: "PARTICIPANTS_UNAVAILABLE", causa: checkins.error };
  }
  const pessoasAtivas = new Set(
    linhas(checkins.data)
      .filter((l) => l.estado === "ativo" && typeof l.person_id === "string")
      .map((l) => l.person_id as string),
  );
  const presentes = new Set(
    linhas(pessoas.data)
      .filter((l) => typeof l.id === "string" && pessoasAtivas.has(l.id as string))
      .map((l) => l.participant_id)
      .filter((v): v is string => typeof v === "string"),
  );

  if (participantes.length === 0) {
    return { ok: true, participantes: [] };
  }

  // As etapas DESTA versao de questionario. Sem o filtro, resposta de outra
  // versao entraria no motor e a contagem de completude diria outra coisa.
  const etapas = await supabase
    .from("quiz_stages")
    .select("id")
    .eq("quiz_version", quizVersion);
  if (etapas.error) return { ok: false, codigo: "QUIZ_STAGES_UNAVAILABLE", causa: etapas.error };
  const idsDeEtapa = linhas(etapas.data)
    .map((l) => l.id)
    .filter((v): v is number => typeof v === "number");
  if (idsDeEtapa.length === 0) {
    return { ok: false, codigo: "QUIZ_STAGES_INVALID", causa: "versão de questionário sem etapas" };
  }

  const resp = await supabase
    .from("quiz_responses")
    .select("participant_id, stage_id, answers")
    .in(
      "participant_id",
      participantes.map((p) => p.id),
    );
  if (resp.error) return { ok: false, codigo: "PARTICIPANTS_UNAVAILABLE", causa: resp.error };

  const porParticipante = new Map<string, LinhaDeRespostas[]>();
  for (const l of linhas(resp.data)) {
    const pid = l.participant_id;
    const stage = l.stage_id;
    if (typeof pid !== "string" || typeof stage !== "number") continue;
    if (!idsDeEtapa.includes(stage)) continue;
    const lista = porParticipante.get(pid) ?? [];
    lista.push({ stage_id: stage, answers: l.answers });
    porParticipante.set(pid, lista);
  }

  const saida: ParticipanteDna[] = [];
  for (const p of participantes) {
    const linhasDele = porParticipante.get(p.id) ?? [];
    let scores = null as ParticipanteDna["scores"];
    if (linhasDele.length > 0) {
      try {
        scores = calcularMarcoZero(achatarRespostas(linhasDele));
      } catch (e) {
        return { ok: false, codigo: "GUIDE_DATA_INCONSISTENT", causa: e };
      }
    }
    saida.push({
      id: p.id,
      ...(p.full_name ? { nome: p.full_name } : {}),
      presente: presentes.has(p.id),
      scores,
    });
  }
  return { ok: true, participantes: saida };
}

// ---------------------------------------------------------------------------
// A montagem
// ---------------------------------------------------------------------------

interface EventoDoGuia {
  id: string;
  name?: string | null;
  event_date?: string | null;
  quiz_version?: number | null;
}

/**
 * ORDEM: pedido -> evento -> cobertura oficial -> estado de publicacao do DNA
 * -> participantes. A cobertura vem antes da publicacao porque e dela que saem
 * os sinais de caducidade; a publicacao vem antes dos participantes porque nao
 * ha motivo para pontuar o evento inteiro quando o DNA ja esta disponibilizado.
 */
export async function prepararEntradaDoGuia(
  supabase: ClienteDoGuia,
  eventId: string,
): Promise<PreparoDoGuia> {
  if (!ehUuid(eventId)) return { ok: false, codigo: "INVALID_REQUEST" };

  const ev = await supabase
    .from("events")
    .select("id, name, event_date, quiz_version")
    .eq("id", eventId)
    .maybeSingle();
  if (ev.error) return { ok: false, codigo: "QUIZ_STAGES_UNAVAILABLE", causa: ev.error };
  const evento = ev.data as EventoDoGuia | null;
  if (!evento || typeof evento.id !== "string") {
    return { ok: false, codigo: "EVENT_NOT_FOUND" };
  }
  if (!Number.isInteger(evento.quiz_version)) {
    return {
      ok: false,
      codigo: "QUIZ_STAGES_INVALID",
      causa: "evento sem quiz_version utilizável",
    };
  }

  const { linha: cobertura, erro } = await lerCobertura(supabase, eventId);
  if (cobertura === null) return { ok: false, codigo: "COVERAGE_UNAVAILABLE", causa: erro };
  if (typeof cobertura.checkin_fechado !== "boolean") {
    return {
      ok: false,
      codigo: "COVERAGE_UNAVAILABLE",
      causa: "a linha de cobertura veio sem o estado do check-in",
    };
  }
  // O total de convidados e a fotografia versionada do banco. Sem ela, as oito
  // contagens nao fecham -- e estimar o denominador e justamente o que o guia
  // existe para nao fazer.
  if (!Number.isInteger(cobertura.convidados) || (cobertura.convidados as number) < 0) {
    return {
      ok: false,
      codigo: "INVITE_COUNT_UNDETERMINED",
      causa: `motivo_convidados=${String((cobertura as { motivo_convidados?: unknown }).motivo_convidados)}`,
    };
  }

  const publicacao = await lerPublicacaoDoDna(supabase, eventId, cobertura);

  const participantes = await lerParticipantes(
    supabase,
    eventId,
    evento.quiz_version as number,
  );
  if (!participantes.ok) {
    return { ok: false, codigo: participantes.codigo, causa: participantes.causa };
  }

  return {
    ok: true,
    publicacao,
    entrada: {
      dna: {
        meta: {
          nomeEvento: typeof evento.name === "string" ? evento.name : null,
          dataEvento:
            typeof evento.event_date === "string" ? evento.event_date.slice(0, 10) : null,
        },
        convidados: cobertura.convidados as number,
        checkinFechado: cobertura.checkin_fechado,
        participantes: participantes.participantes,
        gateDeVolume: gateDeVolumeDaCoberturaOficial(cobertura),
      },
      publicacaoDoDna: publicacao,
      // LIMITE DECLARADO: o banco de hoje nao guarda a liberacao de leitura
      // individual que a propria pessoa declara para o facilitador. Enquanto ela
      // nao existir, o guia conta ZERO liberacoes -- e nao presume liberacao
      // alguma. Inventar autorizacao aqui abriria o documento de outra pessoa.
      autorizacoes: [],
    },
  };
}
