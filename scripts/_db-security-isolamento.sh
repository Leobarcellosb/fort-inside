#!/usr/bin/env bash
# _db-security-isolamento.sh -- guarda de isolamento do ALVO da suíte de segurança do banco.
# Biblioteca: é carregada com `.` por scripts/test-db-security.sh. Não execute direto.
#
# POR QUE EXISTE (medido, não suposto)
# Uma execução de `npm run db:security` ficou VERMELHA no cenário 4: a linha que confere a
# massa do próprio cenário esperava "3 respostas" e obteve "7". Nada de segurança havia
# quebrado -- outra unidade de trabalho estava inserindo em `quiz_responses` no MESMO banco
# local durante a execução, e o cenário confere a massa CONTANDO LINHAS. Rodando sozinho
# depois: 69 ok, 0 falhas. O vermelho sumiu sozinho.
#
# Contaminação assim só produz VERMELHO, nunca verde falso, então não é brecha de segurança.
# O dano é outro e é pior: vermelho que some sozinho ensina todo mundo a ignorar vermelho.
# A resposta NÃO é relaxar a asserção (a contagem sem filtro é a prova mais forte de que a
# função destrutiva não apagou nada em lugar algum). A resposta é ISOLAR O ALVO e, quando o
# alvo não for isolado, RECUSAR A EXECUÇÃO.
#
# "NÃO CONSEGUI VERIFICAR" NÃO É "REPROVADO"
# Alvo compartilhado => exit 2 / BLOCKED, igual ao guard de drift. Nunca exit 1 (FAIL), que
# significa "uma verificação de segurança reprovou", e nunca exit 0.
#
# AS QUATRO PORTAS (todas por MEDIÇÃO; declaração sozinha não vale)
#   1. identidade    -- banco, porta, system_identifier, uptime e quantas conexões de
#                       terceiros existem no alvo ficam IMPRESSAS em toda execução.
#   2. trava         -- trava exclusiva (advisory lock) presa durante a execução inteira e
#                       conferida por um SEGUNDO caminho (pg_locks), não pela palavra do
#                       processo que a pediu. Duas execuções nunca dividem o mesmo alvo.
#   3. massa         -- a massa de que os cenários dependem tem de ser SÓ a da suíte. No modo
#                       descartável, toda tabela de negócio vazia; no modo compartilhado, no
#                       mínimo as tabelas que os cenários contam sem filtro.
#   4. sentinela     -- a massa é remedida entre TODOS os cenários. Mudou sem vestígio da
#                       suíte => outro processo escreveu no alvo DURANTE a execução => BLOCKED.
#
# LIÇÃO DE BASH (de scripts/manifesto-migrations.sh): o macOS traz bash 3.2, sem `declare -A`.
# Aqui não há array associativo nenhum -- só listas em string e linhas de texto. E toda
# medição que volta VAZIA aborta: estrutura vazia nunca segue adiante como se fosse "nada a
# reclamar" (foi exatamente assim que o manifesto acusou 16 divergências fantasma).

# ---------------------------------------------------------------- contrato com o chamador
# A biblioteca depende de URL, blocked() e psql_q() vindos do script da suíte. Se faltar
# qualquer um, aborta: carregar a guarda e ela não guardar nada é o pior desfecho possível.
iso_contrato() {
  local falta=""
  [ -n "${URL:-}" ] || falta="$falta URL"
  type blocked >/dev/null 2>&1 || falta="$falta blocked()"
  type psql_q  >/dev/null 2>&1 || falta="$falta psql_q()"
  if [ -n "$falta" ]; then
    echo "DB-SECURITY: BLOCKED -- erro interno: a guarda de isolamento foi carregada sem:$falta" >&2
    exit 2
  fi
}

