// Cliente falso do Supabase para testes: tabelas em memoria e um construtor de
// consultas que APLICA os filtros de verdade (eq, in, order). Serve para provar
// que uma leitura filtra por versao: um filtro esquecido devolve linhas de mais
// e o teste enxerga. Registra cada consulta para o teste poder inspecionar.

type Linha = Record<string, unknown>;

export interface ConsultaRegistrada {
  tabela: string;
  colunas: string;
  filtros: string[];
}

export function criarClienteFalso(tabelas: Record<string, Linha[]>) {
  const consultas: ConsultaRegistrada[] = [];

  function consulta(tabela: string, colunas: string) {
    const registro: ConsultaRegistrada = { tabela, colunas, filtros: [] };
    consultas.push(registro);
    let linhas = [...(tabelas[tabela] ?? [])];
    let ordem: string | null = null;

    const executar = (unica: boolean) => {
      if (ordem) {
        const col = ordem;
        linhas.sort((a, b) => Number(a[col]) - Number(b[col]));
      }
      const data = unica ? (linhas[0] ?? null) : linhas;
      return { data, error: null as unknown };
    };

    const q = {
      eq(coluna: string, valor: string | number) {
        registro.filtros.push(`${coluna}=${valor}`);
        linhas = linhas.filter((l) => l[coluna] === valor);
        return q;
      },
      in(coluna: string, valores: readonly (string | number)[]) {
        registro.filtros.push(`${coluna} in (${valores.join(",")})`);
        linhas = linhas.filter((l) => valores.includes(l[coluna] as string | number));
        return q;
      },
      order(coluna: string) {
        ordem = coluna;
        return q;
      },
      maybeSingle() {
        return Promise.resolve(executar(true));
      },
      then<R1, R2>(
        ok?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
        err?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
      ) {
        return Promise.resolve(executar(false)).then(ok, err);
      },
    };
    return q;
  }

  return {
    consultas,
    from(tabela: string) {
      return { select: (colunas: string) => consulta(tabela, colunas) };
    },
  };
}
