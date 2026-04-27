"use client";

import { useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { QrCode } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface Props {
  event: { event_code: string };
}

export function EventQRDialog({ event }: Props) {
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  async function handleOpen() {
    if (!qrDataUrl) {
      setGenerating(true);
      try {
        const url = `${window.location.origin}/join/${event.event_code}`;
        const qr = await QRCode.toDataURL(url, {
          width: 400,
          margin: 2,
          color: { dark: "#C9A961", light: "#0A0A0A" },
        });
        setQrDataUrl(qr);
        setJoinUrl(url);
      } catch {
        toast.error("Erro ao gerar QR.");
        setGenerating(false);
        return;
      }
      setGenerating(false);
    }
    setOpen(true);
  }

  async function copyLink() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success("Link copiado");
    } catch {
      toast.error("Falha ao copiar");
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleOpen}
        disabled={generating}
        className="border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
      >
        <QrCode className="w-4 h-4 mr-2" />
        {generating ? "Gerando..." : "Ver QR"}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="bg-card border-border max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground text-center">
              QR Code do evento
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground text-sm text-center">
              Escaneie ou compartilhe o link com participantes.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {qrDataUrl && (
            <div className="space-y-5 py-2">
              <div className="mx-auto w-fit p-4 bg-[#0A0A0A] rounded-xl border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrDataUrl} alt="QR code do evento" className="w-64 h-64" />
              </div>

              <div className="space-y-1 text-center">
                <p className="text-xs text-muted-foreground uppercase tracking-[0.1em]">
                  Código do evento
                </p>
                <p className="font-mono text-2xl text-primary">{event.event_code}</p>
              </div>

              {joinUrl && (
                <div className="px-4 py-3 bg-background/50 rounded-md border border-border">
                  <p className="text-xs text-muted-foreground break-all text-center">{joinUrl}</p>
                </div>
              )}
            </div>
          )}

          <AlertDialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={copyLink}
              className="flex-1 border-border text-muted-foreground hover:text-foreground"
            >
              Copiar link
            </Button>
            <AlertDialogCancel className="flex-1 mt-0 border-border">
              Fechar
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
