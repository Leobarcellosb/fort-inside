// Situação do prognóstico de cada pessoa, para o painel do host.
//
// A distinção que este arquivo existe para sustentar:
//
//   ESTADO DO DOCUMENTO          != RESULTADO DO ÚLTIMO PROCESSAMENTO
//   prognostics.status (015)        jobs.status (018), ou o lote desta sessão
//   pending > generating >          na fila / gerando / gerado / pulado /
//   generated > in_review >         falhou / cancelado
//   reviewed > delivered
//   nunca regride                   muda o tempo todo
//
// "Pulado" é um RESULTADO de uma tentativa, não um estado do documento. Um
// documento entregue pode ter sido corretamente pulado numa rodada posterior:
// hoje ele está "entregue" (estado) e a última rodada o "pulou" (resultado). As
// duas coisas são verdadeiras ao mesmo tempo e nenhuma delas é erro.
//
// REVISÃO CORRENTE
// O estado que o painel mostra é o da revisão CORRENTE do documento. Versões
// anteriores são histórico: não competem pelo estado atual. Nunca se escolhe "o
// maior estado já alcançado": um documento antigo entregue não pode mascarar uma
// versão nova em revisão.
//
// Hoje a tabela `prognostics` tem UNIQUE (participant_id) e nenhuma coluna que
// identifique revisão (número, `is_current`, `superseded_by`...). Logo existe, no
// máximo, UMA linha por pessoa e ela é, por construção, a corrente. Se algum dia
// aparecerem duas linhas para a mesma pessoa, o painel NÃO tem como saber qual é a
// corrente: em vez de inventar uma heurística (maior estado, mais recente...), ele
// diz que há mais de uma versão e não afirma estado nenhum. Ver `documentoCorrente`.
//
// Tudo aqui é função pura (sem rede, sem React) para poder ser provada em teste.

// ---------------------------------------------------------------------------
// Estado do documento
// ---------------------------------------------------------------------------

export type EstadoDocumento =
  | "pending"
  | "generating"
  | "generated"
  | "in_review"
  | "reviewed"
  | "delivered"
  | "suspended";

/**
 * A ordem dos SEIS primeiros é a do gatilho da migration 015. Posição maior =
 * mais avançado.
 *
 * `suspended` (migration 027) fica no fim desta lista e NÃO está no vetor de
 * ordem da 015 -- é justamente por estar fora dele que
 * `delivered -> suspended -> reviewed -> delivered` existe sem abrir nenhuma
 * regressão entre os seis. Então esta posição NÃO afirma "mais avançado que
 * entregue": ela existe porque este vetor é usado para UMA pergunta só
 * (`documentoTemConteudo`: índice >= `generated`), e um documento suspenso tem
 * conteúdo -- ele esteve entregue. Nada aqui compara posições para decidir
 * transição; quem decide transição é o banco.
 */
export const ORDEM_DOCUMENTO: readonly EstadoDocumento[] = [
  "pending",
  "generating",
  "generated",
  "in_review",
  "reviewed",
  "delivered",
  "suspended",
];

/**
 * Estados com trabalho humano em cima: gerar de novo é recusado pelo sistema.
 *
 * `suspended` entra: regerar um documento que já foi lido e tirado do ar
 * apagaria a edição humana e a razão de ele ter saído do ar. (A recusa de verdade
 * é de `lib/ai/generate-prognostic.ts`, que trabalha com lista de estados
 * REGERÁVEIS -- `pending`, `generating`, `generated` --, então `suspended` já era
 * recusado lá antes desta linha existir. Aqui é o painel dizendo o mesmo fato.)
 */
const PROTEGIDOS: readonly EstadoDocumento[] = [
  "in_review",
  "reviewed",
  "delivered",
  "suspended",
];

