#!/usr/bin/env bash
# rodar-028.sh -- prova da TRAVA DA LIBERACAO DE ETAPA (migration 028).
#
#   bash supabase/provas/rodar-028.sh
#   bash supabase/provas/rodar-028.sh --manter   (deixa o container de pe)
#
# Exit: 0 = provado   1 = FALHOU   2 = BLOCKED (nao deu para construir o alvo)
#
# O QUE ESTA PROVA MEDE, E POR QUE ELA EXISTE
# -------------------------------------------
# A unidade anterior isolou o painel ao vivo: num evento cujas etapas nao sao
# numeradas de 1 a N, ele deixou de OFERECER "liberar etapa". A revisao aprovou e
# pediu mais -- "verificar expressamente o bloqueio por MODO no ENDPOINT" --, e a
# medicao mostrou que ela tinha razao: nao havia rota no caminho (o painel grava
# direto na tabela pelo navegador) e nao havia gatilho, CHECK nem restricao
# nenhuma sobre `current_stage`. A contencao era SO DE INTERFACE.
#
# Esta prova e, de proposito, feita nas DUAS metades, no MESMO banco:
#
#   ANTES da 028  -- a gravacao invalida PASSA. Sem esta metade a prova nao
#                    distingue "a trava funciona" de "isto nunca foi possivel".
#   DEPOIS da 028 -- a MESMA gravacao e RECUSADA, com o nome do fato.
#
# E o controle que impede isto de virar "recusa tudo", que e o unico jeito de uma
# trava ser pior que a ausencia dela: evento AO VIVO da versao ANTIGA (v1)
# liberando etapa 1..6 normalmente, no mesmo banco, DEPOIS da trava.
#
# A sessao e a do NAVEGADOR DO HOST: role `authenticated` com claim de
# administrador (o que `is_admin()` exige), nunca superusuario. Uma prova feita
# como `postgres` mediria outra coisa.
#
# NUNCA aponta para producao: o alvo nasce aqui, com nome unico, e morre no fim.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALVO_SH="$RAIZ/scripts/drift/reference-db.sh"
MIGRATION="$RAIZ/supabase/migrations/028_liberacao_de_etapa_no_banco.sql"
# Prefixo `fort-drift-`: e o unico que `reference-db.sh down` aceita remover, de
# proposito. Nome fora dele deixaria o container de pe.
NOME="fort-drift-prova-028-$$-$RANDOM"
CONTAINER=""; FALHAS=0

die() { echo "028: BLOCKED -- $*" >&2; exit 2; }
limpa() {
  if [ -n "${MANTER:-}" ]; then
    echo "028: --manter -- container de pe: $CONTAINER" >&2
  else
    [ -n "$CONTAINER" ] && bash "$ALVO_SH" down "$CONTAINER" >/dev/null 2>&1
  fi
}
trap limpa EXIT INT TERM
[ "${1:-}" = "--manter" ] && MANTER=1

# Toda consulta de prova roda COMO O NAVEGADOR DO HOST: `authenticated` + claim de
# admin. O `set local` morre no fim da transacao, entao cada chamada e isolada.
COMO_HOST="set local role authenticated;
select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"app_metadata\":{\"role\":\"admin\"}}', true);"

q() { PGCONNECT_TIMEOUT=60 psql -X -Atc "$1" "$URL"; }
# Executa como host, numa transacao, e devolve a saida (inclusive a mensagem de erro).
host() {
  PGCONNECT_TIMEOUT=60 psql -X -Atc "begin; $COMO_HOST $1; commit;" "$URL" 2>&1 \
    | grep -v -E '^(BEGIN|COMMIT|ROLLBACK|SET|INSERT|UPDATE|DELETE)( [0-9]+)*$' \
    | grep -v '^{"role"' | tr -d '\n'
}
exige() { # nome, esperado, obtido
  if [ "$2" = "$3" ]; then
    echo "   PASS  $1"
  else
    echo "   FAIL  $1: esperado [$2], obtido [$3]"; FALHAS=$((FALHAS + 1))
  fi
}
# A gravacao PASSOU? (etapa gravada == etapa pedida)
etapa_de() { q "select current_stage from public.events where event_code = '$1'"; }
exige_gravou() { # rotulo, event_code, etapa pedida
  host "update public.events set current_stage = $3 where event_code = '$2'" >/dev/null
  exige "$1" "$3" "$(etapa_de "$2")"
}
# A gravacao foi RECUSADA, nomeando ESTE fato? E nada foi gravado?
exige_recusou() { # rotulo, event_code, etapa pedida, fato esperado
  local antes saida
  antes="$(etapa_de "$2")"
  saida="$(host "update public.events set current_stage = $3 where event_code = '$2'")"
  case "$saida" in
    *"$4"*) echo "   PASS  $1 (fato: $4)" ;;
    *) echo "   FAIL  $1: nao recusou com '$4'. Saida: $saida"; FALHAS=$((FALHAS + 1)) ;;
  esac
  exige "   ...e nada foi gravado ($2 segue na etapa $antes)" "$antes" "$(etapa_de "$2")"
}

