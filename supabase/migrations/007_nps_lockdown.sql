-- 007_nps_lockdown.sql
-- Fecha a escrita anônima direta em nps_responses.
--
-- CONTEXTO: a policy "Anyone can submit NPS" (INSERT para anon) foi criada
-- direto no dashboard. Como a anon key é pública (vai no bundle do browser),
-- ela permite POST direto no PostgREST — contornando por completo o rate limit
-- por IP de /api/nps. O formulário público NÃO depende dela: a rota grava com
-- o service_role, que ignora RLS.
--
-- "Only admin can read NPS" (SELECT) é redundante com nps_responses_admin
-- (FOR ALL), que já cobre leitura e escrita para admin.

drop policy if exists "Anyone can submit NPS" on nps_responses;
drop policy if exists "Only admin can read NPS" on nps_responses;

-- Estado final: uma única policy, nps_responses_admin (FOR ALL, is_admin()).
-- Escrita pública continua funcionando via /api/nps (service_role).
