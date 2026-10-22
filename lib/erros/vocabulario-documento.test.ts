// A FAMÍLIA DO DOCUMENTO INDIVIDUAL, no mesmo critério do critério 7 de
// `criterios.test.ts`: cada código tem status, texto do servidor e mensagem do
// host, e nenhuma dessas mensagens cai na genérica.
//
// Arquivo próprio (e não um `it` dentro de criterios.test.ts) por uma razão
// prática declarada: os códigos desta família ficam FORA do tipo
// `CodigoDeErro` enquanto os mapas exaustivos de
// `components/features/admin/importar-respostas.ts` estiverem sendo mexidos por
// outra frente -- ver o comentário em `codigos.ts`. Quando as duas famílias se
// juntarem, estes casos migram para o critério 7 e este arquivo desaparece.

import { describe, expect, it } from "vitest";
import {
  CODIGOS_DE_ERRO,
  CODIGOS_DE_ERRO_DOCUMENTO,
  DEFINICOES_DE_ERRO,
  ehCodigoDeErro,
  ehCodigoDeErroDocumento,
  statusDoCodigo,
} from "./codigos";
import { MENSAGEM_GENERICA, mensagemParaHost } from "./mensagens-host";
import { erroHttp } from "./resposta";

describe("vocabulário do documento individual", () => {
  it("são os seis códigos do documento, e nenhum deles está na família das telas de processamento", () => {
    expect([...CODIGOS_DE_ERRO_DOCUMENTO].sort()).toEqual([
      "PROGNOSTIC_APPROVAL_STALE",
      "PROGNOSTIC_NOT_FOUND",
      "PROGNOSTIC_RESPONSES_INSUFFICIENT",
      "PROGNOSTIC_RESPONSES_UNREADABLE",
      "PROGNOSTIC_STATE_REGRESSION",
      "PROGNOSTIC_WRITE_UNAVAILABLE",
    ]);
    // As duas listas não se cruzam: `ehCodigoDeErro` NÃO reconhece um código do
    // documento, de propósito -- os mapas exaustivos das telas de processamento
    // e de importação são indexados com ele, e uma chave que eles não têm
    // devolveria `undefined` em execução.
    for (const c of CODIGOS_DE_ERRO_DOCUMENTO) {
      expect(ehCodigoDeErro(c)).toBe(false);
      expect(ehCodigoDeErroDocumento(c)).toBe(true);
      expect(CODIGOS_DE_ERRO).not.toContain(c as never);
    }
    for (const c of CODIGOS_DE_ERRO) {
      expect(ehCodigoDeErroDocumento(c)).toBe(false);
    }
  });

  it("cada código tem status, texto curto do servidor e mensagem própria do host", () => {
    for (const c of CODIGOS_DE_ERRO_DOCUMENTO) {
      expect([400, 404, 422, 503]).toContain(DEFINICOES_DE_ERRO[c].status);
      expect(statusDoCodigo(c)).toBe(DEFINICOES_DE_ERRO[c].status);
      expect(DEFINICOES_DE_ERRO[c].error.length).toBeGreaterThan(3);
      const msg = mensagemParaHost(c, { estado_do_documento: "delivered" });
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toBe(MENSAGEM_GENERICA);
    }
  });

  it("os três fatos ficam separados: recusa verificada (400/404), dado ilegível (422) e indisponibilidade (503)", () => {
    expect(statusDoCodigo("PROGNOSTIC_RESPONSES_INSUFFICIENT")).toBe(400);
    expect(statusDoCodigo("PROGNOSTIC_STATE_REGRESSION")).toBe(400);
    expect(statusDoCodigo("PROGNOSTIC_APPROVAL_STALE")).toBe(400);
    expect(statusDoCodigo("PROGNOSTIC_NOT_FOUND")).toBe(404);
    expect(statusDoCodigo("PROGNOSTIC_RESPONSES_UNREADABLE")).toBe(422);
    // "Não consegui gravar" NUNCA vira recusa: é 503 e a mensagem manda
    // conferir o estado antes de tentar de novo, sem afirmar que foi recusado.
    expect(statusDoCodigo("PROGNOSTIC_WRITE_UNAVAILABLE")).toBe(503);
    const msg = mensagemParaHost("PROGNOSTIC_WRITE_UNAVAILABLE");
    expect(msg).toContain("não deu para saber");
    // Nenhuma mensagem desta família manda APLICAR migration: nenhuma delas
    // significa "o recurso não está instalado".
    for (const c of CODIGOS_DE_ERRO_DOCUMENTO) {
      expect(mensagemParaHost(c)).not.toMatch(/\baplicar\b|\baplicada\b|migration/i);
    }
  });

  it("a recusa por respostas insuficientes diz ONDE falta, e o corpo nunca carrega texto de banco", async () => {
    const r = erroHttp("PROGNOSTIC_RESPONSES_INSUFFICIENT", {
      causa: 'PGRST202 relation "prognostics" does not exist (SQLSTATE 42P01)',
      detalhes: {
        blocos_incompletos: ["likert"],
        itens: ["q31"],
        completude: [{ bloco: "likert", respondidas: 23, total: 24, minimo: 24 }],
      },
    });
    expect(r.status).toBe(400);
    const corpo = (await r.json()) as Record<string, unknown>;
    expect(corpo.code).toBe("PROGNOSTIC_RESPONSES_INSUFFICIENT");
    expect(typeof corpo.ocorrencia).toBe("string");
    expect(JSON.stringify(corpo)).not.toMatch(/PGRST|SQLSTATE|42P01/);
    const texto = mensagemParaHost("PROGNOSTIC_RESPONSES_INSUFFICIENT", {
      blocos_incompletos: ["likert"],
      completude: [{ bloco: "likert", respondidas: 23, total: 24, minimo: 24 }],
    });
    expect(texto).toContain("23 de 24");
    expect(texto).toContain("mínimo 24");
  });
});
