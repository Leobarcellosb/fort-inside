-- semear-cobertura.sql -- MASSA SINTETICA do ensaio "banco vs scoring".
--
-- Roda num banco DESCARTAVEL construido pelas MESMAS migrations de
-- supabase/migrations/ (scripts/drift/reference-db.sh). NUNCA em producao:
-- este arquivo ESCREVE. O orquestrador (scripts/ensaio-cobertura-vs-scoring.sh)
-- recusa alvo que nao seja 127.0.0.1.
--
-- Nada aqui e dado real. Os nomes sao a ETIQUETA DO CENARIO, de proposito: a
-- saida do ensaio tem de ser identificavel participante por participante, e nao
-- uma contagem agregada.
--
-- CENARIOS (os cinco pedidos pela revisao, mais os dois pedidos pelo dono, mais
-- quatro que fecham as combinacoes das tres nocoes de conclusao):
--   P01 completo-de-verdade .............. questionario completo de verdade
--   P02 resposta-vazia ................... etapa gravada com answers = '{}'
--   P03 alternativa-incompativel ......... q40 = "Z. ..." (fora do dominio)
--   P04 dimensao-incompleta .............. 12 dos 24 itens Likert
--   P05 conclusao-administrativa-indevida  completed_at sem resposta alguma
--   P06 versao-de-quiz-diferente ......... respostas gravadas na versao 1
--   P07 dimensao-inteira-faltando ........ 5 etapas, eixo integridade ausente
--   P08 so-as-dimensoes .................. 30 dimensoes perfeitas, 3 etapas ausentes
--   P09 sem-marca-de-conclusao ........... tudo respondido, completed_at NULL
--   P10 likert-fora-do-dominio ........... q16 = 9
--   P11 ausente-com-questionario-completo  completo e NAO presente
--
-- A escrita de presenca passa pelas FUNCOES OFICIAIS (marco_zero_pessoa_registrar,
-- marco_zero_checkin_registrar, marco_zero_checkin_encerrar): a massa nasce pelo
-- mesmo caminho que a producao usa, e nao por insert cru que driblaria gatilho.

\set ON_ERROR_STOP on

-- Guarda-corpo: so banco descartavel. A fonte de verdade e o orquestrador, mas
-- este arquivo tambem se recusa a rodar onde ja existe massa de gente real.
do $$
begin
  if exists (select 1 from public.events where event_code not like 'ENSAIO-%') then
    raise exception
      'semear-cobertura: este banco tem eventos que nao sao do ensaio (% evento(s)). Recuso semear fora de um alvo descartavel.',
      (select count(*) from public.events where event_code not like 'ENSAIO-%')
      using errcode = 'check_violation';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Construtores das respostas, por etapa do quiz_version = 2
-- ---------------------------------------------------------------------------
-- Ids das perguntas e dominios, como a migration 017 os define e como
-- lib/scoring/marco-zero.ts os le:
--   q1..q6    contexto (etapa 101)
--   q7..q13   elementos, inteiros 0..10   | q14,q15 abertas (etapa 102)
--   q16..q39  24 itens Likert, 1..5        (etapa 103)
--   q40..q45  6 situacionais, "A".."D"     (etapa 104)
--   q46..q52  abertas                      (etapa 105)

create or replace function ens_texto(p_de int, p_ate int, p_semente int)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg('q' || i, 'resposta sintetica ' || p_semente || ' para q' || i), '{}'::jsonb)
  from generate_series(p_de, p_ate) i;
$$;

/** Etapa 101: contexto. */
create or replace function ens_etapa101(p_semente int)
returns jsonb language sql immutable as $$
  select ens_texto(1, 6, p_semente);
$$;

/** Etapa 102: os sete elementos (0..10) mais duas abertas. */
create or replace function ens_etapa102(p_semente int)
returns jsonb language sql immutable as $$
  select (
    select coalesce(jsonb_object_agg('q' || i, ((p_semente + i) % 11)), '{}'::jsonb)
    from generate_series(7, 13) i
  ) || ens_texto(14, 15, p_semente);
