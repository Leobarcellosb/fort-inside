// Protecao de privacidade do DNA Coletivo: piso de exibicao e tratamento do
// complementar. Funcoes puras, sem I/O.
//
// O PROBLEMA. O documento e lido em voz alta para uma sala de 8 a 50 pessoas que
// em boa parte se conhece. Uma contagem pequena ("2 pessoas com destaque em X")
// aponta gente; e uma contagem grande tambem aponta, por subtracao, quando a
// outra metade e pequena ("39 de 40 tem destaque" diz que 1 nao tem).
//
// A REGRA (deste arquivo, e so dele):
//  1. PISO. Nenhum numero de pessoas entre 1 e PISO-1 e exibido. Zero pode ser
//     exibido (e o "o que nao aparece"); a partir do piso, tambem.
//  2. COMPLEMENTAR. Nenhuma celula escondida pode ser recuperada por subtracao.
//     Por isso uma celula pequena nunca e escondida sozinha: ela e SOMADA a
//     outras e so a soma aparece (que e >= PISO e envolve >= 2 celulas). Se
//     houver celula grande disponivel, a menor delas e sempre somada junto, para
//     que a soma nao denuncie o valor dos membros (4+4=8, ou 1+1+1+1+1=5).
//  3. Se somar tudo o que e positivo nao deixa nada a mostrar alem do total, a
//     particao e OCULTADA por inteiro (nem zeros aparecem).
//  4. Particao em dois lados (com/sem): se qualquer lado esta entre 1 e PISO-1, os
//     DOIS numeros exatos sao ocultados; so se diz "menos de PISO".
//
// O QUE ISTO NAO E. Nao e k-anonimato formal nem privacidade diferencial: protege
// contra leitura direta e subtracao simples dentro de um mesmo quadro. Nao
// impede cruzar quadros diferentes (um recorte aqui com outro ali) nem usar o
// que a sala ja sabe sobre as pessoas. Os limites estao no relatorio.

/**
 * PISO PROVISORIO, a ser ratificado por quem responde pela metodologia/privacidade.
 * Escolha: 5. Com 3, uma celula exibida ainda pode ser "as tres pessoas de
 * tal funcao"; 5 e o minimo usual de estatistica publica para contagens
 * divulgadas e deixa a soma de qualquer par de celulas ocultas >= 5. Subir o
 * piso so oculta mais; baixa-lo exige decisao explicita.
 */
export const PISO_DE_EXIBICAO = 5;

export interface Celula<Id extends string = string> {
  id: Id;
  contagem: number;
}

export type LinhaProtegida<Id extends string = string> =
  | { tipo: "celula"; id: Id; contagem: number }
  | { tipo: "agrupada"; ids: readonly Id[]; contagem: number };

export interface ParticaoProtegida<Id extends string = string> {
  linhas: readonly LinhaProtegida<Id>[];
  /** Houve celula somada a outras. */
  agrupou: boolean;
  /** A particao inteira foi escondida (nada alem do total seria seguro). */
  oculta: boolean;
}

/**
 * Protege uma particao (as celulas somam o total da base). Preserva a ordem
 * original das celulas; a linha agrupada ocupa o lugar do primeiro membro.
 */
export function protegerParticao<Id extends string>(
  celulas: readonly Celula<Id>[],
  piso: number = PISO_DE_EXIBICAO,
): ParticaoProtegida<Id> {
  for (const c of celulas) {
    if (!Number.isInteger(c.contagem) || c.contagem < 0) {
      throw new Error(`Contagem invalida para ${c.id}: ${c.contagem}`);
    }
  }
  const positivas = celulas.filter((c) => c.contagem > 0);
  const pequenas = positivas.filter((c) => c.contagem < piso);

  if (pequenas.length === 0) {
    return {
      linhas: celulas.map((c) => ({ tipo: "celula", id: c.id, contagem: c.contagem })),
      agrupou: false,
      oculta: false,
    };
  }

  const grupo: Celula<Id>[] = [...pequenas];
  const sobra = positivas
    .filter((c) => c.contagem >= piso)
    .sort((a, b) => a.contagem - b.contagem);
  if (sobra.length > 0) grupo.push(sobra[0]); // sempre soma a menor grande

  const soma = grupo.reduce((s, c) => s + c.contagem, 0);
  if (grupo.length < 2 || soma < piso) {
    return { linhas: [], agrupou: false, oculta: true };
  }
  // Somar todas as positivas nao informa nada alem do total.
  if (grupo.length === positivas.length) {
    return { linhas: [], agrupou: true, oculta: true };
  }

  const ids = new Set(grupo.map((c) => c.id));
  const linhas: LinhaProtegida<Id>[] = [];
  let emitido = false;
  for (const c of celulas) {
    if (ids.has(c.id)) {
      if (!emitido) {
        linhas.push({
          tipo: "agrupada",
          ids: celulas.filter((x) => ids.has(x.id)).map((x) => x.id),
          contagem: soma,
        });
        emitido = true;
      }
    } else {
      linhas.push({ tipo: "celula", id: c.id, contagem: c.contagem });
    }
  }
  return { linhas, agrupou: true, oculta: false };
}

export type ExibicaoDeDoisLados =
  | { exibir: true }
  | { exibir: false; ladoPequeno: "com" | "sem" };

/**
 * Particao em dois lados (com destaque / sem destaque). Se um lado esta entre 1
 * e piso-1, os dois numeros exatos saem de cena: o grande entregaria o pequeno
 * por subtracao.
 */
export function protegerDoisLados(
  com: number,
  sem: number,
  piso: number = PISO_DE_EXIBICAO,
): ExibicaoDeDoisLados {
  if (com > 0 && com < piso) return { exibir: false, ladoPequeno: "com" };
  if (sem > 0 && sem < piso) return { exibir: false, ladoPequeno: "sem" };
  return { exibir: true };
}
