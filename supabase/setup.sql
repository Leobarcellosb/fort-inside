-- =============================================================
-- Fort Inside — Setup completo (schema + RLS + seed do quiz)
-- Cole este script no SQL Editor do Supabase e execute.
-- URL: https://supabase.com/dashboard/project/mgozonrciqrbwsigedfv/sql
-- =============================================================

-- ---------------------------------------------------------------
-- 1. SCHEMA
-- ---------------------------------------------------------------

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_code text not null unique,
  event_date timestamptz not null,
  status text not null default 'draft',
  current_stage int not null default 0,
  host_name text default 'Yuri Fortes',
  location_name text,
  max_participants int default 8,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text,
  course_or_moment text,
  joined_at timestamptz default now(),
  completed_at timestamptz,
  unique(event_id, email)
);

create table if not exists quiz_stages (
  id int primary key,
  title text not null,
  ambient_name text not null,
  description text,
  questions jsonb not null
);

create table if not exists quiz_responses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  stage_id int not null references quiz_stages(id),
  answers jsonb not null,
  submitted_at timestamptz default now(),
  unique(participant_id, stage_id)
);

create table if not exists prognostics (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade unique,
  raw_ai_output jsonb not null,
  edited_content jsonb,
  final_content jsonb,
  status text not null default 'pending',
  trail_recommendation text,
  yuri_note text,
  generated_at timestamptz,
  reviewed_at timestamptz,
  delivered_at timestamptz,
  pdf_url text,
  public_share_token text unique default gen_random_uuid()::text
);

create table if not exists event_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  participant_id uuid references participants(id) on delete set null,
  action text not null,
  payload jsonb,
  created_at timestamptz default now()
);

create or replace view participant_profiles as
select
  p.id,
  p.full_name,
  p.event_id,
  pr.trail_recommendation,
  pr.status as prognostic_status,
  count(qr.id) as stages_completed,
  p.completed_at
from participants p
left join prognostics pr on pr.participant_id = p.id
left join quiz_responses qr on qr.participant_id = p.id
group by p.id, pr.trail_recommendation, pr.status;

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_updated_at on events;
create trigger events_updated_at
  before update on events
  for each row execute function update_updated_at();

-- ---------------------------------------------------------------
-- 2. ROW LEVEL SECURITY
-- ---------------------------------------------------------------

alter table events enable row level security;
alter table participants enable row level security;
alter table quiz_stages enable row level security;
alter table quiz_responses enable row level security;
alter table prognostics enable row level security;
alter table event_logs enable row level security;

