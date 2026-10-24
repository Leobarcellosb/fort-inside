-- CONFERENCIA DAS RESPOSTAS ANTES DE GERAR (so leitura).
--
-- Por que existe: o formulario confere que as 52 respostas existem e tem o tipo
-- certo, mas nao a faixa (Likert 1 a 5, elementos 0 a 10, situacional A a D).
-- Na segunda, a geracao normaliza as respostas com regras estritas
-- (lib/scoring/achatar-respostas.ts) e PARA na pessoa que tiver um valor fora
-- dessas regras. Esta consulta acha essas pessoas antes, com as mesmas regras.
--
-- Os ids das perguntas foram tirados de lib/scoring/marco-zero.ts.
--
-- Como usar: cole no editor SQL do Supabase e rode. Nao grava nada. A saida
-- traz o id do participante, a etapa, a pergunta e o motivo, nunca o nome nem o
-- valor respondido.
--
-- Esperado: zero linhas no bloco 2. Uma linha la = um documento que vai falhar
-- na segunda, a menos que a resposta seja corrigida antes.

-- Troque o codigo se o evento for outro.
with evento as (
  select id from public.events where event_code = 'MARCOZERO'
),
linhas as (
  select r.participant_id, r.stage_id, r.answers
  from public.quiz_responses r
  join public.participants p on p.id = r.participant_id
  where p.event_id = (select id from evento) and p.completed_at is not null
),
problemas_da_linha as (
  -- A mesma etapa gravada duas vezes para a mesma pessoa.
  select participant_id, stage_id, null::text as pergunta, 'etapa repetida' as motivo
  from linhas group by participant_id, stage_id having count(*) > 1
  union all
  -- O conjunto de respostas da etapa nao e um objeto.
  select participant_id, stage_id, null, 'respostas da etapa nao sao um objeto'
  from linhas where jsonb_typeof(answers) is distinct from 'object'
),
itens as (
  select l.participant_id, l.stage_id, kv.key as pergunta, kv.value as valor
  from linhas l, jsonb_each(case when jsonb_typeof(l.answers) = 'object' then l.answers else '{}'::jsonb end) kv
),
problemas_dos_itens as (
  -- A mesma pergunta respondida em duas etapas.
  select participant_id, min(stage_id) as stage_id, pergunta, 'pergunta em mais de uma etapa' as motivo
  from itens group by participant_id, pergunta having count(*) > 1
  union all
  select participant_id, stage_id, pergunta,
    case
      when pergunta in ('q16','q17','q18','q19','q20','q21','q22','q23','q24','q25','q26','q27',
                        'q28','q29','q30','q31','q32','q33','q34','q35','q36','q37','q38','q39')
        then 'Likert fora de 1 a 5'
      when pergunta in ('q7','q8','q9','q10','q11','q12','q13')
        then 'elemento fora de 0 a 10'
      when pergunta in ('q40','q41','q42','q43','q44','q45')
        then 'situacional sem alternativa A a D'
      else 'tipo de valor nao suportado'
    end
  from itens
  where case
    when pergunta in ('q16','q17','q18','q19','q20','q21','q22','q23','q24','q25','q26','q27',
                      'q28','q29','q30','q31','q32','q33','q34','q35','q36','q37','q38','q39')
      then not (
        (jsonb_typeof(valor) = 'number' and (valor #>> '{}') ~ '^-?\d+$' and (valor #>> '{}')::numeric between 1 and 5)
        or (jsonb_typeof(valor) = 'string' and (valor #>> '{}') ~ '^\s*-?\d+\s*$' and btrim(valor #>> '{}')::numeric between 1 and 5))
    when pergunta in ('q7','q8','q9','q10','q11','q12','q13')
      then not (
        (jsonb_typeof(valor) = 'number' and (valor #>> '{}') ~ '^-?\d+$' and (valor #>> '{}')::numeric between 0 and 10)
        or (jsonb_typeof(valor) = 'string' and (valor #>> '{}') ~ '^\s*-?\d+\s*$' and btrim(valor #>> '{}')::numeric between 0 and 10))
    when pergunta in ('q40','q41','q42','q43','q44','q45')
      then not (
        jsonb_typeof(valor) = 'string'
        and (btrim(valor #>> '{}') ~ '^[A-Da-d]$' or btrim(valor #>> '{}') ~ '^[A-D]\.\s+\S'))
    else not (
      jsonb_typeof(valor) in ('string', 'number')
      or (jsonb_typeof(valor) = 'array'
          and not exists (select 1 from jsonb_array_elements(valor) e where jsonb_typeof(e) <> 'string')))
  end
),
todos as (
  select * from problemas_da_linha
  union all
  select * from problemas_dos_itens
)
-- BLOCO 1: o resumo.
select 'resumo' as bloco,
       (select count(distinct participant_id) from linhas) as pessoas_conferidas,
       (select count(distinct participant_id) from todos) as pessoas_com_problema,
       (select count(*) from todos) as problemas,
       null::uuid as participant_id, null::int as etapa, null::text as pergunta, null::text as motivo
union all
-- BLOCO 2: cada problema.
select 'problema', null, null, null, participant_id, stage_id, pergunta, motivo
from todos
order by bloco desc, participant_id, etapa, pergunta;
