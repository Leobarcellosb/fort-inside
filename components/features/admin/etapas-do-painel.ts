// O QUE O PAINEL AO VIVO SABE -- E O QUE ELE NAO SABE -- SOBRE AS ETAPAS DO EVENTO.
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// O painel ao vivo (LiveControlPanel) foi escrito para o Fort Inside, onde a
// coincidencia abaixo era verdadeira e invisivel:
//
//   events.current_stage       e um ORDINAL (1..N), comparado no banco com
//                              quiz_stages.stage_number (migration 010).
//   quiz_responses.stage_id    e o ID DA LINHA de quiz_stages.
//
// Na versao 1 do questionario os ids sao 1..6 e os stage_number sao 1..6: id e
// ordinal sao o MESMO numero, e o painel pode compara-los sem perceber que sao
// grandezas diferentes. (O mesmo e dito em lib/quiz/carregar-etapa.ts: "Na v1 o
// stage_number e igual ao id, entao o mesmo caminho serve para as duas.")
//
// Na versao 2 (Marco Zero) os ids sao 101..105 e os stage_number sao 1..5. A
// coincidencia morre, e TODO numero por etapa que o painel calculava passa a
// mentir:
//   - `r.stage_id === currentStage` nunca bate -> "0/4 na etapa 5" num evento
//     onde todo mundo respondeu as cinco etapas;
//   - as barrinhas de etapa por pessoa ficam todas apagadas -> "ninguem
//     respondeu nada";
//   - `currentStage + 1` oferece "liberar etapa 6" num evento de cinco etapas,
//     uma operacao que nao existe.
//
// A DECISAO DA REVISAO, LITERAL
// -----------------------------
// "Painel ao vivo: nao sera utilizado no Marco Zero. Porem, deve ser ISOLADO
// ESTRUTURALMENTE para impedir acoes incompativeis e numeros falsos."
//
// Entao este arquivo NAO faz o painel funcionar na v2. Ele decide UMA coisa: se
// o painel consegue ou nao ler as etapas deste evento. Quando nao consegue, o
// painel deixa de oferecer a acao e deixa de exibir o numero -- e DIZ que nao
// sabe.
//
// A REGRA QUE GOVERNA O PROJETO, AQUI EM PIXELS
// ---------------------------------------------
// "Nao consegui verificar" nunca e "verifiquei e deu zero". Zero respostas e uma
// AFIRMACAO sobre o evento; nao saber ler o evento e uma afirmacao sobre a TELA.
// Por isso nenhuma funcao daqui devolve 0 como contagem desconhecida: ela
// devolve um estado proprio (`nao_sei`), e quem renderiza e obrigado pelo tipo a
// tratar os dois casos separadamente.
//
// O CRITERIO: a leitura e possivel quando os ids das etapas recebidas sao
// exatamente 1..N. Nao se olha `quiz_version`: o numero da versao nao e a
// doenca -- a doenca e id != ordinal, e e exatamente isso que se mede. Uma v3
// futura com ids 1..N seria lida; uma v1 remendada com ids fora de 1..N nao
// seria, e esta certo.
//
// POR QUE NAO SE CONSERTA AQUI (alcance declarado): bastaria o painel receber
// `stage_number` de cada etapa para mapear ordinal -> id e passar a funcionar na
// v2. Isso e a reescrita que a revisao disse para NAO fazer. A pagina continua
// sem selecionar `stage_number` de proposito.
//
// Tudo aqui e funcao pura (sem rede, sem React) para poder ser provado em teste.

export interface EtapaRecebida {
  /** Id da linha de `quiz_stages` -- o que `quiz_responses.stage_id` guarda. */
  id: number;
  title: string | null;
  ambient_name: string | null;
}

export interface EtapaDoPainel {
  /** O numero que o host ve, e o que `events.current_stage` significa. */
  numero: number;
  /** O id da linha. Igual a `numero` por construcao: so ha leitura quando ids = 1..N. */
  id: number;
  titulo: string;
  ambiente: string;
}

