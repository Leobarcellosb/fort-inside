"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  linkDoDocumento,
  linkDoWhatsApp,
  mensagemDeEnvio,
  numeroDoWhatsApp,
  telefoneLegivel,
  textoDaConferencia,
} from "./envio-do-documento";

interface Props {
  prognosticId: string;
  shareToken: string;
  participantName: string;
  participantEmail: string;
  /** Telefone deixado no formulario (opcional). Com ele, o WhatsApp abre na conversa. */
  participantPhone?: string | null;
  /** Ja disponibilizado: "Enviar de novo" nao libera nada, so mostra a mensagem. */
  jaEntregue: boolean;
  /** Disponibiliza o documento (status `delivered`). Devolve se o servidor confirmou. */
  onLiberar: () => Promise<boolean>;
  onClose: () => void;
}

/** O que a tela pode afirmar, nas palavras do CTO (Rodada 68). */
export const TEXTO_DISPONIBILIZADO =
  "Documento disponibilizado. Agora confira a conversa e envie a mensagem ao participante.";

/**
 * O envio de UM documento, em tres passos, com o destinatario na tela ate o fim
 * (Rodadas 67 e 68 do CTO):
 *
 *   1. CONFERIR. Nome completo em destaque e a conferencia do contato oficial,
 *      DESMARCADA a cada abertura (o componente monta de novo por documento:
 *      nada do anterior sobrevive no estado).
 *   2. DISPONIBILIZAR. O servidor confere revisao e selo e libera o link. Ate
 *      ele confirmar, a mensagem NAO fica disponivel para copiar nem abrir: o
 *      link so funciona depois da liberacao, e uma janela de WhatsApp aberta
 *      antes nao pode ser fechada com garantia se a liberacao falhar.
 *   3. COMPARTILHAR. So entao aparecem "Copiar mensagem" e "Abrir no WhatsApp".
 *      Nenhum dos dois e registrado como envio: `delivered` quer dizer
 *      documento disponibilizado, nunca mensagem enviada, recebida ou lida.
 */
export function EnviarDocumentoDialog({
  prognosticId,
  shareToken,
  participantName,
  participantEmail,
  participantPhone,
  jaEntregue: jaEntregueAoAbrir,
  onLiberar,
  onClose,
}: Props) {
  // Lido UMA vez, na abertura: liberar muda o status no cartao, e sem isto a
  // janela trocava de "Enviar documento" para "Enviar de novo" no meio do envio.
  const [jaEntregue] = useState(jaEntregueAoAbrir);
  const [conferido, setConferido] = useState(false);
  const [fase, setFase] = useState<"conferir" | "liberando" | "pronto">("conferir");

  const link = linkDoDocumento(window.location.origin, shareToken);
  const mensagem = mensagemDeEnvio(participantName, link);
  const numero = numeroDoWhatsApp(participantPhone);
  const idDaRazao = `envio-razao-${prognosticId}`;
  const idDoTitulo = `envio-titulo-${prognosticId}`;
  const ocupado = fase === "liberando";

  async function disponibilizar() {
    if (!conferido) return;
    if (jaEntregue) {
      setFase("pronto");
      return;
    }
    setFase("liberando");
    const ok = await onLiberar();
    // Falhou: volta para o passo 1, sem mensagem a vista. O motivo ja foi dito
    // por quem liberou (a recusa do banco tem texto proprio).
    setFase(ok ? "pronto" : "conferir");
    if (ok) toast.success(TEXTO_DISPONIBILIZADO);
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(mensagem);
      toast.success("Mensagem copiada. Confira a conversa antes de enviar.");
    } catch {
      // "Copiada" so com a copia confirmada (Rodada 67).
      toast.error("A cópia falhou. Selecione a mensagem e copie à mão.");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={idDoTitulo}
      className="fixed inset-0 z-50 bg-black/60 flex items-start md:items-center justify-center p-0 md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !ocupado) onClose();
      }}
    >
      <div className="bg-background border border-border md:rounded-lg max-w-lg w-full flex flex-col overflow-hidden">
        <header className="border-b border-border px-5 py-3">
          <h2 id={idDoTitulo} className="font-display text-base font-bold text-foreground">
            {jaEntregue ? "Enviar de novo" : "Enviar documento"}
          </h2>
          <p className="text-xs text-muted-foreground">Destinatário do documento</p>
        </header>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 space-y-1">
            <p className="text-base font-semibold text-foreground">{participantName}</p>
            <p className="text-xs text-muted-foreground">{participantEmail}</p>
            <p className="text-xs text-foreground">
              {numero
                ? `WhatsApp informado no formulário: ${telefoneLegivel(numero)}`
                : "Sem telefone no formulário: escolha a conversa no WhatsApp."}
            </p>
            <p className="text-xs leading-relaxed text-foreground/80">
              Envie só pelo contato oficial da organização (lista de convidados ou conversa individual
              já conhecida). Nunca pelo grupo do evento.
            </p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={conferido}
              onChange={(e) => setConferido(e.target.checked)}
              disabled={fase !== "conferir"}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span className="text-sm leading-relaxed text-foreground">
              {textoDaConferencia(participantName)}
            </span>
          </label>

          {fase === "pronto" ? (
            <div className="space-y-1.5">
              <p className="text-xs leading-relaxed text-foreground" role="status">
                {jaEntregue
                  ? "O documento já está disponível. Confira a conversa e envie a mensagem ao participante."
                  : TEXTO_DISPONIBILIZADO}
              </p>
              <p className="rounded-md border border-border px-3 py-2 text-sm leading-relaxed text-foreground break-words select-all">
                {mensagem}
              </p>
            </div>
          ) : (
            // A razao do botao desligado e conteudo da tela, como no resto do
            // painel: no celular nao ha hover, e leitor de tela nao anuncia a
            // descricao de botao desabilitado.
            <p id={idDaRazao} className="text-xs leading-relaxed text-foreground/70">
              {!conferido
                ? "Confira o contato antes: sem a conferência, o documento não é disponibilizado."
                : jaEntregue
                  ? "O link já funciona. Continue para ver a mensagem."
                  : "Ao disponibilizar, o link passa a funcionar. A mensagem aparece em seguida."}
            </p>
          )}
        </div>

        <footer className="border-t border-border px-5 py-3 flex flex-wrap justify-end gap-2">
          {fase === "pronto" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onClose}
                className="text-xs border-border text-muted-foreground hover:text-foreground"
              >
                Fechar
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={copiar}
                className="text-xs border-border text-foreground"
              >
                Copiar mensagem
              </Button>
              <a
                href={linkDoWhatsApp(mensagem, numero)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {numero ? "Abrir a conversa no WhatsApp" : "Abrir no WhatsApp"}
              </a>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={onClose}
                disabled={ocupado}
                className="text-xs border-border text-muted-foreground hover:text-foreground"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={disponibilizar}
                disabled={ocupado || !conferido}
                aria-describedby={idDaRazao}
                className="text-xs bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {ocupado ? "Disponibilizando…" : jaEntregue ? "Continuar" : "Disponibilizar documento"}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
