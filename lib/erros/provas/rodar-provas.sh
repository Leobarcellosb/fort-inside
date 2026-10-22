#!/usr/bin/env bash
# Prova de HTTP real dos codigos de erro (lib/erros/provas/erros-http.test.ts), em
# stack DESCARTAVEL e PROPRIO -- nada toca o banco local compartilhado:
#
#   container Postgres (imagem do Supabase, migrations 001-022 + a proposta de
#   migration desta unidade)  ->  container PostgREST  ->  gateway de teste (falha
#   sob demanda + identidade simulada)  ->  app em modo de producao, de um CLONE
#   descartavel do checkout (sem .env.local)  +  canario no lugar da Anthropic.
#
# Containers e rede de nome proprio (erros-pg-/erros-rest-/erros-net-<id>) e removidos
# no fim; so remove o que ESTE script criou. Reaproveita, sem altera-lo, o harness de
# scripts/_seguranca-http-common.sh (clone, canario, chave falsa, sonda de ambiente).
#
# ERROS_MUTACAO (opcional) sabota o CLONE para provar que as negativas medem o que
# dizem: auth403 | migration | status500 | semmodo | abertalibera | modoadivinha |
# relogionode | semvalidacao | semquiescencia.
#
# O vitest roda com TZ=Asia/Tokyo de proposito: o texto do prazo tem de sair no fuso do
# EVENTO (America/Sao_Paulo), nao no do computador de quem acessa.
#
# Uso: bash lib/erros/provas/rodar-provas.sh        (precisa de docker; nao faz reset de nada)
source "$(dirname "$0")/../../../scripts/_seguranca-http-common.sh"

PRV_ID="$$-$RANDOM"
PRV_DB="erros-pg-$PRV_ID"; PRV_REST="erros-rest-$PRV_ID"; PRV_NET="erros-net-$PRV_ID"
PRV_SEGREDO="super-secret-jwt-token-with-at-least-32-characters-long"  # padrao PUBLICO do Supabase local, nao e credencial

prv_limpa() {
  docker rm -f "$PRV_REST" "$PRV_DB" >/dev/null 2>&1 || true
  docker network rm "$PRV_NET" >/dev/null 2>&1 || true
  seg_limpa
}
trap prv_limpa EXIT

command -v docker >/dev/null || seg_die "docker nao encontrado"
command -v psql >/dev/null || seg_die "psql nao encontrado"
[ -f "$SEG_ROOT/supabase/.temp/project-ref" ] && seg_die "checkout linkado a projeto remoto; recuse."

jwt() { # $1 = role ; $2 = sub (opcional) ; $3 = app_metadata json (opcional)
  node "$SEG_ROOT/lib/erros/provas/jwt.mjs" "$PRV_SEGREDO" "$1" "${2:-}" "${3:-}"
}

# ---- banco descartavel ---------------------------------------------------
PRV_SAIDA="$(bash "$SEG_ROOT/scripts/drift/reference-db.sh" up --name "$PRV_DB")" || seg_die "banco descartavel nao subiu"
PRV_DB_URL="$(printf '%s' "$PRV_SAIDA" | cut -f2)"
case "$PRV_DB_URL" in *@127.0.0.1:*) ;; *) seg_die "DB nao e local: $PRV_DB_URL" ;; esac
PRV_SQL="$SEG_ROOT/lib/erros/sql/processamento_assincrono.sql"
if [ -n "${ERROS_MUTACAO_SQL:-}" ]; then   # sabota uma COPIA da proposta, so neste banco descartavel
  PRV_SQL="$(mktemp -t erros-sql-mutado.XXXXXX)"
  python3 - "$SEG_ROOT/lib/erros/sql/processamento_assincrono.sql" "$PRV_SQL" "$ERROS_MUTACAO_SQL" <<'PY'
import sys
src, dst, m = sys.argv[1:4]
s = open(src).read()
alvo = {"abertalibera": "if v_agora < v_limite then", "semquiescencia": "if v_abertas > 0 then", "semvalidacao": "if v_digest_fim is distinct from v_digest_ini then"}[m]
assert alvo in s, m
open(dst, "w").write(s.replace(alvo, "if false then"))
PY
  echo "[mutacao-sql] $ERROS_MUTACAO_SQL aplicada a uma copia da proposta"
fi
psql -X -q -v ON_ERROR_STOP=1 -f "$PRV_SQL" "$PRV_DB_URL" >/dev/null \
  || seg_die "a proposta de migration nao aplicou no banco descartavel"
docker exec "$PRV_DB" psql -U supabase_admin -h 127.0.0.1 -d postgres -Atc "alter role authenticator with password 'drift-local-only'" >/dev/null

# ---- PostgREST descartavel -----------------------------------------------
docker network create "$PRV_NET" >/dev/null
docker network connect "$PRV_NET" "$PRV_DB"
docker run -d --name "$PRV_REST" --network "$PRV_NET" -p 127.0.0.1::3000 \
  -e PGRST_DB_URI="postgres://authenticator:drift-local-only@$PRV_DB:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$PRV_SEGREDO" \
  public.ecr.aws/supabase/postgrest:v14.8 >/dev/null || seg_die "PostgREST nao subiu"
