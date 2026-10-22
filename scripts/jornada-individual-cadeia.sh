#!/usr/bin/env bash
# jornada-individual-cadeia.sh -- percorre a CADEIA POS-COLETA do documento
# individual (resposta -> identidade -> scoring -> geracao -> revisao -> entrega)
# contra um stack DESCARTAVEL proprio, e imprime o que mediu.
#
#   bash scripts/jornada-individual-cadeia.sh
#   JORNADA_MANTER=1 bash scripts/jornada-individual-cadeia.sh   (nao destroi o stack)
#
# Exit: 0 = a cadeia foi percorrida e a medicao esta na saida
#       2 = BLOCKED: nao deu para construir o stack (nao e veredito do produto)
#
# O STACK QUE ELE CONSTROI, E POR QUE ASSIM
# -----------------------------------------
#   Postgres   descartavel, nome unico, construido pelas MESMAS migrations de
#              supabase/migrations/ (scripts/drift/reference-db.sh).
#   PostgREST  de verdade na frente dele: e o PostgREST que valida o JWT e o
#              Postgres que aplica a RLS. Sem isso a prova mediria um mock.
#   proxy      scripts/jornada-individual/proxy-supabase.mjs, o unico papel do
#              Kong que o caminho sob teste usa (tirar o prefixo /rest/v1).
#   canario    lib/ai/provas/canario-roteirizado.mjs no lugar da Anthropic, com
#              chave FALSA e contador de chamadas. Nenhum token e gasto.
#
# O QUE ELE NAO CONSTROI, DE PROPOSITO (e o relatorio diz)
#   GoTrue  -- o JWT do participante e assinado na prova. A EMISSAO de sessao
#              (OTP, e-mail) nao e exercitada; a RLS que o token ativa, sim.
#   Next    -- as rotas nao sao servidas. Ver o cabecalho do arquivo de teste.
#   Storage -- sem PDF. `pdf_url` e conferido nulo.
#
# NUNCA aponta para producao: o alvo nasce aqui, com nome unico, e morre no fim.
# Nenhum banco existente e tocado, nem para ler.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALVO_SH="$RAIZ/scripts/drift/reference-db.sh"
PROXY_MJS="$RAIZ/scripts/jornada-individual/proxy-supabase.mjs"
CANARIO_MJS="$RAIZ/lib/ai/provas/canario-roteirizado.mjs"
CONFIG="$RAIZ/scripts/jornada-individual/vitest.cadeia.config.mts"

SUFIXO="$$-$RANDOM"
NOME_DB="fort-drift-jornada-ind-$SUFIXO"
NOME_REST="fort-jornada-rest-$SUFIXO"
NOME_REDE="fort-jornada-net-$SUFIXO"
IMAGEM_REST="${JORNADA_POSTGREST_IMAGE:-public.ecr.aws/supabase/postgrest:v14.8}"
SENHA_AUTH="jornada-local-only"

CONTAINER=""; REST=""; REDE=""; TRABALHO=""; PID_PROXY=""; PID_CANARIO=""

die() { echo "jornada: BLOCKED -- $*" >&2; exit 2; }

limpa() {
  [ -n "$PID_PROXY" ] && kill "$PID_PROXY" 2>/dev/null
  [ -n "$PID_CANARIO" ] && kill "$PID_CANARIO" 2>/dev/null
  if [ -n "${JORNADA_MANTER:-}" ]; then
    echo "jornada: JORNADA_MANTER=1 -- stack de pe: db=$CONTAINER rest=$REST rede=$REDE" >&2
  else
    # Pelos NOMES EXATOS que este script criou. Nunca por prefixo, nunca em massa.
    [ -n "$REST" ] && docker rm -f "$REST" >/dev/null 2>&1
    [ -n "$CONTAINER" ] && bash "$ALVO_SH" down "$CONTAINER" >/dev/null 2>&1
    [ -n "$REDE" ] && docker network rm "$REDE" >/dev/null 2>&1
  fi
  [ -n "$TRABALHO" ] && rm -rf "$TRABALHO"
}
trap limpa EXIT INT TERM

for f in "$ALVO_SH" "$PROXY_MJS" "$CANARIO_MJS" "$CONFIG"; do
  [ -f "$f" ] || die "falta $f"
done
for c in docker psql npx node; do
  command -v "$c" >/dev/null 2>&1 || die "$c nao encontrado"
done

TRABALHO="$(mktemp -d "${TMPDIR:-/tmp}/jornada-individual.XXXXXX")" || die "mktemp falhou"