# ---------------------------------------------------------------- o que cada lista significa
# Tabelas que os CENÁRIOS contam SEM FILTRO. Massa de terceiro aqui invalida o veredito.
# Hoje: cenario-4-funcao-destrutiva.sql confere `count(*) from public.quiz_responses = 3`.
# scripts/test-db-security-isolamento.sh relê os .sql e FALHA se aparecer uma contagem sem
# filtro em tabela que não esteja nesta lista -- a lista não envelhece calada.
ISO_TABELAS_CONTADAS="public.quiz_responses"

# Dados de REFERÊNCIA: não são massa de teste, são pré-condição do ambiente (as etapas do
# quiz). O seed tem FK para cá; alvo sem isto não dá para verificar (BLOCKED, não FAIL).
ISO_TABELAS_REFERENCIA="public.quiz_stages"

# Chave da trava exclusiva. 42501 é o SQLSTATE que a suíte persegue; serve de rótulo.
ISO_TRAVA_A=42501
ISO_TRAVA_B=1

ISO_SNAP_ANTERIOR=""
ISO_SNAP_ROTULO=""
ISO_MOTIVO=""
ISO_TRAVA_PID=""
ISO_TRAVA_SINAL=""

# ---------------------------------------------------------------- medições
# Uma linha por tabela ("schema.tabela=N") mais uma linha "zz_estrutura=<md5>" com policies,
# grants de tabela/view, grants de função e ACL do schema public. Ordenado no shell (sort),
# para não depender de ORDER BY em UNION ALL.
iso_snapshot() {
  psql_q -c "
    select n.nspname || '.' || c.relname || '=' ||
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
    union all
    select 'zz_estrutura=' || md5(
         coalesce((select string_agg(tablename || policyname || cmd || coalesce(qual,'') || coalesce(with_check,''), ',' order by tablename, policyname)
                     from pg_policies where schemaname = 'public'), '')
      || '|' || coalesce((select string_agg(c.relname || coalesce(c.relacl::text,'') || coalesce(c.reloptions::text,''), ',' order by c.relname)
                            from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v')), '')
      || '|' || coalesce((select string_agg(p.proname || coalesce(p.proacl::text,''), ',' order by p.proname)
                            from pg_proc p where p.pronamespace = 'public'::regnamespace), '')
      || '|' || coalesce((select nspacl::text from pg_namespace where nspname = 'public'), ''))" 2>/dev/null | sort
}

# Valor de uma tabela dentro de um snapshot. Devolve "" se a tabela não existe no alvo.
iso_valor() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

# Vestígio da PRÓPRIA suíte no alvo (fora de transação): evento/usuários do seed ou a tabela
# do autoteste. Se houver, a mudança veio de um rollback que não aconteceu -- isso é FALHA da
# suíte, não contaminação de terceiro, e as duas não podem ser confundidas.
iso_vestigio() {
  psql_q -c "select (select count(*) from public.events where id = '00000000-0000-4000-8000-0000000000e1')
                  + (select count(*) from auth.users where email like '%@seguranca.test')
                  + (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname = 'zz_autoteste')" 2>/dev/null
}

# ---------------------------------------------------------------- 1. identidade do alvo
iso_identidade() {
  local linha
  linha="$(psql_q -c "select current_database()
       || '|' || coalesce(inet_server_port()::text, 'socket')
       || '|' || (select system_identifier::text from pg_control_system())
       || '|' || to_char(pg_postmaster_start_time(), 'YYYY-MM-DD HH24:MI:SS')
       || '|' || (select count(*) from pg_stat_activity
                   where datname = current_database() and backend_type = 'client backend'
                     and coalesce(application_name, '') not like 'db-security/%')" 2>/dev/null)"
  [ -n "$linha" ] || blocked "não consegui medir a identidade do alvo. Sem identidade não há isolamento para declarar."
  ISO_DB="$(printf '%s' "$linha" | cut -d'|' -f1)"
  ISO_PORTA="$(printf '%s' "$linha" | cut -d'|' -f2)"
  ISO_SYSID="$(printf '%s' "$linha" | cut -d'|' -f3)"
  ISO_INICIO="$(printf '%s' "$linha" | cut -d'|' -f4)"
  ISO_TERCEIROS="$(printf '%s' "$linha" | cut -d'|' -f5)"
  echo "   alvo: host=$HOST porta=$ISO_PORTA banco=$ISO_DB system_identifier=$ISO_SYSID"
  echo "         postmaster desde $ISO_INICIO ; conexões de terceiros no alvo agora: $ISO_TERCEIROS"
}

# ---------------------------------------------------------------- modo declarado
# DB_SECURITY_ALVO=descartavel   -> o chamador declara instância descartável e exclusiva
#                                   (CI por job, ou scripts/db-security-isolado.sh).
#                                   A suíte CONFERE: toda tabela de negócio vazia.
# DB_SECURITY_ALVO=compartilhado -> contenção local: trava exclusiva + sentinela. É o padrão,
#                                   e a suíte diz em voz alta que contenção não é isolamento.
iso_modo() {
  ISO_MODO="${DB_SECURITY_ALVO:-compartilhado}"
  case "$ISO_MODO" in
    descartavel)
      echo "   isolamento: DECLARADO descartável (DB_SECURITY_ALVO=descartavel) -- a suíte vai CONFERIR a declaração"
      ;;
    compartilhado)
      echo "   isolamento: modo compartilhado sob TRAVA EXCLUSIVA -- contenção imediata, NÃO é isolamento."
      echo "               alvo descartável de verdade: npm run db:security:isolado"
      ;;
    *)
      blocked "DB_SECURITY_ALVO='$ISO_MODO' é desconhecido. Use 'descartavel' ou 'compartilhado'."
      ;;
  esac
}

