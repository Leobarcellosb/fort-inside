#!/usr/bin/env bash
# db-security-alvo.sh -- constrói e destrói o ALVO DESCARTÁVEL da suíte de segurança do banco:
# uma instância Postgres em container, só dela, com fixtures próprias e limpeza independente.
#
#   db-security-alvo.sh up   [--fonte URL] [--nome NOME]   imprime: <container>\t<url>
#   db-security-alvo.sh down <container>
#
# POR QUE CLONE, E NÃO "SOBE DAS MIGRATIONS"
# Tentei primeiro scripts/drift/reference-db.sh (imagem do Supabase + supabase/migrations).
# Resultado MEDIDO: 10 verificações falharam, porque a imagem traz a versão ANTIGA de
# auth.uid() --  `current_setting('request.jwt.claim.sub')` -- enquanto o stack do Supabase CLI
# a substitui pela versão que também lê `request.jwt.claims` (JSON), que é a que as policies
# usam. Um alvo onde auth.uid() se comporta diferente não é alvo desta suíte: ou dá vermelho
# falso (foi o caso) ou, pior, poderia dar verde falso.
# A alternativa de definir auth.uid() à mão foi descartada: escrever a função de que as
# policies dependem para que o teste passe é o oposto de verificar.
# Então o alvo é um CLONE do banco que o próprio Supabase CLI construiu: schema de public e
# auth copiado com pg_dump (SOMENTE LEITURA na fonte) + dados de referência (quiz_stages, que
# o seed referencia por FK). No fim, uma CONFERÊNCIA DE FIDELIDADE compara policies, grants de
# tabela/view, grants de função e ACL do schema public, linha por linha: se o clone divergir
# da fonte em qualquer uma, este script FALHA (exit 2) em vez de entregar um alvo parecido.
#
# Exit 0 = alvo pronto. Exit 2 = não consegui construir/conferir (nunca "quase pronto").
# Nunca aponte --fonte para produção: é só leitura, mas a fonte precisa ser local e é exigido.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DB_SECURITY_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.106}"
FONTE_PADRAO="postgresql://postgres:postgres@127.0.0.1:54732/postgres"
PREFIXO="fort-dbsec-alvo"
# Senha de container local descartável. Não é credencial de nada.
SENHA_LOCAL="dbsec-local-only"
BANCO="alvo"
TRABALHO=""
# Dados de referência (não são massa de teste): o seed tem FK para as etapas do quiz.
TABELAS_REFERENCIA="public.quiz_stages"

die() { echo "db-security-alvo: BLOCKED -- $*" >&2; exit 2; }

exige_local() {
  local url="$1" hostpart host
  case "$url" in postgres://*|postgresql://*) ;; *) die "a fonte precisa ser URL postgres://" ;; esac
  case "$url" in *host=*|*hostaddr=*|*service=*|*passfile=*) die "a URL da fonte não pode ter host=/hostaddr=/service=/passfile=" ;; esac
  hostpart="${url#*://}"; hostpart="${hostpart##*@}"; hostpart="${hostpart%%/*}"
  case "$hostpart" in \[*\]*) host="${hostpart%%\]*}]" ;; *) host="${hostpart%%:*}" ;; esac
  case "$host" in 127.0.0.1|localhost|"[::1]") ;; *) die "fonte não local (host='$host'). Este script só clona banco local." ;; esac
}

# SQL da conferência de fidelidade: uma linha por objeto, para o diff dizer O QUE divergiu.
#
# Duas armadilhas CAÍDAS na primeira versão, e as duas davam divergência falsa:
#  (a) o texto de uma policy é renderizado com o search_path da sessão -- a mesma policy sai
#      "auth.uid()" num lado e "uid()" no outro, porque a imagem do Supabase põe `auth` no
#      search_path de supabase_admin. Daí o `set search_path = pg_catalog` explícito: os dois
#      lados renderizam tudo qualificado.
#  (b) ACL é array ORDENADO: conceder o mesmo privilégio em outra ordem muda o texto. Daí
#      aclexplode: uma linha por (objeto, beneficiário, privilégio), que o sort normaliza.
# Nenhuma das duas afrouxa a comparação -- ambas comparam MAIS coisa, só sem o artefato.
FIDELIDADE_SQL="
set search_path = pg_catalog;
select 'policy|' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual,'') || '|' || coalesce(with_check,'')
  from pg_policies where schemaname = 'public'
