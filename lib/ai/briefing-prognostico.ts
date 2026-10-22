import type { QuizResponse } from "@/types/database";
import {
  ErroNormalizacaoResposta,
  achatarRespostas,
} from "../scoring/achatar-respostas";
import { calcularMarcoZero } from "../scoring/marco-zero";
import {
  briefingParaPrompt,
  montarBriefingMarcoZero,
  type BriefingMarcoZero,
} from "../scoring/briefing-marco-zero";
import { ROTULOS_EIXOS_MARCO_ZERO } from "../../components/features/marco-zero/catalogo-dimensoes";
import {
  avaliarCompletude,
  mensagemDeCompletude,
  type Completude,
} from "./completude-marco-zero";
import type { DetalhesDeErro, TodoCodigoDeErro } from "../erros/codigos";

// Liga o que o motor mede ao que o gerador manda para o modelo.
//
// Caminho unico e obrigatorio: respostas gravadas -> achatarRespostas (extrai a
// letra da situacional, que a interface grava como TEXTO da opcao) ->
// calcularMarcoZero (motor) -> PORTAO DE COMPLETUDE (avaliarCompletude, sobre o
// `incompleto` que o motor reportou) -> montarBriefingMarcoZero (camada de
// linguagem, com os quatro rotulos do catalogo fechado) -> briefingParaPrompt.
// O gerador nunca le o resultado do motor direto: so o que a camada de briefing
// autoriza chega ao prompt.
//
// O portao de completude esta AQUI, e nao em contexto-quiz.ts, porque e aqui
// que o resultado do motor existe: ele conta PERGUNTAS a partir do campo que o
// motor ja preenche, em vez de recontar linhas de etapa. O portao de linhas
// segue em contexto-quiz.ts, antes deste, e e o que recusa etapa faltando.

/** Versoes do quiz com tratamento proprio no gerador. */
export const QUIZ_VERSION_FORT_INSIDE = 1;
export const QUIZ_VERSION_MARCO_ZERO = 2;

export type BriefingDoParticipante =
  | {
      ok: true;
      briefing: BriefingMarcoZero;
      /** Bloco de texto pronto para o prompt (briefingParaPrompt). */
      bloco: string;
      /** O que o motor mediu de completude (todos os blocos acima do mínimo). */
      completude: Completude;
    }
  | {
      ok: false;
      status: number;
      error: string;
      /**
       * A CAUSA, no vocabulário de lib/erros/codigos.ts. Recusar por dado
       * insuficiente não é erro de servidor: é desfecho previsto, e o código é
       * o que permite à tela dizer o que falta sem interpretar texto.
       */
      code?: TodoCodigoDeErro;
      detalhes?: DetalhesDeErro;
    };

export function prepararBriefing(
  respostas: readonly Pick<QuizResponse, "stage_id" | "answers">[],
): BriefingDoParticipante {
  let achatadas;
  try {
    achatadas = achatarRespostas(respostas);
  } catch (err) {
    if (err instanceof ErroNormalizacaoResposta) {
      // Valor presente e ilegivel e ERRO DE DADOS, nao "nao respondeu": o
      // motor trataria como ausente e a pessoa sairia com uma leitura falsa.
      // Sem briefing nao ha prognostico, e o modelo nem e chamado.
      console.error("[generate-prognostic] resposta do Marco Zero ilegivel", {
        perguntaId: err.perguntaId,
        etapaId: err.etapaId,
      });
      return {
        ok: false,
        status: 422,
        code: "PROGNOSTIC_RESPONSES_UNREADABLE",
        error: `Resposta ilegível no questionário (${err.perguntaId ?? `etapa ${err.etapaId}`}); o prognóstico não foi gerado.`,
        detalhes: err.perguntaId ? { itens: [err.perguntaId] } : undefined,
      };
    }
    throw err;
  }

  const scores = calcularMarcoZero(achatadas);

  // PORTÃO DE COMPLETUDE, em cima do que o MOTOR reportou como ausente
  // (`scores.incompleto`), antes de qualquer chamada ao modelo e antes de
  // existir documento. Ver lib/ai/completude-marco-zero.ts para o limiar e a
  // justificativa de cada bloco. Sem este portão, as 5 linhas de etapa bastavam
  // e um questionário quase vazio virava documento com os quatro eixos em zero.
  const completude = avaliarCompletude(scores);
  if (!completude.suficiente) {
    console.error("[generate-prognostic] respostas insuficientes para o documento", {
      blocos_incompletos: completude.insuficientes,
      faltando: completude.faltando,
    });
    return {
      ok: false,
      status: 400,
      code: "PROGNOSTIC_RESPONSES_INSUFFICIENT",
      error: mensagemDeCompletude(completude),
      detalhes: {
        blocos_incompletos: completude.insuficientes,
        itens: completude.faltando,
        completude: completude.blocos
          .filter((b) => !b.suficiente)
          .map((b) => ({
            bloco: b.bloco,
            respondidas: b.respondidas,
            total: b.total,
            minimo: b.minimo,
          })),
      },
    };
  }

  try {
    const briefing = montarBriefingMarcoZero(scores, {
      rotulosEixos: ROTULOS_EIXOS_MARCO_ZERO,
    });
    if (briefing.avisos.length > 0) {
      console.warn("[generate-prognostic] avisos do briefing", briefing.avisos);
    }
    return { ok: true, briefing, bloco: briefingParaPrompt(briefing), completude };
  } catch (err) {
    // A camada de briefing LANCA em vez de entregar texto proibido.
    console.error("[generate-prognostic] briefing do Marco Zero recusado", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 500,
      code: "INTERNAL_ERROR",
      error: "Não foi possível montar o briefing do Marco Zero; o prognóstico não foi gerado.",
    };
  }
}
