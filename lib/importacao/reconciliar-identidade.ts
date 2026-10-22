// RECONCILIACAO DE IDENTIDADE DE UMA SUBMISSAO EXTERNA.
//
// A pergunta: esta submissao do Google Forms e de QUAL participante deste
// evento? Dela depende um documento que vai levar o nome de uma pessoa. Errar
// aqui e entregar o prognostico de A para B.
//
// DECISAO DO RESPONSAVEL TECNICO, cumprida por este arquivo:
//   "A reconciliacao de identidade e por e-mail verificado do Forms. Pessoa que
//    nao casar com ninguem fica PENDENTE para decisao humana -- nunca criada em
//    silencio, nunca descartada em silencio. Duas submissoes da mesma pessoa,
//    idem: conflito explicito."
//   "A importacao NAO PODE IMPERSONAR O PARTICIPANTE. Reconciliar identidade e
//    um ato do operador, registrado e reversivel, nao um efeito colateral de um
//    import."
//
// O QUE ESTE MODULO FAZ, E O QUE NAO FAZ
// --------------------------------------
// FAZ: casar e-mail verificado da submissao com `participants.email` do evento,
// e SO quando a correspondencia e UNICA nos dois sentidos (um e-mail, um
// participante, uma submissao).
//
// NAO FAZ, nunca: criar participante; casar por nome ("Joao Silva" e "joao
// silva" podem ser duas pessoas); casar por semelhanca de e-mail; escolher a
// submissao "mais completa" ou "mais recente" quando ha duas da mesma pessoa;
// casar submissao com e-mail NAO verificado (sem verificacao, o e-mail e so um
// texto que alguem digitou); descartar submissao que nao casou.
//
// TRES ESTADOS, e nenhum deles e silencio:
//   reconciliada  e-mail verificado, correspondencia unica. Segue.
//   pendente      nao deu para decidir. Fica esperando decisao HUMANA. Nao e
//                 recusa e nao e aprovacao: e "nao consegui verificar".
//   conflito      ha mais de um candidato de um dos lados. Exige decisao humana
//                 e nunca e resolvido por desempate automatico.
//
// NORMALIZACAO DE E-MAIL: apara espaco e passa para minuscula. O dominio e
// insensivel a caixa por norma; a parte local, na teoria, nao e, mas nenhum
// provedor usado por este publico diferencia, e `participants.email` do projeto
// ja e comparado assim. Esta e a UNICA normalizacao, e ela esta declarada: nada
// de remover ponto, nada de ignorar sufixo "+tag", nada de trocar dominio.
//
// Funcoes puras: sem I/O, sem data/hora, sem aleatoriedade.

export type EstadoDeIdentidade = "reconciliada" | "pendente" | "conflito";

export type MotivoPendente =
  /** A submissao nao trouxe e-mail. */
  | "email_ausente"
  /** Trouxe e-mail, mas o formulario nao confirmou que e da pessoa. */
  | "email_nao_verificado"
  /** E-mail verificado que nao e de nenhum participante do evento. */
  | "sem_correspondencia";

export type MotivoConflito =
  /** Duas (ou mais) submissoes com o mesmo e-mail verificado. */
  | "duas_submissoes_do_mesmo_email"
  /** O e-mail casa com mais de uma linha de `participants` do evento. */
  | "email_casa_com_mais_de_um_participante"
  /** O participante ja tem respostas canonicas gravadas por outra origem. */
  | "participante_ja_tem_respostas";

export interface SubmissaoExterna {
  /** Identificador da submissao NO formulario de origem. Unico por formulario. */
  submissao_id: string;
  /** E-mail como o formulario o entregou. */
  email: string | null;
  /** O formulario confirmou a posse deste e-mail? Nunca se presume `true`. */
  email_verificado: boolean;
  /** Nome que a pessoa declarou. Serve para o operador LER, nunca para casar. */
  nome_declarado?: string | null;
  /** Respostas cruas, chave = id da pergunta. */
  respostas: Readonly<Record<string, unknown>>;
}

