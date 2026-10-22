// O TEXTO QUE O JOVEM LÊ, PROVADO COMO QUALQUER OUTRA REGRA DO PRODUTO.
//
// Por que um teste para um texto: porque este é o texto que uma pessoa de 16
// anos lê, sozinha, no celular, sobre o documento que fala da vida dela, depois
// de clicar num link que funcionava. Se ele voltar a dizer "documento
// indisponível" ou "erro 404", a correção de hoje não terá sobrado nada -- e
// nenhum teste de banco pegaria isso.
//
// Se um destes falhar, a pergunta não é "conserta o teste": é "por que o aviso
// que o jovem lê voltou a assustar, a culpá-lo, ou a falar a língua do sistema?".

import { describe, expect, it } from "vitest";
import {
  PALAVRAS_QUE_NAO_ENTRAM,
  PARAGRAFOS_DOCUMENTO_SUSPENSO,
  RODAPE_DOCUMENTO_SUSPENSO,
  TITULO_DOCUMENTO_SUSPENSO,
  textoIntegralDoAviso,
} from "./documento-suspenso";

const TEXTO = textoIntegralDoAviso();
const BAIXO = TEXTO.toLowerCase();

describe("o aviso diz as cinco coisas que ele precisa ler", () => {
  it("NÃO É CULPA DELE, em palavras, não insinuado", () => {
    expect(BAIXO).toContain("você não fez nada errado");
  });

  it("DIZ QUE ELE SERÁ AVISADO -- é o que faz ele parar de recarregar a página", () => {
    expect(BAIXO).toContain("avisar você");
  });

  it("DIZ QUE O LINK É O MESMO, e que ele não vai precisar de um novo", () => {
    // A decisão de produto da 027 é não revogar o token: o mesmo link volta a
    // abrir o documento corrigido, sozinho. Se o texto não disser isso, ele vai
    // achar que perdeu o acesso ao próprio documento.
    expect(BAIXO).toContain("este mesmo link");
    expect(BAIXO).toContain("link novo");
  });

  it("DIZ QUE NADA DO QUE ELE RESPONDEU FOI PERDIDO", () => {
    expect(BAIXO).toContain("nada do que você respondeu foi perdido");
  });

  it("NOMEIA QUEM AGIU: nós encontramos, nós tiramos do ar", () => {
    // Voz ativa com sujeito. "O documento está indisponível" esconde quem agiu, e
    // esconder é o que assusta: dá a entender que algo quebrou sozinho.
    expect(BAIXO).toContain("nós encontramos");
    expect(BAIXO).toContain("tiramos ele do ar");
  });

  it("MANDA FALAR COM UMA PESSOA, se ele quiser conversar antes", () => {
    expect(BAIXO).toContain("conduziu o encontro");
  });
});

describe("sem jargão e sem alarme", () => {
  it("nenhuma das palavras proibidas aparece no que ele lê", () => {
    for (const palavra of PALAVRAS_QUE_NAO_ENTRAM) {
      expect(BAIXO).not.toContain(palavra.toLowerCase());
    }
  });

  it("a lista de proibidas cobre as duas famílias: jargão e alarme", () => {
    // Guarda contra alguém esvaziar a lista para fazer o teste acima passar.
    for (const obrigatoria of ["suspenso", "status", "erro", "falha", "sistema"]) {
      expect(PALAVRAS_QUE_NAO_ENTRAM).toContain(obrigatoria);
    }
  });

  it("o título fala do DOCUMENTO dele, não do sistema", () => {
    expect(TITULO_DOCUMENTO_SUSPENSO.toLowerCase()).toContain("seu documento");
  });
});

describe("o aviso não entrega o que não é dele", () => {
  it("o motivo interno do operador não está em lugar nenhum deste módulo", () => {
    // `prognostics.suspensao_motivo` é escrito pelo operador PARA o operador
    // ("a trilha saiu trocada", "o nome está errado"). Lido fora de contexto por
    // um adolescente, assustaria mais do que explicaria -- e a conversa que ele
    // precisa ter é com o host, que é para onde o texto o manda.
    expect(TEXTO).not.toContain("motivo");
    expect(BAIXO).not.toContain("suspensao_motivo");
  });

  it("não há conteúdo do documento aqui: o módulo é só o aviso", () => {
    // A metade "não deixar o jovem exposto ao conteúdo incorreto": o texto
    // suspenso não chega ao navegador dele nem escondido no HTML. Este módulo
    // não tem como vazá-lo porque não recebe nada.
    expect(typeof textoIntegralDoAviso()).toBe("string");
    expect(textoIntegralDoAviso.length).toBe(0); // nenhum parâmetro
  });
});

describe("é um aviso de verdade, não um rótulo", () => {
  it("são vários parágrafos, e o primeiro é o que tira o peso dele", () => {
    expect(PARAGRAFOS_DOCUMENTO_SUSPENSO.length).toBeGreaterThanOrEqual(4);
    expect(PARAGRAFOS_DOCUMENTO_SUSPENSO[0].toLowerCase()).toContain("não fez nada errado");
  });

  it("cada parágrafo é uma frase inteira", () => {
    for (const p of PARAGRAFOS_DOCUMENTO_SUSPENSO) {
      // Piso baixo de propósito: "Nada do que você respondeu foi perdido." tem
      // 39 caracteres e é a frase mais importante do aviso. O que este piso
      // existe para pegar é rótulo de três palavras, não frase curta e boa.
      expect(p.length).toBeGreaterThan(35);
      expect(p.trim()).toBe(p);
    }
  });

  it("o rodapé serve a quem chegou aqui recarregando", () => {
    expect(RODAPE_DOCUMENTO_SUSPENSO.toLowerCase()).toContain("recarregando");
  });
});
