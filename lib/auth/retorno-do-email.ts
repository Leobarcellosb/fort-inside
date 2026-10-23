// A VOLTA DO LINK DO E-MAIL para o painel: entrar sem senha e redefinir a senha.
//
// O Supabase manda um link que volta para /admin/login/confirmar trazendo, conforme
// o modelo do e-mail, um `code` (fluxo PKCE do @supabase/ssr, o padrao) ou um
// `token_hash` com `type`. Esta funcao so le a URL; quem troca por sessao e a rota.
//
// `next` vem de fora (esta no link). So vale caminho do proprio painel: sem isso
// o link viraria um redirecionador aberto para qualquer site.

export type RetornoDoEmail =
  | { tipo: "codigo"; code: string }
  | { tipo: "token"; tokenHash: string; type: TipoDoToken }
  | { tipo: "invalido" };

export type TipoDoToken = "magiclink" | "recovery" | "email";

const TIPOS_ACEITOS = new Set<TipoDoToken>(["magiclink", "recovery", "email"]);

export const DESTINO_PADRAO = "/admin/events";
export const PAGINA_DE_NOVA_SENHA = "/admin/login/nova-senha";
export const ROTA_DE_RETORNO = "/admin/login/confirmar";

/** So caminhos do painel, relativos, sem `//` (que o navegador le como outro site). */
export function destinoSeguro(next: string | null | undefined): string {
  if (!next) return DESTINO_PADRAO;
  if (!next.startsWith("/admin")) return DESTINO_PADRAO;
  if (next.startsWith("//") || next.includes("\\") || next.includes("://") || next.includes("..")) {
    return DESTINO_PADRAO;
  }
  // Voltar para a propria rota de retorno nao tem sentido e faria um ciclo.
  if (next.startsWith(ROTA_DE_RETORNO)) return DESTINO_PADRAO;
  return next;
}

export function lerRetorno(params: URLSearchParams): RetornoDoEmail {
  const code = params.get("code");
  if (code) return { tipo: "codigo", code };
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as TipoDoToken | null;
  if (tokenHash && type && TIPOS_ACEITOS.has(type)) return { tipo: "token", tokenHash, type };
  return { tipo: "invalido" };
}

/** Endereco de volta que vai dentro do e-mail, ja com o destino depois de entrar. */
export function enderecoDeRetorno(origem: string, next: string): string {
  const url = new URL(ROTA_DE_RETORNO, origem);
  url.searchParams.set("next", destinoSeguro(next));
  return url.toString();
}

/**
 * A mesma frase para "tem conta" e "nao tem conta": a tela nao pode servir para
 * descobrir quais e-mails tem acesso ao painel.
 */
export const TEXTO_LINK_ENVIADO =
  "Se houver uma conta com esse e-mail, enviamos um link. Abra o link neste mesmo navegador; ele vale por uma hora.";

export const TEXTO_LINK_INVALIDO =
  "Este link de acesso não vale mais (expirou, já foi usado ou foi aberto em outro navegador). Peça um novo abaixo.";
