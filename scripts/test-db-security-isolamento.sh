#!/usr/bin/env bash
# test-db-security-isolamento.sh -- autoteste da GUARDA DE ISOLAMENTO da suíte de segurança
# do banco (scripts/_db-security-isolamento.sh).
#
# "Um mecanismo de isolamento que nunca foi visto falhando não está provado." Aqui a guarda é
# vista recusando, com a saída real: massa de terceiro no alvo, escritor concorrente DURANTE a
# execução, alvo já travado por outra execução, declaração falsa de descartável e alvo sem
# dados de referência. E vista ACEITANDO um alvo isolado, com as verificações todas.
#
# Tudo roda num ALVO DESCARTÁVEL construído por scripts/db-security-alvo.sh e destruído no
# fim. NUNCA escreve no banco local do projeto -- a fonte é usada apenas para leitura, pelo
# construtor do alvo.
#
# ---------------------------------------------------------------------------------------
# O INSTRUMENTO JÁ SE CONTAMINOU SOZINHO, E ISSO MUDOU O DESENHO DELE
# A primeira versão deste autoteste dava 16 ok num micro e 14 ok 2 falhas noutro: o MESMO
# comando com número diferente. Causa medida: o simulador de trava do caso 6 pegava a
# advisory lock num `psql ... -c "select pg_sleep(40)"` e depois matava o psql. Matar o
# cliente NÃO devolve a trava -- o backend só percebe que o cliente foi embora quando a
# consulta termina, então a trava ficava presa pelo resto do pg_sleep. Medição direta:
#   psql morto (kill retornou)
#     +3s ... +60s depois do kill: trava ainda presa = 1
#   após pg_terminate_backend: trava presa = 0
# Se o caso 6 tinha demorado, sobrava pouco sleep e o caso 7/8 começava limpo (16 ok). Se
# tinha sido rápido, a trava vazava e o caso 8 recusava pelo MOTIVO ERRADO ("alvo já
# travado") sem nunca exercitar o que ele diz exercitar (14 ok, 2 falhas).
#
# Isto é exatamente a doença que esta unidade foi contratada para curar, agora dentro do
# instrumento. Por isso três regras, aplicadas a este arquivo:
#   1. o simulador de trava devolve a trava SEMPRE: sessão ociosa que morre no EOF, mais
#      pg_terminate_backend como garantia, e liberação também no trap de saída (erro, Ctrl-C);
#   2. todo caso confere o AMBIENTE antes de rodar e limpa o que sujou depois, conferindo a
#      limpeza;
#   3. caso que não pode ser exercitado em condições válidas conta como NÃO VERIFICADO, nunca
#      como aprovado -- a mesma regra que a guarda aplica ao banco: BLOCKED não é PASS nem
#      FAIL. O resumo diz quantos não foram verificados.
#
# Exit 0 = PASS (a guarda se comportou como anunciado em todos os casos).
#      1 = FAIL (a guarda, ou este instrumento, não se comportou como anunciado).
#      2 = BLOCKED (não deu para exercitar algum caso em condições válidas; nada foi provado
#          sobre ele). NUNCA confundir com sucesso.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE="$HERE/test-db-security.sh"
ALVO_SH="$HERE/db-security-alvo.sh"
DIR_SQL="$HERE/db-security"
LIB="$HERE/_db-security-isolamento.sh"

PASSOU=0; FALHOU=0; NAOVERIF=0
NV_LISTA=""
WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-iso.XXXXXX")" || { echo "ISOLAMENTO: BLOCKED -- mktemp falhou" >&2; exit 2; }
CONTAINER=""; URL=""
SIM_PID=""; SIM_SINAL=""; SIM_BACKEND=""

