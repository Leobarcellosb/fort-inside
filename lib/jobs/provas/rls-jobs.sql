-- Sonda de RLS e privilégio da tabela `jobs` e das funções da fila (migration 018).
--
-- Esperado, e nada além disto:
--   anon                                    -> não chega nem na policy (42501 de tabela)
--   participante (authenticated sem admin)  -> NÃO enxerga job nenhum, nem o próprio
--   admin (app_metadata.role = 'admin')     -> LÊ todos, mas NÃO escreve e NÃO aciona a fila
--   service_role                            -> lê, escreve e aciona a fila
--
-- Reusa o ferramental da suíte de segurança do projeto (`scripts/db-security`),
-- que já resolve o que é difícil aqui: cada sonda roda em savepoint (um erro
-- NUNCA aborta a transação do cenário), um erro que não é 42501 conta como
-- INCONCLUSIVO e portanto FALHA, e toda negativa exige CONTROLE POSITIVO -- o
-- mesmo comando como service_role tem de afetar linha, senão "0 linhas" poderia
-- ser só tabela vazia ou WHERE errado.
--
-- DUAS CAMADAS para as funções, igual ao cenário 4 da suíte do projeto:
--   camada a) privilégio: o catálogo (has_function_privilege) diz que anon,
--      authenticated e PUBLIC não têm EXECUTE. Verificar no catálogo em vez de
--      chamar não é preguiça: na imagem descartável do reference-db.sh
--      (supabase/postgres 17.6.1.106, com pgaudit em shared_preload_libraries)
--      uma chamada de função com EXECUTE REVOGADO derruba o backend com
--      SIGSEGV em vez de devolver 42501 -- vale para qualquer função, inclusive
--      a `delete_event_cascade` da 005. É defeito do ambiente, não da 018, e é
--      exatamente por isso que o cenário 4 da suíte também usa o catálogo.
--   camada b) corpo: COM o EXECUTE concedido de propósito (simulando o descuido
--      de alguém reabrir a função), a chamada ainda tem de ser barrada -- pelo
--      privilégio de TABELA revogado. É a afirmação que a própria 018 faz no
--      comentário de "Privilégio de execução", aqui provada.
--
-- Roda inteiro em transação com rollback: não deixa nada no banco.

begin;
\o /dev/null
\ir ../../../scripts/db-security/_lib.sql
\ir ../../../scripts/db-security/_seed.sql

-- Terceiro participante, para que os controles positivos de INSERT tenham onde
-- escrever sem bater no unique (kind, participant_id).
insert into public.participants (id, event_id, user_id, full_name, email)
values ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000e1',
        null, 'Participante C', 'c@prova-jobs.test');

-- Dois jobs: um do participante A (que vai tentar ler o PRÓPRIO) e um de B.
insert into public.jobs (kind, event_id, participant_id, status, attempts, last_error)
values
  ('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a2', 'failed', 3, 'erro interno que o participante nao deve ler'),
  ('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b2', 'pending', 0, null);

\set A '''00000000-0000-4000-8000-0000000000a1'''
select pg_temp.cl_user(:A::uuid) as claim_a,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000ad', 'admin') as claim_admin,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000c1', null, 'admin') as claim_user_meta
\gset

-- ---------------------------------------------------------------------------
-- 6.0 estrutura: RLS ligada e uma única policy, de leitura, atrás de is_admin()
-- ---------------------------------------------------------------------------
select pg_temp.afirmar(6, 'RLS está LIGADA em public.jobs', 'estrutura',
  (select relrowsecurity from pg_class where oid = 'public.jobs'::regclass),
  'relrowsecurity = true',
  'relrowsecurity = ' || (select relrowsecurity::text from pg_class where oid = 'public.jobs'::regclass));

