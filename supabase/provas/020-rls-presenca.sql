-- Sonda de RLS e PRIVILÉGIO das tabelas de presença/convites (migration 020).
--
-- A afirmação central desta migration, e por isso a primeira coisa provada:
-- NÃO EXISTE caminho pelo qual o participante se declare presente. Isso é
-- PRIVILÉGIO, não só política -- política se reabre com uma policy nova,
-- privilégio não. Provado nas duas direções:
--
--   anon                                    -> não chega nem na policy (42501 de tabela)
--   participante (authenticated sem admin)  -> NÃO insere, NÃO atualiza, NÃO lê
--                                              check-in -- nem o DELE, nem com
--                                              token próprio
--   admin (app_metadata.role = 'admin')     -> LÊ tudo, mas NÃO escreve
--   service_role                            -> lê, escreve e aciona as funções
--
-- Reusa o ferramental da suíte de segurança do projeto (`scripts/db-security`),
-- que já resolve o que é difícil aqui: cada sonda roda em savepoint (um erro
-- NUNCA aborta a transação do cenário), um erro que não é 42501 conta como
-- INCONCLUSIVO e portanto FALHA, e toda negativa exige CONTROLE POSITIVO -- o
-- mesmo comando como service_role tem de afetar linha, senão "0 linhas" poderia
-- ser só tabela vazia ou WHERE errado.
--
-- DUAS CAMADAS para as funções, igual ao cenário 4 do projeto e à prova da 018:
--   camada a) privilégio: o catálogo (has_function_privilege) diz que anon,
--      authenticated e PUBLIC não têm EXECUTE. Verificar no catálogo em vez de
--      chamar não é preguiça: nesta imagem descartável (supabase/postgres
--      17.6.1.106, com pgaudit em shared_preload_libraries) uma chamada de
--      função com EXECUTE REVOGADO derruba o backend com SIGSEGV em vez de
--      devolver 42501. É defeito do ambiente, não da migration.
--   camada b) corpo: COM o EXECUTE concedido DE PROPÓSITO (simulando o descuido
--      de alguém reabrir a função amanhã), a chamada ainda tem de ser barrada --
--      pelo privilégio de TABELA revogado. É a razão de as funções de ESCRITA
--      desta migration NÃO serem SECURITY DEFINER, e é a afirmação que o
--      comentário da seção 11 faz; aqui ela é medida.
--
-- Roda inteiro em transação com rollback: não deixa nada no banco.

begin;
\o /dev/null
\ir ../../scripts/db-security/_lib.sql
\ir ../../scripts/db-security/_seed.sql

-- ---------------------------------------------------------------------------
-- Massa: duas pessoas do evento do seed. A pessoa A é o participante A (tem
-- conta e token); a pessoa W é walk-in sem conta.
-- ---------------------------------------------------------------------------
insert into public.event_people (id, event_id, participant_id, full_name, email, origem)
values
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000e1',
   '00000000-0000-4000-8000-0000000000a2', 'Pessoa A (participante)', 'a@seguranca.test', 'lista_convite'),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-0000000000e1',
   null, 'Pessoa W (walk-in)', null, 'walk_in'),
  ('00000000-0000-4000-8000-00000000f003', '00000000-0000-4000-8000-0000000000e1',
   '00000000-0000-4000-8000-0000000000b2', 'Pessoa B (participante)', 'b@seguranca.test', 'lista_convite');

insert into public.event_invitations (event_id, person_id, canal, status, tentativa, destino)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f001',
        'email', 'enviado', 1, 'a@seguranca.test');

-- Check-in da pessoa A, confirmado pelo HOST (não por ela).
insert into public.event_checkins
  (id, event_id, person_id, confirmado_por_nome, confirmado_por_papel, avulso)
values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-0000000000e1',
   '00000000-0000-4000-8000-00000000f001', 'Yuri Fortes', 'host', false);

select pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1') as claim_a,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000ad', 'admin') as claim_admin,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000c1', null, 'admin') as claim_user_meta
\gset

