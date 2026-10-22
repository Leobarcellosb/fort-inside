// O QUE A TELA DE REVISAO DIZ SOBRE O DOCUMENTO, por tipo de evento (Rodada 77).
//
// O produto antigo (questionario v1) gera PDF, e os textos dele continuam
// verdadeiros: nao mudam uma letra. O Marco Zero (v2) nao tem PDF (ver
// lib/pdf/politica-do-pdf.ts), e dizer "PDF sera regenerado" para quem revisa
// na segunda descreve um passo que nao existe.

export interface TextosDaRevisao {
  /** Aviso depois de salvar a revisao. */
  aoSalvar: string;
  /** Complemento da dica de Markdown, depois de `**texto**`. */
  negrito: string;
}

export function textosDaRevisao(pdfDisponivel: boolean): TextosDaRevisao {
  return pdfDisponivel
    ? {
        aoSalvar: "Edição salva. PDF será regenerado ao entregar.",
        negrito: " vira negrito no PDF e na web.",
      }
    : {
        aoSalvar: "Edição salva. Após a aprovação, o documento poderá ser disponibilizado ao participante.",
        negrito: ": o trecho ficará em negrito no documento apresentado ao participante.",
      };
}
