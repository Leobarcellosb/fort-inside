import type { PrognosticContent } from "@/types/database";
import { correcoesSchema, prognosticContentSchema } from "./prognostic-schema";
import {
  aplicarCorrecoes,
  descreverMotivo,
  resumirViolacoes,
  verificarSaida,
  type Violacao,
} from "./saida-prognostico";

// Orquestra "gerar -> verificar contra o veto -> corrigir uma vez -> recusar".
// Nao conhece o SDK nem o banco: recebe as duas chamadas ao modelo por
// injecao, entao a politica abaixo e testavel sem gastar um token.
//
// POLITICA (decisao e justificativa em docs do relatorio desta unidade):
//
//   1. Gera o documento (1 chamada completa, a cara).
//   2. Varre CADA string contra o veto. Limpo -> devolve.
//   3. Violou -> UM pedido de CORRECAO PONTUAL: o modelo recebe o proprio
//      rascunho e a lista de campos recusados (com a frase culpada e o motivo)
//      e devolve so a reescrita desses campos. Nao regera o documento.
//   4. Varre o documento corrigido de novo. Limpo -> devolve.
//   5. Ainda violando -> RECUSA (422). Nada e gravado. Sem terceira tentativa.
//
// Por que corrigir so os campos e nao regerar: toda regra do veto e local a um
// texto (nenhuma depende de dois campos ao mesmo tempo), entao a correcao tambem
// e local. Regerar tudo pagaria de novo ~4k tokens de saida e ~1 min de Opus
// para trocar uma frase; o pedido pontual devolve algumas centenas de tokens.
// Por que so uma rodada: o modelo que ignorou a regra uma vez e ainda foi
// avisado de qual frase e por que, e a segunda falha indica que o caso nao se
// resolve com mais gasto. Mais rodadas trocam previsibilidade de custo por uma
// chance pequena de sucesso. Por que recusar e nao gravar mesmo assim: o
// documento vai para o participante; a regra e do codigo exatamente para nao
// depender da boa vontade do modelo.

export const MAX_RODADAS_DE_CORRECAO = 1;

export interface SaidaDoModelo {
  /** Texto da resposta (JSON). */
  texto: string;
  /** O modelo recusou a requisicao (stop_reason "refusal"). */
  recusou: boolean;
  detalheRecusa?: unknown;
}

export interface Dependencias {
  /** Chamada completa: gera o documento. */
  gerar(): Promise<SaidaDoModelo>;
  /**
   * Chamada pontual: recebe o rascunho recusado (o texto cru devolvido por
   * `gerar`) e o pedido de correcao; devolve JSON { correcoes: [...] }.
   */
  corrigir(rascunho: string, pedido: string): Promise<SaidaDoModelo>;
}

export interface Chamadas {
  completas: number;
  correcoes: number;
}

