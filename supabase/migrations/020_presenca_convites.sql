-- 020_presenca_convites.sql
-- Presença, convites e o DENOMINADOR OFICIAL da cobertura do Marco Zero.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 018 e a 019.
--
-- ===========================================================================
-- Por que NÃO é uma coluna `is_present` em participants
-- ===========================================================================
-- A proposta de `participants.is_present boolean` foi recusada pelo responsável
-- técnico com uma frase que decide o modelo inteiro: alguém pode comparecer
-- fisicamente SEM ter criado conta e SEM ter respondido ao questionário, e essa
-- pessoa precisa entrar no DENOMINADOR de presença.
--
-- Uma coluna em `participants` torna isso impossível por construção, porque
-- `participants` é a tabela de quem ENTROU NO APLICATIVO: tem `user_id`,
-- `email` único por evento e é a linha a que respostas e prognóstico se
-- amarram. Quem chegou na porta e não abriu o aplicativo não tem linha lá -- e
-- criar uma linha falsa de participante para representá-lo contamina tudo que
-- conta participantes (fila de geração, cobrança de IA, listagens do painel) com
-- pessoas que nunca responderam nada.
--
-- Daí três entidades distintas, cada uma com um dono de verdade diferente:
--
--   event_people      CADASTRO da pessoa vinculada ao evento. A associação ao
--                     participante autenticado é OPCIONAL (participant_id
--                     nullable). É esta tabela que define "pessoa", e é por
--                     pessoa que tudo é deduplicado.
--   event_invitations CONVITES individuais: uma linha por ENVIO, com estado.
--                     Uma pessoa convidada três vezes tem três linhas aqui e
--                     continua sendo UMA pessoa.
--   event_checkins    PRESENÇA FÍSICA registrada e auditável. Um único registro
--                     ATIVO por pessoa e evento, com relógio do servidor e
--                     identificação de quem confirmou.
--
-- Mais duas tabelas que existem porque "total" e "encerrado" são FATOS com
-- data, autor e versão -- não consultas feitas na hora:
--
--   event_invite_snapshots (+ _people)  A FOTOGRAFIA da lista de convidados no
--                     ENCERRAMENTO do período de convites. O total oficial de
--                     convidados é o desta fotografia, nunca um count() vivo de
--                     uma lista que ainda pode crescer.
--   event_checkin_closures  O ENCERRAMENTO formal do check-in pelo
--                     administrador, com data e autor. Sem ele não existe
--                     universo oficial de presentes.
--
--   event_dna_invalidations  O PONTO ÚNICO onde a invalidação é disparada:
--                     qualquer correção de presença (ou de elegibilidade,
--                     chamada de fora) depois do encerramento invalida a
--                     aprovação e o hash do DNA correspondente.
--
-- O DNA Coletivo em si NÃO está aqui: é outra unidade
-- (components/features/marco-zero/dna-coletivo-*). Esta migration entrega os
-- NÚMEROS que ela consome e o SINAL de invalidação que ela precisa respeitar.
--
-- ===========================================================================
-- O denominador, exatamente como foi escrito
-- ===========================================================================
--   Cobertura = (presentes com questionário válido e completo
--                / total de presentes confirmados) × 100
--
-- Exemplo canônico: 50 compareceram, 45 responderam validamente -> 90%.
-- Quem compareceu e NÃO preencheu CONTINUA no denominador. É por isso que o
-- denominador é `event_checkins` e não `participants`: a presença é o universo,
-- a resposta é o numerador.
--
-- Total de convidados NÃO é o denominador da cobertura. Ele aparece ao lado,
-- como participação, e vem do snapshot versionado. Misturar os dois é
-- exatamente o erro que o modelo do DNA já proíbe em texto.
--
-- ===========================================================================
-- "Não consegui verificar" não é "reprovado"
-- ===========================================================================
-- `marco_zero_cobertura()` nunca devolve percentual aproximado nem palpite.
-- Quando o número oficial não é calculável ela devolve
-- `status = 'indisponivel'` com `motivo`, e `cobertura_percentual = NULL`:
--
--   checkin_aberto   -- não há universo oficial: o conjunto de presentes ainda
--                       pode mudar, então qualquer percentual seria sobre um
--                       denominador provisório apresentado como final.
--   sem_presentes    -- 0 presentes. 0/0 não é 0% nem 100%: é indefinido.
--   quiz_sem_etapas  -- a versão de quiz do evento não tem etapa alguma
--                       cadastrada, então não existe definição de
--                       "questionário COMPLETO" para comparar.
--
-- As CONTAGENS (presentes, respondentes) continuam sendo devolvidas nesses
-- casos, porque contar linha é exato -- o que falta é a autoridade do universo,
-- e isso está dito em `checkin_fechado`, não escondido num número redondo.
--
-- O total de convidados tem motivo PRÓPRIO (`motivo_convidados`), para que a
-- ausência da fotografia de convites não contamine o estado da cobertura:
--   sem_snapshot_de_convites -- o período de convites não foi encerrado.
--   snapshot_inconsistente   -- o total gravado não bate com as pessoas da
--                               fotografia; devolver o total gravado seria
--                               devolver um número que o próprio banco
--                               desmente.
--
-- ===========================================================================
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. event_people -- o cadastro de PESSOAS do evento
-- ---------------------------------------------------------------------------
create table if not exists public.event_people (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  -- A associação OPCIONAL ao participante autenticado. NULL é o caso normal de
  -- quem compareceu sem criar conta, e é o motivo de esta tabela existir.
  -- `on delete set null`: apagar o participante não apaga a presença física
  -- dele -- o fato de ter estado na sala não deixa de ser verdade porque a
  -- conta sumiu, e o denominador não pode encolher por isso.
  participant_id uuid references public.participants(id) on delete set null,

  full_name text not null,
  -- NULLABLE de propósito: walk-in registrado na porta pode não ter e-mail, e
  -- exigir e-mail obrigaria a operação a inventar um.
  email text,
  phone text,

  -- Como a pessoa entrou no cadastro. 'walk_in' é quem apareceu sem convite.
  origem text not null default 'lista_convite',

  observacao text,
  registrado_por text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Alvo das FKs compostas de convites e check-ins: elas amarram
  -- (event_id, person_id) de uma vez, então não existe convite nem presença
  -- apontando para pessoa de OUTRO evento. Isso é declarativo, não confiança.
  unique (event_id, id)
);

do $$
begin
  alter table public.event_people drop constraint if exists event_people_origem_check;
  alter table public.event_people add constraint event_people_origem_check
    check (origem in ('lista_convite', 'walk_in', 'importacao'));

  alter table public.event_people drop constraint if exists event_people_nome_check;
  alter table public.event_people add constraint event_people_nome_check
    check (length(btrim(full_name)) > 0);
end
$$;

-- Deduplicação por PESSOA dentro do evento. `lower(email)` porque
-- "Maria@x.com" e "maria@x.com" são a mesma pessoa, e um total de convidados
-- que conta as duas está errado. Parcial porque e-mail é opcional: vários
-- walk-ins sem e-mail convivem.
create unique index if not exists event_people_email_unico_idx
  on public.event_people (event_id, lower(email))
  where email is not null;

-- Um participante autenticado é UMA pessoa no evento. Sem isto, duas linhas de
-- pessoa apontando para o mesmo participante contariam a mesma presença duas
-- vezes no denominador.
create unique index if not exists event_people_participante_unico_idx
  on public.event_people (event_id, participant_id)
  where participant_id is not null;

create index if not exists event_people_evento_idx
  on public.event_people (event_id);

comment on table public.event_people is
  'Cadastro das pessoas vinculadas ao evento. participant_id é OPCIONAL: quem compareceu sem criar conta tem linha aqui e entra no denominador de presença. A unidade de deduplicação do projeto é a PESSOA desta tabela, nunca o envio de convite.';

