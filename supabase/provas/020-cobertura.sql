-- Prova FUNCIONAL do modelo de presença/convites e do denominador oficial
-- (migration 020), contra Postgres de verdade.
--
-- O caso canônico da decisão: 50 compareceram, 45 responderam validamente ->
-- 90%. Quem compareceu e não preencheu CONTINUA no denominador.
--
-- Cada afirmação tem CONTROLE NEGATIVO: ao lado da recusa, o fluxo legítimo
-- equivalente que tem de continuar funcionando. Sem isso, "o banco recusou"
-- poderia ser só um banco quebrado.
--
-- Roda inteiro em transação com rollback: não deixa nada no banco.
--
-- NOTA DE MECÂNICA, aprendida nesta sessão: as seções destrutivas rodam em
-- SAVEPOINT, e `rollback to savepoint` desfaz TAMBÉM as linhas que o harness
-- gravou na tabela `relatorio` -- o relatório sumiria junto com o cenário. Por
-- isso cada seção com savepoint IMPRIME o próprio trecho do relatório antes de
-- voltar, e o veredito final é contado pelo runner sobre a saída inteira
-- (supabase/provas/rodar-020.sh), não por um select no fim do arquivo.

begin;
\o /dev/null
\ir ../../scripts/db-security/_lib.sql

-- ===========================================================================
-- Massa: um evento com 50 PESSOAS presentes
-- ===========================================================================
--   45 pessoas: participante com as 5 etapas da quiz_version 2 respondidas
--               (respostas não vazias) e completed_at -> válido e completo
--    3 pessoas: participante com 3 das 5 etapas -> presente e NÃO respondente
--    2 pessoas: SEM participante nenhum (compareceu sem criar conta)
--               -> presente e NÃO respondente
--   => presentes = 50, respondentes válidos = 45, cobertura = 90%
--
-- Os 2 sem conta são o motivo de o modelo existir: numa coluna `is_present` em
-- participants eles não teriam onde ser contados.
insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
values ('00000000-0000-4000-9000-0000000000e2', 'Marco Zero -- prova 50/45',
        'PROVA-020-E2', now(), 'live', 5, 2);

create temp table pv(i int primary key, pid uuid) on commit drop;
insert into pv(i, pid)
select i, gen_random_uuid() from generate_series(1, 48) i;

insert into public.participants (id, event_id, full_name, email, completed_at)
select pv.pid, '00000000-0000-4000-9000-0000000000e2',
       'Participante ' || pv.i, 'p' || pv.i || '@prova020.test',
       case when pv.i <= 45 then now() else null end
from pv;

-- 45 completos: todas as 5 etapas da versão 2, respostas não vazias.
insert into public.quiz_responses (participant_id, stage_id, answers)
select pv.pid, qs.id, '{"q1": "respondido"}'::jsonb
from pv
join public.quiz_stages qs on qs.quiz_version = 2
where pv.i <= 45;

-- 3 incompletos: 3 das 5 etapas.
insert into public.quiz_responses (participant_id, stage_id, answers)
select pv.pid, qs.id, '{"q1": "respondido"}'::jsonb
from pv
join public.quiz_stages qs on qs.quiz_version = 2 and qs.id in (101, 102, 103)
where pv.i between 46 and 48;

-- Pessoas: 48 com participante vinculado + 2 sem conta nenhuma.
insert into public.event_people (event_id, participant_id, full_name, email, origem)
select '00000000-0000-4000-9000-0000000000e2', pv.pid,
       'Participante ' || pv.i, 'p' || pv.i || '@prova020.test', 'lista_convite'
from pv;

insert into public.event_people (event_id, participant_id, full_name, email, origem)
values
  ('00000000-0000-4000-9000-0000000000e2', null, 'Sem conta 1', 'sc1@prova020.test', 'lista_convite'),
  ('00000000-0000-4000-9000-0000000000e2', null, 'Sem conta 2', 'sc2@prova020.test', 'lista_convite');

-- Convites: um envio para cada uma das 48 pessoas com conta. As duas sem conta
-- NÃO recebem convite -- é o que as torna walk-in no check-in.
-- A pessoa 1 recebe TRÊS envios: é a prova de "três convites, uma pessoa".
do $$
declare
  p record;
begin
  for p in
    select ep.id, ep.email, ep.full_name
    from public.event_people ep
    where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
      and ep.participant_id is not null
  loop
    perform public.marco_zero_convite_registrar(p.id, 'email', p.email, 'Operação');
  end loop;

  -- Mais dois envios para a MESMA pessoa (reenvio por falta de resposta).
  for p in
    select ep.id from public.event_people ep
    where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
      and ep.email = 'p1@prova020.test'
  loop
    perform public.marco_zero_convite_registrar(p.id, 'whatsapp', '+550000000', 'Operação');
    perform public.marco_zero_convite_registrar(p.id, 'email', 'p1@prova020.test', 'Operação');
  end loop;
end
$$;

-- Check-in das 50 pessoas, pelo host.
do $$
declare
  p record;
begin
  for p in
    select ep.id from public.event_people ep
    where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
  loop
    perform public.marco_zero_checkin_registrar(
      '00000000-0000-4000-9000-0000000000e2', p.id, 'Yuri Fortes', 'host');
  end loop;
end
$$;

-- ===========================================================================
-- 1. Convites: o histórico é por ENVIO, o total é por PESSOA
-- ===========================================================================
select pg_temp.afirmar(1, 'três envios para a mesma pessoa são três linhas em event_invitations', 'service_role',
  (select count(*) = 3 from public.event_invitations i
     join public.event_people ep on ep.id = i.person_id
    where ep.email = 'p1@prova020.test'),
  '3 envios registrados para a pessoa p1',
  format('%s envios (tentativas: %s)',
    (select count(*) from public.event_invitations i join public.event_people ep on ep.id = i.person_id where ep.email = 'p1@prova020.test'),
    (select string_agg(i.tentativa::text || ':' || i.canal, ', ' order by i.tentativa)
       from public.event_invitations i join public.event_people ep on ep.id = i.person_id
      where ep.email = 'p1@prova020.test')));

