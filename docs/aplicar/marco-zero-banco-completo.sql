-- =========================================================================
-- ATENCAO -- LEIA ANTES DE APLICAR
-- =========================================================================
-- Este arquivo consolidado vai ate a migration 023, e PARA ALI.
--
-- Ele NAO contem as migrations 024 a 028, que sao as desta serie:
--   024  impede a importacao de sobrescrever resposta de quem respondeu no app
--   025  amarra a aprovacao ao texto aprovado (entrega so do que foi revisado)
--   026  guarda o historico do que cada participante leu, e quando
--   027  permite tirar do ar e corrigir um documento ja entregue
--   028  impede gravar etapa que nao existe no evento
--
-- Quem aplicar SO este arquivo fica sem essas cinco protecoes, acreditando ter
-- aplicado tudo -- e e exatamente por isso que este aviso existe. O arquivo nao
-- tinha marcacao nenhuma de ate onde ia.
--
-- O caminho correto para um banco que ja tem ate a 023 e aplicar os arquivos de
-- supabase/migrations/ de 024 a 028, em ordem crescente.
--
-- Ver docs/RELEASE-23-OUT.md para o que cada uma muda e o risco de cada uma.
-- =========================================================================

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
-- Fort Inside — Row Level Security

alter table events enable row level security;
alter table participants enable row level security;
alter table quiz_stages enable row level security;
alter table quiz_responses enable row level security;
alter table prognostics enable row level security;
alter table event_logs enable row level security;

-- Helper: is the current user an admin/service role?
create or replace function is_admin()
returns boolean language sql security definer as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
    or (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- events: public read by event_code; admin writes
create policy "events_public_read" on events
  for select using (true);

create policy "events_admin_write" on events
  for all using (is_admin());

-- quiz_stages: public read
create policy "quiz_stages_public_read" on quiz_stages
  for select using (true);

-- participants: own data only; admin reads all
create policy "participants_own_read" on participants
  for select using (user_id = auth.uid() or is_admin());

create policy "participants_own_insert" on participants
  for insert with check (user_id = auth.uid() or is_admin());

create policy "participants_own_update" on participants
  for update using (user_id = auth.uid() or is_admin());

create policy "participants_admin_delete" on participants
  for delete using (is_admin());

-- quiz_responses: participant writes own; stage must be <= current_stage
create policy "quiz_responses_own_read" on quiz_responses
  for select using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    ) or is_admin()
  );

create policy "quiz_responses_own_insert" on quiz_responses
  for insert with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and stage_id <= (
      select e.current_stage
      from participants p
      join events e on e.id = p.event_id
      where p.id = participant_id
    )
  );

-- prognostics: participant reads only after delivered; admin full access
create policy "prognostics_participant_read" on prognostics
  for select using (
    (
      participant_id in (
        select id from participants where user_id = auth.uid()
      ) and status = 'delivered'
    ) or is_admin()
  );

create policy "prognostics_admin_write" on prognostics
  for all using (is_admin());

-- event_logs: admin only
create policy "event_logs_admin" on event_logs
  for all using (is_admin());
-- Fort Inside — seed das 6 etapas do quiz
-- Gerado a partir do banco de produção. O seed anterior tinha 5 etapas com
-- títulos diferentes, o que deixava o gate de 6 etapas da geração de
-- prognóstico impossível de satisfazer num deploy limpo.

-- Upsert em vez de delete+insert: quiz_responses.stage_id tem FK para
-- quiz_stages(id) sem ON DELETE, então apagar as etapas quebra com qualquer
-- resposta já gravada. Assim a migration roda tanto num banco novo quanto
-- num banco com histórico.
insert into quiz_stages (id, title, ambient_name, description, questions) values

(1, 'Seu Ponto de Partida', 'Portão', null, '[
  {
    "id": "q1",
    "text": "Hoje, em que momento da sua jornada você sente que está?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Responde com sinceridade. Sem pressa."
  },
  {
    "id": "q2",
    "text": "O que mais te trouxe até aqui hoje?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Pode ser específico. Pode ser geral. O que vier."
  },
  {
    "id": "q3",
    "text": "O que você sente que mais precisa neste momento?",
    "type": "select",
    "options": [
      "Clareza",
      "Direção",
      "Ambiente",
      "Repertório",
      "Posicionamento",
      "Coragem"
    ],
    "required": true
  },
  {
    "id": "q4",
    "text": "Se você sair daqui com uma única resposta, qual gostaria que fosse?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Pensa antes de escrever. Só uma."
  }
]'::jsonb),

