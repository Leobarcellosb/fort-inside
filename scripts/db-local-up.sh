#!/usr/bin/env bash
# Sobe o stack Supabase local (Docker) e aplica TODAS as migrations de supabase/migrations/
# em ordem, a partir de um banco novo. Se o banco ja existir, apenas sobe os containers
# (para recriar do zero use scripts/db-local-reset.sh).
source "$(dirname "$0")/_db-local-common.sh"
require_tools
refuse_if_linked

supabase start
echo
supabase status
echo
echo "Pronto. Para recriar o banco do zero: scripts/db-local-reset.sh"