limpa() {
  trava_simulada_libera >/dev/null 2>&1
  [ -n "$CONTAINER" ] && bash "$ALVO_SH" down "$CONTAINER" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap limpa EXIT INT TERM

ok()  { PASSOU=$((PASSOU + 1)); echo "  ok    - $*"; }
nok() { FALHOU=$((FALHOU + 1)); echo "  FALHA - $*"; }
# Caso que não pôde ser exercitado: não é aprovado nem reprovado.
nv()  { NAOVERIF=$((NAOVERIF + 1)); NV_LISTA="$NV_LISTA
    - $1 | motivo: $2"; echo "  NÃO VERIFICADO - $1"; echo "        | motivo: $2"; }
mostra() { sed 's/^/        | /' "$1" | tail -"${2:-6}"; }

sql()  { psql -X -q -At -v ON_ERROR_STOP=1 "$URL" -c "$1"; }
sqlv() { psql -X -At "$URL" -c "$1" 2>/dev/null; }   # leitura que nunca aborta o autoteste

# ----------------------------------------------------------------------------------------
# Simulador de trava: sessão OCIOSA segurando a advisory lock. Ociosa de propósito -- backend
# sem consulta em curso percebe o EOF na hora e morre, devolvendo a trava na hora.
trava_simulada_pega() {
  SIM_SINAL="$WORK/trava-sim.ativa"
  local saida="$WORK/trava-sim.out" i
  : >"$SIM_SINAL"; : >"$saida"
  (
    # Token explícito em vez do booleano: concatenado em texto ele sai "true"/"false", não
    # "t"/"f" como numa coluna booleana, e a primeira versão desta função comparava com "t" --
    # resultado: o simulador pegava a trava e o caso se declarava NÃO VERIFICADO à toa.
    cat <<SQL
\o $saida
select pg_backend_pid() || '|' || case when pg_try_advisory_lock(42501, 1) then 'TRAVADO' else 'OCUPADO' end;
\o
SQL
    i=0
    while [ -e "$SIM_SINAL" ] && [ "$i" -lt 1800 ]; do sleep 0.2; i=$((i + 1)); done
  ) | psql -X -q -At -v ON_ERROR_STOP=1 "$URL" >/dev/null 2>&1 &
  SIM_PID=$!
  for i in $(seq 1 300); do [ -s "$saida" ] && break; sleep 0.1; done
  SIM_BACKEND="$(cut -d'|' -f1 "$saida" 2>/dev/null)"
  local pegou
  pegou="$(cut -d'|' -f2 "$saida" 2>/dev/null | tr -d '[:space:]')"
  [ "$pegou" = TRAVADO ] || return 1
  # Confere pelo catálogo, não pela palavra do simulador.
  [ "$(sqlv "select count(*) from pg_locks where locktype='advisory' and classid=42501 and objid=1 and granted")" = 1 ] || return 1
  return 0
}

# Devolve a trava, aconteça o que acontecer. Idempotente: pode ser chamada no caminho de erro
# e no trap. Devolve 0 só quando pg_locks confirma que a trava saiu.
trava_simulada_libera() {
  [ -n "$SIM_SINAL" ] && rm -f "$SIM_SINAL" 2>/dev/null
  if [ -n "$SIM_PID" ]; then
    local i
    for i in $(seq 1 25); do kill -0 "$SIM_PID" 2>/dev/null || break; sleep 0.2; done
    kill "$SIM_PID" 2>/dev/null; wait "$SIM_PID" 2>/dev/null
    SIM_PID=""
  fi
  [ -n "$URL" ] || return 0
  local i n
  for i in $(seq 1 50); do
    n="$(sqlv "select count(*) from pg_locks where locktype='advisory' and classid=42501 and objid=1 and granted")"
    [ "${n:-1}" = 0 ] && { SIM_BACKEND=""; return 0; }
    sleep 0.1
  done
  # Garantia: derruba quem ainda segura a trava. É o único jeito determinístico quando o
  # backend está em consulta longa -- matar o cliente não basta (medido).
  sqlv "select pg_terminate_backend(l.pid) from pg_locks l
         where l.locktype = 'advisory' and l.classid = 42501 and l.objid = 1 and l.granted
           and l.pid <> pg_backend_pid()" >/dev/null
  for i in $(seq 1 50); do
    n="$(sqlv "select count(*) from pg_locks where locktype='advisory' and classid=42501 and objid=1 and granted")"
    [ "${n:-1}" = 0 ] && { SIM_BACKEND=""; return 0; }
    sleep 0.1
  done
  return 1
}

# ----------------------------------------------------------------------------------------
# Pré-condição de TODO caso: o alvo tem de estar no estado conhecido. Se não estiver, o caso
# não roda e conta como NÃO VERIFICADO -- rodar e contar um resultado que não mediu o que diz
# medir é o defeito que originou esta unidade.
AMBIENTE_MOTIVO=""
ambiente_pronto() {
  AMBIENTE_MOTIVO=""
  local n
  n="$(sqlv "select count(*) from pg_locks where locktype='advisory' and classid=42501 and objid=1 and granted")"
  [ -n "$n" ] || { AMBIENTE_MOTIVO="não consegui ler pg_locks do alvo"; return 1; }
  [ "$n" = 0 ] || AMBIENTE_MOTIVO="a trava 42501/1 continua presa no alvo (vazamento de um caso anterior)"
  n="$(sqlv "select (select count(*) from public.quiz_responses) + (select count(*) from public.events)
                  + (select count(*) from public.participants) + (select count(*) from public.knowledge_base)
                  + (select count(*) from public.nps_responses) + (select count(*) from auth.users)")"
  [ -n "$n" ] || { AMBIENTE_MOTIVO="${AMBIENTE_MOTIVO:+$AMBIENTE_MOTIVO; }não consegui contar a massa do alvo"; return 1; }
  [ "$n" = 0 ] || AMBIENTE_MOTIVO="${AMBIENTE_MOTIVO:+$AMBIENTE_MOTIVO; }sobrou massa de um caso anterior no alvo (soma=$n)"
  n="$(sqlv "select count(*) from public.quiz_stages")"
  [ "${n:-0}" -gt 0 ] 2>/dev/null || AMBIENTE_MOTIVO="${AMBIENTE_MOTIVO:+$AMBIENTE_MOTIVO; }dados de referência ausentes no alvo (quiz_stages=${n:-?})"
  [ -z "$AMBIENTE_MOTIVO" ]
}

# Roda a suíte guardando a saída. $1 = arquivo de saída, $2 = modo (vazio = padrão).
roda() {
  local saida="$1" modo="${2:-}"
  if [ -n "$modo" ]; then
    DB_SECURITY_ALVO="$modo" DB_SECURITY_URL="$URL" bash "$SUITE" >"$saida" 2>&1
  else
    DB_SECURITY_URL="$URL" bash "$SUITE" >"$saida" 2>&1
  fi
  echo $?
}

# Confere exit code + trechos obrigatórios na saída.
exige() { # descrição, arquivo, exit esperado, exit obtido, trecho...
  local d="$1" arq="$2" esp="$3" obt="$4"; shift 4
  local falta="" t
  # -i de propósito: a mesma frase aparece no meio e no começo de frase ("Não consegui" /
  # "não consegui"). Exigir a caixa certa reprovava uma recusa CORRETA.
  for t in "$@"; do grep -iqF -- "$t" "$arq" || falta="$falta \"$t\""; done
  if [ "$esp" = "$obt" ] && [ -z "$falta" ]; then
    ok "$d (exit $obt)"
  else
    nok "$d -- exit esperado $esp, obtido $obt;${falta:+ trecho(s) ausente(s):$falta}"
    mostra "$arq" 8
  fi
}

command -v docker >/dev/null 2>&1 || { echo "ISOLAMENTO: BLOCKED -- docker ausente" >&2; exit 2; }
command -v psql   >/dev/null 2>&1 || { echo "ISOLAMENTO: BLOCKED -- psql ausente"   >&2; exit 2; }
export PGCONNECT_TIMEOUT=15

# ----------------------------------------------------------------------------------------
# 0. Estático: a lista de tabelas contadas sem filtro não pode envelhecer calada.
echo "== 0. coerência estática: toda contagem sem filtro está declarada na guarda =="
DECLARADAS="$(sed -n 's/^ISO_TABELAS_CONTADAS="\(.*\)"$/\1/p' "$LIB")"
[ -n "$DECLARADAS" ] || { echo "ISOLAMENTO: BLOCKED -- não achei ISO_TABELAS_CONTADAS em $LIB" >&2; exit 2; }
echo "   declaradas: $DECLARADAS"
ENCONTRADAS="$(grep -ohE 'count\(\*\) from [a-zA-Z_.]+\)' "$DIR_SQL"/cenario-*.sql \
               | sed -E 's/.*from ([a-zA-Z_.]+)\)/\1/' | sed 's/^public\.//' | sort -u)"
echo "   contagens sem filtro nos cenários: $(echo "$ENCONTRADAS" | tr '\n' ' ')"
NAO_DECLARADAS=""
for t in $ENCONTRADAS; do
  case " $(echo "$DECLARADAS" | sed 's/public\.//g') " in *" $t "*) ;; *) NAO_DECLARADAS="$NAO_DECLARADAS $t" ;; esac