select pg_temp.afirmar(1, 'enviado_em é do relógio do SERVIDOR mesmo com valor informado', 'service_role',
  (select bool_and(i.enviado_em > now() - interval '5 minutes') from public.event_invitations i),
  'todos os envios com horário recente (atribuído pelo banco)',
  format('mais antigo = %s', (select min(i.enviado_em)::text from public.event_invitations i)));

-- Encerramento do período de convites: a fotografia, com data e versão.
select * from public.marco_zero_convites_encerrar(
  '00000000-0000-4000-9000-0000000000e2', 'Administrador', 'fim do período de convites') \gset snap_

select pg_temp.afirmar(1, 'a fotografia conta PESSOAS, não envios: 48 convidados para 50 envios', 'service_role',
  (select s.total_convidados = 48 from public.event_invite_snapshots s where s.id = :'snap_snapshot_id')
  and (select count(*) = 48 from public.event_invite_snapshot_people sp where sp.snapshot_id = :'snap_snapshot_id')
  and (select count(*) = 50 from public.event_invitations i where i.event_id = '00000000-0000-4000-9000-0000000000e2'),
  'total_convidados = 48, pessoas na fotografia = 48, envios = 50',
  format('total=%s pessoas=%s envios=%s versao=%s',
    (select s.total_convidados from public.event_invite_snapshots s where s.id = :'snap_snapshot_id'),
    (select count(*) from public.event_invite_snapshot_people sp where sp.snapshot_id = :'snap_snapshot_id'),
    (select count(*) from public.event_invitations i where i.event_id = '00000000-0000-4000-9000-0000000000e2'),
    (select s.versao from public.event_invite_snapshots s where s.id = :'snap_snapshot_id')));

-- CONTROLE NEGATIVO: a fotografia não se retoca.
do $$
declare
  r      record;
  v_snap uuid;
begin
  select s.id into v_snap from public.event_invite_snapshots s
  where s.event_id = '00000000-0000-4000-9000-0000000000e2'
  order by s.versao desc limit 1;

  select * into r from pg_temp.tentar('postgres', null,
    format($q$update public.event_invite_snapshots set total_convidados = 999 where id = '%s'$q$, v_snap));

  perform pg_temp.afirmar(1, 'UPDATE na fotografia de convites é recusado (imutável)', 'postgres (dono)',
    r.estado = 'ERRO' and r.cod = '23514',
    'erro 23514 (check_violation) do gatilho de imutabilidade',
    format('estado=%s cod=%s msg=%s', r.estado, coalesce(r.cod, '-'), coalesce(left(r.msg, 90), '-')));

  -- CONTROLE NEGATIVO: encerrar DE NOVO cria a versão 2 em vez de editar a 1.
  select * into r from pg_temp.tentar('postgres', null,
    $q$select * from public.marco_zero_convites_encerrar(
         '00000000-0000-4000-9000-0000000000e2', 'Administrador', 'segunda fotografia')$q$, true);

  perform pg_temp.afirmar(1, 'CONTROLE: encerrar de novo cria a VERSÃO 2, sem tocar na 1', 'postgres (dono)',
    r.estado = 'OK'
    and (select count(*) = 2 from public.event_invite_snapshots s
          where s.event_id = '00000000-0000-4000-9000-0000000000e2')
    and (select s.total_convidados = 48 from public.event_invite_snapshots s
          where s.event_id = '00000000-0000-4000-9000-0000000000e2' and s.versao = 1),
    'OK, 2 fotografias, a versão 1 intacta (48)',
    format('estado=%s fotografias=%s v1_total=%s', r.estado,
      (select count(*) from public.event_invite_snapshots s where s.event_id = '00000000-0000-4000-9000-0000000000e2'),
      (select s.total_convidados from public.event_invite_snapshots s
        where s.event_id = '00000000-0000-4000-9000-0000000000e2' and s.versao = 1)));
end
$$;

