// O ROTEIRO DO FORMULARIO IMERSIVO -- a ordem das telas, e o que cada uma exige.
//
// Modulo PURO (sem React, sem DOM), para que as decisoes de desenho fiquem num
// lugar so, testadas em node, e mudar uma delas seja mudar uma constante:
//
//   - UMA PERGUNTA POR TELA, sempre, na ORDEM DO BANCO. (Bloco de tres Likert foi
//     cogitado e revertido pela revisao: tres afirmacoes da mesma dimensao lado a
//     lado estimulam responder por coerencia visual, nao por avaliacao de cada
//     uma.)
//   - QUAIS telas avancam sozinhas (`avancaSozinha`): so a escolha unica (A-D) e
//     a escala LONGA (Elementos, 0 a 10). O Likert (1 a 5) pede selecao explicita
//     e Continuar. Texto e revisao, nunca.
//   - O QUE FALTA numa tela: a regra de obrigatoriedade e a de
//     lib/quiz/obrigatorias.ts -- a MESMA que o servidor reconfere -- mais uma
//     exigencia so de tela (texto feito so de espacos nao conta), que nunca
//     aceita o que o servidor recusaria.
//
// NENHUM texto de pergunta, alternativa, instrucao ou ancora de escala e
// produzido aqui. Tudo vem do banco (quiz_stages); a unica reserva sao os
// rotulos canonicos das pontas da escala, usados so quando a pergunta nao traz
// os proprios -- os mesmos da versao simples, palavra por palavra.

import {
  obrigatoriasEmFalta,
  textoDaFalta,
  type MapaDeRespostas,
  type ValorDeResposta,
} from "../../../../lib/quiz/obrigatorias";
import type { QuizQuestion } from "../../../../types/database";

export interface EtapaImersiva {
  id: number;
  numero: number;
  titulo: string;
  descricao: string | null;
  questions: QuizQuestion[];
}

export interface Identificacao {
  nome: string;
  email: string;
  telefone: string;
}

export const IDENTIFICACAO_VAZIA: Identificacao = { nome: "", email: "", telefone: "" };

/** Atraso entre o toque e a saida da tela, para a pessoa VER o que marcou. */
export const ATRASO_DO_AVANCO_MS = 400;

/** Mesma validacao de e-mail da versao simples (o suficiente para avisar antes). */
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type CampoDeIdentificacao = keyof Identificacao;

export type Tela =
  | { id: "boas-vindas"; tipo: "boas-vindas" }
  | { id: `dado:${CampoDeIdentificacao}`; tipo: "dado"; campo: CampoDeIdentificacao }
  | { id: `abertura:${number}`; tipo: "abertura"; etapa: EtapaImersiva }
  | {
      id: `perguntas:${string}`;
      tipo: "perguntas";
      etapa: EtapaImersiva;
      /**
       * As perguntas desta tela. Hoje sempre UMA; a lista existe para que voltar a
       * agrupar (se a metodologia um dia pedir) seja mudar `montarRoteiro`, nao
       * a tela.
       */
      perguntas: QuizQuestion[];
      /** Posicao (base 1) da primeira pergunta desta tela DENTRO da etapa. */
      primeiroNumero: number;
      /** Escolha unica ou escala longa: avanca ao tocar. */
      avancaSozinha: boolean;
    }
  | { id: "revisao"; tipo: "revisao" };

/** [menor, maior] da escala, com os mesmos padroes da versao simples (0 e 10). */
export function faixaDaEscala(q: QuizQuestion): [number, number] {
  return [q.min ?? 0, q.max ?? 10];
}

/** Escala curta (ate 5 pontos, Likert): selecao explicita + Continuar, transicao discreta. */
export function ehLikert(q: QuizQuestion): boolean {
  if (q.type !== "scale") return false;
  const [menor, maior] = faixaDaEscala(q);
  return maior - menor + 1 <= 5;
}

/** Rotulos canonicos das pontas, por faixa -- reserva, nao substituto. */
const ROTULOS_POR_FAIXA: Record<string, readonly [string, string]> = {
  "1-5": ["Discordo totalmente", "Concordo totalmente"],
  "0-10": ["Totalmente insatisfeito", "Plenamente satisfeito"],
};

export function rotulosDaEscala(q: QuizQuestion): [string | null, string | null] {
  const [menor, maior] = faixaDaEscala(q);
  const reserva = ROTULOS_POR_FAIXA[`${menor}-${maior}`];
  return [q.min_label ?? reserva?.[0] ?? null, q.max_label ?? reserva?.[1] ?? null];
}

/**
 * A letra de uma alternativa ("A. Organizar..." -> "A."), para ser DESTACADA.
 * O texto nao e cortado nem reescrito: `letra + " " + resto` reconstitui a
 * alternativa exata, e e a alternativa exata que vai como resposta. Quando o
 * banco nao traz letra, a tela usa a posicao (A, B, C...) so como tecla de
 * atalho, sem acrescentar nada ao texto.
 */
export function separarLetra(opcao: string): { letra: string; resto: string } | null {
  const m = /^([A-Z])\.\s+/.exec(opcao);
  if (!m) return null;
  return { letra: `${m[1]}.`, resto: opcao.slice(m[0].length) };
}

export function letraDoAtalho(indice: number): string {
  return String.fromCharCode(65 + indice);
}

/** Avanca ao tocar: escolha unica (A-D) e escala longa (0 a 10). Likert, nao. */
export function avancaAoTocar(q: QuizQuestion): boolean {
  if (q.type === "select" || q.type === "dilemma") return true;
  return q.type === "scale" && !ehLikert(q);
}

