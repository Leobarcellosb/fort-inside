"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
import type { QuizQuestion } from "@/types/database";
import { faixaDaEscala, letraDoAtalho, rotulosDaEscala, separarLetra } from "./roteiro";

/*
 * Os controles do formulario imersivo. Cada um e so apresentacao: recebe o valor,
 * devolve a escolha. Nenhum texto de pergunta, alternativa ou ancora e escrito
 * aqui -- tudo chega por `question`.
 *
 * Foco: todos os botoes tem anel de foco visivel (`focus-visible:ring`), e a
 * selecao nunca depende so de cor -- o escolhido muda de fundo, de borda E de
 * peso, e anuncia `aria-pressed` para leitor de tela.
 */

const ANEL =
  "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// ---------------------------------------------------------------------------
// ESCALA: 0 a 10 (Elementos) e 1 a 5 (Likert)
// ---------------------------------------------------------------------------

export function Escala({
  question,
  valor,
  idDoEnunciado,
  idDoAviso,
  onEscolher,
}: {
  question: QuizQuestion;
  valor: number | undefined;
  idDoEnunciado: string;
  idDoAviso?: string;
  onEscolher: (n: number) => void;
}) {
  const [menor, maior] = faixaDaEscala(question);
  const passos = Array.from({ length: Math.max(maior - menor + 1, 0) }, (_, i) => menor + i);
  const [rotuloMenor, rotuloMaior] = rotulosDaEscala(question);
  const longa = passos.length > 6;

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-labelledby={idDoEnunciado}
        aria-describedby={idDoAviso}
        // Escala longa (0 a 10): SEMPRE duas fileiras -- seis na primeira (0 a 5),
        // cinco na segunda (6 a 10) -- com alvos de 44px ou mais e nenhuma
        // rolagem horizontal. Onze botoes numa linha dariam 27px cada a 375px.
        // Nunca slider: slider comeca numa posicao ambigua e pede toque preciso.
        className={cn("flex justify-center gap-2", longa ? "flex-wrap" : "flex-nowrap")}
      >
        {passos.map((p) => {
          const escolhido = valor === p;
          const ponta = p === menor ? rotuloMenor : p === maior ? rotuloMaior : null;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onEscolher(p)}
              aria-pressed={escolhido}
              aria-label={ponta ? `${p}, ${ponta}` : String(p)}
              className={cn(
                ANEL,
                "rounded-xl border text-[17px] tabular-nums select-none",
                // Sem transicao de cor: o valor escolhido aparece no instante do toque.
                "transition-transform duration-100 active:scale-[0.96] motion-reduce:active:scale-100",
                longa
                  ? "basis-[calc((100%-2.5rem)/6)] grow-0 shrink-0 min-w-11 h-14"
                  : "flex-1 min-w-11 h-14",
                escolhido
                  ? "border-primary bg-primary text-primary-foreground font-semibold shadow-sm"
                  : "border-border bg-card text-foreground hover:border-foreground/40",
              )}
            >
              {p}
            </button>
          );
        })}
      </div>
      {/* As DUAS pontas, nomeadas, em cada pergunta. O numero da ponta vai junto
          do rotulo porque na escala longa o 10 fica na segunda fileira: sem o
          numero escrito, "Plenamente satisfeito" ficaria embaixo do 10 so por
          acaso de layout. */}
      {(rotuloMenor || rotuloMaior) && (
        <div className="flex justify-between gap-4 text-[13px] leading-snug text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground tabular-nums">{menor}</span>{" "}
            {rotuloMenor}
          </span>
          <span className="text-right">
            <span className="font-semibold text-foreground tabular-nums">{maior}</span>{" "}
            {rotuloMaior}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ESCOLHA UNICA (situacional A-D)
// ---------------------------------------------------------------------------

export function opcoesDaPergunta(question: QuizQuestion): string[] {
  if (question.type === "dilemma") {
    return [question.option_a, question.option_b].filter((o): o is string => !!o);
  }
  return question.options ?? [];
}

export function Escolha({
  question,
  valor,
  idDoEnunciado,
  idDoAviso,
  onEscolher,
}: {
  question: QuizQuestion;
  valor: string | undefined;
  idDoEnunciado: string;
  idDoAviso?: string;
  onEscolher: (opcao: string) => void;
}) {
  const opcoes = opcoesDaPergunta(question);
  return (
    <div role="group" aria-labelledby={idDoEnunciado} aria-describedby={idDoAviso} className="space-y-3">
      {opcoes.map((opcao, i) => {
        const escolhida = valor === opcao;
        const partes = separarLetra(opcao);
        return (
          <button
            key={opcao}
            type="button"
            onClick={() => onEscolher(opcao)}
            aria-pressed={escolhida}
            // Nome explicito, como nas escalas: o texto exato da alternativa,
            // com a letra. Nao depende de cada leitor de tela montar o nome a
            // partir dos spans internos.
            aria-label={opcao}
            className={cn(
              ANEL,
              "w-full flex items-start gap-3.5 text-left rounded-2xl border px-4 py-3.5 min-h-[60px]",
              // Sem transicao de cor: a escolha aparece NO INSTANTE do toque, e o
              // atraso do avanco existe para ela ser vista.
              "active:scale-[0.99] motion-reduce:active:scale-100 transition-transform duration-100",
              escolhida
                ? "border-primary bg-primary/[0.09] shadow-[0_0_0_1px_var(--primary)]"
                : "border-border bg-card hover:border-foreground/40",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0 inline-flex items-center justify-center min-w-9 h-9 px-1.5 rounded-lg border text-[15px] font-semibold",
                escolhida
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-foreground/25 text-foreground",
              )}
            >
              {/* A letra que o BANCO escreveu ("A."), destacada. Sem letra no
                  banco, a posicao (A, B...) aparece so aqui, como tecla. */}
              {partes ? partes.letra : letraDoAtalho(i)}
            </span>
            <span className="pt-1.5 text-[16px] leading-snug text-foreground">
              {partes ? (
                <>
                  <span className="sr-only">{partes.letra} </span>
                  {partes.resto}
                </>
              ) : (
                opcao
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TEXTO
// ---------------------------------------------------------------------------

export interface CampoDeTextoHandle {
  focar: () => void;
}

const CAMPO =
  "w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 caret-primary " +
  "border-0 border-b-2 border-foreground/20 focus:border-primary outline-none rounded-none px-0 " +
  "transition-colors duration-150 motion-reduce:transition-none";

/**
 * Texto curto: uma linha, fonte grande. Enter avanca (o `onEnter` da tela).
 * 16px+ evita o zoom automatico do Safari ao focar.
 */
export const TextoCurto = forwardRef<
  CampoDeTextoHandle,
  {
    id: string;
    valor: string;
    idDoEnunciado: string;
    idDoAviso?: string;
    invalido?: boolean;
    tipo?: "text" | "email" | "tel";
    autoComplete?: string;
    inputMode?: "text" | "email" | "tel";
    maxLength?: number;
    placeholder?: string;
    onChange: (v: string) => void;
    onEnter: () => void;
  }
>(function TextoCurto(p, ref) {
  const campo = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focar: () => campo.current?.focus({ preventScroll: true }) }));
  return (
    <input
      ref={campo}
      id={p.id}
      type={p.tipo ?? "text"}
      value={p.valor}
      autoComplete={p.autoComplete ?? "off"}
      inputMode={p.inputMode}
      maxLength={p.maxLength}
      placeholder={p.placeholder ?? "Escreva aqui"}
      enterKeyHint="next"
      aria-labelledby={p.idDoEnunciado}
      aria-describedby={p.idDoAviso}
      aria-invalid={p.invalido || undefined}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          p.onEnter();
        }
      }}
      className={cn(CAMPO, "h-14 text-[22px] sm:text-2xl")}
    />
  );
});

/**
 * Texto longo: area que CRESCE com o texto. Enter INSERE NOVA LINHA -- nunca
 * avanca nem envia (revisao tecnica, item 2). Sem contador, sem cronometro, sem
 * incentivo a escrever mais (item 9).
 *
 * Ela cresce ate caber na area visivel e, dali em diante, rola por dentro: assim
 * o cursor continua a vista enquanto a pessoa escreve com o teclado aberto, e o
 * Continuar do rodape nao e empurrado para fora.
 */
export const TextoAberto = forwardRef<
  CampoDeTextoHandle,
  {
    id: string;
    valor: string;
    idDoEnunciado: string;
    idDoAviso?: string;
    invalido?: boolean;
    maxLength?: number;
    placeholder?: string;
    alturaMaxima: number | null;
    onChange: (v: string) => void;
  }
>(function TextoAberto(p, ref) {
  const campo = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focar: () => campo.current?.focus({ preventScroll: true }) }));

  const ajustar = useCallback(() => {
    const el = campo.current;
    if (!el) return;
    el.style.height = "auto";
    const limite = p.alturaMaxima ?? Number.POSITIVE_INFINITY;
    el.style.height = `${Math.min(el.scrollHeight + 2, limite)}px`;
    el.style.overflowY = el.scrollHeight + 2 > limite ? "auto" : "hidden";
  }, [p.alturaMaxima]);

  useEffect(() => {
    ajustar();
  }, [p.valor, ajustar]);

  return (
    <textarea
      ref={campo}
      id={p.id}
      value={p.valor}
      rows={3}
      maxLength={p.maxLength}
      placeholder={p.placeholder ?? "Escreva com suas palavras"}
      enterKeyHint="enter"
      aria-labelledby={p.idDoEnunciado}
      aria-describedby={p.idDoAviso}
      aria-invalid={p.invalido || undefined}
      onChange={(e) => p.onChange(e.target.value)}
      onFocus={() => {
        // Ao abrir o teclado, garante que o fim do texto (onde esta o cursor)
        // fique a vista depois que a area visivel encolher.
        window.setTimeout(() => campo.current?.scrollIntoView({ block: "nearest" }), 300);
      }}
      className={cn(
        CAMPO,
        "min-h-[132px] resize-none py-3 text-[18px] leading-relaxed",
        "border-2 border-foreground/15 focus:border-primary rounded-xl px-4 bg-card",
      )}
    />
  );
});
