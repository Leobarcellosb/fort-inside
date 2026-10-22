import {
  faseDaJanela,
  fasePermiteResponder,
  type JanelaEmMs,
} from "./janela-da-etapa";

// PROXIMA ETAPA NO MODO ASSINCRONO -- decisao pura.
//
// No assincrono nao ha host liberando etapa: `events.current_stage` nunca anda e
// NAO entra nesta decisao. A elegibilidade vem de tres coisas, todas do banco:
//   1. as etapas da VERSAO do quiz do evento (a contagem vem de
//      lib/quiz/etapas-do-evento.ts, a mesma fonte dos portoes de processamento);
//   2. quais etapas a pessoa JA ENVIOU (existe resposta gravada);
//   3. a janela temporal, pela MESMA funcao que a tela da etapa usa
//      (`faseDaJanela`): nunca se manda a pessoa a uma etapa que ela nao pode
//      comecar. Esta funcao nao reimplementa a regra, so a consulta.
//
// Ordem: a menor etapa ainda nao enviada que a janela permite. Uma etapa ja
// iniciada continua valendo na reta final e na tolerancia; uma nao iniciada so
// vale ate T-15.
//
// "Concluido" = TODAS as etapas da versao tem envio. Contado, nao suposto: nao
// ha numero fixo aqui.

export type DestinoAssincrono =
  | { tipo: "etapa"; numero: number }
  | { tipo: "concluido" }
  /** Ha etapas por enviar, mas a janela nao deixa nenhuma ser feita agora. */
  | {
      tipo: "nenhuma";
      motivo: "ainda_nao_abriu" | "nao_inicia_mais" | "encerrada";
      pendentes: number[];
    }
  /** NAO foi possivel determinar. Nunca vira "etapa 1" nem qualquer palpite. */
  | { tipo: "indisponivel"; motivo: "leitura" | "configuracao" };

export function decidirDestino(e: {
  totalEtapas: number;
  enviadas: number[];
  iniciadas: number[];
  agora: number;
  janela: JanelaEmMs;
}): DestinoAssincrono {
  if (!Number.isInteger(e.totalEtapas) || e.totalEtapas < 1) {
    return { tipo: "indisponivel", motivo: "configuracao" };
  }
  const enviadas = new Set(e.enviadas);
  const iniciadas = new Set(e.iniciadas);
  const pendentes: number[] = [];
  for (let n = 1; n <= e.totalEtapas; n++) if (!enviadas.has(n)) pendentes.push(n);

  if (pendentes.length === 0) return { tipo: "concluido" };

  for (const n of pendentes) {
    if (fasePermiteResponder(faseDaJanela(e.agora, e.janela, iniciadas.has(n)))) {
      return { tipo: "etapa", numero: n };
    }
  }

  const fase = faseDaJanela(e.agora, e.janela, iniciadas.has(pendentes[0]));
  const motivo =
    fase === "ainda_nao_abriu" || fase === "encerrada" ? fase : "nao_inicia_mais";
  return { tipo: "nenhuma", motivo, pendentes };
}

/** Corpo de 200 de POST /api/etapa/proxima. */
export interface RespostaProxima {
  modo: "live" | "async";
  /** Relogio do servidor (ISO), para o cliente medir o desvio. */
  agora: string;
  janela: { abre: string | null; fecha: string | null } | null;
  total_etapas: number | null;
  etapas_enviadas: number[];
  etapas_iniciadas: number[];
  /** null no live: quem manda ali e current_stage, e esta rota nao decide. */
  destino: DestinoAssincrono | null;
}