echo "== 1/6 Postgres descartavel pelas migrations de supabase/migrations/ =="
# A maquina pode estar saturada: a imagem leva minutos no proprio init e o
# wait_ready de reference-db.sh desiste em 90s. Por isso: sobe, espera de
# verdade, e aplica as migrations aqui, anunciando cada nova tentativa.
LINHA="$(bash "$ALVO_SH" up-empty --name "$NOME_DB" 2>"$TRABALHO/alvo.err")" \
  || die "nao consegui subir o Postgres: $(tail -3 "$TRABALHO/alvo.err" | tr '\n' ' ')"
CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"
URL="$(printf '%s' "$LINHA" | cut -f2)"
[ "$CONTAINER" = "$NOME_DB" ] || die "container criado ($CONTAINER) nao e o nome pedido ($NOME_DB)"
case "$URL" in *@127.0.0.1:*|*@localhost:*) ;; *) die "o alvo nao e local ($URL)" ;; esac
echo "   db: $CONTAINER"

pronto=0
for i in $(seq 1 120); do
  if PGCONNECT_TIMEOUT=20 psql -X -Atc "select 1" "$URL" >/dev/null 2>&1; then pronto=1; break; fi
  [ $((i % 10)) -eq 0 ] && echo "   [aviso] banco ainda em init ($((i * 5))s); maquina saturada, seguindo"
  sleep 5
done
[ "$pronto" = 1 ] || die "o Postgres nao aceitou conexao em 600s (saturacao, nao defeito do produto)"

