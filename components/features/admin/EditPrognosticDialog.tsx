"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { PrognosticContent, TrailRecommendation } from "@/types/database";
import { Button } from "@/components/ui/button";

const TRAILS: TrailRecommendation[] = [
  "Exploração",
  "Direção",
  "Aproximação",
  "Aceleração",
  "Sessão Privada",
];

interface Props {
  prognosticId: string;
  participantName: string;
  initialContent: PrognosticContent;
  initialYuriNote: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function EditPrognosticDialog({
  prognosticId,
  participantName,
  initialContent,
  initialYuriNote,
  onClose,
  onSaved,
}: Props) {
  const [content, setContent] = useState<PrognosticContent>(initialContent);
  const [yuriNote, setYuriNote] = useState(initialYuriNote ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/prognostics/${prognosticId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          yuri_note: yuriNote.trim() === "" ? null : yuriNote,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Erro ao salvar");
      toast.success("Edição salva. PDF será regenerado ao entregar.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  // Helpers tipados pra evitar repetição em onChange
  function updateArea(i: number, patch: Partial<PrognosticContent["areas_chave"][number]>) {
    const arr = [...content.areas_chave];
    arr[i] = { ...arr[i], ...patch };
    setContent({ ...content, areas_chave: arr });
  }
  function updatePlano(i: number, patch: Partial<PrognosticContent["plano_30_dias"][number]>) {
    const arr = [...content.plano_30_dias];
    arr[i] = { ...arr[i], ...patch };
    setContent({ ...content, plano_30_dias: arr });
  }
  function updateObjetivo(i: number, j: number, value: string) {
    const arr = [...content.plano_30_dias];
    const objs = [...arr[i].objetivos];
    objs[j] = value;
    arr[i] = { ...arr[i], objetivos: objs };
    setContent({ ...content, plano_30_dias: arr });
  }
  function addObjetivo(i: number) {
    const arr = [...content.plano_30_dias];
    arr[i] = { ...arr[i], objetivos: [...arr[i].objetivos, ""] };
    setContent({ ...content, plano_30_dias: arr });
  }
  function removeObjetivo(i: number, j: number) {
    const arr = [...content.plano_30_dias];
    arr[i] = { ...arr[i], objetivos: arr[i].objetivos.filter((_, k) => k !== j) };
    setContent({ ...content, plano_30_dias: arr });
  }
  function updatePratica(i: number, patch: Partial<PrognosticContent["praticas"][number]>) {
    const arr = [...content.praticas];
    arr[i] = { ...arr[i], ...patch };
    setContent({ ...content, praticas: arr });
  }

  const sectionLabel =
    "text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-display font-bold mb-2 block";
  const blockLabel =
    "text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-display font-bold mb-1 block";
  const inputBase =
    "w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary transition-colors";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-prognostic-title"
      className="fixed inset-0 z-50 bg-black/60 flex items-start md:items-center justify-center p-0 md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-background border border-border md:rounded-lg max-w-3xl w-full md:max-h-[92vh] h-full md:h-auto flex flex-col overflow-hidden">
        <header className="sticky top-0 bg-background border-b border-border px-5 py-3 flex justify-between items-center shrink-0">
          <div className="min-w-0">
            <h2
              id="edit-prognostic-title"
              className="font-display text-base font-bold text-foreground truncate"
            >
              Editar prognóstico
            </h2>
            <p className="text-xs text-muted-foreground truncate">{participantName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-2 -m-2 shrink-0"
            aria-label="Fechar"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-8">
          {/* TRILHA */}
          <section>
            <label className={sectionLabel}>Trilha recomendada</label>
            <div className="flex flex-wrap gap-2">
              {TRAILS.map((t) => {
                const selected = content.trilha_recomendada === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setContent({ ...content, trilha_recomendada: t })}
                    className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ANÁLISE GERAL */}
          <section>
            <label className={sectionLabel}>Análise geral</label>
            <textarea
              value={content.analise_geral}
              onChange={(e) => setContent({ ...content, analise_geral: e.target.value })}
              rows={10}
              className={inputBase}
              placeholder="3-5 parágrafos. Use **bold** em conceitos-chave."
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Markdown: <code>**texto**</code> vira negrito no PDF e na web.
            </p>
          </section>

          {/* ÁREAS-CHAVE */}
          <section>
            <label className={sectionLabel}>Áreas-chave</label>
            <div className="space-y-3">
              {content.areas_chave.map((area, i) => (
                <div key={i} className="border border-border rounded-md p-3 space-y-2">
                  <div>
                    <span className={blockLabel}>Nome</span>
                    <input
                      type="text"
                      value={area.nome}
                      onChange={(e) => updateArea(i, { nome: e.target.value })}
                      className={`${inputBase} font-display font-bold`}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Diagnóstico</span>
                    <textarea
                      value={area.diagnostico}
                      onChange={(e) => updateArea(i, { diagnostico: e.target.value })}
                      rows={3}
                      className={inputBase}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Risco</span>
                    <input
                      type="text"
                      value={area.risco}
                      onChange={(e) => updateArea(i, { risco: e.target.value })}
                      className={inputBase}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Movimento</span>
                    <input
                      type="text"
                      value={area.movimento}
                      onChange={(e) => updateArea(i, { movimento: e.target.value })}
                      className={inputBase}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* PLANO 30 DIAS */}
          <section>
            <label className={sectionLabel}>Plano de 30 dias</label>
            <div className="space-y-3">
              {content.plano_30_dias.map((step, i) => (
                <div key={i} className="border border-border rounded-md p-3 space-y-2">
                  <div>
                    <span className={blockLabel}>Título</span>
                    <input
                      type="text"
                      value={step.titulo}
                      onChange={(e) => updatePlano(i, { titulo: e.target.value })}
                      className={`${inputBase} font-display font-bold`}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Objetivos</span>
                    <div className="space-y-1.5">
                      {step.objetivos.map((obj, j) => (
                        <div key={j} className="flex gap-1.5">
                          <input
                            type="text"
                            value={obj}
                            onChange={(e) => updateObjetivo(i, j, e.target.value)}
                            className={inputBase}
                          />
                          <button
                            type="button"
                            onClick={() => removeObjetivo(i, j)}
                            className="px-2 text-xs text-muted-foreground hover:text-destructive border border-border rounded shrink-0"
                            aria-label="Remover objetivo"
                            disabled={step.objetivos.length <= 1}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addObjetivo(i)}
                        className="text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded px-2 py-1"
                      >
                        + Adicionar objetivo
                      </button>
                    </div>
                  </div>
                  <div>
                    <span className={blockLabel}>Ação</span>
                    <textarea
                      value={step.acao}
                      onChange={(e) => updatePlano(i, { acao: e.target.value })}
                      rows={2}
                      className={inputBase}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Resultado esperado</span>
                    <textarea
                      value={step.resultado_esperado}
                      onChange={(e) =>
                        updatePlano(i, { resultado_esperado: e.target.value })
                      }
                      rows={2}
                      className={inputBase}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* PILARES */}
          <section>
            <label className={sectionLabel}>Pilares</label>
            <div className="space-y-3">
              {content.praticas.map((p, i) => (
                <div key={i} className="border border-border rounded-md p-3 space-y-2">
                  <div>
                    <span className={blockLabel}>Nome</span>
                    <input
                      type="text"
                      value={p.nome}
                      onChange={(e) => updatePratica(i, { nome: e.target.value })}
                      className={`${inputBase} font-display font-bold`}
                    />
                  </div>
                  <div>
                    <span className={blockLabel}>Descrição</span>
                    <textarea
                      value={p.descricao}
                      onChange={(e) => updatePratica(i, { descricao: e.target.value })}
                      rows={3}
                      className={inputBase}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* FRASE DE ATIVAÇÃO */}
          <section>
            <label className={sectionLabel}>Frase de ativação</label>
            <div className="border border-border rounded-md p-3 space-y-2">
              <div>
                <span className={blockLabel}>Frase</span>
                <textarea
                  value={content.frase_ativacao.frase}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      frase_ativacao: { ...content.frase_ativacao, frase: e.target.value },
                    })
                  }
                  rows={2}
                  className={`${inputBase} italic`}
                />
              </div>
              <div>
                <span className={blockLabel}>Contexto</span>
                <textarea
                  value={content.frase_ativacao.contexto}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      frase_ativacao: { ...content.frase_ativacao, contexto: e.target.value },
                    })
                  }
                  rows={4}
                  className={inputBase}
                />
              </div>
              <div>
                <span className={blockLabel}>Como aplicar</span>
                <textarea
                  value={content.frase_ativacao.aplicacao}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      frase_ativacao: { ...content.frase_ativacao, aplicacao: e.target.value },
                    })
                  }
                  rows={4}
                  className={inputBase}
                />
              </div>
              <div>
                <span className={blockLabel}>Pergunta prática</span>
                <input
                  type="text"
                  value={content.frase_ativacao.pergunta_pratica}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      frase_ativacao: {
                        ...content.frase_ativacao,
                        pergunta_pratica: e.target.value,
                      },
                    })
                  }
                  className={inputBase}
                />
              </div>
            </div>
          </section>

          {/* JUSTIFICATIVA TRILHA */}
          <section>
            <label className={sectionLabel}>Por que esta trilha</label>
            <textarea
              value={content.justificativa_trilha}
              onChange={(e) =>
                setContent({ ...content, justificativa_trilha: e.target.value })
              }
              rows={6}
              className={inputBase}
            />
          </section>

          {/* YURI NOTE */}
          <section>
            <label className={sectionLabel}>Observação pessoal (opcional)</label>
            <textarea
              value={yuriNote}
              onChange={(e) => setYuriNote(e.target.value)}
              rows={3}
              placeholder="Linha de fechamento sua. Aparece na última página do PDF."
              className={`${inputBase} italic`}
            />
          </section>
        </div>

        <footer className="sticky bottom-0 bg-background border-t border-border px-5 py-3 flex justify-end gap-2 shrink-0">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            className="text-xs"
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