export const ROTULO_DOCUMENTO: Record<EstadoDocumento, string> = {
  pending: "Aguardando geração",
  generating: "Sendo gerado",
  generated: "Gerado, aguardando revisão",
  in_review: "Em revisão",
  reviewed: "Revisado",
  delivered: "Entregue",
  // O rótulo fala do ponto de vista de quem lia o documento, não do banco:
  // "suspenso" é o nome da coluna, "fora do ar" é o fato.
  suspended: "Fora do ar, aguardando correção",
};

export function ehEstadoDocumento(v: unknown): v is EstadoDocumento {
  return typeof v === "string" && (ORDEM_DOCUMENTO as readonly string[]).includes(v);
}

export function documentoProtegido(estado: EstadoDocumento | null): boolean {
  return estado !== null && PROTEGIDOS.includes(estado);
}

/** O documento já tem texto gerado (generated em diante)? */
export function documentoTemConteudo(estado: EstadoDocumento | null): boolean {
  return estado !== null && ORDEM_DOCUMENTO.indexOf(estado) >= ORDEM_DOCUMENTO.indexOf("generated");
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

export interface PessoaBase {
  id: string;
  nome: string;
  quizConcluido: boolean;
}

export interface LinhaDocumento {
  participant_id: string;
  status: string;
  generated_at: string | null;
}

/** Subconjunto das colunas de `jobs` que /api/jobs/status devolve. */
export interface LinhaJob {
  id: string;
  participant_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  last_error_code: string | null;
  result: unknown;
  finished_at: string | null;
  updated_at: string;
}

/**
 * Resultado de uma rodada do lote antigo (/api/batch-process), identificado por
 * pessoa pela própria tela. O lote não grava registro por pessoa: só existe
 * enquanto esta tela ficou aberta. `em` é o instante em que a rodada terminou.
 */
export interface ResultadoLote {
  resultado: "gerado" | "pulado" | "falhou";
  /** Estado do documento ANTES da rodada, quando pulado. */
  estadoAntes: string | null;
  em: string;
}

// ---------------------------------------------------------------------------
// Resultado do último processamento
// ---------------------------------------------------------------------------

export type ResultadoProcessamento =
  | "gerado"
  | "pulado"
  | "falhou"
  | "nova_tentativa"
  | "na_fila"
  | "gerando"
  | "cancelado"
  | "nunca";

export const ROTULO_PROCESSAMENTO: Record<ResultadoProcessamento, string> = {
  gerado: "Gerado",
  pulado: "Pulado, preservado",
  falhou: "Falhou",
  nova_tentativa: "Vai tentar de novo",
  na_fila: "Na fila",
  gerando: "Gerando agora",
  cancelado: "Cancelado",
  nunca: "Ainda não processado",
};

/** Documento que existe sem nenhum registro de processamento (rodada antiga). */
export const ROTULO_SEM_REGISTRO = "Sem registro";

export interface Processamento {
  resultado: ResultadoProcessamento;
  rotulo: string;
  /** De onde veio a informação. 'nenhuma' = nunca foi processado. */
  fonte: "fila" | "lote" | "nenhuma";
  /** Explicação em português claro do que o resultado significa. */
  motivo: string | null;
  /** Soma das tentativas já iniciadas; null quando a fonte não registra. */
  tentativas: number | null;
  tentativasMax: number | null;
  /** Mensagem em português do que deu errado; null se não deu. */
  erro: string | null;
  /** Texto técnico original, para quem precisar mostrar à equipe. */
  detalheTecnico: string | null;
  quando: string | null;
  jobId: string | null;
}

const ROTULO_ESTADO_NO_PULO: Record<string, string> = {
  in_review: "em revisão",
  reviewed: "revisado",
  delivered: "entregue",
};

/** Traduz o código gravado em `last_error_code` para uma frase que o host entende. */
export function explicarErro(codigo: string | null, textoOriginal: string | null): string {
  switch (codigo) {
    case "http_404":
      return "Não encontramos este participante ou as respostas dele para gerar o direcionamento.";
    case "http_400":
      return "As respostas do questionário desta pessoa estão incompletas, então não dá para gerar o direcionamento.";
    case "http_502":
      return "A inteligência artificial recusou ou não respondeu.";
    case "http_500":
      return "A resposta da inteligência artificial veio inválida ou não foi possível salvar.";
    case "lease_expirado":
    case "lease_perdido":
      return "A geração demorou demais e foi interrompida.";
    case "excecao":
      return "Aconteceu um erro inesperado durante a geração.";
    case "gravacao_do_desfecho":
      return "A geração terminou, mas não foi possível registrar o resultado.";
    default:
      return textoOriginal
        ? "A geração não foi concluída."
        : "A geração não foi concluída e nenhum motivo foi informado.";
  }
}

function motivoDoPulo(estadoNoPulo: string | null): string {
  const quando = estadoNoPulo ? ROTULO_ESTADO_NO_PULO[estadoNoPulo] : null;
  return quando
    ? `O documento já estava ${quando} quando foi processado. Foi preservado de propósito: nada foi regerado nem sobrescrito. Não precisa fazer nada.`
    : "O documento já estava em revisão, revisado ou entregue quando foi processado. Foi preservado de propósito: nada foi regerado nem sobrescrito. Não precisa fazer nada.";
}

/** Lê o estado citado no texto do 409 ("... já está em \"delivered\" ..."). */
function estadoCitado(texto: string | null): string | null {
  if (!texto) return null;
  const m = /"(in_review|reviewed|delivered)"/.exec(texto);
  return m ? m[1] : null;
}

function motivoGravado(result: unknown): string | null {
  if (result && typeof result === "object" && "motivo" in result) {
    const m = (result as { motivo: unknown }).motivo;
    return typeof m === "string" ? m : null;
  }
  return null;
}

function aPartirDeJobs(linhas: LinhaJob[]): Processamento {
  // Mais recente primeiro. A tabela tem UNIQUE (kind, participant_id), então hoje
  // existe um só; se algum dia vierem dois, o último manda no RESULTADO e as
  // tentativas SOMAM (cada uma foi uma chamada de verdade), mas a pessoa continua
  // sendo uma só.
  const ordenadas = [...linhas].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const ultima = ordenadas[0];
  const tentativas = linhas.reduce((s, l) => s + (Number.isFinite(l.attempts) ? l.attempts : 0), 0);
  const base = {
    fonte: "fila" as const,
    tentativas,
    tentativasMax: ultima.max_attempts,
    quando: ultima.finished_at ?? ultima.updated_at,
    jobId: ultima.id,
  };

  switch (ultima.status) {
    case "succeeded":
      return {
        ...base,
        resultado: "gerado",
        rotulo: ROTULO_PROCESSAMENTO.gerado,
        motivo: "O direcionamento foi gerado nesta rodada.",
        erro: null,
        detalheTecnico: null,
      };
    case "skipped": {
      const tecnico = motivoGravado(ultima.result);
      return {
        ...base,
        resultado: "pulado",
        rotulo: ROTULO_PROCESSAMENTO.pulado,
        motivo: motivoDoPulo(estadoCitado(tecnico)),
        erro: null,
        detalheTecnico: tecnico,
      };
    }
    case "failed":
      return {
        ...base,
        resultado: "falhou",
        rotulo: ROTULO_PROCESSAMENTO.falhou,
        motivo: "A geração não aconteceu e as tentativas acabaram.",
        erro: explicarErro(ultima.last_error_code, ultima.last_error),
        detalheTecnico: ultima.last_error,
      };
    case "running":
      return {
        ...base,
        resultado: "gerando",
        rotulo: ROTULO_PROCESSAMENTO.gerando,
        motivo: "A geração está acontecendo agora. Leva cerca de 1 minuto.",
        erro: null,
        detalheTecnico: null,
      };
    case "pending":
      // Pendente COM erro gravado = a tentativa anterior falhou e sobrou
      // retentativa. Não é falha final; é o sistema tentando de novo sozinho.
      if (ultima.last_error || ultima.last_error_code) {
        return {
          ...base,
          resultado: "nova_tentativa",
          rotulo: ROTULO_PROCESSAMENTO.nova_tentativa,
          motivo: "A última tentativa não deu certo. O sistema vai tentar de novo sozinho.",
          erro: explicarErro(ultima.last_error_code, ultima.last_error),
          detalheTecnico: ultima.last_error,
        };
      }
      return {
        ...base,
        resultado: "na_fila",
        rotulo: ROTULO_PROCESSAMENTO.na_fila,
        motivo: "Está esperando a vez para ser gerado.",
        erro: null,
        detalheTecnico: null,
      };
    case "canceled":
      return {
        ...base,
        resultado: "cancelado",
        rotulo: ROTULO_PROCESSAMENTO.cancelado,
        motivo: "O processamento foi cancelado pela equipe. Nada foi gerado nesta rodada.",
        erro: null,
        detalheTecnico: null,
      };
    default:
      return semRegistro();
  }
}

function aPartirDoLote(l: ResultadoLote): Processamento {
  const base = {
    fonte: "lote" as const,
    // O lote não registra quantas vezes tentou por pessoa.
    tentativas: null,
    tentativasMax: null,
    quando: l.em,
    jobId: null,
  };
  if (l.resultado === "gerado") {
    return {
      ...base,
      resultado: "gerado",
      rotulo: ROTULO_PROCESSAMENTO.gerado,
      motivo: "O direcionamento foi gerado nesta rodada.",
      erro: null,
      detalheTecnico: null,
    };
  }
  if (l.resultado === "pulado") {
    return {
      ...base,
      resultado: "pulado",
      rotulo: ROTULO_PROCESSAMENTO.pulado,
      motivo: motivoDoPulo(l.estadoAntes),
      erro: null,
      detalheTecnico: null,
    };
  }
  return {
    ...base,
    resultado: "falhou",
    rotulo: ROTULO_PROCESSAMENTO.falhou,
    motivo: "A geração não aconteceu nesta rodada.",
    erro: "O processamento em lote não informa o motivo de cada falha.",
    detalheTecnico: null,
  };
}

function semRegistro(): Processamento {
  return {
    resultado: "nunca",
    rotulo: ROTULO_PROCESSAMENTO.nunca,
    fonte: "nenhuma",
    motivo: null,
    tentativas: null,
    tentativasMax: null,
    erro: null,
    detalheTecnico: null,
    quando: null,
    jobId: null,
  };
}

// ---------------------------------------------------------------------------
// Grupos e retentativa
// ---------------------------------------------------------------------------

export type GrupoId =
  | "indeterminado"
  | "atencao"
  | "andamento"
  | "aguardando"
  | "pulados"
  | "prontos"
  | "quiz_aberto";

/** Ordem de leitura: o que exige ação primeiro, o que está tudo bem por último. */
export const ORDEM_GRUPOS: readonly GrupoId[] = [
  "indeterminado",
  "atencao",
  "andamento",
  "aguardando",
  "pulados",
  "prontos",
  "quiz_aberto",
];

export type Retentativa =
  | {
      /** Recoloca o job existente na fila (/api/jobs/operacao, sem `forcar`). */
      tipo: "fila";
      jobId: string;
    }
  | {
      /** Sem registro na fila (veio do lote): gera só esta pessoa. */
      tipo: "direta";
    };

export interface SituacaoPessoa {
  id: string;
  nome: string;
  grupo: GrupoId;
  /** Estado da revisão CORRENTE. null = ainda não existe documento (ou não dá para saber). */
  documento: EstadoDocumento | null;
  documentoRotulo: string;
  /** Quantas linhas de documento existem para a pessoa. Mais de 1 = revisão corrente indeterminável hoje. */
  versoesDoDocumento: number;
  processamento: Processamento;
  /** Aviso discreto (não é erro) para quando as duas informações parecem se contradizer. */
  aviso: string | null;
  /** Quando a retentativa é legítima. null = não oferecer. */
  retentativa: Retentativa | null;
  /** Por que NÃO há retentativa, quando a ausência merece explicação. */
  semRetentativa: string | null;
}

/**
 * Revisão corrente do documento.
 *
 * - nenhuma linha: ainda não existe documento;
 * - uma linha: é a corrente (e é o único caso possível hoje: UNIQUE em
 *   participant_id);
 * - mais de uma: o banco não diz qual é a corrente. NÃO escolhemos por maior estado
 *   nem por data (foi uma heurística plausível assim que mascararia uma versão nova
 *   em revisão atrás de uma antiga entregue). Devolvemos `ambiguo` e nenhum estado.
 */
export function documentoCorrente(linhas: LinhaDocumento[]): {
  estado: EstadoDocumento | null;
  versoes: number;
  ambiguo: boolean;
} {
  const validas = linhas.filter((l) => ehEstadoDocumento(l.status));
  if (validas.length === 0) return { estado: null, versoes: linhas.length, ambiguo: false };
  if (validas.length === 1) return { estado: validas[0].status as EstadoDocumento, versoes: linhas.length, ambiguo: false };
  return { estado: null, versoes: linhas.length, ambiguo: true };
}

function agrupar<T extends { participant_id: string }>(linhas: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const l of linhas) {
    const lista = m.get(l.participant_id);
    if (lista) lista.push(l);
    else m.set(l.participant_id, [l]);
  }
  return m;
}

