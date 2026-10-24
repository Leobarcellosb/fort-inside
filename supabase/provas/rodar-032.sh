#!/usr/bin/env bash
# rodar-032.sh -- prova do PRAZO RIGIDO v2 (migration 032) em Postgres DESCARTAVEL.
#
#   bash supabase/provas/rodar-032.sh                 sobe container proprio, aplica, prova, remove
#   bash supabase/provas/rodar-032.sh --com-028       idem, aplicando tambem a 028 (fora do pacote)
#   bash supabase/provas/rodar-032.sh --manter        deixa o container de pe no fim (imprime a URL)
#   bash supabase/provas/rodar-032.sh --url URL       usa um banco local JA PREPARADO (001..031 + 032)
#
# Exit: 0 = provado   1 = FALHOU   2 = BLOCKED (nao deu para montar o alvo)
#
# O alvo nasce aqui, com nome unico, e morre no fim. Nunca aponta para producao
# nem para o banco local compartilhado (supabase_db_fort-inside): com --url, so
# 127.0.0.1/localhost/[::1] e aceito, e a porta 54732 (a do banco local do
# projeto) e recusada.
#
# Imagem: a mesma do scripts/drift/reference-db.sh (Supabase Postgres), que ja
# traz anon/authenticated/service_role, o schema auth, auth.uid() e os default
# privileges da plataforma. Nada disso e imitado.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGS="$RAIZ/supabase/migrations"
IMAGEM="${PRAZO_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.106}"
SENHA="descartavel-local"
NOME="pg-prazo-032-$$-$RANDOM"
CRIEI=""; URL=""; MANTER=""; COM_028=""

die() { echo "032: BLOCKED -- $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --manter) MANTER=1; shift ;;
    --com-028) COM_028=1; shift ;;
    *) die "opcao desconhecida: $1" ;;
  esac
done

limpa() {
  if [ -n "$CRIEI" ]; then
    if [ -n "$MANTER" ]; then
      echo "032: --manter -- container de pe: $NOME ($URL)" >&2
    else
      docker rm -f "$NOME" >/dev/null 2>&1
    fi
  fi
}
trap limpa EXIT INT TERM

if [ -z "$URL" ]; then
  command -v docker >/dev/null || die "docker nao encontrado"
  docker run -d --name "$NOME" -e POSTGRES_PASSWORD="$SENHA" -p 127.0.0.1::5432 "$IMAGEM" >/dev/null \
    || die "docker run falhou"
  CRIEI=1
  # A imagem sobe um postgres temporario durante o init: espera o papel
  # authenticator existir, como o reference-db.sh.
  pronto=""
  for _ in $(seq 1 90); do
    if docker exec "$NOME" psql -U postgres -h 127.0.0.1 -d postgres -Atc \
         "select 1 from pg_roles where rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
      pronto=1; break
    fi
    sleep 1
  done
  [ -n "$pronto" ] || die "container $NOME nao ficou pronto em 90s"
  PORTA="$(docker port "$NOME" 5432/tcp | head -1 | sed 's/.*://')"
  URL="postgresql://postgres:${SENHA}@127.0.0.1:${PORTA}/postgres"

  for f in $(ls "$MIGS"/*.sql | sort); do
    base="$(basename "$f")"
    if [ -z "$COM_028" ] && [ "${base#028_}" != "$base" ]; then
      echo "032: pulando $base (fora do pacote)"; continue
    fi
    PGCONNECT_TIMEOUT=10 psql -X -q -v ON_ERROR_STOP=1 -f "$f" "$URL" >/dev/null 2>&1 \
      || die "migration falhou: $base"
  done
  echo "032: migrations aplicadas em $NOME"
else
  case "$URL" in
    *@127.0.0.1:54732/*|*@localhost:54732/*) die "recuso a porta 54732: e o banco local compartilhado do projeto" ;;
    *@127.0.0.1:*|*@localhost:*|*@\[::1\]:*) ;;
    *) die "--url precisa ser local (127.0.0.1, localhost ou [::1])" ;;
  esac
fi

cd "$RAIZ" || die "sem raiz"
PRAZO_PROVA_URL="$URL" npx vitest run --config supabase/provas/vitest.prova.config.ts --reporter=verbose
saida=$?
[ "$saida" -eq 0 ] && echo "032: PROVADO" || echo "032: FALHOU"
exit "$saida"
