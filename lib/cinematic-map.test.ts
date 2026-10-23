import { describe, it, expect } from "vitest";
import {
  AMBIENT_IMAGES,
  marcaDoEvento,
  rotuloDaMarca,
  QUIZ_VERSION_MARCO_ZERO,
  ehMarcoZero,
  getStageImage,
  imagemDoAmbiente,
} from "./cinematic-map";

// O Marco Zero não mostra as fotos da casa do Fort Inside. Estes testes existem
// porque o defeito que eles pegam é SILENCIOSO: a tela renderiza igual, ninguém
// quebra, e a pessoa simplesmente vê a foto errada. Só olho humano pegaria.

describe("imagem de ambiente por versão do quiz", () => {
  it("Marco Zero (versão 2) não recebe foto em nenhuma tela", () => {
    for (const chave of Object.keys(AMBIENT_IMAGES) as (keyof typeof AMBIENT_IMAGES)[]) {
      expect(imagemDoAmbiente(chave, QUIZ_VERSION_MARCO_ZERO)).toBeUndefined();
    }
  });

  it("Fort Inside (versão 1) continua com a foto de sempre, sem regressão", () => {
    expect(imagemDoAmbiente("join", 1)).toBe(AMBIENT_IMAGES.join);
    expect(imagemDoAmbiente("waiting", 1)).toBe(AMBIENT_IMAGES.waiting);
    expect(imagemDoAmbiente("prognostic", 1)).toBe(AMBIENT_IMAGES.prognostic);
  });

  it("versão desconhecida mantém a foto: é decoração, não há o que bloquear", () => {
    expect(imagemDoAmbiente("join", null)).toBe(AMBIENT_IMAGES.join);
    expect(imagemDoAmbiente("join", undefined)).toBe(AMBIENT_IMAGES.join);
  });

  it("uma versão futura não vira Marco Zero por acidente", () => {
    expect(ehMarcoZero(3)).toBe(false);
    expect(imagemDoAmbiente("join", 3)).toBe(AMBIENT_IMAGES.join);
  });
});

describe("getStageImage", () => {
  it("nenhuma das 5 etapas do Marco Zero tem foto", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(getStageImage(n, QUIZ_VERSION_MARCO_ZERO)).toBeUndefined();
    }
  });

  it("as 6 etapas do Fort Inside mantêm a foto que já tinham", () => {
    expect(getStageImage(1, 1)).toBe(AMBIENT_IMAGES.stage_1);
    expect(getStageImage(3, 1)).toBe(AMBIENT_IMAGES.stage_3);
    expect(getStageImage(6, 1)).toBe(AMBIENT_IMAGES.stage_6);
  });

  it("etapa fora da faixa no Fort Inside cai na primeira, como antes", () => {
    expect(getStageImage(99, 1)).toBe(AMBIENT_IMAGES.stage_1);
  });

  it("sem versão informada o comportamento é o legado", () => {
    expect(getStageImage(2)).toBe(AMBIENT_IMAGES.stage_2);
  });
});

describe("marca do evento (a pele off-white + verde militar)", () => {
  it("Marco Zero recebe o atributo que liga a pele", () => {
    expect(marcaDoEvento(QUIZ_VERSION_MARCO_ZERO)).toEqual({ "data-marca": "marco-zero" });
  });

  it("Fort Inside NAO recebe atributo nenhum: a tela dele fica byte a byte como era", () => {
    expect(marcaDoEvento(1)).toEqual({});
  });

  it("versao desconhecida nao liga a pele por acidente", () => {
    expect(marcaDoEvento(null)).toEqual({});
    expect(marcaDoEvento(undefined)).toEqual({});
    expect(marcaDoEvento(3)).toEqual({});
  });
});

describe("selo da tela de entrada", () => {
  it("Marco Zero nao se apresenta como imersao do Fort Inside", () => {
    const selo = rotuloDaMarca(QUIZ_VERSION_MARCO_ZERO);
    expect(selo).toBe("Marco Zero · Geração Preparada");
    expect(selo).not.toMatch(/fort inside/i);
  });

  it("evento antigo (v1) tambem se apresenta como Geracao Preparada, nunca Fort Inside", () => {
    expect(rotuloDaMarca(1)).toBe("Imersão Geração Preparada");
  });

  it("versao desconhecida fica no legado, nao vira Marco Zero", () => {
    expect(rotuloDaMarca(null)).toBe("Imersão Geração Preparada");
    expect(rotuloDaMarca(undefined)).toBe("Imersão Geração Preparada");
  });
});
