export type EventStatus = "draft" | "live" | "processing" | "completed";
export type PrognosticStatus = "pending" | "generated" | "reviewed" | "delivered";
export type TrailRecommendation =
  | "Exploração"
  | "Direção"
  | "Aproximação"
  | "Aceleração"
  | "Sessão Privada";

export type QuestionType = "select" | "text";

export interface QuizQuestion {
  id: string;
  type: QuestionType;
  text: string;
  options?: string[];
  placeholder?: string;
  min_chars?: number;
  required?: boolean;
}

export interface QuizStage {
  id: number;
  title: string;
  ambient_name: string;
  description: string | null;
  questions: QuizQuestion[];
}

export interface Event {
  id: string;
  name: string;
  event_code: string;
  event_date: string;
  status: EventStatus;
  current_stage: number;
  host_name: string;
  location_name: string | null;
  max_participants: number;
  created_at: string;
  updated_at: string;
}

export interface Participant {
  id: string;
  event_id: string;
  user_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  course_or_moment: string | null;
  joined_at: string;
  completed_at: string | null;
}

export interface QuizResponse {
  id: string;
  participant_id: string;
  stage_id: number;
  answers: Record<string, string | string[]>;
  submitted_at: string;
}

export interface Prognostic {
  id: string;
  participant_id: string;
  raw_ai_output: PrognosticContent;
  edited_content: PrognosticContent | null;
  final_content: PrognosticContent | null;
  status: PrognosticStatus;
  trail_recommendation: TrailRecommendation | null;
  yuri_note: string | null;
  generated_at: string | null;
  reviewed_at: string | null;
  delivered_at: string | null;
  pdf_url: string | null;
  public_share_token: string;
}

export interface PrognosticContent {
  analise_geral: string;
  areas_chave: Array<{
    nome: string;
    direcionamento: string;
  }>;
  plano_30_dias: Array<{
    comportamento: string;
    microacao: string;
  }>;
  praticas: Array<{
    nome: string;
    descricao: string;
  }>;
  frase_ativacao: {
    frase: string;
    contexto: string;
  };
  trilha_recomendada: TrailRecommendation;
  justificativa_trilha: string;
}

export interface ParticipantProfile {
  id: string;
  full_name: string;
  event_id: string;
  trail_recommendation: TrailRecommendation | null;
  prognostic_status: PrognosticStatus | null;
  stages_completed: number;
  completed_at: string | null;
}

export interface Database {
  public: {
    Tables: {
      events: {
        Row: Event;
        Insert: Omit<Event, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Event, "id" | "created_at">>;
        Relationships: [];
      };
      participants: {
        Row: Participant;
        Insert: Omit<Participant, "id" | "joined_at">;
        Update: Partial<Omit<Participant, "id" | "event_id">>;
        Relationships: [];
      };
      quiz_stages: {
        Row: QuizStage;
        Insert: QuizStage;
        Update: Partial<QuizStage>;
        Relationships: [];
      };
      quiz_responses: {
        Row: QuizResponse;
        Insert: Omit<QuizResponse, "id" | "submitted_at">;
        Update: Partial<QuizResponse>;
        Relationships: [];
      };
      prognostics: {
        Row: Prognostic;
        Insert: Omit<Prognostic, "id" | "public_share_token">;
        Update: Partial<Omit<Prognostic, "id" | "participant_id">>;
        Relationships: [];
      };
      event_logs: {
        Row: {
          id: string;
          event_id: string;
          participant_id: string | null;
          action: string;
          payload: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: Omit<{ id: string; event_id: string; participant_id: string | null; action: string; payload: Record<string, unknown> | null; created_at: string; }, "id" | "created_at">;
        Update: Partial<{ event_id: string; participant_id: string | null; action: string; payload: Record<string, unknown> | null; }>;
        Relationships: [];
      };
    };
    Views: {
      participant_profiles: {
        Row: ParticipantProfile;
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
