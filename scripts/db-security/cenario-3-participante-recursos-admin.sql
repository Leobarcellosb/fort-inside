-- Cenário 3 -- participante tentando acessar recursos administrativos, no nível do banco.
-- Papel: authenticated, usuário comum (participante A) SEM app_metadata.role = 'admin'.
-- Esperado: NEGADO ler dados de OUTRO participante (B), escrever em events, escrever e ler
-- knowledge_base, ler nps_responses. Controles positivos provam que o corte é is_admin() e
-- que as policies não negam tudo.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

\set A '''00000000-0000-4000-8000-0000000000a1'''
select pg_temp.cl_user(:A::uuid) as claim_a,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000ad', 'admin') as claim_admin,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000c1', null, 'admin') as claim_user_meta
\gset

-- 3.1 dados de OUTRO participante (B). O prognóstico de B está 'delivered': se A não o lê, é por
-- ser de outra pessoa.
select pg_temp.negar(3, 'ler respostas de OUTRO participante (quiz_responses de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.quiz_responses where participant_id = '00000000-0000-4000-8000-0000000000b2'$q$);

select pg_temp.negar(3, 'ler prognóstico ENTREGUE de OUTRO participante (prognostics de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.prognostics where participant_id = '00000000-0000-4000-8000-0000000000b2'$q$);

select pg_temp.negar(3, 'ler pontuação de OUTRO participante (participant_scores de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.participant_scores where participant_id = '00000000-0000-4000-8000-0000000000b2'$q$);

select pg_temp.negar(3, 'ler o cadastro de OUTRO participante (participants de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.participants where id = '00000000-0000-4000-8000-0000000000b2'$q$);

select pg_temp.negar(3, 'alterar resposta de OUTRO participante (UPDATE em quiz_responses de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.quiz_responses set answers = '{"q1":"adulterado"}' where participant_id = '00000000-0000-4000-8000-0000000000b2'$q$);

select pg_temp.negar(3, 'gravar resposta EM NOME de outro participante (INSERT em quiz_responses de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.quiz_responses (participant_id, stage_id, answers) values ('00000000-0000-4000-8000-0000000000b2', 1, '{"q1":"forjado"}')$q$,
  -- controle: como service_role a mesma intenção sem conflito de unicidade (etapa 3 de B)
  $q$insert into public.quiz_responses (participant_id, stage_id, answers) values ('00000000-0000-4000-8000-0000000000b2', 3, '{"q1":"forjado"}')$q$);

select pg_temp.negar(3, 'apagar OUTRO participante (DELETE em participants de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$delete from public.participants where id = '00000000-0000-4000-8000-0000000000b2'$q$);

-- 3.2 events: leitura é pública por desenho (events_public_read), escrita é só admin.
select pg_temp.negar(3, 'INSERT em events', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.events (name, event_code, event_date) values ('Evento forjado', 'FORJADO-1', now())$q$);

select pg_temp.negar(3, 'UPDATE em events (liberar etapas por conta própria)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.events set current_stage = 6$q$);

select pg_temp.negar(3, 'DELETE em events', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'delete from public.events');

-- 3.3 knowledge_base
select pg_temp.negar(3, 'SELECT em knowledge_base', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.knowledge_base');

select pg_temp.negar(3, 'INSERT em knowledge_base', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.knowledge_base (title, content) values ('injeção', 'prompt malicioso')$q$);

select pg_temp.negar(3, 'UPDATE em knowledge_base', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.knowledge_base set content = 'adulterado'$q$);

select pg_temp.negar(3, 'DELETE em knowledge_base', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'delete from public.knowledge_base');

-- 3.4 NPS
select pg_temp.negar(3, 'SELECT em nps_responses', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.nps_responses');

-- 3.5 admin nunca vem de user_metadata (o usuário edita o próprio user_metadata).
select pg_temp.negar(3, 'UPDATE em events com user_metadata.role=admin (NÃO é admin)', 'authenticated (usuário com user_metadata.role=admin)', 'authenticated', :'claim_user_meta',
  $q$update public.events set current_stage = 6$q$);

select pg_temp.negar(3, 'SELECT em knowledge_base com user_metadata.role=admin (NÃO é admin)', 'authenticated (usuário com user_metadata.role=admin)', 'authenticated', :'claim_user_meta',
  'select * from public.knowledge_base');

-- 3.6 controles positivos: o corte é is_admin(), não "ninguém pode nada".
select pg_temp.permitir(3, 'UPDATE em events', 'authenticated (admin: app_metadata.role=admin)', 'authenticated', :'claim_admin',
  $q$update public.events set current_stage = 3$q$);

select pg_temp.permitir(3, 'INSERT em knowledge_base', 'authenticated (admin: app_metadata.role=admin)', 'authenticated', :'claim_admin',
  $q$insert into public.knowledge_base (title, content) values ('legítimo', 'conteúdo do admin')$q$);

select pg_temp.permitir(3, 'ler quiz_responses de QUALQUER participante', 'authenticated (admin: app_metadata.role=admin)', 'authenticated', :'claim_admin',
  'select * from public.quiz_responses', 3);

-- sem WHERE: a RLS é quem recorta. A tabela tem 3 linhas (1 de A, 2 de B); A tem de ver exatamente 1.
select pg_temp.permitir(3, 'ler quiz_responses sem filtro: só as PRÓPRIAS', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.quiz_responses', 1, false, 1);

\o
select linha from relatorio order by ordem;
rollback;
