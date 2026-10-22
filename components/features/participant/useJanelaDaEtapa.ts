"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ClienteDeLeitura } from "@/lib/quiz/carregar-etapa";
import { chamarAbrirEtapa, type ResultadoDaChamada } from "./abrir-etapa-cliente";
import {
  faseDaJanela,
  fasePermiteResponder,
  janelaDeIso,
  type FaseDaJanela,
  type JanelaEmMs,
} from "./janela-da-etapa";

// Estado da JANELA do formulario assincrono para a etapa aberta na tela.
//
// QUANDO A ETAPA E INICIADA: assim que a tela da etapa carrega e a janela
// permite -- nao quando a pessoa comeca a digitar. Motivo: iniciar nao tem
// custo para ela (o prazo de envio e o MESMO para todos, T+15; o registro so
// prova que ela entrou antes de T-15). Esperar o primeiro toque so criaria um
// jeito de perder: quem abriu a tela as 23h40 e comecou a escrever as 23h50
// seria recusada no meio da escrita. Iniciar na entrada fixa "abriu as 23h40"
// no instante em que a pessoa de fato chegou.
//
// MODO LIVE: este hook le o evento, ve `live` e PARA. Nenhuma chamada a rota,
// nenhum timer, nenhum estado de bloqueio: a tela e o envio ficam como antes.

export type ModoDoEvento = "carregando" | "live" | "async" | "indefinido";

export interface EstadoDaJanela {
  /** Ainda descobrindo o modo (e, no async, falando com o servidor pela primeira vez). */
  carregando: boolean;
  modo: ModoDoEvento;
  /** null fora do async, ou enquanto o relogio do servidor ainda nao foi medido. */
  fase: FaseDaJanela | null;
  janela: JanelaEmMs | null;
  /** servidor - aparelho, em ms. */
  deslocamento: number;
  etapasNaoIniciadas: number[];
  jaEnviou: boolean;
  /** A fase nao deixa responder/enviar: campos viram somente leitura. */
  bloqueada: boolean;
  /** Nao deu para confirmar com o servidor (rede). A tela nao bloqueia por isso. */
  semConfirmacao: boolean;
}

export type ResultadoDaGarantia =
  | { ok: true }
  | { ok: false; motivo: "bloqueada"; fase: FaseDaJanela }
  | { ok: false; motivo: "sem_acesso" | "sem_conexao" | "indisponivel" };

interface Entrada {
  eventId: string | null;
  participantId: string | null;
  numeroDaEtapa: number;
  /** So comeca depois que a etapa carregou. */
  ativo: boolean;
}

interface EventoDaJanela {
  mode: "live" | "async";
  form_opens_at: string | null;
  form_closes_at: string | null;
}