union all
select 'relrls|' || c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || coalesce(c.reloptions::text,'')
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v')
union all
select 'relacl|' || c.relname || '|' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || '|' || a.privilege_type
  from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v')
union all
select 'proacl|' || p.proname || '|' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || '|' || a.privilege_type
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where p.pronamespace = 'public'::regnamespace
union all
select 'prosec|' || p.proname || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '')
  from pg_proc p where p.pronamespace = 'public'::regnamespace
union all
select 'nspacl|' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || '|' || a.privilege_type
  from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
 where n.nspname = 'public'"

espera_pronto() {
  local c="$1" i
  # pg_isready não basta: a imagem sobe um postgres temporário durante o init. Espera o init
  # terminar (role authenticator existir), como scripts/drift/reference-db.sh faz.
  # 300s, não 90/120: medido neste Mac com o Docker carregado, o init da imagem do Supabase
  # (são ~100 migrations de plataforma) passou de 4 minutos. Teto generoso é melhor que um
  # BLOCKED por impaciência -- e, estourado o teto, isto FALHA, nunca segue com meio alvo.
  for i in $(seq 1 300); do
    if docker exec "$c" psql -U postgres -h 127.0.0.1 -d postgres -Atc \
         "select 1 from pg_roles where rolname = 'authenticator'" 2>/dev/null | grep -q 1; then
      return 0
    fi
    sleep 1
  done
  die "o container $c não ficou pronto em 120s"
}

