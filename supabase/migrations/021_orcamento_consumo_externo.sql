-- 021_orcamento_consumo_externo.sql
-- Disjuntor de consumo externo: quantas TENTATIVAS CHEGARAM AO PROVEDOR, por
-- evento e por participante, com teto persistente e liberação auditada.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 018 e a 019.
--
-- (A 020 é de outra unidade, modelando presença e convites. Esta é a 021.)
--
-- ===========================================================================
-- Por que `jobs.attempts` NÃO serve para isto
-- ===========================================================================
-- Duas razões, e cada uma sozinha já bastaria:
--
-- 1. `attempts` conta REIVINDICAÇÕES, não chegadas ao provedor. Uma tentativa
--    que perde o lease antes de chamar o modelo, ou que é recusada pelo próprio
--    disjuntor, incrementa `attempts` sem ter custado nada. Contar essas
--    tentativas no teto gastaria orçamento que não foi gasto.
--
-- 2. `jobs_reenfileirar(p_forcar => true)` ZERA `attempts` (018). Um teto por
--    participante lido de `attempts` seria decorativo: bastaria reprocessar à
--    força para o contador voltar a zero e o teto nunca morder. Este foi um
--    achado medido, não hipótese.
--
-- Por isso o registro aqui é um LIVRO-RAZÃO APPEND-ONLY, numa tabela própria,
-- com chave em (event_id, participant_id) e independente do ciclo de vida da
-- linha de `jobs`. Reprocessar à força não apaga o que já foi gasto, porque o
-- que já foi gasto não deixou de ter sido gasto.
--
-- ===========================================================================
-- O que conta como tentativa externa
-- ===========================================================================
-- Conta: toda tentativa em que uma requisição foi DESPACHADA ao provedor,
--   INCLUSIVE as abortadas por timeout ou por perda de lease. Uma geração
--   cortada no meio já consumiu do provedor; o fencing recusa o resultado, não
--   a cobrança.
-- NÃO conta: tentativa que nunca abriu conexão (o aborto chegou antes do
--   despacho, e o invólucro de fetch recusa a requisição sem sair do processo).
--
-- O número é registrado pelo worker, que é quem consegue observar o despacho
-- (ver `lib/jobs/aborto.ts`). O banco guarda, soma e compara com o teto.
--
-- `chamadas` é o número de REQUISIÇÕES despachadas na tentativa, que pode ser
-- maior que 1: o SDK da Anthropic tenta de novo por conta própria em falha de
-- rede. Os tetos desta migration são em TENTATIVAS (linhas com chamadas > 0),
-- como pedido; `chamadas` fica persistido ao lado para a recalibração com a
-- distribuição real de custo.
--
-- ===========================================================================
-- Números iniciais e de onde vêm
-- ===========================================================================
-- Teto inicial: 100 tentativas externas por evento, dimensionado para 50
-- participantes elegíveis, com máximo de 3 por participante. É LIMITE
-- OPERACIONAL INICIAL, não teto monetário em dólares, e deve ser recalibrado
-- com a distribuição real de custo e duração. Evento de referência: 24/10/2026,
-- 50 jovens.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- 1. Livro-razão do consumo externo. APPEND-ONLY.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_consumo_externo (
  id uuid primary key default gen_random_uuid(),

  kind text not null,

  -- Não é FK para `jobs`: a linha de job pode ser reenfileirada à força (o que
  -- zera attempts) e o livro-razão tem de sobreviver a isso. O vínculo que
  -- importa é com o evento e com a pessoa, e esses são FK de verdade.
  event_id       uuid not null references public.events(id)       on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,

  -- Rastro de QUAL tentativa gastou. Referência fraca de propósito.
  job_id    uuid,
  run_token uuid,

  -- Requisições DESPACHADAS ao provedor nesta tentativa. 0 = a tentativa
  -- existiu mas nunca abriu conexão: fica registrada (serve à medição) e NÃO
  -- conta no teto, porque não custou.
  chamadas int not null default 0,

  -- true = a tentativa foi cortada (timeout ou lease perdido). Continua
  -- contando se chamadas > 0: chegou ao provedor, logo custou.
  abortada boolean not null default false,

  -- 'ok', 'timeout_da_tentativa', 'lease_perdido_abortado', 'excecao'...
  motivo text,

  registrado_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_consumo_externo drop constraint if exists jobs_consumo_externo_kind_check;
  alter table public.jobs_consumo_externo add constraint jobs_consumo_externo_kind_check
    check (kind in ('prognostico', 'pdf'));

  alter table public.jobs_consumo_externo drop constraint if exists jobs_consumo_externo_chamadas_check;
  alter table public.jobs_consumo_externo add constraint jobs_consumo_externo_chamadas_check
    check (chamadas >= 0);
end
$$;

-- A consulta do disjuntor é sempre "quanto este evento/participante já gastou".
create index if not exists jobs_consumo_externo_evento_idx
  on public.jobs_consumo_externo (kind, event_id, participant_id)
  where chamadas > 0;

comment on table public.jobs_consumo_externo is
  'Livro-razão APPEND-ONLY das tentativas que CHEGARAM ao provedor externo (inclusive abortadas). Independente de jobs.attempts, que conta reivindicações e é zerado por jobs_reenfileirar(p_forcar).';

-- ---------------------------------------------------------------------------
-- 2. Teto persistente por evento. Alterável SOMENTE por liberação auditada.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_orcamento_evento (
  event_id uuid primary key references public.events(id) on delete cascade,
  kind text not null default 'prognostico',
  teto_evento       int not null,
  teto_participante int not null,
  definido_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_orcamento_evento drop constraint if exists jobs_orcamento_evento_tetos_check;
  alter table public.jobs_orcamento_evento add constraint jobs_orcamento_evento_tetos_check
    check (teto_evento >= 0 and teto_participante >= 0);
end
$$;

comment on table public.jobs_orcamento_evento is
  'Teto de consumo externo em vigor por evento. Sem linha aqui, vale o padrão que o worker passa (config). Só muda por jobs_orcamento_liberar, que exige quem e por quê.';

-- ---------------------------------------------------------------------------
-- 3. Auditoria das liberações. APPEND-ONLY, e é a única porta de alteração.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs_orcamento_liberacoes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null default 'prognostico',

  -- QUEM. Identidade de quem autorizou, não "o sistema".
  liberado_por text not null,
  -- POR QUÊ. Obrigatório e com tamanho mínimo: "porque sim" não é motivo.
  motivo text not null,

  teto_anterior_evento       int,
  teto_anterior_participante int,
  teto_novo_evento           int not null,
  teto_novo_participante     int not null,

  -- Quanto já havia sido gasto no momento da liberação: sem isso não se sabe
  -- se a liberação foi para destravar 2 participantes ou para dobrar o gasto.
  usado_no_momento int,

  liberado_em timestamptz not null default now()
);

do $$
begin
  alter table public.jobs_orcamento_liberacoes drop constraint if exists jobs_orcamento_liberacoes_motivo_check;
  alter table public.jobs_orcamento_liberacoes add constraint jobs_orcamento_liberacoes_motivo_check
    check (length(btrim(motivo)) >= 10 and length(btrim(liberado_por)) >= 3);
end
$$;

create index if not exists jobs_orcamento_liberacoes_evento_idx
  on public.jobs_orcamento_liberacoes (event_id, liberado_em desc);

comment on table public.jobs_orcamento_liberacoes is
  'Trilha de auditoria das liberações excepcionais de orçamento: quem, quando, por que, teto anterior e novo. APPEND-ONLY.';

-- ---------------------------------------------------------------------------
-- RLS e privilégios -- mesma ordem da 014/018/019
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA: privilégio de coluna não subtrai de privilégio de tabela, e o
-- Supabase concede a tabela inteira a anon e authenticated por padrão.
do $$
declare t text;
begin
  foreach t in array array[
    'jobs_consumo_externo', 'jobs_orcamento_evento', 'jobs_orcamento_liberacoes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    -- O admin LÊ (é o painel de custo e a trilha de auditoria) e não escreve:
    -- escrever o livro-razão ou o teto pelo navegador tiraria o sentido dos dois.
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end
$$;

-- service_role: INSERT sempre; UPDATE só onde faz sentido (o teto em vigor);
-- DELETE em NENHUMA das três. Sem DELETE concedido, o worker não apaga linha
-- avulsa nem por engano -- e a cascata de `events` continua passando, porque
-- ação referencial não usa o privilégio do papel chamador.
--
-- O REVOKE explícito para service_role é obrigatório e foi outro erro meu,
-- medido: a imagem do Supabase já concede a tabela inteira a service_role por
-- DEFAULT PRIVILEGES em tabela nova do schema public. Sem revogar, service_role
-- APAGAVA o livro-razão (testei: apagou), e o "append-only" existiria só no
-- comentário. É a mesma lição da 014: privilégio de coluna não subtrai de
-- privilégio de tabela, e o que a plataforma concede por padrão precisa ser
-- removido explicitamente antes de reconceder o que se quer.
revoke all on table public.jobs_consumo_externo from service_role;
revoke all on table public.jobs_orcamento_liberacoes from service_role;
revoke all on table public.jobs_orcamento_evento from service_role;

grant select, insert on table public.jobs_consumo_externo to service_role;
grant select, insert on table public.jobs_orcamento_liberacoes to service_role;
grant select, insert, update on table public.jobs_orcamento_evento to service_role;

drop policy if exists "jobs_consumo_externo_admin_read" on public.jobs_consumo_externo;
create policy "jobs_consumo_externo_admin_read" on public.jobs_consumo_externo
  for select using (public.is_admin());

drop policy if exists "jobs_orcamento_evento_admin_read" on public.jobs_orcamento_evento;
create policy "jobs_orcamento_evento_admin_read" on public.jobs_orcamento_evento
  for select using (public.is_admin());

drop policy if exists "jobs_orcamento_liberacoes_admin_read" on public.jobs_orcamento_liberacoes;
create policy "jobs_orcamento_liberacoes_admin_read" on public.jobs_orcamento_liberacoes
  for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- APPEND-ONLY: duas travas, e a divisão entre elas NÃO é arbitrária
-- ---------------------------------------------------------------------------
-- UPDATE -> gatilho. Dispara para QUALQUER papel, inclusive service_role e
--   superusuário, e não existe GUC que o desligue. Reescrever consumo gasto ou
--   adulterar uma trilha de auditoria não é operação legítima para ninguém.
--
-- DELETE -> PRIVILÉGIO, não gatilho. Aqui houve um erro meu, medido e
--   corrigido: a primeira versão desta migration bloqueava DELETE por gatilho
--   também, e isso QUEBRAVA `on delete cascade`. Apagar um evento (operação
--   real do admin, que `delete_event_cascade` faz) passou a falhar com
--   "A tabela jobs_consumo_externo é APPEND-ONLY". Uma tabela de auditoria que
--   impede apagar o evento auditado não protege nada: só trava o produto.
--
--   A ação referencial de cascata é executada pelo sistema com privilégio do
--   DONO da tabela referenciante, então ela PASSA mesmo sem DELETE concedido ao
--   papel da aplicação. Resultado: ninguém da aplicação apaga linha avulsa, e
--   apagar o evento continua funcionando -- levando consigo a auditoria daquele
--   evento, que é o comportamento correto (o evento deixou de existir).
--
--   Consequência declarada: o DONO da tabela (DBA, via psql) pode apagar. É o
--   mesmo que vale para qualquer tabela de auditoria num banco relacional;
--   quem tem o dono tem o banco.
create or replace function public.jobs_livro_razao_somente_insercao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'A tabela % é APPEND-ONLY: % recusado. O consumo já gasto e a trilha de auditoria não se reescrevem.',
    tg_table_name, tg_op
    using errcode = 'check_violation',
          hint = 'Para mudar um teto, use jobs_orcamento_liberar, que deixa rastro.';
end;
$$;

drop trigger if exists jobs_consumo_externo_append_only on public.jobs_consumo_externo;
create trigger jobs_consumo_externo_append_only
  before update on public.jobs_consumo_externo
  for each row execute function public.jobs_livro_razao_somente_insercao();

drop trigger if exists jobs_orcamento_liberacoes_append_only on public.jobs_orcamento_liberacoes;
create trigger jobs_orcamento_liberacoes_append_only
  before update on public.jobs_orcamento_liberacoes
  for each row execute function public.jobs_livro_razao_somente_insercao();

revoke all on function public.jobs_livro_razao_somente_insercao() from public;
revoke all on function public.jobs_livro_razao_somente_insercao() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- jobs_consumo_registrar: lança no livro-razão.
-- ---------------------------------------------------------------------------
-- Chamada pelo worker DEPOIS da tentativa, com o número de requisições que
-- foram efetivamente despachadas ao provedor. Devolve os totais já atualizados,
-- para o worker poder registrar no log quanto o evento já consumiu.
create or replace function public.jobs_consumo_registrar(
  p_kind           text,
  p_event_id       uuid,
  p_participant_id uuid,
  p_chamadas       int,
  p_abortada       boolean default false,
  p_motivo         text default null,
  p_job_id         uuid default null,
  p_run_token      uuid default null
)
returns table (tentativas_evento int, tentativas_participante int, requisicoes_evento bigint)
language plpgsql
set search_path = ''
as $$
begin
  insert into public.jobs_consumo_externo
    (kind, event_id, participant_id, job_id, run_token, chamadas, abortada, motivo)
  values
    (p_kind, p_event_id, p_participant_id, p_job_id, p_run_token,
     greatest(coalesce(p_chamadas, 0), 0), coalesce(p_abortada, false), p_motivo);

  return query
  select
    count(*) filter (where c.chamadas > 0)::int,
    count(*) filter (where c.chamadas > 0 and c.participant_id = p_participant_id)::int,
    coalesce(sum(c.chamadas), 0)::bigint
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_orcamento_verificar: o disjuntor. Chamada ANTES de gastar.
-- ---------------------------------------------------------------------------
-- Tetos efetivos = linha persistida do evento, se existir; senão os padrões que
-- o worker passa (que vêm da configuração). Assim o teto é persistente a partir
-- da primeira liberação, e antes disso não há número mágico escondido no banco.
--
-- Teto 0 em qualquer dos dois desliga AQUELE teto (e só ele).
create or replace function public.jobs_orcamento_verificar(
  p_kind                      text,
  p_event_id                  uuid,
  p_participant_id            uuid,
  p_teto_evento_padrao        int,
  p_teto_participante_padrao  int
)
returns table (
  permitido boolean,
  motivo text,
  teto_evento int,
  teto_participante int,
  tentativas_evento int,
  tentativas_participante int,
  requisicoes_evento bigint,
  teto_persistido boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_teto_evento int;
  v_teto_part   int;
  v_persistido  boolean := false;
  v_tent_ev     int;
  v_tent_part   int;
  v_req_ev      bigint;
begin
  select o.teto_evento, o.teto_participante, true
    into v_teto_evento, v_teto_part, v_persistido
  from public.jobs_orcamento_evento o
  where o.event_id = p_event_id and o.kind = p_kind;

  if not found then
    v_teto_evento := p_teto_evento_padrao;
    v_teto_part   := p_teto_participante_padrao;
    v_persistido  := false;
  end if;

  select
    count(*) filter (where c.chamadas > 0)::int,
    count(*) filter (where c.chamadas > 0 and c.participant_id = p_participant_id)::int,
    coalesce(sum(c.chamadas), 0)::bigint
    into v_tent_ev, v_tent_part, v_req_ev
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;

  -- Teto por PARTICIPANTE primeiro: é o mais específico, e saber que a pessoa
  -- já queimou as três tentativas dela é informação melhor que "o evento
  -- estourou" quando as duas coisas valem.
  if v_teto_part > 0 and v_tent_part >= v_teto_part then
    return query select false,
      format('participante já consumiu %s de %s tentativa(s) externa(s) permitidas', v_tent_part, v_teto_part),
      v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
    return;
  end if;

  if v_teto_evento > 0 and v_tent_ev >= v_teto_evento then
    return query select false,
      format('evento já consumiu %s de %s tentativa(s) externa(s) permitidas', v_tent_ev, v_teto_evento),
      v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
    return;
  end if;

  return query select true,
    format('dentro do orçamento: evento %s/%s, participante %s/%s', v_tent_ev, v_teto_evento, v_tent_part, v_teto_part),
    v_teto_evento, v_teto_part, v_tent_ev, v_tent_part, v_req_ev, v_persistido;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_orcamento_liberar: liberação excepcional AUDITADA.
-- ---------------------------------------------------------------------------
-- É a ÚNICA porta de alteração do teto. Exige quem e por quê (o CHECK da tabela
-- de auditoria recusa motivo curto e autor curto), grava a trilha ANTES de
-- mexer no teto, e devolve o id da liberação para quem chamou poder citá-lo.
--
-- Não existe função de "baixar teto sem rastro" nem de apagar liberação: o
-- gatilho append-only recusa UPDATE e DELETE na trilha, para qualquer papel.
create or replace function public.jobs_orcamento_liberar(
  p_event_id          uuid,
  p_teto_evento       int,
  p_teto_participante int,
  p_liberado_por      text,
  p_motivo            text,
  p_kind              text default 'prognostico'
)
returns table (liberacao_id uuid, teto_anterior_evento int, teto_novo_evento int, usado_no_momento int)
language plpgsql
set search_path = ''
as $$
declare
  v_ant_ev   int;
  v_ant_part int;
  v_usado    int;
  v_id       uuid;
begin
  if p_teto_evento is null or p_teto_participante is null then
    raise exception 'jobs_orcamento_liberar: os dois tetos são obrigatórios'
      using errcode = 'check_violation';
  end if;

  select o.teto_evento, o.teto_participante into v_ant_ev, v_ant_part
  from public.jobs_orcamento_evento o
  where o.event_id = p_event_id and o.kind = p_kind;

  select count(*) filter (where c.chamadas > 0)::int into v_usado
  from public.jobs_consumo_externo c
  where c.kind = p_kind and c.event_id = p_event_id;

  -- A trilha primeiro: se o UPDATE do teto falhar, não fica liberação sem
  -- rastro; e se a trilha falhar (motivo curto, autor vazio), o teto não muda.
  insert into public.jobs_orcamento_liberacoes
    (event_id, kind, liberado_por, motivo,
     teto_anterior_evento, teto_anterior_participante,
     teto_novo_evento, teto_novo_participante, usado_no_momento)
  values
    (p_event_id, p_kind, p_liberado_por, p_motivo,
     v_ant_ev, v_ant_part, p_teto_evento, p_teto_participante, v_usado)
  returning public.jobs_orcamento_liberacoes.id into v_id;

  insert into public.jobs_orcamento_evento (event_id, kind, teto_evento, teto_participante)
  values (p_event_id, p_kind, p_teto_evento, p_teto_participante)
  on conflict (event_id) do update
    set teto_evento = excluded.teto_evento,
        teto_participante = excluded.teto_participante,
        kind = excluded.kind,
        definido_em = now();

  return query select v_id, v_ant_ev, p_teto_evento, v_usado;
end;
$$;

-- ---------------------------------------------------------------------------
-- jobs_consumo_resumo: medição por evento, para o painel e a recalibração.
-- ---------------------------------------------------------------------------
create or replace function public.jobs_consumo_resumo(
  p_event_id uuid,
  p_kind     text default 'prognostico'
)
returns table (
  tentativas_externas int,
  tentativas_abortadas int,
  tentativas_sem_conexao int,
  requisicoes_despachadas bigint,
  participantes_tocados int,
  participantes_no_teto int,
  primeira_em timestamptz,
  ultima_em timestamptz
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select * from public.jobs_consumo_externo c
    where c.event_id = p_event_id and c.kind = p_kind
  ), teto as (
    select coalesce((select o.teto_participante from public.jobs_orcamento_evento o
                      where o.event_id = p_event_id and o.kind = p_kind), 2147483647) as tp
  )
  select
    count(*) filter (where chamadas > 0)::int,
    count(*) filter (where chamadas > 0 and abortada)::int,
    -- Tentativa que nunca abriu conexão: existiu, não custou, não conta no teto.
    count(*) filter (where chamadas = 0)::int,
    coalesce(sum(chamadas), 0)::bigint,
    count(distinct participant_id) filter (where chamadas > 0)::int,
    (select count(*)::int from (
       select participant_id from base where chamadas > 0
       group by participant_id having count(*) >= (select tp from teto)
     ) x),
    min(registrado_em),
    max(registrado_em)
  from base;
$$;

-- ---------------------------------------------------------------------------
-- Privilégio de execução
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.jobs_consumo_registrar(text,uuid,uuid,int,boolean,text,uuid,uuid)',
    'public.jobs_orcamento_verificar(text,uuid,uuid,int,int)',
    'public.jobs_orcamento_liberar(uuid,int,int,text,text,text)',
    'public.jobs_consumo_resumo(uuid,text)'
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
-- 1. O número de requisições despachadas é observado NO WORKER (invólucro de
--    fetch). Se a função morrer entre o despacho e o lançamento no livro-razão,
--    aquele consumo não é contabilizado -- o livro subestima nesse caso. É o
--    mesmo limite da entrega "ao menos uma vez": não há commit atômico entre a
--    cobrança do provedor e o commit do Postgres. O lançamento acontece o mais
--    cedo possível depois da tentativa, para encurtar essa janela.
--
-- 2. O teto é verificado ANTES da tentativa, então é teto de INÍCIO, não de
--    término: duas vagas que verificam ao mesmo tempo podem ambas passar e
--    estourar o teto em até `JOBS_CONCURRENCY - 1` tentativas. Fechar isso
--    exigiria serializar a verificação com um advisory lock por evento, ao
--    custo de um lock no caminho de cada job. Com teto 100 e concorrência 3, o
--    erro máximo é de 2 tentativas (2%).
--
-- 3. `chamadas` conta REQUISIÇÕES, e os tetos contam TENTATIVAS (linhas com
--    chamadas > 0). O SDK da Anthropic tenta de novo por conta própria em falha
--    de rede, então `requisicoes_despachadas` pode ser maior que
--    `tentativas_externas`. Se o teto tiver de ser em requisições, é trocar
--    `count(*) filter (where chamadas > 0)` por `sum(chamadas)` em
--    `jobs_orcamento_verificar` -- decisão de produto, não de implementação.
--
-- 4. DELETE é barrado por privilégio (service_role não o tem), não por gatilho,
--    para não quebrar `on delete cascade` de `events`. O DONO da tabela ainda
--    pode apagar, como em qualquer tabela de auditoria. Apagar o evento apaga a
--    auditoria DELE junto -- correto, porque o evento deixou de existir.
--
-- 5. Sem linha em `jobs_orcamento_evento`, o teto efetivo é o PADRÃO que o
--    worker passa (configuração). Isso é deliberado: evita número mágico
--    escondido no banco antes de alguém decidir. A partir da primeira
--    liberação auditada, o teto daquele evento passa a ser persistente.
