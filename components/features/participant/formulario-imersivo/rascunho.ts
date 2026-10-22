// O RASCUNHO DO FORMULARIO IMERSIVO -- o que fica no aparelho, por quanto tempo,
// e como se le o rascunho que a VERSAO SIMPLES deixou.
//
// Modulo PURO: recebe o `Storage` e o relogio por parametro, para os testes
// provarem expiracao e importacao sem navegador.
//
// PRIVACIDADE, DECLARADA (quem responde e adolescente, as respostas sao pessoais,
// e aparelho compartilhado acontece):
//   - o rascunho vive SO no localStorage deste aparelho. Nada vai para a URL, para
//     o servidor (antes do envio) ou para ferramenta de analise;
//   - ele EXPIRA: `PRAZO_DO_RASCUNHO_MS` (7 dias) contados da ultima resposta. A
//     cada leitura, rascunho vencido e apagado em vez de devolvido;
//   - a pessoa pode APAGAR quando quiser (`apagarRascunho`), e apagar remove
//     tambem o rascunho no formato da versao simples -- senao ele seria
//     reimportado na proxima visita e o "apagar" mentiria;
//   - enviado com sucesso, o rascunho sai do aparelho. Fica so a DATA do envio
//     (sem nome, sem e-mail, sem resposta), para a tela poder dizer "voce ja
//     enviou deste aparelho" -- e ela tambem expira.
//
// COMPATIBILIDADE COM A VERSAO SIMPLES (FormularioPublico.tsx): ela grava em
// `fort_formulario_<CODIGO>` um JSON `{ identificacao: {nome, email, telefone},
// respostas: {<id>: valor}, passo }`, sem data. Quem comecou la e abre a versao
// imersiva tem esse rascunho LIDO e retomado. Como ele nao tem data, nao ha como
// saber a idade dele: e tratado como recente, e a partir dali passa a valer o
// prazo deste formato.

import type { MapaDeRespostas, ValorDeResposta } from "../../../../lib/quiz/obrigatorias";
import { IDENTIFICACAO_VAZIA, type Identificacao } from "./roteiro";

export const PRAZO_DO_RASCUNHO_DIAS = 7;
export const PRAZO_DO_RASCUNHO_MS = PRAZO_DO_RASCUNHO_DIAS * 24 * 60 * 60 * 1000;

export type ArmazenamentoMinimo = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function chaveDoRascunhoImersivo(eventCode: string) {
  return `fort_formulario_imersivo_${eventCode}`;
}

/** A chave da versao simples. LIDA, nunca gravada daqui. */
export function chaveDoRascunhoSimples(eventCode: string) {
  return `fort_formulario_${eventCode}`;
}

export function chaveDoEnvio(eventCode: string) {
  return `fort_formulario_imersivo_enviado_${eventCode}`;
}

export interface Rascunho {
  identificacao: Identificacao;
  respostas: MapaDeRespostas;
  /** Id da tela em que a pessoa estava (`roteiro.ts`). Ausente no da versao simples. */
  telaId: string | null;
  /** Passo da versao simples (0 = dados, 1..N = etapa), quando veio de la. */
  passoSimples: number | null;
  origem: "imersivo" | "simples";
  salvoEm: number;
}

function ehValor(v: unknown): v is ValorDeResposta {
  return (
    typeof v === "string" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}

/** So entra o que tem formato de resposta: um rascunho corrompido nao quebra a tela. */
function limparRespostas(bruto: unknown): MapaDeRespostas {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const limpo: MapaDeRespostas = {};
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (ehValor(v)) limpo[k] = v;
  }
  return limpo;
}

function limparIdentificacao(bruto: unknown): Identificacao {
  if (!bruto || typeof bruto !== "object") return { ...IDENTIFICACAO_VAZIA };
  const b = bruto as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === "string" ? v : "");
  return { nome: texto(b.nome), email: texto(b.email), telefone: texto(b.telefone) };
}

function vazio(r: Pick<Rascunho, "identificacao" | "respostas">): boolean {
  const i = r.identificacao;
  return (
    Object.keys(r.respostas).length === 0 &&
    !i.nome.trim() &&
    !i.email.trim() &&
    !i.telefone.trim()
  );
}