-- O participante apontado tem de ser do MESMO evento. Não dá por CHECK (exige
-- subconsulta), e a consequência de não ter a trava é direta: um participante
-- de outro evento emprestaria o questionário completo dele para o numerador
-- deste evento.
create or replace function public.event_people_valida_participante()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_evento_do_participante uuid;
begin
  if new.participant_id is null then
    return new;
  end if;

  select p.event_id into v_evento_do_participante
  from public.participants p
  where p.id = new.participant_id;

  if v_evento_do_participante is distinct from new.event_id then
    raise exception
      'event_people: participante % é do evento % e não pode ser vinculado à pessoa do evento %',
      new.participant_id, v_evento_do_participante, new.event_id
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_people_valida_participante on public.event_people;
create trigger event_people_valida_participante
  before insert or update of participant_id, event_id on public.event_people
  for each row execute function public.event_people_valida_participante();

drop trigger if exists event_people_updated_at on public.event_people;
create trigger event_people_updated_at
  before update on public.event_people
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. event_invitations -- uma linha por ENVIO, com estado
-- ---------------------------------------------------------------------------
-- O histórico de envios vive AQUI. O total oficial de convidados NÃO sai desta
-- tabela por count(): sai do snapshot (seção 3), que conta PESSOAS distintas.
-- Três envios para a mesma pessoa são três linhas aqui e UMA no snapshot.
create table if not exists public.event_invitations (
  id uuid primary key default gen_random_uuid(),
  event_id  uuid not null,
  person_id uuid not null,

  canal  text not null default 'email',
  status text not null default 'enviado',

  -- Ordinal do envio para aquela pessoa (1, 2, 3...). É o que torna o
  -- histórico legível e o registro de envio idempotente por tentativa.
  tentativa int not null default 1,

  -- RELÓGIO DO SERVIDOR. Nenhum papel de cliente escreve nesta tabela (ver
  -- bloco de privilégios), e o gatilho da seção 2.1 recusa qualquer valor
  -- diferente de now() na inserção -- inclusive vindo de service_role.
  enviado_em timestamptz not null default now(),
  enviado_por text,

  -- Endereço/telefone efetivamente usado NAQUELE envio. Fica na linha do envio
  -- porque pode ter mudado entre tentativas; o cadastro guarda o atual.
  destino text,
  erro text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (event_id, person_id)
    references public.event_people (event_id, id) on delete cascade,

  unique (person_id, tentativa)
);

do $$
begin
  alter table public.event_invitations drop constraint if exists event_invitations_canal_check;
  alter table public.event_invitations add constraint event_invitations_canal_check
    check (canal in ('email', 'whatsapp', 'sms', 'presencial', 'outro'));

  alter table public.event_invitations drop constraint if exists event_invitations_status_check;
  alter table public.event_invitations add constraint event_invitations_status_check
    check (status in ('enviado', 'entregue', 'falhou', 'respondido', 'recusado', 'cancelado'));

  alter table public.event_invitations drop constraint if exists event_invitations_tentativa_check;
  alter table public.event_invitations add constraint event_invitations_tentativa_check
    check (tentativa >= 1);
end
$$;

create index if not exists event_invitations_pessoa_idx
  on public.event_invitations (person_id, tentativa);

create index if not exists event_invitations_evento_idx
  on public.event_invitations (event_id, status);

comment on table public.event_invitations is
  'Convites individuais: UMA LINHA POR ENVIO, com estado e autor. Uma pessoa convidada três vezes tem três linhas aqui e continua sendo uma pessoa. O total oficial de convidados é o snapshot versionado (event_invite_snapshots), nunca um count() desta tabela.';

-- 2.1 Relógio do servidor, também para o envio.
create or replace function public.event_invitations_relogio_do_servidor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Atribuição, não validação: o valor que vier é descartado.
    new.enviado_em := now();
    return new;
  end if;

  if new.enviado_em is distinct from old.enviado_em then
    raise exception 'event_invitations: enviado_em é do relógio do servidor e não pode ser reescrito (envio %)', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_invitations_relogio on public.event_invitations;
create trigger event_invitations_relogio
  before insert or update on public.event_invitations
  for each row execute function public.event_invitations_relogio_do_servidor();

drop trigger if exists event_invitations_updated_at on public.event_invitations;
create trigger event_invitations_updated_at
  before update on public.event_invitations
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 3. event_invite_snapshots -- a FOTOGRAFIA do encerramento dos convites
-- ---------------------------------------------------------------------------
-- "Total de convidados" é, por decisão do responsável técnico, uma fotografia
-- da lista no ENCERRAMENTO do período de convites, com data e versão. Não é
-- `select count(*) from event_people`: aquela consulta responde "quantas
-- pessoas estão cadastradas AGORA", que muda quando um walk-in é cadastrado na
-- porta -- e o total de convidados não pode subir por causa de quem não foi
-- convidado.
--
-- Versão em vez de linha única: se o período for reaberto e encerrado de novo,
-- nasce a versão 2 e a 1 continua legível. Fotografia não se retoca.
create table if not exists public.event_invite_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  versao int not null,

  -- Redundante com a contagem das linhas filhas DE PROPÓSITO: é o número que
  -- foi declarado no encerramento. Se os dois divergirem, a cobertura devolve
  -- `snapshot_inconsistente` em vez de escolher um deles.
  total_convidados int not null,

  encerrado_em  timestamptz not null default now(),
  encerrado_por text not null,
  motivo text,

  created_at timestamptz not null default now(),

  unique (event_id, versao)
);

do $$
begin
  alter table public.event_invite_snapshots drop constraint if exists event_invite_snapshots_total_check;
  alter table public.event_invite_snapshots add constraint event_invite_snapshots_total_check
    check (total_convidados >= 0);

  alter table public.event_invite_snapshots drop constraint if exists event_invite_snapshots_versao_check;
  alter table public.event_invite_snapshots add constraint event_invite_snapshots_versao_check
    check (versao >= 1);
end
$$;

-- As PESSOAS da fotografia. A chave primária é (snapshot_id, person_id): a
-- deduplicação por pessoa é estrutural, não um `distinct` que alguém pode
-- esquecer de escrever.
create table if not exists public.event_invite_snapshot_people (
  snapshot_id uuid not null references public.event_invite_snapshots(id) on delete cascade,
  person_id   uuid not null references public.event_people(id) on delete restrict,
  primary key (snapshot_id, person_id)
);

comment on table public.event_invite_snapshots is
  'Fotografia da lista de convidados no encerramento do período de convites, com data, autor e versão. É daqui que sai o total OFICIAL de convidados; nunca de um count() vivo de event_people ou event_invitations.';

comment on table public.event_invite_snapshot_people is
  'Pessoas da fotografia. PK (snapshot_id, person_id): deduplicação POR PESSOA imposta pela chave, não por um distinct na consulta.';

-- Fotografia é imutável. Sem isto, "total de convidados com data e versão" é só
-- uma linha que alguém pode editar depois do fato -- que é precisamente o que a
-- decisão pedia para evitar.
create or replace function public.event_invite_snapshots_imutavel()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'event_invite_snapshots: fotografia de convites é imutável (snapshot %, versão %). Encerre uma versão NOVA.', old.id, old.versao
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists event_invite_snapshots_imutavel on public.event_invite_snapshots;
create trigger event_invite_snapshots_imutavel
  before update on public.event_invite_snapshots
  for each row execute function public.event_invite_snapshots_imutavel();