export function montarSituacao(entrada: {
  pessoas: PessoaBase[];
  documentos: LinhaDocumento[];
  jobs: LinhaJob[];
  lote?: Map<string, ResultadoLote>;
}): SituacaoPessoa[] {
  const docsPorPessoa = agrupar(entrada.documentos);
  const jobsPorPessoa = agrupar(entrada.jobs);

  return entrada.pessoas.map((pessoa): SituacaoPessoa => {
    const corrente = documentoCorrente(docsPorPessoa.get(pessoa.id) ?? []);
    const documento = corrente.estado;
    const jobs = jobsPorPessoa.get(pessoa.id) ?? [];
    const lote = entrada.lote?.get(pessoa.id);

    // Fonte do "último processamento": a mais recente entre a fila e a rodada do
    // lote feita nesta sessão.
    let processamento = semRegistro();
    if (jobs.length > 0) {
      processamento = aPartirDeJobs(jobs);
      const maisRecenteDoJob = [...jobs].map((j) => j.updated_at).sort().at(-1) ?? "";
      if (lote && lote.em > maisRecenteDoJob) processamento = aPartirDoLote(lote);
    } else if (lote) {
      processamento = aPartirDoLote(lote);
    }

    // Documento que existe sem registro de rodada não é "não processado": alguém o
    // gerou, só não ficou guardado quem nem quando.
    if (processamento.resultado === "nunca" && documentoTemConteudo(documento) && pessoa.quizConcluido) {
      processamento = {
        ...processamento,
        rotulo: ROTULO_SEM_REGISTRO,
        motivo:
          "O direcionamento existe, mas veio de um processamento que não guardou o registro por pessoa. O estado do documento ao lado é o que vale.",
      };
    }

    const protegido = documentoProtegido(documento);
    const temConteudo = documentoTemConteudo(documento);
    const r = processamento.resultado;

    let grupo: GrupoId;
    let aviso: string | null = null;

    if (!pessoa.quizConcluido) {
      grupo = "quiz_aberto";
    } else if (corrente.ambiguo) {
      // Não sabemos qual versão é a corrente: não classificamos, não oferecemos ação.
      grupo = "indeterminado";
      aviso =
        "Existe mais de uma versão deste documento e o sistema ainda não marca qual é a atual. Por isso não mostramos um estado que poderia estar errado. Confira na tela de revisão.";
    } else if (r === "na_fila" || r === "gerando" || r === "nova_tentativa") {
      grupo = "andamento";
    } else if (r === "falhou" || r === "cancelado") {
      if (temConteudo) {
        grupo = "prontos";
        aviso =
          r === "falhou"
            ? "A última tentativa falhou, mas o direcionamento já existia e foi mantido como está."
            : "A última tentativa foi cancelada, mas o direcionamento já existia e foi mantido como está.";
      } else {
        grupo = "atencao";
      }
    } else if (r === "pulado") {
      grupo = "pulados";
    } else if (r === "gerado") {
      if (temConteudo) {
        grupo = "prontos";
      } else {
        // O registro diz que gerou, mas não achamos o documento. Não esconder.
        grupo = "atencao";
        aviso = "O registro diz que foi gerado, mas o documento não foi encontrado.";
      }
    } else {
      // Nunca processado nesta fonte. Se já existe documento, veio de rodada
      // anterior que não deixou registro por pessoa.
      grupo = temConteudo ? "prontos" : "aguardando";
    }

    // Retentativa: só onde ela pode mudar alguma coisa.
    let retentativa: Retentativa | null = null;
    let semRetentativa: string | null = null;
    const tentavel = r === "falhou" || r === "cancelado";

    if (corrente.ambiguo) {
      // sem retentativa: não sabemos o que seria sobrescrito.
    } else if (tentavel && protegido && documento) {
      semRetentativa = `O documento já está ${ROTULO_ESTADO_NO_PULO[documento]}. Gerar de novo não é permitido, para não apagar o trabalho da revisão. Não há o que refazer aqui.`;
    } else if (tentavel && processamento.jobId) {
      retentativa = { tipo: "fila", jobId: processamento.jobId };
    } else if (r === "falhou" && processamento.fonte === "lote") {
      retentativa = { tipo: "direta" };
    }

    return {
      id: pessoa.id,
      nome: pessoa.nome,
      grupo,
      documento,
      documentoRotulo: corrente.ambiguo
        ? "Mais de uma versão"
        : documento
          ? ROTULO_DOCUMENTO[documento]
          : "Ainda não existe",
      versoesDoDocumento: corrente.versoes,
      processamento,
      aviso,
      retentativa,
      semRetentativa,
    };
  });
}

