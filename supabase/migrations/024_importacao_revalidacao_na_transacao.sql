-- 024_importacao_revalidacao_na_transacao.sql
-- FECHA A JANELA ENTRE A PREVIA E A APLICACAO DA IMPORTACAO EXTERNA.
--
-- NAO APLICAR sem autorizacao nominal, como a 011, a 014, a 022 e as demais da
-- serie. Nenhuma das migrations 010 a 024 esta aplicada em lugar nenhum.
--
-- NAO EDITA a 022: substitui a funcao por `create or replace` e ESTENDE os
-- checks por `drop constraint if exists` + `add constraint`, no mesmo desenho
-- idempotente do resto da serie. A 022 continua sendo o arquivo que CRIA as
-- tabelas; esta e a que corrige a decisao.
--
-- ===========================================================================
-- O DEFEITO, medido
-- ===========================================================================
-- A importacao externa DECIDIA fora da transacao e GRAVAVA dentro dela.
--
--   1. `lerContextoDoEvento` (lib/importacao/borda.ts) conta, por participante,
--      quantas respostas ele JA tem (`respostas_existentes`);
--   2. `planejarImportacao`/`montarPlanoDaBorda` usam esse numero para marcar a
--      submissao como `conflito` (ja respondeu) ou `importavel` (nao respondeu);
--   3. a rota /api/importacao/aplicar remonta o plano, confere a impressao
--      digital contra a que o operador viu, e chama esta funcao;
--   4. a funcao gravava `insert ... on conflict (participant_id, stage_id) do
--      update set answers = excluded.answers, origem = excluded.origem, ...`.
--
-- Entre (1) e (4) existe tempo real. Se a pessoa responder PELO APLICATIVO
-- nesse intervalo, o plano continua dizendo `importavel`, o `do update` passa
-- por cima da resposta dela e `origem` vira 'externo'. A resposta que ela
-- mesma deu desaparece, substituida por dado vindo de fora, e o CONFLITO que
-- este subsistema inteiro existe para detectar nao e detectado -- porque foi
-- avaliado num instante em que ainda nao existia.
--
-- Reproduzido contra Postgres real, com as migrations 001..023, em
-- lib/importacao/provas/corrida-aplicacao.test.ts: a resposta do aplicativo
-- desaparecia, sem erro, sem conflito, e o livro-razao registrava "importada".
--
-- A impressao digital da previa NAO cobre isso, e nao poderia: ela amarra a
-- previa ao PLANO, e o plano nao mudou. O que mudou foi o banco. Dito como a
-- revisao disse: um hash correto nao pode autorizar uma operacao que deixou de
-- ser segura.
--
-- ===========================================================================
-- A CORRECAO, em tres partes
-- ===========================================================================
-- (I) SERIALIZACAO COMPARTILHADA entre os DOIS caminhos de escrita.
--     Nao basta proteger a colisao da mesma chave: a pessoa pode estar
--     respondendo OUTRA etapa no mesmo instante. Os dois caminhos -- aplicativo
--     e importacao -- passam a disputar o MESMO bloqueio transacional, por
--     participante. Quem chega depois ESPERA e, ao entrar, ve o que o outro fez.
--
-- (II) REGRA ESTRUTURAL, revalidada sob o bloqueio.
--     Nao se compara contagem com contagem (contagem e justamente o numero que
--     envelheceu). A regra e sobre a PROCEDENCIA da linha que existe:
--
--       A importacao NUNCA sobrescreve resposta canonica que nao tenha sido
--       escrita POR ESTA MESMA SUBMISSAO EXTERNA -- mesma submissao com
--       IDENTIDADE e VERSAO verificadas.
--
--     Reimportar a mesma submissao e atualizacao legitima -- e o caso de uso
--     real: a correspondencia e corrigida e o lote entra de novo. Passar por
--     cima do que a pessoa respondeu no aplicativo nunca e. Linha vinda de OUTRA
--     submissao externa tambem nao e atualizacao: e conflito.
--
-- (III) LOTE ATOMICO.
--     Ou o conjunto elegivel que o operador aprovou na previa entra INTEIRO, ou
--     NADA entra. Nao existe importacao parcial inesperada.
--
-- ===========================================================================
-- ATOMICIDADE E AUDITORIA: a decisao, e por que ela nao mente
-- ===========================================================================
-- ORDEM DA REVISAO: "aplicar exatamente aquele conjunto elegivel ou recusar a
-- operacao inteira quando surgir um conflito novo. Nao autorizo uma importacao
-- parcial inesperada." E, sobre o historico: "Como a transacao de importacao
-- sera revertida, esse registro deve ser persistido por um mecanismo separado e
-- confiavel, sem fingir que uma escrita revertida ficou gravada."
--
-- O PROBLEMA REAL: em plpgsql nao existe transacao autonoma. `raise exception`
-- desfaz TUDO, inclusive a linha de auditoria -- a recusa desapareceria
-- exatamente no lugar onde foi mandado que ela aparecesse. E os unicos jeitos de
-- escapar da atomicidade da transacao corrente, em Postgres, sao: outra conexao
-- (dblink/pg_background), o log do servidor, ou mensagem nao-transacional no
-- WAL. dblink para a MESMA base exige senha no conninfo para role nao-superuser
-- (ou `dblink_connect_u` com SECURITY DEFINER escalado): credencial dentro de
-- uma migration e escalada de privilegio num banco que serve um evento real.
-- RECUSADO -- nao e um mecanismo confiavel, e um risco novo.
--
-- O MECANISMO ESCOLHIDO, e por que ele sobrevive ao rollback sem mentir:
-- ELE NAO PRECISA SOBREVIVER A ROLLBACK NENHUM, porque na recusa NAO HA
-- ROLLBACK -- nao ha o que reverter. A funcao e dividida em fases:
--
--   FASE 1  trava todos os participantes do lote (ordem crescente de id:
--           ordem determinista, sem ciclo, sem deadlock);
--   FASE 2  REVALIDA o lote inteiro SEM ESCREVER UMA LINHA DO PLANO;
--   FASE 3  havendo QUALQUER conflito: grava SO o registro de auditoria da
--           recusa (em `external_import_rejections`, tabela append-only que
--           NUNCA faz parte do conjunto de escrita de uma importacao) e DEVOLVE
--           a recusa. O conjunto de escrita desta transacao e EXATAMENTE
--           {registro de recusa}: zero submissoes, zero itens, zero respostas
--           canonicas. Nada parcial, nada revertido, nada fingido;
--   FASE 4  nao havendo conflito: aplica o lote INTEIRO. Como o bloqueio da
--           FASE 1 continua nas maos desta transacao, nenhum conflito novo pode
--           surgir entre a FASE 2 e a FASE 4 -- a hipotese "conflito aparece no
--           meio da escrita" deixa de existir, em vez de ser tratada. Qualquer
--           OUTRA falha (constraint, FK, disco) reverte tudo do lote, que e o
--           desfecho que a propria tabela da revisao manda: "falha durante a
--           transacao -> reverter todas as escritas daquele lote". Falha nao e
--           recusa decidida, e nao inventa linha de auditoria.
--
-- O custo, declarado: a recusa chega ao chamador como VALOR DE RETORNO
-- (`ok: false`, com codigo, motivo e zeros em todos os contadores), nao como
-- excecao. Trocar por `raise` devolveria o problema que a propria revisao
-- apontou -- a linha de auditoria iria junto. O que falta para o operador LER
-- "conflito, peca previa nova" em vez de uma divergencia generica e uma mudanca
-- pequena no TypeScript (lib/importacao/borda.ts + a tela), fora do escopo
-- desta unidade e anotada no relatorio.
--
-- O CAMINHO DE PROGRESSO (ordem da revisao) nao precisa de nada novo aqui: o
-- operador pede PREVIA NOVA sem as submissoes conflitantes e aplica o novo
-- conjunto elegivel. A previa continua funcionando; quem recusa e a aplicacao.
--
-- NADA e descartado: na recusa, o payload cru anterior continua onde estava, e a
-- submissao nova simplesmente nao entra -- a coleta inteira segue no arquivo de
-- origem e entra na previa seguinte. Dado coletado de uma pessoa nao se joga
-- fora; o que se recusa e SOBRESCREVER a resposta dela.

