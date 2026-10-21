-- 010_programas.sql
-- Versionamento do quiz + modo assincrono + gabarito congelado por resposta.
-- Idempotente e sem nenhuma alteracao destrutiva: so adiciona colunas, indices
-- e uma tabela. Seguro rodar em producao (com dados) e duas vezes seguidas.
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
-- 5. quiz_responses: trava de escrita ciente de versao e modo
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
-- existem. Errar aqui trava a sala inteira num evento ao vivo.
--
-- Regras novas (alem da checagem de posse, mantida igual em using e with check):
--   live : stage_number <= current_stage
--   async: now() dentro de [form_opens_at, form_closes_at]; nulo = aberto;
--          current_stage e ignorado
--   ambos: a versao do quiz da etapa tem de ser a versao do quiz do evento
--          (impede gravar etapa de outra versao do quiz)
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
          when 'async' then
            now() between coalesce(e.form_opens_at, '-infinity'::timestamptz)
                      and coalesce(e.form_closes_at, 'infinity'::timestamptz)
          else
            s.stage_number <= e.current_stage
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
          when 'async' then
            now() between coalesce(e.form_opens_at, '-infinity'::timestamptz)
                      and coalesce(e.form_closes_at, 'infinity'::timestamptz)
          else
            s.stage_number <= e.current_stage
        end
    )
  );

-- ---------------------------------------------------------------
-- 6. Indices
-- ---------------------------------------------------------------

create index if not exists events_quiz_version_idx
  on events (quiz_version);

-- Unico: impede duas etapas com a mesma posicao na mesma versao. Linhas com
-- stage_number nulo nao colidem entre si no Postgres.
create unique index if not exists quiz_stages_version_number_idx
  on quiz_stages (quiz_version, stage_number);
