-- 010_programas.sql
-- Versionamento do quiz + modo assincrono com SESSAO DE ETAPA + gabarito
-- congelado por resposta.
-- Idempotente e sem nenhuma alteracao destrutiva: so adiciona colunas, indices,
-- tabelas, uma funcao e um gatilho. Seguro rodar em producao (com dados) e duas
-- vezes seguidas.
--
-- CONTEXTO: o Marco Zero e uma EVOLUCAO do Fort Inside, nao um segundo produto.
-- O que muda de uma geracao para outra e o quiz. Hoje `quiz_stages` e global
-- (ids 1..6) e `quiz_responses.stage_id` aponta para ele por FK. Trocar o
-- conteudo dessas linhas reinterpreta TODO o historico: ja aconteceu em
-- producao uma vez e embaralhou respostas. As duas travas abaixo
-- (`quiz_version` + `questions_snapshot`) existem para isso nao se repetir.

-- ---------------------------------------------------------------
-- 1. events: versao do quiz, modo e janela do formulario assincrono
-- ---------------------------------------------------------------

-- Cada evento aponta para a versao do quiz que usa. Default 1 = Fort Inside,
-- entao todos os eventos existentes continuam exatamente como estao.
alter table events
  add column if not exists quiz_version int not null default 1;

-- live  = evento presencial, etapas liberadas por `current_stage`.
-- async = formulario respondido por conta propria dentro de uma janela.
alter table events
  add column if not exists mode text not null default 'live'
    check (mode in ('live', 'async'));

-- Janela do formulario assincrono. Nulas no modo live (nao se aplicam), e por
-- isso sem NOT NULL nem default.
alter table events
  add column if not exists form_opens_at timestamptz;

alter table events
  add column if not exists form_closes_at timestamptz;

-- ---------------------------------------------------------------
-- 2. quiz_stages: versao e ordem dentro da versao
-- ---------------------------------------------------------------

-- As 6 etapas existentes ficam na versao 1. O Marco Zero sera a versao 2, com
-- ids proprios a partir de 101.
-- `id` continua sendo a PRIMARY KEY (NAO viramos chave composta): a FK de
-- quiz_responses.stage_id depende dele, e os ids em faixas separadas (1..6 e
-- 101+) nunca colidem. As queries passam a filtrar por quiz_version.
alter table quiz_stages
  add column if not exists quiz_version int not null default 1;

-- Ordem da etapa dentro da versao. Separada do id porque a versao 2 comeca em
-- 101 mas a pessoa ve "etapa 1..N".
alter table quiz_stages
  add column if not exists stage_number int;

-- Backfill: nas 6 etapas existentes a ordem e o proprio id. So preenche onde
-- esta nulo, entao rodar de novo nao sobrescreve nada.
update quiz_stages
   set stage_number = id
 where stage_number is null
   and quiz_version = 1;

-- ---------------------------------------------------------------
-- 3. quiz_responses: enunciado congelado
-- ---------------------------------------------------------------

-- Guarda as perguntas exatamente como a pessoa viu ao responder. Sem isso,
-- editar `quiz_stages.questions` reescreve a interpretacao de todas as
-- respostas passadas (as respostas so guardam id da pergunta -> valor).
-- NULO nas linhas antigas: quem le deve cair de volta em quiz_stages.
alter table quiz_responses
  add column if not exists questions_snapshot jsonb;

-- ---------------------------------------------------------------
-- 4. participant_scores: 1 linha por participante
-- ---------------------------------------------------------------

create table if not exists participant_scores (
  participant_id uuid primary key references participants(id) on delete cascade,
  -- {visao:{likert:int,situacional:int}, execucao:{...}, relacao:{...}, integridade:{...}}
  eixos jsonb not null,
  -- {desenvolvimento_intelectual:int, saude_energia:int, ...}, cada um 0..10
  elementos jsonb,
  perfil_dominante text,
  perfil_declarado text,
  -- true quando o perfil declarado difere do medido pelas respostas
  divergencia boolean,
  computed_at timestamptz default now()
);

-- RLS ligado: a tabela guarda pontuacao individual. Escrita so por admin /
-- service role (o calculo roda no servidor); o participante so le a propria.
alter table participant_scores enable row level security;

drop policy if exists "participant_scores_admin" on participant_scores;
create policy "participant_scores_admin" on participant_scores
  for all using (is_admin());

drop policy if exists "participant_scores_own_read" on participant_scores;
create policy "participant_scores_own_read" on participant_scores
  for select using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- 5. participant_stage_sessions: a ABERTURA da etapa, pelo relogio do servidor
