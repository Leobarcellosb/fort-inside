#!/usr/bin/env bash
# db-security-isolado.sh -- roda a suíte de segurança do banco num ALVO DESCARTÁVEL PRÓPRIO:
# constrói a instância (scripts/db-security-alvo.sh), roda a suíte nela declarando
# DB_SECURITY_ALVO=descartavel (a suíte CONFERE a declaração) e destrói a instância no fim,
# mesmo se a suíte falhar. Nenhum outro processo escreve nesse alvo, então a contagem de
# linhas de que os cenários dependem é verdade por construção, não por sorte.
#
# Uso:  npm run db:security:isolado          (fonte: banco local do projeto, só leitura)
#       DB_SECURITY_FONTE=<url> npm run db:security:isolado
#
# Exit: 0 = PASS ; 1 = alguma verificação reprovou ; 2 = BLOCKED (não deu para verificar).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALVO_SH="$HERE/db-security-alvo.sh"
SUITE_SH="$HERE/test-db-security.sh"
CONTAINER=""

limpa() {
  if [ -n "$CONTAINER" ]; then
    echo
    echo "db-security-isolado: destruindo o alvo descartável ($CONTAINER)"
    bash "$ALVO_SH" down "$CONTAINER" || echo "db-security-isolado: AVISO -- não consegui remover $CONTAINER; remova à mão: docker rm -f $CONTAINER" >&2
    CONTAINER=""
  fi
}
trap limpa EXIT INT TERM

[ -x "$ALVO_SH" ] || [ -f "$ALVO_SH" ] || { echo "db-security-isolado: BLOCKED -- falta $ALVO_SH" >&2; exit 2; }

ARGS=""
[ -n "${DB_SECURITY_FONTE:-}" ] && ARGS="--fonte $DB_SECURITY_FONTE"

echo "== alvo descartável próprio para esta suíte =="
# shellcheck disable=SC2086
LINHA="$(bash "$ALVO_SH" up $ARGS)" || { echo "db-security-isolado: BLOCKED -- não consegui construir o alvo descartável." >&2; exit 2; }
CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"
URL_ALVO="$(printf '%s' "$LINHA" | cut -f2)"
[ -n "$CONTAINER" ] && [ -n "$URL_ALVO" ] || { echo "db-security-isolado: BLOCKED -- o construtor não devolveu container e url." >&2; exit 2; }
echo "   container: $CONTAINER"

DB_SECURITY_ALVO=descartavel DB_SECURITY_URL="$URL_ALVO" bash "$SUITE_SH"
RC=$?
limpa
exit "$RC"