-- ---------------------------------------------------------------------------
-- 4. event_checkins -- presença física, auditável
-- ---------------------------------------------------------------------------
create table if not exists public.event_checkins (
  id uuid primary key default gen_random_uuid(),
  event_id  uuid not null,
  person_id uuid not null,

  -- 'ativo'     -> é este o registro que conta no denominador
  -- 'corrigido' -> substituído por outro registro (que aponta para este)
  -- 'anulado'   -> a pessoa NÃO esteve presente; registro mantido para auditoria
  estado text not null default 'ativo',

  -- REGRA: horário atribuído pelo SERVIDOR, nunca enviado pelo cliente. Três
  -- camadas, porque uma só não cobre todos os papéis:
  --   privilégio -> anon e authenticated não têm INSERT/UPDATE nenhum aqui;
  --   default    -> quem não informa recebe now();
  --   gatilho    -> quem INFORMA tem o valor DESCARTADO e trocado por now(),
  --                 inclusive service_role. É o que impede antedatar presença
  --                 para dentro de uma janela já encerrada.
  registrado_em timestamptz not null default now(),

  -- QUEM confirmou. `_nome` e `_papel` são obrigatórios: check-in sem
  -- responsável identificado não é presença auditável, é uma linha anônima.
  -- `_uid` é opcional porque a operação pode estar na porta com um aparelho
  -- compartilhado, mas o nome e o papel nunca faltam.
  confirmado_por_uid   uuid references auth.users(id) on delete set null,
  confirmado_por_nome  text not null,
  confirmado_por_papel text not null,

  -- "mediante confirmação presencial": é uma AFIRMAÇÃO registrada, com CHECK
  -- que só aceita verdadeiro. Existe como coluna, e não como comentário, para
  -- que o registro diga o que foi afirmado no momento do check-in.
  confirmacao_presencial boolean not null default true,

  -- Entrada avulsa: compareceu SEM convite anterior. Congelado no instante do
  -- check-in (é um fato sobre aquele momento) e imutável depois -- um convite
  -- enviado DEPOIS do evento não transforma retroativamente um walk-in em
  -- convidado.
  avulso boolean not null default false,

  -- Auditoria da correção: o registro novo aponta para o que ele substitui, e o
  -- antigo continua na tabela com estado 'corrigido'. Não há sobrescrita cega.
  substitui_id uuid references public.event_checkins(id) on delete set null,
  motivo text,
  corrigido_em  timestamptz,
  corrigido_por text,

  created_at timestamptz not null default now(),

  foreign key (event_id, person_id)
    references public.event_people (event_id, id) on delete cascade
);

do $$
begin
  alter table public.event_checkins drop constraint if exists event_checkins_estado_check;
  alter table public.event_checkins add constraint event_checkins_estado_check
    check (estado in ('ativo', 'corrigido', 'anulado'));

  alter table public.event_checkins drop constraint if exists event_checkins_papel_check;
  alter table public.event_checkins add constraint event_checkins_papel_check
    check (confirmado_por_papel in ('host', 'operacao', 'admin'));

  alter table public.event_checkins drop constraint if exists event_checkins_nome_check;
  alter table public.event_checkins add constraint event_checkins_nome_check
    check (length(btrim(confirmado_por_nome)) > 0);

  -- Presença sem confirmação presencial não existe neste modelo.
  alter table public.event_checkins drop constraint if exists event_checkins_presencial_check;
  alter table public.event_checkins add constraint event_checkins_presencial_check
    check (confirmacao_presencial);

  -- Sair de 'ativo' exige motivo e autor: é o que torna a correção AUDITADA em
  -- vez de só diferente.
  alter table public.event_checkins drop constraint if exists event_checkins_correcao_check;
  alter table public.event_checkins add constraint event_checkins_correcao_check
    check (
      estado = 'ativo'
      or (motivo is not null and length(btrim(motivo)) > 0
          and corrigido_em is not null and corrigido_por is not null)
    );
end
$$;

-- UM ÚNICO REGISTRO ATIVO POR PESSOA E EVENTO. Índice parcial em vez de
-- constraint porque os registros 'corrigido' e 'anulado' PRECISAM coexistir com
-- o ativo -- é deles que o histórico é feito.
create unique index if not exists event_checkins_ativo_unico_idx
  on public.event_checkins (event_id, person_id)
  where estado = 'ativo';

create index if not exists event_checkins_evento_idx
  on public.event_checkins (event_id, estado);

create index if not exists event_checkins_pessoa_idx
  on public.event_checkins (person_id, estado);

comment on table public.event_checkins is
  'Presença física registrada e auditável. Um único registro ATIVO por (evento, pessoa); horário pelo relógio do servidor; quem confirmou é obrigatório; correção preserva o registro anterior. authenticated NÃO tem privilégio de escrita aqui -- o participante não consegue se declarar presente pelo aplicativo nem com token próprio.';

-- 4.1 Relógio do servidor, imutabilidade do fato e proibição de autodeclaração.
create or replace function public.event_checkins_integridade()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mesma_pessoa boolean;
begin
  if tg_op = 'INSERT' then
    -- Relógio do servidor: o valor informado é DESCARTADO, não validado.
    new.registrado_em := now();

    -- Ninguém confirma a própria presença. Esta é a trava que sobrevive até ao
    -- caminho de service_role: o privilégio de tabela já impede o participante
    -- de inserir, mas uma rota administrativa distraída poderia inserir um
    -- check-in "confirmado" pelo próprio uid da pessoa, e aí a confirmação
    -- presencial viraria autodeclaração com outro nome.
    if new.confirmado_por_uid is not null then
      select exists (
        select 1
        from public.event_people ep
        join public.participants p on p.id = ep.participant_id
        where ep.id = new.person_id
          and p.user_id = new.confirmado_por_uid
      ) into v_mesma_pessoa;

      if v_mesma_pessoa then
        raise exception
          'event_checkins: a própria pessoa não confirma a presença dela (pessoa %, uid %)',
          new.person_id, new.confirmado_por_uid
          using errcode = 'check_violation';
      end if;
    end if;

    return new;
  end if;

  -- UPDATE: o FATO registrado é imutável. O que pode mudar é só o desfecho de
  -- auditoria (estado, motivo, autor e data da correção). Sem isto, "correção
  -- auditada" seria um UPDATE que apaga o que havia antes -- a sobrescrita cega
  -- que a decisão proíbe.
  if new.id                     is distinct from old.id
     or new.event_id            is distinct from old.event_id
     or new.person_id           is distinct from old.person_id
     or new.registrado_em       is distinct from old.registrado_em
     or new.confirmado_por_uid  is distinct from old.confirmado_por_uid
     or new.confirmado_por_nome is distinct from old.confirmado_por_nome
     or new.confirmado_por_papel is distinct from old.confirmado_por_papel
     or new.confirmacao_presencial is distinct from old.confirmacao_presencial
     or new.avulso              is distinct from old.avulso
     or new.substitui_id        is distinct from old.substitui_id
     or new.created_at          is distinct from old.created_at
  then
    raise exception
      'event_checkins: registro de presença % é imutável; em UPDATE só estado, motivo, corrigido_em e corrigido_por podem mudar. Correção se faz com registro NOVO.',
      old.id
      using errcode = 'check_violation';
  end if;

  -- Estado não volta para 'ativo': ressuscitar um registro corrigido faria dois
  -- ativos ou apagaria a correção. Presença de volta se registra com linha nova.
  if old.estado <> 'ativo' and new.estado = 'ativo' then
    raise exception
      'event_checkins: registro % está % e não volta para ativo; registre um check-in NOVO',
      old.id, old.estado
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists event_checkins_integridade on public.event_checkins;
create trigger event_checkins_integridade
  before insert or update on public.event_checkins
  for each row execute function public.event_checkins_integridade();

-- ---------------------------------------------------------------------------
-- 5. event_checkin_closures -- o encerramento formal, pelo administrador
-- ---------------------------------------------------------------------------
-- Sem encerramento não existe universo oficial de presentes, e sem universo
-- oficial a cobertura não é calculável (é o motivo `checkin_aberto`).
create table if not exists public.event_checkin_closures (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  versao int not null,

  fechado_em      timestamptz not null default now(),
  fechado_por     text not null,
  fechado_por_uid uuid references auth.users(id) on delete set null,

  -- Quantos presentes havia NO FECHAMENTO. Guardado, e não recalculado, para
  -- que se saiba depois se o número mudou -- é a prova de que houve correção.
  total_presentes_no_fechamento int not null,

  -- Reabertura: encerra a vigência desta versão. O próximo encerramento é a
  -- versão seguinte.
  reaberto_em       timestamptz,
  reaberto_por      text,
  motivo_reabertura text,

  -- INVALIDAÇÃO: qualquer correção de presença (ou de elegibilidade, disparada
  -- de fora por marco_zero_invalidar_dna) depois deste fechamento invalida a
  -- aprovação e o hash do DNA correspondente. Aqui fica o marcador; o histórico
  -- de cada disparo fica em event_dna_invalidations.
  invalidado_em     timestamptz,
  invalidado_motivo text,

  created_at timestamptz not null default now(),

  unique (event_id, versao)
);

