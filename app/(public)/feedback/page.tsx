"use client";

import { useEffect, useState } from "react";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { Logo } from "@/components/ui/Logo";
import type { NPSQualityRating } from "@/types/database";

const QUALITY_OPTIONS: { value: NPSQualityRating; label: string }[] = [
  { value: "nao_refletiu", label: "Não refletiu" },
  { value: "parcialmente", label: "Refletiu parcialmente" },
  { value: "bem", label: "Refletiu bem" },
  { value: "precisao", label: "Refletiu com precisão" },
];

const STORAGE_KEY = "fort_inside_nps_submitted";

export default function FeedbackPage() {
  const [submitted, setSubmitted] = useState(false);
  const [alreadySent, setAlreadySent] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<{
    full_name: string;
    nps_score: number | null;
    quality_rating: NPSQualityRating | "";
    highlight: string;
    improvement: string;
  }>({
    full_name: "",
    nps_score: null,
    quality_rating: "",
    highlight: "",
    improvement: "",
  });

  // Lê localStorage no client (evita hydration mismatch)
  useEffect(() => {
    try {
      setAlreadySent(!!localStorage.getItem(STORAGE_KEY));
    } catch {
      setAlreadySent(false);
    }
  }, []);

  async function handleSubmit() {
    setError("");

    if (!form.full_name.trim()) {
      setError("Por favor, preencha seu nome.");
      return;
    }
    if (form.nps_score === null) {
      setError("Por favor, escolha uma nota de 0 a 10.");
      return;
    }
    if (!form.quality_rating) {
      setError("Por favor, avalie como o prognóstico refletiu seu momento.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/nps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: form.full_name.trim(),
          nps_score: form.nps_score,
          quality_rating: form.quality_rating,
          highlight: form.highlight.trim() || null,
          improvement: form.improvement.trim() || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || "Erro ao enviar feedback.");
        setSubmitting(false);
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, "true");
      } catch {
        // tolerar Safari privado
      }
      setSubmitted(true);
    } catch {
      setError("Erro de conexão. Tente novamente.");
      setSubmitting(false);
    }
  }

  // Loading state pra evitar flash do form quando já existe registro local
  if (alreadySent === null) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </main>
    );
  }

  if (alreadySent || submitted) {
    return (
      <main className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <Logo size="lg" className="mb-8 opacity-90" />
        <div className="max-w-md text-center space-y-4">
          <h1 className="font-display text-5xl text-foreground font-bold">
            {submitted ? "Obrigado." : "Já recebemos seu feedback"}
          </h1>
          <p className="text-muted-foreground font-body text-base leading-relaxed">
            {submitted
              ? "Seu feedback foi recebido. O que você compartilhou aqui ajuda a próxima imersão a ser melhor."
              : "Obrigado por compartilhar. Cada palavra ajuda a próxima imersão a ser ainda melhor."}
          </p>
        </div>
      </main>
    );
  }

  const sectionLabel =
    "text-xs uppercase tracking-[0.2em] text-muted-foreground font-display font-bold block";
  const inputBase =
    "w-full p-3 border border-border rounded-md text-base font-body bg-background text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary transition-colors";

  return (
    <main className="min-h-screen bg-background">
      <div className="relative">
        <CinematicHero
          imageSrc="/cinematic/hero-join.jpg"
          imageAlt="Fort Inside"
          eyebrow="Fort Inside"
          title="Sua avaliação"
          subtitle="Conta pra gente como foi a imersão"
        />
        {/* Logo branca (invertida) sobreposta no topo do hero */}
        <div className="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 z-20">
          <Logo size="md" className="brightness-0 invert opacity-90" />
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-12 space-y-12">
        {/* PERGUNTA 1 — Nome */}
        <section className="space-y-3">
          <span className={sectionLabel}>Pergunta 1 de 5</span>
          <p className="text-foreground text-lg font-body font-medium">
            Como você se chama?
          </p>
          <input
            type="text"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            placeholder="Seu nome"
            className={inputBase}
          />
        </section>

        {/* PERGUNTA 2 — NPS */}
        <section className="space-y-3">
          <span className={sectionLabel}>Pergunta 2 de 5</span>
          <p className="text-foreground text-lg font-body font-medium">
            De 0 a 10, o quanto você recomendaria a imersão Fort Inside com Yuri Fortes para um amigo?
          </p>
          <div className="grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, i) => i).map((n) => {
              const selected = form.nps_score === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setForm({ ...form, nps_score: n })}
                  className={`p-2 text-sm rounded-md border transition-colors ${
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:border-primary/50"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Nada provável</span>
            <span>Extremamente provável</span>
          </div>
        </section>

        {/* PERGUNTA 3 — Qualidade do prognóstico */}
        <section className="space-y-3">
          <span className={sectionLabel}>Pergunta 3 de 5</span>
          <p className="text-foreground text-lg font-body font-medium">
            O prognóstico que você recebeu refletiu seu momento atual?
          </p>
          <div className="space-y-2">
            {QUALITY_OPTIONS.map((opt) => {
              const selected = form.quality_rating === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm({ ...form, quality_rating: opt.value })}
                  className={`w-full text-left px-4 py-3 rounded-md border text-base font-body transition-colors ${
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-foreground hover:border-primary/50"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* PERGUNTA 4 — O que marcou (opcional) */}
        <section className="space-y-3">
          <span className={sectionLabel}>Pergunta 4 de 5 — opcional</span>
          <p className="text-foreground text-lg font-body font-medium">
            O que mais te marcou na imersão?
          </p>
          <textarea
            value={form.highlight}
            onChange={(e) => setForm({ ...form, highlight: e.target.value })}
            rows={4}
            maxLength={2000}
            placeholder="Pode ser específico. O que ficou."
            className={`${inputBase} resize-none`}
          />
        </section>

        {/* PERGUNTA 5 — O que pode melhorar (opcional) */}
        <section className="space-y-3">
          <span className={sectionLabel}>Pergunta 5 de 5 — opcional</span>
          <p className="text-foreground text-lg font-body font-medium">
            O que poderia ser melhor?
          </p>
          <textarea
            value={form.improvement}
            onChange={(e) => setForm({ ...form, improvement: e.target.value })}
            rows={4}
            maxLength={2000}
            placeholder="Direto. Sem rodeio."
            className={`${inputBase} resize-none`}
          />
        </section>

        {error && (
          <p className="text-sm text-destructive font-body" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full p-4 bg-primary text-primary-foreground rounded-md font-display font-bold text-base uppercase tracking-[0.08em] disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          {submitting ? "Enviando..." : "Enviar avaliação"}
        </button>
      </div>
    </main>
  );
}
