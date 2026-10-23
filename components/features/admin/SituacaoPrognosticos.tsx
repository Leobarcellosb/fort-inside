"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ORDEM_GRUPOS,
  TEXTO_GRUPO,
  contarPorGrupo,
  montarSituacao,
  resumoDaTurma,
  textoConfirmacao,
  type GrupoId,
  type LinhaDocumento,
  type LinhaJob,
  type PessoaBase,
  type SituacaoPessoa,
} from "./situacao-prognostico";
import { interpretarRespostaDaFila, type EstadoDaFila } from "./estado-da-fila";

export type { EstadoDaFila };

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
// Duas fontes, de propósito separadas, porque respondem perguntas diferentes:
//   documentos: prognostics.status  -> "em que estado o DOCUMENTO está hoje?"
//   jobs:       /api/jobs/status    -> "o que aconteceu no ÚLTIMO PROCESSAMENTO?"

async function lerDocumentos(ids: string[]): Promise<LinhaDocumento[] | null> {
  if (ids.length === 0) return [];
  try {
    const supabase = createClient();
    const { data, error } = await (
      supabase.from("prognostics") as unknown as {
        select(cols: string): {
          in(col: string, values: string[]): Promise<{ data: LinhaDocumento[] | null; error: unknown }>;
        };
      }
    )
      .select("participant_id, status, generated_at")
      .in("participant_id", ids);
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function linhaJobValida(x: unknown): x is LinhaJob {
  if (!x || typeof x !== "object") return false;
  const j = x as Record<string, unknown>;
  return (
    typeof j.id === "string" &&
    typeof j.participant_id === "string" &&
    typeof j.status === "string" &&
    typeof j.attempts === "number" &&
    typeof j.max_attempts === "number" &&
    typeof j.updated_at === "string"
  );
}

async function lerJobs(
  eventId: string
): Promise<{ jobs: LinhaJob[] | null; fila: Exclude<EstadoDaFila, "verificando"> }> {
  try {
    const res = await fetch(`/api/jobs/status?event_id=${encodeURIComponent(eventId)}`, {
      cache: "no-store",
      // Leitura barata: se travar, melhor mostrar os documentos sem o histórico
      // do que deixar a tela esperando.
      signal: AbortSignal.timeout(15_000),
    });
    // O CÓDIGO da resposta diz a causa (ver estado-da-fila.ts): só
    // QUEUE_SCHEMA_MISSING significa "falta a migration 018". Auth fora do ar, fila
    // que não respondeu, 5xx de proxy etc. NÃO são isso.
    let corpo: unknown = null;
    try {
      corpo = await res.json();
    } catch {
      /* corpo não-JSON */
    }
    const leitura = interpretarRespostaDaFila(res.status, corpo);
    if (leitura.fila !== "ok") {
      if (leitura.ocorrencia || !res.ok) {
        console.warn("[fila] leitura de /api/jobs/status sem sucesso", {
          status: res.status,
          codigo: leitura.codigo,
          ocorrencia: leitura.ocorrencia,
        });
      }
      return { jobs: null, fila: leitura.fila };
    }
    const body = corpo as { jobs: unknown[] };
    return { jobs: body.jobs.filter(linhaJobValida), fila: "ok" };
  } catch {
    // Rede ou tempo esgotado: não sabemos. Não derrubamos o que já sabíamos.
    return { jobs: null, fila: "sem_resposta" };
  }
}

// ---------------------------------------------------------------------------
// Apresentação
// ---------------------------------------------------------------------------

type Tom = "sucesso" | "neutro" | "silencioso" | "atencao" | "andamento";

const CLASSE_TOM: Record<Tom, string> = {
  sucesso: "bg-success/10 text-success",
  neutro: "bg-muted/50 text-foreground",
  silencioso: "border border-border text-muted-foreground",
  atencao: "bg-destructive/10 text-destructive",
  andamento: "bg-primary/10 text-primary",
};

function Selo({ tom, children }: { tom: Tom; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${CLASSE_TOM[tom]}`}>
      {children}
    </span>
  );
}

function tomDoDocumento(s: SituacaoPessoa): Tom {
  switch (s.documento) {
    case "delivered":
    case "reviewed":
      return "sucesso";
    case "in_review":
    case "generated":
      return "neutro";
    default:
      return "silencioso";
  }
}

function tomDoProcessamento(s: SituacaoPessoa): Tom {
  switch (s.processamento.resultado) {
    case "gerado":
      return "sucesso";
    // Pulado é proteção, nunca erro: tom neutro, igual a um documento comum.
    case "pulado":
      return "neutro";
    case "falhou":
    case "cancelado":
      // Só é alarme quando a pessoa realmente ficou sem documento.
      return s.grupo === "atencao" ? "atencao" : "neutro";
    case "na_fila":
    case "gerando":
    case "nova_tentativa":
      return "andamento";
    default:
      return "silencioso";
  }
}

function tomDoGrupo(g: GrupoId): string {
  return g === "atencao" ? "border-destructive/40" : "border-border";
}

function quando(iso: string | null, agora: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.floor((agora - t) / 60_000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** "2 tentativas" quando terminou bem; "3 de 3 tentativas" quando o limite importa. */
function textoTentativas(p: SituacaoPessoa["processamento"]): string | null {
  if (p.tentativas === null || p.tentativasMax === null || p.tentativas < 1) return null;
  const limiteImporta = p.resultado === "falhou" || p.resultado === "nova_tentativa";
  if (limiteImporta) {
    return `${p.tentativas} de ${p.tentativasMax} ${p.tentativasMax === 1 ? "tentativa" : "tentativas"}`;
  }
  return `${p.tentativas} ${p.tentativas === 1 ? "tentativa" : "tentativas"}`;
}

function Linha({
  s,
  agora,
  ocupado,
  aoTentarDeNovo,
}: {
  s: SituacaoPessoa;
  agora: number;
  ocupado: boolean;
  aoTentarDeNovo: (s: SituacaoPessoa) => void;
}) {
  const p = s.processamento;
  const hora = quando(p.quando, agora);
  const temDetalhe = Boolean(p.motivo || p.erro || p.tentativas !== null || p.detalheTecnico || s.semRetentativa);

  return (
    <li className="space-y-2 rounded-md border border-border bg-card px-4 py-3" data-pessoa={s.id}>
      <p className="truncate text-sm font-medium text-foreground">{s.nome}</p>

      {/* Duas informações, em linhas separadas e com nomes diferentes: nunca somadas. */}
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Documento</dt>
        <dd>
          <Selo tom={tomDoDocumento(s)}>{s.documentoRotulo}</Selo>
        </dd>
        <dt className="text-muted-foreground">Último processamento</dt>
        <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Selo tom={tomDoProcessamento(s)}>{p.rotulo}</Selo>
          {textoTentativas(p) && <span className="text-muted-foreground">{textoTentativas(p)}</span>}
          {hora && p.resultado !== "nunca" && <span className="text-muted-foreground">{hora}</span>}
        </dd>
      </dl>

      {s.aviso && <p className="text-xs text-foreground/80">{s.aviso}</p>}

      {temDetalhe && (
        <details className="group text-xs">
          <summary className="cursor-pointer select-none py-1 text-muted-foreground underline-offset-2 hover:underline">
            Ver motivo e tentativas
          </summary>
          <div className="space-y-1.5 border-l border-border pl-3 pt-1 text-foreground/80">
            {p.motivo && <p>{p.motivo}</p>}
            {p.erro && (
              <p>
                <span className="text-muted-foreground">O que deu errado: </span>
                {p.erro}
              </p>
            )}
            <p>
              <span className="text-muted-foreground">Tentativas: </span>
              {p.tentativas !== null && p.tentativasMax !== null
                ? `${p.tentativas} de ${p.tentativasMax}`
                : "nenhuma ainda"}
            </p>
            <p>
              <span className="text-muted-foreground">Documento agora: </span>
              {s.documentoRotulo}
            </p>
            {p.detalheTecnico && (
              <p className="break-words text-muted-foreground">Mensagem original: {p.detalheTecnico}</p>
            )}
            {s.semRetentativa && <p>{s.semRetentativa}</p>}
          </div>
        </details>
      )}

      {s.retentativa?.tipo === "fila" && (
        <Button
          variant="outline"
          disabled={ocupado}
          onClick={() => aoTentarDeNovo(s)}
          className="h-10 w-full border-border text-xs uppercase tracking-[0.08em] sm:w-auto"
        >
          {ocupado ? "Tentando..." : "Tentar de novo"}
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

interface Props {
  eventId: string;
  eventStatus: string;
  pessoas: PessoaBase[];
  /** Muda quando o painel quer forçar uma releitura (ex.: acabou de enfileirar). */
  sinalDeLeitura: number;
  /** Diz ao painel se a fila está utilizável: o botão "Processar" depende disso. */
  aoMudarFila: (estado: EstadoDaFila) => void;
  aoIrParaRevisao: () => void;
  /**
   * Quantos ja tem documento e quantos falharam sem documento. O painel usa isto
   * para nao chamar de "Concluido" um processamento em que tudo falhou: o banco
   * fecha o evento quando nao sobra job pendente, falho ou nao (Rodada 69).
   */
  aoResumir?: (r: { comDocumento: number; falharam: number }) => void;
  /**
   * Dentro de um passo do painel do Marco Zero: sem o titulo, sem o botao de
   * revisao (o passo seguinte ja leva la) e sem a explicacao longa. Os dados, as
   * falhas e o reprocessamento continuam iguais.
   */
  embutido?: boolean;
}

export function SituacaoPrognosticos({
  eventId,
  eventStatus,
  pessoas,
  sinalDeLeitura,
  aoMudarFila,
  aoIrParaRevisao,
  aoResumir,
  embutido = false,
}: Props) {
  const [documentos, setDocumentos] = useState<LinhaDocumento[] | null>(null);
  const [jobs, setJobs] = useState<LinhaJob[] | null>(null);
  const [lidoEm, setLidoEm] = useState<number | null>(null);
  const [falhaDeLeitura, setFalhaDeLeitura] = useState(false);
  const [semFila, setSemFila] = useState(false);
  const [tentouLer, setTentouLer] = useState(false);
  const [confirmando, setConfirmando] = useState<SituacaoPessoa | null>(null);
  const [ocupados, setOcupados] = useState<Set<string>>(new Set());
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  const [reprocessandoLote, setReprocessandoLote] = useState(false);

  const idsChave = pessoas.map((p) => p.id).join(",");
  const idsRef = useRef<string[]>([]);
  idsRef.current = pessoas.map((p) => p.id);

  const atualizar = useCallback(async () => {
    // As duas leituras são independentes: o que chegar primeiro aparece primeiro.
    const pDocs = lerDocumentos(idsRef.current).then((docs) => {
      if (docs) setDocumentos(docs);
      setFalhaDeLeitura(docs === null);
      if (docs) setLidoEm(Date.now());
    });
    // Sem a fila (ex.: migration 018 ainda não aplicada neste ambiente) o painel
    // continua mostrando o estado dos documentos e diz que o histórico não existe.
    const pJobs = lerJobs(eventId).then(({ jobs: js, fila }) => {
      if (js) {
        setJobs(js);
        setLidoEm(Date.now());
      }
      setSemFila(js === null);
      aoMudarFila(fila);
    });
    await Promise.all([pDocs, pJobs]);
    setTentouLer(true);
  }, [eventId, aoMudarFila]);

  const situacoes = useMemo(
    () =>
      documentos === null && jobs === null
        ? null
        : montarSituacao({
            pessoas,
            documentos: documentos ?? [],
            jobs: jobs ?? [],
          }),
    [pessoas, documentos, jobs]
  );

  // Falhas que a fila sabe reprocessar: as mesmas do botao individual.
  const falhasDoLote = situacoes
    ? situacoes.filter((s) => s.grupo === "atencao" && s.retentativa?.tipo === "fila")
    : [];
  const comDocumento = situacoes ? situacoes.filter((s) => s.documento !== null).length : 0;
  useEffect(() => {
    if (situacoes) aoResumir?.({ comDocumento, falharam: falhasDoLote.length });
  }, [situacoes, comDocumento, falhasDoLote.length, aoResumir]);

  const emAndamento = situacoes ? situacoes.some((s) => s.grupo === "andamento") : false;
  const ativoRef = useRef(false);
  ativoRef.current = emAndamento || eventStatus === "processing" || ocupados.size > 0;

  // Leitura inicial e quando entra gente nova ou o painel pede.
  useEffect(() => {
    void atualizar();
  }, [atualizar, idsChave, sinalDeLeitura]);

  // Empurrão na fila. Enquanto houver gente em andamento e esta página estiver
  // aberta, pedimos um ciclo ao processador de tempos em tempos. É idempotente: o
  // teto de concorrência é global no banco, então ciclos sobrepostos não multiplicam
  // o trabalho. Não substitui o agendador (cron): se ninguém tiver uma página
  // aberta, quem faz a fila andar é ele.
  const tickEmVooRef = useRef(false);
  const ultimoTickRef = useRef(0);
  const empurrarFila = useCallback(() => {
    if (!ativoRef.current || tickEmVooRef.current) return;
    if (Date.now() - ultimoTickRef.current < 45_000) return;
    tickEmVooRef.current = true;
    ultimoTickRef.current = Date.now();
    void fetch("/api/jobs/tick", { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        tickEmVooRef.current = false;
      });
  }, []);

  // Releitura periódica: rápida enquanto há trabalho em curso, lenta no resto.
  useEffect(() => {
    let vivo = true;
    let timer: ReturnType<typeof setTimeout>;
    const agendar = () => {
      timer = setTimeout(async () => {
        if (!vivo) return;
        if (!document.hidden) {
          await atualizar();
          empurrarFila();
        }
        if (vivo) agendar();
      }, ativoRef.current ? 5_000 : 30_000);
    };
    agendar();
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [atualizar, empurrarFila]);

  async function executar(s: SituacaoPessoa) {
    const r = s.retentativa;
    if (!r) return;
    setOcupados((prev) => new Set(prev).add(s.id));
    try {
      if (r.tipo === "fila") {
        const res = await fetch("/api/jobs/operacao", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id: r.jobId, acao: "reenfileirar" }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; motivo?: string; error?: string };
        if (!res.ok || !data.ok) {
          toast.error(data.motivo ?? data.error ?? `Não foi possível recolocar ${s.nome} na fila`);
          return;
        }
        toast.success(`${s.nome} voltou para a fila`);
        // Pede ao processador que comece já, em vez de esperar o próximo ciclo.
        // Não aguardamos: a resposta só chega quando a fatia de trabalho termina.
        void fetch("/api/jobs/tick", { method: "POST" }).catch(() => undefined);
      }
    } catch {
      toast.error("Sem conexão com o servidor. Tente de novo em instantes.");
    } finally {
      setOcupados((prev) => {
        const n = new Set(prev);
        n.delete(s.id);
        return n;
      });
      void atualizar();
    }
  }

  async function reprocessarFalhas() {
    setReprocessandoLote(true);
    try {
      const res = await fetch("/api/jobs/reprocessar-falhas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reenfileirados?: number;
        nao_voltaram?: { motivo: string }[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Não foi possível reprocessar as falhas agora. Nada foi alterado.");
        return;
      }
      const n = data.reenfileirados ?? 0;
      const fora = data.nao_voltaram?.length ?? 0;
      toast.success(
        fora > 0
          ? `${n} voltaram para a fila. ${fora} não voltaram: veja o motivo em cada pessoa.`
          : `${n} voltaram para a fila.`,
      );
      void fetch("/api/jobs/tick", { method: "POST" }).catch(() => undefined);
    } catch {
      toast.error("Sem conexão com o servidor. Nada foi alterado; tente de novo em instantes.");
    } finally {
      setReprocessandoLote(false);
      setConfirmandoLote(false);
      void atualizar();
    }
  }

  if (situacoes === null) {
    // Nenhuma das duas leituras voltou com dados.
    return (
      <section className="space-y-2" aria-busy={!tentouLer}>
        <h2 className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Direcionamentos</h2>
        {tentouLer ? (
          <div role="status" className="space-y-2 text-sm text-foreground/80">
            <p>Não foi possível ler a situação dos direcionamentos agora. Isto não significa que algo deu errado com eles.</p>
            <Button variant="outline" onClick={() => void atualizar()} className="h-10 border-border text-xs uppercase tracking-[0.08em]">
              Ler de novo
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Lendo a situação dos direcionamentos...</p>
        )}
      </section>
    );
  }

  const contagem = contarPorGrupo(situacoes);
  const confirmacao = confirmando ? textoConfirmacao(confirmando) : null;
  const agora = lidoEm ?? 0;

  return (
    <section className="space-y-4" aria-labelledby="situacao-titulo">
      <div className="space-y-1">
        {!embutido && (
          <div className="flex items-start justify-between gap-3">
            <h2 id="situacao-titulo" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              Direcionamentos
            </h2>
            <Button
              onClick={aoIrParaRevisao}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-xs"
            >
              Ir para a revisão
            </Button>
          </div>
        )}
        <p className="font-display text-lg text-foreground" data-testid="resumo-turma">
          {resumoDaTurma(situacoes)}
        </p>
        {!embutido && (
          <p className="text-xs text-muted-foreground">
            Cada pessoa aparece uma vez. Para cada uma mostramos duas coisas separadas: em que estado o
            documento está agora e o que aconteceu no último processamento.
          </p>
        )}
      </div>

      {(falhaDeLeitura || semFila) && (
        <p role="status" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground/80">
          {falhaDeLeitura
            ? "Não foi possível atualizar o estado dos documentos agora. O que está na tela pode estar desatualizado; tentamos de novo em instantes."
            : "Não foi possível ler o histórico de processamento (tentativas e motivos) agora. Mostramos só o estado dos documentos."}
        </p>
      )}

      {/* REPROCESSAR EM LOTE (Rodada 69). So aparece com 2 ou mais falhas: com
          uma, o botao da propria pessoa resolve. O resumo e a confirmacao
          dizem quem volta e o que NAO muda. */}
      {falhasDoLote.length >= 2 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 space-y-2">
          <p className="text-sm text-foreground">
            {falhasDoLote.length} documentos falharam. Se a causa já foi resolvida (por exemplo, a chave da
            IA), dá para colocar todos de volta na fila de uma vez.
          </p>
          <Button
            variant="outline"
            disabled={reprocessandoLote}
            onClick={() => setConfirmandoLote(true)}
            className="h-10 border-border text-xs uppercase tracking-[0.08em]"
          >
            {reprocessandoLote ? "Reprocessando..." : `Reprocessar as ${falhasDoLote.length} falhas`}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmandoLote} onOpenChange={(aberto) => !aberto && !reprocessandoLote && setConfirmandoLote(false)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">
              Reprocessar {falhasDoLote.length} documentos que falharam?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Voltam para a fila: {falhasDoLote.map((s) => s.nome).join(", ")}. Documentos já gerados não são
              refeitos, e o limite de tentativas por pessoa e por evento continua valendo. Confirme antes que a
              causa da falha foi resolvida: se não foi, eles vão falhar de novo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border" disabled={reprocessandoLote}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void reprocessarFalhas();
              }}
              disabled={reprocessandoLote}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Reprocessar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="space-y-3">
        {ORDEM_GRUPOS.filter((g) => contagem[g] > 0).map((g) => {
          const texto = TEXTO_GRUPO[g];
          const membros = situacoes.filter((s) => s.grupo === g);
          const abrir = g === "indeterminado" || g === "atencao" || g === "andamento" || g === "aguardando";
          return (
            <details
              key={g}
              open={abrir}
              data-grupo={g}
              className={`group rounded-md border bg-card/50 ${tomDoGrupo(g)}`}
            >
              <summary className="cursor-pointer select-none px-4 py-3">
                <span className={`text-sm font-medium ${g === "atencao" ? "text-destructive" : "text-foreground"}`}>
                  {texto.titulo(membros.length)}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{texto.explicacao}</span>
              </summary>
              <ul className="space-y-2 px-3 pb-3">
                {membros.map((s) => (
                  <Linha
                    key={s.id}
                    s={s}
                    agora={agora}
                    ocupado={ocupados.has(s.id)}
                    aoTentarDeNovo={setConfirmando}
                  />
                ))}
              </ul>
            </details>
          );
        })}
      </div>

      <AlertDialog open={confirmando !== null} onOpenChange={(aberto) => !aberto && setConfirmando(null)}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-foreground">{confirmacao?.titulo}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">{confirmacao?.corpo}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const alvo = confirmando;
                setConfirmando(null);
                if (alvo) void executar(alvo);
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {confirmacao?.botao}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
