// PROVA de que a tentativa que perde o lease ABORTA a chamada externa, em vez
// de seguir gastando.
//
// Como se prova isso sem chamar a Anthropic (o que é PROIBIDO aqui): sobe-se um
// servidor HTTP local que imita um endpoint de modelo em streaming -- ele emite
// um "token" a cada 25ms e CONTA quantos emitiu. Se o cliente abortar de
// verdade, o servidor detecta a desconexão e para de emitir; o contador
// congela. Se o aborto fosse só uma flag, o contador continuaria subindo.
//
// O contador do SERVIDOR é a medida honesta: ele é o lado que "cobraria".
// Olhar só para o lado do cliente provaria apenas que paramos de esperar.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { criarClienteDeFilaFalso, type Manipulador } from "./cliente-falso";
import { executarJob } from "./executor";
import {
  contextoDeAbortoAtual,
  desinstalarAbortoDeFetch,
  ehErroDeAborto,
  ehProvedorPadrao,
  executarComAborto,
  instalarAbortoDeFetch,
  novaMedicao,
} from "./aborto";
import type { ClienteFila, JobReivindicado } from "./fila";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- servidor que imita o modelo em streaming, contando o que emitiu --------
let servidor: Server;
let base = "";
/** Tokens emitidos por requisição, pela CHAVE que o cliente manda. */
const emitidos = new Map<string, number>();
/** Requisições em que o servidor detectou o cliente desconectando. */
const desconectadas = new Set<string>();

