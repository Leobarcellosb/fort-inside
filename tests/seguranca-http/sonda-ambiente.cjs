// Carregada no servidor do app via NODE_OPTIONS=--require. Grava o ambiente REAL do
// processo (o que o Next/SDK vão de fato ler), para o harness provar o isolamento
// sem confiar no que ele "acha" que exportou. A chave é gravada truncada.
const { appendFileSync } = require("node:fs");
const arq = process.env.SEG_SONDA_ARQ;
if (arq) {
  const k = process.env.ANTHROPIC_API_KEY || "";
  appendFileSync(
    arq,
    JSON.stringify({
      pid: process.pid,
      SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "",
      ANTHROPIC_API_KEY_prefixo: k.slice(0, 18),
    }) + "\n"
  );
}
