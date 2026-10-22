-- Cenário 5 -- view participant_profiles.
-- Papel: anon. Esperado: leitura bloqueada, e a view com security_invoker = on (sem isso ela
-- lia por cima do RLS das tabelas de baixo). Duas camadas, testadas separadamente:
--   privilégio: anon sem SELECT na view (revogado na 011)
--   security_invoker: mesmo que um GRANT reabra o SELECT, o RLS de quem chama continua valendo
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

select pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1') as claim_a \gset

-- Estrutural
select pg_temp.afirmar(5, 'participant_profiles tem security_invoker = on', 'catálogo (pg_class.reloptions)',
  coalesce((select reloptions::text ~ 'security_invoker=(on|true)' from pg_class where oid = 'public.participant_profiles'::regclass), false),
  'reloptions contém security_invoker=on',
  'reloptions = ' || coalesce((select reloptions::text from pg_class where oid = 'public.participant_profiles'::regclass), 'NULL'));

select pg_temp.afirmar(5, 'anon NÃO tem SELECT em participant_profiles', 'anon [camada: privilégio]',
  not has_table_privilege('anon', 'public.participant_profiles', 'select'),
  'has_table_privilege(select) = false', 'has_table_privilege(select) = ' || has_table_privilege('anon', 'public.participant_profiles', 'select'));

-- Comportamental, camada de privilégio
select pg_temp.negar(5, 'SELECT em participant_profiles', 'anon [camada: privilégio]', 'anon', pg_temp.cl_anon(),
  'select * from public.participant_profiles');

-- Comportamental, camada security_invoker: um participante comum só enxerga a PRÓPRIA linha
-- (com a view rodando como dono ele enxergaria as duas).
select pg_temp.permitir(5, 'SELECT em participant_profiles sem filtro: só o PRÓPRIO perfil', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.participant_profiles', 1, false, 1);

select pg_temp.negar(5, 'SELECT do perfil de OUTRO participante (participant_profiles de B)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.participant_profiles where id = '00000000-0000-4000-8000-0000000000b2'$q$);

-- Pior caso: alguém reabre o GRANT para anon. Só o security_invoker segura (rollback no fim).
grant select on public.participant_profiles to anon;

select pg_temp.negar(5, 'SELECT em participant_profiles COM GRANT reaberto (GRANT simulado)', 'anon [camada: security_invoker + RLS]', 'anon', pg_temp.cl_anon(),
  'select * from public.participant_profiles');

\o
select linha from relatorio order by ordem;
rollback;