export interface ParticipanteDoEvento {
  id: string;
  email: string;
  full_name: string;
  /** Quantas linhas de `quiz_responses` este participante ja tem. */
  respostas_existentes?: number;
}

export type ResultadoDeIdentidade =
  | {
      estado: "reconciliada";
      submissao_id: string;
      participant_id: string;
      /**
       * `null` e possivel e legitimo: o operador pode reconciliar uma submissao
       * que chegou SEM e-mail. Nesse caso `via` e "decisao_do_operador", e e
       * isso que a proveniencia registra.
       */
      email_normalizado: string | null;
      /** Como a identidade foi estabelecida. Vai para a proveniencia. */
      via: "email_verificado" | "decisao_do_operador";
    }
  | {
      estado: "pendente";
      submissao_id: string;
      motivo: MotivoPendente;
      email_normalizado: string | null;
      explicacao: string;
    }
  | {
      estado: "conflito";
      submissao_id: string;
      motivo: MotivoConflito;
      email_normalizado: string | null;
      /** As outras submissoes / participantes envolvidos. Nomeados, nao contados. */
      envolvidos: string[];
      explicacao: string;
    };

/** A unica normalizacao de e-mail deste modulo: trim + minuscula. */
export function normalizarEmail(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const e = bruto.trim().toLowerCase();
  return e === "" ? null : e;
}

/**
 * Reconcilia um LOTE de submissoes contra os participantes do evento.
 *
 * E lote, e nao uma por vez, de proposito: "duas submissoes da mesma pessoa" so
 * da para ver olhando o lote inteiro. Uma funcao que recebesse uma submissao
 * isolada reconciliaria as duas, cada uma convencida de estar certa, e a
 * segunda sobrescreveria a primeira sem ninguem saber.
 */
export function reconciliarLote(
  submissoes: readonly SubmissaoExterna[],
  participantes: readonly ParticipanteDoEvento[],
): ResultadoDeIdentidade[] {
  // Indice e-mail -> participantes. Lista, nao um: e-mail repetido e conflito.
  const porEmail = new Map<string, ParticipanteDoEvento[]>();
  for (const p of participantes) {
    const e = normalizarEmail(p.email);
    if (e === null) continue;
    const atual = porEmail.get(e);
    if (atual === undefined) porEmail.set(e, [p]);
    else atual.push(p);
  }

  // Quantas submissoes trazem cada e-mail VERIFICADO.
  const submissoesPorEmail = new Map<string, string[]>();
  for (const s of submissoes) {
    if (!s.email_verificado) continue;
    const e = normalizarEmail(s.email);
    if (e === null) continue;
    const atual = submissoesPorEmail.get(e);
    if (atual === undefined) submissoesPorEmail.set(e, [s.submissao_id]);
    else atual.push(s.submissao_id);
  }

  return submissoes.map((s) => {
    const email = normalizarEmail(s.email);

    if (email === null) {
      return {
        estado: "pendente" as const,
        submissao_id: s.submissao_id,
        motivo: "email_ausente" as const,
        email_normalizado: null,
        explicacao:
          "a submissao nao trouxe e-mail. Sem e-mail nao ha como reconciliar; so um operador pode dizer de quem e esta resposta",
      };
    }

    if (!s.email_verificado) {
      return {
        estado: "pendente" as const,
        submissao_id: s.submissao_id,
        motivo: "email_nao_verificado" as const,
        email_normalizado: email,
        explicacao: `o formulario nao confirmou a posse de ${email}. E-mail apenas digitado nao identifica ninguem`,
      };
    }

    const irmas = submissoesPorEmail.get(email) ?? [];
    if (irmas.length > 1) {
      return {
        estado: "conflito" as const,
        submissao_id: s.submissao_id,
        motivo: "duas_submissoes_do_mesmo_email" as const,
        email_normalizado: email,
        envolvidos: irmas,
        explicacao: `${irmas.length} submissoes trazem o mesmo e-mail verificado ${email} (${irmas.join(", ")}). Escolher uma delas automaticamente descartaria a outra em silencio`,
      };
    }

    const candidatos = porEmail.get(email) ?? [];
    if (candidatos.length === 0) {
      return {
        estado: "pendente" as const,
        submissao_id: s.submissao_id,
        motivo: "sem_correspondencia" as const,
        email_normalizado: email,
        explicacao: `${email} nao e o e-mail de nenhum participante deste evento. Nao se cria participante a partir de um import: um operador decide se e alguem novo, um e-mail trocado, ou alguem de outro evento`,
      };
    }
    if (candidatos.length > 1) {
      return {
        estado: "conflito" as const,
        submissao_id: s.submissao_id,
        motivo: "email_casa_com_mais_de_um_participante" as const,
        email_normalizado: email,
        envolvidos: candidatos.map((p) => p.id),
        explicacao: `${email} casa com ${candidatos.length} participantes deste evento (${candidatos.map((p) => p.id).join(", ")}). O cadastro esta ambiguo e so um operador resolve`,
      };
    }

    const p = candidatos[0];
    if ((p.respostas_existentes ?? 0) > 0) {
      return {
        estado: "conflito" as const,
        submissao_id: s.submissao_id,
        motivo: "participante_ja_tem_respostas" as const,
        email_normalizado: email,
        envolvidos: [p.id],
        explicacao: `o participante ${p.id} (${p.full_name}) ja tem ${p.respostas_existentes} etapa(s) de resposta gravada(s). Importar por cima apagaria resposta ja existente: so um operador decide qual vale`,
      };
    }

    return {
      estado: "reconciliada" as const,
      submissao_id: s.submissao_id,
      participant_id: p.id,
      email_normalizado: email,
      via: "email_verificado" as const,
    };
  });
}

