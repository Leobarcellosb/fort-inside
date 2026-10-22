-- 011_fix_privilegio_anon.sql
-- Correção emergencial de duas escaladas de privilégio que estavam DECLARADAS
-- nas migrations, não introduzidas por drift. O guard de drift dá PASS nelas
-- justamente por isso: ele prova que o banco é igual às migrations, não que as
-- migrations são seguras.
--
-- Idempotente: seguro rodar duas vezes, em produção e num banco novo.

-- ---------------------------------------------------------------
-- 1. delete_event_cascade: EXECUTE aberto para PUBLIC
--
-- A 005 termina com `GRANT EXECUTE ... TO service_role` e nada mais. Em
-- Postgres, função nasce com EXECUTE para PUBLIC: conceder a um papel NÃO
-- revoga o default. O comentário da 005 afirma "Callable only from
-- service_role" e isso era falso desde o dia em que foi escrito -- qualquer
-- cliente anônimo podia chamar a função pelo PostgREST e apagar evento,
-- participantes, respostas, prognósticos e linhas de auth.users.
--
-- Duas camadas de correção, porque uma só não basta:
--   (a) privilégio: revogar o EXECUTE de PUBLIC/anon/authenticated;
--   (b) autorização interna: a própria função recusa contexto não privilegiado,
--       para que um GRANT acidental no futuro não reabra o buraco sozinho.
-- ---------------------------------------------------------------

-- search_path VAZIO, não 'public', e todas as referências qualificadas. Vazio é
-- estritamente mais forte: nada resolve sem qualificação de schema, então nem um
-- objeto plantado em public é alcançável. Numa função SECURITY DEFINER, que roda
-- com os privilégios do dono, depender de resolução por search_path é como essa
-- mesma função apagaria a tabela errada se alguém conseguisse criar um objeto de
-- mesmo nome num schema que resolvesse antes.
create or replace function public.delete_event_cascade(event_uuid uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_participants int;
  deleted_responses int;
  deleted_prognostics int;
  deleted_logs int;
  participant_user_ids uuid[];
begin
  -- Camada (b): is_admin() já cobre os dois contextos legítimos -- JWT de
  -- service_role e usuário com app_metadata.role = 'admin'. Sem claim nenhum
  -- (anon) retorna false. 42501 = insufficient_privilege.
  if not public.is_admin() then
    raise exception 'delete_event_cascade: chamada nao autorizada'
      using errcode = '42501';
  end if;

  -- Collect user_ids of event participants (for auth.users cleanup).
  select array_agg(user_id) into participant_user_ids
  from public.participants
  where event_id = event_uuid and user_id is not null;

  delete from public.event_logs where event_id = event_uuid;
  get diagnostics deleted_logs = row_count;

  delete from public.quiz_responses
  where participant_id in (select id from public.participants where event_id = event_uuid);
  get diagnostics deleted_responses = row_count;

  delete from public.prognostics
  where participant_id in (select id from public.participants where event_id = event_uuid);
  get diagnostics deleted_prognostics = row_count;

  delete from public.participants where event_id = event_uuid;
  get diagnostics deleted_participants = row_count;

  -- Delete auth.users ONLY for this event's participants, never admins.
  -- CRITICAL: parens around the OR clause. Without them, AND/OR precedence
  -- makes the OR branch unbound and deletes every non-admin row in auth.users.
  if participant_user_ids is not null then
    delete from auth.users
    where id = any(participant_user_ids)
      and (
        raw_app_meta_data->>'role' is null
        or raw_app_meta_data->>'role' != 'admin'
      );
  end if;

  delete from public.events where id = event_uuid;

  return json_build_object(
    'deleted_logs', deleted_logs,
    'deleted_responses', deleted_responses,
    'deleted_prognostics', deleted_prognostics,
    'deleted_participants', deleted_participants,
    'deleted_users', coalesce(array_length(participant_user_ids, 1), 0)
  );
end;
$$;

-- Camada (a). CREATE OR REPLACE preserva privilégios existentes, então o
-- EXECUTE de PUBLIC herdado da criação original sobrevive ao replace acima:
-- o revoke precisa vir DEPOIS, nesta ordem.
revoke execute on function public.delete_event_cascade(uuid) from public;
revoke execute on function public.delete_event_cascade(uuid) from anon;
revoke execute on function public.delete_event_cascade(uuid) from authenticated;
grant execute on function public.delete_event_cascade(uuid) to service_role;

-- ---------------------------------------------------------------
-- 2. participant_profiles: view sem security_invoker exposta a anon
--
-- View criada na 001 sem `security_invoker`. Por padrão a view roda com os
-- privilégios do dono, então ela LÊ POR CIMA do RLS de participants,
-- prognostics e quiz_responses. Como o Supabase concede acesso às tabelas do
-- schema public para anon e authenticated, qualquer cliente anônimo podia
-- listar nome e status de prognóstico de todo mundo.
--
-- security_invoker = on faz a view aplicar o RLS de quem chama. O revoke de
-- anon é a segunda camada: sem claim, não há leitura nenhuma.
-- ---------------------------------------------------------------

alter view public.participant_profiles set (security_invoker = on);

revoke all on public.participant_profiles from anon;
grant select on public.participant_profiles to authenticated, service_role;
