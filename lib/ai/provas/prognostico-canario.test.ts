// PROVA do gerador de prognostico do Marco Zero contra Postgres local de
// verdade e o CANARIO roteirizavel no lugar da Anthropic.
//
// Como rodar (nunca contra producao; ver o guarda abaixo):
//   bash lib/ai/provas/rodar.sh
// Sem PROVA_CANARIO_URL o arquivo e PULADO, para `npx vitest run` continuar
// verde em maquina sem Supabase local.
//
// O que ela prova, nesta ordem:
//   1. briefing no prompt (e as respostas cruas pontuadas fora);
//   2. indeterminacao nao pede eixo;
//   3. elemento ausente nao chega como fragilidade;
//   4. violacao plantada na saida: recusada e NADA gravado; depois o caminho
//      limpo e o de uma correcao bem-sucedida;
//   5. travas de estado da migration 015 valem (409, zero chamadas);
//   6. zero chamadas a Anthropic real, com controle positivo do contador.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { ETAPAS_MARCO_ZERO, respostasMarcoZero } from "../fixtures-marco-zero";
import type { OpcoesDeRespostas } from "../fixtures-marco-zero";
import { prognosticoLimpo } from "../fixtures-prognostico";

const CANARIO = process.env.PROVA_CANARIO_URL;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const descreve = CANARIO ? describe : describe.skip;

const evidencia: Record<string, unknown> = {};
const hostsAlcancados = new Set<string>();
const registrar = (chave: string, valor: unknown) => {
  evidencia[chave] = valor;
};

async function canario(caminho: string, init?: RequestInit) {
  const r = await fetch(`${CANARIO}${caminho}`, init);
  return r.json() as Promise<any>;
}
const zerar = () => canario("/__canario/zerar", { method: "POST" });
const roteiro = (respostas: unknown[]) =>
  canario("/__canario/roteiro", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ respostas }),
  });
const contagem = async () => (await canario("/__canario/contagem")).total as number;

