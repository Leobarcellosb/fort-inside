import { KnowledgeBaseManager } from "@/components/features/admin/KnowledgeBaseManager";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-10">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Admin</p>
          <h1 className="font-display text-2xl text-foreground mt-1">Configurações</h1>
        </div>

        <section className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-foreground uppercase tracking-[0.1em]">Base de Conhecimento</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Documentos e textos que o Claude vai usar como contexto ao gerar os prognósticos.
              Adicione metodologias, frameworks, perfis de trilha, ou qualquer conteúdo que deve
              orientar a análise.
            </p>
          </div>

          <KnowledgeBaseManager />
        </section>
      </div>
    </div>
  );
}
