#!/usr/bin/env bash
# Teste de SENSIBILIDADE da suite de seguranca HTTP: prova que ela DETECTA regressao.
#
# Para cada mutacao (tests/seguranca-http/mutacoes.mjs) remove UMA verificacao de
# autorizacao num CLONE descartavel (o checkout real nunca e tocado), reconstroi o app e
# roda o cenario correspondente. O cenario TEM que falhar. Se passar, a suite esta cega.
#
# Antes de mutar, roda o app intacto como CONTROLE: se o controle nao passa, o resultado
# das mutacoes nao significa nada e o script aborta.
#
# Uso: bash scripts/test-seguranca-http-sensibilidade.sh [m1 m2 m3 m4 m4b m4c m5 m5b m5c m6 m7 m8]   (padrao: todas)
# Exit 0 so se o controle passou E todas as mutacoes pedidas foram detectadas.
source "$(dirname "$0")/_seguranca-http-common.sh"
trap seg_limpa EXIT

MUT="$SEG_ROOT/tests/seguranca-http/mutacoes.mjs"
if [ "$#" -gt 0 ]; then IDS=("$@"); else IDS=(m1 m2 m3 m4 m4b m4c m5 m5b m5c m6 m7 m8); fi

estado_git() { (cd "$SEG_ROOT" && git status --porcelain); }
ANTES="$(estado_git)"

seg_carrega_supabase_local
seg_clona_fonte
seg_sobe_canario
seg_env_app

echo "== CONTROLE: app intacto, suite completa (precisa passar)"
seg_build_e_sobe || exit 2
seg_prova_isolamento
if ! seg_roda_suite "" >"$SEG_TMP/controle.log" 2>&1; then
  tail -30 "$SEG_TMP/controle.log"
  echo "ABORTADO: o controle (sem mutacao) falhou; sensibilidade nao e interpretavel." >&2
  exit 2
fi
grep -E '^(cenário|total)' "$SEG_TMP/controle.log"
seg_para_app

RESUMO=()
FALHOU=0
for id in "${IDS[@]}"; do
  cen="$(node "$MUT" --cenario "$id")"
  arq="$(node "$MUT" --arquivo "$id")"
  echo
  echo "== MUTACAO $id (cenario $cen): $(node "$MUT" --descricao "$id")"
  cp "$SEG_ROOT/$arq" "$SEG_SRC/$arq"          # parte sempre do arquivo original
  alterado="$(node "$MUT" "$id" "$SEG_SRC")" || { echo "ERRO: mutacao $id invalida: $alterado" >&2; exit 2; }
  echo "   aplicada em: $alterado"
  if ! seg_build_e_sobe; then
    echo "   build/start da mutacao falhou: mutacao invalida, NAO conta como deteccao." >&2
    exit 2
  fi
  set +e
  seg_roda_suite "$cen" >"$SEG_TMP/mut-$id.log" 2>&1
  rc=$?
  set -e
  seg_para_app
  cp "$SEG_ROOT/$arq" "$SEG_SRC/$arq"          # desfaz no clone
  falhas="$(grep -c "^\[FAIL\] C$cen\." "$SEG_TMP/mut-$id.log" || true)"
  fatal="$(grep -c 'ERRO FATAL' "$SEG_TMP/mut-$id.log" || true)"
  if [ "$rc" -ne 0 ] && [ "$falhas" -ge 1 ] && [ "$fatal" -eq 0 ]; then
    echo "   DETECTADA: suite saiu com exit $rc e $falhas verificacao(oes) do cenario $cen falharam. Exemplos:"
    grep "^\[FAIL\] C$cen\." "$SEG_TMP/mut-$id.log" | head -3 | cut -c1-330 | sed 's/^/     /'
    RESUMO+=("$id (cenario $cen): DETECTADA")
  else
    echo "   NAO DETECTADA (exit $rc, falhas no cenario: $falhas, fatal: $fatal): A SUITE ESTA CEGA PARA ESTA REGRESSAO."
    tail -15 "$SEG_TMP/mut-$id.log" | sed 's/^/     /'
    RESUMO+=("$id (cenario $cen): NAO DETECTADA")
    FALHOU=1
  fi
done

echo
echo "== RESUMO DA SENSIBILIDADE"
printf '   %s\n' "${RESUMO[@]}"
DEPOIS="$(estado_git)"
if [ "$ANTES" = "$DEPOIS" ]; then
  echo "   git status do checkout real: IDENTICO antes e depois (mutacoes so existiram no clone descartavel)."
else
  echo "   ALERTA: git status mudou durante o teste! Diferenca (< antes, > depois):" >&2
  diff <(printf '%s\n' "$ANTES") <(printf '%s\n' "$DEPOIS") | sed 's/^/     /' >&2 || true
  echo "   (mutacoes so existem no clone; se a diferenca for de arquivos que voce nao mexeu, outra pessoa editou o checkout durante a execucao: rode de novo.)" >&2
  FALHOU=1
fi
exit "$FALHOU"
