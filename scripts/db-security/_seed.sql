-- _seed.sql -- massa de dados do cenário, inserida como postgres (que ignora RLS) DENTRO da
-- transação do cenário. Nada disto sobrevive ao rollback. IDs fixos e legíveis:
--   usuários : ...00a1 (participante A)  ...00b1 (participante B)  ...00ad (admin)
--              ...00c1 (usuário comum que se diz admin só em user_metadata)
--   evento   : ...00e1  (ao vivo, etapa liberada = 2)
--   particip.: ...00a2 (A)  ...00b2 (B)

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@seguranca.test', '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@seguranca.test', '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000ad', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@seguranca.test', '{"role":"admin"}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@seguranca.test', '{}', '{"role":"admin"}', now(), now());

insert into public.events (id, name, event_code, event_date, status, current_stage)
values ('00000000-0000-4000-8000-0000000000e1', 'Evento de teste de segurança', 'SEG-TESTE-E1', now(), 'live', 2);

insert into public.participants (id, event_id, user_id, full_name, email)
values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'Participante A', 'a@seguranca.test'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', 'Participante B', 'b@seguranca.test');

-- A já enviou a etapa 1; B enviou as etapas 1 e 2.
insert into public.quiz_responses (participant_id, stage_id, answers)
values
  ('00000000-0000-4000-8000-0000000000a2', 1, '{"q1":"original-de-A"}'),
  ('00000000-0000-4000-8000-0000000000b2', 1, '{"q1":"segredo-de-B"}'),
  ('00000000-0000-4000-8000-0000000000b2', 2, '{"q1":"segredo-de-B-2"}');

-- Prognóstico de A ainda pendente; o de B JÁ ENTREGUE (assim, se A não o lê, é por ser de
-- outra pessoa, e não porque o status esconde).
insert into public.prognostics (participant_id, raw_ai_output, status)
values
  ('00000000-0000-4000-8000-0000000000a2', '{"txt":"pendente-de-A"}', 'pending'),
  ('00000000-0000-4000-8000-0000000000b2', '{"txt":"entregue-de-B"}', 'delivered');

insert into public.participant_scores (participant_id, eixos)
values
  ('00000000-0000-4000-8000-0000000000a2', '{"visao":{"likert":3,"situacional":3}}'),
  ('00000000-0000-4000-8000-0000000000b2', '{"visao":{"likert":9,"situacional":9}}');

insert into public.event_logs (event_id, action) values ('00000000-0000-4000-8000-0000000000e1', 'seed-seguranca');
insert into public.knowledge_base (title, content) values ('Metodologia de teste', 'conteúdo restrito');
insert into public.nps_responses (full_name, nps_score, quality_rating) values ('Fulano de teste', 9, 'bem');
