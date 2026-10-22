"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import { notFound, useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { QuizQuestion, QuizStage } from "@/types/database";
import React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { AvisoDaJanela } from "@/components/features/participant/AvisoDaJanela";
import { useJanelaDaEtapa } from "@/components/features/participant/useJanelaDaEtapa";
import { diagnosticarRecusaLive } from "@/components/features/participant/diagnostico-de-recusa-live";
import type { FaseDaJanela } from "@/components/features/participant/janela-da-etapa";
import {
  MSG_ENVIO_FALHA_GENERICA,
  MSG_ENVIO_SEM_CONEXAO,
  MSG_ETAPA_NAO_LIBERADA,
  MSG_SESSAO_DE_LOGIN_EXPIRADA,
  avisoDeTransicao,
  mensagemDeRecusa,
  textoParaCopiar,
} from "@/components/features/participant/textos-da-janela";
import { getStageImage, marcaDoEvento } from "@/lib/cinematic-map";
import {
  carregarEtapa,
  lerNumeroDaEtapa,
  rotuloDaEtapa,
  type ClienteDeLeitura,
} from "@/lib/quiz/carregar-etapa";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ stageId: string }>;
}

export default function QuizPage({ params }: Props) {
  const { stageId } = use(params);
  const router = useRouter();
  // A URL carrega o NUMERO da etapa dentro do quiz do evento ("Etapa 1"), nao o
  // id da linha em quiz_stages (a v2 do Marco Zero tem ids 101..105). Ver
  // lib/quiz/carregar-etapa.ts.
  const stageNum = lerNumeroDaEtapa(stageId) ?? NaN;

  const [stage, setStage] = useState<QuizStage | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [totalEtapas, setTotalEtapas] = useState<number | null>(null);
  const [stageMissing, setStageMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Janela do formulario assincrono (migration 010). No modo live este hook le o
  // evento, ve `live` e nao faz mais nada: nenhuma rota, nenhum bloqueio.
  const janela = useJanelaDaEtapa({
    eventId,
    participantId,
    numeroDaEtapa: stageNum,
    ativo: !!stage,
  });
  // Prazo encerrado: os campos ficam visiveis e somente leitura. O que a pessoa
  // escreveu nunca some da tela, e nada novo e gravado (nem no rascunho local).
  const somenteLeitura = janela.bloqueada;

  // A fase mudou com a pessoa ja na tela (ela pode estar la embaixo, escrevendo,
  // longe do aviso do topo): avisa por toast. Na carga inicial nao dispara: o
  // aviso do topo ja esta a vista. Fora do async `fase` e sempre null.
  const faseAnterior = useRef<FaseDaJanela | null>(null);
  useEffect(() => {
    const antes = faseAnterior.current;
    faseAnterior.current = janela.fase;
    if (antes === null || janela.fase === null || antes === janela.fase) return;
    const msg = avisoDeTransicao(janela.fase);
    if (!msg) return;
    if (janela.fase === "encerrada") toast.error(msg, { id: "prazo", duration: 15000 });
    else toast.warning(msg, { id: "prazo", duration: 12000 });
  }, [janela.fase]);

  useEffect(() => {
    const pid = localStorage.getItem("fort_participant_id");
    const eid = localStorage.getItem("fort_event_id");
    if (!pid || !eid) { router.replace("/"); return; }
    setParticipantId(pid);
    setEventId(eid);
  }, [router]);

  useEffect(() => {
    if (!participantId || !eventId) return;
    if (!Number.isInteger(stageNum)) {
      setStageMissing(true);
      return;
    }
    let cancelado = false;
    const supabase = createClient() as unknown as ClienteDeLeitura;
    carregarEtapa(supabase, eventId, stageNum)
      .then((r) => {
        if (cancelado) return;
        if (r.ok) {
          setStage(r.etapa);
          setTotalEtapas(r.totalEtapas);
          // O rascunho e guardado por id da etapa (nao pelo numero): na v1 id e
          // numero coincidem, entao rascunhos antigos continuam valendo, e um
          // rascunho da v1 nunca vaza para a etapa de mesmo numero da v2.
          const saved = localStorage.getItem(`fort_answers_${r.etapa.id}`);
          if (saved) {
            try { setAnswers(JSON.parse(saved)); } catch { /* ignore */ }
          }
        } else if (r.motivo === "erro") {
          setLoadFailed(true);
        } else {
          setStageMissing(true);
        }
      })
      .catch((err) => {
        console.error("[quiz] falha ao carregar etapa", err);
        if (!cancelado) setLoadFailed(true);
      });
    return () => {
      cancelado = true;
    };
  }, [stageNum, participantId, eventId]);

  const autosave = useCallback(
    (updated: Record<string, string | string[] | number>) => {
      if (!stage) return;
      localStorage.setItem(`fort_answers_${stage.id}`, JSON.stringify(updated));
    },
    [stage]
  );

  function setAnswer(questionId: string, value: string | string[] | number) {
    if (somenteLeitura) return;
    const updated = { ...answers, [questionId]: value };
    setAnswers(updated);
    autosave(updated);
  }

  // ranking: toca em uma opção para dar a ela a próxima posição livre;
  // tocar de novo numa opção já ordenada remove e reordena as demais.
  function toggleRanking(question: QuizQuestion, option: string) {
    const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
    const updated = current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option];
    setAnswer(question.id, updated);
  }

  // multi_select: alterna a opção, respeitando max_choices quando definido.
  function toggleMultiSelect(question: QuizQuestion, option: string) {
    const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
    if (current.includes(option)) {
      setAnswer(question.id, current.filter((o) => o !== option));
      return;
    }
    if (question.max_choices && current.length >= question.max_choices) return;
    setAnswer(question.id, [...current, option]);
  }

  const allValid = !!stage && stage.questions.every((q) => {
    const val = answers[q.id];
    switch (q.type) {
      case "select":
      case "short_text":
      case "dilemma": {
        const str = typeof val === "string" ? val : "";
        return q.required ? str.length > 0 : true;
      }
      case "text": {
        const str = typeof val === "string" ? val : "";
        const min = q.min_chars ?? 0;
        // Sem min_chars, `required` e o que exige resposta. O piso de
        // caracteres era pedagogicamente ruim: os 10 participantes do FORT26
        // escreveram 2 a 3x o minimo, entao ele nunca puxou profundidade —
        // so punia com erro vermelho quem tinha uma resposta curta e honesta.
        if (min > 0) return str.trim().length >= min;
        return q.required ? str.trim().length > 0 : true;
      }
      case "scale": {
        if (typeof val === "number") return true;
        return !q.required;
      }
      case "multi_select": {
        const arr = Array.isArray(val) ? val : [];
        if (arr.length > 0) return true;
        return !q.required;
      }
      case "ranking": {
        // Ranking parcial não serve para nada: ou ordena tudo, ou não responde.
        const arr = Array.isArray(val) ? val : [];
        const total = q.options?.length ?? 0;
        if (total > 0 && arr.length === total) return true;
        return !q.required && arr.length === 0;
      }
      default:
        return true;
    }
  });

  async function handleSubmit() {
    if (!stage || !participantId || !eventId || !allValid) return;
    // Sem a contagem da versao nao se sabe se esta e a ultima etapa; nao grava.
    if (totalEtapas === null) return;

    setSubmitting(true);
    try {
      // Modo assincrono: a etapa precisa estar iniciada ANTES de gravar (o banco
      // so aceita resposta de quem tem a etapa registrada) e a janela precisa
      // ainda estar aberta. Se nao estiver, a tela explica e NADA e descartado.
      // No live isto passa direto, sem chamada nenhuma.
      if (janela.modo !== "live") {
        const g = await janela.garantirInicio();
        if (!g.ok) {
          if (g.motivo === "bloqueada") {
            throw new Error(mensagemDeRecusa(g.fase) ?? MSG_ENVIO_FALHA_GENERICA);
          }
          throw new Error(
            g.motivo === "sem_acesso"
              ? MSG_SESSAO_DE_LOGIN_EXPIRADA
              : g.motivo === "sem_conexao"
                ? MSG_ENVIO_SEM_CONEXAO
                : MSG_ENVIO_FALHA_GENERICA
          );
        }
      }

      // Modo como o hook o conhece AGORA (pode ter sido descoberto pela chamada
      // acima, quando a leitura do evento tinha falhado na carga).
      const modoNoEnvio = janela.modoAtual();

      const supabase = createClient();

      // onConflict must name the (participant_id, stage_id) unique constraint.
      // Without it PostgREST infers the primary key (id), so re-submitting a
      // stage raised a duplicate-key error instead of updating the answers.
      const { error } = await (supabase.from("quiz_responses") as unknown as {
        upsert(
          values: Record<string, unknown>,
          options: { onConflict: string }
        ): Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      }).upsert(
        { participant_id: participantId, stage_id: stage.id, answers },
        { onConflict: "participant_id,stage_id" }
      );

      if (error) {
        // O participante nunca deve ver erro cru de banco no meio da imersao.
        // A mensagem tecnica fica no console para o Yuri/suporte diagnosticar.
        console.error("[quiz] falha ao gravar etapa", { stageNum, stageId: stage.id, error });
        const code = (error as { code?: string }).code;
        if (modoNoEnvio !== "live") {
          // No assincrono uma recusa do banco quase sempre quer dizer "o prazo
          // acabou enquanto a pessoa escrevia". Pergunta ao servidor o que e
          // verdade e diz isso, em vez de "sessao expirou". O texto continua na
          // tela (a tela vira somente leitura, nao e esvaziada).
          const r = await janela.reavaliar();
          if (!r.ok) {
            if (r.motivo === "bloqueada") {
              throw new Error(mensagemDeRecusa(r.fase) ?? MSG_ENVIO_FALHA_GENERICA);
            }
            throw new Error(
              r.motivo === "sem_acesso"
                ? MSG_SESSAO_DE_LOGIN_EXPIRADA
                : r.motivo === "sem_conexao"
                  ? MSG_ENVIO_SEM_CONEXAO
                  : MSG_ENVIO_FALHA_GENERICA
            );
          }
          if (code === "42501") throw new Error(MSG_ENVIO_FALHA_GENERICA);
        }
        if (code === "42501") {
          // Modo live. O banco recusou: ou a etapa ainda nao foi liberada pelo
          // host (o caso comum), ou nao ha login de verdade. Cada um tem o seu
          // texto e eles NAO se unificam; na duvida, a mensagem generica.
          const causa = await diagnosticarRecusaLive(
            supabase as unknown as Parameters<typeof diagnosticarRecusaLive>[0],
            eventId,
            stageNum
          );
          throw new Error(
            causa === "login_ausente"
              ? MSG_SESSAO_DE_LOGIN_EXPIRADA
              : causa === "etapa_nao_liberada"
                ? MSG_ETAPA_NAO_LIBERADA
                : "Não consegui salvar suas respostas. Tente de novo em alguns segundos."
          );
        }
        throw new Error("Não consegui salvar suas respostas. Tente de novo em alguns segundos.");
      }

      // Broadcast to Yuri's panel
      await supabase.channel(`event:${eventId}`).send({
        type: "broadcast",
        event: "response_submitted",
        payload: { participant_id: participantId, stage_id: stage.id },
      });

      // Ultima etapa: pede ao SERVIDOR que registre a conclusao.
      //
      // O navegador nao grava mais `participants.completed_at`: a migration 014
      // tirou esse UPDATE do participante (ele marcava a propria conclusao para
      // entrar na fila de geracao sem ter respondido tudo). Quem decide e a rota,
      // que confere no banco se todas as etapas do quiz do evento tem resposta.
      //
      // Aqui NAO se dispara geracao de prognostico, de proposito. A geracao
      // automatica ao concluir foi removida por decisao do responsavel tecnico:
      // os documentos sao produzidos sob controle da operacao e passam por
      // revisao humana. /api/generate-prognostic e so para admin (devolve 403 ao
      // participante), e a operacao gera pelo "Processar prognosticos" do painel
      // (/api/batch-process). Manter um fetch aqui seria codigo morto: o 403
      // morria dentro de um `.catch` vazio e escondia a falha.
      //
      // Se a conclusao falhar, NAO seguimos para /waiting: a pessoa ficaria
      // "esperando" sem nunca ter sido marcada como concluida, e ninguem veria.
      // As respostas desta etapa ja estao gravadas; reenviar e seguro (upsert) e
      // tenta a conclusao de novo.
      //
      // No ASSINCRONO as etapas podem ser enviadas em qualquer ordem, entao "a
      // ultima" nao e a etapa de maior numero: quem registra a conclusao e a
      // tela /waiting (NavegacaoAssincrona), quando o banco mostra TODAS as
      // etapas da versao enviadas.
      if (stageNum === totalEtapas && modoNoEnvio !== "async") {
        let res: Response;
        try {
          res = await fetch("/api/complete-quiz", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participant_id: participantId }),
          });
        } catch (err) {
          console.error("[quiz] falha de rede ao concluir", err);
          throw new Error(
            "Suas respostas foram salvas, mas não conseguimos confirmar a conclusão. Verifique a conexão e toque em enviar de novo."
          );
        }

        if (!res.ok) {
          const corpo = (await res.json().catch(() => null)) as { error?: string } | null;
          console.error("[quiz] conclusão recusada", { status: res.status });
          throw new Error(
            corpo?.error ??
              "Suas respostas foram salvas, mas não conseguimos confirmar a conclusão. Toque em enviar de novo."
          );
        }
      }

      localStorage.removeItem(`fort_answers_${stage.id}`);
      router.push("/waiting");
    } catch (err) {
      // No assincrono a mesma `id` dos avisos de prazo: se a fase mudou junto com
      // a recusa, a pessoa ve UM aviso, nao dois empilhados.
      toast.error(err instanceof Error ? err.message : "Erro ao enviar respostas", {
        id: janela.modo !== "live" ? "prazo" : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (stageMissing) {
    notFound();
  }

  if (loadFailed) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <p className="text-center text-muted-foreground max-w-sm">
          Não consegui carregar esta etapa. Verifique a conexão e recarregue a página.
        </p>
      </main>
    );
  }

  if (!stage || totalEtapas === null || janela.carregando) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </main>
    );
  }

  const temTexto = Object.values(answers).some((v) =>
    typeof v === "string" ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : typeof v === "number"
  );
  const aviso =
    janela.fase && janela.janela ? (
      <AvisoDaJanela
        fase={janela.fase}
        janela={janela.janela}
        deslocamento={janela.deslocamento}
        etapasNaoIniciadas={janela.etapasNaoIniciadas}
        temTexto={temTexto}
        jaEnviou={janela.jaEnviou}
        textoParaCopiar={
          janela.fase === "encerrada" && temTexto
            ? textoParaCopiar(stage.title, stage.questions, answers)
            : null
        }
      />
    ) : null;

  const hero = (
    <CinematicHero
      variant="compact"
      imageSrc={getStageImage(stage.stage_number ?? stage.id, stage.quiz_version)}
      imageAlt={stage.ambient_name}
      eyebrow={rotuloDaEtapa(stageNum, totalEtapas)}
      title={stage.ambient_name.toUpperCase()}
      subtitle={stage.title}
    />
  );

  // Prazo fechado e nada escrito aqui: so a explicacao, sem formulario inutil.
  if (somenteLeitura && !temTexto) {
    return (
      <main className="min-h-screen flex flex-col bg-background" {...marcaDoEvento(stage.quiz_version)}>
        {hero}
        <div className="flex-1 px-6 py-10 max-w-xl w-full mx-auto">{aviso}</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col bg-background" {...marcaDoEvento(stage.quiz_version)}>
      {hero}

      {/* Questions — all visible, single submit at bottom */}
      <div className="flex-1 px-6 py-10 space-y-12 max-w-xl w-full mx-auto">
        {aviso}
        {janela.semConfirmacao && janela.fase === null && (
          <p className="text-xs text-muted-foreground" role="status">
            Não conseguimos confirmar o prazo agora. Você pode continuar escrevendo: o que você
            digita fica guardado nesta tela e vamos tentar de novo.
          </p>
        )}
        {stage.questions.map((question, idx) => {
          const rawValue = answers[question.id];
          const stringValue = typeof rawValue === "string" ? rawValue : "";
          const numberValue = typeof rawValue === "number" ? rawValue : undefined;
          const arrayValue = Array.isArray(rawValue) ? rawValue : [];
          const minChars = question.min_chars ?? 0;
          const currentLen = stringValue.trim().length;
          const tooShort = minChars > 0 && currentLen < minChars;
          const scaleMin = question.min ?? 0;
          const scaleMax = question.max ?? 10;
          const scaleSteps = Array.from(
            { length: Math.max(scaleMax - scaleMin + 1, 0) },
            (_, i) => scaleMin + i
          );
          const maxChoices = question.max_choices;

          return (
            <div key={question.id} className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                Pergunta {idx + 1} de {stage.questions.length}
              </p>
              <p className="text-foreground text-[16px] leading-relaxed font-medium">
                {question.text}
              </p>

              {question.type === "select" && question.options ? (
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const selected = stringValue === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={somenteLeitura}
                        onClick={() => setAnswer(question.id, option)}
                        className={cn(
                          "w-full text-left px-4 py-3.5 rounded-md border text-base transition-all",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "multi_select" && question.options ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    {question.options.map((option) => {
                      const selected = arrayValue.includes(option);
                      const limitReached = !!maxChoices && arrayValue.length >= maxChoices && !selected;
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={limitReached || somenteLeitura}
                          onClick={() => toggleMultiSelect(question, option)}
                          className={cn(
                            "w-full text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[44px]",
                            selected
                              ? "border-primary bg-primary/10 text-foreground"
                              : limitReached
                                ? "border-primary/10 bg-card text-muted-foreground/50 cursor-not-allowed"
                                : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          )}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                  {maxChoices && (
                    <p className="text-xs text-primary/60" aria-live="polite">
                      {arrayValue.length} de {maxChoices} escolhidos
                    </p>
                  )}
                </div>
              ) : question.type === "ranking" && question.options ? (
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const position = arrayValue.indexOf(option);
                    const selected = position !== -1;
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={somenteLeitura}
                        onClick={() => toggleRanking(question, option)}
                        className={cn(
                          "w-full flex items-center gap-3 text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[44px]",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        <span
                          className={cn(
                            "flex items-center justify-center w-7 h-7 rounded-full border text-xs font-semibold shrink-0",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-primary/30 text-muted-foreground"
                          )}
                        >
                          {selected ? position + 1 : ""}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "dilemma" ? (
                <div className="flex flex-col sm:flex-row gap-3">
                  {[question.option_a, question.option_b].map((option, optionIdx) => {
                    if (!option) return null;
                    const selected = stringValue === option;
                    return (
                      <button
                        key={optionIdx}
                        type="button"
                        disabled={somenteLeitura}
                        onClick={() => setAnswer(question.id, option)}
                        className={cn(
                          "flex-1 text-left px-4 py-5 rounded-md border text-base transition-all min-h-[44px]",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        )}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              ) : question.type === "scale" ? (
                <div className="space-y-2">
                  {/* Grade fixa em vez de flex-wrap: com 11 passos o wrap
                      deixava o "10" sozinho ocupando a linha inteira. 6 por
                      linha no mobile mantem o alvo de toque grande. */}
                  <div className="grid grid-cols-6 sm:grid-cols-11 gap-2">
                    {scaleSteps.map((step) => {
                      const selected = numberValue === step;
                      return (
                        <button
                          key={step}
                          type="button"
                          disabled={somenteLeitura}
                          onClick={() => setAnswer(question.id, step)}
                          className={cn(
                            "flex-1 min-w-[44px] min-h-[44px] rounded-md border text-base transition-all",
                            selected
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-primary/20 bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          )}
                        >
                          {step}
                        </button>
                      );
                    })}
                  </div>
                  {(question.min_label || question.max_label) && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{question.min_label}</span>
                      <span>{question.max_label}</span>
                    </div>
                  )}
                </div>
              ) : question.type === "short_text" ? (
                <Input
                  placeholder={question.placeholder ?? "Responda com suas palavras..."}
                  value={stringValue}
                  maxLength={question.max_chars}
                  readOnly={somenteLeitura}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setAnswer(question.id, e.target.value)
                  }
                  className="h-[44px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground border-primary/40 focus-visible:border-primary focus-visible:ring-0 transition-colors"
                />
              ) : (
                <Textarea
                  placeholder={question.placeholder ?? "Responda com suas palavras..."}
                  value={stringValue}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setAnswer(question.id, e.target.value)
                  }
                  rows={6}
                  readOnly={somenteLeitura}
                  className={cn(
                    "min-h-[140px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground resize-none focus-visible:ring-0 transition-colors",
                    tooShort
                      ? "border-primary/20 focus-visible:border-primary"
                      : "border-primary/40 focus-visible:border-primary"
                  )}
                />
              )}

              {question.type === "text" && minChars > 0 && (
                <p
                  className={cn(
                    "text-xs transition-colors",
                    tooShort ? "text-destructive" : "text-primary/60"
                  )}
                  aria-live="polite"
                >
                  {currentLen}/{minChars} {tooShort ? "mínimo" : "caracteres"}
                </p>
              )}
            </div>
          );
        })}

        <Button
          onClick={handleSubmit}
          disabled={submitting || !allValid || somenteLeitura}
          className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting
            ? "Enviando..."
            : somenteLeitura
              ? "Envio indisponível"
              : "Enviar esta etapa"}
        </Button>
      </div>
    </main>
  );
}
