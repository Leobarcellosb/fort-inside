import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// So para a prova desta pasta, que fala com um Postgres de verdade via psql.
// Nao e usada por `npx vitest run` (que roda a prova com describe.skip quando
// PROVA_GUIA_URL nao esta no ambiente).
const raiz = fileURLToPath(new URL("../../../../", import.meta.url));

export default defineConfig({
  root: raiz,
  resolve: { alias: { "@": raiz.replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["components/features/marco-zero/provas/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
