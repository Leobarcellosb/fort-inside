// Cliente de fila que fala com um Postgres DESCARTÁVEL via psql.
//
// Para que serve: provar `lib/jobs/*` contra o banco de verdade, com as funções
// da migration 018 aplicadas, sem subir PostgREST e sem Supabase. O código de
// produção roda EXATAMENTE como está -- é ele que é provado, não uma imitação.
//
// Por que psql e não um driver: o projeto não tem driver de Postgres nas
// dependências (`pg` não está no package.json) e esta unidade não pode mexer
// nelas. Cada chamada vira um processo psql, logo uma CONEXÃO e uma TRANSAÇÃO
// próprias -- que é justamente o que a prova de concorrência precisa: duas
// chamadas simultâneas são duas transações simultâneas de verdade, disputando o
// mesmo advisory lock e o mesmo `for update skip locked`.
//
// Contrato imitado: o do PostgREST, que é o que o cliente do Supabase entrega.
//   - função que RETURNS TABLE  -> array de objetos (vazio = nenhuma linha)
//   - função escalar            -> o valor cru
// Erro vira `{ data: null, error: { message } }`, como no supabase-js, para que
// o caminho de erro de `lib/jobs/fila.ts` também seja exercitado.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClienteWorker } from "../worker";
import type { ClienteSaude } from "../saude";
import type { RespostaRpc } from "../fila";

const executar = promisify(execFile);

/** Funções da 018 que devolvem escalar; todas as outras devolvem TABLE. */
const ESCALARES = new Set([
  "jobs_renovar_lease",
  "jobs_concluir",
  "jobs_cancelar",
  "jobs_fechar_evento_se_concluido",
]);

function literal(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`número inválido: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  const texto = typeof v === "string" ? v : JSON.stringify(v);
  // Literal sem cast de propósito: literal de tipo `unknown` é coagido pelo
  // Postgres para o tipo do parâmetro (uuid, text ou jsonb) na resolução da
  // função. Adivinhar o cast aqui é que daria erro.
  return `'${texto.replace(/'/g, "''")}'`;
}

export async function psql(url: string, sql: string): Promise<string> {
  const { stdout } = await executar(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-c", sql],
    {
      env: { ...process.env, PGCONNECT_TIMEOUT: "30" },
      maxBuffer: 32 * 1024 * 1024,
      // Mata o processo filho em vez de deixá-lo pendurado. Sem isto, quando o
      // vitest estoura o timeout de uma prova, os psql em voo SOBREVIVEM: numa
      // máquina carregada eu cheguei a 62 processos órfãos, e aí TODA conexão
      // seguinte expirava -- as provas seguintes falhavam por esgotamento de
      // processo, não pelo que mediam.
      timeout: 90_000,
      killSignal: "SIGKILL",
    }
  );
  return stdout.trim();
}

/** Roda um arquivo .sql (usado pela sonda de RLS). */
export async function psqlArquivo(url: string, caminho: string): Promise<string> {
  const { stdout } = await executar(
    "psql",
    ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", url, "-f", caminho],
    {
      env: { ...process.env, PGCONNECT_TIMEOUT: "30" },
      maxBuffer: 32 * 1024 * 1024,
      // Mata o processo filho em vez de deixá-lo pendurado. Sem isto, quando o
      // vitest estoura o timeout de uma prova, os psql em voo SOBREVIVEM: numa
      // máquina carregada eu cheguei a 62 processos órfãos, e aí TODA conexão
      // seguinte expirava -- as provas seguintes falhavam por esgotamento de
      // processo, não pelo que mediam.
      timeout: 90_000,
      killSignal: "SIGKILL",
    }
  );
  return stdout.trim();
}

export async function consultarJson<T = unknown>(url: string, sql: string): Promise<T> {
  const saida = await psql(url, `select coalesce((${sql})::text, 'null')`);
  return JSON.parse(saida || "null") as T;
}

export function criarClientePsql(url: string): ClienteWorker &
  ClienteSaude & {
    chamadas: { funcao: string; sql: string }[];
  } {
  const chamadas: { funcao: string; sql: string }[] = [];

  const rodar = async (sql: string): Promise<RespostaRpc> => {
    try {
      const saida = await psql(url, sql);
      return { data: JSON.parse(saida || "null"), error: null };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return {
        data: null,
        error: { message: (e.stderr || e.message || "erro psql").trim() },
      };
    }
  };

  return {
    chamadas,

    rpc(nome, args) {
      const argumentos = Object.entries(args)
        .map(([chave, valor]) => `${chave} := ${literal(valor)}`)
        .join(", ");

      const sql = ESCALARES.has(nome)
        ? `select to_json(public.${nome}(${argumentos}))::text`
        : `select coalesce(json_agg(t)::text, '[]') from public.${nome}(${argumentos}) t`;

      chamadas.push({ funcao: nome, sql });
      return rodar(sql);
    },

    from(tabela) {
      return {
        select(colunas) {
          // Construtor encadeável equivalente ao do supabase-js para o
          // subconjunto que a fila usa: eq, in, gte, order e limit. Monta UM
          // SELECT; cada filtro é um AND.
          const condicoes: string[] = [];
          let ordem = "";
          let teto = "";

          const q = {
            eq(coluna: string, valor: string) {
              condicoes.push(`${coluna} = ${literal(valor)}`);
              return q;
            },
            in(coluna: string, valores: readonly string[]) {
              condicoes.push(`${coluna} in (${valores.map(literal).join(", ")})`);
              return q;
            },
            gte(coluna: string, valor: string) {
              condicoes.push(`${coluna} >= ${literal(valor)}`);
              return q;
            },
            not(coluna: string, _operador: "is", _valor: null) {
              condicoes.push(`${coluna} is not null`);
              return q;
            },
            order(coluna: string, opcoes: { ascending: boolean }) {
              ordem = ` order by ${coluna} ${opcoes.ascending ? "asc" : "desc"}`;
              return q;
            },
            limit(n: number) {
              teto = ` limit ${Number(n)}`;
              return q;
            },
            then<R1, R2>(
              ok?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
              falha?: ((e: unknown) => R2 | PromiseLike<R2>) | null
            ) {
              const onde = condicoes.length > 0 ? ` where ${condicoes.join(" and ")}` : "";
              const sql =
                `select coalesce(json_agg(t)::text, '[]') from ` +
                `(select ${colunas} from public.${tabela}${onde}${ordem}${teto}) t`;
              return rodar(sql).then(ok, falha);
            },
          };
          return q;
        },
      };
    },
  };
}