-- ===========================================================================
-- 20.0 Estrutura: RLS ligada, uma única policy de leitura, escrita revogada
-- ===========================================================================
do $$
declare
  t text;
  v_tabelas text[] := array[
    'event_people', 'event_invitations', 'event_invite_snapshots',
    'event_invite_snapshot_people', 'event_checkins', 'event_checkin_closures',
    'event_dna_invalidations'
  ];
begin
  foreach t in array v_tabelas loop
    perform pg_temp.afirmar(20, format('RLS está LIGADA em public.%s', t), 'estrutura',
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
      'relrowsecurity = true',
      'relrowsecurity = ' || (select relrowsecurity::text from pg_class where oid = ('public.' || t)::regclass));

    perform pg_temp.afirmar(20, format('a única policy de %s é SELECT atrás de is_admin()', t), 'estrutura',
      (select count(*) = 1 and bool_and(cmd = 'SELECT' and qual like '%is_admin%')
         from pg_policies where schemaname = 'public' and tablename = t),
      'exatamente 1 policy, cmd=SELECT, usando is_admin()',
      coalesce((select string_agg(policyname || ':' || cmd || ':' || coalesce(qual, ''), ', ')
                  from pg_policies where schemaname = 'public' and tablename = t), '<nenhuma>'));

    perform pg_temp.afirmar(20, format('anon não tem privilégio ALGUM em %s', t), 'estrutura',
      not (has_table_privilege('anon', 'public.' || t, 'select')
        or has_table_privilege('anon', 'public.' || t, 'insert')
        or has_table_privilege('anon', 'public.' || t, 'update')
        or has_table_privilege('anon', 'public.' || t, 'delete')
        or has_table_privilege('anon', 'public.' || t, 'truncate')),
      'select/insert/update/delete/truncate = false',
      format('select=%s insert=%s update=%s delete=%s truncate=%s',
        has_table_privilege('anon', 'public.' || t, 'select'),
        has_table_privilege('anon', 'public.' || t, 'insert'),
        has_table_privilege('anon', 'public.' || t, 'update'),
        has_table_privilege('anon', 'public.' || t, 'delete'),
        has_table_privilege('anon', 'public.' || t, 'truncate')));

    perform pg_temp.afirmar(20, format('authenticated tem SELECT e NADA de escrita em %s', t), 'estrutura',
      has_table_privilege('authenticated', 'public.' || t, 'select')
      and not (has_table_privilege('authenticated', 'public.' || t, 'insert')
            or has_table_privilege('authenticated', 'public.' || t, 'update')
            or has_table_privilege('authenticated', 'public.' || t, 'delete')
            or has_table_privilege('authenticated', 'public.' || t, 'truncate')),
      'select=true e insert/update/delete/truncate=false',
      format('select=%s insert=%s update=%s delete=%s truncate=%s',
        has_table_privilege('authenticated', 'public.' || t, 'select'),
        has_table_privilege('authenticated', 'public.' || t, 'insert'),
        has_table_privilege('authenticated', 'public.' || t, 'update'),
        has_table_privilege('authenticated', 'public.' || t, 'delete'),
        has_table_privilege('authenticated', 'public.' || t, 'truncate')));

    perform pg_temp.afirmar(20, format('service_role escreve em %s', t), 'estrutura',
      has_table_privilege('service_role', 'public.' || t, 'select')
      and has_table_privilege('service_role', 'public.' || t, 'insert')
      and has_table_privilege('service_role', 'public.' || t, 'update')
      and has_table_privilege('service_role', 'public.' || t, 'delete'),
      'select/insert/update/delete = true',
      format('select=%s insert=%s update=%s delete=%s',
        has_table_privilege('service_role', 'public.' || t, 'select'),
        has_table_privilege('service_role', 'public.' || t, 'insert'),
        has_table_privilege('service_role', 'public.' || t, 'update'),
        has_table_privilege('service_role', 'public.' || t, 'delete')));
  end loop;
