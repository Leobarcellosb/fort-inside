"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Prognostic, PrognosticContent } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EditPrognosticDialog } from "./EditPrognosticDialog";
import { SuspenderDocumentoDialog } from "./SuspenderDocumentoDialog";
import { EnviarDocumentoDialog } from "./EnviarDocumentoDialog";
import { idDaRazao, situacaoDaEntrega } from "./entrega-do-documento";
import {
  ROTULO_SUSPENDER,
  situacaoDaSuspensao,
} from "./suspensao-do-documento";

interface Participant {
  id: string;
  full_name: string;
  email: string;
  completed_at: string | null;
}

interface Props {
  eventId: string;
  /** O evento gera PDF (questionario v1)? Repassado ao editor, que muda so o texto. */
  pdfDisponivel: boolean;
  participants: Participant[];
  prognostics: Prognostic[];
}

const TRAIL_COLORS: Record<string, string> = {
  "Exploração": "bg-chart-3/20 text-chart-3 border-chart-3/30",
  "Direção": "bg-chart-1/20 text-chart-1 border-chart-1/30",
  "Aproximação": "bg-chart-2/20 text-chart-2 border-chart-2/30",
  "Aceleração": "bg-chart-4/20 text-chart-4 border-chart-4/30",
  "Sessão Privada": "bg-primary/20 text-primary border-primary/30",
};

