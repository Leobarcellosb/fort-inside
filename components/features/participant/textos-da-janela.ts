// TUDO O QUE A PESSOA LE SOBRE O PRAZO, num so lugar para revisar.
//
// Regras de redacao (decididas com o responsavel tecnico):
//   - portugues claro, sem jargao: nada de "sessao de etapa", "RLS", "permissao",
//     codigo de erro. A pessoa "comeca" uma etapa; o prazo "termina";
//   - nunca culpar: o texto descreve a regra e o que acontece, nao o que a
//     pessoa deveria ter feito;
//   - sempre dizer o que fazer agora e o que acontece com o que ela escreveu.

import {
  formatarMomento,
  formatarRestante,
  limitesDaJanela,
  type FaseDaJanela,
  type JanelaEmMs,
} from "./janela-da-etapa";

export type TomDoAviso = "discreto" | "atencao" | "bloqueio";

export interface Aviso {
  tom: TomDoAviso;
  /** null = so a linha discreta, sem destaque. */
  titulo: string | null;
  corpo: string[];
  /** Contagem regressiva exibida junto ao aviso (nao entra em leitor de tela). */
  contagem: { rotulo: string; restante: string } | null;
}

export interface EntradaDoAviso {
  fase: FaseDaJanela;
  agora: number;
  janela: JanelaEmMs;
  /** Numeros das etapas do quiz que a pessoa AINDA NAO comecou (sem a atual). */
  etapasNaoIniciadas: number[];
  /** Ha texto/resposta guardado nesta tela? */
  temTexto: boolean;
  /** Esta etapa ja foi enviada antes? */
  jaEnviou: boolean;
}

const MIN = 60_000;
/** Faltando tanto para o limite de iniciar etapas, o aviso sai do discreto para o de atencao. */
export const ANTECEDENCIA_DO_AVISO_MIN = 30;

function listaDe(numeros: number[]): string {
  if (numeros.length <= 1) return numeros.join("");
  return `${numeros.slice(0, -1).join(", ")} e ${numeros[numeros.length - 1]}`;
}

/** Etapas que ainda dá tempo de começar (fase "aberta"). */
function aindaNaoComecadas(numeros: number[]): string {
  return numeros.length === 1
    ? `A etapa ${numeros[0]} ainda não foi começada. Se quiser fazê-la, comece antes do limite.`
    : `As etapas ${listaDe(numeros)} ainda não foram começadas. Se quiser fazê-las, comece antes do limite.`;
}

