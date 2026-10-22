import { describe, expect, it } from "vitest";
import { criaLimitador, ipDoCliente } from "./limite-entrada";

describe("criaLimitador", () => {
  it("deixa passar ate o maximo e recusa o excedente com retryAfter", () => {
    let t = 1_000_000;
    const l = criaLimitador({ janelaMs: 60_000, max: 3, agora: () => t });
    expect(l.tenta("a").ok).toBe(true);
    expect(l.tenta("a").ok).toBe(true);
    expect(l.tenta("a").ok).toBe(true);
    const r = l.tenta("a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterS).toBe(60);
    // outra chave nao e afetada
    expect(l.tenta("b").ok).toBe(true);
  });

  it("libera depois que a janela passa", () => {
    let t = 0;
    const l = criaLimitador({ janelaMs: 10_000, max: 1, agora: () => t });
    expect(l.tenta("a").ok).toBe(true);
    t = 5_000;
    expect(l.tenta("a").ok).toBe(false);
    t = 10_001;
    expect(l.tenta("a").ok).toBe(true);
  });

  it("zera uma chave", () => {
    const l = criaLimitador({ janelaMs: 60_000, max: 1 });
    l.tenta("a");
    expect(l.tenta("a").ok).toBe(false);
    l.zera("a");
    expect(l.tenta("a").ok).toBe(true);
  });

  it("nao cresce sem limite sob rajada de chaves distintas", () => {
    let t = 0;
    const l = criaLimitador({ janelaMs: 60_000, max: 5, maxChaves: 100, agora: () => (t += 2000) });
    for (let i = 0; i < 1000; i++) l.tenta(`k${i}`);
    expect(l.tamanho()).toBeLessThanOrEqual(100);
  });
});

describe("ipDoCliente", () => {
  it("usa o primeiro item de x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(ipDoCliente(h)).toBe("203.0.113.9");
  });
  it("cai para x-real-ip e depois para 'desconhecido'", () => {
    expect(ipDoCliente(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(ipDoCliente(new Headers())).toBe("desconhecido");
  });
});
