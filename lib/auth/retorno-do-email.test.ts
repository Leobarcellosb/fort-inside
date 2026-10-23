import { describe, expect, it } from "vitest";
import {
  DESTINO_PADRAO,
  PAGINA_DE_NOVA_SENHA,
  TEXTO_LINK_ENVIADO,
  TEXTO_LINK_INVALIDO,
  destinoSeguro,
  enderecoDeRetorno,
  lerRetorno,
} from "./retorno-do-email";

describe("destino depois de voltar do e-mail", () => {
  it("aceita caminhos do painel", () => {
    expect(destinoSeguro("/admin/events/abc")).toBe("/admin/events/abc");
    expect(destinoSeguro(PAGINA_DE_NOVA_SENHA)).toBe(PAGINA_DE_NOVA_SENHA);
  });

  it("recusa tudo que sairia do painel e cai no padrao", () => {
    for (const ruim of [
      null,
      "",
      "https://golpe.com",
      "//golpe.com",
      "/formulario/MARCOZERO",
      "/admin/../../x",
      "/admin\\@golpe.com",
      "/admin?u=https://golpe.com",
      "/admin/login/confirmar?next=/admin",
    ]) {
      expect(destinoSeguro(ruim), String(ruim)).toBe(DESTINO_PADRAO);
    }
  });
});

describe("leitura do link de volta", () => {
  it("codigo PKCE", () => {
    expect(lerRetorno(new URLSearchParams("code=abc&next=/admin/events"))).toEqual({ tipo: "codigo", code: "abc" });
  });

  it("token com tipo aceito", () => {
    expect(lerRetorno(new URLSearchParams("token_hash=h&type=recovery"))).toEqual({
      tipo: "token",
      tokenHash: "h",
      type: "recovery",
    });
    expect(lerRetorno(new URLSearchParams("token_hash=h&type=magiclink")).tipo).toBe("token");
  });

  it("tipo desconhecido ou nada: invalido", () => {
    expect(lerRetorno(new URLSearchParams("token_hash=h&type=signup")).tipo).toBe("invalido");
    expect(lerRetorno(new URLSearchParams("token_hash=h")).tipo).toBe("invalido");
    expect(lerRetorno(new URLSearchParams("")).tipo).toBe("invalido");
  });
});

describe("endereco que vai no e-mail", () => {
  it("volta para a rota de confirmacao no mesmo site, com destino seguro", () => {
    const u = new URL(enderecoDeRetorno("https://marcozero-gp.vercel.app", PAGINA_DE_NOVA_SENHA));
    expect(u.origin).toBe("https://marcozero-gp.vercel.app");
    expect(u.pathname).toBe("/admin/login/confirmar");
    expect(u.searchParams.get("next")).toBe(PAGINA_DE_NOVA_SENHA);
    expect(new URL(enderecoDeRetorno("https://x.app", "https://golpe.com")).searchParams.get("next")).toBe(DESTINO_PADRAO);
  });

  it("as mensagens nao tem travessao e nao revelam se a conta existe", () => {
    expect(TEXTO_LINK_ENVIADO).toMatch(/^Se houver uma conta/);
    expect(`${TEXTO_LINK_ENVIADO}${TEXTO_LINK_INVALIDO}`).not.toMatch(/[—–]/);
  });
});