done
if [ -z "$NAO_DECLARADAS" ]; then ok "nenhuma contagem sem filtro fora da lista da guarda"
else nok "contagem sem filtro NÃO declarada:$NAO_DECLARADAS (adicione a ISO_TABELAS_CONTADAS)"; fi

# ----------------------------------------------------------------------------------------
echo
echo "== preparação: alvo descartável (nada é escrito no banco do projeto) =="
if [ -n "${DB_SECURITY_ALVO_URL:-}" ]; then
  # Reuso de um alvo descartável JÁ construído (iteração rápida: construir a instância leva
  # minutos). Este autoteste ESCREVE no alvo, então o reuso é RECUSADO em qualquer alvo que
  # não seja exclusivamente dele -- apontar isto para banco compartilhado seria a própria
  # contaminação que a unidade existe para impedir.
  URL="$DB_SECURITY_ALVO_URL"
  case "$URL" in
    postgres://*|postgresql://*) ;;
    *) echo "ISOLAMENTO: BLOCKED -- DB_SECURITY_ALVO_URL não é URL postgres://" >&2; exit 2 ;;
  esac
  case "$URL" in *host=*|*hostaddr=*|*service=*|*passfile=*) echo "ISOLAMENTO: BLOCKED -- a URL não pode ter host=/hostaddr=/service=/passfile=" >&2; exit 2 ;; esac
  HP="${URL#*://}"; HP="${HP##*@}"; HP="${HP%%/*}"
  case "$HP" in \[*\]*) H="${HP%%\]*}]" ;; *) H="${HP%%:*}" ;; esac
  case "$H" in 127.0.0.1|localhost|"[::1]") ;; *) echo "ISOLAMENTO: BLOCKED -- alvo reusado não é local (host='$H')" >&2; exit 2 ;; esac
  TERCEIROS="$(sqlv "select count(*) from pg_stat_activity where datname = current_database()
                      and backend_type = 'client backend' and coalesce(application_name,'') not like 'db-security%'
                      and pid <> pg_backend_pid()")"
  [ -n "$TERCEIROS" ] || { echo "ISOLAMENTO: BLOCKED -- não consegui medir o alvo reusado" >&2; exit 2; }
  [ "$TERCEIROS" = 0 ] || { echo "ISOLAMENTO: BLOCKED -- o alvo reusado tem $TERCEIROS conexão(ões) de terceiros: não é instância exclusiva deste autoteste, e este autoteste ESCREVE no alvo. Recuso." >&2; exit 2; }
  if ! ambiente_pronto; then
    echo "ISOLAMENTO: BLOCKED -- o alvo reusado não está no estado conhecido: $AMBIENTE_MOTIVO" >&2; exit 2
  fi
  echo "   reusando alvo descartável já construído (DB_SECURITY_ALVO_URL), 0 conexões de terceiros"
  echo "   este autoteste NÃO vai destruí-lo (quem construiu destrói)"
