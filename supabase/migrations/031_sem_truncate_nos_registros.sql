-- 031: TIRA O TRUNCATE DOS DOIS REGISTROS QUE SO RECEBEM ACRESCIMO.
--
-- A 022 e a 024 tiraram UPDATE e DELETE de `service_role` nestas tabelas, para
-- que o registro so cresca. Esqueceram o TRUNCATE, que apaga a tabela inteira
-- de uma vez e nao passa por politica nem por gatilho de linha. Conferido no
-- banco: `service_role` tinha TRUNCATE nas duas e DELETE em nenhuma.
--
-- Nada mais muda: INSERT e SELECT continuam como estavam.
-- Numero 031 porque a 030 (disjuntor da IA) existe em outro ramo.

begin;

revoke truncate on public.external_import_rejections from service_role, anon, authenticated;
revoke truncate on public.external_submission_events from service_role, anon, authenticated;

commit;
