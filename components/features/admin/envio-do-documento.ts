// O ENVIO DO DOCUMENTO INDIVIDUAL -- o que o operador manda, e para quem.
//
// POR QUE ISTO EXISTE (Rodada 67 do CTO)
// --------------------------------------
// "Entregar" copiava o link e marcava o documento como entregue no mesmo clique.
// A associacao participante -> documento, protegida no banco inteiro, se perdia
// no ato de copiar e colar: nada na tela dizia DE QUEM era o link na area de
// transferencia, e o status "Entregue" aparecia mesmo que ninguem tivesse
// mandado nada.
//
// A decisao: levar a identidade ate a ultima acao do operador. O destinatario
// fica visivel, a mensagem sai pronta com o primeiro nome (sem telefone, sem
// e-mail), e a conferencia do contato e obrigatoria a cada documento.
//
// A RESTRICAO QUE DEFINE A ORDEM. A pagina do participante so responde para
// `delivered` (ou `suspended`): o link nao funciona antes da marcacao. Entao
// liberar e enviar sao o MESMO gesto -- o clique que abre o WhatsApp ou copia a
// mensagem e o clique que libera. Nunca "copiar agora, marcar depois".
//
// Funcoes puras (sem rede, sem React), provadas em teste.

/** Dominio que o participante ve. O painel pode estar aberto no antigo. */
const DOMINIO_DO_MARCO_ZERO = "https://marcozero-gp.vercel.app";
const DOMINIOS_ANTIGOS = new Set(["fort-inside.vercel.app"]);

/**
 * A origem que vai no link. O link circula no WhatsApp de adolescentes: com o
 * nome antigo do produto ele parece golpe (pedido do dono: "tem que ser marco
 * zero"). Qualquer outra origem (local, previa) passa como esta.
 */
export function origemDoLink(origemDoPainel: string): string {
  try {
    const url = new URL(origemDoPainel);
    return DOMINIOS_ANTIGOS.has(url.host) ? DOMINIO_DO_MARCO_ZERO : url.origin;
  } catch {
    return DOMINIO_DO_MARCO_ZERO;
  }
}

export function linkDoDocumento(origemDoPainel: string, token: string): string {
  return `${origemDoLink(origemDoPainel)}/prognostic/${token}`;
}

/** "Ana Clara Souza" -> "Ana". Vazio quando nao ha nome legivel. */
export function primeiroNomeDoDestinatario(nomeCompleto: string): string {
  return nomeCompleto.trim().split(/\s+/)[0] ?? "";
}

/**
 * A mensagem, nas palavras do CTO. So o primeiro nome: o nome completo fica na
 * TELA do operador (para ele conferir), nao no texto que pode ser encaminhado.
 */
export function mensagemDeEnvio(nomeCompleto: string, link: string): string {
  const nome = primeiroNomeDoDestinatario(nomeCompleto);
  const abertura = nome ? `${nome}, seu` : "Seu";
  return `${abertura} direcionamento individual do Marco Zero está disponível: ${link}`;
}

/**
 * Link do WhatsApp com a mensagem pronta e SEM numero: o operador escolhe a
 * conversa. O numero nao entra de proposito -- quem confere o destinatario e a
 * pessoa, no contato oficial, nao um campo autodeclarado do formulario.
 */
export function linkDoWhatsApp(mensagem: string): string {
  return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}

/** A frase que o operador confirma. Uma por documento, com o nome completo. */
export function textoDaConferencia(nomeCompleto: string): string {
  const nome = nomeCompleto.trim() || "a pessoa indicada";
  return `Conferi no contato oficial que esta conversa é de ${nome}.`;
}
