import type { User } from "@supabase/supabase-js";
import type { CodigoDeErro } from "../erros/codigos";

// QUEM É ADMIN -- e, quando não é, POR QUE NÃO.
//
// A regra de quem é administrador NÃO mudou e não muda aqui:
// `app_metadata.role === "admin"`, a mesma claim que `is_admin()` checa no banco
// e que o `proxy.ts` exige nas páginas. O que este arquivo passou a fazer é
// separar os DESFECHOS de uma verificação de identidade.
//
// Antes, `getAdminUser()` chamava `supabase.auth.getUser()` e DESCARTAVA o erro:
//
//   const { data: { user } } = await supabase.auth.getUser();
//
// Com o `error` no lixo, um engasgo do GoTrue (rede, timeout, 502) virava
// `user === null`, que virava 403 "Não autorizado" na API e redirect mudo para o
// login nas páginas. Medido ao vivo numa jornada ponta a ponta (ver
// tests/jornada/jornada.mjs): `GET /api/jobs/status` respondeu 403 um segundo
// depois de `POST /api/jobs/enfileirar` ter ACEITO a mesma sessão de admin.
// Para quem opera o evento, "não consegui verificar" ficava indistinguível de
// "você não tem permissão" -- e a segunda conclusão é a que faz o host sair
// tentando entrar de novo com a credencial certa, que vai falhar de novo.
//
// São TRÊS desfechos, não dois:
//
//   autorizado      -> sessão verificada e com o papel de administrador;
//   ADMIN_FORBIDDEN -> sessão verificada, SEM o papel. É a única falta de permissão;
//   AUTH_REQUIRED   -> o serviço respondeu e afirmou que não há sessão utilizável;
//   AUTH_UNAVAILABLE-> o serviço NÃO respondeu a pergunta. Não é recusa de permissão.
//
// REGRA DE DESEMPATE, deliberada: na dúvida o desfecho é AUTH_UNAVAILABLE, nunca
// ADMIN_FORBIDDEN. Chamar de "sem permissão" algo que não foi verificado é
// exatamente a confusão que este arquivo existe para não repetir.
//
// NÃO É BRECHA: indisponibilidade BLOQUEIA, igual à recusa. `autorizado` só é
// `true` no caminho em que o serviço respondeu, trouxe um usuário e esse usuário
// tem a claim. Todo o resto -- erro, exceção, resposta em formato inesperado --
// cai em `autorizado: false`. O que muda é o que o operador vê e o que ele deve
// fazer, não quem entra.
//
// Os códigos vêm do vocabulário compartilhado em `lib/erros/codigos.ts` (o mesmo
// de QUIZ_STAGES_UNAVAILABLE e QUEUE_SCHEMA_MISSING), então o status HTTP e a
// mensagem do host já estão definidos lá e em `lib/erros/mensagens-host.ts`.
//
// Importes RELATIVOS e `lib/supabase/server` carregado SOB DEMANDA de propósito:
// `proxy.ts` importa este módulo e não pode arrastar `next/headers` para o
// bundle do proxy, e os testes não podem precisar do alias `@/` (o
// vitest.config.ts não resolve alias).

/** Os três desfechos de recusa, todos já presentes no vocabulário de erros. */
export type CodigoDeRecusaDeAdmin = Extract<
  CodigoDeErro,
  "AUTH_REQUIRED" | "ADMIN_FORBIDDEN" | "AUTH_UNAVAILABLE"
>;

export type ResultadoDeAdmin =
  | { autorizado: true; user: User }
  | {
      autorizado: false;
      codigo: CodigoDeRecusaDeAdmin;
      /**
       * O que realmente aconteceu, para o LOG DO SERVIDOR. Nunca vai para o
       * cliente: carrega só nome/status/código do erro observado, e jamais a
       * `message` do GoTrue -- quem investiga acha pela ocorrência.
       */
      causa: string;
    };

/** `true` quando o serviço de login respondeu e deu para saber quem é. */
export function foiVerificado(r: ResultadoDeAdmin): boolean {
  return r.autorizado || r.codigo !== "AUTH_UNAVAILABLE";
}

/** Forma mínima do erro de `auth.getUser()` que observamos. */
export interface ErroDeAuthObservado {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
}

interface RespostaDeGetUser {
  data?: { user?: User | null } | null;
  error?: unknown;
}

export interface ClienteDeAuth {
  auth: { getUser(): PromiseLike<RespostaDeGetUser> };
}

/** Resumo citável do erro, SEM a mensagem interna do serviço de login. */
function resumoDoErro(erro: ErroDeAuthObservado): string {
  return `${erro.name ?? "erro"} status=${erro.status ?? "?"} code=${erro.code ?? "?"}`;
}

function naoVerificado(causa: string): ResultadoDeAdmin {
  return { autorizado: false, codigo: "AUTH_UNAVAILABLE", causa };
}

