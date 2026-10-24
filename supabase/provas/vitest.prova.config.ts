import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// So para as provas desta pasta, que falam com um Postgres DESCARTAVEL via psql.
// `npx vitest run` (config da raiz) tambem encontra os arquivos, mas sem
// PRAZO_PROVA_URL no ambiente eles rodam com describe.skip.
const raiz = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: raiz,
  resolve: { alias: { "@": raiz.replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["supabase/provas/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
