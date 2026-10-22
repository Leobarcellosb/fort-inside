#!/usr/bin/env bash
# Roda a prova do gerador de prognostico contra o Supabase LOCAL e o canario
# roteirizavel. Nunca usa .env.local (que aponta para producao): tudo e injetado.
set -euo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$RAIZ"

saida="$(supabase status -o env 2>/dev/null)" || { echo "Supabase local fora do ar (npm run db:local:up)"; exit 2; }
API_URL="$(printf '%s\n' "$saida" | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
SERVICE="$(printf '%s\n' "$saida" | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "API_URL nao e local: $API_URL"; exit 2 ;; esac

tmp="$(mktemp -d)"
node lib/ai/provas/canario-roteirizado.mjs "$tmp/porta" >"$tmp/canario.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; rm -rf "$tmp"' EXIT
for _ in $(seq 1 50); do [ -s "$tmp/porta" ] && break; sleep 0.1; done
[ -s "$tmp/porta" ] || { cat "$tmp/canario.log"; exit 2; }

env -u ANTHROPIC_AUTH_TOKEN \
  NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  PROVA_CANARIO_URL="http://127.0.0.1:$(cat "$tmp/porta")" \
  PROVA_SAIDA="${PROVA_SAIDA:-}" \
  npx vitest run --config lib/ai/provas/vitest.prova.config.ts --reporter=verbose
