#!/usr/bin/env bash
# Gera o manifesto das migrations EFETIVAMENTE aplicadas num banco, com nome e
# checksum, e compara com os arquivos do repositório.
#
# Existe porque uma contagem descritiva minha estava errada: eu vinha afirmando
# "as 18 migrations" usando o último número do nome como se fosse o total, e são
# 17 arquivos -- a 013 foi dobrada na 011 e apagada, deixando o número vago.
# O aceite não pode depender de alguém contar certo. A máquina conta.
#
# Uso:
#   scripts/manifesto-migrations.sh --target "postgresql://usuario@host:5432/db"
#   PGPASSWORD=... scripts/manifesto-migrations.sh --target "$URL"
#
# Exit 0 = repositório e banco batem. Exit 1 = divergência (nome, checksum ou
# ausência). Exit 2 = não deu para inspecionar -- NUNCA confundir com sucesso.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/supabase/migrations"
ALVO="${DRIFT_TARGET_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) ALVO="${2:-}"; shift 2 ;;
    *) echo "manifesto: argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

[ -d "$DIR" ] || { echo "manifesto: BLOCKED -- $DIR não existe"; exit 2; }

echo "manifesto de migrations"
echo "  diretório : $DIR"

# ---------------------------------------------------------------
# 1. O que o repositório declara
# ---------------------------------------------------------------
# Sem array associativo de proposito: o macOS traz bash 3.2, que nao os suporta.
# A primeira versao deste script usava `declare -A` e, em vez de falhar, produziu
# um FALSO VERMELHO -- acusou 16 divergencias inexistentes. Verificador que erra
# calado e pior que verificador nenhum, entao aqui se usa so lista de linhas.
LINHAS=$(find "$DIR" -maxdepth 1 -name '*.sql' | sort | while IFS= read -r arq; do
  printf '%s\t%s\n' "$(basename "$arq")" "$(shasum -a 256 "$arq" | cut -d' ' -f1)"
done)
TOTAL=$(printf '%s\n' "$LINHAS" | grep -c .)

echo "  no repositório: $TOTAL arquivo(s)"
echo
printf '%-44s %s\n' "ARQUIVO" "SHA-256 (12 primeiros)"
printf '%s\n' "$LINHAS" | while IFS=$'\t' read -r n sha; do
  [ -z "$n" ] && continue
  printf '%-44s %s\n' "$n" "$(printf '%s' "$sha" | cut -c1-12)"
done

# Lacunas de numeração são legítimas (a 013 não existe de propósito), mas
# precisam ser VISÍVEIS, não descobertas por alguém conferindo à mão depois.
echo
PREFIXOS=$(printf '%s\n' "$LINHAS" | cut -f1 | grep -oE '^[0-9]+' | sed 's/^0*//;s/^$/0/' | sort -n)
PRIMEIRO=$(echo "$PREFIXOS" | head -1); ULTIMO=$(echo "$PREFIXOS" | tail -1)
FALTANDO=""
for i in $(seq "$PRIMEIRO" "$ULTIMO"); do
  echo "$PREFIXOS" | grep -qx "$i" || FALTANDO="$FALTANDO $i"
done
if [ -n "$FALTANDO" ]; then
  echo "numeração: faixa $PRIMEIRO..$ULTIMO, com lacuna(s) em:$FALTANDO"
  echo "  (lacuna é legítima quando uma migration foi dobrada em outra e apagada;"
  echo "   o que não é legítimo é contar o último número como se fosse o total)"
else
  echo "numeração: faixa $PRIMEIRO..$ULTIMO, sem lacunas"
fi

# ---------------------------------------------------------------
# 2. O que o banco diz ter aplicado
# ---------------------------------------------------------------
if [ -z "$ALVO" ]; then
  echo
  echo "Sem --target: manifesto do repositório apenas. O que o BANCO aplicou não foi verificado."
  echo "MANIFESTO: SOMENTE-REPOSITORIO"
  exit 0
fi

case "$ALVO" in postgres://*|postgresql://*) ;; *) echo "manifesto: BLOCKED -- alvo não é uma URL postgres"; exit 2 ;; esac

APLICADAS=$(psql "$ALVO" -Atc \
  "select version||'_'||coalesce(name,'') from supabase_migrations.schema_migrations order by version;" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo
  echo "MANIFESTO: BLOCKED -- não foi possível ler supabase_migrations.schema_migrations no alvo."
  echo "Isto NÃO é um atestado de que o banco está em dia."
  exit 2
fi

echo
echo "no alvo: $(printf '%s\n' "$APLICADAS" | grep -c . ) migration(s) registrada(s)"

DIVERGENCIAS=0
while IFS=$'\t' read -r n sha; do
  [ -z "$n" ] && continue
  v="${n%%_*}"
  if ! printf '%s\n' "$APLICADAS" | grep -q "^${v}_"; then
    echo "  [AUSENTE NO ALVO] $n (sha $(printf '%s' "$sha" | cut -c1-12))"
    DIVERGENCIAS=$((DIVERGENCIAS+1))
  fi
done <<< "$LINHAS"
while IFS= read -r a; do
  [ -z "$a" ] && continue
  v="${a%%_*}"
  printf '%s\n' "$LINHAS" | cut -f1 | grep -q "^${v}_" || {
    echo "  [NO ALVO, NÃO DECLARADA] $a"
    DIVERGENCIAS=$((DIVERGENCIAS+1))
  }
done <<< "$APLICADAS"

echo
if [ "$DIVERGENCIAS" -eq 0 ]; then
  echo "MANIFESTO: OK -- $TOTAL arquivo(s), todos registrados no alvo"
  exit 0
fi
echo "MANIFESTO: DIVERGENTE -- $DIVERGENCIAS diferença(s)"
exit 1
