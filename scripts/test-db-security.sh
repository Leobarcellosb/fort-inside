#!/usr/bin/env bash
# test-db-security.sh -- suíte de regressão de segurança da CAMADA DE BANCO (RLS, grants e
# privilégio de função), rodando contra o Postgres LOCAL do Supabase (nunca produção).
#
# Cada cenário roda em uma transação com ROLLBACK: dá para rodar N vezes sem reset. Os papéis
# (anon / authenticated / service_role) e as claims de JWT são reproduzidos com
# `set local role` + `set local request.jwt.claims`, como o PostgREST faz por requisição.
#
# Exit code:  0 = todos os cenários passaram
#             1 = pelo menos uma verificação falhou (a saída nomeia cenário, papel e esperado)
#             2 = BLOCKED: ambiente inadequado (alvo não local, link remoto, banco sem schema,
#                 ALVO COMPARTILHADO). BLOCKED é "não consegui verificar em condições
#                 isoladas" -- categoria diferente de "reprovado", igual ao guard de drift.
#
# ISOLAMENTO DO ALVO (scripts/_db-security-isolamento.sh)
# Os cenários conferem massa CONTANDO LINHAS, então um escritor concorrente no mesmo banco
# produz vermelho sem que nada de segurança tenha quebrado -- já aconteceu, medido. A suíte
# agora RECUSA (BLOCKED) alvo compartilhado: trava exclusiva confirmada em pg_locks, massa
# exclusiva conferida antes de começar e sentinela remedindo a massa entre todos os cenários.
# A guarda nunca afrouxa asserção nenhuma: a saída é isolar o alvo, não relaxar a conta.
#
# Uso:  npm run db:security             (contenção local: trava exclusiva + sentinela)
#       npm run db:security:isolado     (banco descartável próprio, construído e destruído)
#       npm run db:security:isolamento:test  (autoteste da guarda de isolamento)
# Alvo: DB_SECURITY_URL (opcional; só aceita 127.0.0.1 / localhost / [::1]).
#       Padrão: postgresql://postgres:postgres@127.0.0.1:54732/postgres (supabase/config.toml)
#       DB_SECURITY_ALVO=descartavel  declara instância descartável e exclusiva; a suíte
#       CONFERE a declaração (toda tabela de negócio vazia) e recusa se for mentira.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIR="$HERE/db-security"
DEFAULT_URL="postgresql://postgres:postgres@127.0.0.1:54732/postgres"
URL="${DB_SECURITY_URL:-$DEFAULT_URL}"

# BLOCKED tem de ser inconfundível com reprovação: quem lê a saída precisa saber que a suíte
# NÃO disse "a segurança está ruim", disse "não consegui verificar em condições isoladas".
blocked() {
  echo "RESULTADO: BLOCKED -- $*" >&2
  echo "   BLOCKED não é PASS nem FAIL: nenhuma verificação de segurança foi reprovada aqui," >&2
  echo "   a suíte apenas não conseguiu verificar em condições isoladas." >&2
  echo "DB-SECURITY: BLOCKED -- $*" >&2
  exit 2
}

# ---------------------------------------------------------------- recusas de segurança
[ -f "$ROOT/supabase/.temp/project-ref" ] \
  && blocked "este checkout está linkado a um projeto remoto (supabase/.temp/project-ref). Remova o link; esta suíte só roda no banco local."

command -v psql >/dev/null 2>&1 || blocked "psql não encontrado no PATH."

case "$URL" in
  postgres://*|postgresql://*) ;;
  *) blocked "o alvo precisa ser uma URL postgres:// ou postgresql://." ;;
esac
# Parâmetros de URL (?host=..., ?hostaddr=..., ?service=...) poderiam redirecionar a conexão
# para fora do host que acabamos de validar.
case "$URL" in
  *host=*|*hostaddr=*|*service=*|*passfile=*) blocked "a URL não pode conter host=/hostaddr=/service=/passfile=." ;;
esac
HOSTPART="${URL#*://}"          # user:pass@host:porta/db
HOSTPART="${HOSTPART##*@}"      # host:porta/db   (a senha pode conter ':' e '@' codificado)
HOSTPART="${HOSTPART%%/*}"      # host:porta
case "$HOSTPART" in
  \[*\]*) HOST="${HOSTPART%%\]*}]" ;;
  *)      HOST="${HOSTPART%%:*}" ;;
