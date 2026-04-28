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

export function getStageImage(stageId: number): string {
  const key = `stage_${stageId}` as AmbientKey;
  return AMBIENT_IMAGES[key] ?? AMBIENT_IMAGES.stage_1;
}

/**
 * Shared blur placeholder — a warm-tone 1x1 JPEG base64.
 * Keeps CLS near 0 and prevents a white flash before the hero paints.
 */
export const CINEMATIC_BLUR_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=";
