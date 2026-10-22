import Anthropic from "@anthropic-ai/sdk";

// TESTE DA IA ANTES DE PROCESSAR (Rodadas 70 e 71 do CTO).
//
// Antes de colocar 50 documentos na fila, uma chamada REAL e minima, feita pelo
// SERVIDOR com a mesma configuracao que vai gerar os documentos: mesma chave
// (ANTHROPIC_API_KEY), mesmo destino (ANTHROPIC_BASE_URL, quando existe), mesmo
// modelo. Uma chamada feita do computador de alguem nao prova a configuracao
// da Vercel; esta prova.
//
// Dados sinteticos: a mensagem nao tem nada de participante. Nada e gravado.
// Custo: uma chamada com max_tokens pequeno.

/**
 * O modelo que gera os documentos. Tem de ser o MESMO de
 * lib/ai/generate-prognostic.ts -- um teste confere o texto daquele arquivo,
 * para os dois nao divergirem em silencio.
 */
export const MODELO_DOS_DOCUMENTOS = "claude-opus-5";

export type ClasseDaFalha =
  | "credencial" // 401 authentication_error: chave invalida ou revogada
  | "saldo" // 402 billing_error: sem credito
  | "permissao" // 403 permission_error
  | "modelo" // 404: modelo indisponivel para esta conta
  | "limite" // 429: limite temporario, nao e falha da chave
  | "provedor" // 5xx / overloaded: instabilidade do lado da Anthropic
  | "rede" // nao chegou a falar com a API
  | "outra";

export type ResultadoDoTeste =
  | {
      ok: true;
      modelo: string;
      destino: string;
      latenciaMs: number;
      motivoDeParada: string | null;
    }
  | { ok: false; classe: ClasseDaFalha; status: number | null; tipo: string | null; destino: string; latenciaMs: number };

/**
 * Classifica pela classe e pelo status do SDK, nunca por texto da mensagem.
 * APIConnectionError vem antes de APIError: no SDK TypeScript ela e subclasse.
 */
export function classificarFalhaDaIA(err: unknown): { classe: ClasseDaFalha; status: number | null; tipo: string | null } {
  if (err instanceof Anthropic.APIConnectionError) return { classe: "rede", status: null, tipo: null };
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const tipo = (err as { type?: string | null }).type ?? null;
    if (status === 401 || tipo === "authentication_error") return { classe: "credencial", status, tipo };
    if (status === 402 || tipo === "billing_error") return { classe: "saldo", status, tipo };
    if (status === 403 || tipo === "permission_error") return { classe: "permissao", status, tipo };
    if (status === 404 || tipo === "not_found_error") return { classe: "modelo", status, tipo };
    if (status === 429 || tipo === "rate_limit_error") return { classe: "limite", status, tipo };
    if ((status !== null && status >= 500) || tipo === "overloaded_error" || tipo === "api_error") {
      return { classe: "provedor", status, tipo };
    }
    return { classe: "outra", status, tipo };
  }
  return { classe: "outra", status: null, tipo: null };
}

/** Host para onde a chamada vai. So o host: nunca chave, header ou caminho. */
export function destinoDaChamada(baseURL: string | undefined | null): string {
  try {
    return new URL(baseURL || "https://api.anthropic.com").host;
  } catch {
    return "desconhecido";
  }
}

export async function testarConexaoComIA(
  cliente: Anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  agora: () => number = () => Date.now(),
): Promise<ResultadoDoTeste> {
  const destino = destinoDaChamada(cliente.baseURL);
  const inicio = agora();
  try {
    const resposta = await cliente.messages.create({
      model: MODELO_DOS_DOCUMENTOS,
      max_tokens: 64,
      messages: [{ role: "user", content: "Teste de conexão. Responda apenas: ok" }],
    });
    return {
      ok: true,
      // A API real sempre devolve `model`; se faltar, a tela nao inventa um.
      modelo: typeof resposta.model === "string" && resposta.model ? resposta.model : "não confirmado na resposta",
      destino,
      latenciaMs: agora() - inicio,
      motivoDeParada: resposta.stop_reason ?? null,
    };
  } catch (err) {
    return { ok: false, ...classificarFalhaDaIA(err), destino, latenciaMs: agora() - inicio };
  }
}

/** O que o operador le, por classe. Sem travessao. */
export const TEXTO_DA_FALHA: Record<ClasseDaFalha, string> = {
  credencial:
    "A chave da IA foi recusada (credencial inválida ou revogada). Não processe: troque a chave na Vercel e teste de novo.",
  saldo: "A conta da IA está sem crédito. Não processe: adicione crédito e teste de novo.",
  permissao: "A chave não tem permissão para este modelo. Não processe: confira a chave e teste de novo.",
  modelo: "O modelo que gera os documentos não está disponível para esta conta. Não processe.",
  limite: "A IA está limitando pedidos agora (limite temporário). A chave funciona; espere alguns minutos e teste de novo.",
  provedor: "A IA está instável neste momento. Espere alguns minutos e teste de novo antes de processar.",
  rede: "Não foi possível falar com a IA a partir do servidor. Teste de novo; se repetir, avise a equipe técnica.",
  outra: "A IA respondeu com um erro inesperado. Não processe; avise a equipe técnica.",
};
