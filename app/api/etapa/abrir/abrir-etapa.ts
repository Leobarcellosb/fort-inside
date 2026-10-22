import {
  faseDaJanela,
  janelaDeIso,
  type MotivoDeRecusa,
  type RespostaDeAbertura,
} from "../../../../components/features/participant/janela-da-etapa";

// REGISTRA A ABERTURA DA ETAPA (participant_stage_sessions, migration 010).
//
// QUEM DECIDE E O BANCO. Este codigo roda com a sessao do PROPRIO participante
// (nunca service_role): a policy `participant_stage_sessions_own_open` valida
// dono, evento, versao do quiz e janela, e `started_at` nasce do relogio do
// banco -- o corpo da requisicao nao tem como informa-lo (e nem existe grant de
// coluna para isso). A checagem de fase feita aqui so evita uma ida ao banco
// quando a resposta e certa, e permite devolver um MOTIVO legivel; se ela e a
// policy divergirem, vale a policy, e a recusa dela vira motivo, nunca erro cru.
//
// IDEMPOTENTE: chamar de novo devolve o registro existente (mesmo started_at).
// Repetir nao renova prazo -- o indice unico (participante, evento, etapa)
// garante no banco, e aqui nem se tenta inserir quando o registro ja existe.
//
// MODO LIVE: nao cria nada. No live a sessao e opcional e o envio nao olha para
// ela (010, secao 6); criar seria so um caminho a mais.

interface ErroDoBanco {
  code?: string;
  message?: string;
}

interface Consulta extends PromiseLike<{ data: unknown; error: ErroDoBanco | null }> {
  eq(coluna: string, valor: string | number): Consulta;
  maybeSingle(): PromiseLike<{ data: unknown; error: ErroDoBanco | null }>;
}

export interface ClienteDeAbertura {
  from(tabela: string): {
    select(colunas: string): Consulta;
    insert(valores: Record<string, unknown>): PromiseLike<{ error: ErroDoBanco | null }>;
  };
}

export type ResultadoDaAbertura =
  | { tipo: "ok"; resposta: RespostaDeAbertura }
  | { tipo: "nao_autorizado" }
  | { tipo: "nao_encontrado" }
  | { tipo: "erro"; causa: unknown };

interface Entrada {
  userId: string;
  participantId: string;
  numeroDaEtapa: number;
  /** Relogio do servidor da aplicacao. Injetavel para teste. */
  agora?: () => number;
}

interface LinhaDeSessao {
  stage_id: number;
  started_at: string;
  status: "open" | "submitted";
}

