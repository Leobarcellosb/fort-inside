// A BORDA DA TELA do Guia de Preparacao do Facilitador: pede o guia a
// /api/marco-zero/guia-facilitador e traduz a resposta para o que o host le.
//
// Funcao pura com `fetch` injetado: a tela nao interpreta status HTTP e nao
// exibe o `error` do corpo (texto do servidor, que pode vir do banco). Quem
// decide a mensagem e o CODIGO, traduzido por `mensagemParaHost`
// (lib/erros/mensagens-host.ts) -- o mesmo caminho das outras telas do host.
//
// As TRES CLASSES de desfecho, e por que nao sao duas:
//   gerado     -> o guia veio, com o hash do conteudo;
//   recusado   -> o servidor VERIFICOU e nao gerou (ha DNA publicado; ou os
//                 dados nao fecham). Ha o que conferir;
//   bloqueado  -> NAO deu para verificar (estado do DNA indeterminado, cobertura
//                 sem resposta, login fora do ar). Nao ha o que corrigir: e
//                 esperar. Chamar isso de recusa manda o host procurar um DNA
//                 que talvez nao exista.

import {
  ehCodigoDeErro,
  type CodigoDeErro,
} from "../../../lib/erros/codigos";
import { MENSAGEM_GENERICA, mensagemParaHost } from "../../../lib/erros/mensagens-host";
import type { ParticipacaoVerificada } from "./guia-facilitador-modelo";

export const MENSAGEM_SEM_CONEXAO =
  "Não foi possível falar com o servidor agora. Nenhum guia foi gerado. Confira a conexão e tente de novo.";

/** Códigos que são "não deu para verificar". Bloqueiam, e não são recusa. */
const BLOQUEIO: readonly CodigoDeErro[] = [
  "GUIDE_DNA_STATE_UNVERIFIABLE",
  "COVERAGE_UNAVAILABLE",
  "INVITE_COUNT_UNDETERMINED",
  "AUTH_UNAVAILABLE",
  "PARTICIPANTS_UNAVAILABLE",
  "QUIZ_STAGES_UNAVAILABLE",
  "QUIZ_STAGES_INVALID",
];

export interface GuiaRecebido {
  conteudo_sha256: string;
  motivo_sem_dna: string;
  populacoes: ParticipacaoVerificada;
  acesso_individual: { idsLiberados: readonly string[] };
  texto: string;
}

export type DesfechoDoGuia =
  | { tipo: "gerado"; guia: GuiaRecebido }
  | { tipo: "recusado"; codigo: CodigoDeErro; mensagem: string; ocorrencia: string | null }
  | { tipo: "bloqueado"; codigo: CodigoDeErro; mensagem: string; ocorrencia: string | null }
  | { tipo: "erro_inesperado"; mensagem: string; ocorrencia: string | null }
  | { tipo: "sem_conexao"; mensagem: string };

const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

function ocorrenciaDe(corpo: Record<string, unknown>): string | null {
  const o = corpo.ocorrencia;
  return typeof o === "string" && ID_VALIDO.test(o) ? o : null;
}

function guiaValido(corpo: Record<string, unknown>): GuiaRecebido | null {
  if (corpo.ok !== true) return null;
  const { conteudo_sha256, texto, motivo_sem_dna, populacoes, acesso_individual } = corpo;
  if (typeof conteudo_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(conteudo_sha256)) return null;
  if (typeof texto !== "string" || texto.length === 0) return null;
  if (typeof motivo_sem_dna !== "string") return null;
  if (populacoes === null || typeof populacoes !== "object") return null;
  const ids = (acesso_individual as { idsLiberados?: unknown } | null)?.idsLiberados;
  return {
    conteudo_sha256,
    texto,
    motivo_sem_dna,
    populacoes: populacoes as ParticipacaoVerificada,
    acesso_individual: { idsLiberados: Array.isArray(ids) ? (ids as string[]) : [] },
  };
}

export async function pedirGuiaDoFacilitador(
  eventId: string,
  buscar: typeof fetch = fetch,
): Promise<DesfechoDoGuia> {
  let res: Response;
  try {
    res = await buscar("/api/marco-zero/guia-facilitador", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId }),
    });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }

  let corpo: Record<string, unknown> = {};
  try {
    corpo = (await res.json()) as Record<string, unknown>;
  } catch {
    corpo = {};
  }

  if (res.ok) {
    const guia = guiaValido(corpo);
    if (guia) return { tipo: "gerado", guia };
    return {
      tipo: "erro_inesperado",
      mensagem: MENSAGEM_GENERICA,
      ocorrencia: ocorrenciaDe(corpo),
    };
  }

  const codigo = corpo.code;
  if (!ehCodigoDeErro(codigo)) {
    return {
      tipo: "erro_inesperado",
      mensagem: MENSAGEM_GENERICA,
      ocorrencia: ocorrenciaDe(corpo),
    };
  }
  return {
    tipo: BLOQUEIO.includes(codigo) ? "bloqueado" : "recusado",
    codigo,
    mensagem: mensagemParaHost(codigo),
    ocorrencia: ocorrenciaDe(corpo),
  };
}
