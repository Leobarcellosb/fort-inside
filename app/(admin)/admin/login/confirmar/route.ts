import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { destinoSeguro, lerRetorno } from "@/lib/auth/retorno-do-email";

// VOLTA DO LINK DO E-MAIL (entrar sem senha e redefinir a senha).
//
// Troca o que veio no link por uma sessao, gravada em cookie pelo cliente de
// servidor, e manda para o destino. Fica embaixo de /admin/login de proposito: o
// proxy nao protege esse caminho, porque aqui a pessoa ainda nao tem sessao.
//
// Ter sessao nao e ser administrador. Quem nao tem o papel volta para o login pelo
// proprio proxy ao tentar abrir o painel; esta rota nao decide permissao.
//
// Link vencido, ja usado ou aberto em outro navegador (o PKCE exige o mesmo):
// volta para o login com `?link=invalido`, que a tela explica. A causa so vai
// para o log do servidor.

// O endereco pelo qual a pessoa CHEGOU. `nextUrl.origin` pode vir normalizado
// pelo servidor (127.0.0.1 virando localhost, por exemplo), e devolver a pessoa
// a outro endereco deixa a sessao nova num lugar e a pagina em outro: no ensaio
// local, isso fez a senha ser trocada numa sessao antiga de outra conta.
function origemDaRequisicao(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const origem = origemDaRequisicao(request);
  const destino = destinoSeguro(url.searchParams.get("next"));
  const retorno = lerRetorno(url.searchParams);

  const supabase = await createClient();
  let erro: string | null = null;

  if (retorno.tipo === "codigo") {
    const { error } = await supabase.auth.exchangeCodeForSession(retorno.code);
    if (error) erro = `${error.name}: ${error.message}`;
  } else if (retorno.tipo === "token") {
    const { error } = await supabase.auth.verifyOtp({ token_hash: retorno.tokenHash, type: retorno.type });
    if (error) erro = `${error.name}: ${error.message}`;
  } else {
    erro = "link sem code nem token_hash";
  }

  if (erro) {
    console.error("[login-por-email] link recusado", { causa: erro });
    const login = new URL("/admin/login", origem);
    login.searchParams.set("link", "invalido");
    return NextResponse.redirect(login);
  }

  return NextResponse.redirect(new URL(destino, origem));
}
