"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/client";
import { createEventSchema, type CreateEventInput } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewEventForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [eventCode, setEventCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateEventInput>({
    resolver: zodResolver(createEventSchema),
    defaultValues: { max_participants: 8, host_name: "Yuri Fortes" },
  });

  async function onSubmit(data: CreateEventInput) {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: event, error } = await supabase
        .from("events")
        .insert({
          name: data.name,
          event_code: data.event_code.toUpperCase(),
          event_date: data.event_date,
          location_name: data.location_name ?? null,
          max_participants: data.max_participants,
          host_name: data.host_name,
          status: "draft",
          current_stage: 0,
        })
        .select("id, event_code")
        .single();

      if (error || !event) throw new Error(error?.message ?? "Erro ao criar evento");

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
      const url = `${appUrl}/join/${event.event_code}`;
      const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: "#C9A961", light: "#0A0A0A" } });

      setQrDataUrl(qr);
      setEventCode(event.event_code);
      setJoinUrl(url);
      toast.success("Evento criado com sucesso!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar evento");
    } finally {
      setLoading(false);
    }
  }

  if (qrDataUrl && eventCode && joinUrl) {
    return (
      <div className="space-y-6 text-center">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">QR Code gerado</p>
          <p className="text-muted-foreground text-sm">Mostre este QR code aos participantes no início da imersão.</p>
        </div>

        <div className="mx-auto w-fit p-4 bg-[#0A0A0A] rounded-xl border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="QR Code de acesso" className="w-48 h-48" />
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-[0.1em]">Código do evento</p>
          <p className="font-mono text-xl text-primary">{eventCode}</p>
        </div>

        <div className="px-4 py-3 bg-card rounded-md border border-border">
          <p className="text-xs text-muted-foreground break-all">{joinUrl}</p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(joinUrl).catch(() => {});
              toast.success("Link copiado");
            }}
            className="flex-1 border-border text-muted-foreground hover:text-foreground"
          >
            Copiar link
          </Button>
          <Button
            onClick={() => router.push("/admin/events")}
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Ver eventos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Nome do evento</Label>
        <Input
          placeholder="Fort Inside — Abril 2026"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
          {...register("name")}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Código do evento <span className="normal-case text-muted-foreground/60">(maiúsculas, sem espaço)</span>
        </Label>
        <Input
          placeholder="FORT28ABR"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 uppercase font-mono"
          {...register("event_code")}
        />
        {errors.event_code && <p className="text-xs text-destructive">{errors.event_code.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Data do evento</Label>
        <Input
          type="datetime-local"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
          {...register("event_date")}
        />
        {errors.event_date && <p className="text-xs text-destructive">{errors.event_date.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Local</Label>
        <Input
          placeholder="Casa Jardins, São Paulo"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
          {...register("location_name")}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Máx. participantes</Label>
          <Input
            type="number"
            min={1}
            max={20}
            className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
            {...register("max_participants", { valueAsNumber: true })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Host</Label>
          <Input
            className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
            {...register("host_name")}
          />
        </div>
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] mt-4"
      >
        {loading ? "Criando..." : "Criar evento + gerar QR"}
      </Button>
    </form>
  );
}
