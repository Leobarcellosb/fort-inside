-- Cenário 2 -- escrita direta em nps_responses contornando a API (rate limit de /api/nps).
-- Papel: anon. Esperado: INSERT NEGADO. Regressão que isto pega: a policy
-- "Anyone can submit NPS" (INSERT para anon), criada à mão no dashboard e removida na 007.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

select pg_temp.negar(2, 'INSERT direto em nps_responses (policy "Anyone can submit NPS")', 'anon', 'anon', pg_temp.cl_anon(),
  $q$insert into public.nps_responses (full_name, nps_score, quality_rating) values ('Atacante', 10, 'bem')$q$);

select pg_temp.negar(2, 'SELECT em nps_responses', 'anon', 'anon', pg_temp.cl_anon(),
  'select * from public.nps_responses');

select pg_temp.negar(2, 'UPDATE em nps_responses', 'anon', 'anon', pg_temp.cl_anon(),
  $q$update public.nps_responses set nps_score = 0$q$);

select pg_temp.negar(2, 'DELETE em nps_responses', 'anon', 'anon', pg_temp.cl_anon(),
  'delete from public.nps_responses');

select pg_temp.negar(2, 'INSERT direto em nps_responses', 'authenticated (participante A, sem app_metadata admin)', 'authenticated',
  pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1'),
  $q$insert into public.nps_responses (full_name, nps_score, quality_rating) values ('Participante', 10, 'bem')$q$);

-- Estrutural: toda policy de nps_responses tem de depender de is_admin(). Pega a volta de uma
-- policy permissiva (OR'd com as demais) mesmo que ela ainda não tenha dado erro em nada.
select pg_temp.afirmar(2, 'toda policy de nps_responses exige is_admin()', 'catálogo (pg_policies)',
  not exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = 'nps_responses'
                 and coalesce(qual, '') not like '%is_admin()%' and coalesce(with_check, '') not like '%is_admin()%'),
  'nenhuma policy fora de is_admin()',
  coalesce((select string_agg('"' || policyname || '" (' || cmd || ' para ' || roles::text || ')', '; ')
              from pg_policies
             where schemaname = 'public' and tablename = 'nps_responses'
               and coalesce(qual, '') not like '%is_admin()%' and coalesce(with_check, '') not like '%is_admin()%'),
           'nenhuma policy fora de is_admin()'));

-- O caminho legítimo continua de pé: /api/nps grava com service_role (ignora RLS).
select pg_temp.permitir(2, 'INSERT em nps_responses pela rota legítima (/api/nps)', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$insert into public.nps_responses (full_name, nps_score, quality_rating) values ('Respondente legítimo', 8, 'parcialmente')$q$);

\o
select linha from relatorio order by ordem;
rollback;