export function PrognosticReviewGrid({ eventId, pdfDisponivel, participants, prognostics }: Props) {
  const [localPrognostics, setLocalPrognostics] = useState<Prognostic[]>(prognostics);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suspendingId, setSuspendingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  // Realtime: sincroniza localPrognostics quando IA gera ou outro admin entrega.
  useEffect(() => {
    const supabase = createClient();
    const participantIds = new Set(participants.map((p) => p.id));

    const channel = supabase
      .channel(`prognostics-review-${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "prognostics",
        },
        (payload) => {
          const newRow = payload.new as Prognostic | undefined;
          const oldRow = payload.old as { id?: string; participant_id?: string } | undefined;

          if (
            payload.eventType === "INSERT" &&
            newRow?.participant_id &&
            participantIds.has(newRow.participant_id)
          ) {
            setLocalPrognostics((prev) => {
              if (prev.some((p) => p.id === newRow.id)) return prev;
              return [...prev, newRow];
            });
            return;
          }

          if (
            payload.eventType === "UPDATE" &&
            newRow?.participant_id &&
            participantIds.has(newRow.participant_id)
          ) {
            setLocalPrognostics((prev) =>
              prev.map((p) => (p.id === newRow.id ? newRow : p))
            );
            return;
          }

          if (payload.eventType === "DELETE" && oldRow?.id) {
            setLocalPrognostics((prev) => prev.filter((p) => p.id !== oldRow.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, participants]);

  /**
   * LIBERA o link (status `delivered`). Nao copia nem envia nada: quem chama e
   * a janela de envio, no mesmo clique em que o operador, com o destinatario
   * conferido, abre o WhatsApp ou copia a mensagem (Rodada 67).
   */
  async function liberar(prognosticId: string): Promise<boolean> {
    setSaving(true);
    try {
      const supabase = createClient();
      const prog = localPrognostics.find((p) => p.id === prognosticId);
      if (!prog) return false;

      const final = prog.edited_content ?? prog.raw_ai_output;

      type MutResult = { data: unknown; error: { message: string } | null };
      const { error } = await ((supabase.from("prognostics") as unknown as {
        update(v: Record<string, unknown>): { eq(c: string, v: string): Promise<MutResult> };
      }).update({
        final_content: final,
        status: "delivered",
        delivered_at: new Date().toISOString(),
      }).eq("id", prognosticId));

      if (error) throw error;

      setLocalPrognostics((prev) =>
        prev.map((p) =>
          p.id === prognosticId
            ? { ...p, final_content: final as PrognosticContent, status: "delivered" }
            : p
        )
      );

      // Editing a prognostic nulls pdf_url, so after an edited delivery there is
      // no PDF and nothing was generating one — the participant's page just sat
      // polling for 120s. Kick the render off here (the realtime subscription
      // picks up pdf_url when it lands).
      if (!prog.pdf_url) {
        fetch("/api/generate-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prognostic_id: prognosticId }),
        }).catch(() => {
          // Non-fatal: the participant still has the on-demand PDF button.
        });
      }

      return true;
    } catch (err) {
      // A entrega passa pelo portão do banco (migration 025): `delivered` exige
      // `final_content` com a MESMA impressão digital que a última revisão
      // humana aprovou. A recusa chega aqui como `check_violation` (23514), e
      // "Erro ao entregar" mandaria o host investigar a coisa errada -- ele
      // tentaria de novo, e seria recusado de novo, pelo mesmo motivo. A
      // mensagem abaixo é a mesma frase de PROGNOSTIC_APPROVAL_STALE em
      // lib/erros/mensagens-host.ts; esta tela escreve direto no banco (não há
      // rota no caminho), então o texto é escolhido aqui pelo código do banco.
      const codigo = (err as { code?: string } | null)?.code;
      toast.error(
        codigo === "23514"
          ? "Entrega recusada: o texto deste documento não é o que foi revisado e aprovado. Abra o documento, revise o texto como ele está agora e salve a revisão; depois disso a entrega é liberada."
          : "Erro ao entregar"
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  const editingProg = editingId
    ? localPrognostics.find((p) => p.id === editingId) ?? null
    : null;
  const editingParticipantName = editingProg
    ? participants.find((pt) => pt.id === editingProg.participant_id)?.full_name ?? ""
    : "";

  const sendingProg = sendingId
    ? localPrognostics.find((p) => p.id === sendingId) ?? null
    : null;
  const sendingParticipant = sendingProg
    ? participants.find((pt) => pt.id === sendingProg.participant_id) ?? null
    : null;

  const suspendingProg = suspendingId
    ? localPrognostics.find((p) => p.id === suspendingId) ?? null
    : null;
  const suspendingParticipantName = suspendingProg
    ? participants.find((pt) => pt.id === suspendingProg.participant_id)?.full_name ?? ""
    : "";

  return (
    <>
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {participants.map((participant) => {
        const prog = localPrognostics.find((p) => p.participant_id === participant.id);
        const content = (prog?.edited_content ?? prog?.raw_ai_output) as
          | PrognosticContent
          | undefined;
        const trail = content?.trilha_recomendada;
        const previewText = content?.analise_geral?.split(/\n\n+/)[0] ?? "";
        // A razão de "Entregar" estar desligado é calculada POR DOCUMENTO: o
        // texto nasce no cartão de quem está bloqueado e desaparece sozinho
        // quando aquele documento ganha revisão salva. Um aviso só no topo da
        // tela seria igual em todos os cartões e não diria QUAL documento.
        const entrega = prog ? situacaoDaEntrega(prog) : null;
        // E a MESMA ideia para "Tirar do ar" (migration 027): quem decide se o
        // controle aparece e uma funcao pura, e o banco e quem garante.
        const suspensao = prog ? situacaoDaSuspensao(prog) : null;
        const foraDoAr = prog?.status === "suspended";

        return (
          <div
            key={participant.id}
            className="rounded-lg border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">{participant.full_name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{participant.email}</p>
              </div>
              {prog && (
                <Badge
                  className={`text-xs shrink-0 border ${
                    prog.status === "delivered"
                      ? "bg-success/20 text-success border-success/30"
                      : prog.status === "suspended"
                      ? "bg-chart-4/20 text-chart-4 border-chart-4/30"
                      : prog.status === "reviewed"
                      ? "bg-primary/20 text-primary border-primary/30"
                      : "bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {prog.status === "delivered"
                    ? // "Link liberado" e nao "Entregue": o sistema sabe que
                      // disponibilizou, nao que a mensagem chegou (Rodada 67).
                      "Link liberado"
                    : prog.status === "suspended"
                    ? // "Fora do ar" e nao "Suspenso": o rotulo fala do ponto de
                      // vista de quem lia o documento, que e o que o operador
                      // precisa decidir. "Suspenso" e o nome da coluna.
                      "Fora do ar"
                    : prog.status === "reviewed"
                    ? "Revisado"
                    : "Gerado"}
                </Badge>
              )}
            </div>

            {trail && (
              <div
                className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs border ${
                  TRAIL_COLORS[trail] ?? ""
                }`}
              >
                {trail}
              </div>
            )}

            {previewText && (
              <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                {previewText}
              </p>
            )}

            {!prog && participant.completed_at && (
              <div className="flex items-center gap-2 text-foreground">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 opacity-60"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                {/* Esta tela nao le a fila: "gerando" era afirmado tambem para
                    quem ja tinha falhado 3 vezes. O estado de cada geracao
                    (na fila, gerando, falhou) e da secao Prognosticos do painel. */}
                <p className="text-xs">Documento ainda não existe. O andamento está no painel do evento.</p>
              </div>
            )}
            {!prog && !participant.completed_at && (
              <p className="text-xs text-muted-foreground italic">Aguardando participante</p>
            )}

            {/* A RAZÃO FICA NO CONTEÚDO DA TELA, não no `title` do botão.
                `title` só aparece no hover do mouse: em tela de toque não
                existe hover, e para leitor de tela um botão desabilitado nem
                entra na ordem de foco, então a descrição nunca é anunciada.
                Aqui o texto é lido por quem olha, por quem toca e por quem
                ouve a página, sem gesto nenhum. */}
            {prog && prog.status !== "delivered" && entrega && !entrega.liberada && (
              <div
                id={idDaRazao(prog.id)}
                data-testid={idDaRazao(prog.id)}
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground/80 space-y-2"
              >
                {/* No documento FORA DO AR, a primeira coisa que o operador
                    precisa saber é o que o PARTICIPANTE está vendo agora -- é o
                    que ele vai ter de responder se o jovem ligar. Depois vem o
                    caminho de volta, que é `entrega.texto`. São dois fatos
                    diferentes, não a mesma frase duas vezes. */}
                {foraDoAr && suspensao && !suspensao.disponivel && (
                  <p>{suspensao.texto}</p>
                )}
                <p>{entrega.texto}</p>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              {prog && prog.status !== "delivered" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingId(prog.id)}
                  disabled={saving}
                  className="text-xs border-border text-muted-foreground hover:text-foreground"
                >
                  Editar
                </Button>
              )}
              {prog && prog.status !== "delivered" && entrega && (
                // O botão fica DESLIGADO enquanto não há aprovação registrada
                // (migration 025): o banco recusaria a entrega de qualquer
                // maneira, e um botão que só pode falhar é pior do que um botão
                // que diz por que está desligado. A garantia é do banco; isto
                // aqui é só não oferecer o caminho sem saída. O selo em si é
                // escrito pelo gatilho quando a revisão é salva -- esta tela
                // não o calcula e não o escreve.
                //
                // `aria-describedby` amarra o botão ao parágrafo acima para quem
                // navega com leitor de tela e chega ao botão por outro caminho
                // (modo de leitura, lista de elementos). Não SUBSTITUI o texto
                // visível: ele é o que resolve para o operador de celular.
                <Button
                  size="sm"
                  onClick={() => setSendingId(prog.id)}
                  disabled={saving || !entrega.liberada}
                  aria-describedby={entrega.liberada ? undefined : idDaRazao(prog.id)}
                  className="flex-1 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Entregar
                </Button>
              )}
              {prog?.status === "delivered" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSendingId(prog.id)}
                  disabled={saving}
                  className="flex-1 text-xs border-border text-muted-foreground hover:text-foreground"
                >
                  Enviar de novo
                </Button>
              )}
              {/* TIRAR DO AR (migration 027). Aparece SÓ no documento entregue,
                  que é o único que alguém está lendo -- e é a mesma condição que
                  o banco impõe, então a tela não oferece um caminho sem saída.
                  `situacaoDaSuspensao` é quem decide, e quando ela recusa a razão
                  vai para o conteúdo da tela, nunca para um `title`. */}
              {prog && suspensao?.disponivel && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSuspendingId(prog.id)}
                  disabled={saving}
                  className="text-xs border-chart-4/40 text-chart-4 hover:bg-chart-4/10"
                >
                  {ROTULO_SUSPENDER}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>

    {sendingProg && sendingParticipant && (
      // `key` por documento: a conferencia do destinatario nasce desmarcada a
      // cada documento, e nada do anterior sobrevive no estado.
      <EnviarDocumentoDialog
        key={sendingProg.id}
        prognosticId={sendingProg.id}
        shareToken={sendingProg.public_share_token}
        participantName={sendingParticipant.full_name}
        participantEmail={sendingParticipant.email}
        jaEntregue={sendingProg.status === "delivered"}
        onLiberar={() => liberar(sendingProg.id)}
        onClose={() => setSendingId(null)}
      />
    )}

    {suspendingProg && (
      <SuspenderDocumentoDialog
        prognosticId={suspendingProg.id}
        participantName={suspendingParticipantName}
        onClose={() => setSuspendingId(null)}
        onSuspenso={() => {
          // A subscription de realtime propaga, mas atualiza localmente tambem
          // pra o cartao mudar na hora: o operador acabou de tirar um documento
          // do ar e precisa VER que saiu. `pdf_url` vira nulo porque o gatilho
          // da 027 o zera -- o PDF era do texto suspenso.
          setLocalPrognostics((prev) =>
            prev.map((p) =>
              p.id === suspendingProg.id
                ? { ...p, status: "suspended", pdf_url: null }
                : p,
            ),
          );
        }}
      />
    )}

    {editingProg && (
      <EditPrognosticDialog
        prognosticId={editingProg.id}
        participantName={editingParticipantName}
        initialContent={
          (editingProg.edited_content ?? editingProg.raw_ai_output) as PrognosticContent
        }
        initialYuriNote={editingProg.yuri_note}
        pdfDisponivel={pdfDisponivel}
        onClose={() => setEditingId(null)}
        onSaved={() => {
          const id = editingProg.id;
          setLocalPrognostics((prev) =>
            prev.map((p) => (p.id === id ? { ...p, status: "reviewed", pdf_url: null } : p))
          );
          // RELE O DOCUMENTO DO BANCO depois de salvar. O selo da aprovacao
          // (`conteudo_aprovado_hash`, migration 025) e escrito pelo GATILHO, nao
          // por esta tela; sem reler, o cartao continuava dizendo "ainda nao tem
          // revisao salva" com o botao Entregar desligado ate alguem recarregar
          // a pagina. O realtime cobria isso quando ligado; no ensaio local ele
          // estava desligado e o laco apareceu. A tela nao pode depender dele.
          void (async () => {
            const { data } = (await (createClient().from("prognostics") as unknown as {
              select(c: string): { eq(c: string, v: string): { maybeSingle(): Promise<{ data: Prognostic | null }> } };
            })
              .select("*")
              .eq("id", id)
              .maybeSingle());
            if (data) setLocalPrognostics((prev) => prev.map((p) => (p.id === id ? data : p)));
          })();
        }}
      />
    )}
    </>
  );
}
