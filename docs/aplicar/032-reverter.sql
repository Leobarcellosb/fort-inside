-- 032-reverter.sql
-- REVERSAO da migration 032_prazo_rigido_v2.sql.
--
-- Apaga as tres policies restritivas que a 032 criou. As policies permissivas da
-- 010 nunca foram alteradas pela 032, entao depois disto o banco volta a ter
-- exatamente o comportamento anterior: tolerancia de envio ate
-- form_closes_at + 15min para quem abriu a etapa com login.
--
-- So DDL de policy. Nao toca em dado. Idempotente.
-- NAO RODAR sem autorizacao nominal (ver docs/PRAZO-RIGIDO-032.md).

begin;

drop policy if exists "quiz_responses_prazo_rigido_insert" on public.quiz_responses;
drop policy if exists "quiz_responses_prazo_rigido_update" on public.quiz_responses;
drop policy if exists "participants_prazo_rigido_insert" on public.participants;

commit;
