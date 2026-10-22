import { afterEach, describe, expect, it } from "vitest";
import { MAPEAMENTO_DE_FUSO, formatarInstante, fusoDoEvento, fusoValido } from "./fuso";
import { CODIGOS_DE_ERRO } from "../erros/codigos";
import { mensagemParaHost } from "../erros/mensagens-host";

const TZ_ORIGINAL = process.env.TZ;
afterEach(() => {
  if (TZ_ORIGINAL === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINAL;
});

const INSTANTE = "2026-11-07T15:00:00.000Z";

describe("o fuso é do EVENTO, não do computador de quem acessa", () => {
  it.each(["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati", "America/Sao_Paulo"])(
    "com o computador em %s, o texto é o mesmo",
    (tz) => {
      process.env.TZ = tz;
      expect(formatarInstante(INSTANTE, "America/Sao_Paulo")).toBe("07/11/2026 12:00 (America/Sao_Paulo, GMT-03:00)");
    }
  );

  it("CONTROLE: a alavanca do teste funciona -- o relógio LOCAL do processo muda com TZ (e o texto não acompanha)", () => {
    process.env.TZ = "Asia/Tokyo";
    const horaLocalToquio = new Date(INSTANTE).getHours();
    process.env.TZ = "America/Sao_Paulo";
    const horaLocalSp = new Date(INSTANTE).getHours();
    expect(horaLocalToquio).toBe(0); // 15:00Z = 00:00 em Tóquio
    expect(horaLocalSp).toBe(12);
    expect(horaLocalToquio).not.toBe(horaLocalSp);
  });
});

describe("nada de UTC-3 manual: o deslocamento sai do Intl, para a DATA do instante", () => {
  it("fuso com horário de verão: o mesmo 'meio-dia local' tem deslocamentos diferentes no verão e no inverno", () => {
    expect(formatarInstante("2026-07-01T16:00:00Z", "America/New_York")).toBe("01/07/2026 12:00 (America/New_York, GMT-04:00)");
    expect(formatarInstante("2026-12-01T17:00:00Z", "America/New_York")).toBe("01/12/2026 12:00 (America/New_York, GMT-05:00)");
  });
  it("São Paulo, hoje sem horário de verão: -03:00 em qualquer época de 2026 -- porque o Intl diz, não porque o código assume", () => {
    expect(formatarInstante("2026-01-15T15:00:00Z", "America/Sao_Paulo")).toContain("GMT-03:00");
    expect(formatarInstante("2026-07-15T15:00:00Z", "America/Sao_Paulo")).toContain("GMT-03:00");
  });
  it("outro fuso fixo do mesmo instante dá outra hora (Manaus = -04:00)", () => {
    expect(formatarInstante(INSTANTE, "America/Manaus")).toBe("07/11/2026 11:00 (America/Manaus, GMT-04:00)");
  });
  it("meia-noite aparece como 00:00, nunca 24:00", () => {
    expect(formatarInstante("2026-11-07T03:00:00Z", "America/Sao_Paulo")).toBe("07/11/2026 00:00 (America/Sao_Paulo, GMT-03:00)");
  });
});

describe("o fuso do evento: campo próprio > mapeamento versionado > nada (nunca palpite)", () => {
  it("o mapeamento é explícito e versionado, e a v2 (Marco Zero) é São Paulo", () => {
    expect(MAPEAMENTO_DE_FUSO.versao).toBe(1);
    expect(fusoDoEvento({ quiz_version: 2 })).toBe("America/Sao_Paulo");
  });
  it("versão sem mapeamento -> null (não assume São Paulo)", () => {
    expect(fusoDoEvento({ quiz_version: 1 })).toBeNull();
    expect(fusoDoEvento({ quiz_version: 99 })).toBeNull();
    expect(fusoDoEvento({})).toBeNull();
  });
  it("o campo próprio (futuro events.timezone) vence o mapeamento", () => {
    expect(fusoDoEvento({ timezone: "America/Manaus", quiz_version: 2 })).toBe("America/Manaus");
  });
  it("campo próprio INVÁLIDO não cai em silêncio no mapeamento: é null", () => {
    expect(fusoDoEvento({ timezone: "Marte/Olimpo", quiz_version: 2 })).toBeNull();
    expect(fusoValido("Marte/Olimpo")).toBe(false);
    expect(fusoValido("")).toBe(false);
    expect(fusoValido(null)).toBe(false);
  });
});

describe("sem fuso: mostra UTC, rotulado -- não inventa hora local", () => {
  it("rótulo explícito", () => {
    expect(formatarInstante(INSTANTE, null)).toBe("07/11/2026 15:00 (UTC; o fuso deste evento não está configurado)");
    expect(formatarInstante(INSTANTE, "Marte/Olimpo")).toBe("07/11/2026 15:00 (UTC; o fuso deste evento não está configurado)");
  });
  it("entrada ilegível -> null (a mensagem cai na forma sem horário)", () => {
    expect(formatarInstante("amanhã", "America/Sao_Paulo")).toBeNull();
    expect(formatarInstante(undefined, "America/Sao_Paulo")).toBeNull();
  });
});

describe("a mensagem do host só diz a hora que o banco tem", () => {
  const dets = (iso: string, fuso?: string) => ({ coleta_encerra_em: iso, ...(fuso ? { fuso } : {}) });

  it("23h só sai se 23h for o horário real configurado", () => {
    // 02:00Z de 07/11 = 23:00 de 06/11 em São Paulo.
    expect(mensagemParaHost("COLLECTION_OPEN", dets("2026-11-07T02:00:00Z", "America/Sao_Paulo"))).toContain("06/11/2026 23:00 (America/Sao_Paulo, GMT-03:00)");
    // CONTROLE: outro prazo real NÃO mostra 23:00.
    const outro = mensagemParaHost("COLLECTION_OPEN", dets("2026-11-07T15:00:00Z", "America/Sao_Paulo"));
    expect(outro).toContain("07/11/2026 12:00");
    expect(outro).not.toContain("23:00");
  });
  it("nenhuma mensagem de nenhum código inventa 'horário de Brasília'", () => {
    for (const c of CODIGOS_DE_ERRO) {
      expect(mensagemParaHost(c, dets("2026-11-07T15:00:00Z", "America/Sao_Paulo"))).not.toMatch(/Bras[ií]lia/i);
    }
  });
  it("sem fuso no detalhe, a mensagem diz UTC com o rótulo", () => {
    expect(mensagemParaHost("COLLECTION_OPEN", dets("2026-11-07T15:00:00Z"))).toContain("(UTC; o fuso deste evento não está configurado)");
  });
});