else
  LINHA="$(bash "$ALVO_SH" up --nome "fort-dbsec-alvo-autoteste-$$")" || { echo "ISOLAMENTO: BLOCKED -- não consegui construir o alvo" >&2; exit 2; }
  CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"; URL="$(printf '%s' "$LINHA" | cut -f2)"
  [ -n "$CONTAINER" ] && [ -n "$URL" ] || { echo "ISOLAMENTO: BLOCKED -- construtor não devolveu container/url" >&2; exit 2; }
  echo "   container: $CONTAINER"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 1. ACEITA alvo isolado: a suíte passa e as verificações continuam todas lá =="
if ambiente_pronto; then
  RC="$(roda "$WORK/c1.out" descartavel)"
  TOTAL_OK="$(sed -n 's/^  total: \([0-9]*\) ok.*/\1/p' "$WORK/c1.out" | tail -1)"
  exige "alvo isolado => PASS" "$WORK/c1.out" 0 "$RC" "DB-SECURITY: PASS" \
        "declaração de descartável CONFIRMADA" "trava: exclusiva e confirmada em pg_locks"
  if [ "${TOTAL_OK:-0}" -ge 69 ] 2>/dev/null; then ok "verificações intactas: $TOTAL_OK ok (piso 69)"
  else nok "a suíte rodou só ${TOTAL_OK:-0} verificações (piso 69): algo parou de rodar"; fi
  grep -q "PASSOU  cenário 0" "$WORK/c1.out" && ok "cenário 0 (autoteste do harness) preservado" || nok "cenário 0 não passou"
  grep -q "contagens de linhas, policies, grants e funções idênticos antes/depois" "$WORK/c1.out" \
    && ok "verificação de repetibilidade por impressão digital preservada" || nok "repetibilidade desapareceu"
