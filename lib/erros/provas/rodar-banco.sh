#!/usr/bin/env bash
# Prova da corrida do fechamento: Postgres DESCARTAVEL com container de nome proprio,
# removido no fim (so o que ESTE script criou). Nada toca o banco local compartilhado.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NOME="erros-pg-$$-$RANDOM"
trap 'docker rm -f "$NOME" >/dev/null 2>&1 || true' EXIT
SAIDA="$(bash "$ROOT/scripts/drift/reference-db.sh" up --name "$NOME")"
URL="$(printf '%s' "$SAIDA" | cut -f2)"
echo "[banco] container $NOME -> $URL (migrations 001-022 aplicadas)"
# A proposta de migration desta unidade, aplicada SO neste banco descartavel.
# ERROS_MUTACAO_SQL (opcional) sabota uma COPIA da proposta de migration, so neste banco
# descartavel, para provar que cada protecao e testada de verdade:
#   semquiescencia  a funcao deixa de recusar com transacao em voo no limite
#   semvalidacao    a funcao deixa de validar a fotografia no fim (commit no meio passa)
#   abertalibera    a funcao deixa de recusar coleta aberta (o portao do app ainda recusa antes)
SQL="$ROOT/lib/erros/sql/processamento_assincrono.sql"
if [ -n "${ERROS_MUTACAO_SQL:-}" ]; then
  SQL="$(mktemp -t erros-sql-mutado.XXXXXX)"
  python3 - "$ROOT/lib/erros/sql/processamento_assincrono.sql" "$SQL" "$ERROS_MUTACAO_SQL" <<'PY'
import sys
src, dst, m = sys.argv[1:4]
s = open(src).read()
alvo = {"semquiescencia": "if v_abertas > 0 then", "semvalidacao": "if v_digest_fim is distinct from v_digest_ini then", "abertalibera": "if v_agora < v_limite then"}[m]
assert alvo in s, m
open(dst, "w").write(s.replace(alvo, "if false then"))
PY
  echo "[mutacao-sql] $ERROS_MUTACAO_SQL aplicada a uma copia da proposta de migration"
fi
psql -X -q -v ON_ERROR_STOP=1 -f "$SQL" "$URL" >/dev/null
cd "$ROOT"
ERROS_PG_URL="$URL" npx vitest run lib/erros/provas/corrida-fechamento.test.ts --reporter=verbose ${ERROS_FILTRO:+-t "$ERROS_FILTRO"}
