import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// So para as provas desta pasta: o alias "@/" que o Next resolve via tsconfig
// (o vitest.config.ts do projeto nao o declara). Nao e usado por `npx vitest run`.
const raiz = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: raiz,
  resolve: { alias: { "@": raiz.replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["lib/ai/provas/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