export type MotivoSemLeitura = "sem_etapas" | "ids_nao_sao_ordinais";

export const TEXTO_SEM_ETAPAS =
  "Este painel não recebeu nenhuma etapa deste evento, então não sabe ler o andamento dele. " +
  "Enquanto isso, o painel não mostra lista de etapas, não libera etapa e não exibe contagem por etapa. " +
  "Isso não é o mesmo que dizer que ninguém respondeu: é esta tela que não sabe.";

export const TEXTO_IDS_NAO_SAO_ORDINAIS =
  "Este painel só sabe ler eventos cujas etapas são numeradas de 1 a N. As etapas deste evento têm " +
  "outros identificadores, então o painel não consegue dizer em que etapa o evento está, quem respondeu " +
  "o quê, nem qual é a próxima etapa. Por isso ele não mostra a lista de etapas, não oferece liberar " +
  "etapa e não exibe contagem por etapa. Atenção: isso NÃO significa zero respostas — as respostas podem " +
  "existir e esta tela não sabe lê-las. O que vale para este evento é a seção Prognósticos, acima: ela não " +
  "depende de etapa. Se precisar do andamento por etapa, peça à equipe técnica.";

export type LeituraDoPainel =
  | { suportado: true; etapas: EtapaDoPainel[]; total: number }
  | {
      suportado: false;
      motivo: MotivoSemLeitura;
      texto: string;
      /** Para o host conseguir relatar o que a tela recebeu, sem abrir o banco. */
      idsEncontrados: number[];
    };

/**
 * O painel consegue ler as etapas deste evento?
 *
 * Nao recebe `quiz_version` de proposito: o criterio e a forma dos ids, nao o
 * numero da versao.
 */
export function leituraDoPainel(etapasRecebidas: readonly EtapaRecebida[]): LeituraDoPainel {
  const ids = etapasRecebidas.map((e) => e.id);

  if (etapasRecebidas.length === 0) {
    return { suportado: false, motivo: "sem_etapas", texto: TEXTO_SEM_ETAPAS, idsEncontrados: [] };
  }

  const ordenadas = [...etapasRecebidas].sort((a, b) => a.id - b.id);
  const saoOrdinais = ordenadas.every((e, i) => e.id === i + 1);
  if (!saoOrdinais) {
    return {
      suportado: false,
      motivo: "ids_nao_sao_ordinais",
      texto: TEXTO_IDS_NAO_SAO_ORDINAIS,
      idsEncontrados: [...ids].sort((a, b) => a - b),
    };
  }

  return {
    suportado: true,
    total: ordenadas.length,
    etapas: ordenadas.map((e) => ({
      numero: e.id,
      id: e.id,
      // O nome do ambiente vem do BANCO. O painel tinha uma copia escrita a mao
      // dos ambientes da casa do Fort Inside ("Portao, Entrada, Sala
      // Principal...") num vetor fixo indexado pelo numero da etapa; ela
      // aparecia em QUALQUER evento, inclusive nos do Marco Zero, de onde o dono
      // pediu nominalmente que a casa saisse. A copia foi removida: aqui nao ha
      // nome de ambiente que nao tenha vindo da linha da etapa.
      titulo: (e.title ?? "").trim(),
      ambiente: (e.ambient_name ?? "").trim(),
    })),
  };
}

// ---------------------------------------------------------------------------
// A proxima etapa -- ou por que nao ha uma para oferecer
// ---------------------------------------------------------------------------

export type ProximaEtapa =
  | { oferecer: true; numero: number; etapa: EtapaDoPainel }
  | { oferecer: false; motivo: "nao_sei_ler" | "ultima_etapa"; texto: string };

export const TEXTO_LIBERAR_NAO_SE_APLICA =
  "Liberar a próxima etapa não se aplica a este evento nesta tela: o painel não sabe ler as etapas dele, " +
  "e oferecer uma etapa que talvez não exista seria oferecer uma operação inexistente.";

