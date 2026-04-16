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
