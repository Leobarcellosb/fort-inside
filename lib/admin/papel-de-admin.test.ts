import { describe, expect, it } from "vitest";
import { isAdminUser } from "@/lib/auth/require-admin";
import { appMetadataComPapel, enderecoDoProjeto } from "./papel-de-admin";

describe("papel de administrador no app_metadata", () => {
  it("conceder: o app passa a reconhecer como administrador, e o resto fica", () => {
    const novo = appMetadataComPapel({ provider: "email", providers: ["email"] }, "conceder");
    expect(novo).toEqual({ provider: "email", providers: ["email"], role: "admin" });
    expect(isAdminUser({ app_metadata: novo as { role?: string } })).toBe(true);
  });

  it("conceder sobre metadados vazios", () => {
    expect(appMetadataComPapel(null, "conceder")).toEqual({ role: "admin" });
  });

  it("revogar: manda role nulo (o Supabase mescla), deixa de ser administrador, e o resto fica", () => {
    const novo = appMetadataComPapel({ provider: "email", role: "admin" }, "revogar");
    expect(novo).toEqual({ provider: "email", role: null });
    expect(isAdminUser({ app_metadata: novo as { role?: string } })).toBe(false);
  });

  it("revogar nao apaga outro papel", () => {
    expect(appMetadataComPapel({ role: "outro" }, "revogar")).toEqual({ role: "outro" });
  });

  it("nao altera o objeto recebido", () => {
    const atual = { provider: "email" };
    appMetadataComPapel(atual, "conceder");
    expect(atual).toEqual({ provider: "email" });
  });

  it("so aceita o endereco do projeto indicado", () => {
    expect(enderecoDoProjeto("https://dodbgmmvtrhcrahfllvl.supabase.co", "dodbgmmvtrhcrahfllvl")).toBe(true);
    expect(enderecoDoProjeto("https://outroprojeto.supabase.co", "dodbgmmvtrhcrahfllvl")).toBe(false);
    expect(enderecoDoProjeto("http://127.0.0.1:54731", "dodbgmmvtrhcrahfllvl")).toBe(false);
    expect(enderecoDoProjeto("nao e url", "dodbgmmvtrhcrahfllvl")).toBe(false);
    expect(enderecoDoProjeto("http://127.0.0.1:54731", "local")).toBe(true);
    expect(enderecoDoProjeto("https://dodbgmmvtrhcrahfllvl.supabase.co", "local")).toBe(false);
  });
});