export async function abrirEtapa(
  supabase: ClienteDeAbertura,
  { userId, participantId, numeroDaEtapa, agora = Date.now }: Entrada,
): Promise<ResultadoDaAbertura> {
  try {
    const p = (await supabase
      .from("participants")
      .select("id, user_id, event_id")
      .eq("id", participantId)
      .maybeSingle()) as {
      data: { id: string; user_id: string | null; event_id: string } | null;
      error: ErroDoBanco | null;
    };
    if (p.error) return { tipo: "erro", causa: p.error };
    // Mesma resposta para "nao existe" e "e de outra pessoa": nao vira oraculo de ids.
    if (!p.data || p.data.user_id !== userId) return { tipo: "nao_autorizado" };
    const eventId = p.data.event_id;

    const ev = (await supabase
      .from("events")
      .select("id, mode, quiz_version, form_opens_at, form_closes_at")
      .eq("id", eventId)
      .maybeSingle()) as {
      data: {
        id: string;
        mode: "live" | "async";
        quiz_version: number;
        form_opens_at: string | null;
        form_closes_at: string | null;
      } | null;
      error: ErroDoBanco | null;
    };
    if (ev.error) return { tipo: "erro", causa: ev.error };
    if (!ev.data) return { tipo: "nao_encontrado" };
    const evento = ev.data;

    const et = (await supabase
      .from("quiz_stages")
      .select("id, stage_number")
      .eq("quiz_version", evento.quiz_version)) as unknown as {
      data: { id: number; stage_number: number | null }[] | null;
      error: ErroDoBanco | null;
    };
    if (et.error || !et.data) return { tipo: "erro", causa: et.error };
    const etapa = et.data.find((s) => s.stage_number === numeroDaEtapa);
    if (!etapa) return { tipo: "nao_encontrado" };
    const numeroPorId = new Map(et.data.map((s) => [s.id, s.stage_number as number]));

    const lerSessoes = async (): Promise<LinhaDeSessao[] | ErroDoBanco> => {
      const r = (await supabase
        .from("participant_stage_sessions")
        .select("stage_id, started_at, status")
        .eq("participant_id", participantId)
        .eq("event_id", eventId)) as unknown as {
        data: LinhaDeSessao[] | null;
        error: ErroDoBanco | null;
      };
      return r.error || !r.data ? (r.error ?? {}) : r.data;
    };

    const monta = (
      sessoes: LinhaDeSessao[],
      extra: { recemCriada: boolean; motivo: MotivoDeRecusa | null },
    ): RespostaDeAbertura => {
      const desta = sessoes.find((s) => s.stage_id === etapa.id) ?? null;
      return {
        modo: evento.mode,
        agora: new Date(agora()).toISOString(),
        janela:
          evento.mode === "async"
            ? { abre: evento.form_opens_at, fecha: evento.form_closes_at }
            : null,
        total_etapas: et.data!.length,
        etapas_iniciadas: sessoes
          .map((s) => numeroPorId.get(s.stage_id))
          .filter((n): n is number => typeof n === "number")
          .sort((a, b) => a - b),
        sessao: desta ? { iniciada_em: desta.started_at, status: desta.status } : null,
        recem_criada: extra.recemCriada,
        motivo_recusa: desta ? null : extra.motivo,
      };
    };

    const sessoes = await lerSessoes();
    if (!Array.isArray(sessoes)) return { tipo: "erro", causa: sessoes };

    if (evento.mode === "live") {
      return { tipo: "ok", resposta: monta(sessoes, { recemCriada: false, motivo: null }) };
    }

    // Ja existe: devolve o MESMO registro. Nao tenta inserir (nao renova nada).
    if (sessoes.some((s) => s.stage_id === etapa.id)) {
      return { tipo: "ok", resposta: monta(sessoes, { recemCriada: false, motivo: null }) };
    }

    const janela = janelaDeIso(evento.form_opens_at, evento.form_closes_at);
    const fase = faseDaJanela(agora(), janela, false);
    if (fase !== "aberta") {
      const motivo: MotivoDeRecusa =
        fase === "ainda_nao_abriu" || fase === "encerrada" ? fase : "nao_inicia_mais";
      return { tipo: "ok", resposta: monta(sessoes, { recemCriada: false, motivo }) };
    }

    const ins = await supabase.from("participant_stage_sessions").insert({
      event_id: eventId,
      participant_id: participantId,
      stage_id: etapa.id,
      quiz_version: evento.quiz_version,
    });

    let recemCriada = true;
    if (ins.error) {
      if (ins.error.code === "23505") {
        // Corrida: outra aba/requisicao criou entre a leitura e a escrita. E o
        // resultado desejado, so nao foi esta chamada que o produziu.
        recemCriada = false;
      } else if (ins.error.code === "42501") {
        // O banco recusou onde o relogio desta maquina achava que cabia: borda
        // da janela. Vale o banco; vira motivo, nunca erro cru.
        const depois = faseDaJanela(agora(), janela, false);
        const motivo: MotivoDeRecusa =
          depois === "aberta" ? "nao_inicia_mais" : depois === "ainda_nao_abriu" || depois === "encerrada" ? depois : "nao_inicia_mais";
        console.warn("[etapa/abrir] banco recusou a abertura", { code: "42501", fase_local: depois });
        return { tipo: "ok", resposta: monta(sessoes, { recemCriada: false, motivo }) };
      } else {
        return { tipo: "erro", causa: ins.error };
      }
    }

    const depois = await lerSessoes();
    if (!Array.isArray(depois)) return { tipo: "erro", causa: depois };
    return { tipo: "ok", resposta: monta(depois, { recemCriada, motivo: "indisponivel" }) };
  } catch (causa) {
    return { tipo: "erro", causa };
  }
}