up() {
  local fonte="$FONTE_PADRAO" nome="$PREFIXO-$$-$RANDOM" tmp porta url faltando sql
  while [ $# -gt 0 ]; do
    case "$1" in
      --fonte) fonte="${2:-}"; shift 2 ;;
      --nome)  nome="${2:-}"; shift 2 ;;
      *) die "opção desconhecida: $1" ;;
    esac
  done
  case "$nome" in "$PREFIXO"*) ;; *) die "o nome do container precisa começar com '$PREFIXO' (é o que permite destruir só o que é nosso)." ;; esac
  command -v docker  >/dev/null 2>&1 || die "docker não encontrado"
  command -v psql    >/dev/null 2>&1 || die "psql não encontrado"
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump não encontrado"
  exige_local "$fonte"
  export PGCONNECT_TIMEOUT=15

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/db-security-alvo.XXXXXX")" || die "mktemp falhou"
  # O trap roda DEPOIS de up() retornar, quando `tmp` (local) já saiu de escopo: com set -u
  # isso virava "tmp: unbound variable" na saída e o diretório ficava para trás. A variável
  # global TRABALHO existe só para o trap ter o que apagar.
  TRABALHO="$tmp"
  trap 'rm -rf "${TRABALHO:-}"' EXIT

  psql -X -q -At -v ON_ERROR_STOP=1 "$fonte" -c "select 1" >/dev/null 2>"$tmp/err" \
    || die "não consegui ler a fonte: $(head -1 "$tmp/err"). Suba o banco local: npm run db:local:up"

  # pg_dump se RECUSA a ler servidor mais novo que ele. Se isso acontecer, tem de aparecer
  # aqui, com o conserto, e não como erro solto no meio da restauração.
  local v_dump v_srv
  v_dump="$(pg_dump --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  v_srv="$(psql -X -At "$fonte" -c "select current_setting('server_version_num')::int / 10000" 2>/dev/null)"
  if [ -n "$v_dump" ] && [ -n "$v_srv" ] && [ "$v_dump" -lt "$v_srv" ] 2>/dev/null; then
    die "pg_dump é da versão $v_dump e a fonte é Postgres $v_srv: pg_dump não lê servidor mais novo. Instale o cliente $v_srv (macOS: brew install postgresql@$v_srv ; Ubuntu: repositório PGDG postgresql-client-$v_srv)."
  fi

  echo "db-security-alvo: subindo instância descartável ($IMAGE)" >&2
  docker run -d --name "$nome" -e POSTGRES_PASSWORD="$SENHA_LOCAL" -p 127.0.0.1::5432 "$IMAGE" >/dev/null \
    || die "docker run falhou"
  espera_pronto "$nome"
  porta="$(docker port "$nome" 5432/tcp | head -1 | sed 's/.*://')"
  [ -n "$porta" ] || { docker rm -f "$nome" >/dev/null 2>&1; die "não descobri a porta publicada do container."; }
  url="postgresql://postgres:${SENHA_LOCAL}@127.0.0.1:${porta}/${BANCO}"

  # 1. Papéis que a fonte tem e a imagem não (sem senha nenhuma: só o esqueleto de papel).
  psql -X -At "$fonte" -c "select rolname from pg_roles order by 1" >"$tmp/papeis-fonte" 2>"$tmp/err" \
    || { docker rm -f "$nome" >/dev/null 2>&1; die "não consegui listar os papéis da fonte: $(head -1 "$tmp/err")"; }
  [ -s "$tmp/papeis-fonte" ] || { docker rm -f "$nome" >/dev/null 2>&1; die "a lista de papéis da fonte voltou vazia -- recuso seguir com estrutura vazia."; }
  docker exec "$nome" psql -U postgres -h 127.0.0.1 -d postgres -Atc "select rolname from pg_roles order by 1" >"$tmp/papeis-alvo" 2>/dev/null
  # comm exige ordenação do shell, não a do Postgres (collation pode diferir).
  LC_ALL=C sort -o "$tmp/papeis-fonte" "$tmp/papeis-fonte"
  LC_ALL=C sort -o "$tmp/papeis-alvo" "$tmp/papeis-alvo"
  faltando="$(comm -23 "$tmp/papeis-fonte" "$tmp/papeis-alvo")"
  if [ -n "$faltando" ]; then
    echo "db-security-alvo: criando papéis que faltam no alvo: $(echo "$faltando" | tr '\n' ' ')" >&2
    printf '%s\n' "$faltando" | while IFS= read -r p; do
      [ -z "$p" ] && continue
      sql="$(psql -X -At "$fonte" -c "select format('create role %I%s%s%s%s nologin;', rolname,
                 case when rolsuper then ' superuser' else '' end,
                 case when rolinherit then ' inherit' else ' noinherit' end,
                 case when rolcreaterole then ' createrole' else '' end,
                 case when rolbypassrls then ' bypassrls' else '' end)
               from pg_roles where rolname = '$p'")"
      [ -n "$sql" ] || continue
      docker exec "$nome" psql -U supabase_admin -h 127.0.0.1 -d postgres -Atq -v ON_ERROR_STOP=1 -c "$sql" >/dev/null \
        || echo "db-security-alvo: AVISO -- não criei o papel $p (se o schema depender dele, a restauração abaixo FALHA e este script aborta)" >&2
    done
  fi

  # 2. Banco virgem (template0: o template1 da imagem já traz schemas da plataforma), dono
  #    postgres -- é de pg_database_owner que o schema public herda o CREATE, e o cenário 0
  #    cria uma tabela descartável lá.
  docker exec "$nome" psql -U supabase_admin -h 127.0.0.1 -d postgres -Atq -v ON_ERROR_STOP=1 \
      -c "create database \"$BANCO\" owner postgres template template0" >/dev/null 2>"$tmp/err" \
    || { docker rm -f "$nome" >/dev/null 2>&1; die "não consegui criar o banco $BANCO: $(head -1 "$tmp/err")"; }
  docker exec "$nome" psql -U supabase_admin -h 127.0.0.1 -d "$BANCO" -Atq -v ON_ERROR_STOP=1 \
      -c "drop schema public cascade" >/dev/null 2>&1

  # 3. Schema de public e auth, vindo da FONTE (pg_dump só lê).
  pg_dump --schema-only -n public -n auth "$fonte" >"$tmp/schema.sql" 2>"$tmp/err" \
    || { docker rm -f "$nome" >/dev/null 2>&1; die "pg_dump do schema falhou: $(head -1 "$tmp/err")"; }
  [ -s "$tmp/schema.sql" ] || { docker rm -f "$nome" >/dev/null 2>&1; die "o dump do schema saiu vazio."; }
  docker exec -i "$nome" psql -U supabase_admin -h 127.0.0.1 -d "$BANCO" -q -v ON_ERROR_STOP=1 -f - \
      <"$tmp/schema.sql" >/dev/null 2>"$tmp/err" \
    || { docker rm -f "$nome" >/dev/null 2>&1; die "a restauração do schema falhou: $(tail -2 "$tmp/err" | tr '\n' ' ')"; }

  # pg_dump não carrega o USAGE de PUBLIC no schema public (é "default" na origem dele). Sem
  # isto o clone fica MAIS restrito que a fonte; a conferência de fidelidade abaixo pegaria.
  docker exec "$nome" psql -U supabase_admin -h 127.0.0.1 -d "$BANCO" -Atq -v ON_ERROR_STOP=1 \
      -c "grant usage on schema public to public" >/dev/null 2>&1

  # 4. Dados de referência (FK do seed).
  local t
  for t in $TABELAS_REFERENCIA; do
    pg_dump --data-only --table="$t" "$fonte" >"$tmp/ref.sql" 2>"$tmp/err" \
      || { docker rm -f "$nome" >/dev/null 2>&1; die "pg_dump de $t falhou: $(head -1 "$tmp/err")"; }
    docker exec -i "$nome" psql -U supabase_admin -h 127.0.0.1 -d "$BANCO" -q -v ON_ERROR_STOP=1 -f - \
        <"$tmp/ref.sql" >/dev/null 2>"$tmp/err" \
      || { docker rm -f "$nome" >/dev/null 2>&1; die "não consegui copiar os dados de referência de $t: $(tail -1 "$tmp/err")"; }
    local n
    n="$(psql -X -At "$url" -c "select count(*) from $t" 2>/dev/null)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null \
      || { docker rm -f "$nome" >/dev/null 2>&1; die "$t ficou sem linhas no alvo: o seed tem FK para ela e a suíte não teria como rodar."; }
  done

  # 5. Conferência de fidelidade: policies, RLS, grants, security definer e ACL do schema.
  # Os dois lados são lidos pelo MESMO cliente (psql do host) e com o MESMO search_path, para
  # que uma divergência de verdade não se esconda atrás de diferença de renderização.
  psql -X -At "$fonte" -c "$FIDELIDADE_SQL" 2>"$tmp/err" | sort >"$tmp/fid-fonte"
  psql -X -At "$url"   -c "$FIDELIDADE_SQL" 2>/dev/null   | sort >"$tmp/fid-alvo"
  [ -s "$tmp/fid-fonte" ] || { docker rm -f "$nome" >/dev/null 2>&1; die "a leitura de fidelidade da fonte voltou vazia -- recuso entregar alvo não conferido."; }
  if ! diff "$tmp/fid-fonte" "$tmp/fid-alvo" >"$tmp/fid.diff" 2>&1; then
    echo "db-security-alvo: o clone DIVERGIU da fonte:" >&2
    head -20 "$tmp/fid.diff" >&2
    docker rm -f "$nome" >/dev/null 2>&1
    die "alvo descartável reprovado na conferência de fidelidade ($(grep -c '^[<>]' "$tmp/fid.diff") linha(s) divergente(s)). Um alvo parecido não serve."
  fi
  echo "db-security-alvo: fidelidade conferida -- $(wc -l <"$tmp/fid-fonte" | tr -d ' ') objetos (policies, grants de tabela/view, grants de função, ACL do schema) idênticos à fonte" >&2

  printf '%s\t%s\n' "$nome" "$url"
}

down() {
  [ $# -eq 1 ] || die "uso: down <container>"
  # NUNCA remover container de outra pessoa: só o nosso prefixo.
  case "$1" in
    "$PREFIXO"*) docker rm -f "$1" >/dev/null 2>&1 || die "não consegui remover $1" ;;
    *) die "recuso remover container fora do prefixo '$PREFIXO': $1" ;;
  esac
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  up)   up "$@" ;;
  down) down "$@" ;;
  *)    die "uso: db-security-alvo.sh up [--fonte URL] [--nome NOME] | down <container>" ;;
esac
