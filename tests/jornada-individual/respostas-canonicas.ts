// As 52 respostas de um participante, montadas a partir do QUESTIONARIO
// CANONICO publicado (`docs/questionario-v2-canonico.json`), no formato que a
// TELA grava.
//
// POR QUE A FONTE E O CANONICO, E NAO UM FIXTURE
// ----------------------------------------------
// `lib/ai/fixtures-marco-zero.ts` ja tem respostas sinteticas, mas elas
// descrevem o instrumento como o MOTOR o espera. Esta prova precisa do caminho
// inverso: partir do instrumento que o produto publicou (com impressao digital
// SHA-256 conferivel, ver `impressaoCanonica`) e produzir exatamente o que a
// tela escreveria. Se o questionario mudar sem a impressao mudar, ou vice-versa,
// esta prova para de montar respostas e a cadeia falha alto.
//
// O FORMATO DE CADA TIPO E O DA TELA, nao o do motor
// (`app/(participant)/quiz/[stageId]/page.tsx`, funcao `allValid`):
//   scale      -> number
//   select     -> string, o TEXTO INTEIRO da opcao ("A. Organizar o ...")
//   text       -> string nao vazia (respeitando min_chars quando houver)
//   short_text -> string nao vazia
// A situacional gravada como texto e o defeito historico desta cadeia: o motor
// le so a letra. Montar aqui como a tela monta e o que faz a prova medir a
// normalizacao de borda (`lib/scoring/achatar-respostas.ts`) em vez de passar
// por cima dela.

import { createHash } from "node:crypto";
import canonico from "../../docs/questionario-v2-canonico.json";

export interface PerguntaCanonica {
  id: string;
  text: string;
  type: string;
  required: boolean;
  options: string[] | null;
  min: number | null;
  max: number | null;
  min_label: string | null;
  max_label: string | null;
  min_chars: number | null;
  max_chars: number | null;
}

export interface EtapaCanonica {
  n: number;
  t: string;
  q: PerguntaCanonica[];
}

/** Impressao publicada em `docs/FORMULARIO-MARCO-ZERO.md` para a versao 2. */
export const IMPRESSAO_PUBLICADA =
  "859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b";

/**
 * As 5 etapas canonicas, na ordem em que o documento as publica.
 *
 * O arquivo e um ARRAY de etapas, e a ordem do array E a ordem que entra na
 * impressao digital: nao se reordena nada aqui.
 */
export const ETAPAS_CANONICAS: readonly EtapaCanonica[] =
  canonico as unknown as EtapaCanonica[];

/**
 * Reproduz a impressao do manifesto (mesmo algoritmo de
 * `lib/importacao/manifesto-questionario.ts`: SHA-256 do JSON.stringify do
 * array de etapas). Reimplementado em uma linha de proposito: importar o
 * modulo de `lib/importacao/**` aqui acoplaria esta prova a uma arvore que
 * outra frente esta mexendo agora.
 */
export function impressaoCanonica(): string {
  return createHash("sha256")
    .update(JSON.stringify(ETAPAS_CANONICAS), "utf8")
    .digest("hex");
}

export type ValorDeResposta = string | number | string[];
export type RespostasDaEtapa = Record<string, ValorDeResposta>;

/** Um texto longo o bastante para qualquer `min_chars` do questionario. */
function textoLongo(id: string, minChars: number | null): string {
  const base =
    `Resposta de prova para ${id}. ` +
    "Escrevo aqui o que de fato me ocupa hoje: a decisao sobre continuar na " +
    "presidencia da associacao, que ja adiei duas vezes, e o efeito disso na " +
    "minha agenda e na minha familia. Quero sair do Marco Zero com um critério " +
    "para decidir, nao com mais uma lista de intencoes. ";
  const alvo = Math.max(minChars ?? 0, 1);
  let t = base;
  while (t.length < alvo) t += base;
  return t;
}

/**
 * Valor que a TELA gravaria para uma pergunta, dentro do dominio declarado.
 *
 * `escala` escolhe o valor das perguntas `scale`: um numero no meio da faixa
 * por padrao. `situacional` escolhe o indice da alternativa (0 = "A. ...").
 */
export function valorDaTela(
  q: PerguntaCanonica,
  opcoes?: { escala?: (q: PerguntaCanonica) => number; situacional?: number },
): ValorDeResposta {
  switch (q.type) {
    case "scale": {
      if (opcoes?.escala) return opcoes.escala(q);
      const min = q.min ?? 0;
      const max = q.max ?? 10;
      return Math.round((min + max) / 2);
    }
    case "select":
    case "dilemma": {
      const lista = q.options ?? [];
      if (lista.length === 0) throw new Error(`pergunta ${q.id} e select sem options`);
      return lista[(opcoes?.situacional ?? 0) % lista.length];
    }
    case "multi_select":
      return [(q.options ?? ["sem opcao"])[0]];
    case "ranking":
      return [...(q.options ?? [])];
    case "short_text":
      return `Resposta curta de prova (${q.id})`;
    case "text":
      return textoLongo(q.id, q.min_chars);
    default:
      throw new Error(`tipo de pergunta nao previsto nesta prova: ${q.type} (${q.id})`);
  }
}

export interface OpcoesDoQuestionario {
  /** Valor das perguntas `scale`; recebe a pergunta para ver min/max. */
  escala?: (q: PerguntaCanonica) => number;
  /** Indice da alternativa situacional (0=A, 1=B, 2=C, 3=D). */
  situacional?: (q: PerguntaCanonica, i: number) => number;
  /** Perguntas a OMITIR (para medir resposta parcial). */
  omitir?: ReadonlySet<string>;
  /** Valores a sobrescrever cruamente (para medir valor fora do dominio). */
  sobrescrever?: Record<string, ValorDeResposta>;
}

/**
 * As 5 etapas de respostas, no formato de `quiz_responses.answers`: um objeto
 * por etapa, com `id da pergunta -> valor`. Devolve na ordem canonica
 * (`n` 1..5), sem decidir `stage_id`: quem grava casa `n` com o `stage_id` real
 * lido de `quiz_stages`, porque o id e do banco e nao do documento.
 */
export function respostasCanonicas(
  opcoes: OpcoesDoQuestionario = {},
): { n: number; answers: RespostasDaEtapa }[] {
  let iSituacional = 0;
  return ETAPAS_CANONICAS.map((etapa) => {
    const answers: RespostasDaEtapa = {};
    for (const q of etapa.q) {
      if (opcoes.omitir?.has(q.id)) continue;
      if (opcoes.sobrescrever && q.id in opcoes.sobrescrever) {
        answers[q.id] = opcoes.sobrescrever[q.id];
        continue;
      }
      const situacional =
        q.type === "select" || q.type === "dilemma"
          ? (opcoes.situacional?.(q, iSituacional++) ?? iSituacional++ % 4)
          : undefined;
      answers[q.id] = valorDaTela(q, { escala: opcoes.escala, situacional });
    }
    return { n: etapa.n, answers };
  });
}

/** Quantas perguntas o questionario canonico tem (esperado: 52). */
export const TOTAL_DE_PERGUNTAS = ETAPAS_CANONICAS.reduce((a, e) => a + e.q.length, 0);
