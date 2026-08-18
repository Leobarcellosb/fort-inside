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
