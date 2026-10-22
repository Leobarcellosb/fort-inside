// A BORDA DO CADERNO: o que a tela mostra para cada resposta do servidor.
//
// O que esta sob prova e a separacao RECUSADO / BLOQUEADO -- "verifiquei e nao
// entreguei" contra "nao deu para verificar quem esta pedindo" -- e a recusa de
// corpo que diz `ok` sem trazer Caderno. Em nenhum desfecho a tela exibe o
// `error` do corpo (texto do servidor).

import { describe, expect, it } from "vitest";
import { mensagemParaHost } from "../../../lib/erros/mensagens-host";
import {
  MENSAGEM_SEM_CONEXAO,
  pedirCadernoDeConducao,
} from "./caderno-de-conducao-borda";
import { cadernoDeConducao, paginaImprimivelDoCaderno } from "../../../lib/marco-zero/caderno-de-conducao";

function responde(corpo: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;
}

const { caderno, conteudoSha256, texto, versao } = cadernoDeConducao();

const CORPO_BOM = {
  ok: true,
  versao,
  conteudo_sha256: conteudoSha256,
  contagem: caderno.contagem,
  momentos: caderno.momentos.map((m) => ({
    id: m.id,
    numero: m.numero,
    titulo: m.titulo,
    contagem: m.contagem,
  })),
  lacunas: caderno.lacunas.map((l) => ({
    momento: l.momento,
    momento_numero: l.momentoNumero,
    rotulo: l.rotulo,
    falta: l.falta,
    de_quem: l.deQuem,
    classe: l.classe,
  })),
  texto,
  html: paginaImprimivelDoCaderno(caderno),
};

describe("o Caderno veio", () => {
  it("entrega versão, hash, contagem, momentos, lacunas, texto e página de impressão", async () => {
    const d = await pedirCadernoDeConducao(responde(CORPO_BOM));
    expect(d.tipo).toBe("gerado");
    if (d.tipo !== "gerado") return;
    expect(d.caderno.versao).toBe(versao);
    expect(d.caderno.conteudo_sha256).toBe(conteudoSha256);
    expect(d.caderno.momentos).toHaveLength(8);
    expect(d.caderno.lacunas.length).toBeGreaterThan(0);
    expect(d.caderno.html).toContain("@media print");
  });

  it("faz o pedido SEM corpo: o Caderno não é por evento", async () => {
    let visto: RequestInit | undefined;
    const espiao = (async (_u: string, init?: RequestInit) => {
      visto = init;
      return new Response(JSON.stringify(CORPO_BOM), { status: 200 });
    }) as unknown as typeof fetch;
    await pedirCadernoDeConducao(espiao);
    expect(visto?.method).toBe("POST");
    expect(visto?.body).toBeUndefined();
  });
});

describe("recusado: o servidor verificou e não entregou", () => {
  for (const codigo of ["AUTH_REQUIRED", "ADMIN_FORBIDDEN"] as const) {
    it(`${codigo} é recusa, com a mensagem do código`, async () => {
      const d = await pedirCadernoDeConducao(
        responde({ error: "texto interno do servidor", code: codigo, ocorrencia: "abc123" }, 401),
      );
      expect(d.tipo).toBe("recusado");
      if (d.tipo !== "recusado") return;
      expect(d.codigo).toBe(codigo);
      expect(d.mensagem).toBe(mensagemParaHost(codigo));
      expect(d.mensagem).not.toContain("texto interno do servidor");
      expect(d.ocorrencia).toBe("abc123");
    });
  }
});

describe("bloqueado: não deu para verificar quem está pedindo", () => {
  it("AUTH_UNAVAILABLE bloqueia, e NÃO é recusa", async () => {
    const d = await pedirCadernoDeConducao(
      responde({ error: "x", code: "AUTH_UNAVAILABLE", ocorrencia: "zzz999" }, 503),
    );
    expect(d.tipo).toBe("bloqueado");
    expect(d.tipo).not.toBe("recusado");
  });
});

describe("o que não é Caderno não é mostrado como Caderno", () => {
  const ruins: readonly [string, unknown][] = [
    ["ok ausente", { versao, conteudo_sha256: conteudoSha256, texto, html: "x" }],
    ["hash que não é sha-256", { ...CORPO_BOM, conteudo_sha256: "curto" }],
    ["texto vazio", { ...CORPO_BOM, texto: "" }],
    ["sem página de impressão", { ...CORPO_BOM, html: "" }],
    ["sem momentos", { ...CORPO_BOM, momentos: [] }],
    ["sem versão", { ...CORPO_BOM, versao: "" }],
  ];
  for (const [nome, corpo] of ruins) {
    it(`200 com ${nome} -> erro inesperado, nunca "gerado"`, async () => {
      const d = await pedirCadernoDeConducao(responde(corpo, 200));
      expect(d.tipo).toBe("erro_inesperado");
    });
  }

  it("código fora do vocabulário -> erro inesperado, com mensagem genérica", async () => {
    const d = await pedirCadernoDeConducao(responde({ code: "INVENTADO" }, 400));
    expect(d.tipo).toBe("erro_inesperado");
  });
});

describe("sem conexão", () => {
  it("fetch que lança -> sem_conexao, e a mensagem lembra que o arquivo baixado vale offline", async () => {
    const quebrado = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const d = await pedirCadernoDeConducao(quebrado);
    expect(d).toEqual({ tipo: "sem_conexao", mensagem: MENSAGEM_SEM_CONEXAO });
    expect(MENSAGEM_SEM_CONEXAO).toContain("não depende de internet");
  });
});