# ---------------------------------------------------------------- 2. trava exclusiva
# A trava é de SESSÃO: morre com a sessão que a pegou. Por isso um psql de vida longa fica
# segurando (stdin aberto por um pipe) enquanto a suíte roda. O veredito dele não basta: a
# sessão principal confere em pg_locks que a trava existe mesmo neste banco.
iso_trava_adquirir() {
  local saida="$ISO_TMP/trava.saida" erro="$ISO_TMP/trava.erro" veredito presa i
  ISO_TRAVA_SINAL="$ISO_TMP/trava.ativa"
  : >"$ISO_TRAVA_SINAL"; : >"$saida"
  (
    cat <<SQL
\o $saida
select case when pg_try_advisory_lock($ISO_TRAVA_A, $ISO_TRAVA_B) then 'TRAVADO' else 'OCUPADO' end;
\o
SQL
    # Mantém o stdin do psql aberto (logo, a sessão viva) até o sinal sair. O teto de
    # iterações existe para não deixar processo imortal se a suíte morrer de -9.
    i=0
    while [ -e "$ISO_TRAVA_SINAL" ] && [ "$i" -lt 18000 ]; do sleep 0.2; i=$((i + 1)); done
  ) | psql -X -q -At -v ON_ERROR_STOP=1 "$URL" >/dev/null 2>"$erro" &
  ISO_TRAVA_PID=$!

  for i in $(seq 1 200); do [ -s "$saida" ] && break; sleep 0.1; done
  veredito="$(tr -d '[:space:]' <"$saida" 2>/dev/null)"
  case "$veredito" in
    TRAVADO) ;;
    OCUPADO) blocked "outra execução já tem a trava exclusiva deste alvo (advisory $ISO_TRAVA_A/$ISO_TRAVA_B). Duas execuções não podem dividir a mesma massa de teste: espere a outra terminar." ;;
    *)       blocked "não consegui pegar a trava exclusiva do alvo: $(tr '\n' ' ' <"$erro" 2>/dev/null | cut -c1-200). Recuso rodar sem exclusividade." ;;
  esac
  # Segunda via: a trava existe no catálogo, neste banco, concedida?
  presa="$(psql_q -c "select count(*) from pg_locks
                       where locktype = 'advisory' and granted
                         and classid = $ISO_TRAVA_A and objid = $ISO_TRAVA_B
                         and database = (select oid from pg_database where datname = current_database())" 2>/dev/null)"
  [ "${presa:-0}" -ge 1 ] 2>/dev/null \
    || blocked "a sessão da trava disse TRAVADO, mas pg_locks não mostra a trava presa neste banco (obtido: '${presa:-vazio}'). Recuso seguir com uma trava que não consigo confirmar."
  echo "   trava: exclusiva e confirmada em pg_locks (advisory $ISO_TRAVA_A/$ISO_TRAVA_B)"
}

