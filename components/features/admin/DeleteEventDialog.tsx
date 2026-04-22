"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Variant = "icon" | "button";

interface Props {
  event: { id: string; name: string; event_code: string; status: string };
  variant?: Variant;
}

const DELETABLE_STATUSES = ["draft", "completed"];

export function DeleteEventDialog({ event, variant = "icon" }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typedCode, setTypedCode] = useState("");
  const [loading, setLoading] = useState(false);

  if (!DELETABLE_STATUSES.includes(event.status)) return null;

  async function handleDelete() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_code: typedCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Falha ao deletar");

      toast.success("Evento deletado.");
      setOpen(false);
      setTypedCode("");

      if (variant === "button") {
        router.push("/admin/events");
      } else {
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao deletar");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Deletar evento ${event.name}`}
          className="text-muted-foreground hover:text-destructive transition-colors p-1.5 rounded-md"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      ) : (
        <Button
          type="button"
          onClick={() => setOpen(true)}
          variant="outline"
          size="sm"
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Deletar evento
        </Button>
      )}

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (loading) return;
          setOpen(o);
          if (!o) setTypedCode("");
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">
              Deletar evento
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground text-sm leading-relaxed">
              Essa ação é irreversível. Serão apagados: participantes, respostas,
              prognósticos, logs e arquivos PDF.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              Digite{" "}
              <code className="text-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                {event.event_code}
              </code>{" "}
              para confirmar:
            </p>
            <Label htmlFor="confirmation_code" className="sr-only">
              Código de confirmação
            </Label>
            <Input
              id="confirmation_code"
              value={typedCode}
              onChange={(e) => setTypedCode(e.target.value)}
              placeholder={event.event_code}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              className="bg-transparent border border-border focus-visible:border-primary font-mono"
              disabled={loading}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading} className="border-border">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={loading || typedCode !== event.event_code}
              className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
            >
              {loading ? "Deletando..." : "Deletar evento"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
