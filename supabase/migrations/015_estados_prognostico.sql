-- 015_estados_prognostico.sql
-- Máquina de estados do prognóstico, imposta pelo banco.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011 e a 014.
--
-- ---------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------
-- prognostics.status era `text not null default 'pending'` SEM check: qualquer
-- string entrava, e qualquer string podia ser trocada por qualquer outra.
-- O caminho de regeração da aplicação forçava status = 'generated', então um
-- prognóstico `reviewed` ou `delivered` regredia e o trabalho de revisão do
-- administrador era apagado.
--
-- ---------------------------------------------------------------
-- A máquina de estados aprovada (ordem estrita)
-- ---------------------------------------------------------------
--   pending -> generating -> generated -> in_review -> reviewed -> delivered
--
-- Falhas e retentativas são estados dos JOBS de geração, não do documento: o
-- documento nunca regride sozinho.
--
-- ---------------------------------------------------------------
-- Duas peças, porque cada uma cobre o que a outra não cobre
-- ---------------------------------------------------------------
-- 1. CHECK: os valores permitidos são exatamente os seis. Um CHECK enxerga só a
--    linha nova, então ele fecha "valor fora do conjunto", mas NÃO consegue dizer
--    "reviewed -> generated é para trás".
--
-- 2. Gatilho BEFORE UPDATE: recusa transição para trás. Por que gatilho e não as
--    alternativas:
--      - Policy de RLS: USING enxerga a linha antiga, WITH CHECK a nova, e não há
--        como comparar as duas na mesma expressão. Além disso o service_role (que
--        é quem as rotas usam) ignora RLS (BYPASSRLS): uma policy nunca o
--        alcançaria, e é justamente por ele que a regressão acontecia.
--      - Privilégio de coluna em `status`: tudo-ou-nada. Não distingue
--        generated -> reviewed (legítimo) de reviewed -> generated (proibido),
--        e a revisão do admin precisa escrever essa coluna.
--      - Função/RPC como único caminho de escrita: exigiria revogar UPDATE da
--        tabela e reescrever todos os chamadores (inclusive o painel do admin,
--        que grava direto pelo cliente). Mais invasivo e ainda deixaria um
--        service_role distraído escrever na tabela por fora.
--    O gatilho dispara para QUALQUER papel, inclusive service_role e superuser.
--    Só dá para contorná-lo com DDL (alter table ... disable trigger), que exige
--    ser dono da tabela: não existe GUC nem parâmetro de sessão que o desligue,
--    de propósito (um bypass por sessão seria um bypass para o atacante também).
--
-- Regra: o gatilho recusa APENAS regressão (posição nova < posição antiga).
-- Mesmo estado -> mesmo estado passa (regravar `generated` é no-op de estado), e
-- avanço passa mesmo pulando etapas. Pular etapa é permitido de propósito: os
-- fluxos de hoje fazem generated -> reviewed (edição do admin) e
-- generated -> delivered (botão Entregar) sem passar por in_review, e o INSERT
-- já nasce `generated`, sem passar por generating. Exigir passo a passo no banco
-- quebraria o painel; se o produto quiser passo estrito, é decisão separada.
--
-- ---------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------
-- Os quatro valores que a aplicação sempre gravou (pending, generated, reviewed,
-- delivered) existem idênticos na máquina nova: o mapeamento é identidade e não
-- há UPDATE a fazer. Como a coluna era texto livre, a migração VERIFICA antes de
-- restringir; se houver qualquer outro valor ela ABORTA listando-os, em vez de
-- inventar um mapeamento (isso é decisão de produto).
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

do $$
declare
  desconhecidos text;
begin
  select string_agg(distinct coalesce(status, '<NULL>') || ' (' || n || ')', ', ')
    into desconhecidos
  from (
    select status, count(*) as n
    from public.prognostics
    where status is null
       or status not in ('pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered')
    group by status
  ) x;

  if desconhecidos is not null then
    raise exception
      '015: prognostics.status tem valores fora dos seis estados aprovados: %. Decisao de produto necessaria antes de restringir; nenhuma linha foi alterada.',
      desconhecidos
      using errcode = 'check_violation';
  end if;
end
$$;

-- CHECK: NOT VALID + VALIDATE em vez de ADD direto. O ADD direto segura lock
-- exclusivo enquanto varre a tabela; assim a varredura roda com lock mais
-- fraco. (A guarda acima já garante que a validação passa.)
alter table public.prognostics
  drop constraint if exists prognostics_status_check;

alter table public.prognostics
  add constraint prognostics_status_check
  check (status in ('pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered'))
  not valid;

alter table public.prognostics
  validate constraint prognostics_status_check;

-- Gatilho anti-regressão.
-- search_path vazio: tudo qualificado, nada resolvível por schema plantado.
create or replace function public.prognostics_bloqueia_regressao_de_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ordem constant text[] :=
    array['pending', 'generating', 'generated', 'in_review', 'reviewed', 'delivered'];
  pos_antiga int := array_position(ordem, old.status);
  pos_nova   int := array_position(ordem, new.status);
begin
  -- Valor fora dos seis não é problema deste gatilho: o CHECK recusa com a
  -- mensagem própria. Aqui só comparamos posições conhecidas.
  if pos_antiga is null or pos_nova is null then
    return new;
  end if;

  if pos_nova < pos_antiga then
    raise exception
      'Transicao de status recusada: o prognostico nao pode voltar de "%" para "%" (ordem: pending > generating > generated > in_review > reviewed > delivered).',
      old.status, new.status
      using errcode = 'check_violation',
            hint = 'Um prognostico so avanca; o estado nunca regride, nem por service_role.';
  end if;

  return new;
end;
$$;

drop trigger if exists prognostics_status_sem_regressao on public.prognostics;

create trigger prognostics_status_sem_regressao
  before update of status on public.prognostics
  for each row
  when (old.status is distinct from new.status)
  execute function public.prognostics_bloqueia_regressao_de_status();

-- A função do gatilho não é chamável por API: sem EXECUTE para quem vem da web.
-- (Funções retornando trigger já não podem ser chamadas diretamente, mas o
-- Supabase concede EXECUTE por padrão e a suíte de grants audita isso.)
revoke all on function public.prognostics_bloqueia_regressao_de_status() from public;
revoke all on function public.prognostics_bloqueia_regressao_de_status() from anon, authenticated;