export const TEXTO_ULTIMA_ETAPA =
  "Esta é a última etapa do questionário deste evento: não há próxima etapa para liberar.";

/**
 * `currentStage + 1` era a proxima etapa, SEM perguntar se ela existe -- e foi
 * isso que produziu "LIBERAR ETAPA 6" num evento de cinco. A proxima etapa agora
 * so existe se houver uma LINHA de etapa com aquele numero.
 */
export function proximaEtapa(leitura: LeituraDoPainel, etapaAtual: number): ProximaEtapa {
  if (!leitura.suportado) {
    return { oferecer: false, motivo: "nao_sei_ler", texto: TEXTO_LIBERAR_NAO_SE_APLICA };
  }
  const numero = etapaAtual + 1;
  const etapa = leitura.etapas.find((e) => e.numero === numero);
  if (!etapa) {
    return { oferecer: false, motivo: "ultima_etapa", texto: TEXTO_ULTIMA_ETAPA };
  }
  return { oferecer: true, numero, etapa };
}

/** O evento ja passou da ultima etapa? Desconhecido quando nao ha leitura. */
export function coletaDeEtapasConcluida(leitura: LeituraDoPainel, etapaAtual: number): boolean {
  return leitura.suportado && etapaAtual >= leitura.total;
}

// ---------------------------------------------------------------------------
// Contagem na etapa atual -- "0/4" era um numero falso
// ---------------------------------------------------------------------------

export type Contagem =
  | { estado: "conhecida"; feitos: number; total: number; etapa: number }
  /** O evento ainda nao liberou etapa nenhuma: nao ha etapa atual (nao e "nao sei"). */
  | { estado: "nao_comecou" }
  /** A tela nao sabe calcular. NUNCA e zero. */
  | { estado: "nao_sei"; texto: string };

export const TEXTO_CONTAGEM_DESCONHECIDA =
  "Quantas pessoas estão na etapa atual: não disponível nesta tela para este evento. " +
  "Não é zero — é desconhecido.";

/** Rotulo curto, para a linha ao lado do titulo da coluna. Visivel, nao em `title`. */
export const ROTULO_CONTAGEM_DESCONHECIDA = "na etapa: não disponível";

export function contagemNaEtapaAtual(entrada: {
  leitura: LeituraDoPainel;
  etapaAtual: number;
  participantes: readonly { id: string }[];
  respostas: readonly { participant_id: string; stage_id: number }[];
}): Contagem {
  const { leitura, etapaAtual, participantes, respostas } = entrada;
  if (!leitura.suportado) return { estado: "nao_sei", texto: TEXTO_CONTAGEM_DESCONHECIDA };
  if (etapaAtual <= 0) return { estado: "nao_comecou" };

  const etapa = leitura.etapas.find((e) => e.numero === etapaAtual);
  // `current_stage` aponta para uma etapa que nao existe nesta versao: a tela
  // nao sabe o que contar. Zero seria uma afirmacao sobre as pessoas.
  if (!etapa) return { estado: "nao_sei", texto: TEXTO_CONTAGEM_DESCONHECIDA };

  const feitos = participantes.filter((p) =>
    respostas.some((r) => r.participant_id === p.id && r.stage_id === etapa.id)
  ).length;

  return { estado: "conhecida", feitos, total: participantes.length, etapa: etapaAtual };
}

/** Quem ainda nao enviou a etapa atual. Vazio quando a tela nao sabe: nao se acusa por ignorancia. */
export function pendentesDaEtapaAtual<P extends { id: string }>(entrada: {
  leitura: LeituraDoPainel;
  etapaAtual: number;
  participantes: readonly P[];
  respostas: readonly { participant_id: string; stage_id: number }[];
}): P[] {
  const { leitura, etapaAtual, participantes, respostas } = entrada;
  if (!leitura.suportado || etapaAtual <= 0) return [];
  const etapa = leitura.etapas.find((e) => e.numero === etapaAtual);
  if (!etapa) return [];
  return participantes.filter(
    (p) => !respostas.some((r) => r.participant_id === p.id && r.stage_id === etapa.id)
  );
}

