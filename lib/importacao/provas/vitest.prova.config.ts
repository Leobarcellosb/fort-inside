import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// So para a prova desta pasta, que fala com um Postgres de verdade via psql.
// Nao e usada por `npx vitest run` (que roda a prova com describe.skip quando
// PROVA_IMPORTACAO_URL nao esta no ambiente).
const raiz = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: raiz,
  resolve: { alias: { "@": raiz.replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["lib/importacao/provas/**/*.test.ts"],
    // Container saturado: psql pode demorar. Teto generoso e melhor que um
    // falso vermelho por impaciencia.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Os cenarios compartilham estado no banco e dependem da ordem.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
