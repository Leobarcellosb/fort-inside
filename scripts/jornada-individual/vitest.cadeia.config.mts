import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// So para a prova da cadeia pos-coleta. Declara o alias "@/" que o Next resolve
// pelo tsconfig e que o vitest.config.ts do projeto nao declara -- os modulos de
// producao importados aqui (lib/ai, lib/scoring, lib/jobs) usam esse alias.
// `npx vitest run` do projeto nao usa este arquivo.
const raiz = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: raiz,
  resolve: { alias: { "@": raiz.replace(/\/$/, "") } },
  test: {
    environment: "node",
    include: ["tests/jornada-individual/**/*.test.ts"],
    // A cadeia inteira num arquivo, em ordem: os elos dependem uns dos outros.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
