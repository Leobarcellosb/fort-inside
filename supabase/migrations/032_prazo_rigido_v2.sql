-- 032_prazo_rigido_v2.sql
-- PRAZO RIGIDO no banco para o formulario assincrono da versao 2 (Marco Zero).
--
-- NAO APLICAR sem autorizacao nominal. Trabalho POS-SEGUNDA, fora do pacote de
-- 24/10 (docs/aplicar/MANIFESTO-DO-PACOTE.md). Validada so contra Postgres
-- DESCARTAVEL (supabase/provas/prazo-032.test.ts). Plano de implantacao e de
-- reversao: docs/PRAZO-RIGIDO-032.md. Numero 032 porque a 030 esta reservada ao
-- ramo disjuntor-030 e a 031 ja existe.
--
-- ---------------------------------------------------------------
-- O problema (MANIFESTO-DO-PACOTE.md, "Excecoes conhecidas", item 1)
-- ---------------------------------------------------------------
-- A 010 deu ao fluxo COM LOGIN uma tolerancia de envio: no modo async, quem
-- abriu a etapa ate T-15min (T = events.form_closes_at) grava resposta ate
-- T+15min (`now() <= form_closes_at + interval '15 minutes'` nas policies
-- quiz_responses_own_insert e quiz_responses_own_update). Nenhuma migration
-- posterior (011..031) mexeu nessas policies: elas sao as vigentes.
--
-- O formulario publico (sem login) ja recusa a partir de T, pelo relogio do
-- servidor (`agora >= form_closes_at`, receber-formulario.ts). Ou seja: para o
-- MESMO evento v2, o caminho publico fecha em T e o caminho com login continua
-- aceitando ate T+15. Encerrar o formulario publico nao proibia toda escrita no
-- banco.
--
-- ---------------------------------------------------------------
-- O que esta migration faz
-- ---------------------------------------------------------------
-- Para evento com mode = 'async', quiz_version >= 2 e form_closes_at definido,
-- T passa a ser o PRIMEIRO INSTANTE RECUSADO tambem no banco, com a mesma regra
-- do formulario publico: recusa quando `now() >= form_closes_at`.
--
--   1. quiz_responses, INSERT: nova resposta recusada a partir de T.
--   2. quiz_responses, UPDATE: reescrita recusada a partir de T. USING olha a
--      linha ANTIGA e WITH CHECK a NOVA, entao nao da para tirar uma resposta de
--      um evento encerrado mudando participant_id para outro cadastro.
--   3. participants, INSERT: autocadastro (participants_own_insert) num evento
--      v2 encerrado recusado a partir de T. Sem isto um usuario autenticado ainda
--      se inseria no evento depois do prazo, inclusive com completed_at.
--
-- O relogio e `now()` do Postgres (inicio da transacao do pedido). Nenhuma
-- coluna enviada pelo cliente participa da decisao: submitted_at, started_at ou
-- qualquer horario no corpo do pedido sao ignorados por desenho.
--
-- ---------------------------------------------------------------
-- Por que policies RESTRITIVAS, e nao reescrever as da 010
-- ---------------------------------------------------------------
-- Policy restritiva e combinada com AND sobre as permissivas: ela so pode TIRAR
-- acesso, nunca dar. Entao:
--   - as permissivas da 010 continuam exatamente como estao, e com elas o
--     comportamento v1 e o modo live (stage_number <= current_stage) e o
--     modo async v1 (tolerancia de T+15) ficam intocados;
--   - nenhuma escrita que hoje e negada passa a ser permitida (nao reabre nada);
--   - reverter e apagar tres policies, sem reescrever a 010 de memoria.
--
-- As tres valem para PUBLIC. Quem nao e alcancado, por desenho da plataforma:
--   - service_role (BYPASSRLS): rotas do servidor, formulario publico,
--     importacao, regularizacao, conclusao (/api/complete-quiz) e a fila;
--   - o DONO das tabelas (postgres, sem FORCE ROW LEVEL SECURITY): as funcoes
--     SECURITY DEFINER da 010 (gatilho da sessao), 023 (inicio do processamento)
--     e 029 (regularizacao).
-- A prova mede as duas coisas no catalogo e com escrita de verdade.
--
-- ---------------------------------------------------------------
-- O que esta migration NAO muda (de proposito)
-- ---------------------------------------------------------------
--   - A ESPERA DE 15 MINUTOS ANTES DO PROCESSAMENTO (023,
--     jobs_iniciar_assincrono, p_tolerancia_segundos = 900, e a quiescencia).
--     Proibir admissao nova e drenar operacao em voo sao problemas diferentes:
--     uma gravacao do servidor aceita antes de T (formulario publico) pode
--     terminar depois de T, e a espera continua existindo para ela.
--   - A abertura de etapa (participant_stage_sessions_own_open): ja recusa a
--     partir de T-15min no async, o que e mais estrito do que esta regra.
--   - Eventos live (qualquer versao) e eventos async v1.
--   - Evento async v2 SEM form_closes_at: a 010 trata como janela que nao fecha.
--     Mudar isso e decisao de produto (o formulario publico recusa esse caso
--     como "prazo indeterminado"); fica registrado no plano.
--
-- Idempotente (drop policy if exists + create policy). So DDL de policy: nao
-- toca em dado nenhum.

