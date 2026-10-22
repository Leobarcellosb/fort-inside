import Link from "next/link";
import { ResolverIdentidadesExternas } from "@/components/features/admin/ResolverIdentidadesExternas";

// A PAGINA DA DECISAO DO OPERADOR sobre identidade.
//
// O portao de quem entra NAO esta aqui: `proxy.ts` protege `/admin/:path*` com
// `verificarAdminCom()`, e as tres rotas que esta tela chama verificam de novo
// com `verificarAdmin()`. Duas verificacoes, de proposito: a pagina nao e o que
// protege o dado, a rota e.
//
// A pagina e um Server Component e nao le nada do banco: tudo o que a tela mostra
// vem da MESA, que e a resposta de /api/importacao/decisoes. Se a pagina lesse por
// conta propria, haveria duas fontes para o mesmo numero, e elas divergiriam.

export default async function DecisoesDeIdentidadePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Admin · Evento</p>
          <h1 className="font-display mt-1 text-2xl text-foreground">
            Resolver identidade de respostas importadas
          </h1>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Quando a identidade de uma submissão externa não casa automaticamente, ela fica{" "}
            <strong>pendente</strong> ou <strong>em conflito</strong> — visível, guardada inteira, e nunca
            atribuída a quem não é. Aqui essas submissões são resolvidas: você afirma de quem é cada uma, a
            afirmação fica registrada com o seu nome e a sua justificativa, e pode ser revogada depois. A
            tela mostra, antes de cada confirmação, exatamente o que você está afirmando e o que não bate.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            <Link
              href={`/admin/events/${id}/importacao`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              ← Importar respostas coletadas fora do aplicativo
            </Link>
          </p>
        </div>

        <ResolverIdentidadesExternas eventId={id} />
      </div>
    </div>
  );
}
