import { NextResponse } from "next/server";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { respostaDeRecusa } from "@/lib/erros/resposta";
import { testarConexaoComIA, TEXTO_DA_FALHA } from "@/lib/ai/teste-de-conexao";

export const maxDuration = 60;

// UMA chamada real e minima a IA, pelo servidor, com a configuracao que vai
// gerar os documentos (lib/ai/teste-de-conexao.ts). So administrador: cada
// chamada custa, e o resultado diz qual host a configuracao alcanca.
// Nada e gravado; o log recebe so a classe e o status, nunca chave ou header.
export async function POST() {
  const admin = await verificarAdmin();
  if (!admin.autorizado) return respostaDeRecusa(admin);

  const r = await testarConexaoComIA();
  if (r.ok) {
    return NextResponse.json({
      ok: true,
      modelo: r.modelo,
      destino: r.destino,
      latencia_ms: r.latenciaMs,
      texto: `A IA respondeu. Modelo ${r.modelo}, servidor ${r.destino}, em ${(r.latenciaMs / 1000).toFixed(1)} s. Pode processar.`,
    });
  }
  console.warn("[teste-ia] falha", { classe: r.classe, status: r.status, tipo: r.tipo, destino: r.destino });
  return NextResponse.json(
    { ok: false, classe: r.classe, status: r.status, destino: r.destino, texto: TEXTO_DA_FALHA[r.classe] },
    { status: 200 },
  );
}
