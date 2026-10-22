import type { RespostaDeAbertura } from "./janela-da-etapa";

// Chamada do navegador a POST /api/etapa/abrir. NUNCA lanca: devolve o que
// aconteceu, para a tela decidir sem try/catch espalhado.
//
// `deslocamento` = relogio do servidor menos o do aparelho, medido no meio da
// ida e volta. E ele (nao Date.now() puro) que alimenta a contagem do prazo:
// aparelho com hora errada nao pode mostrar "faltam 20 min" quando faltam 2.

export type ResultadoDaChamada =
  | { tipo: "ok"; dados: RespostaDeAbertura; deslocamento: number }
  /** Sem rede, servidor fora, resposta ilegivel ou erro 5xx. */
  | { tipo: "indisponivel" }
  /** Sessao de login ausente/expirada (401) ou participante alheio (403). */
  | { tipo: "sem_acesso" }
  /** Etapa/evento inexistente (404). */
  | { tipo: "inexistente" };

export async function chamarAbrirEtapa(
  participantId: string,
  numeroDaEtapa: number,
  executar: typeof fetch = fetch,
  relogio: () => number = Date.now,
): Promise<ResultadoDaChamada> {
  const t0 = relogio();
  let res: Response;
  try {
    res = await executar("/api/etapa/abrir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_id: participantId, numero_da_etapa: numeroDaEtapa }),
    });
  } catch (err) {
    console.error("[etapa] falha de rede ao iniciar etapa", err);
    return { tipo: "indisponivel" };
  }
  const t1 = relogio();

  if (res.status === 401 || res.status === 403) return { tipo: "sem_acesso" };
  if (res.status === 404) return { tipo: "inexistente" };
  if (!res.ok) {
    console.error("[etapa] servidor recusou iniciar etapa", { status: res.status });
    return { tipo: "indisponivel" };
  }

  try {
    const dados = (await res.json()) as RespostaDeAbertura;
    const servidor = Date.parse(dados.agora);
    if (Number.isNaN(servidor)) return { tipo: "indisponivel" };
    return { tipo: "ok", dados, deslocamento: servidor - (t0 + t1) / 2 };
  } catch {
    return { tipo: "indisponivel" };
  }
}
