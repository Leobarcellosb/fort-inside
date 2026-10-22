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

  it("o cartão de um documento FORA DO AR explica em texto o que o jovem está vendo", () => {
    // ASSERÇÕES ACRESCENTADAS com a migration 027, e nenhuma das acima foi
    // tocada. A doença de origem foi de LUGAR, e os controles novos
    // ("Tirar do ar", e "Entregar" desligado por suspensão) são exatamente o tipo
    // de coisa em que ela reincide: um botão cinza, um ícone de cadeado e a
    // explicação no hover.
    //
    // A EVIDÊNCIA NOVA que estas linhas apontam: o cartão suspenso renderiza DOIS
    // fatos como conteúdo -- o que o participante está vendo agora
    // (`suspensao.texto`) e o caminho de volta (`entrega.texto`) -- e o segundo é
    // o que o botão "Entregar" aponta por `aria-describedby`.
    expect(codigo).toContain("suspensao-do-documento");
    expect(codigo).toContain("situacaoDaSuspensao");
    expect(codigo).toContain("suspensao.texto");
    // Condicionado ao estado DAQUELE documento, então desaparece sozinho quando a
    // retificação é salva -- a mesma regra da razão da entrega.
    expect(codigo).toContain("!suspensao.disponivel");
  });

  it("o botão de tirar do ar não tem `title`, e o rótulo fala do documento", () => {
    // O `it` acima já cobre a razão visível; este cobre o controle novo em si. A
    // asserção `not.toMatch(/title=/)` do caso anterior vale para o arquivo
    // inteiro, inclusive para este botão -- aqui o que se prova é que o rótulo
    // vem do módulo puro (e portanto é o texto provado lá), e não uma string
    // escrita à mão no JSX que poderia divergir dele.
    expect(codigo).toContain("ROTULO_SUSPENDER");
    expect(codigo).not.toContain("Suspender documento<");
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

describe("o diálogo de tirar do ar explica o botão desligado em texto visível", () => {
  const DIALOGO = join(RAIZ, "components/features/admin/SuspenderDocumentoDialog.tsx");
  const codigo = semComentarios(ler(DIALOGO));

  it("a razão do campo e do botão é um parágrafo, ligado por aria-describedby", () => {
    // O botão "Tirar do ar" do diálogo fica DESLIGADO enquanto o motivo não
    // serve, e por que ele está desligado é conteúdo da tela. Sem isto, o
    // operador de celular veria um botão cinza e nenhuma palavra -- exatamente o
    // defeito que este arquivo existe para impedir de voltar.
    expect(codigo).toContain("aria-describedby");
    expect(codigo).toContain("validacao.texto");
    expect(codigo).toMatch(/id=\{idDaRazaoDoCampo\}/);
  });

  it("nada aqui está num atributo `title`", () => {
    expect(codigo).not.toMatch(/[\s{]title=/);
  });

  it("o texto vem dos módulos puros, não de strings escritas no JSX", () => {
    // Uma frase escrita à mão aqui divergiria da que o teste prova em
    // `suspensao-do-documento.test.ts` na primeira vez que alguém corrigisse uma
    // das duas.
    expect(codigo).toContain("TEXTO_DA_CONFIRMACAO");
    expect(codigo).toContain("TITULO_DA_CONFIRMACAO");
    expect(codigo).toContain("validarMotivoDaSuspensao");
  });
});

describe("a página do participante não devolve erro cru num documento fora do ar", () => {
  // Teste de FONTE, pela mesma razão declarada no topo deste arquivo: o ambiente
  // do vitest é `node`, sem DOM e sem servidor Next, e o que se prova aqui é de
  // LUGAR -- que o ramo suspenso existe na página e que ele NÃO passa conteúdo.
  const PAGINA = join(RAIZ, "app/(participant)/prognostic/[token]/page.tsx");
  const codigo = semComentarios(ler(PAGINA));

  it("o estado suspenso é consultado, e não cai em notFound()", () => {
    expect(codigo).toContain("suspended");
    expect(codigo).toContain("DocumentoSuspensoView");
    // O ramo suspenso vem ANTES de montar `content`: ele retorna o aviso e para.
    const posSuspenso = codigo.indexOf("DocumentoSuspensoView");
    const posConteudo = codigo.indexOf("prognostic.final_content");
    expect(posSuspenso).toBeGreaterThan(-1);
    expect(posConteudo).toBeGreaterThan(posSuspenso);
  });

  it("o aviso NÃO recebe conteúdo nem o motivo interno do operador", () => {
    // A metade "não deixar o jovem exposto ao conteúdo incorreto": o texto
    // suspenso não chega ao navegador dele nem escondido no HTML.
    expect(codigo).toMatch(/<DocumentoSuspensoView\s+participantName=\{[^}]*\}\s*\/>/);
    expect(codigo).not.toContain("suspensao_motivo");
  });

  it("nenhum outro estado passou a aparecer neste link", () => {
    // `generated`, `in_review` e `reviewed` continuam caindo em notFound():
    // documento não entregue nunca foi para ser lido.
    expect(codigo).toContain("notFound()");
    for (const estado of ["generated", "in_review", '"reviewed"']) {
      expect(codigo).not.toContain(estado);
    }
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
