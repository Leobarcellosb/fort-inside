#!/usr/bin/env bash
# rodar-020.sh -- prova a migration 020 contra um Postgres DESCARTÁVEL próprio.
#
# Sobe um container exclusivo desta prova, aplica TODAS as migrations em ordem
# (001 -> 020) e roda as duas sondas:
#
#   020-rls-presenca.sql  privilégio e RLS: o participante não se declara presente
#   020-cobertura.sql     o denominador oficial, com o caso canônico 50/45 = 90%
#
# NUNCA aponta para o banco local do projeto nem para produção: o alvo é sempre
# um container que este script acabou de criar. O banco local é compartilhado
# entre unidades em voo -- uma suíte que conta linhas já foi para vermelho
# porque outra unidade escreveu nele durante a execução.
#
#   uso: bash supabase/provas/rodar-020.sh [--nome NOME] [--manter]
#
# --manter deixa o container de pé para inspeção (e imprime como removê-lo).
# Sem --manter, o container é removido no fim -- APENAS o que este script criou.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOME="teste020"
MANTER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --nome) NOME="$2"; shift 2 ;;
    --manter) MANTER=1; shift ;;
    *) echo "rodar-020: opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "rodar-020: docker não encontrado" >&2; exit 2; }
command -v psql   >/dev/null || { echo "rodar-020: psql não encontrado" >&2; exit 2; }

# Recusa reaproveitar container existente: pode ser de OUTRA unidade em voo, e
# remover o container de outro agente é dano, não limpeza.
if docker ps -a --format '{{.Names}}' | grep -qx "$NOME"; then
  echo "rodar-020: já existe um container chamado '$NOME'. Não vou tocar nele." >&2
  echo "           use --nome OUTRO, ou remova o seu com: docker rm -f $NOME" >&2
  exit 2
fi

CRIADO=0
limpar() {
  if [ "$CRIADO" = 1 ] && [ "$MANTER" = 0 ]; then
    docker rm -f "$NOME" >/dev/null 2>&1 || true
  fi
}
trap limpar EXIT

echo "== subindo Postgres descartável ($NOME) e aplicando 001 -> 020"
SAIDA="$(bash "$ROOT/scripts/drift/reference-db.sh" up --name "$NOME")"
CRIADO=1
URL="$(printf '%s' "$SAIDA" | cut -f2)"

falhas=0
oks=0

for sonda in 020-rls-presenca.sql 020-cobertura.sql; do
  echo
  echo "== $sonda"
  saida="$(cd "$ROOT/supabase/provas" && psql -X -q -At -v ON_ERROR_STOP=1 -f "$sonda" "$URL" 2>&1)" || {
    echo "$saida"
    echo "rodar-020: a sonda $sonda não terminou (erro de execução, não veredito)" >&2
    exit 2
  }
  echo "$saida"
  oks=$((oks + $(printf '%s\n' "$saida" | grep -cE '^\[ok  \]' || true)))
  falhas=$((falhas + $(printf '%s\n' "$saida" | grep -cE '^\[FALHA\]' || true)))
done

echo
if [ "$falhas" -eq 0 ] && [ "$oks" -gt 0 ]; then
  echo "PROVA-020: PASS ($oks afirmações, 0 falhas)"
  rc=0
else
  echo "PROVA-020: FAIL ($oks afirmações, $falhas falhas)"
  rc=1
fi

if [ "$MANTER" = 1 ]; then
  echo "container mantido: $NOME (remova com: docker rm -f $NOME)"
fi

exit "$rc"
