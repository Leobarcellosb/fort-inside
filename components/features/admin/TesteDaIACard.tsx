"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Testar a IA" antes de processar (Rodadas 70 e 71 do CTO): uma chamada real
 * e minima, feita pelo servidor com a configuracao que vai gerar os documentos.
 * Se a chave, o saldo ou o modelo falharem, a equipe descobre aqui, e nao
 * depois de 50 tentativas. Pede confirmacao porque a chamada custa (pouco).
 */
/** `embutido`: dentro de um passo do painel, sem titulo e sem caixa propria (o passo ja diz o que e). */
export function TesteDaIACard({ embutido = false }: { embutido?: boolean } = {}) {
  const [estado, setEstado] = useState<"parado" | "confirmando" | "testando">("parado");
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  async function testar() {
    setEstado("testando");
    setResultado(null);
    try {
      const res = await fetch("/api/marco-zero/teste-ia", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; texto?: string; error?: string } | null;
      setResultado({
        ok: res.ok && data?.ok === true,
        texto: data?.texto ?? data?.error ?? "Não foi possível fazer o teste agora. Tente de novo.",
      });
    } catch {
      setResultado({ ok: false, texto: "Sem conexão com o servidor. Nada foi testado; tente de novo." });
    } finally {
      setEstado("parado");
    }
  }

  return (
    <section className={embutido ? "space-y-2" : "rounded-md border border-border bg-card/50 px-4 py-3 space-y-2"}>
      {!embutido && (
        <>
          <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Teste da IA antes de processar</h2>
          <p className="text-xs leading-relaxed text-foreground/80">
            Faz uma chamada real e mínima à IA, com dados fictícios, pela mesma configuração que vai gerar os
            documentos. Use antes de apertar Processar. Custa centavos e não grava nada.
          </p>
        </>
      )}
      {estado === "confirmando" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-foreground">Fazer uma chamada real agora?</span>
          <Button size="sm" onClick={() => void testar()} className="text-xs bg-primary text-primary-foreground">
            Sim, testar
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEstado("parado")} className="text-xs border-border">
            Cancelar
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={estado === "testando"}
          onClick={() => setEstado("confirmando")}
          className="text-xs border-border"
        >
          {estado === "testando" ? "Testando..." : "Testar a IA"}
        </Button>
      )}
      {resultado && (
        <p
          role="status"
          className={`text-xs leading-relaxed ${resultado.ok ? "text-foreground" : "text-destructive font-medium"}`}
        >
          {resultado.texto}
        </p>
      )}
    </section>
  );
}
