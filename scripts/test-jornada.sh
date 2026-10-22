#!/usr/bin/env bash
# Teste de jornada completa: convidado -> OTP -> 52 respostas -> conclusão no
# servidor -> pontuação -> fila -> documento entregue.
#
# Prova que as peças que passam ISOLADAMENTE funcionam JUNTAS. O defeito que
# motivou esta suíte nasceu no vão entre duas unidades corretas.
#
# Uso:  bash scripts/test-jornada.sh
# Pré-requisito: Supabase local de pé com as 17 migrations (npm run db:local:up).
# Não precisa de reset entre rodadas: cada rodada cria dados com sufixo único e
# remove tudo ao final. Exit 0 só se TODAS as verificações passarem.
#
# GARANTIAS (reaproveitadas de scripts/_seguranca-http-common.sh, sem alterá-lo):
#   1. O app NUNCA roda a partir do checkout real: roda de um CLONE descartável,
#      sem .env.local (que aponta para produção). Tudo é injetado e aponta para
#      o Supabase LOCAL.
#   2. ANTHROPIC_API_KEY é FALSA e ANTHROPIC_BASE_URL aponta para um canário
#      local que CONTA chamadas: nenhum token é gasto, e "zero chamadas" passa a
#      ser um número verificável.
#   3. Uma sonda dentro do processo do servidor confere o ambiente REAL e aborta
#      se algo sensível apontar para fora (seg_prova_isolamento).
#   4. Só matamos processos que NÓS subimos (PIDs rastreados).
#
# O QUE ESTE SCRIPT ACRESCENTA AO HARNESS COMPARTILHADO:
#   - DB_URL do stack local (a jornada precisa olhar o schema `auth`, que o
#     PostgREST não expõe: contagem de sessões e manifesto de migrations);
#   - CRON_SECRET só neste processo, para exercitar a porta do agendador de
#     /api/jobs/tick sem depender de nada configurado na Vercel;
#   - os módulos de pontuação (lib/scoring) compilados para CommonJS num
#     diretório temporário, a partir do MESMO clone que o app sob teste usa. A
#     jornada carrega o código de produção, não uma cópia: sabotar lib/scoring
#     quebra esta suíte.
source "$(dirname "$0")/_seguranca-http-common.sh"
trap seg_limpa EXIT

seg_carrega_supabase_local

# DB_URL: lido do mesmo `supabase status` e recusado se não for local.
JOR_DB_URL="$(cd "$SEG_ROOT" && supabase status -o env 2>/dev/null | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
[ -n "$JOR_DB_URL" ] || seg_die "DB_URL não encontrada em 'supabase status'."
case "$JOR_DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) seg_die "DB_URL não é local ($JOR_DB_URL); abortando por segurança." ;;
esac
command -v psql >/dev/null 2>&1 || seg_die "psql não encontrado (a jornada consulta o schema auth)."

seg_clona_fonte
seg_sobe_canario
seg_env_app

# Porta do agendador. O segredo nasce e morre nesta execução: não há CRON_SECRET
# de produção envolvido, e sem ele a porta do agendador simplesmente não existe
# (ver lib/jobs/autorizacao.ts).
export CRON_SECRET="jornada-cron-$(date +%s)-$RANDOM"

# Motor de pontuação e camada de linguagem, compilados do CLONE para CommonJS.
# CommonJS de propósito: o fonte usa import relativo sem extensão (".../marco-zero"),
# que o ESM do Node não resolve, e o `require` resolve. Sem isto a jornada teria
# de reimplementar a pontuação -- e aí não estaria provando o código que roda.
JOR_SCORING="$SEG_TMP/scoring"
echo "[jornada] compilando lib/scoring do clone para $JOR_SCORING..."
( cd "$SEG_SRC" && node node_modules/typescript/bin/tsc \
    lib/scoring/marco-zero.ts lib/scoring/achatar-respostas.ts lib/scoring/briefing-marco-zero.ts \
    --outDir "$JOR_SCORING" --module commonjs --target es2022 --strict --skipLibCheck \
    --moduleResolution node ) \
  || seg_die "falha ao compilar lib/scoring (sem o motor não há jornada; isto NÃO é aprovação)."

echo "[jornada] build de produção do clone descartável..."
seg_build_e_sobe || exit 2
seg_prova_isolamento
echo "[jornada] app em $SEG_APP_URL | banco $SEG_API_URL | canário $SEG_CANARIO_URL (Anthropic NÃO é usada)"

APP_URL="$SEG_APP_URL" \
SUPA_URL="$SEG_API_URL" \
ANON_KEY="$SEG_ANON_KEY" \
SERVICE_KEY="$SEG_SERVICE_KEY" \
CANARIO_URL="$SEG_CANARIO_URL" \
DB_URL="$JOR_DB_URL" \
SCORING_DIR="$JOR_SCORING" \
CRON_SECRET="$CRON_SECRET" \
  node "$SEG_ROOT/tests/jornada/jornada.mjs"