iso_trava_liberar() {
  [ -n "$ISO_TRAVA_SINAL" ] && rm -f "$ISO_TRAVA_SINAL"
  if [ -n "$ISO_TRAVA_PID" ]; then
    local i
    for i in $(seq 1 30); do kill -0 "$ISO_TRAVA_PID" 2>/dev/null || break; sleep 0.2; done
    kill "$ISO_TRAVA_PID" 2>/dev/null || true
    ISO_TRAVA_PID=""
  fi
}

# ---------------------------------------------------------------- 3. massa exclusiva
iso_massa() {
  local snap="$1" t v sujas="" vazias=""
  # Pré-condição de ambiente: dados de referência presentes (o seed tem FK para eles).
  for t in $ISO_TABELAS_REFERENCIA; do
    v="$(iso_valor "$snap" "$t")"
    [ -n "$v" ] || blocked "o alvo não tem a tabela de referência $t. Não é alvo desta suíte."
    [ "$v" -gt 0 ] 2>/dev/null || vazias="$vazias $t"
  done
  [ -z "$vazias" ] || blocked "dados de referência ausentes no alvo ($(echo "$vazias" | sed 's/^ //') sem linhas): as fixtures do seed têm FK para eles. Alvo incompleto não é alvo reprovado -- construa o alvo (npm run db:security:isolado) ou aplique as migrations."

  if [ "$ISO_MODO" = descartavel ]; then
    # Declarou instância descartável e exclusiva? Então nenhuma tabela de negócio tem linha
    # de ninguém. É assim que uma conexão apontada para o banco COMPARTILHADO é recusada:
    # o banco compartilhado carrega massa de outras unidades, e isso é medido, não confiado.
    while IFS= read -r linha; do
      case "$linha" in zz_estrutura=*|'') continue ;; esac
      t="${linha%%=*}"; v="${linha##*=}"
      case " $ISO_TABELAS_REFERENCIA " in *" $t "*) continue ;; esac
      [ "$v" = 0 ] || sujas="$sujas $t=$v"
    done <<EOF
$snap
EOF
    [ -z "$sujas" ] || blocked "DB_SECURITY_ALVO=descartavel foi declarado, mas o alvo TRAZ MASSA QUE NÃO É DESTA SUÍTE ($(echo "$sujas" | sed 's/^ //')). Isto não é instância descartável e exclusiva: é banco compartilhado. Não consegui verificar em condições isoladas."
    echo "   massa: todas as tabelas de negócio vazias (referência: $(echo "$ISO_TABELAS_REFERENCIA" | tr ' ' ',')) -- declaração de descartável CONFIRMADA"
  else
    # Contenção: no mínimo as tabelas que os cenários contam sem filtro têm de estar livres.
    for t in $ISO_TABELAS_CONTADAS; do
      v="$(iso_valor "$snap" "$t")"
      [ -n "$v" ] || blocked "o alvo não tem a tabela $t, que os cenários contam. Não é alvo desta suíte."
      [ "$v" = 0 ] || sujas="$sujas $t=$v"
    done
    [ -z "$sujas" ] || blocked "o alvo já traz massa de terceiros nas tabelas que os cenários contam SEM FILTRO ($(echo "$sujas" | sed 's/^ //'), esperado 0). Foi exatamente assim que o cenário 4 ficou vermelho sem nenhuma falha de segurança. Não consegui verificar em condições isoladas: limpe o alvo ou use npm run db:security:isolado."
    echo "   massa: tabelas contadas sem filtro estão livres ($(echo "$ISO_TABELAS_CONTADAS" | tr ' ' ','))"
  fi

  local vest
  vest="$(iso_vestigio)"
  [ -n "$vest" ] || blocked "não consegui conferir vestígio de execução anterior no alvo."
  [ "$vest" = 0 ] || blocked "o alvo tem VESTÍGIO de uma execução anterior da suíte (evento/usuários do seed ou public.zz_autoteste ainda presentes: $vest). Algum rollback não aconteceu; o alvo não está em estado conhecido."
}

