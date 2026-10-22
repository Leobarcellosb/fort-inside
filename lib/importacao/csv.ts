// LEITURA DO ARQUIVO EXPORTADO PELO FORMULARIO (CSV/TSV), sem adivinhacao.
//
// O operador tem em maos o que o Google Forms exporta: um arquivo de texto com o
// cabecalho na primeira linha. Este modulo o transforma em `cabecalhos` e
// `linhas`, que e o que a borda consome. Ele NAO interpreta nada do conteudo: a
// correspondencia coluna -> pergunta e de `casarColunas`, e a de resposta ->
// alternativa e de `mapearResposta`. Aqui so se separa celula de celula.
//
// O QUE E PERMITIDO: aspas de campo (RFC 4180), aspas duplicadas dentro de campo,
// quebra de linha DENTRO de campo entre aspas (resposta de texto longo tem), CRLF,
// e BOM no inicio do arquivo (planilha do Windows traz).
//
// O QUE NAO E PERMITIDO: adivinhar o separador. Um arquivo em que a virgula e
// decimal e o separador e ponto-e-virgula seria lido como uma coluna so, ou como
// vinte, dependendo do palpite -- e o resultado disso nao e erro, e resposta na
// pergunta errada. Quem opera DECLARA o separador, e o padrao e a virgula, que e
// o que o Google Forms exporta.
//
// O QUE TAMBEM NAO E PERMITIDO: completar linha curta com vazio. Uma linha mais
// curta que o cabecalho e arquivo truncado, e preencher o fim com vazio
// transformaria colunas perdidas em respostas ausentes, em silencio, para a
// pessoa daquela linha. As linhas saem como estao e `lerPlanilha` as RECUSA com
// LINHA_CURTA, dizendo qual.
//
// Funcoes puras: sem I/O, sem data/hora.

export type Separador = "," | ";" | "\t";

export const SEPARADORES: { valor: Separador; rotulo: string }[] = [
  { valor: ",", rotulo: "vírgula (padrão do Google Forms)" },
  { valor: ";", rotulo: "ponto e vírgula" },
  { valor: "\t", rotulo: "tabulação" },
];

export interface LinhaCrua {
  /** Numero da linha no arquivo, contando o cabecalho como 1. Para o operador achar. */
  numero: number;
  celulas: string[];
}

export type CodigoDeCsv = "ARQUIVO_VAZIO" | "SO_CABECALHO" | "ASPAS_ABERTAS";

export type LeituraDeCsv =
  | { ok: true; cabecalhos: string[]; linhas: LinhaCrua[] }
  | { ok: false; codigo: CodigoDeCsv; motivo: string };

/** Separa UM texto delimitado em linhas de celulas, respeitando aspas. */
function separar(texto: string, sep: Separador): { linhas: string[][]; aspasAbertas: boolean } {
  const linhas: string[][] = [];
  let celula = "";
  let linha: string[] = [];
  let dentroDeAspas = false;
  let i = 0;

  const fecharCelula = () => {
    linha.push(celula);
    celula = "";
  };
  const fecharLinha = () => {
    fecharCelula();
    linhas.push(linha);
    linha = [];
  };

  while (i < texto.length) {
    const c = texto[i];

    if (dentroDeAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          // Aspas escapadas: valem uma aspa literal.
          celula += '"';
          i += 2;
          continue;
        }
        dentroDeAspas = false;
        i++;
        continue;
      }
      celula += c;
      i++;
      continue;
    }

    if (c === '"' && celula === "") {
      dentroDeAspas = true;
      i++;
      continue;
    }
    if (c === sep) {
      fecharCelula();
      i++;
      continue;
    }
    if (c === "\r") {
      // CRLF ou CR solto: uma quebra.
      fecharLinha();
      i += texto[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (c === "\n") {
      fecharLinha();
      i++;
      continue;
    }
    celula += c;
    i++;
  }

  // O fim do arquivo fecha a ultima linha, se ela tiver algo.
  if (celula !== "" || linha.length > 0) fecharLinha();

  return { linhas, aspasAbertas: dentroDeAspas };
}

/**
 * Le o arquivo exportado. O separador e DECLARADO, nunca inferido.
 *
 * Linhas inteiramente vazias no fim do arquivo (a planilha costuma deixar uma) sao
 * descartadas -- uma linha de uma celula vazia nao e submissao de ninguem. Linha
 * vazia NO MEIO tambem e descartada, pelo mesmo motivo, e nao e tratada como
 * resposta em branco de alguem.
 */
export function lerCsv(conteudo: string, separador: Separador = ","): LeituraDeCsv {
  const texto = conteudo.replace(/^﻿/, "");
  if (texto.trim() === "") {
    return { ok: false, codigo: "ARQUIVO_VAZIO", motivo: "o arquivo nao tem conteudo" };
  }

  const { linhas, aspasAbertas } = separar(texto, separador);
  if (aspasAbertas) {
    // Aspas abertas e nunca fechadas: dali para frente tudo entrou numa celula
    // so. Ler assim atribuiria o resto do arquivo a uma resposta.
    return {
      ok: false,
      codigo: "ASPAS_ABERTAS",
      motivo:
        "o arquivo tem aspas abertas que nunca fecham; dali em diante o conteudo seria lido como uma unica resposta",
    };
  }
  if (linhas.length === 0) {
    return { ok: false, codigo: "ARQUIVO_VAZIO", motivo: "o arquivo nao tem linhas" };
  }

  const cabecalhos = linhas[0];
  const corpo: LinhaCrua[] = [];
  for (let i = 1; i < linhas.length; i++) {
    const celulas = linhas[i];
    const vazia = celulas.every((c) => c.trim() === "");
    if (vazia) continue;
    corpo.push({ numero: i + 1, celulas });
  }

  if (corpo.length === 0) {
    return {
      ok: false,
      codigo: "SO_CABECALHO",
      motivo: "o arquivo tem cabecalho e nenhuma submissao",
    };
  }

  return { ok: true, cabecalhos, linhas: corpo };
}

/**
 * Identificador de submissao de cada linha.
 *
 * O Forms nao exporta id de resposta na planilha, entao ele nao e inventado: ou o
 * operador aponta uma COLUNA que o contenha (o carimbo de data/hora serve, e e
 * unico por resposta na pratica), ou se usa `linha-N`, que e estavel para ESTE
 * arquivo e por isso e declarado assim no identificador -- quem ler a
 * proveniencia depois ve que a origem foi a posicao na planilha, nao um id do
 * formulario, e nao confunde um com o outro.
 */
export function identificarSubmissoes(
  linhas: readonly LinhaCrua[],
  indiceDaColuna: number | null,
): { celulas: unknown[]; submissao_id: string }[] {
  return linhas.map((l) => {
    const daColuna = indiceDaColuna === null ? "" : (l.celulas[indiceDaColuna] ?? "").trim();
    return {
      celulas: l.celulas,
      submissao_id: daColuna !== "" ? daColuna : `linha-${l.numero}`,
    };
  });
}