end
$$;

-- Nenhuma coluna reconcedida por engano: a lição da 014 ao contrário. Se
-- existisse `grant insert (coluna)` sobrevivendo ao revoke de tabela, o
-- participante escreveria naquela coluna.
select pg_temp.afirmar(20, 'não há privilégio de COLUNA de escrita para anon/authenticated nas tabelas da 020', 'estrutura',
  not exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('event_people', 'event_invitations', 'event_invite_snapshots',
                         'event_invite_snapshot_people', 'event_checkins',
                         'event_checkin_closures', 'event_dna_invalidations')
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE')
  ),
  'nenhuma linha de column_privileges com INSERT/UPDATE',
  coalesce((select string_agg(table_name || '.' || column_name || ':' || grantee || ':' || privilege_type, ', ')
              from information_schema.column_privileges
             where table_schema = 'public'
               and table_name in ('event_people', 'event_invitations', 'event_invite_snapshots',
                                  'event_invite_snapshot_people', 'event_checkins',
                                  'event_checkin_closures', 'event_dna_invalidations')
               and grantee in ('anon', 'authenticated')
               and privilege_type in ('INSERT', 'UPDATE')), '<nenhuma>'));

-- EXECUTE das funções: revogado de PUBLIC, anon e authenticated.
do $$
declare
  f text;
  v_fn text[] := array[
    'public.marco_zero_respostas_validas(uuid)',
    'public.marco_zero_cobertura(uuid)',
    'public.marco_zero_pessoa_registrar(uuid,text,text,text,text,uuid,text)',
    'public.marco_zero_convite_registrar(uuid,text,text,text,text,text)',
    'public.marco_zero_convites_encerrar(uuid,text,text)',
    'public.marco_zero_checkin_registrar(uuid,uuid,text,text,uuid)',
    'public.marco_zero_checkin_avulso(uuid,text,text,text,text,text,uuid)',
    'public.marco_zero_checkin_corrigir(uuid,text,text,text,uuid)',
    'public.marco_zero_checkin_anular(uuid,text,text)',
    'public.marco_zero_checkin_encerrar(uuid,text,uuid)',
    'public.marco_zero_checkin_reabrir(uuid,text,text)',
    'public.marco_zero_invalidar_dna(uuid,text,text,uuid)'
  ];
begin
  foreach f in array v_fn loop
    perform pg_temp.afirmar(20, format('EXECUTE de %s revogado de PUBLIC/anon/authenticated e concedido a service_role', f), 'estrutura',
      not has_function_privilege('anon', f, 'execute')
      and not has_function_privilege('authenticated', f, 'execute')
      and has_function_privilege('service_role', f, 'execute'),
      'anon=false authenticated=false service_role=true',
      format('anon=%s authenticated=%s service_role=%s',
        has_function_privilege('anon', f, 'execute'),
        has_function_privilege('authenticated', f, 'execute'),
        has_function_privilege('service_role', f, 'execute')));
  end loop;
end
$$;

-- As duas funções de LEITURA são SECURITY DEFINER com search_path fixado; as de
-- ESCRITA, NÃO são definidoras -- de propósito (ver seção 11 da migration).
select pg_temp.afirmar(20, 'funções de leitura são SECURITY DEFINER com search_path fixado', 'estrutura',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('marco_zero_cobertura', 'marco_zero_respostas_validas')),
  'prosecdef = true e search_path = '''' nas duas',
  coalesce((select string_agg(p.proname || ':secdef=' || p.prosecdef || ':cfg=' || coalesce(array_to_string(p.proconfig, '|'), '-'), ', ')
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('marco_zero_cobertura', 'marco_zero_respostas_validas')), '<nenhuma>'));

select pg_temp.afirmar(20, 'funções de ESCRITA de presença NÃO são SECURITY DEFINER (dupla camada)', 'estrutura',
  (select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('marco_zero_checkin_registrar', 'marco_zero_checkin_avulso',
                        'marco_zero_checkin_corrigir', 'marco_zero_checkin_anular',
                        'marco_zero_checkin_encerrar', 'marco_zero_checkin_reabrir',
                        'marco_zero_pessoa_registrar', 'marco_zero_convite_registrar',
                        'marco_zero_convites_encerrar', 'marco_zero_invalidar_dna')),
  'prosecdef = false e search_path = '''' em todas',
  coalesce((select string_agg(p.proname || ':secdef=' || p.prosecdef, ', ')
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'marco_zero_%' and p.prosecdef), '<nenhuma definidora: ok>'));

