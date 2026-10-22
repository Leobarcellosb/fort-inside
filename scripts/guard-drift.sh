#!/usr/bin/env bash
# guard-drift.sh -- guard de DRIFT de schema: compara o que as migrations declaram
# com o que um banco alvo de fato tem.
#
# POR QUE EXISTE: uma policy de INSERT anônimo em nps_responses foi criada à mão no
# dashboard do Supabase, direto em produção, e nunca existiu nos arquivos. Teste
# contra banco local confirma as migrations, não o banco real. Este guard confere o
# banco real.
#
# Uso:
#   scripts/guard-drift.sh --target <url> [--reference <url>] [--schemas public]
#
#   --target     URL do banco a inspecionar (ou env DRIFT_TARGET_URL).
#                Recomendado: URL sem senha + env PGPASSWORD, para a senha não
#                aparecer na lista de processos.
#   --reference  URL de um banco JÁ construído das migrations (ou env
#                DRIFT_REFERENCE_URL). Sem isto, o guard sobe um Postgres
#                descartável no Docker, aplica supabase/migrations/ e descarta no fim.
#   --schemas    schemas a comparar (padrão: public; env DRIFT_SCHEMAS). Policies
#                são sempre lidas em todos os schemas de usuário.
#
# Resultado e exit code (os três são mutuamente exclusivos):
#   0  PASS     alvo igual à referência
#   1  FAIL     diferença encontrada (policy/grant não declarado, RLS desligado, ...)
#   2  BLOCKED  alvo/referência inacessível, inspeção incompleta, erro de uso ou
#               erro interno. NUNCA é sinônimo de "está tudo certo".
#
# SOMENTE LEITURA no alvo: a única coisa executada nele é
# scripts/drift/introspect.sql, que roda dentro de BEGIN READ ONLY e só contém SELECT.
# A URL (com credenciais) nunca é impressa.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/drift/introspect.sql"
REFDB="$HERE/drift/reference-db.sh"

TARGET_URL="${DRIFT_TARGET_URL:-}"
REFERENCE_URL="${DRIFT_REFERENCE_URL:-}"
SCHEMAS="${DRIFT_SCHEMAS:-public}"
CONNECT_TIMEOUT="${DRIFT_CONNECT_TIMEOUT:-8}"
RUN_TIMEOUT="${DRIFT_RUN_TIMEOUT:-120}"

TMP=""
EPHEMERAL_CONTAINER=""
FINISHED=0

cleanup() {
  [ -n "$EPHEMERAL_CONTAINER" ] && "$REFDB" down "$EPHEMERAL_CONTAINER" >/dev/null 2>&1
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}

# Qualquer saída do script que não passe por finish/blocked é erro interno => BLOCKED.
on_exit() {
  local rc=$?
  if [ "$FINISHED" -ne 1 ]; then
    cleanup
    echo "RESULTADO: BLOCKED -- erro interno do guard (inspeção não concluída)"
    echo "GUARD-DRIFT: BLOCKED"
    exit 2
  fi
  exit "$rc"
}
trap on_exit EXIT

blocked() {
  echo
  echo "RESULTADO: BLOCKED -- $*"
  echo "A inspeção não foi concluída; isto NÃO é um atestado de que o banco está íntegro."
  echo "GUARD-DRIFT: BLOCKED"
  cleanup
  FINISHED=1
  exit 2
}

# host:porta/banco, sem usuário nem senha (nunca imprimir a URL inteira).
describe_url() {
  local rest="${1#*://}"
  rest="${rest%%\?*}"
  local authority="${rest%%/*}" path=""
  case "$rest" in */*) path="${rest#*/}" ;; esac
  echo "${authority##*@}/${path}"
}

# Mensagem de erro do psql sem URL e sem a palavra "password" (evita ruído em greps).
sanitize_err() {
  grep -v '^[[:space:]]*$' "$1" 2>/dev/null | head -1 \
    | sed -E 's#postgres(ql)?://[^ ]*#<url>#g; s/[Pp]assword authentication/autenticação por senha/g; s/[Pp]assword/senha/g' | cut -c1-220
}

