import { NextResponse } from "next/server";
import type { ResultadoDeAdmin } from "../auth/require-admin";
import {
  DEFINICOES_DE_ERRO,
  novaOcorrencia,
  type TodoCodigoDeErro,
  type CorpoDeErro,
  type DetalhesDeErro,
} from "./codigos";

// Monta a resposta de erro das rotas: status e código vêm de UMA tabela
// (codigos.ts), então duas rotas que enfrentam a mesma condição não têm como
// responder diferente.
//
// `causa` é o que realmente aconteceu (mensagem do banco, erro do GoTrue, código
// do PostgREST). Vai para o LOG junto com a ocorrência e NUNCA para o corpo: o
// host não recebe texto interno de banco; quem investiga acha pela ocorrência.

export function erroHttp(
  codigo: TodoCodigoDeErro,
  opcoes: { causa?: unknown; detalhes?: DetalhesDeErro; error?: string } = {}
): NextResponse<CorpoDeErro> {
  const def = DEFINICOES_DE_ERRO[codigo];
  const ocorrencia = novaOcorrencia();

  if (def.status >= 500) {
    console.error("[erro]", {
      ocorrencia,
      codigo,
      status: def.status,
      causa: opcoes.causa instanceof Error ? opcoes.causa.message : opcoes.causa,
    });
  }

  const corpo: CorpoDeErro = {
    error: opcoes.error ?? def.error,
    code: codigo,
    ocorrencia,
  };
  if (opcoes.detalhes) corpo.detalhes = opcoes.detalhes;
  return NextResponse.json(corpo, { status: def.status });
}

/**
 * A resposta de uma verificação de admin que NÃO autorizou. Recebe o resultado
 * inteiro (e não só o ramo recusado) de propósito: assim a rota escreve
 * `if (!admin.autorizado) { return respostaDeRecusa(admin); }` e o código segue
 * compilando se alguém neutralizar o `if` -- o que a mutação m3 de
 * tests/seguranca-http faz para provar que a suíte percebe a falta do guarda.
 *
 * Os três códigos (AUTH_REQUIRED 401, ADMIN_FORBIDDEN 403, AUTH_UNAVAILABLE 503)
 * nascem em `verificarAdmin()` (lib/auth/require-admin.ts), a única implementação
 * da classificação. A causa vai só para o log.
 */
export function respostaDeRecusa(r: ResultadoDeAdmin): NextResponse<CorpoDeErro> {
  if (r.autorizado) {
    // Inalcançável com o guarda no lugar; se acontecer, é bug, não recusa.
    return erroHttp("INTERNAL_ERROR", { causa: "respostaDeRecusa chamada com administrador autorizado" });
  }
  return erroHttp(r.codigo, { causa: r.causa });
}
