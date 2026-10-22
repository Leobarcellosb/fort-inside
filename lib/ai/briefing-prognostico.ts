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

// Liga o que o motor mede ao que o gerador manda para o modelo.
//
// Caminho unico e obrigatorio: respostas gravadas -> achatarRespostas (extrai a
// letra da situacional, que a interface grava como TEXTO da opcao) ->
// calcularMarcoZero (motor) -> montarBriefingMarcoZero (camada de linguagem,
// com os quatro rotulos do catalogo fechado) -> briefingParaPrompt. O gerador
// nunca le o resultado do motor direto: so o que a camada de briefing autoriza
// chega ao prompt.

/** Versoes do quiz com tratamento proprio no gerador. */
export const QUIZ_VERSION_FORT_INSIDE = 1;
export const QUIZ_VERSION_MARCO_ZERO = 2;

export type BriefingDoParticipante =
  | {
      ok: true;
      briefing: BriefingMarcoZero;
      /** Bloco de texto pronto para o prompt (briefingParaPrompt). */
      bloco: string;
    }
  | { ok: false; status: number; error: string };

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
        error: `Resposta ilegível no questionário (${err.perguntaId ?? `etapa ${err.etapaId}`}); o prognóstico não foi gerado.`,
      };
    }
    throw err;
  }

  try {
    const briefing = montarBriefingMarcoZero(calcularMarcoZero(achatadas), {
      rotulosEixos: ROTULOS_EIXOS_MARCO_ZERO,
    });
    if (briefing.avisos.length > 0) {
      console.warn("[generate-prognostic] avisos do briefing", briefing.avisos);
    }
    return { ok: true, briefing, bloco: briefingParaPrompt(briefing) };
  } catch (err) {
    // A camada de briefing LANCA em vez de entregar texto proibido.
    console.error("[generate-prognostic] briefing do Marco Zero recusado", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 500,
      error: "Não foi possível montar o briefing do Marco Zero; o prognóstico não foi gerado.",
    };
  }
}
