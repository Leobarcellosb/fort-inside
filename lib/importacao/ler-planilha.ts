// DA PLANILHA DO FORMULARIO PARA SUBMISSOES EXTERNAS.
//
// O Google Forms nao exporta ids de pergunta: exporta uma planilha em que o
// CABECALHO DE CADA COLUNA E O ENUNCIADO DA PERGUNTA, copiado como esta no
// formulario. Ou seja, a correspondencia coluna -> pergunta e, ela mesma, uma
// correspondencia de texto exato -- e e o segundo lugar onde "uma palavra
// trocada" apaga dado.
//
// A impressao digital do manifesto pega o caso em que o questionario inteiro
// divergiu. Este arquivo pega o caso mais rasteiro: o manifesto bate, mas a
// coluna da planilha foi renomeada a mao, ou uma coluna sobrou, ou falta uma. A
// regra e a mesma: NAO SE ADIVINHA. Coluna que nao casa exatamente com um
// enunciado do manifesto e RELATADA, nunca atribuida a pergunta mais parecida.
//
// O QUE E PERMITIDO: aparar espaco nas pontas do cabecalho (planilha costuma
// trazer espaco sobrando) e reconhecer as colunas PROPRIAS do formulario
// (carimbo de data/hora, e-mail), que nao sao perguntas do questionario.
//
// O QUE NAO E PERMITIDO: casar sem diferenciar caixa, ignorar acento ou
// pontuacao, casar por prefixo, casar pela coluna na POSICAO esperada, ou casar
// "a unica que sobrou". Qualquer uma dessas transforma um erro de copia numa
// resposta atribuida a pergunta errada -- pior que dado faltando, porque pontua.
//
// Funcoes puras: sem I/O, sem data/hora. Quem le o arquivo e quem chama.

import type { ManifestoQuestionario } from "./manifesto-questionario";
import type { SubmissaoExterna } from "./reconciliar-identidade";

/**
 * Cabecalhos que o Google Forms gera por conta propria, em portugues e em
 * ingles. Sao DECLARADOS aqui, nao inferidos: uma coluna so e tratada como
 * metadado se for exatamente uma destas, ou se quem chama disser qual e.
 */
export const COLUNAS_DE_METADADO = {
  carimbo: ["Carimbo de data/hora", "Timestamp"],
  email: ["Endereço de e-mail", "Endereco de e-mail", "Email Address", "Email address"],
} as const;

export type PapelDaColuna = "pergunta" | "carimbo" | "email" | "desconhecida";

export interface ColunaCasada {
  cabecalho: string;
  indice: number;
  papel: PapelDaColuna;
  /** Preenchido so quando `papel === "pergunta"`. */
  pergunta_id: string | null;
}

export interface ResultadoDoCasamento {
  colunas: ColunaCasada[];
  /** pergunta_id -> indice da coluna. */
  porPerguntaId: Record<string, number>;
  /** Cabecalhos que nao casaram com NADA. Nunca atribuidos a chute. */
  desconhecidos: ColunaCasada[];
  /** Perguntas do manifesto que NAO tem coluna na planilha. */
  perguntasSemColuna: string[];
  /** Enunciados que aparecem em mais de uma coluna: ambiguo, nao se escolhe. */
  cabecalhosDuplicados: string[];
  indiceDoEmail: number | null;
  indiceDoCarimbo: number | null;
}

export type CasamentoDeColunas =
  | { ok: true; casamento: ResultadoDoCasamento }
  | { ok: false; codigo: CodigoDeCasamento; motivo: string; casamento: ResultadoDoCasamento };

export type CodigoDeCasamento =
  /** Uma coluna nao casou com nenhuma pergunta nem com metadado conhecido. */
  | "COLUNA_DESCONHECIDA"
  /** Duas colunas trazem o mesmo enunciado: nao se escolhe uma. */
  | "COLUNA_AMBIGUA"
  /** Falta coluna de pergunta do manifesto. */
  | "COLUNA_FALTANDO"
  /** Sem coluna de e-mail nao ha reconciliacao possivel (regra 6). */
  | "EMAIL_SEM_COLUNA";

export interface OpcoesDoCasamento {
  /** Cabecalho exato da coluna de e-mail, quando nao e um dos conhecidos. */
  cabecalhoDoEmail?: string;
  /** Cabecalho exato da coluna de carimbo, quando nao e um dos conhecidos. */
  cabecalhoDoCarimbo?: string;
  /**
   * Cabecalhos que quem opera DECLARA como extras a ignorar (ex.: uma coluna de
   * controle da equipe). Tem de ser declarados um por um: nao existe "ignorar o
   * que nao casou".
   */
  ignorar?: readonly string[];
  /**
   * Aceitar planilha com pergunta faltando. O padrao e NAO aceitar: coluna que
   * falta vira resposta ausente para TODO MUNDO, e isso tem de ser uma decisao
   * consciente, nao um silencio.
   */
  tolerarPerguntaFaltando?: boolean;
}