usage() {
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)    TARGET_URL="${2:-}"; shift 2 ;;
    --reference) REFERENCE_URL="${2:-}"; shift 2 ;;
    --schemas)   SCHEMAS="${2:-}"; shift 2 ;;
    -h|--help)   usage; FINISHED=1; exit 0 ;;
    *)           blocked "argumento desconhecido: $1 (use --help)" ;;
  esac
done

echo "guard-drift"

[ -n "$TARGET_URL" ] || blocked "alvo não informado (--target <url> ou DRIFT_TARGET_URL)"
case "$TARGET_URL" in postgres://*|postgresql://*) ;; *) blocked "o alvo precisa ser uma URL postgres:// ou postgresql://" ;; esac
[ -n "$REFERENCE_URL" ] && case "$REFERENCE_URL" in postgres://*|postgresql://*) ;; *) blocked "a referência precisa ser uma URL postgres:// ou postgresql://" ;; esac
command -v psql >/dev/null 2>&1 || blocked "psql não encontrado no PATH"
[ -f "$SQL" ] || blocked "arquivo de introspecção ausente: $SQL"
case "$SCHEMAS" in *[!a-zA-Z0-9_,]*|"") blocked "--schemas aceita só nomes simples separados por vírgula" ;; esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/guard-drift.XXXXXX")" || blocked "não consegui criar diretório temporário"

# --- referência: usa a informada ou constrói uma efêmera das migrations ----------------
if [ -z "$REFERENCE_URL" ]; then
  command -v docker >/dev/null 2>&1 || blocked "sem --reference e sem docker para construir a referência das migrations"
  echo "  referência : construindo das migrations num Postgres descartável (Docker)..."
  built="$("$REFDB" up 2>"$TMP/refbuild.err")" || blocked "falha ao construir a referência: $(sanitize_err "$TMP/refbuild.err")"
  EPHEMERAL_CONTAINER="$(printf '%s' "$built" | cut -f1)"
  REFERENCE_URL="$(printf '%s' "$built" | cut -f2)"
  REF_LABEL="efêmera ($(describe_url "$REFERENCE_URL"))"
else
  REF_LABEL="$(describe_url "$REFERENCE_URL")"
fi
TGT_LABEL="$(describe_url "$TARGET_URL")"

if [ "$(printf '%s' "$REF_LABEL" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$TGT_LABEL" | tr 'A-Z' 'a-z')" ] \
   || [ "$(describe_url "$REFERENCE_URL" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$TGT_LABEL" | tr 'A-Z' 'a-z')" ]; then
  blocked "alvo e referência apontam para o mesmo banco ($TGT_LABEL); a comparação não provaria nada"
fi

echo "  referência : $REF_LABEL"
echo "  alvo       : $TGT_LABEL"
echo "  schemas    : $SCHEMAS"

# --- inspeção (somente leitura) ----------------------------------------------------------
take_snapshot() { # label url outfile
  local label="$1" url="$2" out="$3" err="$3.err" pid wd rc
  PGCONNECT_TIMEOUT="$CONNECT_TIMEOUT" PGAPPNAME="fort-drift-guard" \
    psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -v "schemas=$SCHEMAS" -f "$SQL" "$url" \
    >"$out" 2>"$err" </dev/null &
  pid=$!
  ( sleep "$RUN_TIMEOUT"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  disown "$wd" 2>/dev/null
  wait "$pid"; rc=$?
  pkill -P "$wd" 2>/dev/null; kill "$wd" 2>/dev/null
  if [ "$rc" -ne 0 ]; then
    local why; why="$(sanitize_err "$err")"
    [ "$rc" -ge 128 ] && why="tempo esgotado ou processo morto (${RUN_TIMEOUT}s)"
    blocked "$label inacessível ou inspeção falhou: ${why:-sem detalhe (código $rc)}"
  fi

  # Saída completa? Sentinela final com a contagem batendo, e ao menos uma tabela.
  local last n actual
  last="$(tail -n 1 "$out")"
  case "$last" in zz_end$'\t'*) ;; *) blocked "$label: saída da inspeção truncada (sem sentinela final)" ;; esac
  n="${last#*$'\t'}"
  actual=$(( $(wc -l <"$out") - 1 ))
  [ "$n" = "$actual" ] || blocked "$label: saída da inspeção incompleta (esperado $n linhas, recebido $actual)"
  grep -q $'^meta\tserver_version_num\t' "$out" || blocked "$label: saída sem metadados de versão"
  grep -q $'^rel\t' "$out" || blocked "$label: nenhuma tabela encontrada nos schemas '$SCHEMAS' (banco errado ou catálogo ilegível)"
}

