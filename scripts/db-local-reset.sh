#!/usr/bin/env bash
# Destroi e recria o banco LOCAL, reaplicando todas as migrations do zero.
# Sempre local: usa 'supabase db reset --local' (nunca --linked, nunca --db-url).
source "$(dirname "$0")/_db-local-common.sh"
require_tools
refuse_if_linked

# Garante que o stack esta no ar (reset precisa do container do banco).
if ! supabase status >/dev/null 2>&1; then
  supabase start
fi

supabase db reset --local
echo
echo "Banco local recriado a partir de supabase/migrations/."
