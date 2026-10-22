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