# ---------------------------------------------------------------- 4. sentinela entre cenários
# Primeira chamada grava a linha de base. As seguintes comparam. Devolve:
#   0 -> alvo intacto
#   1 -> mudou COM vestígio da suíte: rollback não aconteceu => é FALHA da suíte (ISO_MOTIVO)
#   (não devolve) -> mudou SEM vestígio: terceiro escreveu durante a execução => BLOCKED
iso_marco() {
  local rotulo="$1" atual antes depois mudou vest
  atual="$(iso_snapshot)"
  [ -n "$atual" ] || blocked "a medição da massa do alvo voltou VAZIA ($rotulo). Recuso seguir sem medida -- estrutura vazia não é 'nada a reclamar'."
  if [ -z "$ISO_SNAP_ANTERIOR" ]; then
    ISO_SNAP_ANTERIOR="$atual"; ISO_SNAP_ROTULO="$rotulo"; return 0
  fi
  if [ "$atual" = "$ISO_SNAP_ANTERIOR" ]; then
    ISO_SNAP_ROTULO="$rotulo"; return 0
  fi

  antes="$ISO_TMP/snap.antes"; depois="$ISO_TMP/snap.depois"
  printf '%s\n' "$ISO_SNAP_ANTERIOR" >"$antes"; printf '%s\n' "$atual" >"$depois"
  mudou="$(diff "$antes" "$depois" | sed -n 's/^< \(.*\)$/\1/p' | while IFS= read -r l; do
             t="${l%%=*}"; v="${l##*=}"
             n="$(sed -n "s/^$t=//p" "$depois" | head -1)"
             [ "$v" = "$n" ] || printf '%s: %s -> %s; ' "$t" "$v" "${n:-ausente}"
           done)"
  [ -n "$mudou" ] || mudou="$(diff "$antes" "$depois" | tr '\n' ' ' | cut -c1-200)"

  vest="$(iso_vestigio)"
  if [ -n "$vest" ] && [ "$vest" != 0 ]; then
    ISO_MOTIVO="o alvo mudou entre '$ISO_SNAP_ROTULO' e '$rotulo' E há vestígio da própria suíte no banco: algum rollback não aconteceu ($mudou)"
    ISO_SNAP_ANTERIOR="$atual"; ISO_SNAP_ROTULO="$rotulo"
    return 1
  fi
  blocked "o alvo MUDOU entre '$ISO_SNAP_ROTULO' e '$rotulo' sem vestígio nenhum da suíte ($mudou): outro processo está escrevendo no alvo DURANTE a execução. Não consegui verificar em condições isoladas -- isto não é reprovação de segurança."
}

# ---------------------------------------------------------------- porta de entrada
# Ordem importa: identidade e modo primeiro (aparecem no log mesmo se a porta fechar), depois
# trava (para a massa ser medida já sob exclusividade), depois massa, depois linha de base.
iso_porta_de_entrada() {
  iso_contrato
  iso_identidade
  iso_modo
  iso_trava_adquirir
  local snap
  snap="$(iso_snapshot)"
  [ -n "$snap" ] || blocked "não consegui medir a massa do alvo (permissão?). Sem medida não há isolamento verificado."
  iso_massa "$snap"
  ISO_SNAP_ANTERIOR="$snap"; ISO_SNAP_ROTULO="antes do primeiro cenário"
}
