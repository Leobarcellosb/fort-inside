"use client";

import { useEffect, useState } from "react";
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

export function PrognosticView({
  participantName,
  eventName,
  eventDate,
  hostName,
  content,
  yuriNote,
  prognosticId,
  token,
  pdfUrl: initialPdfUrl,
}: Props) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(initialPdfUrl);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pollingTimedOut, setPollingTimedOut] = useState(false);

  useEffect(() => {
    if (pdfUrl) return;
    if (pollingTimedOut) return;
    const POLL_INTERVAL_MS = 3000;
    const POLL_MAX_MS = 120_000;
    const startedAt = Date.now();

    async function pollOnce() {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        setPollingTimedOut(true);
        return;
      }
      try {
        const res = await fetch(`/api/prognostic-status/${token}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { pdf_url: string | null };
        if (data.pdf_url) setPdfUrl(data.pdf_url);
      } catch {
        // swallow — next tick retries
      }
    }

    pollOnce();
    const interval = setInterval(pollOnce, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [pdfUrl, pollingTimedOut, token]);

  const isPolling = !pdfUrl && !pollingTimedOut;
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

  const analiseParagraphs = content.analise_geral.split(/\n\n+/).filter(Boolean);
  const contextoParagraphs = content.frase_ativacao.contexto.split(/\n\n+/).filter(Boolean);

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
      {/* Fixed PDF download — top-right */}
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
        ) : isPolling ? (
          <div
            className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-background/70 border border-primary/20 text-primary/70 text-xs uppercase tracking-[0.12em] backdrop-blur-md shadow-lg"
            aria-live="polite"
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
              className="animate-spin"
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span>Preparando PDF...</span>
          </div>
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

      {/* Cinematic hero */}
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

      {/* Editorial content — 7 sections */}
      <article className="mx-auto max-w-2xl px-6 py-16 md:py-24 space-y-20 md:space-y-24">
        {/* 1. Análise */}
        <section className="space-y-5">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Análise
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <div className="space-y-5">
            {analiseParagraphs.map((p, i) => (
              <p
                key={i}
                className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans"
              >
                {p}
              </p>
            ))}
          </div>
        </section>

        {/* 2. Áreas-chave */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Áreas-chave
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <div className="space-y-10">
            {content.areas_chave.map((area, i) => (
              <div key={i} className="space-y-3">
                <h3 className="font-playfair text-xl md:text-2xl text-primary font-light tracking-tight">
                  {area.nome}
                </h3>
                <p className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans">
                  {area.direcionamento}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 3. Plano 30 dias */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Plano de 30 dias
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <div className="space-y-8">
            {content.plano_30_dias.map((step, i) => (
              <div key={i} className="flex gap-5">
                <div className="shrink-0">
                  <span className="font-playfair text-3xl md:text-4xl text-primary font-light leading-none">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <div className="space-y-2">
                  <h3 className="font-playfair text-lg md:text-xl text-foreground tracking-tight">
                    {step.comportamento}
                  </h3>
                  <p className="text-[17px] leading-[1.7] text-foreground/85 font-sans">
                    {step.microacao}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4. Pilares */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Pilares
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {content.praticas.map((p, i) => (
              <div key={i} className="space-y-2 border-l-2 border-primary/40 pl-4">
                <h3 className="font-playfair text-lg text-primary tracking-tight">{p.nome}</h3>
                <p className="text-sm leading-[1.6] text-foreground/80 font-sans">
                  {p.descricao}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 5. Frase de ativação */}
        <section className="space-y-10">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Frase de ativação
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <div className="relative px-6 py-8 md:px-10 md:py-10 border-y-2 border-primary/40 bg-card/30 rounded-sm">
            <blockquote className="font-playfair italic text-2xl md:text-3xl text-foreground/95 leading-[1.4] text-center font-light tracking-tight">
              &ldquo;{content.frase_ativacao.frase}&rdquo;
            </blockquote>
          </div>
          <div className="space-y-5">
            {contextoParagraphs.map((p, i) => (
              <p
                key={i}
                className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans"
              >
                {p}
              </p>
            ))}
          </div>
        </section>

        {/* 6. Por que esta trilha */}
        <section className="space-y-5">
          <div className="space-y-3">
            <h2 className="font-playfair text-2xl md:text-3xl font-light text-foreground uppercase tracking-[0.15em]">
              Por que esta trilha
            </h2>
            <div className="h-px w-16 bg-primary/50" aria-hidden />
          </div>
          <p className="text-[17px] md:text-lg leading-[1.7] text-foreground/85 font-sans">
            {content.justificativa_trilha}
          </p>
        </section>

        {/* 7. Yuri's note (opcional) */}
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

        {/* Footer */}
        <footer className="pt-10 border-t border-border/50 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Prognóstico Inicial de Direção
          </p>
          <p className="text-sm text-foreground/70 mt-2 font-playfair">por {hostName}</p>
        </footer>
      </article>
    </main>
  );
}
