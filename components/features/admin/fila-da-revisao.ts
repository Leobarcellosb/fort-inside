// A REVISAO COMO FILA DE TRABALHO (CTO, Rodada 82): o que falta fazer em cima,
// o que ja foi em baixo, e quanto falta. Nada aqui decide se pode entregar: isso
// continua em `situacaoDaEntrega` e, de verdade, no banco.

export type EtapaDaRevisao = "revisar" | "enviar" | "sem_documento" | "fora_do_ar" | "enviado";

export function etapaDaRevisao(status: string | null | undefined): EtapaDaRevisao {
  switch (status) {
    case "reviewed":
      return "enviar";
    case "delivered":
      return "enviado";
    case "suspended":
      return "fora_do_ar";
    case "generated":
    case "in_review":
      return "revisar";
    default:
      return "sem_documento";
  }
}

/** A ordem da lista: primeiro o que da para fazer agora. */
const ORDEM: Record<EtapaDaRevisao, number> = {
  revisar: 0,
  enviar: 1,
  fora_do_ar: 2,
  sem_documento: 3,
  enviado: 4,
};

export function ordenarParaRevisao<T extends { nome: string; etapa: EtapaDaRevisao }>(itens: T[]): T[] {
  return [...itens].sort((a, b) => ORDEM[a.etapa] - ORDEM[b.etapa] || a.nome.localeCompare(b.nome, "pt-BR"));
}

export type Contagem = Record<EtapaDaRevisao, number>;

export function contarPorEtapa(etapas: EtapaDaRevisao[]): Contagem {
  const c: Contagem = { revisar: 0, enviar: 0, sem_documento: 0, fora_do_ar: 0, enviado: 0 };
  for (const e of etapas) c[e] += 1;
  return c;
}

export const ROTULO_DA_ETAPA: Record<EtapaDaRevisao, string> = {
  revisar: "Para revisar",
  enviar: "Pronto para enviar",
  sem_documento: "Sem documento",
  fora_do_ar: "Fora do ar",
  enviado: "Link liberado",
};
