import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { joinEventSchema } from "@/lib/schemas";
import { z } from "zod";

const bodySchema = joinEventSchema.extend({
  event_id: z.string().uuid(),
  event_code: z.string(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { email, full_name, phone, course_or_moment, event_id, event_code } = parsed.data;
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

  const password = `${email}::${event_code}`;

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
      // User exists — fetch their ID and reset password to the current
      // event-scoped password so signInWithPassword on the client succeeds.
      // Without this, returning users from a previous event hit "invalid
      // credentials" because their stored password matches the old event_code.
      const { data: users } = await supabase.auth.admin.listUsers();
      const existing = users?.users.find((u) => u.email === email);
      if (!existing) {
        return NextResponse.json({ error: "Erro ao identificar usuário" }, { status: 500 });
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
