#!/usr/bin/env bash
# test-guard-drift.sh -- prova os três resultados do guard de drift (PASS, FAIL, BLOCKED)
# e que ele não escreve no alvo. Só usa bancos LOCAIS descartáveis (Docker); nunca toca
# em produção. Requer: docker, psql. Leva ~1-2 min (sobe 2 Postgres do Supabase).
#
# Bancos de teste:
#   REF  = construído das migrations (a "referência")
#   TGT  = construído das migrations também, depois alterado de propósito, caso a caso
#          (log_statement=all ligado, para auditar tudo o que o guard executa nele)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/guard-drift.sh"
REFDB="$HERE/drift/reference-db.sh"
SQLFILE="$HERE/drift/introspect.sql"

PASSED=0; FAILED=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-guard-drift.XXXXXX")"
REF_C=""; TGT_C=""

cleanup() {
  [ -n "$REF_C" ] && "$REFDB" down "$REF_C" >/dev/null 2>&1
  [ -n "$TGT_C" ] && "$REFDB" down "$TGT_C" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

ok()   { PASSED=$((PASSED + 1)); echo "  ok   - $*"; }
nok()  { FAILED=$((FAILED + 1)); echo "  FALHA - $*"; }
check() { # descrição, comando...
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else nok "$d"; fi
}

OUT=""; RC=0
run_guard() { OUT="$("$GUARD" "$@" 2>&1)"; RC=$?; }
show() { echo "$OUT" | sed 's/^/      | /'; echo "      | (exit code: $RC)"; }

tgt_sql()   { psql -X -q -v ON_ERROR_STOP=1 "$TGT" -c "$1" >/dev/null; }
tgt_super() { docker exec "$TGT_C" psql -U supabase_admin -d postgres -h 127.0.0.1 -Atq -c "$1" >/dev/null; }

command -v docker >/dev/null || { echo "docker ausente"; exit 2; }
command -v psql   >/dev/null || { echo "psql ausente";   exit 2; }

echo "== preparação: subindo referência e alvo locais a partir de supabase/migrations =="
line="$("$REFDB" up --name "fort-drift-test-ref-$$")"  || { echo "falha ao subir referência"; exit 2; }
REF_C="$(echo "$line" | cut -f1)"; REF="$(echo "$line" | cut -f2)"
line="$("$REFDB" up --name "fort-drift-test-tgt-$$" --log-all)" || { echo "falha ao subir alvo"; exit 2; }
TGT_C="$(echo "$line" | cut -f1)"; TGT="$(echo "$line" | cut -f2)"
echo "  referência: $REF_C ; alvo: $TGT_C"

# ----------------------------------------------------------------------------------------
echo
echo "== 0. o SQL de introspecção é somente leitura (checagem estática) =="
sql_code="$(sed -e 's/--.*$//' "$SQLFILE" | sed -E "s/'[^']*'//g")"
first_stmt="$(echo "$sql_code" | tr -s ' \n' ' ' | sed -E 's/^ +//' | cut -d';' -f1)"
[ "$first_stmt" = "begin read only" ] && ok "primeiro comando é BEGIN READ ONLY" || nok "primeiro comando: '$first_stmt'"
if echo "$sql_code" | grep -Eiw 'insert|update|delete|create|alter|drop|grant|revoke|truncate|copy|vacuum|call|do|lock|comment' >/dev/null; then
  nok "o SQL contém palavra de escrita/DDL"; echo "$sql_code" | grep -Eiwn 'insert|update|delete|create|alter|drop|grant|revoke|truncate|copy|vacuum|call|do|lock|comment' | head
else
  ok "nenhum INSERT/UPDATE/DELETE/DDL/GRANT/COPY no SQL"
fi
echo "$sql_code" | tr -s ' \n' ' ' | grep -Eiq 'rollback ?; *$' && ok "termina com ROLLBACK" || nok "não termina com ROLLBACK"

# ----------------------------------------------------------------------------------------
echo
echo "== 1. PASS: alvo idêntico à referência =="
# Estado do alvo ANTES: dump completo (schema + dados) e contadores de escrita do banco.
fingerprint() {
  local dump stats
  dump="$(docker exec "$TGT_C" pg_dump -U postgres -h 127.0.0.1 -d postgres --no-owner 2>/dev/null \
         | grep -v -e '^\\restrict ' -e '^\\unrestrict ' | md5)"
  sleep 2   # deixa o coletor de estatísticas assentar
  stats="$(docker exec "$TGT_C" psql -U postgres -h 127.0.0.1 -d postgres -Atc \
     "select tup_inserted || '/' || tup_updated || '/' || tup_deleted from pg_stat_database where datname = 'postgres'")"
  echo "dump_md5=$dump tuplas_ins/upd/del=$stats"
}
BEFORE_FP="$(fingerprint)"
LOG_BEFORE="$(docker logs "$TGT_C" 2>&1 | wc -l | tr -d ' ')"

