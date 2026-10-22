// Distingue "as funções da fila NÃO EXISTEM no banco" (migration 018 ausente) de
// qualquer outra falha ao falar com a fila.
//
// `lib/jobs/fila.ts` converte o `{ error }` do PostgREST em `ErroDeFila(mensagem)`
// e PERDE o código. Aquele arquivo é de outro escopo, então a rota observa a
// resposta crua do rpc ANTES de ela virar exceção: `observarRpc` embrulha o
// cliente, guarda o último erro (com o código) e devolve a resposta intacta.
//
// Códigos que significam "o objeto não existe no banco":
//   PGRST202  PostgREST: função não encontrada no schema cache (é o que o rpc de
//             uma função renomeada/ausente devolve; também a assinatura errada);
//   42883     Postgres: undefined_function;
//   42P01     Postgres: undefined_table (função existe, tabela `jobs` não);
//   PGRST205  PostgREST: tabela não está no schema cache (é o que a LEITURA direta
//             de `jobs`, em /api/jobs/status, devolve quando a tabela não existe).
// Qualquer outro erro (rede, timeout, permissão, conflito) é QUEUE_UNAVAILABLE:
// a fila existe, só não respondeu. Mandar o host aplicar migration nesse caso
// seria mandá-lo investigar a coisa errada.

export interface ErroRpcCru {
  code?: string;
  message?: string;
}

interface RespostaRpcCrua {
  data: unknown;
  error: ErroRpcCru | null;
}

interface ClienteRpc {
  rpc(nome: string, args: Record<string, unknown>): PromiseLike<RespostaRpcCrua>;
}

const CODIGOS_DE_OBJETO_AUSENTE = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);

/**
 * A MENSAGEM diz que um objeto do esquema não existe?
 *
 * Lacuna medida por outra unidade: o padrão antigo `function [^ ]+ does not exist`
 * não casava o Postgres CRU, porque ele traz a assinatura COM ESPAÇO --
 *     function public.jobs_consumo_resumo(uuid, text) does not exist
 * --, e a causa (migration ausente) era classificada como indisponibilidade: a
 * operação seria mandada investigar a rede quando o que falta é aplicar migration.
 * Formas cobertas:
 *   PostgREST   Could not find the function public.f(a, b) in the schema cache
 *               Could not find the table 'public.jobs' in the schema cache
 *   Postgres    function public.f(uuid, text) does not exist
 *               relation "public.jobs" does not exist | table "x" does not exist
 *               column "c" of relation "t" does not exist
 *   Portugues   a função public.f(uuid, text) não existe | a relação "t" não existe
 * Fora de proposito: role/database/schema/extension ("role X does not exist").
 */
export function mensagemDeObjetoAusente(mensagem: string): boolean {
  return (
    /could not find the (function|table)\b/i.test(mensagem) ||
    /\b(function|relation|table)\b[^\n]*\bdoes not exist\b/i.test(mensagem) ||
    /\b(fun[cç][aã]o|rela[cç][aã]o|tabela)\b[^\n]*\bn[aã]o existe\b/i.test(mensagem)
  );
}

/**
 * Qual objeto faltou, quando a mensagem diz (nome sem esquema nem assinatura), ou
 * `null`. Serve para separar "faltou a função que EU chamei" de "faltou uma função
 * que ELA chama por dentro" (ex.: jobs_iniciar_assincrono x jobs_enfileirar).
 */
export function nomeDoObjetoAusente(mensagem: string): string | null {
  const m =
    /(?:function|fun[cç][aã]o)\s+(?:"?[a-z_0-9]+"?\.)?"?([a-z_0-9]+)"?\s*\(/i.exec(mensagem) ??
    /(?:relation|table|rela[cç][aã]o|tabela)\s+'?"?(?:[a-z_0-9]+\.)?([a-z_0-9]+)"?'?/i.exec(mensagem);
  return m ? m[1].toLowerCase() : null;
}

export function indicaEsquemaAusente(erro: ErroRpcCru | null | undefined): boolean {
  if (!erro) return false;
  if (erro.code && CODIGOS_DE_OBJETO_AUSENTE.has(erro.code)) return true;
  // Sem código (alguns caminhos do cliente só trazem a mensagem).
  return mensagemDeObjetoAusente(erro.message ?? "");
}

export function codigoDeFalhaDeFila(
  erro: ErroRpcCru | null | undefined
): "QUEUE_SCHEMA_MISSING" | "QUEUE_UNAVAILABLE" {
  return indicaEsquemaAusente(erro) ? "QUEUE_SCHEMA_MISSING" : "QUEUE_UNAVAILABLE";
}

export function observarRpc<C extends ClienteRpc>(
  cliente: C
): { cliente: C; ultimoErro: () => ErroRpcCru | null; zerar: () => void } {
  let ultimo: ErroRpcCru | null = null;
  const observado = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      const r = await cliente.rpc(nome, args);
      ultimo = r.error ?? null;
      return r;
    },
  } as unknown as C;
  return { cliente: observado, ultimoErro: () => ultimo, zerar: () => (ultimo = null) };
}
