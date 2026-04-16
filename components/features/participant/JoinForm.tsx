"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { joinEventSchema, type JoinEventInput } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  eventId: string;
  eventCode: string;
}

export function JoinForm({ eventId, eventCode }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<JoinEventInput>({
    resolver: zodResolver(joinEventSchema),
  });

  async function onSubmit(data: JoinEventInput) {
    setLoading(true);
    try {
      const supabase = createClient();

      // Sign up or sign in (magic password = email+eventCode)
      const password = `${data.email}::${eventCode}`;
      let userId: string;

      const { data: signUp, error: signUpError } = await supabase.auth.signUp({
        email: data.email,
        password,
        options: { data: { full_name: data.full_name } },
      });

      if (signUpError?.message?.includes("already registered")) {
        const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
          email: data.email,
          password,
        });
        if (signInError || !signIn.user) throw new Error("Erro ao entrar. Tente novamente.");
        userId = signIn.user.id;
      } else if (signUpError || !signUp.user) {
        throw new Error(signUpError?.message ?? "Erro ao criar conta.");
      } else {
        userId = signUp.user.id;
      }

      // Check if already joined
      const { data: existing } = await supabase
        .from("participants")
        .select("id")
        .eq("event_id", eventId)
        .eq("email", data.email)
        .single();

      let participantId: string;

      if (existing) {
        participantId = existing.id;
        await supabase
          .from("participants")
          .update({ user_id: userId })
          .eq("id", existing.id);
      } else {
        const { data: participant, error: pErr } = await supabase
          .from("participants")
          .insert({
            event_id: eventId,
            user_id: userId,
            full_name: data.full_name,
            email: data.email,
            phone: data.phone ?? null,
            course_or_moment: data.course_or_moment ?? null,
          })
          .select("id")
          .single();

        if (pErr || !participant) throw new Error("Erro ao registrar. Tente novamente.");
        participantId = participant.id;
      }

      localStorage.setItem("fort_participant_id", participantId);
      localStorage.setItem("fort_event_id", eventId);

      router.push("/waiting");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="full_name" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Nome completo
        </Label>
        <Input
          id="full_name"
          placeholder="Seu nome"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("full_name")}
        />
        {errors.full_name && (
          <p className="text-xs text-destructive">{errors.full_name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          E-mail
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="seu@email.com"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phone" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Telefone <span className="normal-case text-muted-foreground/60">(opcional)</span>
        </Label>
        <Input
          id="phone"
          type="tel"
          placeholder="(11) 99999-0000"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("phone")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="course_or_moment" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          O que te trouxe até aqui? <span className="normal-case text-muted-foreground/60">(opcional)</span>
        </Label>
        <Input
          id="course_or_moment"
          placeholder="Contexto breve"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("course_or_moment")}
        />
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-sans uppercase tracking-[0.08em] text-sm h-12 mt-2"
      >
        {loading ? "Entrando..." : "Entrar na imersão"}
      </Button>
    </form>
  );
}