-- ---------------------------------------------------------------
--
-- POR QUE ESTA TABELA EXISTE (modelo que substituiu a janela avaliada na
-- escrita). A primeira versao desta migration decidia o modo assincrono com
--
--     now() between e.form_opens_at and e.form_closes_at
--
-- dentro das policies de INSERT/UPDATE de quiz_responses. Como cada etapa e uma
-- escrita independente, `now()` era o instante do ENVIO. Consequencia medida:
-- quem abria o formulario as 23h50 e enviava as 00h05 recebia erro de
-- permissao cru do Postgres e perdia o que tinha escrito naquele envio. O prazo
-- nao fechava a porta antes da pessoa entrar -- fechava com ela dentro.
--
-- Resolver isso so na interface foi REJEITADO: bloqueio visual antecipado
-- continua vulneravel a conexao lenta, relogio do cliente incorreto e sessao ja
-- aberta. A regra precisa existir no banco.
--
-- O modelo aprovado registra QUANDO a etapa foi ABERTA, com o relogio do
-- servidor, e passa a decidir o envio contra esse registro, nao contra o
-- relogio do envio. `started_at` NAO virou coluna de quiz_responses: isso
-- criaria resposta vazia so para marcar abertura e mexeria na logica existente
-- de conclusao do questionario.
--
-- SEMANTICA DA JANELA (T = events.form_closes_at):
--   ate T-15min : pode ABRIR etapa nova (e enviar)
--   T-15min a T : NAO pode abrir etapa nova; pode CONCLUIR etapa ja aberta
--   T a T+15min : tolerancia de ENVIO apenas, para sessao ja aberta
--   depois T+15 : nada, nem salvamento automatico
-- O prazo de tolerancia NUNCA serve para abrir etapa nova. Caso canonico com a
-- janela fechando a meia-noite: quem ABRIU as 23h40 consegue ENVIAR as 00h05;
-- quem tenta ABRIR as 23h50 e recusado.

create table if not exists participant_stage_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  stage_id int not null references quiz_stages(id),
  -- Copia da versao do quiz vigente na abertura. A policy abaixo exige que ela
  -- bata com events.quiz_version, entao a sessao nao sobrevive a uma troca de
  -- versao do evento: e um registro do que a pessoa abriu, nao um ponteiro.
  quiz_version int not null,
  -- REGRA 1: atribuido EXCLUSIVAMENTE pelo banco, com relogio do servidor. O
  -- cliente nao informa (sem privilegio de INSERT nesta coluna) nem altera
  -- (sem privilegio de UPDATE em coluna nenhuma). Ver bloco de GRANTs.
  started_at timestamptz not null default now(),
  -- Mantido pelo gatilho da secao 7, nunca pelo browser.
  status text not null default 'open' check (status in ('open', 'submitted')),
  submitted_at timestamptz
);

-- REGRA 3: uma sessao por (participante, evento, etapa). E isto que impede
-- recriar a sessao para renovar o prazo. Indice separado (em vez de constraint
-- na CREATE TABLE) para que um banco que ja tenha a tabela receba a restricao
-- de qualquer forma -- `create table if not exists` nao reavalia constraints.
create unique index if not exists participant_stage_sessions_unica_idx
  on participant_stage_sessions (participant_id, event_id, stage_id);

-- Usado pela policy de quiz_responses e pelo gatilho da secao 7.
create index if not exists participant_stage_sessions_participante_idx
  on participant_stage_sessions (participant_id, stage_id);

alter table participant_stage_sessions enable row level security;

-- REGRA 4, camada de PRIVILEGIO (vem antes da RLS e nenhuma policy futura a
-- reabre por descuido).
--
-- ORDEM IMPORTA, e errar aqui produz falso conserto silencioso: privilegio de
-- COLUNA nao subtrai de privilegio de TABELA. O Supabase concede todos os
-- privilegios do schema public a anon e authenticated por default privilege,
-- entao enquanto existir INSERT/UPDATE no nivel da tabela qualquer
-- `revoke insert (coluna)` e ignorado na pratica. Revoga-se a tabela primeiro e
-- so depois concede-se coluna a coluna. (Mesma licao da 014.)
revoke all on participant_stage_sessions from anon;
revoke all on participant_stage_sessions from authenticated;

-- O participante le as proprias sessoes (a RLS recorta quais) e abre etapa.
-- O conjunto concedido no INSERT e exatamente a intencao do cliente: "abrir a
-- etapa X deste evento, nesta versao do quiz". Fora dele:
--   started_at   -> default now() do servidor, inalcancavel pelo cliente
--   status       -> default 'open', so o gatilho muda
--   submitted_at -> so o gatilho escreve
--   id           -> default gen_random_uuid()
-- Nenhum UPDATE e nenhum DELETE para authenticated: nao da para reescrever a
-- propria sessao, trocar o dono, antecipar started_at, nem apagar a sessao para
-- abrir outra e renovar o prazo.
grant select on participant_stage_sessions to authenticated;
grant insert (event_id, participant_id, stage_id, quiz_version)
  on participant_stage_sessions to authenticated;

