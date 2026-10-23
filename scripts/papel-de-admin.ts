// Concede ou revoga o papel de administrador de UMA conta, pela API
// administrativa do Supabase (Rodada 81 do CTO). Roda so no terminal do
// proprietario: a chave de servico nunca vai para o navegador nem para o chat.
//
// Uso (a chave e o endereco ficam so nesta janela do terminal):
//   export SUPABASE_URL="https://<projeto>.supabase.co"
//   export SUPABASE_SERVICE_ROLE_KEY="<chave service_role do painel do Supabase>"
//   npx tsx scripts/papel-de-admin.ts --projeto <projeto> --email pessoa@dominio
//   npx tsx scripts/papel-de-admin.ts --projeto <projeto> --email pessoa@dominio --confirmar
//   npx tsx scripts/papel-de-admin.ts --projeto <projeto> --email pessoa@dominio --revogar --confirmar
//
// Sem --confirmar, so mostra o que faria. A conta precisa existir antes
// (Supabase > Authentication > Add user).

import { createClient } from "@supabase/supabase-js";
import { appMetadataComPapel, enderecoDoProjeto, type AcaoSobreOPapel } from "../lib/admin/papel-de-admin";

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

function parar(mensagem: string): never {
  console.error(`ERRO: ${mensagem}`);
  process.exit(1);
}

async function main() {
  const url = process.env.SUPABASE_URL ?? "";
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const projeto = argumento("projeto");
  const email = argumento("email")?.trim().toLowerCase() ?? null;
  const acao: AcaoSobreOPapel = process.argv.includes("--revogar") ? "revogar" : "conceder";
  const confirmar = process.argv.includes("--confirmar");

  if (!projeto) parar("informe --projeto (o identificador do projeto no Supabase).");
  if (!email) parar("informe --email da conta.");
  if (!url || !chave) parar("defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY neste terminal.");
  if (!enderecoDoProjeto(url, projeto)) parar(`SUPABASE_URL nao e o projeto ${projeto}. Nada foi feito.`);

  const supabase = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });

  // Procura a conta pelo e-mail, pagina por pagina.
  let usuario: { id: string; email?: string; app_metadata: Record<string, unknown> } | null = null;
  for (let pagina = 1; !usuario; pagina++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page: pagina, perPage: 1000 });
    if (error) parar(`nao foi possivel listar as contas: ${error.message}`);
    usuario = data.users.find((u) => u.email?.toLowerCase() === email) ?? null;
    if (data.users.length < 1000) break;
  }
  if (!usuario) parar(`nenhuma conta com o e-mail ${email}. Crie em Authentication > Add user.`);

  const antes = usuario.app_metadata?.role ?? "(nenhum)";
  const novo = appMetadataComPapel(usuario.app_metadata, acao);
  console.log(`conta: ${email}`);
  console.log(`papel antes: ${antes}`);
  console.log(`acao: ${acao}`);

  if (!confirmar) {
    console.log(`papel depois (simulado): ${novo.role ?? "(nenhum)"}`);
    console.log("Nada foi alterado. Repita com --confirmar para aplicar.");
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(usuario.id, { app_metadata: novo });
  if (error) parar(`a alteracao falhou: ${error.message}`);

  const { data: relido, error: erroRelido } = await supabase.auth.admin.getUserById(usuario.id);
  if (erroRelido) parar(`alterado, mas nao foi possivel reler: ${erroRelido.message}`);
  console.log(`papel depois (relido no Supabase): ${relido.user.app_metadata?.role ?? "(nenhum)"}`);
  console.log("A pessoa precisa sair e entrar de novo no painel para o papel valer na sessao dela.");
}

main().catch((e) => parar(e instanceof Error ? e.message : String(e)));
