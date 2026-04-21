import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  type: z.enum(["text", "file"]),
  file_name: z.string().optional(),
});

export async function GET() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("id, title, type, file_name, created_at, content")
    .order("created_at", { ascending: false }) as {
      data: { id: string; title: string; type: string; file_name: string | null; created_at: string; content: string }[] | null;
      error: unknown;
    };

  if (error) return NextResponse.json({ error: "Erro ao buscar base de conhecimento" }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  let title: string;
  let content: string;
  let type: "text" | "file";
  let file_name: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    title = (form.get("title") as string) ?? "";

    if (!file) return NextResponse.json({ error: "Arquivo não enviado" }, { status: 400 });

    const allowedTypes = ["text/plain", "text/markdown", "application/json"];
    if (!allowedTypes.some((t) => file.type.startsWith(t)) && !file.name.match(/\.(txt|md|json)$/i)) {
      return NextResponse.json({ error: "Apenas arquivos .txt, .md ou .json são suportados" }, { status: 400 });
    }

    content = await file.text();
    type = "file";
    file_name = file.name;
  } else {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
    ({ title, content, type, file_name } = parsed.data);
  }

  type KBRow = { id: string; title: string; type: string; file_name: string | null; created_at: string };
  type InsertResult = { data: KBRow | null; error: { message: string } | null };

  const supabase = createAdminClient();
  const { data, error } = await (supabase.from("knowledge_base") as unknown as {
    insert(v: Record<string, unknown>): {
      select(cols: string): { single(): Promise<InsertResult> };
    };
  }).insert({ title, content, type, file_name: file_name ?? null }).select("id, title, type, file_name, created_at").single();

  if (error || !data) return NextResponse.json({ error: "Erro ao salvar" }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID obrigatório" }, { status: 400 });

  const supabase = createAdminClient();
  await (supabase.from("knowledge_base") as unknown as {
    delete(): { eq(c: string, v: string): Promise<unknown> };
  }).delete().eq("id", id);

  return NextResponse.json({ ok: true });
}
