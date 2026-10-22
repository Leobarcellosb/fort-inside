"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { mensagemParaHost } from "@/lib/erros/mensagens-host";
import { ehCodigoDeErro, ehCodigoDeErroDocumento } from "@/lib/erros/codigos";
import {
  ROTULO_SUSPENDER,
  TEXTO_DA_CONFIRMACAO,
  TEXTO_MOTIVO_OBRIGATORIO,
  TITULO_DA_CONFIRMACAO,
  validarMotivoDaSuspensao,
} from "./suspensao-do-documento";

interface Props {
  prognosticId: string;
  participantName: string;
  onClose: () => void;
  onSuspenso: () => void;
}

/**
 * A confirmação da suspensão, com o MOTIVO escrito ali.
 *
 * Por que o motivo é digitado aqui e não depois: a suspensão é ato de operador e
 * o banco não aceita o ato sem ele (migration 027). Pedir o motivo "depois"
 * significaria ou gravar sem motivo (impossível, e bem) ou perder o ato.
 *
 * A razão de o botão de confirmar estar desligado fica no CONTEÚDO do diálogo,
 * ligada ao campo por `aria-describedby` -- mesma regra do resto desta tela: a
 * explicação de um controle desligado nunca vive num `title`, que só existe no
 * hover do mouse.
 */
export function SuspenderDocumentoDialog({
  prognosticId,
  participantName,
  onClose,
  onSuspenso,
}: Props) {
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  const validacao = validarMotivoDaSuspensao(motivo);
  const idDaRazaoDoCampo = `motivo-suspensao-razao-${prognosticId}`;

  async function confirmar() {
    if (!validacao.valido) return;
    setEnviando(true);
    try {
      const res = await fetch(`/api/prognostics/${prognosticId}/suspender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: validacao.motivo }),
      });
      const json = (await res.json()) as { code?: string };
      if (!res.ok) {
        // O host lê a mensagem do vocabulário, nunca o `error` do corpo (que é
        // texto de servidor). Código fora do vocabulário cai na genérica.
        const codigo = json.code;
        const conhecido =
          typeof codigo === "string" &&
          (ehCodigoDeErroDocumento(codigo) || ehCodigoDeErro(codigo));
        throw new Error(
          conhecido
            ? mensagemParaHost(codigo as Parameters<typeof mensagemParaHost>[0])
            : mensagemParaHost("PROGNOSTIC_WRITE_UNAVAILABLE"),
        );
      }
      toast.success("Fora do ar. O participante que abrir o link vê o aviso.");
      onSuspenso();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : mensagemParaHost("PROGNOSTIC_WRITE_UNAVAILABLE"),
      );
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`suspender-titulo-${prognosticId}`}
      className="fixed inset-0 z-50 bg-black/60 flex items-start md:items-center justify-center p-0 md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-background border border-border md:rounded-lg max-w-lg w-full flex flex-col overflow-hidden">
        <header className="border-b border-border px-5 py-3">
          <h2
            id={`suspender-titulo-${prognosticId}`}
            className="font-display text-base font-bold text-foreground"
          >
            {TITULO_DA_CONFIRMACAO}
          </h2>
          <p className="text-xs text-muted-foreground truncate">{participantName}</p>
        </header>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs leading-relaxed text-foreground/80">{TEXTO_DA_CONFIRMACAO}</p>

          <div className="space-y-2">
            <label
              htmlFor={`motivo-suspensao-${prognosticId}`}
              className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-display font-bold block"
            >
              Por que está saindo do ar
            </label>
            <textarea
              id={`motivo-suspensao-${prognosticId}`}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              aria-describedby={idDaRazaoDoCampo}
              placeholder="Ex.: a trilha recomendada saiu trocada — o texto cita Aceleração e a análise é de Direção."
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary transition-colors"
            />
            {/* A razão fica no CONTEÚDO da tela, visível, sempre -- tanto quando
                explica por que o botão está desligado quanto quando só diz o que
                este campo é. Em celular não existe hover, e um leitor de tela não
                anuncia a descrição de um botão desabilitado. */}
            <p
              id={idDaRazaoDoCampo}
              data-testid={idDaRazaoDoCampo}
              className="text-xs leading-relaxed text-foreground/70"
            >
              {validacao.valido ? TEXTO_MOTIVO_OBRIGATORIO : validacao.texto}
            </p>
          </div>
        </div>

        <footer className="border-t border-border px-5 py-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            disabled={enviando}
            className="text-xs border-border text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={confirmar}
            disabled={enviando || !validacao.valido}
            aria-describedby={idDaRazaoDoCampo}
            className="text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {ROTULO_SUSPENDER}
          </Button>
        </footer>
      </div>
    </div>
  );
}