export type ResultadoComVeto =
  | {
      ok: true;
      content: PrognosticContent;
      chamadas: Chamadas;
      /** Campos que precisaram de correcao (vazio = saiu limpo de primeira). */
      camposCorrigidos: string[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: unknown;
      chamadas: Chamadas;
      /** Violacoes que levaram a recusa (so campo e motivo; nunca o texto). */
      violacoes?: { campo: string; motivos: string[] }[];
    };

export function montarPedidoDeCorrecao(violacoes: readonly Violacao[]): string {
  const blocos = violacoes.map((v) => {
    const trechos = v.trechos
      .map(
        (t) =>
          `    - ${JSON.stringify(t.trecho)}\n      motivo: ${t.motivos.map(descreverMotivo).join("; ")}`,
      )
      .join("\n");
    return [
      `Campo: ${v.campo}`,
      `  Trechos recusados:`,
      trechos,
      `  Texto atual do campo:`,
      `    ${JSON.stringify(v.textoDoCampo)}`,
    ].join("\n");
  });
  return [
    "A verificação automática de linguagem do Marco Zero recusou trechos do texto que você devolveu. Nada foi gravado.",
    "",
    'Reescreva SOMENTE os campos listados abaixo. Responda com JSON { "correcoes": [ { "campo": "...", "texto": "..." } ] }, com exatamente uma entrada por campo listado, usando o nome do campo como está escrito, e em "texto" o conteúdo COMPLETO do campo já corrigido (não apenas a frase).',
    "Mantenha o sentido, a voz e o tamanho. Troque só o que viola a regra. Não use a expressão recusada nem um sinônimo que diga a mesma coisa. Não acrescente fato, número, comparação ou nome de dimensão que não esteja no briefing.",
    "",
    blocos.join("\n\n"),
  ].join("\n");
}

function lerConteudo(
  texto: string,
):
  | { ok: true; content: PrognosticContent }
  | { ok: false; status: number; error: string; detail?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(texto);
  } catch (err) {
    console.error("[generate-prognostic] parse failure", {
      err: err instanceof Error ? err.message : String(err),
      rawTextPreview: texto.slice(0, 800),
      rawTextLength: texto.length,
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao parsear resposta da IA",
      detail: err instanceof Error ? err.message : "unknown",
    };
  }
  const validado = prognosticContentSchema.safeParse(parsed);
  if (!validado.success) {
    console.error("[generate-prognostic] schema validation failed", {
      errors: validado.error.flatten(),
      parsedPreview: JSON.stringify(parsed).slice(0, 800),
    });
    return {
      ok: false,
      status: 500,
      error: "IA retornou estrutura inválida",
      detail: validado.error.flatten(),
    };
  }
  return { ok: true, content: validado.data as PrognosticContent };
}

const RECUSA_DO_MODELO = "A IA recusou a geração para este participante";

/**
 * Caminho SEM veto (Fort Inside, v1): uma chamada, leitura e schema, nada mais.
 * Existe aqui para os dois caminhos compartilharem o mesmo tratamento de
 * recusa, JSON invalido e estrutura invalida.
 */
export async function gerarSemVeto(gerar: Dependencias["gerar"]): Promise<ResultadoComVeto> {
  const chamadas: Chamadas = { completas: 1, correcoes: 0 };
  const saida = await gerar();
  if (saida.recusou) {
    console.error("[generate-prognostic] refusal", { stopDetails: saida.detalheRecusa });
    return { ok: false, status: 502, error: RECUSA_DO_MODELO, chamadas };
  }
  const lido = lerConteudo(saida.texto);
  if (!lido.ok) return { ...lido, chamadas };
  return { ok: true, content: lido.content, chamadas, camposCorrigidos: [] };
}

export async function gerarComVeto(dep: Dependencias): Promise<ResultadoComVeto> {
  const chamadas: Chamadas = { completas: 0, correcoes: 0 };

  const primeira = await dep.gerar();
  chamadas.completas += 1;
  if (primeira.recusou) {
    console.error("[generate-prognostic] refusal", { stopDetails: primeira.detalheRecusa });
    return { ok: false, status: 502, error: RECUSA_DO_MODELO, chamadas };
  }

  const lido = lerConteudo(primeira.texto);
  if (!lido.ok) return { ...lido, chamadas };

  let content = lido.content;
  let violacoes = verificarSaida(content);
  if (violacoes.length === 0) {
    return { ok: true, content, chamadas, camposCorrigidos: [] };
  }

  console.warn("[generate-prognostic] saida violou o veto; pedindo correcao pontual", {
    violacoes: resumirViolacoes(violacoes),
  });

  // MAX_RODADAS_DE_CORRECAO = 1: o laco existe para a constante mandar, nao
  // para o numero crescer sem alguem decidir o custo.
  for (let rodada = 0; rodada < MAX_RODADAS_DE_CORRECAO; rodada++) {
    const pedidos = violacoes;
    const resposta = await dep.corrigir(primeira.texto, montarPedidoDeCorrecao(pedidos));
    chamadas.correcoes += 1;

    const recusaDeCorrecao = (
      error: string,
      detail?: unknown,
      status = 422,
    ): ResultadoComVeto => ({
      ok: false,
      status,
      error,
      detail,
      chamadas,
      violacoes: resumirViolacoes(pedidos),
    });

    if (resposta.recusou) {
      console.error("[generate-prognostic] refusal na correcao", {
        stopDetails: resposta.detalheRecusa,
      });
      return recusaDeCorrecao(RECUSA_DO_MODELO, undefined, 502);
    }

    let bruto: unknown;
    try {
      bruto = JSON.parse(resposta.texto);
    } catch {
      return recusaDeCorrecao(
        "Texto violou as regras de linguagem do Marco Zero e a correção veio ilegível; nada foi gravado.",
      );
    }
    const lidas = correcoesSchema.safeParse(bruto);
    if (!lidas.success) {
      return recusaDeCorrecao(
        "Texto violou as regras de linguagem do Marco Zero e a correção veio fora do formato; nada foi gravado.",
      );
    }

    const pedidosCampos = new Set(pedidos.map((v) => v.campo));
    const devolvidos = lidas.data.correcoes.map((c) => c.campo);
    const completo =
      devolvidos.length === pedidosCampos.size &&
      new Set(devolvidos).size === pedidosCampos.size &&
      devolvidos.every((c) => pedidosCampos.has(c));
    if (!completo) {
      return recusaDeCorrecao(
        "Texto violou as regras de linguagem do Marco Zero e a correção não cobriu exatamente os campos recusados; nada foi gravado.",
      );
    }

    try {
      content = aplicarCorrecoes(content, lidas.data.correcoes);
    } catch (err) {
      return recusaDeCorrecao(
        "Texto violou as regras de linguagem do Marco Zero e a correção não pôde ser aplicada; nada foi gravado.",
        err instanceof Error ? err.message : String(err),
      );
    }

    // O documento corrigido passa pela varredura INTEIRA de novo: a correcao
    // pode ter introduzido violacao nova, e nada anterior vale como aprovacao.
    violacoes = verificarSaida(content);
    if (violacoes.length === 0) {
      return {
        ok: true,
        content,
        chamadas,
        camposCorrigidos: [...pedidosCampos],
      };
    }
  }

  console.error("[generate-prognostic] saida recusada pelo veto apos correcao; nada sera gravado", {
    violacoes: resumirViolacoes(violacoes),
    chamadas,
  });
  return {
    ok: false,
    status: 422,
    error:
      "O texto gerado violou as regras de linguagem do Marco Zero mesmo após uma correção; nada foi gravado.",
    detail: resumirViolacoes(violacoes),
    chamadas,
    violacoes: resumirViolacoes(violacoes),
  };
}
