-- Cenário 6 -- participante legítimo completando o fluxo. Endurecer não pode quebrar o produto.
-- Papel: authenticated (participante A, SEM app_metadata admin), evento ao vivo com etapa
-- liberada = 2. Esperado: ler as próprias respostas, inserir etapa liberada, reenviar (UPDATE).
-- Limite: NÃO insere etapa ainda não liberada pelo evento.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

select pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1') as claim_a \gset

-- Leitura
select pg_temp.permitir(6, 'ler as PRÓPRIAS respostas', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.quiz_responses where participant_id = '00000000-0000-4000-8000-0000000000a2'$q$, 1, false, 1);

select pg_temp.permitir(6, 'ler o PRÓPRIO cadastro', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.participants where user_id = '00000000-0000-4000-8000-0000000000a1'$q$, 1, false, 1);

select pg_temp.permitir(6, 'ler as etapas do quiz (quiz_stages)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.quiz_stages', 6);

-- Escrita dentro do que o evento liberou (etapa 2 <= current_stage 2)
select pg_temp.permitir(6, 'INSERT de resposta de etapa JÁ LIBERADA (etapa 2)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers) values ('00000000-0000-4000-8000-0000000000a2', 2, '{"q1":"resposta-etapa-2"}')$q$,
  1, true);

-- Reenvio de etapa já enviada (UPDATE)
select pg_temp.permitir(6, 'UPDATE de resposta já enviada = reenvio da etapa 1', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.quiz_responses set answers = '{"q1":"reenviado-por-A"}' where participant_id = '00000000-0000-4000-8000-0000000000a2' and stage_id = 1$q$,
  1, true);

select pg_temp.afirmar(6, 'o reenvio gravou de fato o novo conteúdo', 'postgres [verificação]',
  (select answers->>'q1' from public.quiz_responses where participant_id = '00000000-0000-4000-8000-0000000000a2' and stage_id = 1) = 'reenviado-por-A',
  'answers.q1 = reenviado-por-A',
  'answers.q1 = ' || coalesce((select answers->>'q1' from public.quiz_responses where participant_id = '00000000-0000-4000-8000-0000000000a2' and stage_id = 1), 'NULL'));

-- É assim que o app grava: upsert (INSERT ... ON CONFLICT DO UPDATE). Etapa 2 já existe agora.
select pg_temp.permitir(6, 'UPSERT (INSERT ... ON CONFLICT DO UPDATE) de etapa liberada, como o app faz', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers)
     values ('00000000-0000-4000-8000-0000000000a2', 2, '{"q1":"upsert-etapa-2"}')
     on conflict (participant_id, stage_id) do update set answers = excluded.answers$q$,
  1, true);

-- O limite: etapa 3 > current_stage 2 ainda NÃO foi liberada pelo evento.
select pg_temp.negar(6, 'INSERT de resposta de etapa NÃO liberada (etapa 3, evento em 2)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers) values ('00000000-0000-4000-8000-0000000000a2', 3, '{"q1":"adiantado"}')$q$);

select pg_temp.negar(6, 'UPSERT de etapa NÃO liberada (etapa 3, evento em 2)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers)
     values ('00000000-0000-4000-8000-0000000000a2', 3, '{"q1":"adiantado"}')
     on conflict (participant_id, stage_id) do update set answers = excluded.answers$q$);

select pg_temp.negar(6, 'UPDATE que MOVE uma resposta para etapa NÃO liberada (etapa 1 -> 3)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.quiz_responses set stage_id = 3 where participant_id = '00000000-0000-4000-8000-0000000000a2' and stage_id = 1$q$);

-- A trava é o estado do evento, não um número fixo: o admin libera a etapa 3 e a mesma
-- escrita passa a funcionar.
update public.events set current_stage = 3 where id = '00000000-0000-4000-8000-0000000000e1';

select pg_temp.permitir(6, 'INSERT da etapa 3 DEPOIS que o evento liberou a etapa 3', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers) values ('00000000-0000-4000-8000-0000000000a2', 3, '{"q1":"agora-liberada"}')$q$,
  1, true);

-- Prognóstico próprio: só depois de entregue.
update public.events set current_stage = 2 where id = '00000000-0000-4000-8000-0000000000e1';

select pg_temp.negar(6, 'ler o PRÓPRIO prognóstico ainda PENDENTE', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.prognostics where participant_id = '00000000-0000-4000-8000-0000000000a2'$q$);

update public.prognostics set status = 'delivered' where participant_id = '00000000-0000-4000-8000-0000000000a2';

select pg_temp.permitir(6, 'ler o PRÓPRIO prognóstico depois de ENTREGUE', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.prognostics where participant_id = '00000000-0000-4000-8000-0000000000a2'$q$, 1, false, 1);

\o
select linha from relatorio order by ordem;
rollback;