begin;

-- ---------------------------------------------------------------
-- 1. quiz_responses, INSERT
-- ---------------------------------------------------------------
-- Falha FECHADA: exige ENXERGAR o cadastro da linha e que o evento dele nao
-- esteja encerrado. Cadastro invisivel (de outra pessoa) ja e recusado pela
-- permissiva; aqui ele tambem nao passa.
drop policy if exists "quiz_responses_prazo_rigido_insert" on public.quiz_responses;
create policy "quiz_responses_prazo_rigido_insert" on public.quiz_responses
  as restrictive
  for insert
  with check (
    exists (
      select 1
        from public.participants p
        join public.events e on e.id = p.event_id
       where p.id = quiz_responses.participant_id
         and not (
               e.mode = 'async'
           and e.quiz_version >= 2
           and e.form_closes_at is not null
           and now() >= e.form_closes_at
         )
    )
  );

-- ---------------------------------------------------------------
-- 2. quiz_responses, UPDATE (inclui o ramo DO UPDATE do upsert do aplicativo)
-- ---------------------------------------------------------------
drop policy if exists "quiz_responses_prazo_rigido_update" on public.quiz_responses;
create policy "quiz_responses_prazo_rigido_update" on public.quiz_responses
  as restrictive
  for update
  using (
    exists (
      select 1
        from public.participants p
        join public.events e on e.id = p.event_id
       where p.id = quiz_responses.participant_id
         and not (
               e.mode = 'async'
           and e.quiz_version >= 2
           and e.form_closes_at is not null
           and now() >= e.form_closes_at
         )
    )
  )
  with check (
    exists (
      select 1
        from public.participants p
        join public.events e on e.id = p.event_id
       where p.id = quiz_responses.participant_id
         and not (
               e.mode = 'async'
           and e.quiz_version >= 2
           and e.form_closes_at is not null
           and now() >= e.form_closes_at
         )
    )
  );

-- ---------------------------------------------------------------
-- 3. participants, INSERT (autocadastro pelo navegador)
-- ---------------------------------------------------------------
-- events e de leitura publica, entao aqui `not exists` nao depende de
-- visibilidade: o evento sempre e enxergado (e a FK garante que existe).
drop policy if exists "participants_prazo_rigido_insert" on public.participants;
create policy "participants_prazo_rigido_insert" on public.participants
  as restrictive
  for insert
  with check (
    not exists (
      select 1
        from public.events e
       where e.id = participants.event_id
         and e.mode = 'async'
         and e.quiz_version >= 2
         and e.form_closes_at is not null
         and now() >= e.form_closes_at
    )
  );

commit;