-- ===========================================================================
-- 2. O DENOMINADOR: 50 presentes, 45 respondentes válidos, 90%
-- ===========================================================================
-- Antes do encerramento do check-in NÃO existe universo oficial: as contagens
-- saem exatas, o percentual sai NULL com motivo. É a distinção entre
-- "não consegui verificar" e "reprovado".
select pg_temp.afirmar(2, 'check-in ABERTO: contagens exatas, cobertura NULL, motivo checkin_aberto', 'service_role',
  (select c.status = 'indisponivel' and c.motivo = 'checkin_aberto'
          and c.cobertura_percentual is null and c.gate_cobertura is null
          and c.presentes = 50 and c.respondentes_validos = 45
          and c.checkin_fechado = false
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'status=indisponivel motivo=checkin_aberto cobertura=NULL presentes=50 respondentes=45',
  (select format('status=%s motivo=%s cobertura=%s gate_cobertura=%s presentes=%s respondentes=%s fechado=%s',
                 c.status, c.motivo, coalesce(c.cobertura_percentual::text, 'NULL'),
                 coalesce(c.gate_cobertura::text, 'NULL'), c.presentes, c.respondentes_validos, c.checkin_fechado)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

-- Encerramento formal do check-in, pelo administrador.
select * from public.marco_zero_checkin_encerrar(
  '00000000-0000-4000-9000-0000000000e2', 'Administrador') \gset fech_

select pg_temp.afirmar(2, 'O CASO CANÔNICO: 45 de 50 presentes = 90% exatos', 'service_role',
  (select c.status = 'ok' and c.motivo is null
          and c.presentes = 50 and c.respondentes_validos = 45
          and c.presentes_sem_resposta = 5
          and c.cobertura_percentual = 90
          and c.gate_cobertura = true and c.gate_minimo_respostas = true
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'status=ok presentes=50 respondentes=45 sem_resposta=5 cobertura=90 gates=true',
  (select format('status=%s presentes=%s respondentes=%s sem_resposta=%s cobertura=%s gate_cob=%s gate_min=%s convidados=%s avulsos=%s',
                 c.status, c.presentes, c.respondentes_validos, c.presentes_sem_resposta,
                 c.cobertura_percentual, c.gate_cobertura, c.gate_minimo_respostas,
                 coalesce(c.convidados::text, 'NULL'), c.presentes_avulsos)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

select pg_temp.afirmar(2, 'quem compareceu SEM conta e SEM responder está no denominador', 'service_role',
  (select count(*) = 2 from public.event_checkins ck
     join public.event_people ep on ep.id = ck.person_id
    where ck.event_id = '00000000-0000-4000-9000-0000000000e2'
      and ck.estado = 'ativo' and ep.participant_id is null)
  and (select c.presentes = 50 from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  '2 presentes sem participante vinculado, e presentes = 50 (eles contam)',
  format('%s presentes sem participante; presentes totais = %s',
    (select count(*) from public.event_checkins ck join public.event_people ep on ep.id = ck.person_id
      where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'ativo' and ep.participant_id is null),
    (select c.presentes from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c)));

select pg_temp.afirmar(2, 'convidados (48, da fotografia) NÃO é o denominador (50 presentes)', 'service_role',
  (select c.convidados = 48 and c.presentes = 50 and c.motivo_convidados is null
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'convidados=48 e presentes=50, cada um com sua própria origem',
  (select format('convidados=%s (snapshot v%s) presentes=%s motivo_convidados=%s',
                 c.convidados, c.convite_snapshot_versao, c.presentes, coalesce(c.motivo_convidados, 'NULL'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

select pg_temp.afirmar(2, 'os três gates do DNA vêm do banco: 30 respostas, 90% de cobertura, piso 5', 'service_role',
  (select c.minimo_respostas = 30 and c.cobertura_minima_percentual = 90 and c.piso_supressao = 5
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'minimo_respostas=30 cobertura_minima=90 piso=5',
  (select format('minimo=%s cobertura_minima=%s piso=%s', c.minimo_respostas, c.cobertura_minima_percentual, c.piso_supressao)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

-- ===========================================================================
-- 3. "Reprovado" é resultado DIFERENTE de "não consegui verificar"
-- ===========================================================================
savepoint reprovado;

-- Anula 2 presenças de respondentes válidos: 43 de 48 = 89,58% -> REPROVADO,
-- com número. Não é indisponível: o banco sabe calcular e o resultado é não.
do $$
declare
  v_ck uuid;
  i int;
begin
  for i in 1..2 loop
    select ck.id into v_ck
    from public.event_checkins ck
    join public.event_people ep on ep.id = ck.person_id
    join public.participants p on p.id = ep.participant_id
    where ck.event_id = '00000000-0000-4000-9000-0000000000e2'
      and ck.estado = 'ativo' and p.completed_at is not null
    limit 1;
    perform public.marco_zero_checkin_anular(v_ck, 'pessoa não compareceu, lista conferida', 'Administrador');
  end loop;
end
$$;

select pg_temp.afirmar(3, 'cobertura abaixo de 90%: REPROVADO com número, não indisponível', 'service_role',
  (select c.status = 'ok' and c.cobertura_percentual < 90 and c.gate_cobertura = false
          and c.presentes = 48 and c.respondentes_validos = 43
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'status=ok (calculável) com gate_cobertura=false e percentual < 90',
  (select format('status=%s presentes=%s respondentes=%s cobertura=%s gate_cob=%s',
                 c.status, c.presentes, c.respondentes_validos,
                 round(c.cobertura_percentual, 4), c.gate_cobertura)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

select pg_temp.afirmar(3, 'a anulação DEPOIS do encerramento invalidou a aprovação do DNA', 'service_role',
  (select c.aprovacao_invalidada and c.invalidado_em is not null and c.invalidacoes_pendentes >= 2
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c)
  and (select count(*) >= 2 from public.event_dna_invalidations i
        where i.event_id = '00000000-0000-4000-9000-0000000000e2' and i.origem = 'checkin_anulado'),
  'aprovacao_invalidada=true, invalidado_em preenchido, >= 2 disparos de origem checkin_anulado',
  (select format('invalidada=%s invalidado_em=%s pendentes=%s disparos=%s',
                 c.aprovacao_invalidada, coalesce(c.invalidado_em::text, 'NULL'), c.invalidacoes_pendentes,
                 (select string_agg(i.origem, ', ') from public.event_dna_invalidations i
                   where i.event_id = '00000000-0000-4000-9000-0000000000e2'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

select pg_temp.afirmar(3, 'anulação é auditada: o registro fica na tabela, com motivo e autor', 'service_role',
  (select count(*) = 2 from public.event_checkins ck
    where ck.event_id = '00000000-0000-4000-9000-0000000000e2'
      and ck.estado = 'anulado'
      and ck.motivo is not null and ck.corrigido_por is not null and ck.corrigido_em is not null),
  '2 registros anulados, todos com motivo, autor e data',
  (select coalesce(string_agg(format('%s/%s/%s', ck.estado, ck.corrigido_por, left(ck.motivo, 20)), ' | '), '<nenhum>')
     from public.event_checkins ck
    where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'anulado'));

\o
select linha from relatorio where cenario = 3 order by ordem;
\o /dev/null
rollback to savepoint reprovado;

-- CONTROLE NEGATIVO da seção 3: desfeita a anulação, a cobertura volta a 90 e a
-- aprovação volta a não estar invalidada. O verde de cima não era um banco
-- preso em "reprovado".
select pg_temp.afirmar(13, 'CONTROLE: desfeitas as anulações, volta a 90% e sem invalidação', 'service_role',
  (select c.status = 'ok' and c.cobertura_percentual = 90 and c.gate_cobertura
          and not c.aprovacao_invalidada and c.invalidacoes_pendentes = 0
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'cobertura=90 gate=true invalidada=false pendentes=0',
  (select format('cobertura=%s gate=%s invalidada=%s pendentes=%s',
                 c.cobertura_percentual, c.gate_cobertura, c.aprovacao_invalidada, c.invalidacoes_pendentes)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

-- ===========================================================================
-- 4. Um único registro ATIVO por pessoa e evento
-- ===========================================================================
savepoint dois_checkins;

do $$
declare
  v_person uuid;
  v_1 record;
  v_2 record;
  v_direto record;
begin
  select ep.id into v_person from public.event_people ep
  where ep.event_id = '00000000-0000-4000-9000-0000000000e2' and ep.email = 'p1@prova020.test';

  select * into v_1 from public.marco_zero_checkin_registrar(
    '00000000-0000-4000-9000-0000000000e2', v_person, 'Yuri Fortes', 'host') x;
  select * into v_2 from public.marco_zero_checkin_registrar(
    '00000000-0000-4000-9000-0000000000e2', v_person, 'Operação na porta', 'operacao') x;

  perform pg_temp.afirmar(4,
    'segundo check-in da MESMA pessoa devolve o ativo existente (criado=false), sem criar outro',
    'service_role',
    v_1.id = v_2.id and v_2.criado = false
      and (select count(*) = 1 from public.event_checkins ck
            where ck.person_id = v_person and ck.estado = 'ativo'),
    'mesmo id, criado=false, exatamente 1 ativo',
    format('id1=%s id2=%s criado2=%s ativos=%s', v_1.id, v_2.id, v_2.criado,
           (select count(*) from public.event_checkins ck where ck.person_id = v_person and ck.estado = 'ativo')));

  -- Segunda camada: INSERT direto, por fora da função, bate no índice único.
  select * into v_direto from pg_temp.tentar('postgres', null,
    format($q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
              values ('00000000-0000-4000-9000-0000000000e2', '%s', 'Alguém por fora', 'operacao')$q$, v_person));

  perform pg_temp.afirmar(4,
    'INSERT direto de um SEGUNDO ativo é recusado pelo índice único parcial',
    'postgres (dono, por fora da função)',
    v_direto.estado = 'ERRO' and v_direto.cod = '23505',
    'erro 23505 (unique_violation)',
    format('estado=%s cod=%s msg=%s', v_direto.estado, coalesce(v_direto.cod, '-'), coalesce(v_direto.msg, '-')));

  -- CONTROLE NEGATIVO: a MESMA inserção para OUTRA pessoa funciona -- o índice
  -- recusa o segundo ativo, não a inserção.
  select * into v_direto from pg_temp.tentar('postgres', null,
    $q$insert into public.event_checkins (event_id, person_id, confirmado_por_nome, confirmado_por_papel)
       select '00000000-0000-4000-9000-0000000000e2', ep.id, 'Yuri Fortes', 'host'
       from public.event_people ep
       where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
         and not exists (select 1 from public.event_checkins c2 where c2.person_id = ep.id)
       limit 1$q$);

  perform pg_temp.afirmar(4,
    'CONTROLE: a mesma inserção para pessoa SEM ativo funciona',
    'postgres (dono, por fora da função)',
    v_direto.estado = 'OK',
    'OK (a trava é o segundo ativo, não a inserção)',
    format('estado=%s cod=%s msg=%s', v_direto.estado, coalesce(v_direto.cod, '-'), coalesce(v_direto.msg, '-')));
end
$$;

\o
select linha from relatorio where cenario = 4 order by ordem;
\o /dev/null
rollback to savepoint dois_checkins;

-- ===========================================================================
-- 5. Walk-in: compareceu SEM convite anterior
-- ===========================================================================
savepoint walkin;

select pg_temp.afirmar(5, 'as 2 pessoas sem convite ficaram marcadas como avulsas; as convidadas, não', 'service_role',
  (select count(*) = 2 from public.event_checkins ck
    where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'ativo' and ck.avulso)
  and (select count(*) = 48 from public.event_checkins ck
        where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'ativo' and not ck.avulso),
  '2 avulsos (sem convite) e 48 não avulsos (com convite)',
  format('avulsos=%s nao_avulsos=%s',
    (select count(*) from public.event_checkins ck where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'ativo' and ck.avulso),
    (select count(*) from public.event_checkins ck where ck.event_id = '00000000-0000-4000-9000-0000000000e2' and ck.estado = 'ativo' and not ck.avulso)));

-- Entrada avulsa de quem não está nem no cadastro: pessoa nova + presença, numa
-- chamada. Este é o caso que uma coluna em `participants` não suportaria.
do $$
declare
  v record;
begin
  select * into v from public.marco_zero_checkin_avulso(
    '00000000-0000-4000-9000-0000000000e2', 'Chegou na porta sem convite', 'Yuri Fortes', 'host') x;

  perform pg_temp.afirmar(5,
    'walk-in de pessoa NOVA: cadastra, marca avulso e entra no denominador',
    'service_role',
    v.avulso
      and (select ep.origem = 'walk_in' and ep.participant_id is null
             from public.event_people ep where ep.id = v.person_id)
      and (select c.presentes = 51 from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
    'avulso=true, origem=walk_in, participant_id=NULL, presentes=51',
    format('avulso=%s origem=%s participant=%s presentes=%s',
      v.avulso,
      (select ep.origem from public.event_people ep where ep.id = v.person_id),
      coalesce((select ep.participant_id::text from public.event_people ep where ep.id = v.person_id), 'NULL'),
      (select c.presentes from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c)));

  -- CONTROLE NEGATIVO: o walk-in muda o DENOMINADOR e derruba a cobertura
  -- (45 de 51 = 88,2%). Se não mudasse, ele não estaria no denominador -- e o
  -- "avulso=true" seria enfeite.
  perform pg_temp.afirmar(5,
    'CONTROLE: o walk-in derruba a cobertura, porque está no denominador',
    'service_role',
    (select c.respondentes_validos = 45 and c.cobertura_percentual < 90 and c.gate_cobertura = false
       from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
    'respondentes segue 45, cobertura < 90, gate_cobertura=false',
    (select format('presentes=%s respondentes=%s cobertura=%s gate=%s',
                   c.presentes, c.respondentes_validos, round(c.cobertura_percentual, 4), c.gate_cobertura)
       from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));
end
$$;

\o
select linha from relatorio where cenario = 5 order by ordem;
\o /dev/null
rollback to savepoint walkin;

-- ===========================================================================
-- 6. Correção auditada: histórico preservado, não sobrescrita cega
-- ===========================================================================
savepoint correcao;

do $$
declare
  v_person uuid;
  v_antigo uuid;
  v_r record;
  v_upd record;
begin
  select ep.id into v_person from public.event_people ep
  where ep.event_id = '00000000-0000-4000-9000-0000000000e2' and ep.email = 'p2@prova020.test';

  select ck.id into v_antigo from public.event_checkins ck
  where ck.person_id = v_person and ck.estado = 'ativo';

  select * into v_r from public.marco_zero_checkin_corrigir(
    v_antigo, 'papel de quem confirmou estava errado na planilha', 'Administrador', 'admin') x;

  perform pg_temp.afirmar(6,
    'correção preserva o registro anterior (estado corrigido) e cria o novo apontando para ele',
    'service_role',
    (select ck.estado = 'corrigido' and ck.motivo is not null
            and ck.corrigido_por = 'Administrador' and ck.corrigido_em is not null
       from public.event_checkins ck where ck.id = v_antigo)
    and (select ck.estado = 'ativo' and ck.substitui_id = v_antigo
           from public.event_checkins ck where ck.id = v_r.novo_id)
    and (select count(*) = 2 from public.event_checkins ck where ck.person_id = v_person)
    and (select count(*) = 1 from public.event_checkins ck where ck.person_id = v_person and ck.estado = 'ativo'),
    'antigo=corrigido com motivo/autor/data, novo=ativo com substitui_id, 2 linhas no histórico, 1 ativa',
    format('antigo=%s/%s/%s | novo=%s/substitui=%s | linhas=%s ativos=%s',
      (select ck.estado from public.event_checkins ck where ck.id = v_antigo),
      (select ck.corrigido_por from public.event_checkins ck where ck.id = v_antigo),
      (select left(ck.motivo, 24) from public.event_checkins ck where ck.id = v_antigo),
      (select ck.estado from public.event_checkins ck where ck.id = v_r.novo_id),
      (select (ck.substitui_id = v_antigo)::text from public.event_checkins ck where ck.id = v_r.novo_id),
      (select count(*) from public.event_checkins ck where ck.person_id = v_person),
      (select count(*) from public.event_checkins ck where ck.person_id = v_person and ck.estado = 'ativo')));

  perform pg_temp.afirmar(6,
    'CONTROLE: o denominador NÃO muda com a correção (continua 50 presentes)',
    'service_role',
    (select c.presentes = 50 from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
    'presentes = 50 (uma pessoa, um ativo)',
    (select format('presentes=%s', c.presentes) from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

  perform pg_temp.afirmar(6,
    'a correção depois do encerramento invalidou a aprovação do DNA',
    'service_role',
    (select c.aprovacao_invalidada from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c)
    and (select count(*) > 0 from public.event_dna_invalidations i
          where i.event_id = '00000000-0000-4000-9000-0000000000e2' and i.origem = 'checkin_corrigido'),
    'aprovacao_invalidada=true e disparo de origem checkin_corrigido',
    format('invalidada=%s origens=%s',
      (select c.aprovacao_invalidada from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
      (select string_agg(distinct i.origem, ', ') from public.event_dna_invalidations i
        where i.event_id = '00000000-0000-4000-9000-0000000000e2')));

  -- SOBRESCRITA CEGA: recusada pelo gatilho, inclusive para o dono da tabela.
  select * into v_upd from pg_temp.tentar('postgres', null,
    format($q$update public.event_checkins
             set registrado_em = '2000-01-01', confirmado_por_nome = 'outra pessoa'
             where id = '%s'$q$, v_antigo));

  perform pg_temp.afirmar(6,
    'UPDATE que reescreve o FATO registrado (horário, quem confirmou) é recusado',
    'postgres (dono)',
    v_upd.estado = 'ERRO' and v_upd.cod = '23514',
    'erro 23514 do gatilho de imutabilidade',
    format('estado=%s cod=%s msg=%s', v_upd.estado, coalesce(v_upd.cod, '-'), coalesce(left(v_upd.msg, 90), '-')));

  -- CONTROLE NEGATIVO: o UPDATE de AUDITORIA (o que a correção precisa) passa.
  select * into v_upd from pg_temp.tentar('postgres', null,
    format($q$update public.event_checkins set motivo = motivo || ' (revisado)' where id = '%s'$q$, v_antigo));

  perform pg_temp.afirmar(6,
    'CONTROLE: o UPDATE de auditoria (motivo) continua permitido',
    'postgres (dono)',
    v_upd.estado = 'OK' and v_upd.n = 1,
    'OK, 1 linha',
    format('estado=%s n=%s cod=%s', v_upd.estado, coalesce(v_upd.n::text, '-'), coalesce(v_upd.cod, '-')));
end
$$;

\o
select linha from relatorio where cenario = 6 order by ordem;
\o /dev/null
rollback to savepoint correcao;

-- ===========================================================================
-- 7. Horário pelo relógio do servidor, e nunca do cliente
-- ===========================================================================
savepoint relogio;

do $$
declare
  v_person uuid;
  v_id     uuid;
  v_em     timestamptz;
  v_upd    record;
begin
  select ep.id into v_person
  from public.event_people ep
  where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
    and not exists (select 1 from public.event_checkins ck where ck.person_id = ep.id)
  limit 1;

  if v_person is null then
    insert into public.event_people (event_id, full_name, origem)
    values ('00000000-0000-4000-9000-0000000000e2', 'Pessoa para prova de relógio', 'walk_in')
    returning id into v_person;
  end if;

  -- Horário informado NA INSERÇÃO: 2000-01-01. Tem de sair now().
  insert into public.event_checkins
    (event_id, person_id, registrado_em, confirmado_por_nome, confirmado_por_papel)
  values
    ('00000000-0000-4000-9000-0000000000e2', v_person, '2000-01-01 00:00:00+00', 'Yuri Fortes', 'host')
  returning id, registrado_em into v_id, v_em;

  perform pg_temp.afirmar(7,
    'horário informado pelo cliente é DESCARTADO: gravou now(), não 2000-01-01',
    'postgres (dono, por fora da função)',
    v_em > now() - interval '5 minutes',
    'registrado_em recente (relógio do servidor)',
    format('registrado_em=%s', v_em));

  select * into v_upd from pg_temp.tentar('postgres', null,
    format($q$update public.event_checkins set registrado_em = now() + interval '1 day' where id = '%s'$q$, v_id));

  perform pg_temp.afirmar(7,
    'UPDATE de registrado_em é recusado (nem antedatar, nem pós-datar)',
    'postgres (dono)',
    v_upd.estado = 'ERRO' and v_upd.cod = '23514',
    'erro 23514 do gatilho',
    format('estado=%s cod=%s', v_upd.estado, coalesce(v_upd.cod, '-')));
end
$$;

\o
select linha from relatorio where cenario = 7 order by ordem;
\o /dev/null
rollback to savepoint relogio;

-- ===========================================================================
-- 8. Ninguém confirma a própria presença
-- ===========================================================================
savepoint autodeclaracao;

do $$
declare
  v_person   uuid;
  v_uid      uuid;
  v_uid_host uuid;
  v_r        record;
begin
  -- Duas contas de verdade: a da PRÓPRIA pessoa e a do host. O uid do host tem
  -- de existir em auth.users, senão o controle falharia pela chave estrangeira
  -- e não pela regra que se quer medir.
  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'auto@prova020.test', '{}', '{}', now(), now())
  returning id into v_uid;

  insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'host@prova020.test', '{"role":"admin"}', '{}', now(), now())
  returning id into v_uid_host;

  select ep.id into v_person from public.event_people ep
  where ep.event_id = '00000000-0000-4000-9000-0000000000e2' and ep.email = 'p3@prova020.test';

  update public.participants p set user_id = v_uid
  where p.id = (select ep.participant_id from public.event_people ep where ep.id = v_person);

  delete from public.event_checkins ck where ck.person_id = v_person;

  select * into v_r from pg_temp.tentar('postgres', null,
    format($q$insert into public.event_checkins
             (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel)
             values ('00000000-0000-4000-9000-0000000000e2', '%s', '%s', 'Eu mesmo', 'operacao')$q$,
           v_person, v_uid));

  perform pg_temp.afirmar(8,
    'check-in confirmado pelo uid DA PRÓPRIA PESSOA é recusado',
    'postgres (dono, simulando rota distraída)',
    v_r.estado = 'ERRO' and v_r.cod = '23514',
    'erro 23514 do gatilho de autodeclaração',
    format('estado=%s cod=%s msg=%s', v_r.estado, coalesce(v_r.cod, '-'), coalesce(left(v_r.msg, 80), '-')));

  -- CONTROLE NEGATIVO: o MESMO insert com o uid de OUTRA pessoa (o host) passa.
  select * into v_r from pg_temp.tentar('postgres', null,
    format($q$insert into public.event_checkins
             (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel)
             values ('00000000-0000-4000-9000-0000000000e2', '%s', '%s', 'Yuri Fortes', 'host')$q$,
           v_person, v_uid_host));

  perform pg_temp.afirmar(8,
    'CONTROLE: o mesmo check-in confirmado por OUTRO uid passa',
    'postgres (dono)',
    v_r.estado = 'OK' and v_r.n = 1,
    'OK, 1 linha',
    format('estado=%s n=%s cod=%s msg=%s', v_r.estado, coalesce(v_r.n::text, '-'),
           coalesce(v_r.cod, '-'), coalesce(left(v_r.msg, 80), '-')));
end
$$;

\o
select linha from relatorio where cenario = 8 order by ordem;
\o /dev/null
rollback to savepoint autodeclaracao;

-- ===========================================================================
-- 9. Indisponível explícito, nunca palpite
-- ===========================================================================
savepoint indisponivel;

-- 9a. Evento encerrado e SEM presentes: 0/0 não é 0% nem 100%.
insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
values ('00000000-0000-4000-9000-0000000000e3', 'Prova 020 -- sem presentes',
        'PROVA-020-E3', now(), 'live', 1, 2);

select * from public.marco_zero_checkin_encerrar(
  '00000000-0000-4000-9000-0000000000e3', 'Administrador') \gset vazio_

select pg_temp.afirmar(9, 'evento encerrado SEM presentes: indisponivel/sem_presentes e cobertura NULL', 'service_role',
  (select c.status = 'indisponivel' and c.motivo = 'sem_presentes'
          and c.cobertura_percentual is null and c.presentes = 0 and c.gate_cobertura is null
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e3') c),
  'status=indisponivel motivo=sem_presentes cobertura=NULL (não 0, não 100)',
  (select format('status=%s motivo=%s cobertura=%s presentes=%s gate=%s',
                 c.status, c.motivo, coalesce(c.cobertura_percentual::text, 'NULL'), c.presentes,
                 coalesce(c.gate_cobertura::text, 'NULL'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e3') c));

select pg_temp.afirmar(9, 'evento sem fotografia de convites: convidados NULL com motivo próprio', 'service_role',
  (select c.convidados is null and c.motivo_convidados = 'sem_snapshot_de_convites'
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e3') c),
  'convidados=NULL motivo_convidados=sem_snapshot_de_convites',
  (select format('convidados=%s motivo_convidados=%s',
                 coalesce(c.convidados::text, 'NULL'), coalesce(c.motivo_convidados, 'NULL'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e3') c));

-- 9b. Versão de quiz sem etapa alguma: não há definição de "completo".
insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
values ('00000000-0000-4000-9000-0000000000e4', 'Prova 020 -- quiz sem etapas',
        'PROVA-020-E4', now(), 'live', 1, 999);

insert into public.event_people (id, event_id, full_name, origem)
values ('00000000-0000-4000-9000-00000000f901', '00000000-0000-4000-9000-0000000000e4', 'Presente sem quiz', 'walk_in');

select * from public.marco_zero_checkin_registrar(
  '00000000-0000-4000-9000-0000000000e4', '00000000-0000-4000-9000-00000000f901', 'Yuri Fortes', 'host') \gset q999_
select * from public.marco_zero_checkin_encerrar(
  '00000000-0000-4000-9000-0000000000e4', 'Administrador') \gset q999f_

select pg_temp.afirmar(9, 'quiz_version sem etapas: respondentes NULL e cobertura indisponível (não zero)', 'service_role',
  (select c.status = 'indisponivel' and c.motivo = 'quiz_sem_etapas'
          and c.respondentes_validos is null and c.cobertura_percentual is null
          and c.presentes = 1 and c.gate_minimo_respostas is null
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e4') c),
  'status=indisponivel motivo=quiz_sem_etapas respondentes=NULL presentes=1',
  (select format('status=%s motivo=%s respondentes=%s cobertura=%s presentes=%s gate_min=%s',
                 c.status, c.motivo, coalesce(c.respondentes_validos::text, 'NULL'),
                 coalesce(c.cobertura_percentual::text, 'NULL'), c.presentes,
                 coalesce(c.gate_minimo_respostas::text, 'NULL'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e4') c));

do $$
declare r record;
begin
  select * into r from pg_temp.tentar('postgres', null,
    $q$select * from public.marco_zero_respostas_validas('00000000-0000-4000-9000-0000000000e4')$q$);
  perform pg_temp.afirmar(9,
    'marco_zero_respostas_validas LEVANTA em vez de devolver zero quando não há etapas',
    'postgres',
    r.estado = 'ERRO' and r.cod = 'P0002',
    'erro no_data_found (P0002)',
    format('estado=%s cod=%s msg=%s', r.estado, coalesce(r.cod, '-'), coalesce(left(r.msg, 80), '-')));
end
$$;

-- 9c. Evento inexistente: LEVANTA. Não devolve linha de zeros.
do $$
declare r record;
begin
  select * into r from pg_temp.tentar('postgres', null,
    $q$select * from public.marco_zero_cobertura('00000000-0000-4000-9000-00000000dead')$q$);
  perform pg_temp.afirmar(9,
    'evento inexistente LEVANTA (não devolve linha de zeros)',
    'postgres',
    r.estado = 'ERRO' and r.cod = 'P0002',
    'erro no_data_found (P0002)',
    format('estado=%s cod=%s msg=%s', r.estado, coalesce(r.cod, '-'), coalesce(left(r.msg, 80), '-')));
end
$$;

-- 9d. Fotografia inconsistente: o banco desmente o próprio total.
delete from public.event_invite_snapshot_people sp
where sp.snapshot_id = (select s.id from public.event_invite_snapshots s
                        where s.event_id = '00000000-0000-4000-9000-0000000000e2'
                        order by s.versao desc limit 1)
  and sp.person_id = (select sp2.person_id from public.event_invite_snapshot_people sp2
                      where sp2.snapshot_id = (select s.id from public.event_invite_snapshots s
                                               where s.event_id = '00000000-0000-4000-9000-0000000000e2'
                                               order by s.versao desc limit 1)
                      limit 1);

select pg_temp.afirmar(9, 'fotografia inconsistente (total <> pessoas): convidados NULL, não o total gravado', 'service_role',
  (select c.convidados is null and c.motivo_convidados = 'snapshot_inconsistente'
          and c.status = 'ok'
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'convidados=NULL motivo_convidados=snapshot_inconsistente, e a COBERTURA segue ok',
  (select format('convidados=%s motivo_convidados=%s status_cobertura=%s cobertura=%s',
                 coalesce(c.convidados::text, 'NULL'), coalesce(c.motivo_convidados, 'NULL'),
                 c.status, coalesce(c.cobertura_percentual::text, 'NULL'))
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

\o
select linha from relatorio where cenario = 9 order by ordem;
\o /dev/null
rollback to savepoint indisponivel;

-- CONTROLE NEGATIVO da seção 9: desfeitas as sabotagens, tudo volta ao normal.
select pg_temp.afirmar(13, 'CONTROLE: desfeitas as sabotagens, convidados=48 e cobertura=90', 'service_role',
  (select c.convidados = 48 and c.motivo_convidados is null
          and c.status = 'ok' and c.cobertura_percentual = 90
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'convidados=48 motivo_convidados=NULL status=ok cobertura=90',
  (select format('convidados=%s motivo=%s status=%s cobertura=%s',
                 coalesce(c.convidados::text, 'NULL'), coalesce(c.motivo_convidados, 'NULL'),
                 c.status, c.cobertura_percentual)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

-- ===========================================================================
-- 10. Gate de volume: cobertura 100% ainda pode ser REPROVADO por base pequena
-- ===========================================================================
savepoint base_pequena;

insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
values ('00000000-0000-4000-9000-0000000000e5', 'Prova 020 -- sala pequena',
        'PROVA-020-E5', now(), 'live', 5, 2);

do $$
declare
  i int;
  v_pid uuid;
  v_person uuid;
begin
  for i in 1..10 loop
    insert into public.participants (event_id, full_name, email, completed_at)
    values ('00000000-0000-4000-9000-0000000000e5', 'Pequeno ' || i,
            'pq' || i || '@prova020.test', now())
    returning id into v_pid;

    insert into public.quiz_responses (participant_id, stage_id, answers)
    select v_pid, qs.id, '{"q1": "respondido"}'::jsonb
    from public.quiz_stages qs where qs.quiz_version = 2;

    insert into public.event_people (event_id, participant_id, full_name, email, origem)
    values ('00000000-0000-4000-9000-0000000000e5', v_pid, 'Pequeno ' || i,
            'pq' || i || '@prova020.test', 'lista_convite')
    returning id into v_person;

    perform public.marco_zero_checkin_registrar(
      '00000000-0000-4000-9000-0000000000e5', v_person, 'Yuri Fortes', 'host');
  end loop;

  perform public.marco_zero_checkin_encerrar('00000000-0000-4000-9000-0000000000e5', 'Administrador');
end
$$;

select pg_temp.afirmar(10, 'cobertura 100% com 10 respostas: REPROVADO pelo gate de volume, com número', 'service_role',
  (select c.status = 'ok' and c.cobertura_percentual = 100
          and c.gate_cobertura = true and c.gate_minimo_respostas = false
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e5') c),
  'status=ok cobertura=100 gate_cobertura=true gate_minimo_respostas=false',
  (select format('status=%s cobertura=%s gate_cob=%s gate_min=%s respondentes=%s minimo=%s',
                 c.status, c.cobertura_percentual, c.gate_cobertura, c.gate_minimo_respostas,
                 c.respondentes_validos, c.minimo_respostas)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e5') c));

select pg_temp.afirmar(10, 'CONTROLE: no evento de 50, o mesmo gate de volume passa (45 >= 30)', 'service_role',
  (select c.gate_minimo_respostas = true and c.gate_cobertura = true
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'gate_minimo_respostas=true e gate_cobertura=true',
  (select format('gate_min=%s gate_cob=%s respondentes=%s', c.gate_minimo_respostas, c.gate_cobertura, c.respondentes_validos)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

\o
select linha from relatorio where cenario = 10 order by ordem;
\o /dev/null
rollback to savepoint base_pequena;

-- ===========================================================================
-- 11. Reabertura do check-in invalida a aprovação
-- ===========================================================================
savepoint reabertura;

select * from public.marco_zero_checkin_reabrir(
  '00000000-0000-4000-9000-0000000000e2', 'Administrador', 'faltou conferir duas pessoas na lista') \gset reab_

select pg_temp.afirmar(11, 'reabrir o check-in volta a cobertura para indisponivel/checkin_aberto e invalida a aprovação', 'service_role',
  (select c.status = 'indisponivel' and c.motivo = 'checkin_aberto'
          and c.cobertura_percentual is null and c.checkin_fechado = false
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c)
  and (select count(*) > 0 from public.event_dna_invalidations i
        where i.event_id = '00000000-0000-4000-9000-0000000000e2' and i.reconhecido_em is null),
  'status=indisponivel motivo=checkin_aberto cobertura=NULL + invalidação pendente',
  (select format('status=%s motivo=%s cobertura=%s fechado=%s pendentes=%s',
                 c.status, c.motivo, coalesce(c.cobertura_percentual::text, 'NULL'),
                 c.checkin_fechado, c.invalidacoes_pendentes)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

-- CONTROLE NEGATIVO: encerrar de novo produz a versão 2 e a cobertura volta.
select * from public.marco_zero_checkin_encerrar(
  '00000000-0000-4000-9000-0000000000e2', 'Administrador') \gset reenc_

select pg_temp.afirmar(11, 'CONTROLE: novo encerramento é a versão 2 e a cobertura volta a 90', 'service_role',
  (select c.status = 'ok' and c.cobertura_percentual = 90 and c.closure_versao = 2
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c),
  'status=ok cobertura=90 closure_versao=2',
  (select format('status=%s cobertura=%s versao=%s', c.status, c.cobertura_percentual, c.closure_versao)
     from public.marco_zero_cobertura('00000000-0000-4000-9000-0000000000e2') c));

\o
select linha from relatorio where cenario = 11 order by ordem;
\o /dev/null
rollback to savepoint reabertura;

-- ===========================================================================
-- 12. Vínculos que corromperiam o numerador
-- ===========================================================================
do $$
declare r record;
begin
  -- Participante de OUTRO evento não pode ser vinculado a uma pessoa daqui:
  -- seria emprestar um questionário completo para o numerador deste evento.
  -- Massa própria: um participante de OUTRO evento e um participante deste
  -- evento ainda sem pessoa. Sem isto, os dois INSERTs abaixo casariam ZERO
  -- linhas e devolveriam OK -- um verde que não prova nada.
  insert into public.events (id, name, event_code, event_date, status, current_stage, quiz_version)
  values ('00000000-0000-4000-9000-0000000000e6', 'Prova 020 -- outro evento',
          'PROVA-020-E6', now(), 'live', 1, 2)
  on conflict do nothing;

  insert into public.participants (id, event_id, full_name, email)
  values ('00000000-0000-4000-9000-00000000a601', '00000000-0000-4000-9000-0000000000e6',
          'Participante de outro evento', 'outro@prova020.test')
  on conflict do nothing;

  insert into public.participants (id, event_id, full_name, email)
  values ('00000000-0000-4000-9000-00000000a602', '00000000-0000-4000-9000-0000000000e2',
          'Participante sem pessoa', 'sempessoa@prova020.test')
  on conflict do nothing;

  select * into r from pg_temp.tentar('postgres', null,
    $q$insert into public.event_people (event_id, participant_id, full_name, origem)
       values ('00000000-0000-4000-9000-0000000000e2',
               '00000000-0000-4000-9000-00000000a601', 'Vínculo cruzado', 'importacao')$q$);

  perform pg_temp.afirmar(12,
    'vincular participante de OUTRO evento é recusado',
    'postgres (dono)',
    r.estado = 'ERRO' and r.cod = '23503',
    'erro 23503 (foreign_key_violation) do gatilho de validação',
    format('estado=%s cod=%s msg=%s', r.estado, coalesce(r.cod, '-'), coalesce(left(r.msg, 90), '-')));

  -- CONTROLE NEGATIVO: o mesmo vínculo com participante DESTE evento passa.
  select * into r from pg_temp.tentar('postgres', null,
    $q$insert into public.event_people (event_id, participant_id, full_name, origem)
       values ('00000000-0000-4000-9000-0000000000e2',
               '00000000-0000-4000-9000-00000000a602', 'Vínculo legítimo', 'importacao')$q$);

  perform pg_temp.afirmar(12,
    'CONTROLE: vincular participante DO MESMO evento passa',
    'postgres (dono)',
    r.estado = 'OK' and r.n = 1,
    'OK, 1 linha',
    format('estado=%s n=%s cod=%s msg=%s', r.estado, coalesce(r.n::text, '-'),
           coalesce(r.cod, '-'), coalesce(left(r.msg, 90), '-')));

  -- Duas pessoas para o MESMO participante contariam a mesma presença duas vezes.
  select * into r from pg_temp.tentar('postgres', null,
    $q$insert into public.event_people (event_id, participant_id, full_name, origem)
       select ep.event_id, ep.participant_id, 'Pessoa duplicada', 'importacao'
       from public.event_people ep
       where ep.event_id = '00000000-0000-4000-9000-0000000000e2'
         and ep.participant_id is not null
       limit 1$q$);

  perform pg_temp.afirmar(12,
    'duas PESSOAS para o mesmo participante é recusado (contaria a presença duas vezes)',
    'postgres (dono)',
    r.estado = 'ERRO' and r.cod = '23505',
    'erro 23505 (unique_violation)',
    format('estado=%s cod=%s', r.estado, coalesce(r.cod, '-')));

  -- E-mail repetido no mesmo evento, só diferindo a caixa: a mesma pessoa.
  select * into r from pg_temp.tentar('postgres', null,
    $q$insert into public.event_people (event_id, full_name, email, origem)
       values ('00000000-0000-4000-9000-0000000000e2', 'Maiúsculas', 'P1@PROVA020.TEST', 'lista_convite')$q$);

  perform pg_temp.afirmar(12,
    'mesmo e-mail em caixa diferente é a MESMA pessoa (recusado)',
    'postgres (dono)',
    r.estado = 'ERRO' and r.cod = '23505',
    'erro 23505 (unique_violation) pelo índice em lower(email)',
    format('estado=%s cod=%s', r.estado, coalesce(r.cod, '-')));
end
$$;

\o
-- As seções com savepoint já imprimiram o próprio trecho; aqui saem as que
-- sobreviveram (1, 2, 12 e os controles pós-rollback, 13).
select linha from relatorio order by ordem;
rollback;
