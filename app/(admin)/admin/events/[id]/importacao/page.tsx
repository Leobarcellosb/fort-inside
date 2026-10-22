import { ImportarRespostasExternas } from "@/components/features/admin/ImportarRespostasExternas";

// A PAGINA da importacao externa.
//
// O portao de quem entra NAO esta aqui: `proxy.ts` protege `/admin/:path*` com
// `verificarAdminCom()`, e as rotas que esta tela chama verificam de novo com
// `verificarAdmin()`. Duas verificacoes, de proposito: a pagina nao e o que
// protege o dado, a rota e.
//
// A pagina e um Server Component e nao le nada do banco: tudo o que a tela mostra
// vem da PREVIA, que e a resposta de /api/importacao/previa. Se a pagina lesse por
// conta propria, haveria duas fontes para o mesmo numero, e elas divergiriam.

export default async function ImportacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Admin · Evento</p>
          <h1 className="font-display mt-1 text-2xl text-foreground">
            Importar respostas coletadas fora do aplicativo
          </h1>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            A coleta pré-evento começou por formulário externo, não pelo aplicativo. Esta tela traz essas
            respostas para dentro como respostas canônicas — depois de conferir que o questionário respondido é
            o que o sistema conhece, e de reconciliar cada submissão com um participante deste evento. Nada é
            gravado antes de você ver a prévia.
          </p>
        </div>

        <ImportarRespostasExternas eventId={id} />
      </div>
    </div>
  );
}