else
  nv "caso 1 (aceita alvo isolado)" "$AMBIENTE_MOTIVO"
fi

echo
echo "== 2. a trava é devolvida: a execução seguinte não fica travada pela anterior =="
if ambiente_pronto; then
  RC="$(roda "$WORK/c2.out" descartavel)"
  exige "segunda execução em sequência => PASS" "$WORK/c2.out" 0 "$RC" "DB-SECURITY: PASS"
else
  nv "caso 2 (trava devolvida entre execuções)" "$AMBIENTE_MOTIVO"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 3. RECUSA massa de terceiro na tabela que o cenário 4 conta SEM FILTRO =="
echo "   (é o incidente real: outra unidade inseriu em quiz_responses e o cenário 4 ficou vermelho)"
SUJOU=0
if ambiente_pronto; then
  sql "insert into public.events (id, name, event_code, event_date, status, current_stage)
       values ('00000000-0000-4000-8000-00000000f001', 'evento de outra unidade', 'OUTRA-UNIDADE', now(), 'live', 1)" >/dev/null
  sql "insert into public.participants (id, event_id, full_name, email)
       values ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f001', 'Participante de outra unidade', 'outra@unidade.test')" >/dev/null
  sql "insert into public.quiz_responses (participant_id, stage_id, answers)
       values ('00000000-0000-4000-8000-00000000f002', 1, '{\"q1\":\"massa de outra unidade\"}')" >/dev/null
  SUJOU=1
  if [ "$(sqlv "select count(*) from public.quiz_responses")" = 1 ]; then
    RC="$(roda "$WORK/c3.out" compartilhado)"
    exige "massa de terceiro em quiz_responses => BLOCKED (modo compartilhado)" "$WORK/c3.out" 2 "$RC" \
          "DB-SECURITY: BLOCKED" "public.quiz_responses=1" "não consegui verificar em condições isoladas"
    grep -q "DB-SECURITY: FAIL" "$WORK/c3.out" && nok "a saída ainda diz FAIL: contaminação não pode virar reprovação" \
      || ok "nenhum FAIL na saída: contaminação não é reprovação de segurança"
  else
    nv "caso 3 (massa de terceiro na tabela contada)" "não consegui inserir a massa simulada no alvo"
  fi

  echo
  echo "== 4. RECUSA declaração falsa de descartável (massa de terceiro presente) =="
  # Este caso PRECISA da massa de terceiro do caso 3. Em vez de supor que ela está lá,
  # confere -- se não estiver, o caso não mediria o que diz medir.
  if [ "$(sqlv "select count(*) from public.events where id = '00000000-0000-4000-8000-00000000f001'")" = 1 ]; then
    RC="$(roda "$WORK/c4.out" descartavel)"
    exige "DB_SECURITY_ALVO=descartavel mentindo => BLOCKED" "$WORK/c4.out" 2 "$RC" \
          "DB-SECURITY: BLOCKED" "MASSA QUE NÃO É DESTA SUÍTE" "é banco compartilhado"
  else
    nv "caso 4 (declaração falsa de descartável)" "a massa de terceiro do caso 3 não está no alvo"
  fi
else
  nv "caso 3 (massa de terceiro na tabela contada)" "$AMBIENTE_MOTIVO"
  echo
  echo "== 4. RECUSA declaração falsa de descartável (massa de terceiro presente) =="
  nv "caso 4 (declaração falsa de descartável)" "$AMBIENTE_MOTIVO"
fi

# Limpeza dos casos 3 e 4, conferida: o que sujou aqui não pode invalidar o caso seguinte.
if [ "$SUJOU" = 1 ]; then
  sql "delete from public.quiz_responses where participant_id = '00000000-0000-4000-8000-00000000f002'" >/dev/null
  sql "delete from public.participants where id = '00000000-0000-4000-8000-00000000f002'" >/dev/null
  sql "delete from public.events where id = '00000000-0000-4000-8000-00000000f001'" >/dev/null
  n="$(sqlv "select (select count(*) from public.quiz_responses) + (select count(*) from public.participants) + (select count(*) from public.events)")"
  [ "${n:-1}" = 0 ] && ok "massa simulada dos casos 3 e 4 removida (alvo volta ao estado conhecido)" \
                    || nok "a massa simulada dos casos 3 e 4 NÃO saiu do alvo (soma=${n:-?})"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 5. RECUSA escritor concorrente que aparece DURANTE a execução =="
