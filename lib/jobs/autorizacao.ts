// Quem pode acionar o worker.
//
// Duas portas, e só duas:
//   1. o agendador, com `Authorization: Bearer <CRON_SECRET>` (é o cabeçalho
//      que o Vercel Cron envia quando CRON_SECRET existe no projeto);
//   2. a operação, com sessão de admin (app_metadata.role = 'admin'), para
//      poder destravar um evento na hora sem esperar o próximo minuto.
//
// O participante não tem porta nenhuma: a rota gasta crédito de IA.

import { createHash, timingSafeEqual } from "node:crypto";
import { getAdminUser } from "../auth/require-admin";

/**
 * Comparação de tempo constante. Compara os DIGESTS, não as strings: digest tem
 * tamanho fixo, então `timingSafeEqual` não estoura com tamanhos diferentes e o
 * tempo de resposta não vaza o comprimento do segredo.
 */
function igualEmTempoConstante(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type OrigemDoAcionamento = "agendador" | "admin";

export async function autorizarAcionamento(
  cabecalhoAutorizacao: string | null
): Promise<OrigemDoAcionamento | null> {
  const segredo = process.env.CRON_SECRET;

  // Sem CRON_SECRET configurado, a porta do agendador simplesmente NÃO EXISTE.
  // O contrário (aceitar qualquer chamada quando o segredo não está
  // configurado) transformaria um deploy incompleto em endpoint aberto que
  // gasta Opus.
  if (segredo && cabecalhoAutorizacao?.startsWith("Bearer ")) {
    const enviado = cabecalhoAutorizacao.slice("Bearer ".length);
    if (igualEmTempoConstante(enviado, segredo)) return "agendador";
  }

  if (await getAdminUser()) return "admin";

  return null;
}
