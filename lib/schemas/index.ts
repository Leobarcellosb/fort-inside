import { z } from "zod";

export const joinEventSchema = z.object({
  full_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres"),
  email: z.string().email("E-mail inválido"),
  phone: z.string().optional(),
  course_or_moment: z.string().optional(),
});

export const quizResponseSchema = z.object({
  participant_id: z.string().uuid(),
  stage_id: z.number().int().min(1).max(5),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

export const createEventSchema = z.object({
  name: z.string().min(3),
  event_code: z.string().min(3).max(20).regex(/^[A-Z0-9]+$/, "Somente letras maiúsculas e números"),
  event_date: z.string().min(1).transform((v) => (v.length === 16 ? v + ":00" : v)),
  location_name: z.string().optional(),
  max_participants: z.number().int().min(1).max(20).default(8),
  host_name: z.string().default("Yuri Fortes"),
});

export const updatePrognosticSchema = z.object({
  prognostic_id: z.string().uuid(),
  edited_content: z.object({
    momento_atual: z.string(),
    forca_central: z.string(),
    gargalo_sensivel: z.string(),
    risco_permanecer: z.string(),
    construir_agora: z.string(),
    proximo_passo: z.string(),
    trilha_recomendada: z.enum(["Exploração", "Direção", "Aproximação", "Aceleração", "Sessão Privada"]),
    justificativa_trilha: z.string(),
  }),
  yuri_note: z.string().optional(),
});

export const generatePrognosticSchema = z.object({
  participant_id: z.string().uuid(),
  event_id: z.string().uuid(),
});

export const batchProcessSchema = z.object({
  event_id: z.string().uuid(),
});

export const generatePdfSchema = z.object({
  prognostic_id: z.string().uuid(),
});

export type JoinEventInput = z.infer<typeof joinEventSchema>;
export type CreateEventInput = z.output<typeof createEventSchema>;
export type QuizResponseInput = z.infer<typeof quizResponseSchema>;
export type UpdatePrognosticInput = z.infer<typeof updatePrognosticSchema>;
