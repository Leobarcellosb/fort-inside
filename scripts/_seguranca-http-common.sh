#!/usr/bin/env bash
# Funcoes compartilhadas de test-seguranca-http*.sh. Nao execute diretamente.
#
# Garantias deste harness (a ordem importa, nao relaxe):
#  1. O app NUNCA roda a partir do checkout real: roda de um CLONE descartavel, sem
#     .env.local (que aponta para producao). Todas as variaveis sensiveis sao
#     injetadas explicitamente e apontam para o Supabase LOCAL.
#  2. ANTHROPIC_API_KEY e FALSA e ANTHROPIC_BASE_URL aponta para um canario local:
#     nenhuma chamada ao modelo consegue sair da maquina nem gastar token.
#  3. So matamos processos que NOS subimos (PIDs rastreados). Nunca pkill por nome.

set -euo pipefail

SEG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEG_TMP=""
SEG_PIDS=()

seg_die() { echo "ERRO: $*" >&2; exit 2; }

seg_limpa() {
  local pid
  for pid in "${SEG_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  if [ -n "$SEG_TMP" ] && [ -d "$SEG_TMP" ] && [ -z "${SEG_HTTP_MANTER:-}" ]; then
    rm -rf "$SEG_TMP"
  elif [ -n "$SEG_TMP" ]; then
    echo "[manter] diretorio de trabalho preservado: $SEG_TMP"
  fi
}

seg_porta_livre() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# Le o stack local e recusa qualquer coisa que nao seja localhost.
seg_carrega_supabase_local() {
  command -v supabase >/dev/null 2>&1 || seg_die "Supabase CLI nao encontrada."
  [ -f "$SEG_ROOT/supabase/.temp/project-ref" ] && seg_die "checkout linkado a projeto remoto (supabase/.temp/project-ref); recuse."
  local saida
  saida="$(cd "$SEG_ROOT" && supabase status -o env 2>/dev/null)" || seg_die "Supabase local fora do ar. Rode: npm run db:local:up"
  SEG_API_URL="$(printf '%s\n' "$saida" | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
  SEG_ANON_KEY="$(printf '%s\n' "$saida" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
  SEG_SERVICE_KEY="$(printf '%s\n' "$saida" | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
  case "$SEG_API_URL" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) seg_die "API_URL nao e local ($SEG_API_URL); abortando por seguranca." ;;
  esac
  [ -n "$SEG_ANON_KEY" ] && [ -n "$SEG_SERVICE_KEY" ] || seg_die "chaves locais nao encontradas em 'supabase status'."
  # Banco alcancavel e com o schema esperado (migrations aplicadas)?
  local codigo
  codigo="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $SEG_SERVICE_KEY" -H "Authorization: Bearer $SEG_SERVICE_KEY" "$SEG_API_URL/rest/v1/events?select=id&limit=1" || true)"
  [ "$codigo" = "200" ] || seg_die "API local nao respondeu 200 em /rest/v1/events (got $codigo). Rode: npm run db:local:reset"
}

# Copia o working tree para um diretorio descartavel (sem .git, sem .next, sem .env*).
# node_modules e clonado com copy-on-write (APFS) quando possivel.
seg_clona_fonte() {
  SEG_TMP="$(mktemp -d "${TMPDIR:-/tmp}/seguranca-http.XXXXXX")"
  SEG_SRC="$SEG_TMP/app"
  mkdir -p "$SEG_SRC"
  (cd "$SEG_ROOT" && tar --exclude=./.git --exclude=./.next --exclude=./node_modules \
      --exclude='./.env*' --exclude=./graphify-out --exclude=./.claude -cf - .) | tar -xf - -C "$SEG_SRC"
  [ -d "$SEG_ROOT/node_modules" ] || seg_die "node_modules ausente; rode npm install."
  cp -Rc "$SEG_ROOT/node_modules" "$SEG_SRC/node_modules" 2>/dev/null || cp -R "$SEG_ROOT/node_modules" "$SEG_SRC/node_modules"
}

seg_sobe_canario() {
  local arq="$SEG_TMP/canario.porta"
  node "$SEG_ROOT/tests/seguranca-http/canario-anthropic.mjs" "$arq" >"$SEG_TMP/canario.log" 2>&1 &
  SEG_PIDS+=("$!"); disown "$!" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do [ -s "$arq" ] && break; sleep 0.1; done
  [ -s "$arq" ] || seg_die "canario nao subiu: $(cat "$SEG_TMP/canario.log")"
  SEG_CANARIO_URL="http://127.0.0.1:$(cat "$arq")"
}