[ -f "$ALVO_SH" ] || die "falta $ALVO_SH"
[ -f "$MIGRATION" ] || die "falta $MIGRATION"
for c in docker psql; do command -v "$c" >/dev/null || die "$c nao encontrado"; done

echo "== 1/6 Postgres descartavel =="
LINHA="$(bash "$ALVO_SH" up-empty --name "$NOME" 2>/dev/null)" || die "nao subiu o Postgres"
CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"
URL="$(printf '%s' "$LINHA" | cut -f2)"
case "$URL" in *@127.0.0.1:*|*@localhost:*) ;; *) die "o alvo nao e local" ;; esac
for i in $(seq 1 120); do q "select 1" >/dev/null 2>&1 && break; sleep 5; done
q "select 1" >/dev/null 2>&1 || die "o Postgres nao aceitou conexao (saturacao, nao defeito do produto)"
echo "   db: $CONTAINER"

echo "== 2/6 migrations 001..027 (o banco COMO ERA ANTES da 028) =="
for f in $(ls "$RAIZ"/supabase/migrations/*.sql | sort); do
  case "$(basename "$f")" in 028_*) continue ;; esac
  ok=0
  for t in 1 2 3; do
    PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$f" "$URL" >/dev/null 2>&1 && { ok=1; break; }
    echo "   [aviso] $(basename "$f") nova tentativa $t/3"
  done
  [ "$ok" = 1 ] || die "migration falhou: $(basename "$f")"
done
echo "   aplicadas"

# Os tres eventos da medicao. Os numeros de etapa vem das etapas CADASTRADAS:
# v1 tem 6 (migration 010, backfill stage_number = id); v2 tem 5 (017).
q "
insert into public.events (id, name, event_code, event_date, status, current_stage, mode, quiz_version) values
  ('aaaaaaaa-0000-4000-8000-000000000001','MZ assincrono (o de sabado)','MZ-ASYNC', now(), 'live', 0, 'async', 2),
  ('aaaaaaaa-0000-4000-8000-000000000002','MZ ao vivo (v2, 5 etapas)','MZ-LIVE',  now(), 'live', 0, 'live',  2),
  ('aaaaaaaa-0000-4000-8000-000000000003','Fort Inside antigo (v1, 6 etapas)','FI-LIVE', now(), 'live', 0, 'live', 1);
" >/dev/null 2>&1 || die "nao consegui semear os eventos da medicao"
exige "v1 tem 6 etapas cadastradas" "6" "$(q "select count(*) from public.quiz_stages where quiz_version = 1")"
exige "v2 tem 5 etapas cadastradas" "5" "$(q "select count(*) from public.quiz_stages where quiz_version = 2")"
exige "antes da 028 nao ha gatilho de liberacao de etapa" "0" \
  "$(q "select count(*) from pg_trigger t where t.tgrelid='public.events'::regclass and t.tgname='events_liberacao_de_etapa'")"
exige "antes da 028 nao ha CHECK sobre current_stage" "0" \
  "$(q "select count(*) from pg_constraint where conrelid='public.events'::regclass and contype='c' and pg_get_constraintdef(oid) like '%current_stage%'")"

echo "== 3/6 ANTES da 028: a gravacao invalida PASSA (o defeito, medido) =="
# Sem esta secao a prova nao distingue "a trava funciona" de "isto nunca foi
# possivel". Cada linha abaixo e uma afirmacao falsa que o banco aceitou.
exige_gravou "etapa 6 num evento de CINCO etapas e aceita" "MZ-LIVE" 6
exige_gravou "etapa 3 num evento ASSINCRONO e aceita" "MZ-ASYNC" 3
exige_gravou "etapa 99 e aceita" "MZ-LIVE" 99
exige_gravou "etapa -4 e aceita" "FI-LIVE" -4

echo "== 4/6 a 028, aplicada em cima desse banco (com linhas JA tortas) =="
PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION" "$URL" >/dev/null 2>&1 \
  || { echo "   FAIL  a 028 nao aplicou sobre banco com dados"; exit 1; }
exige "o gatilho existe" "1" \
  "$(q "select count(*) from pg_trigger t where t.tgrelid='public.events'::regclass and t.tgname='events_liberacao_de_etapa'")"
# A PROPRIEDADE QUE IMPORTA MAIS QUE A TRAVA: aplicar a migration nao pode travar
# escrita que hoje funciona. As linhas tortas semeadas acima continuam de pe e
# continuam editaveis -- nao ha `validate constraint` nesta migration.
# Ordem por event_code: FI-LIVE(-4), MZ-ASYNC(3), MZ-LIVE(99).
exige "as linhas JA tortas continuam no banco (nada foi reescrito)" "-4|3|99" \
  "$(q "select string_agg(current_stage::text, '|' order by event_code) from public.events")"
exige_gravou "...e a linha torta aceita REPARO para um valor valido" "MZ-LIVE" 5
exige "...e aceita escrita em OUTRA coluna sem a etapa ser tocada" "ok" \
  "$(host "update public.events set name = 'nome novo' where event_code = 'FI-LIVE' returning 'ok'")"

echo "== 5/6 DEPOIS da 028: a MESMA gravacao e recusada, nomeando o fato =="
exige_recusou "etapa 6 num evento de CINCO etapas" "MZ-LIVE" 6 "etapa_fora_da_versao_do_evento"
exige_recusou "etapa 7 num evento v1 de SEIS etapas" "FI-LIVE" 7 "etapa_fora_da_versao_do_evento"
exige_recusou "etapa 99" "MZ-LIVE" 99 "etapa_fora_da_versao_do_evento"
# PROPRIEDADE DECLARADA, provada antes de ser usada: gravar o MESMO valor NAO e
# mudanca, entao o gatilho nao acorda (o `when` compara VALOR). Isso e desejado --
# uma linha que ja dizia 3 nao passa a afirmar nada de novo ao ser regravada com
# 3 --, mas o teste do modo tem de partir de um valor DIFERENTE, ou mediria o
# no-op em vez da trava. Foi este caso que a primeira versao desta prova mediu
# errado, e por isso ele ficou escrito.
exige "MZ-ASYNC ficou na etapa 3 desde a secao 3" "3" "$(etapa_de MZ-ASYNC)"
exige "regravar o MESMO valor nao e mudanca e nao dispara a trava" "ok" \
  "$(host "update public.events set current_stage = 3 where event_code = 'MZ-ASYNC' returning 'ok'")"
# Zerado (a etapa 0 passa em qualquer modo), para que o proximo update seja uma
# mudanca de verdade.
q "update public.events set current_stage = 0 where event_code = 'MZ-ASYNC'" >/dev/null 2>&1
# MODO: as duas metades, provadas separadamente. A etapa 1 EXISTE na versao do
# evento assincrono -- e a recusa continua sendo por MODO, nao por existencia.
exige_recusou "etapa 3 num evento ASSINCRONO" "MZ-ASYNC" 3 "modo_nao_libera_etapa"
exige_recusou "etapa 1 (que EXISTE na versao dele) num evento ASSINCRONO" "MZ-ASYNC" 1 "modo_nao_libera_etapa"
# TERCEIRO FATO: versao sem lista de etapas utilizavel nao e "a etapa nao existe".
q "
insert into public.events (id, name, event_code, event_date, status, current_stage, mode, quiz_version)
  values ('aaaaaaaa-0000-4000-8000-000000000004','v9 sem etapas','V9-LIVE', now(), 'live', 0, 'live', 9);
insert into public.quiz_stages (id, title, ambient_name, questions, quiz_version, stage_number) values
  (901,'a','a','[]'::jsonb, 8, 1), (902,'b','b','[]'::jsonb, 8, 2), (904,'d','d','[]'::jsonb, 8, 4);
insert into public.events (id, name, event_code, event_date, status, current_stage, mode, quiz_version)
  values ('aaaaaaaa-0000-4000-8000-000000000005','v8 com buraco','V8-LIVE', now(), 'live', 0, 'live', 8);
" >/dev/null 2>&1 || die "nao consegui semear as versoes inconsistentes"
exige_recusou "versao SEM etapa nenhuma" "V9-LIVE" 1 "versao_sem_etapas_utilizaveis"
exige_recusou "versao com BURACO na numeracao (1,2,4), etapa que existe como linha" "V8-LIVE" 2 "versao_sem_etapas_utilizaveis"
# Nem o superusuario passa: a trava nao e de permissao, e de fato.
SAIDA_SU="$(q "update public.events set current_stage = 6 where event_code = 'MZ-LIVE'" 2>&1 | tr -d '\n')"
case "$SAIDA_SU" in
  *etapa_fora_da_versao_do_evento*) echo "   PASS  nem como superusuario a etapa invalida passa" ;;
  *) echo "   FAIL  superusuario gravou etapa invalida: $SAIDA_SU"; FALHAS=$((FALHAS + 1)) ;;
esac

echo "== 6/6 CONTROLE POSITIVO: o caminho bom continua funcionando =="
# Isto e o que impede a trava de virar "recusa tudo". Uma trava que impede o
# caminho bom e pior que a ausencia dela.
q "update public.events set current_stage = 0" >/dev/null 2>&1
TRILHA=""
for n in 1 2 3 4 5 6; do
  host "update public.events set current_stage = $n, status = 'live' where event_code = 'FI-LIVE'" >/dev/null
  TRILHA="$TRILHA$(etapa_de FI-LIVE)"
done
exige "evento AO VIVO da versao ANTIGA (v1) libera a etapa 1 ate a 6, uma por uma" "123456" "$TRILHA"
TRILHA=""
for n in 1 2 3 4 5; do
  host "update public.events set current_stage = $n where event_code = 'MZ-LIVE'" >/dev/null
  TRILHA="$TRILHA$(etapa_de MZ-LIVE)"
done
exige "evento AO VIVO da v2 libera a etapa 1 ate a 5 (e para na 5, que e a ultima)" "12345" "$TRILHA"
exige_gravou "retrocesso continua permitido (nao se inventou monotonia)" "MZ-LIVE" 4
exige_gravou "a etapa 0 passa, em evento ao vivo" "MZ-LIVE" 0
exige_gravou "a etapa 0 passa tambem no ASSINCRONO (e o caminho de reparo)" "MZ-ASYNC" 0
exige "o evento ASSINCRONO continua editavel em tudo o mais" "ok" \
  "$(host "update public.events set name = 'MZ sabado', status = 'active', form_closes_at = now() + interval '2 days' where event_code = 'MZ-ASYNC' returning 'ok'")"

echo "== idempotencia: a 028 aplicada DE NOVO =="
ANTES="$(q "select string_agg(event_code || ':' || current_stage, ',' order by event_code) from public.events")"
PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION" "$URL" >/dev/null 2>&1 \
  || { echo "   FAIL  a 028 nao e idempotente: a segunda aplicacao falhou"; exit 1; }
DEPOIS="$(q "select string_agg(event_code || ':' || current_stage, ',' order by event_code) from public.events")"
exige "reaplicar a 028 nao muda nenhuma etapa" "$ANTES" "$DEPOIS"
exige "e segue havendo UM gatilho, nao dois" "1" \
  "$(q "select count(*) from pg_trigger t where t.tgrelid='public.events'::regclass and t.tgname='events_liberacao_de_etapa'")"

echo
if [ "$FALHAS" -eq 0 ]; then echo "028: PASS -- trava provada, e o caminho bom segue aberto"; exit 0; fi
echo "028: FAIL -- $FALHAS verificacao(oes) reprovada(s)"; exit 1
