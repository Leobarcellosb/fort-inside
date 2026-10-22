// CONTRATO DE INTERFACE: a razão de um controle estar desligado é CONTEÚDO da
// tela, nunca decoração de ponteiro.
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// Os testes de função pura (entrega-do-documento.test.ts) provam que existe um
// texto e que ele instrui. Não provam ONDE ele é renderizado -- e o defeito
// encontrado na inspeção em navegador foi exatamente de LUGAR: o texto existia,
// era bom, e vivia no atributo `title` do botão, isto é, só no hover do mouse.
//
// Num celular não existe hover: o operador via um botão cinza e nenhuma palavra
// dizendo por que. Para leitor de tela `title` também não resolve -- um botão
// desabilitado não entra na ordem de foco, então a descrição nunca é anunciada.
//
// Este arquivo lê o CÓDIGO-FONTE das telas de administração e falha se a doença
// voltar. É um teste de fonte de propósito: é a única forma de provar, sem
// navegador, que a explicação não voltou para o hover. O ambiente do vitest é
// `node`, sem DOM.
//
// Se este teste falhar, a pergunta não é "conserta o teste": é "por que uma
// informação que o operador precisa ler voltou a depender de um gesto de mouse?".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TEXTO_SEM_REVISAO_SALVA } from "../../components/features/admin/entrega-do-documento";
import {
  TEXTO_IDS_NAO_SAO_ORDINAIS,
  TEXTO_LIBERAR_NAO_SE_APLICA,
  TEXTO_CONTAGEM_DESCONHECIDA,
} from "../../components/features/admin/etapas-do-painel";

const RAIZ = join(__dirname, "..", "..");
const GRID = join(RAIZ, "components/features/admin/PrognosticReviewGrid.tsx");
const PAINEL = join(RAIZ, "components/features/admin/LiveControlPanel.tsx");

function ler(caminho: string): string {
  return readFileSync(caminho, "utf8");
}

/**
 * O CÓDIGO, sem os comentários.
 *
 * Os comentários destes arquivos CITAM o defeito antigo por extenso ("a tela
 * oferecia liberar etapa 6", "`r.stage_id === currentStage` nunca batia") para
 * que quem leia o arquivo entenda por que ele está como está. Um teste que
 * procurasse a citação no arquivo inteiro proibiria explicar o defeito --
 * exatamente o contrário do que este projeto quer. Então as asserções de "isto
 * não existe mais" olham só o código.
 *
 * Remove blocos `/* ... *\/` (o que cobre os comentários de JSX, que são blocos
 * dentro de chaves) e as linhas que começam com `//`.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");
}

/** Todos os .tsx das telas de administração. */
function telasDeAdmin(): string[] {
  const encontrados: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (nome.endsWith(".tsx")) encontrados.push(caminho);
    }
  };
  andar(join(RAIZ, "components/features/admin"));
  andar(join(RAIZ, "app/(admin)"));
  return encontrados;
}

describe("a razão de 'Entregar' estar desligado está no conteúdo, não no hover", () => {
  const codigo = semComentarios(ler(GRID));

  it("o texto da razão aparece no arquivo (ele é renderizado em algum lugar)", () => {
    // Vem do módulo puro, então a frase não pode divergir entre os dois lados.
    expect(codigo).toContain("entrega-do-documento");
    expect(codigo).toContain("entrega.texto");
  });

  it("a frase NÃO está escrita dentro de um atributo `title`", () => {
    // A frase não está mais literal no .tsx (vem do módulo), mas o teste cobre
    // os dois jeitos de reincidir: a frase literal num `title`, ou `entrega.texto`
    // num `title`.
    expect(codigo).not.toContain(TEXTO_SEM_REVISAO_SALVA);
    expect(codigo).not.toMatch(/title=\{[^}]*entrega\.texto/);
  });

  it("o botão Entregar não tem atributo `title` nenhum", () => {
    expect(codigo).not.toMatch(/title=/);
  });

  it("o botão desabilitado aponta para a razão por aria-describedby", () => {
    expect(codigo).toContain("aria-describedby");
    expect(codigo).toContain("idDaRazao(prog.id)");
  });

  it("a razão é renderizada dentro do cartão do documento, por documento", () => {
    // `idDaRazao(prog.id)` como `id` do parágrafo: o aviso pertence AQUELE
    // documento. Um aviso único no topo da tela não teria id por documento.
    expect(codigo).toMatch(/id=\{idDaRazao\(prog\.id\)\}/);
    // E é condicionado ao estado daquele documento, então desaparece sozinho.
    expect(codigo).toContain("!entrega.liberada");
  });
});