-- O índice que sustenta "um único registro ATIVO por pessoa e evento".
select pg_temp.afirmar(20, 'existe índice único parcial de presença ATIVA por (evento, pessoa)', 'estrutura',
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'event_checkins'
      and indexdef ilike '%unique%(event_id, person_id)%'
      and indexdef ilike '%estado%ativo%'
  ),
  'índice UNIQUE em (event_id, person_id) WHERE estado = ''ativo''',
  coalesce((select string_agg(indexname || ': ' || indexdef, ' | ')
              from pg_indexes where schemaname = 'public' and tablename = 'event_checkins'), '<nenhum>'));

-- ===========================================================================
-- 20.1 O participante NÃO se declara presente. Nem insere, nem atualiza.
-- ===========================================================================
select pg_temp.negar(20, 'INSERT de check-in para SI MESMO (autodeclaração de presença)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f001', 'Participante A', 'operacao')$q$,
  -- Controle positivo com OUTRA pessoa, porque a pessoa A já tem check-in ativo
  -- e o índice único recusaria o segundo (o que daria 23505, não 42501, e o
  -- controle seria inválido).
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f003', 'Yuri Fortes', 'host')$q$);

select pg_temp.negar(20, 'INSERT de check-in para OUTRA pessoa (fingir ser a operação)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'Yuri Fortes', 'host')$q$);

select pg_temp.negar(20, 'UPDATE do PRÓPRIO registro de presença (trocar estado/horário)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$update public.event_checkins set estado = 'ativo', motivo = 'eu estava lá'
     where id = '00000000-0000-4000-8000-00000000c001'$q$,
  -- Controle: o mesmo UPDATE como service_role afeta a linha (estado já é
  -- 'ativo', então o comando é um no-op de valor mas afeta 1 linha).
  $q$update public.event_checkins set motivo = null
     where id = '00000000-0000-4000-8000-00000000c001'$q$);

select pg_temp.negar(20, 'DELETE do PRÓPRIO registro de presença', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$delete from public.event_checkins where id = '00000000-0000-4000-8000-00000000c001'$q$);

select pg_temp.negar(20, 'SELECT do PRÓPRIO registro de presença (dado de operação, não do participante)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$select * from public.event_checkins where id = '00000000-0000-4000-8000-00000000c001'$q$);

select pg_temp.negar(20, 'INSERT de pessoa no evento (criar presença por tabela vizinha)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$insert into public.event_people (event_id, full_name, origem)
     values ('00000000-0000-4000-8000-0000000000e1', 'Pessoa inventada pelo participante', 'walk_in')$q$);

select pg_temp.negar(20, 'INSERT de encerramento de check-in (fechar o universo sozinho)', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$insert into public.event_checkin_closures (event_id, versao, fechado_por, total_presentes_no_fechamento)
     values ('00000000-0000-4000-8000-0000000000e1', 9, 'participante', 1)$q$);

-- Usuário comum que se diz admin no user_metadata (que ele mesmo edita) não
-- vira admin: is_admin() só olha app_metadata.
select pg_temp.negar(20, 'SELECT de presença com role=admin em user_metadata (autopromoção)', 'authenticated (user_metadata diz admin)', 'authenticated', :'claim_user_meta',
  $q$select * from public.event_checkins$q$);

select pg_temp.negar(20, 'anon: SELECT de presença', 'anon', 'anon', pg_temp.cl_anon(),
  $q$select * from public.event_checkins$q$);

select pg_temp.negar(20, 'anon: INSERT de presença', 'anon', 'anon', pg_temp.cl_anon(),
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'anon', 'host')$q$,
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'Yuri Fortes', 'host')$q$);

