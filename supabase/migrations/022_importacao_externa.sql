-- 022_importacao_externa.sql
-- A PONTE ENTRE A COLETA FORA DO APLICATIVO E AS RESPOSTAS CANONICAS.
--
-- NAO APLICAR sem autorizacao nominal, como a 011, a 014 e as demais da serie.
-- Nenhuma das migrations 010 a 022 esta aplicada em lugar nenhum.
--
-- POR QUE EXISTE
-- --------------
-- A coleta pre-evento do Marco Zero (sabado 24/10/2026, 50 jovens) comecou por
-- Google Forms, nao pelo aplicativo: o e-mail transacional e a implantacao nao
-- estao liberados. Sem esta ponte, o portao de processamento e a fila ficam
-- prontos e NENHUM questionario externo e elegivel para entrar nela.
--
-- O QUE ELA GUARDA, e por que cada coisa esta aqui
-- ------------------------------------------------
--   external_submissions        uma linha por submissao externa, com a
--                               PROVENIENCIA inteira (regra 4) e o payload cru.
--   external_response_items     o desfecho de CADA resposta, pergunta por
--                               pergunta, nos tres estados que nao se
--                               confundem: compativel, incompativel, ausente.
--                               E aqui que DADO INCOMPATIVEL existe como estado
--                               proprio, em vez de virar zero ou virar ausencia.
--   external_submission_events  historico append-only de atos do operador:
--                               importou, reconciliou, revogou. E o que torna a
--                               reconciliacao REVERSIVEL sem apagar o passado.
--
-- A REGRA CENTRAL, do responsavel tecnico: "Se uma palavra for alterada e a
-- correspondencia falhar, o processamento deve registrar DADO INCOMPATIVEL,
-- NUNCA pontuacao zero." Ja aconteceu neste projeto um instrumento situacional
-- inteiro ir de 73% de cobertura a ZERO porque a interface gravava o texto da
-- opcao e o motor so aceitava a letra. Ninguem viu, porque zero parece um
-- resultado. O check de `estado` em external_response_items e a coluna
-- `apto_para_pontuar` sao a forma de isso nao poder mais passar calado.
--
-- A IMPORTACAO NAO IMPERSONA O PARTICIPANTE (regra 5). Em nenhum lugar deste
-- arquivo:
--   - se escreve em auth.users, nem se cria sessao, nem se toca em credencial;
--   - se escreve `participants.user_id` (e a coluna que liga pessoa a login);
--   - se cria participante (regra 6: quem nao casa fica PENDENTE);
--   - se marca `participants.completed_at` (entrar na fila de IA e decisao de
--     outro portao, nao efeito colateral de um import).
-- Toda linha gravada carrega `origem = 'externo'` e `importado_por`: quem le a
-- resposta depois ve que ela foi importada por alguem, e por quem.
--
-- Idempotente: `create ... if not exists`, `add column if not exists`,
-- `create or replace`, e chave natural (event_id, formulario_id, submissao_id)
-- para reimportar o mesmo lote nao duplicar nada. Nenhum `delete`, nenhum
-- `drop table`: quiz_responses.stage_id tem FK sem ON DELETE e apagar etapa ja
-- quebrou este projeto uma vez.
--
-- DEPENDE DA 010 (quiz_stages.quiz_version e stage_number, events.quiz_version)
-- e da 012 (is_admin() que nao estoura sem claim).

