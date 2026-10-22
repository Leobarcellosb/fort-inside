// A TELA DA SEGUNDA RESPOSTA DO FORMULARIO PUBLICO, sem React.
//
// Funcoes puras em torno de um `fetcher` injetavel (o mesmo desenho de
// decidir-identidade.ts): a prova chama as ROTAS DE VERDADE por aqui.
//
// A classificacao de erro NAO e escrita aqui: e `desfechoDeErro` da tela da
// importacao. O que esta tela acrescenta e o NOME DO FATO que o banco (ou a
// borda) deu a recusa -- `detalhes.fato_do_banco` --, traduzido por uma tabela
// fechada. Sem isso o operador leria "a decisao nao foi autorizada" sem saber
// se o cadastro ja tinha resposta, se o e-mail ja era de outra pessoa ou se
// outro operador decidiu antes.

import type {
  CasoDeSegundaResposta,
  MesaDaRegularizacao,
  PedidoDeDesconsideracao,
  PedidoDeDestinatario,
  PedidoDeRegularizacao,
} from "../../../lib/importacao/regularizacao";
import {
  MENSAGEM_SEM_CONEXAO,
  corpoDe,
  desfechoDeErro,
  registrarNoConsole,
  type Desfecho,
  type Fetcher,
  type Registrador,
} from "./importar-respostas";

export const ROTA_DA_MESA_DA_SEGUNDA_RESPOSTA = "/api/importacao/segunda-resposta";
export const ROTA_DE_REGULARIZAR = "/api/importacao/segunda-resposta/regularizar";
export const ROTA_DE_DESCONSIDERAR = "/api/importacao/segunda-resposta/desconsiderar";
export const ROTA_DO_DESTINATARIO = "/api/importacao/segunda-resposta/destinatario";

/** O que cada fato de recusa quer dizer, para quem esta na frente da tela. */
export const FATO_DA_RECUSA: Record<string, string> = {
  fora_do_escopo: "Esta submissão não é uma segunda resposta do formulário público.",
  submissao_ja_decidida: "Outro operador já decidiu esta submissão. Recarregue a lista.",
  submissao_mudou: "A submissão mudou desde que você a abriu. Recarregue a lista.",
  caso_mudou: "O caso mudou desde que você o abriu (outro cadastro, outra resposta). Recarregue a lista.",
  plano_nao_corresponde: "O que seria gravado não corresponde à submissão preservada. Nada foi gravado.",
  alvo_inexistente: "O cadastro escolhido não existe mais.",
  alvo_de_outro_evento: "O cadastro escolhido não é deste evento.",
  alvo_e_o_dono_da_primeira: "Esse cadastro é o dono da PRIMEIRA resposta: vincular escreveria por cima dela.",
  alvo_tem_respostas: "Esse cadastro já tem respostas gravadas. Elas não são sobrescritas — escolha outro cadastro ou desconsidere.",
  alvo_tem_submissao_ativa: "Esse cadastro já tem outra submissão externa ligada a ele.",
  alvo_tem_documento: "Esse cadastro já tem documento gerado.",
  email_e_o_digitado: "O e-mail do novo cadastro é o mesmo digitado no formulário — que já é de outra pessoa.",
  email_ja_cadastrado: "Já existe cadastro neste evento com esse e-mail. Não se cria uma segunda pessoa: vincule ao cadastro existente, se for ela.",
  nome_ja_cadastrado: "Já existe cadastro neste evento com esse nome. Se é a mesma pessoa, vincule a ele.",
  convidado_inexistente: "O convidado apontado não está na lista oficial deste evento.",
  convidado_de_outra_pessoa: "O convidado apontado já está ligado a outro cadastro.",
  convidado_com_outro_email: "O convidado apontado tem outro e-mail na lista oficial.",
  primeira_resposta_ausente: "A primeira resposta não existe mais: desconsiderar a segunda deixaria a pessoa sem resposta.",
  recusada_na_revalidacao: "O banco recusou na revalidação (as respostas daquele cadastro mudaram no meio). Nada foi gravado.",
  referencia_sem_substancia:
    "A referência não identifica conferência nenhuma. Diga qual lista e qual linha, quem confirmou presencialmente e quando, ou qual contato previamente conhecido foi usado. “Identidade conferida”, ou o nome/e-mail do próprio formulário, não é referência.",
  fonte_fora_do_vocabulario: "A fonte não é uma das três aceitas.",
  motivo_insuficiente: "O motivo está curto demais: explique a divergência deste caso.",
  sem_regularizacao: "Esta pessoa não foi regularizada: a confirmação de destinatário é o segundo passo de uma regularização.",
  email_nao_e_o_do_cadastro: "O e-mail confirmado não é o do cadastro. A entrega vai para o endereço do cadastro.",
  canal_fora_do_vocabulario: "O canal não é um dos aceitos.",
};

