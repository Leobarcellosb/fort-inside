// Textos da tela que leva o participante do modo ASSINCRONO de uma etapa a
// outra (ou diz por que nao da). Mesmas regras de redacao de textos-da-janela.ts:
// portugues claro, sem jargao, sem culpar, sempre dizendo o que acontece com o
// que a pessoa ja enviou.

import { formatarMomento, limitesDaJanela, type JanelaEmMs } from "./janela-da-etapa";

export type EstadoDaNavegacao =
  | {
      tipo: "nenhuma";
      motivo: "ainda_nao_abriu" | "nao_inicia_mais" | "encerrada";
      pendentes: number[];
      enviadas: number;
      total: number;
      janela: JanelaEmMs;
      agora: number;
    }
  | { tipo: "indisponivel"; causa: "leitura" | "configuracao" | "login" | "conclusao" };

export interface TelaDaNavegacao {
  titulo: string;
  corpo: string[];
  /** Botao "Tentar de novo" so quando tentar de novo pode resolver. */
  tentarDeNovo: boolean;
}

function lista(numeros: number[]): string {
  if (numeros.length <= 1) return numeros.join("");
  return `${numeros.slice(0, -1).join(", ")} e ${numeros[numeros.length - 1]}`;
}

const FALE_COM_A_EQUIPE = "Se você acha que isso não deveria ter acontecido, fale com a equipe do evento.";

export const MSG_NAVEGACAO_LOGIN = "Sua sessão expirou. Recarregue a página e tente de novo.";

export function montarTelaDaNavegacao(e: EstadoDaNavegacao): TelaDaNavegacao {
  if (e.tipo === "indisponivel") {
    switch (e.causa) {
      case "leitura":
        return {
          titulo: "Não conseguimos achar sua próxima etapa agora",
          corpo: [
            "Tudo o que você já enviou está guardado. Estamos tentando de novo, e você também pode tocar em “Tentar de novo”.",
          ],
          tentarDeNovo: true,
        };
      case "configuracao":
        return {
          titulo: "Não conseguimos levar você à próxima etapa",
          corpo: [
            "O formulário deste evento parece estar com um problema de configuração, e tentar de novo não resolve. Suas respostas estão guardadas.",
            "Avise a equipe do evento.",
          ],
          tentarDeNovo: false,
        };
      case "login":
        return { titulo: MSG_NAVEGACAO_LOGIN, corpo: [], tentarDeNovo: false };
      case "conclusao":
        return {
          titulo: "Recebemos suas respostas, mas não conseguimos confirmar a conclusão",
          corpo: ["Elas estão guardadas. Toque em “Tentar de novo” para concluir."],
          tentarDeNovo: true,
        };
    }
  }

  const l = limitesDaJanela(e.janela);
  const enviou =
    e.enviadas === 0
      ? "Você ainda não enviou nenhuma etapa."
      : `Você enviou ${e.enviadas} de ${e.total} etapas.`;
  const faltam = e.pendentes.length === 1 ? `A etapa ${e.pendentes[0]}` : `As etapas ${lista(e.pendentes)}`;

  switch (e.motivo) {
    case "ainda_nao_abriu":
      return {
        titulo: "O formulário ainda não abriu",
        corpo: [
          `Ele abre ${l.abre === null ? "em breve" : formatarMomento(l.abre, e.agora)}. Esta tela avança sozinha quando abrir.`,
        ],
        tentarDeNovo: false,
      };
    case "nao_inicia_mais":
      return {
        titulo: "Não dá mais para começar as etapas que faltam",
        corpo: [
          `${enviou} ${faltam} ${e.pendentes.length === 1 ? "não tinha sido começada" : "não tinham sido começadas"}, e o prazo para começar etapas novas já passou (o limite era ${l.ultimoInicio === null ? "" : formatarMomento(l.ultimoInicio, e.agora)}). O que você já enviou está guardado.`,
          FALE_COM_A_EQUIPE,
        ],
        tentarDeNovo: false,
      };
    case "encerrada":
      return {
        titulo: "O formulário foi encerrado",
        corpo: [
          `${enviou} ${faltam} ${e.pendentes.length === 1 ? "não foi enviada" : "não foram enviadas"}, e o formulário não recebe mais respostas. O que você já enviou está guardado.`,
          FALE_COM_A_EQUIPE,
        ],
        tentarDeNovo: false,
      };
  }
}