$$;

/**
 * Etapa 103: os 24 itens Likert.
 *   p_ate      ultimo id incluido (39 = completo; 27 = so 12 itens)
 *   p_pular    ids a OMITIR (ex.: 34..39, o eixo integridade inteiro)
 *   p_fora     id que recebe valor FORA do dominio 1..5 (NULL = nenhum)
 */
create or replace function ens_etapa103(
  p_semente int,
  p_ate int default 39,
  p_pular int[] default '{}',
  p_fora int default null
)
returns jsonb language sql immutable as $$
  select coalesce(
    jsonb_object_agg(
      'q' || i,
      case when i = p_fora then 9 else 1 + ((p_semente + i) % 5) end
    ),
    '{}'::jsonb
  )
  from generate_series(16, p_ate) i
  where not (i = any(p_pular));
$$;

/**
 * Etapa 104: as 6 situacionais, no formato que a interface grava ("A. texto").
 *   p_incompativel  id que recebe uma letra FORA de A..D (NULL = nenhum)
 */
create or replace function ens_etapa104(p_semente int, p_incompativel int default null)
returns jsonb language sql immutable as $$
  select coalesce(
    jsonb_object_agg(
      'q' || i,
      case
        when i = p_incompativel then 'Z. alternativa que o questionario nao oferece.'
        else substr('ABCD', 1 + ((p_semente + i) % 4), 1) || '. opcao sintetica da situacional q' || i || '.'
      end
    ),
    '{}'::jsonb
  )
  from generate_series(40, 45) i;
$$;

/** Etapa 105: abertas. */
create or replace function ens_etapa105(p_semente int)
returns jsonb language sql immutable as $$
  select ens_texto(46, 52, p_semente);
$$;

-- ---------------------------------------------------------------------------
-- Montagem do evento e dos onze participantes sinteticos
-- ---------------------------------------------------------------------------
do $$
declare
  v_event  uuid;
  v_person uuid;
  v_part   uuid;
  v_sem    int;

  -- cenario, presente, marca de conclusao
  r record;