function lerJson(storage: ArmazenamentoMinimo, chave: string): unknown {
  try {
    const bruto = storage.getItem(chave);
    return bruto ? JSON.parse(bruto) : null;
  } catch {
    return null;
  }
}

function remover(storage: ArmazenamentoMinimo, chave: string) {
  try {
    storage.removeItem(chave);
  } catch {
    // Armazenamento bloqueado: nao ha o que remover.
  }
}

/**
 * O rascunho deste evento neste aparelho, ou `null`. O formato proprio tem
 * prioridade; sem ele, importa o da versao simples.
 */
export function lerRascunho(
  storage: ArmazenamentoMinimo,
  eventCode: string,
  agora: number,
): Rascunho | null {
  const proprio = lerJson(storage, chaveDoRascunhoImersivo(eventCode)) as Record<
    string,
    unknown
  > | null;
  if (proprio && typeof proprio === "object") {
    const salvoEm = typeof proprio.salvoEm === "number" ? proprio.salvoEm : 0;
    if (agora - salvoEm > PRAZO_DO_RASCUNHO_MS) {
      // Vencido: apaga os dois formatos, para o simples nao "ressuscitar" o
      // que acabou de expirar.
      apagarRascunho(storage, eventCode);
      return null;
    }
    const r: Rascunho = {
      identificacao: limparIdentificacao(proprio.identificacao),
      respostas: limparRespostas(proprio.respostas),
      telaId: typeof proprio.telaId === "string" ? proprio.telaId : null,
      passoSimples: null,
      origem: "imersivo",
      salvoEm,
    };
    return vazio(r) ? null : r;
  }

  const simples = lerJson(storage, chaveDoRascunhoSimples(eventCode)) as Record<
    string,
    unknown
  > | null;
  if (simples && typeof simples === "object") {
    const r: Rascunho = {
      identificacao: limparIdentificacao(simples.identificacao),
      respostas: limparRespostas(simples.respostas),
      telaId: null,
      passoSimples: typeof simples.passo === "number" ? simples.passo : null,
      origem: "simples",
      salvoEm: agora,
    };
    return vazio(r) ? null : r;
  }
  return null;
}

export function gravarRascunho(
  storage: ArmazenamentoMinimo,
  eventCode: string,
  dados: { identificacao: Identificacao; respostas: MapaDeRespostas; telaId: string | null },
  agora: number,
): boolean {
  try {
    storage.setItem(
      chaveDoRascunhoImersivo(eventCode),
      JSON.stringify({ versao: 1, ...dados, salvoEm: agora }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Apaga o rascunho deste evento NOS DOIS FORMATOS. */
export function apagarRascunho(storage: ArmazenamentoMinimo, eventCode: string) {
  remover(storage, chaveDoRascunhoImersivo(eventCode));
  remover(storage, chaveDoRascunhoSimples(eventCode));
}

/** Enviado: sai o rascunho, fica so a data do envio. */
export function registrarEnvio(storage: ArmazenamentoMinimo, eventCode: string, agora: number) {
  apagarRascunho(storage, eventCode);
  try {
    storage.setItem(chaveDoEnvio(eventCode), JSON.stringify({ em: agora }));
  } catch {
    // Sem marca de envio: a tela final ja e a verdade desta sessao.
  }
}

/** A data do ultimo envio deste aparelho, se ainda dentro do prazo. */
export function lerEnvio(
  storage: ArmazenamentoMinimo,
  eventCode: string,
  agora: number,
): number | null {
  const d = lerJson(storage, chaveDoEnvio(eventCode)) as { em?: unknown } | null;
  if (!d || typeof d.em !== "number") return null;
  if (agora - d.em > PRAZO_DO_RASCUNHO_MS) {
    remover(storage, chaveDoEnvio(eventCode));
    return null;
  }
  return d.em;
}

export function esquecerEnvio(storage: ArmazenamentoMinimo, eventCode: string) {
  remover(storage, chaveDoEnvio(eventCode));
}
