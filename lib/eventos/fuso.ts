// FUSO HORARIO DO EVENTO -- o contrato.
//
// Decisao do responsavel tecnico (rodada 27), em resumo:
//   - persistencia: instantes em UTC, com informacao temporal inequivoca
//     (`timestamptz`; no JSON, ISO 8601 com `Z`/offset). Nada aqui grava hora local;
//   - o fuso pertence ao EVENTO, nao ao app: esta funcao recebe o evento e devolve
//     o fuso DELE. Nao existe "fuso da aplicacao";
//   - a interface mostra o instante no fuso do evento, claramente identificado
//     (nome do fuso e o deslocamento daquela data), nunca no do computador de quem
//     acessa;
//   - eventos futuros usam o fuso configurado no evento.
//
// "Se o schema ainda nao possui timezone por evento, aceito um mapeamento explicito
// e versionado para o Marco Zero nesta fase, com migracao futura para um campo
// proprio." O schema AINDA NAO tem `events.timezone`. Entao:
//   1. se o evento trouxer `timezone` (o campo futuro), ele vence;
//   2. senao, vale o mapeamento abaixo, POR VERSAO DO QUIZ (o Marco Zero e a v2);
//   3. senao, NAO se adivinha: o fuso e `null` e o instante e mostrado em UTC, com
//      o rotulo "UTC". Mostrar uma hora local inventada seria pior que mostrar a
//      hora certa num fuso estranho.
//
// PROIBIDO aqui (e coberto por teste): ler o fuso do computador (`TZ`, `Intl`
// sem `timeZone`, `getHours()`), e qualquer conta manual de "UTC-3" -- ela ignora
// horario de verao e mudancas de regra. O deslocamento sai do proprio `Intl`, para
// a DATA do instante.

/** Mapeamento versionado, ate existir `events.timezone`. Mudar um valor aqui e uma decisao de produto. */
export const MAPEAMENTO_DE_FUSO = {
  /** Sobe quando o mapeamento muda. Ao migrar para o campo proprio, este objeto some. */
  versao: 1,
  /** `events.quiz_version` -> IANA. A v2 e o Marco Zero. */
  porQuizVersion: { 2: "America/Sao_Paulo" } as Readonly<Record<number, string>>,
} as const;

export interface EventoComFuso {
  /** Campo FUTURO (migracao para `events.timezone`). Hoje nao existe no schema. */
  timezone?: string | null;
  quiz_version?: number | null;
}

/** IANA valido neste runtime? (`Intl` rejeita nome desconhecido com RangeError.) */
export function fusoValido(nome: unknown): nome is string {
  if (typeof nome !== "string" || nome.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: nome });
    return true;
  } catch {
    return false;
  }
}

/** O fuso do EVENTO, ou `null` se nao der para determinar (nunca um palpite). */
export function fusoDoEvento(evento: EventoComFuso): string | null {
  if (evento.timezone !== undefined && evento.timezone !== null) {
    // Campo proprio presente: vale, ou nada. Um valor invalido nao cai no mapeamento
    // em silencio -- seria esconder um dado quebrado.
    return fusoValido(evento.timezone) ? evento.timezone : null;
  }
  const v = evento.quiz_version;
  if (typeof v === "number") {
    const mapeado = MAPEAMENTO_DE_FUSO.porQuizVersion[v];
    if (mapeado && fusoValido(mapeado)) return mapeado;
  }
  return null;
}

/**
 * Formata um instante para o host: "07/11/2026 12:00 (America/Sao_Paulo, GMT-03:00)".
 * Sem fuso: "07/11/2026 15:00 (UTC; o fuso deste evento nao esta configurado)".
 * Entrada ilegivel => `null` (quem chama decide o texto; nao se inventa hora).
 */
export function formatarInstante(iso: string | undefined | null, fuso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const usado = fuso !== null && fusoValido(fuso) ? fuso : "UTC";
  const partes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: usado,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(t);
  const pega = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  // Montado das PARTES para nao depender da ordem/pontuacao que o locale escolher.
  const data = `${pega("day")}/${pega("month")}/${pega("year")}`;
  const hora = `${pega("hour")}:${pega("minute")}`;
  const deslocamento = pega("timeZoneName"); // "GMT-03:00", calculado pelo Intl para ESTA data
  if (usado === "UTC" && (fuso === null || !fusoValido(fuso))) {
    return `${data} ${hora} (UTC; o fuso deste evento não está configurado)`;
  }
  return `${data} ${hora} (${usado}, ${deslocamento})`;
}