/**
 * Casa os cabecalhos da planilha com as perguntas do manifesto, por texto
 * EXATO (so trim).
 *
 * Devolve `ok: false` com o diagnostico completo em vez de lancar: quem opera
 * precisa ver TODAS as divergencias de uma vez, nao a primeira.
 */
export function casarColunas(
  manifesto: ManifestoQuestionario,
  cabecalhos: readonly string[],
  opcoes: OpcoesDoCasamento = {},
): CasamentoDeColunas {
  // Indice enunciado exato -> ids. Lista, porque enunciado repetido no
  // questionario tornaria a coluna ambigua, e isso tem de aparecer.
  const porEnunciado = new Map<string, string[]>();
  for (const p of manifesto.perguntas) {
    const chave = p.text.trim();
    const atual = porEnunciado.get(chave);
    if (atual === undefined) porEnunciado.set(chave, [p.id]);
    else atual.push(p.id);
  }

  const ignorar = new Set((opcoes.ignorar ?? []).map((s) => s.trim()));
  const emailsConhecidos = new Set<string>([
    ...COLUNAS_DE_METADADO.email,
    ...(opcoes.cabecalhoDoEmail ? [opcoes.cabecalhoDoEmail.trim()] : []),
  ]);
  const carimbosConhecidos = new Set<string>([
    ...COLUNAS_DE_METADADO.carimbo,
    ...(opcoes.cabecalhoDoCarimbo ? [opcoes.cabecalhoDoCarimbo.trim()] : []),
  ]);

  const colunas: ColunaCasada[] = [];
  const porPerguntaId: Record<string, number> = {};
  const desconhecidos: ColunaCasada[] = [];
  const duplicados: string[] = [];
  let indiceDoEmail: number | null = null;
  let indiceDoCarimbo: number | null = null;

  cabecalhos.forEach((bruto, indice) => {
    const cabecalho = bruto.trim();

    if (ignorar.has(cabecalho)) {
      colunas.push({ cabecalho, indice, papel: "desconhecida", pergunta_id: null });
      return;
    }
    if (emailsConhecidos.has(cabecalho)) {
      if (indiceDoEmail === null) indiceDoEmail = indice;
      colunas.push({ cabecalho, indice, papel: "email", pergunta_id: null });
      return;
    }
    if (carimbosConhecidos.has(cabecalho)) {
      if (indiceDoCarimbo === null) indiceDoCarimbo = indice;
      colunas.push({ cabecalho, indice, papel: "carimbo", pergunta_id: null });
      return;
    }

    const ids = porEnunciado.get(cabecalho);
    if (ids === undefined) {
      const col: ColunaCasada = { cabecalho, indice, papel: "desconhecida", pergunta_id: null };
      colunas.push(col);
      desconhecidos.push(col);
      return;
    }
    if (ids.length > 1) {
      duplicados.push(cabecalho);
      colunas.push({ cabecalho, indice, papel: "desconhecida", pergunta_id: null });
      return;
    }
    const id = ids[0];
    if (porPerguntaId[id] !== undefined) {
      // A MESMA pergunta em duas colunas. "A primeira vale" seria escolher uma
      // das duas sem saber qual: DESFAZ a ligacao que ja havia, para a pergunta
      // ficar sem coluna e a ambiguidade aparecer inteira.
      duplicados.push(cabecalho);
      delete porPerguntaId[id];
      const anterior = colunas.find((c) => c.pergunta_id === id);
      if (anterior !== undefined) {
        anterior.papel = "desconhecida";
        anterior.pergunta_id = null;
      }
      colunas.push({ cabecalho, indice, papel: "desconhecida", pergunta_id: null });
      return;
    }
    porPerguntaId[id] = indice;
    colunas.push({ cabecalho, indice, papel: "pergunta", pergunta_id: id });
  });

  const perguntasSemColuna = manifesto.perguntas
    .map((p) => p.id)
    .filter((id) => porPerguntaId[id] === undefined);

  const casamento: ResultadoDoCasamento = {
    colunas,
    porPerguntaId,
    desconhecidos,
    perguntasSemColuna,
    cabecalhosDuplicados: [...new Set(duplicados)],
    indiceDoEmail,
    indiceDoCarimbo,
  };

  if (casamento.cabecalhosDuplicados.length > 0) {
    return {
      ok: false,
      codigo: "COLUNA_AMBIGUA",
      motivo: `${casamento.cabecalhosDuplicados.length} enunciado(s) aparecem em mais de uma coluna: ${casamento.cabecalhosDuplicados.join(" | ")}. Nao se escolhe uma das colunas`,
      casamento,
    };
  }
  if (desconhecidos.length > 0) {
    return {
      ok: false,
      codigo: "COLUNA_DESCONHECIDA",
      motivo: `${desconhecidos.length} coluna(s) nao casam com nenhum enunciado do questionario do sistema (nao se atribui a pergunta mais parecida): ${desconhecidos.map((c) => JSON.stringify(c.cabecalho)).join(" | ")}`,
      casamento,
    };
  }
  if (indiceDoEmail === null) {
    return {
      ok: false,
      codigo: "EMAIL_SEM_COLUNA",
      motivo:
        "a planilha nao tem coluna de e-mail. A reconciliacao de identidade e por e-mail verificado; sem ela nao se importa nada",
      casamento,
    };
  }
  if (perguntasSemColuna.length > 0 && opcoes.tolerarPerguntaFaltando !== true) {
    return {
      ok: false,
      codigo: "COLUNA_FALTANDO",
      motivo: `o questionario tem ${perguntasSemColuna.length} pergunta(s) sem coluna na planilha: ${perguntasSemColuna.join(", ")}. Isso viraria resposta ausente para TODA a turma, e tem de ser decisao consciente`,
      casamento,
    };
  }

  return { ok: true, casamento };
}