run_guard --reference "$REF" --target "$TGT"; show
[ "$RC" -eq 0 ] && ok "exit code 0" || nok "exit code $RC (esperado 0)"
echo "$OUT" | grep -q '^GUARD-DRIFT: PASS$' && ok "resultado PASS" || nok "faltou GUARD-DRIFT: PASS"

# ----------------------------------------------------------------------------------------
echo
echo "== 2. o guard não escreveu no alvo =="
run_guard --reference "$REF" --target "$TGT" >/dev/null   # segunda execução, para reforçar
docker logs "$TGT_C" 2>&1 | tail -n +"$((LOG_BEFORE + 1))" >"$WORK/target.log"   # antes do fingerprint, que também consulta o alvo
AFTER_FP="$(fingerprint)"
echo "  antes : $BEFORE_FP"
echo "  depois: $AFTER_FP"
[ "$BEFORE_FP" = "$AFTER_FP" ] && ok "dump completo (schema+dados) e contadores de escrita idênticos antes/depois" \
                               || nok "estado do alvo mudou"

# Cada comando que o servidor logou ("statement: <texto>"): olha a 1ª palavra.
grep 'LOG:  statement:' "$WORK/target.log" \
  | sed -E 's/.*LOG:  statement: *//' | awk '{gsub(/;/, "", $1); print tolower($1)}' | sort | uniq -c >"$WORK/verbs"
echo "  comandos executados no alvo durante as duas execuções do guard (1ª palavra):"
sed 's/^/      /' "$WORK/verbs"
if [ ! -s "$WORK/verbs" ]; then
  nok "log do alvo vazio: não foi possível auditar"
elif awk '{ if ($2 !~ /^(begin|set|with|select|rollback)$/) bad=1 } END { exit bad }' "$WORK/verbs"; then
  ok "só BEGIN/SET/WITH-SELECT/ROLLBACK foram executados no alvo (nenhum INSERT/UPDATE/DELETE/DDL)"
else
  nok "o guard executou comando inesperado no alvo"
fi
grep -q 'begin read only' "$WORK/target.log" && ok "transação aberta como READ ONLY (visto no log do servidor)" || nok "sem BEGIN READ ONLY no log"

# ----------------------------------------------------------------------------------------
echo
echo "== 3. FAIL: policy de INSERT anônima plantada e não declarada =="
tgt_sql 'create policy "Anyone can submit NPS" on public.nps_responses for insert to anon with check (true)'
run_guard --reference "$REF" --target "$TGT"; show
[ "$RC" -eq 1 ] && ok "exit code 1 (diferente de 0 e do BLOCKED=2)" || nok "exit code $RC (esperado 1)"
echo "$OUT" | grep -q 'Anyone can submit NPS' && ok "a mensagem nomeia a policy" || nok "policy não nomeada"
echo "$OUT" | grep -q 'public.nps_responses' && ok "a mensagem nomeia a tabela" || nok "tabela não nomeada"
echo "$OUT" | grep -q '^GUARD-DRIFT: FAIL$' && ok "resultado FAIL" || nok "faltou GUARD-DRIFT: FAIL"
echo "$OUT" | grep -q 'CRITICO' && ok "classificada como crítica (anon)" || nok "não marcou como crítica"
tgt_sql 'drop policy "Anyone can submit NPS" on public.nps_responses'

echo
echo "== 4. FAIL: outros tipos de drift (cada um aplicado, detectado e revertido) =="
expect_fail() { # descrição, regex esperado na saída
  local d="$1" re="$2"
  run_guard --reference "$REF" --target "$TGT"
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -Eq "$re"; then ok "$d -> FAIL detectado"; else nok "$d (exit $RC)"; show; fi
}
tgt_sql 'create table public.leak_manual (id int)'
expect_fail "tabela criada à mão, sem RLS" 'CRITICO.*public\.leak_manual'
tgt_sql 'drop table public.leak_manual'

tgt_sql 'alter table public.participants disable row level security'
expect_fail "RLS desligado em public.participants" 'CRITICO.*TABELA ALTERADA: public\.participants'
tgt_sql 'alter table public.participants enable row level security'

tgt_sql 'alter policy participants_own_read on public.participants using (true)'
expect_fail "policy declarada alterada para USING (true)" 'POLICY ALTERADA: "participants_own_read" na tabela public\.participants'
tgt_sql 'alter policy participants_own_read on public.participants using ((user_id = auth.uid()) or public.is_admin())'

tgt_sql 'drop policy quiz_stages_public_read on public.quiz_stages'
expect_fail "policy declarada removida" 'POLICY DECLARADA AUSENTE NO ALVO: "quiz_stages_public_read"'
tgt_sql 'create policy quiz_stages_public_read on public.quiz_stages for select using (true)'

tgt_sql 'revoke select on public.events from authenticated'
expect_fail "grant declarado revogado" 'GRANT EM TABELA.*public\.events'
tgt_sql 'grant select on public.events to authenticated'