-- anon nao recebe nada: sem sessao de usuario nao se abre etapa.
-- service_role e quem roda as rotas administrativas; explicito para nao
-- depender do default privilege da plataforma.
grant all on participant_stage_sessions to service_role;

drop policy if exists "participant_stage_sessions_admin" on participant_stage_sessions;
create policy "participant_stage_sessions_admin" on participant_stage_sessions
  for all
  using (is_admin())
  with check (is_admin());

-- REGRA 10 do fluxo: sessao e dado individual. So o dono (e o admin, pela
-- policy acima) enxerga.
drop policy if exists "participant_stage_sessions_own_read" on participant_stage_sessions;
create policy "participant_stage_sessions_own_read" on participant_stage_sessions
  for select using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  );

-- REGRA 2: a abertura e operacao autenticada e valida, no banco, participante,
-- evento, versao do quiz e disponibilidade da etapa.
--
--   participante : a linha tem de ser de um participante do proprio auth.uid()
--   evento       : event_id da sessao tem de ser o event_id DO participante
--                  (o join amarra e.id = p.event_id e e.id = <novo>.event_id)
--   versao       : a versao da etapa, a do evento e a gravada na sessao tem de
--                  ser a mesma -- nao se abre etapa de outra versao do quiz
--   disponib.    : async -> dentro de [form_opens_at, form_closes_at - 15min]
--                  live  -> stage_number <= current_stage, como sempre
--
-- No modo live a sessao e opcional: ela nao e exigida para enviar resposta (ver
-- secao 6) e existe so para a interface poder usar um unico caminho. Abri-la
-- obedece a mesma trava de etapa do ao vivo, entao nao cria caminho novo.
drop policy if exists "participant_stage_sessions_own_open" on participant_stage_sessions;
create policy "participant_stage_sessions_own_open" on participant_stage_sessions
  for insert with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = participant_stage_sessions.stage_id
      where p.id = participant_stage_sessions.participant_id
        and e.id = participant_stage_sessions.event_id
        and s.quiz_version = e.quiz_version
        and participant_stage_sessions.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            -- O -15min e a regra "nao se abre etapa no fim do prazo".
            -- 'infinity' - interval = 'infinity': janela sem fechamento
            -- definido nao fecha.
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         - interval '15 minutes'
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

-- ---------------------------------------------------------------
-- 6. quiz_responses: trava de escrita ciente de versao, modo e sessao
-- ---------------------------------------------------------------

-- POR QUE MEXER NESSAS POLICIES: elas sao o caminho de escrita do participante.
-- A trava antiga (002 e 006) comparava `stage_id <= events.current_stage`. Isso
-- so funcionava por acidente: os ids 1..6 do Fort Inside coincidem com a ordem.
-- Com ids 101+ (quiz v2) a comparacao nunca passaria, e eventos `async` nem
-- usam `current_stage`. A comparacao correta e contra `stage_number`.
--
-- PROPRIEDADE DE SEGURANCA (nao quebrar o ao vivo): como as 6 etapas
-- existentes receberam `stage_number = id` no backfill acima, e todos os
-- eventos existentes sao mode='live' e quiz_version=1, a trava do modo live
-- fica COMPORTAMENTALMENTE IDENTICA a de hoje para todos os dados que ja
-- existem -- em particular, o modo live NAO exige sessao de etapa. Errar aqui
-- trava a sala inteira num evento ao vivo.
--
-- Regras (alem da checagem de posse, mantida igual em using e with check):
--   live : stage_number <= current_stage, sem sessao
--   async: REGRA 5 -- tem de existir sessao registrada para
--          (participante, evento, etapa); e
--          REGRA 6 -- now() <= form_closes_at + 15min, a tolerancia de ENVIO.
--          `current_stage` e ignorado.
--   ambos: a versao do quiz da etapa tem de ser a versao do quiz do evento
--          (impede gravar etapa de outra versao do quiz)
--
-- Por que a tolerancia aqui e segura: a sessao so pode ter sido criada ate
-- T-15min (policy da secao 5) e nao pode ser recriada (indice unico) nem
-- apagada (sem privilegio de DELETE). Entao "existe sessao" ja prova "entrou
-- antes do prazo", e o +15min so da tempo de terminar o envio. A tolerancia
-- nunca abre etapa nova.
--
-- Se a etapa tiver stage_number nulo, a comparacao do live da NULL e a escrita
-- e negada: falha fechada, e o backfill cobre todas as etapas existentes.

