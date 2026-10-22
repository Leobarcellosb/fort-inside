// Config SO do ensaio. Existe para que o comparador NAO entre na suite padrao:
// ele depende de Docker e de um banco construido na hora, e a suite padrao
// (`npx vitest run`, include "**/*.test.ts") tem de continuar hermetica e
// rapida. Por isso o arquivo do ensaio termina em `.ensaio.ts`, e nao em
// `.test.ts`, e so este include o alcanca.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/ensaio/comparar-cobertura.ensaio.ts"],
    // A saida do ensaio E o resultado: nada de capturar o console.
    disableConsoleIntercept: true,
    reporters: ["verbose"],
  },
});
