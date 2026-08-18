import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/nps — submissão pública de feedback. Sem auth.
// Anti-spam em duas camadas: localStorage no cliente (descarta o formulário
// depois de enviar) e o limite por IP abaixo. Só o localStorage era trivial de
// contornar com um loop de curl.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const RATE_LIMIT_MAP = new Map<string, number[]>();

// Best-effort e por instância: em serverless cada instância tem o seu mapa.
// Segura spam casual, não é defesa contra um atacante determinado — para isso
// seria preciso um store compartilhado (Redis/Upstash).
function allowRequest(ip: string): boolean {
  const now = Date.now();

  for (const [key, stamps] of RATE_LIMIT_MAP) {
    const fresh = stamps.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) RATE_LIMIT_MAP.delete(key);
    else RATE_LIMIT_MAP.set(key, fresh);
  }

  const hits = (RATE_LIMIT_MAP.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) return false;

  hits.push(now);
  RATE_LIMIT_MAP.set(ip, hits);
  return true;
}

// nps_responses.ip_hash já existia na tabela mas nunca era preenchida.
// Guardamos só o hash: serve para detectar spam depois sem armazenar o IP.
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

const npsSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  nps_score: z.number().int().min(0).max(10),
  quality_rating: z.enum(["nao_refletiu", "parcialmente", "bem", "precisao"]),
  highlight: z.string().max(2000).nullable().optional(),
  improvement: z.string().max(2000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  if (!allowRequest(ip)) {
    return NextResponse.json(
      { error: "Muitas tentativas. Aguarde um instante." },
      { status: 429 }
    );
  }

  let parsed;
  try {
    parsed = npsSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!parsed?.success) {
    return NextResponse.json(
      { error: "Dados inválidos", details: parsed?.error.format() },
      { status: 400 }
    );
  }

  const { full_name, nps_score, quality_rating, highlight, improvement } = parsed.data;

  const supabase = createAdminClient();

  type MutResult = { data: unknown; error: { message: string } | null };
  const { error } = (await (supabase.from("nps_responses") as unknown as {
    insert(v: Record<string, unknown>): Promise<MutResult>;
  }).insert({
    full_name,
    nps_score,
    quality_rating,
    highlight: highlight ?? null,
    improvement: improvement ?? null,
    ip_hash: hashIp(ip),
  })) as MutResult;

  if (error) {
    console.error("[POST /api/nps] DB error:", error);
    return NextResponse.json({ error: "Erro ao salvar" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