describe("o painel ao vivo diz o que não sabe, em texto visível", () => {
  const fonte = ler(PAINEL);
  const codigo = semComentarios(fonte);

  it("os três textos de isolamento são renderizados como conteúdo", () => {
    expect(codigo).toContain("leitura.texto");
    expect(codigo).toContain("proxima.texto");
    expect(codigo).toContain("contagem.texto");
  });

  it("nenhum deles está num atributo `title`", () => {
    expect(codigo).not.toMatch(/title=/);
    for (const texto of [
      TEXTO_IDS_NAO_SAO_ORDINAIS,
      TEXTO_LIBERAR_NAO_SE_APLICA,
      TEXTO_CONTAGEM_DESCONHECIDA,
    ]) {
      expect(codigo).not.toContain(texto);
    }
  });

  it("os nomes dos ambientes da casa do Fort Inside saíram do código", () => {
    // O dono pediu NOMINALMENTE que a casa saísse da versão do Marco Zero. As
    // fotos saíram; estes nomes tinham ficado, num vetor fixo indexado pelo
    // número da etapa, exibido em QUALQUER evento.
    expect(codigo).not.toContain("STAGE_LABELS");
    for (const nome of ["Portão", "Sala Principal", "Varanda", "Suíte"]) {
      expect(codigo).not.toContain(nome);
    }
    // Nem o módulo puro que alimenta o painel guarda nome de ambiente: eles vêm
    // da linha da etapa, no banco.
    const modulo = semComentarios(ler(join(RAIZ, "components/features/admin/etapas-do-painel.ts")));
    for (const nome of ["Portão", "Sala Principal", "Varanda", "Suíte"]) {
      expect(modulo).not.toContain(nome);
    }
  });

  it("as etapas não são mais uma lista escrita a mão", () => {
    expect(codigo).not.toContain("[1, 2, 3, 4, 5, 6]");
  });

  it("a próxima etapa não é mais `currentStage + 1`", () => {
    expect(codigo).not.toContain("currentStage + 1");
    expect(codigo).toContain("proxima.numero");
  });

  it("a contagem por etapa não compara mais ordinal com id de linha", () => {
    expect(codigo).not.toMatch(/stage_id === currentStage/);
  });
});

describe("nenhuma outra tela de administração esconde explicação em `title`", () => {
  // A lista completa de `title=` nas telas de administração, com a decisão de
  // cada um declarada aqui. Qualquer `title=` novo faz este teste falhar e
  // obriga a decisão a ser registrada.
  const PERMITIDOS: Record<string, string> = {
    // Tooltip de uma barra do gráfico de notas do NPS. A MESMA contagem já está
    // impressa, visível, logo abaixo da barra (`{count}`), então o `title` é
    // redundante e não esconde nada. Mantido: não é informação só no hover.
    "app/(admin)/admin/nps/page.tsx": "contagem já visível abaixo da barra",
  };

  it("só os `title=` declarados acima existem", () => {
    const comTitle: string[] = [];
    for (const caminho of telasDeAdmin()) {
      const fonte = semComentarios(ler(caminho));
      // `AlertDialogTitle`, `DialogTitle` e afins são componentes, não o atributo
      // HTML: o atributo aparece como `title=` precedido de espaço ou abertura.
      if (/[\s{]title=/.test(fonte)) comTitle.push(caminho.slice(RAIZ.length + 1));
    }
    expect(comTitle.sort()).toEqual(Object.keys(PERMITIDOS).sort());
  });
});