function comFato(d: Desfecho, corpo: Record<string, unknown>): Desfecho {
  const detalhes = corpo.detalhes as { fato_do_banco?: unknown } | undefined;
  const fato = typeof detalhes?.fato_do_banco === "string" ? detalhes.fato_do_banco : null;
  if (fato === null || !("mensagem" in d)) return d;
  const texto = FATO_DA_RECUSA[fato] ?? `Fato registrado pelo banco: ${fato}.`;
  return { ...d, mensagem: `${texto} ${d.mensagem}` } as Desfecho;
}

export type DesfechoDaSegundaResposta =
  | { tipo: "mesa"; mesa: MesaDaRegularizacao }
  | { tipo: "gravado"; resumo: Record<string, unknown> }
  | Exclude<Desfecho, { tipo: "previa" } | { tipo: "aplicado" }>;

async function pedir(
  url: string,
  init: RequestInit,
  fetcher: Fetcher,
  registrar: Registrador,
): Promise<{ ok: true; corpo: Record<string, unknown> } | { ok: false; d: DesfechoDaSegundaResposta }> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch {
    return { ok: false, d: { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO } };
  }
  const corpo = await corpoDe(res);
  if (!res.ok) {
    return { ok: false, d: comFato(desfechoDeErro(res, corpo, registrar), corpo) as DesfechoDaSegundaResposta };
  }
  return { ok: true, corpo };
}

/** Le a mesa. Nao escreve nada, e nao ha argumento capaz de fazer escrever. */
export async function pedirMesaDaSegundaResposta(
  eventId: string,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDaSegundaResposta> {
  const r = await pedir(
    `${ROTA_DA_MESA_DA_SEGUNDA_RESPOSTA}?event_id=${encodeURIComponent(eventId)}`,
    { method: "GET" },
    fetcher,
    registrar,
  );
  if (!r.ok) return r.d;
  const mesa = r.corpo.mesa as MesaDaRegularizacao | undefined;
  if (!mesa || !Array.isArray(mesa.casos)) {
    // Mesa que nao chegou nao e mesa vazia.
    return { tipo: "erro_inesperado", mensagem: "A lista não chegou inteira. Tente de novo.", ocorrencia: "local", status: 200 };
  }
  return { tipo: "mesa", mesa };
}

async function escrever(
  url: string,
  corpo: unknown,
  fetcher: Fetcher,
  registrar: Registrador,
): Promise<DesfechoDaSegundaResposta> {
  const r = await pedir(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) },
    fetcher,
    registrar,
  );
  if (!r.ok) return r.d;
  const resumo = r.corpo.gravado as Record<string, unknown> | undefined;
  if (!resumo || resumo.ok !== true) {
    return { tipo: "erro_inesperado", mensagem: "O servidor respondeu sem dizer o que gravou.", ocorrencia: "local", status: 200 };
  }
  return { tipo: "gravado", resumo };
}

/**
 * REGULARIZA. A assinatura exige o CASO recebido da mesa: a impressao que vai
 * no corpo e a dele, nunca recalculada aqui. O corpo NAO leva operador.
 */
export function regularizar(
  entrada: { eventId: string; caso: CasoDeSegundaResposta } & Pick<
    PedidoDeRegularizacao,
    "destino" | "convidado_id" | "fonte_tipo" | "referencia" | "motivo"
  >,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDaSegundaResposta> {
  return escrever(
    ROTA_DE_REGULARIZAR,
    {
      event_id: entrada.eventId,
      submission_id: entrada.caso.submissao.id,
      caso_impressao: entrada.caso.impressao_do_caso,
      destino: entrada.destino,
      convidado_id: entrada.convidado_id,
      fonte_tipo: entrada.fonte_tipo,
      referencia: entrada.referencia,
      motivo: entrada.motivo,
    },
    fetcher,
    registrar,
  );
}

export function desconsiderar(
  entrada: { eventId: string; caso: CasoDeSegundaResposta } & Pick<PedidoDeDesconsideracao, "fonte_tipo" | "referencia" | "motivo">,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDaSegundaResposta> {
  return escrever(
    ROTA_DE_DESCONSIDERAR,
    {
      event_id: entrada.eventId,
      submission_id: entrada.caso.submissao.id,
      caso_impressao: entrada.caso.impressao_do_caso,
      fonte_tipo: entrada.fonte_tipo,
      referencia: entrada.referencia,
      motivo: entrada.motivo,
    },
    fetcher,
    registrar,
  );
}

export function confirmarDestinatario(
  entrada: PedidoDeDestinatario,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  registrar: Registrador = registrarNoConsole,
): Promise<DesfechoDaSegundaResposta> {
  return escrever(ROTA_DO_DESTINATARIO, entrada, fetcher, registrar);
}
