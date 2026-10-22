-- Cenário 0 -- autoteste do harness: prova que a suíte não dá falso verde.
-- Cada verificação aqui é sobre o PRÓPRIO mecanismo de classificação, não sobre o banco.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

-- Tabela descartável só do autoteste (RLS ligado, nenhuma policy, uma linha): assim o autoteste
-- não depende das policies reais, e uma regressão de verdade não o faz falhar por engano.
create table public.zz_autoteste (id int);
alter table public.zz_autoteste enable row level security;
insert into public.zz_autoteste values (1);

-- Roda uma negação e confere se (ok, trecho do veredito) é o esperado.
create function pg_temp.autoteste(p_titulo text, p_ok_esperado boolean, p_trecho text,
                                  p_titulo_sonda text, p_papel text, p_claims text, p_sql text, p_ctrl text default null)
returns void language plpgsql as $$
declare a record;
begin
  select * into a from pg_temp.avaliar_negacao(p_titulo_sonda, p_papel, p_papel, p_claims, p_sql, p_ctrl);
  perform pg_temp.afirmar(0, p_titulo, 'harness',
    a.ok = p_ok_esperado and a.linha like '%' || p_trecho || '%',
    format('ok=%s e veredito contendo "%s"', p_ok_esperado, p_trecho),
    format('ok=%s | %s', a.ok, substr(regexp_replace(a.linha, '^\[[^]]*\] ', ''), 1, 150)));
end $$;

select pg_temp.autoteste('erro de sintaxe é INCONCLUSIVO, nunca "negado"', false, 'INCONCLUSIVO',
  'sonda quebrada', 'anon', pg_temp.cl_anon(),
  'selec * frm public.zz_autoteste', 'select * from public.zz_autoteste');

select pg_temp.autoteste('erro 42703 (coluna inexistente) é INCONCLUSIVO', false, 'INCONCLUSIVO',
  'coluna inexistente', 'anon', pg_temp.cl_anon(),
  'select coluna_que_nao_existe from public.zz_autoteste', 'select * from public.zz_autoteste');

select pg_temp.autoteste('controle sem linhas invalida a sonda ("0 linhas" não prova nada)', false, 'CONTROLE INVÁLIDO',
  'where que não casa', 'anon', pg_temp.cl_anon(),
  'select * from public.zz_autoteste where false');

select pg_temp.autoteste('negativa real de RLS (anon lendo tabela com RLS e sem policy) é reconhecida', true, 'NEGADO',
  'select', 'anon', pg_temp.cl_anon(),
  'select * from public.zz_autoteste');

select pg_temp.autoteste('acesso que deveria ser barrado mas passa é reprovado como PERMITIDO', false, 'PERMITIDO',
  'select', 'service_role', pg_temp.cl_service(),
  'select * from public.zz_autoteste');

-- Um erro dentro de uma sonda não aborta a transação: a sonda seguinte ainda roda.
select * from pg_temp.tentar('anon', pg_temp.cl_anon(), 'selec 1') \gset erro_
select * from pg_temp.tentar('anon', pg_temp.cl_anon(), 'select 1') \gset depois_
select pg_temp.afirmar(0, 'após erro de sintaxe a transação segue utilizável (sem "current transaction is aborted")', 'harness',
  :'erro_estado' = 'ERRO' and :'depois_estado' = 'OK',
  'sonda ruim = ERRO e sonda seguinte = OK',
  format('sonda ruim = %s (%s) e sonda seguinte = %s', :'erro_estado', :'erro_cod', :'depois_estado'));

\o
select linha from relatorio order by ordem;
rollback;
