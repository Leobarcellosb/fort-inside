-- QUEM VAI SER GERADO: FOTOGRAFIA DE ELEGIBILIDADE (so leitura, CTO Rodada 89).
--
-- Rode no editor SQL do Supabase DEPOIS de decidir os 3 cadastros de teste e
-- ANTES de Gerar. Nao grava nada. Mostra so identificadores e marcas, nunca nome,
-- e-mail ou resposta.
--
-- Por que existe: a geracao processa quem tem `completed_at` preenchido. Ha tres
-- caminhos que podem produzir um "concluido" que nao veio do formulario publico
-- dentro do prazo:
--   1. Uma sessao com login pode criar um cadastro em qualquer evento ja com
--      `completed_at` (achado A1; nenhuma tela faz isso, mas a permissao existe).
--   2. /api/complete-quiz marca conclusao sem olhar o prazo (achado A2). So vale
--      para cadastro com login (`user_id` preenchido); quem respondeu pelo
--      formulario publico nao tem login.
--   3. Respostas com origem diferente do formulario (importacao, regularizacao).
--
-- Esperado no Marco Zero: todo concluido sem login, entrou e concluiu antes do
-- prazo, 5 etapas respondidas, nenhuma resposta depois do prazo. Cada marca
-- "sim" em uma coluna de alerta e um cadastro a explicar ANTES de Gerar. Nao
-- corrija, nao apague e nao exclua da geracao em silencio: mande a saida.
--
-- Limite: o banco nao guarda historico de cada alteracao. Esta consulta ve o
-- estado de agora e os horarios gravados; ela nao prova quem respondeu nem que
-- uma resposta valida nao foi trocada por outra resposta valida.

with evento as (
  select id, quiz_version, form_closes_at from public.events where event_code = 'MARCOZERO'
),
esperadas as (
  select count(*) as n from public.quiz_stages where quiz_version = (select quiz_version from evento)
),
concluidos as (
  select p.id, p.user_id, p.joined_at, p.completed_at
  from public.participants p
  where p.event_id = (select id from evento) and p.completed_at is not null
),
respostas as (
  select r.participant_id,
         count(distinct r.stage_id) as etapas,
         max(r.submitted_at) as ultima_resposta,
         string_agg(distinct coalesce(r.origem, 'sem origem'), ', ') as origens
  from public.quiz_responses r
  where r.participant_id in (select id from concluidos)
  group by r.participant_id
),
linhas as (
  select c.id as participant_id,
         c.user_id is not null as tem_login,
         c.joined_at >= e.form_closes_at as entrou_depois_do_prazo,
         c.completed_at >= e.form_closes_at as concluiu_depois_do_prazo,
         coalesce(r.etapas, 0) as etapas_respondidas,
         (select n from esperadas) as etapas_esperadas,
         r.ultima_resposta >= e.form_closes_at as resposta_depois_do_prazo,
         coalesce(r.origens, 'nenhuma resposta') as origens
  from concluidos c
  cross join evento e
  left join respostas r on r.participant_id = c.id
)
select 'resumo' as bloco,
       count(*) as concluidos,
       count(*) filter (where tem_login) as com_login,
       count(*) filter (where entrou_depois_do_prazo) as entraram_depois,
       count(*) filter (where concluiu_depois_do_prazo) as concluiram_depois,
       count(*) filter (where etapas_respondidas <> etapas_esperadas) as etapas_incompletas,
       count(*) filter (where resposta_depois_do_prazo) as respostas_depois,
       null::uuid as participant_id, null::text as origens
from linhas
union all
select 'cadastro', null, null, null, null, null, null, participant_id,
       concat_ws(' | ',
         origens,
         case when tem_login then 'ALERTA com login' end,
         case when entrou_depois_do_prazo then 'ALERTA entrou depois do prazo' end,
         case when concluiu_depois_do_prazo then 'ALERTA concluiu depois do prazo' end,
         case when etapas_respondidas <> etapas_esperadas
              then 'ALERTA ' || etapas_respondidas || ' de ' || etapas_esperadas || ' etapas' end,
         case when resposta_depois_do_prazo then 'ALERTA resposta depois do prazo' end)
from linhas
order by bloco desc, origens desc nulls last, participant_id;
