import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { NPSResponse, NPSQualityRating } from "@/types/database";

// Admin NPS dashboard — protegido pelo proxy `/admin/:path*`.
// Lê via admin client (bypass RLS) — service role só no servidor.

const QUALITY_LABEL: Record<NPSQualityRating, string> = {
  nao_refletiu: "Não refletiu",
  parcialmente: "Refletiu parcialmente",
  bem: "Refletiu bem",
  precisao: "Refletiu com precisão",
};

const QUALITY_STYLE: Record<NPSQualityRating, string> = {
  nao_refletiu: "border-destructive/30 text-destructive bg-destructive/10",
  parcialmente: "border-border text-muted-foreground",
  bem: "border-primary/30 text-primary bg-primary/10",
  precisao: "border-success/30 text-success bg-success/10",
};

export const dynamic = "force-dynamic";

export default async function NpsAdminPage() {
  const supabase = createAdminClient();

  const { data, error } = (await (supabase
    .from("nps_responses") as unknown as {
    select(cols: string): {
      order(col: string, opts: { ascending: boolean }): Promise<{
        data: NPSResponse[] | null;
        error: { message: string } | null;
      }>;
    };
  })
    .select("id, full_name, nps_score, quality_rating, highlight, improvement, created_at")
    .order("created_at", { ascending: false })) as {
    data: NPSResponse[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return (
      <div className="min-h-screen bg-background p-8">
        <p className="text-destructive">Erro ao carregar respostas: {error.message}</p>
        <p className="text-muted-foreground text-sm mt-2">
          Confirme que a tabela <code>nps_responses</code> existe no Supabase.
        </p>
      </div>
    );
  }

  const responses = data ?? [];
  const total = responses.length;

  // NPS = % promotores (9-10) − % detratores (0-6). Passivos (7-8) não contam.
  const promoters = responses.filter((r) => r.nps_score >= 9).length;
  const passives = responses.filter((r) => r.nps_score >= 7 && r.nps_score <= 8).length;
  const detractors = responses.filter((r) => r.nps_score <= 6).length;
  const nps = total > 0 ? Math.round((promoters / total) * 100 - (detractors / total) * 100) : 0;
  const avgScore =
    total > 0
      ? (responses.reduce((acc, r) => acc + r.nps_score, 0) / total).toFixed(1)
      : "—";

  // Distribuição por nota (0-10)
  const scoreDistribution: number[] = Array.from({ length: 11 }, (_, i) =>
    responses.filter((r) => r.nps_score === i).length
  );
  const maxCount = Math.max(...scoreDistribution, 1);

  // Qualidade do prognóstico
  const qualityCounts: Record<NPSQualityRating, number> = {
    nao_refletiu: 0,
    parcialmente: 0,
    bem: 0,
    precisao: 0,
  };
  for (const r of responses) qualityCounts[r.quality_rating]++;

  function ScoreBadge({ score }: { score: number }) {
    const tier =
      score >= 9
        ? "border-success/40 text-success bg-success/10"
        : score >= 7
        ? "border-border text-muted-foreground"
        : "border-destructive/30 text-destructive bg-destructive/10";
    return (
      <span
        className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-display font-bold border ${tier}`}
      >
        {score}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              Admin
            </p>
            <h1 className="font-display text-2xl text-foreground mt-1">
              Avaliações Fort Inside
            </h1>
          </div>
          <div className="flex gap-2">
            <Button
              asChild
              variant="outline"
              className="border-border text-muted-foreground hover:text-foreground"
            >
              <Link href="/admin/events">Eventos</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-border text-muted-foreground hover:text-foreground"
            >
              <Link href="/feedback/qr" target="_blank" rel="noopener noreferrer">
                Mostrar QR
              </Link>
            </Button>
          </div>
        </div>

        {/* Métricas top */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">NPS</p>
            <p className="font-display text-4xl font-bold text-foreground mt-2">
              {total > 0 ? nps : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Promotores − Detratores
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Nota média
            </p>
            <p className="font-display text-4xl font-bold text-foreground mt-2">
              {avgScore}
            </p>
            <p className="text-xs text-muted-foreground mt-1">de 0 a 10</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Respostas
            </p>
            <p className="font-display text-4xl font-bold text-foreground mt-2">{total}</p>
            <p className="text-xs text-muted-foreground mt-1">total recebidas</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">
              Mix
            </p>
            <p className="font-display text-sm font-bold text-foreground mt-2 leading-tight">
              <span className="text-success">{promoters}</span>
              <span className="text-muted-foreground/60"> · </span>
              <span className="text-muted-foreground">{passives}</span>
              <span className="text-muted-foreground/60"> · </span>
              <span className="text-destructive">{detractors}</span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">prom · pass · detr</p>
          </div>
        </div>

        {/* Distribuição de notas */}
        <div className="rounded-lg border border-border bg-card p-5 mb-6">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground mb-4">
            Distribuição de notas
          </p>
          <div className="grid grid-cols-11 gap-1.5 items-end h-32">
            {scoreDistribution.map((count, score) => {
              const height = total > 0 ? (count / maxCount) * 100 : 0;
              const tier =
                score >= 9
                  ? "bg-success/70"
                  : score >= 7
                  ? "bg-muted-foreground/40"
                  : "bg-destructive/60";
              return (
                <div key={score} className="flex flex-col items-center gap-1">
                  <div className="flex-1 w-full flex items-end">
                    <div
                      className={`w-full rounded-t ${tier} transition-all`}
                      style={{ height: `${height}%`, minHeight: count > 0 ? 4 : 0 }}
                      title={`${count} resposta(s)`}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {score}
                  </span>
                  <span className="text-[10px] text-foreground font-bold">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Qualidade do prognóstico */}
        <div className="rounded-lg border border-border bg-card p-5 mb-8">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground mb-4">
            Como o prognóstico refletiu o momento
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {(Object.keys(QUALITY_LABEL) as NPSQualityRating[]).map((key) => {
              const c = qualityCounts[key];
              const pct = total > 0 ? Math.round((c / total) * 100) : 0;
              return (
                <div key={key} className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{QUALITY_LABEL[key]}</p>
                  <p className="font-display text-2xl font-bold text-foreground">
                    {c}
                    <span className="text-sm text-muted-foreground font-normal ml-1.5">
                      ({pct}%)
                    </span>
                  </p>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lista de respostas */}
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground mb-2">
            Todas as respostas ({total})
          </p>

          {responses.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-muted-foreground text-sm">
                Nenhuma resposta recebida ainda.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-2">
                Compartilhe{" "}
                <Link
                  href="/feedback/qr"
                  target="_blank"
                  className="underline hover:text-foreground"
                >
                  /feedback/qr
                </Link>{" "}
                ao final da imersão.
              </p>
            </div>
          ) : (
            responses.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border bg-card p-4 md:p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <ScoreBadge score={r.nps_score} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {r.full_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                  <Badge
                    className={`text-[10px] shrink-0 border ${
                      QUALITY_STYLE[r.quality_rating]
                    }`}
                  >
                    {QUALITY_LABEL[r.quality_rating]}
                  </Badge>
                </div>

                {(r.highlight || r.improvement) && (
                  <div className="space-y-2 pt-2 border-t border-border">
                    {r.highlight && (
                      <div>
                        <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold mb-1">
                          O que marcou
                        </p>
                        <p className="text-sm text-foreground leading-relaxed font-body whitespace-pre-wrap">
                          {r.highlight}
                        </p>
                      </div>
                    )}
                    {r.improvement && (
                      <div>
                        <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold mb-1">
                          O que melhorar
                        </p>
                        <p className="text-sm text-foreground leading-relaxed font-body whitespace-pre-wrap">
                          {r.improvement}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
