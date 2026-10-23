// COMO O APP ASSINA: o nome do Yuri nunca aparece sozinho, sempre com o movimento.
// Mesmo separador do resto do app ("Marco Zero · Geração Preparada"): o ponto
// medio, que nao se confunde com travessao.

export const MARCA = "Yuri Fortes · Geração Preparada";

const NOME_DO_YURI = "yuri fortes";

/**
 * A assinatura para um nome de anfitriao vindo do cadastro do evento. O dado
 * continua sendo o nome da pessoa; so a TELA mostra a marca completa. Outro
 * anfitriao, se um dia existir, aparece como foi cadastrado.
 */
export function assinaturaDoAnfitriao(hostName: string | null | undefined): string {
  const nome = (hostName ?? "").trim();
  if (!nome || nome.toLowerCase() === NOME_DO_YURI) return MARCA;
  return nome;
}