esac
case "$HOST" in
  127.0.0.1|localhost|"[::1]") ;;
  *) blocked "o alvo não é local (host='$HOST'). Esta suíte só roda em 127.0.0.1/localhost/[::1]." ;;
esac
# Variáveis de ambiente do libpq não podem redirecionar a conexão.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGPASSFILE PGOPTIONS
# 15s, não 5: medido neste Mac com o Docker Desktop carregado, a PRIMEIRA conexão a um
# Postgres em container passa de 5s com frequência (1 em 5 tentativas), e o resultado era
# BLOCKED por "tempo limite" sem nada de errado com o alvo. Isso não afrouxa verificação
# nenhuma -- é só o tempo de abrir a conexão.
export PGCONNECT_TIMEOUT=15
# Marca TODAS as sessões desta execução. A guarda de isolamento usa isto para separar as
# conexões da própria suíte das de terceiros em pg_stat_activity.
export PGAPPNAME="db-security/$$"

PSQL=(psql -X -q -At -v ON_ERROR_STOP=1 "$URL")
psql_q() { psql -X -q -At -v ON_ERROR_STOP=1 "$URL" "$@"; }

# shellcheck source=scripts/_db-security-isolamento.sh
. "$HERE/_db-security-isolamento.sh" \
  || blocked "não consegui carregar a guarda de isolamento ($HERE/_db-security-isolamento.sh)."

echo "== suíte de segurança da camada de banco =="
echo "   cada cenário roda em transação com rollback"

# ---------------------------------------------------------------- o alvo tem o schema?
ISO_TMP="$(mktemp -d "${TMPDIR:-/tmp}/db-security.XXXXXX")" \
  || blocked "mktemp -d falhou: sem diretório de trabalho não há onde guardar o veredito da trava."
ERR="$ISO_TMP/psql.err"
: >"$ERR"
trap 'iso_trava_liberar; rm -rf "$ISO_TMP"' EXIT
probe="$(psql_q -c "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')
  union all select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in
    ('events','participants','quiz_responses','quiz_stages','prognostics','knowledge_base','nps_responses','participant_scores','participant_profiles')
  union all select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('delete_event_cascade','is_admin')" 2>"$ERR")" \
  || blocked "não consegui conectar em $HOST: $(head -1 "$ERR"). Suba o banco: npm run db:local:up"
set -- $probe
[ "${1:-0}" = 3 ] && [ "${2:-0}" = 9 ] && [ "${3:-0}" = 2 ] \
  || blocked "o banco local não tem o schema esperado (papéis=${1:-?}/3, relações=${2:-?}/9, funções=${3:-?}/2). Aplique as migrations: npm run db:local:reset"

# ---------------------------------------------------------------- isolamento do alvo
# Identidade medida, modo declarado, trava exclusiva confirmada, massa exclusiva conferida.
# Qualquer porta fechada aqui => BLOCKED (exit 2), nunca FAIL e nunca verde.
echo
echo "== isolamento do alvo =="
iso_porta_de_entrada