do $$
begin
  alter table public.event_checkin_closures drop constraint if exists event_checkin_closures_versao_check;
  alter table public.event_checkin_closures add constraint event_checkin_closures_versao_check
    check (versao >= 1 and total_presentes_no_fechamento >= 0);

  alter table public.event_checkin_closures drop constraint if exists event_checkin_closures_reabertura_check;
  alter table public.event_checkin_closures add constraint event_checkin_closures_reabertura_check
    check (
      (reaberto_em is null and reaberto_por is null)
      or (reaberto_em is not null and reaberto_por is not null)
    );
end
$$;

-- No máximo UM fechamento vigente por evento. Dois vigentes significariam dois
-- universos oficiais ao mesmo tempo.
create unique index if not exists event_checkin_closures_vigente_idx
  on public.event_checkin_closures (event_id)
  where reaberto_em is null;

comment on table public.event_checkin_closures is
  'Encerramento formal do check-in pelo administrador, com data, autor e versão. No máximo um vigente por evento. invalidado_em marca que houve correção de presença ou elegibilidade DEPOIS do fechamento -- o que invalida a aprovação e o hash do DNA daquele fechamento.';

-- ---------------------------------------------------------------------------
-- 6. event_dna_invalidations -- o ponto único onde a invalidação é disparada
-- ---------------------------------------------------------------------------
-- O DNA Coletivo NÃO é implementado aqui. O que esta tabela entrega é o SINAL
-- que a unidade do DNA precisa respeitar: uma linha por disparo, com origem,
-- autor do fato e o fechamento afetado. `reconhecido_em` é preenchido por quem
-- registrar a NOVA aprovação -- enquanto estiver nulo, há invalidação pendente.
create table if not exists public.event_dna_invalidations (
  id uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  closure_id uuid references public.event_checkin_closures(id) on delete set null,

  origem  text not null,
  detalhe text,

  -- Sem FK para event_checkins: a linha de invalidação tem de sobreviver ao
  -- desaparecimento do check-in que a causou (é registro de auditoria, não
  -- ponteiro vivo).
  checkin_id uuid,
  person_id  uuid,

  disparado_em timestamptz not null default now(),

  reconhecido_em  timestamptz,
  reconhecido_por text
);

do $$
begin
  alter table public.event_dna_invalidations drop constraint if exists event_dna_invalidations_origem_check;
  alter table public.event_dna_invalidations add constraint event_dna_invalidations_origem_check
    check (origem in (
      'checkin_registrado', 'checkin_corrigido', 'checkin_anulado',
      'elegibilidade', 'manual'
    ));
end
$$;

create index if not exists event_dna_invalidations_evento_idx
  on public.event_dna_invalidations (event_id, disparado_em desc);

create index if not exists event_dna_invalidations_pendentes_idx
  on public.event_dna_invalidations (event_id)
  where reconhecido_em is null;

comment on table public.event_dna_invalidations is
  'Disparos de invalidação da aprovação e do hash do DNA Coletivo: correção de presença depois do encerramento, ou mudança de elegibilidade avisada por marco_zero_invalidar_dna. O DNA em si é outra unidade; esta tabela é o contrato entre as duas.';

-- 6.1 O disparo automático. Fica em gatilho, e não na função de correção,
-- porque uma escrita direta em event_checkins por service_role (rota futura,
-- correção manual em psql) também tem de invalidar. Regra na aplicação
-- invalidaria apenas o caminho que alguém lembrou de instrumentar.
create or replace function public.event_checkins_invalida_dna()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_closure_id uuid;
  v_origem     text;
  v_detalhe    text;
  v_linha      public.event_checkins;
begin
  v_linha := case when tg_op = 'DELETE' then old else new end;

  select c.id into v_closure_id
  from public.event_checkin_closures c
  where c.event_id = v_linha.event_id
    and c.reaberto_em is null
  order by c.versao desc
  limit 1;

  -- Sem fechamento vigente não há aprovação para invalidar: check-in durante o
  -- evento é o fluxo normal, não uma correção.
  if v_closure_id is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_origem  := 'checkin_registrado';
    v_detalhe := format('presença registrada depois do encerramento (check-in %s)', new.id);
  elsif tg_op = 'DELETE' then
    v_origem  := 'checkin_anulado';
    v_detalhe := format('registro de presença removido depois do encerramento (check-in %s)', old.id);
  elsif new.estado = 'anulado' then
    v_origem  := 'checkin_anulado';
    v_detalhe := format('presença anulada depois do encerramento (check-in %s): %s', new.id, coalesce(new.motivo, '-'));
  else
    v_origem  := 'checkin_corrigido';
    v_detalhe := format('presença corrigida depois do encerramento (check-in %s -> %s): %s',
                        new.id, new.estado, coalesce(new.motivo, '-'));
  end if;

  insert into public.event_dna_invalidations
    (event_id, closure_id, origem, detalhe, checkin_id, person_id)
  values
    (v_linha.event_id, v_closure_id, v_origem, v_detalhe, v_linha.id, v_linha.person_id);

  update public.event_checkin_closures c
  set invalidado_em     = coalesce(c.invalidado_em, now()),
      invalidado_motivo = v_detalhe
  where c.id = v_closure_id;

  return null;
end;
$$;

-- AFTER, e por linha: o estado final da linha é o que importa, e o disparo não
-- pode impedir a correção legítima de acontecer.
drop trigger if exists event_checkins_invalida_dna on public.event_checkins;
create trigger event_checkins_invalida_dna
  after insert or update or delete on public.event_checkins
  for each row execute function public.event_checkins_invalida_dna();

-- ---------------------------------------------------------------------------
-- 7. RLS e privilégios -- a parte que o participante não atravessa
-- ---------------------------------------------------------------------------
-- ORDEM IMPORTA, e errar aqui produz falso conserto silencioso (lição da 014 e
-- da 010): privilégio de COLUNA não subtrai de privilégio de TABELA, e o
-- Supabase concede os privilégios do schema public a anon e authenticated por
-- default privilege. Revoga-se a TABELA primeiro; só então o que existe é o que
-- foi reconcedido explicitamente.
--
-- O desenho é o mesmo da 018, e para event_checkins é o ponto central desta
-- migration: `authenticated` recebe SELECT e NADA de escrita. Não existe policy
-- de INSERT/UPDATE/DELETE em nenhuma destas tabelas -- e, mesmo que alguém crie
-- uma amanhã, o privilégio revogado barra antes de a policy ser avaliada. É por
-- isso que "o participante não se declara presente" é PRIVILÉGIO aqui, e não
-- só política: política se reabre com uma policy nova; privilégio não.
do $$
declare
  t text;