-- ===========================================================================
-- 20.2 Camada b): COM o EXECUTE concedido de propósito, a função ainda barra
-- ===========================================================================
-- Simula o descuido de alguém reabrir a função para authenticated amanhã. Por
-- NÃO ser SECURITY DEFINER, ela executa com os privilégios de quem chama -- e o
-- privilégio de tabela revogado barra de novo, por baixo.
-- O EXECUTE é concedido para TODA a cadeia, inclusive as funções internas que
-- `marco_zero_checkin_avulso` chama. Não é generosidade: medido nesta imagem,
-- uma chamada ANINHADA a função com EXECUTE revogado derruba o backend com
-- SIGSEGV (o mesmo defeito de ambiente que a prova da 018 documenta para a
-- chamada direta), e um backend derrubado não prova nada -- não é 42501. Com a
-- cadeia toda liberada, a única barreira que resta é o privilégio de TABELA, que
-- é exatamente a afirmação a medir.
grant execute on function public.marco_zero_pessoa_registrar(uuid,text,text,text,text,uuid,text) to authenticated;
grant execute on function public.marco_zero_checkin_registrar(uuid,uuid,text,text,uuid) to authenticated;
grant execute on function public.marco_zero_checkin_avulso(uuid,text,text,text,text,text,uuid) to authenticated;

-- `marco_zero_checkin_registrar` chamada pelo participante NÃO devolve 42501:
-- devolve 23503 da própria guarda de existência da função. Isso é consequência
-- de ela ter direitos de INVOCADOR -- a RLS esconde a linha de `event_people`
-- dele, então a guarda conclui "pessoa não é do evento" ANTES de o INSERT
-- chegar ao privilégio de tabela. A negativa é real e o efeito é zero, mas o
-- código não é de autorização, e o classificador do harness (corretamente)
-- chamaria isso de INCONCLUSIVO. Então aqui a afirmação é medida direto: a
-- chamada FALHA e NENHUMA presença é escrita -- com controle positivo logo
-- abaixo, para que "nenhuma presença" não seja só uma chamada que nunca
-- funcionou para ninguém.
do $$
declare
  r      record;
  ctrl   record;
  v_antes  int;
  v_depois int;
begin
  select count(*) into v_antes from public.event_checkins
   where person_id = '00000000-0000-4000-8000-00000000f002' and estado = 'ativo';

  select * into r from pg_temp.tentar(
    'authenticated',
    pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1'),
    $q$select * from public.marco_zero_checkin_registrar(
         '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002',
         'Participante A', 'operacao')$q$);

  select count(*) into v_depois from public.event_checkins
   where person_id = '00000000-0000-4000-8000-00000000f002' and estado = 'ativo';

  perform pg_temp.afirmar(20,
    'chamar marco_zero_checkin_registrar COM execute concedido: FALHA e não escreve presença',
    'authenticated (participante A, token próprio)',
    r.estado = 'ERRO' and v_depois = v_antes,
    'erro + nenhuma presença ativa nova',
    format('estado=%s cod=%s msg=%s | presenças ativas antes=%s depois=%s',
           r.estado, coalesce(r.cod, '-'), coalesce(r.msg, '-'), v_antes, v_depois));

  -- CONTROLE POSITIVO: a MESMA chamada por service_role registra a presença.
  select * into ctrl from pg_temp.tentar(
    'service_role', pg_temp.cl_service(),
    $q$select * from public.marco_zero_checkin_registrar(
         '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002',
         'Yuri Fortes', 'host')$q$,
    true);

  select count(*) into v_depois from public.event_checkins
   where person_id = '00000000-0000-4000-8000-00000000f002' and estado = 'ativo';

  perform pg_temp.afirmar(20,
    'CONTROLE: a MESMA chamada por service_role registra a presença',
    'service_role',
    ctrl.estado = 'OK' and v_depois = v_antes + 1,
    'OK + 1 presença ativa nova',
    format('estado=%s cod=%s | presenças ativas antes=%s depois=%s',
           ctrl.estado, coalesce(ctrl.cod, '-'), v_antes, v_depois));

  -- Desfaz o efeito do controle: as sondas seguintes contam presença.
  delete from public.event_checkins
   where person_id = '00000000-0000-4000-8000-00000000f002';
