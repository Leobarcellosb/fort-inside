-- BOLETIM DA COLETA DO MARCO ZERO -- SOMENTE LEITURA.
--
-- Rodar no SQL Editor do Supabase do projeto que serve o Marco Zero, nos
-- quatro momentos combinados (ver docs/aplicar/BOLETIM-DA-COLETA.md):
-- quinta depois do disparo, sexta 12h, sexta 18h, sexta 22h30.
--
-- So SELECT. Nao altera nada, nao cria nada. Nao devolve nome, e-mail,
-- telefone nem conteudo de resposta: so contagens e horarios. Pode colar o
-- resultado do bloco 1 no grupo da equipe.
--
-- Para conferir que e so leitura, rode antes de tudo (vale para a sessao):
--   set default_transaction_read_only = on;
-- Qualquer escrita falharia com "cannot execute ... in a read-only transaction".
--
-- O evento vem do codigo. Os 50 convidados sao o numero informado pela
-- organizacao: referencia, NAO um denominador verificado no banco.

-- 1. O BOLETIM, PRONTO PARA COPIAR. Uma celula de texto.
with ev as (
  select id, event_code, mode, status, quiz_version, form_closes_at
  from public.events where event_code = 'MARCOZERO'
),
exigidas as (
  -- As perguntas obrigatorias do questionario do evento (52 na versao 2).
  select s.id as stage_id, q->>'id' as pergunta
  from public.quiz_stages s
  cross join lateral jsonb_array_elements(s.questions) q
  join ev on ev.quiz_version = s.quiz_version
  where coalesce((q->>'required')::boolean, true)
),
total_exigidas as (select count(*) as n from exigidas),
por_pessoa as (
  -- Quantas perguntas obrigatorias cada pessoa tem respondidas NO BANCO.
  -- Le so se a chave existe e nao esta vazia; o valor nao sai daqui.
  select pa.id, pa.completed_at,
         count(e.pergunta) filter (
           where r.answers ? e.pergunta
             and jsonb_typeof(r.answers -> e.pergunta) <> 'null'
             and coalesce(r.answers ->> e.pergunta, '') <> ''
         ) as respondidas
  from public.participants pa
  join ev on ev.id = pa.event_id
  left join public.quiz_responses r on r.participant_id = pa.id
  left join exigidas e on e.stage_id = r.stage_id
  group by pa.id, pa.completed_at
),
logs as (
  select l.action, l.payload, l.created_at
  from public.event_logs l join ev on ev.id = l.event_id
  where l.action like 'formulario_publico_%'
),
mesa as (
  select s.estado, s.email_coletado
  from public.external_submissions s join ev on ev.id = s.event_id
),
nomes as (
  select lower(regexp_replace(btrim(pa.full_name), '\s+', ' ', 'g')) as nome, count(*) as n
  from public.participants pa join ev on ev.id = pa.event_id
  group by 1 having count(*) > 1
),
m as (
  select
    (select count(*) from por_pessoa)                                              as registrados,
    (select count(*) from por_pessoa where completed_at is not null)               as concluidos,
    (select count(*) from por_pessoa, total_exigidas t
       where completed_at is not null and respondidas = t.n)                       as completos,
    (select count(*) from por_pessoa, total_exigidas t
       where completed_at is not null and respondidas < t.n)                       as concluidos_incompletos,
    (select count(*) from por_pessoa where completed_at is null)                   as sem_conclusao,
    (select n from total_exigidas)                                                 as perguntas,
    (select count(*) from logs where action = 'formulario_publico_recebido'
       and coalesce((payload->>'primeira_resposta')::boolean, false))             as primeiros_envios,
    (select count(*) from logs where action = 'formulario_publico_recebido'
       and coalesce((payload->>'reenvio_identico')::boolean, false))              as reenvios_identicos,
    (select count(*) from mesa where estado = 'conflito')                          as conflitos_aguardando,
    (select count(*) from mesa where estado <> 'conflito')                         as mesa_resolvidas,
    (select count(distinct lower(email_coletado)) from mesa)                       as emails_repetidos,
    (select count(*) from nomes)                                                   as nomes_repetidos,
    (select count(*) from logs where action = 'formulario_publico_envio_nao_gravado') as falhas,
    (select max(created_at) from logs where action = 'formulario_publico_envio_nao_gravado') as ultima_falha,
    (select max(completed_at) from por_pessoa)                                     as ultima_conclusao,
    (select max(created_at) from logs where action = 'formulario_publico_recebido') as ultimo_recebido
)
select concat_ws(E'\n',
  'MARCO ZERO: COLETA PRÉ-EVENTO',
  'Leitura de ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') || ' (horário de São Paulo)',
  'Evento ' || ev.event_code || ', id ' || ev.id,
  '',
  'Convidados informados pela organização: 50 (referência, não verificado no banco)',
  'Cadastros de participantes registrados: ' || m.registrados,
  'Cadastros com ' || m.perguntas || '/' || m.perguntas || ' respostas obrigatórias presentes e não vazias: ' || m.completos,
  'Concluídos sem as ' || m.perguntas || ' respostas obrigatórias: ' || m.concluidos_incompletos || case when m.concluidos_incompletos > 0 then '  << ATENÇÃO' else '' end,
  'Registrados sem conclusão: ' || m.sem_conclusao,
  'Reenvios idênticos (já estavam gravados): ' || m.reenvios_identicos,
  '',
  'Conflitos de identidade aguardando a equipe: ' || m.conflitos_aguardando || case when m.conflitos_aguardando > 0 then '  << resolver antes de segunda' else '' end,
  'Segundas respostas já decididas: ' || m.mesa_resolvidas,
  'E-mails que enviaram mais de uma vez: ' || m.emails_repetidos,
  'Nomes iguais em cadastros diferentes: ' || m.nomes_repetidos || case when m.nomes_repetidos > 0 then '  << conferir com a lista' else '' end,
  '',
  'Erros de gravação registrados no banco: ' || m.falhas
    || coalesce(' (último às ' || to_char(m.ultima_falha at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ')', '')
    || case when m.falhas = 0 then ' (zero registrado não prova ausência de falha: conferir o log da Vercel)' else '' end,
  'Último questionário recebido: '
    || coalesce(to_char(greatest(m.ultima_conclusao, m.ultimo_recebido) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nenhum ainda'),
  '',
  'Prazo cadastrado: '
    || coalesce(to_char(ev.form_closes_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' em São Paulo', 'NÃO CADASTRADO  << ATENÇÃO')
    || case when ev.form_closes_at = timestamptz '2026-10-24 02:59:00+00' then ' (confere com sexta 23h59)'
            when ev.form_closes_at is null then ''
            else '  << DIFERENTE DE SEXTA 23h59' end,
  'Estado cadastral do formulário: ' || case when ev.status = 'completed' then 'evento concluído (o formulário recusa envios)'
                         when ev.form_closes_at is not null and now() >= ev.form_closes_at then 'prazo cadastrado já passou'
                         else 'dentro do prazo cadastrado' end,
  'Prazo cadastrado e prazo aplicado pelo servidor são verificações distintas: este boletim só confere o cadastrado.'
) as boletim
from m, ev;

-- 2. RECEBIMENTO VERDADEIRO, POR HORA (Sao Paulo). Mostra o ritmo e um buraco
--    de horas sem nada recebido. So contagens.
select date_trunc('hour', pa.completed_at at time zone 'America/Sao_Paulo') as hora_sao_paulo,
       count(*) as concluidos_na_hora
from public.participants pa
join public.events e on e.id = pa.event_id
where e.event_code = 'MARCOZERO' and pa.completed_at is not null
group by 1 order by 1;

-- 3. FALHAS DE GRAVACAO, POR FASE. Sem conteudo: so a fase em que parou e o
--    codigo do banco. Se o banco inteiro caiu, nem este registro entra: nesse
--    caso o sinal e o log da Vercel (respostas 503 em /api/formulario-publico).
select l.payload->>'fase'           as fase,
       l.payload->>'codigo_do_banco' as codigo_do_banco,
       count(*)                      as vezes,
       max(l.created_at at time zone 'America/Sao_Paulo') as ultima_em_sao_paulo
from public.event_logs l
join public.events e on e.id = l.event_id
where e.event_code = 'MARCOZERO' and l.action = 'formulario_publico_envio_nao_gravado'
group by 1, 2 order by 3 desc;

-- 4. MESA DE DECISAO: segundas respostas por estado. 'conflito' e o que espera
--    a equipe; os outros ja foram decididos.
select s.estado, count(*) as submissoes
from public.external_submissions s
join public.events e on e.id = s.event_id
where e.event_code = 'MARCOZERO'
group by 1 order by 1;

-- 5. PRAZO, em UTC e em Sao Paulo. Deve ser 2026-10-24 02:59:00+00
--    (= sexta 23/10, 23h59 em Sao Paulo).
select event_code, status, mode,
       form_closes_at                                        as fecha_em_utc,
       form_closes_at at time zone 'America/Sao_Paulo'       as fecha_em_sao_paulo,
       form_closes_at = timestamptz '2026-10-24 02:59:00+00' as confere_com_sexta_23h59
from public.events where event_code = 'MARCOZERO';

-- 6. ISOLAMENTO: as tabelas com dado pessoal estao com RLS ligada, e quais
--    politicas existem. Isto prova a CONFIGURACAO, nao o acesso: a prova
--    negativa hospedada (um visitante tentando ler e recebendo nada) continua
--    PENDENTE ate ser feita, e o boletim deve dizer isso.
select c.relname as tabela,
       c.relrowsecurity as rls_ligada,
       (select count(*) from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as politicas,
       (select string_agg(p.policyname || ' (' || p.cmd || ')', '; ' order by p.policyname)
          from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as quais_politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('participants', 'quiz_responses', 'external_submissions', 'event_logs', 'prognostics')
order by 1;
