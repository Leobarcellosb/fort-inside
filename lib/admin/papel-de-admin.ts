// O PAPEL DE ADMINISTRADOR, como ele vive no Supabase Auth (Rodada 81 do CTO).
//
// O app reconhece administrador por `app_metadata.role === "admin"`
// (lib/auth/require-admin.ts e `is_admin()` no banco). `app_metadata` so muda pela
// API administrativa, com a chave de servico: o proprio usuario nao a altera, ao
// contrario de `user_metadata`. Nunca se edita a tabela interna `auth.users`.
//
// Conceder e revogar mexem SO em `role`: o resto de `app_metadata` (provedor de
// login, por exemplo) fica como estava.
//
// O Supabase MESCLA `app_metadata` na atualizacao: uma chave que falta no objeto
// enviado continua la. Por isso revogar manda `role: null` explicito, e nao
// apenas tira a chave (provado no ensaio local: tirar a chave nao revogava).

export type AcaoSobreOPapel = "conceder" | "revogar";

export function appMetadataComPapel(
  atual: Record<string, unknown> | null | undefined,
  acao: AcaoSobreOPapel,
): Record<string, unknown> {
  const base = { ...(atual ?? {}) };
  if (acao === "conceder") return { ...base, role: "admin" };
  // Revogar so tira o papel de administrador; outro papel, se existir, fica.
  if (base.role === "admin") return { ...base, role: null };
  return base;
}

/** O endereco do Supabase e mesmo o do projeto indicado? Evita mexer no banco errado. */
export function enderecoDoProjeto(url: string, projeto: string): boolean {
  try {
    const u = new URL(url);
    // "local" e o Supabase da maquina de quem desenvolve, para ensaiar o script.
    if (projeto === "local") return u.hostname === "127.0.0.1" || u.hostname === "localhost";
    return u.host === `${projeto}.supabase.co`;
  } catch {
    return false;
  }
}
