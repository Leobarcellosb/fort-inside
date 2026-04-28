"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type KBEntry = {
  id: string;
  title: string;
  type: "text" | "file";
  file_name: string | null;
  created_at: string;
  content: string;
};

export function KnowledgeBaseManager() {
  const [entries, setEntries] = useState<KBEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Text form
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  // File upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileTitle, setFileTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);

  async function fetchEntries() {
    setLoading(true);
    try {
      const res = await fetch("/api/knowledge-base");
      const data = await res.json();
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchEntries(); }, []);

  async function submitText(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, type: "text" }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setTitle("");
      setContent("");
      toast.success("Entrada adicionada.");
      await fetchEntries();
    } catch {
      toast.error("Erro ao salvar.");
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadFile(file: File, customTitle?: string) {
    const form = new FormData();
    form.append("file", file);
    form.append("title", customTitle || file.name.replace(/\.[^.]+$/, ""));
    setSubmitting(true);
    try {
      const res = await fetch("/api/knowledge-base", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).error);
      setFileTitle("");
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Arquivo carregado.");
      await fetchEntries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao enviar arquivo.");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteEntry(id: string) {
    await fetch(`/api/knowledge-base?id=${id}`, { method: "DELETE" });
    toast.success("Removido.");
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  return (
    <div className="space-y-8">
      {/* Text input */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Adicionar texto</p>
        <form onSubmit={submitText} className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Título</Label>
            <Input
              placeholder="ex: Metodologia Fort Inside"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Conteúdo</Label>
            <Textarea
              placeholder="Cole aqui a metodologia, descrição das trilhas, critérios de análise..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              className="bg-transparent border border-border rounded-lg focus-visible:ring-0 focus-visible:border-primary resize-none text-sm"
            />
          </div>
          <Button
            type="submit"
            disabled={submitting || !title.trim() || !content.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-xs h-9"
          >
            {submitting ? "Salvando..." : "Adicionar"}
          </Button>
        </form>
      </div>

      {/* File upload */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Subir arquivo</p>
        <p className="text-xs text-muted-foreground">Formatos suportados: .txt, .md, .json</p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) uploadFile(file, fileTitle || undefined);
          }}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
          }`}
        >
          <p className="text-sm text-muted-foreground">
            Arraste um arquivo aqui ou <span className="text-primary">clique para selecionar</span>
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.json,text/plain,text/markdown"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFile(file, fileTitle || undefined);
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Título personalizado <span className="opacity-50">(opcional)</span></Label>
          <Input
            placeholder="Deixe vazio para usar o nome do arquivo"
            value={fileTitle}
            onChange={(e) => setFileTitle(e.target.value)}
            className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0"
          />
        </div>
      </div>

      {/* Entries list */}
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          {loading ? "Carregando..." : `${entries.length} entrada${entries.length !== 1 ? "s" : ""}`}
        </p>

        {entries.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-mono ${
                  entry.type === "file"
                    ? "border-primary/40 text-primary bg-primary/5"
                    : "border-border text-muted-foreground"
                }`}>
                  {entry.type === "file" ? entry.file_name?.split(".").pop() ?? "file" : "texto"}
                </span>
                <span className="text-sm text-foreground truncate">{entry.title}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2"
                >
                  {expanded === entry.id ? "Fechar" : "Ver"}
                </button>
                <button
                  onClick={() => deleteEntry(entry.id)}
                  className="text-xs text-destructive hover:text-destructive/80 transition-colors px-2"
                >
                  Remover
                </button>
              </div>
            </div>

            {expanded === entry.id && (
              <div className="px-4 pb-4 border-t border-border pt-3">
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-body leading-relaxed max-h-64 overflow-y-auto">
                  {entry.content}
                </pre>
              </div>
            )}
          </div>
        ))}

        {!loading && entries.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Nenhuma entrada ainda. Adicione textos ou faça upload de arquivos acima.
          </p>
        )}
      </div>
    </div>
  );
}
