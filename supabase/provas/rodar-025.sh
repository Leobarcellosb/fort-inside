#!/usr/bin/env bash
# rodar-025.sh -- prova do CAMINHO DE APLICACAO da migration 025
# (aprovacao cobre o conteudo entregue), que a cadeia pos-coleta nao cobre.
#
#   bash supabase/provas/rodar-025.sh
#   bash supabase/provas/rodar-025.sh --manter   (deixa o container de pe)
#
# Exit: 0 = provado   1 = FALHOU   2 = BLOCKED (nao deu para construir o alvo)
#
# O que esta prova mede, e que a prova da cadeia NAO mede:
#   1. BACKFILL. A cadeia constroi um banco VAZIO: nela a 025 nunca encontra
#      linha historica. Aqui o banco e carregado com documentos JA REVISADOS e
#      JA ENTREGUES, SEM selo, e a 025 e aplicada em cima deles. O selo tem de
#      nascer sobre o conteudo QUE JA ESTA LA -- e, no caso entregue, sobre
#      exatamente o que a pagina de entrega renderiza hoje
#      (`final_content ?? raw_ai_output`), nunca sobre `edited_content`.
#   2. QUE DOCUMENTO HISTORICO NAO QUEBRA. Depois da 025, uma escrita comum
#      sobre documento entregue (gravar `pdf_url`) tem de continuar passando.
#   3. IDEMPOTENCIA. O proprio runner das migrations reaplica um arquivo quando
#      a primeira tentativa falha por saturacao: aplicar a 025 duas vezes nao
#      pode falhar nem mudar nenhum selo.
#
# NUNCA aponta para producao: o alvo nasce aqui, com nome unico, e morre no fim.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALVO_SH="$RAIZ/scripts/drift/reference-db.sh"
# Prefixo `fort-drift-`: e o unico que `scripts/drift/reference-db.sh down`
# aceita remover, de proposito. Nome fora dele deixaria o container de pe.
NOME="fort-drift-prova-025-$$-$RANDOM"
CONTAINER=""; FALHAS=0

die() { echo "025: BLOCKED -- $*" >&2; exit 2; }
limpa() {
  if [ -n "${MANTER:-}" ]; then
    echo "025: --manter -- container de pe: $CONTAINER" >&2
  else
    [ -n "$CONTAINER" ] && bash "$ALVO_SH" down "$CONTAINER" >/dev/null 2>&1
  fi
}
trap limpa EXIT INT TERM
[ "${1:-}" = "--manter" ] && MANTER=1

q() { PGCONNECT_TIMEOUT=60 psql -X -Atc "$1" "$URL"; }
exige() { # nome, esperado, obtido
  if [ "$2" = "$3" ]; then
    echo "   PASS  $1"
  else
    echo "   FAIL  $1: esperado [$2], obtido [$3]"; FALHAS=$((FALHAS + 1))
  fi
}

[ -f "$ALVO_SH" ] || die "falta $ALVO_SH"
for c in docker psql; do command -v "$c" >/dev/null || die "$c nao encontrado"; done

echo "== 1/5 Postgres descartavel =="
LINHA="$(bash "$ALVO_SH" up-empty --name "$NOME" 2>/dev/null)" || die "nao subiu o Postgres"
CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"
URL="$(printf '%s' "$LINHA" | cut -f2)"
case "$URL" in *@127.0.0.1:*|*@localhost:*) ;; *) die "o alvo nao e local" ;; esac
for i in $(seq 1 120); do q "select 1" >/dev/null 2>&1 && break; sleep 5; done
q "select 1" >/dev/null 2>&1 || die "o Postgres nao aceitou conexao (saturacao, nao defeito do produto)"
echo "   db: $CONTAINER"