-- ===========================================================================
-- 1. SUBMISSOES EXTERNAS: a proveniencia da regra 4
-- ===========================================================================
create table if not exists public.external_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,

  -- PROVENIENCIA: formulario de origem e identificador da submissao.
  formulario_id text not null,
  formulario_nome text,
  submissao_id text not null,

  -- PROVENIENCIA: versao das perguntas. `questionario_impressao` e o SHA-256 do
  -- manifesto canonico (lib/importacao/manifesto-questionario.ts). Guardado na
  -- linha, nao so conferido na hora: daqui a um mes a pergunta certa e "a que
  -- questionario esta pessoa respondeu?", e a resposta tem de estar escrita.
  quiz_version int not null,
  questionario_impressao text not null,

  -- O que a coleta entregou, como entregou. Dado coletado de uma pessoa nao se
  -- joga fora: se a correspondencia for corrigida amanha, e daqui que ela e
  -- refeita, sem pedir que 50 jovens respondam de novo.
  email_coletado text,
  email_verificado boolean not null default false,
  nome_declarado text,
  respostas_brutas jsonb not null,

  -- PROVENIENCIA: identidade reconciliada. `participant_id` NULO e um estado
  -- legitimo e esperado (pendente/conflito), nao um defeito.
  participant_id uuid references public.participants(id) on delete set null,
  identidade_via text,
  email_reconciliado text,

  -- O DESFECHO.
  estado text not null,
  apto_para_pontuar boolean not null default false,
  bloqueio jsonb,
  contagens jsonb,

  -- PROVENIENCIA: responsavel pela importacao. NOT NULL de proposito.
  importado_por uuid not null,
  importado_por_email text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

do $$
begin
  -- OS QUATRO ESTADOS, mais 'revogada'. Nao ha estado "ok" generico: cada
  -- recusa tem nome, e 'incompativel' NAO e 'importavel' com zero nem
  -- 'pendente'. Se faltar um nome aqui, a coisa certa e adicionar o nome, nunca
  -- reaproveitar um que diga outra coisa.
  alter table public.external_submissions
    drop constraint if exists external_submissions_estado_check;
  alter table public.external_submissions
    add constraint external_submissions_estado_check
    check (estado in ('importavel', 'incompativel', 'pendente', 'conflito', 'revogada'));

  -- Identidade resolvida EXIGE participante; nao resolvida NAO pode ter um.
  -- Sem isto, um bug de aplicacao poderia gravar "pendente" apontando para
  -- alguem -- ou "importavel" apontando para ninguem.
  alter table public.external_submissions
    drop constraint if exists external_submissions_identidade_check;
  alter table public.external_submissions
    add constraint external_submissions_identidade_check
    check (
      (estado in ('importavel', 'incompativel') and participant_id is not null)
      or (estado in ('pendente', 'conflito') and participant_id is null)
      or estado = 'revogada'
    );

  -- APTO SO QUANDO IMPORTAVEL. Esta e a trava que impede "pontuou zero":
  -- nenhuma submissao com dado incompativel, pendente ou em conflito pode
  -- aparecer como apta, nem por engano de aplicacao.
  alter table public.external_submissions
    drop constraint if exists external_submissions_aptidao_check;
  alter table public.external_submissions
    add constraint external_submissions_aptidao_check
    check (apto_para_pontuar = false or estado = 'importavel');

  -- Dado incompativel, pendente e conflito TEM de dizer por que.
  alter table public.external_submissions
    drop constraint if exists external_submissions_bloqueio_check;
  alter table public.external_submissions
    add constraint external_submissions_bloqueio_check
    check (
      estado = 'importavel'
      or estado = 'revogada'
      or (bloqueio is not null and bloqueio ? 'motivo')
    );

  -- A impressao digital e um SHA-256 hexadecimal, nao um texto livre.
  alter table public.external_submissions
    drop constraint if exists external_submissions_impressao_check;
  alter table public.external_submissions
    add constraint external_submissions_impressao_check
    check (questionario_impressao ~ '^[0-9a-f]{64}$');

  alter table public.external_submissions
    drop constraint if exists external_submissions_via_check;
  alter table public.external_submissions
    add constraint external_submissions_via_check
    check (identidade_via is null or identidade_via in ('email_verificado', 'decisao_do_operador'));
end $$;

-- A MESMA SUBMISSAO NAO ENTRA DUAS VEZES. Reimportar o mesmo lote atualiza as
-- linhas; nao cria copias nem some com nada.
create unique index if not exists external_submissions_natural_idx
  on public.external_submissions (event_id, formulario_id, submissao_id);