# Ambiente injetado no build e no start. Precedencia: variavel de ambiente do
# processo vence qualquer .env* - e nao ha .env* no clone de qualquer forma.
seg_env_app() {
  export NEXT_PUBLIC_SUPABASE_URL="$SEG_API_URL"
  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SEG_ANON_KEY"
  export SUPABASE_SERVICE_ROLE_KEY="$SEG_SERVICE_KEY"
  export ANTHROPIC_API_KEY="sk-ant-FALSA-seguranca-http-nao-existe"
  export ANTHROPIC_BASE_URL="$SEG_CANARIO_URL"
  export NEXT_TELEMETRY_DISABLED=1
  unset ANTHROPIC_AUTH_TOKEN || true
}

# Build de producao + start no clone. Modo de producao e o que vai ao ar de verdade
# (o comportamento do proxy em dev pode diferir). Retorna !=0 (sem matar o script)
# se o build ou o start falharem: quem chama decide; falha aqui NUNCA e aprovacao.
seg_build_e_sobe() {
  local porta; porta="$(seg_porta_livre)"
  SEG_APP_URL="http://127.0.0.1:$porta"
  rm -rf "$SEG_SRC/.next"
  if ! ( cd "$SEG_SRC" && node node_modules/next/dist/bin/next build >"$SEG_TMP/build.log" 2>&1 ); then
    tail -40 "$SEG_TMP/build.log" >&2
    echo "ERRO: next build falhou (servidor nao subiu = NAO e aprovacao)." >&2
    return 1
  fi
  # node direto (sem npx): o PID rastreado E o do servidor, entao o kill nao deixa orfao.
  rm -f "$SEG_TMP/sonda.jsonl"
  ( cd "$SEG_SRC" && SEG_SONDA_ARQ="$SEG_TMP/sonda.jsonl" NODE_OPTIONS="--require $SEG_ROOT/tests/seguranca-http/sonda-ambiente.cjs" \
      exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$porta" >"$SEG_TMP/app.log" 2>&1 ) &
  SEG_APP_PID="$!"
  SEG_PIDS+=("$SEG_APP_PID"); disown "$SEG_APP_PID" 2>/dev/null || true
  local i codigo
  for i in $(seq 1 120); do
    codigo="$(curl -s -o /dev/null -w '%{http_code}' "$SEG_APP_URL/admin/login" || true)"
    [ "$codigo" = "200" ] && return 0
    sleep 0.5
  done
  tail -40 "$SEG_TMP/app.log" >&2
  echo "ERRO: app nao respondeu 200 em /admin/login (servidor fora do ar = NAO e aprovacao)." >&2
  return 1
}

# Prova de isolamento: a sonda (carregada no processo do servidor via NODE_OPTIONS)
# gravou o ambiente REAL do app. Recusa seguir se algo sensivel aponta para fora.
# (ps -E nao serve: o Next renomeia o titulo do processo e apaga o ambiente da vista.)
seg_prova_isolamento() {
  [ -s "$SEG_TMP/sonda.jsonl" ] || seg_die "sonda de ambiente nao gravou nada: nao da para provar o isolamento."
  local linha url base chave
  linha="$(tail -1 "$SEG_TMP/sonda.jsonl")"
  url="$(printf '%s' "$linha" | sed -n 's/.*"SUPABASE_URL":"\([^"]*\)".*/\1/p')"
  base="$(printf '%s' "$linha" | sed -n 's/.*"ANTHROPIC_BASE_URL":"\([^"]*\)".*/\1/p')"
  chave="$(printf '%s' "$linha" | sed -n 's/.*"ANTHROPIC_API_KEY_prefixo":"\([^"]*\)".*/\1/p')"
  echo "[isolamento] ambiente real do processo do app: SUPABASE_URL=$url | ANTHROPIC_BASE_URL=$base | ANTHROPIC_API_KEY=${chave}..."
  [ "$url" = "$SEG_API_URL" ] || seg_die "app NAO esta apontando para o Supabase local."
  [ "$base" = "$SEG_CANARIO_URL" ] || seg_die "app NAO esta apontando a Anthropic para o canario."
  case "$chave" in sk-ant-FALSA-*) ;; *) seg_die "ANTHROPIC_API_KEY do app nao e a chave falsa." ;; esac
}

seg_para_app() {
  [ -n "${SEG_APP_PID:-}" ] && kill "$SEG_APP_PID" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    kill -0 "${SEG_APP_PID:-0}" 2>/dev/null || break
    sleep 0.2
  done
  SEG_APP_PID=""
}

seg_roda_suite() {
  APP_URL="$SEG_APP_URL" SUPA_URL="$SEG_API_URL" ANON_KEY="$SEG_ANON_KEY" \
  SERVICE_KEY="$SEG_SERVICE_KEY" CANARIO_URL="$SEG_CANARIO_URL" CENARIOS="${1:-}" \
    node "$SEG_ROOT/tests/seguranca-http/suite.mjs"
}