take_snapshot "referência" "$REFERENCE_URL" "$TMP/ref.snap"
take_snapshot "alvo"       "$TARGET_URL"    "$TMP/tgt.snap"

version_of() { grep $'^meta\tserver_version_num\t' "$1" | cut -f3; }
REF_V="$(version_of "$TMP/ref.snap")"; TGT_V="$(version_of "$TMP/tgt.snap")"
echo "  versão pg  : referência $REF_V / alvo $TGT_V"
VERSION_NOTE=""
if [ "${REF_V%????}" != "${TGT_V%????}" ]; then
  VERSION_NOTE="AVISO: major do Postgres difere entre referência e alvo; a forma de deparse das expressões pode divergir e gerar diferenças espúrias."
fi

# --- comparação ----------------------------------------------------------------------------
body() { grep -v -e $'^meta\t' -e $'^zz_end\t' "$1" | LC_ALL=C sort -u; }
body "$TMP/ref.snap" >"$TMP/ref.body"
body "$TMP/tgt.snap" >"$TMP/tgt.body"
LC_ALL=C comm -23 "$TMP/ref.body" "$TMP/tgt.body" >"$TMP/missing"   # declarado, ausente no alvo
LC_ALL=C comm -13 "$TMP/ref.body" "$TMP/tgt.body" >"$TMP/extra"     # no alvo, não declarado
COMPARED="$(wc -l <"$TMP/ref.body" | tr -d ' ')"

if [ ! -s "$TMP/missing" ] && [ ! -s "$TMP/extra" ]; then
  echo
  [ -n "$VERSION_NOTE" ] && echo "$VERSION_NOTE"
  echo "RESULTADO: PASS -- $COMPARED itens comparados, nenhuma diferença entre as migrations e o alvo"
  echo "GUARD-DRIFT: PASS"
  cleanup
  FINISHED=1
  exit 0
fi

