export type EventStatus = "draft" | "live" | "processing" | "completed";
export type EventMode = "live" | "async";
// Ordem da maquina de estados (migration 015); o banco recusa regressao.
export type PrognosticStatus =
  | "pending"
  | "generating"
  | "generated"
  | "in_review"
  | "reviewed"
  | "delivered";
export type TrailRecommendation =
  | "Exploração"
  | "Direção"
  | "Aproximação"
  | "Aceleração"
  | "Sessão Privada";

export type QuestionType =
  | "select" // escolha única, já existe
  | "text" // dissertativa, já existe
  | "short_text" // uma linha, sem mínimo
  | "scale" // régua numérica
  | "multi_select" // várias opções
  | "ranking" // ordenar opções por prioridade
  | "dilemma"; // escolha forçada entre duas tensões

export interface QuizQuestion {
  id: string;
  type: QuestionType;
  text: string;
  options?: string[];
  placeholder?: string;
  min_chars?: number;
  required?: boolean;
  min?: number; // scale — default 0
  max?: number; // scale — default 10
  min_label?: string; // scale — rótulo da ponta esquerda
  max_label?: string; // scale — rótulo da ponta direita
  max_choices?: number; // multi_select — máximo de opções
  option_a?: string; // dilemma
  option_b?: string; // dilemma
  max_chars?: number; // short_text
}

export interface QuizStage {
  id: number;
  title: string;
  ambient_name: string;
  description: string | null;
  questions: QuizQuestion[];
  quiz_version: number; // versão do quiz (1 = Fort Inside, 2 = Marco Zero)
  stage_number: number | null; // ordem dentro da versão (id pode começar em 101)
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
  quiz_version: number; // versão do quiz que o evento usa
  mode: EventMode;
  form_opens_at: string | null; // janela do formulário assíncrono; nulos no live
  form_closes_at: string | null;
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
  answers: Record<string, string | string[] | number>;
  // Enunciado congelado no momento da resposta. Nulo nas linhas antigas:
  // nesse caso ler de quiz_stages.
  questions_snapshot: QuizQuestion[] | null;
  submitted_at: string;
}

export interface AxisScore {
  likert: number;
  situacional: number;
}

export interface ParticipantScores {
  participant_id: string;
  eixos: {
    visao: AxisScore;
    execucao: AxisScore;
    relacao: AxisScore;
    integridade: AxisScore;
  };
  elementos: Record<string, number> | null; // 0..10 por elemento
  perfil_dominante: string | null;
  perfil_declarado: string | null;
  divergencia: boolean | null;
  computed_at: string;
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
  analise_geral: string; // 3-5 paragrafos curtos com markdown bold (**texto**)
  areas_chave: Array<{
    nome: string;          // Curto e forte
    diagnostico: string;   // 1 parágrafo curto com bold
    risco: string;         // 1 frase
    movimento: string;     // 1 frase clara
  }>; // 3 ou 4 itens
  plano_30_dias: Array<{
    titulo: string;
    objetivos: string[];   // 3 bullets, verbos no infinitivo
    acao: string;
    resultado_esperado: string;
  }>; // 3 itens
  praticas: Array<{
    nome: string;          // Verbo no infinitivo
    descricao: string;     // 1-2 parágrafos curtos com bold inline
  }>; // 3 ou 4 itens
  frase_ativacao: {
    frase: string;             // Aforismo 8-15 palavras
    contexto: string;          // Por que apareceu
    aplicacao: string;         // Como aplicar
    pergunta_pratica: string;  // Pergunta concreta
  };
  trilha_recomendada: TrailRecommendation;
  justificativa_trilha: string; // 2-3 parágrafos curtos
}

export type NPSQualityRating = "nao_refletiu" | "parcialmente" | "bem" | "precisao";

export interface NPSResponse {
  id: string;
  full_name: string;
  nps_score: number;
  quality_rating: NPSQualityRating;
  highlight: string | null;
  improvement: string | null;
  ip_hash: string | null;
  created_at: string;
}

export interface KnowledgeBaseEntry {
  id: string;
  title: string;
  content: string;
  type: "text" | "file";
  file_name: string | null;
  priority: number;
  created_at: string;
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
        Insert: Omit<
          Event,
          "id" | "created_at" | "updated_at" | "quiz_version" | "mode" | "form_opens_at" | "form_closes_at"
        > &
          Partial<Pick<Event, "quiz_version" | "mode" | "form_opens_at" | "form_closes_at">>;
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
        Insert: Omit<QuizStage, "quiz_version" | "stage_number"> &
          Partial<Pick<QuizStage, "quiz_version" | "stage_number">>;
        Update: Partial<QuizStage>;
        Relationships: [];
      };
      quiz_responses: {
        Row: QuizResponse;
        Insert: Omit<QuizResponse, "id" | "submitted_at" | "questions_snapshot"> &
          Partial<Pick<QuizResponse, "questions_snapshot">>;
        Update: Partial<QuizResponse>;
        Relationships: [];
      };
      prognostics: {
        Row: Prognostic;
        Insert: Omit<Prognostic, "id" | "public_share_token">;
        Update: Partial<Omit<Prognostic, "id" | "participant_id">>;
        Relationships: [];
      };
      knowledge_base: {
        Row: KnowledgeBaseEntry;
        Insert: Omit<KnowledgeBaseEntry, "id" | "created_at" | "priority"> & {
          priority?: number;
        };
        Update: Partial<Omit<KnowledgeBaseEntry, "id" | "created_at">>;
        Relationships: [];
      };
      nps_responses: {
        Row: NPSResponse;
        Insert: Omit<NPSResponse, "id" | "created_at">;
        Update: Partial<Omit<NPSResponse, "id" | "created_at">>;
        Relationships: [];
      };
      participant_scores: {
        Row: ParticipantScores;
        Insert: Omit<ParticipantScores, "computed_at"> & { computed_at?: string };
        Update: Partial<Omit<ParticipantScores, "participant_id">>;
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
