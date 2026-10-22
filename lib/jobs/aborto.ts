// Aborto REAL da chamada externa quando a tentativa perde o direito de existir.
//
// ===========================================================================
// O problema, nas palavras do responsável técnico
// ===========================================================================
// "O fencing garante que um worker antigo não consiga persistir um resultado
// depois de perder seu lease. Ele NÃO impede que esse worker continue
// consumindo tokens da Anthropic."
//
// Medido: 3 leases vivos, 4 execuções em voo. O quarto worker existe porque um
// lease venceu com a chamada ainda aberta -- e o dono antigo seguiu gerando
// (e sendo cobrado) até o fim, para ter o resultado recusado depois.
//
// Uma FLAG que alguém consulta não resolve: `sinal.perdido` só ajuda se o
// trabalho tiver um ponto de checagem, e uma chamada de streaming de ~63s não
// tem nenhum entre o pedido e a resposta. O que corta o consumo é fechar a
// CONEXÃO.
//
// ===========================================================================
// Por que pelo fetch global, e não por um parâmetro
// ===========================================================================
// O caminho óbvio seria `generatePrognostic(..., { signal })`. Não é possível:
// `lib/ai/**` está fora do escopo desta unidade (outra unidade está lá agora), e
// `generatePrognostic` não aceita signal -- ela instancia o SDK da Anthropic no
// módulo e chama `anthropic.messages.stream(...)` sem repassar nada.
//
// O SDK da Anthropic usa `fetch` por baixo. Então o aborto é instalado onde o
// SDK inevitavelmente passa: um invólucro de `globalThis.fetch` que, APENAS
// dentro do contexto assíncrono de uma tentativa, anexa o AbortSignal daquela
// tentativa à requisição. `AsyncLocalStorage` é o que amarra "esta requisição
// pertence àquela tentativa" sem precisar passar nada de mão em mão.
//
// Consequências, declaradas:
//   - TODA requisição feita dentro da tentativa é abortada junto, não só a da
//     Anthropic -- inclusive as leituras/escritas que `generatePrognostic` faz
//     no Supabase. Isso é desejado: a tentativa perdeu o lease, então o que ela
//     ainda ia escrever seria recusado pelo fencing de qualquer forma (e a 015 e
//     o UNIQUE de prognostics protegem a integridade do documento).
//   - Fora do contexto, o fetch é o original, sem nenhuma alteração de
//     comportamento. As chamadas do próprio executor (`jobs_concluir`,
//     `jobs_falhar`, renovação de lease) acontecem FORA do contexto de
//     propósito: elas precisam sobreviver ao aborto para registrar o desfecho.
//   - É monkey-patch de global, e isso é uma escolha consciente de último
//     recurso. O invólucro é idempotente, não troca o comportamento fora do
//     contexto e não engole erro nenhum.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contagem do que a tentativa CHEGOU a mandar para o provedor externo.
 *
 * Esta é a unidade de cobrança, e é diferente de `jobs.attempts`: uma tentativa
 * abortada no meio JÁ chegou ao provedor (conta), e uma tentativa cujo aborto
 * chegou antes do despacho NÃO abriu conexão (não conta).
 *
 * A contagem é no DESPACHO, não na resposta: uma requisição que saiu e falhou
 * na conexão é contada. É a escolha conservadora de propósito -- superestimar o
 * consumo é erro seguro; subestimar é teto que não morde.
 */
export interface MedicaoDeChamadas {
  /** Requisições ao PROVEDOR efetivamente despachadas. */
  aoProvedor: number;
  /** Requisições recusadas pelo invólucro porque a tentativa já estava abortada. */
  recusadasAntesDeAbrir: number;
  /** Requisições a outros destinos (Supabase etc.), só para diagnóstico. */
  outras: number;
}

export function novaMedicao(): MedicaoDeChamadas {
  return { aoProvedor: 0, recusadasAntesDeAbrir: 0, outras: 0 };
}

/** O provedor que custa dinheiro. Sobrescrevível para a prova com servidor local. */
export function ehProvedorPadrao(url: string): boolean {
  return /(^|\/\/|\.)anthropic\.com([/:]|$)/i.test(url);
}

