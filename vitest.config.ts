import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // O mesmo "@/*" -> "./*" do tsconfig: sem ele, um teste que carrega uma rota
  // de verdade (as provas contra Postgres) falha ao importar "@/lib/...".
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
