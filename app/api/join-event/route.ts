import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { joinEventSchema } from "@/lib/schemas";
import { z } from "zod";

const bodySchema = joinEventSchema.extend({
  event_id: z.string().uuid(),
  event_code: z.string(),
});

type AuthUser = { id: string; email?: string; app_metadata?: { role?: string } };

// listUsers() defaults to 50 per page. Past that, a returning participant's
// account simply wasn't found and the join failed with "Erro ao identificar
// usuário". Walk every page until we find the e-mail or run out.
async function findUserByEmail(
  supabase: ReturnType<typeof createAdminClient>,
  email: string
): Promise<AuthUser | null> {
  const perPage = 1000;
  const target = email.toLowerCase();

  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;

    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match as AuthUser;

    if (data.users.length < perPage) return null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { email, full_name, phone, course_or_moment, event_id } = parsed.data;
  const supabase = createAdminClient();

  // Verify event exists and has capacity
  const { data: event } = await supabase
    .from("events")
    .select("id, max_participants, status")
    .eq("id", event_id)
    .single() as { data: { id: string; max_participants: number; status: string } | null; error: unknown };

  if (!event) {
    return NextResponse.json({ error: "Evento não encontrado" }, { status: 404 });
  }

  // Random, single-use credential. The previous `${email}::${event_code}`
  // scheme was guessable: the event code is printed on a public QR, so knowing
  // a participant's e-mail was enough to sign in as them.
  const password = randomBytes(24).toString("base64url");

  // Try to create auth user — email_confirm: true skips confirmation email
  let userId: string;
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });

  if (createError) {
    if (createError.message.includes("already been registered")) {
      // User exists — reset the password to the freshly generated one so
      // signInWithPassword on the client succeeds. Returning participants from
      // a previous event would otherwise hit "invalid credentials".
      const existing = await findUserByEmail(supabase, email);
      if (!existing) {
        return NextResponse.json({ error: "Erro ao identificar usuário" }, { status: 500 });
      }

      // NEVER reset the credentials of a privileged account. Without this,
      // anyone holding a public event QR could type the admin's e-mail into
      // the join form, have the admin password overwritten, and read the new
      // one straight out of this endpoint's response.
      if (existing.app_metadata?.role === "admin") {
        return NextResponse.json(
          { error: "Este e-mail não pode ser usado para entrar na imersão." },
          { status: 403 }
        );
      }

      userId = existing.id;
      const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
      });
      if (updateErr) {
        return NextResponse.json(
          { error: "Erro ao atualizar credenciais" },
          { status: 500 }
        );
      }
    } else {
      return NextResponse.json({ error: createError.message }, { status: 500 });
    }
  } else {
    userId = created.user.id;
  }

  type ParticipantRow = { id: string };
  type MutResult<T> = { data: T | null; error: { message: string } | null };

  // Check if participant already registered for this event
  const { data: existingParticipant } = await supabase
    .from("participants")
    .select("id")
    .eq("event_id", event_id)
    .eq("email", email)
    .single() as { data: ParticipantRow | null; error: unknown };

  let participantId: string;

  if (existingParticipant) {
    participantId = existingParticipant.id;
    await (supabase.from("participants") as unknown as {
      update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<unknown> };
    }).update({ user_id: userId }).eq("id", existingParticipant.id);
  } else {
    const { data: participant, error: pErr } = await (supabase.from("participants") as unknown as {
      insert(v: Record<string, unknown>): {
        select(cols: string): {
          single(): Promise<MutResult<ParticipantRow>>;
        };
      };
    }).insert({
      event_id,
      user_id: userId,
      full_name,
      email,
      phone: phone ?? null,
      course_or_moment: course_or_moment ?? null,
    }).select("id").single();

    if (pErr || !participant) {
      return NextResponse.json({ error: "Erro ao registrar participante" }, { status: 500 });
    }
    participantId = participant.id;
  }

  return NextResponse.json({ participant_id: participantId, password });
}