/**
 * O serviço respondeu e disse "não há sessão" (AUTH_REQUIRED), ou não respondeu
 * a pergunta (AUTH_UNAVAILABLE)? Nunca ADMIN_FORBIDDEN: um erro de `getUser()`
 * não permite afirmar nada sobre o PAPEL de ninguém.
 *
 * Espelha `classificarErroDeAuth` em `lib/erros/diagnostico-auth.ts` (de outro
 * escopo). Um teste de deriva prende as duas a uma tabela comum.
 */
export function classificarFalhaDeAuth(erro: ErroDeAuthObservado): ResultadoDeAdmin {
  const causa = resumoDoErro(erro);

  // O serviço respondeu e afirmou que não há sessão utilizável.
  if (erro.name === "AuthSessionMissingError") {
    return { autorizado: false, codigo: "AUTH_REQUIRED", causa };
  }
  // Rede caída, timeout, 502/503/504: o serviço NÃO respondeu a pergunta.
  if (erro.name === "AuthRetryableFetchError") return naoVerificado(causa);

  const status = erro.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    // 4xx do serviço: token inválido, expirado, usuário removido. Veredito.
    return { autorizado: false, codigo: "AUTH_REQUIRED", causa };
  }
  // 5xx, status 0/ausente ou formato que não reconhecemos: não verificado.
  return naoVerificado(causa);
}

/**
 * Decide os três desfechos a partir de um cliente qualquer que saiba
 * `auth.getUser()`. É o que o `proxy.ts` usa (ele monta o próprio cliente, com
 * os cookies do request) e o que os testes injetam.
 *
 * Não lança: toda saída é um `ResultadoDeAdmin`.
 */
export async function verificarAdminCom(cliente: ClienteDeAuth): Promise<ResultadoDeAdmin> {
  let resposta: RespostaDeGetUser;
  try {
    resposta = await cliente.auth.getUser();
  } catch (e) {
    // Exceção ao falar com o serviço: DNS, socket, abort. Não verificado.
    return naoVerificado(
      `exceção ao consultar o serviço de login: ${e instanceof Error ? e.name : typeof e}`
    );
  }

  if (!resposta || typeof resposta !== "object") {
    return naoVerificado("resposta do serviço de login em formato inesperado (sem objeto)");
  }

  const { data, error } = resposta;
  if (error) return classificarFalhaDeAuth(error as ErroDeAuthObservado);

  // Sem erro e sem o envelope `data`: não é o contrato do cliente. Não dá para
  // afirmar que a pessoa não tem sessão -- só que não sabemos.
  if (data === null || data === undefined) {
    return naoVerificado("resposta do serviço de login sem erro e sem `data`");
  }

  const user = data.user ?? null;
  // O serviço respondeu que não há usuário nesta sessão: veredito, não engasgo.
  if (!user) return { autorizado: false, codigo: "AUTH_REQUIRED", causa: "getUser sem erro e sem usuário" };

  if (typeof user !== "object" || typeof (user as User).id !== "string") {
    return naoVerificado("usuário devolvido pelo serviço de login em formato inesperado");
  }

  if (!isAdminUser(user as { app_metadata?: { role?: string } })) {
    return {
      autorizado: false,
      codigo: "ADMIN_FORBIDDEN",
      causa: "sessão válida sem papel de administrador",
    };
  }

  return { autorizado: true, user };
}

/**
 * Os três desfechos para quem roda em rota de API ou Server Component (usa os
 * cookies via `next/headers`).
 */
export async function verificarAdmin(): Promise<ResultadoDeAdmin> {
  let cliente: ClienteDeAuth;
  try {
    // Sob demanda: mantém `next/headers` fora do bundle do proxy e dos testes.
    const { createClient } = await import("../supabase/server");
    cliente = (await createClient()) as unknown as ClienteDeAuth;
  } catch (e) {
    // Nem o cliente subiu (env ausente, cookies indisponíveis): não verificado.
    return naoVerificado(
      `não foi possível montar o cliente de login: ${e instanceof Error ? e.name : typeof e}`
    );
  }
  return verificarAdminCom(cliente);
}

/**
 * Compatibilidade: devolve o usuário admin ou `null`, sem dizer por quê.
 *
 * Os chamadores em `app/api/**` (outro escopo) ainda usam esta forma e perdem a
 * distinção -- `null` continua querendo dizer três coisas para quem olha só o
 * retorno. Quem precisa do desfecho deve chamar `verificarAdmin()`. As rotas que
 * precisam migrar estão listadas no relatório desta unidade.
 */
export async function getAdminUser(): Promise<User | null> {
  const r = await verificarAdmin();
  return r.autorizado ? r.user : null;
}

export function isAdminUser(user: { app_metadata?: { role?: string } } | null): boolean {
  return user?.app_metadata?.role === "admin";
}
