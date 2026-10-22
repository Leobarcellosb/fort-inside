"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FaseDaJanela, JanelaEmMs } from "./janela-da-etapa";
import { montarAviso } from "./textos-da-janela";

// Aviso do prazo no topo da etapa. Redesenha a cada segundo SO este componente
// (a pagina inteira nao re-renderiza por causa da contagem).
//
// Acessibilidade: o titulo e o corpo ficam em uma regiao `status` (leitor de
// tela anuncia quando a fase muda); os segundos da contagem ficam fora dela
// (aria-hidden) para nao serem lidos a cada tick.

interface Props {
  fase: FaseDaJanela;
  janela: JanelaEmMs;
  /** servidor - aparelho, em ms. */
  deslocamento: number;
  etapasNaoIniciadas: number[];
  temTexto: boolean;
  jaEnviou: boolean;
  /** Texto pronto para copiar (so usado quando o formulario encerrou com texto na tela). */
  textoParaCopiar: string | null;
}

export function AvisoDaJanela({
  fase,
  janela,
  deslocamento,
  etapasNaoIniciadas,
  temTexto,
  jaEnviou,
  textoParaCopiar,
}: Props) {
  const [agora, setAgora] = useState(() => Date.now() + deslocamento);
  const [copia, setCopia] = useState<"nenhuma" | "copiado" | "manual">("nenhuma");

  useEffect(() => {
    const tick = () => setAgora(Date.now() + deslocamento);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [deslocamento]);

  const aviso = montarAviso({ fase, agora, janela, etapasNaoIniciadas, temTexto, jaEnviou });
  if (!aviso) return null;

  async function copiar() {
    if (!textoParaCopiar) return;
    try {
      await navigator.clipboard.writeText(textoParaCopiar);
      setCopia("copiado");
    } catch {
      // Sem permissao de area de transferencia (ex.: pagina sem HTTPS): mostra o
      // texto para a pessoa selecionar e copiar sozinha.
      setCopia("manual");
    }
  }

  if (aviso.tom === "discreto") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="aviso-janela" data-fase={fase}>
        {aviso.corpo[0]}
      </p>
    );
  }

  return (
    <section
      data-testid="aviso-janela"
      data-fase={fase}
      className={cn(
        "rounded-md border px-4 py-4 space-y-3",
        aviso.tom === "atencao"
          ? "border-primary bg-primary/10"
          : "border-primary/30 bg-card",
      )}
    >
      <div role="status" aria-live="polite" className="space-y-2">
        {aviso.titulo && (
          <p className="text-[15px] font-semibold text-foreground leading-snug">{aviso.titulo}</p>
        )}
        {aviso.corpo.map((linha, i) => (
          <p key={i} className="text-sm text-muted-foreground leading-relaxed">
            {linha}
          </p>
        ))}
      </div>

      {aviso.contagem && (
        <p className="text-sm text-foreground" aria-hidden="true">
          {aviso.contagem.rotulo}:{" "}
          <span className="font-semibold tabular-nums">{aviso.contagem.restante}</span>
        </p>
      )}

      {fase === "encerrada" && textoParaCopiar && (
        <div className="space-y-2">
          <Button type="button" variant="outline" onClick={copiar} className="w-full h-11">
            {copia === "copiado" ? "Texto copiado" : "Copiar o que escrevi"}
          </Button>
          {copia === "manual" && (
            <p className="text-sm text-muted-foreground">
              Não conseguimos copiar automaticamente. Selecione o texto abaixo e copie.
            </p>
          )}
          {copia === "manual" && (
            <textarea
              readOnly
              value={textoParaCopiar}
              rows={8}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Suas respostas, para copiar"
              className="w-full rounded-md border border-primary/30 bg-background p-3 text-sm text-foreground"
            />
          )}
        </div>
      )}
    </section>
  );
}
