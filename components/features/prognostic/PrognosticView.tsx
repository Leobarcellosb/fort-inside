"use client";

import { useState } from "react";
import type { PrognosticContent, TrailRecommendation } from "@/types/database";
import { Button } from "@/components/ui/button";
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
  pdfUrl: string | null;
}

const TRAIL_COLORS: Record<TrailRecommendation, string> = {
  "Exploração": "border-chart-3/50 text-chart-3 bg-chart-3/5",
  "Direção": "border-primary/60 text-primary bg-primary/10",
  "Aproximação": "border-chart-2/50 text-chart-2 bg-chart-2/5",
  "Aceleração": "border-chart-4/50 text-chart-4 bg-chart-4/5",
  "Sessão Privada": "border-primary/70 text-primary bg-primary/10",
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
  pdfUrl: initialPdfUrl,
}: Props) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(initialPdfUrl);
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const trailColor =
    TRAIL_COLORS[content.trilha_recomendada] ?? "border-border text-muted-foreground";

  const firstName = participantName.trim().split(" ")[0];

  const formattedDate = eventDate
    ? new Date(eventDate).toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  // Fallback when the PDF wasn't pre-generated (auto-chain from prognostic may have failed)
  async function generateAndOpenPdf() {
    setGeneratingPdf(true);
    try {
      const res = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prognostic_id: prognosticId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.pdf_url) {
        setPdfUrl(data.pdf_url);
        window.open(data.pdf_url, "_blank", "noopener,noreferrer");
      }
    } catch {
      toast.error("Erro ao gerar PDF. Tente novamente.");
    } finally {
      setGeneratingPdf(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground relative">
      {/* Fixed PDF download — top-right, discreet but visible */}
      <div className="fixed top-4 right-4 z-30">
        {pdfUrl ? (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-background/70 border border-primary/30 text-primary text-xs uppercase tracking-[0.12em] backdrop-blur-md hover:bg-background/90 hover:border-primary transition-all shadow-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>PDF</span>
          </a>
        ) : (
          <Button
            onClick={generateAndOpenPdf}
            disabled={generatingPdf}
            variant="outline"
            className="h-9 px-3 rounded-full bg-background/70 border border-primary/30 text-primary text-xs uppercase tracking-[0.12em] backdrop-blur-md hover:bg-background/90 shadow-lg"
          >
            {generatingPdf ? "Gerando..." : "PDF"}
          </Button>
        )}
      </div>

      {/* Cinematic hero — uses existing component, untouched */}
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
            {firstName}
          </h1>
          <p className="text-white/75 text-sm">
            {eventName} · {formattedDate}
          </p>

          <div
            className={`inline-flex items-center gap-3 px-5 py-2 rounded-full border backdrop-blur-sm ${trailColor} mt-3`}
          >
            <span className="text-[10px] uppercase tracking-[0.2em] font-sans">Trilha</span>
            <span className="text-sm font-medium font-playfair">
              {content.trilha_recomendada}
            </span>
          </div>
        </div>
      </CinematicHero>

      {/* Editorial content */}
      <article className="mx-auto max-w-2xl px-6 py-16 md:py-24">
        <div className="space-y-16 md:space-y-20">
          {SECTIONS.map(({ key, label }) => (
            <section key={key} className="space-y-5">
              <div className="space-y-3">
                <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em] leading-tight">
                  {label}
                </h2>
                <div className="h-px w-16 bg-primary/50" aria-hidden />
              </div>
              <p className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans">
                {content[key]}
              </p>
            </section>
          ))}

          {/* Por que esta trilha — full section, not a sidebar card */}
          <section className="space-y-5">
            <div className="space-y-3">
              <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em] leading-tight">
                Por que esta trilha
              </h2>
              <div className="h-px w-16 bg-primary/50" aria-hidden />
            </div>
            <p className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans">
              {content.justificativa_trilha}
            </p>
          </section>

          {/* Yuri's personal note */}
          {yuriNote && (
            <section className="space-y-4 border-l-2 border-primary/50 pl-6 py-2">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Observação de {hostName}
              </p>
              <p className="font-playfair text-xl md:text-2xl text-foreground/90 leading-[1.5] italic font-light">
                &ldquo;{yuriNote}&rdquo;
              </p>
            </section>
          )}
        </div>

        {/* Footer */}
        <footer className="mt-20 pt-10 border-t border-border/50 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Prognóstico Inicial de Direção
          </p>
          <p className="text-sm text-foreground/70 mt-2 font-playfair">por {hostName}</p>
        </footer>
      </article>
    </main>
  );
}
