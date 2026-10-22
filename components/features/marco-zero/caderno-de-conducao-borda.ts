// A BORDA DA TELA do CADERNO DE CONDUCAO: pede o Caderno a
// /api/marco-zero/caderno-de-conducao e traduz a resposta para o que o host le.
//
// Mesmo desenho da borda do Guia (`guia-facilitador-borda.ts`), de proposito: a
// tela nao interpreta status HTTP e nao exibe o `error` do corpo (texto do
// servidor). Quem decide a mensagem e o CODIGO, traduzido por `mensagemParaHost`
// (lib/erros/mensagens-host.ts).
//
// As TRES CLASSES de desfecho, e por que nao sao duas:
//   gerado     -> o Caderno veio, com versao e hash do conteudo;
//   recusado   -> o servidor VERIFICOU e nao entregou (sem sessao; sessao sem
//                 papel de administrador). Ha o que fazer: entrar como quem pode;
//   bloqueado  -> NAO deu para verificar quem esta pedindo (o servico de login
//                 nao respondeu). Nao ha o que corrigir: e esperar.
//
// IMPORTAR SOMENTE TIPO do montador. `caderno-de-conducao.ts` usa `node:crypto`
// para o hash; um import de valor arrastaria isso para o bundle do cliente.

import { ehCodigoDeErro, type CodigoDeErro } from "../../../lib/erros/codigos";
import { MENSAGEM_GENERICA, mensagemParaHost } from "../../../lib/erros/mensagens-host";
import type { ContagemDeItens } from "../../../lib/marco-zero/caderno-de-conducao";
import type { ClasseDeLacuna, MomentoId } from "../../../lib/marco-zero/roteiro-oficial";

export const MENSAGEM_SEM_CONEXAO =
  "Não foi possível falar com o servidor agora. Nenhum Caderno foi recebido. Confira a conexão e tente de novo. Se você já baixou o Caderno antes, o arquivo baixado continua valendo: ele não depende de internet.";

/** Códigos que são "não deu para verificar". Bloqueiam, e não são recusa. */
const BLOQUEIO: readonly CodigoDeErro[] = ["AUTH_UNAVAILABLE"];

export interface LacunaRecebida {
  momento: MomentoId;
  momento_numero: number;
  rotulo: string;
  falta: string;
  de_quem: string;
  classe: ClasseDeLacuna;
}

export interface MomentoRecebido {
  id: MomentoId;
  numero: number;
  titulo: string;
  contagem: ContagemDeItens;
}

export interface CadernoRecebido {
  versao: string;
  conteudo_sha256: string;
  contagem: ContagemDeItens;
  momentos: readonly MomentoRecebido[];
  lacunas: readonly LacunaRecebida[];
  texto: string;
  html: string;
}

export type DesfechoDoCaderno =
  | { tipo: "gerado"; caderno: CadernoRecebido }
  | { tipo: "recusado"; codigo: CodigoDeErro; mensagem: string; ocorrencia: string | null }
  | { tipo: "bloqueado"; codigo: CodigoDeErro; mensagem: string; ocorrencia: string | null }
  | { tipo: "erro_inesperado"; mensagem: string; ocorrencia: string | null }
  | { tipo: "sem_conexao"; mensagem: string };

const ID_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

function ocorrenciaDe(corpo: Record<string, unknown>): string | null {
  const o = corpo.ocorrencia;
  return typeof o === "string" && ID_VALIDO.test(o) ? o : null;
}

/**
 * Aceita só o que tem a forma do Caderno. Em especial: o hash tem de ser
 * SHA-256 em hexadecimal e o texto não pode ser vazio -- um corpo "ok" sem
 * conteúdo não é um Caderno, e a tela não mostra um Caderno vazio como se fosse.
 */
function cadernoValido(corpo: Record<string, unknown>): CadernoRecebido | null {
  if (corpo.ok !== true) return null;
  const { versao, conteudo_sha256, contagem, momentos, lacunas, texto, html } = corpo;
  if (typeof versao !== "string" || versao.length === 0) return null;
  if (typeof conteudo_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(conteudo_sha256)) return null;
  if (typeof texto !== "string" || texto.length === 0) return null;
  if (typeof html !== "string" || html.length === 0) return null;
  if (contagem === null || typeof contagem !== "object") return null;
  if (!Array.isArray(momentos) || momentos.length === 0) return null;
  if (!Array.isArray(lacunas)) return null;
  return {
    versao,
    conteudo_sha256,
    contagem: contagem as ContagemDeItens,
    momentos: momentos as MomentoRecebido[],
    lacunas: lacunas as LacunaRecebida[],
    texto,
    html,
  };
}

export async function pedirCadernoDeConducao(
  buscar: typeof fetch = fetch,
): Promise<DesfechoDoCaderno> {
  let res: Response;
  try {
    // Sem corpo: o Caderno não é por evento e a rota ignora o que vier.
    res = await buscar("/api/marco-zero/caderno-de-conducao", { method: "POST" });
  } catch {
    return { tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO };
  }

  let corpo: Record<string, unknown> = {};
  try {
    corpo = (await res.json()) as Record<string, unknown>;
  } catch {
    corpo = {};
  }

  if (res.ok) {
    const caderno = cadernoValido(corpo);
    if (caderno) return { tipo: "gerado", caderno };
    return { tipo: "erro_inesperado", mensagem: MENSAGEM_GENERICA, ocorrencia: ocorrenciaDe(corpo) };
  }

  const codigo = corpo.code;
  if (!ehCodigoDeErro(codigo)) {
    return { tipo: "erro_inesperado", mensagem: MENSAGEM_GENERICA, ocorrencia: ocorrenciaDe(corpo) };
  }
  return {
    tipo: BLOQUEIO.includes(codigo) ? "bloqueado" : "recusado",
    codigo,
    mensagem: mensagemParaHost(codigo),
    ocorrencia: ocorrenciaDe(corpo),
  };
}
