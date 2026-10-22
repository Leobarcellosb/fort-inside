-- PREFLIGHT DE DOMINGO, 25/10 -- SOMENTE LEITURA.
--
-- Rodar no SQL Editor do Supabase do projeto que serve o Marco Zero, ANTES de
-- aplicar qualquer migration. Nao altera nada: so SELECT. Copie o resultado de
-- cada bloco e mande para a equipe tecnica.
--
-- Responde o que o CTO exigiu na Rodada 70 antes da janela das migrations:
--   1. o estado exato do banco (que objetos de cada migration ja existem,
--      conferidos pelo schema, nao pela numeracao);
--   2. o prazo do formulario do MARCOZERO (form_closes_at), que decide a trava
--      de prazo do formulario e o botao Processar de segunda;
--   3. quantos documentos e PDFs ja existem, para nao presumir.
--
-- Tambem serve HOJE: o bloco 1 sozinho responde se o prazo esta cadastrado.

-- 1. O EVENTO. form_closes_at e o PRIMEIRO instante em que o formulario recusa.
--    Recomendado: 2026-10-24 03:00:00+00 (meia-noite em Sao Paulo: "aberto ate
--    sexta, 23h59" com o minuto 23h59 inteiro). 02:59:00+00 fecha no inicio do
--    minuto 23h59. Se vier nulo ou fora dessas duas, NAO publicar a trava
--    de prazo antes de corrigir.
select event_code, name, status, mode, quiz_version,
       form_opens_at, form_closes_at,
       form_closes_at at time zone 'America/Sao_Paulo' as fecha_em_sao_paulo,
       now() at time zone 'America/Sao_Paulo'          as agora_em_sao_paulo
from public.events
where event_code = 'MARCOZERO';

-- 2. QUE MIGRATIONS JA ESTAO NO BANCO, pelo objeto que cada uma cria.
select m.migration, m.objeto,
       case m.tipo
         when 'tabela' then to_regclass('public.' || m.objeto) is not null
         when 'coluna' then exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = split_part(m.objeto, '.', 1)
             and column_name = split_part(m.objeto, '.', 2))
         when 'funcao' then exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = m.objeto)
       end as existe
from (values
  ('018', 'tabela', 'jobs'),
  ('019', 'funcao', 'jobs_registrar_tick_ok'),
  ('020', 'tabela', 'event_checkins'),
  ('021', 'tabela', 'jobs_consumo_externo'),
  ('022', 'tabela', 'external_submissions'),
  ('023', 'funcao', 'jobs_iniciar_assincrono'),
  ('024', 'tabela', 'external_import_rejections'),
  ('025', 'coluna', 'prognostics.conteudo_aprovado_hash'),
  ('026', 'tabela', 'prognostic_delivery_history'),
  ('027', 'coluna', 'prognostics.suspensao_motivo'),
  ('028', 'funcao', 'events_valida_liberacao_de_etapa'),
  ('029', 'tabela', 'external_identity_resolutions')
) as m(migration, tipo, objeto)
order by m.migration;

-- 3. O REGISTRO DE MIGRATIONS, se existir. Ele NAO e confiavel neste projeto
--    (no ambiente local ja disse 018 com objetos da 025 aplicados); vale o bloco 2.
select to_regclass('supabase_migrations.schema_migrations') is not null as registro_existe;
-- Se existir, rode tambem:
-- select version, name from supabase_migrations.schema_migrations order by version;

-- 4. O QUE JA EXISTE DO EVENTO: participantes, respostas, documentos e PDFs.
select
  (select count(*) from public.participants pa
     join public.events e on e.id = pa.event_id where e.event_code = 'MARCOZERO') as participantes,
  (select count(*) from public.participants pa
     join public.events e on e.id = pa.event_id
     where e.event_code = 'MARCOZERO' and pa.completed_at is not null)           as concluiram,
  (select count(*) from public.prognostics p
     join public.participants pa on pa.id = p.participant_id
     join public.events e on e.id = pa.event_id where e.event_code = 'MARCOZERO') as documentos,
  (select count(*) from public.prognostics p
     join public.participants pa on pa.id = p.participant_id
     join public.events e on e.id = pa.event_id
     where e.event_code = 'MARCOZERO' and p.pdf_url is not null)                  as com_pdf_gravado;

-- 5. SEGUNDAS RESPOSTAS EM CONFLITO esperando a equipe (022).
select count(*) as segundas_respostas_em_conflito
from public.external_submissions s
join public.events e on e.id = s.event_id
where e.event_code = 'MARCOZERO' and s.estado = 'conflito';