export function contarPorGrupo(situacoes: SituacaoPessoa[]): Record<GrupoId, number> {
  const c: Record<GrupoId, number> = {
    atencao: 0,
    andamento: 0,
    aguardando: 0,
    pulados: 0,
    prontos: 0,
    quiz_aberto: 0,
    indeterminado: 0,
  };
  for (const s of situacoes) c[s.grupo]++;
  return c;
}

// ---------------------------------------------------------------------------
// Textos dos grupos
// ---------------------------------------------------------------------------

export interface TextoGrupo {
  titulo: (n: number) => string;
  explicacao: string;
}

export const TEXTO_GRUPO: Record<GrupoId, TextoGrupo> = {
  indeterminado: {
    titulo: (n) => (n === 1 ? "1 pessoa com mais de uma versão do documento" : `${n} pessoas com mais de uma versão do documento`),
    explicacao:
      "O sistema ainda não marca qual versão é a atual, então não mostramos um estado que poderia estar errado. Confira na tela de revisão.",
  },
  atencao: {
    titulo: (n) => (n === 1 ? "1 pessoa sem direcionamento" : `${n} pessoas sem direcionamento`),
    explicacao:
      "A geração falhou e o documento ainda não existe. É o único grupo que precisa de ação.",
  },
  andamento: {
    titulo: (n) => (n === 1 ? "1 pessoa em andamento" : `${n} pessoas em andamento`),
    explicacao: "Na fila, sendo geradas agora ou esperando uma nova tentativa. Esta tela se atualiza sozinha.",
  },
  aguardando: {
    titulo: (n) => (n === 1 ? "1 pessoa aguardando processamento" : `${n} pessoas aguardando processamento`),
    explicacao: "Concluíram o questionário, mas o direcionamento ainda não foi gerado.",
  },
  pulados: {
    titulo: (n) => (n === 1 ? "1 pessoa preservada (pulada)" : `${n} pessoas preservadas (puladas)`),
    explicacao:
      "O documento já estava em revisão, revisado ou entregue, então o sistema não mexeu nele de propósito. Isto não é erro.",
  },
  prontos: {
    titulo: (n) => (n === 1 ? "1 pessoa com direcionamento pronto" : `${n} pessoas com direcionamento pronto`),
    explicacao: "O documento existe e está seguro.",
  },
  quiz_aberto: {
    titulo: (n) => (n === 1 ? "1 pessoa ainda no quiz" : `${n} pessoas ainda no quiz`),
    explicacao: "Ainda não concluíram, por isso não entram no processamento.",
  },
};

