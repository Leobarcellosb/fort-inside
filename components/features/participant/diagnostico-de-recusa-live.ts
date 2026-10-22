// POR QUE O BANCO RECUSOU A GRAVACAO NO MODO LIVE.
//
// Antes, todo 42501 virava "Sua sessao expirou". Mas a recusa mais comum no ao
// vivo e outra: a etapa ainda nao foi liberada pelo host (`stage_number >
// current_stage`), e dizer "sessao expirou" mandava a pessoa recarregar a tela
// por nada. Decisao do CTO: nesse caso a mensagem e "Esta etapa ainda nao foi
// liberada pela organizacao"; "sessao expirou" fica SO para login ausente de
// verdade. Os dois textos NAO se unificam.
//
// Nao se adivinha: so se diz "nao liberada" se o evento lido agora confirma
// (numero da etapa maior que current_stage), e so se diz "login ausente" se o
// servico de login confirma que nao ha usuario. Qualquer duvida (falha de
// leitura, rede) e `indeterminado`, que a tela trata com a mensagem generica de
// falha ao salvar.

export type CausaDaRecusaLive = "login_ausente" | "etapa_nao_liberada" | "indeterminado";

interface Consulta extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ClienteDeDiagnostico {
  auth: {
    getUser(): PromiseLike<{
      data: { user: unknown | null };
      error: { name?: string; status?: number } | null;
    }>;
  };
  from(tabela: string): { select(colunas: string): Consulta };
}

export async function diagnosticarRecusaLive(
  supabase: ClienteDeDiagnostico,
  eventId: string,
  numeroDaEtapa: number,
): Promise<CausaDaRecusaLive> {
  try {
    const login = await supabase.auth.getUser();
    if (!login.data.user) {
      const e = login.error;
      const transitorio =
        !!e &&
        (e.name === "AuthRetryableFetchError" ||
          e.status === 0 ||
          (typeof e.status === "number" && e.status >= 500));
      // Sem usuario e sem falha de rede/servidor: login ausente de verdade.
      return transitorio ? "indeterminado" : "login_ausente";
    }

    const ev = (await supabase
      .from("events")
      .select("current_stage")
      .eq("id", eventId)
      .maybeSingle()) as { data: { current_stage: number } | null; error: unknown };
    if (ev.error || !ev.data) return "indeterminado";
    return numeroDaEtapa > ev.data.current_stage ? "etapa_nao_liberada" : "indeterminado";
  } catch {
    return "indeterminado";
  }
}
