"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { NavegacaoAssincrona } from "@/components/features/participant/NavegacaoAssincrona";
import { imagemDoAmbiente, marcaDoEvento } from "@/lib/cinematic-map";
import type { Event, QuizResponse } from "@/types/database";

export default function WaitingPage() {
  const router = useRouter();
  const [eventName, setEventName] = useState<string>("");
  const [currentStage, setCurrentStage] = useState(0);
  const [hostName, setHostName] = useState("Yuri Fortes");
  const [dots, setDots] = useState(".");
  // null = ainda lendo do banco. A tela so e desenhada depois de saber, para o
  // texto de "aguardando proxima etapa" nao piscar na cara de quem acabou de
  // terminar o questionario.
  const [concluido, setConcluido] = useState<boolean | null>(null);
  // A versao do quiz decide se a tela tem foto (ver lib/cinematic-map.ts).
  const [quizVersion, setQuizVersion] = useState<number | null>(null);
  // Modo do evento. `async` NAO tem host liberando etapa: `current_stage` nunca
  // anda, entao quem leva a pessoa a proxima etapa e a NavegacaoAssincrona (pelas
  // etapas da versao, pelos envios e pela janela). `live` segue exatamente como
  // antes, por current_stage. Se a leitura do evento falhar, cai em `live`
  // (comportamento de sempre): nada novo e decidido sem saber o modo.
  const [modo, setModo] = useState<"carregando" | "live" | "async">("carregando");
  const modoRef = useRef<"carregando" | "live" | "async">("carregando");
  const [participantId, setParticipantId] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 600);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const eventId = localStorage.getItem("fort_event_id");
    const participantId = localStorage.getItem("fort_participant_id");

    if (!eventId || !participantId) {
      router.replace("/");
      return;
    }

    setParticipantId(participantId);
    const supabase = createClient();

    // Quem ja terminou o questionario nao espera "proxima etapa": espera o
    // prognostico, que a operacao prepara e revisa (a geracao nao dispara mais
    // sozinha ao concluir). Le o estado real (`completed_at`, gravado pelo
    // servidor em /api/complete-quiz), em vez de depender de parametro de URL,
    // para a tela continuar certa ao recarregar a pagina.
    (supabase
      .from("participants")
      .select("completed_at")
      .eq("id", participantId)
      .maybeSingle() as unknown as Promise<{
        data: { completed_at: string | null } | null;
        error: unknown;
      }>)
      .then(({ data }) => setConcluido(!!data?.completed_at))
      .catch(() => setConcluido(false));

    (supabase
      .from("events")
      .select("name, current_stage, host_name, status, quiz_version, mode")
      .eq("id", eventId)
      .single() as unknown as Promise<{ data: Pick<Event, "name" | "current_stage" | "host_name" | "status" | "quiz_version" | "mode"> | null; error: unknown }>)
      .then(({ data }) => {
        if (!data) {
          modoRef.current = "live";
          setModo("live");
          return;
        }
        setEventName(data.name);
        setHostName(data.host_name ?? "Yuri Fortes");
        setQuizVersion(data.quiz_version);
        setCurrentStage(data.current_stage);
        modoRef.current = data.mode === "async" ? "async" : "live";
        setModo(modoRef.current);

        // So o live decide por current_stage.
        if (modoRef.current === "live" && data.current_stage > 0) {
          checkAndRedirect(supabase, participantId, data.current_stage);
        }
      })
      .catch(() => {
        modoRef.current = "live";
        setModo("live");
      });

    const eventChannel = supabase
      .channel(`event:${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "events",
          filter: `id=eq.${eventId}`,
        },
        (payload) => {
          const stage = (payload.new as { current_stage: number }).current_stage;
          setCurrentStage(stage);
          if (modoRef.current === "live" && stage > 0) {
            checkAndRedirect(supabase, participantId, stage);
          }
        }
      )
      .subscribe();

    const deliveryChannel = supabase
      .channel(`prognostic-delivery-${participantId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "prognostics",
          filter: `participant_id=eq.${participantId}`,
        },
        (payload) => {
          const prog = payload.new as { status: string; public_share_token: string | null };
          if (prog.status === "delivered" && prog.public_share_token) {
            router.push(`/prognostic/${prog.public_share_token}`);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(eventChannel);
      supabase.removeChannel(deliveryChannel);
    };
  }, [router]);

  async function checkAndRedirect(
    supabase: ReturnType<typeof createClient>,
    participantId: string,
    currentStage: number
  ) {
    const { data: answered } = await supabase
      .from("quiz_responses")
      .select("stage_id")
      .eq("participant_id", participantId) as {
        data: Pick<QuizResponse, "stage_id">[] | null;
        error: unknown;
      };

    const answeredIds = new Set((answered ?? []).map((r) => r.stage_id));

    for (let s = 1; s <= currentStage; s++) {
      if (!answeredIds.has(s)) {
        router.push(`/quiz/${s}`);
        return;
      }
    }
  }

  if (concluido === null || modo === "carregando") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </main>
    );
  }

  if (concluido) {
    return (
      <main className="min-h-screen bg-background" {...marcaDoEvento(quizVersion)}>
        <CinematicHero
          imageSrc={imagemDoAmbiente("waiting", quizVersion)}
          imageAlt="Respostas recebidas"
          eyebrow="Questionário concluído"
          title="Recebemos"
          subtitle="Suas respostas chegaram até nós"
        />
        <section className="px-6 py-16 max-w-md mx-auto text-center space-y-6">
          {/* Sem prazo de proposito: nenhum prazo foi definido pelo produto.
              O texto so afirma o que o sistema faz de verdade: o prognostico e
              preparado e revisado pela equipe, e a tela leva a pessoa a ele
              quando for liberado (canal `prognostic-delivery-*` abaixo). */}
          <p className="text-foreground text-base font-medium leading-relaxed">
            Seu prognóstico será preparado e revisado pela equipe antes de ser liberado para você.
          </p>
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            Quando ele estiver liberado, esta tela leva você até ele automaticamente.
            Se puder, deixe esta página aberta.
          </p>
        </section>
      </main>
    );
  }

  if (modo === "async" && participantId) {
    return (
      <NavegacaoAssincrona
        participantId={participantId}
        imageSrc={imagemDoAmbiente("waiting", quizVersion)}
        quizVersion={quizVersion}
        onConcluido={() => setConcluido(true)}
      />
    );
  }

  return (
    <main className="min-h-screen bg-background" {...marcaDoEvento(quizVersion)}>
      <CinematicHero
        imageSrc={imagemDoAmbiente("waiting", quizVersion)}
        imageAlt="Aguardando próxima etapa"
        eyebrow="Próxima etapa"
        title="Aguarde"
        subtitle={`${hostName} vai liberar em instantes`}
      />
      <section className="px-6 py-16 max-w-md mx-auto text-center space-y-10">
        <div className="relative mx-auto w-16 h-16">
          <div className="absolute inset-0 rounded-full border border-foreground/30 animate-ping" />
          <div className="absolute inset-2 rounded-full border border-foreground/50" />
          <div className="absolute inset-4 rounded-full bg-foreground/40" />
        </div>

        <div className="space-y-2">
          <p className="text-foreground text-base font-medium">
            Aguardando próxima etapa{dots}
          </p>
          {currentStage > 0 && (
            <p className="text-xs text-muted-foreground">
              Etapa {currentStage} em andamento
            </p>
          )}
          {eventName && (
            <p className="text-xs text-muted-foreground">
              {eventName} · com {hostName}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          Quando {hostName} liberar a próxima etapa,<br />
          você será redirecionado automaticamente.
        </p>
      </section>
    </main>
  );
}
