import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Pecas compartilhadas pelas rotas de entrada por codigo (/api/entrar/*).
 * O desenho e as regras de seguranca estao no comentario do topo de
 * app/api/entrar/solicitar/route.ts e em docs/OTP-E-MAIL.md.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Resposta de erro. So texto NOSSO: nunca repassa mensagem do GoTrue nem eco do corpo. */
export function erro(
  status: number,
  error: string,
  extra?: { codigo?: string; retryAfterS?: number }
) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (extra?.retryAfterS) headers["Retry-After"] = String(extra.retryAfterS);
  const corpo: Record<string, unknown> = { error };
  if (extra?.codigo) corpo.codigo = extra.codigo;
  return NextResponse.json(corpo, { status, headers });
}

export const DADOS_INVALIDOS = "Dados inválidos";

export const ERRO_INTERNO =
  "Não foi possível concluir agora. Tente novamente em instantes.";

/**
 * Falha segura quando o envio de e-mail nao esta configurado/funcionando
 * (SMTP ausente, credencial errada, dominio nao verificado, cota do provedor).
 * Texto honesto para a pessoa, sem culpa e sem detalhe tecnico; o detalhe
 * (code/status do GoTrue) vai so para o log do servidor.
 */
export function envioIndisponivel() {
  return erro(
    503,
    "Não conseguimos enviar o código para o seu e-mail agora. Não é problema com os seus dados. Avise a equipe do evento e tente de novo em alguns minutos.",
    { codigo: "envio_de_codigo_indisponivel" }
  );
}

/** Limite de bytes do corpo: JSON legitimo daqui tem poucas centenas. */
const MAX_CORPO_BYTES = 8 * 1024;

/**
 * Le o corpo como JSON. Malformado, vazio, enorme ou de tipo errado => null
 * (quem chama devolve 400). Nunca lanca.
 */
export async function leCorpoJson(req: Request): Promise<unknown | null> {
  try {
    const texto = await req.text();
    if (texto.length === 0 || texto.length > MAX_CORPO_BYTES) return null;
    const json: unknown = JSON.parse(texto);
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    return json;
  } catch {
    return null;
  }
}

/** E-mail normalizado como o GoTrue guarda (minusculo, sem espacos nas pontas). */
export const emailSchema = z
  .string()
  .max(254)
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().email());

export const eventoSchema = {
  event_id: z.string().uuid(),
  event_code: z.string().trim().min(1).max(40),
};

export interface EventoEntrada {
  id: string;
  max_participants: number;
  status: string;
}

/**
 * Evento existe, o codigo bate e ele nao esta encerrado. Mesma regra da pagina
 * /join/[eventCode]. event_id e event_code vem do QR (publicos): isto nao e
 * segredo, e so impede juntar pedido de codigo/participante a evento inventado.
 * Devolve null para qualquer motivo (inexistente, codigo errado, encerrado):
 * quem chama responde uma unica mensagem.
 */
export async function buscaEventoAberto(
  eventId: string,
  eventCode: string
): Promise<EventoEntrada | null> {
  const admin = createAdminClient();
  const { data, error } = (await admin
    .from("events")
    .select("id, max_participants, status, event_code")
    .eq("id", eventId)
    .maybeSingle()) as unknown as {
    data: (EventoEntrada & { event_code: string }) | null;
    error: unknown;
  };

  if (error || !data) return null;
  if (data.event_code.toUpperCase() !== eventCode.trim().toUpperCase()) return null;
  if (data.status === "completed") return null;
  return { id: data.id, max_participants: data.max_participants, status: data.status };
}

export const EVENTO_NAO_ENCONTRADO = "Evento não encontrado ou encerrado.";