-- UM PARTICIPANTE, UMA SUBMISSAO ATIVA. Duas submissoes da mesma pessoa viram
-- CONFLITO explicito na aplicacao (lib/importacao/reconciliar-identidade.ts); se
-- algum caminho futuro tentar gravar as duas de qualquer forma, isto estoura em
-- vez de a segunda sobrescrever a primeira em silencio. 'revogada' sai do indice
-- de proposito: e assim que uma reconciliacao errada e desfeita e refeita.
create unique index if not exists external_submissions_participante_ativo_idx
  on public.external_submissions (event_id, participant_id)
  where participant_id is not null and estado in ('importavel', 'incompativel');

create index if not exists external_submissions_evento_idx
  on public.external_submissions (event_id, estado);

create index if not exists external_submissions_email_idx
  on public.external_submissions (event_id, lower(email_coletado));

comment on table public.external_submissions is
  'Uma submissao de coleta FORA do aplicativo (ex.: Google Forms), com proveniencia completa e o payload cru. participant_id nulo = identidade pendente ou em conflito, estado legitimo.';
comment on column public.external_submissions.questionario_impressao is
  'SHA-256 do manifesto canonico do questionario respondido. Conferido na importacao e GUARDADO, para que a pergunta "a que questionario esta pessoa respondeu?" tenha resposta escrita.';
comment on column public.external_submissions.apto_para_pontuar is
  'false sempre que houver DADO INCOMPATIVEL em pergunta pontuada, identidade nao resolvida, ou qualquer duvida. Pontuar sem consultar isto reproduz o acidente dos 73% que viraram zero.';

-- ===========================================================================
-- 2. ITENS: o desfecho de CADA resposta. Onde DADO INCOMPATIVEL mora.
-- ===========================================================================
create table if not exists public.external_response_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.external_submissions(id) on delete cascade,
  pergunta_id text not null,

  -- OS TRES ESTADOS. 'incompativel' NAO e 'ausente' e NAO e compativel com
  -- valor 0. Esta distincao e o produto deste arquivo.
  estado text not null,

  -- O valor que o motor consome. NULO quando incompativel ou ausente: nao
  -- existe valor canonico para resposta que nao casou, e inventar um
  -- (0, '', 'A') e exatamente o defeito que esta tabela existe para impedir.
  valor_canonico jsonb,
  -- O que a pessoa respondeu, intacto, inclusive (e principalmente) quando nao
  -- casou: e o que permite a um humano ver que "Organizar o problema e definir
  -- a PRIORIDADE" virou "... a URGENCIA".
  valor_bruto jsonb,

  causa text,
  motivo text,
  -- O motor de pontuacao consome esta pergunta? Incompativel em pergunta
  -- pontuada apaga instrumento; em pergunta aberta, nao.
  pontuada boolean not null default false,
  forma text,

  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_response_items
    drop constraint if exists external_response_items_estado_check;
  alter table public.external_response_items
    add constraint external_response_items_estado_check
    check (estado in ('compativel', 'incompativel', 'ausente'));

  -- COMPATIVEL EXIGE VALOR; INCOMPATIVEL E AUSENTE NAO PODEM TER VALOR
  -- CANONICO. E a trava de banco contra "pontuou zero": nao ha como gravar uma
  -- resposta que falhou a correspondencia carregando um valor pontuavel.
  alter table public.external_response_items
    drop constraint if exists external_response_items_valor_check;
  alter table public.external_response_items
    add constraint external_response_items_valor_check
    check (
      (estado = 'compativel' and valor_canonico is not null)
      or (estado in ('incompativel', 'ausente') and valor_canonico is null)
    );

  -- INCOMPATIVEL TEM DE DIZER POR QUE, e tem de mostrar o que chegou.
  alter table public.external_response_items
    drop constraint if exists external_response_items_motivo_check;
  alter table public.external_response_items
    add constraint external_response_items_motivo_check
    check (
      estado <> 'incompativel'
      or (causa is not null and motivo is not null and valor_bruto is not null)
    );

  alter table public.external_response_items
    drop constraint if exists external_response_items_causa_check;
  alter table public.external_response_items
    add constraint external_response_items_causa_check
    check (causa is null or causa in (
      'alternativa_desconhecida',
      'alternativa_fora_do_mapa',
      'fora_da_escala',
      'acima_do_limite_de_caracteres',
      'tipo_invalido',
      'pergunta_desconhecida'
    ));
