-- 019_heartbeat_worker.sql
-- Registro do TICK BEM-SUCEDIDO do worker da fila.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015 e a 018.
--
-- ===========================================================================
-- Por que existe: saúde do PROCESSAMENTO não é saúde do AGENDADOR
-- ===========================================================================
-- São duas propriedades diferentes, e a primeira NÃO substitui a segunda:
--
--   saúde do processamento -> existe trabalho avançando. Dá para derivar de
--     `jobs`: alguém reivindicou, renovou lease ou gravou desfecho há pouco.
--
--   saúde do agendador -> o cron executou, o handler CONCLUIU, e novas
--     execuções continuam chegando no intervalo esperado. Isso NÃO é derivável
--     de `jobs`: um tick que reivindica um job e estoura em seguida deixa
--     `jobs.updated_at` fresquinho e parece saudável por até um lease inteiro.
--     E um tick que roda com a fila vazia (o caso normal na maior parte do
--     tempo) não toca em `jobs` nenhum -- logo não deixa rastro algum.
--
-- Até esta migration, o indicador 1 era DERIVADO e se declarava derivado. O
-- buraco estava medido: `lib/jobs/provas`, caso [SAUDE-6]. Esta tabela fecha o
-- buraco gravando o fato que faltava.
--
-- ===========================================================================
-- Por que uma TABELA e não `event_logs`
-- ===========================================================================
-- `event_logs` era o único lugar gravável sem schema novo, e foi descartado por
-- medida: a página do evento lê as ÚLTIMAS 50 LINHAS de event_logs e as
-- apresenta como a linha do tempo da operação. Um heartbeat a cada 45s
-- expulsaria daquela janela todo o histórico real (liberação de etapa,
-- enfileiramento) em menos de uma hora. Trocar visibilidade da fila por
-- cegueira na operação não é troca.
--
-- `jobs` também não serve: `event_id` e `participant_id` são NOT NULL com FK e
-- `kind` tem CHECK -- não existe linha sintética de heartbeat possível.
--
-- ===========================================================================
-- UMA LINHA POR KIND, sobrescrita. Não é log, é marcador.
-- ===========================================================================
-- A pergunta que esta tabela responde é "QUANDO foi o último tick que terminou
-- inteiro?". Para isso basta uma linha por tipo de trabalho, atualizada no
-- lugar: não cresce, não precisa de expurgo, não entra em nenhuma listagem da
-- interface. O histórico de QUANTO já rodou fica no contador `ticks_ok`, que só
-- sobe -- é o que permite dizer "as execuções continuam chegando" comparando
-- duas leituras, em vez de só olhar um instante.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_worker_heartbeat (
  -- Mesmo domínio de `jobs.kind`. Sem FK porque não há tabela de tipos; o CHECK
  -- é a trava, igual ao da 018.
  kind text primary key,

  -- O fato que não dava para derivar: o instante em que um tick chegou até a
  -- ÚLTIMA linha dele. Quem grava é `jobs_registrar_tick_ok`, chamada no fim de
  -- `rodarTick` -- um tick cortado no meio nunca a alcança.
  ultimo_tick_ok_em timestamptz not null,

  -- Quem foi. Responde "qual deploy/instância estava executando o agendador".
  worker text not null,

  -- Duração do tick que terminou. Com o orçamento do tick (240s) ao lado, diz
  -- se os ticks estão rente ao teto -- sinal de que a concorrência está baixa
  -- para o volume, antes de alguém notar pela fila crescendo.
  duracao_ms int,

  -- Monotônico. Duas leituras espaçadas dizem se NOVAS execuções continuam
  -- chegando, que é parte da definição de saúde do agendador; um timestamptz
  -- sozinho não distingue "chegando de minuto em minuto" de "chegou uma vez".
  ticks_ok bigint not null default 0,

  -- {reivindicados, sucesso, pulados, falhas, descartados, recuperados}: o que
  -- aquele tick fez. É o resumo que morria no log da função.
  resumo jsonb,

  updated_at timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_worker_heartbeat drop constraint if exists jobs_worker_heartbeat_kind_check;
  alter table public.jobs_worker_heartbeat add constraint jobs_worker_heartbeat_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs_worker_heartbeat drop constraint if exists jobs_worker_heartbeat_ticks_check;
  alter table public.jobs_worker_heartbeat add constraint jobs_worker_heartbeat_ticks_check
    check (ticks_ok >= 0);
end
$$;

comment on table public.jobs_worker_heartbeat is
  'Marcador do último tick do worker que terminou INTEIRO (saúde do agendador). Uma linha por kind, sobrescrita. Não confundir com o progresso derivado de jobs.updated_at, que é saúde do processamento.';

-- Sem índice além da PK: a tabela tem no máximo uma linha por kind.

drop trigger if exists jobs_worker_heartbeat_updated_at on public.jobs_worker_heartbeat;
create trigger jobs_worker_heartbeat_updated_at
  before update on public.jobs_worker_heartbeat
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS e privilégios -- mesma ordem da 014/018
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA: privilégio de coluna não subtrai de privilégio de tabela, e o
-- Supabase concede a tabela inteira a anon e authenticated por padrão. Revoga-se
-- a tabela primeiro; só então o que sobra é o que foi reconcedido.
alter table public.jobs_worker_heartbeat enable row level security;

revoke all on table public.jobs_worker_heartbeat from anon;
revoke all on table public.jobs_worker_heartbeat from authenticated;

-- O admin precisa LER para o painel de saúde responder "o agendador está
-- executando?". O participante é `authenticated` também, mas is_admin() é false
-- para ele e a policy devolve zero linha. anon não recebe privilégio algum.
grant select on table public.jobs_worker_heartbeat to authenticated;

-- Escrita só service_role: quem grava é o worker, nunca o navegador.
grant select, insert, update, delete on table public.jobs_worker_heartbeat to service_role;

drop policy if exists "jobs_worker_heartbeat_admin_read" on public.jobs_worker_heartbeat;
create policy "jobs_worker_heartbeat_admin_read" on public.jobs_worker_heartbeat
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- jobs_registrar_tick_ok: grava que um tick terminou INTEIRO.
-- ---------------------------------------------------------------------------
-- Chamada na ÚLTIMA linha de `rodarTick`. É nisso que está toda a diferença
-- entre "a rota foi chamada" e "o tick teve sucesso": qualquer exceção antes
-- deste ponto -- na recuperação, na reivindicação, na execução, no fechamento
-- do evento -- impede a gravação, e o marcador continua apontando para o último
-- tick que de fato terminou.
--
-- `on conflict do update` incondicional é correto aqui: o marcador é o ÚLTIMO
-- tick ok, e um tick que acabou agora é sempre mais recente que o anterior.
create or replace function public.jobs_registrar_tick_ok(
  p_kind       text,
  p_worker     text,
  p_duracao_ms int default null,
  p_resumo     jsonb default null
)
returns table (ultimo_tick_ok_em timestamptz, ticks_ok bigint)
language plpgsql
set search_path = ''
as $$
begin
  return query
  insert into public.jobs_worker_heartbeat as h
    (kind, ultimo_tick_ok_em, worker, duracao_ms, ticks_ok, resumo)
  values (p_kind, now(), p_worker, p_duracao_ms, 1, p_resumo)
  on conflict (kind) do update
    set ultimo_tick_ok_em = now(),
        worker            = excluded.worker,
        duracao_ms        = excluded.duracao_ms,
        -- O contador é do BANCO, não do worker: dois deploys diferentes somam
        -- no mesmo número em vez de cada um manter a sua contagem.
        ticks_ok          = h.ticks_ok + 1,
        resumo            = excluded.resumo
  returning h.ultimo_tick_ok_em, h.ticks_ok;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (padrão), deliberado: mesmo que alguém reabra o EXECUTE por
-- descuido, o chamador ainda esbarra no privilégio de tabela revogado acima.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.jobs_registrar_tick_ok(text,text,int,jsonb)'
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
-- 1. Esta tabela registra tick que TERMINOU. Ela NÃO distingue "o cron nunca
--    disparou" de "o cron disparou e o handler estourou antes do fim": nos dois
--    casos o marcador fica velho. Separar os dois exigiria um segundo marcador,
--    gravado no INÍCIO do tick (um `ultimo_tick_iniciado_em`), ao custo de uma
--    escrita a mais por tick. Não foi incluído porque ninguém pediu e porque o
--    sintoma operacional dos dois casos é o mesmo: o agendador não está
--    entregando. O log da rota distingue, enquanto a função sobreviver.
--
-- 2. O marcador é por `kind`, não por instância. Com dois deploys ativos, o
--    `worker` da linha é o do último que terminou -- não dá para saber se um
--    deles parou enquanto o outro continua. É a mesma troca da limitação 3 da
--    018 (mantenha um valor de configuração por ambiente).
--
-- 3. `ticks_ok` conta ticks que terminaram, não trabalho feito. Um agendador
--    saudável com a fila vazia incrementa o contador sem gerar prognóstico
--    nenhum -- e é exatamente para isso que ele serve: provar que o agendador
--    vive mesmo quando não há trabalho.
