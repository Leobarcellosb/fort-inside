"use client";

import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import type { Participant, QuizResponse, Prognostic, TrailRecommendation } from "@/types/database";
import { Button } from "@/components/ui/button";

interface Props {
  participants: Participant[];
  responses: QuizResponse[];
  prognostics: Pick<Prognostic, "participant_id" | "trail_recommendation" | "status">[];
}

const TRAIL_COLORS: Record<string, string> = {
  "Exploração": "#60A5FA",
  "Direção": "#C9A961",
  "Aproximação": "#6EE7B7",
  "Aceleração": "#FCA5A5",
  "Sessão Privada": "#A78BFA",
};

const CHART_COLORS = ["#C9A961", "#60A5FA", "#6EE7B7", "#FCA5A5", "#A78BFA"];

export function AggregatedDashboard({ participants, responses, prognostics }: Props) {
  const metrics = useMemo(() => {
    const completed = participants.filter((p) => p.completed_at !== null).length;
    const delivered = prognostics.filter((p) => p.status === "delivered").length;

    // Trail distribution
    const trailCounts: Record<string, number> = {};
    prognostics.forEach((p) => {
      if (p.trail_recommendation) {
        trailCounts[p.trail_recommendation] = (trailCounts[p.trail_recommendation] ?? 0) + 1;
      }
    });
    const trailData = Object.entries(trailCounts).map(([name, value]) => ({ name, value }));

    // Stage 1 Q1 — journey moment distribution
    const momentCounts: Record<string, number> = {};
    responses
      .filter((r) => r.stage_id === 1)
      .forEach((r) => {
        const answer = (r.answers as Record<string, string>).q1;
        if (answer) momentCounts[answer] = (momentCounts[answer] ?? 0) + 1;
      });
    const momentData = Object.entries(momentCounts).map(([name, value]) => ({ name, value }));

    // Top blockers from stage 3 Q3 (text) & Q4 (select)
    const blockerCounts: Record<string, number> = {};
    responses
      .filter((r) => r.stage_id === 3)
      .forEach((r) => {
        const ans = (r.answers as Record<string, string>).q4;
        if (ans) blockerCounts[ans] = (blockerCounts[ans] ?? 0) + 1;
      });
    const blockerData = Object.entries(blockerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value]) => ({ name, value }));

    // Avg time per stage
    const stageTimes: Record<number, number[]> = {};
    // (simplified — just count responses per stage)
    const stageCompletions = [1, 2, 3, 4, 5].map((s) => ({
      stage: `Etapa ${s}`,
      completions: responses.filter((r) => r.stage_id === s).length,
    }));

    return { completed, delivered, trailData, momentData, blockerData, stageCompletions };
  }, [participants, responses, prognostics]);

  function exportCsv() {
    const rows = [
      ["Participante", "Completou", "Trilha", "Status"],
      ...participants.map((p) => {
        const prog = prognostics.find((pr) => pr.participant_id === p.id);
        return [
          p.full_name,
          p.completed_at ? "Sim" : "Não",
          prog?.trail_recommendation ?? "—",
          prog?.status ?? "—",
        ];
      }),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fort-inside-dashboard.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Participantes", value: participants.length },
          { label: "Completaram", value: metrics.completed },
          { label: "Prognósticos", value: prognostics.length },
          { label: "Entregues", value: metrics.delivered },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-card px-5 py-4">
            <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground mb-1">{label}</p>
            <p className="font-display text-3xl text-foreground">{value}</p>
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Trail distribution */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Distribuição de trilhas</p>
          {metrics.trailData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={metrics.trailData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label={({ name, percent }) =>
                    `${name} ${(percent * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                >
                  {metrics.trailData.map((entry, index) => (
                    <Cell
                      key={entry.name}
                      fill={TRAIL_COLORS[entry.name as TrailRecommendation] ?? CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: "#1C1C1C", border: "1px solid #2A2A2A", borderRadius: 6 }}
                  labelStyle={{ color: "#F5F1EA" }}
                  itemStyle={{ color: "#A39D91" }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">Sem dados ainda</p>
          )}
        </div>

        {/* Journey moment */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Momento da jornada</p>
          {metrics.momentData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={metrics.momentData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" horizontal={false} />
                <XAxis type="number" tick={{ fill: "#6B6557", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fill: "#A39D91", fontSize: 9 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1C1C1C", border: "1px solid #2A2A2A", borderRadius: 6 }}
                  labelStyle={{ color: "#F5F1EA" }}
                  itemStyle={{ color: "#A39D91" }}
                />
                <Bar dataKey="value" fill="#C9A961" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">Sem dados ainda</p>
          )}
        </div>

        {/* Top blockers */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Principais gargalos</p>
          {metrics.blockerData.length > 0 ? (
            <div className="space-y-2">
              {metrics.blockerData.map(({ name, value }) => (
                <div key={name} className="flex items-center gap-3">
                  <div
                    className="h-1.5 rounded-full bg-primary"
                    style={{ width: `${(value / participants.length) * 100}%`, minWidth: 8 }}
                  />
                  <span className="text-xs text-muted-foreground shrink-0">{name}</span>
                  <span className="text-xs text-primary ml-auto">{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">Sem dados ainda</p>
          )}
        </div>

        {/* Stage completions */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Conclusões por etapa</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={metrics.stageCompletions}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2A2A" vertical={false} />
              <XAxis dataKey="stage" tick={{ fill: "#6B6557", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#6B6557", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1C1C1C", border: "1px solid #2A2A2A", borderRadius: 6 }}
                labelStyle={{ color: "#F5F1EA" }}
                itemStyle={{ color: "#A39D91" }}
              />
              <Bar dataKey="completions" fill="#C9A961" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={exportCsv}
          className="border-border text-muted-foreground hover:text-foreground text-sm"
        >
          Exportar CSV
        </Button>
      </div>
    </div>
  );
}