export interface ContextoDeAborto {
  signal: AbortSignal;
  /** Para a mensagem de erro dizer QUAL tentativa foi abortada. */
  rotulo: string;
  medicao: MedicaoDeChamadas;
  ehProvedor: (url: string) => boolean;
}

const armazenamento = new AsyncLocalStorage<ContextoDeAborto>();

/** Para teste e diagnóstico: o contexto em vigor, se houver. */
export function contextoDeAbortoAtual(): ContextoDeAborto | undefined {
  return armazenamento.getStore();
}

function combinar(a: AbortSignal, b: AbortSignal | null | undefined): AbortSignal {
  if (!b) return a;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any([a, b]);
  // Combinador manual, para não depender da versão do runtime. Perder o signal
  // do chamador seria pior que o patch: quebraria o aborto DELE.
  const c = new AbortController();
  const propagar = (origem: AbortSignal) => () => c.abort(origem.reason);
  if (a.aborted) c.abort(a.reason);
  else if (b.aborted) c.abort(b.reason);
  else {
    a.addEventListener("abort", propagar(a), { once: true });
    b.addEventListener("abort", propagar(b), { once: true });
  }
  return c.signal;
}

let instalado = false;

/**
 * Instala o invólucro de `globalThis.fetch`. Idempotente: pode ser chamada
 * quantas vezes quiser, embrulha uma só.
 */
export function instalarAbortoDeFetch(): boolean {
  if (instalado) return true;
  const original = globalThis.fetch;
  if (typeof original !== "function") return false;

  const comAborto: typeof fetch = (entrada, init) => {
    const ctx = armazenamento.getStore();
    if (!ctx) return original(entrada, init);

    const url =
      typeof entrada === "string"
        ? entrada
        : entrada instanceof URL
          ? entrada.href
          : typeof Request !== "undefined" && entrada instanceof Request
            ? entrada.url
            : String(entrada);
    const paraOProvedor = ctx.ehProvedor(url);

    // Já abortado: nem abre a conexão. Esta requisição NÃO chegou ao provedor,
    // logo NÃO entra no consumo -- é a distinção que o teto do CTO faz.
    if (ctx.signal.aborted) {
      if (paraOProvedor) ctx.medicao.recusadasAntesDeAbrir++;
      return Promise.reject(
        new DOMException(
          `requisição recusada: a tentativa ${ctx.rotulo} já foi abortada`,
          "AbortError"
        )
      );
    }

    // Contado no DESPACHO: a partir daqui a requisição saiu, e o que o provedor
    // gerar até o aborto já foi gerado. Abortar depois não desconta.
    if (paraOProvedor) ctx.medicao.aoProvedor++;
    else ctx.medicao.outras++;

    const doChamador =
      init?.signal ?? (typeof Request !== "undefined" && entrada instanceof Request ? entrada.signal : null);

    return original(entrada, { ...init, signal: combinar(ctx.signal, doChamador) });
  };

  globalThis.fetch = comAborto;
  instalado = true;
  return true;
}

/** Só para teste: devolve o fetch original e permite reinstalar. */
export function desinstalarAbortoDeFetch(originalSalvo: typeof fetch): void {
  globalThis.fetch = originalSalvo;
  instalado = false;
}

/**
 * Roda `fn` num contexto onde todo `fetch` nasce amarrado a `signal`.
 * Instala o invólucro na primeira vez, para que contexto e patch nunca fiquem
 * fora de sincronia (um contexto sem patch abortaria nada, silenciosamente).
 */
export function executarComAborto<T>(
  signal: AbortSignal,
  rotulo: string,
  fn: () => Promise<T>,
  medicao: MedicaoDeChamadas = novaMedicao(),
  ehProvedor: (url: string) => boolean = ehProvedorPadrao
): Promise<T> {
  instalarAbortoDeFetch();
  return armazenamento.run({ signal, rotulo, medicao, ehProvedor }, fn);
}

export function ehErroDeAborto(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "object" && "name" in err && (err as { name?: unknown }).name === "AbortError") {
    return true;
  }
  // O SDK da Anthropic e o undici reembrulham o erro; a mensagem é o que resta.
  const msg = err instanceof Error ? err.message : String(err);
  return /abort/i.test(msg);
}
