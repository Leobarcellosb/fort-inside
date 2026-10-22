"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  pedirCadernoDeConducao,
  type DesfechoDoCaderno,
} from "./caderno-de-conducao-borda";

// O ACESSO DO HOST ao CADERNO DE CONDUCAO. Sem este bloco a rota existiria e
// quem conduz nao teria como chegar nela.
//
// A DIFERENCA EM RELACAO AO CARD DO GUIA, e e a razao de serem dois blocos: o
// Guia depende de dados validos e pode ser RECUSADO por motivo de metodologia
// (ha DNA publicado, as contagens nao fecham). O Caderno nao: ele existe sempre,
// com zero resposta no banco, e o unico desfecho que o impede e nao dar para
// saber quem esta pedindo. Por isso o texto deste card diz "sempre disponivel".
//
// TRES CAMINHOS PARA O PAPEL, porque o requisito e uso SEM INTERNET:
//   - "Baixar para imprimir": arquivo .html autocontido (sem script, sem fonte
//     externa, sem imagem). Baixado uma vez, abre e imprime offline;
//   - "Imprimir agora": abre esse mesmo HTML em uma janela e chama a impressao;
//   - "Baixar em texto": o .txt, para quem so quer o conteudo.
// O nome dos arquivos carrega o inicio do hash: duas impressoes diferentes do
// Caderno nunca ficam com o mesmo nome de arquivo.

export function CadernoDeConducaoCard() {
  const [emCurso, setEmCurso] = useState(false);
  const [desfecho, setDesfecho] = useState<DesfechoDoCaderno | null>(null);

  async function obter() {
    setEmCurso(true);
    setDesfecho(null);
    try {
      setDesfecho(await pedirCadernoDeConducao());
    } finally {
      setEmCurso(false);
    }
  }

  function baixar(conteudo: string, extensao: "txt" | "html", mime: string) {
    if (desfecho?.tipo !== "gerado") return;
    const blob = new Blob([conteudo], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `caderno-de-conducao-${desfecho.caderno.conteudo_sha256.slice(0, 8)}.${extensao}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function imprimir() {
    if (desfecho?.tipo !== "gerado") return;
    const janela = window.open("", "_blank");
    if (!janela) return;
    janela.document.write(desfecho.caderno.html);
    janela.document.close();
    janela.focus();
    janela.print();
  }

  const caderno = desfecho?.tipo === "gerado" ? desfecho.caderno : null;

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="space-y-1">
        <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          Caderno de Condução
        </h2>
        <p className="text-sm text-muted-foreground">
          Como conduzir o dia, nos oito momentos. Sempre disponível: não depende de questionário
          respondido, não depende de DNA Coletivo e não afirma nada sobre as pessoas que estarão na
          sala. Cada item carrega a fonte de onde veio, e o que não tem conteúdo oficial aparece
          como lacuna nomeada, com o responsável, e nunca é preenchido. Feito para ser impresso e
          usado sem internet.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={obter} disabled={emCurso} size="sm">
          {emCurso ? "Obtendo..." : "Obter caderno de condução"}
        </Button>
        {caderno && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => baixar(caderno.html, "html", "text/html")}
            >
              Baixar para imprimir
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={imprimir}>
              Imprimir agora
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => baixar(caderno.texto, "txt", "text/plain")}
            >
              Baixar em texto
            </Button>
          </>
        )}
      </div>

      {caderno && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Versão {caderno.versao} · conteúdo {caderno.conteudo_sha256.slice(0, 8)} ·{" "}
            {caderno.contagem.oficial} itens oficiais · {caderno.contagem.operacao} de operação ·{" "}
            {caderno.contagem.lacuna} lacunas declaradas
          </p>
          {caderno.lacunas.length > 0 && (
            <div className="rounded border border-border bg-background p-3">
              <p className="text-xs font-medium text-foreground">
                Falta conteúdo oficial nestes itens. Buscar antes de sábado:
              </p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {caderno.lacunas.map((l) => (
                  <li key={`${l.momento}-${l.rotulo}`}>
                    <span className="text-foreground">
                      Momento {l.momento_numero} · {l.rotulo}
                    </span>{" "}
                    · de quem: {l.de_quem}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 text-xs">
            {caderno.texto}
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
            <p className="mt-1 text-xs text-muted-foreground">Ocorrência {desfecho.ocorrencia}</p>
          )}
        </div>
      )}
    </div>
  );
}
