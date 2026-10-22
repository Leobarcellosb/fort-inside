-- 018_fila_jobs.sql
-- Fila de jobs por participante: a geração de prognóstico deixa de depender da
-- sobrevivência de uma requisição HTTP de cinco minutos.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014 e a 015.
--
-- ===========================================================================
-- Por que existe
-- ===========================================================================
-- `app/api/batch-process/route.ts` gera tudo dentro de UMA requisição, em ondas
-- de 10, com maxDuration = 300. O comentário do próprio arquivo declara o alvo:
-- "com ~63s por prognóstico, 10 por onda entrega 20 participantes em ~2 min".
-- Foi dimensionado para 20.
--
-- Com 50 participantes são 5 ondas de geração (~315s, já acima do teto) e
-- depois 5 ondas de renderização de PDF, na mesma requisição. E 63s é a mediana
-- de UMA medição, não uma distribuição: como a onda dura o tempo do mais lento,
-- 315s é otimista.
--
-- O modo de falha é pior que a lentidão. O evento recebe `processing` na
-- primeira linha e `completed` na última. Se a função for cortada no meio:
-- alguns prognósticos ficam gravados, outros não existem, a resposta nunca
-- chega, o evento fica preso em `processing` para sempre e o log morre junto
-- com a função -- não sobra registro de quem falhou. Já aconteceu em produção.
--
-- A fila troca isso por estado persistido: cada participante é uma LINHA, e
-- qualquer worker futuro consegue responder "o que falta" lendo o banco.
--
-- ===========================================================================
-- O estado do JOB não é o estado do DOCUMENTO
-- ===========================================================================
-- A 015 governa `prognostics.status` (pending -> generating -> generated ->
-- in_review -> reviewed -> delivered), que NUNCA regride. O estado aqui é o da
-- TENTATIVA DE TRABALHO, que regride o tempo todo: running volta para pending
-- quando a tentativa falha e ainda há retentativa. São máquinas separadas, em
-- tabelas separadas, de propósito. Nada nesta migration escreve em
-- `prognostics`; quem escreve lá é o executor, pela função que já existe, e com
-- as travas de estado que a 015 impõe.
--
-- ===========================================================================
-- Reivindicação: por que é exclusiva
-- ===========================================================================
-- Três camadas, nesta ordem, dentro de `jobs_reivindicar`:
--
--   1. `pg_advisory_xact_lock` por `kind`. Serializa a janela em que as vagas
--      globais são contadas e consumidas. Sem ele, dois workers leriam
--      "0 em execução" ao mesmo tempo e cada um reivindicaria o teto inteiro --
--      com cron de 1 em 1 minuto e tick de até 300s, cinco ticks sobrepostos
--      virariam 5x o teto de concorrência. O lock é de transação: morre no
--      commit, no rollback e na queda da conexão, sem destravamento manual.
--      É barato porque a seção crítica é um único UPDATE.
--   2. `for update skip locked` na seleção dos candidatos. Garantia de que duas
--      transações não pegam a mesma linha mesmo que alguém, no futuro, chame o
--      UPDATE sem o lock consultivo.
--   3. O próprio UPDATE só casa linhas em `pending` (ou `running` com lease
--      vencido): depois dele o estado da linha já exclui o concorrente.
--
-- Nada disso depende de recurso externo: é Postgres puro, sem extensão.
--
-- ===========================================================================
-- Lease + token de execução (fencing)
-- ===========================================================================
-- Reivindicar grava `lease_expires_at` e um `run_token` novo. O worker renova o
-- lease enquanto trabalha. Se a função for cortada, o lease vence e OUTRO worker
-- reivindica -- gerando um run_token NOVO.
--
-- Quando o worker antigo volta do limbo e tenta gravar o resultado dele, o
-- UPDATE exige `run_token = <o token dele>`. O token mudou, nenhuma linha casa,
-- e o resultado velho é DESCARTADO em vez de sobrescrever o da tentativa mais
-- recente. É o mesmo princípio de fencing token de qualquer lock distribuído, e
-- é a razão de o token ser gerado no banco (no momento da reivindicação) e não
-- no worker.
--
-- ===========================================================================
-- Entrega AO MENOS UMA VEZ -- não exatamente uma vez
-- ===========================================================================
-- Um worker pode terminar o trabalho e morrer ANTES de gravar o desfecho. O
-- lease vence, outro worker reivindica e refaz. Isso é inerente a fila: não
-- existe commit atômico entre "a Anthropic cobrou" e "o Postgres gravou".
--
-- O que a fila garante é a IDEMPOTÊNCIA DOS EFEITOS, não a unicidade da
-- execução: `prognostics` tem UNIQUE em participant_id, a regeração é recusada
-- pela 015 fora dos estados regeráveis, e a publicação do PDF é por
-- participante. Uma tentativa interrompida PODE ter consumido créditos de IA
-- sem deixar resultado -- isso está declarado, não disfarçado.
--
-- ===========================================================================
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),

  -- Que trabalho é este. Hoje só 'prognostico'; 'pdf' fica declarado porque a
  -- renderização é o segundo pedaço caro do lote atual e vai entrar pela mesma
  -- porta, sem migration nova.
  kind text not null,

  event_id       uuid not null references public.events(id)       on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  status text not null default 'pending',

  -- Ordem de atendimento. Maior primeiro; empate resolve por created_at.
  priority int not null default 0,

  -- Tentativas JÁ INICIADAS (incrementa na reivindicação, não no desfecho).
  -- Contar na reivindicação é o que torna o contador honesto: uma tentativa que
  -- morreu sem gravar nada continua aparecendo aqui. Como toda tentativa de
  -- 'prognostico' chama o modelo, este número é também o piso de chamadas de IA
  -- potencialmente cobradas para este participante.
  attempts     int not null default 0,
  max_attempts int not null default 3,

  -- Antes deste instante a linha não é candidata. É o backoff entre tentativas.
  available_at timestamptz not null default now(),

  -- Reivindicação em vigor.
  run_token        uuid,
  lease_expires_at timestamptz,
  claimed_by       text,

  -- Visibilidade de duração, sem depender dos logs da Vercel.
  first_attempt_at   timestamptz,  -- início da PRIMEIRA tentativa (nunca reescrito)
  attempt_started_at timestamptz,  -- início da tentativa ATUAL
  finished_at        timestamptz,
  last_duration_ms   int,          -- duração da última tentativa que chegou ao fim
  total_duration_ms  bigint not null default 0,  -- soma das tentativas: o custo real

  last_error      text,
  last_error_code text,

  result   jsonb,  -- {prognostic_id, trail} no caso do prognóstico
  ai_usage jsonb,  -- reservado; ver LIMITAÇÃO no fim do arquivo

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Um job por participante por tipo. Reprocessar NÃO cria linha nova: reusa
  -- esta, preservando o histórico de tentativas. É também o que torna o
  -- enfileiramento idempotente (`on conflict do nothing`), para que um clique
  -- duplo em "Processar" não duplique trabalho pago.
  unique (kind, participant_id)
);

