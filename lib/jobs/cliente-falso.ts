// Cliente de fila falso, para testar a camada de execução sem banco e sem rede.
//
// Não imita o Postgres: imita o CONTRATO do PostgREST (o que o supabase-js
// entrega). Serve para provar o que é lógica do worker -- ordem das chamadas,
// pool de concorrência, tratamento de `false` do fencing, heartbeat -- enquanto
// a semântica transacional (exclusão mútua, lease, fencing de verdade) é
// provada contra Postgres real em `provas/fila-postgres.test.ts`. As duas
// provas respondem perguntas diferentes; nenhuma substitui a outra.

import type { RespostaRpc } from "./fila";

export interface ChamadaRegistrada {
  funcao: string;
  args: Record<string, unknown>;
}

export type Manipulador = (
  args: Record<string, unknown>
) => RespostaRpc | Promise<RespostaRpc>;

export function criarClienteDeFilaFalso(
  manipuladores: Record<string, Manipulador>,
  tabelas: Record<string, Record<string, unknown>[]> = {}
) {
  const chamadas: ChamadaRegistrada[] = [];

  return {
    chamadas,
    /** Nomes das funções chamadas, na ordem. Para provar ordem de operações. */
    get ordem() {
      return chamadas.map((c) => c.funcao);
    },

    rpc(funcao: string, args: Record<string, unknown>): Promise<RespostaRpc> {
      chamadas.push({ funcao, args });
      const m = manipuladores[funcao];
      if (!m) {
        return Promise.resolve({
          data: null,
          error: { message: `sem manipulador falso para ${funcao}` },
        });
      }
      return Promise.resolve(m(args));
    },

    from(tabela: string) {
      return {
        select(_colunas: string) {
          // APLICA os filtros de verdade (eq, in, gte, order, limit), como o
          // `cliente-falso` de lib/testing: um filtro esquecido no código de
          // produção devolve linhas de mais e o teste enxerga.
          let linhas = [...(tabelas[tabela] ?? [])];
          const q = {
            eq(coluna: string, valor: string) {
              linhas = linhas.filter((l) => l[coluna] === valor);
              return q;
            },
            in(coluna: string, valores: readonly string[]) {
              linhas = linhas.filter((l) => valores.includes(String(l[coluna])));
              return q;
            },
            gte(coluna: string, valor: string) {
              linhas = linhas.filter(
                (l) => l[coluna] != null && String(l[coluna]) >= valor
              );
              return q;
            },
            not(coluna: string, _operador: "is", _valor: null) {
              linhas = linhas.filter((l) => l[coluna] != null);
              return q;
            },
            order(coluna: string, opcoes: { ascending: boolean }) {
              linhas.sort((a, b) => {
                const x = String(a[coluna] ?? "");
                const y = String(b[coluna] ?? "");
                return opcoes.ascending ? x.localeCompare(y) : y.localeCompare(x);
              });
              return q;
            },
            limit(n: number) {
              linhas = linhas.slice(0, n);
              return q;
            },
            then<R1, R2>(
              ok?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
              falha?: ((e: unknown) => R2 | PromiseLike<R2>) | null
            ) {
              return Promise.resolve({ data: linhas, error: null as unknown }).then(ok, falha);
            },
          };
          return q;
        },
      };
    },
  };
}
