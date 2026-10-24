// O PAINEL DO EVENTO COMO ROTEIRO (CTO, Rodada 82).
//
// O painel mostrava ferramentas, nao o caminho. Para o evento assincrono do Marco
// Zero ele vira quatro passos: coleta, testar a IA, gerar, revisar e enviar. Esta
// parte so decide O QUE MOSTRAR, a partir de dados que o painel ja tem. Quem
// decide se pode processar, entregar ou recusar continua sendo o servidor.

import { rotuloDoEventoConcluido, type ResumoDosDocumentos } from "./situacao-prognostico";

export type TipoDaOperacao = "assincrona" | "ao_vivo" | "nao_verificado";

/**
 * Pelo modo e pela versao do questionario, nunca por "a tela nao leu as
 * etapas". Dado ausente ou contraditorio nao escolhe fluxo: e "nao verificado".
 */
export function tipoDaOperacao(evento: { mode?: string | null; quiz_version?: number | null }): TipoDaOperacao {
  if (evento.mode === "live") return "ao_vivo";
  if (evento.mode === "async" && evento.quiz_version === 2) return "assincrona";
  return "nao_verificado";
}

/** O estado do evento em portugues; palavra crua do banco nunca vai para a tela. */
export function rotuloDoEstado(status: string | null | undefined, resumo: ResumoDosDocumentos | null): string {
  switch (status) {
    case "draft":
      return "Rascunho";
    case "live":
      return "Em andamento";
    case "processing":
      return "Gerando documentos";
    case "completed":
      return rotuloDoEventoConcluido(resumo);
    default:
      return "Estado não reconhecido";
  }
}

const FUSO = "America/Sao_Paulo";

export interface PrazoNaTela {
  /** Ex.: "sexta-feira, 23/10, às 23h59 (horário de Brasília)". */
  texto: string;
  /** Pelo relogio DESTE computador. A recusa de verdade e do servidor. */
  passou: boolean | null;
}

/**
 * `form_closes_at` e o primeiro instante recusado. Para quem le, o prazo e o
 * ultimo minuto aberto: um minuto antes.
 */
export function prazoNaTela(formClosesAt: string | null | undefined, agora: Date): PrazoNaTela {
  if (!formClosesAt) return { texto: "Prazo não cadastrado", passou: null };
  const fecha = new Date(formClosesAt).getTime();
  if (Number.isNaN(fecha)) return { texto: "Prazo ilegível no cadastro", passou: null };
  const ultimoMinuto = new Date(fecha - 60_000);
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit" })
    .format(ultimoMinuto)
    .replace(",", ",");
  const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(ultimoMinuto)
    .replace(":", "h");
  return { texto: `${dia}, às ${hora} (horário de Brasília)`, passou: agora.getTime() >= fecha };
}

export type SituacaoDoPasso = "feito" | "agora" | "depois" | "atencao" | "se_precisar";

export interface PassosDaOperacao {
  coleta: SituacaoDoPasso;
  testarIA: SituacaoDoPasso;
  gerar: SituacaoDoPasso;
  revisar: SituacaoDoPasso;
}

/**
 * Em que passo o operador esta. O teste da IA nunca aparece como feito: um
 * teste de ontem nao prova que a IA responde hoje (CTO, Rodada 82).
 */
export function passosDaOperacao(entrada: {
  status: string | null | undefined;
  prazoPassou: boolean | null;
  resumo: ResumoDosDocumentos | null;
  /** Quantos concluiram o questionario: com documento para todos, gerar esta feito. */
  concluidos: number;
}): PassosDaOperacao {
  const { status, prazoPassou, resumo, concluidos } = entrada;
  const gerando = status === "processing";
  const temDocumentos = (resumo?.comDocumento ?? 0) > 0;
  const temFalhas = (resumo?.falharam ?? 0) > 0;
  const coletaFechada = prazoPassou === true || gerando || status === "completed";
  // "Feito" so com documento para todos E nada na fila nem gerando. Sem saber
  // quantos estao em andamento, nao se afirma que terminou (CTO, Rodada 83).
  const filaParada = resumo?.emAndamento === 0;
  const todosComDocumento = temDocumentos && (resumo?.comDocumento ?? 0) >= concluidos && filaParada;

  const coleta: SituacaoDoPasso = coletaFechada ? "feito" : prazoPassou === null ? "atencao" : "agora";
  // Com documentos ja gerados, o teste so importa para gerar de novo: "se precisar".
  const testarIA: SituacaoDoPasso = temDocumentos ? "se_precisar" : coletaFechada && !gerando ? "agora" : "depois";
  const gerar: SituacaoDoPasso = temFalhas
    ? "atencao"
    : gerando || (resumo?.emAndamento ?? 0) > 0
      ? "agora"
      : todosComDocumento
        ? "feito"
        : coletaFechada
          ? "agora"
          : "depois";
  const revisar: SituacaoDoPasso = temDocumentos ? "agora" : "depois";
  return { coleta, testarIA, gerar, revisar };
}

export const ROTULO_DA_SITUACAO: Record<SituacaoDoPasso, string> = {
  feito: "Feito",
  agora: "Agora",
  depois: "Depois",
  atencao: "Atenção",
  se_precisar: "Se precisar",
};
