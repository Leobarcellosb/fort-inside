-- 014_participants_colunas_travadas.sql
-- Fecha um desvio de etapa explorável pela API normal, achado pela suíte de
-- regressão de RLS e confirmado de ponta a ponta no ambiente descartável.
--
-- NÃO APLICAR sem autorização nominal. Fica escrita e validada, como a 011.
--
-- ---------------------------------------------------------------
-- A cadeia, exatamente como foi reproduzida
-- ---------------------------------------------------------------
-- 1. Participante de um evento na etapa 1 tenta gravar resposta da etapa 6:
--    NEGADO pela RLS de quiz_responses. A trava de etapa funciona.
-- 2. O mesmo participante troca o PRÓPRIO event_id para um evento que está na
--    etapa 6: PERMITIDO.
-- 3. Repete a mesma gravação da etapa 6: PERMITIDO.
-- 4. Marca o próprio completed_at: PERMITIDO.
--
-- Causa: `participants_own_update` só tem USING, sem WITH CHECK. Sem WITH
-- CHECK, o Postgres aplica a expressão do USING também à linha nova -- e essa
-- expressão só amarra `user_id = auth.uid()`. Todo o resto da linha, inclusive
-- `event_id` e `completed_at`, fica livre.
--
-- Consequências, em ordem de gravidade:
--   - A trava de etapa deixa de valer: basta apontar para um evento adiantado
--     para liberar todas as etapas antes da condução do host.
--   - O participante se insere em evento alheio, inclusive `draft`.
--   - Marcando o próprio `completed_at` ele entra na fila de geração de IA sem
--     ter completado o questionário -- custo de modelo gasto e um documento
--     gerado sobre dados incompletos, que é justamente o que o contrato novo de
--     scoring existe para evitar.
--
-- ---------------------------------------------------------------
-- Por que privilégio de coluna, e não WITH CHECK
-- ---------------------------------------------------------------
-- A correção óbvia seria um WITH CHECK que exigisse `event_id` inalterado. Não
-- dá: dentro de uma policy, USING enxerga a linha antiga e WITH CHECK enxerga a
-- nova, e não existe forma de comparar as duas na mesma expressão. Para isso
-- seria preciso uma trigger BEFORE UPDATE.
--
-- Privilégio de coluna resolve sem trigger e é mais forte, porque atua antes da
-- RLS: o participante simplesmente perde o direito de escrever nessas colunas,
-- e nenhuma policy futura reabre isso por descuido. Ele mantém UPDATE nas
-- colunas que são dele de fato.
--
-- `service_role` não é afetado: o revoke abaixo é só para anon e authenticated.
-- É por service_role que as rotas administrativas e o avanço de etapa passam.

-- ORDEM IMPORTA, e errar aqui produz um falso conserto silencioso.
-- Privilégio de coluna NÃO subtrai de privilégio de tabela: enquanto existir
-- `UPDATE` no nível da tabela, ele cobre todas as colunas e qualquer
-- `revoke update (coluna)` é ignorado na prática. O Supabase concede UPDATE de
-- tabela para anon e authenticated por padrão, então é preciso revogar a tabela
-- primeiro e só depois conceder as colunas permitidas.
--
-- Medido: com o revoke só de colunas, o participante continuava trocando o
-- próprio event_id (UPDATE 1). Com a ordem abaixo, para de conseguir.
revoke update on participants from authenticated;
revoke update on participants from anon;

-- O participante continua podendo corrigir os próprios dados de cadastro.
-- anon não recebe nada: participante sem sessão não edita ninguém.
grant update (full_name, phone, course_or_moment)
  on participants to authenticated;

-- Segunda camada: WITH CHECK explícito na policy. Ele não consegue amarrar
-- `event_id` (ver acima), mas deixa de depender do fallback implícito do
-- USING -- que é o detalhe que escondeu o problema até agora. Quem ler a policy
-- passa a ver a regra da linha nova escrita, em vez de ter que lembrar que o
-- Postgres reaproveita o USING quando o WITH CHECK falta.
drop policy if exists "participants_own_update" on participants;
create policy "participants_own_update" on participants
  for update
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());
