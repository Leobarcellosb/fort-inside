-- introspect.sql -- inspeção SOMENTE LEITURA do schema de um banco Postgres.
--
-- Uso (feito por scripts/guard-drift.sh):
--   psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -v schemas=public -f introspect.sql <url>
--
-- Emite uma linha por objeto, campos separados por TAB, primeiro campo = categoria.
-- Duas execuções (referência e alvo) são comparadas linha a linha pelo guard.
-- A última linha é um sentinela "zz_end <n>" com a contagem de linhas: se ele
-- faltar ou não bater, a inspeção ficou incompleta e o guard devolve BLOCKED.
--
-- GARANTIA DE LEITURA: a transação abaixo é READ ONLY (o servidor recusa
-- qualquer escrita) e este arquivo só contém SELECT. O teste automático
-- (scripts/test-guard-drift.sh) verifica as duas coisas.
--
-- Escopo: tabelas, colunas, grants e funções nos schemas de :schemas (padrão
-- public); policies em TODOS os schemas que não são de sistema, porque uma
-- policy criada à mão em storage.objects é tão perigosa quanto em public.

begin read only;
set local statement_timeout = '60s';
-- search_path fixo: deixa pg_get_expr/format_type qualificarem tudo, então a
-- saída não depende da configuração da sessão (pooler, role, etc.).
set local search_path = pg_catalog;

with
scope as (
  select n.oid as nsp_oid, n.nspname
  from pg_namespace n
  where n.nspname = any (string_to_array(:'schemas', ','))
),
rels as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         c.relacl, c.relowner, c.reloptions, s.nspname,
         format('%I.%I', s.nspname, c.relname) as qname
  from pg_class c
  join scope s on s.nsp_oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
