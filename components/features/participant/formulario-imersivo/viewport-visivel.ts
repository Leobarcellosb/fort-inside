"use client";

import { useEffect, useState } from "react";

/**
 * A AREA REALMENTE VISIVEL DA TELA, para o botao de avancar nunca ficar atras do
 * teclado virtual.
 *
 * No Safari do iPhone (e no Chrome do Android, no modo padrao) abrir o teclado
 * NAO encolhe o layout: um rodape `position: fixed; bottom: 0` fica escondido
 * atras do teclado. O que encolhe e o `visualViewport`. Entao a casca do
 * formulario e posicionada pela area visivel: topo = `offsetTop`, altura =
 * `height`. Com o teclado aberto, o rodape assenta logo acima dele; fechado, volta
 * ao pe da tela. Sem `visualViewport` (navegador antigo), devolve `null` e a
 * casca usa `100dvh`.
 */
export function useViewportVisivel(): { altura: number; topo: number } | null {
  const [area, setArea] = useState<{ altura: number; topo: number } | null>(null);

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    let quadro = 0;
    const medir = () => {
      cancelAnimationFrame(quadro);
      quadro = requestAnimationFrame(() => {
        setArea((atual) => {
          const altura = Math.round(vv.height);
          const topo = Math.max(0, Math.round(vv.offsetTop));
          return atual && atual.altura === altura && atual.topo === topo
            ? atual
            : { altura, topo };
        });
      });
    };
    medir();
    vv.addEventListener("resize", medir);
    vv.addEventListener("scroll", medir);
    return () => {
      cancelAnimationFrame(quadro);
      vv.removeEventListener("resize", medir);
      vv.removeEventListener("scroll", medir);
    };
  }, []);

  return area;
}

/** Ponteiro grosso (dedo): muda atalhos e foco automatico. */
export function ehToque(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export function preferePoucoMovimento(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
