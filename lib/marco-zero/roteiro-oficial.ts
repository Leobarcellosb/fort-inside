// A ENTRADA ESTATICA E VERSIONADA do Caderno de Conducao -- e a sua PROVENIENCIA,
// item por item.
//
// POR QUE ESTE ARQUIVO EXISTE SEPARADO DE TUDO. O Caderno de Conducao e o
// TERCEIRO artefato do Marco Zero, e a distincao entre os tres e a razao de ele
// existir. Duas perguntas estavam sendo respondidas pelo mesmo documento:
//
//   "Como o facilitador conduz o evento?"              -> este Caderno.
//       NAO exige questionario respondido. Existe com ZERO respostas digitais.
//   "O que podemos afirmar sobre os participantes?"    -> o Guia e o DNA.
//       Exige dados validos e todas as portas metodologicas.
//
// O Caderno existe INDEPENDENTEMENTE de haver Guia ou DNA, esta sempre
// disponivel e tem de ser usavel SEM INTERNET. Ele NAO passa pelo gerador do
// Guia (components/features/marco-zero/guia-facilitador-modelo.ts), NAO recebe
// pontuacao e NAO recebe resposta de ninguem: a sua unica entrada e o conteudo
// estatico aprovado do evento, que e este arquivo.
//
// AS TRES CATEGORIAS, APLICADAS AO CONTEUDO. O principio que governa este
// projeto -- "nao consegui verificar", "verifiquei e nao existe" e "eu inventei"
// sao tres fatos diferentes e nunca se confundem -- aqui vale para cada frase do
// Caderno. Por isso todo item e de um de TRES tipos, e o tipo aparece impresso:
//
//   "oficial"   conteudo do roteiro oficial do evento. Carrega a FONTE (URL ou
//               caminho de arquivo) e a secao de onde saiu. Verificavel.
//   "operacao"  procedimento escrito por quem montou o Caderno: conferencia de
//               material, guarda e digitalizacao do Mural, registro de quem
//               levou o que, o que fazer sem internet. E operacao, nao
//               pedagogia, e vem declarado como tal.
//   "lacuna"    NAO ha conteudo oficial para este item. Diz O QUE falta, DE QUEM
//               tem de vir, e ONDE foi conferido. NUNCA e preenchido com
//               facilitacao plausivel.
//
// O QUE NAO PODE SER "operacao", nunca, e esta a restricao que define esta
// unidade: o conteudo das tres missoes, as perguntas da SWOT, o metodo de
// construcao do Manifesto e os objetivos declarados do movimento. Isso e o
// planejamento pedagogico aprovado e nao e de quem montou este arquivo. Quando
// nao chegou, virou "lacuna" -- e um Caderno com metade das lacunas declaradas e
// util e honesto; um Caderno completo com conteudo inventado e pior que nenhum,
// porque ninguem descobre que e invencao ate a sala estar cheia.
//
// A REGRA DE REDACAO, herdada do Guia e valendo aqui em todos os oito momentos:
// pergunta facilitadora e instrucao de PROCESSO. "Como voces chegaram a essa
// decisao?" pode. Frase que atribui caracteristica a quem esta na sala nao pode,
// nunca. A identidade do movimento e construida pelos jovens durante a imersao,
// nao antecipada por um documento. O varredor em
// `lib/marco-zero/caderno-de-conducao.ts` recusa a montagem do Caderno se uma
// frase dessas entrar aqui.
//
// COMO ESTE ARQUIVO FOI LEVANTADO, e o que o repositorio nao tinha.
// --------------------------------------------------------------------
// Procurado no repositorio: missao, SWOT, Mural, Manifesto, nucleo, pilar e
// cronograma, em `docs/` e no codigo. O que existe sao mencoes de passagem em
// `docs/BRIEFING.md` (o Mural do Futuro citado em duas linhas). NAO existe, no
// repositorio: descricao das tres missoes, cronograma, lista de materiais,
// perguntas da SWOT, metodo do Manifesto, objetivos declarados do movimento.
//
// A fonte real do roteiro e o SITE DO EVENTO, lido em 2026-10-22 e registrado em
// `FONTES`. Toda linha "oficial" deste arquivo aponta para uma secao dele.
//
// UMA PALAVRA TROCADA, declarada. O site diz "a distribuicao de pilares em
// roda". A palavra "distribuicao" e vocabulario de RETRATO COLETIVO no varredor
// do Guia (ele a recusa junto com "media" e "percentual"), e o Caderno reusa
// esse varredor. O mesmo fato aparece aqui como "a roda dos pilares". E a unica
// troca de palavra em conteudo oficial, e o fato nao muda.

export const VERSAO_DO_ROTEIRO = "roteiro-oficial-marco-zero-2026-10-22";

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

export type FonteId =
  | "site_roteiro"
  | "site_caso_1"
  | "site_caso_2"
  | "site_caso_3"
  | "site_caso_4"
  | "site_caso_5"
  | "repo_briefing";

export interface Fonte {
  readonly id: FonteId;
  readonly titulo: string;
  /** URL ou caminho de arquivo. E o que vai impresso ao lado do item. */
  readonly onde: string;
  readonly tipo: "site_do_evento" | "arquivo_do_repositorio";
  /** Quando esta entrada foi lida e transcrita. ISO 8601, data. */
  readonly lidoEm: string;
}

