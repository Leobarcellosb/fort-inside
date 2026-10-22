import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { verificarAdminCom } from "./lib/auth/require-admin";
import { novaOcorrencia } from "./lib/erros/codigos";
import { mensagemParaHost } from "./lib/erros/mensagens-host";

// PORTÃO DAS PÁGINAS /admin/*.
//
// A REGRA de quem é admin não está aqui e não mudou: é `verificarAdminCom()`, que
// exige `app_metadata.role === "admin"` -- a mesma claim que `is_admin()` checa no
// banco. O que este arquivo decide é o TRATAMENTO DO DESFECHO.
//
// Antes, o `error` de `getUser()` era descartado: qualquer engasgo do GoTrue virava
// `user === null`, virava "não é admin", e virava redirect para o login. Nas páginas
// esse é o pior formato possível para uma indisponibilidade: quem está logado e é
// mandado para o login SEM EXPLICAÇÃO conclui que perdeu a sessão, e vai tentar
// entrar de novo com a credencial certa -- que vai falhar de novo, porque o problema
// nunca foi a credencial. No dia do evento isso é o host sendo expulso do painel no
// meio da condução, na frente de 50 pessoas, sem nada na tela que diga o que fazer.
//
// Os três desfechos, e o formato de cada um:
//
//   autorizado       -> segue para a página;
//   AUTH_REQUIRED    -> redirect para /admin/login?next=... (CORRETO: realmente
//                       precisa entrar. Comportamento preservado);
//   ADMIN_FORBIDDEN  -> redirect para /admin/login?next=... (preservado: é como a
//                       suíte de segurança já exige que participante e anônimo sejam
//                       barrados em /admin/*);
//   AUTH_UNAVAILABLE -> 503 com PÁGINA EXPLICATIVA, sem redirect. Diz que a sessão
//                       não pôde ser confirmada, que isso NÃO significa perda de
//                       permissão, e traz a ocorrência para o host informar à equipe.
//
// INDISPONIBILIDADE BLOQUEIA. A 503 é devolvida NO LUGAR de `response`: a página de
// /admin/* não é renderizada nem enviada. Ninguém atravessa por este caminho; o que
// muda é só o que o operador lê.

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect admin routes (not login)
  if (!pathname.startsWith("/admin") || pathname.startsWith("/admin/login")) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Being signed in is NOT enough: every participant gets a Supabase session
  // when they join an event, so a bare `!user` check let them reach /admin/*
  // — including /admin/nps, which reads with service_role and bypasses RLS.
  // Require the same claim the is_admin() RLS helper checks.
  const resultado = await verificarAdminCom(supabase);

  if (resultado.autorizado) return response;

  if (resultado.codigo === "AUTH_UNAVAILABLE") {
    const ocorrencia = novaOcorrencia();
    // A causa (nome/status/código do erro observado) fica SÓ aqui, no log do
    // servidor. Nunca na página: o host recebe a ocorrência, e quem investiga
    // encontra a causa por ela.
    //
    // Só o desfecho operacional é registrado, como em `erroHttp` (que loga a
    // partir do 500): anônimo batendo em /admin é rotina, não incidente, e
    // encher o log disso esconderia justamente a linha que importa.
    console.error("[erro]", {
      ocorrencia,
      codigo: resultado.codigo,
      rota: pathname,
      causa: resultado.causa,
    });
    return paginaDeIndisponibilidade(request, response, ocorrencia);
  }

  const loginUrl = new URL("/admin/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  const redirectResponse = NextResponse.redirect(loginUrl);
  // Propagate cookies set/cleared by Supabase during the session refresh attempt.
  // Without this, a failed refresh leaves stale tokens in the browser and can
  // trigger a login <-> admin redirect loop.
  response.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });
  return redirectResponse;
}

const escapaHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A 503 que o host lê quando não deu para verificar a sessão.
 *
 * O texto vem de `mensagemParaHost("AUTH_UNAVAILABLE")`, o mesmo que a interface
 * mostra quando uma rota de API devolve esse código: a explicação não é reescrita
 * em dois lugares.
 *
 * `Retry-After` e o link de recarregar dizem o que fazer (esperar e tentar de novo).
 * O link para o login existe, mas é escolha do host -- não um redirect automático
 * que o faria concluir que perdeu a sessão.
 */
function paginaDeIndisponibilidade(
  request: NextRequest,
  response: NextResponse,
  ocorrencia: string
) {
  const mensagem = escapaHtml(mensagemParaHost("AUTH_UNAVAILABLE"));
  const destino = escapaHtml(request.nextUrl.pathname + request.nextUrl.search);

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Não foi possível verificar a sessão</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; background:#0b0b0c; color:#f4f4f5;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.6; }
  main { max-width:33rem; }
  p.rotulo { margin:0 0 .5rem; font-size:.7rem; letter-spacing:.18em; text-transform:uppercase; color:#a1a1aa; }
  h1 { margin:0 0 1rem; font-size:1.5rem; font-weight:700; }
  p { margin:0 0 1rem; }
  .acoes { display:flex; gap:1rem; flex-wrap:wrap; margin:1.5rem 0 1rem; }
  a { color:#f4f4f5; text-decoration:none; border:1px solid #3f3f46; border-radius:.375rem;
      padding:.65rem 1.1rem; font-size:.85rem; }
  a.primario { background:#f4f4f5; color:#0b0b0c; border-color:#f4f4f5; }
  .ocorrencia { font-size:.8rem; color:#a1a1aa; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:#f4f4f5; }
</style>
</head>
<body>
<main>
  <p class="rotulo">Painel do administrador</p>
  <h1>Não foi possível verificar sua sessão</h1>
  <p>${mensagem}</p>
  <p>Você <strong>não</strong> foi desconectado e <strong>não</strong> perdeu o acesso: o
  painel apenas não conseguiu confirmar sua identidade agora, então não foi aberto.
  Entrar de novo não resolve este caso.</p>
  <div class="acoes">
    <a class="primario" href="${destino}">Tentar de novo</a>
    <a href="/admin/login?next=${encodeURIComponent(destino)}">Entrar com outra conta</a>
  </div>
  <p class="ocorrencia">Se persistir, informe esta ocorrência à equipe técnica:
  <code>${escapaHtml(ocorrencia)}</code></p>
</main>
</body>
</html>`;

  const indisponivel = new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Diz ao host (e a qualquer cliente) que é para tentar de novo, não que falta permissão.
      "retry-after": "5",
      "cache-control": "no-store",
      // Deixa o desfecho legível por máquina sem precisar interpretar o HTML:
      // é o mesmo vocabulário de `lib/erros/codigos.ts`.
      "x-codigo-erro": "AUTH_UNAVAILABLE",
      "x-ocorrencia": ocorrencia,
    },
  });
  // Mesma propagação do caminho de redirect: se o cliente de login mexeu nos
  // cookies durante a tentativa, o navegador recebe o estado atual em vez de
  // ficar com token velho.
  response.cookies.getAll().forEach((cookie) => {
    indisponivel.cookies.set(cookie);
  });
  return indisponivel;
}

// O nome do export importa: o Next 16 reconhece `config`, NAO `proxyConfig`.
// Com o nome errado o matcher era silenciosamente ignorado -- o manifesto
// construido (.next/server/functions-config-manifest.json) mostrava
// "originalSource": "/:path*" e regexp "^.*$", ou seja, o proxy rodava em TODA
// requisicao, inclusive assets estaticos e todas as rotas de API. Nao era
// brecha, porque o `if` de pathname la em cima ja filtrava, mas a seguranca
// dependia inteiramente desse `if` e nao do matcher declarado, e todo request
// do app pagava uma execucao de proxy a toa.
export const config = {
  matcher: ["/admin/:path*"],
};