export function montarAviso(e: EntradaDoAviso): Aviso | null {
  const l = limitesDaJanela(e.janela);
  const ref = e.agora;
  const momento = (ms: number | null) => (ms === null ? "" : formatarMomento(ms, ref));
  const ate = (ms: number | null) => (ms === null ? "" : formatarMomento(ms, ref, "até"));

  switch (e.fase) {
    case "ainda_nao_abriu":
      return {
        tom: "bloqueio",
        titulo: "O formulário ainda não abriu",
        corpo: [`Ele abre ${momento(l.abre)}. Volte nesse horário para responder.`],
        contagem: null,
      };

    case "aberta": {
      if (l.fecha === null || l.ultimoInicio === null) return null;
      const faltaParaLimite = l.ultimoInicio - e.agora;
      if (faltaParaLimite <= ANTECEDENCIA_DO_AVISO_MIN * MIN) {
        return {
          tom: "atencao",
          titulo: "Daqui a pouco não dá mais para começar etapas novas",
          corpo: [
            `Só dá para começar uma etapa nova ${ate(l.ultimoInicio)}. Depois disso, só dá para terminar e enviar etapas que você já começou, ${ate(l.fecha)}.`,
            ...(e.etapasNaoIniciadas.length ? [aindaNaoComecadas(e.etapasNaoIniciadas)] : []),
          ],
          contagem: { rotulo: "Tempo para começar etapas novas", restante: formatarRestante(faltaParaLimite) },
        };
      }
      return {
        tom: "discreto",
        titulo: null,
        corpo: [
          `O prazo do formulário termina ${momento(l.fecha)}. Etapas novas podem ser começadas ${ate(l.ultimoInicio)}.`,
        ],
        contagem: null,
      };
    }

    case "reta_final": {
      return {
        tom: "atencao",
        titulo: "Faltam menos de 15 minutos para o prazo",
        corpo: [
          `Você já começou esta etapa, então pode terminar e enviar normalmente ${ate(l.fecha)}.`,
          `Não dá mais para começar etapas novas.${
            e.etapasNaoIniciadas.length ? ` ${pendentesTexto(e.etapasNaoIniciadas)}` : ""
          }`,
          `Se o horário passar enquanto você termina, ainda aceitamos o envio desta etapa ${ate(l.ultimoEnvio)}. Esse tempo extra serve só para concluir uma etapa que você já começou: nunca para começar uma etapa nova.`,
        ],
        contagem: l.fecha === null ? null : { rotulo: "Tempo até o prazo", restante: formatarRestante(l.fecha - e.agora) },
      };
    }

    case "tolerancia":
      return {
        tom: "atencao",
        titulo: "O prazo terminou, mas você ainda pode enviar esta etapa",
        corpo: [
          `Você começou esta etapa dentro do prazo, por isso ainda aceitamos o envio dela ${ate(l.ultimoEnvio)}. Envie agora.`,
          `Esse tempo extra serve só para concluir uma etapa que você já começou. Não dá para começar nenhuma etapa nova, e depois desse horário o formulário não recebe mais respostas.${
            e.etapasNaoIniciadas.length ? ` ${pendentesTexto(e.etapasNaoIniciadas)}` : ""
          }`,
        ],
        contagem:
          l.ultimoEnvio === null
            ? null
            : { rotulo: "Tempo para enviar", restante: formatarRestante(l.ultimoEnvio - e.agora) },
      };

    case "nao_inicia_mais": {
      const depoisDoPrazo = l.fecha !== null && e.agora > l.fecha;
      return {
        tom: "bloqueio",
        titulo: "Não dá mais para começar esta etapa",
        corpo: [
          depoisDoPrazo
            ? `O prazo do formulário terminou ${momento(l.fecha)}. Só era possível começar etapas novas ${ate(l.ultimoInicio)}, e esta etapa não tinha sido começada. Essa regra vale para todos os participantes.`
            : `Só era possível começar etapas novas ${ate(l.ultimoInicio)}, e esta etapa ainda não tinha sido começada. Essa regra vale para todos os participantes.`,
          "Se você acha que isso não deveria ter acontecido, fale com a equipe do evento.",
        ],
        contagem: null,
      };
    }

    case "encerrada": {
      const quando = `O formulário foi encerrado ${momento(l.ultimoEnvio)} e não recebe mais respostas.`;
      if (e.jaEnviou) {
        return {
          tom: "bloqueio",
          titulo: "O formulário foi encerrado",
          corpo: [`${quando} Você já tinha enviado esta etapa, e as respostas dela foram recebidas.`],
          contagem: null,
        };
      }
      if (e.temTexto) {
        return {
          tom: "bloqueio",
          titulo: "O formulário foi encerrado",
          corpo: [
            quando,
            "O que você escreveu nesta etapa continua aqui na tela. Você pode copiar o texto para guardar.",
            "Se você acha que isso não deveria ter acontecido, fale com a equipe do evento.",
          ],
          contagem: null,
        };
      }
      return {
        tom: "bloqueio",
        titulo: "O formulário foi encerrado",
        corpo: [quando, "Se você acha que isso não deveria ter acontecido, fale com a equipe do evento."],
        contagem: null,
      };
    }
  }
}

function pendentesTexto(numeros: number[]): string {
  return numeros.length === 1
    ? `A etapa ${numeros[0]} não foi começada antes do limite e não pode mais ser aberta.`
    : `As etapas ${listaDe(numeros)} não foram começadas antes do limite e não podem mais ser abertas.`;
}

