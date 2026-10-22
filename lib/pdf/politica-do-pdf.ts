// O MARCO ZERO NAO TEM PDF NESTA EDICAO (Rodada 70 do CTO).
//
// O PDF e gravado num bucket PUBLICO (getPublicUrl): o endereco e permanente,
// abre para qualquer pessoa que o tenha e continua abrindo depois que o
// documento sai do ar -- a suspensao (027) zera `pdf_url`, mas nao apaga o
// arquivo, e a CDN pode guardar copia. Para documento pessoal de adolescente,
// isso nao passa no teste de acesso. A decisao foi entregar so a pagina, que
// respeita a liberacao e a suspensao.
//
// O criterio e a versao do questionario: a v2 e a do Marco Zero; o produto
// antigo (v1) continua com PDF, sem regressao.
//
// Esconder o botao nao bastaria: a rota de gerar e a de status tambem
// recusam, para nao existir caminho alternativo que produza ou devolva o
// arquivo.

export function pdfPermitido(evento: { quiz_version?: number | null } | null | undefined): boolean {
  if (!evento || typeof evento.quiz_version !== "number") return false;
  return evento.quiz_version < 2;
}

export const TEXTO_PDF_INDISPONIVEL = "PDF indisponível para este evento.";