export const FONTES: Record<FonteId, Fonte> = {
  site_roteiro: {
    id: "site_roteiro",
    titulo: "Roteiro oficial do Marco Zero (site do evento)",
    onde: "https://evento-marcozero.velvoramedia.com.br/",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  site_caso_1: {
    id: "site_caso_1",
    titulo: "Ficha tecnica do concierge, Missao 03 -- Nucleo 1, Caso A",
    onde: "https://evento-marcozero.velvoramedia.com.br/caso-1.html",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  site_caso_2: {
    id: "site_caso_2",
    titulo: "Ficha tecnica do concierge, Missao 03 -- Nucleo 2, Caso B",
    onde: "https://evento-marcozero.velvoramedia.com.br/caso-2.html",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  site_caso_3: {
    id: "site_caso_3",
    titulo: "Ficha tecnica do concierge, Missao 03 -- Nucleo 3, Caso C",
    onde: "https://evento-marcozero.velvoramedia.com.br/caso-3.html",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  site_caso_4: {
    id: "site_caso_4",
    titulo: "Ficha tecnica do concierge, Missao 03 -- Nucleo 4, Caso D",
    onde: "https://evento-marcozero.velvoramedia.com.br/caso-4.html",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  site_caso_5: {
    id: "site_caso_5",
    titulo: "Ficha tecnica do concierge, Missao 03 -- Nucleo 5, Caso E",
    onde: "https://evento-marcozero.velvoramedia.com.br/caso-5.html",
    tipo: "site_do_evento",
    lidoEm: "2026-10-22",
  },
  repo_briefing: {
    id: "repo_briefing",
    titulo: "Briefing do projeto (repositorio)",
    onde: "docs/BRIEFING.md",
    tipo: "arquivo_do_repositorio",
    lidoEm: "2026-10-22",
  },
};

export interface Proveniencia {
  readonly fonte: FonteId;
  /** A secao da fonte. No site, a ancora ("#cronologia", "#m02"). */
  readonly secao: string;
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------

/**
 * POR QUE A LACUNA TEM CLASSE. "A propria fonte oficial declara isto como
 * pendencia", "a fonte diz que o conteudo existe em um arquivo que eu nao
 * consegui ler" e "conferi as fontes e nao ha conteudo algum" mandam quem
 * conduz fazer coisas diferentes: cobrar de quem ficou responsavel, pedir o
 * arquivo, ou avisar que ninguem escreveu aquilo ainda.
 */
export type ClasseDeLacuna =
  /** A fonte oficial LISTA isto como pendencia ou como ponto a validar. */
  | "pendencia_declarada"
  /** A fonte diz que o conteudo existe em outro artefato, que nao foi obtido. */
  | "existe_fora_do_meu_alcance"
  /** Conferi as fontes disponiveis e nao ha conteudo oficial para isto. */
  | "ausente_nas_fontes";

export type ItemDoRoteiro =
  | {
      readonly tipo: "oficial";
      readonly rotulo: string;
      readonly texto: string;
      readonly proveniencia: Proveniencia;
    }
  | {
      readonly tipo: "operacao";
      readonly rotulo: string;
      readonly texto: string;
      /**
       * Quando o procedimento so faz sentido por causa de um fato oficial (uma
       * dependencia declarada da jornada, uma regra do dia), a fonte desse FATO
       * vem aqui. O procedimento continua sendo escrito aqui; o fato, nao.
       */
      readonly apoiadoEm?: readonly Proveniencia[];
    }
  | {
      readonly tipo: "lacuna";
      readonly rotulo: string;
      /** O que falta, em uma frase que quem conduz consegue cobrar. */
      readonly falta: string;
      /** De quem tem de vir. Nome proprio quando a fonte nomeia. */
      readonly deQuem: string;
      readonly classe: ClasseDeLacuna;
      /** Onde foi conferido -- ou, na pendencia declarada, onde ela esta escrita. */
      readonly conferidoEm: readonly Proveniencia[];
    };

export type MomentoId =
  | "antes_da_recepcao"
  | "abertura"
  | "tres_missoes"
  | "swot_em_grupo"
  | "mural_do_futuro"
  | "manifesto"
  | "encerramento"
  | "contingencias";

/**
 * Os OITO MOMENTOS, na ordem e com os ids fechados. A lista e a fonte do teste
 * de estrutura: faltar um momento, ou aparecer um nono, quebra a montagem.
 */
export const MOMENTOS_OBRIGATORIOS: readonly MomentoId[] = [
  "antes_da_recepcao",
  "abertura",
  "tres_missoes",
  "swot_em_grupo",
  "mural_do_futuro",
  "manifesto",
  "encerramento",
  "contingencias",
];

export interface MomentoDoRoteiro {
  readonly id: MomentoId;
  readonly numero: number;
  readonly titulo: string;
  /** O horario oficial, quando a cronologia publica um. `null` quando nao ha. */
  readonly quando: string | null;
  readonly itens: readonly ItemDoRoteiro[];
}

export interface RoteiroOficial {
  readonly versao: string;
  readonly momentos: readonly MomentoDoRoteiro[];
}

const S = (secao: string): Proveniencia => ({ fonte: "site_roteiro", secao });

// ---------------------------------------------------------------------------
// 1. Antes da recepcao
// ---------------------------------------------------------------------------

const ANTES_DA_RECEPCAO: MomentoDoRoteiro = {
  id: "antes_da_recepcao",
  numero: 1,
  titulo: "Antes da recepção",
  quando: "preparação antes de 8h15; chegada 8h15 às 9h00",
  itens: [
    {
      tipo: "oficial",
      rotulo: "O dia",
      texto:
        "Marco Zero, o primeiro dia da Geração Preparada. Sábado, 24 de outubro de 2026, 9h às 17h, recepção às 8h15, no Distrito Itaqui. 50 jovens em 5 Núcleos de 10.",
      proveniencia: S("cabeçalho do roteiro"),
    },
    {
      tipo: "oficial",
      rotulo: "Chegada",
      texto:
        "8h15 às 9h00 — Chegada. Celulares recolhidos por Núcleo, crachá com número, pulseira colorida, café e uma garrafa de água Fort por pessoa. Até as 9h, água à vontade.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Formação dos Núcleos",
      texto:
        "9h20 às 9h40 — Formação dos Núcleos. Revelação dos 5 grupos já montados por Matheus e Carol, separando amigos e universidades.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "A roda dos pilares (quem recebe o quê)",
      texto:
        "Cada Núcleo recebe um pilar de manhã e, à tarde, o caso do pilar SEGUINTE — assim ninguém resolve o caso com a própria SWOT. Núcleo 1: pilar Mental de manhã, Caso A (A efetivação, Bruno) à tarde, precisa do painel Profissional do Núcleo 2. Núcleo 2: Profissional, Caso B (O sinal do palco, Lívia), precisa do painel Financeiro do Núcleo 3. Núcleo 3: Financeiro, Caso C (Os 400 inscritos, Caio), precisa do painel Moral do Núcleo 4. Núcleo 4: Moral, Caso D (A equipe que encolheu, Marina), precisa do painel Liderança do Núcleo 5. Núcleo 5: Liderança, Caso E (O diretor desligado, Theo), precisa do painel Mental do Núcleo 1. A roda é Mental para Profissional para Financeiro para Moral para Liderança e volta a Mental.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Materiais para imprimir",
      texto:
        "M01 Cartolinas: ficha técnica do Núcleo, 5 páginas (Núcleos 1 a 5), A2 em gráfica ou A3 colado na cartolina. M02 Matrizes SWOT: uma matriz por pilar, com a definição e as 4 perguntas, A2 em gráfica ou A3 colado na cartolina. M03 O Caso: cenário e caso de cada Núcleo, elenco, ficha de resposta e as 50 cartas para recortar, A4, cartas em papel mais grosso.",
      proveniencia: S("#materiais"),
    },
    {
      tipo: "oficial",
      rotulo: "Produzir até sexta, 23/10 (lista oficial)",
      texto:
        "Cartolinas da Missão 01: arquivo pronto, imprimir 5 em A2 ou A3, comprar post-its e canetas. Matrizes da Missão 02: arquivo pronto, imprimir as 5 em A2 ou A3, post-its de 5 cores. Materiais de O Caso: arquivo pronto, imprimir cenários, elenco (5), fichas de resposta (5) e as 50 cartas, recortar e montar 5 envelopes. Fichas dos concierges: as fichas de O Caso estão prontas no site; faltam as fichas impressas das Missões 01 e 02. Mural do Futuro: 50 murais impressos e pranchetas, a partir das instruções do Carlos. Pacto: versão impressa em tamanho grande para assinatura. Pontuação e observação: ficha de ordem de conclusão e ficha de observação por concierge. Votação da identidade: material com os elementos da marca, a partir dos arquivos da Bia. Credenciamento: lista de presença com contato de emergência, 50 crachás e mapa dos Núcleos com as cores de pulseira. Documentos de apoio: autorização de uso de imagem.",
      proveniencia: S("#pendencias"),
    },
    {
      tipo: "oficial",
      rotulo: "Pessoas e papéis",
      texto:
        "Concierges: um por Núcleo; só observam e tiram dúvidas sobre regras. Gui: materiais e logística — envelopes, post-its, cartolinas; a avaliar se assume a gestão do tempo do dia. Divisão dos Núcleos: feita por Matheus e Carol. Audiovisual: horários das entrevistas, local do cantinho com câmera e prazo do aftermovie com o Felipe.",
      proveniencia: S("#pendencias"),
    },
    {
      tipo: "oficial",
      rotulo: "Logística do espaço",
      texto:
        "Água: 50 garrafas Fort, uma por pessoa, e água liberada no almoço. Recipientes para celulares: um por Núcleo, com capacidade para 10 celulares, ou uma cesta grande para os 50. Guarda e devolução: responsável pelos recipientes e devolução em caso de necessidade. Sem relógio no espaço: conferir se há relógios visíveis no Distrito Itaqui e cobrir. Parede para as matrizes: espaço e fita para fixar as 5 matrizes, que ficam expostas até o fim de O Caso. Comunicação prévia: endereço, horário e orientação de roupa enviados aos selecionados. Alimentação: café, almoço e pausa; restrições alimentares. Segurança: kit de primeiros socorros e contato de emergência.",
      proveniencia: S("#pendencias"),
    },
    {
      tipo: "operacao",
      rotulo: "Conferência de materiais antes de abrir a porta",
      texto:
        "Conferir item por item contra a lista oficial M01, M02 e M03, ANTES de abrir a porta, e separar em cinco pilhas identificadas com o número do Núcleo. Em cada pilha: 1 cartolina, 1 matriz do pilar daquele Núcleo, 1 envelope de 10 cartas (contadas), 1 ficha de resposta, 1 ficha de ordem de conclusão, 1 ficha de observação, 10 Murais, post-its da cor daquele Núcleo, canetas. Anotar em papel, ao lado de cada linha, a quantidade encontrada, quem conferiu e a hora. Item que não estiver na pilha é anotado como FALTANDO, com o Núcleo que ele afeta, e não como conferido.",
    },
    {
      tipo: "operacao",
      rotulo: "Plano sem tecnologia",
      texto:
        "O dia não depende de tela, energia ou rede. Tudo impresso antes de sábado, em duas vias: este Caderno, as 5 cartolinas, as 5 matrizes, as 5 fichas de concierge de O Caso, os 50 Murais, o pacto, as fichas de ordem e de observação. Uma via fica com quem conduz e a outra guardada em outro lugar da sala. O tempo fica com UMA pessoa nomeada, que usa relógio de pulso ou ampulheta de papel fora do campo de visão dos participantes — a regra oficial é que eles não vejam horário em lugar nenhum. Se houver projetor, ele é conveniência e não dependência: nada que precise ser lido em voz alta está só na tela.",
      apoiadoEm: [S("#regras"), S("#cronologia")],
    },
    {
      tipo: "operacao",
      rotulo: "Registro de quem levou o que",
      texto:
        "Uma folha única, em papel, com quatro colunas: item, Núcleo, quem recebeu, hora. A mesma folha serve para a devolução no fim do dia, com duas colunas a mais: quem devolveu e hora. Nada sai da mesa de materiais sem a linha preenchida, e quem recebe assina ao lado do próprio nome. É esta folha que a conferência final do momento 7 confere.",
    },
    {
      tipo: "lacuna",
      rotulo: "Composição dos cinco Núcleos",
      falta:
        "Quem está em cada um dos cinco Núcleos. O roteiro diz que os grupos já estão montados e que a versão final ainda tem de ser confirmada; a lista de nomes não está em nenhuma fonte disponível.",
      deQuem: "Matheus e Carol (divisão dos Núcleos), confirmada pela organização",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#cronologia")],
    },
    {
      tipo: "lacuna",
      rotulo: "Fichas impressas das Missões 01 e 02",
      falta:
        "As fichas de concierge das Missões 01 e 02 — o que o concierge entrega e lê em voz alta em cada uma. O roteiro declara que elas faltam; só as fichas de O Caso estão prontas.",
      deQuem: "quem planejou as missões (Carlos e Yuri), via as fichas de concierge",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias")],
    },
    {
      tipo: "lacuna",
      rotulo: "Briefing dos concierges",
      falta:
        "Se haverá encontro com os concierges antes do evento, e quando. Sem ele, cinco pessoas chegam no sábado sem terem lido o que vão conduzir.",
      deQuem: "a organização",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias")],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. Abertura
// ---------------------------------------------------------------------------

const ABERTURA: MomentoDoRoteiro = {
  id: "abertura",
  numero: 2,
  titulo: "Abertura",
  quando: "9h00 às 9h20",
  itens: [
    {
      tipo: "oficial",
      rotulo: "O que acontece na abertura",
      texto:
        "9h00 às 9h20 — Abertura. Yuri apresenta o propósito do Marco Zero, as regras, a regra da água e a cronologia do dia.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Regras de participação: tempo e papéis",
      texto:
        "Ninguém vê horário: sem relógio, celular ou cronômetro. A organização não define Guardião do Tempo nem outros papéis. Cada Núcleo escolhe o Líder e se organiza como quiser. Água: só a garrafa Fort das 9h até o almoço.",
      proveniencia: S("#regras"),
    },
    {
      tipo: "oficial",
      rotulo: "Regras de participação: o concierge",
      texto:
        "Concierge em toda missão. Entrega o material e lê as instruções. Só tira dúvidas sobre as regras, não opina no conteúdo. Registra a ordem de conclusão e observa os comportamentos.",
      proveniencia: S("#regras"),
    },
    {
      tipo: "oficial",
      rotulo: "Regras de participação: pontuação",
      texto:
        "Pontuação por ordem de conclusão, nesta ordem de pontos: 5, 4, 3, 2 e 1. Vale para as Missões 01, 02 e 03. O placar da manhã define quem mantém o líder à tarde.",
      proveniencia: S("#regras"),
    },
    {
      tipo: "oficial",
      rotulo: "A cronologia, apresentada na abertura",
      texto:
        "A cronologia é apresentada aos jovens na abertura; durante o dia eles não veem horário em nenhum lugar. 8h15–9h00 Chegada. 9h00–9h20 Abertura. 9h20–9h40 Formação dos Núcleos. 9h40–10h20 Missão 01, Quem somos?. 10h20–11h50 Missão 02, SWOT dos pilares. 11h50–12h50 Almoço nos Núcleos. 12h50–13h10 Volta e troca de líder. 13h10–14h30 Missão 03, O Caso. 14h30–14h45 Pausa. 14h45–15h15 Identidade da GP. 15h15–16h05 Mural do Futuro. 16h05–16h30 Manifesto e pacto. 16h30–16h45 Fechamento do Yuri. 16h45–17h00 Rito de pertencimento. Se sobrar tempo entre blocos, a reserva é uma rodada de mímica ou Imagem e Ação entre Núcleos.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Onde o sábado fica dentro da jornada",
      texto:
        "O Marco Zero começa antes do sábado e termina na segunda. O dia é só uma parte da jornada: o Forms de antes e o Mural do Futuro do dia viram o direcionamento individual que cada um recebe na segunda. Quinta 22 ou sexta 23: Forms pré-evento, enviado entre 48h e 24h antes, respostas até sexta — Carlos e Léo montam, Malu valida e envia. Sábado 24: cartolinas, matrizes e Murais recolhidos no fim do dia pelos concierges. Domingo 25: Murais escaneados e cruzados com as respostas do Forms, responsável a definir. Segunda 26: dois documentos, o direcionamento individual com a missão de 30 dias e o Manifesto da GP, consolidado das SWOTs e dos casos — Yuri e Carlos. Semanas seguintes: conversas individuais de 10 a 15 minutos com os participantes.",
      proveniencia: S("#jornada"),
    },
    {
      tipo: "operacao",
      rotulo: "Orientação inicial: o que confirmar nos cinco minutos antes",
      texto:
        "Antes de chamar a sala: as cinco pilhas de material estão nas cinco mesas, identificadas pelo número do Núcleo; a parede das matrizes está livre e a fita já está cortada; os recipientes de celular estão identificados por Núcleo; a folha de registro de materiais está na mesa com caneta; quem controla o tempo está com o único relógio visível da sala e sabe que é o único. Conferir também que não há relógio de parede descoberto, porque a regra oficial é que os participantes não vejam horário.",
      apoiadoEm: [S("#regras"), S("#pendencias")],
    },
    {
      tipo: "lacuna",
      rotulo: "O propósito do Marco Zero, nas palavras oficiais",
      falta:
        "O texto do propósito que é apresentado na abertura. O roteiro diz que ele é apresentado e não registra o que ele diz. Este Caderno NÃO escreve um propósito: a identidade do movimento é construída pelos jovens durante a imersão, e antecipá-la aqui seria inventá-la.",
      deQuem: "Yuri (quem conduz a abertura)",
      classe: "ausente_nas_fontes",
      conferidoEm: [S("#cronologia"), S("#mudou"), { fonte: "repo_briefing", secao: "documento inteiro" }],
    },
    {
      tipo: "lacuna",
      rotulo: "Os objetivos declarados do movimento",
      falta:
        "Os objetivos da Geração Preparada como o movimento os declara. Nenhuma fonte disponível os escreve. Este Caderno não os formula.",
      deQuem: "quem planejou o movimento (Yuri e Carlos)",
      classe: "ausente_nas_fontes",
      conferidoEm: [S("#jornada"), S("#validar"), { fonte: "repo_briefing", secao: "documento inteiro" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. As tres missoes
// ---------------------------------------------------------------------------

const TRES_MISSOES: MomentoDoRoteiro = {
  id: "tres_missoes",
  numero: 3,
  titulo: "As três missões",
  quando: "Missão 01 9h40–10h20 · Missão 02 10h20–11h50 · Missão 03 13h10–14h30",
  itens: [
    {
      tipo: "oficial",
      rotulo: "Missão 01 · Quem somos? — objetivo",
      texto:
        "9h40 às 10h20, 40 min. Transformar 10 desconhecidos em um Núcleo com nome, valores e Líder.",
      proveniencia: S("#m01"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 01 — instruções, por fase",
      texto:
        "0 a 3 min: o concierge entrega a cartolina, os post-its e as canetas e lê a instrução. 3 a 20 min: apresentação dentro do Núcleo só com o primeiro nome; proibido citar faculdade, entidade, curso, cargo ou seguidores. 20 a 38 min: ficha técnica do Núcleo na cartolina — nome do Núcleo, primeiro nome e número GP de cada integrante, 3 valores e Líder; outros papéis, se o grupo quiser. 38 a 40 min: cartolina entregue ao concierge, que registra a ordem de conclusão.",
      proveniencia: S("#m01"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 01 — materiais, entrega e observação",
      texto:
        "Materiais: 1 cartolina impressa por Núcleo, post-its, canetas, fita para fixar. Entrega: ficha do Núcleo completa na cartolina. O concierge observa: quem fala primeiro, quem se candidata a líder, quem organiza, quem controla o tempo.",
      proveniencia: S("#m01"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 02 · SWOT dos pilares — onde está detalhada",
      texto:
        "10h20 às 11h50, 90 min. Cada Núcleo recebe um dos cinco pilares da GP e faz a análise de forças, fraquezas, oportunidades e ameaças a partir da própria vida. É a primeira camada do Manifesto e o material que os outros Núcleos vão usar à tarde. A condução desta missão está no momento 4 deste Caderno.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Almoço",
      texto:
        "11h50 às 12h50 — Almoço nos Núcleos. Mesas por Núcleo, sem celular, água liberada. As matrizes ficam fixadas na parede.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Volta e troca de líder",
      texto:
        "12h50 às 13h10 — Placar das Missões 01 e 02. O Núcleo com mais pontos mantém o líder; nos outros, o líder muda dentro do próprio Núcleo, sem aviso prévio.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 03 · O Caso — cenário",
      texto:
        "13h10 às 14h30, 80 min. A Alavanca é uma liga universitária de negócios em São Paulo. Em 12 dias acontece o Alavanca Day, o maior evento do ano: palco, palestrantes e um patrocinador que só fecha contrato se o evento passar de 400 inscritos. Cinco diretores carregam o evento. Cada um está passando por alguma coisa que os outros ainda não enxergaram. Cinco casos conectados: para resolver o seu, cada Núcleo precisa de cartas e das SWOTs dos outros.",
      proveniencia: S("#caso"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 03 — o que cada Núcleo entrega",
      texto:
        "As 3 respostas: quem está passando pela dificuldade, qual é a dificuldade de fato, e qual é o caminho, montado com a SWOT de outro Núcleo. As cartas: 10 por Núcleo, 6 do próprio caso e 1 de cada caso dos outros; a carta decisiva do quem e a da raiz sempre começam fora. Carta estrela: uma por caso, de contexto; quem terminar com uma estrela de outro caso ganha prêmio, mas deixa o outro Núcleo sem a pista.",
      proveniencia: S("#caso"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 03 — instruções, por fase",
      texto:
        "0 a 10 min: o concierge lê o cenário e o caso; o Núcleo abre o envelope e organiza as cartas; o novo Líder já está no comando. 10 a 55 min: negociação — só os Líderes saem do Núcleo, trocas de 1 carta por 1 carta, vale levar vantagem. 55 a 75 min: caminho — o Núcleo vai ao painel do pilar do caso, feito por outro Núcleo de manhã, e monta a resposta com pelo menos 2 itens dele. 75 a 80 min: ficha de resposta conferida com o gabarito; a ordem de aprovação define os pontos.",
      proveniencia: S("#caso"),
    },
    {
      tipo: "oficial",
      rotulo: "Missão 03 — regras que o concierge lembra",
      texto:
        "Só o Líder sai do Núcleo para negociar; trocas de 1 carta por 1 carta. Vale levar vantagem, esconder o que tem e negociar duro; não vale tomar carta à força. A entrega é a ficha de resposta com as 3 respostas; não precisa ter as 10 cartas. O concierge não dá dica sobre o conteúdo, só tira dúvida sobre regra. Registrar a ordem de aprovação para os pontos.",
      proveniencia: { fonte: "site_caso_1", secao: "REGRAS PARA LEMBRAR" },
    },
    {
      tipo: "oficial",
      rotulo: "Missão 03 — as cinco fichas de concierge (história, cartas, gabarito, conexões)",
      texto:
        "Cada Núcleo tem uma ficha própria, com o texto para ler em voz alta, o elenco, as 10 cartas, o conteúdo do envelope, o gabarito, como o caso conversa com os outros e o que observar. Elas NÃO estão reproduzidas neste Caderno: são material do concierge, trazem o gabarito e têm de ser IMPRESSAS antes de sábado, uma por Núcleo. Núcleo 1, Caso A: caso-1.html. Núcleo 2, Caso B: caso-2.html. Núcleo 3, Caso C: caso-3.html. Núcleo 4, Caso D: caso-4.html. Núcleo 5, Caso E: caso-5.html — todas em https://evento-marcozero.velvoramedia.com.br/.",
      proveniencia: S("#caso"),
    },
    {
      tipo: "oficial",
      rotulo: "Papel do facilitador e do concierge nas três missões",
      texto:
        "O concierge entrega o material e lê as instruções, só tira dúvidas sobre as regras e não opina no conteúdo, registra a ordem de conclusão e observa os comportamentos. A organização não define Guardião do Tempo nem outros papéis: cada Núcleo escolhe o Líder e se organiza como quiser.",
      proveniencia: S("#regras"),
    },
    {
      tipo: "oficial",
      rotulo: "Critério de encerramento de cada missão",
      texto:
        "Missão 01 encerra na entrega da cartolina ao concierge, que registra a ordem de conclusão (38 a 40 min). Missão 02 encerra na entrega da matriz com as conclusões e no registro da ordem (50 a 60 min), seguida das apresentações. Missão 03 encerra na conferência da ficha de resposta com o gabarito, e a ordem de aprovação define os pontos (75 a 80 min). Em todas, a pontuação é por ordem: 5, 4, 3, 2 e 1.",
      proveniencia: S("#regras"),
    },
    {
      tipo: "operacao",
      rotulo: "Guarda das entregas, missão por missão",
      texto:
        "No momento da entrega, antes de a peça sair da mesa: o concierge escreve no verso da cartolina, da matriz e da ficha de resposta o número do Núcleo e a hora da entrega, e assina. A ficha de ordem de conclusão é preenchida na hora, não de memória no fim do dia. Cada peça entregue vai para a pilha daquele Núcleo, nunca para uma pilha comum. A matriz é a exceção: ela vai para a parede e fica lá até o fim de O Caso, porque é pista da tarde — quem a retirar antes derruba a Missão 03 de outro Núcleo.",
      apoiadoEm: [S("#m02"), S("#caso"), S("#regras")],
    },
    {
      tipo: "lacuna",
      rotulo: "O que o concierge lê em voz alta nas Missões 01 e 02",
      falta:
        "As palavras exatas da instrução de abertura das Missões 01 e 02. O roteiro diz que o concierge lê a instrução e, para essas duas missões, a ficha com o texto ainda não existe — o próprio roteiro a lista como pendência. Para a Missão 03 o texto existe, na ficha de cada Núcleo. Este Caderno não escreve as instruções que faltam.",
      deQuem: "quem planejou as missões (Carlos e Yuri), via as fichas impressas das Missões 01 e 02",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#m01"), S("#m02")],
    },
    {
      tipo: "lacuna",
      rotulo: "As histórias de O Caso, validadas",
      falta:
        "A validação das histórias dos cinco casos. O roteiro diz que o rascunho está pronto nas fichas por Núcleo e que falta validar.",
      deQuem: "Yuri e Carlos",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#validar")],
    },
    {
      tipo: "lacuna",
      rotulo: "Como o novo Líder é escolhido na troca do meio-dia",
      falta:
        "Se o novo Líder é escolhido pelo próprio Núcleo na hora ou indicado pela organização. O roteiro lista isto como ponto a validar, e o critério do placar (Missões 01 e 02) também está em aberto.",
      deQuem: "Yuri e Carlos",
      classe: "pendencia_declarada",
      conferidoEm: [S("#validar"), S("#pendencias")],
    },
    {
      tipo: "lacuna",
      rotulo: "Carta estrela: se entra e qual é o prêmio",
      falta:
        "Se a carta estrela entra no jogo e qual é o prêmio de quem terminar com uma. O roteiro descreve a mecânica e lista a decisão como pendente.",
      deQuem: "Yuri e Carlos",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#validar")],
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. SWOT em grupo
// ---------------------------------------------------------------------------

const SWOT_EM_GRUPO: MomentoDoRoteiro = {
  id: "swot_em_grupo",
  numero: 4,
  titulo: "SWOT em grupo (Missão 02)",
  quando: "10h20 às 11h50 · 90 min",
  itens: [
    {
      tipo: "oficial",
      rotulo: "O que a missão é",
      texto:
        "Cada Núcleo recebe um dos cinco pilares da GP e faz a análise de forças, fraquezas, oportunidades e ameaças a partir da própria vida. É a primeira camada do Manifesto e o material que os outros Núcleos vão usar à tarde.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Os cinco pilares, como aparecem no topo de cada matriz",
      texto:
        "Mental: como a nossa geração cuida da cabeça — foco, emoções, descanso, uso do celular e pressão. Profissional: como a nossa geração constrói carreira — entregas, disciplina, prioridades e relação com quem lidera. Financeiro: como a nossa geração lida com dinheiro — consumo, dívidas, reserva e independência. Moral: como a nossa geração sustenta valores — verdade, palavra, integridade e pressão do grupo. Liderança: como a nossa geração lidera — assumir responsabilidade, ouvir, delegar e servir ao grupo.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "A roda, e a única troca permitida",
      texto:
        "Cada Núcleo recebe à tarde o caso do pilar seguinte ao que analisou, de modo que ninguém resolve o caso com a própria SWOT e todos dependem do trabalho de outro Núcleo. Se o Forms indicar um pilar melhor para algum grupo, troque o pilar: o caso acompanha o pilar, não o número do Núcleo.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Instruções, por fase",
      texto:
        "0 a 5 min: o concierge entrega a matriz do pilar impressa e lê a definição do pilar. 5 a 20 min: individual — cada um responde em post-its as 4 perguntas da matriz pensando na própria vida, uma ideia por post-it. 20 a 50 min: coletivo — post-its no quadrante certo, ideias agrupadas, o que é comum à geração em destaque. 50 a 60 min: conclusões no rodapé da matriz, escritas pelo próprio Núcleo — 3 coisas que a geração precisa desenvolver nesse pilar e uma frase para o Manifesto; entrega e registro da ordem. 60 a 90 min: apresentações de 5 minutos por Núcleo; as 5 matrizes ficam na parede, porque viram pista para O Caso à tarde.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Materiais, entrega e observação",
      texto:
        "Materiais: 5 matrizes impressas, uma por pilar, post-its de uma cor por Núcleo, canetas. Entrega: matriz preenchida com as conclusões. O concierge observa: quem se expõe, quem sintetiza, quem conecta com a vida prática.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "operacao",
      rotulo: "Operação da missão (não é o conteúdo dela)",
      texto:
        "Antes do início: as 5 matrizes já fixadas na parede, cada uma identificada com o pilar e o número do Núcleo, e os post-its separados em cinco sacos, uma cor por Núcleo. Durante: quem controla o tempo avisa o concierge, nunca os participantes, nas marcas de 5, 20, 50 e 60 minutos — os participantes não veem horário. Na marca dos 60 minutos a ficha de ordem de conclusão é preenchida na hora. Depois das apresentações: as matrizes NÃO saem da parede; elas são pista da Missão 03 e saem só no fim do dia, quando são recolhidas com o número do Núcleo e a hora escritos no verso.",
      apoiadoEm: [S("#m02"), S("#regras"), S("#jornada")],
    },
    {
      tipo: "lacuna",
      rotulo: "As quatro perguntas da matriz SWOT",
      falta:
        "O texto exato das 4 perguntas que cada participante responde em post-its. O roteiro as chama de 'as 4 perguntas da matriz' e diz que elas estão impressas na matriz do pilar (material M02); o texto delas não está publicado no roteiro nem existe no repositório. Este Caderno NÃO as escreve: formular as perguntas da SWOT é escrever o planejamento pedagógico aprovado.",
      deQuem: "quem planejou a Missão 02 (Carlos e Yuri), via o arquivo M02 das matrizes",
      classe: "existe_fora_do_meu_alcance",
      conferidoEm: [S("#m02"), S("#materiais"), { fonte: "repo_briefing", secao: "documento inteiro" }],
    },
    {
      tipo: "lacuna",
      rotulo: "As perguntas de condução da SWOT",
      falta:
        "As perguntas que quem conduz faz ao Núcleo durante a missão. Nenhuma fonte disponível as traz. Este Caderno não as inventa por duas razões: são planejamento pedagógico aprovado, e uma pergunta de condução escrita por fora corre o risco de atribuir característica aos jovens antes de eles falarem — o que nenhum momento deste Caderno faz. Quando elas chegarem, a regra que elas têm de respeitar é a deste Caderno: pergunta facilitadora é instrução de processo, do tipo 'Como vocês chegaram a essa decisão?', e nunca uma frase que afirme algo sobre quem está na sala.",
      deQuem: "quem planejou a Missão 02 (Carlos e Yuri)",
      classe: "ausente_nas_fontes",
      conferidoEm: [S("#m02"), S("#regras"), { fonte: "repo_briefing", secao: "documento inteiro" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// 5. Mural do Futuro
// ---------------------------------------------------------------------------

const MURAL_DO_FUTURO: MomentoDoRoteiro = {
  id: "mural_do_futuro",
  numero: 5,
  titulo: "Mural do Futuro",
  quando: "15h15 às 16h05 · 50 min (precedido por Identidade da GP, 14h45 às 15h15)",
  itens: [
    {
      tipo: "oficial",
      rotulo: "Pausa",
      texto: "14h30 às 14h45 — Pausa. Café e hidratação. Celulares seguem guardados.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "Identidade da GP — a atividade que antecede o Mural",
      texto:
        "14h45 às 15h15, 30 min. Os 50 participam da construção da marca da Geração Preparada, para depois dizer 'eu ajudei a criar isso'. 0 a 5 min: apresentação dos elementos da identidade visual feitos pela Bia. 5 a 20 min: cada Núcleo debate e escolhe o elemento que melhor representa a GP. 20 a 30 min: votação geral e revelação do resultado. (Este bloco não é um dos oito momentos; está aqui porque é o que acontece imediatamente antes do Mural.)",
      proveniencia: S("#identidade"),
    },
    {
      tipo: "oficial",
      rotulo: "O Mural do Futuro",
      texto:
        "15h15 às 16h05, 50 min. Individual e em papel: quem eu preciso me tornar e o que faço nos próximos 30 dias. Preenchido à mão, sem celular, para evitar respostas prontas, com instruções do Carlos. Termina com uma missão concreta para os próximos 30 dias.",
      proveniencia: S("#fechamento"),
    },
    {
      tipo: "oficial",
      rotulo: "Materiais, entrega e destino",
      texto:
        "Materiais: 50 Murais impressos, pranchetas, canetas. Entrega: o Mural de cada um, recolhido e escaneado depois. Destino: o Mural e o Forms viram o direcionamento individual de segunda. Domingo 25: Murais escaneados e cruzados com as respostas do Forms. Segunda 26: direcionamento individual com a missão de 30 dias, por Yuri e Carlos.",
      proveniencia: S("#fechamento"),
    },
    {
      tipo: "operacao",
      rotulo: "Coleta e identificação",
      texto:
        "Antes de distribuir: cada Mural recebe, a lápis no canto, o número do Núcleo e um número sequencial de 1 a 10 — a folha fica identificada mesmo que quem escreveu não se identifique. O participante escreve nela só o primeiro nome e o número GP do crachá, que é a regra de identificação do dia. Recolher por Núcleo, no envelope daquele Núcleo, contando em voz alta contra a lista de dez daquele Núcleo. Na frente do envelope: número do Núcleo, quantidade recolhida, hora, e o nome de quem contou. Mural que não voltou entra como linha própria no envelope — número do crachá e 'não entregue'. Folha em branco NÃO é preenchida por outra pessoa, e nada é transcrito, resumido ou interpretado durante a coleta.",
      apoiadoEm: [S("#m01"), S("#fechamento")],
    },
    {
      tipo: "operacao",
      rotulo: "Preservação até domingo",
      texto:
        "Os cinco envelopes vão fechados para uma única caixa, junto com a folha de registro de materiais. A caixa é lacrada, identificada com a data do evento, e entregue a UMA pessoa nomeada, que assina a folha. Se ninguém tiver sido nomeado, quem conduz fica com a caixa e escreve isso na folha — a caixa não fica com o espaço. Os originais em papel não são descartados: eles voltam para os envelopes depois da digitalização e ficam guardados pelo menos até o direcionamento individual de segunda estar entregue.",
      apoiadoEm: [S("#jornada")],
    },
    {
      tipo: "operacao",
      rotulo: "Digitalização posterior (domingo)",
      texto:
        "Abrir um envelope por vez e fechá-lo antes de abrir o próximo. Escanear na ordem do envelope, um arquivo por Mural, nomeado com o número do Núcleo e o número sequencial da folha. Conferir a quantidade de arquivos contra a quantidade escrita na frente do envelope ANTES de guardar; divergência é resolvida recontando o papel, nunca ajustando o número escrito. Devolver os originais ao envelope e registrar, na folha, quem escaneou e a hora. A digitalização não corrige, não completa e não interpreta o que está escrito à mão.",
      apoiadoEm: [S("#jornada")],
    },
    {
      tipo: "lacuna",
      rotulo: "As instruções do Mural do Futuro",
      falta:
        "O texto das instruções que são dadas aos participantes para preencher o Mural, e o próprio conteúdo da folha do Mural. O roteiro diz 'com instruções do Carlos' e lista, como pendência, que Carlos ainda tem de enviá-las ao Yuri e à Malu. Este Caderno não escreve as instruções: sem elas não há como imprimir os 50 Murais, e isso tem de estar resolvido antes de sexta.",
      deQuem: "Carlos (envia ao Yuri e à Malu)",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#fechamento")],
    },
    {
      tipo: "lacuna",
      rotulo: "Arquivos da identidade visual e formato da votação",
      falta:
        "Os arquivos finais dos elementos da marca e a definição do formato da votação do bloco Identidade da GP. O roteiro lista os dois como pendentes.",
      deQuem: "Bia (arquivos) e a organização (formato da votação)",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#identidade")],
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. Manifesto
// ---------------------------------------------------------------------------

const MANIFESTO: MomentoDoRoteiro = {
  id: "manifesto",
  numero: 6,
  titulo: "Manifesto e pacto",
  quando: "16h05 às 16h30 · 25 min",
  itens: [
    {
      tipo: "oficial",
      rotulo: "O que acontece",
      texto:
        "16h05 às 16h30, 25 min. As 5 SWOTs e os 5 casos viram a base do Manifesto: leitura das conclusões das 5 SWOTs e dos 5 caminhos de O Caso. Todos assinam o pacto da primeira geração.",
      proveniencia: S("#fechamento"),
    },
    {
      tipo: "oficial",
      rotulo: "De onde sai a matéria-prima do Manifesto",
      texto:
        "Da Missão 02: no rodapé de cada matriz, escritas pelo próprio Núcleo, 3 coisas que a geração precisa desenvolver naquele pilar e uma frase para o Manifesto. Da Missão 03: cinco caminhos práticos, um por pilar, construídos sobre o que a própria geração disse de si mesma de manhã, e a descoberta de que nenhum pilar resolve a vida sozinho. Os dois entram no Manifesto.",
      proveniencia: S("#m02"),
    },
    {
      tipo: "oficial",
      rotulo: "Materiais",
      texto: "Pacto impresso em tamanho grande para assinatura.",
      proveniencia: S("#fechamento"),
    },
    {
      tipo: "oficial",
      rotulo: "Quem consolida, e quando",
      texto:
        "O Manifesto da GP é consolidado das SWOTs e dos casos e entregue na segunda, 26, junto com o direcionamento individual. Responsáveis: Yuri e Carlos.",
      proveniencia: S("#jornada"),
    },
    {
      tipo: "operacao",
      rotulo: "Procedimento da leitura, sem inventar conclusão pelo grupo",
      texto:
        "As 5 matrizes e as 5 fichas de resposta vão para a frente da sala e ficam visíveis. Quem lê, lê SÓ o que está escrito no rodapé das matrizes e nas fichas, palavra por palavra, na ordem dos Núcleos, sem acrescentar conclusão, sem resumir em uma frase própria e sem corrigir a redação do grupo. Se uma conclusão estiver ilegível, a pergunta vai para o Núcleo que a escreveu: 'o que vocês escreveram aqui?' — a resposta é deles, não de quem lê. Nada é declarado como conclusão do conjunto neste momento: o Manifesto é consolidado na segunda, por quem o roteiro nomeia.",
      apoiadoEm: [S("#fechamento"), S("#m02"), S("#jornada")],
    },
    {
      tipo: "operacao",
      rotulo: "Procedimento da assinatura e guarda do pacto",
      texto:
        "O pacto fica deitado em superfície firme, com duas canetas, e as assinaturas acontecem em fila por Núcleo, um Núcleo por vez, para que ninguém assine duas vezes nem fique de fora. Contar as assinaturas contra a lista de presença e escrever a contagem na folha de registro. Fotografar a folha assinada antes de guardá-la, e guardá-la plana em envelope rígido, que entra na mesma caixa dos Murais.",
      apoiadoEm: [S("#fechamento"), S("#pendencias")],
    },
    {
      tipo: "lacuna",
      rotulo: "O texto do pacto, o formato da assinatura e quem conduz",
      falta:
        "O texto do pacto da primeira geração, o formato da assinatura e quem conduz o momento da assinatura. O roteiro lista os três como pendentes e a validar. Sem o texto não há o que imprimir em tamanho grande, e isso tem de estar resolvido antes de sexta.",
      deQuem: "Yuri e Carlos",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#validar")],
    },
    {
      tipo: "lacuna",
      rotulo: "O método de construção coletiva do Manifesto",
      falta:
        "Como os 25 minutos constroem o Manifesto além da leitura das conclusões: se há votação, se há redação coletiva de frases, se o grupo aprova um texto no dia. O roteiro descreve o que é lido e que todos assinam o pacto, e não descreve método de construção. Este Caderno não escreve um: método de construção do Manifesto é planejamento pedagógico aprovado.",
      deQuem: "Yuri e Carlos (quem consolida o Manifesto na segunda)",
      classe: "ausente_nas_fontes",
      conferidoEm: [S("#fechamento"), S("#jornada"), S("#validar")],
    },
  ],
};

// ---------------------------------------------------------------------------
// 7. Encerramento
// ---------------------------------------------------------------------------

const ENCERRAMENTO: MomentoDoRoteiro = {
  id: "encerramento",
  numero: 7,
  titulo: "Encerramento",
  quando: "16h30 às 17h00",
  itens: [
    {
      tipo: "oficial",
      rotulo: "Fechamento e rito",
      texto:
        "16h30 às 16h45 — Fechamento do Yuri: o que acontece a partir de segunda e o papel de cada um na comunidade. 16h45 às 17h00 — Rito de pertencimento: crachá virado, símbolo da GP entregue e foto oficial.",
      proveniencia: S("#cronologia"),
    },
    {
      tipo: "oficial",
      rotulo: "O que é recolhido, e por quem",
      texto:
        "Sábado 24: cartolinas, matrizes e Murais recolhidos no fim do dia. Responsáveis: os concierges.",
      proveniencia: S("#jornada"),
    },
    {
      tipo: "oficial",
      rotulo: "A passagem para o trabalho de domingo",
      texto:
        "Domingo 25: Murais escaneados e cruzados com as respostas do Forms. Responsável: a definir. Segunda 26: dois documentos — o direcionamento individual com a missão de 30 dias e o Manifesto da GP, consolidado das SWOTs e dos casos. Responsáveis: Yuri e Carlos.",
      proveniencia: S("#jornada"),
    },
    {
      tipo: "oficial",
      rotulo: "Devolução dos celulares",
      texto:
        "Guarda e devolução: há um responsável pelos recipientes e pela devolução em caso de necessidade.",
      proveniencia: S("#pendencias"),
    },
    {
      tipo: "operacao",
      rotulo: "Conferência final dos materiais",
      texto:
        "Conferir contra a folha de registro aberta no momento 1, linha por linha, com a quantidade encontrada, quem recebeu, a hora e a assinatura: 5 cartolinas; 5 matrizes; 5 envelopes de cartas, recontadas até 10 cada; 5 fichas de resposta; 5 fichas de ordem de conclusão; 5 fichas de observação; os Murais, contados contra os envelopes; o pacto assinado; a lista de presença; as autorizações de uso de imagem. Linha que não fecha é anotada como não fechada, com o número encontrado — nunca ajustada para fechar. A folha sai em duas vias: uma fica com quem conduziu, outra vai dentro da caixa.",
      apoiadoEm: [S("#materiais"), S("#pendencias"), S("#jornada")],
    },
    {
      tipo: "operacao",
      rotulo: "Devolução dos celulares, Núcleo por Núcleo",
      texto:
        "Um Núcleo por vez, no recipiente daquele Núcleo, com o concierge daquele Núcleo presente. Ninguém sai antes de o recipiente do próprio Núcleo estar vazio. Aparelho que sobrar no recipiente é anotado na folha com o número do Núcleo e entregue a quem é responsável pela guarda, não deixado no espaço.",
      apoiadoEm: [S("#cronologia"), S("#pendencias")],
    },
    {
      tipo: "operacao",
      rotulo: "Passagem para domingo",
      texto:
        "A caixa lacrada, com os cinco envelopes de Murais, o pacto, as cartolinas, as matrizes e a via da folha de registro, é entregue a uma pessoa nomeada, que assina. A folha diz o que está dentro, quantos Murais, e o que não fechou. Quem recebe a caixa precisa ter, por escrito, duas informações: onde a digitalização acontece e até quando — porque o direcionamento individual de segunda depende dela.",
      apoiadoEm: [S("#jornada")],
    },
    {
      tipo: "lacuna",
      rotulo: "Quem escaneia e cruza os dados",
      falta:
        "Quem faz a digitalização dos Murais no domingo e o cruzamento com o Forms, e o modelo dos documentos de segunda. O roteiro registra o responsável de domingo como 'a definir' e lista o modelo dos documentos como pendência.",
      deQuem: "a organização (hoje sem nome definido)",
      classe: "pendencia_declarada",
      conferidoEm: [S("#jornada"), S("#pendencias")],
    },
    {
      tipo: "lacuna",
      rotulo: "O símbolo de pertencimento do rito",
      falta:
        "Qual é o item entregue no rito de pertencimento, e se há tempo de produzir 50. O roteiro descreve o rito e lista o símbolo como pendente.",
      deQuem: "a organização",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#cronologia")],
    },
    {
      tipo: "lacuna",
      rotulo: "As conversas individuais das semanas seguintes",
      falta:
        "Quem conduz as conversas individuais de 10 a 15 minutos e quando elas acontecem. O roteiro as prevê e lista as duas definições como pendentes.",
      deQuem: "a organização",
      classe: "pendencia_declarada",
      conferidoEm: [S("#pendencias"), S("#jornada")],
    },
  ],
};

// ---------------------------------------------------------------------------
// 8. Contingencias
// ---------------------------------------------------------------------------

const CONTINGENCIAS: MomentoDoRoteiro = {
  id: "contingencias",
  numero: 8,
  titulo: "Contingências",
  quando: null,
  itens: [
    {
      tipo: "operacao",
      rotulo: "Ausência de respostas do Forms",
      texto:
        "O envio do Forms pré-evento depende de uma etapa que pode não acontecer, e é possível que NENHUMA resposta exista até sábado. O dia não depende delas. No roteiro, o Forms toca o sábado em UM lugar só: a permissão de trocar o pilar de um grupo se o Forms indicar um pilar melhor. Com zero respostas essa permissão simplesmente não é usada, e a roda dos pilares fica exatamente como está publicada — Núcleo 1 Mental, Núcleo 2 Profissional, Núcleo 3 Financeiro, Núcleo 4 Moral, Núcleo 5 Liderança. O outro lugar onde o Forms entra é o direcionamento individual de segunda, que é depois do evento. Então: nada da condução de sábado muda, e escreve-se na folha de registro 'Forms sem respostas: roda mantida como publicada'. O que NÃO se faz: substituir o dado que não chegou por uma impressão sobre o grupo. Este Caderno existe para ser conduzido inteiro com zero respostas, e nenhum momento dele precisa de uma.",
      apoiadoEm: [S("#m02"), S("#jornada")],
    },
    {
      tipo: "operacao",
      rotulo: "Falta de internet, de energia ou de tela",
      texto:
        "Nada do dia é lido de uma tela. Este Caderno é impresso antes de sábado, em duas vias, e vale em papel; as cinco fichas de concierge de O Caso, as cartolinas, as matrizes, os Murais, o pacto e as fichas de ordem e de observação também. Sem energia: o tempo fica com quem está de relógio de pulso, fora do campo de visão dos participantes, e as apresentações acontecem sem microfone, em círculo mais fechado. Sem rede: não há nada a consultar — o que não estiver impresso não existe no dia, e é por isso que a conferência do momento 1 acontece antes de abrir a porta. O único bloco com risco de tela é a apresentação dos elementos da identidade visual; se não houver como projetar, os elementos vão impressos.",
      apoiadoEm: [S("#regras"), S("#identidade"), S("#materiais")],
    },
    {
      tipo: "operacao",
      rotulo: "Atraso no início ou no meio do dia",
      texto:
        "A primeira coisa a cair é a reserva prevista no roteiro (a rodada de mímica ou Imagem e Ação entre blocos). Depois dela, encurtar nesta ordem: as apresentações da Missão 02 (a fase de 60 a 90 minutos), o bloco Identidade da GP (30 minutos) e a pausa. O que NÃO se encurta são as fases de ENTREGA: 38 a 40 na Missão 01, 50 a 60 na Missão 02, 75 a 80 na Missão 03, e os 50 minutos do Mural. A razão não é de condução, é de dependência declarada: as matrizes, as fichas de resposta e os Murais são a entrada do domingo e da segunda, e um dia que termina sem eles quebra o direcionamento individual e o Manifesto. Anotar na folha de registro qual fase foi encurtada e em quantos minutos — quem consolida na segunda precisa saber.",
      apoiadoEm: [S("#cronologia"), S("#jornada"), S("#m02"), S("#caso"), S("#fechamento")],
    },
    {
      tipo: "operacao",
      rotulo: "Menos gente do que o previsto",
      texto:
        "O formato oficial é 5 Núcleos de 10, e a roda exige que os cinco pilares sejam analisados: cada Núcleo depende do painel de outro Núcleo à tarde. Com menos gente, mantenha CINCO Núcleos, menores. Juntar Núcleos derruba um pilar da parede e deixa um caso da tarde sem o painel de que ele precisa — e isso não é decisão de quem conduz no dia, é de quem planejou. Anotar na folha de registro quantas pessoas chegaram em cada Núcleo. Se a quantidade for baixa o bastante para que um Núcleo fique com menos de três pessoas, pare e fale com quem planejou antes de mudar o formato; se não houver tempo para isso, mantenha os cinco Núcleos e registre a composição real.",
      apoiadoEm: [S("#m02"), S("#caso")],
    },
    {
      tipo: "operacao",
      rotulo: "Materiais incompletos",
      texto:
        "A conferência do momento 1 é o que transforma material faltando em problema conhecido, e não em surpresa na sala. Item impresso que faltar: usar a segunda via; se não houver segunda via, o concierge conduz pela via impressa deste Caderno e da ficha, e a falta é anotada com o Núcleo afetado. CONTEÚDO que faltar é outra coisa, e é mais grave: quando o que falta é uma das lacunas declaradas deste Caderno — as instruções do Mural, as 4 perguntas da matriz, o texto do pacto, o texto lido nas Missões 01 e 02 — a atividade NÃO é improvisada. Antes de sábado, quem conduz cobra de quem está nomeado na lacuna. Se chegar sábado com a lacuna aberta, quem conduz diz em voz alta que o conteúdo oficial daquela atividade não chegou, e não o inventa no lugar.",
      apoiadoEm: [S("#materiais"), S("#pendencias")],
    },
    {
      tipo: "operacao",
      rotulo: "Falta um concierge",
      texto:
        "O desenho oficial é um concierge por Núcleo, e é ele quem registra a ordem de conclusão. Núcleo sem ninguém para registrar a ordem não tem pontuação, e o placar da manhã é o que decide a troca de líder do meio-dia. Se faltar um: quem conduz assume aquele Núcleo, anota na folha que o Núcleo ficou sem concierge próprio e a partir de que hora, e a troca de líder do meio-dia é tratada com quem planejou — não resolvida no improviso, porque o critério do placar é uma das pendências declaradas.",
      apoiadoEm: [S("#regras"), S("#cronologia"), S("#validar")],
    },
    {
      tipo: "operacao",
      rotulo: "Quem decide o que este Caderno não decide",
      texto:
        "Qualquer mudança em conteúdo oficial — pilar de um Núcleo, ordem das missões, texto do pacto, método do Manifesto, o que é lido em voz alta — é de quem planejou, nomeado item por item nas lacunas deste Caderno. Este Caderno decide procedimento: conferência, guarda, registro, contagem, digitalização e o que fazer quando falta algo. A diferença entre as duas coisas está marcada em cada item, e é ela que permite dizer, depois, o que foi conduzido como planejado e o que foi conduzido sem o planejamento ter chegado.",
    },
  ],
};

// ---------------------------------------------------------------------------
// O roteiro
// ---------------------------------------------------------------------------

export const ROTEIRO_OFICIAL: RoteiroOficial = {
  versao: VERSAO_DO_ROTEIRO,
  momentos: [
    ANTES_DA_RECEPCAO,
    ABERTURA,
    TRES_MISSOES,
    SWOT_EM_GRUPO,
    MURAL_DO_FUTURO,
    MANIFESTO,
    ENCERRAMENTO,
    CONTINGENCIAS,
  ],
};