PRV_REST_PORTA="$(docker port "$PRV_REST" 3000/tcp | head -1 | sed 's/.*://')"
PRV_SERVICE_KEY="$(jwt service_role)"; PRV_ANON_KEY="$(jwt anon)"
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $PRV_SERVICE_KEY" "http://127.0.0.1:$PRV_REST_PORTA/events?select=id&limit=1" || true)" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $PRV_SERVICE_KEY" "http://127.0.0.1:$PRV_REST_PORTA/events?select=id&limit=1" || true)" = "200" ] \
  || seg_die "PostgREST descartavel nao respondeu 200"

# ---- clone, canario, mutacao opcional ------------------------------------
seg_clona_fonte
seg_sobe_canario
bash "$SEG_ROOT/lib/erros/provas/mutar-clone.sh" "$SEG_SRC" "${ERROS_MUTACAO:-}" || seg_die "mutacao invalida"

# ---- gateway de teste ----------------------------------------------------
PRV_PORTA_ARQ="$SEG_TMP/gateway.porta"
node "$SEG_ROOT/lib/erros/provas/proxy-falha.mjs" "http://127.0.0.1:$PRV_REST_PORTA" "$PRV_SEGREDO" "$PRV_PORTA_ARQ" >"$SEG_TMP/gateway.log" 2>&1 &
SEG_PIDS+=("$!"); disown "$!" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$PRV_PORTA_ARQ" ] && break; sleep 0.1; done
[ -s "$PRV_PORTA_ARQ" ] || seg_die "gateway nao subiu: $(cat "$SEG_TMP/gateway.log")"
PRV_GATEWAY="http://127.0.0.1:$(cat "$PRV_PORTA_ARQ")"

# O app fala com o gateway (Supabase de mentira, descartavel).
SEG_API_URL="$PRV_GATEWAY"; SEG_ANON_KEY="$PRV_ANON_KEY"; SEG_SERVICE_KEY="$PRV_SERVICE_KEY"
seg_env_app

echo "[provas] build de producao do clone descartavel..."
seg_build_e_sobe || exit 2
seg_prova_isolamento
PRV_APP_URL="$SEG_APP_URL"

# Sem subshell ($(...)): os PIDs precisam ficar em SEG_PIDS para o trap mata-los.
sobe_instancia() { # $1 = nome ; resto = variaveis (VAR=valor) ou -u VAR ; resultado em PRV_URL_INSTANCIA
  local nome="$1"; shift
  local porta; porta="$(seg_porta_livre)"
  ( cd "$SEG_SRC" && exec env "$@" node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$porta" >"$SEG_TMP/app-$nome.log" 2>&1 ) &
  SEG_PIDS+=("$!"); disown "$!" 2>/dev/null || true
  local i
  for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$porta/admin/login" || true)" = "200" ] && { PRV_URL_INSTANCIA="http://127.0.0.1:$porta"; return 0; }
    sleep 0.5
  done
  tail -20 "$SEG_TMP/app-$nome.log" >&2
  seg_die "instancia $nome nao subiu"
}
sobe_instancia config JOBS_CONCURRENCY=abc; PRV_APP_CONFIG_URL="$PRV_URL_INSTANCIA"
sobe_instancia semchave -u SUPABASE_SERVICE_ROLE_KEY; PRV_APP_SEMCHAVE_URL="$PRV_URL_INSTANCIA"

echo "[provas] app $PRV_APP_URL | config-invalida $PRV_APP_CONFIG_URL | sem-chave $PRV_APP_SEMCHAVE_URL"
echo "[provas] gateway $PRV_GATEWAY -> PostgREST :$PRV_REST_PORTA -> $PRV_DB | canario $SEG_CANARIO_URL (Anthropic NAO e usada)"

cd "$SEG_ROOT"
ERROS_APP_URL="$PRV_APP_URL" \
ERROS_APP_CONFIG_URL="$PRV_APP_CONFIG_URL" \
ERROS_APP_SEMCHAVE_URL="$PRV_APP_SEMCHAVE_URL" \
ERROS_PROXY_URL="$PRV_GATEWAY" \
ERROS_SUPA_URL="$PRV_GATEWAY" \
ERROS_ANON_KEY="$PRV_ANON_KEY" \
ERROS_SERVICE_KEY="$PRV_SERVICE_KEY" \
ERROS_JWT_SECRET="$PRV_SEGREDO" \
ERROS_DB_URL="$PRV_DB_URL" \
ERROS_DB_SUPER_URL="$(printf '%s' "$PRV_DB_URL" | sed 's#//postgres:#//supabase_admin:#')" \
ERROS_CANARIO_URL="$SEG_CANARIO_URL" \
TZ=Asia/Tokyo \
  npx vitest run lib/erros/provas/erros-http.test.ts --reporter=verbose ${ERROS_FILTRO:+-t "$ERROS_FILTRO"}
