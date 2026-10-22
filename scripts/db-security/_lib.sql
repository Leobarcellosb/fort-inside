-- _lib.sql -- ferramentas da suíte de segurança da camada de banco.
-- Incluído (\ir) por cada cenário DENTRO da transação do cenário; tudo vive em pg_temp
-- e some junto com o rollback.
--
-- PRINCÍPIO: uma negativa só vale se for negativa de AUTORIZAÇÃO. Cada sonda roda dentro de
-- um sub-bloco com exceção (savepoint), então um erro NUNCA aborta a transação do cenário, e
-- o resultado é classificado em quatro vereditos:
--   NEGADO (42501)       -> erro de autorização (RLS ou privilégio)
--   NEGADO (0 linhas)    -> a RLS filtrou tudo
--   PERMITIDO (n linhas) -> o papel conseguiu: é a regressão que a suíte procura
--   INCONCLUSIVO         -> erro que NÃO é de autorização (sintaxe, tipo, constraint...):
--                           conta como FALHA, porque não prova nada
-- Além disso, toda negativa exige um CONTROLE: o mesmo comando, como service_role, tem de
-- afetar >= 1 linha. Sem isso "0 linhas" poderia ser só uma tabela vazia ou um WHERE errado.

create temp table relatorio (
  ordem    serial primary key,
  cenario  int     not null,
  ok       boolean not null,
  linha    text    not null
) on commit drop;

-- ---------------------------------------------------------------------------
-- Claims de JWT, como o PostgREST os monta por requisição.
-- ---------------------------------------------------------------------------
create function pg_temp.cl_anon() returns text language sql as
$$ select '{"role":"anon"}' $$;

create function pg_temp.cl_service() returns text language sql as
$$ select '{"role":"service_role"}' $$;

-- Usuário autenticado. p_app_role = app_metadata.role (só o servidor consegue definir);
-- p_user_role = user_metadata.role (o PRÓPRIO usuário consegue editar: nunca pode dar poder).
create function pg_temp.cl_user(p_uid uuid, p_app_role text default null, p_user_role text default null)
returns text language sql as $$
  select jsonb_build_object(
    'role', 'authenticated',
    'aud',  'authenticated',
    'sub',  p_uid::text,
    'app_metadata',  case when p_app_role  is null then '{}'::jsonb else jsonb_build_object('role', p_app_role)  end,
    'user_metadata', case when p_user_role is null then '{}'::jsonb else jsonb_build_object('role', p_user_role) end
  )::text
$$;

-- ---------------------------------------------------------------------------
-- tentar(): executa p_sql como p_papel com as claims dadas e devolve o desfecho bruto.
-- Nunca propaga erro. Por padrão desfaz o efeito da sonda (savepoint); p_persistir = true
-- mantém o efeito dentro da transação do cenário (para fluxos em várias etapas).
-- ---------------------------------------------------------------------------
create function pg_temp.tentar(p_papel text, p_claims text, p_sql text, p_persistir boolean default false,
                               out estado text, out n bigint, out cod text, out msg text)
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  execute format('set local role %I', p_papel);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    estado := 'OK';
    if not p_persistir then
      raise exception 'desfazendo a sonda' using errcode = 'RB001';
    end if;
  exception
    when sqlstate 'RB001' then null;
    when others then
      get stacked diagnostics cod = returned_sqlstate, msg = message_text;
      estado := 'ERRO';
      n := null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- classificar(): estado bruto -> (negado?, texto do veredito)
-- ---------------------------------------------------------------------------
create function pg_temp.classificar(p_estado text, p_n bigint, p_cod text, p_msg text,
                                    out negado boolean, out veredito text)
language plpgsql as $$
begin
  if p_estado = 'ERRO' and p_cod = '42501' then
    negado := true;
    veredito := case
      when p_msg ilike '%row-level security%' then 'NEGADO por RLS (42501)'
      when p_msg ilike '%permission denied%'   then 'NEGADO por privilégio (42501)'
      else 'NEGADO (42501: ' || p_msg || ')'
    end;
  elsif p_estado = 'OK' and p_n = 0 then
    negado := true;
    veredito := 'NEGADO (0 linhas: RLS filtrou)';
  elsif p_estado = 'OK' then
    negado := false;
    veredito := 'PERMITIDO (' || p_n || ' linha(s))';
  else
    negado := false;
    veredito := 'INCONCLUSIVO (erro ' || coalesce(p_cod, '?') || ' que NÃO é de autorização: ' || coalesce(p_msg, '?') || ')';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- avaliar_negacao(): roda controle + sonda e devolve (ok, linha). Não grava nada.