create or replace function is_admin()
returns boolean language sql security definer as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
    or (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- events
drop policy if exists "events_public_read" on events;
create policy "events_public_read" on events for select using (true);

drop policy if exists "events_admin_write" on events;
create policy "events_admin_write" on events for all using (is_admin());

-- quiz_stages
drop policy if exists "quiz_stages_public_read" on quiz_stages;
create policy "quiz_stages_public_read" on quiz_stages for select using (true);

-- participants
drop policy if exists "participants_own_read" on participants;
create policy "participants_own_read" on participants
  for select using (user_id = auth.uid() or is_admin());

drop policy if exists "participants_own_insert" on participants;
create policy "participants_own_insert" on participants
  for insert with check (user_id = auth.uid() or is_admin());

drop policy if exists "participants_own_update" on participants;
create policy "participants_own_update" on participants
  for update using (user_id = auth.uid() or is_admin());

drop policy if exists "participants_admin_delete" on participants;
create policy "participants_admin_delete" on participants
  for delete using (is_admin());

-- quiz_responses
drop policy if exists "quiz_responses_own_read" on quiz_responses;
create policy "quiz_responses_own_read" on quiz_responses
  for select using (
    participant_id in (select id from participants where user_id = auth.uid())
    or is_admin()
  );

drop policy if exists "quiz_responses_own_insert" on quiz_responses;
create policy "quiz_responses_own_insert" on quiz_responses
  for insert with check (
    participant_id in (select id from participants where user_id = auth.uid())
    and stage_id <= (
      select e.current_stage
      from participants p
      join events e on e.id = p.event_id
      where p.id = participant_id
    )
  );

-- prognostics
drop policy if exists "prognostics_participant_read" on prognostics;
create policy "prognostics_participant_read" on prognostics
  for select using (
    (participant_id in (select id from participants where user_id = auth.uid()) and status = 'delivered')
    or is_admin()
  );

drop policy if exists "prognostics_admin_write" on prognostics;
create policy "prognostics_admin_write" on prognostics for all using (is_admin());

-- event_logs
drop policy if exists "event_logs_admin" on event_logs;
create policy "event_logs_admin" on event_logs for all using (is_admin());

-- ---------------------------------------------------------------
-- 3. SEED — 5 etapas do quiz
-- ---------------------------------------------------------------

insert into quiz_stages (id, title, ambient_name, description, questions) values

(1, 'Seu ponto de partida', 'Entrada / Recepção', 'O que te trouxe até aqui e onde você está hoje.', '[
  {"id":"q1","type":"select","text":"Hoje, em que momento da sua jornada você sente que está?","options":["Início de construção","Fase de exploração","Busca por direção","Aceleração inicial","Transição para um novo nível"]},
  {"id":"q2","type":"select","text":"O que mais te trouxe até aqui hoje?","options":["Interesse pelo mercado imobiliário","Clareza de carreira","Aproximação com o ecossistema","Desenvolvimento e visão","Curiosidade sobre investimentos","Outro"]},
  {"id":"q3","type":"select","text":"O que você sente que mais precisa neste momento?","options":["Clareza","Direção","Ambiente","Repertório","Posicionamento","Coragem de avançar"]},
  {"id":"q4","type":"text","text":"Se você sair daqui com uma única resposta, qual gostaria que fosse?"}
]'::jsonb),

(2, 'Sua visão atual', 'Sala Principal', 'Como você enxerga sua trajetória e o que está construindo.', '[
  {"id":"q1","type":"select","text":"Hoje, você sente que está construindo sua trajetória com intenção ou apenas reagindo ao que aparece?","options":["Totalmente com intenção","Mais com intenção do que reação","Mais reagindo do que construindo","Ainda sem clareza"]},
  {"id":"q2","type":"select","text":"Você tem clareza de onde quer estar nos próximos 3 anos?","options":["Muito clara","Parcialmente clara","Pouco clara","Ainda não sei"]},
  {"id":"q3","type":"text","text":"O que mais falta hoje para sua construção ganhar força?"},
  {"id":"q4","type":"text","text":"Em que área da sua vida ou carreira você sente que está abaixo da ambição que carrega?"}
]'::jsonb),

(3, 'Seu posicionamento e construção', 'Cozinha / Gourmet', 'Como você se posiciona e o que te impede de crescer.', '[
  {"id":"q1","type":"select","text":"Hoje, como você avalia seu nível de posicionamento?","options":["Ainda muito inicial","Em construção","Já tenho alguma base","Estou começando a me diferenciar"]},
  {"id":"q2","type":"text","text":"Qual é sua principal força hoje?"},
  {"id":"q3","type":"text","text":"Qual é seu principal gargalo hoje?"},
  {"id":"q4","type":"select","text":"O que mais te impede de crescer no ritmo que gostaria?","options":["Falta de direção","Falta de ambiente","Falta de repertório","Insegurança","Falta de disciplina","Pouca vivência prática"]}
]'::jsonb),

(4, 'Seu ecossistema e sua alavanca', 'Varanda / Área Externa', 'O ambiente que você vive e o que precisa mudar.', '[
  {"id":"q1","type":"select","text":"O ambiente atual em que você está te aproxima ou te afasta do futuro que deseja?","options":["Me aproxima claramente","Me ajuda parcialmente","Me limita mais do que ajuda","Ainda não sei avaliar"]},
  {"id":"q2","type":"text","text":"Quem você precisa se tornar para operar em outro nível?"},
  {"id":"q3","type":"text","text":"De que tipo de ambiente você sente falta hoje?"},
  {"id":"q4","type":"text","text":"O que você precisa parar de adiar imediatamente?"}
]'::jsonb),

(5, 'Sua direção', 'Suíte / Escritório', 'O que você vai fazer com tudo que descobriu aqui.', '[
  {"id":"q1","type":"text","text":"Qual é o principal movimento que você precisa fazer nos próximos 30 dias?"},
  {"id":"q2","type":"text","text":"Qual risco você corre se continuar como está?"},
  {"id":"q3","type":"select","text":"Em qual trilha você sente que deveria caminhar agora?","options":["Exploração","Direção","Aproximação","Aceleração","Sessão privada"]},
  {"id":"q4","type":"text","text":"O que você gostaria que eu percebesse sobre você ao ler sua jornada?"}
]'::jsonb)

on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 4. REALTIME — habilitar para as tabelas necessárias
-- ---------------------------------------------------------------
-- Execute estes comandos separadamente se o publication já existir:
--
-- alter publication supabase_realtime add table events;
-- alter publication supabase_realtime add table quiz_responses;
--
-- Ou habilite pelo dashboard: Database → Replication → supabase_realtime
-- e marque as tabelas "events" e "quiz_responses".