end $$;

create unique index if not exists external_response_items_unico_idx
  on public.external_response_items (submission_id, pergunta_id);

create index if not exists external_response_items_incompativeis_idx
  on public.external_response_items (submission_id)
  where estado = 'incompativel';

comment on table public.external_response_items is
  'O desfecho de cada resposta externa, nos tres estados que nao se confundem: compativel (tem valor canonico), incompativel (respondeu e a correspondencia falhou -- NUNCA zero) e ausente (nao respondeu).';

-- ===========================================================================
-- 3. ATOS DO OPERADOR: append-only, e por isso REVERSIVEL
-- ===========================================================================
-- Regra 5: "Reconciliar identidade e um ato do operador, registrado e
-- reversivel, nao um efeito colateral de um import." Reversivel aqui NAO quer
-- dizer apagavel: desfazer e uma linha nova de 'revogada', e a linha anterior
-- continua la. Quem auditar ve a decisao, quem a tomou, e que ela foi desfeita.
create table if not exists public.external_submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.external_submissions(id) on delete cascade,
  acao text not null,
  operador uuid not null,
  operador_email text,
  justificativa text,
  detalhes jsonb,
  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_acao_check;
  alter table public.external_submission_events
    add constraint external_submission_events_acao_check
    check (acao in (
      'importada',              -- virou resposta canonica pontuavel
      'retida_incompativel',    -- gravada e MARCADA: dado incompativel
      'retida_pendente',        -- identidade nao casou: espera humano
      'retida_conflito',        -- mais de um candidato: espera humano
      'reconciliada_pelo_operador',
      'revogada'
    ));

  -- Ato de operador sem justificativa nao e ato registrado.
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_justificativa_check;
  alter table public.external_submission_events
    add constraint external_submission_events_justificativa_check
    check (
      acao not in ('reconciliada_pelo_operador', 'revogada')
      or (justificativa is not null and length(btrim(justificativa)) >= 3)
    );
end $$;

create index if not exists external_submission_events_submissao_idx
  on public.external_submission_events (submission_id, criado_em);

-- APPEND-ONLY DE VERDADE, nao por convencao: sem UPDATE e sem DELETE para
-- ninguem alem do dono da tabela. Historico que da para reescrever nao e
-- historico.
revoke update, delete on public.external_submission_events from anon, authenticated, service_role;

-- ===========================================================================
-- 4. PROVENIENCIA NA PROPRIA RESPOSTA CANONICA
-- ===========================================================================
-- Quem le `quiz_responses` tem de ver, na linha, que ela veio de fora e de onde.
-- `questions_snapshot` (coluna da 010) continua guardando as perguntas da etapa.
alter table public.quiz_responses
  add column if not exists origem text not null default 'app';

alter table public.quiz_responses
  add column if not exists external_submission_id uuid
    references public.external_submissions(id) on delete set null;

-- Resumo legivel da proveniencia, direto na linha: formulario, submissao,
-- impressao do questionario, operador, e as perguntas desta etapa que ficaram
-- INCOMPATIVEIS. Esta ultima parte e deliberada: a incompatibilidade viaja com
-- a resposta, em vez de morar so numa tabela que alguem pode esquecer de olhar.
alter table public.quiz_responses
  add column if not exists importacao jsonb;

