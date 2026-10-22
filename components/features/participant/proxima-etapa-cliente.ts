import type { RespostaProxima } from "./proxima-etapa";

// Chamada do navegador a POST /api/etapa/proxima. NUNCA lanca e NUNCA adivinha:
// o que nao deu para saber volta como "indisponivel".

export type ResultadoDaProxima =
  | { tipo: "ok"; dados: RespostaProxima; deslocamento: number }
  | { tipo: "indisponivel" }
  | { tipo: "sem_acesso" }
  | { tipo: "inexistente" };

export async function chamarProxima(
  participantId: string,
  executar: typeof fetch = fetch,
  relogio: () => number = Date.now,
): Promise<ResultadoDaProxima> {
  const t0 = relogio();
  let res: Response;
  try {
    res = await executar("/api/etapa/proxima", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_id: participantId }),
    });
  } catch (err) {
    console.error("[etapa] falha de rede ao descobrir a proxima etapa", err);
    return { tipo: "indisponivel" };
  }
  const t1 = relogio();

  if (res.status === 401 || res.status === 403) return { tipo: "sem_acesso" };
  if (res.status === 404) return { tipo: "inexistente" };
  if (!res.ok) {
    console.error("[etapa] servidor nao conseguiu dizer a proxima etapa", { status: res.status });
    return { tipo: "indisponivel" };
  }
  try {
    const dados = (await res.json()) as RespostaProxima;
    const servidor = Date.parse(dados.agora);
    if (Number.isNaN(servidor)) return { tipo: "indisponivel" };
    return { tipo: "ok", dados, deslocamento: servidor - (t0 + t1) / 2 };
  } catch {
    return { tipo: "indisponivel" };
  }
}
