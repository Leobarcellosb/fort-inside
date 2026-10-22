"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { marcaDoEvento } from "@/lib/cinematic-map";
import { CinematicHero } from "./CinematicHero";
import { chamarProxima } from "./proxima-etapa-cliente";
import { janelaDeIso } from "./janela-da-etapa";
import { montarTelaDaNavegacao, type EstadoDaNavegacao } from "./textos-da-navegacao";

// Tela de /waiting para o modo ASSINCRONO. Pergunta ao servidor qual e a proxima
// etapa (ver /api/etapa/proxima) e:
//   - etapa N        -> leva a /quiz/N (so etapas que a janela permite comecar);
//   - todas enviadas -> pede a conclusao ao servidor e avisa o pai (que mostra a
//                       tela "Recebemos");
//   - nada a fazer   -> explica por que, sem culpar;
//   - nao deu para saber -> mensagem propria. NUNCA manda para a etapa 1 nem
//                       "tenta a proxima".
// current_stage nao e lido aqui.

interface Props {
  participantId: string;
  imageSrc?: string;
  /** Versao do quiz do evento: liga a pele do Marco Zero (data-marca), como no resto das telas. */
  quizVersion?: number | null;
  /** Chamado quando o servidor confirmou que TODAS as etapas foram enviadas e a conclusao foi registrada. */
  onConcluido: () => void;
}

type Tela = { tipo: "carregando" } | EstadoDaNavegacao;

export function NavegacaoAssincrona({ participantId, imageSrc, quizVersion, onConcluido }: Props) {
  const router = useRouter();
  const [tela, setTela] = useState<Tela>({ tipo: "carregando" });
  const vivo = useRef(true);
  const rodando = useRef(false);
  // O pai re-renderiza a cada 600 ms (pontinhos da espera): sem a ref, `resolver`
  // mudaria de identidade e a consulta rodaria de novo a cada renderizacao.
  const aoConcluir = useRef(onConcluido);
  aoConcluir.current = onConcluido;

  const resolver = useCallback(async () => {
    if (rodando.current) return;
    rodando.current = true;
    try {
      const r = await chamarProxima(participantId);
      if (!vivo.current) return;
      if (r.tipo === "sem_acesso") return setTela({ tipo: "indisponivel", causa: "login" });
      if (r.tipo === "inexistente") return setTela({ tipo: "indisponivel", causa: "configuracao" });
      if (r.tipo === "indisponivel") return setTela({ tipo: "indisponivel", causa: "leitura" });

      const d = r.dados;
      // Esta tela so existe para o async. Se o servidor disser outra coisa, nao se adivinha.
      if (d.modo !== "async" || !d.destino) return setTela({ tipo: "indisponivel", causa: "leitura" });
      const destino = d.destino;

      if (destino.tipo === "etapa") {
        router.replace(`/quiz/${destino.numero}`);
        return;
      }
      if (destino.tipo === "indisponivel") {
        return setTela({ tipo: "indisponivel", causa: destino.motivo });
      }
      if (destino.tipo === "concluido") {
        // Todas as etapas tem envio no banco. Registra a conclusao (idempotente).
        try {
          const res = await fetch("/api/complete-quiz", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participant_id: participantId }),
          });
          if (!vivo.current) return;
          if (res.ok) return aoConcluir.current();
          console.error("[navegacao] conclusao recusada", { status: res.status });
        } catch (err) {
          console.error("[navegacao] falha de rede ao concluir", err);
        }
        if (vivo.current) setTela({ tipo: "indisponivel", causa: "conclusao" });
        return;
      }

      // nenhuma
      if (!d.janela || d.total_etapas === null) {
        return setTela({ tipo: "indisponivel", causa: "configuracao" });
      }
      const janela = janelaDeIso(d.janela.abre, d.janela.fecha);
      setTela({
        tipo: "nenhuma",
        motivo: destino.motivo,
        pendentes: destino.pendentes,
        enviadas: d.etapas_enviadas.length,
        total: d.total_etapas,
        janela,
        agora: Date.now() + r.deslocamento,
      });
      // Antes de abrir: reavalia quando abrir, sem a pessoa precisar fazer nada.
      if (destino.motivo === "ainda_nao_abriu" && janela.abre !== null) {
        const espera = Math.min(janela.abre - (Date.now() + r.deslocamento) + 1000, 2 ** 31 - 1);
        setTimeout(() => void resolver(), Math.max(espera, 1000));
      }
    } finally {
      rodando.current = false;
    }
  }, [participantId, router]);

  useEffect(() => {
    vivo.current = true;
    void resolver();
    return () => {
      vivo.current = false;
    };
  }, [resolver]);

  // Falha de leitura: tenta sozinho de tempos em tempos (a pessoa tambem tem o botao).
  useEffect(() => {
    if (tela.tipo !== "indisponivel" || tela.causa !== "leitura") return;
    const t = setInterval(() => void resolver(), 20000);
    return () => clearInterval(t);
  }, [tela, resolver]);

  if (tela.tipo === "carregando") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div
          className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin"
          role="status"
          aria-label="Procurando sua próxima etapa"
        />
      </main>
    );
  }

  const t = montarTelaDaNavegacao(tela);
  return (
    <main
      className="min-h-screen bg-background"
      data-testid="navegacao-assincrona"
      {...marcaDoEvento(quizVersion)}
    >
      <CinematicHero
        imageSrc={imageSrc}
        imageAlt="Questionário"
        eyebrow="Questionário"
        title="Sua próxima etapa"
      />
      <section className="px-6 py-12 max-w-md mx-auto space-y-4">
        <div role="status" aria-live="polite" className="space-y-3">
          <p className="text-foreground text-base font-semibold leading-snug">{t.titulo}</p>
          {t.corpo.map((linha, i) => (
            <p key={i} className="text-sm text-muted-foreground leading-relaxed">
              {linha}
            </p>
          ))}
        </div>
        {t.tentarDeNovo && (
          <Button
            type="button"
            variant="outline"
            className="w-full h-11"
            onClick={() => {
              setTela({ tipo: "carregando" });
              void resolver();
            }}
          >
            Tentar de novo
          </Button>
        )}
      </section>
    </main>
  );
}
