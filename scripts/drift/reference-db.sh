#!/usr/bin/env bash
# reference-db.sh -- constrói/descarta bancos Postgres DESCARTÁVEIS (Docker) a partir
# de supabase/migrations/. Serve de "schema de referência" para o guard de drift e
# de bancos de teste. NUNCA aponte isto para produção: `apply` ESCREVE no banco.
#
#   reference-db.sh up [--name NOME] [--log-all]   sobe container + aplica migrations
#                                                  imprime: <container>\t<url>
#   reference-db.sh up-empty [--name NOME]         sobe container SEM migrations
#   reference-db.sh apply <url>                    aplica as migrations em <url>
#   reference-db.sh down <container>               remove o container
#
# --log-all liga log_statement=all (usado no teste para auditar que o guard só lê).
# A imagem é a do Supabase (já traz roles anon/authenticated/service_role, schema
# auth e os default privileges da plataforma), a mesma que o Supabase CLI usa.
# A senha abaixo é de um container local descartável, não é credencial real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="${DRIFT_MIGRATIONS_DIR:-$ROOT/supabase/migrations}"
IMAGE="${DRIFT_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.106}"
LOCAL_PW="drift-local-only"

die() { echo "reference-db: $*" >&2; exit 2; }

wait_ready() {
  local c="$1" i
  for i in $(seq 1 90); do
    # Não basta pg_isready: a imagem sobe um postgres temporário durante o init.
    # Esperamos o init terminar (role authenticator existir) antes de seguir.
    if docker exec "$c" psql -U postgres -h 127.0.0.1 -d postgres -Atc \
         "select 1 from pg_roles where rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
      return 0
    fi
    sleep 1
  done
  die "container $c não ficou pronto em 90s"
}

apply_migrations() {
  local url="$1" f
  [ -d "$MIGRATIONS_DIR" ] || die "sem diretório de migrations: $MIGRATIONS_DIR"
  for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    PGCONNECT_TIMEOUT=10 psql -X -q -v ON_ERROR_STOP=1 -f "$f" "$url" >/dev/null 2>&1 \
      || die "migration falhou: $(basename "$f")"
  done
}

start_container() {
  local name="$1" log_all="$2" c port
  command -v docker >/dev/null || die "docker não encontrado"
  c="$(docker run -d --name "$name" -e POSTGRES_PASSWORD="$LOCAL_PW" \
        -p 127.0.0.1::5432 "$IMAGE")" || die "docker run falhou"
  wait_ready "$name"
  if [ "$log_all" = 1 ]; then
    for q in "alter system set log_statement = 'all'" \
             "alter system set log_min_messages = 'log'" \
             "select pg_reload_conf()"; do
      docker exec "$name" psql -U supabase_admin -d postgres -h 127.0.0.1 -Atc "$q" >/dev/null
    done
  fi
  port="$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')"
  echo "postgresql://postgres:${LOCAL_PW}@127.0.0.1:${port}/postgres"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  up|up-empty)
    name="fort-drift-$$-$RANDOM"; log_all=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --log-all) log_all=1; shift ;;
        *) die "opção desconhecida: $1" ;;
      esac
    done
    url="$(start_container "$name" "$log_all")"
    if [ "$cmd" = up ]; then
      apply_migrations "$url" || { docker rm -f "$name" >/dev/null 2>&1; exit 2; }
    fi
    printf '%s\t%s\n' "$name" "$url"
    ;;
  apply)
    [ $# -eq 1 ] || die "uso: apply <url>"
    apply_migrations "$1"
    ;;
  down)
    [ $# -eq 1 ] || die "uso: down <container>"
    case "$1" in fort-drift-*) docker rm -f "$1" >/dev/null ;; *) die "recuso remover container fora do prefixo fort-drift-" ;; esac
    ;;
  *) die "uso: reference-db.sh up|up-empty|apply|down" ;;
esac