do $$
begin
  -- CHECKs em bloco idempotente: `add constraint if not exists` não existe.
  alter table public.jobs drop constraint if exists jobs_kind_check;
  alter table public.jobs add constraint jobs_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs drop constraint if exists jobs_status_check;
  alter table public.jobs add constraint jobs_status_check
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'canceled'));

  alter table public.jobs drop constraint if exists jobs_max_attempts_check;
  alter table public.jobs add constraint jobs_max_attempts_check
    check (max_attempts >= 1 and attempts >= 0);
end
$$;

-- Índice da fila. Parcial nos dois estados que a reivindicação olha: as linhas
-- terminais (que são a maioria depois do evento) ficam fora do índice.
create index if not exists jobs_fila_idx
  on public.jobs (kind, available_at, priority desc, created_at)
  where status in ('pending', 'running');

-- Contagem de vagas globais e varredura de lease vencido.
create index if not exists jobs_lease_idx
  on public.jobs (kind, lease_expires_at)
  where status = 'running';

-- Painel/ops: "como está o evento X".
create index if not exists jobs_evento_idx
  on public.jobs (event_id, kind, status);

comment on table public.jobs is
  'Fila de trabalho por participante. O estado AQUI é o da tentativa; o estado do documento vive em prognostics.status (migration 015) e nunca regride.';

-- updated_at: reusa a função da 001.
drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS e privilégios
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA (lição da 014): privilégio de coluna não subtrai de privilégio
-- de tabela, e o Supabase concede a tabela inteira a anon e authenticated por
-- padrão. Revoga-se a tabela primeiro; só então o que sobra é o que foi
-- reconcedido explicitamente.
alter table public.jobs enable row level security;

revoke all on table public.jobs from anon;
revoke all on table public.jobs from authenticated;