# ---------------------------------------------------------------- impressão digital do banco
# Contagens de linhas + policies + grants. Igual antes e depois = os cenários não vazaram nada.
fingerprint() {
  psql_q -c "
    select md5(
      coalesce((select string_agg(c.relname || '=' ||
                 (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text,
                 ',' order by n.nspname, c.relname)
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))), '')
      || '|' || coalesce((select string_agg(tablename || policyname || cmd || coalesce(qual,'') || coalesce(with_check,''), ',' order by tablename, policyname)
                            from pg_policies where schemaname = 'public'), '')
      || '|' || coalesce((select string_agg(c.relname || coalesce(c.relacl::text,'') || coalesce(c.reloptions::text,''), ',' order by c.relname)
                            from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v')), '')
      || '|' || coalesce((select string_agg(p.proname || coalesce(p.proacl::text,''), ',' order by p.proname)
                            from pg_proc p where p.pronamespace = 'public'::regnamespace), ''))" 2>/dev/null
}
FP_BEFORE="$(fingerprint)"
[ -n "$FP_BEFORE" ] || blocked "não consegui tirar a impressão digital do banco (permissão?)."

# ---------------------------------------------------------------- cenários
SCENARIOS=(
  "0|cenario-0-autoteste-harness.sql|autoteste do harness (a suíte não dá falso verde)"
  "1|cenario-1-knowledge-base-anon.sql|anônimo lê/altera a base de conhecimento (papel: anon)"
  "2|cenario-2-nps-escrita-direta.sql|escrita direta em nps_responses contornando a API (papel: anon)"
  "3|cenario-3-participante-recursos-admin.sql|participante acessa recursos administrativos (papel: authenticated sem admin)"
  "4|cenario-4-funcao-destrutiva.sql|chamada da função delete_event_cascade (anon/authenticated; camadas privilégio e corpo)"
  "5|cenario-5-participant-profiles.sql|leitura da view participant_profiles (papel: anon; security_invoker)"
  "6|cenario-6-participante-legitimo.sql|participante legítimo completa o fluxo (papel: authenticated; o produto não pode quebrar)"
)

TOTAL_OK=0; TOTAL_FAIL=0
FAILED_SCENARIOS=()
SUMMARY=()

for entry in "${SCENARIOS[@]}"; do
  IFS='|' read -r num file desc <<<"$entry"
  echo
  echo "== cenário $num: $desc =="
  out="$(cd "$DIR" && psql -X -q -At -v ON_ERROR_STOP=1 "$URL" -f "$file" 2>"$ERR")"
  rc=$?
  n_ok=0; n_fail=0
  if [ -n "$out" ]; then
    while IFS= read -r line; do
      echo "  $line"
      case "$line" in
        "[ok  ]"*)  n_ok=$((n_ok + 1)) ;;
        "[FALHA]"*) n_fail=$((n_fail + 1)) ;;
      esac
    done <<<"$out"
  fi
  if [ "$rc" -ne 0 ]; then
    n_fail=$((n_fail + 1))
    echo "  [FALHA] cenário $num: o script SQL não terminou (psql exit $rc): $(tr '\n' ' ' <"$ERR" | cut -c1-300)"
  elif [ $((n_ok + n_fail)) -eq 0 ]; then
    n_fail=1
    echo "  [FALHA] cenário $num: nenhuma verificação foi executada"
  fi
  TOTAL_OK=$((TOTAL_OK + n_ok)); TOTAL_FAIL=$((TOTAL_FAIL + n_fail))
  if [ "$n_fail" -eq 0 ]; then
    SUMMARY+=("  PASSOU  cenário $num ($n_ok verificações) -- $desc")
  else
    SUMMARY+=("  FALHOU  cenário $num ($n_fail falha(s), $n_ok ok) -- $desc")
    FAILED_SCENARIOS+=("$num")
  fi
  # Sentinela: a massa do alvo mudou desde o marco anterior? Terceiro escrevendo => BLOCKED
  # (sai aqui dentro); vestígio da própria suíte => FALHA e para, porque daí em diante o
  # alvo não está mais em estado conhecido e tudo o que vier é ruído.
  if ! iso_marco "depois do cenário $num"; then
    echo "  [FALHA] sentinela de isolamento: $ISO_MOTIVO"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    FAILED_SCENARIOS+=("vazamento")
    SUMMARY+=("  FALHOU  vazamento de fixture detectado depois do cenário $num (rollback não aconteceu)")
    break
  fi
done

# ---------------------------------------------------------------- repetibilidade
echo
echo "== repetibilidade: o banco ficou idêntico depois da suíte? =="
FP_AFTER="$(fingerprint)"
if [ "$FP_BEFORE" = "$FP_AFTER" ]; then
  echo "  [ok  ] contagens de linhas, policies, grants e funções idênticos antes/depois (impressão $FP_BEFORE)"
  TOTAL_OK=$((TOTAL_OK + 1))
else
  echo "  [FALHA] a suíte ALTEROU o banco (antes=$FP_BEFORE depois=$FP_AFTER): algum rollback não aconteceu"
  TOTAL_FAIL=$((TOTAL_FAIL + 1)); FAILED_SCENARIOS+=("repetibilidade")
  SUMMARY+=("  FALHOU  repetibilidade (o banco mudou)")
fi

# ---------------------------------------------------------------- resumo
echo
echo "== resumo =="
printf '%s\n' "${SUMMARY[@]}"
echo "  total: $TOTAL_OK ok, $TOTAL_FAIL falha(s)"
if [ "$TOTAL_FAIL" -eq 0 ]; then
  echo "DB-SECURITY: PASS"
  exit 0
fi
echo "DB-SECURITY: FAIL (cenários com falha: ${FAILED_SCENARIOS[*]})"
exit 1