drop policy if exists "quiz_responses_own_insert" on quiz_responses;
create policy "quiz_responses_own_insert" on quiz_responses
  for insert with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = quiz_responses.stage_id
      where p.id = quiz_responses.participant_id
        and s.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            -- 'infinity' + interval = 'infinity'.
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         + interval '15 minutes'
            and exists (
              select 1
              from participant_stage_sessions ss
              where ss.participant_id = quiz_responses.participant_id
                and ss.event_id = e.id
                and ss.stage_id = quiz_responses.stage_id
            )
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

drop policy if exists "quiz_responses_own_update" on quiz_responses;
create policy "quiz_responses_own_update" on quiz_responses
  for update using (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
  )
  with check (
    participant_id in (
      select id from participants where user_id = auth.uid()
    )
    and exists (
      select 1
      from participants p
      join events e on e.id = p.event_id
      join quiz_stages s on s.id = quiz_responses.stage_id
      where p.id = quiz_responses.participant_id
        and s.quiz_version = e.quiz_version
        and case e.mode
          when 'async' then (
                now() >= coalesce(e.form_opens_at, '-infinity'::timestamptz)
            and now() <= coalesce(e.form_closes_at, 'infinity'::timestamptz)
                         + interval '15 minutes'
            and exists (
              select 1
              from participant_stage_sessions ss
              where ss.participant_id = quiz_responses.participant_id
                and ss.event_id = e.id
                and ss.stage_id = quiz_responses.stage_id
            )
          )
          else (
            s.stage_number <= e.current_stage
          )
        end
    )
  );

-- ---------------------------------------------------------------
-- 7. Conclusao da sessao: gatilho, nao escrita do cliente
-- ---------------------------------------------------------------
--
-- `status`/`submitted_at` precisam ser verdadeiros e o browser nao pode
-- escreve-los (REGRA 4). Como o participante nao tem UPDATE nenhum na tabela,
-- alguem do lado do servidor tem de fechar a sessao. Duas opcoes foram
-- consideradas:
--   (a) a rota administrativa fechar via service_role -- deixaria o estado
--       dependente de a aplicacao lembrar de chamar, e ele desalinha em
--       silencio quando alguem grava resposta por outro caminho;
--   (b) gatilho na propria gravacao da resposta -- o estado passa a ser
--       consequencia do fato, nao de uma chamada extra.
-- Escolhida a (b). Nao ha como marcar isto sem gatilho: policy de RLS filtra
-- linha, nao escreve em outra tabela.
--
-- SECURITY DEFINER porque quem dispara e o participante, que (de proposito) nao
-- tem UPDATE em participant_stage_sessions. search_path vazio e referencias
-- qualificadas, pela mesma razao da 012/013: funcao SECURITY DEFINER nao pode
-- depender de resolucao de nome por search_path.
--
-- Nao decide nada de autorizacao: quando chega aqui, a policy de
-- quiz_responses ja aprovou a gravacao. No modo live nao existe sessao e o
-- UPDATE casa 0 linhas -- no-op.

create or replace function public.marcar_sessao_de_etapa_enviada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.participant_stage_sessions
     set status = 'submitted',
         submitted_at = now()
   where participant_id = new.participant_id
     and stage_id = new.stage_id;
  return null;
end;
$$;

-- Funcao de gatilho nao deve ser chamavel diretamente. CREATE OR REPLACE
-- preserva privilegios, entao o EXECUTE herdado de PUBLIC na primeira criacao
-- sobreviveria: o revoke precisa vir depois, nesta ordem (licao da 011).
revoke execute on function public.marcar_sessao_de_etapa_enviada() from public;
revoke execute on function public.marcar_sessao_de_etapa_enviada() from anon;
revoke execute on function public.marcar_sessao_de_etapa_enviada() from authenticated;

drop trigger if exists quiz_responses_marca_sessao on quiz_responses;
create trigger quiz_responses_marca_sessao
  after insert or update on quiz_responses
  for each row execute function public.marcar_sessao_de_etapa_enviada();

-- ---------------------------------------------------------------
-- 8. Indices
-- ---------------------------------------------------------------

create index if not exists events_quiz_version_idx
  on events (quiz_version);

-- Unico: impede duas etapas com a mesma posicao na mesma versao. Linhas com
-- stage_number nulo nao colidem entre si no Postgres.
create unique index if not exists quiz_stages_version_number_idx
  on quiz_stages (quiz_version, stage_number);
