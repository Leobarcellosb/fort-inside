// AS FOTOS SÃO DO FORT INSIDE, NÃO DO MARCO ZERO.
//
// `ambiente-*` é o imaginário de uma casa -- entrada, sala, cozinha, varanda,
// suíte. Faz sentido na imersão Fort Inside, onde a pessoa de fato percorre a
// casa. O Marco Zero é outro evento: 50 jovens em 5 Núcleos, cartolina, matriz
// de SWOT e Mural do Futuro em papel. Mostrar a casa ali promete uma experiência
// que não vai acontecer.
//
// NÃO há imagem substituta, e isso é de propósito: a identidade visual da
// Geração Preparada é decidida DENTRO do evento (o bloco "Identidade da GP",
// em que os Núcleos escolhem e votam os elementos da marca). Inventar uma arte
// agora seria decidir no lugar deles. Sem imagem, `CinematicHero` cai no
// tratamento tipográfico que ele já tem, que é também a linguagem do material
// do próprio Marco Zero: tipo preto sobre fundo claro, sem foto.
export const AMBIENT_IMAGES = {
  join: "/cinematic/hero-join.jpg",
  waiting: "/cinematic/hero-join.jpg",
  // Stage 1 (Portão / Seu Ponto de Partida) reuses the Entrada image per product decision.
  stage_1: "/cinematic/ambiente-1-entrada.jpg",
  stage_2: "/cinematic/ambiente-1-entrada.jpg",
  stage_3: "/cinematic/ambiente-2-sala.jpg",
  stage_4: "/cinematic/ambiente-3-cozinha.jpg",
  stage_5: "/cinematic/ambiente-4-varanda.jpg",
  stage_6: "/cinematic/ambiente-5-suite.jpg",
  prognostic: "/cinematic/hero-prognostico.jpg",
} as const;

export type AmbientKey = keyof typeof AMBIENT_IMAGES;

/**
 * A versão do quiz do Marco Zero.
 *
 * Quem decide é a VERSÃO DO EVENTO, não uma constante espalhada pelas telas:
 * é a mesma fonte que já governa a contagem de etapas
 * (`lib/quiz/etapas-do-evento.ts`). Um evento novo do Marco Zero nasce sem foto
 * sem ninguém precisar lembrar de mexer na tela.
 */
export const QUIZ_VERSION_MARCO_ZERO = 2;

export function ehMarcoZero(quizVersion: number | null | undefined): boolean {
  return quizVersion === QUIZ_VERSION_MARCO_ZERO;
}

/**
 * A imagem de fundo de uma tela, ou `undefined` quando a tela não deve ter foto.
 *
 * VERSÃO DESCONHECIDA MANTÉM A FOTO, e isto é deliberado. Em todo lugar onde
 * "não consegui verificar" vale como recusa, este projeto bloqueia -- mas aqui
 * não há nada a bloquear: é decoração, e a tela precisa renderizar de qualquer
 * jeito. O legado (Fort Inside) é o único caso em que a foto está certa, então
 * é ele o padrão, e só a confirmação de que é Marco Zero tira a imagem.
 */
export function imagemDoAmbiente(
  chave: AmbientKey,
  quizVersion: number | null | undefined
): string | undefined {
  return ehMarcoZero(quizVersion) ? undefined : AMBIENT_IMAGES[chave];
}

/**
 * O selo que aparece acima do titulo na tela de entrada.
 *
 * O Marco Zero NAO e uma imersao do Fort Inside, e a tela de cadastro estava
 * dizendo que era. Com a foto da casa no fundo isso passava despercebido; sem
 * ela, "IMERSAO FORT INSIDE" ficou sendo a primeira coisa que 50 jovens leem
 * ao entrar num evento que nao se chama assim.
 *
 * O texto e o do proprio material do evento. Nao e identidade de marca fechada
 * -- a marca da Geracao Preparada so vai ser criada DEPOIS do Marco Zero --, e
 * por isso ele e descritivo em vez de conceitual: diz o nome do evento e o nome
 * do movimento, e nada mais.
 */
export function rotuloDaMarca(quizVersion: number | null | undefined): string {
  return ehMarcoZero(quizVersion)
    ? "Marco Zero · Geração Preparada"
    : "Imersão Geração Preparada";
}

/**
 * O atributo que liga a pele do Marco Zero (ver `[data-marca]` em globals.css).
 *
 * Espalhe no elemento que envolve a tela: `<main {...marcaDoEvento(v)}>`.
 * Fora do Marco Zero devolve objeto vazio, então o Fort Inside não recebe
 * atributo nenhum e continua exatamente como era.
 */
export function marcaDoEvento(
  quizVersion: number | null | undefined
): { "data-marca"?: "marco-zero" } {
  return ehMarcoZero(quizVersion) ? { "data-marca": "marco-zero" } : {};
}

export function getStageImage(
  stageId: number,
  quizVersion?: number | null
): string | undefined {
  if (ehMarcoZero(quizVersion)) return undefined;
  const key = `stage_${stageId}` as AmbientKey;
  return AMBIENT_IMAGES[key] ?? AMBIENT_IMAGES.stage_1;
}

/**
 * Shared blur placeholder — a warm-tone 1x1 JPEG base64.
 * Keeps CLS near 0 and prevents a white flash before the hero paints.
 */
export const CINEMATIC_BLUR_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=";
