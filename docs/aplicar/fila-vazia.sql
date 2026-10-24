-- ANTES E DEPOIS DE OLHAR O PREVIEW (so leitura, CTO Rodada 88).
--
-- O preview usa o banco de producao. Abrir o painel so e passivo enquanto a fila
-- estiver vazia e nenhum evento estiver gerando documentos. Rode isto no editor
-- SQL do Supabase ANTES de abrir o preview e DE NOVO depois de fechar todas as
-- abas dele. Nao grava nada e nao mostra dado pessoal.
--
-- Antes: nenhum job "pending" nem "running" (hoje a tabela esta vazia) e
-- nenhum evento "processing". Se aparecer qualquer um dos
-- dois, NAO abra o preview: veja por capturas.
-- Depois: as mesmas contagens de antes, e nada novo em "mudou na ultima hora"
-- que voce nao tenha feito pelo app publicado.

select 'jobs' as o_que, status as estado, count(*) as quantos
from public.jobs group by status
union all
select 'eventos', status, count(*)
from public.events group by status
union all
select 'mudou na ultima hora: documentos gerados', null, count(*)
from public.prognostics where generated_at > now() - interval '1 hour'
union all
select 'mudou na ultima hora: documentos aprovados', null, count(*)
from public.prognostics where reviewed_at > now() - interval '1 hour'
union all
select 'mudou na ultima hora: links liberados', null, count(*)
from public.prognostics where delivered_at > now() - interval '1 hour'
union all
select 'mudou na ultima hora: tirados do ar', null, count(*)
from public.prognostics where suspenso_em > now() - interval '1 hour'
union all
select 'mudou na ultima hora: registros de atividade', null, count(*)
from public.event_logs where created_at > now() - interval '1 hour'
order by 1, 2;