select pg_temp.afirmar(6, 'a única policy de jobs é SELECT atrás de is_admin()', 'estrutura',
  (select count(*) = 1 and bool_and(cmd = 'SELECT' and qual like '%is_admin%')
     from pg_policies where schemaname = 'public' and tablename = 'jobs'),
  'exatamente 1 policy, cmd=SELECT, usando is_admin()',
  coalesce((select string_agg(policyname || ':' || cmd || ':' || coalesce(qual,''), ', ')
              from pg_policies where schemaname = 'public' and tablename = 'jobs'), '<nenhuma>'));

select pg_temp.afirmar(6, 'anon não tem privilégio ALGUM na tabela jobs', 'estrutura',
  not (has_table_privilege('anon', 'public.jobs', 'select')
    or has_table_privilege('anon', 'public.jobs', 'insert')
    or has_table_privilege('anon', 'public.jobs', 'update')
    or has_table_privilege('anon', 'public.jobs', 'delete')),
  'select/insert/update/delete = false',
  format('select=%s insert=%s update=%s delete=%s',
    has_table_privilege('anon', 'public.jobs', 'select'),
    has_table_privilege('anon', 'public.jobs', 'insert'),
    has_table_privilege('anon', 'public.jobs', 'update'),
    has_table_privilege('anon', 'public.jobs', 'delete')));

select pg_temp.afirmar(6, 'authenticated tem SELECT e NADA de escrita na tabela jobs', 'estrutura',
  has_table_privilege('authenticated', 'public.jobs', 'select')
  and not (has_table_privilege('authenticated', 'public.jobs', 'insert')
        or has_table_privilege('authenticated', 'public.jobs', 'update')
        or has_table_privilege('authenticated', 'public.jobs', 'delete')),
  'select=true e insert/update/delete=false',
  format('select=%s insert=%s update=%s delete=%s',
    has_table_privilege('authenticated', 'public.jobs', 'select'),
    has_table_privilege('authenticated', 'public.jobs', 'insert'),
    has_table_privilege('authenticated', 'public.jobs', 'update'),
    has_table_privilege('authenticated', 'public.jobs', 'delete')));

select pg_temp.afirmar(6, 'service_role escreve na tabela jobs (controle positivo de privilégio)', 'estrutura',
  has_table_privilege('service_role', 'public.jobs', 'select')
  and has_table_privilege('service_role', 'public.jobs', 'insert')
  and has_table_privilege('service_role', 'public.jobs', 'update')
  and has_table_privilege('service_role', 'public.jobs', 'delete'),
  'select/insert/update/delete = true',
  format('select=%s insert=%s update=%s delete=%s',
    has_table_privilege('service_role', 'public.jobs', 'select'),
    has_table_privilege('service_role', 'public.jobs', 'insert'),
    has_table_privilege('service_role', 'public.jobs', 'update'),
    has_table_privilege('service_role', 'public.jobs', 'delete')));

-- ---------------------------------------------------------------------------
-- 6.1 anon: nem chega na policy (o privilégio de tabela foi revogado na 018)
-- ---------------------------------------------------------------------------
select pg_temp.negar(6, 'SELECT em jobs', 'anon', 'anon', pg_temp.cl_anon(),
  'select * from public.jobs');