export function useJanelaDaEtapa({ eventId, participantId, numeroDaEtapa, ativo }: Entrada) {
  const [modo, setModo] = useState<ModoDoEvento>("carregando");
  const [janela, setJanela] = useState<JanelaEmMs | null>(null);
  const [deslocamento, setDeslocamento] = useState<number | null>(null);
  const [iniciada, setIniciada] = useState(false);
  const [jaEnviou, setJaEnviou] = useState(false);
  const [totalEtapas, setTotalEtapas] = useState(0);
  const [etapasIniciadas, setEtapasIniciadas] = useState<number[]>([]);
  const [semConfirmacao, setSemConfirmacao] = useState(false);
  const [fase, setFase] = useState<FaseDaJanela | null>(null);
  // Async: so "pronto" depois da primeira resposta (ou falha) do servidor, para a
  // tela nao piscar editavel e virar somente leitura em seguida.
  const [primeiraChamadaFeita, setPrimeiraChamadaFeita] = useState(false);

  // Refs para o setInterval/garantirInicio enxergarem o valor atual.
  const iniciadaRef = useRef(false);
  const deslocRef = useRef<number | null>(null);
  const janelaRef = useRef<JanelaEmMs | null>(null);
  const modoRef = useRef<ModoDoEvento>("carregando");

  const aplicar = useCallback((r: ResultadoDaChamada): ResultadoDaGarantia => {
    if (r.tipo === "ok") {
      const d = r.dados;
      const j = d.janela ? janelaDeIso(d.janela.abre, d.janela.fecha) : null;
      modoRef.current = d.modo;
      setModo(d.modo);
      if (j) {
        janelaRef.current = j;
        setJanela(j);
      }
      deslocRef.current = r.deslocamento;
      setDeslocamento(r.deslocamento);
      setTotalEtapas(d.total_etapas);
      setEtapasIniciadas(d.etapas_iniciadas);
      setJaEnviou(d.sessao?.status === "submitted");
      const tem = d.sessao !== null;
      iniciadaRef.current = tem;
      setIniciada(tem);
      setSemConfirmacao(false);
      if (d.modo === "live") return { ok: true };
      if (tem) return { ok: true };
      if (j) {
        const f = faseDaJanela(Date.now() + r.deslocamento, j, false);
        if (f !== "aberta") return { ok: false, motivo: "bloqueada", fase: f };
      }
      return { ok: false, motivo: "indisponivel" };
    }
    if (r.tipo === "sem_acesso") return { ok: false, motivo: "sem_acesso" };
    setSemConfirmacao(true);
    return { ok: false, motivo: r.tipo === "indisponivel" ? "sem_conexao" : "indisponivel" };
  }, []);

  const chamar = useCallback(async (): Promise<ResultadoDaGarantia> => {
    if (!participantId) return { ok: false, motivo: "indisponivel" };
    return aplicar(await chamarAbrirEtapa(participantId, numeroDaEtapa));
  }, [participantId, numeroDaEtapa, aplicar]);

  // 1) Descobre o modo. Live para aqui.
  useEffect(() => {
    if (!ativo || !eventId || !participantId) return;
    let cancelado = false;
    (async () => {
      let ev: EventoDaJanela | null = null;
      try {
        const supabase = createClient() as unknown as ClienteDeLeitura;
        const r = (await supabase
          .from("events")
          .select("mode, form_opens_at, form_closes_at")
          .eq("id", eventId)
          .maybeSingle()) as { data: EventoDaJanela | null; error: unknown };
        if (!r.error) ev = r.data;
      } catch (err) {
        console.error("[janela] falha ao ler o evento", err);
      }
      if (cancelado) return;

      if (ev?.mode === "live") {
        modoRef.current = "live";
        setModo("live");
        return;
      }
      if (ev) {
        const j = janelaDeIso(ev.form_opens_at, ev.form_closes_at);
        janelaRef.current = j;
        setJanela(j);
      }
      modoRef.current = ev ? "async" : "indefinido";
      setModo(ev ? "async" : "indefinido");
      // 2) Async (ou nao deu para saber): inicia a etapa no servidor.
      await chamar();
      if (!cancelado) setPrimeiraChamadaFeita(true);
    })();
    return () => {
      cancelado = true;
    };
  }, [ativo, eventId, participantId, chamar]);

  // 3) Fase pelo relogio do SERVIDOR, reavaliada a cada segundo. setFase com o
  //    mesmo valor nao re-renderiza, entao o custo e desprezivel.
  useEffect(() => {
    if (modo !== "async" && modo !== "indefinido") return;
    const avaliar = () => {
      const j = janelaRef.current;
      const d = deslocRef.current;
      if (!j || d === null) {
        setFase(null);
        return;
      }
      setFase(faseDaJanela(Date.now() + d, j, iniciadaRef.current));
    };
    avaliar();
    const t = setInterval(avaliar, 1000);
    return () => clearInterval(t);
  }, [modo, iniciada, janela, deslocamento]);

  // 4) Nao conseguiu iniciar (rede/erro) mas a janela permite: tenta de novo.
  useEffect(() => {
    if (modo !== "async" && modo !== "indefinido") return;
    if (iniciada) return;
    if (fase !== null && fase !== "aberta") return;
    const t = setInterval(() => {
      void chamar();
    }, 8000);
    return () => clearInterval(t);
  }, [modo, iniciada, fase, chamar]);

  /** Antes de gravar: garante que a etapa esta iniciada. Live passa direto. */
  const garantirInicio = useCallback(async (): Promise<ResultadoDaGarantia> => {
    if (modoRef.current === "live") return { ok: true };
    if (iniciadaRef.current) {
      // Ja iniciada, mas a janela pode ter fechado enquanto a pessoa escrevia.
      const j = janelaRef.current;
      const d = deslocRef.current;
      if (j && d !== null) {
        const f = faseDaJanela(Date.now() + d, j, true);
        if (!fasePermiteResponder(f)) return { ok: false, motivo: "bloqueada", fase: f };
      }
      return { ok: true };
    }
    return chamar();
  }, [chamar]);

  /** Depois de uma recusa do banco: pergunta ao servidor como as coisas estao. */
  const reavaliar = useCallback(async (): Promise<ResultadoDaGarantia> => {
    if (modoRef.current === "live") return { ok: true };
    const r = await chamar();
    if (r.ok) {
      const j = janelaRef.current;
      const d = deslocRef.current;
      if (j && d !== null) {
        const f = faseDaJanela(Date.now() + d, j, true);
        if (!fasePermiteResponder(f)) return { ok: false, motivo: "bloqueada", fase: f };
      }
    }
    return r;
  }, [chamar]);

  const numerosDaEtapa = Array.from({ length: totalEtapas }, (_, i) => i + 1);
  const etapasNaoIniciadas = numerosDaEtapa.filter(
    (n) => n !== numeroDaEtapa && !etapasIniciadas.includes(n),
  );

  const estado: EstadoDaJanela = {
    carregando: modo === "carregando" || (modo !== "live" && !primeiraChamadaFeita),
    modo,
    fase,
    janela,
    deslocamento: deslocamento ?? 0,
    etapasNaoIniciadas,
    jaEnviou,
    bloqueada: fase !== null && !fasePermiteResponder(fase),
    semConfirmacao,
  };

  /** Modo como o hook o conhece AGORA (o `modo` do estado pode estar um render atras). */
  const modoAtual = useCallback(() => modoRef.current, []);

  return { ...estado, garantirInicio, reavaliar, modoAtual };
}
