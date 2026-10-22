-- Cenário 4 -- chamada da função destrutiva delete_event_cascade(uuid).
-- Duas camadas, testadas SEPARADAMENTE porque protegem coisas diferentes:
--   (a) privilégio: anon/authenticated/PUBLIC sem EXECUTE (revogado na 011). Some se alguém der GRANT.
--   (b) corpo: a função recusa contexto não privilegiado com 42501 (is_admin()). Não some com GRANT.
-- Para isolar (b), a transação concede EXECUTE a anon/authenticated/PUBLIC (rollback no fim) e
-- chama como cada papel; assim o erro só pode vir do corpo.
begin;
\o /dev/null
\ir _lib.sql
\ir _seed.sql

select pg_temp.cl_user('00000000-0000-4000-8000-0000000000a1') as claim_a,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000ad', 'admin') as claim_admin,
       pg_temp.cl_user('00000000-0000-4000-8000-0000000000c1', null, 'admin') as claim_user_meta
\gset

-- Chama a função e confere: erro 42501 cuja mensagem contém p_trecho (isso distingue as camadas).
create function pg_temp.chamar_e_exigir_erro(p_titulo text, p_rotulo text, p_papel text, p_claims text,
                                             p_trecho text, p_camada text, p_persistir boolean default false)
returns void language plpgsql as $$
declare r record; v boolean;
begin
  select * into r from pg_temp.tentar(p_papel, p_claims,
    $q$select public.delete_event_cascade('00000000-0000-4000-8000-0000000000e1')$q$, p_persistir);
  v := (r.estado = 'ERRO' and r.cod = '42501' and r.msg ilike '%' || p_trecho || '%');
  insert into relatorio(cenario, ok, linha) values (4, v,
    format('[%s] papel=%s [camada %s] | %s | esperado: erro 42501 "%s" | obtido: %s',
           case when v then 'ok  ' else 'FALHA' end, p_rotulo, p_camada, p_titulo, p_trecho,
           case when r.estado = 'ERRO' then 'erro ' || r.cod || ': ' || r.msg
                else 'EXECUTOU (' || r.n || ' linha) -- a função destrutiva foi chamada com sucesso' end));
end $$;

-- ---------------- Camada (a): privilégio ----------------
select pg_temp.afirmar(4, 'anon NÃO tem EXECUTE em delete_event_cascade(uuid)', 'anon [camada a: privilégio]',
  not has_function_privilege('anon', 'public.delete_event_cascade(uuid)', 'execute'),
  'has_function_privilege = false', 'has_function_privilege = ' || has_function_privilege('anon', 'public.delete_event_cascade(uuid)', 'execute'));

select pg_temp.afirmar(4, 'authenticated NÃO tem EXECUTE em delete_event_cascade(uuid)', 'authenticated [camada a: privilégio]',
  not has_function_privilege('authenticated', 'public.delete_event_cascade(uuid)', 'execute'),
  'has_function_privilege = false', 'has_function_privilege = ' || has_function_privilege('authenticated', 'public.delete_event_cascade(uuid)', 'execute'));

select pg_temp.afirmar(4, 'PUBLIC NÃO tem EXECUTE em delete_event_cascade(uuid) (default do Postgres que a 005 deixou aberto)', 'PUBLIC [camada a: privilégio]',
  not exists (select 1
                from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where p.oid = 'public.delete_event_cascade(uuid)'::regprocedure
                 and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'sem entrada de EXECUTE para PUBLIC no proacl', 'proacl = ' || coalesce((select proacl::text from pg_proc where oid = 'public.delete_event_cascade(uuid)'::regprocedure), 'NULL'));

select pg_temp.afirmar(4, 'service_role TEM EXECUTE (caminho administrativo legítimo)', 'service_role [camada a: privilégio]',
  has_function_privilege('service_role', 'public.delete_event_cascade(uuid)', 'execute'),
  'has_function_privilege = true', 'has_function_privilege = ' || has_function_privilege('service_role', 'public.delete_event_cascade(uuid)', 'execute'));

-- NOTA: a camada (a) é verificada pelo CATÁLOGO, não chamando a função sem privilégio. No
-- Postgres 17.6 do stack local do Supabase (aarch64), uma chamada de função que falha na
-- checagem de EXECUTE derruba o servidor com SIGSEGV (reproduzível com qualquer função, e
-- só com função; permission denied em TABELA funciona). A suíte nunca faz essa chamada.

select pg_temp.permitir(4, 'chamada real da função (controle: o caminho legítimo funciona)', 'service_role', 'service_role', pg_temp.cl_service(),
  $q$select public.delete_event_cascade('00000000-0000-4000-8000-0000000000e1')$q$);

-- ---------------- Camada (b): corpo da função ----------------
-- Simula o pior caso: alguém deu GRANT. Dentro da transação; o rollback desfaz.
grant execute on function public.delete_event_cascade(uuid) to public, anon, authenticated;

select pg_temp.chamar_e_exigir_erro('chamada real COM EXECUTE concedido (GRANT simulado)', 'anon', 'anon', pg_temp.cl_anon(),
  'chamada nao autorizada', 'b: corpo', true);

select pg_temp.chamar_e_exigir_erro('chamada real COM EXECUTE concedido (GRANT simulado)', 'authenticated (participante A)', 'authenticated', :'claim_a',
  'chamada nao autorizada', 'b: corpo', true);

select pg_temp.chamar_e_exigir_erro('chamada real COM EXECUTE concedido (user_metadata.role=admin NÃO é admin)', 'authenticated (usuário com user_metadata.role=admin)', 'authenticated', :'claim_user_meta',
  'chamada nao autorizada', 'b: corpo', true);

-- As tentativas acima foram executadas com persistir=true: se o corpo não tivesse segurado,
-- a exclusão estaria confirmada na transação e estes dados teriam sumido.
select pg_temp.afirmar(4, 'após as tentativas barradas pelo corpo, evento, participantes e respostas seguem intactos', 'postgres [verificação]',
  (select count(*) from public.events where id = '00000000-0000-4000-8000-0000000000e1') = 1
  and (select count(*) from public.participants where event_id = '00000000-0000-4000-8000-0000000000e1') = 2
  and (select count(*) from public.quiz_responses) = 3
  and (select count(*) from auth.users where email like '%@seguranca.test') = 4,
  '1 evento, 2 participantes, 3 respostas, 4 usuários de teste',
  format('%s evento(s), %s participante(s), %s resposta(s), %s usuário(s)',
         (select count(*) from public.events where id = '00000000-0000-4000-8000-0000000000e1'),
         (select count(*) from public.participants where event_id = '00000000-0000-4000-8000-0000000000e1'),
         (select count(*) from public.quiz_responses),
         (select count(*) from auth.users where email like '%@seguranca.test')));

select pg_temp.permitir(4, 'o corpo deixa passar quem é admin (não é "negar tudo")', 'authenticated (admin: app_metadata.role=admin, EXECUTE simulado)', 'authenticated', :'claim_admin',
  $q$select public.delete_event_cascade('00000000-0000-4000-8000-0000000000e1')$q$);

\o
select linha from relatorio order by ordem;
rollback;