-- O admin entra como `authenticated` com app_metadata.role = 'admin', então ele
-- precisa do privilégio de SELECT na tabela; quem filtra por pessoa é a policy.
-- O participante também é `authenticated`, mas is_admin() é false para ele e a
-- policy devolve zero linha: ele não enxerga job nenhum, nem o próprio.
-- anon não recebe privilégio algum: nem chega na policy (42501).
grant select on table public.jobs to authenticated;

-- Escrita: só service_role. Não existe policy de insert/update/delete, e sem
-- policy a RLS nega por padrão -- mas o privilégio revogado acima já barra
-- antes disso. service_role tem BYPASSRLS por desenho da plataforma: é por ele
-- que as rotas escrevem.
grant select, insert, update, delete on table public.jobs to service_role;

drop policy if exists "jobs_admin_read" on public.jobs;
create policy "jobs_admin_read" on public.jobs
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- jobs_enfileirar: cria (ou reaproveita) o job de um participante.
-- ---------------------------------------------------------------------------
-- `on conflict do nothing` em vez de `do update`: enfileirar NUNCA ressuscita um
-- job terminal. Um job que já terminou com sucesso não pode ser refeito por um
-- segundo clique em "Processar" -- para isso existe jobs_reenfileirar, que é
-- explícito e exige força para desfazer sucesso.
create or replace function public.jobs_enfileirar(
  p_kind           text,
  p_event_id       uuid,
  p_participant_id uuid,
  p_priority       int default 0,
  p_max_attempts   int default 3
)
returns table (id uuid, status text, criado boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.jobs (kind, event_id, participant_id, priority, max_attempts)
  values (p_kind, p_event_id, p_participant_id, p_priority, p_max_attempts)
  on conflict (kind, participant_id) do nothing
  returning public.jobs.id into v_id;

  if v_id is not null then
    return query select v_id, 'pending'::text, true;
    return;
  end if;

  return query
    select j.id, j.status, false
    from public.jobs j
    where j.kind = p_kind and j.participant_id = p_participant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_reivindicar: a reivindicação por lease.
-- ---------------------------------------------------------------------------
-- p_concorrencia_max é o TETO GLOBAL de jobs em execução com lease vivo, não um
-- teto por processo. Vem da configuração do worker (JOBS_CONCURRENCY, hoje 3).
-- Contado aqui dentro, sob o lock consultivo, para que ticks sobrepostos somem
-- em vez de multiplicar.
create or replace function public.jobs_reivindicar(
  p_kind             text,
  p_worker           text,
  p_lease_seconds    int default 180,
  p_limit            int default 1,
  p_concorrencia_max int default 3
)
returns table (
  id uuid,
  participant_id uuid,
  event_id uuid,
  run_token uuid,
  attempts int,
  max_attempts int,
  lease_expires_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_em_execucao int;
  v_vagas       int;
begin
  if p_lease_seconds < 5 then
    raise exception 'jobs_reivindicar: lease de % segundos é curto demais para ser renovado a tempo', p_lease_seconds
      using errcode = 'check_violation';
  end if;

  -- Serializa a janela "contar vagas e consumi-las". Transação-escopado.
  perform pg_advisory_xact_lock(hashtext('jobs_reivindicar:' || p_kind));

  select count(*) into v_em_execucao
  from public.jobs j
  where j.kind = p_kind
    and j.status = 'running'
    and j.lease_expires_at > now();

  v_vagas := least(coalesce(p_limit, 1), greatest(p_concorrencia_max - v_em_execucao, 0));

  if v_vagas <= 0 then
    return;
  end if;

  return query
  with candidatos as (
    select j.id
    from public.jobs j
    where j.kind = p_kind
      and j.available_at <= now()
      and j.attempts < j.max_attempts
      and (
        j.status = 'pending'
        -- Lease vencido: a tentativa anterior sumiu sem dar desfecho. Reivindicar
        -- daqui gera run_token novo, o que já invalida o worker que sumiu.
        or (j.status = 'running' and j.lease_expires_at <= now())
      )
    order by j.priority desc, j.created_at
    for update skip locked
    limit v_vagas
  )
  update public.jobs j
  set status             = 'running',
      attempts           = j.attempts + 1,
      run_token          = gen_random_uuid(),
      lease_expires_at   = now() + make_interval(secs => p_lease_seconds),
      claimed_by         = p_worker,
      attempt_started_at = now(),
      first_attempt_at   = coalesce(j.first_attempt_at, now()),
      finished_at        = null
  from candidatos c
  where j.id = c.id
  returning j.id, j.participant_id, j.event_id, j.run_token,
            j.attempts, j.max_attempts, j.lease_expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_renovar_lease: o worker diz "ainda estou vivo".
-- ---------------------------------------------------------------------------
-- Falso = o worker perdeu o job (lease tomado por outro, ou job já encerrado).
-- Quem recebe falso deve PARAR de trabalhar: o resultado dele vai ser recusado
-- de qualquer forma.
create or replace function public.jobs_renovar_lease(
  p_id            uuid,
  p_run_token     uuid,
  p_lease_seconds int default 180
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.jobs j
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_concluir: desfecho terminal da tentativa (succeeded | skipped | canceled).
-- ---------------------------------------------------------------------------
-- 'skipped' é o 409 de generatePrognostic: o documento avançou de estado
-- (in_review/reviewed/delivered) e regerar foi recusado DE PROPÓSITO. Não é
-- falha -- contar como falha inflaria o número em todo reprocessamento e
-- esconderia as falhas reais. É o mesmo tratamento que o lote de hoje dá.
--
-- `run_token = p_run_token and status = 'running'` é o fencing: o worker que
-- voltou do limbo não casa nenhuma linha e o resultado dele é descartado.
-- Devolve false nesse caso, para que o worker possa REGISTRAR que foi descartado
-- em vez de achar que gravou.
create or replace function public.jobs_concluir(
  p_id        uuid,
  p_run_token uuid,
  p_status    text,
  p_result    jsonb default null,
  p_ai_usage  jsonb default null
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_status not in ('succeeded', 'skipped', 'canceled') then
    raise exception 'jobs_concluir: status "%" não é desfecho de sucesso; use jobs_falhar', p_status
      using errcode = 'check_violation';
  end if;

  update public.jobs j
  set status            = p_status,
      finished_at       = now(),
      last_duration_ms  = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint,
      result            = coalesce(p_result, j.result),
      ai_usage          = coalesce(p_ai_usage, j.ai_usage),
      last_error        = null,
      last_error_code   = null,
      lease_expires_at  = null
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_falhar: a tentativa falhou. Reagenda ou encerra.
-- ---------------------------------------------------------------------------
-- Reagendar quando ainda há tentativa: volta para 'pending' com backoff. Essa
-- "regressão" é legítima porque é estado de JOB, não de documento.
-- Sem tentativa restante: 'failed', terminal e RASTREÁVEL (fica a mensagem, o
-- código, o número de tentativas e a duração somada).
create or replace function public.jobs_falhar(
  p_id              uuid,
  p_run_token       uuid,
  p_erro            text,
  p_codigo          text default null,
  p_backoff_seconds int default 30
)
returns table (aplicado boolean, status text, attempts int)
language plpgsql
set search_path = ''
as $$
declare
  v_row public.jobs;
begin
  update public.jobs j
  set status            = case when j.attempts >= j.max_attempts then 'failed' else 'pending' end,
      last_error        = left(coalesce(p_erro, 'erro sem mensagem'), 2000),
      last_error_code   = p_codigo,
      last_duration_ms  = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint,
      finished_at       = case when j.attempts >= j.max_attempts then now() else null end,
      available_at      = now() + make_interval(secs => greatest(coalesce(p_backoff_seconds, 0), 0)),
      lease_expires_at  = null,
      run_token         = null
  where j.id = p_id
    and j.run_token = p_run_token
    and j.status = 'running'
  returning j.* into v_row;

  if v_row.id is null then
    return query select false, null::text, null::int;
    return;
  end if;

  return query select true, v_row.status, v_row.attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_recuperar_expirados: retoma o que ficou para trás.
-- ---------------------------------------------------------------------------
-- Chamada no começo de cada tick. Dois desfechos:
--   - ainda há tentativa  -> volta para 'pending' AGORA, e o run_token é zerado
--                            (o worker sumido já não consegue gravar nada).
--   - acabaram as tentativas -> 'failed' com motivo explícito. Sem isto, um job
--                            que estourou o lease na última tentativa ficaria
--                            'running' para sempre: invisível e irrecuperável,
--                            que é exatamente o defeito que esta fila existe
--                            para eliminar.
create or replace function public.jobs_recuperar_expirados(
  p_kind  text,
  p_limit int default 100
)
returns table (id uuid, novo_status text, attempts int)
language plpgsql
set search_path = ''
as $$
begin
  return query
  with vencidos as (
    select j.id
    from public.jobs j
    where j.kind = p_kind
      and j.status = 'running'
      and j.lease_expires_at <= now()
    order by j.lease_expires_at
    for update skip locked
    limit p_limit
  )
  update public.jobs j
  set status = case when j.attempts >= j.max_attempts then 'failed' else 'pending' end,
      run_token = null,
      lease_expires_at = null,
      available_at = now(),
      finished_at = case when j.attempts >= j.max_attempts then now() else null end,
      last_error = 'lease expirado: a tentativa ' || j.attempts
                   || ' não deu desfecho (função cortada, processo morto ou rede). '
                   || case when j.attempts >= j.max_attempts
                           then 'Sem tentativas restantes.'
                           else 'Reagendado.' end,
      last_error_code = 'lease_expirado',
      last_duration_ms = (extract(epoch from (now() - j.attempt_started_at)) * 1000)::int,
      total_duration_ms = j.total_duration_ms
                          + (extract(epoch from (now() - j.attempt_started_at)) * 1000)::bigint
  from vencidos v
  where j.id = v.id
  returning j.id, j.status, j.attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_reenfileirar: operação manual de reprocessamento.
-- ---------------------------------------------------------------------------
-- Sem p_forcar, recusa desfazer sucesso ('succeeded'/'skipped'): a preservação
-- é a regra, e quem quiser quebrá-la escreve isso explicitamente. Com p_forcar,
-- o job volta à fila, mas a 015 continua valendo no documento: um prognóstico
-- em `delivered` será recusado de novo e o job terminará em 'skipped'.
create or replace function public.jobs_reenfileirar(
  p_id     uuid,
  p_forcar boolean default false
)
returns table (aplicado boolean, status_anterior text, motivo text)
language plpgsql
set search_path = ''
as $$
declare
  v_antes text;
begin
  select j.status into v_antes from public.jobs j where j.id = p_id;

  if v_antes is null then
    return query select false, null::text, 'job inexistente'::text;
    return;
  end if;

  if v_antes = 'running' then
    return query select false, v_antes,
      'job em execução com lease vivo; espere o lease vencer ou use jobs_cancelar'::text;
    return;
  end if;

  if v_antes in ('succeeded', 'skipped') and not p_forcar then
    return query select false, v_antes,
      'job já finalizado; reprocessar exige p_forcar = true'::text;
    return;
  end if;

  update public.jobs j
  set status = 'pending',
      attempts = 0,
      run_token = null,
      lease_expires_at = null,
      available_at = now(),
      finished_at = null,
      last_error = null,
      last_error_code = null
  where j.id = p_id;

  return query select true, v_antes, 'reenfileirado'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_cancelar: tira o job da fila sem fingir que deu certo.
-- ---------------------------------------------------------------------------
-- Para o job preso cuja tentativa ainda tem lease vivo e que ninguém quer mais.
-- 'canceled' é terminal e distinto de 'failed': não foi o trabalho que falhou,
-- foi a decisão de não fazer. O run_token é zerado, então a tentativa em voo
-- (se existir) terá o resultado recusado quando voltar.
create or replace function public.jobs_cancelar(p_id uuid, p_motivo text default null)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.jobs j
  set status = 'canceled',
      run_token = null,
      lease_expires_at = null,
      finished_at = now(),
      last_error = coalesce(p_motivo, 'cancelado manualmente'),
      last_error_code = 'cancelado'
  where j.id = p_id
    and j.status in ('pending', 'running', 'failed');

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_resumo_evento: "o evento acabou?" respondido pelo banco.
-- ---------------------------------------------------------------------------
-- O lote de hoje só sabe responder isso enquanto a requisição estiver viva.
-- Aqui a resposta é uma consulta, e qualquer worker, painel ou pessoa com psql
-- consegue fazê-la depois do fato.
create or replace function public.jobs_resumo_evento(p_event_id uuid, p_kind text default 'prognostico')
returns table (
  total int, pending int, running int, succeeded int, failed int, skipped int, canceled int,
  pendentes int, total_duration_ms bigint, attempts_total int
)
language sql
stable
set search_path = ''
as $$
  select
    count(*)::int,
    count(*) filter (where j.status = 'pending')::int,
    count(*) filter (where j.status = 'running')::int,
    count(*) filter (where j.status = 'succeeded')::int,
    count(*) filter (where j.status = 'failed')::int,
    count(*) filter (where j.status = 'skipped')::int,
    count(*) filter (where j.status = 'canceled')::int,
    count(*) filter (where j.status in ('pending', 'running'))::int,
    coalesce(sum(j.total_duration_ms), 0)::bigint,
    coalesce(sum(j.attempts), 0)::int
  from public.jobs j
  where j.event_id = p_event_id and j.kind = p_kind;
$$;

-- ---------------------------------------------------------------------------
-- jobs_fechar_evento_se_concluido: mata o estado indefinido.
-- ---------------------------------------------------------------------------
-- O evento preso em 'processing' para sempre é o defeito que motivou tudo isto.
-- A saída não pode ser "a última linha da requisição grava completed", porque é
-- justamente essa linha que não roda quando a função é cortada. Aqui é o
-- contrário: QUALQUER tick, de QUALQUER worker, fecha o evento assim que não
-- sobrar job não-terminal. Chamar duas vezes não faz mal (o segundo não casa
-- linha, porque o status já não é 'processing').
--
-- Só avança 'processing' -> 'completed'. Nunca mexe em 'draft' nem 'live', e
-- nunca volta de 'completed': quem controla o evento é o painel.
create or replace function public.jobs_fechar_evento_se_concluido(
  p_event_id uuid,
  p_kind     text default 'prognostico'
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_pendentes int;
  v_total     int;
  v_n         int;
begin
  select count(*) filter (where j.status in ('pending', 'running')), count(*)
    into v_pendentes, v_total
  from public.jobs j
  where j.event_id = p_event_id and j.kind = p_kind;

  -- Sem job nenhum deste evento: não é "concluído", é "nada foi enfileirado".
  -- Fechar aqui transformaria um enfileiramento que falhou em evento completo.
  if v_total = 0 or v_pendentes > 0 then
    return false;
  end if;

  update public.events e
  set status = 'completed'
  where e.id = p_event_id and e.status = 'processing';

  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
-- Toda função acima é SECURITY INVOKER (o padrão). Isso é deliberado: mesmo que
-- alguém reabra o EXECUTE por descuido, o chamador ainda esbarra no privilégio
-- de tabela revogado acima. Não há caminho em que anon ou authenticated
-- escrevam na fila.
--
-- O Supabase concede EXECUTE a public por padrão em função nova; é preciso
-- revogar e reconceder só para service_role.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.jobs_enfileirar(text,uuid,uuid,int,int)',
    'public.jobs_reivindicar(text,text,int,int,int)',
    'public.jobs_renovar_lease(uuid,uuid,int)',
    'public.jobs_concluir(uuid,uuid,text,jsonb,jsonb)',
    'public.jobs_falhar(uuid,uuid,text,text,int)',
    'public.jobs_recuperar_expirados(text,int)',
    'public.jobs_reenfileirar(uuid,boolean)',
    'public.jobs_cancelar(uuid,text)',
    'public.jobs_resumo_evento(uuid,text)',
    'public.jobs_fechar_evento_se_concluido(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. `ai_usage` nasce sempre NULL. Encher essa coluna exige que o executor
--    receba o `message.usage` da Anthropic, e hoje `generatePrognostic` devolve
--    apenas {ok, prognosticId, trail} -- o usage é descartado dentro dela. A
--    coluna existe para que o dia em que aquela função passar a devolver usage
--    não precise de migration. Enquanto isso, o proxy de custo é `attempts`:
--    toda tentativa de 'prognostico' chama o modelo, então attempts é o piso de
--    chamadas potencialmente cobradas.
--
-- 2. A fila garante AO MENOS UMA VEZ. Uma tentativa pode terminar o trabalho,
--    ser cortada antes de gravar o desfecho, e ser refeita. Não há commit
--    atômico entre a cobrança da Anthropic e o commit do Postgres, e nenhuma
--    fila resolve isso -- resolve-se com idempotência do efeito, que é o que a
--    015 e o UNIQUE de prognostics.participant_id dão.
--
-- 3. O teto de concorrência é o valor que o worker PASSA na reivindicação. Se
--    dois deploys divergirem no JOBS_CONCURRENCY, o teto efetivo é o do worker
--    que reivindicou. Mantenha um valor só, por ambiente.
--
-- 4. `jobs_fechar_evento_se_concluido` só olha jobs do tipo pedido. Quando o
--    tipo 'pdf' entrar, o fechamento precisa considerar os dois (é uma troca de
--    um `and j.kind = p_kind` por um `and j.kind = any(p_kinds)`).