-- ---------------------------------------------------------------------------
create function pg_temp.avaliar_negacao(p_titulo text, p_rotulo text, p_papel text, p_claims text,
                                        p_sql text, p_ctrl_sql text default null,
                                        out ok boolean, out linha text)
language plpgsql as $$
declare
  c record;
  r record;
  k record;
  base text;
begin
  base := format('papel=%s | %s', p_rotulo, p_titulo);
  select * into c from pg_temp.tentar('service_role', pg_temp.cl_service(), coalesce(p_ctrl_sql, p_sql));
  if c.estado is distinct from 'OK' or c.n < 1 then
    ok := false;
    linha := format('[FALHA] %s | CONTROLE INVÁLIDO: o mesmo comando como service_role não afetou linha alguma (%s). A sonda não prova nada.',
                    base, case when c.estado = 'ERRO' then 'erro ' || c.cod || ': ' || c.msg else c.n || ' linhas' end);
    return;
  end if;
  select * into r from pg_temp.tentar(p_papel, p_claims, p_sql);
  select * into k from pg_temp.classificar(r.estado, r.n, r.cod, r.msg);
  ok := k.negado;
  linha := format('[%s] %s | esperado: NEGADO (42501 ou 0 linhas) | obtido: %s | controle service_role: %s linha(s)',
                  case when ok then 'ok  ' else 'FALHA' end, base, k.veredito, c.n);
end $$;

create function pg_temp.negar(p_cen int, p_titulo text, p_rotulo text, p_papel text, p_claims text,
                              p_sql text, p_ctrl_sql text default null)
returns void language plpgsql as $$
declare a record;
begin
  select * into a from pg_temp.avaliar_negacao(p_titulo, p_rotulo, p_papel, p_claims, p_sql, p_ctrl_sql);
  insert into relatorio(cenario, ok, linha) values (p_cen, a.ok, a.linha);
end $$;

-- ---------------------------------------------------------------------------
-- permitir(): o fluxo legítimo TEM de funcionar (n >= p_min linhas).
-- ---------------------------------------------------------------------------
create function pg_temp.permitir(p_cen int, p_titulo text, p_rotulo text, p_papel text, p_claims text,
                                 p_sql text, p_min bigint default 1, p_persistir boolean default false,
                                 p_exato bigint default null)
returns void language plpgsql as $$
declare
  r record;
  k record;
  v boolean;
  txt text;
begin
  select * into r from pg_temp.tentar(p_papel, p_claims, p_sql, p_persistir);
  select * into k from pg_temp.classificar(r.estado, r.n, r.cod, r.msg);
  v := (r.estado = 'OK' and r.n >= p_min and (p_exato is null or r.n = p_exato));
  txt := case
    when v then 'PERMITIDO (' || r.n || ' linha(s))'
    when r.estado = 'OK' then 'PERMITIDO mas afetou ' || r.n || ' linha(s) (esperava ' || coalesce('exatamente ' || p_exato, '>= ' || p_min) || ')'
    when r.cod = '42501' then 'BLOQUEADO indevidamente: ' || k.veredito || ' (o produto quebrou)'
    else 'ERRO ' || coalesce(r.cod, '?') || ': ' || coalesce(r.msg, '?')
  end;
  insert into relatorio(cenario, ok, linha) values (p_cen, v,
    format('[%s] papel=%s | %s | esperado: PERMITIDO (%s linha) | obtido: %s',
           case when v then 'ok  ' else 'FALHA' end, p_rotulo, p_titulo, coalesce('exatamente ' || p_exato, '>= ' || p_min), txt));
end $$;

-- ---------------------------------------------------------------------------
-- afirmar(): checagem estrutural (catálogo), com esperado e obtido explícitos.
-- ---------------------------------------------------------------------------
create function pg_temp.afirmar(p_cen int, p_titulo text, p_rotulo text, p_cond boolean,
                                p_esperado text, p_obtido text)
returns void language plpgsql as $$
begin
  insert into relatorio(cenario, ok, linha) values (p_cen, coalesce(p_cond, false),
    format('[%s] papel=%s | %s | esperado: %s | obtido: %s',
           case when coalesce(p_cond, false) then 'ok  ' else 'FALHA' end, p_rotulo, p_titulo, p_esperado, p_obtido));
end $$;