begin
  -- Evento na versao 2 do questionario (a do Marco Zero: 5 etapas, 52 perguntas).
  insert into public.events (name, event_code, event_date, status, quiz_version)
  values ('Ensaio banco vs scoring', 'ENSAIO-COBERTURA', now(), 'active', 2)
  returning id into v_event;

  for r in
    select * from (values
      ('P01', 'completo-de-verdade',                 true,  true ),
      ('P02', 'resposta-vazia',                      true,  true ),
      ('P03', 'alternativa-incompativel',            true,  true ),
      ('P04', 'dimensao-incompleta',                 true,  true ),
      ('P05', 'conclusao-administrativa-indevida',   true,  true ),
      ('P06', 'versao-de-quiz-diferente',            true,  true ),
      ('P07', 'dimensao-inteira-faltando',           true,  true ),
      ('P08', 'so-as-dimensoes',                     true,  true ),
      ('P09', 'sem-marca-de-conclusao',              true,  false),
      ('P10', 'likert-fora-do-dominio',              true,  true ),
      ('P11', 'ausente-com-questionario-completo',   false, true )
    ) as t(codigo, cenario, presente, concluido)
    order by 1
  loop
    v_sem := ('x' || substr(md5(r.codigo), 1, 4))::bit(16)::int;

    -- Participante (a conta): onde vive completed_at, a conclusao ADMINISTRATIVA.
    insert into public.participants (event_id, full_name, email, completed_at)
    values (
      v_event,
      r.codigo || ' ' || r.cenario,
      lower(r.codigo) || '@ensaio.invalid',
      case when r.concluido then now() else null end
    )
    returning id into v_part;

    -- Pessoa do evento (o denominador vive aqui) e o vinculo com a conta.
    select (public.marco_zero_pessoa_registrar(
              v_event,
              r.codigo || ' ' || r.cenario,
              lower(r.codigo) || '@ensaio.invalid',
              null,
              'lista_convite',
              v_part,
              'ensaio'
            )).id
      into v_person;

    -- Convite, para que a fotografia de convidados exista e a linha de
    -- cobertura saia completa (convidados nao e denominador, mas aparece nela).
    perform public.marco_zero_convite_registrar(v_person, 'email', lower(r.codigo) || '@ensaio.invalid', 'ensaio');

    if r.presente then
      perform public.marco_zero_checkin_registrar(v_event, v_person, 'ensaio', 'host');
    end if;

    -- -----------------------------------------------------------------------
    -- As respostas de cada cenario
    -- -----------------------------------------------------------------------
    if r.cenario = 'completo-de-verdade'
       or r.cenario = 'sem-marca-de-conclusao'
       or r.cenario = 'ausente-com-questionario-completo' then
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, ens_etapa103(v_sem)),
        (v_part, 104, ens_etapa104(v_sem)),
        (v_part, 105, ens_etapa105(v_sem));

    elsif r.cenario = 'resposta-vazia' then
      -- A etapa EXISTE e esta gravada, com objeto vazio.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, '{}'::jsonb),
        (v_part, 104, ens_etapa104(v_sem)),
        (v_part, 105, ens_etapa105(v_sem));

    elsif r.cenario = 'alternativa-incompativel' then
      -- q40 com uma letra que o questionario nao oferece.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, ens_etapa103(v_sem)),
        (v_part, 104, ens_etapa104(v_sem, 40)),
        (v_part, 105, ens_etapa105(v_sem));

    elsif r.cenario = 'dimensao-incompleta' then
      -- 12 dos 24 itens Likert (q16..q27). A etapa segue NAO VAZIA.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, ens_etapa103(v_sem, 27)),
        (v_part, 104, ens_etapa104(v_sem)),
        (v_part, 105, ens_etapa105(v_sem));

    elsif r.cenario = 'conclusao-administrativa-indevida' then
      -- Marcado como concluido e NENHUMA resposta gravada.
      null;

    elsif r.cenario = 'versao-de-quiz-diferente' then
      -- Respostas semanticamente perfeitas, gravadas nas etapas da VERSAO 1.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 1, ens_etapa101(v_sem)),
        (v_part, 2, ens_etapa102(v_sem)),
        (v_part, 3, ens_etapa103(v_sem)),
        (v_part, 4, ens_etapa104(v_sem)),
        (v_part, 5, ens_etapa105(v_sem));

    elsif r.cenario = 'dimensao-inteira-faltando' then
      -- As 5 etapas registradas e nao vazias; o eixo integridade (q34..q39) inteiro ausente.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, ens_etapa103(v_sem, 39, array[34,35,36,37,38,39])),
        (v_part, 104, ens_etapa104(v_sem)),
        (v_part, 105, ens_etapa105(v_sem));

    elsif r.cenario = 'so-as-dimensoes' then
      -- As 30 dimensoes perfeitas; as etapas 101, 102 e 105 nunca gravadas.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 103, ens_etapa103(v_sem)),
        (v_part, 104, ens_etapa104(v_sem));

    elsif r.cenario = 'likert-fora-do-dominio' then
      -- q16 = 9, fora de 1..5.
      insert into public.quiz_responses (participant_id, stage_id, answers) values
        (v_part, 101, ens_etapa101(v_sem)),
        (v_part, 102, ens_etapa102(v_sem)),
        (v_part, 103, ens_etapa103(v_sem, 39, '{}', 16)),
        (v_part, 104, ens_etapa104(v_sem)),
        (v_part, 105, ens_etapa105(v_sem));

    else
      raise exception 'semear-cobertura: cenario sem massa definida: %', r.cenario;
    end if;
  end loop;

  -- Fotografia de convidados e encerramento do check-in: sem o encerramento a
  -- cobertura do banco e, por regra, INDISPONIVEL -- e o ensaio nao mediria nada.
  perform public.marco_zero_convites_encerrar(v_event, 'ensaio', 'massa sintetica do ensaio');
  perform public.marco_zero_checkin_encerrar(v_event, 'ensaio');
end
$$;
