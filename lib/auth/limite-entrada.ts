/*
 * Contencao de tentativas da entrada por codigo (rotas /api/entrar/*).
 *
 * O QUE E: janela deslizante EM MEMORIA, por chave (IP, e-mail informado, ou
 * "global"). Cada chamada que passa registra um carimbo de tempo; passou do
 * maximo dentro da janela, recusa e diz em quantos segundos libera.
 *
 * O QUE ISTO NAO E (limitacao honesta, leia antes de confiar):
 *   - Vive na memoria do processo. Some a cada deploy/reinicio e NAO e
 *     compartilhada entre instancias: em serverless (Vercel) cada instancia tem
 *     o seu mapa, entao o teto real e (limite x numero de instancias vivas).
 *   - O Supabase Auth (GoTrue) fica ABERTO na internet com a anon key, que e
 *     publica: quem quiser pode chamar /auth/v1/otp e /auth/v1/verify direto,
 *     sem passar por aqui. Este limitador protege o CAMINHO DO APP e segura
 *     abuso casual; a defesa que vale contra atacante determinado sao os
 *     limites do proprio Supabase Auth (docs/OTP-E-MAIL.md, secao "Limites") e,
 *     para entrega/cota de e-mail, o painel do Resend.
 *   - A chave de IP depende de cabecalho. Atras da Vercel, x-forwarded-for e
 *     reescrito pela plataforma e serve. Fora dela, o cliente pode forjar o
 *     cabecalho e trocar de "IP" a cada chamada; os limites por e-mail e global
 *     continuam valendo, o por IP nao.
 *   - A chave de e-mail e o texto informado (minusculo), nao a conta: "a+1@x" e
 *     "a+2@x" sao chaves diferentes. A decisao NUNCA depende de a conta existir,
 *     por isso o limitador nao vira oraculo de existencia.
 *
 * Para contencao de verdade entre instancias: store compartilhado (Redis/Upstash
 * ou uma tabela no Postgres com UPDATE atomico). Fora do escopo desta entrega.
 */

export interface Limitador {
  /** Registra uma tentativa e diz se ela passa. */
  tenta(chave: string): { ok: true } | { ok: false; retryAfterS: number };
  /** Esquece a chave (ex.: apos sucesso). */
  zera(chave: string): void;
  /** So para teste. */
  tamanho(): number;
}

export function criaLimitador(opts: {
  janelaMs: number;
  max: number;
  /** Teto de chaves guardadas; passou disso, chaves antigas sao descartadas. */
  maxChaves?: number;
  agora?: () => number;
}): Limitador {
  const { janelaMs, max } = opts;
  const maxChaves = opts.maxChaves ?? 5000;
  const agora = opts.agora ?? Date.now;
  const mapa = new Map<string, number[]>();
  let ultimaLimpeza = 0;

  function limpa(now: number) {
    // No maximo uma varredura por segundo: barato mesmo sob rajada.
    if (now - ultimaLimpeza < 1000 && mapa.size <= maxChaves) return;
    ultimaLimpeza = now;
    for (const [k, stamps] of mapa) {
      const frescos = stamps.filter((t) => now - t < janelaMs);
      if (frescos.length === 0) mapa.delete(k);
      else mapa.set(k, frescos);
    }
    // Ainda acima do teto (rajada de chaves distintas): descarta as mais antigas.
    // Map preserva ordem de insercao; a chave mais velha vem primeiro.
    while (mapa.size > maxChaves) {
      const primeira = mapa.keys().next().value;
      if (primeira === undefined) break;
      mapa.delete(primeira);
    }
  }

  return {
    tenta(chave) {
      const now = agora();
      limpa(now);
      const hits = (mapa.get(chave) ?? []).filter((t) => now - t < janelaMs);
      if (hits.length >= max) {
        const retryAfterS = Math.max(1, Math.ceil((hits[0] + janelaMs - now) / 1000));
        mapa.set(chave, hits);
        return { ok: false, retryAfterS };
      }
      hits.push(now);
      // delete + set move a chave para o fim (mais recente) na ordem do Map.
      mapa.delete(chave);
      mapa.set(chave, hits);
      return { ok: true };
    },
    zera(chave) {
      mapa.delete(chave);
    },
    tamanho() {
      return mapa.size;
    },
  };
}

/**
 * IP do cliente. Na Vercel o x-forwarded-for e reescrito pela plataforma; o
 * primeiro item e o cliente. Sem cabecalho, devolve "desconhecido" (todos os
 * sem-IP dividem um balde: falha para o lado restritivo, nao para o aberto).
 */
export function ipDoCliente(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const primeiro = fwd.split(",")[0]?.trim();
    if (primeiro) return primeiro.slice(0, 64);
  }
  return (headers.get("x-real-ip") ?? "desconhecido").slice(0, 64);
}

// ---------------------------------------------------------------------------
// Instancias compartilhadas pelas duas rotas (um mapa por processo).
// Numeros pensados para um evento de ate ~20 pessoas entrando ao mesmo tempo,
// muitas delas na MESMA rede do local (mesmo IP): por isso o limite por IP
// (60 pedidos / 10 min) e folgado, e o que realmente segura e-mail-bomba e o por e-mail.
// ---------------------------------------------------------------------------

/** Pedidos de codigo por IP. */
export const pedidosPorIp = criaLimitador({ janelaMs: 10 * 60_000, max: 60 });
/** Pedidos de codigo por e-mail informado: nao vira maquina de mandar e-mail a um alvo. */
export const pedidosPorEmail = criaLimitador({ janelaMs: 15 * 60_000, max: 5 });
/** Teto de e-mails enviados por este processo por hora: protege a cota do provedor. */
export const pedidosGlobal = criaLimitador({ janelaMs: 60 * 60_000, max: 300 });

/** Tentativas de verificar codigo por e-mail: 8 palpites / 15 min contra 10^6 combinacoes. */
export const verificacoesPorEmail = criaLimitador({ janelaMs: 15 * 60_000, max: 8 });
/** Tentativas de verificar por IP. */
export const verificacoesPorIp = criaLimitador({ janelaMs: 15 * 60_000, max: 60 });
