#!/usr/bin/env bash
# Funcoes compartilhadas dos scripts db-local-*. Nao execute diretamente.
# Garantia central: estes scripts SO falam com o Postgres local (Docker, 127.0.0.1).
# Nunca usam --linked, nunca fazem link e nunca recebem --db-url externo.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

die() { echo "ERRO: $*" >&2; exit 1; }

require_tools() {
  command -v supabase >/dev/null 2>&1 || die "Supabase CLI nao encontrada (https://supabase.com/docs/guides/local-development/cli/getting-started)."
  command -v docker >/dev/null 2>&1 || die "Docker nao encontrado."
  docker info >/dev/null 2>&1 || die "Docker nao esta rodando."
}

# Se alguem linkou este checkout a um projeto remoto, recusa: o ambiente local
# deve ser sempre independente de producao.
refuse_if_linked() {
  if [ -f supabase/.temp/project-ref ]; then
    die "Este checkout esta linkado a um projeto remoto (supabase/.temp/project-ref). Remova o link antes de usar os scripts locais."
  fi
}

# Le a URL do banco local via 'supabase status' (nada de credencial gravada em arquivo)
# e confirma que o host e local antes de devolve-la.
local_db_url() {
  local url
  url="$(supabase status -o env 2>/dev/null | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
  [ -n "$url" ] || die "Banco local nao esta no ar. Rode: scripts/db-local-up.sh"
  case "$url" in
    postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
    *) die "DB_URL nao aponta para localhost; abortando por seguranca." ;;
  esac
  echo "$url"
}