echo "   (a massa estava limpa quando a suíte começou; o escritor entra depois)"
if ambiente_pronto; then
  SAIDA="$WORK/c5.out"; : >"$SAIDA"
  (
    # Espera o PRIMEIRO CENÁRIO começar e só então escreve. Esperar a linha 'massa:' não serve:
    # a linha de base da sentinela é tirada DEPOIS dela, e a escrita poderia entrar na linha de
    # base em vez de ser detectada como deriva.
    for _ in $(seq 1 900); do grep -q 'cenário 0:' "$SAIDA" 2>/dev/null && break; sleep 0.1; done
    # knowledge_base (title, content): duas colunas de texto, sem CHECK nem FK. A primeira
    # versão escrevia em nps_responses e a escrita FALHAVA calada, então o caso "reprovava" a
    # sentinela por uma escrita que nunca aconteceu. O rc vai para arquivo e é conferido.
    psql -X -q -At -v ON_ERROR_STOP=1 "$URL" \
      -c "insert into public.knowledge_base (title, content) values ('escritor concorrente', 'linha de outra unidade')" >/dev/null 2>"$WORK/c5.escritor.err"
    echo $? >"$WORK/c5.escritor.rc"
  ) &
  ESCRITOR=$!
  DB_SECURITY_ALVO=descartavel DB_SECURITY_URL="$URL" bash "$SUITE" >"$SAIDA" 2>&1
  RC=$?
  wait "$ESCRITOR" 2>/dev/null
  if [ "$(cat "$WORK/c5.escritor.rc" 2>/dev/null)" = 0 ]; then
    ok "o escritor concorrente simulado conseguiu escrever (é isso que a sentinela tem de pegar)"
    exige "escrita de terceiro durante a execução => BLOCKED" "$SAIDA" 2 "$RC" \
          "DB-SECURITY: BLOCKED" "DURANTE a execução" "public.knowledge_base"
    grep -qi "isto não é reprovação de segurança" "$SAIDA" \
      && ok "a mensagem separa 'não consegui verificar' de 'reprovado'" || nok "a mensagem não faz a distinção"
  else
    nv "caso 5 (sentinela pega escritor concorrente)" "não consegui simular o escritor concorrente (rc=$(cat "$WORK/c5.escritor.rc" 2>/dev/null), erro: $(head -1 "$WORK/c5.escritor.err" 2>/dev/null))"
  fi
  sql "delete from public.knowledge_base where title = 'escritor concorrente'" >/dev/null
  n="$(sqlv "select count(*) from public.knowledge_base")"
  [ "${n:-1}" = 0 ] && ok "linha do escritor simulado removida (alvo volta ao estado conhecido)" \
                    || nok "a linha do escritor simulado NÃO saiu do alvo (knowledge_base=${n:-?})"
else
  nv "caso 5 (sentinela pega escritor concorrente)" "$AMBIENTE_MOTIVO"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 6. RECUSA alvo já travado por outra execução (serialização) =="
if ambiente_pronto; then
  if trava_simulada_pega; then
    ok "simulador pegou a trava 42501/1 numa sessão ociosa (confirmado em pg_locks, backend $SIM_BACKEND)"
    RC="$(roda "$WORK/c6.out" descartavel)"
    exige "alvo com trava de outra execução => BLOCKED" "$WORK/c6.out" 2 "$RC" \
          "DB-SECURITY: BLOCKED" "trava exclusiva deste alvo" "não podem dividir a mesma massa de teste"
    # Devolver a trava é obrigação deste caso, no caminho feliz e no de erro.
    if [ "${ISO_TESTE_INJETAR_VAZAMENTO:-0}" = 1 ]; then
      # Injeção de defeito, só para PROVAR a regra 3 deste arquivo: com a trava vazada de
      # propósito, os casos seguintes têm de se declarar NÃO VERIFICADOS (e o veredito final,
      # BLOCKED), em vez de recusarem pelo motivo errado e serem contados como aprovados.
      echo "   [INJEÇÃO DE DEFEITO] ISO_TESTE_INJETAR_VAZAMENTO=1: não devolvo a trava de propósito."
      echo "   Os casos 7 e 8 devem se declarar NÃO VERIFICADOS. (O trap de saída devolve a trava.)"
    elif trava_simulada_libera; then
      ok "a trava do simulador foi devolvida e pg_locks confirma (os casos seguintes valem)"
    else
      nok "a trava do simulador NÃO saiu de pg_locks nem com pg_terminate_backend"
    fi
  else
    nv "caso 6 (recusa alvo já travado)" "o simulador não conseguiu pegar a trava 42501/1"
    # Não contou verificação nenhuma, mas o ambiente não pode ficar sujo para os próximos.
    trava_simulada_libera >/dev/null 2>&1 || true
  fi
