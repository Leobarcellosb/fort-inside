-- Cenário 1 -- anônimo tentando ler ou alterar a base de conhecimento.
-- Papel: anon. Esperado: select, insert, update e delete em knowledge_base NEGADOS.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

select pg_temp.negar(1, 'SELECT em knowledge_base', 'anon', 'anon', pg_temp.cl_anon(),
  'select * from public.knowledge_base');

select pg_temp.negar(1, 'INSERT em knowledge_base', 'anon', 'anon', pg_temp.cl_anon(),
  $q$insert into public.knowledge_base (title, content) values ('invasor', 'conteúdo injetado')$q$);

select pg_temp.negar(1, 'UPDATE em knowledge_base', 'anon', 'anon', pg_temp.cl_anon(),
  $q$update public.knowledge_base set content = 'adulterado'$q$);

select pg_temp.negar(1, 'DELETE em knowledge_base', 'anon', 'anon', pg_temp.cl_anon(),
  'delete from public.knowledge_base');

-- Sem claim nenhum (sessão sem JWT): a is_admin() da 012 tem de recusar limpo, e não estourar
-- com erro de parse de JSON (um erro assim apareceria aqui como INCONCLUSIVO).
select pg_temp.negar(1, 'SELECT em knowledge_base SEM claim de JWT', 'anon (sem claims)', 'anon', '',
  'select * from public.knowledge_base');

\o
select linha from relatorio order by ordem;
rollback;