select pg_temp.negar(6, 'INSERT em jobs (enfileirar trabalho pago)', 'anon', 'anon', pg_temp.cl_anon(),
  $q$insert into public.jobs (kind, event_id, participant_id) values ('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$,
  $q$insert into public.jobs (kind, event_id, participant_id) values ('pdf', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$);

select pg_temp.negar(6, 'UPDATE em jobs (marcar job como succeeded)', 'anon', 'anon', pg_temp.cl_anon(),
  $q$update public.jobs set status = 'succeeded' where kind = 'prognostico'$q$);

select pg_temp.negar(6, 'DELETE em jobs (apagar o rastro da falha)', 'anon', 'anon', pg_temp.cl_anon(),
  'delete from public.jobs');

-- ---------------------------------------------------------------------------
-- 6.2 participante: a policy devolve ZERO linha, inclusive para o próprio job
-- ---------------------------------------------------------------------------
select pg_temp.negar(6, 'SELECT em jobs (sem filtro)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'select * from public.jobs');

select pg_temp.negar(6, 'SELECT do PRÓPRIO job (não enxerga nem o dele)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$select * from public.jobs where participant_id = '00000000-0000-4000-8000-0000000000a2'$q$);

select pg_temp.negar(6, 'INSERT em jobs (enfileirar a si mesmo para gastar Opus)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$insert into public.jobs (kind, event_id, participant_id) values ('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$,
  $q$insert into public.jobs (kind, event_id, participant_id) values ('pdf', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$);

select pg_temp.negar(6, 'UPDATE em jobs (zerar attempts para forçar regeração)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  $q$update public.jobs set attempts = 0, status = 'pending' where kind = 'prognostico'$q$);

select pg_temp.negar(6, 'DELETE em jobs', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'delete from public.jobs');

-- admin nunca vem de user_metadata (que o próprio usuário edita)
select pg_temp.negar(6, 'SELECT em jobs com user_metadata.role=admin (NÃO é admin)', 'authenticated (user_metadata.role=admin)', 'authenticated', :'claim_user_meta',
  'select * from public.jobs');

-- ---------------------------------------------------------------------------
-- 6.3 admin: LÊ tudo (controle positivo: o corte é is_admin(), não "nega todos")
-- ---------------------------------------------------------------------------
select pg_temp.permitir(6, 'SELECT em jobs: vê os DOIS jobs do evento', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$select * from public.jobs where kind = 'prognostico'$q$, 2, false, 2);

select pg_temp.permitir(6, 'SELECT do rastro da falha (last_error) de qualquer participante', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$select last_error from public.jobs where status = 'failed'$q$, 1, false, 1);

-- ...mas NÃO escreve: a 018 concede só SELECT a authenticated.
select pg_temp.negar(6, 'INSERT em jobs', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$insert into public.jobs (kind, event_id, participant_id) values ('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$,
  $q$insert into public.jobs (kind, event_id, participant_id) values ('pdf', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$);

select pg_temp.negar(6, 'UPDATE em jobs', 'authenticated (admin)', 'authenticated', :'claim_admin',
  $q$update public.jobs set status = 'succeeded' where kind = 'prognostico'$q$);

select pg_temp.negar(6, 'DELETE em jobs', 'authenticated (admin)', 'authenticated', :'claim_admin',
  'delete from public.jobs');

-- ---------------------------------------------------------------------------
-- 6.4 funções da fila, camada a) privilégio: só service_role tem EXECUTE
-- ---------------------------------------------------------------------------
create temp table fn_fila(assinatura text) on commit drop;
insert into fn_fila values
  ('public.jobs_enfileirar(text,uuid,uuid,int,int)'),
  ('public.jobs_reivindicar(text,text,int,int,int)'),
  ('public.jobs_renovar_lease(uuid,uuid,int)'),
  ('public.jobs_concluir(uuid,uuid,text,jsonb,jsonb)'),
  ('public.jobs_falhar(uuid,uuid,text,text,int)'),
  ('public.jobs_recuperar_expirados(text,int)'),
  ('public.jobs_reenfileirar(uuid,boolean)'),
  ('public.jobs_cancelar(uuid,text)'),
  ('public.jobs_resumo_evento(uuid,text)'),
  ('public.jobs_fechar_evento_se_concluido(uuid,text)');

select pg_temp.afirmar(6, 'nenhuma das 10 funções da fila tem EXECUTE para anon', 'anon [camada a: privilégio]',
  (select count(*) = 0 from fn_fila where has_function_privilege('anon', assinatura, 'execute')),
  'has_function_privilege = false nas 10',
  coalesce((select string_agg(assinatura, ', ') from fn_fila where has_function_privilege('anon', assinatura, 'execute')), 'nenhuma vaza'));

select pg_temp.afirmar(6, 'nenhuma das 10 funções da fila tem EXECUTE para authenticated (nem para o admin)', 'authenticated [camada a: privilégio]',
  (select count(*) = 0 from fn_fila where has_function_privilege('authenticated', assinatura, 'execute')),
  'has_function_privilege = false nas 10',
  coalesce((select string_agg(assinatura, ', ') from fn_fila where has_function_privilege('authenticated', assinatura, 'execute')), 'nenhuma vaza'));

select pg_temp.afirmar(6, 'PUBLIC não tem EXECUTE em nenhuma das 10 (o default do Postgres foi revogado)', 'PUBLIC [camada a: privilégio]',
  (select count(*) = 0 from fn_fila f
     join pg_proc p on p.oid = f.assinatura::regprocedure
    where coalesce(p.proacl::text, '') like '%=X/%' and coalesce(p.proacl::text, '') ~ '(^|,)=X/'),
  'sem entrada "=X/" (PUBLIC) no proacl das 10',
  coalesce((select string_agg(p.proname || ' -> ' || coalesce(p.proacl::text, '<null>'), ', ')
              from fn_fila f join pg_proc p on p.oid = f.assinatura::regprocedure
             where coalesce(p.proacl::text, '') ~ '(^|,)=X/'), 'nenhuma vaza'));

select pg_temp.afirmar(6, 'service_role TEM EXECUTE nas 10 (o caminho legítimo existe)', 'service_role [camada a: privilégio]',
  (select count(*) = 10 from fn_fila where has_function_privilege('service_role', assinatura, 'execute')),
  '10 de 10 com has_function_privilege = true',
  (select count(*)::text || ' de 10' from fn_fila where has_function_privilege('service_role', assinatura, 'execute')));

-- ---------------------------------------------------------------------------
-- 6.5 funções da fila, camada b) corpo: COM o EXECUTE reaberto por descuido, o
--     privilégio de TABELA revogado ainda barra. Esta é a afirmação que a 018
--     faz em comentário; aqui ela é medida.
-- ---------------------------------------------------------------------------
grant execute on function public.jobs_reivindicar(text,text,int,int,int) to anon, authenticated;
grant execute on function public.jobs_enfileirar(text,uuid,uuid,int,int) to anon, authenticated;
grant execute on function public.jobs_cancelar(uuid,text) to anon, authenticated;
grant execute on function public.jobs_reenfileirar(uuid,boolean) to anon, authenticated;

select pg_temp.negar(6, 'jobs_reivindicar COM EXECUTE concedido (GRANT simulado): o corpo bate na tabela', 'anon [camada b: corpo]', 'anon', pg_temp.cl_anon(),
  $q$select * from public.jobs_reivindicar('prognostico', 'invasor', 60, 5, 3)$q$,
  $q$select * from public.jobs_reivindicar('prognostico', 'worker-controle', 60, 5, 3)$q$);

select pg_temp.negar(6, 'jobs_reivindicar COM EXECUTE concedido (GRANT simulado)', 'authenticated (participante A) [camada b: corpo]', 'authenticated', :'claim_a',
  $q$select * from public.jobs_reivindicar('prognostico', 'invasor', 60, 5, 3)$q$,
  $q$select * from public.jobs_reivindicar('prognostico', 'worker-controle', 60, 5, 3)$q$);

select pg_temp.negar(6, 'jobs_reivindicar COM EXECUTE concedido (nem o admin aciona a fila pelo navegador)', 'authenticated (admin) [camada b: corpo]', 'authenticated', :'claim_admin',
  $q$select * from public.jobs_reivindicar('prognostico', 'admin-pelo-navegador', 60, 5, 3)$q$,
  $q$select * from public.jobs_reivindicar('prognostico', 'worker-controle', 60, 5, 3)$q$);

select pg_temp.negar(6, 'jobs_enfileirar COM EXECUTE concedido (participante se enfileirando)', 'authenticated (participante A) [camada b: corpo]', 'authenticated', :'claim_a',
  $q$select * from public.jobs_enfileirar('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$);

-- jobs_reenfileirar devolve LINHA mesmo quando recusa (aplicado = false), então
-- aqui a sonda tem de olhar o EFEITO, não a contagem de linhas: `where aplicado`
-- deixa 0 linha quando nada foi reenfileirado. Para o participante a recusa vem
-- da RLS (o `select ... into v_antes` não enxerga a linha, v_antes fica NULL e a
-- função sai em "job inexistente" antes do UPDATE); para o admin, que ENXERGA a
-- linha, a recusa vem do privilégio de UPDATE revogado -- as duas metades da
-- defesa, medidas separadamente.
select pg_temp.negar(6, 'jobs_reenfileirar COM EXECUTE concedido: não reenfileira (a RLS esconde a linha)', 'authenticated (participante A) [camada b: corpo]', 'authenticated', :'claim_a',
  $q$select * from public.jobs_reenfileirar((select id from public.jobs where status = 'failed' limit 1), true) where aplicado$q$,
  $q$select * from public.jobs_reenfileirar((select id from public.jobs where status = 'failed' limit 1), true) where aplicado$q$);

select pg_temp.negar(6, 'jobs_reenfileirar COM EXECUTE concedido: o admin ENXERGA a linha e ainda assim é barrado pelo UPDATE revogado', 'authenticated (admin) [camada b: corpo]', 'authenticated', :'claim_admin',
  $q$select * from public.jobs_reenfileirar((select id from public.jobs where status = 'failed' limit 1), true) where aplicado$q$,
  $q$select * from public.jobs_reenfileirar((select id from public.jobs where status = 'failed' limit 1), true) where aplicado$q$);

select pg_temp.negar(6, 'jobs_cancelar COM EXECUTE concedido (cancelar o job de outro)', 'authenticated (participante A) [camada b: corpo]', 'authenticated', :'claim_a',
  $q$select public.jobs_cancelar((select id from public.jobs where status = 'pending' limit 1), 'cancelado por invasor')$q$,
  $q$update public.jobs set priority = priority where status = 'pending'$q$);

-- ---------------------------------------------------------------------------
-- 6.6 service_role: é por ele que a fila funciona (controles positivos)
-- ---------------------------------------------------------------------------
select pg_temp.permitir(6, 'SELECT em jobs', 'service_role', 'service_role', pg_temp.cl_service(),
  'select * from public.jobs', 2);

select pg_temp.permitir(6, 'jobs_reivindicar pega o job pendente', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.jobs_reivindicar('prognostico', 'worker-legitimo', 60, 5, 3)$q$, 1, false, 1);

select pg_temp.permitir(6, 'jobs_enfileirar cria o job do participante C', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select * from public.jobs_enfileirar('prognostico', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c2')$q$, 1);

select pg_temp.permitir(6, 'UPDATE direto em jobs', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$update public.jobs set priority = 1 where kind = 'prognostico'$q$, 2);

-- Verificação final: nenhuma das tentativas barradas mexeu na fila.
select pg_temp.afirmar(6, 'depois de todas as tentativas barradas, a fila está intacta', 'postgres [verificação]',
  (select count(*) = 2 and bool_and(priority = 0) and bool_and(run_token is null)
     from public.jobs where kind = 'prognostico'),
  '2 jobs, priority 0, nenhum reivindicado',
  (select format('%s job(s), prioridades {%s}, reivindicados=%s',
                 count(*), string_agg(distinct priority::text, ','),
                 count(*) filter (where run_token is not null))
     from public.jobs where kind = 'prognostico'));

\o
select linha from relatorio order by ordem;
rollback;