beforeAll(async () => {
  servidor = createServer((req, res) => {
    const chave = new URL(req.url ?? "/", "http://local").searchParams.get("chave") ?? "sem-chave";
    emitidos.set(chave, 0);

    res.writeHead(200, { "content-type": "text/event-stream" });

    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      emitidos.set(chave, (emitidos.get(chave) ?? 0) + 1);
      res.write(`data: token\n\n`);
      // 200 tokens é o "fim da geração"; na prática o teste aborta antes.
      if ((emitidos.get(chave) ?? 0) >= 200) {
        clearInterval(timer);
        res.end();
      }
    }, 25);

    // É isto que faz do contador uma medida de CONSUMO: ao perceber o cliente
    // sumindo, o servidor para de gerar -- como a Anthropic para de gerar (e de
    // cobrar saída) quando a conexão do stream cai.
    const parar = () => {
      desconectadas.add(chave);
      clearInterval(timer);
    };
    req.on("aborted", parar);
    res.on("close", parar);
  });

  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const endereco = servidor.address();
  if (endereco == null || typeof endereco === "string") throw new Error("sem endereço");
  base = `http://127.0.0.1:${endereco.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
});

// --- o "trabalho caro": consome o stream até o fim -------------------------
async function chamadaCara(chave: string): Promise<number> {
  // Note que NADA aqui recebe um signal. É de propósito: é a situação de
  // `generatePrognostic`, que não aceita signal e está fora do escopo desta
  // unidade. O aborto chega pelo invólucro de fetch.
  const resposta = await fetch(`${base}/stream?chave=${chave}`);
  const corpo = resposta.body;
  if (!corpo) return 0;
  let pedacos = 0;
  const leitor = corpo.getReader();
  for (;;) {
    const { done } = await leitor.read();
    if (done) break;
    pedacos++;
  }
  return pedacos;
}

const job: JobReivindicado = {
  id: "job-aborto",
  participantId: "p-1",
  eventId: "e-1",
  runToken: "tok-1",
  attempts: 1,
  maxAttempts: 3,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const base_ok: Record<string, Manipulador> = {
  jobs_concluir: () => ({ data: true, error: null }),
  jobs_falhar: () => ({ data: [{ aplicado: true, status: "pending", attempts: 1 }], error: null }),
  jobs_renovar_lease: () => ({ data: true, error: null }),
};

const cliente = (m: Record<string, Manipulador>) =>
  criarClienteDeFilaFalso(m) as unknown as ClienteFila & { ordem: string[] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aborto da chamada externa", () => {
  it("o invólucro de fetch não altera nada FORA do contexto de uma tentativa", async () => {
    instalarAbortoDeFetch();
    expect(contextoDeAbortoAtual()).toBeUndefined();

    const chave = `fora-${Date.now()}`;
    const resposta = await fetch(`${base}/stream?chave=${chave}`);
    expect(resposta.status).toBe(200);
    await resposta.body?.cancel();
  });

  it("PROVA CENTRAL -- ao perder o lease, a chamada externa é abortada e o servidor PARA de emitir", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const chave = `lease-perdido-${Date.now()}`;
    // O banco recusa a renovação: é a descoberta de que outro worker levou o job.
    const c = cliente({ ...base_ok, jobs_renovar_lease: () => ({ data: false, error: null }) });

    const relatorio = await executarJob(
      c,
      job,
      async () => {
        const pedacos = await chamadaCara(chave);
        return { desfecho: "succeeded", resultado: { pedacos } };
      },
      // Renovação a cada 60ms: por volta do terceiro token o worker descobre
      // que perdeu o lease.
      { leaseSegundos: 60, renovarCadaMs: 60, backoffSegundos: 0 }
    );

    const noMomentoDoAborto = emitidos.get(chave) ?? 0;
    expect(relatorio.leasePerdido).toBe(true);
    expect(relatorio.abortada).toBe(true);
    expect(relatorio.codigo).toBe("lease_perdido_abortado");

    // O servidor percebeu o cliente sumir...
    await dormir(150);
    expect(desconectadas.has(chave)).toBe(true);

    // ...e PAROU de emitir: o contador não andou mais. É a medida de consumo
    // cortado -- com uma flag em vez de aborto, ele teria ido até 200.
    const depois = emitidos.get(chave) ?? 0;
    await dormir(400);
    const bemDepois = emitidos.get(chave) ?? 0;

    expect(depois).toBe(bemDepois);
    expect(bemDepois).toBeLessThan(30); // longe dos 200 da geração completa
    console.log("[ABORTO/lease] tokens emitidos pelo servidor:", {
      no_aborto: noMomentoDoAborto,
      logo_depois: depois,
      meio_segundo_depois: bemDepois,
      total_se_fosse_ate_o_fim: 200,
      desconexao_detectada: desconectadas.has(chave),
    });
  });

  it("PROVA -- o timeout da tentativa também aborta a chamada e congela o consumo", async () => {
    const chave = `timeout-${Date.now()}`;
    const c = cliente(base_ok);

    const relatorio = await executarJob(
      c,
      job,
      async () => {
        const pedacos = await chamadaCara(chave);
        return { desfecho: "succeeded", resultado: { pedacos } };
      },
      // Sem heartbeat: aqui quem corta é o TETO DA TENTATIVA.
      { leaseSegundos: 60, renovarCadaMs: 0, backoffSegundos: 0, timeoutTentativaMs: 150 }
    );

    expect(relatorio.abortada).toBe(true);
    expect(relatorio.codigo).toBe("timeout_da_tentativa");

    await dormir(150);
    const depois = emitidos.get(chave) ?? 0;
    await dormir(400);
    const bemDepois = emitidos.get(chave) ?? 0;

    expect(desconectadas.has(chave)).toBe(true);
    expect(depois).toBe(bemDepois);
    expect(bemDepois).toBeLessThan(30);
    console.log("[ABORTO/timeout] tokens emitidos pelo servidor:", {
      logo_depois: depois,
      meio_segundo_depois: bemDepois,
      total_se_fosse_ate_o_fim: 200,
    });
  });

  it("CONTROLE NEGATIVO -- sem aborto, a mesma chamada vai até o fim (o teste não dá falso verde)", async () => {
    // Se o contador ficasse baixo por qualquer outro motivo (servidor lento,
    // stream curto), as provas acima não valeriam nada. Aqui a MESMA chamada,
    // sem aborto, passa de 30 tokens com folga.
    const chave = `sem-aborto-${Date.now()}`;
    const c = cliente(base_ok);

    const relatorio = await executarJob(
      c,
      job,
      async () => {
        // Deixa o stream correr ~1,2s e então para de ler por conta própria.
        const resposta = await fetch(`${base}/stream?chave=${chave}`);
        await dormir(1200);
        await resposta.body?.cancel();
        return { desfecho: "succeeded" };
      },
      { leaseSegundos: 60, renovarCadaMs: 0, backoffSegundos: 0 }
    );

    expect(relatorio.abortada).toBe(false);
    expect(relatorio.desfecho).toBe("succeeded");
    const total = emitidos.get(chave) ?? 0;
    console.log("[ABORTO/controle] sem aborto, tokens emitidos:", total);
    expect(total).toBeGreaterThan(30);
  });

  it("chamada iniciada DEPOIS do aborto nem abre conexão", async () => {
    const chave = `pos-aborto-${Date.now()}`;
    const controlador = new AbortController();
    controlador.abort();

    await expect(
      executarComAborto(controlador.signal, "tentativa-x", () => chamadaCara(chave))
    ).rejects.toSatisfy(ehErroDeAborto);

    // O servidor nunca foi procurado: não há contador para esta chave.
    expect(emitidos.has(chave)).toBe(false);
  });

  it("o signal do chamador é preservado, não substituído", async () => {
    // Trocar o signal do chamador pelo nosso quebraria o aborto DELE.
    const chave = `combinado-${Date.now()}`;
    const doChamador = new AbortController();
    const daTentativa = new AbortController();

    const promessa = executarComAborto(daTentativa.signal, "tentativa-y", async () => {
      const r = await fetch(`${base}/stream?chave=${chave}`, { signal: doChamador.signal });
      const leitor = r.body!.getReader();
      for (;;) {
        const { done } = await leitor.read();
        if (done) break;
      }
    });

    await dormir(80);
    doChamador.abort(); // o aborto do CHAMADOR tem de funcionar
    await expect(promessa).rejects.toSatisfy(ehErroDeAborto);
    expect(daTentativa.signal.aborted).toBe(false);
  });

  it("CONTAGEM -- tentativa ABORTADA conta (chegou ao provedor); a que não abriu conexão NÃO conta", async () => {
    // A regra do CTO: "tentativas que chegaram ao provedor devem contar,
    // INCLUSIVE AS ABORTADAS". O contador do SERVIDOR é a testemunha: se ele
    // emitiu token, a requisição chegou; e `chamadasAoProvedor` tem de
    // concordar com ele.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // --- caso A: abortada por perda de lease, DEPOIS de despachar
    const chaveA = `conta-abortada-${Date.now()}`;
    const cA = cliente({ ...base_ok, jobs_renovar_lease: () => ({ data: false, error: null }) });
    const relA = await executarJob(
      cA,
      job,
      async () => ({ desfecho: "succeeded", resultado: { n: await chamadaCara(chaveA) } }),
      {
        leaseSegundos: 60,
        renovarCadaMs: 60,
        backoffSegundos: 0,
        ehProvedor: (url) => url.includes("/stream"),
      }
    );

    // --- caso B: abortada ANTES de despachar (o lease já estava perdido)
    const chaveB = `conta-sem-conexao-${Date.now()}`;
    const controlador = new AbortController();
    controlador.abort();
    const medicaoB = novaMedicao();
    await executarComAborto(
      controlador.signal,
      "tentativa-B",
      () => chamadaCara(chaveB).catch(() => 0),
      medicaoB,
      (url) => url.includes("/stream")
    );

    console.log("[CONTAGEM] abortada DEPOIS de despachar (caso A):", {
      chamadas_ao_provedor: relA.chamadasAoProvedor,
      abortada: relA.abortada,
      codigo: relA.codigo,
      tokens_emitidos_pelo_servidor: emitidos.get(chaveA) ?? 0,
      conta_no_teto: relA.chamadasAoProvedor > 0,
    });
    console.log("[CONTAGEM] abortada ANTES de despachar (caso B):", {
      chamadas_ao_provedor: medicaoB.aoProvedor,
      recusadas_antes_de_abrir: medicaoB.recusadasAntesDeAbrir,
      servidor_foi_procurado: emitidos.has(chaveB),
      conta_no_teto: medicaoB.aoProvedor > 0,
    });

    // CONTA: despachou, o servidor emitiu, e foi abortada depois.
    expect(relA.abortada).toBe(true);
    expect(relA.chamadasAoProvedor).toBe(1);
    expect(emitidos.get(chaveA) ?? 0).toBeGreaterThan(0);

    // NÃO CONTA: nunca abriu conexão. O servidor nem foi procurado.
    expect(medicaoB.aoProvedor).toBe(0);
    expect(medicaoB.recusadasAntesDeAbrir).toBe(1);
    expect(emitidos.has(chaveB)).toBe(false);

    vi.restoreAllMocks();
  });

  it("CONTAGEM -- requisição a outro destino (Supabase) não entra como consumo do provedor", async () => {
    // `generatePrognostic` também fala com o Supabase dentro da tentativa.
    // Contar tudo inflaria o consumo e faria o teto morder cedo, sem motivo.
    const chave = `outro-destino-${Date.now()}`;
    const medicao = novaMedicao();
    const controlador = new AbortController();

    await executarComAborto(
      controlador.signal,
      "tentativa-C",
      async () => {
        const r = await fetch(`${base}/stream?chave=${chave}`);
        await r.body?.cancel();
      },
      medicao,
      // Nenhuma URL deste teste é "do provedor".
      (url) => url.includes("api.anthropic.com")
    );

    console.log("[CONTAGEM] destino que não é o provedor:", medicao);
    expect(medicao.aoProvedor).toBe(0);
    expect(medicao.outras).toBe(1);
  });

  it("o reconhecedor padrão do provedor acerta a Anthropic e não pega o Supabase", () => {
    expect(ehProvedorPadrao("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(ehProvedorPadrao("https://abc.supabase.co/rest/v1/jobs")).toBe(false);
    expect(ehProvedorPadrao("http://127.0.0.1:54321/rest/v1/rpc/jobs_reivindicar")).toBe(false);
    // Não cai em domínio parecido de terceiro.
    expect(ehProvedorPadrao("https://anthropic.com.evil.test/v1")).toBe(false);
  });

  it("desinstalar devolve o fetch original", async () => {
    const original = globalThis.fetch;
    instalarAbortoDeFetch();
    desinstalarAbortoDeFetch(original);
    expect(globalThis.fetch).toBe(original);
    instalarAbortoDeFetch(); // reinstala para os demais testes do arquivo
  });
});