echo "== 2/6 migrations (cada nova tentativa e anunciada) =="
for f in $(ls "$RAIZ"/supabase/migrations/*.sql | sort); do
  n="$(basename "$f")"; ok=0
  for t in 1 2 3; do
    if PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$f" "$URL" >"$TRABALHO/mig.err" 2>&1; then
      ok=1; break
    fi
    echo "   [aviso] $n nova tentativa $t/3: $(tail -2 "$TRABALHO/mig.err" | tr '\n' ' ' | cut -c1-140)"
  done
  [ "$ok" = 1 ] || die "migration falhou: $n"
done
echo "   24 migrations aplicadas"

echo "== 3/6 PostgREST de verdade na frente do banco =="
# O authenticator vem com statement_timeout=8s; sob saturacao a consulta do
# cache de schema do PostgREST nao cabe nisso. O teto e afrouxado SO neste
# container descartavel, e isto esta declarado no relatorio: nao e o valor de
# producao e nenhuma regra do produto depende dele.
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -Atc \
  "alter role authenticator with login password '$SENHA_AUTH';
   alter role authenticator set statement_timeout = '120s';
   alter role authenticator set lock_timeout = '60s';" >/dev/null 2>&1 \
  || die "nao consegui preparar o papel authenticator"

# PARIDADE COM A PLATAFORMA, nao mudanca de produto.
# `auth.uid()` NAO esta em supabase/migrations/: e a plataforma Supabase que a
# fornece. A imagem descartavel traz uma versao ANTIGA, que le so o GUC legado
# `request.jwt.claim.sub`; o PostgREST 14 removeu `db-use-legacy-gucs` e publica
# apenas `request.jwt.claims` (JSON). Sem este ajuste `auth.uid()` devolve NULL,
# TODA policy de participante recusa, e a prova mediria "nao consegui verificar"
# acreditando medir "negado" -- justamente a confusao que esta unidade existe
# para nao cometer. O corpo abaixo e o da plataforma: le o GUC legado e, na
# falta dele, a claim `sub` do JSON.
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -Atc "
create or replace function auth.uid() returns uuid language sql stable as \$f\$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
\$f\$;
create or replace function auth.role() returns text language sql stable as \$f\$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
\$f\$;" >/dev/null 2>&1 || die "nao consegui instalar o auth.uid() da plataforma"

SEGREDO="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
docker network create "$NOME_REDE" >/dev/null 2>&1 || die "nao consegui criar a rede"
REDE="$NOME_REDE"
docker network connect "$NOME_REDE" "$CONTAINER" >/dev/null 2>&1 \
  || die "nao consegui ligar o banco a rede"
docker run -d --name "$NOME_REST" --network "$NOME_REDE" -p 127.0.0.1::3000 \
  -e PGRST_DB_URI="postgres://authenticator:$SENHA_AUTH@$CONTAINER:5432/postgres" \
  -e PGRST_DB_SCHEMAS="public" \
  -e PGRST_DB_ANON_ROLE="anon" \
  -e PGRST_JWT_SECRET="$SEGREDO" \
  -e PGRST_DB_USE_LEGACY_GUCS="true" \
  "$IMAGEM_REST" >/dev/null 2>&1 || die "nao consegui subir o PostgREST"
  # PGRST_DB_USE_LEGACY_GUCS=true: a imagem descartavel traz o `auth.uid()`
  # ANTIGO, que le so o GUC `request.jwt.claim.sub`; o PostgREST 14 por padrao
  # publica apenas `request.jwt.claims` (JSON), e entao `auth.uid()` devolveria
  # NULL e TODA policy de participante recusaria -- "nao consegui verificar"
  # vestido de "negado". O modo legado publica os dois GUCs. Isto e configuracao
  # DO STACK: nenhuma linha de `supabase/migrations/` foi alterada, e no Supabase
  # de verdade a plataforma ja traz o `auth.uid()` que le `request.jwt.claims`.
REST="$NOME_REST"
PORTA_REST="$(docker port "$NOME_REST" 3000/tcp | head -1 | sed 's/.*://')"
[ -n "$PORTA_REST" ] || die "PostgREST sem porta publicada"

vivo=0
for i in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA_REST/events")" = "200" ]; then
    vivo=1; break
  fi
  [ $((i % 10)) -eq 0 ] && echo "   [aviso] PostgREST ainda carregando o cache de schema ($((i * 5))s)"
  sleep 5
done
[ "$vivo" = 1 ] || die "PostgREST nao respondeu 200 em 200s: $(docker logs --tail 3 "$NOME_REST" 2>&1 | tr '\n' ' ')"
echo "   postgrest: 127.0.0.1:$PORTA_REST"

echo "== 4/6 fachada /rest/v1 (o unico papel do Kong que a cadeia usa) =="
node "$PROXY_MJS" "http://127.0.0.1:$PORTA_REST" "$TRABALHO/porta-proxy" \
  >"$TRABALHO/proxy.log" 2>&1 &
PID_PROXY=$!
for _ in $(seq 1 50); do [ -s "$TRABALHO/porta-proxy" ] && break; sleep 0.2; done
[ -s "$TRABALHO/porta-proxy" ] || die "o proxy nao subiu: $(cat "$TRABALHO/proxy.log")"
SUPA_URL="http://127.0.0.1:$(cat "$TRABALHO/porta-proxy")"
echo "   supabase url: $SUPA_URL"

echo "== 5/6 canario no lugar da Anthropic (chave FALSA, chamadas CONTADAS) =="
node "$CANARIO_MJS" "$TRABALHO/porta-canario" >"$TRABALHO/canario.log" 2>&1 &
PID_CANARIO=$!
for _ in $(seq 1 50); do [ -s "$TRABALHO/porta-canario" ] && break; sleep 0.2; done
[ -s "$TRABALHO/porta-canario" ] || die "o canario nao subiu: $(cat "$TRABALHO/canario.log")"
CANARIO_URL="http://127.0.0.1:$(cat "$TRABALHO/porta-canario")"
# CONTROLE POSITIVO do instrumento: um POST direto tem de elevar a contagem.
curl -s -X POST "$CANARIO_URL/__canario/zerar" >/dev/null
curl -s -X POST "$CANARIO_URL/v1/messages" -H 'content-type: application/json' -d '{}' >/dev/null
CONTAGEM="$(curl -s "$CANARIO_URL/__canario/contagem" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))')"
[ "$CONTAGEM" = "1" ] || die "o canario nao conta (contagem=$CONTAGEM): instrumento cego nao vale como prova"
curl -s -X POST "$CANARIO_URL/__canario/zerar" >/dev/null
echo "   canario: $CANARIO_URL (controle positivo ok: contou 1)"

# Chaves do stack: JWT assinados com o segredo do PostgREST deste container.
chave() { node -e '
  const {createHmac}=require("crypto");
  const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const agora=Math.floor(Date.now()/1000);
  const h=b64({alg:"HS256",typ:"JWT"});
  const p=b64({role:process.argv[1],iat:agora,exp:agora+86400});
  console.log(`${h}.${p}.`+createHmac("sha256",process.argv[2]).update(`${h}.${p}`).digest("base64url"));
' "$1" "$SEGREDO"; }

echo "== 6/6 a cadeia, elo por elo =="
JORNADA_SUPA_URL="$SUPA_URL" \
JORNADA_SERVICE_KEY="$(chave service_role)" \
JORNADA_ANON_KEY="$(chave anon)" \
JORNADA_JWT_SECRET="$SEGREDO" \
JORNADA_CANARIO_URL="$CANARIO_URL" \
JORNADA_PG_URL="$URL" \
  env -u ANTHROPIC_AUTH_TOKEN npx vitest run --root "$RAIZ" --config "$CONFIG" --reporter=verbose
RC=$?

[ "$RC" -eq 0 ] || echo "jornada: o comparador reprovou -- ver qual elo acima" >&2
exit "$RC"
