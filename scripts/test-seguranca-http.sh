#!/usr/bin/env bash
# Suite de regressao de seguranca da camada HTTP.
#
# Sobe um clone descartavel do app (build de producao) contra o Supabase LOCAL, com a
# Anthropic substituida por um canario, e exercita as rotas historicamente vulneraveis
# com identidades reais. Exit 0 so se TODAS as verificacoes passarem.
#
# Uso: bash scripts/test-seguranca-http.sh [cenarios]     ex.: bash scripts/test-seguranca-http.sh 1,5
# Pre-requisito: npm run db:local:up (migrations aplicadas). Nao precisa de reset entre rodadas:
# cada rodada cria dados com sufixo unico e remove tudo ao final.
source "$(dirname "$0")/_seguranca-http-common.sh"
trap seg_limpa EXIT

seg_carrega_supabase_local
seg_clona_fonte
seg_sobe_canario
seg_env_app
echo "[seguranca-http] build de producao do clone descartavel..."
seg_build_e_sobe || exit 2
seg_prova_isolamento
echo "[seguranca-http] app em $SEG_APP_URL | banco $SEG_API_URL | canario $SEG_CANARIO_URL (Anthropic NAO e usada)"
seg_roda_suite "${1:-}"