do $$
begin
  alter table public.quiz_responses
    drop constraint if exists quiz_responses_origem_check;
  alter table public.quiz_responses
    add constraint quiz_responses_origem_check
    check (origem in ('app', 'externo'));

  -- Resposta externa EXIGE a submissao que a originou. Sem isso, "veio de fora"
  -- seria uma afirmacao sem lastro.
  alter table public.quiz_responses
    drop constraint if exists quiz_responses_proveniencia_check;
  alter table public.quiz_responses
    add constraint quiz_responses_proveniencia_check
    check (origem = 'app' or external_submission_id is not null);
end $$;

create index if not exists quiz_responses_origem_idx
  on public.quiz_responses (origem);

comment on column public.quiz_responses.origem is
  '''app'' = a pessoa respondeu nesta aplicacao. ''externo'' = importada de coleta fora do aplicativo, com external_submission_id e importacao preenchidos. A importacao nunca se passa pela pessoa.';

-- ===========================================================================
-- 5. A VISAO DE PROVENIENCIA: legivel DEPOIS, por quem nao estava aqui
-- ===========================================================================
create or replace view public.v_proveniencia_respostas_externas as
select
  qr.id                        as resposta_id,
  qr.participant_id,
  p.full_name                  as participante,
  p.email                      as participante_email,
  qr.stage_id,
  qs.stage_number,
  qs.title                     as etapa,
  qr.submitted_at,
  qr.origem,
  es.formulario_id,
  es.formulario_nome,
  es.submissao_id,
  es.quiz_version,
  es.questionario_impressao,
  es.email_coletado,
  es.email_verificado,
  es.email_reconciliado,
  es.identidade_via,
  es.estado                    as estado_da_submissao,
  es.apto_para_pontuar,
  es.bloqueio,
  es.importado_por,
  es.importado_por_email,
  es.criado_em                 as importado_em,
  (qr.importacao -> 'incompativeis') as perguntas_incompativeis,
  jsonb_build_object(
    'compativeis',  (select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'compativel'),
    'incompativeis',(select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'incompativel'),
    'ausentes',     (select count(*) from public.external_response_items i
                      where i.submission_id = es.id and i.estado = 'ausente')
  ) as itens
from public.quiz_responses qr
join public.external_submissions es on es.id = qr.external_submission_id
join public.participants p          on p.id = qr.participant_id
left join public.quiz_stages qs     on qs.id = qr.stage_id
where qr.origem = 'externo';

comment on view public.v_proveniencia_respostas_externas is
  'De onde veio cada resposta importada: formulario, submissao, impressao digital do questionario, identidade reconciliada e como, responsavel pela importacao, e o que ficou incompativel.';

-- ===========================================================================
-- 6. O PORTAO DE PONTUACAO das respostas externas
-- ===========================================================================
-- `calcularMarcoZero` nao tem como distinguir, olhando so o mapa de respostas,
-- uma pergunta que ninguem respondeu de uma cuja alternativa foi reescrita: as
-- duas chegam ausentes. Esta visao e a distincao, por participante, e ela tem
-- TRES desfechos, nunca dois:
--   pode_pontuar       conferido e apto;
--   DADO_INCOMPATIVEL  conferido: respondeu e a correspondencia falhou;
--   IDENTIDADE_NAO_RESOLVIDA / APTIDAO_INDETERMINADA  nao deu para afirmar.
create or replace view public.v_aptidao_pontuacao_externa as
select
  es.event_id,
  es.participant_id,
  es.id            as submission_id,
  es.estado,
  es.apto_para_pontuar as pode_pontuar,
  case
    when es.apto_para_pontuar then null
    when es.estado = 'incompativel' then 'DADO_INCOMPATIVEL'
    when es.estado in ('pendente', 'conflito') then 'IDENTIDADE_NAO_RESOLVIDA'
    else 'APTIDAO_INDETERMINADA'
  end as codigo,
  es.bloqueio ->> 'motivo' as motivo,
  coalesce(es.bloqueio -> 'perguntas', '[]'::jsonb) as perguntas,
  (select jsonb_agg(jsonb_build_object(
            'pergunta_id', i.pergunta_id,
            'causa', i.causa,
            'motivo', i.motivo,
            'respondido', i.valor_bruto,
            'pontuada', i.pontuada) order by i.pergunta_id)
     from public.external_response_items i
    where i.submission_id = es.id and i.estado = 'incompativel') as incompativeis
from public.external_submissions es;

comment on view public.v_aptidao_pontuacao_externa is
  'Pode pontuar as respostas externas deste participante? Tres desfechos: apto, DADO_INCOMPATIVEL (respondeu e nao casou -- nunca zero), ou identidade/aptidao nao verificada.';

-- ===========================================================================
-- 7. A APLICACAO DO PLANO, numa transacao
-- ===========================================================================
-- Recebe o plano que `lib/importacao/planejar-importacao.ts` montou e grava.
-- NAO decide nada: toda decisao (manifesto, identidade, correspondencia) ja foi
-- tomada e testada em funcao pura. Aqui so se escreve -- e se RECUSA escrever o
-- que o plano nao autoriza.
--
-- SECURITY INVOKER de proposito: roda com o privilegio de quem chama, a RLS vale,
-- e isto NAO e um caminho para escrever onde quem chamou nao podia. Comparar com
-- is_admin(): as rotas administrativas passam por service_role.
--
-- O que ela se RECUSA a fazer, e estoura em vez de fazer:
--   - aplicar plano com ok <> true (um plano recusado nao escreve nada);
--   - aplicar sem operador;
--   - gravar quiz_responses de submissao sem participante;
--   - marcar apto_para_pontuar sem o plano ter dito que e importavel.
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
  s jsonb;
  e jsonb;
  it jsonb;
  v_sub_id uuid;
  v_estado text;
  v_participant uuid;
  v_apto boolean;
  v_acao text;
  v_gravadas int := 0;
  v_itens int := 0;
  v_resumo jsonb := '{}'::jsonb;
  v_por_estado jsonb := '{}'::jsonb;
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

  if v_operador is null then
    raise exception 'importacao_externa_aplicar: plano sem operador responsavel. Nada foi gravado.';
  end if;
  if v_form_id is null or btrim(v_form_id) = '' then
    raise exception 'importacao_externa_aplicar: plano sem formulario de origem. Nada foi gravado.';
  end if;
  if v_impressao is null or v_impressao !~ '^[0-9a-f]{64}$' then
    raise exception 'importacao_externa_aplicar: plano sem impressao digital valida do questionario. Nada foi gravado.';
  end if;

  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    v_estado := s ->> 'estado';
    v_participant := nullif(s ->> 'participant_id', '')::uuid;
    v_apto := coalesce((s ->> 'apto_para_pontuar')::boolean, false);

    -- Cinto e suspensorio: o check da tabela ja proibiria, mas a mensagem daqui
    -- diz qual submissao, e e ela que o operador vai ler.
    if v_apto and v_estado <> 'importavel' then
      raise exception
        'importacao_externa_aplicar: submissao % pede apto_para_pontuar com estado %. Recusado.',
        s ->> 'submissao_id', v_estado;
    end if;

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

    -- As respostas canonicas. SO com participante reconciliado, e so com os
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
        'questionario_impressao', v_impressao
      )
    );

    v_por_estado := jsonb_set(
      v_por_estado, array[v_estado],
      to_jsonb(coalesce((v_por_estado ->> v_estado)::int, 0) + 1), true
    );
  end loop;

  v_resumo := jsonb_build_object(
    'evento_id', v_event_id,
    'formulario_id', v_form_id,
    'questionario_impressao', v_impressao,
    'por_estado', v_por_estado,
    'linhas_de_resposta_gravadas', v_gravadas,
    'itens_registrados', v_itens,
    'importado_por', v_operador
  );
  return v_resumo;
end;
$$;

comment on function public.importacao_externa_aplicar(jsonb) is
  'Grava um plano de importacao externa numa transacao. Nao decide nada (isso e lib/importacao/*), e recusa plano sem ok, sem operador, sem origem ou sem impressao digital valida.';

-- ===========================================================================
-- 8. REVOGAR UMA RECONCILIACAO: reversivel, sem apagar o passado
-- ===========================================================================
-- Desfaz a ligacao entre submissao e participante. NAO apaga a submissao (o
-- payload cru fica) e NAO apaga o historico: grava uma linha 'revogada'. As
-- respostas canonicas que nasceram dela saem, porque afirmavam ser respostas
-- daquela pessoa e isso deixou de ser verdade.
create or replace function public.importacao_externa_revogar(
  p_submission_id uuid,
  p_operador uuid,
  p_justificativa text
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_antes jsonb;
  v_removidas int;
begin
  if p_operador is null then
    raise exception 'importacao_externa_revogar: revogacao exige operador responsavel.';
  end if;
  if p_justificativa is null or length(btrim(p_justificativa)) < 3 then
    raise exception 'importacao_externa_revogar: revogacao exige justificativa registrada.';
  end if;

  select jsonb_build_object(
           'estado', estado, 'participant_id', participant_id,
           'identidade_via', identidade_via, 'apto_para_pontuar', apto_para_pontuar)
    into v_antes
    from public.external_submissions where id = p_submission_id;

  if v_antes is null then
    raise exception 'importacao_externa_revogar: submissao % nao encontrada.', p_submission_id;
  end if;

  delete from public.quiz_responses where external_submission_id = p_submission_id;
  get diagnostics v_removidas = row_count;

  update public.external_submissions set
    estado = 'revogada',
    participant_id = null,
    identidade_via = null,
    apto_para_pontuar = false,
    bloqueio = jsonb_build_object(
      'motivo', 'reconciliacao REVOGADA pelo operador: ' || btrim(p_justificativa),
      'perguntas', '[]'::jsonb),
    atualizado_em = now()
  where id = p_submission_id;

  insert into public.external_submission_events (
    submission_id, acao, operador, justificativa, detalhes
  ) values (
    p_submission_id, 'revogada', p_operador, btrim(p_justificativa),
    jsonb_build_object('antes', v_antes, 'respostas_canonicas_removidas', v_removidas)
  );

  return jsonb_build_object(
    'submission_id', p_submission_id,
    'antes', v_antes,
    'respostas_canonicas_removidas', v_removidas
  );
end;
$$;

-- ===========================================================================
-- 9. RLS: as tres tabelas sao de administracao, nao do participante
-- ===========================================================================
-- Um participante nao le nem escreve nada disto: nao e dado dele operar, e o
-- payload cru de uma submissao contem o e-mail de outra pessoa. Mesmo desenho do
-- resto do projeto: policy de admin via is_admin() (migration 012), nada para
-- anon, nada para authenticated.
alter table public.external_submissions      enable row level security;
alter table public.external_response_items   enable row level security;
alter table public.external_submission_events enable row level security;

drop policy if exists external_submissions_admin on public.external_submissions;
create policy external_submissions_admin on public.external_submissions
  for all using (is_admin()) with check (is_admin());

drop policy if exists external_response_items_admin on public.external_response_items;
create policy external_response_items_admin on public.external_response_items
  for all using (is_admin()) with check (is_admin());

-- Historico: admin LE e INSERE; ninguem altera nem apaga (o revoke acima e a
-- ausencia de policy de update/delete).
drop policy if exists external_submission_events_admin_select on public.external_submission_events;
create policy external_submission_events_admin_select on public.external_submission_events
  for select using (is_admin());

drop policy if exists external_submission_events_admin_insert on public.external_submission_events;
create policy external_submission_events_admin_insert on public.external_submission_events
  for insert with check (is_admin());

revoke all on public.external_submissions      from anon, authenticated;
revoke all on public.external_response_items   from anon, authenticated;
revoke all on public.external_submission_events from anon, authenticated;
revoke all on public.v_proveniencia_respostas_externas from anon, authenticated;
revoke all on public.v_aptidao_pontuacao_externa       from anon, authenticated;