else
  nv "caso 6 (recusa alvo já travado)" "$AMBIENTE_MOTIVO"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 7. RECUSA modo desconhecido (declaração que ninguém sabe conferir) =="
if ambiente_pronto; then
  RC="$(roda "$WORK/c7.out" descartável-talvez)"
  exige "DB_SECURITY_ALVO inválido => BLOCKED" "$WORK/c7.out" 2 "$RC" "DB-SECURITY: BLOCKED" "é desconhecido"
else
  nv "caso 7 (recusa modo desconhecido)" "$AMBIENTE_MOTIVO"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== 8. RECUSA alvo sem os dados de referência (ambiente incompleto, não reprovação) =="
if ambiente_pronto; then
  # Guarda as etapas num schema à parte (fora de public, para não mexer na massa que a guarda
  # mede) e devolve no fim: o caso não deixa o alvo pior do que encontrou.
  sql "create schema if not exists zz_autoteste_backup" >/dev/null
  sql "drop table if exists zz_autoteste_backup.quiz_stages" >/dev/null
  sql "create table zz_autoteste_backup.quiz_stages as select * from public.quiz_stages" >/dev/null
  GUARDADAS="$(sqlv "select count(*) from zz_autoteste_backup.quiz_stages")"
  if [ "${GUARDADAS:-0}" -gt 0 ] 2>/dev/null; then
    sql "delete from public.quiz_stages" >/dev/null
    RC="$(roda "$WORK/c8.out" descartavel)"
    exige "alvo sem quiz_stages => BLOCKED" "$WORK/c8.out" 2 "$RC" \
          "DB-SECURITY: BLOCKED" "dados de referência ausentes" "não é alvo reprovado"
    sql "insert into public.quiz_stages select * from zz_autoteste_backup.quiz_stages" >/dev/null
    n="$(sqlv "select count(*) from public.quiz_stages")"
    [ "${n:-0}" = "$GUARDADAS" ] && ok "dados de referência devolvidos ao alvo ($n etapas)" \
                                 || nok "NÃO devolvi os dados de referência (tinha $GUARDADAS, voltou ${n:-?})"
  else
    nv "caso 8 (recusa alvo sem dados de referência)" "não consegui guardar as etapas antes de apagá-las"
  fi
  sql "set client_min_messages = warning; drop schema if exists zz_autoteste_backup cascade" >/dev/null
else
  nv "caso 8 (recusa alvo sem dados de referência)" "$AMBIENTE_MOTIVO"
fi

# ----------------------------------------------------------------------------------------
echo
echo "== resumo do autoteste de isolamento =="
echo "  $PASSOU ok, $FALHOU falha(s), $NAOVERIF não verificado(s)"
if [ "$NAOVERIF" -gt 0 ]; then
  echo "  casos que NÃO foram exercitados em condições válidas (nada foi provado sobre eles):$NV_LISTA"
fi
if [ "$FALHOU" -gt 0 ]; then
  echo "ISOLAMENTO: FAIL -- a guarda (ou este instrumento) não se comportou como anunciado"
  exit 1
fi
if [ "$NAOVERIF" -gt 0 ]; then
  echo "ISOLAMENTO: BLOCKED -- $NAOVERIF caso(s) não puderam ser exercitados. BLOCKED não é PASS nem FAIL:"
  echo "   não houve reprovação, houve medição que não aconteceu."
  exit 2
fi
echo "ISOLAMENTO: PASS -- a guarda aceitou alvo isolado e recusou alvo compartilhado em todos os casos"
exit 0