tgt_sql 'create or replace function public.is_admin() returns boolean language sql security definer as $$ select true $$'
expect_fail "corpo de is_admin() trocado por 'select true'" 'FUNCAO ALTERADA: public\.is_admin\(\)'
# restaura exatamente o corpo declarado em 002_rls.sql
tgt_sql "$(sed -n '/^create or replace function is_admin()/,/^\$\$;/p' "$HERE/../supabase/migrations/002_rls.sql")"

tgt_sql 'alter table public.nps_responses alter column ip_hash set default '"'"'x'"'"
expect_fail "default de coluna alterado" 'COLUNA ALTERADA: public\.nps_responses\.ip_hash'
tgt_sql 'alter table public.nps_responses alter column ip_hash drop default'

tgt_super 'alter role anon bypassrls'
expect_fail "papel anon com BYPASSRLS" 'CRITICO.*PAPEL ALTERADO: anon'
tgt_super 'alter role anon nobypassrls'

run_guard --reference "$REF" --target "$TGT"
[ "$RC" -eq 0 ] && ok "após reverter tudo, volta a PASS (sem falso positivo residual)" || { nok "não voltou a PASS"; show; }

# ----------------------------------------------------------------------------------------
echo
echo "== 5. BLOCKED: alvo inacessível ou inspeção incompleta =="
expect_blocked() { # descrição, regex opcional
  local d="$1" re="${2:-}"
  if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q '^GUARD-DRIFT: BLOCKED$' \
     && ! echo "$OUT" | grep -qiw 'PASS' && ! echo "$OUT" | grep -qi 'pass' \
     && { [ -z "$re" ] || echo "$OUT" | grep -Eiq "$re"; }; then
    ok "$d -> BLOCKED, exit 2, sem a palavra PASS"
  else
    nok "$d (exit $RC)"; show
  fi
}

run_guard --reference "$REF" --target "postgresql://postgres:segredo-que-nao-pode-vazar@127.0.0.1:1/postgres"; show
expect_blocked "porta fechada (host inacessível)" 'inacessível'
echo "$OUT" | grep -q 'segredo-que-nao-pode-vazar' && nok "a senha da URL vazou na saída" || ok "a senha da URL não aparece na saída"
[ "$RC" -ne 1 ] && ok "exit code distinto do FAIL (1)" || nok "BLOCKED saiu com o código do FAIL"

run_guard --reference "$REF" --target "postgresql://postgres:x@nao-existe.invalid:5432/postgres"
expect_blocked "host que não resolve" 'inacessível'

DRIFT_CONNECT_TIMEOUT=2 run_guard --reference "$REF" --target "postgresql://postgres:x@10.255.255.1:5432/postgres"
expect_blocked "host que não responde (timeout de conexão de 2s)" 'inacessível'

run_guard --reference "$REF" --target "${TGT/drift-local-only/senha-errada}"
expect_blocked "credencial recusada pelo servidor" 'inacessível'

tgt_super 'create database drift_vazio'
run_guard --reference "$REF" --target "${TGT%/postgres}/drift_vazio"
expect_blocked "banco acessível mas sem nenhuma tabela (inspeção sem conteúdo)" 'nenhuma tabela'

mkdir -p "$WORK/fakebin"
cat >"$WORK/fakebin/psql" <<'STUB'
#!/usr/bin/env bash
# psql falso: sai com sucesso mas entrega saída truncada (sem sentinela final)
printf 'rel\tpublic.events\tr\trls=true\tforce_rls=false\topts=\n'
printf 'meta\tserver_version_num\t170006\n'
exit 0
STUB
chmod +x "$WORK/fakebin/psql"
OUT="$(PATH="$WORK/fakebin:$PATH" "$GUARD" --reference "$REF" --target "$TGT" 2>&1)"; RC=$?
expect_blocked "psql sai com 0 mas a saída vem truncada" 'truncada'

run_guard
expect_blocked "alvo não informado" 'alvo não informado'

run_guard --reference "$REF" --target "mysql://x@y/z"
expect_blocked "URL que não é postgres" 'postgres'

run_guard --reference "$TGT" --target "$TGT"
expect_blocked "alvo e referência iguais (comparação vazia)" 'mesmo banco'

# ----------------------------------------------------------------------------------------
echo
echo "== 6. modo padrão: referência efêmera construída das migrations =="
before_n="$(docker ps -a --format '{{.Names}}' | grep -c '^fort-drift-' || true)"
run_guard --target "$TGT"; show
[ "$RC" -eq 0 ] && echo "$OUT" | grep -q '^GUARD-DRIFT: PASS$' && ok "sem --reference: constrói, compara e dá PASS" || nok "modo padrão falhou (exit $RC)"
after_n="$(docker ps -a --format '{{.Names}}' | grep -c '^fort-drift-' || true)"
[ "$before_n" = "$after_n" ] && ok "container efêmero da referência foi removido" || nok "sobrou container efêmero ($before_n -> $after_n)"

# ----------------------------------------------------------------------------------------
echo
echo "resumo: $PASSED ok, $FAILED falha(s)"
[ "$FAILED" -eq 0 ]
