"use client";

import { useEffect, useState } from "react";
import type { PrognosticContent } from "@/types/database";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { Logo } from "@/components/ui/Logo";

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
  const aplicacaoParagraphs = content.frase_ativacao.aplicacao.split(/\n\n+/).filter(Boolean);
  const justificativaParagraphs = content.justificativa_trilha.split(/\n\n+/).filter(Boolean);

  // Inline bold parser: turns "**texto**" into <strong> runs.
  function renderBold(text: string) {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, i) =>
      i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>
    );
  }

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
      {/* Logo top-left */}
      <div className="fixed top-4 left-4 z-30">
        <Logo size="md" />
      </div>

      {/* Fixed PDF download — top-right */}
      <div className="fixed top-4 right-4 z-30">
        {pdfUrl ? (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-background/90 border border-foreground text-foreground text-xs uppercase tracking-[0.12em] hover:bg-foreground hover:text-background transition-all shadow-sm"
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
            className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-background/90 border border-border text-muted-foreground text-xs uppercase tracking-[0.12em] shadow-sm"
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
            className="h-9 px-3 rounded-full bg-background border border-foreground text-foreground text-xs uppercase tracking-[0.12em] hover:bg-foreground hover:text-background"
          >
            {generatingPdf ? "Gerando..." : "PDF"}
          </Button>
        )}
      </div>

      {/* Hero */}
      <CinematicHero
        eyebrow="Mapa da Sua Próxima Construção"
        title={firstName}
        subtitle={`${eventName}${formattedDate ? ` · ${formattedDate}` : ""}`}
      >
        <div className="inline-flex items-center gap-3 px-5 py-2 rounded-full border border-foreground bg-background/50 mt-3">
          <span className="text-[10px] uppercase tracking-[0.2em] font-display text-foreground">
            Trilha
          </span>
          <span className="text-sm font-medium font-display text-foreground">
            {content.trilha_recomendada}
          </span>
        </div>
      </CinematicHero>

      {/* Editorial content */}
      <article className="mx-auto max-w-2xl px-6 py-16 md:py-24 space-y-20 md:space-y-24">
        {/* 1. Análise */}
        <section className="space-y-5">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Análise
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="space-y-5">
            {analiseParagraphs.map((p, i) => (
              <p
                key={i}
                className="text-[17px] md:text-lg leading-[1.7] text-foreground font-body"
              >
                {renderBold(p)}
              </p>
            ))}
          </div>
        </section>

        {/* 2. Áreas-chave (vertical, full width) */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Áreas-chave
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="space-y-12">
            {content.areas_chave.map((area, i) => (
              <div key={i} className="space-y-3">
                <h3 className="font-display text-xl md:text-2xl text-foreground font-bold tracking-tight">
                  {area.nome}
                </h3>
                <p className="text-[17px] md:text-lg leading-[1.7] text-foreground font-body">
                  {renderBold(area.diagnostico)}
                </p>
                <p className="text-[15px] md:text-base leading-[1.6] text-foreground font-body italic">
                  <strong className="not-italic">Risco:</strong> {area.risco}
                </p>
                <p className="text-[15px] md:text-base leading-[1.6] text-foreground font-body">
                  <strong>Movimento:</strong> {area.movimento}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 3. Plano 30 dias (cards verticais) */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Plano de 30 dias
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="space-y-6">
            {content.plano_30_dias.map((step, i) => (
              <div key={i} className="border border-foreground p-6 md:p-8 space-y-5">
                <div className="flex gap-4 items-baseline">
                  <span className="font-display text-2xl md:text-3xl text-foreground font-bold leading-none">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-display text-lg md:text-xl text-foreground font-bold tracking-tight">
                    {step.titulo}
                  </h3>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-[0.18em] font-display font-bold text-foreground">
                    Objetivos
                  </p>
                  <ul className="space-y-1.5">
                    {step.objetivos.map((obj, j) => (
                      <li
                        key={j}
                        className="text-[15px] leading-[1.6] text-foreground font-body flex gap-2"
                      >
                        <span aria-hidden>•</span>
                        <span>{obj}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-[0.18em] font-display font-bold text-foreground">
                    Ação
                  </p>
                  <p className="text-[15px] leading-[1.65] text-foreground font-body">
                    {renderBold(step.acao)}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-[0.18em] font-display font-bold text-foreground">
                    Resultado esperado
                  </p>
                  <p className="text-[15px] leading-[1.65] text-foreground font-body">
                    {renderBold(step.resultado_esperado)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4. Pilares (vertical full width) */}
        <section className="space-y-8">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Pilares
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="space-y-8">
            {content.praticas.map((p, i) => (
              <div
                key={i}
                className="space-y-2 border-l-2 border-foreground pl-5"
              >
                <h3 className="font-display text-lg md:text-xl text-foreground font-bold tracking-tight">
                  {p.nome}
                </h3>
                <p className="text-[16px] leading-[1.65] text-foreground font-body">
                  {renderBold(p.descricao)}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 5. Frase de ativação */}
        <section className="space-y-10">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Frase de ativação
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="relative px-6 py-10 md:px-10 md:py-14 border-y-2 border-foreground bg-secondary/40">
            <blockquote className="font-display italic text-2xl md:text-3xl text-foreground leading-[1.4] text-center font-medium tracking-tight">
              &ldquo;{content.frase_ativacao.frase}&rdquo;
            </blockquote>
          </div>

          <div className="space-y-3">
            <p className="text-[10px] uppercase tracking-[0.18em] font-display font-bold text-foreground">
              Contexto
            </p>
            <div className="space-y-4">
              {contextoParagraphs.map((p, i) => (
                <p
                  key={i}
                  className="text-[17px] md:text-lg leading-[1.7] text-foreground font-body"
                >
                  {renderBold(p)}
                </p>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[10px] uppercase tracking-[0.18em] font-display font-bold text-foreground">
              Como aplicar
            </p>
            <div className="space-y-4">
              {aplicacaoParagraphs.map((p, i) => (
                <p
                  key={i}
                  className="text-[17px] md:text-lg leading-[1.7] text-foreground font-body"
                >
                  {renderBold(p)}
                </p>
              ))}
            </div>
          </div>

          <div className="border-l-2 border-foreground pl-5 py-2 bg-secondary/40 px-5 py-4">
            <p className="text-[10px] uppercase tracking-[0.2em] font-display font-bold text-foreground mb-2">
              Pergunte-se
            </p>
            <p className="font-display italic text-lg md:text-xl text-foreground leading-[1.5]">
              {content.frase_ativacao.pergunta_pratica}
            </p>
          </div>
        </section>

        {/* 6. Por que esta trilha */}
        <section className="space-y-5">
          <div className="space-y-3">
            <h2 className="font-display text-2xl md:text-3xl font-bold text-foreground uppercase tracking-[0.15em]">
              Por que esta trilha
            </h2>
            <div className="h-px w-16 bg-foreground" aria-hidden />
          </div>
          <div className="space-y-4">
            {justificativaParagraphs.map((p, i) => (
              <p
                key={i}
                className="text-[17px] md:text-lg leading-[1.7] text-foreground font-body"
              >
                {renderBold(p)}
              </p>
            ))}
          </div>
        </section>

        {/* 7. Yuri's note (opcional) */}
        {yuriNote && (
          <section className="space-y-4 border-l-2 border-foreground pl-6 py-2">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-display">
              Observação de {hostName}
            </p>
            <p className="font-display text-xl md:text-2xl text-foreground leading-[1.5] italic">
              &ldquo;{yuriNote}&rdquo;
            </p>
          </section>
        )}

        {/* Footer */}
        <footer className="pt-10 border-t border-border text-center space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-display">
            Prognóstico Inicial de Direção
          </p>
          <p className="text-sm text-foreground font-display">por {hostName}</p>
        </footer>
      </article>
    </main>
  );
}