{ sed $'s/^/M\t/' "$TMP/missing"; sed $'s/^/E\t/' "$TMP/extra"; } \
| awk -F'\t' '
function exposed(s) { return (s == "anon" || s == "authenticated" || s == "PUBLIC") }
function anyexposed(   i) { for (i = 3; i <= NF; i++) if (exposed($i)) return 1; return 0 }
function rolesexposed(r) { return (r ~ /(^|,)(anon|authenticated|PUBLIC)(,|$)/) }
function join_from(from,   i, s) { s = ""; for (i = from; i <= NF; i++) s = s (i > from ? " | " : "") $i; return s }
function keyof(   c) {
  c = $2
  if (c == "rel" || c == "fn" || c == "role") return c SUBSEP $3
  if (c == "col" || c == "policy") return c SUBSEP $3 SUBSEP $4
  return c SUBSEP $0
}
function val(line, from,   n, a, i, s) {   # junta os campos depois da chave
  n = split(line, a, "\t"); s = ""
  for (i = from; i <= n; i++) s = s (i > from ? " | " : "") a[i]
  return s
}
{
  k = keyof()
  if ($1 == "E") { E[k] = $0 } else { M[k] = $0 }
}
function labelof(cat) {
  return (cat == "grant") ? "GRANT EM TABELA" : (cat == "colgrant") ? "GRANT EM COLUNA" : (cat == "fngrant") ? "GRANT EM FUNCAO" : (cat == "nspgrant") ? "GRANT EM SCHEMA" : (cat == "defacl") ? "DEFAULT PRIVILEGE" : cat
}
function emit(sev, text) { printf "%s\t%s\n", sev, text }
END {
  for (k in E) {
    n = split(E[k], f, "\t"); cat = f[2]
    $0 = E[k]
    changed = (k in M)
    if (cat == "policy") {
      desc = f[5] ", " f[6] ", roles={" f[7] "}, " f[8] ", " f[9]
      sev = rolesexposed(f[7]) ? "CRITICO" : "ALTERACAO"
      if (changed) {
        emit(sev, "POLICY ALTERADA: \"" f[4] "\" na tabela " f[3] " -- no alvo: " desc " -- declarado: " val(M[k], 5))
      } else {
        emit(sev, "POLICY NAO DECLARADA: \"" f[4] "\" na tabela " f[3] " -- " desc)
      }
    } else if (cat == "rel") {
      sev = (f[5] == "rls=false" && (f[4] == "r" || f[4] == "p")) ? "CRITICO" : "ALTERACAO"
      if (changed) emit(sev, "TABELA ALTERADA: " f[3] " -- no alvo: " val(E[k], 4) " -- declarado: " val(M[k], 4))
      else emit(sev, "TABELA/RELACAO NAO DECLARADA: " f[3] " (" val(E[k], 4) ")")
    } else if (cat == "col") {
      if (changed) emit("ALTERACAO", "COLUNA ALTERADA: " f[3] "." f[4] " -- no alvo: " val(E[k], 5) " -- declarado: " val(M[k], 5))
      else emit("ALTERACAO", "COLUNA NAO DECLARADA: " f[3] "." f[4] " (" val(E[k], 5) ")")
    } else if (cat == "fn") {
      sev = (index(E[k], "secdef=true") > 0) ? "CRITICO" : "ALTERACAO"
      if (changed) emit(sev, "FUNCAO ALTERADA: " f[3] " -- no alvo: " val(E[k], 4) " -- declarado: " val(M[k], 4))
      else emit(sev, "FUNCAO NAO DECLARADA: " f[3] " (" val(E[k], 4) ")")
    } else if (cat == "role") {
      if (changed) emit("CRITICO", "PAPEL ALTERADO: " f[3] " -- no alvo: " val(E[k], 4) " -- declarado: " val(M[k], 4))
      else emit("CRITICO", "PAPEL NAO DECLARADO: " f[3] " (" val(E[k], 4) ")")
    } else if (cat == "member") {
      emit("CRITICO", "MEMBERSHIP DE PAPEL NAO DECLARADA: " f[3] " em " f[5])
    } else {
      sev = anyexposed() ? "CRITICO" : "ALTERACAO"
      emit(sev, labelof(cat) " NAO DECLARADO: " join_from(3))
    }
  }
  for (k in M) {
    if (k in E) continue
    n = split(M[k], f, "\t"); cat = f[2]
    $0 = M[k]
    if (cat == "policy") emit("ALTERACAO", "POLICY DECLARADA AUSENTE NO ALVO: \"" f[4] "\" na tabela " f[3])
    else if (cat == "rel") emit("ALTERACAO", "RELACAO DECLARADA AUSENTE NO ALVO: " f[3] " (migration pendente ou objeto removido)")
    else if (cat == "col") emit("ALTERACAO", "COLUNA DECLARADA AUSENTE NO ALVO: " f[3] "." f[4])
    else if (cat == "fn") emit("ALTERACAO", "FUNCAO DECLARADA AUSENTE NO ALVO: " f[3])
    else emit("ALTERACAO", labelof(cat) " DECLARADO AUSENTE NO ALVO: " join_from(3))
  }
}' | LC_ALL=C sort >"$TMP/report"

CRIT="$(grep -c $'^CRITICO\t' "$TMP/report" || true)"
TOTAL="$(wc -l <"$TMP/report" | tr -d ' ')"

echo
[ -n "$VERSION_NOTE" ] && echo "$VERSION_NOTE" && echo
echo "Diferenças entre as migrations (referência) e o alvo:"
while IFS=$'\t' read -r sev text; do
  if [ "$sev" = "CRITICO" ]; then echo "  [CRITICO]   $text"; else echo "  [diferença] $text"; fi
done <"$TMP/report"
echo
echo "RESULTADO: FAIL -- $TOTAL diferença(s), $CRIT crítica(s) (exposição a anon/authenticated/PUBLIC, RLS desligado, papel alterado ou função SECURITY DEFINER)"
echo "GUARD-DRIFT: FAIL"
cleanup
FINISHED=1
exit 1
