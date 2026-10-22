-- extrair-cobertura.sql -- LE o alvo descartavel e imprime UM json com tudo o
-- que o comparador precisa. Somente leitura.
--
-- Para cada pessoa do evento do ensaio:
--   banco.*            o veredito de public.marco_zero_respostas_validas
--   respostas_da_versao  as linhas de quiz_responses das etapas da versao
--                        VIGENTE do evento -- o filtro que lib/ai/contexto-quiz.ts
--                        aplica em producao ("nada de outra versao entra no
--                        prompt, mesmo que exista linha solta no banco")
--   respostas_todas      TODAS as linhas de quiz_responses da pessoa, sem filtro
--                        de versao -- serve para medir o que um adaptador que
--                        ESQUECESSE o filtro produziria
-- E a linha inteira de public.marco_zero_cobertura, que e o veredito agregado
-- oficial.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

with evento as (
  select e.id, e.quiz_version
  from public.events e
  where e.event_code = 'ENSAIO-COBERTURA'
),
etapas as (
  select qs.id
  from public.quiz_stages qs, evento ev
  where qs.quiz_version = ev.quiz_version
),
pessoas as (
  select
    ep.id as person_id,
    ep.participant_id,
    split_part(ep.full_name, ' ', 1) as codigo,
    substr(ep.full_name, strpos(ep.full_name, ' ') + 1) as cenario,
    exists (
      select 1 from public.event_checkins ck
      where ck.person_id = ep.id and ck.estado = 'ativo'
    ) as presente,
    p.completed_at
  from public.event_people ep
  join evento ev on ev.id = ep.event_id
  left join public.participants p on p.id = ep.participant_id
),
veredito as (
  select v.* from evento ev, public.marco_zero_respostas_validas(ev.id) v
)
select jsonb_pretty(jsonb_build_object(
  'evento', (select jsonb_build_object('quiz_version', ev.quiz_version) from evento ev),
  'etapas_da_versao', (select jsonb_agg(id order by id) from etapas),
  'cobertura', (
    select to_jsonb(c) from evento ev, public.marco_zero_cobertura(ev.id) c
  ),
  'participantes', (
    select jsonb_agg(
      jsonb_build_object(
        'codigo', ps.codigo,
        'cenario', ps.cenario,
        'presente', ps.presente,
        'banco', jsonb_build_object(
          'etapas_exigidas',    vd.etapas_exigidas,
          'etapas_respondidas', vd.etapas_respondidas,
          'completo',           vd.completo,
          'valido',             vd.valido,
          'tem_completed_at',   ps.completed_at is not null
        ),
        'respostas_da_versao', coalesce((
          select jsonb_agg(jsonb_build_object('stage_id', qr.stage_id, 'answers', qr.answers) order by qr.stage_id)
          from public.quiz_responses qr
          where qr.participant_id = ps.participant_id
            and qr.stage_id in (select id from etapas)
        ), '[]'::jsonb),
        'respostas_todas', coalesce((
          select jsonb_agg(jsonb_build_object('stage_id', qr.stage_id, 'answers', qr.answers) order by qr.stage_id)
          from public.quiz_responses qr
          where qr.participant_id = ps.participant_id
        ), '[]'::jsonb)
      )
      order by ps.codigo
    )
    from pessoas ps
    left join veredito vd on vd.person_id = ps.person_id
  )
));