/**
 * DECISAO DO OPERADOR sobre uma submissao pendente ou em conflito.
 *
 * E o unico caminho pelo qual uma submissao que o e-mail nao resolveu pode
 * virar `reconciliada`, e ele exige um operador NOMEADO. Nao e um desempate
 * automatico disfarcado: a funcao nao escolhe participante, ela registra a
 * escolha de alguem.
 *
 * A reversibilidade nao esta aqui: esta no banco (migration 022), onde cada
 * decisao e uma linha de `external_submission_events` que pode ser revogada
 * sem apagar a anterior. Esta funcao so valida a decisao antes de registra-la.
 */
export function aplicarDecisaoDoOperador(
  anterior: ResultadoDeIdentidade,
  decisao: {
    participant_id: string;
    operador_id: string;
    justificativa: string;
  },
): { ok: true; resultado: ResultadoDeIdentidade } | { ok: false; motivo: string } {
  if (anterior.estado === "reconciliada") {
    return {
      ok: false,
      motivo: `a submissao ${anterior.submissao_id} ja esta reconciliada com ${anterior.participant_id}; para trocar, revogue a reconciliacao primeiro`,
    };
  }
  if (decisao.participant_id.trim() === "") {
    return { ok: false, motivo: "decisao sem participante" };
  }
  if (decisao.operador_id.trim() === "") {
    // Sem operador nomeado isto seria exatamente o efeito colateral de import
    // que a regra 5 proibe.
    return { ok: false, motivo: "decisao sem operador responsavel" };
  }
  if (decisao.justificativa.trim().length < 3) {
    return { ok: false, motivo: "decisao sem justificativa registrada" };
  }
  return {
    ok: true,
    resultado: {
      estado: "reconciliada",
      submissao_id: anterior.submissao_id,
      participant_id: decisao.participant_id,
      email_normalizado: anterior.email_normalizado,
      via: "decisao_do_operador",
    },
  };
}