(2, 'A Chegada', 'Entrada', null, '[
  {
    "id": "q_main",
    "text": "Você sente que está construindo alguma coisa ou só está seguindo o que parece certo de seguir?",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "O que você faria nos próximos 5 anos se ninguém tivesse opinião sobre isso? Nem família, nem amigos, nem mercado. Ninguém. Só você.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(3, 'A Força que Sustenta', 'Sala', null, '[
  {
    "id": "q_main",
    "text": "Tem uma coisa que você entrega melhor que a maioria do seu ciclo de convívio. Qual é? E não me responde ''eu sou dedicado'', ''sou esforçado''. Isso não diz nada, é o mínimo. Me conta algo concreto: algo que alguém já te falou, ou que você consegue provar.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "A força que te sustenta, ela vem de onde? Talento natural, necessidade da vida, ou teimosia? É importante saber a raiz, é ela que vai dizer se essa força aguenta crescer junto com você.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(4, 'A Fricção Invisível', 'Cozinha', null, '[
  {
    "id": "q_main",
    "text": "Tem alguma decisão que você sabe que precisa tomar há meses, e está empurrando? Pode ser sair de algum lugar. Falar com alguém. Começar alguma coisa. Terminar outra. Me fala qual é.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "O que essa decisão adiada está protegendo? Não é à toa que você não toma. Tem algo que você perde no momento que decidir. Me fala o que é.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(5, 'O Horizonte Visível', 'Varanda', null, '[
  {
    "id": "q_main",
    "text": "Imagina uma construção sua daqui 10 anos. Construção sua mesmo, algo que você irá construir. Pode ser empresa, pode ser marca, pode ser carreira, pode ser o que for. Me descreve ela em 3 frases. O que tem ali que não tem em nenhuma outra? Essa é a pergunta.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "Pra essa construção existir, qual versão sua precisa deixar de existir? Quem você precisa parar de ser? Não é fácil responder, eu sei. Mas responde.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(6, 'A Decisão que Arrisca', 'Suíte', null, '[
  {
    "id": "q_main",
    "text": "Saindo daqui hoje, o que você vai fazer diferente nos próximos 30 dias? Não me dá lista. Me dá UMA coisa. A primeira. A que você sabe que vai fazer.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "Pra você não recuar na primeira semana, o que precisa estar no lugar? Pessoas ao seu redor, regra interna, ambiente, compromisso público. O que é que segura você quando o impulso de voltar bater? Porque ele vai bater. Conto com você pra pensar nisso.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb)
on conflict (id) do update set
  title = excluded.title,
  ambient_name = excluded.ambient_name,
  description = excluded.description,
  questions = excluded.questions;
-- Fort Inside — Base de conhecimento para o Claude

create table knowledge_base (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  type text not null default 'text', -- 'text' | 'file'
  file_name text,
  created_at timestamptz default now()
);

alter table knowledge_base enable row level security;

-- Admin full access; no public read
create policy "knowledge_base_admin" on knowledge_base
  for all using (is_admin());
-- 005_delete_event.sql
-- Deletes an event and all its dependents in a single transaction.
-- SECURITY DEFINER runs as function owner so it can reach auth.users.
-- Callable only from service_role.

CREATE OR REPLACE FUNCTION delete_event_cascade(event_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_participants INT;
  deleted_responses INT;
  deleted_prognostics INT;
  deleted_logs INT;
  participant_user_ids UUID[];
BEGIN
  -- Collect user_ids of event participants (for auth.users cleanup).
  SELECT ARRAY_AGG(user_id) INTO participant_user_ids
  FROM participants
  WHERE event_id = event_uuid AND user_id IS NOT NULL;

  DELETE FROM event_logs WHERE event_id = event_uuid;
  GET DIAGNOSTICS deleted_logs = ROW_COUNT;

  DELETE FROM quiz_responses
  WHERE participant_id IN (SELECT id FROM participants WHERE event_id = event_uuid);
  GET DIAGNOSTICS deleted_responses = ROW_COUNT;

  DELETE FROM prognostics
  WHERE participant_id IN (SELECT id FROM participants WHERE event_id = event_uuid);
  GET DIAGNOSTICS deleted_prognostics = ROW_COUNT;

  DELETE FROM participants WHERE event_id = event_uuid;
  GET DIAGNOSTICS deleted_participants = ROW_COUNT;

  -- Delete auth.users ONLY for this event's participants, never admins.
  -- CRITICAL: parens around the OR clause. Without them, AND/OR precedence
  -- makes the OR branch unbound and deletes every non-admin row in auth.users.
  IF participant_user_ids IS NOT NULL THEN
    DELETE FROM auth.users
    WHERE id = ANY(participant_user_ids)
      AND (
        raw_app_meta_data->>'role' IS NULL
        OR raw_app_meta_data->>'role' != 'admin'
      );
  END IF;

  DELETE FROM events WHERE id = event_uuid;

  RETURN json_build_object(
    'deleted_logs', deleted_logs,
    'deleted_responses', deleted_responses,
    'deleted_prognostics', deleted_prognostics,
    'deleted_participants', deleted_participants,
    'deleted_users', COALESCE(ARRAY_LENGTH(participant_user_ids, 1), 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_event_cascade TO service_role;
-- 006_sync_production.sql
-- Reconcilia as migrations com o que já existe no banco de produção e adiciona
-- as policies que faltavam. Idempotente: seguro rodar em produção e num banco novo.

-- ---------------------------------------------------------------
-- 1. knowledge_base.priority
-- A query em lib/ai/generate-prognostic.ts ordena por `priority`. A coluna
-- existia só em produção, então um deploy limpo quebrava a leitura da base de
-- conhecimento — e o erro era engolido, gerando prognósticos sem metodologia.
-- ---------------------------------------------------------------

alter table knowledge_base
  add column if not exists priority int not null default 0;

-- ---------------------------------------------------------------
-- 2. nps_responses
-- Tabela criada direto no dashboard, sem migration. Recriada aqui para que um
-- ambiente novo tenha /feedback e /admin/nps funcionando.
-- ---------------------------------------------------------------

create table if not exists nps_responses (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  nps_score int not null check (nps_score between 0 and 10),
  quality_rating text not null
    check (quality_rating in ('nao_refletiu', 'parcialmente', 'bem', 'precisao')),
  highlight text,
  improvement text,
  ip_hash text,
  created_at timestamptz default now()
);

alter table nps_responses enable row level security;

-- Acesso total para admin. ATENÇÃO: em produção já existiam, criadas fora de
-- migration, as policies "Anyone can submit NPS" (INSERT, anon) e
-- "Only admin can read NPS" (SELECT). Policies permissivas são OR'd, então a
-- de INSERT anon deixa qualquer um gravar direto pelo PostgREST, sem passar
-- pelo rate limit da rota. A remoção está no 007.
drop policy if exists "nps_responses_admin" on nps_responses;
create policy "nps_responses_admin" on nps_responses
  for all using (is_admin());

create index if not exists nps_responses_created_at_idx
  on nps_responses (created_at desc);

-- ---------------------------------------------------------------
-- 3. quiz_responses: policy de UPDATE
-- Só existia policy de INSERT. Reenviar uma etapa (voltar e corrigir a
-- resposta) fazia o upsert virar UPDATE e ser bloqueado pelo RLS.
-- Mantém a mesma trava do INSERT: a etapa precisa já ter sido liberada.
-- ---------------------------------------------------------------

drop policy if exists "quiz_responses_own_update" on quiz_responses;
create policy "quiz_responses_own_update" on quiz_responses
  for update using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  )
  with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and stage_id <= (
      select e.current_stage
      from participants p
      join events e on e.id = p.event_id
      where p.id = participant_id
    )
  );
-- 007_nps_lockdown.sql
-- Fecha a escrita anônima direta em nps_responses.
--
-- CONTEXTO: a policy "Anyone can submit NPS" (INSERT para anon) foi criada
-- direto no dashboard. Como a anon key é pública (vai no bundle do browser),
-- ela permite POST direto no PostgREST — contornando por completo o rate limit
-- por IP de /api/nps. O formulário público NÃO depende dela: a rota grava com
-- o service_role, que ignora RLS.
--
-- "Only admin can read NPS" (SELECT) é redundante com nps_responses_admin
-- (FOR ALL), que já cobre leitura e escrita para admin.

drop policy if exists "Anyone can submit NPS" on nps_responses;
drop policy if exists "Only admin can read NPS" on nps_responses;

-- Estado final: uma única policy, nps_responses_admin (FOR ALL, is_admin()).
-- Escrita pública continua funcionando via /api/nps (service_role).
-- 008_quiz_v2.sql (payload em base64)
-- O texto vai em base64 e o Postgres decodifica: puro ASCII na transferencia,
-- imune a corrupcao de encoding no caminho ate o editor. A primeira tentativa
-- foi colada como UTF-8 lido como MacRoman e gravou "constru????o" no lugar de
-- "construcao" com cedilha.

update quiz_stages set questions = case id
  when 1 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzY2FsZSIsInJlcXVpcmVkIjp0cnVlLCJtaW4iOjAsIm1heCI6MTAsInRleHQiOiJQZW5zYW5kbyBubyBzZXUgw7psdGltbyBhbm86IHF1YW50byBmb2kgY29uc3RydcOnw6NvIGUgcXVhbnRvIGZvaSByZWHDp8Ojbz8iLCJtaW5fbGFiZWwiOiJSZWFnaW5kbyBvIHRlbXBvIHRvZG8iLCJtYXhfbGFiZWwiOiJDb25zdHJ1aW5kbyBjb20gbcOpdG9kbyJ9LHsiaWQiOiJxMiIsInR5cGUiOiJzZWxlY3QiLCJyZXF1aXJlZCI6dHJ1ZSwidGV4dCI6IlRyw6pzIGhvcmFzIGxpdnJlcyBudW1hIHRlcsOnYSDDoCBub2l0ZS4gTmEgcHLDoXRpY2EsIG8gcXVlIGNvc3R1bWEgYWNvbnRlY2VyPyIsIm9wdGlvbnMiOlsiQWRpYW50byB0cmFiYWxobyIsIkVzdHVkbyBhbGdvIHF1ZSBldSBlc2NvbGhpIiwiRGVzY2Fuc28gc2VtIGN1bHBhIiwiQWNhYm8gbm8gY2VsdWxhciBlIG7Do28gc2VpIG9uZGUgZm9pIG8gdGVtcG8iXX0seyJpZCI6InEzIiwidHlwZSI6InNlbGVjdCIsInJlcXVpcmVkIjp0cnVlLCJ0ZXh0IjoiTyBxdWUgdm9jw6ogc2VudGUgcXVlIG1haXMgcHJlY2lzYSBuZXN0ZSBtb21lbnRvPyIsIm9wdGlvbnMiOlsiQ2xhcmV6YSIsIkRpcmXDp8OjbyIsIkFtYmllbnRlIiwiUmVwZXJ0w7NyaW8iLCJQb3NpY2lvbmFtZW50byIsIkNvcmFnZW0iXX0seyJpZCI6InE0IiwidHlwZSI6InNob3J0X3RleHQiLCJyZXF1aXJlZCI6dHJ1ZSwibWF4X2NoYXJzIjoxMjAsInRleHQiOiJTZSB2b2PDqiBzYWlyIGRhcXVpIGNvbSB1bWEgw7puaWNhIHJlc3Bvc3RhLCBxdWFsIGdvc3RhcmlhIHF1ZSBmb3NzZT8iLCJwbGFjZWhvbGRlciI6IlVtYSBmcmFzZSBiYXN0YS4ifV0=', 'base64'), 'UTF8')::jsonb
  when 2 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJkaWxlbW1hIiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJPIHF1ZSBwZXNhIG1haXMgaG9qZT8iLCJvcHRpb25fYSI6Ik7Do28gc2FiZXIgcGFyYSBvbmRlIGlyIiwib3B0aW9uX2IiOiJTYWJlciBlIG7Do28gc2FpciBkbyBsdWdhciJ9LHsiaWQiOiJxMiIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MTIwLCJ0ZXh0IjoiRW0gcXVlIG1vbWVudG8gZGEgc3VhIGpvcm5hZGEgdm9jw6ogZXN0w6EgaG9qZT8gU2VqYSBob25lc3RvLCBuw6NvIHRlbnRlIGltcHJlc3Npb25hci4iLCJwbGFjZWhvbGRlciI6Ik9uZGUgdm9jw6ogZXN0w6EgZGUgdmVyZGFkZSwgbsOjbyBvbmRlIGdvc3RhcmlhIGRlIGVzdGFyLiJ9LHsiaWQiOiJxMyIsInR5cGUiOiJzZWxlY3QiLCJyZXF1aXJlZCI6dHJ1ZSwidGV4dCI6IkRvaXMgY29udml0ZXMgYm9ucyBubyBtZXNtbyBkaWEgZSBzw7MgZMOhIHBhcmEgaXIgYSB1bS4gTmEgcHLDoXRpY2EsIGNvbW8gdm9jw6ogZGVjaWRlPyIsIm9wdGlvbnMiOlsiVm91IG5hIHF1ZSB0ZW0gZ2VudGUgZGUgcXVlbSBldSBnb3N0byIsIlBlcmd1bnRvIHBhcmEgYWxndcOpbSBlbSBxdWVtIGNvbmZpbyIsIkVzY29saG8gYSBxdWUgYWJyZSBtYWlzIHBvcnRhcyBkZXBvaXMiLCJFbnJvbG8gZSBkZWNpZG8gZW0gY2ltYSBkYSBob3JhIl19XQ==', 'base64'), 'UTF8')::jsonb
  when 3 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzaG9ydF90ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1heF9jaGFycyI6NjAsInRleHQiOiJTdWEgcHJpbmNpcGFsIGZvcsOnYSwgZW0gYXTDqSA2IHBhbGF2cmFzLiIsInBsYWNlaG9sZGVyIjoiU2VtIHJvZGVpby4ifSx7ImlkIjoicTIiLCJ0eXBlIjoic2VsZWN0IiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJWb2PDqiB0ZXJtaW5vdSBhbGdvIGRlIHF1ZSBzZSBvcmd1bGhhLiBPIHF1ZSBhY29udGVjZSBub3MgMTAgbWludXRvcyBzZWd1aW50ZXM/Iiwib3B0aW9ucyI6WyJNb3N0cm8gcGFyYSB1bWEgcGVzc29hIGVzcGVjw61maWNhIGFudGVzIGRlIHR1ZG8iLCJQdWJsaWNvIHBhcmEgdG9kbyBtdW5kbyIsIkd1YXJkbyBlIHZvdSBwYXJhIGEgcHLDs3hpbWEiLCJGaWNvIHJldmlzYW5kbyBtYWlzIHVtIHBvdWNvIl19LHsiaWQiOiJxMyIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MTIwLCJ0ZXh0IjoiRXNzYSBmb3LDp2EgdmVpbyBkZSBvbmRlPyBUYWxlbnRvLCBuZWNlc3NpZGFkZSwgYW1iaWVudGUsIG91IGFsZ3XDqW0/IiwicGxhY2Vob2xkZXIiOiJDb250YSBhIG9yaWdlbSwgbsOjbyBhIGRlZmluacOnw6NvLiJ9XQ==', 'base64'), 'UTF8')::jsonb
  when 4 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MTIwLCJ0ZXh0IjoiUXVhbCBkZWNpc8OjbyB2b2PDqiB2ZW0gYWRpYW5kbyBow6EgbWVzZXM/IEUgbyBxdWUgZWxhIGVzdMOhIHByb3RlZ2VuZG8/IiwicGxhY2Vob2xkZXIiOiJOaW5ndcOpbSBhZGlhIMOgIHRvYS4gTyBxdWUgYSBkZW1vcmEgZXN0w6EgcHJlc2VydmFuZG8/In0seyJpZCI6InEyIiwidHlwZSI6Im11bHRpX3NlbGVjdCIsInJlcXVpcmVkIjp0cnVlLCJtYXhfY2hvaWNlcyI6MiwidGV4dCI6Ik8gcXVlIG1haXMgdGUgdHJhdmE/IChlc2NvbGhhIGF0w6kgMikiLCJvcHRpb25zIjpbIkZhbHRhIGRlIG3DqXRvZG8iLCJGYWx0YSBkZSBhbWJpZW50ZSIsIk1lZG8gZGUgZXJyYXIgZW0gcMO6YmxpY28iLCJGYWx0YSBkZSByZXBlcnTDs3JpbyIsIkRlcGVuZGVyIGRlIGFwcm92YcOnw6NvIiwiRmFsdGEgZGUgdXJnw6puY2lhIl19LHsiaWQiOiJxMyIsInR5cGUiOiJzY2FsZSIsInJlcXVpcmVkIjp0cnVlLCJtaW4iOjAsIm1heCI6MTAsInRleHQiOiJPIHF1YW50byBlc3NhIGRlY2lzw6NvIGFkaWFkYSB0ZSBjdXN0YSBob2plPyIsIm1pbl9sYWJlbCI6IlF1YXNlIG5hZGEiLCJtYXhfbGFiZWwiOiJNZSBjdXN0YSB0b2RvIGRpYSJ9XQ==', 'base64'), 'UTF8')::jsonb
  when 5 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzaG9ydF90ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1heF9jaGFycyI6MTQwLCJ0ZXh0IjoiRGFxdWkgYSAxMCBhbm9zLCBlbSB1bWEgZnJhc2UuIiwicGxhY2Vob2xkZXIiOiJVbWEgY29uc3RydcOnw6NvIHN1YSwgbsOjbyB1bSBjYXJnby4ifSx7ImlkIjoicTIiLCJ0eXBlIjoicmFua2luZyIsInJlcXVpcmVkIjp0cnVlLCJ0ZXh0IjoiT3JkZW5lIHBlbG8gcXVlIHZvY8OqIFJFQUxNRU5URSBmZXogbWFpcyBub3Mgw7psdGltb3MgNiBtZXNlcy4iLCJvcHRpb25zIjpbIkV4ZWN1dGFyIHByb2pldG9zIiwiRXN0dWRhciIsIkNvbmhlY2VyIHBlc3NvYXMiLCJQbGFuZWphciJdfSx7ImlkIjoicTMiLCJ0eXBlIjoicmFua2luZyIsInJlcXVpcmVkIjp0cnVlLCJ0ZXh0IjoiQWdvcmEgb3JkZW5lIHBlbG8gcXVlIHByZWNpc2EgdmlyIHByaW1laXJvIGRhcXVpIHByYSBmcmVudGUuIiwib3B0aW9ucyI6WyJSZXBlcnTDs3JpbyIsIkFtYmllbnRlIGUgY29uZXjDtWVzIiwiUG9zaWNpb25hbWVudG8iLCJDYXBpdGFsIl19LHsiaWQiOiJxNCIsInR5cGUiOiJzZWxlY3QiLCJyZXF1aXJlZCI6dHJ1ZSwidGV4dCI6IkEgw7psdGltYSBwZXNzb2EgcmVsZXZhbnRlIHF1ZSB2b2PDqiBjb25oZWNldSBub3Mgw7psdGltb3MgNiBtZXNlcy4gQ29tbyBhY29udGVjZXU/Iiwib3B0aW9ucyI6WyJFdSBwcm9jdXJlaSBlIHB1eGVpIGNvbnZlcnNhIiwiQWxndcOpbSBtZSBhcHJlc2VudG91IiwiQWNvbnRlY2V1IHBvciBhY2FzbyIsIk7Do28gY29uc2lnbyBwZW5zYXIgZW0gbmluZ3XDqW0iXX1d', 'base64'), 'UTF8')::jsonb
  when 6 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MTIwLCJ0ZXh0IjoiUXVhbCDDqSBvIHNldSBwcmltZWlybyBtb3ZpbWVudG8gbm9zIHByw7N4aW1vcyAzMCBkaWFzPyIsInBsYWNlaG9sZGVyIjoiQ29uY3JldG8uIFVtYSBjb2lzYSBxdWUgZMOhIHBhcmEgY29tZcOnYXIgc2VtYW5hIHF1ZSB2ZW0uIn0seyJpZCI6InEyIiwidHlwZSI6ImRpbGVtbWEiLCJyZXF1aXJlZCI6dHJ1ZSwidGV4dCI6IlF1YW5kbyBhcGVydGEsIG8gcXVlIHZvY8OqIGZhej8iLCJvcHRpb25fYSI6IlJlY3VvIGUgcmVvcmdhbml6byIsIm9wdGlvbl9iIjoiSW5zaXN0byBlIGZvcsOnbyJ9LHsiaWQiOiJxMyIsInR5cGUiOiJzY2FsZSIsInJlcXVpcmVkIjp0cnVlLCJtaW4iOjAsIm1heCI6MTAsInRleHQiOiJPIHF1YW50byB2b2PDqiBlc3TDoSBkaXNwb3N0byBhIHBhZ2FyIG8gY3VzdG8gZGlzc28/IiwibWluX2xhYmVsIjoiU8OzIHNlIGZvciBjb25mb3J0w6F2ZWwiLCJtYXhfbGFiZWwiOiJQYWdvIG8gcHJlw6dvIGludGVpcm8ifV0=', 'base64'), 'UTF8')::jsonb
  else questions
end
where id between 1 and 6;
-- 009_quiz_v3.sql (payload em base64)
-- Corrige um excesso do v2. O v2 cortou de 13 perguntas abertas para 4, o que
-- resolveu o tempo mas custou a exploracao: sem superficie aberta nao da para
-- encontrar o que a pessoa tem de proprio.
--
-- O dado que reorienta: no FORT26 os participantes escreveram 2 a 3x o minimo
-- exigido em TODAS as etapas (etapa 3: 587 caracteres contra 180 exigidos).
-- Ou seja, o piso de caracteres nunca puxou profundidade -- as pessoas queriam
-- falar. O que ele fazia era transformar resposta curta e honesta em erro
-- vermelho e cobrar pedagio de quem ja tinha dito o que tinha para dizer.
--
-- v3: 11 perguntas abertas (quase a superficie do v1) com min_chars 0, mais
-- 13 perguntas de toque rapido. Quem tem profundidade escreve a vontade; quem
-- ja respondeu, segue. Zero caracteres obrigatorios.
--
-- Desenho novo: emparelhar escolha rapida com "por que?" aberto (etapa 2). A
-- pessoa ja se comprometeu com um lado, entao escrever fica mais facil e mais
-- especifico do que responder no vazio.
--
-- O quiz v1 continua em 003_seed_quiz.sql (chave das respostas do FORT26) e o
-- v2 em 008_quiz_v2.sql.

update quiz_stages set questions = case id
  when 1 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzY2FsZSIsInJlcXVpcmVkIjp0cnVlLCJtaW4iOjAsIm1heCI6MTAsInRleHQiOiJQZW5zYW5kbyBubyBzZXUgw7psdGltbyBhbm86IHF1YW50byBmb2kgY29uc3RydcOnw6NvIGUgcXVhbnRvIGZvaSByZWHDp8Ojbz8iLCJtaW5fbGFiZWwiOiJSZWFnaW5kbyBvIHRlbXBvIHRvZG8iLCJtYXhfbGFiZWwiOiJDb25zdHJ1aW5kbyBjb20gbcOpdG9kbyJ9LHsiaWQiOiJxMiIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MCwidGV4dCI6Ik8gcXVlIHRlIHRyb3V4ZSBhcXVpIGhvamU/IE7Do28gYSByZXNwb3N0YSBib25pdGEg4oCUIGEgcmVhbC4iLCJwbGFjZWhvbGRlciI6IlBvZGUgc2VyIGN1cnRvLiBTw7MgbsOjbyBzZWphIGdlbsOpcmljby4ifSx7ImlkIjoicTMiLCJ0eXBlIjoic2VsZWN0IiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJUcsOqcyBob3JhcyBsaXZyZXMgbnVtYSB0ZXLDp2Egw6Agbm9pdGUuIE5hIHByw6F0aWNhLCBvIHF1ZSBjb3N0dW1hIGFjb250ZWNlcj8iLCJvcHRpb25zIjpbIkFkaWFudG8gdHJhYmFsaG8iLCJFc3R1ZG8gYWxnbyBxdWUgZXUgZXNjb2xoaSIsIkRlc2NhbnNvIHNlbSBjdWxwYSIsIkFjYWJvIG5vIGNlbHVsYXIgZSBuw6NvIHNlaSBvbmRlIGZvaSBvIHRlbXBvIl19LHsiaWQiOiJxNCIsInR5cGUiOiJzaG9ydF90ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1heF9jaGFycyI6MTIwLCJ0ZXh0IjoiU2Ugdm9jw6ogc2FpciBkYXF1aSBjb20gdW1hIMO6bmljYSByZXNwb3N0YSwgcXVhbCBnb3N0YXJpYSBxdWUgZm9zc2U/IiwicGxhY2Vob2xkZXIiOiJVbWEgZnJhc2UgYmFzdGEuIn1d', 'base64'), 'UTF8')::jsonb
  when 2 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJkaWxlbW1hIiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJPIHF1ZSBwZXNhIG1haXMgaG9qZT8iLCJvcHRpb25fYSI6Ik7Do28gc2FiZXIgcGFyYSBvbmRlIGlyIiwib3B0aW9uX2IiOiJTYWJlciBlIG7Do28gc2FpciBkbyBsdWdhciJ9LHsiaWQiOiJxMiIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MCwidGV4dCI6IlBvciBxdWUgZXNzYSBlIG7Do28gYSBvdXRyYT8iLCJwbGFjZWhvbGRlciI6Ik8gcXVlIHRlIGZleiBlc2NvbGhlciBlc3NlIGxhZG8uIn0seyJpZCI6InEzIiwidHlwZSI6InRleHQiLCJyZXF1aXJlZCI6dHJ1ZSwibWluX2NoYXJzIjowLCJ0ZXh0IjoiRW0gcXVlIG1vbWVudG8gZGEgc3VhIGpvcm5hZGEgdm9jw6ogZXN0w6EgaG9qZT8gU2VqYSBob25lc3RvLCBuw6NvIHRlbnRlIGltcHJlc3Npb25hci4iLCJwbGFjZWhvbGRlciI6Ik9uZGUgdm9jw6ogZXN0w6EgZGUgdmVyZGFkZSwgbsOjbyBvbmRlIGdvc3RhcmlhIGRlIGVzdGFyLiJ9XQ==', 'base64'), 'UTF8')::jsonb
  when 3 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzaG9ydF90ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1heF9jaGFycyI6NjAsInRleHQiOiJTdWEgcHJpbmNpcGFsIGZvcsOnYSwgZW0gYXTDqSA2IHBhbGF2cmFzLiIsInBsYWNlaG9sZGVyIjoiU2VtIHJvZGVpby4ifSx7ImlkIjoicTIiLCJ0eXBlIjoidGV4dCIsInJlcXVpcmVkIjp0cnVlLCJtaW5fY2hhcnMiOjAsInRleHQiOiJDb250YSBhIMO6bHRpbWEgdmV6IHF1ZSBlc3NhIGZvcsOnYSB0ZSBzYWx2b3UuIEEgc2l0dWHDp8OjbyBpbnRlaXJhLiIsInBsYWNlaG9sZGVyIjoiVW0gY2FzbyBjb25jcmV0byB2YWxlIG1haXMgcXVlIHVtYSBkZWZpbmnDp8Ojby4ifSx7ImlkIjoicTMiLCJ0eXBlIjoidGV4dCIsInJlcXVpcmVkIjp0cnVlLCJtaW5fY2hhcnMiOjAsInRleHQiOiJFbGEgdmVpbyBkZSBvbmRlPyBUYWxlbnRvLCBuZWNlc3NpZGFkZSwgYW1iaWVudGUsIG91IGFsZ3XDqW0/IiwicGxhY2Vob2xkZXIiOiJBIG9yaWdlbSwgbsOjbyBhIGRlZmluacOnw6NvLiJ9LHsiaWQiOiJxNCIsInR5cGUiOiJzZWxlY3QiLCJyZXF1aXJlZCI6dHJ1ZSwidGV4dCI6IlZvY8OqIHRlcm1pbm91IGFsZ28gZGUgcXVlIHNlIG9yZ3VsaGEuIE8gcXVlIGFjb250ZWNlIG5vcyAxMCBtaW51dG9zIHNlZ3VpbnRlcz8iLCJvcHRpb25zIjpbIk1vc3RybyBwYXJhIHVtYSBwZXNzb2EgZXNwZWPDrWZpY2EgYW50ZXMgZGUgdHVkbyIsIlB1YmxpY28gcGFyYSB0b2RvIG11bmRvIiwiR3VhcmRvIGUgdm91IHBhcmEgYSBwcsOzeGltYSIsIkZpY28gcmV2aXNhbmRvIG1haXMgdW0gcG91Y28iXX1d', 'base64'), 'UTF8')::jsonb
  when 4 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MCwidGV4dCI6IlF1YWwgZGVjaXPDo28gdm9jw6ogdmVtIGFkaWFuZG8gaMOhIG1lc2VzPyIsInBsYWNlaG9sZGVyIjoiQXF1ZWxhIHF1ZSB2b2PDqiBzYWJlIHF1YWwgw6kuIn0seyJpZCI6InEyIiwidHlwZSI6InRleHQiLCJyZXF1aXJlZCI6dHJ1ZSwibWluX2NoYXJzIjowLCJ0ZXh0IjoiTyBxdWUgZXNzYSBkZW1vcmEgZXN0w6EgcHJvdGVnZW5kbz8gTmluZ3XDqW0gYWRpYSDDoCB0b2EuIiwicGxhY2Vob2xkZXIiOiJWYWxlIGEgcGVuYSBwZW5zYXIgYW50ZXMgZGUgcmVzcG9uZGVyLiJ9LHsiaWQiOiJxMyIsInR5cGUiOiJtdWx0aV9zZWxlY3QiLCJyZXF1aXJlZCI6dHJ1ZSwibWF4X2Nob2ljZXMiOjIsInRleHQiOiJPIHF1ZSBtYWlzIHRlIHRyYXZhPyAoZXNjb2xoYSBhdMOpIDIpIiwib3B0aW9ucyI6WyJGYWx0YSBkZSBtw6l0b2RvIiwiRmFsdGEgZGUgYW1iaWVudGUiLCJNZWRvIGRlIGVycmFyIGVtIHDDumJsaWNvIiwiRmFsdGEgZGUgcmVwZXJ0w7NyaW8iLCJEZXBlbmRlciBkZSBhcHJvdmHDp8OjbyIsIkZhbHRhIGRlIHVyZ8OqbmNpYSJdfSx7ImlkIjoicTQiLCJ0eXBlIjoic2NhbGUiLCJyZXF1aXJlZCI6dHJ1ZSwibWluIjowLCJtYXgiOjEwLCJ0ZXh0IjoiTyBxdWFudG8gZXNzYSBkZWNpc8OjbyBhZGlhZGEgdGUgY3VzdGEgaG9qZT8iLCJtaW5fbGFiZWwiOiJRdWFzZSBuYWRhIiwibWF4X2xhYmVsIjoiTWUgY3VzdGEgdG9kbyBkaWEifV0=', 'base64'), 'UTF8')::jsonb
  when 5 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJzaG9ydF90ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1heF9jaGFycyI6MTQwLCJ0ZXh0IjoiRGFxdWkgYSAxMCBhbm9zLCBlbSB1bWEgZnJhc2UuIiwicGxhY2Vob2xkZXIiOiJVbWEgY29uc3RydcOnw6NvIHN1YSwgbsOjbyB1bSBjYXJnby4ifSx7ImlkIjoicTIiLCJ0eXBlIjoidGV4dCIsInJlcXVpcmVkIjp0cnVlLCJtaW5fY2hhcnMiOjAsInRleHQiOiJEZXNjcmV2ZSB1bSBkaWEgZGVzc2EgdmlkYS4gRGEgaG9yYSBxdWUgdm9jw6ogYWNvcmRhLiIsInBsYWNlaG9sZGVyIjoiUXVhbnRvIG1haXMgY29uY3JldG8sIG1lbGhvci4gT25kZSB2b2PDqiBlc3TDoSwgY29tIHF1ZW0sIGZhemVuZG8gbyBxdcOqLiJ9LHsiaWQiOiJxMyIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MCwidGV4dCI6IlBhcmEgZXNzYSBjb25zdHJ1w6fDo28gZXhpc3RpciwgcXVhbCB2ZXJzw6NvIHN1YSBwcmVjaXNhIGRlaXhhciBkZSBleGlzdGlyPyIsInBsYWNlaG9sZGVyIjoiTyBxdWUgdm9jw6ogdmFpIHRlciBxdWUgbGFyZ2FyLiJ9LHsiaWQiOiJxNCIsInR5cGUiOiJyYW5raW5nIiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJPcmRlbmUgcGVsbyBxdWUgdm9jw6ogUkVBTE1FTlRFIGZleiBtYWlzIG5vcyDDumx0aW1vcyA2IG1lc2VzLiIsIm9wdGlvbnMiOlsiRXhlY3V0YXIgcHJvamV0b3MiLCJFc3R1ZGFyIiwiQ29uaGVjZXIgcGVzc29hcyIsIlBsYW5lamFyIl19LHsiaWQiOiJxNSIsInR5cGUiOiJyYW5raW5nIiwicmVxdWlyZWQiOnRydWUsInRleHQiOiJBZ29yYSBvcmRlbmUgcGVsbyBxdWUgcHJlY2lzYSB2aXIgcHJpbWVpcm8gZGFxdWkgcHJhIGZyZW50ZS4iLCJvcHRpb25zIjpbIlJlcGVydMOzcmlvIiwiQW1iaWVudGUgZSBjb25leMO1ZXMiLCJQb3NpY2lvbmFtZW50byIsIkNhcGl0YWwiXX1d', 'base64'), 'UTF8')::jsonb
  when 6 then convert_from(decode('W3siaWQiOiJxMSIsInR5cGUiOiJ0ZXh0IiwicmVxdWlyZWQiOnRydWUsIm1pbl9jaGFycyI6MCwidGV4dCI6IlNhaW5kbyBkYXF1aSBob2plLCBxdWFsIMOpIG8gc2V1IHByaW1laXJvIG1vdmltZW50byBub3MgcHLDs3hpbW9zIDMwIGRpYXM/IiwicGxhY2Vob2xkZXIiOiJDb25jcmV0by4gQWxnbyBxdWUgZMOhIHBhcmEgY29tZcOnYXIgc2VtYW5hIHF1ZSB2ZW0uIn0seyJpZCI6InEyIiwidHlwZSI6InRleHQiLCJyZXF1aXJlZCI6dHJ1ZSwibWluX2NoYXJzIjowLCJ0ZXh0IjoiUGFyYSB2b2PDqiBuw6NvIHJlY3VhciBuYSBwcmltZWlyYSBzZW1hbmEsIG8gcXVlIHByZWNpc2EgZXN0YXIgbm8gbHVnYXI/IiwicGxhY2Vob2xkZXIiOiJQZXNzb2EsIHByYXpvLCBjb21wcm9taXNzbyBww7pibGljbywgZGluaGVpcm8g4oCUIG8gcXVlIGZvci4ifSx7ImlkIjoicTMiLCJ0eXBlIjoiZGlsZW1tYSIsInJlcXVpcmVkIjp0cnVlLCJ0ZXh0IjoiUXVhbmRvIGFwZXJ0YSwgbyBxdWUgdm9jw6ogZmF6PyIsIm9wdGlvbl9hIjoiUmVjdW8gZSByZW9yZ2FuaXpvIiwib3B0aW9uX2IiOiJJbnNpc3RvIGUgZm9yw6dvIn0seyJpZCI6InE0IiwidHlwZSI6InNjYWxlIiwicmVxdWlyZWQiOnRydWUsIm1pbiI6MCwibWF4IjoxMCwidGV4dCI6Ik8gcXVhbnRvIHZvY8OqIGVzdMOhIGRpc3Bvc3RvIGEgcGFnYXIgbyBjdXN0byBkaXNzbz8iLCJtaW5fbGFiZWwiOiJTw7Mgc2UgZm9yIGNvbmZvcnTDoXZlbCIsIm1heF9sYWJlbCI6IlBhZ28gbyBwcmXDp28gaW50ZWlybyJ9XQ==', 'base64'), 'UTF8')::jsonb
  else questions
end
where id between 1 and 6;
-- 010_programas.sql
-- Versionamento do quiz + modo assincrono com SESSAO DE ETAPA + gabarito
-- congelado por resposta.
-- Idempotente e sem nenhuma alteracao destrutiva: so adiciona colunas, indices,
-- tabelas, uma funcao e um gatilho. Seguro rodar em producao (com dados) e duas
-- vezes seguidas.
--
-- CONTEXTO: o Marco Zero e uma EVOLUCAO do Fort Inside, nao um segundo produto.
-- O que muda de uma geracao para outra e o quiz. Hoje `quiz_stages` e global
-- (ids 1..6) e `quiz_responses.stage_id` aponta para ele por FK. Trocar o
-- conteudo dessas linhas reinterpreta TODO o historico: ja aconteceu em
-- producao uma vez e embaralhou respostas. As duas travas abaixo
-- (`quiz_version` + `questions_snapshot`) existem para isso nao se repetir.

-- ---------------------------------------------------------------
-- 1. events: versao do quiz, modo e janela do formulario assincrono
-- ---------------------------------------------------------------

-- Cada evento aponta para a versao do quiz que usa. Default 1 = Fort Inside,
-- entao todos os eventos existentes continuam exatamente como estao.
alter table events
  add column if not exists quiz_version int not null default 1;

-- live  = evento presencial, etapas liberadas por `current_stage`.
-- async = formulario respondido por conta propria dentro de uma janela.
alter table events
  add column if not exists mode text not null default 'live'
    check (mode in ('live', 'async'));

-- Janela do formulario assincrono. Nulas no modo live (nao se aplicam), e por
-- isso sem NOT NULL nem default.
alter table events
  add column if not exists form_opens_at timestamptz;

alter table events
  add column if not exists form_closes_at timestamptz;

-- ---------------------------------------------------------------
-- 2. quiz_stages: versao e ordem dentro da versao
-- ---------------------------------------------------------------

-- As 6 etapas existentes ficam na versao 1. O Marco Zero sera a versao 2, com
-- ids proprios a partir de 101.
-- `id` continua sendo a PRIMARY KEY (NAO viramos chave composta): a FK de
-- quiz_responses.stage_id depende dele, e os ids em faixas separadas (1..6 e
-- 101+) nunca colidem. As queries passam a filtrar por quiz_version.
alter table quiz_stages
  add column if not exists quiz_version int not null default 1;

-- Ordem da etapa dentro da versao. Separada do id porque a versao 2 comeca em
-- 101 mas a pessoa ve "etapa 1..N".
alter table quiz_stages
  add column if not exists stage_number int;

-- Backfill: nas 6 etapas existentes a ordem e o proprio id. So preenche onde
-- esta nulo, entao rodar de novo nao sobrescreve nada.
update quiz_stages
   set stage_number = id
 where stage_number is null
   and quiz_version = 1;

-- ---------------------------------------------------------------
-- 3. quiz_responses: enunciado congelado
-- ---------------------------------------------------------------

-- Guarda as perguntas exatamente como a pessoa viu ao responder. Sem isso,
-- editar `quiz_stages.questions` reescreve a interpretacao de todas as
-- respostas passadas (as respostas so guardam id da pergunta -> valor).
-- NULO nas linhas antigas: quem le deve cair de volta em quiz_stages.
alter table quiz_responses
  add column if not exists questions_snapshot jsonb;

-- ---------------------------------------------------------------
-- 4. participant_scores: 1 linha por participante
-- ---------------------------------------------------------------

create table if not exists participant_scores (
  participant_id uuid primary key references participants(id) on delete cascade,
  -- {visao:{likert:int,situacional:int}, execucao:{...}, relacao:{...}, integridade:{...}}
  eixos jsonb not null,
  -- {desenvolvimento_intelectual:int, saude_energia:int, ...}, cada um 0..10
  elementos jsonb,
  perfil_dominante text,
  perfil_declarado text,
  -- true quando o perfil declarado difere do medido pelas respostas
  divergencia boolean,
  computed_at timestamptz default now()
);

-- RLS ligado: a tabela guarda pontuacao individual. Escrita so por admin /
-- service role (o calculo roda no servidor); o participante so le a propria.
alter table participant_scores enable row level security;

drop policy if exists "participant_scores_admin" on participant_scores;
create policy "participant_scores_admin" on participant_scores
  for all using (is_admin());

drop policy if exists "participant_scores_own_read" on participant_scores;
create policy "participant_scores_own_read" on participant_scores
  for select using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- 5. participant_stage_sessions: a ABERTURA da etapa, pelo relogio do servidor
-- ---------------------------------------------------------------
--
-- POR QUE ESTA TABELA EXISTE (modelo que substituiu a janela avaliada na
-- escrita). A primeira versao desta migration decidia o modo assincrono com
--
--     now() between e.form_opens_at and e.form_closes_at
--
-- dentro das policies de INSERT/UPDATE de quiz_responses. Como cada etapa e uma
-- escrita independente, `now()` era o instante do ENVIO. Consequencia medida:
-- quem abria o formulario as 23h50 e enviava as 00h05 recebia erro de
-- permissao cru do Postgres e perdia o que tinha escrito naquele envio. O prazo
-- nao fechava a porta antes da pessoa entrar -- fechava com ela dentro.
--
-- Resolver isso so na interface foi REJEITADO: bloqueio visual antecipado
-- continua vulneravel a conexao lenta, relogio do cliente incorreto e sessao ja
-- aberta. A regra precisa existir no banco.
--
-- O modelo aprovado registra QUANDO a etapa foi ABERTA, com o relogio do
-- servidor, e passa a decidir o envio contra esse registro, nao contra o
-- relogio do envio. `started_at` NAO virou coluna de quiz_responses: isso
-- criaria resposta vazia so para marcar abertura e mexeria na logica existente
-- de conclusao do questionario.
--
-- SEMANTICA DA JANELA (T = events.form_closes_at):
--   ate T-15min : pode ABRIR etapa nova (e enviar)
--   T-15min a T : NAO pode abrir etapa nova; pode CONCLUIR etapa ja aberta
--   T a T+15min : tolerancia de ENVIO apenas, para sessao ja aberta
--   depois T+15 : nada, nem salvamento automatico
-- O prazo de tolerancia NUNCA serve para abrir etapa nova. Caso canonico com a
-- janela fechando a meia-noite: quem ABRIU as 23h40 consegue ENVIAR as 00h05;
-- quem tenta ABRIR as 23h50 e recusado.

create table if not exists participant_stage_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  stage_id int not null references quiz_stages(id),
  -- Copia da versao do quiz vigente na abertura. A policy abaixo exige que ela
  -- bata com events.quiz_version, entao a sessao nao sobrevive a uma troca de
  -- versao do evento: e um registro do que a pessoa abriu, nao um ponteiro.
  quiz_version int not null,
  -- REGRA 1: atribuido EXCLUSIVAMENTE pelo banco, com relogio do servidor. O
  -- cliente nao informa (sem privilegio de INSERT nesta coluna) nem altera
  -- (sem privilegio de UPDATE em coluna nenhuma). Ver bloco de GRANTs.
  started_at timestamptz not null default now(),
  -- Mantido pelo gatilho da secao 7, nunca pelo browser.
  status text not null default 'open' check (status in ('open', 'submitted')),
  submitted_at timestamptz
);

-- REGRA 3: uma sessao por (participante, evento, etapa). E isto que impede
-- recriar a sessao para renovar o prazo. Indice separado (em vez de constraint
-- na CREATE TABLE) para que um banco que ja tenha a tabela receba a restricao
-- de qualquer forma -- `create table if not exists` nao reavalia constraints.
create unique index if not exists participant_stage_sessions_unica_idx
  on participant_stage_sessions (participant_id, event_id, stage_id);

-- Usado pela policy de quiz_responses e pelo gatilho da secao 7.
create index if not exists participant_stage_sessions_participante_idx
  on participant_stage_sessions (participant_id, stage_id);

alter table participant_stage_sessions enable row level security;

-- REGRA 4, camada de PRIVILEGIO (vem antes da RLS e nenhuma policy futura a
-- reabre por descuido).
--
-- ORDEM IMPORTA, e errar aqui produz falso conserto silencioso: privilegio de
-- COLUNA nao subtrai de privilegio de TABELA. O Supabase concede todos os
-- privilegios do schema public a anon e authenticated por default privilege,
-- entao enquanto existir INSERT/UPDATE no nivel da tabela qualquer
-- `revoke insert (coluna)` e ignorado na pratica. Revoga-se a tabela primeiro e
-- so depois concede-se coluna a coluna. (Mesma licao da 014.)
revoke all on participant_stage_sessions from anon;
revoke all on participant_stage_sessions from authenticated;

-- O participante le as proprias sessoes (a RLS recorta quais) e abre etapa.
-- O conjunto concedido no INSERT e exatamente a intencao do cliente: "abrir a
-- etapa X deste evento, nesta versao do quiz". Fora dele:
--   started_at   -> default now() do servidor, inalcancavel pelo cliente
--   status       -> default 'open', so o gatilho muda
--   submitted_at -> so o gatilho escreve
--   id           -> default gen_random_uuid()
-- Nenhum UPDATE e nenhum DELETE para authenticated: nao da para reescrever a
-- propria sessao, trocar o dono, antecipar started_at, nem apagar a sessao para
-- abrir outra e renovar o prazo.
grant select on participant_stage_sessions to authenticated;
grant insert (event_id, participant_id, stage_id, quiz_version)
  on participant_stage_sessions to authenticated;

-- anon nao recebe nada: sem sessao de usuario nao se abre etapa.
-- service_role e quem roda as rotas administrativas; explicito para nao
-- depender do default privilege da plataforma.
grant all on participant_stage_sessions to service_role;

drop policy if exists "participant_stage_sessions_admin" on participant_stage_sessions;
create policy "participant_stage_sessions_admin" on participant_stage_sessions
  for all
  using (is_admin())
  with check (is_admin());

-- REGRA 10 do fluxo: sessao e dado individual. So o dono (e o admin, pela
-- policy acima) enxerga.
drop policy if exists "participant_stage_sessions_own_read" on participant_stage_sessions;
create policy "participant_stage_sessions_own_read" on participant_stage_sessions
  for select using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  );

-- REGRA 2: a abertura e operacao autenticada e valida, no banco, participante,
-- evento, versao do quiz e disponibilidade da etapa.
--
--   participante : a linha tem de ser de um participante do proprio auth.uid()
--   evento       : event_id da sessao tem de ser o event_id DO participante
--                  (o join amarra e.id = p.event_id e e.id = <novo>.event_id)
--   versao       : a versao da etapa, a do evento e a gravada na sessao tem de
--                  ser a mesma -- nao se abre etapa de outra versao do quiz
--   disponib.    : async -> dentro de [form_opens_at, form_closes_at - 15min]
--                  live  -> stage_number <= current_stage, como sempre
--
-- No modo live a sessao e opcional: ela nao e exigida para enviar resposta (ver
-- secao 6) e existe so para a interface poder usar um unico caminho. Abri-la
-- obedece a mesma trava de etapa do ao vivo, entao nao cria caminho novo.
drop policy if exists "participant_stage_sessions_own_open" on participant_stage_sessions;
create policy "participant_stage_sessions_own_open" on participant_stage_sessions
  for insert with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = participant_stage_sessions.stage_id
      where p.id = participant_stage_sessions.participant_id
        and e.id = participant_stage_sessions.event_id
        and s.quiz_version = e.quiz_version
        and participant_stage_sessions.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            -- O -15min e a regra "nao se abre etapa no fim do prazo".
            -- 'infinity' - interval = 'infinity': janela sem fechamento
            -- definido nao fecha.
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         - interval '15 minutes'
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

-- ---------------------------------------------------------------
-- 6. quiz_responses: trava de escrita ciente de versao, modo e sessao
-- ---------------------------------------------------------------

-- POR QUE MEXER NESSAS POLICIES: elas sao o caminho de escrita do participante.
-- A trava antiga (002 e 006) comparava `stage_id <= events.current_stage`. Isso
-- so funcionava por acidente: os ids 1..6 do Fort Inside coincidem com a ordem.
-- Com ids 101+ (quiz v2) a comparacao nunca passaria, e eventos `async` nem
-- usam `current_stage`. A comparacao correta e contra `stage_number`.
--
-- PROPRIEDADE DE SEGURANCA (nao quebrar o ao vivo): como as 6 etapas
-- existentes receberam `stage_number = id` no backfill acima, e todos os
-- eventos existentes sao mode='live' e quiz_version=1, a trava do modo live
-- fica COMPORTAMENTALMENTE IDENTICA a de hoje para todos os dados que ja
-- existem -- em particular, o modo live NAO exige sessao de etapa. Errar aqui
-- trava a sala inteira num evento ao vivo.
--
-- Regras (alem da checagem de posse, mantida igual em using e with check):
--   live : stage_number <= current_stage, sem sessao
--   async: REGRA 5 -- tem de existir sessao registrada para
--          (participante, evento, etapa); e
--          REGRA 6 -- now() <= form_closes_at + 15min, a tolerancia de ENVIO.
--          `current_stage` e ignorado.
--   ambos: a versao do quiz da etapa tem de ser a versao do quiz do evento
--          (impede gravar etapa de outra versao do quiz)
--
-- Por que a tolerancia aqui e segura: a sessao so pode ter sido criada ate
-- T-15min (policy da secao 5) e nao pode ser recriada (indice unico) nem
-- apagada (sem privilegio de DELETE). Entao "existe sessao" ja prova "entrou
-- antes do prazo", e o +15min so da tempo de terminar o envio. A tolerancia
-- nunca abre etapa nova.
--
-- Se a etapa tiver stage_number nulo, a comparacao do live da NULL e a escrita
-- e negada: falha fechada, e o backfill cobre todas as etapas existentes.

drop policy if exists "quiz_responses_own_insert" on quiz_responses;
create policy "quiz_responses_own_insert" on quiz_responses
  for insert with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = quiz_responses.stage_id
      where p.id = quiz_responses.participant_id
        and s.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            -- 'infinity' + interval = 'infinity'.
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         + interval '15 minutes'
            and exists (
              select 1
              from participant_stage_sessions ss
              where ss.participant_id = quiz_responses.participant_id
                and ss.event_id = e.id
                and ss.stage_id = quiz_responses.stage_id
            )
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

drop policy if exists "quiz_responses_own_update" on quiz_responses;
create policy "quiz_responses_own_update" on quiz_responses
  for update using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  )
  with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = quiz_responses.stage_id
      where p.id = quiz_responses.participant_id
        and s.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         + interval '15 minutes'
            and exists (
              select 1
              from participant_stage_sessions ss
              where ss.participant_id = quiz_responses.participant_id
                and ss.event_id = e.id
                and ss.stage_id = quiz_responses.stage_id
            )
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

-- ---------------------------------------------------------------
-- 7. Conclusao da sessao: gatilho, nao escrita do cliente
-- ---------------------------------------------------------------
--
-- `status`/`submitted_at` precisam ser verdadeiros e o browser nao pode
-- escreve-los (REGRA 4). Como o participante nao tem UPDATE nenhum na tabela,
-- alguem do lado do servidor tem de fechar a sessao. Duas opcoes foram
-- consideradas:
--   (a) a rota administrativa fechar via service_role -- deixaria o estado
--       dependente de a aplicacao lembrar de chamar, e ele desalinha em
--       silencio quando alguem grava resposta por outro caminho;
--   (b) gatilho na propria gravacao da resposta -- o estado passa a ser
--       consequencia do fato, nao de uma chamada extra.
-- Escolhida a (b). Nao ha como marcar isto sem gatilho: policy de RLS filtra
-- linha, nao escreve em outra tabela.
--
-- SECURITY DEFINER porque quem dispara e o participante, que (de proposito) nao
-- tem UPDATE em participant_stage_sessions. search_path vazio e referencias
-- qualificadas, pela mesma razao da 012/013: funcao SECURITY DEFINER nao pode
-- depender de resolucao de nome por search_path.
--
-- Nao decide nada de autorizacao: quando chega aqui, a policy de
-- quiz_responses ja aprovou a gravacao. No modo live nao existe sessao e o
-- UPDATE casa 0 linhas -- no-op.

create or replace function public.marcar_sessao_de_etapa_enviada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.participant_stage_sessions
     set status = 'submitted',
         submitted_at = now()
   where participant_id = new.participant_id
     and stage_id = new.stage_id;
  return null;
end;
$$;

-- Funcao de gatilho nao deve ser chamavel diretamente. CREATE OR REPLACE
-- preserva privilegios, entao o EXECUTE herdado de PUBLIC na primeira criacao
-- sobreviveria: o revoke precisa vir depois, nesta ordem (licao da 011).
revoke execute on function public.marcar_sessao_de_etapa_enviada() from public;
revoke execute on function public.marcar_sessao_de_etapa_enviada() from anon;
revoke execute on function public.marcar_sessao_de_etapa_enviada() from authenticated;

drop trigger if exists quiz_responses_marca_sessao on quiz_responses;
create trigger quiz_responses_marca_sessao
  after insert or update on quiz_responses
  for each row execute function public.marcar_sessao_de_etapa_enviada();

-- ---------------------------------------------------------------
-- 8. Indices
-- ---------------------------------------------------------------

create index if not exists events_quiz_version_idx
  on events (quiz_version);

-- Unico: impede duas etapas com a mesma posicao na mesma versao. Linhas com
-- stage_number nulo nao colidem entre si no Postgres.
create unique index if not exists quiz_stages_version_number_idx
  on quiz_stages (quiz_version, stage_number);
-- 011_fix_privilegio_anon.sql
-- Correção emergencial de duas escaladas de privilégio que estavam DECLARADAS
-- nas migrations, não introduzidas por drift. O guard de drift dá PASS nelas
-- justamente por isso: ele prova que o banco é igual às migrations, não que as
-- migrations são seguras.
--
-- Idempotente: seguro rodar duas vezes, em produção e num banco novo.

-- ---------------------------------------------------------------
-- 1. delete_event_cascade: EXECUTE aberto para PUBLIC
--
-- A 005 termina com `GRANT EXECUTE ... TO service_role` e nada mais. Em
-- Postgres, função nasce com EXECUTE para PUBLIC: conceder a um papel NÃO
-- revoga o default. O comentário da 005 afirma "Callable only from
-- service_role" e isso era falso desde o dia em que foi escrito -- qualquer
-- cliente anônimo podia chamar a função pelo PostgREST e apagar evento,
-- participantes, respostas, prognósticos e linhas de auth.users.
--
-- Duas camadas de correção, porque uma só não basta:
--   (a) privilégio: revogar o EXECUTE de PUBLIC/anon/authenticated;
--   (b) autorização interna: a própria função recusa contexto não privilegiado,
--       para que um GRANT acidental no futuro não reabra o buraco sozinho.
-- ---------------------------------------------------------------

-- search_path VAZIO, não 'public', e todas as referências qualificadas. Vazio é
-- estritamente mais forte: nada resolve sem qualificação de schema, então nem um
-- objeto plantado em public é alcançável. Numa função SECURITY DEFINER, que roda
-- com os privilégios do dono, depender de resolução por search_path é como essa
-- mesma função apagaria a tabela errada se alguém conseguisse criar um objeto de
-- mesmo nome num schema que resolvesse antes.
create or replace function public.delete_event_cascade(event_uuid uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_participants int;
  deleted_responses int;
  deleted_prognostics int;
  deleted_logs int;
  participant_user_ids uuid[];
begin
  -- Camada (b): is_admin() já cobre os dois contextos legítimos -- JWT de
  -- service_role e usuário com app_metadata.role = 'admin'. Sem claim nenhum
  -- (anon) retorna false. 42501 = insufficient_privilege.
  if not public.is_admin() then
    raise exception 'delete_event_cascade: chamada nao autorizada'
      using errcode = '42501';
  end if;

  -- Collect user_ids of event participants (for auth.users cleanup).
  select array_agg(user_id) into participant_user_ids
  from public.participants
  where event_id = event_uuid and user_id is not null;

  delete from public.event_logs where event_id = event_uuid;
  get diagnostics deleted_logs = row_count;

  delete from public.quiz_responses
  where participant_id in (select id from public.participants where event_id = event_uuid);
  get diagnostics deleted_responses = row_count;

  delete from public.prognostics
  where participant_id in (select id from public.participants where event_id = event_uuid);
  get diagnostics deleted_prognostics = row_count;

  delete from public.participants where event_id = event_uuid;
  get diagnostics deleted_participants = row_count;

  -- Delete auth.users ONLY for this event's participants, never admins.
  -- CRITICAL: parens around the OR clause. Without them, AND/OR precedence
  -- makes the OR branch unbound and deletes every non-admin row in auth.users.
  if participant_user_ids is not null then
    delete from auth.users
    where id = any(participant_user_ids)
      and (
        raw_app_meta_data->>'role' is null
        or raw_app_meta_data->>'role' != 'admin'
      );
  end if;

  delete from public.events where id = event_uuid;

  return json_build_object(
    'deleted_logs', deleted_logs,
    'deleted_responses', deleted_responses,
    'deleted_prognostics', deleted_prognostics,
    'deleted_participants', deleted_participants,
    'deleted_users', coalesce(array_length(participant_user_ids, 1), 0)
  );
end;
$$;

-- Camada (a). CREATE OR REPLACE preserva privilégios existentes, então o
-- EXECUTE de PUBLIC herdado da criação original sobrevive ao replace acima:
-- o revoke precisa vir DEPOIS, nesta ordem.
revoke execute on function public.delete_event_cascade(uuid) from public;
revoke execute on function public.delete_event_cascade(uuid) from anon;
revoke execute on function public.delete_event_cascade(uuid) from authenticated;
grant execute on function public.delete_event_cascade(uuid) to service_role;

-- ---------------------------------------------------------------
-- 2. participant_profiles: view sem security_invoker exposta a anon
--
-- View criada na 001 sem `security_invoker`. Por padrão a view roda com os
-- privilégios do dono, então ela LÊ POR CIMA do RLS de participants,
-- prognostics e quiz_responses. Como o Supabase concede acesso às tabelas do
-- schema public para anon e authenticated, qualquer cliente anônimo podia
-- listar nome e status de prognóstico de todo mundo.
--
-- security_invoker = on faz a view aplicar o RLS de quem chama. O revoke de
-- anon é a segunda camada: sem claim, não há leitura nenhuma.
-- ---------------------------------------------------------------

alter view public.participant_profiles set (security_invoker = on);

revoke all on public.participant_profiles from anon;
grant select on public.participant_profiles to authenticated, service_role;
-- 012_is_admin_sem_claim.sql
-- is_admin() estourava em vez de recusar quando nao havia claim de JWT nenhum.
--
-- A versao da 002 fazia:
--   (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
-- Sem claim, current_setting devolve STRING VAZIA, e ''::jsonb levanta
-- "invalid input syntax for type json" ANTES de o coalesce ter chance de rodar.
-- O coalesce nunca protegeu nada: ele so cobria o caso de jsonb valido sem a
-- chave, nao o caso de nao haver jsonb.
--
-- Falha FECHADO (a excecao aborta, ninguem entra), entao nao era buraco de
-- seguranca e nao entrou no patch emergencial da 011. Mas is_admin() e chamada
-- por TODAS as policies de RLS, entao todo caminho de acesso sem claim recebia
-- um erro de parse de JSON em vez de uma negativa limpa. Pelo PostgREST o claim
-- sempre existe, e por isso o defeito nunca apareceu no app.
--
-- nullif(..., '') transforma a string vazia em NULL; NULL::jsonb e NULL sem
-- erro, as comparacoes viram NULL e o coalesce finalmente faz o que prometia.

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'service_role'
    or (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- Duas mudancas de atributo junto, ambas conservadoras:
--
-- stable: a funcao le apenas um GUC (current_setting e stable) e nenhuma
-- tabela. Declarada como volatile -- o default da 002 -- ela era reavaliada
-- linha a linha em cada policy de RLS. Com stable o planner pode reaproveitar
-- o resultado dentro da mesma consulta.
--
-- set search_path = '': toda funcao SECURITY DEFINER deve fixar o search_path
-- para nao poder ser sequestrada por um schema do chamador. Vazio em vez de
-- 'public' porque vazio e estritamente mais forte: nada resolve sem
-- qualificacao de schema, entao nem mesmo um objeto plantado em public pode
-- ser alcancado. Funciona aqui porque o corpo so chama current_setting (que
-- vive em pg_catalog, sempre implicito) e faz casts -- nenhum objeto de
-- usuario e referenciado. Nao vale para a 005/011, cujo corpo referencia
-- participants, quiz_responses e companhia sem qualificar.
--
-- NAO convertida para plpgsql com bloco de excecao: isso a tornaria total
-- (nunca estouraria nem com claim malformado), mas plpgsql nao e inlinavel e
-- custa mais por chamada -- e esta funcao roda dentro de policy, potencialmente
-- por linha. Claim malformado so e produzivel por sessao psql manual, nunca
-- pelo PostgREST. Troca consciente: robustez contra lixo manual nao vale o
-- custo por linha em producao.
-- 014_participants_colunas_travadas.sql
-- Fecha um desvio de etapa explorável pela API normal, achado pela suíte de
-- regressão de RLS e confirmado de ponta a ponta no ambiente descartável.
--
-- NÃO APLICAR sem autorização nominal. Fica escrita e validada, como a 011.
--
-- ---------------------------------------------------------------
-- A cadeia, exatamente como foi reproduzida
-- ---------------------------------------------------------------
-- 1. Participante de um evento na etapa 1 tenta gravar resposta da etapa 6:
--    NEGADO pela RLS de quiz_responses. A trava de etapa funciona.
-- 2. O mesmo participante troca o PRÓPRIO event_id para um evento que está na
--    etapa 6: PERMITIDO.
-- 3. Repete a mesma gravação da etapa 6: PERMITIDO.
-- 4. Marca o próprio completed_at: PERMITIDO.
--
-- Causa: `participants_own_update` só tem USING, sem WITH CHECK. Sem WITH
-- CHECK, o Postgres aplica a expressão do USING também à linha nova -- e essa
-- expressão só amarra `user_id = auth.uid()`. Todo o resto da linha, inclusive
-- `event_id` e `completed_at`, fica livre.
--
-- Consequências, em ordem de gravidade:
--   - A trava de etapa deixa de valer: basta apontar para um evento adiantado
--     para liberar todas as etapas antes da condução do host.
--   - O participante se insere em evento alheio, inclusive `draft`.
--   - Marcando o próprio `completed_at` ele entra na fila de geração de IA sem
--     ter completado o questionário -- custo de modelo gasto e um documento
--     gerado sobre dados incompletos, que é justamente o que o contrato novo de
--     scoring existe para evitar.
--
-- ---------------------------------------------------------------
-- Por que privilégio de coluna, e não WITH CHECK
-- ---------------------------------------------------------------
-- A correção óbvia seria um WITH CHECK que exigisse `event_id` inalterado. Não
-- dá: dentro de uma policy, USING enxerga a linha antiga e WITH CHECK enxerga a
-- nova, e não existe forma de comparar as duas na mesma expressão. Para isso
-- seria preciso uma trigger BEFORE UPDATE.
--
-- Privilégio de coluna resolve sem trigger e é mais forte, porque atua antes da
-- RLS: o participante simplesmente perde o direito de escrever nessas colunas,
-- e nenhuma policy futura reabre isso por descuido. Ele mantém UPDATE nas
-- colunas que são dele de fato.
--
-- `service_role` não é afetado: o revoke abaixo é só para anon e authenticated.
-- É por service_role que as rotas administrativas e o avanço de etapa passam.

-- ORDEM IMPORTA, e errar aqui produz um falso conserto silencioso.
-- Privilégio de coluna NÃO subtrai de privilégio de tabela: enquanto existir
-- `UPDATE` no nível da tabela, ele cobre todas as colunas e qualquer
-- `revoke update (coluna)` é ignorado na prática. O Supabase concede UPDATE de
-- tabela para anon e authenticated por padrão, então é preciso revogar a tabela
-- primeiro e só depois conceder as colunas permitidas.
--
-- Medido: com o revoke só de colunas, o participante continuava trocando o
-- próprio event_id (UPDATE 1). Com a ordem abaixo, para de conseguir.
revoke update on participants from authenticated;
revoke update on participants from anon;

-- O participante continua podendo corrigir os próprios dados de cadastro.
-- anon não recebe nada: participante sem sessão não edita ninguém.
grant update (full_name, phone, course_or_moment)
  on participants to authenticated;

-- Segunda camada: WITH CHECK explícito na policy. Ele não consegue amarrar
-- `event_id` (ver acima), mas deixa de depender do fallback implícito do
-- USING -- que é o detalhe que escondeu o problema até agora. Quem ler a policy
-- passa a ver a regra da linha nova escrita, em vez de ter que lembrar que o
-- Postgres reaproveita o USING quando o WITH CHECK falta.
drop policy if exists "participants_own_update" on participants;
create policy "participants_own_update" on participants
  for update
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());
-- 015_estados_prognostico.sql
-- Máquina de estados do prognóstico, imposta pelo banco.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011 e a 014.
--
-- ---------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------
-- prognostics.status era `text not null default 'pending'` SEM check: qualquer
-- string entrava, e qualquer string podia ser trocada por qualquer outra.
-- O caminho de regeração da aplicação forçava status = 'generated', então um
-- prognóstico `reviewed` ou `delivered` regredia e o trabalho de revisão do
-- administrador era apagado.
--
-- ---------------------------------------------------------------
-- A máquina de estados aprovada (ordem estrita)
-- ---------------------------------------------------------------
--   pending -> generating -> generated -> in_review -> reviewed -> delivered
--
-- Falhas e retentativas são estados dos JOBS de geração, não do documento: o
-- documento nunca regride sozinho.
--
-- ---------------------------------------------------------------
-- Duas peças, porque cada uma cobre o que a outra não cobre
-- ---------------------------------------------------------------
-- 1. CHECK: os valores permitidos são exatamente os seis. Um CHECK enxerga só a
--    linha nova, então ele fecha "valor fora do conjunto", mas NÃO consegue dizer
--    "reviewed -> generated é para trás".
--
-- 2. Gatilho BEFORE UPDATE: recusa transição para trás. Por que gatilho e não as
--    alternativas:
--      - Policy de RLS: USING enxerga a linha antiga, WITH CHECK a nova, e não há
--        como comparar as duas na mesma expressão. Além disso o service_role (que
--        é quem as rotas usam) ignora RLS (BYPASSRLS): uma policy nunca o
--        alcançaria, e é justamente por ele que a regressão acontecia.
--      - Privilégio de coluna em `status`: tudo-ou-nada. Não distingue
--        generated -> reviewed (legítimo) de reviewed -> generated (proibido),
--        e a revisão do admin precisa escrever essa coluna.
--      - Função/RPC como único caminho de escrita: exigiria revogar UPDATE da
--        tabela e reescrever todos os chamadores (inclusive o painel do admin,
--        que grava direto pelo cliente). Mais invasivo e ainda deixaria um
--        service_role distraído escrever na tabela por fora.
--    O gatilho dispara para QUALQUER papel, inclusive service_role e superuser.
--    Só dá para contorná-lo com DDL (alter table ... disable trigger), que exige
--    ser dono da tabela: não existe GUC nem parâmetro de sessão que o desligue,
--    de propósito (um bypass por sessão seria um bypass para o atacante também).
--
-- Regra: o gatilho recusa APENAS regressão (posição nova < posição antiga).
-- Mesmo estado -> mesmo estado passa (regravar `generated` é no-op de estado), e
-- avanço passa mesmo pulando etapas. Pular etapa é permitido de propósito: os
-- fluxos de hoje fazem generated -> reviewed (edição do admin) e
-- generated -> delivered (botão Entregar) sem passar por in_review, e o INSERT
-- já nasce `generated`, sem passar por generating. Exigir passo a passo no banco
-- quebraria o painel; se o produto quiser passo estrito, é decisão separada.
--
-- ---------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------
-- Os quatro valores que a aplicação sempre gravou (pending, generated, reviewed,
-- delivered) existem idênticos na máquina nova: o mapeamento é identidade e não
-- há UPDATE a fazer. Como a coluna era texto livre, a migração VERIFICA antes de
-- restringir; se houver qualquer outro valor ela ABORTA listando-os, em vez de
-- inventar um mapeamento (isso é decisão de produto).
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

do $$
declare
  desconhecidos text;
begin
  select string_agg(distinct coalesce(status, '<NULL>') || ' (' || n || ')', ', ')
    into desconhecidos
  from (
    select status, count(*) as n
    from public.prognostics
    where status is null
       or status not in ('pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered')
    group by status
  ) x;

  if desconhecidos is not null then
    raise exception
      '015: prognostics.status tem valores fora dos seis estados aprovados: %. Decisao de produto necessaria antes de restringir; nenhuma linha foi alterada.',
      desconhecidos
      using errcode = 'check_violation';
  end if;
end
$$;

-- CHECK: NOT VALID + VALIDATE em vez de ADD direto. O ADD direto segura lock
-- exclusivo enquanto varre a tabela; assim a varredura roda com lock mais
-- fraco. (A guarda acima já garante que a validação passa.)
alter table public.prognostics
  drop constraint if exists prognostics_status_check;

alter table public.prognostics
  add constraint prognostics_status_check
  check (status in ('pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered'))
  not valid;

alter table public.prognostics
  validate constraint prognostics_status_check;

-- Gatilho anti-regressão.
-- search_path vazio: tudo qualificado, nada resolvível por schema plantado.
create or replace function public.prognostics_bloqueia_regressao_de_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ordem constant text[] :=
    array['pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered'];
  pos_antiga int := array_position(ordem, old.status);
  pos_nova   int := array_position(ordem, new.status);
begin
  -- Valor fora dos seis não é problema deste gatilho: o CHECK recusa com a
  -- mensagem própria. Aqui só comparamos posições conhecidas.
  if pos_antiga is null or pos_nova is null then
    return new;
  end if;

  if pos_nova < pos_antiga then
    raise exception
      'Transicao de status recusada: o prognostico nao pode voltar de "%" para "%" (ordem: pending > generating > generated > in_review > reviewed > delivered).',
      old.status, new.status
      using errcode = 'check_violation',
            hint = 'Um prognostico so avanca; o estado nunca regride, nem por service_role.';
  end if;

  return new;
end;
$$;

drop trigger if exists prognostics_status_sem_regressao on public.prognostics;

create trigger prognostics_status_sem_regressao
  before update of status on public.prognostics
  for each row
  when (old.status is distinct from new.status)
  execute function public.prognostics_bloqueia_regressao_de_status();

-- A função do gatilho não é chamável por API: sem EXECUTE para quem vem da web.
-- (Funções retornando trigger já não podem ser chamadas diretamente, mas o
-- Supabase concede EXECUTE por padrão e a suíte de grants audita isso.)
revoke all on function public.prognostics_bloqueia_regressao_de_status() from public;
revoke all on function public.prognostics_bloqueia_regressao_de_status() from anon, authenticated;
-- 016_revoga_truncate.sql
-- Revoga de anon e authenticated os privilégios que a RLS NÃO governa.
--
-- NÃO APLICAR sem autorização nominal.
--
-- ---------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------
-- O Supabase concede, por padrão, todos os privilégios de tabela a `anon` e
-- `authenticated` em todo o schema public, e confia na RLS como única barreira.
-- Para SELECT, INSERT, UPDATE e DELETE isso funciona: a RLS é avaliada linha a
-- linha e as policies deste projeto cobrem esses quatro.
--
-- Três privilégios escapam dessa lógica:
--
--   TRUNCATE   -- NÃO passa por RLS. É a exceção que importa: uma policy
--                 restritiva não impede nada, porque TRUNCATE não avalia
--                 linhas. Medido: has_table_privilege('anon', <tabela>,
--                 'truncate') = true em todas as tabelas de public.
--   TRIGGER    -- permite criar gatilho numa tabela que o papel não possui.
--                 Gatilho executa código; é escalada de privilégio em potencial.
--   REFERENCES -- permite criar chave estrangeira apontando para a tabela, o
--                 que vaza existência de valores por erro de integridade e
--                 passa a bloquear exclusões legítimas.
--
-- Nenhum dos três é exposto pelo PostgREST hoje, então isto NÃO é falha
-- explorável pela API neste momento -- é endurecimento. Mas a RLS ser "a única
-- barreira" só é verdade para os privilégios que ela de fato governa, e esses
-- três não são.

revoke truncate, trigger, references on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- ---------------------------------------------------------------
-- E para as tabelas que ainda não existem
-- ---------------------------------------------------------------
-- O revoke acima vale só para as tabelas de agora. Sem mexer nos default
-- privileges, a próxima migration que criar tabela reabre o buraco em silêncio
-- -- e ninguém vai lembrar desta aqui. É exatamente o padrão que já nos mordeu:
-- correção pontual que não impede a reincidência.
--
-- O dono dos defaults é quem cria os objetos. As migrations rodam como
-- `postgres`, então é o default dele que governa toda tabela nova criada por
-- migration -- que é o caminho que importa aqui.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon;
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from authenticated;

-- LIMITAÇÃO CONHECIDA, declarada em vez de disfarçada: tabela criada por outro
-- papel (`supabase_admin`, ou seja, pelo dashboard da plataforma) continua
-- nascendo com os privilégios padrão do Supabase, TRUNCATE incluído. Cobrir
-- isso exigiria `alter default privileges for role supabase_admin`, que
-- `postgres` não pode executar -- medido: "ERROR: permission denied to change
-- default privileges", porque é preciso ser membro do papel.
--
-- O controle compensatório já existe e é o certo para esta classe: tabela
-- criada fora das migrations é exatamente o que o guard de drift acusa como
-- POLICY/OBJETO NÃO DECLARADO. Foi assim que a policy anônima de NPS, criada à
-- mão no dashboard, apareceu. Então o caminho não coberto aqui é coberto lá.

-- service_role segue com tudo: é por ele que as rotas administrativas e o
-- processamento em lote escrevem, e ele ignora RLS por desenho.
--
-- SELECT, INSERT, UPDATE e DELETE continuam concedidos a anon e authenticated,
-- governados pelas policies. Revogá-los aqui quebraria o produto inteiro, e a
-- 014 já mostrou qual é a forma correta de travar escrita quando necessário:
-- revogar no nível da tabela e reconceder por coluna.
-- 017_quiz_v2_seed.sql
-- Seed do questionario do Marco Zero (quiz_version = 2): 5 etapas, 52 perguntas.
-- Idempotente (upsert por id, nunca delete) e restrito aos ids 101..105. Nao
-- toca nas etapas 1..6 do Fort Inside (versao 1), cujo conteudo e o gabarito
-- das respostas ja gravadas. Seguro rodar duas vezes seguidas.
--
-- DEPENDE DA 010: usa quiz_stages.quiz_version e quiz_stages.stage_number.
--
-- POR QUE NAO HA delete: quiz_responses.stage_id tem FK para quiz_stages(id)
-- sem ON DELETE. Apagar etapa quebra com qualquer resposta gravada, e ja
-- quebrou neste projeto. Por isso upsert, como a 003.
--
-- FONTE DO CONTEUDO: questionario preparatorio "Marco Zero | Geracao Preparada"
-- do dono do produto, 52 perguntas numeradas. O texto das perguntas e das
-- alternativas e copiado como esta; so foram removidos os marcadores de negrito
-- (**) e o numero inicial ("7. "), que a interface mostra como "Pergunta X de N"
-- e que o id da pergunta ja carrega.
--
-- IDS: o id da pergunta e "q" + o numero da pergunta na fonte, e o motor de
-- pontuacao (lib/scoring/marco-zero.ts) le exatamente estes ids:
--   q7..q13   os 7 Elementos da Vida Plena (escala 0..10)
--   q16..q39  24 itens Likert, 6 por eixo (escala 1..5)
--   q40..q45  6 situacionais (A/B/C/D, cada alternativa pertence a um eixo)
-- As demais (q1..q6 contexto pessoal, q14/q15 e q46..q52 abertas) nao sao
-- consumidas pelo motor; seus ids nao colidem com os acima. Os ids sao unicos
-- no questionario inteiro (nao so dentro de cada etapa), para que as respostas
-- das 5 etapas possam ser achatadas num unico mapa id -> valor.
--
-- AGRUPAMENTO: uma etapa por secao da fonte, nada alem.
--   101 Sobre voce                          q1..q6    (6)
--   102 Os 7 Elementos da Vida Plena        q7..q15   (9)
--   103 Perfil comportamental               q16..q39  (24)
--   104 Como voce reage na pratica          q40..q45  (6)
--   105 Sua preparacao para o Marco Zero    q46..q52  (7)
--
-- SEM PISO DE CARACTERES: a fonte nao especifica minimo, entao nenhuma pergunta
-- aberta tem min_chars > 0 (o 0 explicito segue a convencao da 009). Medicao do
-- evento anterior: todos escreveram 2 a 3x o minimo exigido, ou seja, o piso
-- nunca produziu profundidade, so atrito. `required` exige apenas nao-vazio.
-- Os unicos tetos (max_chars) estao em respostas curtas de uma linha (nome,
-- idade, cidade, organizacao, papel, "tres palavras"): sao limite superior de
-- campo de uma linha, nao exigencia de escrita.
--
-- ALTERNATIVAS SITUACIONAIS: o tipo `select` da interface grava o TEXTO da
-- opcao escolhida, nao a letra. As opcoes mantem o prefixo da fonte ("A. ...")
-- para que a letra seja recuperavel do proprio valor gravado. Quem achatar as
-- respostas para o motor precisa extrair a letra (o motor le "A".."D").
--
-- `description` guarda a instrucao da secao exatamente como esta na fonte. A
-- tela do participante ainda nao a exibe; o prompt do prognostico a usa como
-- "Contexto" da etapa.
--
-- `ambient_name` e NOT NULL e a fonte nao tem nome de ambiente: usa-se o nome
-- do produto. Pode ser trocado aqui e a migration reaplicada.

insert into quiz_stages
  (id, title, ambient_name, description, quiz_version, stage_number, questions)
values

(101, 'Sobre você', 'Marco Zero', null, 2, 1, $json$[
  {
    "id": "q1",
    "type": "short_text",
    "required": true,
    "text": "Qual é seu nome completo?",
    "max_chars": 120
  },
  {
    "id": "q2",
    "type": "short_text",
    "required": true,
    "text": "Qual é sua idade?",
    "max_chars": 3
  },
  {
    "id": "q3",
    "type": "short_text",
    "required": true,
    "text": "Em qual cidade e estado você mora?",
    "max_chars": 120
  },
  {
    "id": "q4",
    "type": "short_text",
    "required": true,
    "text": "Qual organização, empresa, entidade ou comunidade você representa?",
    "max_chars": 160
  },
  {
    "id": "q5",
    "type": "short_text",
    "required": true,
    "text": "Qual é seu papel atual nessa organização?",
    "max_chars": 160
  },
  {
    "id": "q6",
    "type": "text",
    "required": true,
    "text": "Em quais ambientes você mais exerce influência ou liderança hoje?",
    "min_chars": 0
  }
]$json$::jsonb),

(102, 'Os 7 Elementos da Vida Plena', 'Marco Zero', 'Pensando no seu momento atual, responda de 0 a 10, sendo 0 “totalmente insatisfeito” e 10 “plenamente satisfeito”.', 2, 2, $json$[
  {
    "id": "q7",
    "type": "scale",
    "required": true,
    "text": "Desenvolvimento intelectual: quanto você está satisfeito com seu aprendizado, seu repertório e o desenvolvimento de suas capacidades?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q8",
    "type": "scale",
    "required": true,
    "text": "Saúde e energia: quanto você está satisfeito com sua saúde, sua disposição e o cuidado com seu corpo?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q9",
    "type": "scale",
    "required": true,
    "text": "Equilíbrio emocional: quanto você está satisfeito com sua capacidade de compreender suas emoções e lidar com pressões e desafios?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q10",
    "type": "scale",
    "required": true,
    "text": "Recursos financeiros: quanto você está satisfeito com sua organização financeira e com os recursos disponíveis para sustentar sua vida e seus projetos?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q11",
    "type": "scale",
    "required": true,
    "text": "Contribuição social: quanto você está satisfeito com a contribuição que oferece às pessoas, à sua comunidade e à sociedade?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q12",
    "type": "scale",
    "required": true,
    "text": "Realização e propósito: quanto você está satisfeito com o sentido, a direção e a realização que encontra na sua vida?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q13",
    "type": "scale",
    "required": true,
    "text": "Hobbies e diversão: quanto você está satisfeito com o espaço que dedica ao lazer, ao descanso e às atividades que fazem você se sentir bem?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q14",
    "type": "text",
    "required": true,
    "text": "Qual desses sete elementos mais precisa da sua atenção neste momento? Por quê?",
    "min_chars": 0
  },
  {
    "id": "q15",
    "type": "text",
    "required": true,
    "text": "Qual mudança concreta nessa área faria mais diferença na sua vida nos próximos 90 dias?",
    "min_chars": 0
  }
]$json$::jsonb),

(103, 'Perfil comportamental', 'Marco Zero', 'Responda considerando como você costuma agir no dia a dia. Utilize a escala: 1 — Discordo totalmente | 2 — Discordo | 3 — Nem concordo nem discordo | 4 — Concordo | 5 — Concordo totalmente', 2, 3, $json$[
  {
    "id": "q16",
    "type": "scale",
    "required": true,
    "text": "Consigo definir prioridades quando existem muitas possibilidades.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q17",
    "type": "scale",
    "required": true,
    "text": "Costumo conectar as decisões de hoje aos seus efeitos de longo prazo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q18",
    "type": "scale",
    "required": true,
    "text": "Questiono as premissas antes de aceitar a primeira explicação.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q19",
    "type": "scale",
    "required": true,
    "text": "Percebo padrões e oportunidades antes que fiquem evidentes para o grupo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q20",
    "type": "scale",
    "required": true,
    "text": "Quando o grupo está sem direção, costumo ajudar a encontrar um caminho.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q21",
    "type": "scale",
    "required": true,
    "text": "Consigo tomar decisões mesmo sem ter todas as informações.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q22",
    "type": "scale",
    "required": true,
    "text": "Transformo ideias em passos, responsáveis e prazos.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q23",
    "type": "scale",
    "required": true,
    "text": "Mantenho o ritmo mesmo quando a motivação inicial diminui.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q24",
    "type": "scale",
    "required": true,
    "text": "Costumo concluir o que começo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q25",
    "type": "scale",
    "required": true,
    "text": "Cumpro meus combinados mesmo quando ninguém está cobrando.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q26",
    "type": "scale",
    "required": true,
    "text": "Sob pressão, consigo concentrar energia no que precisa ser entregue.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q27",
    "type": "scale",
    "required": true,
    "text": "Divido objetivos grandes em ações que podem ser executadas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q28",
    "type": "scale",
    "required": true,
    "text": "Escuto para compreender antes de defender meu ponto de vista.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q29",
    "type": "scale",
    "required": true,
    "text": "Adapto minha comunicação a pessoas e contextos diferentes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q30",
    "type": "scale",
    "required": true,
    "text": "Consigo envolver outras pessoas em torno de uma ideia.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q31",
    "type": "scale",
    "required": true,
    "text": "Procuro incluir pessoas que ainda não tiveram espaço para falar.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q32",
    "type": "scale",
    "required": true,
    "text": "Conecto pessoas que podem gerar valor juntas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q33",
    "type": "scale",
    "required": true,
    "text": "Consigo lidar com divergências preservando a relação.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q34",
    "type": "scale",
    "required": true,
    "text": "Preservo meus princípios mesmo quando isso torna uma decisão mais difícil.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q35",
    "type": "scale",
    "required": true,
    "text": "Avalio os riscos antes de assumir compromissos importantes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q36",
    "type": "scale",
    "required": true,
    "text": "As pessoas sabem que podem contar comigo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q37",
    "type": "scale",
    "required": true,
    "text": "Procuro preservar a qualidade mesmo quando existe pressão por velocidade.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q38",
    "type": "scale",
    "required": true,
    "text": "Considero o impacto das minhas decisões sobre outras pessoas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q39",
    "type": "scale",
    "required": true,
    "text": "Costumo me preparar antes de entrar em situações importantes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  }
]$json$::jsonb),

(104, 'Como você reage na prática', 'Marco Zero', 'Em cada situação, escolha apenas a alternativa que mais se aproxima da sua primeira reação habitual.', 2, 4, $json$[
  {
    "id": "q40",
    "type": "select",
    "required": true,
    "text": "Um projeto importante está pouco claro e o prazo está próximo. O que você tende a fazer primeiro?",
    "options": [
      "A. Organizar o problema e definir a prioridade antes de avançar.",
      "B. Começar pelo próximo passo mais concreto para recuperar o movimento.",
      "C. Reunir as pessoas envolvidas e alinhar expectativas e compromissos.",
      "D. Revisar os critérios, os riscos e as responsabilidades."
    ]
  },
  {
    "id": "q41",
    "type": "select",
    "required": true,
    "text": "Duas pessoas importantes do grupo entram em conflito e o trabalho começa a parar. Qual tende a ser sua reação?",
    "options": [
      "A. Escutar os dois lados e ajudar a reconstruir o diálogo.",
      "B. Relembrar os acordos e os limites que precisam ser preservados.",
      "C. Identificar a causa do conflito e propor uma direção comum.",
      "D. Reorganizar as tarefas para que o trabalho volte a avançar."
    ]
  },
  {
    "id": "q42",
    "type": "select",
    "required": true,
    "text": "Surge uma oportunidade relevante, mas com riscos e informações incompletas. Qual é seu primeiro movimento?",
    "options": [
      "A. Testar rapidamente uma versão pequena da oportunidade.",
      "B. Comparar a oportunidade com meus objetivos de longo prazo.",
      "C. Verificar os riscos e os impactos sobre as pessoas envolvidas.",
      "D. Conversar com pessoas de confiança e buscar apoio."
    ]
  },
  {
    "id": "q43",
    "type": "select",
    "required": true,
    "text": "Você percebe que um projeto do grupo está atrasado. O que tende a fazer primeiro?",
    "options": [
      "A. Verificar o que precisa ser preservado para não comprometer a qualidade.",
      "B. Reorganizar o plano, definir responsáveis e marcar a próxima entrega.",
      "C. Conversar com o time para recuperar energia e compromisso.",
      "D. Rever as prioridades e eliminar o que está desviando o foco."
    ]
  },
  {
    "id": "q44",
    "type": "select",
    "required": true,
    "text": "Uma decisão sua recebe uma crítica pública. Como você tende a reagir primeiro?",
    "options": [
      "A. Identificar o ponto central da crítica e avaliar o que precisa mudar.",
      "B. Ouvir a pessoa e procurar compreender sua perspectiva.",
      "C. Assumir o que me cabe e apresentar uma ação concreta.",
      "D. Verificar os fatos e as responsabilidades antes de responder."
    ]
  },
  {
    "id": "q45",
    "type": "select",
    "required": true,
    "text": "Depois de uma experiência inspiradora, como você costuma transformar uma intenção em compromisso?",
    "options": [
      "A. Compartilho com alguém e crio uma rede de apoio.",
      "B. Coloco na agenda, estabeleço um prazo e começo a executar.",
      "C. Defino critérios e limites para sustentar o compromisso.",
      "D. Conecto a intenção à minha visão de futuro e escolho uma prioridade."
    ]
  }
]$json$::jsonb),

(105, 'Sua preparação para o Marco Zero', 'Marco Zero', null, 2, 5, $json$[
  {
    "id": "q46",
    "type": "short_text",
    "required": true,
    "text": "Em três palavras, quem você deseja se tornar nos próximos anos?",
    "max_chars": 80
  },
  {
    "id": "q47",
    "type": "text",
    "required": true,
    "text": "Qual comportamento seu mais ajuda você a avançar? Conte um exemplo.",
    "min_chars": 0
  },
  {
    "id": "q48",
    "type": "text",
    "required": true,
    "text": "Qual comportamento seu mais atrapalha seu desenvolvimento? Em quais situações ele aparece?",
    "min_chars": 0
  },
  {
    "id": "q49",
    "type": "text",
    "required": true,
    "text": "Qual responsabilidade ou decisão importante você vem adiando?",
    "min_chars": 0
  },
  {
    "id": "q50",
    "type": "text",
    "required": true,
    "text": "O que você pode oferecer ao grupo durante e depois do Marco Zero?",
    "min_chars": 0
  },
  {
    "id": "q51",
    "type": "text",
    "required": true,
    "text": "O que você precisa encontrar ou receber desse grupo para avançar?",
    "min_chars": 0
  },
  {
    "id": "q52",
    "type": "text",
    "required": true,
    "text": "O que precisa acontecer para você sair do Marco Zero sentindo que essa experiência valeu a pena?",
    "min_chars": 0
  }
]$json$::jsonb)
on conflict (id) do update set
  title        = excluded.title,
  ambient_name = excluded.ambient_name,
  description  = excluded.description,
  quiz_version = excluded.quiz_version,
  stage_number = excluded.stage_number,
  questions    = excluded.questions;

-- ---------------------------------------------------------------
-- Guarda de integridade. Falha a migration (em vez de semear em silencio algo
-- que o motor nao consegue ler) se, na versao 2:
--   - faltar algum id que o motor espera, ou houver id de pergunta repetido;
--   - houver caractere de encoding corrompido (licao da 008: UTF-8 lido como
--     MacRoman gravou lixo no lugar de cedilha).
-- ---------------------------------------------------------------
do $$
declare
  faltando text;
  repetidos text;
  lixo int;
begin
  select string_agg(esperado, ', ' order by esperado) into faltando
  from (
    select 'q' || g as esperado
    from generate_series(7, 13) g
    union all select 'q' || g from generate_series(16, 45) g
  ) e
  where esperado not in (
    select q ->> 'id'
    from quiz_stages s, jsonb_array_elements(s.questions) q
    where s.quiz_version = 2
  );
  if faltando is not null then
    raise exception '017: ids que o motor espera nao existem na versao 2: %', faltando;
  end if;

  select string_agg(id, ', ' order by id) into repetidos
  from (
    select q ->> 'id' as id
    from quiz_stages s, jsonb_array_elements(s.questions) q
    where s.quiz_version = 2
    group by 1
    having count(*) > 1
  ) d;
  if repetidos is not null then
    raise exception '017: ids de pergunta duplicados na versao 2: %', repetidos;
  end if;

  select count(*) into lixo
  from quiz_stages s
  where s.quiz_version = 2
    and (s.title || coalesce(s.description, '') || s.questions::text)
        ~ ('[Ã√' || chr(65533) || ']');
  if lixo > 0 then
    raise exception '017: % etapa(s) da versao 2 com encoding corrompido', lixo;
  end if;
end;
$$;
-- 018_fila_jobs.sql
-- Fila de jobs por participante: a geração de prognóstico deixa de depender da
-- sobrevivência de uma requisição HTTP de cinco minutos.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014 e a 015.
--
-- ===========================================================================
-- Por que existe
-- ===========================================================================
-- `app/api/batch-process/route.ts` gera tudo dentro de UMA requisição, em ondas
-- de 10, com maxDuration = 300. O comentário do próprio arquivo declara o alvo:
-- "com ~63s por prognóstico, 10 por onda entrega 20 participantes em ~2 min".
-- Foi dimensionado para 20.
--
-- Com 50 participantes são 5 ondas de geração (~315s, já acima do teto) e
-- depois 5 ondas de renderização de PDF, na mesma requisição. E 63s é a mediana
-- de UMA medição, não uma distribuição: como a onda dura o tempo do mais lento,
-- 315s é otimista.
--
-- O modo de falha é pior que a lentidão. O evento recebe `processing` na
-- primeira linha e `completed` na última. Se a função for cortada no meio:
-- alguns prognósticos ficam gravados, outros não existem, a resposta nunca
-- chega, o evento fica preso em `processing` para sempre e o log morre junto
-- com a função -- não sobra registro de quem falhou. Já aconteceu em produção.
--
-- A fila troca isso por estado persistido: cada participante é uma LINHA, e
-- qualquer worker futuro consegue responder "o que falta" lendo o banco.
--
-- ===========================================================================
-- O estado do JOB não é o estado do DOCUMENTO
-- ===========================================================================
-- A 015 governa `prognostics.status` (pending -> generating -> generated ->
-- in_review -> reviewed -> delivered), que NUNCA regride. O estado aqui é o da
-- TENTATIVA DE TRABALHO, que regride o tempo todo: running volta para pending
-- quando a tentativa falha e ainda há retentativa. São máquinas separadas, em
-- tabelas separadas, de propósito. Nada nesta migration escreve em
-- `prognostics`; quem escreve lá é o executor, pela função que já existe, e com
-- as travas de estado que a 015 impõe.
--
-- ===========================================================================
-- Reivindicação: por que é exclusiva
-- ===========================================================================
-- Três camadas, nesta ordem, dentro de `jobs_reivindicar`:
--
--   1. `pg_advisory_xact_lock` por `kind`. Serializa a janela em que as vagas
--      globais são contadas e consumidas. Sem ele, dois workers leriam
--      "0 em execução" ao mesmo tempo e cada um reivindicaria o teto inteiro --
--      com cron de 1 em 1 minuto e tick de até 300s, cinco ticks sobrepostos
--      virariam 5x o teto de concorrência. O lock é de transação: morre no
--      commit, no rollback e na queda da conexão, sem destravamento manual.
--      É barato porque a seção crítica é um único UPDATE.
--   2. `for update skip locked` na seleção dos candidatos. Garantia de que duas
--      transações não pegam a mesma linha mesmo que alguém, no futuro, chame o
--      UPDATE sem o lock consultivo.
--   3. O próprio UPDATE só casa linhas em `pending` (ou `running` com lease
--      vencido): depois dele o estado da linha já exclui o concorrente.
--
-- Nada disso depende de recurso externo: é Postgres puro, sem extensão.
--
-- ===========================================================================
-- Lease + token de execução (fencing)
-- ===========================================================================
-- Reivindicar grava `lease_expires_at` e um `run_token` novo. O worker renova o
-- lease enquanto trabalha. Se a função for cortada, o lease vence e OUTRO worker
-- reivindica -- gerando um run_token NOVO.
--
-- Quando o worker antigo volta do limbo e tenta gravar o resultado dele, o
-- UPDATE exige `run_token = <o token dele>`. O token mudou, nenhuma linha casa,
-- e o resultado velho é DESCARTADO em vez de sobrescrever o da tentativa mais
-- recente. É o mesmo princípio de fencing token de qualquer lock distribuído, e
-- é a razão de o token ser gerado no banco (no momento da reivindicação) e não
-- no worker.
--
-- ===========================================================================
-- Entrega AO MENOS UMA VEZ -- não exatamente uma vez
-- ===========================================================================
-- Um worker pode terminar o trabalho e morrer ANTES de gravar o desfecho. O
-- lease vence, outro worker reivindica e refaz. Isso é inerente a fila: não
-- existe commit atômico entre "a Anthropic cobrou" e "o Postgres gravou".
--
-- O que a fila garante é a IDEMPOTÊNCIA DOS EFEITOS, não a unicidade da
-- execução: `prognostics` tem UNIQUE em participant_id, a regeração é recusada
-- pela 015 fora dos estados regeráveis, e a publicação do PDF é por
-- participante. Uma tentativa interrompida PODE ter consumido créditos de IA
-- sem deixar resultado -- isso está declarado, não disfarçado.
--
-- ===========================================================================
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),

  -- Que trabalho é este. Hoje só 'prognostico'; 'pdf' fica declarado porque a
  -- renderização é o segundo pedaço caro do lote atual e vai entrar pela mesma
  -- porta, sem migration nova.
  kind text not null,

  event_id       uuid not null references public.events(id)       on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  status text not null default 'pending',

  -- Ordem de atendimento. Maior primeiro; empate resolve por created_at.
  priority int not null default 0,

  -- Tentativas JÁ INICIADAS (incrementa na reivindicação, não no desfecho).
  -- Contar na reivindicação é o que torna o contador honesto: uma tentativa que
  -- morreu sem gravar nada continua aparecendo aqui. Como toda tentativa de
  -- 'prognostico' chama o modelo, este número é também o piso de chamadas de IA
  -- potencialmente cobradas para este participante.
  attempts     int not null default 0,
  max_attempts int not null default 3,

  -- Antes deste instante a linha não é candidata. É o backoff entre tentativas.
  available_at timestamptz not null default now(),

  -- Reivindicação em vigor.
  run_token        uuid,
  lease_expires_at timestamptz,
  claimed_by       text,

  -- Visibilidade de duração, sem depender dos logs da Vercel.
  first_attempt_at   timestamptz,  -- início da PRIMEIRA tentativa (nunca reescrito)
  attempt_started_at timestamptz,  -- início da tentativa ATUAL
  finished_at        timestamptz,
  last_duration_ms   int,          -- duração da última tentativa que chegou ao fim
  total_duration_ms  bigint not null default 0,  -- soma das tentativas: o custo real

  last_error      text,
  last_error_code text,

  result   jsonb,  -- {prognostic_id, trail} no caso do prognóstico
  ai_usage jsonb,  -- reservado; ver LIMITAÇÃO no fim do arquivo

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Um job por participante por tipo. Reprocessar NÃO cria linha nova: reusa
  -- esta, preservando o histórico de tentativas. É também o que torna o
  -- enfileiramento idempotente (`on conflict do nothing`), para que um clique
  -- duplo em "Processar" não duplique trabalho pago.
  unique (kind, participant_id)
);

do $$
begin
  -- CHECKs em bloco idempotente: `add constraint if not exists` não existe.
  alter table public.jobs drop constraint if exists jobs_kind_check;
  alter table public.jobs add constraint jobs_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs drop constraint if exists jobs_status_check;
  alter table public.jobs add constraint jobs_status_check
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled'));

  alter table public.jobs drop constraint if exists jobs_max_attempts_check;
  alter table public.jobs add constraint jobs_max_attempts_check
    check (max_attempts >= 1 and attempts >= 0);
end
$$;

-- Índice da fila. Parcial nos dois estados que a reivindicação olha: as linhas
-- terminais (que são a maioria depois do evento) ficam fora do índice.
create index if not exists jobs_fila_idx
  on public.jobs (kind, available_at, priority desc, created_at)
  where status in ('pending', 'running');

-- Contagem de vagas globais e varredura de lease vencido.
create index if not exists jobs_lease_idx
  on public.jobs (kind, lease_expires_at)
  where status = 'running';

-- Painel/ops: "como está o evento X".
create index if not exists jobs_evento_idx
  on public.jobs (event_id, kind, status);

comment on table public.jobs is
  'Fila de trabalho por participante. O estado AQUI é o da tentativa; o estado do documento vive em prognostics.status (migration 015) e nunca regride.';

-- updated_at: reusa a função da 001.
drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA (lição da 014): privilégio de coluna não subtrai de privilégio
-- de tabela, e o Supabase concede a tabela inteira a anon e authenticated por
-- padrão. Revoga-se a tabela primeiro; só então o que sobra é o que foi
-- reconcedido explicitamente.
alter table public.jobs enable row level security;

revoke all on table public.jobs from anon;
revoke all on table public.jobs from authenticated;

-- O admin entra como `authenticated` com app_metadata.role = 'admin', então ele
-- precisa do privilégio de SELECT na tabela; quem filtra por pessoa é a policy.
-- O participante também é `authenticated`, mas is_admin() é false para ele e a
-- policy devolve zero linha: ele não enxerga job nenhum, nem o próprio.
-- anon não recebe privilégio algum: nem chega na policy (42501).
grant select on table public.jobs to authenticated;

-- Escrita: só service_role. Não existe policy de insert/update/delete, e sem
-- policy a RLS nega por padrão -- mas o privilégio revogado acima já barra
-- antes disso. service_role tem BYPASSRLS por desenho da plataforma: é por ele
-- que as rotas escrevem.
grant select, insert, update, delete on table public.jobs to service_role;

drop policy if exists "jobs_admin_read" on public.jobs;
create policy "jobs_admin_read" on public.jobs
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- jobs_enfileirar: cria (ou reaproveita) o job de um participante.
-- ---------------------------------------------------------------------------
-- `on conflict do nothing` em vez de `do update`: enfileirar NUNCA ressuscita um
-- job terminal. Um job que já terminou com sucesso não pode ser refeito por um
-- segundo clique em "Processar" -- para isso existe jobs_reenfileirar, que é
-- explícito e exige força para desfazer sucesso.
create or replace function public.jobs_enfileirar(
  p_kind           text,
  p_event_id       uuid,
  p_participant_id uuid,
  p_priority       int default 0,
  p_max_attempts   int default 3
)
returns table (id uuid, status text, criado boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.jobs (kind, event_id, participant_id, priority, max_attempts)
  values (p_kind, p_event_id, p_participant_id, p_priority, p_max_attempts)
  on conflict (kind, participant_id) do nothing
  returning public.jobs.id into v_id;

  if v_id is not null then
    return query select v_id, 'pending'::text, true;
    return;
  end if;

  return query
    select j.id, j.status, false
    from public.jobs j
    where j.kind = p_kind and j.participant_id = p_participant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_reivindicar: a reivindicação por lease.
-- ---------------------------------------------------------------------------
-- p_concorrencia_max é o TETO GLOBAL de jobs em execução com lease vivo, não um
-- teto por processo. Vem da configuração do worker (JOBS_CONCURRENCY, hoje 3).
-- Contado aqui dentro, sob o lock consultivo, para que ticks sobrepostos somem
-- em vez de multiplicar.
create or replace function public.jobs_reivindicar(
  p_kind             text,
  p_worker           text,
  p_lease_seconds    int default 180,
  p_limit            int default 1,
  p_concorrencia_max int default 3
)
returns table (
  id uuid,
  participant_id uuid,
  event_id uuid,
  run_token uuid,
  attempts int,
  max_attempts int,
  lease_expires_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_em_execucao int;
  v_vagas       int;
begin
  if p_lease_seconds < 5 then
    raise exception 'jobs_reivindicar: lease de % segundos é curto demais para ser renovado a tempo', p_lease_seconds
      using errcode = 'check_violation';
  end if;

  -- Serializa a janela "contar vagas e consumi-las". Transação-escopado.
  perform pg_advisory_xact_lock(hashtext('jobs_reivindicar:' || p_kind));

  select count(*) into v_em_execucao
  from public.jobs j
  where j.kind = p_kind
    and j.status = 'running'
    and j.lease_expires_at > now();

  v_vagas := least(coalesce(p_limit, 1), greatest(p_concorrencia_max - v_em_execucao, 0));

  if v_vagas <= 0 then
    return;
  end if;

  return query
  with candidatos as (
    select j.id
    from public.jobs j
    where j.kind = p_kind
      and j.available_at <= now()
      and j.attempts < j.max_attempts
      and (
        j.status = 'pending'
        -- Lease vencido: a tentativa anterior sumiu sem dar desfecho. Reivindicar
        -- daqui gera run_token novo, o que já invalida o worker que sumiu.
        or (j.status = 'running' and j.lease_expires_at <= now())
      )
    order by j.priority desc, j.created_at
    for update skip locked
    limit v_vagas
  )
  update public.jobs j
  set status             = 'running',
      attempts           = j.attempts + 1,
      run_token          = gen_random_uuid(),
      lease_expires_at   = now() + make_interval(secs => p_lease_seconds),
      claimed_by         = p_worker,
      attempt_started_at = now(),
      first_attempt_at   = coalesce(j.first_attempt_at, now()),
      finished_at        = null
  from candidatos c
  where j.id = c.id
  returning j.id, j.participant_id, j.event_id, j.run_token,
            j.attempts, j.max_attempts, j.lease_expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_renovar_lease: o worker diz "ainda estou vivo".
-- ---------------------------------------------------------------------------
-- Falso = o worker perdeu o job (lease tomado por outro, ou job já encerrado).
-- Quem recebe falso deve PARAR de trabalhar: o resultado dele vai ser recusado
-- de qualquer forma.
create or replace function public.jobs_renovar_lease(
  p_id            uuid,
  p_run_token     uuid,
  p_lease_seconds int default 180
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.jobs j
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_concluir: desfecho terminal da tentativa (succeeded | skipped | canceled).
-- ---------------------------------------------------------------------------
-- 'skipped' é o 409 de generatePrognostic: o documento avançou de estado
-- (in_review/reviewed/delivered) e regerar foi recusado DE PROPÓSITO. Não é
-- falha -- contar como falha inflaria o número em todo reprocessamento e
-- esconderia as falhas reais. É o mesmo tratamento que o lote de hoje dá.
--
-- `run_token = p_run_token and status = 'running'` é o fencing: o worker que
-- voltou do limbo não casa nenhuma linha e o resultado dele é descartado.
-- Devolve false nesse caso, para que o worker possa REGISTRAR que foi descartado
-- em vez de achar que gravou.
create or replace function public.jobs_concluir(
  p_id        uuid,
  p_run_token uuid,
  p_status    text,
  p_result    jsonb default null,
  p_ai_usage  jsonb default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_status not in ('succeeded', 'skipped', 'canceled') then
    raise exception 'jobs_concluir: status "%" não é desfecho de sucesso; use jobs_falhar', p_status
      using errcode = 'check_violation';
  end if;

  update public.jobs j
  set status            = p_status,
      finished_at       = now(),
      last_duration_ms  = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint,
      result            = coalesce(p_result, j.result),
      ai_usage          = coalesce(p_ai_usage, j.ai_usage),
      last_error        = null,
      last_error_code   = null,
      lease_expires_at  = null
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_falhar: a tentativa falhou. Reagenda ou encerra.
-- ---------------------------------------------------------------------------
-- Reagendar quando ainda há tentativa: volta para 'pending' com backoff. Essa
-- "regressão" é legítima porque é estado de JOB, não de documento.
-- Sem tentativa restante: 'failed', terminal e RASTREÁVEL (fica a mensagem, o
-- código, o número de tentativas e a duração somada).
create or replace function public.jobs_falhar(
  p_id              uuid,
  p_run_token       uuid,
  p_erro            text,
  p_codigo          text default null,
  p_backoff_seconds int default 30
)
returns table (aplicado boolean, status text, attempts int)
language plpgsql
set search_path = ''
as $$
declare
  v_row public.jobs;
begin
  update public.jobs j
  set status            = case when j.attempts >= j.max_attempts then 'failed' else 'pending' end,
      last_error        = left(coalesce(p_erro, 'erro sem mensagem'), 2000),
      last_error_code   = p_codigo,
      last_duration_ms  = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint,
      finished_at       = case when j.attempts >= j.max_attempts then now() else null end,
      available_at      = now() + make_interval(secs => greatest(coalesce(p_backoff_seconds, 0), 0)),
      lease_expires_at  = null,
      run_token         = null
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running'
  returning j.* into v_row;

  if v_row.id is null then
    return query select false, null::text, null::int;
    return;
  end if;

  return query select true, v_row.status, v_row.attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_recuperar_expirados: retoma o que ficou para trás.
-- ---------------------------------------------------------------------------
-- Chamada no começo de cada tick. Dois desfechos:
--   - ainda há tentativa  -> volta para 'pending' AGORA, e o run_token é zerado
--                            (o worker sumido já não consegue gravar nada).
--   - acabaram as tentativas -> 'failed' com motivo explícito. Sem isto, um job
--                            que estourou o lease na última tentativa ficaria
--                            'running' para sempre: invisível e irrecuperável,
--                            que é exatamente o defeito que esta fila existe
--                            para eliminar.
create or replace function public.jobs_recuperar_expirados(
  p_kind  text,
  p_limit int default 100
)
returns table (id uuid, novo_status text, attempts int)
language plpgsql
set search_path = ''
as $$
begin
  return query
  with vencidos as (
    select j.id
    from public.jobs j
    where j.kind = p_kind
      and j.status = 'running'
      and j.lease_expires_at <= now()
    order by j.lease_expires_at
    for update skip locked
    limit p_limit
  )
  update public.jobs j
  set status = case when j.attempts >= j.max_attempts then 'failed' else 'pending' end,
      run_token = null,
      lease_expires_at = null,
      available_at = now(),
      finished_at = case when j.attempts >= j.max_attempts then now() else null end,
      last_error = 'lease expirado: a tentativa ' || j.attempts
                   || ' não deu desfecho (função cortada, processo morto ou rede). '
                   || case when j.attempts >= j.max_attempts
                           then 'Sem tentativas restantes.'
                           else 'Reagendado.' end,
      last_error_code = 'lease_expirado',
      last_duration_ms = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint
  from vencidos v
  where j.id = v.id
  returning j.id, j.status, j.attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_reenfileirar: operação manual de reprocessamento.
-- ---------------------------------------------------------------------------
-- Sem p_forcar, recusa desfazer sucesso ('succeeded'/'skipped'): a preservação
-- é a regra, e quem quiser quebrá-la escreve isso explicitamente. Com p_forcar,
-- o job volta à fila, mas a 015 continua valendo no documento: um prognóstico
-- em `delivered` será recusado de novo e o job terminará em 'skipped'.
create or replace function public.jobs_reenfileirar(
  p_id     uuid,
  p_forcar boolean default false
)
returns table (aplicado boolean, status_anterior text, motivo text)
language plpgsql
set search_path = ''
as $$
declare
  v_antes text;
begin
  select j.status into v_antes from public.jobs j where j.id = p_id;

  if v_antes is null then
    return query select false, null::text, 'job inexistente'::text;
    return;
  end if;

  if v_antes = 'running' then
    return query select false, v_antes,
      'job em execução com lease vivo; espere o lease vencer ou use jobs_cancelar'::text;
    return;
  end if;

  if v_antes in ('succeeded', 'skipped') and not p_forcar then
    return query select false, v_antes,
      'job já finalizado; reprocessar exige p_forcar = true'::text;
    return;
  end if;

  update public.jobs j
  set status = 'pending',
      attempts = 0,
      run_token = null,
      lease_expires_at = null,
      available_at = now(),
      finished_at = null,
      last_error = null,
      last_error_code = null
  where j.id = p_id;

  return query select true, v_antes, 'reenfileirado'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_cancelar: tira o job da fila sem fingir que deu certo.
-- ---------------------------------------------------------------------------
-- Para o job preso cuja tentativa ainda tem lease vivo e que ninguém quer mais.
-- 'canceled' é terminal e distinto de 'failed': não foi o trabalho que falhou,
-- foi a decisão de não fazer. O run_token é zerado, então a tentativa em voo
-- (se existir) terá o resultado recusado quando voltar.
create or replace function public.jobs_cancelar(p_id uuid, p_motivo text default null)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.jobs j
  set status = 'canceled',
      run_token = null,
      lease_expires_at = null,
      finished_at = now(),
      last_error = coalesce(p_motivo, 'cancelado manualmente'),
      last_error_code = 'cancelado'
  where j.id = p_id
    and j.status in ('pending', 'running', 'failed');

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_resumo_evento: "o evento acabou?" respondido pelo banco.
-- ---------------------------------------------------------------------------
-- O lote de hoje só sabe responder isso enquanto a requisição estiver viva.
-- Aqui a resposta é uma consulta, e qualquer worker, painel ou pessoa com psql
-- consegue fazê-la depois do fato.
create or replace function public.jobs_resumo_evento(p_event_id uuid, p_kind text default 'prognostico')
returns table (
  total int, pending int, running int, succeeded int, failed int, skipped int, canceled int,
  pendentes int, total_duration_ms bigint, attempts_total int
)
language sql
stable
set search_path = ''
as $$
  select
    count(*)::int,
    count(*) filter (where j.status = 'pending')::int,
    count(*) filter (where j.status = 'running')::int,
    count(*) filter (where j.status = 'succeeded')::int,
    count(*) filter (where j.status = 'failed')::int,
    count(*) filter (where j.status = 'skipped')::int,
    count(*) filter (where j.status = 'canceled')::int,
    count(*) filter (where j.status in ('pending', 'running'))::int,
    coalesce(sum(j.total_duration_ms), 0)::bigint,
    coalesce(sum(j.attempts), 0)::int
  from public.jobs j
  where j.event_id = p_event_id and j.kind = p_kind;
$$;

-- ---------------------------------------------------------------------------
-- jobs_fechar_evento_se_concluido: mata o estado indefinido.
-- ---------------------------------------------------------------------------
-- O evento preso em 'processing' para sempre é o defeito que motivou tudo isto.
-- A saída não pode ser "a última linha da requisição grava completed", porque é
-- justamente essa linha que não roda quando a função é cortada. Aqui é o
-- contrário: QUALQUER tick, de QUALQUER worker, fecha o evento assim que não
-- sobrar job não-terminal. Chamar duas vezes não faz mal (o segundo não casa
-- linha, porque o status já não é 'processing').
--
-- Só avança 'processing' -> 'completed'. Nunca mexe em 'draft' nem 'live', e
-- nunca volta de 'completed': quem controla o evento é o painel.
create or replace function public.jobs_fechar_evento_se_concluido(
  p_event_id uuid,
  p_kind     text default 'prognostico'
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_pendentes int;
  v_total     int;
  v_n         int;
begin
  select count(*) filter (where j.status in ('pending', 'running')), count(*)
    into v_pendentes, v_total
  from public.jobs j
  where j.event_id = p_event_id and j.kind = p_kind;

  -- Sem job nenhum deste evento: não é "concluído", é "nada foi enfileirado".
  -- Fechar aqui transformaria um enfileiramento que falhou em evento completo.
  if v_total = 0 or v_pendentes > 0 then
    return false;
  end if;

  update public.events e
  set status = 'completed'
  where e.id = p_event_id and e.status = 'processing';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
-- Toda função acima é SECURITY INVOKER (o padrão). Isso é deliberado: mesmo que
-- alguém reabra o EXECUTE por descuido, o chamador ainda esbarra no privilégio
-- de tabela revogado acima. Não há caminho em que anon ou authenticated
-- escrevam na fila.
--
-- O Supabase concede EXECUTE a public por padrão em função nova; é preciso
-- revogar e reconceder só para service_role.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.jobs_enfileirar(text,uuid,uuid,int,int)',
    'public.jobs_reivindicar(text,text,int,int,int)',
    'public.jobs_renovar_lease(uuid,uuid,int)',
    'public.jobs_concluir(uuid,uuid,text,jsonb,jsonb)',
    'public.jobs_falhar(uuid,uuid,text,text,int)',
    'public.jobs_recuperar_expirados(text,int)',
    'public.jobs_reenfileirar(uuid,boolean)',
    'public.jobs_cancelar(uuid,text)',
    'public.jobs_resumo_evento(uuid,text)',
    'public.jobs_fechar_evento_se_concluido(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. `ai_usage` nasce sempre NULL. Encher essa coluna exige que o executor
--    receba o `message.usage` da Anthropic, e hoje `generatePrognostic` devolve
--    apenas {ok, prognosticId, trail} -- o usage é descartado dentro dela. A
--    coluna existe para que o dia em que aquela função passar a devolver usage
--    não precise de migration. Enquanto isso, o proxy de custo é `attempts`:
--    toda tentativa de 'prognostico' chama o modelo, então attempts é o piso de
--    chamadas potencialmente cobradas.
--
-- 2. A fila garante AO MENOS UMA VEZ. Uma tentativa pode terminar o trabalho,
--    ser cortada antes de gravar o desfecho, e ser refeita. Não há commit
--    atômico entre a cobrança da Anthropic e o commit do Postgres, e nenhuma
--    fila resolve isso -- resolve-se com idempotência do efeito, que é o que a
--    015 e o UNIQUE de prognostics.participant_id dão.
--
-- 3. O teto de concorrência é o valor que o worker PASSA na reivindicação. Se
--    dois deploys divergirem no JOBS_CONCURRENCY, o teto efetivo é o do worker
--    que reivindicou. Mantenha um valor só, por ambiente.
--
-- 4. `jobs_fechar_evento_se_concluido` só olha jobs do tipo pedido. Quando o
--    tipo 'pdf' entrar, o fechamento precisa considerar os dois (é uma troca de
--    um `and j.kind = p_kind` por um `and j.kind = any(p_kinds)`).
-- 019_heartbeat_worker.sql
-- Registro do TICK BEM-SUCEDIDO do worker da fila.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015 e a 018.
--
-- ===========================================================================
-- Por que existe: saúde do PROCESSAMENTO não é saúde do AGENDADOR
-- ===========================================================================
-- São duas propriedades diferentes, e a primeira NÃO substitui a segunda:
--
--   saúde do processamento -> existe trabalho avançando. Dá para derivar de
--     `jobs`: alguém reivindicou, renovou lease ou gravou desfecho há pouco.
--
--   saúde do agendador -> o cron executou, o handler CONCLUIU, e novas
--     execuções continuam chegando no intervalo esperado. Isso NÃO é derivável
--     de `jobs`: um tick que reivindica um job e estoura em seguida deixa
--     `jobs.updated_at` fresquinho e parece saudável por até um lease inteiro.
--     E um tick que roda com a fila vazia (o caso normal na maior parte do
--     tempo) não toca em `jobs` nenhum -- logo não deixa rastro algum.
--
-- Até esta migration, o indicador 1 era DERIVADO e se declarava derivado. O
-- buraco estava medido: `lib/jobs/provas`, caso [SAUDE-6]. Esta tabela fecha o
-- buraco gravando o fato que faltava.
--
-- ===========================================================================
-- Por que uma TABELA e não `event_logs`
-- ===========================================================================
-- `event_logs` era o único lugar gravável sem schema novo, e foi descartado por
-- medida: a página do evento lê as ÚLTIMAS 50 LINHAS de event_logs e as
-- apresenta como a linha do tempo da operação. Um heartbeat a cada 45s
-- expulsaria daquela janela todo o histórico real (liberação de etapa,
-- enfileiramento) em menos de uma hora. Trocar visibilidade da fila por
-- cegueira na operação não é troca.
--
-- `jobs` também não serve: `event_id` e `participant_id` são NOT NULL com FK e
-- `kind` tem CHECK -- não existe linha sintética de heartbeat possível.
--
-- ===========================================================================
-- UMA LINHA POR KIND, sobrescrita. Não é log, é marcador.
-- ===========================================================================
-- A pergunta que esta tabela responde é "QUANDO foi o último tick que terminou
-- inteiro?". Para isso basta uma linha por tipo de trabalho, atualizada no
-- lugar: não cresce, não precisa de expurgo, não entra em nenhuma listagem da
-- interface. O histórico de QUANTO já rodou fica no contador `ticks_ok`, que só
-- sobe -- é o que permite dizer "as execuções continuam chegando" comparando
-- duas leituras, em vez de só olhar um instante.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_worker_heartbeat (
  -- Mesmo domínio de `jobs.kind`. Sem FK porque não há tabela de tipos; o CHECK
  -- é a trava, igual ao da 018.
  kind text primary key,

  -- O fato que não dava para derivar: o instante em que um tick chegou até a
  -- ÚLTIMA linha dele. Quem grava é `jobs_registrar_tick_ok`, chamada no fim de
  -- `rodarTick` -- um tick cortado no meio nunca a alcança.
  ultimo_tick_ok_em timestamptz not null,

  -- Quem foi. Responde "qual deploy/instância estava executando o agendador".
  worker text not null,

  -- Duração do tick que terminou. Com o orçamento do tick (240s) ao lado, diz
  -- se os ticks estão rente ao teto -- sinal de que a concorrência está baixa
  -- para o volume, antes de alguém notar pela fila crescendo.
  duracao_ms int,

  -- Monotônico. Duas leituras espaçadas dizem se NOVAS execuções continuam
  -- chegando, que é parte da definição de saúde do agendador; um timestamptz
  -- sozinho não distingue "chegando de minuto em minuto" de "chegou uma vez".
  ticks_ok bigint not null default 0,

  -- {reivindicados, sucesso, pulados, falhas, descartados, recuperados}: o que
  -- aquele tick fez. É o resumo que morria no log da função.
  resumo jsonb,

  updated_at timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_worker_heartbeat drop constraint if exists jobs_worker_heartbeat_kind_check;
  alter table public.jobs_worker_heartbeat add constraint jobs_worker_heartbeat_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs_worker_heartbeat drop constraint if exists jobs_worker_heartbeat_ticks_check;
  alter table public.jobs_worker_heartbeat add constraint jobs_worker_heartbeat_ticks_check
    check (ticks_ok >= 0);
end
$$;

comment on table public.jobs_worker_heartbeat is
  'Marcador do último tick do worker que terminou INTEIRO (saúde do agendador). Uma linha por kind, sobrescrita. Não confundir com o progresso derivado de jobs.updated_at, que é saúde do processamento.';

-- Sem índice além da PK: a tabela tem no máximo uma linha por kind.

drop trigger if exists jobs_worker_heartbeat_updated_at on public.jobs_worker_heartbeat;
create trigger jobs_worker_heartbeat_updated_at
  before update on public.jobs_worker_heartbeat
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS e privilégios -- mesma ordem da 014/018
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA: privilégio de coluna não subtrai de privilégio de tabela, e o
-- Supabase concede a tabela inteira a anon e authenticated por padrão. Revoga-se
-- a tabela primeiro; só então o que sobra é o que foi reconcedido.
alter table public.jobs_worker_heartbeat enable row level security;

revoke all on table public.jobs_worker_heartbeat from anon;
revoke all on table public.jobs_worker_heartbeat from authenticated;

-- O admin precisa LER para o painel de saúde responder "o agendador está
-- executando?". O participante é `authenticated` também, mas is_admin() é false
-- para ele e a policy devolve zero linha. anon não recebe privilégio algum.
grant select on table public.jobs_worker_heartbeat to authenticated;

-- Escrita só service_role: quem grava é o worker, nunca o navegador.
grant select, insert, update, delete on table public.jobs_worker_heartbeat to service_role;

drop policy if exists "jobs_worker_heartbeat_admin_read" on public.jobs_worker_heartbeat;
create policy "jobs_worker_heartbeat_admin_read" on public.jobs_worker_heartbeat
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- jobs_registrar_tick_ok: grava que um tick terminou INTEIRO.
-- ---------------------------------------------------------------------------
-- Chamada na ÚLTIMA linha de `rodarTick`. É nisso que está toda a diferença
-- entre "a rota foi chamada" e "o tick teve sucesso": qualquer exceção antes
-- deste ponto -- na recuperação, na reivindicação, na execução, no fechamento
-- do evento -- impede a gravação, e o marcador continua apontando para o último
-- tick que de fato terminou.
--
-- `on conflict do update` incondicional é correto aqui: o marcador é o ÚLTIMO
-- tick ok, e um tick que acabou agora é sempre mais recente que o anterior.
create or replace function public.jobs_registrar_tick_ok(
  p_kind       text,
  p_worker     text,
  p_duracao_ms int default null,
  p_resumo     jsonb default null
)
returns table (ultimo_tick_ok_em timestamptz, ticks_ok bigint)
language plpgsql
set search_path = ''
as $$
begin
  return query
  insert into public.jobs_worker_heartbeat as h
    (kind, ultimo_tick_ok_em, worker, duracao_ms, ticks_ok, resumo)
  values (p_kind, now(), p_worker, p_duracao_ms, 1, p_resumo)
  on conflict (kind) do update
    set ultimo_tick_ok_em = now(),
        worker            = excluded.worker,
        duracao_ms        = excluded.duracao_ms,
        -- O contador é do BANCO, não do worker: dois deploys diferentes somam
        -- no mesmo número em vez de cada um manter a sua contagem.
        ticks_ok          = h.ticks_ok + 1,
        resumo            = excluded.resumo
  returning h.ultimo_tick_ok_em, h.ticks_ok;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (padrão), deliberado: mesmo que alguém reabra o EXECUTE por
-- descuido, o chamador ainda esbarra no privilégio de tabela revogado acima.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.jobs_registrar_tick_ok(text,text,int,jsonb)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. Esta tabela registra tick que TERMINOU. Ela NÃO distingue "o cron nunca
--    disparou" de "o cron disparou e o handler estourou antes do fim": nos dois
--    casos o marcador fica velho. Separar os dois exigiria um segundo marcador,
--    gravado no INÍCIO do tick (um `ultimo_tick_iniciado_em`), ao custo de uma
--    escrita a mais por tick. Não foi incluído porque ninguém pediu e porque o
--    sintoma operacional dos dois casos é o mesmo: o agendador não está
--    entregando. O log da rota distingue, enquanto a função sobreviver.
--
-- 2. O marcador é por `kind`, não por instância. Com dois deploys ativos, o
--    `worker` da linha é o do último que terminou -- não dá para saber se um
--    deles parou enquanto o outro continua. É a mesma troca da limitação 3 da
--    018 (mantenha um valor de configuração por ambiente).
--
-- 3. `ticks_ok` conta ticks que terminaram, não trabalho feito. Um agendador
--    saudável com a fila vazia incrementa o contador sem gerar prognóstico
--    nenhum -- e é exatamente para isso que ele serve: provar que o agendador
--    vive mesmo quando não há trabalho.
-- 020_presenca_convites.sql
-- Presença, convites e o DENOMINADOR OFICIAL da cobertura do Marco Zero.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 018 e a 019.
--
-- ===========================================================================
-- Por que NÃO é uma coluna `is_present` em participants
-- ===========================================================================
-- A proposta de `participants.is_present boolean` foi recusada pelo responsável
-- técnico com uma frase que decide o modelo inteiro: alguém pode comparecer
-- fisicamente SEM ter criado conta e SEM ter respondido ao questionário, e essa
-- pessoa precisa entrar no DENOMINADOR de presença.
--
-- Uma coluna em `participants` torna isso impossível por construção, porque
-- `participants` é a tabela de quem ENTROU NO APLICATIVO: tem `user_id`,
-- `email` único por evento e é a linha a que respostas e prognóstico se
-- amarram. Quem chegou na porta e não abriu o aplicativo não tem linha lá -- e
-- criar uma linha falsa de participante para representá-lo contamina tudo que
-- conta participantes (fila de geração, cobrança de IA, listagens do painel) com
-- pessoas que nunca responderam nada.
--
-- Daí três entidades distintas, cada uma com um dono de verdade diferente:
--
--   event_people      CADASTRO da pessoa vinculada ao evento. A associação ao
--                     participante autenticado é OPCIONAL (participant_id
--                     nullable). É esta tabela que define "pessoa", e é por
--                     pessoa que tudo é deduplicado.
--   event_invitations CONVITES individuais: uma linha por ENVIO, com estado.
--                     Uma pessoa convidada três vezes tem três linhas aqui e
--                     continua sendo UMA pessoa.
--   event_checkins    PRESENÇA FÍSICA registrada e auditável. Um único registro
--                     ATIVO por pessoa e evento, com relógio do servidor e
--                     identificação de quem confirmou.
--
-- Mais duas tabelas que existem porque "total" e "encerrado" são FATOS com
-- data, autor e versão -- não consultas feitas na hora:
--
--   event_invite_snapshots (+ _people)  A FOTOGRAFIA da lista de convidados no
--                     ENCERRAMENTO do período de convites. O total oficial de
--                     convidados é o desta fotografia, nunca um count() vivo de
--                     uma lista que ainda pode crescer.
--   event_checkin_closures  O ENCERRAMENTO formal do check-in pelo
--                     administrador, com data e autor. Sem ele não existe
--                     universo oficial de presentes.
--
--   event_dna_invalidations  O PONTO ÚNICO onde a invalidação é disparada:
--                     qualquer correção de presença (ou de elegibilidade,
--                     chamada de fora) depois do encerramento invalida a
--                     aprovação e o hash do DNA correspondente.
--
-- O DNA Coletivo em si NÃO está aqui: é outra unidade
-- (components/features/marco-zero/dna-coletivo-*). Esta migration entrega os
-- NÚMEROS que ela consome e o SINAL de invalidação que ela precisa respeitar.
--
-- ===========================================================================
-- O denominador, exatamente como foi escrito
-- ===========================================================================
--   Cobertura = (presentes com questionário válido e completo
--                / total de presentes confirmados) × 100
--
-- Exemplo canônico: 50 compareceram, 45 responderam validamente -> 90%.
-- Quem compareceu e NÃO preencheu CONTINUA no denominador. É por isso que o
-- denominador é `event_checkins` e não `participants`: a presença é o universo,
-- a resposta é o numerador.
--
-- Total de convidados NÃO é o denominador da cobertura. Ele aparece ao lado,
-- como participação, e vem do snapshot versionado. Misturar os dois é
-- exatamente o erro que o modelo do DNA já proíbe em texto.
--
-- ===========================================================================
-- "Não consegui verificar" não é "reprovado"
-- ===========================================================================
-- `marco_zero_cobertura()` nunca devolve percentual aproximado nem palpite.
-- Quando o número oficial não é calculável ela devolve
-- `status = 'indisponivel'` com `motivo`, e `cobertura_percentual = NULL`:
--
--   checkin_aberto   -- não há universo oficial: o conjunto de presentes ainda
--                       pode mudar, então qualquer percentual seria sobre um
--                       denominador provisório apresentado como final.
--   sem_presentes    -- 0 presentes. 0/0 não é 0% nem 100%: é indefinido.
--   quiz_sem_etapas  -- a versão de quiz do evento não tem etapa alguma
--                       cadastrada, então não existe definição de
--                       "questionário COMPLETO" para comparar.
--
-- As CONTAGENS (presentes, respondentes) continuam sendo devolvidas nesses
-- casos, porque contar linha é exato -- o que falta é a autoridade do universo,
-- e isso está dito em `checkin_fechado`, não escondido num número redondo.
--
-- O total de convidados tem motivo PRÓPRIO (`motivo_convidados`), para que a
-- ausência da fotografia de convites não contamine o estado da cobertura:
--   sem_snapshot_de_convites -- o período de convites não foi encerrado.
--   snapshot_inconsistente   -- o total gravado não bate com as pessoas da
--                               fotografia; devolver o total gravado seria
--                               devolver um número que o próprio banco
--                               desmente.
--
-- ===========================================================================
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. event_people -- o cadastro de PESSOAS do evento
-- ---------------------------------------------------------------------------
create table if not exists public.event_people (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  -- A associação OPCIONAL ao participante autenticado. NULL é o caso normal de
  -- quem compareceu sem criar conta, e é o motivo de esta tabela existir.
  -- `on delete set null`: apagar o participante não apaga a presença física
  -- dele -- o fato de ter estado na sala não deixa de ser verdade porque a
  -- conta sumiu, e o denominador não pode encolher por isso.
  participant_id uuid references public.participants(id) on delete set null,

  full_name text not null,
  -- NULLABLE de propósito: walk-in registrado na porta pode não ter e-mail, e
  -- exigir e-mail obrigaria a operação a inventar um.
  email text,
  phone text,

  -- Como a pessoa entrou no cadastro. 'walk_in' é quem apareceu sem convite.
  origem text not null default 'lista_convite',

  observacao text,
  registrado_por text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Alvo das FKs compostas de convites e check-ins: elas amarram
  -- (event_id, person_id) de uma vez, então não existe convite nem presença
  -- apontando para pessoa de OUTRO evento. Isso é declarativo, não confiança.
  unique (event_id, id)
);

do $$
begin
  alter table public.event_people drop constraint if exists event_people_origem_check;
  alter table public.event_people add constraint event_people_origem_check
    check (origem in ('lista_convite', 'walk_in', 'importacao'));

  alter table public.event_people drop constraint if exists event_people_nome_check;
  alter table public.event_people add constraint event_people_nome_check
    check (length(btrim(full_name)) > 0);
end
$$;

-- Deduplicação por PESSOA dentro do evento. `lower(email)` porque
-- "Maria@x.com" e "maria@x.com" são a mesma pessoa, e um total de convidados
-- que conta as duas está errado. Parcial porque e-mail é opcional: vários
-- walk-ins sem e-mail convivem.
create unique index if not exists event_people_email_unico_idx
  on public.event_people (event_id, lower(email))
  where email is not null;

-- Um participante autenticado é UMA pessoa no evento. Sem isto, duas linhas de
-- pessoa apontando para o mesmo participante contariam a mesma presença duas
-- vezes no denominador.
create unique index if not exists event_people_participante_unico_idx
  on public.event_people (event_id, participant_id)
  where participant_id is not null;

create index if not exists event_people_evento_idx
  on public.event_people (event_id);

comment on table public.event_people is
  'Cadastro das pessoas vinculadas ao evento. participant_id é OPCIONAL: quem compareceu sem criar conta tem linha aqui e entra no denominador de presença. A unidade de deduplicação do projeto é a PESSOA desta tabela, nunca o envio de convite.';

-- O participante apontado tem de ser do MESMO evento. Não dá por CHECK (exige
-- subconsulta), e a consequência de não ter a trava é direta: um participante
-- de outro evento emprestaria o questionário completo dele para o numerador
-- deste evento.
create or replace function public.event_people_valida_participante()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_evento_do_participante uuid;
begin
  if new.participant_id is null then
    return new;
  end if;

  select p.event_id into v_evento_do_participante
  from public.participants p
  where p.id = new.participant_id;

  if v_evento_do_participante is distinct from new.event_id then
    raise exception
      'event_people: participante % é do evento % e não pode ser vinculado à pessoa do evento %',
      new.participant_id, v_evento_do_participante, new.event_id
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_people_valida_participante on public.event_people;
create trigger event_people_valida_participante
  before insert or update of participant_id, event_id on public.event_people
  for each row execute function public.event_people_valida_participante();

drop trigger if exists event_people_updated_at on public.event_people;
create trigger event_people_updated_at
  before update on public.event_people
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. event_invitations -- uma linha por ENVIO, com estado
-- ---------------------------------------------------------------------------
-- O histórico de envios vive AQUI. O total oficial de convidados NÃO sai desta
-- tabela por count(): sai do snapshot (seção 3), que conta PESSOAS distintas.
-- Três envios para a mesma pessoa são três linhas aqui e UMA no snapshot.
create table if not exists public.event_invitations (
  id uuid primary key default gen_random_uuid(),
  event_id  uuid not null,
  person_id uuid not null,

  canal  text not null default 'email',
  status text not null default 'enviado',

  -- Ordinal do envio para aquela pessoa (1, 2, 3...). É o que torna o
  -- histórico legível e o registro de envio idempotente por tentativa.
  tentativa int not null default 1,

  -- RELÓGIO DO SERVIDOR. Nenhum papel de cliente escreve nesta tabela (ver
  -- bloco de privilégios), e o gatilho da seção 2.1 recusa qualquer valor
  -- diferente de now() na inserção -- inclusive vindo de service_role.
  enviado_em timestamptz not null default now(),
  enviado_por text,

  -- Endereço/telefone efetivamente usado NAQUELE envio. Fica na linha do envio
  -- porque pode ter mudado entre tentativas; o cadastro guarda o atual.
  destino text,
  erro text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (event_id, person_id)
    references public.event_people (event_id, id) on delete cascade,

  unique (person_id, tentativa)
);

do $$
begin
  alter table public.event_invitations drop constraint if exists event_invitations_canal_check;
  alter table public.event_invitations add constraint event_invitations_canal_check
    check (canal in ('email', 'whatsapp', 'sms', 'presencial', 'outro'));

  alter table public.event_invitations drop constraint if exists event_invitations_status_check;
  alter table public.event_invitations add constraint event_invitations_status_check
    check (status in ('enviado', 'entregue', 'falhou', 'respondido', 'recusado', 'cancelado'));

  alter table public.event_invitations drop constraint if exists event_invitations_tentativa_check;
  alter table public.event_invitations add constraint event_invitations_tentativa_check
    check (tentativa >= 1);
end
$$;

create index if not exists event_invitations_pessoa_idx
  on public.event_invitations (person_id, tentativa);

create index if not exists event_invitations_evento_idx
  on public.event_invitations (event_id, status);

comment on table public.event_invitations is
  'Convites individuais: UMA LINHA POR ENVIO, com estado e autor. Uma pessoa convidada três vezes tem três linhas aqui e continua sendo uma pessoa. O total oficial de convidados é o snapshot versionado (event_invite_snapshots), nunca um count() desta tabela.';

-- 2.1 Relógio do servidor, também para o envio.
create or replace function public.event_invitations_relogio_do_servidor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Atribuição, não validação: o valor que vier é descartado.
    new.enviado_em := now();
    return new;
  end if;

  if new.enviado_em is distinct from old.enviado_em then
    raise exception 'event_invitations: enviado_em é do relógio do servidor e não pode ser reescrito (envio %)', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_invitations_relogio on public.event_invitations;
create trigger event_invitations_relogio
  before insert or update on public.event_invitations
  for each row execute function public.event_invitations_relogio_do_servidor();

drop trigger if exists event_invitations_updated_at on public.event_invitations;
create trigger event_invitations_updated_at
  before update on public.event_invitations
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. event_invite_snapshots -- a FOTOGRAFIA do encerramento dos convites
-- ---------------------------------------------------------------------------
-- "Total de convidados" é, por decisão do responsável técnico, uma fotografia
-- da lista no ENCERRAMENTO do período de convites, com data e versão. Não é
-- `select count(*) from event_people`: aquela consulta responde "quantas
-- pessoas estão cadastradas AGORA", que muda quando um walk-in é cadastrado na
-- porta -- e o total de convidados não pode subir por causa de quem não foi
-- convidado.
--
-- Versão em vez de linha única: se o período for reaberto e encerrado de novo,
-- nasce a versão 2 e a 1 continua legível. Fotografia não se retoca.
create table if not exists public.event_invite_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  versao int not null,

  -- Redundante com a contagem das linhas filhas DE PROPÓSITO: é o número que
  -- foi declarado no encerramento. Se os dois divergirem, a cobertura devolve
  -- `snapshot_inconsistente` em vez de escolher um deles.
  total_convidados int not null,

  encerrado_em  timestamptz not null default now(),
  encerrado_por text not null,
  motivo text,

  created_at timestamptz not null default now(),

  unique (event_id, versao)
);

do $$
begin
  alter table public.event_invite_snapshots drop constraint if exists event_invite_snapshots_total_check;
  alter table public.event_invite_snapshots add constraint event_invite_snapshots_total_check
    check (total_convidados >= 0);

  alter table public.event_invite_snapshots drop constraint if exists event_invite_snapshots_versao_check;
  alter table public.event_invite_snapshots add constraint event_invite_snapshots_versao_check
    check (versao >= 1);
end
$$;

-- As PESSOAS da fotografia. A chave primária é (snapshot_id, person_id): a
-- deduplicação por pessoa é estrutural, não um `distinct` que alguém pode
-- esquecer de escrever.
create table if not exists public.event_invite_snapshot_people (
  snapshot_id uuid not null references public.event_invite_snapshots(id) on delete cascade,
  person_id   uuid not null references public.event_people(id) on delete restrict,
  primary key (snapshot_id, person_id)
);

comment on table public.event_invite_snapshots is
  'Fotografia da lista de convidados no encerramento do período de convites, com data, autor e versão. É daqui que sai o total OFICIAL de convidados; nunca de um count() vivo de event_people ou event_invitations.';

comment on table public.event_invite_snapshot_people is
  'Pessoas da fotografia. PK (snapshot_id, person_id): deduplicação POR PESSOA imposta pela chave, não por um distinct na consulta.';

-- Fotografia é imutável. Sem isto, "total de convidados com data e versão" é só
-- uma linha que alguém pode editar depois do fato -- que é precisamente o que a
-- decisão pedia para evitar.
create or replace function public.event_invite_snapshots_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'event_invite_snapshots: fotografia de convites é imutável (snapshot %, versão %). Encerre uma versão NOVA.', old.id, old.versao
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists event_invite_snapshots_imutavel on public.event_invite_snapshots;
create trigger event_invite_snapshots_imutavel
  before update on public.event_invite_snapshots
  for each row execute function public.event_invite_snapshots_imutavel();

-- ---------------------------------------------------------------------------
-- 4. event_checkins -- presença física, auditável
-- ---------------------------------------------------------------------------
create table if not exists public.event_checkins (
  id uuid primary key default gen_random_uuid(),
  event_id  uuid not null,
  person_id uuid not null,

  -- 'ativo'     -> é este o registro que conta no denominador
  -- 'corrigido' -> substituído por outro registro (que aponta para este)
  -- 'anulado'   -> a pessoa NÃO esteve presente; registro mantido para auditoria
  estado text not null default 'ativo',

  -- REGRA: horário atribuído pelo SERVIDOR, nunca enviado pelo cliente. Três
  -- camadas, porque uma só não cobre todos os papéis:
  --   privilégio -> anon e authenticated não têm INSERT/UPDATE nenhum aqui;
  --   default    -> quem não informa recebe now();
  --   gatilho    -> quem INFORMA tem o valor DESCARTADO e trocado por now(),
  --                 inclusive service_role. É o que impede antedatar presença
  --                 para dentro de uma janela já encerrada.
  registrado_em timestamptz not null default now(),

  -- QUEM confirmou. `_nome` e `_papel` são obrigatórios: check-in sem
  -- responsável identificado não é presença auditável, é uma linha anônima.
  -- `_uid` é opcional porque a operação pode estar na porta com um aparelho
  -- compartilhado, mas o nome e o papel nunca faltam.
  confirmado_por_uid   uuid references auth.users(id) on delete set null,
  confirmado_por_nome  text not null,
  confirmado_por_papel text not null,

  -- "mediante confirmação presencial": é uma AFIRMAÇÃO registrada, com CHECK
  -- que só aceita verdadeiro. Existe como coluna, e não como comentário, para
  -- que o registro diga o que foi afirmado no momento do check-in.
  confirmacao_presencial boolean not null default true,

  -- Entrada avulsa: compareceu SEM convite anterior. Congelado no instante do
  -- check-in (é um fato sobre aquele momento) e imutável depois -- um convite
  -- enviado DEPOIS do evento não transforma retroativamente um walk-in em
  -- convidado.
  avulso boolean not null default false,

  -- Auditoria da correção: o registro novo aponta para o que ele substitui, e o
  -- antigo continua na tabela com estado 'corrigido'. Não há sobrescrita cega.
  substitui_id uuid references public.event_checkins(id) on delete set null,
  motivo text,
  corrigido_em  timestamptz,
  corrigido_por text,

  created_at timestamptz not null default now(),

  foreign key (event_id, person_id)
    references public.event_people (event_id, id) on delete cascade
);

do $$
begin
  alter table public.event_checkins drop constraint if exists event_checkins_estado_check;
  alter table public.event_checkins add constraint event_checkins_estado_check
    check (estado in ('ativo', 'corrigido', 'anulado'));

  alter table public.event_checkins drop constraint if exists event_checkins_papel_check;
  alter table public.event_checkins add constraint event_checkins_papel_check
    check (confirmado_por_papel in ('host', 'operacao', 'admin'));

  alter table public.event_checkins drop constraint if exists event_checkins_nome_check;
  alter table public.event_checkins add constraint event_checkins_nome_check
    check (length(btrim(confirmado_por_nome)) > 0);

  -- Presença sem confirmação presencial não existe neste modelo.
  alter table public.event_checkins drop constraint if exists event_checkins_presencial_check;
  alter table public.event_checkins add constraint event_checkins_presencial_check
    check (confirmacao_presencial);

  -- Sair de 'ativo' exige motivo e autor: é o que torna a correção AUDITADA em
  -- vez de só diferente.
  alter table public.event_checkins drop constraint if exists event_checkins_correcao_check;
  alter table public.event_checkins add constraint event_checkins_correcao_check
    check (
      estado = 'ativo'
      or (motivo is not null and length(btrim(motivo)) > 0
          and corrigido_em is not null and corrigido_por is not null)
    );
end
$$;

-- UM ÚNICO REGISTRO ATIVO POR PESSOA E EVENTO. Índice parcial em vez de
-- constraint porque os registros 'corrigido' e 'anulado' PRECISAM coexistir com
-- o ativo -- é deles que o histórico é feito.
create unique index if not exists event_checkins_ativo_unico_idx
  on public.event_checkins (event_id, person_id)
  where estado = 'ativo';

create index if not exists event_checkins_evento_idx
  on public.event_checkins (event_id, estado);

create index if not exists event_checkins_pessoa_idx
  on public.event_checkins (person_id, estado);

comment on table public.event_checkins is
  'Presença física registrada e auditável. Um único registro ATIVO por (evento, pessoa); horário pelo relógio do servidor; quem confirmou é obrigatório; correção preserva o registro anterior. authenticated NÃO tem privilégio de escrita aqui -- o participante não consegue se declarar presente pelo aplicativo nem com token próprio.';

-- 4.1 Relógio do servidor, imutabilidade do fato e proibição de autodeclaração.
create or replace function public.event_checkins_integridade()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mesma_pessoa boolean;
begin
  if tg_op = 'INSERT' then
    -- Relógio do servidor: o valor informado é DESCARTADO, não validado.
    new.registrado_em := now();

    -- Ninguém confirma a própria presença. Esta é a trava que sobrevive até ao
    -- caminho de service_role: o privilégio de tabela já impede o participante
    -- de inserir, mas uma rota administrativa distraída poderia inserir um
    -- check-in "confirmado" pelo próprio uid da pessoa, e aí a confirmação
    -- presencial viraria autodeclaração com outro nome.
    if new.confirmado_por_uid is not null then
      select exists (
        select 1
        from public.event_people ep
        join public.participants p on p.id = ep.participant_id
        where ep.id = new.person_id
          and p.user_id = new.confirmado_por_uid
      ) into v_mesma_pessoa;

      if v_mesma_pessoa then
        raise exception
          'event_checkins: a própria pessoa não confirma a presença dela (pessoa %, uid %)',
          new.person_id, new.confirmado_por_uid
          using errcode = 'check_violation';
      end if;
    end if;

    return new;
  end if;

  -- UPDATE: o FATO registrado é imutável. O que pode mudar é só o desfecho de
  -- auditoria (estado, motivo, autor e data da correção). Sem isto, "correção
  -- auditada" seria um UPDATE que apaga o que havia antes -- a sobrescrita cega
  -- que a decisão proíbe.
  if new.id                     is distinct from old.id
     or new.event_id            is distinct from old.event_id
     or new.person_id           is distinct from old.person_id
     or new.registrado_em       is distinct from old.registrado_em
     or new.confirmado_por_uid  is distinct from old.confirmado_por_uid
     or new.confirmado_por_nome is distinct from old.confirmado_por_nome
     or new.confirmado_por_papel is distinct from old.confirmado_por_papel
     or new.confirmacao_presencial is distinct from old.confirmacao_presencial
     or new.avulso              is distinct from old.avulso
     or new.substitui_id        is distinct from old.substitui_id
     or new.created_at          is distinct from old.created_at
  then
    raise exception
      'event_checkins: registro de presença % é imutável; em UPDATE só estado, motivo, corrigido_em e corrigido_por podem mudar. Correção se faz com registro NOVO.',
      old.id
      using errcode = 'check_violation';
  end if;

  -- Estado não volta para 'ativo': ressuscitar um registro corrigido faria dois
  -- ativos ou apagaria a correção. Presença de volta se registra com linha nova.
  if old.estado <> 'ativo' and new.estado = 'ativo' then
    raise exception
      'event_checkins: registro % está % e não volta para ativo; registre um check-in NOVO',
      old.id, old.estado
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_checkins_integridade on public.event_checkins;
create trigger event_checkins_integridade
  before insert or update on public.event_checkins
  for each row execute function public.event_checkins_integridade();

-- ---------------------------------------------------------------------------
-- 5. event_checkin_closures -- o encerramento formal, pelo administrador
-- ---------------------------------------------------------------------------
-- Sem encerramento não existe universo oficial de presentes, e sem universo
-- oficial a cobertura não é calculável (é o motivo `checkin_aberto`).
create table if not exists public.event_checkin_closures (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  versao int not null,

  fechado_em      timestamptz not null default now(),
  fechado_por     text not null,
  fechado_por_uid uuid references auth.users(id) on delete set null,

  -- Quantos presentes havia NO FECHAMENTO. Guardado, e não recalculado, para
  -- que se saiba depois se o número mudou -- é a prova de que houve correção.
  total_presentes_no_fechamento int not null,

  -- Reabertura: encerra a vigência desta versão. O próximo encerramento é a
  -- versão seguinte.
  reaberto_em       timestamptz,
  reaberto_por      text,
  motivo_reabertura text,

  -- INVALIDAÇÃO: qualquer correção de presença (ou de elegibilidade, disparada
  -- de fora por marco_zero_invalidar_dna) depois deste fechamento invalida a
  -- aprovação e o hash do DNA correspondente. Aqui fica o marcador; o histórico
  -- de cada disparo fica em event_dna_invalidations.
  invalidado_em     timestamptz,
  invalidado_motivo text,

  created_at timestamptz not null default now(),

  unique (event_id, versao)
);

do $$
begin
  alter table public.event_checkin_closures drop constraint if exists event_checkin_closures_versao_check;
  alter table public.event_checkin_closures add constraint event_checkin_closures_versao_check
    check (versao >= 1 and total_presentes_no_fechamento >= 0);

  alter table public.event_checkin_closures drop constraint if exists event_checkin_closures_reabertura_check;
  alter table public.event_checkin_closures add constraint event_checkin_closures_reabertura_check
    check (
      (reaberto_em is null and reaberto_por is null)
      or (reaberto_em is not null and reaberto_por is not null)
    );
end
$$;

-- No máximo UM fechamento vigente por evento. Dois vigentes significariam dois
-- universos oficiais ao mesmo tempo.
create unique index if not exists event_checkin_closures_vigente_idx
  on public.event_checkin_closures (event_id)
  where reaberto_em is null;

comment on table public.event_checkin_closures is
  'Encerramento formal do check-in pelo administrador, com data, autor e versão. No máximo um vigente por evento. invalidado_em marca que houve correção de presença ou elegibilidade DEPOIS do fechamento -- o que invalida a aprovação e o hash do DNA daquele fechamento.';

-- ---------------------------------------------------------------------------
-- 6. event_dna_invalidations -- o ponto único onde a invalidação é disparada
-- ---------------------------------------------------------------------------
-- O DNA Coletivo NÃO é implementado aqui. O que esta tabela entrega é o SINAL
-- que a unidade do DNA precisa respeitar: uma linha por disparo, com origem,
-- autor do fato e o fechamento afetado. `reconhecido_em` é preenchido por quem
-- registrar a NOVA aprovação -- enquanto estiver nulo, há invalidação pendente.
create table if not exists public.event_dna_invalidations (
  id uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  closure_id uuid references public.event_checkin_closures(id) on delete set null,

  origem  text not null,
  detalhe text,

  -- Sem FK para event_checkins: a linha de invalidação tem de sobreviver ao
  -- desaparecimento do check-in que a causou (é registro de auditoria, não
  -- ponteiro vivo).
  checkin_id uuid,
  person_id  uuid,

  disparado_em timestamptz not null default now(),

  reconhecido_em  timestamptz,
  reconhecido_por text
);

do $$
begin
  alter table public.event_dna_invalidations drop constraint if exists event_dna_invalidations_origem_check;
  alter table public.event_dna_invalidations add constraint event_dna_invalidations_origem_check
    check (origem in (
      'checkin_registrado', 'checkin_corrigido', 'checkin_anulado',
      'elegibilidade', 'manual'
    ));
end
$$;

create index if not exists event_dna_invalidations_evento_idx
  on public.event_dna_invalidations (event_id, disparado_em desc);

create index if not exists event_dna_invalidations_pendentes_idx
  on public.event_dna_invalidations (event_id)
  where reconhecido_em is null;

comment on table public.event_dna_invalidations is
  'Disparos de invalidação da aprovação e do hash do DNA Coletivo: correção de presença depois do encerramento, ou mudança de elegibilidade avisada por marco_zero_invalidar_dna. O DNA em si é outra unidade; esta tabela é o contrato entre as duas.';

-- 6.1 O disparo automático. Fica em gatilho, e não na função de correção,
-- porque uma escrita direta em event_checkins por service_role (rota futura,
-- correção manual em psql) também tem de invalidar. Regra na aplicação
-- invalidaria apenas o caminho que alguém lembrou de instrumentar.
create or replace function public.event_checkins_invalida_dna()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_closure_id uuid;
  v_origem     text;
  v_detalhe    text;
  v_linha      public.event_checkins;
begin
  v_linha := case when tg_op = 'DELETE' then old else new end;

  select c.id into v_closure_id
  from public.event_checkin_closures c
  where c.event_id = v_linha.event_id
    and c.reaberto_em is null
  order by c.versao desc
  limit 1;

  -- Sem fechamento vigente não há aprovação para invalidar: check-in durante o
  -- evento é o fluxo normal, não uma correção.
  if v_closure_id is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_origem  := 'checkin_registrado';
    v_detalhe := format('presença registrada depois do encerramento (check-in %s)', new.id);
  elsif tg_op = 'DELETE' then
    v_origem  := 'checkin_anulado';
    v_detalhe := format('registro de presença removido depois do encerramento (check-in %s)', old.id);
  elsif new.estado = 'anulado' then
    v_origem  := 'checkin_anulado';
    v_detalhe := format('presença anulada depois do encerramento (check-in %s): %s', new.id, coalesce(new.motivo, '-'));
  else
    v_origem  := 'checkin_corrigido';
    v_detalhe := format('presença corrigida depois do encerramento (check-in %s -> %s): %s',
                        new.id, new.estado, coalesce(new.motivo, '-'));
  end if;

  insert into public.event_dna_invalidations
    (event_id, closure_id, origem, detalhe, checkin_id, person_id)
  values
    (v_linha.event_id, v_closure_id, v_origem, v_detalhe, v_linha.id, v_linha.person_id);

  update public.event_checkin_closures c
  set invalidado_em     = coalesce(c.invalidado_em, now()),
      invalidado_motivo = v_detalhe
  where c.id = v_closure_id;

  return null;
end;
$$;

-- AFTER, e por linha: o estado final da linha é o que importa, e o disparo não
-- pode impedir a correção legítima de acontecer.
drop trigger if exists event_checkins_invalida_dna on public.event_checkins;
create trigger event_checkins_invalida_dna
  after insert or update or delete on public.event_checkins
  for each row execute function public.event_checkins_invalida_dna();

-- ---------------------------------------------------------------------------
-- 7. RLS e privilégios -- a parte que o participante não atravessa
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA, e errar aqui produz falso conserto silencioso (lição da 014 e
-- da 010): privilégio de COLUNA não subtrai de privilégio de TABELA, e o
-- Supabase concede os privilégios do schema public a anon e authenticated por
-- default privilege. Revoga-se a TABELA primeiro; só então o que existe é o que
-- foi reconcedido explicitamente.
--
-- O desenho é o mesmo da 018, e para event_checkins é o ponto central desta
-- migration: `authenticated` recebe SELECT e NADA de escrita. Não existe policy
-- de INSERT/UPDATE/DELETE em nenhuma destas tabelas -- e, mesmo que alguém crie
-- uma amanhã, o privilégio revogado barra antes de a policy ser avaliada. É por
-- isso que "o participante não se declara presente" é PRIVILÉGIO aqui, e não
-- só política: política se reabre com uma policy nova; privilégio não.
do $$
declare
  t text;
begin
  foreach t in array array[
    'public.event_people',
    'public.event_invitations',
    'public.event_invite_snapshots',
    'public.event_invite_snapshot_people',
    'public.event_checkins',
    'public.event_checkin_closures',
    'public.event_dna_invalidations'
  ] loop
    execute format('alter table %s enable row level security', t);

    execute format('revoke all on table %s from anon', t);
    execute format('revoke all on table %s from authenticated', t);

    -- TRUNCATE, TRIGGER e REFERENCES não passam por RLS (ver 016). O revoke all
    -- acima já os cobre; explícito para que uma reconcessão futura de SELECT não
    -- traga os três de volta de carona.
    execute format('revoke truncate, trigger, references on table %s from anon', t);
    execute format('revoke truncate, trigger, references on table %s from authenticated', t);

    -- O admin entra como `authenticated` com app_metadata.role = 'admin', então
    -- precisa do privilégio de SELECT; quem recorta por pessoa é a policy. O
    -- participante também é `authenticated`, mas is_admin() é false para ele e a
    -- policy devolve ZERO linha. anon não recebe nada: nem chega na policy.
    execute format('grant select on table %s to authenticated', t);

    -- Escrita: só service_role, que é por onde as rotas administrativas passam
    -- e que ignora RLS por desenho da plataforma.
    execute format('grant select, insert, update, delete on table %s to service_role', t);

    execute format('drop policy if exists %I on %s',
                   replace(replace(t, 'public.', ''), '.', '_') || '_admin_read', t);
    execute format('create policy %I on %s for select using (public.is_admin())',
                   replace(replace(t, 'public.', ''), '.', '_') || '_admin_read', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Parâmetros dos gates do DNA
-- ---------------------------------------------------------------------------
-- Os três gates de publicação, num lugar só, para que a conta do banco e a do
-- TypeScript sejam comparáveis em vez de parecidas. Ver LIMITAÇÃO 1 no fim.
create or replace view public.marco_zero_parametros_dna as
select
  30 as minimo_respostas_validas,
  90 as cobertura_minima_percentual,
  5  as piso_supressao_por_recorte;

comment on view public.marco_zero_parametros_dna is
  'Gates de publicação do DNA Coletivo: >= 30 questionários completos e válidos entre os presentes, cobertura >= 90% dos presentes, piso de supressão de 5 pessoas por recorte. Deve bater com components/features/marco-zero/dna-coletivo-modelo.ts e dna-coletivo-protecao.ts.';

revoke all on table public.marco_zero_parametros_dna from anon;
grant select on table public.marco_zero_parametros_dna to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. marco_zero_respostas_validas -- o que conta como questionário VÁLIDO e COMPLETO
-- ---------------------------------------------------------------------------
-- A regra, escrita num lugar só para que ninguém a reescreva de memória numa
-- consulta de painel:
--
--   COMPLETO = existe resposta para TODAS as etapas da versão de quiz VIGENTE
--              do evento (events.quiz_version -> quiz_stages.quiz_version).
--   VÁLIDO   = completo, todas as respostas são objetos JSON NÃO VAZIOS, e o
--              participante tem completed_at (a marca de conclusão).
--
-- Pessoa sem participante vinculado é, por construção, não-completa: ela não
-- respondeu nada. E continua no DENOMINADOR -- é todo o ponto do modelo.
--
-- LEVANTA em vez de devolver zero quando a versão do quiz não tem etapa alguma
-- cadastrada: sem etapas não existe definição de "completo", e devolver
-- `0 válidos` seria afirmar que ninguém respondeu quando a verdade é que não se
-- sabe o que perguntar.
--
-- SECURITY DEFINER: a contagem tem de ser a contagem REAL. Com direitos de
-- invocador, um chamador sem privilégio receberia zero linha da RLS e leria
-- isso como "zero respondentes" -- um número errado em vez de um erro. O
-- EXECUTE é revogado de anon, authenticated e PUBLIC no bloco da seção 12.
create or replace function public.marco_zero_respostas_validas(p_event_id uuid)
returns table (
  person_id        uuid,
  participant_id   uuid,
  etapas_exigidas  int,
  etapas_respondidas int,
  completo         boolean,
  valido           boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quiz_version int;
  v_etapas       int;
begin
  select e.quiz_version into v_quiz_version
  from public.events e where e.id = p_event_id;

  if not found then
    raise exception 'marco_zero: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select count(*) into v_etapas
  from public.quiz_stages qs where qs.quiz_version = v_quiz_version;

  if v_etapas = 0 then
    raise exception
      'marco_zero: quiz_version % (evento %) não tem etapa alguma em quiz_stages; não há definição de questionário COMPLETO para comparar',
      v_quiz_version, p_event_id
      using errcode = 'no_data_found';
  end if;

  return query
  select
    ep.id,
    ep.participant_id,
    v_etapas,
    coalesce(r.respondidas, 0)::int,
    coalesce(r.respondidas, 0) = v_etapas,
    coalesce(r.respondidas, 0) = v_etapas
      and coalesce(r.nao_vazias, 0) = v_etapas
      and p.completed_at is not null
  from public.event_people ep
  left join public.participants p on p.id = ep.participant_id
  left join lateral (
    select
      count(distinct qr.stage_id) as respondidas,
      count(distinct qr.stage_id) filter (
        where jsonb_typeof(qr.answers) = 'object' and qr.answers <> '{}'::jsonb
      ) as nao_vazias
    from public.quiz_responses qr
    join public.quiz_stages qs
      on qs.id = qr.stage_id and qs.quiz_version = v_quiz_version
    where qr.participant_id = p.id
  ) r on true
  where ep.event_id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. marco_zero_cobertura -- O DENOMINADOR OFICIAL
-- ---------------------------------------------------------------------------
--   Cobertura = (presentes com questionário válido e completo
--                / total de presentes confirmados) × 100
--
-- Devolve UMA linha. Nunca devolve percentual aproximado: ou o número é o
-- oficial (status = 'ok'), ou é NULL com motivo (status = 'indisponivel').
-- "Não consegui verificar" é um resultado distinto de "reprovado": reprovado
-- aparece em gate_* = false COM percentual; não-verificável aparece em
-- status = 'indisponivel' com percentual NULL.
--
-- A comparação dos gates é feita em ARITMÉTICA INTEIRA
-- (respondentes * 100 >= 90 * presentes), igual à do TypeScript, para que a
-- decisão nunca dependa de arredondamento de ponto flutuante. O percentual
-- devolvido é numeric exato, sem arredondar: quem exibe trunca (89,96% não pode
-- aparecer como 90,0%), e truncar é decisão de apresentação, não de banco.
create or replace function public.marco_zero_cobertura(p_event_id uuid)
returns table (
  event_id uuid,

  -- 'ok' | 'indisponivel'
  status text,
  -- NULL quando ok; senão 'checkin_aberto' | 'sem_presentes' | 'quiz_sem_etapas'
  motivo text,

  checkin_fechado boolean,
  fechado_em      timestamptz,
  fechado_por     text,
  closure_versao  int,

  -- Correção de presença/elegibilidade depois do fechamento: a aprovação e o
  -- hash do DNA daquele fechamento estão invalidados. Os NÚMEROS abaixo seguem
  -- exatos e atuais -- o que caducou é a aprovação, não a contagem.
  aprovacao_invalidada boolean,
  invalidado_em        timestamptz,
  invalidacoes_pendentes int,

  -- Total de convidados: a fotografia versionada. NULL com motivo próprio
  -- quando não há fotografia ou quando ela não fecha com as pessoas dela.
  convidados            int,
  motivo_convidados     text,
  convite_snapshot_versao int,
  convite_encerrado_em  timestamptz,

  -- O DENOMINADOR. Contagem exata de registros ATIVOS de presença.
  presentes          int,
  presentes_avulsos  int,

  -- O NUMERADOR. NULL só quando não existe definição de "completo".
  respondentes_validos int,

  -- Presentes que NÃO responderam validamente. Continuam no denominador: é a
  -- diferença que o modelo do DNA é obrigado a mostrar.
  presentes_sem_resposta int,

  cobertura_percentual numeric,

  gate_minimo_respostas boolean,
  gate_cobertura        boolean,
  minimo_respostas      int,
  cobertura_minima_percentual int,
  piso_supressao        int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quiz_version int;
  v_etapas       int;

  v_fech_id      uuid;
  v_fech_versao  int;
  v_fech_em      timestamptz;
  v_fech_por     text;
  v_fech_inval   timestamptz;
  v_pendentes    int;

  v_snap_id      uuid;
  v_snap_versao  int;
  v_snap_em      timestamptz;
  v_snap_total   int;
  v_snap_pessoas int;

  v_convidados   int;
  v_motivo_conv  text;

  v_pres         int;
  v_avulsos      int;
  v_resp         int;

  v_status       text;
  v_motivo       text;
  v_cob          numeric;
  v_gate_min     boolean;
  v_gate_cob     boolean;

  v_min_respostas int;
  v_min_cobertura int;
  v_piso          int;
begin
  select e.quiz_version into v_quiz_version
  from public.events e where e.id = p_event_id;

  -- Evento inexistente LEVANTA. Não existe resposta "indisponível" para uma
  -- pergunta sobre um evento que não existe: devolver uma linha de zeros faria
  -- um erro de chamada parecer um evento vazio.
  if not found then
    raise exception 'marco_zero_cobertura: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select p.minimo_respostas_validas, p.cobertura_minima_percentual, p.piso_supressao_por_recorte
    into v_min_respostas, v_min_cobertura, v_piso
  from public.marco_zero_parametros_dna p;

  select count(*) into v_etapas
  from public.quiz_stages qs where qs.quiz_version = v_quiz_version;

  -- Fechamento vigente (no máximo um, pelo índice parcial).
  select c.id, c.versao, c.fechado_em, c.fechado_por, c.invalidado_em
    into v_fech_id, v_fech_versao, v_fech_em, v_fech_por, v_fech_inval
  from public.event_checkin_closures c
  where c.event_id = p_event_id and c.reaberto_em is null
  order by c.versao desc
  limit 1;

  select count(*) into v_pendentes
  from public.event_dna_invalidations i
  where i.event_id = p_event_id and i.reconhecido_em is null;

  -- O denominador.
  select count(*), count(*) filter (where ck.avulso)
    into v_pres, v_avulsos
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.estado = 'ativo';

  -- Total de convidados: fotografia, com verificação de integridade.
  select s.id, s.versao, s.encerrado_em, s.total_convidados
    into v_snap_id, v_snap_versao, v_snap_em, v_snap_total
  from public.event_invite_snapshots s
  where s.event_id = p_event_id
  order by s.versao desc
  limit 1;

  if v_snap_id is null then
    v_convidados  := null;
    v_motivo_conv := 'sem_snapshot_de_convites';
  else
    select count(*) into v_snap_pessoas
    from public.event_invite_snapshot_people sp
    where sp.snapshot_id = v_snap_id;

    if v_snap_total <> v_snap_pessoas then
      -- O banco desmente o próprio total: não se escolhe um dos dois.
      v_convidados  := null;
      v_motivo_conv := 'snapshot_inconsistente';
    else
      v_convidados  := v_snap_total;
      v_motivo_conv := null;
    end if;
  end if;

  -- O numerador: presentes (registro ATIVO) com questionário válido e completo.
  if v_etapas = 0 then
    v_resp := null;
  else
    select count(*) into v_resp
    from public.event_checkins ck
    join public.marco_zero_respostas_validas(p_event_id) v on v.person_id = ck.person_id
    where ck.event_id = p_event_id
      and ck.estado = 'ativo'
      and v.valido;
  end if;

  -- Status da COBERTURA. A ordem das recusas é a ordem da gravidade: sem
  -- definição de completo nem faz sentido falar de numerador; sem encerramento
  -- não há universo; com universo vazio a divisão é indefinida.
  if v_etapas = 0 then
    v_status := 'indisponivel';
    v_motivo := 'quiz_sem_etapas';
  elsif v_fech_id is null then
    v_status := 'indisponivel';
    v_motivo := 'checkin_aberto';
  elsif v_pres = 0 then
    v_status := 'indisponivel';
    v_motivo := 'sem_presentes';
  else
    v_status := 'ok';
    v_motivo := null;
    v_cob    := (v_resp::numeric * 100) / v_pres;
  end if;

  -- O gate de volume é uma contagem, então existe mesmo com o check-in aberto
  -- (e aí é provisório, dito por checkin_fechado = false). O gate de cobertura
  -- só existe quando a cobertura é oficial.
  v_gate_min := case when v_resp is null then null else v_resp >= v_min_respostas end;
  v_gate_cob := case
                  when v_status = 'ok' then v_resp * 100 >= v_min_cobertura * v_pres
                  else null
                end;

  return query select
    p_event_id,
    v_status,
    v_motivo,
    v_fech_id is not null,
    v_fech_em,
    v_fech_por,
    v_fech_versao,
    v_fech_inval is not null,
    v_fech_inval,
    v_pendentes,
    v_convidados,
    v_motivo_conv,
    v_snap_versao,
    v_snap_em,
    v_pres,
    v_avulsos,
    v_resp,
    case when v_resp is null then null else v_pres - v_resp end,
    v_cob,
    v_gate_min,
    v_gate_cob,
    v_min_respostas,
    v_min_cobertura,
    v_piso;
end;
$$;

comment on function public.marco_zero_cobertura(uuid) is
  'Denominador oficial e cobertura do Marco Zero: (presentes com questionário válido e completo / presentes confirmados) x 100. Nunca devolve percentual aproximado: status = indisponivel + motivo quando não é calculável. Reprovado (gate_* = false com percentual) é resultado DIFERENTE de não-verificável.';

-- ---------------------------------------------------------------------------
-- 11. Funções de escrita -- o único caminho pretendido
-- ---------------------------------------------------------------------------
-- NÃO são SECURITY DEFINER, de propósito e ao contrário das duas funções de
-- leitura acima. Função definidora que ESCREVE presença seria uma porta que
-- depende apenas do EXECUTE continuar revogado: no dia em que alguém conceder
-- execute a authenticated por engano, ela escreveria com os privilégios do dono
-- e o participante marcaria a própria presença -- exatamente o que esta
-- migration existe para impedir. Com direitos de invocador, o privilégio de
-- tabela revogado barra de novo, por baixo. Duas camadas, não uma.

-- 11.1 Cadastrar/atualizar pessoa. Dedup por (evento, e-mail minúsculo).
create or replace function public.marco_zero_pessoa_registrar(
  p_event_id       uuid,
  p_full_name      text,
  p_email          text default null,
  p_phone          text default null,
  p_origem         text default 'lista_convite',
  p_participant_id uuid default null,
  p_registrado_por text default null
)
returns table (id uuid, criado boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_email is not null then
    select ep.id into v_id
    from public.event_people ep
    where ep.event_id = p_event_id and lower(ep.email) = lower(p_email);
  end if;

  if v_id is not null then
    -- Reaproveita a pessoa: convidar de novo NÃO cria pessoa nova. É aqui que
    -- "três convites, uma pessoa" acontece na prática.
    update public.event_people ep
    set full_name      = coalesce(nullif(btrim(p_full_name), ''), ep.full_name),
        phone          = coalesce(p_phone, ep.phone),
        participant_id = coalesce(p_participant_id, ep.participant_id)
    where ep.id = v_id;

    return query select v_id, false;
    return;
  end if;

  insert into public.event_people
    (event_id, participant_id, full_name, email, phone, origem, registrado_por)
  values
    (p_event_id, p_participant_id, btrim(p_full_name), lower(nullif(btrim(p_email), '')),
     p_phone, p_origem, p_registrado_por)
  returning public.event_people.id into v_id;

  return query select v_id, true;
end;
$$;

-- 11.2 Registrar um ENVIO de convite. Tentativa = próxima da pessoa.
create or replace function public.marco_zero_convite_registrar(
  p_person_id   uuid,
  p_canal       text default 'email',
  p_destino     text default null,
  p_enviado_por text default null,
  p_status      text default 'enviado',
  p_erro        text default null
)
returns table (id uuid, tentativa int)
language plpgsql
set search_path = ''
as $$
declare
  v_event_id  uuid;
  v_tentativa int;
  v_id        uuid;
begin
  select ep.event_id into v_event_id
  from public.event_people ep where ep.id = p_person_id;

  if not found then
    raise exception 'marco_zero_convite_registrar: pessoa % não existe', p_person_id
      using errcode = 'foreign_key_violation';
  end if;

  select coalesce(max(i.tentativa), 0) + 1 into v_tentativa
  from public.event_invitations i where i.person_id = p_person_id;

  insert into public.event_invitations
    (event_id, person_id, canal, status, tentativa, enviado_por, destino, erro)
  values
    (v_event_id, p_person_id, p_canal, p_status, v_tentativa, p_enviado_por,
     coalesce(p_destino, (select ep.email from public.event_people ep where ep.id = p_person_id)),
     p_erro)
  returning public.event_invitations.id into v_id;

  return query select v_id, v_tentativa;
end;
$$;

-- 11.3 Encerrar o período de convites: a FOTOGRAFIA, com data e versão.
-- Conta PESSOAS distintas com ao menos um envio não cancelado. Deduplicação por
-- pessoa, imposta pela PK da tabela filha -- não por um `distinct` escrito aqui
-- que alguém possa esquecer num relatório paralelo.
create or replace function public.marco_zero_convites_encerrar(
  p_event_id      uuid,
  p_encerrado_por text,
  p_motivo        text default null
)
returns table (snapshot_id uuid, versao int, total_convidados int, encerrado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_versao int;
  v_id     uuid;
  v_total  int;
  v_em     timestamptz;
begin
  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'marco_zero_convites_encerrar: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select coalesce(max(s.versao), 0) + 1 into v_versao
  from public.event_invite_snapshots s where s.event_id = p_event_id;

  -- O total é contado ANTES de a linha nascer, e a linha nasce já com ele. O
  -- caminho oposto (inserir com 0 e dar UPDATE depois) exigiria desarmar o
  -- gatilho de imutabilidade da fotografia -- isto é, abrir, ainda que por um
  -- instante, exatamente a porta que aquele gatilho existe para fechar.
  select count(*) into v_total
  from public.event_people ep
  where ep.event_id = p_event_id
    and exists (
      select 1 from public.event_invitations i
      where i.person_id = ep.id and i.status <> 'cancelado'
    );

  insert into public.event_invite_snapshots
    (event_id, versao, total_convidados, encerrado_por, motivo)
  values (p_event_id, v_versao, v_total, p_encerrado_por, p_motivo)
  returning public.event_invite_snapshots.id, public.event_invite_snapshots.encerrado_em
    into v_id, v_em;

  insert into public.event_invite_snapshot_people (snapshot_id, person_id)
  select v_id, ep.id
  from public.event_people ep
  where ep.event_id = p_event_id
    and exists (
      select 1 from public.event_invitations i
      where i.person_id = ep.id and i.status <> 'cancelado'
    );

  -- Duas consultas em READ COMMITTED podem ver instantes diferentes: um convite
  -- registrado entre elas faria o total divergir das pessoas da fotografia. Em
  -- vez de confiar na janela ser estreita, verifica-se -- e uma fotografia
  -- inconsistente NUNCA é gravada.
  if (select count(*) from public.event_invite_snapshot_people sp
      where sp.snapshot_id = v_id) <> v_total then
    raise exception
      'marco_zero_convites_encerrar: a lista mudou durante o encerramento do evento %; nenhuma fotografia foi gravada. Repita.',
      p_event_id
      using errcode = 'serialization_failure';
  end if;

  return query select v_id, v_versao, v_total, v_em;
end;
$$;

-- 11.4 Registrar presença. Host (Yuri) ou alguém autorizado da operação,
-- mediante confirmação presencial. Dois check-ins para a mesma pessoa NÃO
-- geram dois ativos: devolve o ativo que já existe, com criado = false.
create or replace function public.marco_zero_checkin_registrar(
  p_event_id    uuid,
  p_person_id   uuid,
  p_por_nome    text,
  p_por_papel   text default 'host',
  p_por_uid     uuid default null
)
returns table (id uuid, criado boolean, avulso boolean, registrado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_id      uuid;
  v_avulso  boolean;
  v_em      timestamptz;
begin
  if not exists (
    select 1 from public.event_people ep
    where ep.id = p_person_id and ep.event_id = p_event_id
  ) then
    raise exception 'marco_zero_checkin_registrar: pessoa % não é do evento %', p_person_id, p_event_id
      using errcode = 'foreign_key_violation';
  end if;

  select ck.id, ck.avulso, ck.registrado_em into v_id, v_avulso, v_em
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.person_id = p_person_id and ck.estado = 'ativo';

  if v_id is not null then
    return query select v_id, false, v_avulso, v_em;
    return;
  end if;

  -- Walk-in: compareceu SEM convite anterior. Congelado agora porque é um fato
  -- sobre este momento.
  v_avulso := not exists (
    select 1 from public.event_invitations i
    where i.person_id = p_person_id and i.status <> 'cancelado'
  );

  insert into public.event_checkins
    (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel,
     confirmacao_presencial, avulso)
  values
    (p_event_id, p_person_id, p_por_uid, p_por_nome, p_por_papel, true, v_avulso)
  returning public.event_checkins.id, public.event_checkins.registrado_em
    into v_id, v_em;

  return query select v_id, true, v_avulso, v_em;
end;
$$;

-- 11.5 Entrada AVULSA (walk-in) de quem não está nem no cadastro: cadastra a
-- pessoa e registra a presença numa transação. É o caso que a decisão do
-- responsável técnico exige suportar -- compareceu sem conta e sem convite, e
-- entra no denominador.
create or replace function public.marco_zero_checkin_avulso(
  p_event_id  uuid,
  p_full_name text,
  p_por_nome  text,
  p_por_papel text default 'host',
  p_email     text default null,
  p_phone     text default null,
  p_por_uid   uuid default null
)
returns table (person_id uuid, checkin_id uuid, avulso boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_person uuid;
  v_ck     record;
begin
  select r.id into v_person
  from public.marco_zero_pessoa_registrar(
    p_event_id, p_full_name, p_email, p_phone, 'walk_in', null, p_por_nome
  ) r;

  select * into v_ck
  from public.marco_zero_checkin_registrar(p_event_id, v_person, p_por_nome, p_por_papel, p_por_uid) x;

  return query select v_person, v_ck.id, v_ck.avulso;
end;
$$;

-- 11.6 CORREÇÃO AUDITADA: o registro antigo fica, com estado 'corrigido' e
-- motivo; o novo nasce apontando para ele por substitui_id. Não há sobrescrita.
create or replace function public.marco_zero_checkin_corrigir(
  p_checkin_id uuid,
  p_motivo     text,
  p_por_nome   text,
  p_por_papel  text default 'admin',
  p_por_uid    uuid default null
)
returns table (anterior_id uuid, novo_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_old public.event_checkins;
  v_new uuid;
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_corrigir: correção sem motivo não é correção auditada'
      using errcode = 'check_violation';
  end if;

  select * into v_old from public.event_checkins ck where ck.id = p_checkin_id;
  if not found then
    raise exception 'marco_zero_checkin_corrigir: check-in % não existe', p_checkin_id
      using errcode = 'no_data_found';
  end if;
  if v_old.estado <> 'ativo' then
    raise exception 'marco_zero_checkin_corrigir: check-in % já está % e não é o registro vigente', p_checkin_id, v_old.estado
      using errcode = 'check_violation';
  end if;

  -- Primeiro libera o índice parcial de "um ativo só", depois insere o novo.
  update public.event_checkins ck
  set estado = 'corrigido', motivo = p_motivo, corrigido_em = now(), corrigido_por = p_por_nome
  where ck.id = p_checkin_id;

  insert into public.event_checkins
    (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel,
     confirmacao_presencial, avulso, substitui_id)
  values
    (v_old.event_id, v_old.person_id, p_por_uid, p_por_nome, p_por_papel,
     true, v_old.avulso, v_old.id)
  returning public.event_checkins.id into v_new;

  return query select v_old.id, v_new;
end;
$$;

-- 11.7 ANULAÇÃO auditada: a pessoa NÃO esteve presente. Sai do denominador sem
-- sair da tabela.
create or replace function public.marco_zero_checkin_anular(
  p_checkin_id uuid,
  p_motivo     text,
  p_por_nome   text
)
returns table (id uuid, estado text)
language plpgsql
set search_path = ''
as $$
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_anular: anulação sem motivo não é auditável'
      using errcode = 'check_violation';
  end if;

  return query
  update public.event_checkins ck
  set estado = 'anulado', motivo = p_motivo, corrigido_em = now(), corrigido_por = p_por_nome
  where ck.id = p_checkin_id and ck.estado = 'ativo'
  returning ck.id, ck.estado;
end;
$$;

-- 11.8 ENCERRAR o check-in. Só o administrador, pela rota que usa service_role.
create or replace function public.marco_zero_checkin_encerrar(
  p_event_id    uuid,
  p_fechado_por text,
  p_por_uid     uuid default null
)
returns table (closure_id uuid, versao int, total_presentes int, fechado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_versao int;
  v_total  int;
  v_id     uuid;
  v_em     timestamptz;
begin
  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'marco_zero_checkin_encerrar: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from public.event_checkin_closures c
    where c.event_id = p_event_id and c.reaberto_em is null
  ) then
    raise exception 'marco_zero_checkin_encerrar: o check-in do evento % já está encerrado; reabra antes de encerrar de novo', p_event_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_total
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.estado = 'ativo';

  select coalesce(max(c.versao), 0) + 1 into v_versao
  from public.event_checkin_closures c where c.event_id = p_event_id;

  insert into public.event_checkin_closures
    (event_id, versao, fechado_por, fechado_por_uid, total_presentes_no_fechamento)
  values (p_event_id, v_versao, p_fechado_por, p_por_uid, v_total)
  returning public.event_checkin_closures.id, public.event_checkin_closures.fechado_em
    into v_id, v_em;

  return query select v_id, v_versao, v_total, v_em;
end;
$$;

-- 11.9 REABRIR: encerra a vigência da versão atual. O próximo encerramento é a
-- versão seguinte, e a reabertura em si já é motivo de invalidação.
create or replace function public.marco_zero_checkin_reabrir(
  p_event_id uuid,
  p_por_nome text,
  p_motivo   text
)
returns table (closure_id uuid, versao int)
language plpgsql
set search_path = ''
as $$
declare
  v_id     uuid;
  v_versao int;
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_reabrir: reabertura sem motivo não é auditável'
      using errcode = 'check_violation';
  end if;

  update public.event_checkin_closures c
  set reaberto_em = now(), reaberto_por = p_por_nome, motivo_reabertura = p_motivo
  where c.event_id = p_event_id and c.reaberto_em is null
  returning c.id, c.versao into v_id, v_versao;

  if v_id is null then
    raise exception 'marco_zero_checkin_reabrir: o evento % não tem encerramento vigente', p_event_id
      using errcode = 'no_data_found';
  end if;

  perform public.marco_zero_invalidar_dna(
    p_event_id, 'manual',
    format('check-in reaberto (fechamento versão %s): %s', v_versao, p_motivo),
    v_id
  );

  return query select v_id, v_versao;
end;
$$;

-- 11.10 O ponto de invalidação chamável de FORA: mudança de ELEGIBILIDADE, que
-- esta unidade não governa, também invalida a aprovação e o hash do DNA. A
-- unidade do DNA chama isto (ou lê event_dna_invalidations) em vez de reimplementar
-- a regra.
create or replace function public.marco_zero_invalidar_dna(
  p_event_id   uuid,
  p_origem     text default 'elegibilidade',
  p_detalhe    text default null,
  p_closure_id uuid default null
)
returns table (id uuid, closure_id uuid, disparado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_closure uuid;
  v_id      uuid;
  v_em      timestamptz;
begin
  v_closure := p_closure_id;

  if v_closure is null then
    select c.id into v_closure
    from public.event_checkin_closures c
    where c.event_id = p_event_id and c.reaberto_em is null
    order by c.versao desc
    limit 1;
  end if;

  insert into public.event_dna_invalidations (event_id, closure_id, origem, detalhe)
  values (p_event_id, v_closure, p_origem, p_detalhe)
  returning public.event_dna_invalidations.id, public.event_dna_invalidations.disparado_em
    into v_id, v_em;

  if v_closure is not null then
    update public.event_checkin_closures c
    set invalidado_em     = coalesce(c.invalidado_em, now()),
        invalidado_motivo = coalesce(p_detalhe, p_origem)
    where c.id = v_closure;
  end if;

  return query select v_id, v_closure, v_em;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Privilégio de EXECUÇÃO das funções
-- ---------------------------------------------------------------------------
-- Mesmo padrão da 018: PUBLIC, anon e authenticated sem EXECUTE; service_role
-- com EXECUTE. As rotas administrativas passam por service_role.
--
-- Vale para as duas funções de LEITURA também: `marco_zero_cobertura` é
-- SECURITY DEFINER, então conceder execute a authenticated entregaria a
-- contagem real a qualquer participante autenticado. O painel do admin lê isto
-- pela rota do servidor, como já faz com a fila da 018.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.marco_zero_respostas_validas(uuid)',
    'public.marco_zero_cobertura(uuid)',
    'public.marco_zero_pessoa_registrar(uuid,text,text,text,text,uuid,text)',
    'public.marco_zero_convite_registrar(uuid,text,text,text,text,text)',
    'public.marco_zero_convites_encerrar(uuid,text,text)',
    'public.marco_zero_checkin_registrar(uuid,uuid,text,text,uuid)',
    'public.marco_zero_checkin_avulso(uuid,text,text,text,text,text,uuid)',
    'public.marco_zero_checkin_corrigir(uuid,text,text,text,uuid)',
    'public.marco_zero_checkin_anular(uuid,text,text)',
    'public.marco_zero_checkin_encerrar(uuid,text,uuid)',
    'public.marco_zero_checkin_reabrir(uuid,text,text)',
    'public.marco_zero_invalidar_dna(uuid,text,text,uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. Os gates vivem em DOIS lugares, e não nos mesmos dois. Medido em
--    components/features/marco-zero/ no momento desta migration:
--      COBERTURA_MINIMA_PERCENTUAL = 90  (dna-coletivo-modelo.ts) -> igual aqui
--      PISO_DE_EXIBICAO            = 5   (dna-coletivo-protecao.ts) -> igual aqui
--      mínimo de 30 questionários        -> NÃO EXISTE no TypeScript. O `K` de
--        `passaBase` daquele arquivo é o PISO DE SUPRESSÃO (5), não o mínimo de
--        volume. Quem publicar o DNA tem de ler `gate_minimo_respostas` daqui,
--        ou o gate de 30 não existe em lugar nenhum do caminho.
--    Esta unidade não pode editar aqueles arquivos. A view é a fonte do lado do
--    banco, a igualdade dos dois valores que já existem é verificada na prova
--    (supabase/provas/020-cobertura.sql), e o terceiro está DECLARADO como
--    pendência de integração, não escondido.
--
-- 2. "Válido" aqui é validade ESTRUTURAL: todas as etapas da versão vigente
--    respondidas, respostas em objeto JSON não vazio e `completed_at` presente.
--    Validade SEMÂNTICA (resposta coerente, dimensão pontuável) é do motor de
--    scoring, não do banco. Se o motor passar a reprovar respostas que o banco
--    considera válidas, o numerador daqui será maior que o dele -- e aí a regra
--    tem de mudar num lugar só: esta função.
--
-- 3. O gatilho de invalidação cobre INSERT, UPDATE e DELETE em event_checkins.
--    NÃO cobre um `alter table ... disable trigger` nem a remoção em cascata de
--    um evento inteiro (que leva a tabela de invalidações junto, e nesse caso
--    não há mais DNA a invalidar). Mudança de ELEGIBILIDADE não é observável
--    daqui: quem a faz tem de chamar `marco_zero_invalidar_dna`. Isso é
--    contrato entre unidades, não trava de banco, e está dito.
--
-- 4. `marco_zero_convites_encerrar` não roda em transação serializável: ela
--    conta, grava e VERIFICA, e levanta `serialization_failure` se a lista
--    mudou no meio. Então o encerramento pode FALHAR sob concorrência e precisar
--    de nova tentativa -- falha fechado, sem gravar fotografia errada. Encerrar
--    convites é ato único do administrador, não caminho de alto volume: trocar
--    um retry raro por uma fotografia possivelmente inconsistente seria a troca
--    errada.
--
-- 5. DELETE em event_checkins continua possível para service_role (e é o que a
--    cascata de `delete_event_cascade`, da 005, precisa). Presença não é
--    apagada pelo fluxo normal -- anulação é o caminho auditado -- mas quem tem
--    service_role e escreve SQL à mão consegue apagar. O gatilho registra a
--    invalidação do DNA nesse caso; o registro em si, não há como preservar sem
--    tabela de histórico à parte, que foi considerada fora de escopo desta
--    unidade.
--
-- 6. Nenhuma destas tabelas é exposta a `authenticated` para escrita, e por isso
--    não existe caminho de aplicativo para o participante se declarar presente.
--    O que NÃO está coberto é uma rota de servidor futura que, com
--    service_role, aceite `person_id` vindo do cliente sem checar quem pediu --
--    isso é autorização de rota, não de banco. O gatilho de autodeclaração
--    (seção 4.1) é a única parte dessa classe que o banco consegue barrar, e
--    barra: ninguém confirma a própria presença.
-- 021_orcamento_consumo_externo.sql
-- Disjuntor de consumo externo: quantas TENTATIVAS CHEGARAM AO PROVEDOR, por
-- evento e por participante, com teto persistente e liberação auditada.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 018 e a 019.
--
-- (A 020 é de outra unidade, modelando presença e convites. Esta é a 021.)
--
-- ===========================================================================
-- Por que `jobs.attempts` NÃO serve para isto
-- ===========================================================================
-- Duas razões, e cada uma sozinha já bastaria:
--
-- 1. `attempts` conta REIVINDICAÇÕES, não chegadas ao provedor. Uma tentativa
--    que perde o lease antes de chamar o modelo, ou que é recusada pelo próprio
--    disjuntor, incrementa `attempts` sem ter custado nada. Contar essas
--    tentativas no teto gastaria orçamento que não foi gasto.
--
-- 2. `jobs_reenfileirar(p_forcar => true)` ZERA `attempts` (018). Um teto por
--    participante lido de `attempts` seria decorativo: bastaria reprocessar à
--    força para o contador voltar a zero e o teto nunca morder. Este foi um
--    achado medido, não hipótese.
--
-- Por isso o registro aqui é um LIVRO-RAZÃO APPEND-ONLY, numa tabela própria,
-- com chave em (event_id, participant_id) e independente do ciclo de vida da
-- linha de `jobs`. Reprocessar à força não apaga o que já foi gasto, porque o
-- que já foi gasto não deixou de ter sido gasto.
--
-- ===========================================================================
-- O que conta como tentativa externa
-- ===========================================================================
-- Conta: toda tentativa em que uma requisição foi DESPACHADA ao provedor,
--   INCLUSIVE as abortadas por timeout ou por perda de lease. Uma geração
--   cortada no meio já consumiu do provedor; o fencing recusa o resultado, não
--   a cobrança.
-- NÃO conta: tentativa que nunca abriu conexão (o aborto chegou antes do
--   despacho, e o invólucro de fetch recusa a requisição sem sair do processo).
--
-- O número é registrado pelo worker, que é quem consegue observar o despacho
-- (ver `lib/jobs/aborto.ts`). O banco guarda, soma e compara com o teto.
--
-- `chamadas` é o número de REQUISIÇÕES despachadas na tentativa, que pode ser
-- maior que 1: o SDK da Anthropic tenta de novo por conta própria em falha de
-- rede. Os tetos desta migration são em TENTATIVAS (linhas com chamadas > 0),
-- como pedido; `chamadas` fica persistido ao lado para a recalibração com a
-- distribuição real de custo.
--
-- ===========================================================================
-- Números iniciais e de onde vêm
-- ===========================================================================
-- Teto inicial: 100 tentativas externas por evento, dimensionado para 50
-- participantes elegíveis, com máximo de 3 por participante. É LIMITE
-- OPERACIONAL INICIAL, não teto monetário em dólares, e deve ser recalibrado
-- com a distribuição real de custo e duração. Evento de referência: 24/10/2026,
-- 50 jovens.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- 1. Livro-razão do consumo externo. APPEND-ONLY.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_consumo_externo (
  id uuid primary key default gen_random_uuid(),

  kind text not null,

  -- Não é FK para `jobs`: a linha de job pode ser reenfileirada à força (o que
  -- zera attempts) e o livro-razão tem de sobreviver a isso. O vínculo que
  -- importa é com o evento e com a pessoa, e esses são FK de verdade.
  event_id       uuid not null references public.events(id)       on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- Rastro de QUAL tentativa gastou. Referência fraca de propósito.
  job_id    uuid,
  run_token uuid,

  -- Requisições DESPACHADAS ao provedor nesta tentativa. 0 = a tentativa
  -- existiu mas nunca abriu conexão: fica registrada (serve à medição) e NÃO
  -- conta no teto, porque não custou.
  chamadas int not null default 0,

  -- true = a tentativa foi cortada (timeout ou lease perdido). Continua
  -- contando se chamadas > 0: chegou ao provedor, logo custou.
  abortada boolean not null default false,

  -- 'ok', 'timeout_da_tentativa', 'lease_perdido_abortado', 'excecao'...
  motivo text,

  registrado_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_consumo_externo drop constraint if exists jobs_consumo_externo_kind_check;
  alter table public.jobs_consumo_externo add constraint jobs_consumo_externo_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs_consumo_externo drop constraint if exists jobs_consumo_externo_chamadas_check;
  alter table public.jobs_consumo_externo add constraint jobs_consumo_externo_chamadas_check
    check (chamadas >= 0);
end
$$;

-- A consulta do disjuntor é sempre "quanto este evento/participante já gastou".
create index if not exists jobs_consumo_externo_evento_idx
  on public.jobs_consumo_externo (kind, event_id, participant_id)
  where chamadas > 0;

comment on table public.jobs_consumo_externo is
  'Livro-razão APPEND-ONLY das tentativas que CHEGARAM ao provedor externo (inclusive abortadas). Independente de jobs.attempts, que conta reivindicações e é zerado por jobs_reenfileirar(p_forcar).';

-- ---------------------------------------------------------------------------
-- 2. Teto persistente por evento. Alterável SOMENTE por liberação auditada.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_orcamento_evento (
  event_id uuid primary key references public.events(id) on delete cascade,
  kind text not null default 'prognostico',
  teto_evento       int not null,
  teto_participante int not null,
  definido_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_orcamento_evento drop constraint if exists jobs_orcamento_evento_tetos_check;
  alter table public.jobs_orcamento_evento add constraint jobs_orcamento_evento_tetos_check
    check (teto_evento >= 0 and teto_participante >= 0);
end
$$;

comment on table public.jobs_orcamento_evento is
  'Teto de consumo externo em vigor por evento. Sem linha aqui, vale o padrão que o worker passa (config). Só muda por jobs_orcamento_liberar, que exige quem e por quê.';

-- ---------------------------------------------------------------------------
-- 3. Auditoria das liberações. APPEND-ONLY, e é a única porta de alteração.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_orcamento_liberacoes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null default 'prognostico',

  -- QUEM. Identidade de quem autorizou, não "o sistema".
  liberado_por text not null,
  -- POR QUÊ. Obrigatório e com tamanho mínimo: "porque sim" não é motivo.
  motivo text not null,

  teto_anterior_evento       int,
  teto_anterior_participante int,
  teto_novo_evento           int not null,
  teto_novo_participante     int not null,

  -- Quanto já havia sido gasto no momento da liberação: sem isso não se sabe
  -- se a liberação foi para destravar 2 participantes ou para dobrar o gasto.
  usado_no_momento int,

  liberado_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_orcamento_liberacoes drop constraint if exists jobs_orcamento_liberacoes_motivo_check;
  alter table public.jobs_orcamento_liberacoes add constraint jobs_orcamento_liberacoes_motivo_check
    check (length(btrim(motivo)) >= 10 and length(btrim(liberado_por)) >= 3);
end
$$;

create index if not exists jobs_orcamento_liberacoes_evento_idx
  on public.jobs_orcamento_liberacoes (event_id, liberado_em desc);

comment on table public.jobs_orcamento_liberacoes is
  'Trilha de auditoria das liberações excepcionais de orçamento: quem, quando, por que, teto anterior e novo. APPEND-ONLY.';

-- ---------------------------------------------------------------------------
-- RLS e privilégios -- mesma ordem da 014/018/019
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA: privilégio de coluna não subtrai de privilégio de tabela, e o
-- Supabase concede a tabela inteira a anon e authenticated por padrão.
do $$
declare t text;
begin
  foreach t in array array[
    'jobs_consumo_externo', 'jobs_orcamento_evento', 'jobs_orcamento_liberacoes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    -- O admin LÊ (é o painel de custo e a trilha de auditoria) e não escreve:
    -- escrever o livro-razão ou o teto pelo navegador tiraria o sentido dos dois.
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end
$$;

-- service_role: INSERT sempre; UPDATE só onde faz sentido (o teto em vigor);
-- DELETE em NENHUMA das três. Sem DELETE concedido, o worker não apaga linha
-- avulsa nem por engano -- e a cascata de `events` continua passando, porque
-- ação referencial não usa o privilégio do papel chamador.
--
-- O REVOKE explícito para service_role é obrigatório e foi outro erro meu,
-- medido: a imagem do Supabase já concede a tabela inteira a service_role por
-- DEFAULT PRIVILEGES em tabela nova do schema public. Sem revogar, service_role
-- APAGAVA o livro-razão (testei: apagou), e o "append-only" existiria só no
-- comentário. É a mesma lição da 014: privilégio de coluna não subtrai de
-- privilégio de tabela, e o que a plataforma concede por padrão precisa ser
-- removido explicitamente antes de reconceder o que se quer.
revoke all on table public.jobs_consumo_externo from service_role;
revoke all on table public.jobs_orcamento_liberacoes from service_role;
revoke all on table public.jobs_orcamento_evento from service_role;

grant select, insert on table public.jobs_consumo_externo to service_role;
grant select, insert on table public.jobs_orcamento_liberacoes to service_role;
grant select, insert, update on table public.jobs_orcamento_evento to service_role;

drop policy if exists "jobs_consumo_externo_admin_read" on public.jobs_consumo_externo;
create policy "jobs_consumo_externo_admin_read" on public.jobs_consumo_externo
  for select using (public.is_admin());

drop policy if exists "jobs_orcamento_evento_admin_read" on public.jobs_orcamento_evento;
create policy "jobs_orcamento_evento_admin_read" on public.jobs_orcamento_evento
  for select using (public.is_admin());

drop policy if exists "jobs_orcamento_liberacoes_admin_read" on public.jobs_orcamento_liberacoes;
create policy "jobs_orcamento_liberacoes_admin_read" on public.jobs_orcamento_liberacoes
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- APPEND-ONLY: duas travas, e a divisão entre elas NÃO é arbitrária
-- ---------------------------------------------------------------------------
-- UPDATE -> gatilho. Dispara para QUALQUER papel, inclusive service_role e
--   superusuário, e não existe GUC que o desligue. Reescrever consumo gasto ou
--   adulterar uma trilha de auditoria não é operação legítima para ninguém.
--
-- DELETE -> PRIVILÉGIO, não gatilho. Aqui houve um erro meu, medido e
--   corrigido: a primeira versão desta migration bloqueava DELETE por gatilho
--   também, e isso QUEBRAVA `on delete cascade`. Apagar um evento (operação
--   real do admin, que `delete_event_cascade` faz) passou a falhar com
--   "A tabela jobs_consumo_externo é APPEND-ONLY". Uma tabela de auditoria que
--   impede apagar o evento auditado não protege nada: só trava o produto.
--
--   A ação referencial de cascata é executada pelo sistema com privilégio do
--   DONO da tabela referenciante, então ela PASSA mesmo sem DELETE concedido ao
--   papel da aplicação. Resultado: ninguém da aplicação apaga linha avulsa, e
--   apagar o evento continua funcionando -- levando consigo a auditoria daquele
--   evento, que é o comportamento correto (o evento deixou de existir).
--
--   Consequência declarada: o DONO da tabela (DBA, via psql) pode apagar. É o
--   mesmo que vale para qualquer tabela de auditoria num banco relacional;
--   quem tem o dono tem o banco.
create or replace function public.jobs_livro_razao_somente_insercao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'A tabela % é APPEND-ONLY: % recusado. O consumo já gasto e a trilha de auditoria não se reescrevem.',
    tg_table_name, tg_op
    using errcode = 'check_violation',
          hint = 'Para mudar um teto, use jobs_orcamento_liberar, que deixa rastro.';
end;
$$;

drop trigger if exists jobs_consumo_externo_append_only on public.jobs_consumo_externo;
create trigger jobs_consumo_externo_append_only
  before update on public.jobs_consumo_externo
  for each row execute function public.jobs_livro_razao_somente_insercao();

drop trigger if exists jobs_orcamento_liberacoes_append_only on public.jobs_orcamento_liberacoes;
create trigger jobs_orcamento_liberacoes_append_only
  before update on public.jobs_orcamento_liberacoes
  for each row execute function public.jobs_livro_razao_somente_insercao();

revoke all on function public.jobs_livro_razao_somente_insercao() from public;
revoke all on function public.jobs_livro_razao_somente_insercao() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- jobs_consumo_registrar: lança no livro-razão.
-- ---------------------------------------------------------------------------
-- Chamada pelo worker DEPOIS da tentativa, com o número de requisições que
-- foram efetivamente despachadas ao provedor. Devolve os totais já atualizados,
-- para o worker poder registrar no log quanto o evento já consumiu.
create or replace function public.jobs_consumo_registrar(
  p_kind           text,
  p_event_id       uuid,
  p_participant_id uuid,
  p_chamadas       int,
  p_abortada       boolean default false,
  p_motivo         text default null,
  p_job_id         uuid default null,
  p_run_token      uuid default null
)
returns table (tentativas_evento int, tentativas_participante int, requisicoes_evento bigint)
language plpgsql
set search_path = ''
as $$
begin
  insert into public.jobs_consumo_externo
    (kind, event_id, participant_id, job_id, run_token, chamadas, abortada, motivo)
  values
    (p_kind, p_event_id, p_participant_id, p_job_id, p_run_token,
     greatest(coalesce(p_chamadas, 0), 0), coalesce(p_abortada, false), p_motivo);

  return query
  select
    count(*) filter (where c.chamadas > 0)::int,
    count(*) filter (where c.chamadas > 0 and c.participant_id = p_participant_id)::int,
    coalesce(sum(c.chamadas), 0)::bigint
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_orcamento_verificar: o disjuntor. Chamada ANTES de gastar.
-- ---------------------------------------------------------------------------
-- Tetos efetivos = linha persistida do evento, se existir; senão os padrões que
-- o worker passa (que vêm da configuração). Assim o teto é persistente a partir
-- da primeira liberação, e antes disso não há número mágico escondido no banco.
--
-- Teto 0 em qualquer dos dois desliga AQUELE teto (e só ele).
create or replace function public.jobs_orcamento_verificar(
  p_kind                      text,
  p_event_id                  uuid,
  p_participant_id            uuid,
  p_teto_evento_padrao        int,
  p_teto_participante_padrao  int
)
returns table (
  permitido boolean,
  motivo text,
  teto_evento int,
  teto_participante int,
  tentativas_evento int,
  tentativas_participante int,
  requisicoes_evento bigint,
  teto_persistido boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_teto_evento int;
  v_teto_part   int;
  v_persistido  boolean := false;
  v_tent_ev     int;
  v_tent_part   int;
  v_req_ev      bigint;
begin
  select o.teto_evento, o.teto_participante, true
    into v_teto_evento, v_teto_part, v_persistido
  from public.jobs_orcamento_evento o
  where o.event_id = p_event_id and o.kind = p_kind;

  if not found then
    v_teto_evento := p_teto_evento_padrao;
    v_teto_part   := p_teto_participante_padrao;
    v_persistido  := false;
  end if;

  select
    count(*) filter (where c.chamadas > 0)::int,
    count(*) filter (where c.chamadas > 0 and c.participant_id = p_participant_id)::int,
    coalesce(sum(c.chamadas), 0)::bigint
    into v_tent_ev, v_tent_part, v_req_ev
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;

  -- Teto por PARTICIPANTE primeiro: é o mais específico, e saber que a pessoa
  -- já queimou as três tentativas dela é informação melhor que "o evento
  -- estourou" quando as duas coisas valem.
  if v_teto_part > 0 and v_tent_part >= v_teto_part then
    return query select false,
      format('participante já consumiu %s de %s tentativa(s) externa(s) permitidas', v_tent_part, v_teto_part),
      v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
    return;
  end if;

  if v_teto_evento > 0 and v_tent_ev >= v_teto_evento then
    return query select false,
      format('evento já consumiu %s de %s tentativa(s) externa(s) permitidas', v_tent_ev, v_teto_evento),
      v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
    return;
  end if;

  return query select true,
    format('dentro do orçamento: evento %s/%s, participante %s/%s', v_tent_ev, v_teto_evento, v_tent_part, v_teto_part),
    v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_orcamento_liberar: liberação excepcional AUDITADA.
-- ---------------------------------------------------------------------------
-- É a ÚNICA porta de alteração do teto. Exige quem e por quê (o CHECK da tabela
-- de auditoria recusa motivo curto e autor curto), grava a trilha ANTES de
-- mexer no teto, e devolve o id da liberação para quem chamou poder citá-lo.
--
-- Não existe função de "baixar teto sem rastro" nem de apagar liberação: o
-- gatilho append-only recusa UPDATE e DELETE na trilha, para qualquer papel.
create or replace function public.jobs_orcamento_liberar(
  p_event_id          uuid,
  p_teto_evento       int,
  p_teto_participante int,
  p_liberado_por      text,
  p_motivo            text,
  p_kind              text default 'prognostico'
)
returns table (liberacao_id uuid, teto_anterior_evento int, teto_novo_evento int, usado_no_momento int)
language plpgsql
set search_path = ''
as $$
declare
  v_ant_ev   int;
  v_ant_part int;
  v_usado    int;
  v_id       uuid;
begin
  if p_teto_evento is null or p_teto_participante is null then
    raise exception 'jobs_orcamento_liberar: os dois tetos são obrigatórios'
      using errcode = 'check_violation';
  end if;

  select o.teto_evento, o.teto_participante into v_ant_ev, v_ant_part
  from public.jobs_orcamento_evento o
  where o.event_id = p_event_id and o.kind = p_kind;

  select count(*) filter (where c.chamadas > 0)::int into v_usado
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;

  -- A trilha primeiro: se o UPDATE do teto falhar, não fica liberação sem
  -- rastro; e se a trilha falhar (motivo curto, autor vazio), o teto não muda.
  insert into public.jobs_orcamento_liberacoes
    (event_id, kind, liberado_por, motivo,
     teto_anterior_evento, teto_anterior_participante,
     teto_novo_evento, teto_novo_participante, usado_no_momento)
  values
    (p_event_id, p_kind, p_liberado_por, p_motivo,
     v_ant_ev, v_ant_part, p_teto_evento, p_teto_participante, v_usado)
  returning public.jobs_orcamento_liberacoes.id into v_id;

  insert into public.jobs_orcamento_evento (event_id, kind, teto_evento, teto_participante)
  values (p_event_id, p_kind, p_teto_evento, p_teto_participante)
  on conflict (event_id) do update
    set teto_evento = excluded.teto_evento,
        teto_participante = excluded.teto_participante,
        kind = excluded.kind,
        definido_em = now();

  return query select v_id, v_ant_ev, p_teto_evento, v_usado;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_consumo_resumo: medição por evento, para o painel e a recalibração.
-- ---------------------------------------------------------------------------
create or replace function public.jobs_consumo_resumo(
  p_event_id uuid,
  p_kind     text default 'prognostico'
)
returns table (
  tentativas_externas int,
  tentativas_abortadas int,
  tentativas_sem_conexao int,
  requisicoes_despachadas bigint,
  participantes_tocados int,
  participantes_no_teto int,
  primeira_em timestamptz,
  ultima_em timestamptz
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select * from public.jobs_consumo_externo c
    where c.event_id = p_event_id and c.kind = p_kind
  ), teto as (
    select coalesce((select o.teto_participante from public.jobs_orcamento_evento o
                      where o.event_id = p_event_id and o.kind = p_kind), 2147483647) as tp
  )
  select
    count(*) filter (where chamadas > 0)::int,
    count(*) filter (where chamadas > 0 and abortada)::int,
    -- Tentativa que nunca abriu conexão: existiu, não custou, não conta no teto.
    count(*) filter (where chamadas = 0)::int,
    coalesce(sum(chamadas), 0)::bigint,
    count(distinct participant_id) filter (where chamadas > 0)::int,
    (select count(*)::int from (
       select participant_id from base where chamadas > 0
       group by participant_id having count(*) >= (select tp from teto)
     ) x),
    min(registrado_em),
    max(registrado_em)
  from base;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.jobs_consumo_registrar(text,uuid,uuid,int,boolean,text,uuid,uuid)',
    'public.jobs_orcamento_verificar(text,uuid,uuid,int,int)',
    'public.jobs_orcamento_liberar(uuid,int,int,text,text,text)',
    'public.jobs_consumo_resumo(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. O número de requisições despachadas é observado NO WORKER (invólucro de
--    fetch). Se a função morrer entre o despacho e o lançamento no livro-razão,
--    aquele consumo não é contabilizado -- o livro subestima nesse caso. É o
--    mesmo limite da entrega "ao menos uma vez": não há commit atômico entre a
--    cobrança do provedor e o commit do Postgres. O lançamento acontece o mais
--    cedo possível depois da tentativa, para encurtar essa janela.
--
-- 2. O teto é verificado ANTES da tentativa, então é teto de INÍCIO, não de
--    término: duas vagas que verificam ao mesmo tempo podem ambas passar e
--    estourar o teto em até `JOBS_CONCURRENCY - 1` tentativas. Fechar isso
--    exigiria serializar a verificação com um advisory lock por evento, ao
--    custo de um lock no caminho de cada job. Com teto 100 e concorrência 3, o
--    erro máximo é de 2 tentativas (2%).
--
-- 3. `chamadas` conta REQUISIÇÕES, e os tetos contam TENTATIVAS (linhas com
--    chamadas > 0). O SDK da Anthropic tenta de novo por conta própria em falha
--    de rede, então `requisicoes_despachadas` pode ser maior que
--    `tentativas_externas`. Se o teto tiver de ser em requisições, é trocar
--    `count(*) filter (where chamadas > 0)` por `sum(chamadas)` em
--    `jobs_orcamento_verificar` -- decisão de produto, não de implementação.
--
-- 4. DELETE é barrado por privilégio (service_role não o tem), não por gatilho,
--    para não quebrar `on delete cascade` de `events`. O DONO da tabela ainda
--    pode apagar, como em qualquer tabela de auditoria. Apagar o evento apaga a
--    auditoria DELE junto -- correto, porque o evento deixou de existir.
--
-- 5. Sem linha em `jobs_orcamento_evento`, o teto efetivo é o PADRÃO que o
--    worker passa (configuração). Isso é deliberado: evita número mágico
--    escondido no banco antes de alguém decidir. A partir da primeira
--    liberação auditada, o teto daquele evento passa a ser persistente.
-- 022_importacao_externa.sql
-- A PONTE ENTRE A COLETA FORA DO APLICATIVO E AS RESPOSTAS CANONICAS.
--
-- NAO APLICAR sem autorizacao nominal, como a 011, a 014 e as demais da serie.
-- Nenhuma das migrations 010 a 022 esta aplicada em lugar nenhum.
--
-- POR QUE EXISTE
-- --------------
-- A coleta pre-evento do Marco Zero (sabado 24/10/2026, 50 jovens) comecou por
-- Google Forms, nao pelo aplicativo: o e-mail transacional e a implantacao nao
-- estao liberados. Sem esta ponte, o portao de processamento e a fila ficam
-- prontos e NENHUM questionario externo e elegivel para entrar nela.
--
-- O QUE ELA GUARDA, e por que cada coisa esta aqui
-- ------------------------------------------------
--   external_submissions        uma linha por submissao externa, com a
--                               PROVENIENCIA inteira (regra 4) e o payload cru.
--   external_response_items     o desfecho de CADA resposta, pergunta por
--                               pergunta, nos tres estados que nao se
--                               confundem: compativel, incompativel, ausente.
--                               E aqui que DADO INCOMPATIVEL existe como estado
--                               proprio, em vez de virar zero ou virar ausencia.
--   external_submission_events  historico append-only de atos do operador:
--                               importou, reconciliou, revogou. E o que torna a
--                               reconciliacao REVERSIVEL sem apagar o passado.
--
-- A REGRA CENTRAL, do responsavel tecnico: "Se uma palavra for alterada e a
-- correspondencia falhar, o processamento deve registrar DADO INCOMPATIVEL,
-- NUNCA pontuacao zero." Ja aconteceu neste projeto um instrumento situacional
-- inteiro ir de 73% de cobertura a ZERO porque a interface gravava o texto da
-- opcao e o motor so aceitava a letra. Ninguem viu, porque zero parece um
-- resultado. O check de `estado` em external_response_items e a coluna
-- `apto_para_pontuar` sao a forma de isso nao poder mais passar calado.
--
-- A IMPORTACAO NAO IMPERSONA O PARTICIPANTE (regra 5). Em nenhum lugar deste
-- arquivo:
--   - se escreve em auth.users, nem se cria sessao, nem se toca em credencial;
--   - se escreve `participants.user_id` (e a coluna que liga pessoa a login);
--   - se cria participante (regra 6: quem nao casa fica PENDENTE);
--   - se marca `participants.completed_at` (entrar na fila de IA e decisao de
--     outro portao, nao efeito colateral de um import).
-- Toda linha gravada carrega `origem = 'externo'` e `importado_por`: quem le a
-- resposta depois ve que ela foi importada por alguem, e por quem.
--
-- Idempotente: `create ... if not exists`, `add column if not exists`,
-- `create or replace`, e chave natural (event_id, formulario_id, submissao_id)
-- para reimportar o mesmo lote nao duplicar nada. Nenhum `delete`, nenhum
-- `drop table`: quiz_responses.stage_id tem FK sem ON DELETE e apagar etapa ja
-- quebrou este projeto uma vez.
--
-- DEPENDE DA 010 (quiz_stages.quiz_version e stage_number, events.quiz_version)
-- e da 012 (is_admin() que nao estoura sem claim).

-- ===========================================================================
-- 1. SUBMISSOES EXTERNAS: a proveniencia da regra 4
-- ===========================================================================
create table if not exists public.external_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  -- PROVENIENCIA: formulario de origem e identificador da submissao.
  formulario_id text not null,
  formulario_nome text,
  submissao_id text not null,

  -- PROVENIENCIA: versao das perguntas. `questionario_impressao` e o SHA-256 do
  -- manifesto canonico (lib/importacao/manifesto-questionario.ts). Guardado na
  -- linha, nao so conferido na hora: daqui a um mes a pergunta certa e "a que
  -- questionario esta pessoa respondeu?", e a resposta tem de estar escrita.
  quiz_version int not null,
  questionario_impressao text not null,

  -- O que a coleta entregou, como entregou. Dado coletado de uma pessoa nao se
  -- joga fora: se a correspondencia for corrigida amanha, e daqui que ela e
  -- refeita, sem pedir que 50 jovens respondam de novo.
  email_coletado text,
  email_verificado boolean not null default false,
  nome_declarado text,
  respostas_brutas jsonb not null,

  -- PROVENIENCIA: identidade reconciliada. `participant_id` NULO e um estado
  -- legitimo e esperado (pendente/conflito), nao um defeito.
  participant_id uuid references public.participants(id) on delete set null,
  identidade_via text,
  email_reconciliado text,

  -- O DESFECHO.
  estado text not null,
  apto_para_pontuar boolean not null default false,
  bloqueio jsonb,
  contagens jsonb,

  -- PROVENIENCIA: responsavel pela importacao. NOT NULL de proposito.
  importado_por uuid not null,
  importado_por_email text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

do $$
begin
  -- OS QUATRO ESTADOS, mais 'revogada'. Nao ha estado "ok" generico: cada
  -- recusa tem nome, e 'incompativel' NAO e 'importavel' com zero nem
  -- 'pendente'. Se faltar um nome aqui, a coisa certa e adicionar o nome, nunca
  -- reaproveitar um que diga outra coisa.
  alter table public.external_submissions
    drop constraint if exists external_submissions_estado_check;
  alter table public.external_submissions
    add constraint external_submissions_estado_check
    check (estado in ('importavel', 'incompativel', 'pendente', 'conflito', 'revogada'));

  -- Identidade resolvida EXIGE participante; nao resolvida NAO pode ter um.
  -- Sem isto, um bug de aplicacao poderia gravar "pendente" apontando para
  -- alguem -- ou "importavel" apontando para ninguem.
  alter table public.external_submissions
    drop constraint if exists external_submissions_identidade_check;
  alter table public.external_submissions
    add constraint external_submissions_identidade_check
    check (
      (estado in ('importavel', 'incompativel') and participant_id is not null)
      or (estado in ('pendente', 'conflito') and participant_id is null)
      or estado = 'revogada'
    );

  -- APTO SO QUANDO IMPORTAVEL. Esta e a trava que impede "pontuou zero":
  -- nenhuma submissao com dado incompativel, pendente ou em conflito pode
  -- aparecer como apta, nem por engano de aplicacao.
  alter table public.external_submissions
    drop constraint if exists external_submissions_aptidao_check;
  alter table public.external_submissions
    add constraint external_submissions_aptidao_check
    check (apto_para_pontuar = false or estado = 'importavel');

  -- Dado incompativel, pendente e conflito TEM de dizer por que.
  alter table public.external_submissions
    drop constraint if exists external_submissions_bloqueio_check;
  alter table public.external_submissions
    add constraint external_submissions_bloqueio_check
    check (
      estado = 'importavel'
      or estado = 'revogada'
      or (bloqueio is not null and bloqueio ? 'motivo')
    );

  -- A impressao digital e um SHA-256 hexadecimal, nao um texto livre.
  alter table public.external_submissions
    drop constraint if exists external_submissions_impressao_check;
  alter table public.external_submissions
    add constraint external_submissions_impressao_check
    check (questionario_impressao ~ '^[0-9a-f]{64}$');

  alter table public.external_submissions
    drop constraint if exists external_submissions_via_check;
  alter table public.external_submissions
    add constraint external_submissions_via_check
    check (identidade_via is null or identidade_via in ('email_verificado', 'decisao_do_operador'));
end $$;

-- A MESMA SUBMISSAO NAO ENTRA DUAS VEZES. Reimportar o mesmo lote atualiza as
-- linhas; nao cria copias nem some com nada.
create unique index if not exists external_submissions_natural_idx
  on public.external_submissions (event_id, formulario_id, submissao_id);

-- UM PARTICIPANTE, UMA SUBMISSAO ATIVA. Duas submissoes da mesma pessoa viram
-- CONFLITO explicito na aplicacao (lib/importacao/reconciliar-identidade.ts); se
-- algum caminho futuro tentar gravar as duas de qualquer forma, isto estoura em
-- vez de a segunda sobrescrever a primeira em silencio. 'revogada' sai do indice
-- de proposito: e assim que uma reconciliacao errada e desfeita e refeita.
create unique index if not exists external_submissions_participante_ativo_idx
  on public.external_submissions (event_id, participant_id)
  where participant_id is not null and estado in ('importavel', 'incompativel');

create index if not exists external_submissions_evento_idx
  on public.external_submissions (event_id, estado);

create index if not exists external_submissions_email_idx
  on public.external_submissions (event_id, lower(email_coletado));

comment on table public.external_submissions is
  'Uma submissao de coleta FORA do aplicativo (ex.: Google Forms), com proveniencia completa e o payload cru. participant_id nulo = identidade pendente ou em conflito, estado legitimo.';
comment on column public.external_submissions.questionario_impressao is
  'SHA-256 do manifesto canonico do questionario respondido. Conferido na importacao e GUARDADO, para que a pergunta "a que questionario esta pessoa respondeu?" tenha resposta escrita.';
comment on column public.external_submissions.apto_para_pontuar is
  'false sempre que houver DADO INCOMPATIVEL em pergunta pontuada, identidade nao resolvida, ou qualquer duvida. Pontuar sem consultar isto reproduz o acidente dos 73% que viraram zero.';

-- ===========================================================================
-- 2. ITENS: o desfecho de CADA resposta. Onde DADO INCOMPATIVEL mora.
-- ===========================================================================
create table if not exists public.external_response_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.external_submissions(id) on delete cascade,
  pergunta_id text not null,

  -- OS TRES ESTADOS. 'incompativel' NAO e 'ausente' e NAO e compativel com
  -- valor 0. Esta distincao e o produto deste arquivo.
  estado text not null,

  -- O valor que o motor consome. NULO quando incompativel ou ausente: nao
  -- existe valor canonico para resposta que nao casou, e inventar um
  -- (0, '', 'A') e exatamente o defeito que esta tabela existe para impedir.
  valor_canonico jsonb,
  -- O que a pessoa respondeu, intacto, inclusive (e principalmente) quando nao
  -- casou: e o que permite a um humano ver que "Organizar o problema e definir
  -- a PRIORIDADE" virou "... a URGENCIA".
  valor_bruto jsonb,

  causa text,
  motivo text,
  -- O motor de pontuacao consome esta pergunta? Incompativel em pergunta
  -- pontuada apaga instrumento; em pergunta aberta, nao.
  pontuada boolean not null default false,
  forma text,

  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_response_items
    drop constraint if exists external_response_items_estado_check;
  alter table public.external_response_items
    add constraint external_response_items_estado_check
    check (estado in ('compativel', 'incompativel', 'ausente'));

  -- COMPATIVEL EXIGE VALOR; INCOMPATIVEL E AUSENTE NAO PODEM TER VALOR
  -- CANONICO. E a trava de banco contra "pontuou zero": nao ha como gravar uma
  -- resposta que falhou a correspondencia carregando um valor pontuavel.
  alter table public.external_response_items
    drop constraint if exists external_response_items_valor_check;
  alter table public.external_response_items
    add constraint external_response_items_valor_check
    check (
      (estado = 'compativel' and valor_canonico is not null)
      or (estado in ('incompativel', 'ausente') and valor_canonico is null)
    );

  -- INCOMPATIVEL TEM DE DIZER POR QUE, e tem de mostrar o que chegou.
  alter table public.external_response_items
    drop constraint if exists external_response_items_motivo_check;
  alter table public.external_response_items
    add constraint external_response_items_motivo_check
    check (
      estado <> 'incompativel'
      or (causa is not null and motivo is not null and valor_bruto is not null)
    );

  alter table public.external_response_items
    drop constraint if exists external_response_items_causa_check;
  alter table public.external_response_items
    add constraint external_response_items_causa_check
    check (causa is null or causa in (
      'alternativa_desconhecida',
      'alternativa_fora_do_mapa',
      'fora_da_escala',
      'acima_do_limite_de_caracteres',
      'tipo_invalido',
      'pergunta_desconhecida'
    ));
end $$;

create unique index if not exists external_response_items_unico_idx
  on public.external_response_items (submission_id, pergunta_id);

create index if not exists external_response_items_incompativeis_idx
  on public.external_response_items (submission_id)
  where estado = 'incompativel';

comment on table public.external_response_items is
  'O desfecho de cada resposta externa, nos tres estados que nao se confundem: compativel (tem valor canonico), incompativel (respondeu e a correspondencia falhou -- NUNCA zero) e ausente (nao respondeu).';

-- ===========================================================================
-- 3. ATOS DO OPERADOR: append-only, e por isso REVERSIVEL
-- ===========================================================================
-- Regra 5: "Reconciliar identidade e um ato do operador, registrado e
-- reversivel, nao um efeito colateral de um import." Reversivel aqui NAO quer
-- dizer apagavel: desfazer e uma linha nova de 'revogada', e a linha anterior
-- continua la. Quem auditar ve a decisao, quem a tomou, e que ela foi desfeita.
create table if not exists public.external_submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.external_submissions(id) on delete cascade,
  acao text not null,
  operador uuid not null,
  operador_email text,
  justificativa text,
  detalhes jsonb,
  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_acao_check;
  alter table public.external_submission_events
    add constraint external_submission_events_acao_check
    check (acao in (
      'importada',              -- virou resposta canonica pontuavel
      'retida_incompativel',    -- gravada e MARCADA: dado incompativel
      'retida_pendente',        -- identidade nao casou: espera humano
      'retida_conflito',        -- mais de um candidato: espera humano
      'reconciliada_pelo_operador',
      'revogada'
    ));

  -- Ato de operador sem justificativa nao e ato registrado.
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_justificativa_check;
  alter table public.external_submission_events
    add constraint external_submission_events_justificativa_check
    check (
      acao not in ('reconciliada_pelo_operador', 'revogada')
      or (justificativa is not null and length(btrim(justificativa)) >= 3)
    );
end $$;

create index if not exists external_submission_events_submissao_idx
  on public.external_submission_events (submission_id, criado_em);

-- APPEND-ONLY DE VERDADE, nao por convencao: sem UPDATE e sem DELETE para
-- ninguem alem do dono da tabela. Historico que da para reescrever nao e
-- historico.
revoke update, delete on public.external_submission_events from anon, authenticated, service_role;

-- ===========================================================================
-- 4. PROVENIENCIA NA PROPRIA RESPOSTA CANONICA
-- ===========================================================================
-- Quem le `quiz_responses` tem de ver, na linha, que ela veio de fora e de onde.
-- `questions_snapshot` (coluna da 010) continua guardando as perguntas da etapa.
alter table public.quiz_responses
  add column if not exists origem text not null default 'app';

alter table public.quiz_responses
  add column if not exists external_submission_id uuid
    references public.external_submissions(id) on delete set null;

-- Resumo legivel da proveniencia, direto na linha: formulario, submissao,
-- impressao do questionario, operador, e as perguntas desta etapa que ficaram
-- INCOMPATIVEIS. Esta ultima parte e deliberada: a incompatibilidade viaja com
-- a resposta, em vez de morar so numa tabela que alguem pode esquecer de olhar.
alter table public.quiz_responses
  add column if not exists importacao jsonb;

do $$
begin
  alter table public.quiz_responses
    drop constraint if exists quiz_responses_origem_check;
  alter table public.quiz_responses
    add constraint quiz_responses_origem_check
    check (origem in ('app', 'externo'));

  -- Resposta externa EXIGE a submissao que a originou. Sem isso, "veio de fora"
  -- seria uma afirmacao sem lastro.
  alter table public.quiz_responses
    drop constraint if exists quiz_responses_proveniencia_check;
  alter table public.quiz_responses
    add constraint quiz_responses_proveniencia_check
    check (origem = 'app' or external_submission_id is not null);
end $$;

create index if not exists quiz_responses_origem_idx
  on public.quiz_responses (origem);

comment on column public.quiz_responses.origem is
  '''app'' = a pessoa respondeu nesta aplicacao. ''externo'' = importada de coleta fora do aplicativo, com external_submission_id e importacao preenchidos. A importacao nunca se passa pela pessoa.';

-- ===========================================================================
-- 5. A VISAO DE PROVENIENCIA: legivel DEPOIS, por quem nao estava aqui
-- ===========================================================================
create or replace view public.v_proveniencia_respostas_externas as
select
  qr.id                        as resposta_id,
  qr.participant_id,
  p.full_name                  as participante,
  p.email                      as participante_email,
  qr.stage_id,
  qs.stage_number,
  qs.title                     as etapa,
  qr.submitted_at,
  qr.origem,
  es.formulario_id,
  es.formulario_nome,
  es.submissao_id,
  es.quiz_version,
  es.questionario_impressao,
  es.email_coletado,
  es.email_verificado,
  es.email_reconciliado,
  es.identidade_via,
  es.estado                    as estado_da_submissao,
  es.apto_para_pontuar,
  es.bloqueio,
  es.importado_por,
  es.importado_por_email,
  es.criado_em                 as importado_em,
  (qr.importacao -> 'incompativeis') as perguntas_incompativeis,
  jsonb_build_object(
    'compativeis',  (select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'compativel'),
    'incompativeis',(select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'incompativel'),
    'ausentes',     (select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'ausente')
  ) as itens
from public.quiz_responses qr
join public.external_submissions es on es.id = qr.external_submission_id
join public.participants p          on p.id = qr.participant_id
left join public.quiz_stages qs     on qs.id = qr.stage_id
where qr.origem = 'externo';

comment on view public.v_proveniencia_respostas_externas is
  'De onde veio cada resposta importada: formulario, submissao, impressao digital do questionario, identidade reconciliada e como, responsavel pela importacao, e o que ficou incompativel.';

-- ===========================================================================
-- 6. O PORTAO DE PONTUACAO das respostas externas
-- ===========================================================================
-- `calcularMarcoZero` nao tem como distinguir, olhando so o mapa de respostas,
-- uma pergunta que ninguem respondeu de uma cuja alternativa foi reescrita: as
-- duas chegam ausentes. Esta visao e a distincao, por participante, e ela tem
-- TRES desfechos, nunca dois:
--   pode_pontuar       conferido e apto;
--   DADO_INCOMPATIVEL  conferido: respondeu e a correspondencia falhou;
--   IDENTIDADE_NAO_RESOLVIDA / APTIDAO_INDETERMINADA  nao deu para afirmar.
create or replace view public.v_aptidao_pontuacao_externa as
select
  es.event_id,
  es.participant_id,
  es.id            as submission_id,
  es.estado,
  es.apto_para_pontuar as pode_pontuar,
  case
    when es.apto_para_pontuar then null
    when es.estado = 'incompativel' then 'DADO_INCOMPATIVEL'
    when es.estado in ('pendente', 'conflito') then 'IDENTIDADE_NAO_RESOLVIDA'
    else 'APTIDAO_INDETERMINADA'
  end as codigo,
  es.bloqueio ->> 'motivo' as motivo,
  coalesce(es.bloqueio -> 'perguntas', '[]'::jsonb) as perguntas,
  (select jsonb_agg(jsonb_build_object(
            'pergunta_id', i.pergunta_id,
            'causa', i.causa,
            'motivo', i.motivo,
            'respondido', i.valor_bruto,
            'pontuada', i.pontuada) order by i.pergunta_id)
     from public.external_response_items i
    where i.submission_id = es.id and i.estado = 'incompativel') as incompativeis
from public.external_submissions es;

comment on view public.v_aptidao_pontuacao_externa is
  'Pode pontuar as respostas externas deste participante? Tres desfechos: apto, DADO_INCOMPATIVEL (respondeu e nao casou -- nunca zero), ou identidade/aptidao nao verificada.';

-- ===========================================================================
-- 7. A APLICACAO DO PLANO, numa transacao
-- ===========================================================================
-- Recebe o plano que `lib/importacao/planejar-importacao.ts` montou e grava.
-- NAO decide nada: toda decisao (manifesto, identidade, correspondencia) ja foi
-- tomada e testada em funcao pura. Aqui so se escreve -- e se RECUSA escrever o
-- que o plano nao autoriza.
--
-- SECURITY INVOKER de proposito: roda com o privilegio de quem chama, a RLS vale,
-- e isto NAO e um caminho para escrever onde quem chamou nao podia. Comparar com
-- is_admin(): as rotas administrativas passam por service_role.
--
-- O que ela se RECUSA a fazer, e estoura em vez de fazer:
--   - aplicar plano com ok <> true (um plano recusado nao escreve nada);
--   - aplicar sem operador;
--   - gravar quiz_responses de submissao sem participante;
--   - marcar apto_para_pontuar sem o plano ter dito que e importavel.
create or replace function public.importacao_externa_aplicar(plano jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_event_id uuid;
  v_operador uuid;
  v_operador_email text;
  v_impressao text;
  v_versao int;
  v_form_id text;
  v_form_nome text;
  s jsonb;
  e jsonb;
  it jsonb;
  v_sub_id uuid;
  v_estado text;
  v_participant uuid;
  v_apto boolean;
  v_acao text;
  v_gravadas int := 0;
  v_itens int := 0;
  v_resumo jsonb := '{}'::jsonb;
  v_por_estado jsonb := '{}'::jsonb;
begin
  if plano is null or coalesce((plano ->> 'ok')::boolean, false) is not true then
    raise exception
      'importacao_externa_aplicar: plano recusado ou ausente (codigo=%, motivo=%). Nada foi gravado.',
      coalesce(plano ->> 'codigo', 'PLANO_AUSENTE'),
      coalesce(plano ->> 'motivo', 'plano nao informado');
  end if;

  v_event_id := (plano ->> 'evento_id')::uuid;
  v_versao   := (plano ->> 'quiz_version')::int;
  v_impressao := plano ->> 'questionario_impressao';
  v_operador := nullif(plano -> 'operador' ->> 'id', '')::uuid;
  v_operador_email := plano -> 'operador' ->> 'email';
  v_form_id  := plano -> 'origem' ->> 'formulario_id';
  v_form_nome := plano -> 'origem' ->> 'formulario_nome';

  if v_operador is null then
    raise exception 'importacao_externa_aplicar: plano sem operador responsavel. Nada foi gravado.';
  end if;
  if v_form_id is null or btrim(v_form_id) = '' then
    raise exception 'importacao_externa_aplicar: plano sem formulario de origem. Nada foi gravado.';
  end if;
  if v_impressao is null or v_impressao !~ '^[0-9a-f]{64}$' then
    raise exception 'importacao_externa_aplicar: plano sem impressao digital valida do questionario. Nada foi gravado.';
  end if;

  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    v_estado := s ->> 'estado';
    v_participant := nullif(s ->> 'participant_id', '')::uuid;
    v_apto := coalesce((s ->> 'apto_para_pontuar')::boolean, false);

    -- Cinto e suspensorio: o check da tabela ja proibiria, mas a mensagem daqui
    -- diz qual submissao, e e ela que o operador vai ler.
    if v_apto and v_estado <> 'importavel' then
      raise exception
        'importacao_externa_aplicar: submissao % pede apto_para_pontuar com estado %. Recusado.',
        s ->> 'submissao_id', v_estado;
    end if;

    insert into public.external_submissions (
      event_id, formulario_id, formulario_nome, submissao_id,
      quiz_version, questionario_impressao,
      email_coletado, email_verificado, nome_declarado, respostas_brutas,
      participant_id, identidade_via, email_reconciliado,
      estado, apto_para_pontuar, bloqueio, contagens,
      importado_por, importado_por_email
    ) values (
      v_event_id, v_form_id, v_form_nome, s ->> 'submissao_id',
      v_versao, v_impressao,
      s -> 'coleta' ->> 'email',
      coalesce((s -> 'coleta' ->> 'email_verificado')::boolean, false),
      s -> 'coleta' ->> 'nome_declarado',
      coalesce(s -> 'coleta' -> 'respostas_brutas', '{}'::jsonb),
      v_participant,
      s -> 'proveniencia' ->> 'identidade_via',
      s -> 'proveniencia' ->> 'email_reconciliado',
      v_estado, v_apto,
      nullif(s -> 'bloqueio', 'null'::jsonb),
      nullif(s -> 'contagens', 'null'::jsonb),
      v_operador, v_operador_email
    )
    on conflict (event_id, formulario_id, submissao_id) do update set
      quiz_version = excluded.quiz_version,
      questionario_impressao = excluded.questionario_impressao,
      email_coletado = excluded.email_coletado,
      email_verificado = excluded.email_verificado,
      nome_declarado = excluded.nome_declarado,
      respostas_brutas = excluded.respostas_brutas,
      participant_id = excluded.participant_id,
      identidade_via = excluded.identidade_via,
      email_reconciliado = excluded.email_reconciliado,
      estado = excluded.estado,
      apto_para_pontuar = excluded.apto_para_pontuar,
      bloqueio = excluded.bloqueio,
      contagens = excluded.contagens,
      importado_por = excluded.importado_por,
      importado_por_email = excluded.importado_por_email,
      atualizado_em = now()
    returning id into v_sub_id;

    -- Os itens: o desfecho de cada resposta, inclusive (e principalmente) os
    -- incompativeis. Reimportacao substitui o conjunto da submissao, nunca
    -- mistura o antigo com o novo.
    delete from public.external_response_items where submission_id = v_sub_id;
    for it in select * from jsonb_array_elements(coalesce(s -> 'itens', '[]'::jsonb))
    loop
      insert into public.external_response_items (
        submission_id, pergunta_id, estado,
        valor_canonico, valor_bruto, causa, motivo, pontuada, forma
      ) values (
        v_sub_id,
        it ->> 'pergunta_id',
        it ->> 'estado',
        case when it ->> 'estado' = 'compativel' then it -> 'valor' else null end,
        nullif(it -> 'bruto', 'null'::jsonb),
        it ->> 'causa',
        it ->> 'motivo',
        coalesce((it ->> 'pontuada')::boolean, false),
        it ->> 'forma'
      );
      v_itens := v_itens + 1;
    end loop;

    -- As respostas canonicas. SO com participante reconciliado, e so com os
    -- valores COMPATIVEIS que o plano montou: nenhum zero, nenhum placeholder.
    if v_participant is not null and v_estado in ('importavel', 'incompativel') then
      for e in select * from jsonb_array_elements(coalesce(s -> 'etapas', '[]'::jsonb))
      loop
        insert into public.quiz_responses (
          participant_id, stage_id, answers, questions_snapshot,
          origem, external_submission_id, importacao
        ) values (
          v_participant,
          (e ->> 'stage_id')::int,
          e -> 'answers',
          (select qs.questions from public.quiz_stages qs where qs.id = (e ->> 'stage_id')::int),
          'externo',
          v_sub_id,
          jsonb_build_object(
            'formulario_id', v_form_id,
            'formulario_nome', v_form_nome,
            'submissao_id', s ->> 'submissao_id',
            'quiz_version', v_versao,
            'questionario_impressao', v_impressao,
            'identidade_via', s -> 'proveniencia' ->> 'identidade_via',
            'email_reconciliado', s -> 'proveniencia' ->> 'email_reconciliado',
            'importado_por', v_operador,
            'importado_por_email', v_operador_email,
            'apto_para_pontuar', v_apto,
            'incompativeis', coalesce(e -> 'incompativeis', '[]'::jsonb),
            'ausentes', coalesce(e -> 'ausentes', '[]'::jsonb)
          )
        )
        on conflict (participant_id, stage_id) do update set
          answers = excluded.answers,
          questions_snapshot = excluded.questions_snapshot,
          origem = excluded.origem,
          external_submission_id = excluded.external_submission_id,
          importacao = excluded.importacao,
          submitted_at = now();
        v_gravadas := v_gravadas + 1;
      end loop;
    end if;

    v_acao := case v_estado
      when 'importavel'   then 'importada'
      when 'incompativel' then 'retida_incompativel'
      when 'pendente'     then 'retida_pendente'
      when 'conflito'     then 'retida_conflito'
      else 'retida_pendente'
    end;
    insert into public.external_submission_events (
      submission_id, acao, operador, operador_email, justificativa, detalhes
    ) values (
      v_sub_id, v_acao, v_operador, v_operador_email,
      s -> 'bloqueio' ->> 'motivo',
      jsonb_build_object(
        'estado', v_estado,
        'contagens', s -> 'contagens',
        'etapas_gravadas', jsonb_array_length(coalesce(s -> 'etapas', '[]'::jsonb)),
        'questionario_impressao', v_impressao
      )
    );

    v_por_estado := jsonb_set(
      v_por_estado, array[v_estado],
      to_jsonb(coalesce((v_por_estado ->> v_estado)::int, 0) + 1), true
    );
  end loop;

  v_resumo := jsonb_build_object(
    'evento_id', v_event_id,
    'formulario_id', v_form_id,
    'questionario_impressao', v_impressao,
    'por_estado', v_por_estado,
    'linhas_de_resposta_gravadas', v_gravadas,
    'itens_registrados', v_itens,
    'importado_por', v_operador
  );
  return v_resumo;
end;
$$;

comment on function public.importacao_externa_aplicar(jsonb) is
  'Grava um plano de importacao externa numa transacao. Nao decide nada (isso e lib/importacao/*), e recusa plano sem ok, sem operador, sem origem ou sem impressao digital valida.';

-- ===========================================================================
-- 8. REVOGAR UMA RECONCILIACAO: reversivel, sem apagar o passado
-- ===========================================================================
-- Desfaz a ligacao entre submissao e participante. NAO apaga a submissao (o
-- payload cru fica) e NAO apaga o historico: grava uma linha 'revogada'. As
-- respostas canonicas que nasceram dela saem, porque afirmavam ser respostas
-- daquela pessoa e isso deixou de ser verdade.
create or replace function public.importacao_externa_revogar(
  p_submission_id uuid,
  p_operador uuid,
  p_justificativa text
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_antes jsonb;
  v_removidas int;
begin
  if p_operador is null then
    raise exception 'importacao_externa_revogar: revogacao exige operador responsavel.';
  end if;
  if p_justificativa is null or length(btrim(p_justificativa)) < 3 then
    raise exception 'importacao_externa_revogar: revogacao exige justificativa registrada.';
  end if;

  select jsonb_build_object(
           'estado', estado, 'participant_id', participant_id,
           'identidade_via', identidade_via, 'apto_para_pontuar', apto_para_pontuar)
    into v_antes
    from public.external_submissions where id = p_submission_id;

  if v_antes is null then
    raise exception 'importacao_externa_revogar: submissao % nao encontrada.', p_submission_id;
  end if;

  delete from public.quiz_responses where external_submission_id = p_submission_id;
  get diagnostics v_removidas = row_count;

  update public.external_submissions set
    estado = 'revogada',
    participant_id = null,
    identidade_via = null,
    apto_para_pontuar = false,
    bloqueio = jsonb_build_object(
      'motivo', 'reconciliacao REVOGADA pelo operador: ' || btrim(p_justificativa),
      'perguntas', '[]'::jsonb),
    atualizado_em = now()
  where id = p_submission_id;

  insert into public.external_submission_events (
    submission_id, acao, operador, justificativa, detalhes
  ) values (
    p_submission_id, 'revogada', p_operador, btrim(p_justificativa),
    jsonb_build_object('antes', v_antes, 'respostas_canonicas_removidas', v_removidas)
  );

  return jsonb_build_object(
    'submission_id', p_submission_id,
    'antes', v_antes,
    'respostas_canonicas_removidas', v_removidas
  );
end;
$$;

-- ===========================================================================
-- 9. RLS: as tres tabelas sao de administracao, nao do participante
-- ===========================================================================
-- Um participante nao le nem escreve nada disto: nao e dado dele operar, e o
-- payload cru de uma submissao contem o e-mail de outra pessoa. Mesmo desenho do
-- resto do projeto: policy de admin via is_admin() (migration 012), nada para
-- anon, nada para authenticated.
alter table public.external_submissions      enable row level security;
alter table public.external_response_items   enable row level security;
alter table public.external_submission_events enable row level security;

drop policy if exists external_submissions_admin on public.external_submissions;
create policy external_submissions_admin on public.external_submissions
  for all using (is_admin()) with check (is_admin());

drop policy if exists external_response_items_admin on public.external_response_items;
create policy external_response_items_admin on public.external_response_items
  for all using (is_admin()) with check (is_admin());

-- Historico: admin LE e INSERE; ninguem altera nem apaga (o revoke acima e a
-- ausencia de policy de update/delete).
drop policy if exists external_submission_events_admin_select on public.external_submission_events;
create policy external_submission_events_admin_select on public.external_submission_events
  for select using (is_admin());

drop policy if exists external_submission_events_admin_insert on public.external_submission_events;
create policy external_submission_events_admin_insert on public.external_submission_events
  for insert with check (is_admin());

revoke all on public.external_submissions      from anon, authenticated;
revoke all on public.external_response_items   from anon, authenticated;
revoke all on public.external_submission_events from anon, authenticated;
revoke all on public.v_proveniencia_respostas_externas from anon, authenticated;
revoke all on public.v_aptidao_pontuacao_externa       from anon, authenticated;
-- PROPOSTA DE MIGRATION (nome sugerido: 023_processamento_assincrono.sql).
--
-- ESTE ARQUIVO NAO ESTA EM supabase/migrations/ DE PROPOSITO: a gravacao la foi
-- negada a esta unidade (diretorio compartilhado, numeracao disputada por outras
-- unidades -- a 022 ja tinha dono quando isto foi escrito). Quem controla a serie
-- move este arquivo, escolhe o numero e decide quando aplicar. Ele foi validado
-- contra Postgres DESCARTAVEL (lib/erros/provas/), depois de TODAS as migrations
-- 001-022, e nao foi aplicado em lugar nenhum.
--
-- Enquanto nao for aplicada, o processamento de evento ASSINCRONO recusa com
-- ASYNC_PROCESSING_MISSING (a mensagem manda aplicar). O modo `live` nao depende
-- dela em nada.
--
-- DUAS EXIGENCIAS DO RESPONSAVEL TECNICO
-- ----------------------------------------
-- 1. "O banco deve fornecer a referencia temporal de autorizacao, evitando
--    diferencas entre o relogio do navegador, do servidor Next.js e do
--    PostgreSQL."
--    form_closes_at e um instante gravado pelo banco. Compara-lo com o relogio
--    de outro host (a funcao na Vercel) decidiria o inicio do processamento por
--    uma divergencia de relogio. `referencia_temporal_do_banco()` devolve o
--    relogio do PROPRIO Postgres, e `jobs_iniciar_assincrono` decide com ele.
--
-- 2. "O inicio do processamento precisa utilizar um conjunto consistente de
--    respostas ja confirmadas. Uma submissao valida sendo gravada no limite da
--    janela nao pode gerar um documento baseado numa fotografia desatualizada."
--
-- A CORRIDA, concretamente
-- ------------------------
-- A policy de INSERT/UPDATE de quiz_responses (010, REGRA 6) avalia
-- `now() <= form_closes_at + 15min`, e `now()` e o instante em que a TRANSACAO
-- COMECOU. Uma submissao legitima que comecou antes do limite pode, portanto,
-- COMMITAR depois dele. Se o inicio do processamento leu a lista de elegiveis
-- nesse intervalo, essa pessoa fica de fora da fila, ou -- pior -- entra com a
-- fotografia das respostas de antes do commit. Documento individual errado sobre
-- uma pessoa real e o pior desfecho possivel.
--
-- O MECANISMO, e por que ele e este
-- ---------------------------------
-- (a) O limite e fechado pelo relogio do banco: so se inicia com
--     clock_timestamp() >= form_closes_at + tolerancia.
-- (b) QUIESCENCIA: depois do limite nenhuma transacao NOVA consegue gravar
--     resposta pela policy (now() > limite). Logo, o unico risco e uma
--     transacao que comecou ANTES do limite e AINDA esta aberta. O inicio
--     consulta pg_stat_activity e RECUSA (snapshot_instavel) se existir qualquer
--     outra transacao de cliente aberta com xact_start <= limite. Recusar e o
--     default seguro: o host tenta de novo em instantes; nada e processado sobre
--     fotografia que nao se sabe completa.
--     Por que nao um lock: os escritores sao PostgREST/RLS e nao tomam lock do
--     evento; nao ha ponto em que um lock desta funcao os alcance sem mudar as
--     policies de outra unidade.
-- (c) FOTOGRAFIA UNICA: elegiveis e impressao digital (md5 de id, completed_at e
--     das respostas de cada elegivel) sao lidas numa UNICA instrucao SQL, logo
--     num unico snapshot.
-- (d) VALIDACAO NO FIM: depois de enfileirar, a impressao digital e recalculada.
--     Se mudou -- um commit caiu no meio, por qualquer caminho, inclusive
--     escritores que ignoram a policy (service_role, importacao) --, a funcao
--     LEVANTA EXCECAO e a transacao inteira desfaz: nenhum job fica criado. A
--     alternativa (seguir adiante) seria processar uma fotografia que nao se sabe
--     completa.
-- (e) `for update` na linha do evento serializa dois inicios simultaneos
--     (dois administradores clicando ao mesmo tempo).
--
-- SECURITY DEFINER, e por que: pelo PostgREST a funcao roda como `service_role`, que
-- NAO e membro de pg_read_all_stats; sem isso a quiescencia nao enxerga as outras
-- transacoes (pg_stat_activity esconde xact_start). A propria funcao detecta o caso e
-- falha FECHADA (observabilidade_indisponivel) -- foi assim que o problema apareceu na
-- prova de HTTP. Como definer ela roda como o dono da migration (que e membro). Os
-- nomes sao todos qualificados e search_path e vazio; so service_role executa.
--
-- O QUE ISTO NAO COBRE, declarado: um escritor que ignora a policy E comita
-- depois do fim desta funcao altera dados de quem ja esta na fila; o worker nao
-- compara a impressao digital na hora de gerar (lib/jobs e de outra unidade). A
-- impressao digital fica registrada (retorno e event_logs, pela rota) para
-- auditoria. Alem disso `participants.completed_at` e gravado por
-- /api/complete-quiz com o relogio do Node, depois do ultimo envio: quem
-- terminou dentro da tolerancia mas cuja conclusao so chega depois NAO entra
-- nesta rodada e entra ao reprocessar (jobs_enfileirar e idempotente).

create or replace function public.referencia_temporal_do_banco()
returns timestamptz
language sql
volatile
set search_path = ''
as $$ select clock_timestamp() $$;

-- Devolve jsonb. Recusas ESPERADAS voltam como { ok: false, motivo, ... } SEM
-- erro (nada foi escrito). Inconsistencia LEVANTA EXCECAO (para desfazer).
--   motivo: evento_inexistente | modo_nao_assincrono | janela_indeterminada |
--           coleta_aberta | snapshot_instavel | observabilidade_indisponivel |
--           sem_elegiveis
create or replace function public.jobs_iniciar_assincrono(
  p_event_id            uuid,
  p_kind                text default 'prognostico',
  p_max_attempts        int  default 3,
  p_tolerancia_segundos int  default 900,
  -- true = confere (a), (b) e (c) e DEVOLVE a fotografia sem enfileirar. Usado pela
  -- rota do lote antigo, que gera em processo e nao usa a fila.
  p_somente_verificar   boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_evento      record;
  v_agora       timestamptz := clock_timestamp();
  v_limite      timestamptz;
  v_abertas     int;
  v_mais_antiga timestamptz;
  v_ids         uuid[];
  v_digest_ini  text;
  v_digest_fim  text;
  v_total       int;
  v_criados     int := 0;
  v_reaprov     int := 0;
  v_id          uuid;
  v_linha       record;
begin
  select e.id, e.mode, e.form_opens_at, e.form_closes_at
    into v_evento
    from public.events e
   where e.id = p_event_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'evento_inexistente');
  end if;
  if v_evento.mode is distinct from 'async' then
    return jsonb_build_object('ok', false, 'motivo', 'modo_nao_assincrono', 'modo', v_evento.mode);
  end if;
  if v_evento.form_closes_at is null
     or (v_evento.form_opens_at is not null and v_evento.form_opens_at > v_evento.form_closes_at) then
    return jsonb_build_object('ok', false, 'motivo', 'janela_indeterminada');
  end if;

  -- (a) O limite, pelo relogio do banco.
  v_limite := v_evento.form_closes_at + make_interval(secs => p_tolerancia_segundos);
  if v_agora < v_limite then
    return jsonb_build_object(
      'ok', false, 'motivo', 'coleta_aberta',
      'agora', v_agora, 'encerra_em', v_evento.form_closes_at, 'limite', v_limite);
  end if;

  -- (b) Quiescencia. Sem poder OBSERVAR as outras transacoes, nao se afirma
  -- nada: pg_stat_activity esconde xact_start de outros usuarios de quem nao
  -- tem pg_read_all_stats, e um "nenhuma transacao aberta" falso seria o pior
  -- resultado possivel. Falha fechada.
  if not (pg_has_role(current_user, 'pg_read_all_stats', 'member')
          or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user)) then
    return jsonb_build_object('ok', false, 'motivo', 'observabilidade_indisponivel');
  end if;

  select count(*), min(a.xact_start)
    into v_abertas, v_mais_antiga
    from pg_catalog.pg_stat_activity a
   where a.datname = current_database()
     and a.pid <> pg_backend_pid()
     and a.backend_type = 'client backend'
     and a.xact_start is not null
     and a.xact_start <= v_limite;

  if v_abertas > 0 then
    return jsonb_build_object(
      'ok', false, 'motivo', 'snapshot_instavel',
      'transacoes_abertas', v_abertas, 'mais_antiga', v_mais_antiga,
      'agora', v_agora, 'limite', v_limite);
  end if;

  -- (c) Fotografia unica: elegiveis + impressao digital numa so instrucao.
  with elegiveis as (
    select p.id,
           p.id::text || ':' || coalesce(p.completed_at::text, '') || ':' ||
           coalesce((select md5(string_agg(r.stage_id::text || '=' || r.answers::text, ',' order by r.stage_id))
                       from public.quiz_responses r
                      where r.participant_id = p.id), '') as parte
      from public.participants p
     where p.event_id = p_event_id and p.completed_at is not null
  )
  select array_agg(id order by id),
         md5(coalesce(string_agg(parte, '|' order by id), '')),
         count(*)
    into v_ids, v_digest_ini, v_total
    from elegiveis;

  if v_total = 0 or v_ids is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_elegiveis');
  end if;

  if p_somente_verificar then
    return jsonb_build_object(
      'ok', true, 'total', v_total, 'criados', 0, 'reaproveitados', 0,
      'digest', v_digest_ini, 'agora', v_agora, 'limite', v_limite, 'ids', to_jsonb(v_ids));
  end if;

  -- Enfileira EXATAMENTE o conjunto fotografado.
  foreach v_id in array v_ids loop
    select * into v_linha from public.jobs_enfileirar(p_kind, p_event_id, v_id, 0, p_max_attempts);
    if v_linha.criado then v_criados := v_criados + 1; else v_reaprov := v_reaprov + 1; end if;
  end loop;

  -- (d) Validacao no fim: a mesma fotografia, recalculada.
  with elegiveis as (
    select p.id,
           p.id::text || ':' || coalesce(p.completed_at::text, '') || ':' ||
           coalesce((select md5(string_agg(r.stage_id::text || '=' || r.answers::text, ',' order by r.stage_id))
                       from public.quiz_responses r
                      where r.participant_id = p.id), '') as parte
      from public.participants p
     where p.event_id = p_event_id and p.completed_at is not null
  )
  select md5(coalesce(string_agg(parte, '|' order by id), ''))
    into v_digest_fim
    from elegiveis;

  if v_digest_fim is distinct from v_digest_ini then
    raise exception 'SNAPSHOT_INSTAVEL: o conjunto de respostas confirmadas mudou durante o inicio do processamento (evento %)', p_event_id
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'total', v_total, 'criados', v_criados, 'reaproveitados', v_reaprov,
    'digest', v_digest_ini, 'agora', v_agora, 'limite', v_limite);
end;
$$;

-- Privilegios: como as funcoes da 018, so service_role executa.
do $$
declare f text;
begin
  foreach f in array array[
    'public.referencia_temporal_do_banco()',
    'public.jobs_iniciar_assincrono(uuid, text, int, int, boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