// ------------------------------------------------- mensagens de ENVIO (toast)
// Nenhuma carrega texto do banco. A causa tecnica vai para o console.

export const MSG_ENVIO_ENCERRADO =
  "O formulário foi encerrado e não recebe mais respostas. O que você escreveu continua aqui na tela.";

export const MSG_ENVIO_NAO_INICIA_MAIS =
  "Não dá mais para começar esta etapa: o limite para etapas novas já passou.";

export const MSG_ENVIO_AINDA_NAO_ABRIU = "O formulário ainda não abriu. Volte quando ele abrir para enviar.";

export const MSG_ENVIO_FALHA_GENERICA =
  "Não conseguimos receber suas respostas agora. O que você escreveu continua aqui na tela. Tente de novo em alguns segundos.";

export const MSG_ENVIO_SEM_CONEXAO =
  "Não conseguimos falar com o servidor. Verifique a conexão e tente de novo: o que você escreveu continua aqui na tela.";

/** Modo LIVE: o host ainda nao liberou a etapa. NAO e login expirado (decisao do CTO). */
export const MSG_ETAPA_NAO_LIBERADA = "Esta etapa ainda não foi liberada pela organização.";

export const MSG_SESSAO_DE_LOGIN_EXPIRADA = "Sua sessão expirou. Recarregue a página e tente de novo.";

/**
 * Aviso curto (toast) para quando a fase MUDA com a pessoa ja na tela -- ela
 * pode estar la embaixo, escrevendo, longe do aviso do topo. So as mudancas que
 * exigem acao ou explicam por que o campo parou de aceitar texto.
 */
export function avisoDeTransicao(fase: FaseDaJanela): string | null {
  switch (fase) {
    case "reta_final":
      return "Faltam menos de 15 minutos para o prazo. Termine e envie esta etapa: não dá mais para começar outras.";
    case "tolerancia":
      return "O prazo terminou, mas você ainda pode enviar esta etapa. Envie agora.";
    case "encerrada":
      return "O formulário foi encerrado. O que você escreveu continua nesta tela; a explicação está no topo da página.";
    default:
      return null;
  }
}

/** Mensagem do toast para uma recusa de janela. */
export function mensagemDeRecusa(fase: FaseDaJanela): string | null {
  switch (fase) {
    case "encerrada":
      return MSG_ENVIO_ENCERRADO;
    case "nao_inicia_mais":
      return MSG_ENVIO_NAO_INICIA_MAIS;
    case "ainda_nao_abriu":
      return MSG_ENVIO_AINDA_NAO_ABRIU;
    default:
      return null;
  }
}

// ------------------------------------------------------- copiar o que escreveu

interface PerguntaParaCopia {
  id: string;
  text?: string;
  type?: string;
  option_a?: string;
  option_b?: string;
}

/**
 * O que a pessoa escreveu/escolheu, em texto puro, para ela guardar quando o
 * prazo acabou. So entram perguntas com resposta.
 */
export function textoParaCopiar(
  etapaTitulo: string,
  perguntas: PerguntaParaCopia[],
  respostas: Record<string, string | string[] | number>,
): string {
  const blocos: string[] = [];
  perguntas.forEach((p, i) => {
    const r = respostas[p.id];
    let valor = "";
    if (typeof r === "string") valor = r.trim();
    else if (typeof r === "number") valor = String(r);
    else if (Array.isArray(r)) valor = r.map((o, idx) => (p.type === "ranking" ? `${idx + 1}. ${o}` : o)).join(p.type === "ranking" ? "\n" : "; ");
    if (!valor) return;
    blocos.push(`${i + 1}. ${p.text ?? ""}\n${valor}`);
  });
  return blocos.length ? `${etapaTitulo}\n\n${blocos.join("\n\n")}\n` : "";
}
