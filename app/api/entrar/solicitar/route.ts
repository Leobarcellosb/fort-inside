import { NextRequest, NextResponse } from "next/server";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  pedidosGlobal,
  pedidosPorEmail,
  pedidosPorIp,
  ipDoCliente,
} from "@/lib/auth/limite-entrada";
import {
  DADOS_INVALIDOS,
  ERRO_INTERNO,
  EVENTO_NAO_ENCONTRADO,
  NO_STORE,
  buscaEventoAberto,
  emailSchema,
  envioIndisponivel,
  erro,
  eventoSchema,
  leCorpoJson,
} from "@/lib/auth/entrada";

/*
 * ============================================================================
 * ENTRADA POR CODIGO, PASSO 1: PEDIR O CODIGO  (POST /api/entrar/solicitar)
 * ============================================================================
 *
 * Substitui a entrada "so com e-mail" que /api/join-event fazia (e que foi
 * contida: ver o comentario no topo daquela rota). Aqui ninguem recebe sessao
 * por informar um e-mail. A sessao so nasce em /api/entrar/verificar, depois
 * que a pessoa prova que le a caixa de entrada (OTP do Supabase Auth, enviado
 * por SMTP; o provedor escolhido e o Resend, ver docs/OTP-E-MAIL.md).
 *
 * REGRAS QUE ESTA ROTA NAO PODE VIOLAR
 *   1. Resposta IDENTICA (status e corpo, byte a byte) exista a conta ou nao,
 *      seja admin ou participante. Nada de "conta nova"/"conta existente".
 *      Nem o limitador depende da existencia da conta (a chave e o texto do
 *      e-mail informado).
 *   2. Nenhuma credencial, token, link magico, nem Set-Cookie na resposta. O
 *      cliente usado aqui e supabase-js "puro" (sem cookies, sem PKCE).
 *   3. Conta pre-sequestrada: um e-mail inedito vira usuario NAO CONFIRMADO
 *      (email_confirm:false) e sem sessao. Quem digitou o e-mail alheio nao
 *      ganha refresh token nenhum; a conta so e confirmada quando o dono do
 *      e-mail digita o codigo.
 *   4. Mensagem de erro do GoTrue NUNCA vai ao cliente: so code/status no log
 *      do servidor (a mensagem pode conter o e-mail).
 *   5. Corpo malformado => 400, nunca 500.
 *   6. Validacao e contencao ANTES do trabalho caro (consulta ao banco, criar
 *      usuario, enviar e-mail).
 *
 * POR QUE PRE-CRIAR O USUARIO (admin.createUser) EM VEZ DE shouldCreateUser:true
 *   Para a rota controlar QUANDO a conta nasce (so apos validar evento e passar
 *   pela contencao) e para o e-mail inedito percorrer o MESMO caminho do
 *   existente: a chamada e feita SEMPRE (existente ou nao: o GoTrue responde
 *   email_exists e seguimos), entao as duas ramificacoes fazem o mesmo trabalho.
 *   O usuario nasce NAO confirmado e sem senha; o proprio codigo o confirma.
 *   ATENCAO (testado): o GoTrue trata o envio de codigo a usuario ainda nao
 *   confirmado como cadastro. Com "Allow new users to sign up" DESLIGADO no
 *   Supabase ele recusa com signup_disabled, e a entrada de gente nova para de
 *   funcionar (aqui vira 503 + log). Esse ajuste PRECISA ficar LIGADO; ver
 *   docs/OTP-E-MAIL.md.
 *
 * FALHA SEGURA DO ENVIO
 *   Se o SMTP nao estiver configurado/funcionando, o GoTrue devolve erro de
 *   envio. Respondemos 503 "envio_de_codigo_indisponivel" (legivel, sem
 *   detalhe tecnico) e logamos code/status. Nunca fingimos que enviou.
 * ============================================================================
 */

const bodySchema = z.object({
  email: emailSchema,
  ...eventoSchema,
});