/** Resumo de uma linha para o topo: mostra se o número fecha. */
export function resumoDaTurma(situacoes: SituacaoPessoa[]): string {
  const c = contarPorGrupo(situacoes);
  const concluidos = situacoes.length - c.quiz_aberto;
  const comDocumento = c.prontos + c.pulados;
  const partes = [`${comDocumento} de ${concluidos} com direcionamento`];
  if (c.indeterminado > 0) partes.push(`${c.indeterminado} com mais de uma versão`);
  if (c.andamento > 0) partes.push(`${c.andamento} em andamento`);
  if (c.aguardando > 0) partes.push(`${c.aguardando} aguardando`);
  if (c.atencao > 0) partes.push(`${c.atencao} ${c.atencao === 1 ? "precisa" : "precisam"} de atenção`);
  return partes.join(" · ");
}

// ---------------------------------------------------------------------------
// Textos da confirmação de retentativa
// ---------------------------------------------------------------------------

export function textoConfirmacao(s: SituacaoPessoa): { titulo: string; corpo: string; botao: string } | null {
  if (!s.retentativa) return null;
  const protecao =
    "Quem já está em revisão, revisado ou entregue não é afetado: o sistema recusa gerar de novo nesses casos.";
  if (s.retentativa.tipo === "fila") {
    const feitas = s.processamento.tentativas;
    return {
      titulo: `Tentar gerar de novo o direcionamento de ${s.nome}?`,
      corpo:
        `${feitas ? `Já houve ${feitas} ${feitas === 1 ? "tentativa" : "tentativas"} sem sucesso. ` : ""}` +
        `Vamos recolocar esta pessoa na fila com tentativas novas e dar andamento à fila, o que também atende quem já estava esperando. Leva cerca de 1 minuto por pessoa e usa a inteligência artificial. ${protecao}`,
      botao: "Tentar de novo",
    };
  }
  return {
    titulo: `Gerar o direcionamento de ${s.nome} agora?`,
    corpo: `Vamos gerar só o direcionamento desta pessoa. Leva cerca de 1 minuto e usa a inteligência artificial. ${protecao}`,
    botao: "Gerar agora",
  };
}


// ---------------------------------------------------------------------------
// O rotulo do evento "concluido" (Rodada 69)
// ---------------------------------------------------------------------------

export interface ResumoDosDocumentos {
  comDocumento: number;
  falharam: number;
}

/**
 * O banco fecha o evento ('completed') quando nao sobra job pendente -- falho ou
 * nao (migration 018). Com 50 falhas por credencial, o painel dizia "Concluido".
 * Nas palavras do CTO: falha total nao e conclusao, e processamento que exige
 * intervencao. O status do banco nao muda aqui; muda o que a tela afirma.
 * Sem leitura dos documentos, a tela nao arrisca: diz so que o processamento
 * terminou.
 */
export function rotuloDoEventoConcluido(r: ResumoDosDocumentos | null): string {
  if (!r) return "Processamento encerrado";
  if (r.falharam === 0) return "Concluído";
  return r.comDocumento === 0 ? "Falha no processamento" : "Processamento parcial";
}