// ---------------------------------------------------------------------------
// A trilha de barrinhas por pessoa
// ---------------------------------------------------------------------------

export type Trilha =
  | { estado: "conhecida"; marcas: { numero: number; respondida: boolean }[] }
  | { estado: "nao_sei" };

/**
 * As barrinhas eram `[1,2,3,4,5,6]` escritas a mao e comparadas com `stage_id`.
 * Num evento da v2 todas ficavam apagadas: a tela desenhava "respondeu nada"
 * para quem tinha respondido tudo. Sem leitura, nao se desenha trilha.
 */
export function trilhaDaPessoa(entrada: {
  leitura: LeituraDoPainel;
  respondidas: readonly number[];
}): Trilha {
  const { leitura, respondidas } = entrada;
  if (!leitura.suportado) return { estado: "nao_sei" };
  return {
    estado: "conhecida",
    marcas: leitura.etapas.map((e) => ({ numero: e.numero, respondida: respondidas.includes(e.id) })),
  };
}

// ---------------------------------------------------------------------------
// Situacao de cada pessoa
// ---------------------------------------------------------------------------

export type SituacaoDaPessoa =
  /** Vem de `participants.completed_at`: e um fato do banco, independente de etapa. */
  | { tipo: "completo" }
  | { tipo: "na_etapa_atual"; etapa: number }
  | { tipo: "respondendo" }
  /** Nao concluiu o quiz e a tela nao sabe dizer mais nada. */
  | { tipo: "nao_sei" }
  | { tipo: "nada_a_dizer" };

export const ROTULO_SITUACAO_DESCONHECIDA = "sem leitura";

/**
 * "Respondendo" (pulsando) era exibido para quem nao batia com a etapa atual --
 * ou seja, para TODOS, num evento da v2, inclusive para quem ja tinha enviado
 * tudo. `completed_at` continua valendo porque nao depende de etapa.
 */
export function situacaoDaPessoa(entrada: {
  leitura: LeituraDoPainel;
  etapaAtual: number;
  concluiuQuiz: boolean;
  respondidas: readonly number[];
}): SituacaoDaPessoa {
  const { leitura, etapaAtual, concluiuQuiz, respondidas } = entrada;
  if (concluiuQuiz) return { tipo: "completo" };
  if (!leitura.suportado) return { tipo: "nao_sei" };
  if (etapaAtual <= 0) return { tipo: "nada_a_dizer" };
  const etapa = leitura.etapas.find((e) => e.numero === etapaAtual);
  if (!etapa) return { tipo: "nao_sei" };
  if (respondidas.includes(etapa.id)) return { tipo: "na_etapa_atual", etapa: etapaAtual };
  return { tipo: "respondendo" };
}

// ---------------------------------------------------------------------------
// Textos que citam numero de etapa
// ---------------------------------------------------------------------------

/**
 * Timeline e avisos diziam "completou etapa 103" num evento da v2: 103 e um id
 * de linha, nao um numero de etapa, e nenhum participante viu "etapa 103" em
 * tela nenhuma. Sem leitura, o texto nao cita numero.
 */
export function textoDeRespostaRecebida(
  leitura: LeituraDoPainel,
  nome: string,
  stageId: number
): string {
  const etapa = leitura.suportado ? leitura.etapas.find((e) => e.id === stageId) : undefined;
  return etapa
    ? `${nome} completou etapa ${etapa.numero}`
    : `${nome} enviou uma resposta — etapa não identificada nesta tela`;
}

/** O mesmo, para a linha da timeline que nao tem nome de pessoa resolvido. */
export function textoDeEtapaLiberada(leitura: LeituraDoPainel, stageId: number | undefined): string {
  if (stageId === undefined) return "Etapa liberada";
  const etapa = leitura.suportado ? leitura.etapas.find((e) => e.numero === stageId) : undefined;
  return etapa ? `Etapa ${etapa.numero} liberada` : "Etapa liberada (número não identificado nesta tela)";
}
