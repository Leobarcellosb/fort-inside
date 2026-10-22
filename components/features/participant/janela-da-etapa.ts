// JANELA DO FORMULARIO ASSINCRONO -- as regras da 010_programas.sql, em funcao pura.
//
// A FONTE DE VERDADE E O BANCO (policies de participant_stage_sessions e de
// quiz_responses). Este arquivo NAO autoriza nada: ele espelha as regras para a
// interface poder DIZER a verdade antes de a pessoa tentar. Se um dia divergir
// do banco, quem manda e o banco; a rota e a tela tratam a recusa dele sem
// mostrar erro cru (ver textos-da-janela.ts e a rota /api/etapa/abrir).
//
// T = events.form_closes_at.
//   ate T-15min      : pode INICIAR etapa nova (e enviar)
//   T-15min a T      : nao inicia etapa nova; conclui a que ja iniciou
//   T a T+15min      : tolerancia de ENVIO, so para etapa ja iniciada
//   depois de T+15   : nada
//
// Limites inclusivos, como no banco (`now() <= T - 15min`, `now() <= T + 15min`).
// Sem form_closes_at a janela nao fecha ('infinity' no banco).

export const MARGEM_PARA_INICIAR_MIN = 15;
export const TOLERANCIA_DE_ENVIO_MIN = 15;

const MIN = 60_000;

export type FaseDaJanela =
  /** Antes de form_opens_at: nada pode ser iniciado nem enviado. */
  | "ainda_nao_abriu"
  /** Pode iniciar etapa nova e enviar. */
  | "aberta"
  /** T-15 a T, com a etapa JA iniciada: so conclui. */
  | "reta_final"
  /** T a T+15, com a etapa JA iniciada: tolerancia de envio. */
  | "tolerancia"
  /** T-15 a T+15 SEM a etapa iniciada: nao da mais para comecar. */
  | "nao_inicia_mais"
  /** Depois de T+15: nada, nem enviar. */
  | "encerrada";

/** Instantes em milissegundos desde a epoca; null = sem limite naquele lado. */
export interface JanelaEmMs {
  abre: number | null;
  fecha: number | null;
}

export interface LimitesDaJanela {
  abre: number | null;
  /** Ultimo instante em que ainda se INICIA uma etapa (T-15). */
  ultimoInicio: number | null;
  fecha: number | null;
  /** Ultimo instante em que ainda se ENVIA (T+15). */
  ultimoEnvio: number | null;
}

export function limitesDaJanela(janela: JanelaEmMs): LimitesDaJanela {
  return {
    abre: janela.abre,
    ultimoInicio: janela.fecha === null ? null : janela.fecha - MARGEM_PARA_INICIAR_MIN * MIN,
    fecha: janela.fecha,
    ultimoEnvio: janela.fecha === null ? null : janela.fecha + TOLERANCIA_DE_ENVIO_MIN * MIN,
  };
}

/** Converte as datas ISO do banco. Data ilegivel e erro (nao "sem limite"): janela errada nao pode abrir a porta. */
export function janelaDeIso(abre: string | null, fecha: string | null): JanelaEmMs {
  const ler = (v: string | null): number | null => {
    if (v === null) return null;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new Error(`data de janela invalida: ${v}`);
    return ms;
  };
  return { abre: ler(abre), fecha: ler(fecha) };
}

/**
 * Em que fase da janela a pessoa esta, para UMA etapa.
 * `etapaIniciada` = existe registro de abertura dessa etapa para ela.
 */
export function faseDaJanela(
  agora: number,
  janela: JanelaEmMs,
  etapaIniciada: boolean,
): FaseDaJanela {
  const l = limitesDaJanela(janela);
  if (l.abre !== null && agora < l.abre) return "ainda_nao_abriu";
  if (l.fecha === null || l.ultimoInicio === null || l.ultimoEnvio === null) return "aberta";
  if (agora <= l.ultimoInicio) return "aberta";
  if (agora > l.ultimoEnvio) return "encerrada";
  if (!etapaIniciada) return "nao_inicia_mais";
  return agora <= l.fecha ? "reta_final" : "tolerancia";
}

/** A fase permite escrever e enviar? (Sessao ja registrada, ou aberta para iniciar agora.) */
export function fasePermiteResponder(fase: FaseDaJanela): boolean {
  return fase === "aberta" || fase === "reta_final" || fase === "tolerancia";
}

/** Proximo instante em que a fase pode mudar, ou null se nao muda mais. */
export function proximaMudanca(agora: number, janela: JanelaEmMs): number | null {
  const l = limitesDaJanela(janela);
  const marcos = [l.abre, l.ultimoInicio, l.fecha, l.ultimoEnvio].filter(
    (m): m is number => m !== null && m >= agora,
  );
  return marcos.length ? Math.min(...marcos) : null;
}

// ------------------------------------------------------------- apresentacao

const FUSO = "America/Sao_Paulo";

function partesNoFuso(ms: number) {
  const f = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const parte of f.formatToParts(new Date(ms))) p[parte.type] = parte.value;
  return p;
}

/**
 * Momento ja com a preposicao, pronto para entrar numa frase. `em` (padrao):
 * "as 23h45" no mesmo dia de Brasilia que `referencia`, "em 22/10 as 00h15" em
 * outro dia. `ate`: "ate as 23h45" / "ate 22/10 as 00h15" (nunca "ate em").
 * Sempre no horario de Brasilia, para a mensagem dizer o mesmo horario que a
 * equipe do evento fala, em qualquer fuso do aparelho.
 */
export function formatarMomento(
  ms: number,
  referencia: number,
  preposicao: "em" | "até" = "em",
): string {
  const p = partesNoFuso(ms);
  const hora = `às ${p.hour}h${p.minute}`;
  const r = partesNoFuso(referencia);
  const mesmoDia = p.day === r.day && p.month === r.month;
  if (mesmoDia) return preposicao === "até" ? `até ${hora}` : hora;
  return `${preposicao} ${p.day}/${p.month} ${hora}`;
}

/** "12 min 05 s", "1 h 03 min", "45 s". Nunca negativo. */
export function formatarRestante(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

// ------------------------------------------------------- contrato da rota

/** Por que a etapa NAO pode ser iniciada agora. Mapeia 1:1 para uma fase. */
export type MotivoDeRecusa = "ainda_nao_abriu" | "nao_inicia_mais" | "encerrada" | "indisponivel";

/** Corpo da resposta de POST /api/etapa/abrir (HTTP 200). */
export interface RespostaDeAbertura {
  modo: "live" | "async";
  /** Relogio do SERVIDOR no momento da resposta (ISO). O cliente calcula o desvio dele. */
  agora: string;
  /** Janela do evento (so no async). */
  janela: { abre: string | null; fecha: string | null } | null;
  total_etapas: number;
  /** Numeros (stage_number) das etapas que a pessoa ja iniciou neste evento. */
  etapas_iniciadas: number[];
  /** Registro de abertura DESTA etapa; null se nao existe. */
  sessao: { iniciada_em: string; status: "open" | "submitted" } | null;
  /** true so quando ESTA chamada criou o registro. Repetir a chamada devolve false e o mesmo instante. */
  recem_criada: boolean;
  /** Preenchido quando nao ha registro e nao foi possivel criar. */
  motivo_recusa: MotivoDeRecusa | null;
}
