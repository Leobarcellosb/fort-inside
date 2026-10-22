import { Logo } from "@/components/ui/Logo";
import {
  PARAGRAFOS_DOCUMENTO_SUSPENSO,
  RODAPE_DOCUMENTO_SUSPENSO,
  TITULO_DOCUMENTO_SUSPENSO,
} from "./documento-suspenso";

interface Props {
  /** Primeiro nome, só para a página falar com ele e não com um token. */
  participantName: string;
}

/**
 * A página que o jovem vê quando abre o link de um documento que saiu do ar
 * (migration 027).
 *
 * O que ela NÃO é, de propósito: um erro. Não há `notFound()`, não há status de
 * falha, não há ícone de alerta vermelho e não há botão de "tentar de novo" --
 * nada aqui acontece por tentar de novo. É um AVISO, escrito para ele, sobre uma
 * decisão que a organização tomou.
 *
 * O texto mora em `documento-suspenso.ts` e é provado lá. Este arquivo só o
 * coloca na tela.
 *
 * Esta tela NÃO recebe `content` nem `suspensao_motivo`, e isso é a metade
 * "não deixar o jovem exposto ao conteúdo incorreto" do princípio da 027: o
 * texto suspenso não chega ao navegador dele nem escondido no HTML.
 */
export function DocumentoSuspensoView({ participantName }: Props) {
  const firstName = participantName.trim().split(" ")[0];

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center px-5 py-16">
      <div className="w-full max-w-xl space-y-8">
        <div className="flex justify-center">
          <Logo size="md" />
        </div>

        <div className="rounded-lg border border-border bg-card p-6 md:p-8 space-y-5">
          <h1 className="font-display text-xl md:text-2xl font-bold leading-snug text-foreground">
            {firstName ? `${firstName}, ` : ""}
            {firstName
              ? TITULO_DOCUMENTO_SUSPENSO.charAt(0).toLowerCase() +
                TITULO_DOCUMENTO_SUSPENSO.slice(1)
              : TITULO_DOCUMENTO_SUSPENSO}
          </h1>

          {PARAGRAFOS_DOCUMENTO_SUSPENSO.map((paragrafo) => (
            <p key={paragrafo} className="text-sm md:text-base leading-relaxed text-foreground/85">
              {paragrafo}
            </p>
          ))}

          <p className="text-xs text-muted-foreground pt-2 border-t border-border">
            {RODAPE_DOCUMENTO_SUSPENSO}
          </p>
        </div>
      </div>
    </main>
  );
}