export interface LinhaDaPlanilha {
  /** As celulas, na mesma ordem dos cabecalhos. */
  celulas: readonly unknown[];
  /**
   * Identificador da submissao. O Forms nao exporta um id de resposta, entao
   * quem opera informa o que usar (numero da linha, carimbo, ou o id da
   * resposta quando vem pela API). NAO e inventado aqui: sem identificador nao
   * ha proveniencia (regra 4).
   */
  submissao_id: string;
}

export type CodigoDeLeitura = "SUBMISSAO_SEM_ID" | "LINHA_CURTA";

export type LeituraDaPlanilha =
  | { ok: true; submissoes: SubmissaoExterna[] }
  | { ok: false; codigo: CodigoDeLeitura; motivo: string; linha: number };

/**
 * Transforma as linhas da planilha em submissoes externas, usando um casamento
 * de colunas JA aprovado.
 *
 * `emailVerificado` e informado por quem opera, por lote: o Forms so garante a
 * posse do e-mail quando o formulario foi configurado com respondentes
 * restritos e e-mail verificado, e a planilha NAO carrega essa configuracao. Por
 * isso nao se presume `true`: quem declara e quem sabe como o formulario foi
 * configurado, e fica registrado na proveniencia. O padrao e `false`, que leva
 * tudo para PENDENTE -- seguro, visivel, e corrigivel.
 */
export function lerPlanilha(
  casamento: ResultadoDoCasamento,
  linhas: readonly LinhaDaPlanilha[],
  opcoes: { emailVerificado?: boolean; colunaDoNome?: string } = {},
): LeituraDaPlanilha {
  const verificado = opcoes.emailVerificado === true;
  const indiceDoNome =
    opcoes.colunaDoNome !== undefined
      ? (casamento.porPerguntaId[opcoes.colunaDoNome] ?? null)
      : null;

  const submissoes: SubmissaoExterna[] = [];
  const maiorIndice = Math.max(
    casamento.indiceDoEmail ?? 0,
    ...Object.values(casamento.porPerguntaId),
  );

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (typeof linha.submissao_id !== "string" || linha.submissao_id.trim() === "") {
      return {
        ok: false,
        codigo: "SUBMISSAO_SEM_ID",
        motivo:
          "linha sem identificador de submissao. Sem identificador nao ha proveniencia, e sem proveniencia nao se importa",
        linha: i,
      };
    }
    if (linha.celulas.length <= maiorIndice) {
      // Linha mais curta que o cabecalho: as colunas do fim seriam lidas como
      // ausentes sem ninguem notar. E corrupcao de arquivo, nao resposta vazia.
      return {
        ok: false,
        codigo: "LINHA_CURTA",
        motivo: `a linha tem ${linha.celulas.length} celulas e o cabecalho vai ate a posicao ${maiorIndice}. Ler assim transformaria colunas truncadas em respostas ausentes`,
        linha: i,
      };
    }

    const respostas: Record<string, unknown> = {};
    for (const [id, indice] of Object.entries(casamento.porPerguntaId)) {
      respostas[id] = linha.celulas[indice];
    }

    const emailBruto =
      casamento.indiceDoEmail === null ? null : linha.celulas[casamento.indiceDoEmail];

    submissoes.push({
      submissao_id: linha.submissao_id.trim(),
      email: typeof emailBruto === "string" ? emailBruto : null,
      email_verificado: verificado,
      nome_declarado:
        indiceDoNome === null
          ? null
          : typeof linha.celulas[indiceDoNome] === "string"
            ? (linha.celulas[indiceDoNome] as string)
            : null,
      respostas,
    });
  }

  return { ok: true, submissoes };
}
