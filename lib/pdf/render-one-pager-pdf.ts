// Renderizacao do one-pager individual do Marco Zero. Arquivo NOVO e
// independente: nao toca banco nem storage (quem chama decide onde guardar).
// Entrada: respostas JA achatadas (achatarRespostas). Saida: PDF + o modelo que
// o gerou + numero de paginas, para o chamador falhar alto se passar de uma.

import { createElement } from "react";
import { assertPublicavel } from "../../components/features/marco-zero/catalogo-dimensoes";
import { calcularMarcoZero, type RespostasAchatadas } from "../scoring/marco-zero";
import {
  montarModeloOnePager,
  type MetaOnePager,
  type OnePagerModelo,
} from "../../components/features/marco-zero/one-pager-modelo";

export interface ResultadoOnePager {
  pdf: Buffer;
  paginas: number;
  modelo: OnePagerModelo;
}

/** Conta paginas de um PDF gerado pelo react-pdf (objetos /Type /Page, sem /Pages). */
export function contarPaginasPdf(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export async function renderizarOnePager(
  respostas: RespostasAchatadas,
  meta: MetaOnePager,
  opcoes: { paraPublicacao?: boolean } = {},
): Promise<ResultadoOnePager> {
  // Desenvolvimento e testes: liberados com os rotulos funcionais.
  // Publicacao oficial: so com o catalogo ratificado pela metodologia.
  if (opcoes.paraPublicacao) assertPublicavel();
  const modelo = montarModeloOnePager(calcularMarcoZero(respostas), meta);
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { OnePagerPdfDocument } = await import(
    "../../components/features/marco-zero/OnePagerPdfDocument"
  );
  const pdf = await renderToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(OnePagerPdfDocument, { modelo }) as any,
  );
  return { pdf, paginas: contarPaginasPdf(pdf), modelo };
}
