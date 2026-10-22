#!/usr/bin/env bash
# Consulta o catalogo do banco LOCAL: numero de tabelas, de policies RLS e quais tabelas
# tem RLS habilitado no schema public. Somente leitura.
source "$(dirname "$0")/_db-local-common.sh"
require_tools
command -v psql >/dev/null 2>&1 || die "psql nao encontrado."
URL="$(local_db_url)"

psql "$URL" -v ON_ERROR_STOP=1 <<'SQL'
\echo '== Tabelas no schema public'
select count(*) as tabelas
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p');

\echo '== Policies RLS no schema public'
select count(*) as policies from pg_catalog.pg_policies where schemaname = 'public';

\echo '== Tabelas do public: RLS habilitado? / numero de policies'
select c.relname as tabela, c.relrowsecurity as rls_habilitado,
       (select count(*) from pg_catalog.pg_policies p
         where p.schemaname = n.nspname and p.tablename = c.relname) as policies
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by c.relname;
SQL