descreve("gerador de prognostico do Marco Zero (banco local + canario)", () => {
  let db: SupabaseClient;
  let generatePrognostic: typeof import("../generate-prognostic").generatePrognostic;
  let eventId = "";
  const marca = `PROVA-${Date.now()}`;
  let n = 0;

  beforeAll(async () => {
    // GUARDAS: so banco local, so canario local, chave de API falsa.
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(SUPA_URL)) {
      throw new Error(`NEXT_PUBLIC_SUPABASE_URL nao e local: ${SUPA_URL}`);
    }
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(CANARIO!)) {
      throw new Error(`canario nao e local: ${CANARIO}`);
    }
    // Rede: TODO fetch do processo passa por aqui. Um host que nao seja local e
    // recusado ANTES de sair, e a lista de hosts alcancados vira evidencia.
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (entrada: any, init?: any) => {
      const alvo = new URL(typeof entrada === "string" ? entrada : (entrada.url ?? String(entrada)));
      hostsAlcancados.add(alvo.host);
      if (alvo.hostname !== "127.0.0.1" && alvo.hostname !== "localhost") {
        throw new Error(`REDE EXTERNA BLOQUEADA PELA PROVA: ${alvo.host}`);
      }
      return fetchOriginal(entrada, init);
    }) as typeof fetch;

    process.env.ANTHROPIC_BASE_URL = CANARIO;
    process.env.ANTHROPIC_API_KEY = "sk-ant-FALSA-prova-prognostico-nao-existe";
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    db = createClient(SUPA_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // O SDK le ANTHROPIC_BASE_URL na construcao do modulo: importar DEPOIS do env.
    ({ generatePrognostic } = await import("../generate-prognostic"));

    const { data: ev, error } = await db
      .from("events")
      .insert({
        name: `prova prognostico ${marca}`,
        event_code: marca,
        event_date: new Date().toISOString(),
        status: "processing",
        current_stage: 5,
        quiz_version: 2,
      } as never)
      .select("id")
      .single();
    if (error || !ev) throw new Error(`seed do evento: ${error?.message}`);
    eventId = (ev as { id: string }).id;
  });

  afterAll(async () => {
    if (eventId) await db.from("events").delete().eq("id", eventId); // cascata leva o resto
    if (process.env.PROVA_SAIDA) writeFileSync(process.env.PROVA_SAIDA, JSON.stringify(evidencia, null, 2));
  });

  async function semear(opcoes?: OpcoesDeRespostas, statusPrognostico?: string) {
    n += 1;
    const { data: p, error } = await db
      .from("participants")
      .insert({
        event_id: eventId,
        full_name: `Participante ${n}`,
        email: `p${n}-${marca}@prova.test`,
        completed_at: new Date().toISOString(),
      } as never)
      .select("id")
      .single();
    if (error || !p) throw new Error(`seed do participante: ${error?.message}`);
    const id = (p as { id: string }).id;
    const linhas = respostasMarcoZero(opcoes).map((r) => ({
      participant_id: id,
      stage_id: r.stage_id,
      answers: r.answers,
    }));
    const { error: qErr } = await db.from("quiz_responses").insert(linhas as never);
    if (qErr) throw new Error(`seed das respostas: ${qErr.message}`);
    if (statusPrognostico) {
      const { error: gErr } = await db.from("prognostics").insert({
        participant_id: id,
        raw_ai_output: { marcador: "documento-humano-original" },
        status: statusPrognostico,
        trail_recommendation: "Exploração",
        generated_at: new Date().toISOString(),
      } as never);
      if (gErr) throw new Error(`seed do prognostico: ${gErr.message}`);
    }
    return id;
  }

  const lerPrognostico = async (participantId: string) => {
    const { data } = await db.from("prognostics").select("*").eq("participant_id", participantId).maybeSingle();
    return data as { status: string; raw_ai_output: any } | null;
  };
  const promptEnviado = async () => {
    const corpo = await canario("/__canario/ultima");
    const user = corpo.messages[0].content as string;
    const system = corpo.system.map((b: { text: string }) => b.text).join("\n");
    return { corpo, user, system };
  };

  it("0. ambiente: o SDK aponta para o canario e a chave e falsa", async () => {
    expect(process.env.ANTHROPIC_BASE_URL).toBe(CANARIO);
    expect(process.env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-FALSA/);
    expect(SUPA_URL).toMatch(/127\.0\.0\.1|localhost/);
    registrar("ambiente", { ANTHROPIC_BASE_URL: CANARIO, chave: process.env.ANTHROPIC_API_KEY!.slice(0, 18), supabase: SUPA_URL });
  });

  it("1. participante com as 5 etapas: o prompt enviado leva o briefing, nao as respostas cruas sozinhas", async () => {
    await zerar();
    const id = await semear({
      likert: { visao: 5, execucao: 3, relacao: 3, integridade: 3 },
      situacionais: ["A", "C", "B", "D", "A", "D"],
    });
    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(true);
    expect(await contagem()).toBe(1);

    const { user, system, corpo } = await promptEnviado();
    expect(user).toContain("BRIEFING DO MARCO ZERO");
    expect(user).toContain("[FATO MEDIDO]");
    expect(user).toContain("forte orientação à dimensão “Visão e Direção”");
    // as 52 perguntas nao viram dump cru: so as abertas
    expect(user).not.toMatch(/Escolha apenas a alternativa|Organizar o problema/);
    expect(corpo.output_config.effort).toBe("medium");
    expect(system).toContain("exatamente quatro dimensões");
    registrar("1_prompt_usuario_completo", user);
    registrar("1_chamadas_ao_canario", (await canario("/__canario/contagem")).requisicoes);

    const gravado = await lerPrognostico(id);
    expect(gravado?.status).toBe("generated");
  });

  it("2. sem eixo destacado: o prompt leva o texto aprovado e nao pede eixo", async () => {
    await zerar();
    const id = await semear(); // padrao: empate nos dois instrumentos
    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(true);
    const { user, system } = await promptEnviado();
    expect(user).toContain("[INDETERMINADO] dimensão em destaque na autodescrição");
    expect(user).toContain("[INDETERMINADO] dimensão em destaque nas escolhas situacionais");
    expect(user).toContain("sem uma predominância suficientemente clara para destacar um único eixo");
    expect(user).not.toContain("forte orientação");
    expect(user.split("\n").filter((l) => l.startsWith("[HIPÓTESE A VALIDAR]"))).toEqual([]);
    const pede = /\b(escolh\w+|identifi\w+|determin\w+|defin\w+|indiqu\w+|aponte|classifi\w+|elej\w+)\b.*\b(eixo|eixos|dimens\w+|perfil)\b/i;
    const linhasQuePedem = `${system}\n${user}`
      .split("\n")
      .filter((l) => pede.test(l) && !/\b(não|nunca|nada|sem)\b/i.test(l));
    expect(linhasQuePedem).toEqual([]);
    registrar("2_trecho_indeterminado", user.split("\n").filter((l) => l.includes("[INDETERMINADO]")));
  });

  it("3. elemento nao respondido nao chega ao modelo como fragilidade", async () => {
    await zerar();
    const id = await semear({ elementos: [7, 6, undefined, 5, 9, 7, 4] }); // q9 = Equilibrio emocional
    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(true);
    const { user, system } = await promptEnviado();
    expect(user).not.toContain("Equilíbrio emocional");
    expect(system).not.toContain("Equilíbrio emocional");
    expect(user).not.toContain("Entre os sete elementos avaliados");
    expect(user).toContain("6 de 7 respondidas");
    expect(user).toContain("sem resposta e não entram na conta");
    registrar("3_trecho_elementos", user.split("\n").filter((l) => /elemento|elementos/i.test(l) && !l.startsWith("- ")));
  });

  it("4a. violacao plantada na saida e NAO corrigida: recusada, nada gravado", async () => {
    await zerar();
    const id = await semear();
    const violando = prognosticoLimpo();
    violando.analise_geral += " Seu eixo dominante é claro e você age por impulso.";
    violando.areas_chave[1].risco = "O risco é a fragilidade do sono.";
    const aindaViolando = {
      correcoes: [
        { campo: "analise_geral", texto: "Continua dominante." },
        { campo: "areas_chave.1.risco", texto: "O risco é a fragilidade." },
      ],
    };
    await roteiro([violando, aindaViolando]);

    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(await contagem()).toBe(2); // 1 geracao + 1 correcao, nunca 3
    expect(await lerPrognostico(id)).toBeNull(); // nada em prognostics

    const { data: logs } = await db.from("event_logs").select("action,payload").eq("participant_id", id);
    const veto = (logs as any[]).find((l) => l.action === "prognostic_vetoed");
    expect(veto).toBeDefined();
    expect(JSON.stringify(veto.payload)).not.toContain("Continua dominante");
    expect((logs as any[]).some((l) => l.action === "prognostic_generated")).toBe(false);

    const reqs = (await canario("/__canario/contagem")).requisicoes;
    expect(reqs.map((x: any) => x.pedido_de_correcao)).toEqual([false, true]);
    expect(reqs[1].effort).toBe("low");
    expect(reqs[1].papeis).toEqual(["user", "assistant", "user"]);
    registrar("4a_resposta", { status: r.status, error: r.error, detail: r.detail });
    registrar("4a_chamadas", reqs);
    registrar("4a_event_log", veto);
    registrar("4a_prognostics_gravado", null);
  });

  it("4b. violacao plantada e corrigida: o documento gravado nao contem o texto vetado", async () => {
    await zerar();
    const id = await semear();
    const violando = prognosticoLimpo();
    violando.analise_geral += " Seu eixo dominante é claro.";
    await roteiro([
      violando,
      { correcoes: [{ campo: "analise_geral", texto: prognosticoLimpo().analise_geral }] },
    ]);
    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(true);
    expect(await contagem()).toBe(2);
    const gravado = await lerPrognostico(id);
    expect(gravado?.status).toBe("generated");
    expect(JSON.stringify(gravado?.raw_ai_output)).not.toContain("dominante");
    const { data: logs } = await db.from("event_logs").select("action,payload").eq("participant_id", id);
    const ok = (logs as any[]).find((l) => l.action === "prognostic_generated");
    expect(ok.payload.chamadas_modelo).toEqual({ completas: 1, correcoes: 1 });
    registrar("4b_chamadas_modelo", ok.payload);
  });

  it("4c. caminho limpo: uma chamada, documento gravado", async () => {
    await zerar();
    const id = await semear();
    const r = await generatePrognostic(id, eventId);
    expect(r.ok).toBe(true);
    expect(await contagem()).toBe(1);
    const gravado = await lerPrognostico(id);
    expect(gravado?.status).toBe("generated");
    const { data: logs } = await db.from("event_logs").select("action,payload").eq("participant_id", id);
    const ok = (logs as any[]).find((l) => l.action === "prognostic_generated");
    expect(ok.payload.chamadas_modelo).toEqual({ completas: 1, correcoes: 0 });
    registrar("4c_chamadas_modelo", ok.payload);
  });

  it("4d. resposta ilegivel numa pergunta pontuada: 422 e o modelo nem e chamado", async () => {
    await zerar();
    const id = await semear();
    const { data: linha } = await db.from("quiz_responses").select("id,answers").eq("participant_id", id).eq("stage_id", 103).single();
    const answers = { ...(linha as any).answers, q20: "talvez" };
    await db.from("quiz_responses").update({ answers } as never).eq("id", (linha as any).id);
    const r = await generatePrognostic(id, eventId);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await contagem()).toBe(0);
    registrar("4d_resposta", r);
  });

  it("4e. ACHADO: o prognostico sintetico do canario de tests/ (areas_chave[0].nome = 'Visão') e recusado pelo veto", async () => {
    // Copia fiel de PROGNOSTICO_SINTETICO em tests/seguranca-http/canario-anthropic.mjs.
    const legado = {
      analise_geral: "Prognóstico sintético do canário. Nenhum modelo foi chamado.",
      areas_chave: [{ nome: "Visão", diagnostico: "sintético", risco: "sintético", movimento: "sintético" }],
      plano_30_dias: [{ titulo: "Semana 1", objetivos: ["sintético"], acao: "sintético", resultado_esperado: "sintético" }],
      praticas: [{ nome: "Prática", descricao: "sintético" }],
      frase_ativacao: { frase: "sintético", contexto: "sintético", aplicacao: "sintético", pergunta_pratica: "sintético" },
      trilha_recomendada: "Exploração",
      justificativa_trilha: "sintético",
    };
    await zerar();
    const id = await semear();
    await roteiro([legado, legado]); // o canario legado devolve o mesmo corpo ao pedido de correcao
    const r = await generatePrognostic(id, eventId);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await lerPrognostico(id)).toBeNull();
    registrar("4e_canario_legado", { status: (r as any).status, detail: (r as any).detail });
  });

  it("5. travas da 015: in_review, reviewed e delivered nao sao regerados e nao chamam o modelo", async () => {
    await zerar();
    const resultados: Record<string, unknown> = {};
    for (const estado of ["in_review", "reviewed", "delivered"]) {
      const id = await semear(undefined, estado);
      const r = await generatePrognostic(id, eventId);
      expect(r).toMatchObject({ ok: false, status: 409 });
      const gravado = await lerPrognostico(id);
      expect(gravado?.status).toBe(estado);
      expect(gravado?.raw_ai_output).toEqual({ marcador: "documento-humano-original" });
      resultados[estado] = r;
    }
    expect(await contagem()).toBe(0);

    // e os estados regeraveis continuam regerando
    const idPendente = await semear(undefined, "pending");
    const r = await generatePrognostic(idPendente, eventId);
    expect(r.ok).toBe(true);
    expect(await contagem()).toBe(1);
    registrar("5_travas", resultados);
  });

  it("6a. nenhum host fora da maquina foi alcancado", () => {
    const externos = [...hostsAlcancados].filter((h) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
    expect(externos).toEqual([]);
    expect(hostsAlcancados.has(new URL(CANARIO!).host)).toBe(true); // o canario foi, de fato, usado
    expect([...hostsAlcancados].some((h) => h.includes("anthropic.com"))).toBe(false);
    registrar("6a_hosts_alcancados", [...hostsAlcancados]);
  });

  it("6. controle positivo: o contador do canario nao e cego", async () => {
    await zerar();
    expect(await contagem()).toBe(0);
    // chamada que NAO passa pelo gerador: se o contador estivesse cego, ficaria em 0
    const r = await fetch(`${CANARIO}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "controle-positivo", messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(await contagem()).toBe(1);
    registrar("6_controle_positivo", (await canario("/__canario/contagem")).requisicoes);
    await zerar();
  });
});
