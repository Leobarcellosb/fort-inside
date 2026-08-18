import { z } from "zod";

export const joinEventSchema = z.object({
  full_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres"),
  email: z.string().email("E-mail inválido"),
  phone: z.string().optional(),
  course_or_moment: z.string().optional(),
});

export const quizResponseSchema = z.object({
  participant_id: z.string().uuid(),
  stage_id: z.number().int().min(1).max(6),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.number()])),
});

export const createEventSchema = z.object({
  name: z.string().min(3),
  event_code: z.string().min(3).max(20).regex(/^[A-Z0-9]+$/, "Somente letras maiúsculas e números"),
  event_date: z.string().min(1).transform((v) => (v.length === 16 ? v + ":00" : v)),
  location_name: z.string().optional(),
  max_participants: z.number().int().min(1).max(20).default(8),
  host_name: z.string().default("Yuri Fortes"),
});

export const generatePrognosticSchema = z.object({
  participant_id: z.string().uuid(),
  event_id: z.string().uuid(),
});

export const batchProcessSchema = z.object({
  event_id: z.string().uuid(),
});

export type JoinEventInput = z.infer<typeof joinEventSchema>;
export type CreateEventInput = z.output<typeof createEventSchema>;
export type QuizResponseInput = z.infer<typeof quizResponseSchema>;