fns as (
  select p.oid, p.proacl, p.proowner, s.nspname,
         format('%I.%I(%s)', s.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid)) as sig,
         p.prokind, p.prosecdef, p.provolatile, p.proleakproof, p.proconfig,
         pg_get_function_result(p.oid) as result,
         (select l.lanname from pg_language l where l.oid = p.prolang) as lang,
         md5(coalesce(p.prosrc, '') || '|' || coalesce(p.probin, '')) as src_md5
  from pg_proc p
  join scope s on s.nsp_oid = p.pronamespace
  where not exists (   -- funções de extensões não são "nossas"
    select 1 from pg_depend d
    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  )
),
watched_roles as (
  select r.oid, r.rolname
  from pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
),
lines as (

  -- 1. tabelas/views/sequences e flag de RLS
  select concat_ws(E'\t', 'rel', qname, relkind::text,
                   'rls=' || relrowsecurity::text,
                   'force_rls=' || relforcerowsecurity::text,
                   'opts=' || coalesce(array_to_string(reloptions, ','), '')) as line
  from rels

  union all
  -- 2. colunas: nome, tipo, nullability, default, identity/generated
  select concat_ws(E'\t', 'col', r.qname, a.attname::text,
                   format_type(a.atttypid, a.atttypmod),
                   case when a.attnotnull then 'not null' else 'null' end,
                   'default=' || coalesce(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '\s+', ' ', 'g'), ''),
                   'identity=' || a.attidentity::text,
                   'generated=' || a.attgenerated::text)
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind in ('r', 'p', 'v', 'm', 'f')

  union all
  -- 3. policies (todos os schemas, exceto os de sistema)
  select concat_ws(E'\t', 'policy',
                   format('%I.%I', n.nspname, c.relname),
                   pol.polname::text,
                   case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                                   when 'w' then 'UPDATE' when 'd' then 'DELETE'
                                   else 'ALL' end,
                   case when pol.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
                   coalesce((select string_agg(case when x = 0 then 'PUBLIC'
                                                    else (select rolname from pg_roles where oid = x) end,
                                               ',' order by case when x = 0 then 'PUBLIC'
                                                    else (select rolname from pg_roles where oid = x) end)
                             from unnest(pol.polroles) as x), ''),
                   'using=' || coalesce(regexp_replace(pg_get_expr(pol.polqual, pol.polrelid), '\s+', ' ', 'g'), ''),
                   'check=' || coalesce(regexp_replace(pg_get_expr(pol.polwithcheck, pol.polrelid), '\s+', ' ', 'g'), ''))
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')

  union all
  -- 4. grants em tabelas/views/sequences (ACL padrão do dono quando relacl é nulo)
  select concat_ws(E'\t', 'grant', r.qname, r.relkind::text,
                   case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x.grantee) end,
                   x.privilege_type,
                   'grantable=' || x.is_grantable::text)
  from rels r
  cross join lateral aclexplode(coalesce(r.relacl,
        acldefault((case when r.relkind = 'S' then 's' else 'r' end)::"char", r.relowner))) as x

  union all
  -- 5. grants por coluna
  select concat_ws(E'\t', 'colgrant', r.qname, a.attname::text,
                   case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x.grantee) end,
                   x.privilege_type,
                   'grantable=' || x.is_grantable::text)
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  cross join lateral aclexplode(a.attacl) as x

  union all
  -- 6. funções: assinatura, retorno, linguagem, SECURITY DEFINER, config e hash do corpo
  select concat_ws(E'\t', 'fn', sig, prokind::text, 'returns=' || result, 'lang=' || lang,
                   'secdef=' || prosecdef::text, 'volatility=' || provolatile::text,
                   'leakproof=' || proleakproof::text,
                   'config=' || coalesce(array_to_string(proconfig, ','), ''),
                   'body_md5=' || src_md5)
  from fns

  union all
  -- 7. quem pode executar cada função (default do Postgres = PUBLIC)
  select concat_ws(E'\t', 'fngrant', f.sig,
                   case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x.grantee) end,
                   x.privilege_type,
                   'grantable=' || x.is_grantable::text)
  from fns f
  cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) as x

  union all
  -- 8. grants no próprio schema (USAGE/CREATE)
  select concat_ws(E'\t', 'nspgrant', s.nspname,
                   case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x.grantee) end,
                   x.privilege_type)
  from scope s
  join pg_namespace n on n.oid = s.nsp_oid
  cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) as x

  union all
  -- 9. default privileges (o que objetos FUTUROS herdam)
  select concat_ws(E'\t', 'defacl', coalesce(pg_get_userbyid(d.defaclrole), '?'),
                   coalesce((select nspname from pg_namespace where oid = d.defaclnamespace), '*'),
                   d.defaclobjtype::text,
                   case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_roles where oid = x.grantee) end,
                   x.privilege_type)
  from pg_default_acl d
  cross join lateral aclexplode(d.defaclacl) as x
  where d.defaclnamespace = 0
     or d.defaclnamespace in (select nsp_oid from scope)

  union all
  -- 10. atributos dos papéis expostos pelo PostgREST (BYPASSRLS/superuser em anon seria fatal)
  select concat_ws(E'\t', 'role', r.rolname,
                   'super=' || r.rolsuper::text, 'bypassrls=' || r.rolbypassrls::text,
                   'createrole=' || r.rolcreaterole::text, 'createdb=' || r.rolcreatedb::text,
                   'inherit=' || r.rolinherit::text, 'login=' || r.rolcanlogin::text)
  from pg_roles r
  where r.rolname in (select rolname from watched_roles)

  union all
  -- 11. membership: papel X herdando de papel Y (ex.: anon virando membro de algo poderoso)
  select concat_ws(E'\t', 'member', pg_get_userbyid(m.member), 'in', pg_get_userbyid(m.roleid))
  from pg_auth_members m
  where m.member in (select oid from watched_roles)
     or m.roleid in (select oid from watched_roles)

  union all
  -- 12. metadados (não entram no diff; servem para avisar de versão diferente)
  select concat_ws(E'\t', 'meta', 'server_version_num', current_setting('server_version_num'))
  union all
  select concat_ws(E'\t', 'meta', 'schemas', :'schemas')
),
-- quebra de linha dentro de um nome de objeto não pode forjar linhas na saída
clean as (
  select distinct replace(replace(line, chr(10), '\n'), chr(13), '\r') as line from lines
)
select line
from (
  select 0 as k, line from clean
  union all
  select 1, concat_ws(E'\t', 'zz_end', count(*)::text) from clean
) q
order by k, line collate "C";

rollback;
