"use client";

import { useState } from "react";
import type { PrognosticContent, TrailRecommendation } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { AMBIENT_IMAGES } from "@/lib/cinematic-map";

interface Props {
  participantName: string;
  eventName: string;
  eventDate: string;
  hostName: string;
  content: PrognosticContent;
  yuriNote: string | null;
  prognosticId: string;
  token: string;
}

const TRAIL_COLORS: Record<TrailRecommendation, string> = {
  "Exploração": "border-chart-3/40 text-chart-3",
  "Direção": "border-primary/40 text-primary",
  "Aproximação": "border-chart-2/40 text-chart-2",
  "Aceleração": "border-chart-4/40 text-chart-4",
  "Sessão Privada": "border-primary/60 text-primary",
};

const SECTIONS = [
  { key: "momento_atual" as const, label: "Seu momento" },
  { key: "forca_central" as const, label: "Sua força" },
  { key: "gargalo_sensivel" as const, label: "Seu gargalo" },
  { key: "risco_permanecer" as const, label: "O risco de ficar" },
  { key: "construir_agora" as const, label: "O que construir agora" },
  { key: "proximo_passo" as const, label: "Seu próximo passo" },
];

export function PrognosticView({
  participantName,
  eventName,
  eventDate,
  hostName,
  content,
  yuriNote,
  prognosticId,
  token,
}: Props) {
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const trailColor = TRAIL_COLORS[content.trilha_recomendada] ?? "border-border text-muted-foreground";

  const formattedDate = eventDate
    ? new Date(eventDate).toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  async function handleDownloadPdf() {
    setDownloadingPdf(true);
    try {
      const res = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prognostic_id: prognosticId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.pdf_url) {
        window.open(data.pdf_url, "_blank");
      }
    } catch {
      toast.error("Erro ao gerar PDF. Tente novamente.");
    } finally {
      setDownloadingPdf(false);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Fort Inside</p>
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownloadPdf}
          disabled={downloadingPdf}
          className="text-xs border-border text-muted-foreground hover:text-foreground hover:border-primary/50"
        >
          {downloadingPdf ? "Gerando..." : "Baixar PDF"}
        </Button>
      </div>

      {/* Cinematic header */}
      <CinematicHero
        image={AMBIENT_IMAGES.prognostic}
        alt="Mapa da Sua Próxima Construção"
        overlay="medium"
      >
        <div className="mx-auto w-full max-w-2xl text-center space-y-5">
          <p className="text-xs uppercase tracking-[0.25em] text-white/70">
            Mapa da Sua Próxima Construção
          </p>
          <h1 className="font-playfair text-5xl md:text-7xl font-light text-white leading-[1.05] tracking-tight">
            {participantName}
          </h1>
          <p className="text-white/75 text-sm">
            {eventName} · {formattedDate}
          </p>

          <div className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-black/30 backdrop-blur-sm ${trailColor} mt-2`}>
            <span className="text-xs uppercase tracking-[0.12em]">Trilha</span>
            <span className="text-sm font-medium">{content.trilha_recomendada}</span>
          </div>
        </div>
      </CinematicHero>

      <Separator className="bg-border max-w-2xl mx-auto" />

      {/* Content sections */}
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-16">
        {SECTIONS.map(({ key, label }, index) => (
          <section
            key={key}
            className="space-y-4"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
            <p className="font-display text-xl text-foreground leading-relaxed">
              {content[key]}
            </p>
          </section>
        ))}

        {/* Trail justification */}
        <section className="space-y-4 bg-card rounded-lg border border-border p-6">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
            Por que esta trilha
          </p>
          <p className="text-foreground/90 leading-relaxed text-sm">
            {content.justificativa_trilha}
          </p>
        </section>

        {/* Yuri's personal note */}
        {yuriNote && (
          <section className="space-y-4 border-l-2 border-primary/40 pl-6">
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Observação de {hostName}
            </p>
            <p className="font-display text-lg text-foreground/90 leading-relaxed italic">
              &ldquo;{yuriNote}&rdquo;
            </p>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border mt-8">
        <div className="max-w-2xl mx-auto px-6 py-8 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-[0.12em]">
              Prognóstico Inicial de Direção
            </p>
            <p className="text-sm text-foreground font-medium mt-0.5">por {hostName}</p>
          </div>
          <Badge variant="outline" className="text-xs border-border text-muted-foreground">
            {content.trilha_recomendada}
          </Badge>
        </div>
      </div>
    </main>
  );
}
