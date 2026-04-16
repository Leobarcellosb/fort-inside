-- Fort Inside — schema principal

create table events (
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

create table participants (
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

create table quiz_stages (
  id int primary key,
  title text not null,
  ambient_name text not null,
  description text,
  questions jsonb not null
);

create table quiz_responses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  stage_id int not null references quiz_stages(id),
  answers jsonb not null,
  submitted_at timestamptz default now(),
  unique(participant_id, stage_id)
);

create table prognostics (
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

create table event_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  participant_id uuid references participants(id) on delete set null,
  action text not null,
  payload jsonb,
  created_at timestamptz default now()
);

create view participant_profiles as
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

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger events_updated_at
  before update on events
  for each row execute function update_updated_at();
