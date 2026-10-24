// O CONTEUDO DO DOCUMENTO TEM FORMA UTILIZAVEL? (CTO, Rodada 86)
//
// O PROBLEMA
// ----------
// A tela de revisao abre o documento com `edited_content ?? raw_ai_output` e o
// entrega ao editor como se fosse sempre um `PrognosticContent` completo. Era uma
// afirmacao so do tipo: o banco guarda JSON, e dado antigo de teste (linha vazia,
// `{}`, sem secoes, ou com a forma de outra epoca) chegava ao editor, que fazia
// `content.areas_chave.map(...)` e derrubava a pagina inteira, com os outros
// documentos do evento junto.
//
// A REGRA ADOTADA
// ---------------
// FALHAR SEGURO E DEIXAR DIAGNOSTICAR. Documento sem forma utilizavel:
//   - nao abre o editor (o editor mostra o aviso no lugar do formulario);
//   - nao pode ser aprovado (salvar) nem entregue;
//   - NAO e reconstruido: nenhuma secao e inventada, nenhum texto de
//     preenchimento vai para o banco. Consertar o dado e decisao de gente, e o
//     aviso diz QUAIS partes faltam justamente para isso ser possivel.
//
// A forma e a mesma nos dois produtos (v1 com PDF e Marco Zero v2 sem PDF): so o
// que a tela diz muda (textos-da-revisao.ts), nao o formato do documento.
//
// POR QUE NAO REUSAR O SCHEMA ESTRITO DA ROTA PATCH
// -------------------------------------------------
// O schema da rota exige `min(1)` em todo texto. Aqui a pergunta e outra: "isto
// abre no editor sem quebrar e o operador consegue corrigi-lo?". Um campo de texto
// em branco abre e se conserta digitando; uma secao que nao e lista nao abre. A
// rota continua sendo quem recusa texto em branco na hora de gravar, entao esta
// funcao e mais larga que ela de proposito e nunca mais frouxa na parte que quebra.
// Unica excecao de texto: a analise geral precisa ter conteudo, porque ela e o
// corpo do documento; sem ela o que sobra e uma casca.
//
// Tudo aqui e funcao pura (sem rede, sem React) para poder ser provado em teste.

import type { PrognosticContent } from "@/types/database";
import {
  situacaoDaEntrega,
  type SituacaoDaEntrega,
} from "./entrega-do-documento";

/**
 * O texto que o operador le quando o documento nao tem conteudo utilizavel.
 * Sem travessao: o dono proibiu nos textos que as pessoas leem.
 */
export const TEXTO_CONTEUDO_INDISPONIVEL =
  "O conteúdo deste documento não está disponível ou está em um formato inválido. Por isso ele não pode ser editado, aprovado nem entregue. Nada foi alterado nem reconstruído. Avise a equipe técnica para conferir este documento.";

export type ConteudoDoDocumento =
  | { valido: true; conteudo: PrognosticContent }
  | {
      valido: false;
      /** Quais partes faltam ou estao erradas, em palavras de quem opera. */
      problemas: string[];
      texto: string;
    };

const TRILHAS_VALIDAS: readonly string[] = [
  "Exploração",
  "Direção",
  "Aproximação",
  "Aceleração",
  "Sessão Privada",
];

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ehTexto(v: unknown): v is string {
  return typeof v === "string";
}

/** Lista nao vazia em que todo item passa em `itemOk`. Lista vazia e "sem secao". */
function listaDe(v: unknown, itemOk: (item: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(itemOk);
}

function camposTexto(item: unknown, campos: readonly string[]): boolean {
  return ehObjeto(item) && campos.every((c) => ehTexto(item[c]));
}

/**
 * O documento tem a forma que o editor e a entrega esperam?
 *
 * Recebe `unknown` DE PROPOSITO: o tipo `PrognosticContent` da coluna e uma
 * promessa que o banco nao cumpre para linhas antigas. Devolve o conteudo ja
 * estreitado no caso valido, para quem chama nao precisar de cast.
 */
export function conteudoDoDocumentoValido(bruto: unknown): ConteudoDoDocumento {
  if (!ehObjeto(bruto) || Object.keys(bruto).length === 0) {
    return {
      valido: false,
      problemas: ["o documento está vazio"],
      texto: TEXTO_CONTEUDO_INDISPONIVEL,
    };
  }

  const problemas: string[] = [];

  if (!ehTexto(bruto.analise_geral) || bruto.analise_geral.trim() === "") {
    problemas.push("falta a análise geral");
  }
  if (
    !listaDe(bruto.areas_chave, (a) =>
      camposTexto(a, ["nome", "diagnostico", "risco", "movimento"]),
    )
  ) {
    problemas.push("faltam as áreas-chave");
  }
  if (
    !listaDe(
      bruto.plano_30_dias,
      (p) =>
        camposTexto(p, ["titulo", "acao", "resultado_esperado"]) &&
        listaDe((p as Record<string, unknown>).objetivos, ehTexto),
    )
  ) {
    problemas.push("falta o plano de 30 dias");
  }
  if (!listaDe(bruto.praticas, (p) => camposTexto(p, ["nome", "descricao"]))) {
    problemas.push("faltam os pilares");
  }
  if (
    !camposTexto(bruto.frase_ativacao, [
      "frase",
      "contexto",
      "aplicacao",
      "pergunta_pratica",
    ])
  ) {
    problemas.push("falta a frase de ativação");
  }
  if (
    !ehTexto(bruto.trilha_recomendada) ||
    !TRILHAS_VALIDAS.includes(bruto.trilha_recomendada)
  ) {
    problemas.push("falta a trilha recomendada");
  }
  if (!ehTexto(bruto.justificativa_trilha)) {
    problemas.push("falta a justificativa da trilha");
  }

  if (problemas.length > 0) {
    return { valido: false, problemas, texto: TEXTO_CONTEUDO_INDISPONIVEL };
  }
  return { valido: true, conteudo: bruto as unknown as PrognosticContent };
}

/**
 * O conteudo que a tela de revisao usa para um documento: o mesmo
 * `edited_content ?? raw_ai_output` de sempre, agora conferido.
 */
export function conteudoDaLinha(linha: {
  edited_content?: unknown;
  raw_ai_output?: unknown;
}): ConteudoDoDocumento {
  return conteudoDoDocumentoValido(linha.edited_content ?? linha.raw_ai_output);
}

/**
 * A entrega deste documento esta liberada? Soma a pergunta do CONTEUDO a
 * `situacaoDaEntrega` (selo de aprovacao e suspensao).
 *
 * O conteudo e conferido PRIMEIRO: um documento sem conteudo utilizavel nao tem
 * caminho de volta por "abra em Editar e salve" (o editor nem abre o formulario),
 * entao dizer essa frase seria mandar o operador para um beco. A razao certa e a
 * do conteudo. Para documento valido o resultado e exatamente o de antes.
 */
export function situacaoDaEntregaDoDocumento(linha: {
  status?: string | null;
  conteudo_aprovado_hash?: string | null;
  edited_content?: unknown;
  raw_ai_output?: unknown;
}): SituacaoDaEntrega {
  const conteudo = conteudoDaLinha(linha);
  if (!conteudo.valido) {
    return {
      liberada: false,
      motivo: "conteudo_indisponivel",
      texto: conteudo.texto,
    };
  }
  return situacaoDaEntrega(linha);
}
