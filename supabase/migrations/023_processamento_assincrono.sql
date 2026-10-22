-- PROPOSTA DE MIGRATION (nome sugerido: 023_processamento_assincrono.sql).
--
-- ESTE ARQUIVO NAO ESTA EM supabase/migrations/ DE PROPOSITO: a gravacao la foi
-- negada a esta unidade (diretorio compartilhado, numeracao disputada por outras
-- unidades -- a 022 ja tinha dono quando isto foi escrito). Quem controla a serie
-- move este arquivo, escolhe o numero e decide quando aplicar. Ele foi validado
-- contra Postgres DESCARTAVEL (lib/erros/provas/), depois de TODAS as migrations
-- 001-022, e nao foi aplicado em lugar nenhum.
--
-- Enquanto nao for aplicada, o processamento de evento ASSINCRONO recusa com
-- ASYNC_PROCESSING_MISSING (a mensagem manda aplicar). O modo `live` nao depende
-- dela em nada.
--
-- DUAS EXIGENCIAS DO RESPONSAVEL TECNICO
-- ----------------------------------------
-- 1. "O banco deve fornecer a referencia temporal de autorizacao, evitando
--    diferencas entre o relogio do navegador, do servidor Next.js e do
--    PostgreSQL."
--    form_closes_at e um instante gravado pelo banco. Compara-lo com o relogio
--    de outro host (a funcao na Vercel) decidiria o inicio do processamento por
--    uma divergencia de relogio. `referencia_temporal_do_banco()` devolve o
--    relogio do PROPRIO Postgres, e `jobs_iniciar_assincrono` decide com ele.
--
-- 2. "O inicio do processamento precisa utilizar um conjunto consistente de
--    respostas ja confirmadas. Uma submissao valida sendo gravada no limite da
--    janela nao pode gerar um documento baseado numa fotografia desatualizada."
--
-- A CORRIDA, concretamente
-- ------------------------
-- A policy de INSERT/UPDATE de quiz_responses (010, REGRA 6) avalia
-- `now() <= form_closes_at + 15min`, e `now()` e o instante em que a TRANSACAO
-- COMECOU. Uma submissao legitima que comecou antes do limite pode, portanto,
-- COMMITAR depois dele. Se o inicio do processamento leu a lista de elegiveis
-- nesse intervalo, essa pessoa fica de fora da fila, ou -- pior -- entra com a
-- fotografia das respostas de antes do commit. Documento individual errado sobre
-- uma pessoa real e o pior desfecho possivel.
--
-- O MECANISMO, e por que ele e este
-- ---------------------------------
-- (a) O limite e fechado pelo relogio do banco: so se inicia com
--     clock_timestamp() >= form_closes_at + tolerancia.
-- (b) QUIESCENCIA: depois do limite nenhuma transacao NOVA consegue gravar
--     resposta pela policy (now() > limite). Logo, o unico risco e uma
--     transacao que comecou ANTES do limite e AINDA esta aberta. O inicio
--     consulta pg_stat_activity e RECUSA (snapshot_instavel) se existir qualquer
--     outra transacao de cliente aberta com xact_start <= limite. Recusar e o
--     default seguro: o host tenta de novo em instantes; nada e processado sobre
--     fotografia que nao se sabe completa.
--     Por que nao um lock: os escritores sao PostgREST/RLS e nao tomam lock do
--     evento; nao ha ponto em que um lock desta funcao os alcance sem mudar as
--     policies de outra unidade.
-- (c) FOTOGRAFIA UNICA: elegiveis e impressao digital (md5 de id, completed_at e
--     das respostas de cada elegivel) sao lidas numa UNICA instrucao SQL, logo
--     num unico snapshot.
-- (d) VALIDACAO NO FIM: depois de enfileirar, a impressao digital e recalculada.
--     Se mudou -- um commit caiu no meio, por qualquer caminho, inclusive
--     escritores que ignoram a policy (service_role, importacao) --, a funcao
--     LEVANTA EXCECAO e a transacao inteira desfaz: nenhum job fica criado. A
--     alternativa (seguir adiante) seria processar uma fotografia que nao se sabe
--     completa.
-- (e) `for update` na linha do evento serializa dois inicios simultaneos
--     (dois administradores clicando ao mesmo tempo).
--
-- SECURITY DEFINER, e por que: pelo PostgREST a funcao roda como `service_role`, que
-- NAO e membro de pg_read_all_stats; sem isso a quiescencia nao enxerga as outras
-- transacoes (pg_stat_activity esconde xact_start). A propria funcao detecta o caso e
-- falha FECHADA (observabilidade_indisponivel) -- foi assim que o problema apareceu na
-- prova de HTTP. Como definer ela roda como o dono da migration (que e membro). Os
-- nomes sao todos qualificados e search_path e vazio; so service_role executa.
--
-- O QUE ISTO NAO COBRE, declarado: um escritor que ignora a policy E comita
-- depois do fim desta funcao altera dados de quem ja esta na fila; o worker nao
-- compara a impressao digital na hora de gerar (lib/jobs e de outra unidade). A
-- impressao digital fica registrada (retorno e event_logs, pela rota) para
-- auditoria. Alem disso `participants.completed_at` e gravado por
-- /api/complete-quiz com o relogio do Node, depois do ultimo envio: quem
-- terminou dentro da tolerancia mas cuja conclusao so chega depois NAO entra
-- nesta rodada e entra ao reprocessar (jobs_enfileirar e idempotente).

