// Mutações usadas pelo teste de sensibilidade (scripts/test-seguranca-http-sensibilidade.sh).
// Cada uma REMOVE uma verificação de autorização num clone descartável - nunca no
// checkout real. Uma mutação que não altera o arquivo (padrão não encontrado) é
// ERRO: senão o teste de sensibilidade passaria "detectando" uma mutação que nunca
// aconteceu.
//
// Uso:  node mutacoes.mjs --lista
//       node mutacoes.mjs <id> <diretorio-do-clone>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MUTACOES = {
  m1: {
    cenario: 1,
    descricao: "proxy.ts: aceita QUALQUER usuário autenticado em /admin/* (a falha original)",
    arquivo: "proxy.ts",
    de: 'user?.app_metadata?.role === "admin"',
    para: "!!user",
  },
  m2: {
    cenario: 2,
    descricao: "knowledge-base: remove o guarda de admin dos 3 handlers (GET/POST/DELETE)",
    arquivo: "app/api/knowledge-base/route.ts",
    de: "if (!(await getAdminUser())) return forbidden();",
    para: "/* mutação m2: guarda removido */",
    todas: true,
    minimo: 3,
  },
  m3: {
    cenario: 3,
    descricao: "batch-process: remove o guarda de admin (dispara IA por participante)",
    arquivo: "app/api/batch-process/route.ts",
    // A rota usa verificarAdmin() (três desfechos). O texto-guarda mudou junto com
    // ela; `aplica()` recusa a mutação se o padrão sumir (mutação obsoleta é erro).
    de: "if (!admin.autorizado) {",
    para: "if (false) {",
  },
  m4: {
    cenario: 4,
    descricao: "generate-prognostic: remove o guarda de admin (participante qualquer volta a gerar prognóstico, inclusive o alheio)",
    arquivo: "app/api/generate-prognostic/route.ts",
    de: 'if (user.app_metadata?.role !== "admin") {',
    para: "if (false) {",
  },
  m4c: {
    cenario: 6,
    descricao: "generate-prognostic: o MESMO guarda removido, visto pelo cenário 6 (participante gerando o PRÓPRIO prognóstico deve ser 403)",
    arquivo: "app/api/generate-prognostic/route.ts",
    de: 'if (user.app_metadata?.role !== "admin") {',
    para: "if (false) {",
  },
  m4b: {
    cenario: 4,
    descricao: "generate-pdf: remove o guarda de admin do ramo { prognostic_id }",
    arquivo: "app/api/generate-pdf/route.ts",
    de: "if (!(await getAdminUser())) {",
    para: "if (false) {",
  },
  m5: {
    cenario: 5,
    descricao: "join-event: volta a REDEFINIR a senha da conta existente e a DEVOLVÊ-LA no corpo (a tomada de conta original)",
    arquivo: "app/api/join-event/route.ts",
    de: "if (jaExiste) return entradaIndisponivel();",
    para: `if (jaExiste) {
      const novaSenha = randomBytes(24).toString("base64url");
      const { data: lista } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const alvoMut = lista?.users.find((x) => x.email === email);
      if (alvoMut) {
        await supabase.auth.admin.updateUserById(alvoMut.id, { password: novaSenha });
        return NextResponse.json({ password: novaSenha });
      }
      return entradaIndisponivel();
    }`,
  },
  m5b: {
    cenario: 5,
    descricao: "join-event: volta a responder 403 SÓ para administrador (o oráculo que enumera e-mails de admin)",
    arquivo: "app/api/join-event/route.ts",
    de: "if (jaExiste) return entradaIndisponivel();",
    para: `if (jaExiste) {
      const { data: lista } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const alvoMut = lista?.users.find((x) => x.email === email);
      if (alvoMut?.app_metadata?.role === "admin") {
        return NextResponse.json({ error: "Acesso de administrador" }, { status: 403 });
      }
      return entradaIndisponivel();
    }`,
  },
  m5c: {
    cenario: 6,
    descricao: "join-event: e-mail INÉDITO volta a receber a senha na resposta (conta pré-sequestrada)",
    arquivo: "app/api/join-event/route.ts",
    de: "const userId = created.user.id;",
    para: "const userId = created.user.id;\n  if (userId) return NextResponse.json({ password: senhaDescartavel, participant_id: null });",
  },
  m6: {
    cenario: 7,
    descricao: "complete-quiz: remove a checagem de dono (qualquer logado conclui em nome de outra pessoa)",
    arquivo: "app/api/complete-quiz/route.ts",
    de: "if (!participant || !participant.user_id || participant.user_id !== user.id) {",
    para: "if (!participant) {",
  },
  m7: {
    cenario: 7,
    descricao: "complete-quiz: remove a conferência de etapas pendentes (o participante AFIRMA que terminou e o servidor acredita)",
    arquivo: "app/api/complete-quiz/route.ts",
    de: "if (pendentes.length > 0) {",
    para: "if (false) {",
  },
  m8: {
    cenario: 6,
    descricao: "batch-process: documento já avançado deixa de ser 'pulado' e volta a contar como falha",
    arquivo: "app/api/batch-process/route.ts",
    de: "r.value.status === 409",
    para: "r.value.status === 40900",
  },
};

function aplica(id, dir) {
  const m = MUTACOES[id];
  if (!m) throw new Error(`mutação desconhecida: ${id}`);
  const caminho = join(dir, m.arquivo);
  const original = readFileSync(caminho, "utf8");
  const ocorrencias = original.split(m.de).length - 1;
  if (ocorrencias < (m.minimo ?? 1)) {
    throw new Error(`${id}: padrão encontrado ${ocorrencias}x em ${m.arquivo} (esperado >= ${m.minimo ?? 1}); a mutação ficou obsoleta`);
  }
  const mutado = m.todas ? original.split(m.de).join(m.para) : original.replace(m.de, () => m.para);
  if (mutado === original) throw new Error(`${id}: arquivo não mudou`);
  writeFileSync(caminho, mutado);
  return `${m.arquivo} (${ocorrencias} ocorrência(s) alterada(s))`;
}

if (process.argv[1] && process.argv[1].endsWith("mutacoes.mjs")) {
  const [a, b] = process.argv.slice(2);
  if (a === "--lista") {
    for (const [id, m] of Object.entries(MUTACOES)) console.log(`${id}\t${m.cenario}\t${m.arquivo}`);
  } else if (a === "--arquivo") {
    console.log(MUTACOES[b].arquivo);
  } else if (a === "--cenario") {
    console.log(MUTACOES[b].cenario);
  } else if (a === "--descricao") {
    console.log(MUTACOES[b].descricao);
  } else {
    try {
      console.log(aplica(a, b));
    } catch (e) {
      console.error(String(e.message));
      process.exit(1);
    }
  }
}