echo "== 2/5 migrations 001..024 (o banco COMO ERA ANTES da 025) =="
for f in $(ls "$RAIZ"/supabase/migrations/*.sql | sort); do
  case "$(basename "$f")" in 025_*) continue ;; esac
  ok=0
  for t in 1 2 3; do
    PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$f" "$URL" >/dev/null 2>&1 && { ok=1; break; }
    echo "   [aviso] $(basename "$f") nova tentativa $t/3"
  done
  [ "$ok" = 1 ] || die "migration falhou: $(basename "$f")"
done
echo "   aplicadas"

echo "== 3/5 documentos HISTORICOS, sem selo (e sem a 025 no banco) =="
q "
insert into public.events (id, name, event_code, event_date, status, quiz_version)
  values ('11111111-1111-1111-1111-111111111111', 'prova 025', 'PROVA025', now(), 'completed', 2);
insert into public.participants (id, event_id, full_name, email)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Entregue Antigo', 'ent@prova.test'),
         ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Revisado Antigo', 'rev@prova.test');
-- ENTREGUE com final_content NULO e edited_content DIFERENTE do cru: e o caso
-- que decide. A pagina mostra o CRU (final_content ?? raw_ai_output), entao o
-- selo tem de ser do cru -- nao do editado.
insert into public.prognostics (id, participant_id, raw_ai_output, edited_content, final_content, status, delivered_at)
  values ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222',
          '{\"analise_geral\": \"CRU, e o que o participante viu\"}'::jsonb,
          '{\"analise_geral\": \"EDITADO, que nunca foi entregue\"}'::jsonb,
          null, 'delivered', now());
insert into public.prognostics (id, participant_id, raw_ai_output, edited_content, status, reviewed_at)
  values ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
          '{\"analise_geral\": \"cru\"}'::jsonb,
          '{\"analise_geral\": \"REVISADO pelo host\"}'::jsonb,
          'reviewed', now());
" >/dev/null 2>&1 || die "nao consegui semear os documentos historicos"
exige "antes da 025 nao existe coluna de selo" "0" \
  "$(q "select count(*) from information_schema.columns where table_name='prognostics' and column_name='conteudo_aprovado_hash'")"

echo "== 4/5 a 025, aplicada em cima do historico =="
PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$RAIZ/supabase/migrations/025_aprovacao_cobre_conteudo.sql" "$URL" \
  >/dev/null 2>&1 || { echo "   FAIL  a 025 nao aplicou sobre banco com dados"; exit 1; }

exige "entregue: final_content passou a registrar o que a pagina ja mostrava (o CRU)" \
  "CRU, e o que o participante viu" \
  "$(q "select final_content->>'analise_geral' from public.prognostics where id='44444444-4444-4444-4444-444444444444'")"
exige "entregue: o selo e a impressao do que foi ENTREGUE" "t" \
  "$(q "select conteudo_aprovado_hash = encode(sha256(convert_to(final_content::text,'UTF8')),'hex') from public.prognostics where id='44444444-4444-4444-4444-444444444444'")"
exige "entregue: o selo NAO e a impressao do edited_content (que nunca foi entregue)" "f" \
  "$(q "select conteudo_aprovado_hash = encode(sha256(convert_to(edited_content::text,'UTF8')),'hex') from public.prognostics where id='44444444-4444-4444-4444-444444444444'")"
exige "entregue: aprovado_em vem da data do banco, nao de now()" "t" \
  "$(q "select aprovado_em = coalesce(reviewed_at, delivered_at) from public.prognostics where id='44444444-4444-4444-4444-444444444444'")"
exige "revisado: o selo cobre o texto que a revisao deixou pronto" "t" \
  "$(q "select conteudo_aprovado_hash = encode(sha256(convert_to(edited_content::text,'UTF8')),'hex') from public.prognostics where id='55555555-5555-5555-5555-555555555555'")"

# DOCUMENTO HISTORICO NAO QUEBRA: escrita comum sobre entregue continua passando.
# `psql -Atc` com RETURNING imprime a linha E a etiqueta do comando ("UPDATE 1").
# A etiqueta nao e dado: sai fora, como em tests/jornada-individual.
SAIDA_PDF="$(q "update public.prognostics set pdf_url='https://exemplo/x.pdf' where id='44444444-4444-4444-4444-444444444444' returning 'ok'" 2>&1 \
  | grep -v -E '^(INSERT|UPDATE|DELETE) [0-9]+( [0-9]+)?$' | tr -d '\n')"
exige "entregue historico aceita escrita comum (pdf_url) depois da 025" "ok" "$SAIDA_PDF"

# E a NEGATIVA, no mesmo banco: trocar o conteudo entregue e recusado.
SAIDA_TROCA="$(q "update public.prognostics set final_content='{\"analise_geral\":\"texto trocado por fora\"}'::jsonb where id='44444444-4444-4444-4444-444444444444'" 2>&1)"
case "$SAIDA_TROCA" in
  *"nao e o conteudo aprovado"*) echo "   PASS  trocar o conteudo de um documento entregue e recusado" ;;
  *) echo "   FAIL  trocar o conteudo de um documento entregue NAO foi recusado: $SAIDA_TROCA"; FALHAS=$((FALHAS + 1)) ;;
esac

# E A TENTATIVA QUE DECIDE SE O GATILHO VALE A PENA: forjar o selo junto com o
# texto novo. O CHECK sozinho seria contornavel assim (ele so compara duas
# colunas da MESMA linha nova). O gatilho sobrescreve o selo pelo anterior antes
# de o CHECK rodar, entao a forja nao existe.
SAIDA_FORJA="$(q "update public.prognostics
   set final_content = '{\"analise_geral\":\"texto novo, com selo forjado\"}'::jsonb,
       conteudo_aprovado_hash = encode(sha256(convert_to('{\"analise_geral\": \"texto novo, com selo forjado\"}'::jsonb::text,'UTF8')),'hex')
 where id='44444444-4444-4444-4444-444444444444'" 2>&1)"
case "$SAIDA_FORJA" in
  *"nao e o conteudo aprovado"*) echo "   PASS  forjar o selo junto com o texto novo e recusado (o gatilho o sobrescreve)" ;;
  *) echo "   FAIL  o selo PODE ser forjado pela aplicacao: $SAIDA_FORJA"; FALHAS=$((FALHAS + 1)) ;;
esac
exige "e o texto entregue continua sendo o aprovado" "CRU, e o que o participante viu" \
  "$(q "select final_content->>'analise_geral' from public.prognostics where id='44444444-4444-4444-4444-444444444444'")"

echo "== 5/5 idempotencia: a 025 aplicada DE NOVO =="
ANTES="$(q "select string_agg(id || ':' || coalesce(conteudo_aprovado_hash,'-'), ',' order by id) from public.prognostics")"
PGCONNECT_TIMEOUT=60 psql -X -q -v ON_ERROR_STOP=1 -f "$RAIZ/supabase/migrations/025_aprovacao_cobre_conteudo.sql" "$URL" \
  >/dev/null 2>&1 || { echo "   FAIL  a 025 nao e idempotente: a segunda aplicacao falhou"; exit 1; }
DEPOIS="$(q "select string_agg(id || ':' || coalesce(conteudo_aprovado_hash,'-'), ',' order by id) from public.prognostics")"
exige "reaplicar a 025 nao muda nenhum selo" "$ANTES" "$DEPOIS"

echo
if [ "$FALHAS" -eq 0 ]; then echo "025: PASS -- caminho de aplicacao provado"; exit 0; fi
echo "025: FAIL -- $FALHAS verificacao(oes) reprovada(s)"; exit 1