create or replace function public.referencia_temporal_do_banco()
returns timestamptz
language sql
volatile
set search_path = ''
as $$ select clock_timestamp() $$;

-- Devolve jsonb. Recusas ESPERADAS voltam como { ok: false, motivo, ... } SEM
-- erro (nada foi escrito). Inconsistencia LEVANTA EXCECAO (para desfazer).
--   motivo: evento_inexistente | modo_nao_assincrono | janela_indeterminada |
--           coleta_aberta | snapshot_instavel | observabilidade_indisponivel |
--           sem_elegiveis
create or replace function public.jobs_iniciar_assincrono(
  p_event_id            uuid,
  p_kind                text default 'prognostico',
  p_max_attempts        int  default 3,
  p_tolerancia_segundos int  default 900,
  -- true = confere (a), (b) e (c) e DEVOLVE a fotografia sem enfileirar. Usado pela
  -- rota do lote antigo, que gera em processo e nao usa a fila.
  p_somente_verificar   boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_evento      record;
  v_agora       timestamptz := clock_timestamp();
  v_limite      timestamptz;
  v_abertas     int;
  v_mais_antiga timestamptz;
  v_ids         uuid[];
  v_digest_ini  text;
  v_digest_fim  text;
  v_total       int;
  v_criados     int := 0;
  v_reaprov     int := 0;
  v_id          uuid;
  v_linha       record;
begin
  select e.id, e.mode, e.form_opens_at, e.form_closes_at
    into v_evento
    from public.events e
   where e.id = p_event_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'evento_inexistente');
  end if;
  if v_evento.mode is distinct from 'async' then
    return jsonb_build_object('ok', false, 'motivo', 'modo_nao_assincrono', 'modo', v_evento.mode);
  end if;
  if v_evento.form_closes_at is null
     or (v_evento.form_opens_at is not null and v_evento.form_opens_at > v_evento.form_closes_at) then
    return jsonb_build_object('ok', false, 'motivo', 'janela_indeterminada');
  end if;

  -- (a) O limite, pelo relogio do banco.
  v_limite := v_evento.form_closes_at + make_interval(secs => p_tolerancia_segundos);
  if v_agora < v_limite then
    return jsonb_build_object(
      'ok', false, 'motivo', 'coleta_aberta',
      'agora', v_agora, 'encerra_em', v_evento.form_closes_at, 'limite', v_limite);
  end if;

  -- (b) Quiescencia. Sem poder OBSERVAR as outras transacoes, nao se afirma
  -- nada: pg_stat_activity esconde xact_start de outros usuarios de quem nao
  -- tem pg_read_all_stats, e um "nenhuma transacao aberta" falso seria o pior
  -- resultado possivel. Falha fechada.
  if not (pg_has_role(current_user, 'pg_read_all_stats', 'member')
          or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user)) then
    return jsonb_build_object('ok', false, 'motivo', 'observabilidade_indisponivel');
  end if;

  select count(*), min(a.xact_start)
    into v_abertas, v_mais_antiga
    from pg_catalog.pg_stat_activity a
   where a.datname = current_database()
     and a.pid <> pg_backend_pid()
     and a.backend_type = 'client backend'
     and a.xact_start is not null
     and a.xact_start <= v_limite;

  if v_abertas > 0 then
    return jsonb_build_object(
      'ok', false, 'motivo', 'snapshot_instavel',
      'transacoes_abertas', v_abertas, 'mais_antiga', v_mais_antiga,
      'agora', v_agora, 'limite', v_limite);
  end if;

  -- (c) Fotografia unica: elegiveis + impressao digital numa so instrucao.
  with elegiveis as (
    select p.id,
           p.id::text || ':' || coalesce(p.completed_at::text, '') || ':' ||
           coalesce((select md5(string_agg(r.stage_id::text || '=' || r.answers::text, ',' order by r.stage_id))
                       from public.quiz_responses r
                      where r.participant_id = p.id), '') as parte
      from public.participants p
     where p.event_id = p_event_id and p.completed_at is not null
  )
  select array_agg(id order by id),
         md5(coalesce(string_agg(parte, '|' order by id), '')),
         count(*)
    into v_ids, v_digest_ini, v_total
    from elegiveis;

  if v_total = 0 or v_ids is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_elegiveis');
  end if;

  if p_somente_verificar then
    return jsonb_build_object(
      'ok', true, 'total', v_total, 'criados', 0, 'reaproveitados', 0,
      'digest', v_digest_ini, 'agora', v_agora, 'limite', v_limite, 'ids', to_jsonb(v_ids));
  end if;

  -- Enfileira EXATAMENTE o conjunto fotografado.
  foreach v_id in array v_ids loop
    select * into v_linha from public.jobs_enfileirar(p_kind, p_event_id, v_id, 0, p_max_attempts);
    if v_linha.criado then v_criados := v_criados + 1; else v_reaprov := v_reaprov + 1; end if;
  end loop;

  -- (d) Validacao no fim: a mesma fotografia, recalculada.
  with elegiveis as (
    select p.id,
           p.id::text || ':' || coalesce(p.completed_at::text, '') || ':' ||
           coalesce((select md5(string_agg(r.stage_id::text || '=' || r.answers::text, ',' order by r.stage_id))
                       from public.quiz_responses r
                      where r.participant_id = p.id), '') as parte
      from public.participants p
     where p.event_id = p_event_id and p.completed_at is not null
  )
  select md5(coalesce(string_agg(parte, '|' order by id), ''))
    into v_digest_fim
    from elegiveis;

  if v_digest_fim is distinct from v_digest_ini then
    raise exception 'SNAPSHOT_INSTAVEL: o conjunto de respostas confirmadas mudou durante o inicio do processamento (evento %)', p_event_id
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'total', v_total, 'criados', v_criados, 'reaproveitados', v_reaprov,
    'digest', v_digest_ini, 'agora', v_agora, 'limite', v_limite);
end;
$$;

-- Privilegios: como as funcoes da 018, so service_role executa.
do $$
declare f text;
begin
  foreach f in array array[
    'public.referencia_temporal_do_banco()',
    'public.jobs_iniciar_assincrono(uuid, text, int, int, boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
