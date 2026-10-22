import type { PrognosticContent } from "@/types/database";
import {
  EXPRESSOES_VETADAS,
} from "../scoring/briefing-marco-zero";
import {
  EXPRESSOES_VETADAS_DIMENSOES,
  validarTextoDeSaida,
  type RecusaDeSaida,
} from "../../components/features/marco-zero/validacao-saida";

// Verificacao da SAIDA do modelo contra o veto do Marco Zero.
//
// A regra deixou de ser instrucao de prompt (que o modelo pode ignorar) e virou
// verificacao em codigo: cada string do documento passa por
// `validarTextoDeSaida` (components/features/marco-zero/validacao-saida.ts, que
// por sua vez usa as expressoes vetadas e o detector de chaves vazadas da camada
// de briefing) ANTES de qualquer gravacao. Este modulo so adapta o formato do
// prognostico a essa funcao; nao define regra nenhuma.
//
// Funcoes puras: sem I/O, sem modelo.

export interface CampoDeTexto {
  /** Caminho no documento, ex.: "areas_chave.1.risco". */
  campo: string;
  texto: string;
}

export interface TrechoRecusado {
  /** Frase (ou o campo inteiro, se a recusa nao se localiza numa frase). */
  trecho: string;
  motivos: string[];
}

export interface Violacao {
  campo: string;
  textoDoCampo: string;
  motivos: string[];
  trechos: TrechoRecusado[];
}

// trilha_recomendada e um enum fechado de produto, nao prosa do modelo.
const CAMPOS_FORA_DA_VARREDURA: ReadonlySet<string> = new Set(["trilha_recomendada"]);

/** Toda string do documento, com o caminho, na ordem do documento. */
export function camposDeTexto(conteudo: PrognosticContent): CampoDeTexto[] {
  const saida: CampoDeTexto[] = [];
  const andar = (valor: unknown, caminho: string) => {
    if (typeof valor === "string") {
      saida.push({ campo: caminho, texto: valor });
    } else if (Array.isArray(valor)) {
      valor.forEach((v, i) => andar(v, `${caminho}.${i}`));
    } else if (valor !== null && typeof valor === "object") {
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
        if (caminho === "" && CAMPOS_FORA_DA_VARREDURA.has(k)) continue;
        andar(v, caminho === "" ? k : `${caminho}.${k}`);
      }
    }
  };
  andar(conteudo, "");
  return saida;
}

// "Direção" e tambem o nome de uma das cinco trilhas do produto (Exploração,
// Direção, Aproximação, Aceleração, Sessão Privada), e o prompt manda citar a
// trilha pelo nome. O varredor trata o radical "direcao" como variacao de
// rotulo, entao sem este tratamento a recomendacao de trilha "Direção" seria
// recusada SEMPRE. A excecao e estreita: so a forma capitalizada, e so fora do
// rotulo aprovado "Visão e Direção". Fica um token de letras (e nao um
// colchete) para que "dimensão Direção" continue sendo pego como nome proprio
// depois de dimensao. A palavra comum "direção", minuscula, segue vetada.
function mascararNomeDeTrilha(texto: string): string {
  return texto.replace(/(?<!Visão e )\bDireção\b/g, "NomeDeTrilha");
}

function recusasDe(texto: string): RecusaDeSaida[] {
  return validarTextoDeSaida(mascararNomeDeTrilha(texto));
}

const MOTIVOS_LEGIVEIS: ReadonlyMap<string, string> = new Map([
  ...EXPRESSOES_VETADAS.map((e) => [e.id, e.motivo] as const),
  ...EXPRESSOES_VETADAS_DIMENSOES.map((e) => [e.id, e.motivo] as const),
  ["nome_fora_do_catalogo", "nome entre aspas que nao e um dos quatro rotulos aprovados nem um dos sete elementos"],
  ["variacao_de_rotulo", "palavra-raiz de dimensao usada fora dos rotulos aprovados"],
  ["nome_proprio_apos_dimensao", "nome proprio depois de 'dimensao'/'eixo'"],
  ["chave_vazada", "chave interna vazou para o texto"],
]);

export function descreverMotivo(id: string): string {
  return MOTIVOS_LEGIVEIS.get(id) ?? id;
}

const unicos = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Violacoes do documento inteiro. Vazio = pode ser gravado.
 * `trechos` localiza a frase culpada para o pedido de correcao; o veredito
 * (haver ou nao violacao) vem sempre do campo inteiro.
 */
export function verificarSaida(conteudo: PrognosticContent): Violacao[] {
  const violacoes: Violacao[] = [];
  for (const { campo, texto } of camposDeTexto(conteudo)) {
    const recusas = recusasDe(texto);
    if (recusas.length === 0) continue;

    const trechos: TrechoRecusado[] = [];
    for (const f of frases(texto)) {
      const r = recusasDe(f);
      if (r.length > 0) trechos.push({ trecho: f, motivos: unicos(r.map((x) => x.motivo)) });
    }
    if (trechos.length === 0) {
      // Recusa que so aparece no campo inteiro (ex.: aspas abertas numa frase e
      // fechadas na seguinte): o trecho e o campo todo.
      trechos.push({ trecho: texto, motivos: unicos(recusas.map((x) => x.motivo)) });
    }
    violacoes.push({
      campo,
      textoDoCampo: texto,
      motivos: unicos(recusas.map((x) => x.motivo)),
      trechos,
    });
  }
  return violacoes;
}

/** Resumo sem texto do participante, proprio para log e para o corpo do erro. */
export function resumirViolacoes(violacoes: readonly Violacao[]): { campo: string; motivos: string[] }[] {
  return violacoes.map((v) => ({ campo: v.campo, motivos: v.motivos }));
}

/**
 * Troca o texto de campos existentes, sem mexer em mais nada. Lanca se o
 * caminho nao existe ou nao aponta para uma string: correcao nunca CRIA campo.
 */
export function aplicarCorrecoes(
  conteudo: PrognosticContent,
  correcoes: readonly { campo: string; texto: string }[],
): PrognosticContent {
  const copia = JSON.parse(JSON.stringify(conteudo)) as PrognosticContent;
  for (const { campo, texto } of correcoes) {
    const partes = campo.split(".");
    let alvo: unknown = copia;
    for (const p of partes.slice(0, -1)) {
      alvo = (alvo as Record<string, unknown> | undefined)?.[p];
    }
    const ultimo = partes[partes.length - 1];
    if (
      alvo === null ||
      typeof alvo !== "object" ||
      typeof (alvo as Record<string, unknown>)[ultimo] !== "string"
    ) {
      throw new Error(`Correcao aponta para campo inexistente ou que nao e texto: ${campo}`);
    }
    (alvo as Record<string, unknown>)[ultimo] = texto;
  }
  return copia;
}