end
$$;

select pg_temp.negar(20, 'chamar marco_zero_checkin_avulso (walk-in) COM execute concedido de propósito', 'authenticated (participante A, token próprio)', 'authenticated', :'claim_a',
  $q$select * from public.marco_zero_checkin_avulso(
       '00000000-0000-4000-8000-0000000000e1', 'Eu mesmo na porta', 'Participante A', 'operacao')$q$,
  $q$select * from public.marco_zero_checkin_avulso(
       '00000000-0000-4000-8000-0000000000e1', 'Convidado de verdade', 'Yuri Fortes', 'host')$q$);

revoke execute on function public.marco_zero_pessoa_registrar(uuid,text,text,text,text,uuid,text) from authenticated;
revoke execute on function public.marco_zero_checkin_registrar(uuid,uuid,text,text,uuid) from authenticated;
revoke execute on function public.marco_zero_checkin_avulso(uuid,text,text,text,text,text,uuid) from authenticated;

-- ===========================================================================
-- 20.3 O admin LÊ, mas não escreve
-- ===========================================================================
select pg_temp.permitir(20, 'SELECT de presença (painel do evento)', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$select * from public.event_checkins where event_id = '00000000-0000-4000-8000-0000000000e1'$q$, 1);

select pg_temp.permitir(20, 'SELECT de pessoas do evento', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$select * from public.event_people where event_id = '00000000-0000-4000-8000-0000000000e1'$q$, 3);

select pg_temp.negar(20, 'INSERT de presença pelo cliente do admin (escrita é por rota de servidor)', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'Admin pelo navegador', 'admin')$q$,
  $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'Yuri Fortes', 'host')$q$);

select pg_temp.negar(20, 'UPDATE de presença pelo cliente do admin', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$update public.event_checkins set estado = 'anulado', motivo = 'pelo navegador',
         corrigido_em = now(), corrigido_por = 'admin'
     where id = '00000000-0000-4000-8000-00000000c001'$q$,
  $q$update public.event_checkins set motivo = null
     where id = '00000000-0000-4000-8000-00000000c001'$q$);

-- ===========================================================================
-- 20.4 CONTROLE NEGATIVO GERAL: o fluxo legítimo continua funcionando
-- ===========================================================================
-- Sem isto, tudo acima poderia estar verde por o produto estar quebrado.
select pg_temp.permitir(20, 'registrar presença pela função (fluxo do host)', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.marco_zero_checkin_registrar(
       '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000f002', 'Yuri Fortes', 'host')$q$, 1);

select pg_temp.permitir(20, 'walk-in pela função (pessoa nova + presença)', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.marco_zero_checkin_avulso(
       '00000000-0000-4000-8000-0000000000e1', 'Quem chegou na porta', 'Yuri Fortes', 'host')$q$, 1);

select pg_temp.permitir(20, 'encerrar o check-in (ato do administrador)', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.marco_zero_checkin_encerrar(
       '00000000-0000-4000-8000-0000000000e1', 'Administrador')$q$, 1);

select pg_temp.permitir(20, 'ler a cobertura pela função', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.marco_zero_cobertura('00000000-0000-4000-8000-0000000000e1')$q$, 1);

\o
select linha from relatorio order by ordem;
select format('PROVA-020-RLS: %s (%s de %s sondas)',
              case when bool_and(ok) then 'PASS' else 'FAIL' end,
              count(*) filter (where ok), count(*)) as veredito
from relatorio;
rollback;
