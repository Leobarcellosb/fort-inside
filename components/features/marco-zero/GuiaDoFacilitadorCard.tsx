"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  pedirGuiaDoFacilitador,
  type DesfechoDoGuia,
} from "./guia-facilitador-borda";

// O ACESSO DO HOST ao Guia de Preparacao do Facilitador. Sem este bloco a rota
// existiria e o host nao teria como chegar nela -- a contingencia estaria no
// codigo e nao na operacao.
//
// O guia e MATERIAL RESTRITO AO FACILITADOR: ele aparece aqui, no painel que ja
// exige administrador, e nao em tela publica. Baixar e copiar sao as duas acoes;
// nada daqui e enviado para fora.
//
// A tela nunca exibe o `error` do corpo da resposta (texto do servidor). As
// mensagens de recusa e de bloqueio vem de `mensagemParaHost`, pelo codigo.

interface Props {
  eventId: string;
}

export function GuiaDoFacilitadorCard({ eventId }: Props) {
  const [emCurso, setEmCurso] = useState(false);
  const [desfecho, setDesfecho] = useState<DesfechoDoGuia | null>(null);

  async function gerar() {
    setEmCurso(true);
    setDesfecho(null);
    try {
      setDesfecho(await pedirGuiaDoFacilitador(eventId));
    } finally {
      setEmCurso(false);
    }
  }

  function baixar() {
    if (desfecho?.tipo !== "gerado") return;
    const blob = new Blob([desfecho.guia.texto], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `guia-do-facilitador-${desfecho.guia.conteudo_sha256.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="space-y-1">
        <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Guia de Preparação do Facilitador
        </h2>
        <p className="text-sm text-muted-foreground">
          Material restrito ao facilitador, para preparar a condução quando o evento não tem
          DNA Coletivo disponibilizado. Traz a participação verificada e sugestões de condução;
          não afirma nada sobre as pessoas que estarão na sala.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={gerar} disabled={emCurso} size="sm">
          {emCurso ? "Gerando..." : "Gerar guia do facilitador"}
        </Button>
        {desfecho?.tipo === "gerado" && (
          <Button type="button" variant="outline" size="sm" onClick={baixar}>
            Baixar em texto
          </Button>
        )}
      </div>

      {desfecho?.tipo === "gerado" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Conteúdo {desfecho.guia.conteudo_sha256.slice(0, 8)} · motivo de não haver DNA
            Coletivo: {desfecho.guia.motivo_sem_dna} · leituras individuais liberadas:{" "}
            {desfecho.guia.populacoes.leiturasIndividuaisLiberadas}
          </p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 text-xs">
            {desfecho.guia.texto}
          </pre>
        </div>
      )}

      {(desfecho?.tipo === "recusado" ||
        desfecho?.tipo === "bloqueado" ||
        desfecho?.tipo === "erro_inesperado" ||
        desfecho?.tipo === "sem_conexao") && (
        <div className="rounded border border-border bg-background p-3 text-sm">
          <p className="text-foreground">{desfecho.mensagem}</p>
          {"ocorrencia" in desfecho && desfecho.ocorrencia && (
            <p className="mt-1 text-xs text-muted-foreground">
              Ocorrência {desfecho.ocorrencia}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