begin
  foreach t in array array[
    'public.event_people',
    'public.event_invitations',
    'public.event_invite_snapshots',
    'public.event_invite_snapshot_people',
    'public.event_checkins',
    'public.event_checkin_closures',
    'public.event_dna_invalidations'
  ] loop
    execute format('alter table %s enable row level security', t);

    execute format('revoke all on table %s from anon', t);
    execute format('revoke all on table %s from authenticated', t);

    -- TRUNCATE, TRIGGER e REFERENCES não passam por RLS (ver 016). O revoke all
    -- acima já os cobre; explícito para que uma reconcessão futura de SELECT não
    -- traga os três de volta de carona.
    execute format('revoke truncate, trigger, references on table %s from anon', t);
    execute format('revoke truncate, trigger, references on table %s from authenticated', t);

    -- O admin entra como `authenticated` com app_metadata.role = 'admin', então
    -- precisa do privilégio de SELECT; quem recorta por pessoa é a policy. O
    -- participante também é `authenticated`, mas is_admin() é false para ele e a
    -- policy devolve ZERO linha. anon não recebe nada: nem chega na policy.
    execute format('grant select on table %s to authenticated', t);

    -- Escrita: só service_role, que é por onde as rotas administrativas passam
    -- e que ignora RLS por desenho da plataforma.
    execute format('grant select, insert, update, delete on table %s to service_role', t);

    execute format('drop policy if exists %I on %s',
                   replace(replace(t, 'public.', ''), '.', '_') || '_admin_read', t);
    execute format('create policy %I on %s for select using (public.is_admin())',
                   replace(replace(t, 'public.', ''), '.', '_') || '_admin_read', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Parâmetros dos gates do DNA
-- ---------------------------------------------------------------------------
-- Os três gates de publicação, num lugar só, para que a conta do banco e a do
-- TypeScript sejam comparáveis em vez de parecidas. Ver LIMITAÇÃO 1 no fim.
create or replace view public.marco_zero_parametros_dna as
select
  30 as minimo_respostas_validas,
  90 as cobertura_minima_percentual,
  5  as piso_supressao_por_recorte;

comment on view public.marco_zero_parametros_dna is
  'Gates de publicação do DNA Coletivo: >= 30 questionários completos e válidos entre os presentes, cobertura >= 90% dos presentes, piso de supressão de 5 pessoas por recorte. Deve bater com components/features/marco-zero/dna-coletivo-modelo.ts e dna-coletivo-protecao.ts.';

revoke all on table public.marco_zero_parametros_dna from anon;
grant select on table public.marco_zero_parametros_dna to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. marco_zero_respostas_validas -- o que conta como questionário VÁLIDO e COMPLETO
-- ---------------------------------------------------------------------------
-- A regra, escrita num lugar só para que ninguém a reescreva de memória numa
-- consulta de painel:
--
--   COMPLETO = existe resposta para TODAS as etapas da versão de quiz VIGENTE
--              do evento (events.quiz_version -> quiz_stages.quiz_version).
--   VÁLIDO   = completo, todas as respostas são objetos JSON NÃO VAZIOS, e o
--              participante tem completed_at (a marca de conclusão).
--
-- Pessoa sem participante vinculado é, por construção, não-completa: ela não
-- respondeu nada. E continua no DENOMINADOR -- é todo o ponto do modelo.
--
-- LEVANTA em vez de devolver zero quando a versão do quiz não tem etapa alguma
-- cadastrada: sem etapas não existe definição de "completo", e devolver
-- `0 válidos` seria afirmar que ninguém respondeu quando a verdade é que não se
-- sabe o que perguntar.
--
-- SECURITY DEFINER: a contagem tem de ser a contagem REAL. Com direitos de
-- invocador, um chamador sem privilégio receberia zero linha da RLS e leria
-- isso como "zero respondentes" -- um número errado em vez de um erro. O
-- EXECUTE é revogado de anon, authenticated e PUBLIC no bloco da seção 12.
create or replace function public.marco_zero_respostas_validas(p_event_id uuid)
returns table (
  person_id        uuid,
  participant_id   uuid,
  etapas_exigidas  int,
  etapas_respondidas int,
  completo         boolean,
  valido           boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quiz_version int;
  v_etapas       int;
begin
  select e.quiz_version into v_quiz_version
  from public.events e where e.id = p_event_id;

  if not found then
    raise exception 'marco_zero: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select count(*) into v_etapas
  from public.quiz_stages qs where qs.quiz_version = v_quiz_version;

  if v_etapas = 0 then
    raise exception
      'marco_zero: quiz_version % (evento %) não tem etapa alguma em quiz_stages; não há definição de questionário COMPLETO para comparar',
      v_quiz_version, p_event_id
      using errcode = 'no_data_found';
  end if;

  return query
  select
    ep.id,
    ep.participant_id,
    v_etapas,
    coalesce(r.respondidas, 0)::int,
    coalesce(r.respondidas, 0) = v_etapas,
    coalesce(r.respondidas, 0) = v_etapas
      and coalesce(r.nao_vazias, 0) = v_etapas
      and p.completed_at is not null
  from public.event_people ep
  left join public.participants p on p.id = ep.participant_id
  left join lateral (
    select
      count(distinct qr.stage_id) as respondidas,
      count(distinct qr.stage_id) filter (
        where jsonb_typeof(qr.answers) = 'object' and qr.answers <> '{}'::jsonb
      ) as nao_vazias
    from public.quiz_responses qr
    join public.quiz_stages qs
      on qs.id = qr.stage_id and qs.quiz_version = v_quiz_version
    where qr.participant_id = p.id
  ) r on true
  where ep.event_id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. marco_zero_cobertura -- O DENOMINADOR OFICIAL
-- ---------------------------------------------------------------------------
--   Cobertura = (presentes com questionário válido e completo
--                / total de presentes confirmados) × 100
--
-- Devolve UMA linha. Nunca devolve percentual aproximado: ou o número é o
-- oficial (status = 'ok'), ou é NULL com motivo (status = 'indisponivel').
-- "Não consegui verificar" é um resultado distinto de "reprovado": reprovado
-- aparece em gate_* = false COM percentual; não-verificável aparece em
-- status = 'indisponivel' com percentual NULL.
--
-- A comparação dos gates é feita em ARITMÉTICA INTEIRA
-- (respondentes * 100 >= 90 * presentes), igual à do TypeScript, para que a
-- decisão nunca dependa de arredondamento de ponto flutuante. O percentual
-- devolvido é numeric exato, sem arredondar: quem exibe trunca (89,96% não pode
-- aparecer como 90,0%), e truncar é decisão de apresentação, não de banco.
create or replace function public.marco_zero_cobertura(p_event_id uuid)
returns table (
  event_id uuid,

  -- 'ok' | 'indisponivel'
  status text,
  -- NULL quando ok; senão 'checkin_aberto' | 'sem_presentes' | 'quiz_sem_etapas'
  motivo text,

  checkin_fechado boolean,
  fechado_em      timestamptz,
  fechado_por     text,
  closure_versao  int,

  -- Correção de presença/elegibilidade depois do fechamento: a aprovação e o
  -- hash do DNA daquele fechamento estão invalidados. Os NÚMEROS abaixo seguem
  -- exatos e atuais -- o que caducou é a aprovação, não a contagem.
  aprovacao_invalidada boolean,
  invalidado_em        timestamptz,
  invalidacoes_pendentes int,

  -- Total de convidados: a fotografia versionada. NULL com motivo próprio
  -- quando não há fotografia ou quando ela não fecha com as pessoas dela.
  convidados            int,
  motivo_convidados     text,
  convite_snapshot_versao int,
  convite_encerrado_em  timestamptz,

  -- O DENOMINADOR. Contagem exata de registros ATIVOS de presença.
  presentes          int,
  presentes_avulsos  int,

  -- O NUMERADOR. NULL só quando não existe definição de "completo".
  respondentes_validos int,

  -- Presentes que NÃO responderam validamente. Continuam no denominador: é a
  -- diferença que o modelo do DNA é obrigado a mostrar.
  presentes_sem_resposta int,

  cobertura_percentual numeric,

  gate_minimo_respostas boolean,
  gate_cobertura        boolean,
  minimo_respostas      int,
  cobertura_minima_percentual int,
  piso_supressao        int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quiz_version int;
  v_etapas       int;

  v_fech_id      uuid;
  v_fech_versao  int;
  v_fech_em      timestamptz;
  v_fech_por     text;
  v_fech_inval   timestamptz;
  v_pendentes    int;

  v_snap_id      uuid;
  v_snap_versao  int;
  v_snap_em      timestamptz;
  v_snap_total   int;
  v_snap_pessoas int;

  v_convidados   int;
  v_motivo_conv  text;

  v_pres         int;
  v_avulsos      int;
  v_resp         int;

  v_status       text;
  v_motivo       text;
  v_cob          numeric;
  v_gate_min     boolean;
  v_gate_cob     boolean;

  v_min_respostas int;
  v_min_cobertura int;
  v_piso          int;
begin
  select e.quiz_version into v_quiz_version
  from public.events e where e.id = p_event_id;

  -- Evento inexistente LEVANTA. Não existe resposta "indisponível" para uma
  -- pergunta sobre um evento que não existe: devolver uma linha de zeros faria
  -- um erro de chamada parecer um evento vazio.
  if not found then
    raise exception 'marco_zero_cobertura: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select p.minimo_respostas_validas, p.cobertura_minima_percentual, p.piso_supressao_por_recorte
    into v_min_respostas, v_min_cobertura, v_piso
  from public.marco_zero_parametros_dna p;

  select count(*) into v_etapas
  from public.quiz_stages qs where qs.quiz_version = v_quiz_version;

  -- Fechamento vigente (no máximo um, pelo índice parcial).
  select c.id, c.versao, c.fechado_em, c.fechado_por, c.invalidado_em
    into v_fech_id, v_fech_versao, v_fech_em, v_fech_por, v_fech_inval
  from public.event_checkin_closures c
  where c.event_id = p_event_id and c.reaberto_em is null
  order by c.versao desc
  limit 1;

  select count(*) into v_pendentes
  from public.event_dna_invalidations i
  where i.event_id = p_event_id and i.reconhecido_em is null;

  -- O denominador.
  select count(*), count(*) filter (where ck.avulso)
    into v_pres, v_avulsos
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.estado = 'ativo';

  -- Total de convidados: fotografia, com verificação de integridade.
  select s.id, s.versao, s.encerrado_em, s.total_convidados
    into v_snap_id, v_snap_versao, v_snap_em, v_snap_total
  from public.event_invite_snapshots s
  where s.event_id = p_event_id
  order by s.versao desc
  limit 1;

  if v_snap_id is null then
    v_convidados  := null;
    v_motivo_conv := 'sem_snapshot_de_convites';
  else
    select count(*) into v_snap_pessoas
    from public.event_invite_snapshot_people sp
    where sp.snapshot_id = v_snap_id;

    if v_snap_total <> v_snap_pessoas then
      -- O banco desmente o próprio total: não se escolhe um dos dois.
      v_convidados  := null;
      v_motivo_conv := 'snapshot_inconsistente';
    else
      v_convidados  := v_snap_total;
      v_motivo_conv := null;
    end if;
  end if;

  -- O numerador: presentes (registro ATIVO) com questionário válido e completo.
  if v_etapas = 0 then
    v_resp := null;
  else
    select count(*) into v_resp
    from public.event_checkins ck
    join public.marco_zero_respostas_validas(p_event_id) v on v.person_id = ck.person_id
    where ck.event_id = p_event_id
      and ck.estado = 'ativo'
      and v.valido;
  end if;

  -- Status da COBERTURA. A ordem das recusas é a ordem da gravidade: sem
  -- definição de completo nem faz sentido falar de numerador; sem encerramento
  -- não há universo; com universo vazio a divisão é indefinida.
  if v_etapas = 0 then
    v_status := 'indisponivel';
    v_motivo := 'quiz_sem_etapas';
  elsif v_fech_id is null then
    v_status := 'indisponivel';
    v_motivo := 'checkin_aberto';
  elsif v_pres = 0 then
    v_status := 'indisponivel';
    v_motivo := 'sem_presentes';
  else
    v_status := 'ok';
    v_motivo := null;
    v_cob    := (v_resp::numeric * 100) / v_pres;
  end if;

  -- O gate de volume é uma contagem, então existe mesmo com o check-in aberto
  -- (e aí é provisório, dito por checkin_fechado = false). O gate de cobertura
  -- só existe quando a cobertura é oficial.
  v_gate_min := case when v_resp is null then null else v_resp >= v_min_respostas end;
  v_gate_cob := case
                  when v_status = 'ok' then v_resp * 100 >= v_min_cobertura * v_pres
                  else null
                end;

  return query select
    p_event_id,
    v_status,
    v_motivo,
    v_fech_id is not null,
    v_fech_em,
    v_fech_por,
    v_fech_versao,
    v_fech_inval is not null,
    v_fech_inval,
    v_pendentes,
    v_convidados,
    v_motivo_conv,
    v_snap_versao,
    v_snap_em,
    v_pres,
    v_avulsos,
    v_resp,
    case when v_resp is null then null else v_pres - v_resp end,
    v_cob,
    v_gate_min,
    v_gate_cob,
    v_min_respostas,
    v_min_cobertura,
    v_piso;
end;
$$;

comment on function public.marco_zero_cobertura(uuid) is
  'Denominador oficial e cobertura do Marco Zero: (presentes com questionário válido e completo / presentes confirmados) x 100. Nunca devolve percentual aproximado: status = indisponivel + motivo quando não é calculável. Reprovado (gate_* = false com percentual) é resultado DIFERENTE de não-verificável.';

-- ---------------------------------------------------------------------------
-- 11. Funções de escrita -- o único caminho pretendido
-- ---------------------------------------------------------------------------
-- NÃO são SECURITY DEFINER, de propósito e ao contrário das duas funções de
-- leitura acima. Função definidora que ESCREVE presença seria uma porta que
-- depende apenas do EXECUTE continuar revogado: no dia em que alguém conceder
-- execute a authenticated por engano, ela escreveria com os privilégios do dono
-- e o participante marcaria a própria presença -- exatamente o que esta
-- migration existe para impedir. Com direitos de invocador, o privilégio de
-- tabela revogado barra de novo, por baixo. Duas camadas, não uma.

-- 11.1 Cadastrar/atualizar pessoa. Dedup por (evento, e-mail minúsculo).
create or replace function public.marco_zero_pessoa_registrar(
  p_event_id       uuid,
  p_full_name      text,
  p_email          text default null,
  p_phone          text default null,
  p_origem         text default 'lista_convite',
  p_participant_id uuid default null,
  p_registrado_por text default null
)
returns table (id uuid, criado boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_email is not null then
    select ep.id into v_id
    from public.event_people ep
    where ep.event_id = p_event_id and lower(ep.email) = lower(p_email);
  end if;

  if v_id is not null then
    -- Reaproveita a pessoa: convidar de novo NÃO cria pessoa nova. É aqui que
    -- "três convites, uma pessoa" acontece na prática.
    update public.event_people ep
    set full_name      = coalesce(nullif(btrim(p_full_name), ''), ep.full_name),
        phone          = coalesce(p_phone, ep.phone),
        participant_id = coalesce(p_participant_id, ep.participant_id)
    where ep.id = v_id;

    return query select v_id, false;
    return;
  end if;

  insert into public.event_people
    (event_id, participant_id, full_name, email, phone, origem, registrado_por)
  values
    (p_event_id, p_participant_id, btrim(p_full_name), lower(nullif(btrim(p_email), '')),
     p_phone, p_origem, p_registrado_por)
  returning public.event_people.id into v_id;

  return query select v_id, true;
end;
$$;

-- 11.2 Registrar um ENVIO de convite. Tentativa = próxima da pessoa.
create or replace function public.marco_zero_convite_registrar(
  p_person_id   uuid,
  p_canal       text default 'email',
  p_destino     text default null,
  p_enviado_por text default null,
  p_status      text default 'enviado',
  p_erro        text default null
)
returns table (id uuid, tentativa int)
language plpgsql
set search_path = ''
as $$
declare
  v_event_id  uuid;
  v_tentativa int;
  v_id        uuid;
begin
  select ep.event_id into v_event_id
  from public.event_people ep where ep.id = p_person_id;

  if not found then
    raise exception 'marco_zero_convite_registrar: pessoa % não existe', p_person_id
      using errcode = 'foreign_key_violation';
  end if;

  select coalesce(max(i.tentativa), 0) + 1 into v_tentativa
  from public.event_invitations i where i.person_id = p_person_id;

  insert into public.event_invitations
    (event_id, person_id, canal, status, tentativa, enviado_por, destino, erro)
  values
    (v_event_id, p_person_id, p_canal, p_status, v_tentativa, p_enviado_por,
     coalesce(p_destino, (select ep.email from public.event_people ep where ep.id = p_person_id)),
     p_erro)
  returning public.event_invitations.id into v_id;

  return query select v_id, v_tentativa;
end;
$$;

-- 11.3 Encerrar o período de convites: a FOTOGRAFIA, com data e versão.
-- Conta PESSOAS distintas com ao menos um envio não cancelado. Deduplicação por
-- pessoa, imposta pela PK da tabela filha -- não por um `distinct` escrito aqui
-- que alguém possa esquecer num relatório paralelo.
create or replace function public.marco_zero_convites_encerrar(
  p_event_id      uuid,
  p_encerrado_por text,
  p_motivo        text default null
)
returns table (snapshot_id uuid, versao int, total_convidados int, encerrado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_versao int;
  v_id     uuid;
  v_total  int;
  v_em     timestamptz;
begin
  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'marco_zero_convites_encerrar: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  select coalesce(max(s.versao), 0) + 1 into v_versao
  from public.event_invite_snapshots s where s.event_id = p_event_id;

  -- O total é contado ANTES de a linha nascer, e a linha nasce já com ele. O
  -- caminho oposto (inserir com 0 e dar UPDATE depois) exigiria desarmar o
  -- gatilho de imutabilidade da fotografia -- isto é, abrir, ainda que por um
  -- instante, exatamente a porta que aquele gatilho existe para fechar.
  select count(*) into v_total
  from public.event_people ep
  where ep.event_id = p_event_id
    and exists (
      select 1 from public.event_invitations i
      where i.person_id = ep.id and i.status <> 'cancelado'
    );

  insert into public.event_invite_snapshots
    (event_id, versao, total_convidados, encerrado_por, motivo)
  values (p_event_id, v_versao, v_total, p_encerrado_por, p_motivo)
  returning public.event_invite_snapshots.id, public.event_invite_snapshots.encerrado_em
    into v_id, v_em;

  insert into public.event_invite_snapshot_people (snapshot_id, person_id)
  select v_id, ep.id
  from public.event_people ep
  where ep.event_id = p_event_id
    and exists (
      select 1 from public.event_invitations i
      where i.person_id = ep.id and i.status <> 'cancelado'
    );

  -- Duas consultas em READ COMMITTED podem ver instantes diferentes: um convite
  -- registrado entre elas faria o total divergir das pessoas da fotografia. Em
  -- vez de confiar na janela ser estreita, verifica-se -- e uma fotografia
  -- inconsistente NUNCA é gravada.
  if (select count(*) from public.event_invite_snapshot_people sp
      where sp.snapshot_id = v_id) <> v_total then
    raise exception
      'marco_zero_convites_encerrar: a lista mudou durante o encerramento do evento %; nenhuma fotografia foi gravada. Repita.',
      p_event_id
      using errcode = 'serialization_failure';
  end if;

  return query select v_id, v_versao, v_total, v_em;
end;
$$;

-- 11.4 Registrar presença. Host (Yuri) ou alguém autorizado da operação,
-- mediante confirmação presencial. Dois check-ins para a mesma pessoa NÃO
-- geram dois ativos: devolve o ativo que já existe, com criado = false.
create or replace function public.marco_zero_checkin_registrar(
  p_event_id    uuid,
  p_person_id   uuid,
  p_por_nome    text,
  p_por_papel   text default 'host',
  p_por_uid     uuid default null
)
returns table (id uuid, criado boolean, avulso boolean, registrado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_id      uuid;
  v_avulso  boolean;
  v_em      timestamptz;
begin
  if not exists (
    select 1 from public.event_people ep
    where ep.id = p_person_id and ep.event_id = p_event_id
  ) then
    raise exception 'marco_zero_checkin_registrar: pessoa % não é do evento %', p_person_id, p_event_id
      using errcode = 'foreign_key_violation';
  end if;

  select ck.id, ck.avulso, ck.registrado_em into v_id, v_avulso, v_em
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.person_id = p_person_id and ck.estado = 'ativo';

  if v_id is not null then
    return query select v_id, false, v_avulso, v_em;
    return;
  end if;

  -- Walk-in: compareceu SEM convite anterior. Congelado agora porque é um fato
  -- sobre este momento.
  v_avulso := not exists (
    select 1 from public.event_invitations i
    where i.person_id = p_person_id and i.status <> 'cancelado'
  );

  insert into public.event_checkins
    (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel,
     confirmacao_presencial, avulso)
  values
    (p_event_id, p_person_id, p_por_uid, p_por_nome, p_por_papel, true, v_avulso)
  returning public.event_checkins.id, public.event_checkins.registrado_em
    into v_id, v_em;

  return query select v_id, true, v_avulso, v_em;
end;
$$;

-- 11.5 Entrada AVULSA (walk-in) de quem não está nem no cadastro: cadastra a
-- pessoa e registra a presença numa transação. É o caso que a decisão do
-- responsável técnico exige suportar -- compareceu sem conta e sem convite, e
-- entra no denominador.
create or replace function public.marco_zero_checkin_avulso(
  p_event_id  uuid,
  p_full_name text,
  p_por_nome  text,
  p_por_papel text default 'host',
  p_email     text default null,
  p_phone     text default null,
  p_por_uid   uuid default null
)
returns table (person_id uuid, checkin_id uuid, avulso boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_person uuid;
  v_ck     record;
begin
  select r.id into v_person
  from public.marco_zero_pessoa_registrar(
    p_event_id, p_full_name, p_email, p_phone, 'walk_in', null, p_por_nome
  ) r;

  select * into v_ck
  from public.marco_zero_checkin_registrar(p_event_id, v_person, p_por_nome, p_por_papel, p_por_uid) x;

  return query select v_person, v_ck.id, v_ck.avulso;
end;
$$;

-- 11.6 CORREÇÃO AUDITADA: o registro antigo fica, com estado 'corrigido' e
-- motivo; o novo nasce apontando para ele por substitui_id. Não há sobrescrita.
create or replace function public.marco_zero_checkin_corrigir(
  p_checkin_id uuid,
  p_motivo     text,
  p_por_nome   text,
  p_por_papel  text default 'admin',
  p_por_uid    uuid default null
)
returns table (anterior_id uuid, novo_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_old public.event_checkins;
  v_new uuid;
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_corrigir: correção sem motivo não é correção auditada'
      using errcode = 'check_violation';
  end if;

  select * into v_old from public.event_checkins ck where ck.id = p_checkin_id;
  if not found then
    raise exception 'marco_zero_checkin_corrigir: check-in % não existe', p_checkin_id
      using errcode = 'no_data_found';
  end if;
  if v_old.estado <> 'ativo' then
    raise exception 'marco_zero_checkin_corrigir: check-in % já está % e não é o registro vigente', p_checkin_id, v_old.estado
      using errcode = 'check_violation';
  end if;

  -- Primeiro libera o índice parcial de "um ativo só", depois insere o novo.
  update public.event_checkins ck
  set estado = 'corrigido', motivo = p_motivo, corrigido_em = now(), corrigido_por = p_por_nome
  where ck.id = p_checkin_id;

  insert into public.event_checkins
    (event_id, person_id, confirmado_por_uid, confirmado_por_nome, confirmado_por_papel,
     confirmacao_presencial, avulso, substitui_id)
  values
    (v_old.event_id, v_old.person_id, p_por_uid, p_por_nome, p_por_papel,
     true, v_old.avulso, v_old.id)
  returning public.event_checkins.id into v_new;

  return query select v_old.id, v_new;
end;
$$;

-- 11.7 ANULAÇÃO auditada: a pessoa NÃO esteve presente. Sai do denominador sem
-- sair da tabela.
create or replace function public.marco_zero_checkin_anular(
  p_checkin_id uuid,
  p_motivo     text,
  p_por_nome   text
)
returns table (id uuid, estado text)
language plpgsql
set search_path = ''
as $$
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_anular: anulação sem motivo não é auditável'
      using errcode = 'check_violation';
  end if;

  return query
  update public.event_checkins ck
  set estado = 'anulado', motivo = p_motivo, corrigido_em = now(), corrigido_por = p_por_nome
  where ck.id = p_checkin_id and ck.estado = 'ativo'
  returning ck.id, ck.estado;
end;
$$;

-- 11.8 ENCERRAR o check-in. Só o administrador, pela rota que usa service_role.
create or replace function public.marco_zero_checkin_encerrar(
  p_event_id    uuid,
  p_fechado_por text,
  p_por_uid     uuid default null
)
returns table (closure_id uuid, versao int, total_presentes int, fechado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_versao int;
  v_total  int;
  v_id     uuid;
  v_em     timestamptz;
begin
  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'marco_zero_checkin_encerrar: evento % não existe', p_event_id
      using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from public.event_checkin_closures c
    where c.event_id = p_event_id and c.reaberto_em is null
  ) then
    raise exception 'marco_zero_checkin_encerrar: o check-in do evento % já está encerrado; reabra antes de encerrar de novo', p_event_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_total
  from public.event_checkins ck
  where ck.event_id = p_event_id and ck.estado = 'ativo';

  select coalesce(max(c.versao), 0) + 1 into v_versao
  from public.event_checkin_closures c where c.event_id = p_event_id;

  insert into public.event_checkin_closures
    (event_id, versao, fechado_por, fechado_por_uid, total_presentes_no_fechamento)
  values (p_event_id, v_versao, p_fechado_por, p_por_uid, v_total)
  returning public.event_checkin_closures.id, public.event_checkin_closures.fechado_em
    into v_id, v_em;

  return query select v_id, v_versao, v_total, v_em;
end;
$$;

-- 11.9 REABRIR: encerra a vigência da versão atual. O próximo encerramento é a
-- versão seguinte, e a reabertura em si já é motivo de invalidação.
create or replace function public.marco_zero_checkin_reabrir(
  p_event_id uuid,
  p_por_nome text,
  p_motivo   text
)
returns table (closure_id uuid, versao int)
language plpgsql
set search_path = ''
as $$
declare
  v_id     uuid;
  v_versao int;
begin
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'marco_zero_checkin_reabrir: reabertura sem motivo não é auditável'
      using errcode = 'check_violation';
  end if;

  update public.event_checkin_closures c
  set reaberto_em = now(), reaberto_por = p_por_nome, motivo_reabertura = p_motivo
  where c.event_id = p_event_id and c.reaberto_em is null
  returning c.id, c.versao into v_id, v_versao;

  if v_id is null then
    raise exception 'marco_zero_checkin_reabrir: o evento % não tem encerramento vigente', p_event_id
      using errcode = 'no_data_found';
  end if;

  perform public.marco_zero_invalidar_dna(
    p_event_id, 'manual',
    format('check-in reaberto (fechamento versão %s): %s', v_versao, p_motivo),
    v_id
  );

  return query select v_id, v_versao;
end;
$$;

-- 11.10 O ponto de invalidação chamável de FORA: mudança de ELEGIBILIDADE, que
-- esta unidade não governa, também invalida a aprovação e o hash do DNA. A
-- unidade do DNA chama isto (ou lê event_dna_invalidations) em vez de reimplementar
-- a regra.
create or replace function public.marco_zero_invalidar_dna(
  p_event_id   uuid,
  p_origem     text default 'elegibilidade',
  p_detalhe    text default null,
  p_closure_id uuid default null
)
returns table (id uuid, closure_id uuid, disparado_em timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_closure uuid;
  v_id      uuid;
  v_em      timestamptz;
begin
  v_closure := p_closure_id;

  if v_closure is null then
    select c.id into v_closure
    from public.event_checkin_closures c
    where c.event_id = p_event_id and c.reaberto_em is null
    order by c.versao desc
    limit 1;
  end if;

  insert into public.event_dna_invalidations (event_id, closure_id, origem, detalhe)
  values (p_event_id, v_closure, p_origem, p_detalhe)
  returning public.event_dna_invalidations.id, public.event_dna_invalidations.disparado_em
    into v_id, v_em;

  if v_closure is not null then
    update public.event_checkin_closures c
    set invalidado_em     = coalesce(c.invalidado_em, now()),
        invalidado_motivo = coalesce(p_detalhe, p_origem)
    where c.id = v_closure;
  end if;

  return query select v_id, v_closure, v_em;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Privilégio de EXECUÇÃO das funções
-- ---------------------------------------------------------------------------
-- Mesmo padrão da 018: PUBLIC, anon e authenticated sem EXECUTE; service_role
-- com EXECUTE. As rotas administrativas passam por service_role.
--
-- Vale para as duas funções de LEITURA também: `marco_zero_cobertura` é
-- SECURITY DEFINER, então conceder execute a authenticated entregaria a
-- contagem real a qualquer participante autenticado. O painel do admin lê isto
-- pela rota do servidor, como já faz com a fila da 018.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.marco_zero_respostas_validas(uuid)',
    'public.marco_zero_cobertura(uuid)',
    'public.marco_zero_pessoa_registrar(uuid,text,text,text,text,uuid,text)',
    'public.marco_zero_convite_registrar(uuid,text,text,text,text,text)',
    'public.marco_zero_convites_encerrar(uuid,text,text)',
    'public.marco_zero_checkin_registrar(uuid,uuid,text,text,uuid)',
    'public.marco_zero_checkin_avulso(uuid,text,text,text,text,text,uuid)',
    'public.marco_zero_checkin_corrigir(uuid,text,text,text,uuid)',
    'public.marco_zero_checkin_anular(uuid,text,text)',
    'public.marco_zero_checkin_encerrar(uuid,text,uuid)',
    'public.marco_zero_checkin_reabrir(uuid,text,text)',
    'public.marco_zero_invalidar_dna(uuid,text,text,uuid)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- ===========================================================================
-- LIMITAÇÕES, declaradas em vez de disfarçadas
-- ===========================================================================
-- 1. Os gates vivem em DOIS lugares, e não nos mesmos dois. Medido em
--    components/features/marco-zero/ no momento desta migration:
--      COBERTURA_MINIMA_PERCENTUAL = 90  (dna-coletivo-modelo.ts) -> igual aqui
--      PISO_DE_EXIBICAO            = 5   (dna-coletivo-protecao.ts) -> igual aqui
--      mínimo de 30 questionários        -> NÃO EXISTE no TypeScript. O `K` de
--        `passaBase` daquele arquivo é o PISO DE SUPRESSÃO (5), não o mínimo de
--        volume. Quem publicar o DNA tem de ler `gate_minimo_respostas` daqui,
--        ou o gate de 30 não existe em lugar nenhum do caminho.
--    Esta unidade não pode editar aqueles arquivos. A view é a fonte do lado do
--    banco, a igualdade dos dois valores que já existem é verificada na prova
--    (supabase/provas/020-cobertura.sql), e o terceiro está DECLARADO como
--    pendência de integração, não escondido.
--
-- 2. "Válido" aqui é validade ESTRUTURAL: todas as etapas da versão vigente
--    respondidas, respostas em objeto JSON não vazio e `completed_at` presente.
--    Validade SEMÂNTICA (resposta coerente, dimensão pontuável) é do motor de
--    scoring, não do banco. Se o motor passar a reprovar respostas que o banco
--    considera válidas, o numerador daqui será maior que o dele -- e aí a regra
--    tem de mudar num lugar só: esta função.
--
-- 3. O gatilho de invalidação cobre INSERT, UPDATE e DELETE em event_checkins.
--    NÃO cobre um `alter table ... disable trigger` nem a remoção em cascata de
--    um evento inteiro (que leva a tabela de invalidações junto, e nesse caso
--    não há mais DNA a invalidar). Mudança de ELEGIBILIDADE não é observável
--    daqui: quem a faz tem de chamar `marco_zero_invalidar_dna`. Isso é
--    contrato entre unidades, não trava de banco, e está dito.
--
-- 4. `marco_zero_convites_encerrar` não roda em transação serializável: ela
--    conta, grava e VERIFICA, e levanta `serialization_failure` se a lista
--    mudou no meio. Então o encerramento pode FALHAR sob concorrência e precisar
--    de nova tentativa -- falha fechado, sem gravar fotografia errada. Encerrar
--    convites é ato único do administrador, não caminho de alto volume: trocar
--    um retry raro por uma fotografia possivelmente inconsistente seria a troca
--    errada.
--
-- 5. DELETE em event_checkins continua possível para service_role (e é o que a
--    cascata de `delete_event_cascade`, da 005, precisa). Presença não é
--    apagada pelo fluxo normal -- anulação é o caminho auditado -- mas quem tem
--    service_role e escreve SQL à mão consegue apagar. O gatilho registra a
--    invalidação do DNA nesse caso; o registro em si, não há como preservar sem
--    tabela de histórico à parte, que foi considerada fora de escopo desta
--    unidade.
--
-- 6. Nenhuma destas tabelas é exposta a `authenticated` para escrita, e por isso
--    não existe caminho de aplicativo para o participante se declarar presente.
--    O que NÃO está coberto é uma rota de servidor futura que, com
--    service_role, aceite `person_id` vindo do cliente sem checar quem pediu --
--    isso é autorização de rota, não de banco. O gatilho de autodeclaração
--    (seção 4.1) é a única parte dessa classe que o banco consegue barrar, e
--    barra: ninguém confirma a própria presença.