// Resposta ÚNICA do caminho feliz. Nao varia com nada que dependa da conta.
// Nao cita quantidade de digitos (configuravel no Supabase).
const RESPOSTA_ENVIADO = {
  ok: true,
  mensagem:
    "Se o e-mail estiver correto, enviamos um código de uso único para ele. Digite o código para entrar. Confira também a caixa de spam.",
} as const;

function enviado() {
  return NextResponse.json(RESPOSTA_ENVIADO, { status: 200, headers: NO_STORE });
}

function limitado(retryAfterS: number) {
  return erro(429, "Muitos pedidos de código. Aguarde alguns minutos e tente de novo.", {
    codigo: "limite_de_pedidos",
    retryAfterS,
  });
}

export async function POST(req: NextRequest) {
  // 1. Corpo e validacao (barato, sem rede).
  const body = await leCorpoJson(req);
  if (body === null) return erro(400, DADOS_INVALIDOS);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return erro(400, DADOS_INVALIDOS);
  const { email, event_id, event_code } = parsed.data;

  // 2. Contencao ANTES de tocar no banco/GoTrue. Ver lib/auth/limite-entrada.ts
  //    para o que isso garante e o que nao garante.
  const ip = ipDoCliente(req.headers);
  const porIp = pedidosPorIp.tenta(ip);
  if (!porIp.ok) return limitado(porIp.retryAfterS);
  const porEmail = pedidosPorEmail.tenta(email);
  if (!porEmail.ok) return limitado(porEmail.retryAfterS);
  const global = pedidosGlobal.tenta("global");
  if (!global.ok) return limitado(global.retryAfterS);

  // 3. Evento valido (leitura barata) antes de criar usuario/mandar e-mail.
  const evento = await buscaEventoAberto(event_id, event_code);
  if (!evento) return erro(404, EVENTO_NAO_ENCONTRADO);

  // 4. Garante que o usuario existe, NAO confirmado e sem senha (regra 3).
  //    email_exists = conta ja existia (participante, admin, qualquer): segue,
  //    sem tocar nela. Outros erros: nao ha o que enviar.
  const admin = createAdminClient();
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: false,
  });
  if (createError) {
    const jaExiste =
      createError.code === "email_exists" ||
      createError.code === "user_already_exists" ||
      /already been registered/i.test(createError.message);
    if (!jaExiste) {
      console.error("[entrar/solicitar] falha ao preparar usuario", {
        code: createError.code,
        status: createError.status,
      });
      return erro(500, ERRO_INTERNO);
    }
  }

  // 5. Pede o codigo. supabase-js puro: sem cookies, sem PKCE, sem persistencia.
  const anon = createAnonClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  const { error: otpError } = await anon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });

  if (otpError) {
    // So code/status. A mensagem do GoTrue pode conter o e-mail e detalhes de SMTP.
    console.error("[entrar/solicitar] falha ao pedir codigo", {
      code: otpError.code,
      status: otpError.status,
    });

    if (otpError.code === "signup_disabled") {
      console.error(
        "[entrar/solicitar] CONFIGURACAO: ligue 'Allow new users to sign up' no Supabase Auth (ver docs/OTP-E-MAIL.md)"
      );
    }

    // Rate limit do proprio GoTrue (frequencia por usuario ou cota de e-mail).
    // Vale igual para conta existente e inexistente (o usuario ja foi
    // pre-criado acima), portanto nao e oraculo.
    if (otpError.status === 429) {
      return erro(429, "Aguarde um minuto antes de pedir outro código. O anterior ainda vale.", {
        codigo: "aguarde_para_reenviar",
        retryAfterS: 60,
      });
    }

    // Endereco recusado pelo GoTrue por ser invalido. Depende so do endereco.
    if (otpError.code === "email_address_invalid") {
      return erro(400, "Não conseguimos enviar para este e-mail. Confira o endereço.");
    }

    // SMTP ausente/quebrado, e-mail nao autorizado pelo SMTP padrao, 5xx, ou
    // qualquer outra coisa: envio indisponivel. Falha segura e legivel.
    return envioIndisponivel();
  }

  return enviado();
}