-- ===========================================================================
-- 1. O REGISTRO DURAVEL DA RECUSA
-- ===========================================================================
-- Tabela PROPRIA, e e proposital que ela nao tenha FK para
-- `external_submissions`: a recusa precisa poder ser registrada para uma
-- submissao que NUNCA foi gravada (lote recusado = nenhuma submissao entrou).
-- Com FK, o registro da recusa dependeria justamente da escrita que a recusa
-- impede -- e so existiria se mentisse. A chave natural (evento, formulario,
-- submissao) identifica a submissao sem precisar que ela exista.
--
-- Append-only pelo mesmo desenho do livro-razao da 022: sem UPDATE e sem DELETE
-- para ninguem alem do dono da tabela. Historico que da para reescrever nao e
-- historico.
create table if not exists public.external_import_rejections (
  id uuid primary key default gen_random_uuid(),

  -- QUAL LOTE. `lote_impressao` e o md5 do plano inteiro: duas recusas do mesmo
  -- lote compartilham a marca, e e por ela que se le "esta tentativa inteira foi
  -- recusada", nao "estas submissoes avulsas".
  event_id uuid not null,
  lote_impressao text not null,
  questionario_impressao text not null,
  quiz_version int not null,
  formulario_id text not null,

  -- QUAL SUBMISSAO, pela chave natural (ela pode nao existir no banco).
  submissao_id text not null,

  -- POR QUE. `codigo` e vocabulario fechado: cada recusa tem nome proprio, e
  -- nenhum nome diz outra coisa.
  codigo text not null,
  motivo text not null,

  -- O QUE SERIA FEITO E NAO FOI.
  participante_pretendido uuid,
  identidade_via text,
  etapas_em_conflito jsonb not null default '[]'::jsonb,
  etapas_nao_gravadas int not null default 0,
  estado_do_plano text,
  detalhes jsonb,

  -- QUEM TENTOU.
  operador uuid not null,
  operador_email text,

  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_import_rejections
    drop constraint if exists external_import_rejections_codigo_check;
  alter table public.external_import_rejections
    add constraint external_import_rejections_codigo_check
    check (codigo in (
      'resposta_do_aplicativo',                 -- a pessoa respondeu no app
      'outra_submissao_externa',                -- a linha e de outra coleta
      'outra_submissao_ativa_do_participante',  -- duas coletas, uma pessoa
      'duplicidade_no_lote',                    -- duas submissoes do mesmo plano
      'participante_inexistente',
      'participante_fora_do_evento',
      'email_do_participante_mudou',
      'versao_da_submissao_mudou',              -- nao e a MESMA submissao
      'identidade_da_submissao_mudou'
    ));

  alter table public.external_import_rejections
    drop constraint if exists external_import_rejections_motivo_check;
  alter table public.external_import_rejections
    add constraint external_import_rejections_motivo_check
    check (length(btrim(motivo)) >= 3);
end $$;

create index if not exists external_import_rejections_evento_idx
  on public.external_import_rejections (event_id, criado_em desc);
create index if not exists external_import_rejections_lote_idx
  on public.external_import_rejections (lote_impressao);
create index if not exists external_import_rejections_submissao_idx
  on public.external_import_rejections (event_id, formulario_id, submissao_id);

comment on table public.external_import_rejections is
  'Registro DURAVEL de lote de importacao externa RECUSADO na revalidacao. Gravado numa transacao cujo conjunto de escrita e SO este registro (nenhuma submissao, nenhum item, nenhuma resposta canonica), por isso nao depende de sobreviver a rollback: nao ha rollback. Sem FK para external_submissions de proposito -- a recusa e justamente o caso em que a submissao nao foi gravada.';
comment on column public.external_import_rejections.lote_impressao is
  'md5 do plano inteiro. Marca comum das recusas de UMA tentativa: o lote e atomico, e a recusa tambem.';

alter table public.external_import_rejections enable row level security;

drop policy if exists external_import_rejections_admin_select on public.external_import_rejections;
create policy external_import_rejections_admin_select on public.external_import_rejections
  for select using (is_admin());

drop policy if exists external_import_rejections_admin_insert on public.external_import_rejections;
create policy external_import_rejections_admin_insert on public.external_import_rejections
  for insert with check (is_admin());

revoke all on public.external_import_rejections from anon, authenticated;
revoke update, delete on public.external_import_rejections from anon, authenticated, service_role;

-- A ACAO PROPRIA tambem no livro-razao da 022, para a submissao que JA EXISTE.
-- Quando a submissao recusada ja estava gravada de uma importacao anterior, o
-- historico DELA tem de contar que houve uma tentativa recusada -- senao quem
-- auditar aquela submissao ve um buraco. Append-only: linha nova, nada alterado.
do $$
begin
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_acao_check;
  alter table public.external_submission_events
    add constraint external_submission_events_acao_check
    check (acao in (
      'importada',                 -- virou resposta canonica pontuavel
      'retida_incompativel',       -- gravada e MARCADA: dado incompativel
      'retida_pendente',           -- identidade nao casou: espera humano
      'retida_conflito',           -- mais de um candidato: espera humano
      'recusada_na_revalidacao',   -- 024: o plano envelheceu entre a previa e a
                                   -- aplicacao. O LOTE INTEIRO foi recusado e
                                   -- NADA dele foi gravado. O nome e o que a
                                   -- borda da decisao do operador
                                   -- (lib/importacao/decisao-do-operador.ts) ja
                                   -- le: a linha e por submissao, e dizer que
                                   -- ESTA submissao foi recusada na revalidacao
                                   -- e exato. Que o lote inteiro caiu esta em
                                   -- `detalhes.lote_impressao` e na tabela de
                                   -- recusas.
      'reconciliada_pelo_operador',
      'revogada'
    ));

  -- Recusa sem motivo registrado nao e recusa registrada.
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_justificativa_check;
  alter table public.external_submission_events
    add constraint external_submission_events_justificativa_check
    check (
      acao not in ('reconciliada_pelo_operador', 'revogada', 'recusada_na_revalidacao')
      or (justificativa is not null and length(btrim(justificativa)) >= 3)
    );
end $$;

-- ===========================================================================
-- 2. O BLOQUEIO COMPARTILHADO: a chave por participante
-- ===========================================================================
-- Bloqueio CONSULTIVO (advisory), de transacao, e nao `select ... for update` na
-- linha do participante. O motivo e medido, nao estetico: a 014 REVOGOU
-- `update` em `participants` de `authenticated`, e `select ... for update` exige
-- privilegio de UPDATE na tabela -- a escrita do participante estouraria em vez
-- de esperar. Bloqueio consultivo nao depende de privilegio de tabela, nao toca
-- dado do usuario, e o Postgres o solta sozinho no fim da transacao (nenhum
-- caminho de erro deixa trava pendurada).
create or replace function public.participante_lock_key(p_participant uuid)
returns bigint
language sql
immutable
as $$
  -- Namespace proprio ('fort.participante') no hash: a chave nao colide com
  -- bloqueio consultivo de outro assunto do projeto.
  select hashtextextended('fort.participante:' || p_participant::text, 0);
$$;

comment on function public.participante_lock_key(uuid) is
  'Chave do bloqueio consultivo que SERIALIZA as escritas de resposta de um participante entre os dois caminhos: aplicativo e importacao externa.';

-- O APLICATIVO ENTRA NO BLOQUEIO SEM SABER. O caminho de escrita do
-- participante (app/(participant)/quiz/[stageId]/page.tsx) e um upsert pelo
-- PostgREST: ele nao tem como pedir trava nenhuma. Entao a trava e pedida pelo
-- BANCO, no gatilho, em INSERT e em UPDATE -- e com isso TODO caminho de escrita
-- de `quiz_responses` (aplicativo, importacao, painel, psql) disputa a mesma
-- chave, sem uma linha de TypeScript.
--
-- SEM DEADLOCK, por desenho: a importacao pega TODAS as chaves do lote em ordem
-- crescente de id ANTES de escrever; cada transacao do aplicativo pega UMA
-- chave. Um conjunto ordenado contra detentores de recurso unico nao fecha
-- ciclo. Bloqueio consultivo e reentrante na mesma sessao, entao a importacao
-- pedir de novo pelo gatilho nao custa nem trava.
create or replace function public.quiz_responses_serializa_participante()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(public.participante_lock_key(new.participant_id));
  return new;
end;
$$;

comment on function public.quiz_responses_serializa_participante() is
  'Toda escrita em quiz_responses pega o bloqueio consultivo do participante. E o que faz a importacao e a resposta do aplicativo ESPERAREM uma pela outra em vez de uma passar por cima da outra.';

drop trigger if exists quiz_responses_serializa_participante on public.quiz_responses;
create trigger quiz_responses_serializa_participante
  before insert or update on public.quiz_responses
  for each row
  execute function public.quiz_responses_serializa_participante();

-- ===========================================================================
-- 3. A PROCEDENCIA DA LINHA CANONICA PARA DE MENTIR
-- ===========================================================================
-- A regra estrutural (II) so vale se `origem = 'externo'` com
-- `external_submission_id = X` significar DE FATO "o conteudo desta linha foi
-- escrito pela submissao X e ninguem digitou por cima".
--
-- Hoje nao significa. O aplicativo grava com
-- `upsert({participant_id, stage_id, answers}, {onConflict})`
-- (app/(participant)/quiz/[stageId]/page.tsx): no caminho de UPDATE, PostgREST
-- so escreve as colunas enviadas. `origem`, `external_submission_id` e
-- `importacao` ficam como estavam -- e `submitted_at` tambem nao se move,
-- porque default so vale em INSERT. Ou seja: a pessoa responder no aplicativo
-- por cima de uma linha importada NAO DEIXA NENHUM RASTRO no banco. Sem rastro,
-- "mesma submissao -> atualizacao legitima" seria porta aberta: a reimportacao
-- passaria por cima da resposta dela achando que atualizava a propria linha.
--
-- Este gatilho e o rastro. Dispara SO em linha que hoje e 'externo' (toda a
-- escrita normal do aplicativo, que e a maioria absoluta, nao passa por aqui) e
-- SO quando a escrita nao veio desta funcao de importacao. O efeito e dizer a
-- verdade: a linha passou a ser a resposta da pessoa, e a proveniencia externa
-- sai dela. A submissao externa continua inteira na sua propria tabela, com o
-- payload cru -- nada e perdido, e a reimportacao pode ser refeita (e, agora,
-- sera RECUSADA, que e o desfecho certo).
--
-- Nao se recusa a escrita do aplicativo: a resposta da pessoa tem de entrar.
-- Quem e recusado e quem quer passar por cima dela.
create or replace function public.quiz_responses_proveniencia_do_app()
returns trigger
language plpgsql
as $$
begin
  -- A importacao se identifica por um ajuste LOCAL DA TRANSACAO (terceiro
  -- argumento de set_config = true), que nao vaza para outra conexao nem
  -- sobrevive ao commit.
  if coalesce(current_setting('fort.importacao_externa', true), 'off') = 'on' then
    return new;
  end if;
  new.origem := 'app';
  new.external_submission_id := null;
  new.importacao := null;
  return new;
end;
$$;

comment on function public.quiz_responses_proveniencia_do_app() is
  'Escrita que NAO veio de importacao_externa_aplicar sobre uma linha importada: a linha passa a ser resposta do aplicativo e a proveniencia externa sai dela. E o rastro que faz "mesma submissao = atualizacao legitima" ser verdade.';

drop trigger if exists quiz_responses_proveniencia_do_app on public.quiz_responses;
create trigger quiz_responses_proveniencia_do_app
  before update on public.quiz_responses
  for each row
  when (old.origem = 'externo')
  execute function public.quiz_responses_proveniencia_do_app();

-- ===========================================================================
-- 4. A APLICACAO DO LOTE: trava, revalida, e so depois escreve
-- ===========================================================================
-- Substitui a funcao da 022. O que ela continua NAO fazendo: nao escolhe
-- participante, nao cria participante, nao pontua, nao reconcilia identidade --
-- isso e do planejador. O que ela passa a fazer: TRAVAR, CONFERIR que o que o
-- plano autorizou continua verdade, e recusar o LOTE INTEIRO quando deixou de
-- ser.
--
-- SECURITY INVOKER de proposito, como na 022. A revalidacao le `participants` e
-- `quiz_responses` com o privilegio de quem chamou, e isso e seguro aqui porque
-- a policy de SELECT de `quiz_responses` e um SUPERCONJUNTO da de UPDATE
-- (`own_read` = proprias linhas OU is_admin(); `own_update` = proprias linhas):
-- qualquer linha que a chamada conseguiria sobrescrever, a revalidacao consegue
-- ver. Uma linha que a RLS esconde da revalidacao tambem esta escondida do
-- `on conflict do update`, que ai falha pela RLS -- alto, nao em silencio.
-- As rotas administrativas passam por service_role, que nao e afetado.
create or replace function public.importacao_externa_aplicar(plano jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_event_id uuid;
  v_operador uuid;
  v_operador_email text;
  v_impressao text;
  v_versao int;
  v_form_id text;
  v_form_nome text;
  v_lote text;
  s jsonb;
  e jsonb;
  it jsonb;
  v_sub_id uuid;
  v_sub_existente uuid;
  v_estado text;
  v_participant uuid;
  v_apto boolean;
  v_acao text;
  v_gravadas int := 0;
  v_itens int := 0;
  v_por_estado jsonb := '{}'::jsonb;
  -- --- revalidacao e lote atomico (024) ---
  v_participantes uuid[];
  v_p uuid;
  v_recusa_codigo text;
  v_recusa_motivo text;
  v_recusas jsonb := '[]'::jsonb;
  v_evento_do_part uuid;
  v_email_part text;
  v_email_plano text;
  v_outra uuid;
  v_etapas_conflito text[];
  v_n_app int;
  v_n_ext int;
  v_vistos uuid[] := '{}'::uuid[];
  v_sub_versao int;
  v_sub_impressao text;
  v_sub_participant uuid;
  v_sub_estado text;
  v_r jsonb;
begin
  if plano is null or coalesce((plano ->> 'ok')::boolean, false) is not true then
    raise exception
      'importacao_externa_aplicar: plano recusado ou ausente (codigo=%, motivo=%). Nada foi gravado.',
      coalesce(plano ->> 'codigo', 'PLANO_AUSENTE'),
      coalesce(plano ->> 'motivo', 'plano nao informado');
  end if;

  v_event_id := (plano ->> 'evento_id')::uuid;
  v_versao   := (plano ->> 'quiz_version')::int;
  v_impressao := plano ->> 'questionario_impressao';
  v_operador := nullif(plano -> 'operador' ->> 'id', '')::uuid;
  v_operador_email := plano -> 'operador' ->> 'email';
  v_form_id  := plano -> 'origem' ->> 'formulario_id';
  v_form_nome := plano -> 'origem' ->> 'formulario_nome';
  v_lote := md5(plano::text);

  if v_operador is null then
    raise exception 'importacao_externa_aplicar: plano sem operador responsavel. Nada foi gravado.';
  end if;
  if v_form_id is null or btrim(v_form_id) = '' then
    raise exception 'importacao_externa_aplicar: plano sem formulario de origem. Nada foi gravado.';
  end if;
  if v_impressao is null or v_impressao !~ '^[0-9a-f]{64}$' then
    raise exception 'importacao_externa_aplicar: plano sem impressao digital valida do questionario. Nada foi gravado.';
  end if;

  -- Cinto e suspensorio do plano, ANTES de qualquer trava: o check da tabela ja
  -- proibiria, mas a mensagem daqui diz qual submissao, e e ela que o operador
  -- vai ler. Plano mal formado e erro de programa, nao conflito de corrida.
  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    if coalesce((s ->> 'apto_para_pontuar')::boolean, false)
       and (s ->> 'estado') <> 'importavel' then
      raise exception
        'importacao_externa_aplicar: submissao % pede apto_para_pontuar com estado %. Recusado.',
        s ->> 'submissao_id', s ->> 'estado';
    end if;
  end loop;

  -- =======================================================================
  -- FASE 1: TRAVA TODOS OS PARTICIPANTES DO LOTE, EM ORDEM
  -- =======================================================================
  -- Ordem crescente de id: determinista, e por isso sem ciclo de espera. A
  -- trava e pedida para TODOS antes de revalidar QUALQUER UM -- senao o
  -- participante B poderia responder no aplicativo enquanto A esta sendo
  -- revalidado, e a janela voltaria pela porta de tras.
  select array_agg(distinct x.pid order by x.pid)
    into v_participantes
    from jsonb_array_elements(plano -> 'submissoes') ss
    cross join lateral (
      select nullif(ss ->> 'participant_id', '')::uuid as pid,
             ss ->> 'estado' as est
    ) x
   where x.pid is not null and x.est in ('importavel', 'incompativel');

  foreach v_p in array coalesce(v_participantes, '{}'::uuid[])
  loop
    perform pg_advisory_xact_lock(public.participante_lock_key(v_p));
  end loop;

  -- A marca que o gatilho de proveniencia le: daqui para a frente, nesta
  -- transacao, as escritas em quiz_responses SAO da importacao e podem carregar
  -- proveniencia externa. Local da transacao: nao vaza para outra conexao, nao
  -- sobrevive ao commit.
  perform set_config('fort.importacao_externa', 'on', true);

  -- =======================================================================
  -- FASE 2: REVALIDA O LOTE INTEIRO, SEM ESCREVER NADA DO PLANO
  -- =======================================================================
  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    v_estado := s ->> 'estado';
    v_participant := nullif(s ->> 'participant_id', '')::uuid;
    v_recusa_codigo := null;
    v_recusa_motivo := null;
    v_etapas_conflito := null;

    if v_participant is not null and v_estado in ('importavel', 'incompativel') then
      -- A linha desta submissao, se ela ja existe. E a chave da regra
      -- estrutural: "escrita por ESTA submissao" quer dizer
      -- `external_submission_id` igual a este id. Submissao nova (id nulo) nao
      -- escreveu nada antes -- logo QUALQUER linha existente do participante e
      -- de outra procedencia.
      select es.id, es.quiz_version, es.questionario_impressao, es.participant_id, es.estado
        into v_sub_existente, v_sub_versao, v_sub_impressao, v_sub_participant, v_sub_estado
        from public.external_submissions es
       where es.event_id = v_event_id
         and es.formulario_id = v_form_id
         and es.submissao_id = s ->> 'submissao_id';

      -- (a) IDENTIDADE do participante
      select p.event_id, lower(btrim(coalesce(p.email, '')))
        into v_evento_do_part, v_email_part
        from public.participants p
       where p.id = v_participant;

      v_email_plano := lower(btrim(coalesce(s -> 'proveniencia' ->> 'email_reconciliado', '')));

      if v_evento_do_part is null then
        v_recusa_codigo := 'participante_inexistente';
        v_recusa_motivo := format(
          'o participante %s que o plano reconciliou nao existe mais',
          v_participant);
      elsif v_evento_do_part <> v_event_id then
        v_recusa_codigo := 'participante_fora_do_evento';
        v_recusa_motivo := format(
          'o participante %s nao e deste evento (%s)', v_participant, v_event_id);
      elsif (s -> 'proveniencia' ->> 'identidade_via') = 'email_verificado'
            and v_email_plano <> ''
            and v_email_part <> v_email_plano then
        -- A identidade foi estabelecida POR E-MAIL. Se o e-mail da pessoa mudou
        -- depois da previa, a correspondencia que autorizou isto nao existe mais.
        v_recusa_codigo := 'email_do_participante_mudou';
        v_recusa_motivo := format(
          'a identidade veio de e-mail verificado (%s) e o participante agora tem outro e-mail',
          v_email_plano);
      end if;

      -- (b) A SUBMISSAO EXISTENTE E, DE FATO, A MESMA COISA?
      --     Atualizar registro externo so quando se demonstrar MESMA submissao,
      --     com IDENTIDADE e VERSAO verificadas. Versao ou impressao diferente
      --     nao e "a mesma submissao atualizada": e outro questionario com o
      --     mesmo numero de protocolo, e trocar um pelo outro em silencio e
      --     exatamente o que a impressao digital existe para impedir.
      if v_recusa_codigo is null and v_sub_existente is not null then
        if v_sub_versao is distinct from v_versao
           or v_sub_impressao is distinct from v_impressao then
          v_recusa_codigo := 'versao_da_submissao_mudou';
          v_recusa_motivo := format(
            'a submissao %s esta gravada na versao %s / impressao %s e o plano traz versao %s / impressao %s: nao e a mesma submissao',
            s ->> 'submissao_id', v_sub_versao, left(coalesce(v_sub_impressao, '-'), 12),
            v_versao, left(v_impressao, 12));
        elsif v_sub_participant is not null and v_sub_participant <> v_participant then
          v_recusa_codigo := 'identidade_da_submissao_mudou';
          v_recusa_motivo := format(
            'a submissao %s esta gravada para o participante %s e o plano a atribui a %s',
            s ->> 'submissao_id', v_sub_participant, v_participant);
        end if;
      end if;

      -- (c) OUTRA SUBMISSAO EXTERNA ATIVA do mesmo participante
      if v_recusa_codigo is null then
        select es.id into v_outra
          from public.external_submissions es
         where es.event_id = v_event_id
           and es.participant_id = v_participant
           and es.estado in ('importavel', 'incompativel')
           and (v_sub_existente is null or es.id <> v_sub_existente)
         limit 1;
        if v_outra is not null then
          v_recusa_codigo := 'outra_submissao_ativa_do_participante';
          v_recusa_motivo := format(
            'a submissao externa %s ja esta ativa para este participante: duas coletas para a mesma pessoa e CONFLITO, nao atualizacao',
            v_outra);
        end if;
      end if;

      -- (d) DUPLICIDADE DENTRO DO LOTE
      if v_recusa_codigo is null and v_participant = any (v_vistos) then
        v_recusa_codigo := 'duplicidade_no_lote';
        v_recusa_motivo :=
          'outra submissao DESTE MESMO plano ja grava para este participante: a segunda nao passa por cima da primeira';
      end if;
      if v_recusa_codigo is null then
        v_vistos := v_vistos || v_participant;
      end if;

      -- (e) RESPOSTA EXISTENTE QUE NAO E DESTA SUBMISSAO
      --     A REGRA. E ela olha TODAS as respostas do participante, nao apenas
      --     as etapas que este plano grava: proteger so a colisao da mesma
      --     chave nao basta se a pessoa estiver respondendo a etapa vizinha.
      --     Qualquer resposta dela que nao tenha sido escrita por ESTA submissao
      --     e motivo de recusa do lote.
      if v_recusa_codigo is null then
        select count(*) filter (where r.origem <> 'externo'),
               count(*) filter (where r.origem = 'externo'),
               array_agg(r.stage_id::text order by r.stage_id)
          into v_n_app, v_n_ext, v_etapas_conflito
          from public.quiz_responses r
         where r.participant_id = v_participant
           and (
             r.origem <> 'externo'
             or r.external_submission_id is null
             or v_sub_existente is null
             or r.external_submission_id <> v_sub_existente
           );

        if coalesce(v_n_app, 0) + coalesce(v_n_ext, 0) > 0 then
          if coalesce(v_n_app, 0) > 0 then
            v_recusa_codigo := 'resposta_do_aplicativo';
            v_recusa_motivo := format(
              'o participante respondeu PELO APLICATIVO nas etapas %s depois que esta previa foi montada: a resposta dele fica',
              array_to_string(v_etapas_conflito, ', '));
          else
            v_recusa_codigo := 'outra_submissao_externa';
            v_recusa_motivo := format(
              'as etapas %s ja tem resposta de OUTRA submissao externa: trocar uma coleta por outra em silencio nao e atualizacao',
              array_to_string(v_etapas_conflito, ', '));
          end if;
        end if;
      end if;

      if v_recusa_codigo is not null then
        v_recusas := v_recusas || jsonb_build_array(jsonb_build_object(
          'submissao_id', s ->> 'submissao_id',
          'codigo', v_recusa_codigo,
          'motivo', v_recusa_motivo,
          'estado_do_plano', v_estado,
          -- `estado` = o estado REAL da submissao no banco depois da recusa. Como
          -- NADA foi gravado, e o estado que ela ja tinha -- ou nulo, quando ela
          -- nunca foi gravada. Inventar 'conflito' aqui seria afirmar uma escrita
          -- que o lote atomico nao fez.
          'estado', v_sub_estado,
          'participante_pretendido', v_participant,
          'identidade_via', s -> 'proveniencia' ->> 'identidade_via',
          'etapas_em_conflito', coalesce(to_jsonb(v_etapas_conflito), '[]'::jsonb),
          'etapas_nao_gravadas', jsonb_array_length(coalesce(s -> 'etapas', '[]'::jsonb)),
          'submissao_existente', v_sub_existente,
          'bloqueio_do_plano', coalesce(nullif(s -> 'bloqueio', 'null'::jsonb), 'null'::jsonb)));
      end if;
    end if;
  end loop;

  -- =======================================================================
  -- FASE 3: LOTE RECUSADO -- grava SO o registro da recusa e devolve
  -- =======================================================================
  -- O conjunto de escrita desta transacao e EXATAMENTE este registro. Nenhuma
  -- submissao, nenhum item, nenhuma resposta canonica. Nao ha escrita parcial e
  -- nao ha rollback: por isso o registro nao precisa sobreviver a nenhum, e
  -- nada aqui finge estar gravado.
  if jsonb_array_length(v_recusas) > 0 then
    for v_r in select * from jsonb_array_elements(v_recusas)
    loop
      insert into public.external_import_rejections (
        event_id, lote_impressao, questionario_impressao, quiz_version,
        formulario_id, submissao_id, codigo, motivo,
        participante_pretendido, identidade_via,
        etapas_em_conflito, etapas_nao_gravadas, estado_do_plano, detalhes,
        operador, operador_email
      ) values (
        v_event_id, v_lote, v_impressao, v_versao,
        v_form_id, v_r ->> 'submissao_id',
        v_r ->> 'codigo',
        format('LOTE RECUSADO NA REVALIDACAO: %s. NADA do lote foi gravado. Peca uma previa nova sem as submissoes conflitantes.',
               v_r ->> 'motivo'),
        nullif(v_r ->> 'participante_pretendido', '')::uuid,
        v_r ->> 'identidade_via',
        coalesce(v_r -> 'etapas_em_conflito', '[]'::jsonb),
        coalesce((v_r ->> 'etapas_nao_gravadas')::int, 0),
        v_r ->> 'estado_do_plano',
        jsonb_build_object(
          'submissoes_no_lote', jsonb_array_length(plano -> 'submissoes'),
          'recusas_no_lote', jsonb_array_length(v_recusas),
          'bloqueio_do_plano', v_r -> 'bloqueio_do_plano'),
        v_operador, v_operador_email
      );

      -- E, quando a submissao JA EXISTIA, o historico DELA tambem conta a
      -- tentativa recusada. Para submissao que nunca foi gravada nao ha linha a
      -- que apontar -- e e por isso que o registro duravel acima nao tem FK.
      if nullif(v_r ->> 'submissao_existente', '') is not null then
        insert into public.external_submission_events (
          submission_id, acao, operador, operador_email, justificativa, detalhes
        ) values (
          (v_r ->> 'submissao_existente')::uuid,
          'recusada_na_revalidacao',
          v_operador, v_operador_email,
          format('RECUSADA NA REVALIDACAO (LOTE INTEIRO): %s. NADA do lote foi gravado.',
                 v_r ->> 'motivo'),
          jsonb_build_object(
            'codigo', v_r ->> 'codigo',
            -- Zero, escrito: nenhuma etapa desta submissao entrou.
            'etapas_gravadas', 0,
            'lote_impressao', v_lote,
            'etapas_em_conflito', v_r -> 'etapas_em_conflito',
            'etapas_nao_gravadas', v_r -> 'etapas_nao_gravadas',
            'questionario_impressao', v_impressao)
        );
      end if;
    end loop;

    -- No log do servidor tambem, que e canal separado e nao depende de ninguem
    -- consultar tabela: um lote recusado no meio do evento precisa aparecer para
    -- quem esta olhando o log, na hora.
    raise log 'importacao_externa_aplicar: LOTE RECUSADO na revalidacao (evento=%, formulario=%, lote=%, recusas=%). Nada foi gravado.',
      v_event_id, v_form_id, v_lote, jsonb_array_length(v_recusas);

    return jsonb_build_object(
      'ok', false,
      'codigo', 'LOTE_RECUSADO_NA_REVALIDACAO',
      'motivo', format(
        '%s submissao(oes) do lote entraram em conflito depois da previa. O LOTE INTEIRO foi recusado e NADA foi gravado. Peca uma previa nova sem as submissoes conflitantes.',
        jsonb_array_length(v_recusas)),
      'evento_id', v_event_id,
      'formulario_id', v_form_id,
      'questionario_impressao', v_impressao,
      'lote_impressao', v_lote,
      -- Contadores em ZERO porque nada foi gravado. Nao e omissao: e a
      -- afirmacao de que o lote nao entrou.
      'por_estado', '{}'::jsonb,
      'linhas_de_resposta_gravadas', 0,
      'itens_registrados', 0,
      'importado_por', v_operador,
      'recusas_na_revalidacao', jsonb_array_length(v_recusas),
      'recusadas_na_revalidacao', v_recusas
    );
  end if;

  -- =======================================================================
  -- FASE 4: LOTE INTEGRO -- aplica INTEIRO
  -- =======================================================================
  -- A trava da FASE 1 continua nas maos desta transacao: nenhum conflito novo
  -- pode surgir entre a revalidacao e a escrita. Qualquer falha daqui para a
  -- frente reverte TODAS as escritas do lote.
  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    v_estado := s ->> 'estado';
    v_participant := nullif(s ->> 'participant_id', '')::uuid;
    v_apto := coalesce((s ->> 'apto_para_pontuar')::boolean, false);

    insert into public.external_submissions (
      event_id, formulario_id, formulario_nome, submissao_id,
      quiz_version, questionario_impressao,
      email_coletado, email_verificado, nome_declarado, respostas_brutas,
      participant_id, identidade_via, email_reconciliado,
      estado, apto_para_pontuar, bloqueio, contagens,
      importado_por, importado_por_email
    ) values (
      v_event_id, v_form_id, v_form_nome, s ->> 'submissao_id',
      v_versao, v_impressao,
      s -> 'coleta' ->> 'email',
      coalesce((s -> 'coleta' ->> 'email_verificado')::boolean, false),
      s -> 'coleta' ->> 'nome_declarado',
      coalesce(s -> 'coleta' -> 'respostas_brutas', '{}'::jsonb),
      v_participant,
      s -> 'proveniencia' ->> 'identidade_via',
      s -> 'proveniencia' ->> 'email_reconciliado',
      v_estado, v_apto,
      nullif(s -> 'bloqueio', 'null'::jsonb),
      nullif(s -> 'contagens', 'null'::jsonb),
      v_operador, v_operador_email
    )
    on conflict (event_id, formulario_id, submissao_id) do update set
      quiz_version = excluded.quiz_version,
      questionario_impressao = excluded.questionario_impressao,
      email_coletado = excluded.email_coletado,
      email_verificado = excluded.email_verificado,
      nome_declarado = excluded.nome_declarado,
      respostas_brutas = excluded.respostas_brutas,
      participant_id = excluded.participant_id,
      identidade_via = excluded.identidade_via,
      email_reconciliado = excluded.email_reconciliado,
      estado = excluded.estado,
      apto_para_pontuar = excluded.apto_para_pontuar,
      bloqueio = excluded.bloqueio,
      contagens = excluded.contagens,
      importado_por = excluded.importado_por,
      importado_por_email = excluded.importado_por_email,
      atualizado_em = now()
    returning id into v_sub_id;

    -- Os itens: o desfecho de cada resposta, inclusive (e principalmente) os
    -- incompativeis. Reimportacao substitui o conjunto da submissao, nunca
    -- mistura o antigo com o novo.
    delete from public.external_response_items where submission_id = v_sub_id;
    for it in select * from jsonb_array_elements(coalesce(s -> 'itens', '[]'::jsonb))
    loop
      insert into public.external_response_items (
        submission_id, pergunta_id, estado,
        valor_canonico, valor_bruto, causa, motivo, pontuada, forma
      ) values (
        v_sub_id,
        it ->> 'pergunta_id',
        it ->> 'estado',
        case when it ->> 'estado' = 'compativel' then it -> 'valor' else null end,
        nullif(it -> 'bruto', 'null'::jsonb),
        it ->> 'causa',
        it ->> 'motivo',
        coalesce((it ->> 'pontuada')::boolean, false),
        it ->> 'forma'
      );
      v_itens := v_itens + 1;
    end loop;

    -- As respostas canonicas. SO com participante reconciliado e SO com os
    -- valores COMPATIVEIS que o plano montou: nenhum zero, nenhum placeholder.
    if v_participant is not null and v_estado in ('importavel', 'incompativel') then
      for e in select * from jsonb_array_elements(coalesce(s -> 'etapas', '[]'::jsonb))
      loop
        insert into public.quiz_responses (
          participant_id, stage_id, answers, questions_snapshot,
          origem, external_submission_id, importacao
        ) values (
          v_participant,
          (e ->> 'stage_id')::int,
          e -> 'answers',
          (select qs.questions from public.quiz_stages qs where qs.id = (e ->> 'stage_id')::int),
          'externo',
          v_sub_id,
          jsonb_build_object(
            'formulario_id', v_form_id,
            'formulario_nome', v_form_nome,
            'submissao_id', s ->> 'submissao_id',
            'quiz_version', v_versao,
            'questionario_impressao', v_impressao,
            'identidade_via', s -> 'proveniencia' ->> 'identidade_via',
            'email_reconciliado', s -> 'proveniencia' ->> 'email_reconciliado',
            'importado_por', v_operador,
            'importado_por_email', v_operador_email,
            'apto_para_pontuar', v_apto,
            'incompativeis', coalesce(e -> 'incompativeis', '[]'::jsonb),
            'ausentes', coalesce(e -> 'ausentes', '[]'::jsonb)
          )
        )
        on conflict (participant_id, stage_id) do update set
          answers = excluded.answers,
          questions_snapshot = excluded.questions_snapshot,
          origem = excluded.origem,
          external_submission_id = excluded.external_submission_id,
          importacao = excluded.importacao,
          submitted_at = now();
        v_gravadas := v_gravadas + 1;
      end loop;
    end if;

    v_acao := case v_estado
      when 'importavel'   then 'importada'
      when 'incompativel' then 'retida_incompativel'
      when 'pendente'     then 'retida_pendente'
      when 'conflito'     then 'retida_conflito'
      else 'retida_pendente'
    end;
    insert into public.external_submission_events (
      submission_id, acao, operador, operador_email, justificativa, detalhes
    ) values (
      v_sub_id, v_acao, v_operador, v_operador_email,
      s -> 'bloqueio' ->> 'motivo',
      jsonb_build_object(
        'estado', v_estado,
        'contagens', s -> 'contagens',
        'etapas_gravadas', jsonb_array_length(coalesce(s -> 'etapas', '[]'::jsonb)),
        'questionario_impressao', v_impressao,
        'lote_impressao', v_lote
      )
    );

    v_por_estado := jsonb_set(
      v_por_estado, array[v_estado],
      to_jsonb(coalesce((v_por_estado ->> v_estado)::int, 0) + 1), true
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'evento_id', v_event_id,
    'formulario_id', v_form_id,
    'questionario_impressao', v_impressao,
    'lote_impressao', v_lote,
    'por_estado', v_por_estado,
    'linhas_de_resposta_gravadas', v_gravadas,
    'itens_registrados', v_itens,
    'importado_por', v_operador,
    -- Lista vazia e uma AFIRMACAO: nada foi recusado neste lote.
    'recusas_na_revalidacao', 0,
    'recusadas_na_revalidacao', '[]'::jsonb
  );
end;
$$;

comment on function public.importacao_externa_aplicar(jsonb) is
  'Aplica um LOTE de importacao externa: trava os participantes (bloqueio consultivo compartilhado com a escrita do aplicativo), REVALIDA o lote inteiro sem escrever nada (identidade, versao da submissao, duplicidade, respostas existentes em QUALQUER etapa) e so entao aplica. Qualquer conflito novo recusa o LOTE INTEIRO: nada e gravado, e a recusa fica em external_import_rejections (e no livro-razao da submissao, quando ela ja existia). Nao decide identidade nem pontuacao (isso e lib/importacao/*).';

-- ===========================================================================
-- 5. AS VISOES: o novo desfecho tem nome proprio
-- ===========================================================================
-- Um lote recusado NAO deixa submissao em estado nenhum (nada e gravado), entao
-- `v_aptidao_pontuacao_externa` continua como a 022 a escreveu. O que faltava
-- era onde LER as recusas: por lote, com motivo, sem abrir o banco com a mao.
create or replace view public.v_importacoes_recusadas as
select
  r.event_id,
  r.lote_impressao,
  r.formulario_id,
  r.quiz_version,
  r.questionario_impressao,
  min(r.criado_em)                      as recusado_em,
  r.operador,
  r.operador_email,
  count(*)                              as submissoes_recusadas,
  jsonb_agg(jsonb_build_object(
    'submissao_id', r.submissao_id,
    'codigo', r.codigo,
    'motivo', r.motivo,
    'participante_pretendido', r.participante_pretendido,
    'etapas_em_conflito', r.etapas_em_conflito,
    'etapas_nao_gravadas', r.etapas_nao_gravadas
  ) order by r.submissao_id)            as recusas
from public.external_import_rejections r
group by r.event_id, r.lote_impressao, r.formulario_id, r.quiz_version,
         r.questionario_impressao, r.operador, r.operador_email;

comment on view public.v_importacoes_recusadas is
  'Lotes de importacao externa RECUSADOS na revalidacao, um por tentativa, com cada submissao conflitante nomeada e o motivo. Lote recusado nao gravou nada: e aqui que ele existe.';

revoke all on public.v_importacoes_recusadas from anon, authenticated;