export function montarRoteiro(etapas: readonly EtapaImersiva[]): Tela[] {
  const telas: Tela[] = [
    { id: "boas-vindas", tipo: "boas-vindas" },
    { id: "dado:nome", tipo: "dado", campo: "nome" },
    { id: "dado:email", tipo: "dado", campo: "email" },
    { id: "dado:telefone", tipo: "dado", campo: "telefone" },
  ];
  for (const etapa of etapas) {
    telas.push({ id: `abertura:${etapa.numero}`, tipo: "abertura", etapa });
    etapa.questions.forEach((q, i) => {
      telas.push({
        id: `perguntas:${q.id}`,
        tipo: "perguntas",
        etapa,
        perguntas: [q],
        primeiroNumero: i + 1,
        avancaSozinha: avancaAoTocar(q),
      });
    });
  }
  telas.push({ id: "revisao", tipo: "revisao" });
  return telas;
}

/**
 * Quanto tempo leva, estimado HONESTAMENTE pelo tipo de cada pergunta (segundos
 * de leitura + resposta num celular). Resposta aberta pesa mais: e onde mora o
 * valor, e escrever no polegar leva tempo. Arredonda para uma faixa de 5 min.
 */
const SEGUNDOS_POR_TIPO: Partial<Record<QuizQuestion["type"], number>> = {
  scale: 8,
  select: 20,
  dilemma: 15,
  short_text: 20,
  text: 75,
  multi_select: 20,
  ranking: 30,
};

export function estimarMinutos(etapas: readonly EtapaImersiva[]): { de: number; ate: number } {
  const segundos = todasAsPerguntas(etapas).reduce(
    (soma, q) => soma + (SEGUNDOS_POR_TIPO[q.type] ?? 20),
    0,
  );
  const de = Math.max(5, Math.floor(segundos / 60 / 5) * 5);
  return { de, ate: de + 5 };
}

/** Respondida? A regra do servidor, mais: texto so de espacos nao conta. */
export function respondida(q: QuizQuestion, valor: ValorDeResposta | undefined): boolean {
  if ((q.type === "short_text" || q.type === "text") && q.required === true) {
    if (typeof valor !== "string" || valor.trim().length === 0) return false;
  }
  return obrigatoriasEmFalta([q], { [q.id]: valor }).length === 0;
}

/**
 * Por que AQUELA pergunta ainda nao vale -- o texto que a tela escreve ao lado
 * dela. Em branco, diz o GESTO que falta (escolher, escrever), que e o que a
 * pessoa precisa fazer; os outros motivos (texto curto demais, ordenacao
 * incompleta) usam o texto do modulo compartilhado com o servidor.
 */
export function motivoDaFalta(q: QuizQuestion, valor: ValorDeResposta | undefined): string | null {
  if (respondida(q, valor)) return null;
  const [falta] = obrigatoriasEmFalta([q], { [q.id]: valor });
  if (falta && falta.motivo !== "em_branco") return textoDaFalta(falta);
  if (q.type === "scale") {
    const [menor, maior] = faixaDaEscala(q);
    return `Escolha um número de ${menor} a ${maior} para continuar.`;
  }
  if (q.type === "select" || q.type === "dilemma") return "Escolha uma alternativa para continuar.";
  if (q.type === "short_text" || q.type === "text") return "Escreva sua resposta para continuar.";
  return "Esta pergunta é obrigatória.";
}

export function todasAsPerguntas(etapas: readonly EtapaImersiva[]): QuizQuestion[] {
  return etapas.flatMap((e) => e.questions);
}

export function contarRespondidas(
  etapas: readonly EtapaImersiva[],
  respostas: MapaDeRespostas,
): { respondidas: number; total: number } {
  const todas = todasAsPerguntas(etapas);
  return {
    respondidas: todas.filter((q) => respondida(q, respostas[q.id])).length,
    total: todas.length,
  };
}

export function erroDeIdentificacao(
  campo: CampoDeIdentificacao,
  identificacao: Identificacao,
): string | null {
  if (campo === "nome" && identificacao.nome.trim().length < 2) {
    return "Escreva seu nome completo (ao menos 2 letras).";
  }
  if (campo === "email" && !EMAIL_VALIDO.test(identificacao.email.trim())) {
    return "Escreva um e-mail válido, como nome@exemplo.com.";
  }
  return null;
}

/** A tela esta completa? Abertura, boas-vindas e revisao nunca bloqueiam. */
export function telaCompleta(
  tela: Tela,
  respostas: MapaDeRespostas,
  identificacao: Identificacao,
): boolean {
  if (tela.tipo === "dado") return erroDeIdentificacao(tela.campo, identificacao) === null;
  if (tela.tipo === "perguntas") return tela.perguntas.every((q) => respondida(q, respostas[q.id]));
  return true;
}

/**
 * A primeira tela que ainda tem algo a responder, ou a revisao. E para onde a
 * pessoa vai ao retomar um rascunho que nao diz a posicao (o da versao simples),
 * e para onde o envio a leva se, por algum motivo, faltar algo.
 */
export function primeiraTelaIncompleta(
  roteiro: readonly Tela[],
  respostas: MapaDeRespostas,
  identificacao: Identificacao,
): number {
  const i = roteiro.findIndex((t) => !telaCompleta(t, respostas, identificacao));
  return i === -1 ? roteiro.length - 1 : i;
}

export function indiceDaPergunta(roteiro: readonly Tela[], questionId: string): number {
  return roteiro.findIndex(
    (t) => t.tipo === "perguntas" && t.perguntas.some((q) => q.id === questionId),
  );
}

export function indiceDaTela(roteiro: readonly Tela[], telaId: string): number {
  return roteiro.findIndex((t) => t.id === telaId);
}

export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? "";
}
