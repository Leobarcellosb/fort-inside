-- 029_regularizacao_da_segunda_resposta.sql
-- A SEGUNDA RESPOSTA DO FORMULARIO PUBLICO PASSA A TER SAIDA: REGULARIZAR OU
-- DESCONSIDERAR. NUNCA SOBRESCREVER, NUNCA APAGAR.
--
-- NAO APLICAR sem autorizacao nominal, como as demais da serie. NAO EDITA
-- nenhuma migration anterior: estende checks por `drop constraint if exists` +
-- `add constraint` (mesmo desenho da 024) e cria tabelas e funcoes novas.
-- Idempotente: pode rodar duas vezes seguidas.
--
-- ===========================================================================
-- O DEFEITO
-- ===========================================================================
-- O formulario publico (app/api/formulario-publico/receber-formulario.ts) recebe
-- e-mail AUTODECLARADO. Quando chega uma segunda resposta com um e-mail que ja
-- tem resposta gravada, ela NAO sobrescreve: vai inteira para
-- `external_submissions` com estado 'conflito', participant_id nulo e bloqueio
-- SEGUNDA_RESPOSTA_MESMO_EMAIL. Correto. Mas a mesa de decisao nao tinha saida
-- para ela: ligar a quem ja tem resposta e recusado (IMPORT_TARGET_OCCUPIED,
-- corretamente) e nao havia outro caminho. O caso mais provavel -- DUAS PESSOAS
-- DIFERENTES, uma digitou o e-mail da outra -- deixava um jovem que respondeu as
-- 52 perguntas sem documento, sem ter feito nada errado.
--
-- ===========================================================================
-- O QUE ESTA MIGRATION CRIA
-- ===========================================================================
--   1. estado 'desconsiderada' em external_submissions: a segunda submissao sai
--      da fila de conflitos ativos e continua PRESERVADA, imutavel e
--      inapagavel (gatilho), como registro historico restrito a admin;
--   2. external_identity_resolutions: o LIVRO DA REGULARIZACAO, append-only,
--      com fonte independente em VOCABULARIO FECHADO, referencia da
--      conferencia, motivo, operador, hora do banco e resultado;
--   3. external_recipient_confirmations: o SEGUNDO FATO, distinto do primeiro.
--      "A submissao e da Joana" (identidade confirmada pela organizacao) NAO
--      prova que "a Joana controla este e-mail" (destinatario confirmado por
--      canal independente). Os dois sao registrados separadamente;
--   4. tres funcoes SECURITY DEFINER, as UNICAS que escrevem nesses livros:
--      formulario_publico_regularizar, formulario_publico_desconsiderar e
--      formulario_publico_confirmar_destinatario;
--   5. gatilhos que fazem disto garantia e nao disciplina:
--        - submissao do formulario publico NUNCA e marcada email_verificado nem
--          identidade_via 'email_verificado', por ninguem;
--        - a segunda resposta em conflito so sai de 'conflito' pelas funcoes
--          desta migration (a reconciliacao generica nao a resolve sem fonte);
--        - 'desconsiderada' nao muda mais e nao e apagada;
--        - documento de participante regularizado NAO e entregue enquanto o
--          destinatario nao estiver confirmado por canal independente.
--
-- A REGRA CENTRAL, da revisao, literal: "A declaracao do operador registra a
-- conferencia. Ela nao pode ser confundida com a prova de que a conferencia
-- realmente aconteceu." Por isso nada aqui promove identidade a "verificada":
-- `identidade_via` fica 'decisao_do_operador' (que e o que ela e),
-- `email_verificado` fica false (que e o que ele e), e o livro diz QUAL fonte
-- o operador declarou ter consultado e COMO localizar essa conferencia.
--
-- MINIMIZACAO: o livro guarda o TIPO da fonte (vocabulario fechado) e uma
-- REFERENCIA textual que identifica a conferencia (ex.: "lista da coordenacao
-- de 15/10, linha 23"). Nao ha coluna para captura de conversa, copia de
-- documento ou anexo -- e nao deve haver. Acesso: admin (RLS) e service_role
-- so para LER.
--
-- A importacao atomica e REUTILIZADA, nao reescrita: as respostas entram por
-- `importacao_externa_aplicar` (022/024), com o bloqueio por participante e a
-- revalidacao dentro da transacao. Se a 024 recusar, a regularizacao inteira e
-- desfeita (subtransacao) e a recusa fica no livro da regularizacao.

-- ===========================================================================
-- 1. 'desconsiderada' como estado proprio
-- ===========================================================================
do $$
begin
  alter table public.external_submissions
    drop constraint if exists external_submissions_estado_check;
  alter table public.external_submissions
    add constraint external_submissions_estado_check
    check (estado in ('importavel', 'incompativel', 'pendente', 'conflito', 'revogada', 'desconsiderada'));

  -- 'desconsiderada' nao e de ninguem: o operador conferiu que a PRIMEIRA e a
  -- valida, e a segunda fica como registro. Apontar para alguem seria afirmar
  -- uma identidade que a decisao justamente nao afirmou.
  alter table public.external_submissions
    drop constraint if exists external_submissions_identidade_check;
  alter table public.external_submissions
    add constraint external_submissions_identidade_check
    check (
      (estado in ('importavel', 'incompativel') and participant_id is not null)
      or (estado in ('pendente', 'conflito', 'desconsiderada') and participant_id is null)
      or estado = 'revogada'
    );
end $$;

-- ===========================================================================
-- 2. O LIVRO DA REGULARIZACAO
-- ===========================================================================
-- Sem FK para external_submissions, como o livro de recusas da 024: o registro
-- de auditoria nao pode depender da linha que ele audita (nem ir embora com ela
-- num cascade).
create table if not exists public.external_identity_resolutions (
  id uuid primary key default gen_random_uuid(),
  sequencia bigint generated always as identity,

  -- EVENTO E SUBMISSAO: identificadores imutaveis.
  event_id uuid not null,
  submission_id uuid not null,
  submissao_id text not null,

  -- O ATO e o RESULTADO.
  ato text not null,
  resultado text not null,
  recusa_codigo text,

  -- PESSOA IDENTIFICADA: cadastro existente ou criacao autorizada.
  pessoa_participant_id uuid,
  pessoa_criada boolean not null default false,
  -- O dono da PRIMEIRA resposta, para quem auditar ver que ela ficou intacta.
  primeira_participant_id uuid,
  -- Convidado da lista oficial DENTRO do sistema (event_people), quando houver.
  convidado_id uuid,

  -- FONTE INDEPENDENTE (vocabulario fechado) e REFERENCIA da conferencia.
  fonte_tipo text not null,
  referencia text not null,
  motivo text not null,

  -- O que estava gravado ANTES (inclusive o bloqueio original, que a aplicacao
  -- do plano substitui na linha da submissao) e o que a decisao produziu.
  estado_anterior jsonb not null,
  efeito jsonb,

  -- OPERADOR (da sessao, passado pela rota) e DATA E HORA (do banco).
  operador uuid not null,
  operador_email text,
  criado_em timestamptz not null default now()
);

do $$
begin
  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_ato_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_ato_check
    check (ato in ('regularizar_vinculo', 'regularizar_criacao', 'desconsiderar'));

  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_resultado_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_resultado_check
    check (resultado in ('pendente', 'confirmado', 'recusado'));

  -- Recusa sem nome nao e recusa registrada; confirmacao com nome de recusa e
  -- contradicao.
  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_recusa_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_recusa_check
    check ((resultado = 'recusado') = (recusa_codigo is not null));

  -- AS TRES FONTES ACEITAS. Nome e e-mail do proprio formulario, grupo de
  -- WhatsApp e "identidade conferida" NAO estao aqui, e nao e esquecimento.
  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_fonte_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_fonte_check
    check (fonte_tipo in (
      'lista_oficial_previa',          -- lista preparada pela organizacao ANTES da coleta
      'confirmacao_presencial',        -- responsavel do evento confirmou pessoalmente
      'contato_previamente_conhecido'  -- responsavel confirmou por contato ja conhecido antes
    ));

  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_texto_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_texto_check
    check (length(btrim(referencia)) >= 20 and length(btrim(motivo)) >= 20
           and length(referencia) <= 500 and length(motivo) <= 2000);

  alter table public.external_identity_resolutions
    drop constraint if exists external_identity_resolutions_codigo_check;
  alter table public.external_identity_resolutions
    add constraint external_identity_resolutions_codigo_check
    check (recusa_codigo is null or recusa_codigo in (
      'submissao_ja_decidida',
      'submissao_mudou',
      'plano_nao_corresponde',
      'alvo_inexistente',
      'alvo_de_outro_evento',
      'alvo_e_o_dono_da_primeira',
      'alvo_tem_respostas',
      'alvo_tem_submissao_ativa',
      'alvo_tem_documento',
      'email_e_o_digitado',
      'email_ja_cadastrado',
      'nome_ja_cadastrado',
      'convidado_inexistente',
      'convidado_de_outra_pessoa',
      'convidado_com_outro_email',
      'primeira_resposta_ausente',
      'recusada_na_revalidacao'
    ));
end $$;

create index if not exists external_identity_resolutions_submissao_idx
  on public.external_identity_resolutions (submission_id, sequencia);
create index if not exists external_identity_resolutions_pessoa_idx
  on public.external_identity_resolutions (pessoa_participant_id)
  where resultado = 'confirmado';

comment on table public.external_identity_resolutions is
  'APPEND-ONLY. Livro da regularizacao/desconsideracao da segunda resposta do formulario publico. Escrito SOMENTE pelas funcoes security definer da 029; sem insert/update/delete/truncate para anon, authenticated e service_role. Registra a DECLARACAO do operador sobre a conferencia (fonte em vocabulario fechado + referencia), que nao e prova de que a conferencia aconteceu, e nao promove nenhum e-mail a verificado.';

-- ===========================================================================
-- 3. O SEGUNDO FATO: destinatario confirmado por canal independente
-- ===========================================================================
create table if not exists public.external_recipient_confirmations (
  id uuid primary key default gen_random_uuid(),
  sequencia bigint generated always as identity,
  event_id uuid not null,
  participant_id uuid not null,
  -- O endereco que foi confirmado como sob controle da pessoa. A entrega so vale
  -- enquanto o cadastro tiver ESTE endereco.
  email_destinatario text not null,
  canal_tipo text not null,
  referencia text not null,
  operador uuid not null,
  operador_email text,
  criado_em timestamptz not null default now()
);

do $$
begin
  -- Canal INDEPENDENTE da submissao. A lista oficial nao entra aqui: ela diz
  -- quem pertence ao evento, nao quem controla um endereco.
  alter table public.external_recipient_confirmations
    drop constraint if exists external_recipient_confirmations_canal_check;
  alter table public.external_recipient_confirmations
    add constraint external_recipient_confirmations_canal_check
    check (canal_tipo in ('confirmacao_presencial', 'contato_previamente_conhecido'));

  alter table public.external_recipient_confirmations
    drop constraint if exists external_recipient_confirmations_texto_check;
  alter table public.external_recipient_confirmations
    add constraint external_recipient_confirmations_texto_check
    check (length(btrim(referencia)) >= 20 and length(referencia) <= 500
           and email_destinatario = lower(btrim(email_destinatario)));
end $$;

create index if not exists external_recipient_confirmations_pessoa_idx
  on public.external_recipient_confirmations (participant_id, email_destinatario);

comment on table public.external_recipient_confirmations is
  'APPEND-ONLY. Destinatario do documento confirmado por canal independente, para participante cuja identidade veio de regularizacao. Distinto de external_identity_resolutions: identidade confirmada NAO prova controle do e-mail. Nao toca email_verificado nem user_id.';

-- ===========================================================================
-- 4. APPEND-ONLY DE VERDADE, para os dois livros (e sem o erro da 024)
-- ===========================================================================
-- A 024 deixou INSERT e TRUNCATE para service_role no livro de recusas. Aqui
-- nao: os papeis da aplicacao NAO escrevem nos livros de jeito nenhum. Quem
-- escreve e a funcao security definer, que confere tudo antes.
alter table public.external_identity_resolutions enable row level security;
alter table public.external_recipient_confirmations enable row level security;

drop policy if exists external_identity_resolutions_admin_select on public.external_identity_resolutions;
create policy external_identity_resolutions_admin_select on public.external_identity_resolutions
  for select using (is_admin());
drop policy if exists external_recipient_confirmations_admin_select on public.external_recipient_confirmations;
create policy external_recipient_confirmations_admin_select on public.external_recipient_confirmations
  for select using (is_admin());

revoke all on public.external_identity_resolutions from public, anon, authenticated;
revoke all on public.external_recipient_confirmations from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.external_identity_resolutions from service_role;
revoke insert, update, delete, truncate, references, trigger
  on public.external_recipient_confirmations from service_role;
grant select on public.external_identity_resolutions to service_role;
grant select on public.external_recipient_confirmations to service_role;

-- ===========================================================================
-- 5. O LIVRO DA SUBMISSAO conta os dois atos novos
-- ===========================================================================
do $$
begin
  alter table public.external_submission_events
    drop constraint if exists external_submission_events_acao_check;
  alter table public.external_submission_events
    add constraint external_submission_events_acao_check
    check (acao in (
      'importada',
      'retida_incompativel',
      'retida_pendente',
      'retida_conflito',
      'recusada_na_revalidacao',
      'reconciliada_pelo_operador',
      'revogada',
      'regularizada_pelo_operador',    -- 029: segunda resposta ligada a pessoa confirmada
      'desconsiderada_pelo_operador'   -- 029: segunda resposta encerrada, preservada
    ));

  alter table public.external_submission_events
    drop constraint if exists external_submission_events_justificativa_check;
  alter table public.external_submission_events
    add constraint external_submission_events_justificativa_check
    check (
      acao not in ('reconciliada_pelo_operador', 'revogada', 'recusada_na_revalidacao',
                   'regularizada_pelo_operador', 'desconsiderada_pelo_operador')
      or (justificativa is not null and length(btrim(justificativa)) >= 3)
    );
end $$;

-- ===========================================================================
-- 6. GATILHO: as garantias sobre external_submissions
-- ===========================================================================
create or replace function public.external_submissions_guarda_formulario_publico()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pela_regularizacao boolean :=
    coalesce(pg_catalog.current_setting('fort.regularizacao', true), 'off') = 'on';
begin
  if tg_op = 'DELETE' then
    -- PROIBIDO apagar fisicamente o que foi desconsiderado: e registro historico.
    if old.estado = 'desconsiderada' then
      raise exception
        'external_submissions: a submissao % foi DESCONSIDERADA e e registro historico: nao se apaga.',
        old.submissao_id
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- (a) E-MAIL DIGITADO NUNCA VIRA VERIFICADO, por decisao de ninguem.
  if new.formulario_id = 'formulario-publico'
     and (new.email_verificado is true or new.identidade_via = 'email_verificado') then
    raise exception
      'external_submissions: o e-mail do formulario publico e AUTODECLARADO; email_verificado/identidade_via=email_verificado sao proibidos (submissao %).',
      new.submissao_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then
    -- (b) 'desconsiderada' e imutavel.
    if old.estado = 'desconsiderada' then
      raise exception
        'external_submissions: a submissao % foi DESCONSIDERADA e nao muda mais.',
        old.submissao_id
        using errcode = 'check_violation';
    end if;

    -- (c) A segunda resposta em conflito so sai de 'conflito' pelas funcoes da
    --     029, que exigem fonte independente e registram no livro. A
    --     reconciliacao generica (so justificativa) NAO a resolve.
    if old.estado = 'conflito'
       and old.bloqueio ->> 'codigo' = 'SEGUNDA_RESPOSTA_MESMO_EMAIL'
       and (new.estado is distinct from old.estado
            or new.participant_id is distinct from old.participant_id)
       and not v_pela_regularizacao then
      raise exception
        'external_submissions: a segunda resposta % (SEGUNDA_RESPOSTA_MESMO_EMAIL) so e resolvida por formulario_publico_regularizar/desconsiderar, com fonte independente registrada.',
        old.submissao_id
        using errcode = 'check_violation';
    end if;

    -- (d) Entrar em 'desconsiderada' so pela funcao que registra o ato.
    if new.estado = 'desconsiderada' and not v_pela_regularizacao then
      raise exception
        'external_submissions: so formulario_publico_desconsiderar marca uma submissao como desconsiderada.'
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' and new.estado = 'desconsiderada' then
    raise exception
      'external_submissions: uma submissao nao nasce desconsiderada.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists external_submissions_guarda_formulario_publico on public.external_submissions;
create trigger external_submissions_guarda_formulario_publico
  before insert or update or delete on public.external_submissions
  for each row
  execute function public.external_submissions_guarda_formulario_publico();

revoke all on function public.external_submissions_guarda_formulario_publico() from public, anon, authenticated;

-- ===========================================================================
-- 7. A REFERENCIA TEM DE DIZER ALGO ALEM DE "CONFERIDO"
-- ===========================================================================
-- Devolve o que sobra da referencia depois de tirar: pontuacao, o e-mail e o
-- nome que a PROPRIA submissao trouxe (a evidencia tem de ser independente
-- dela), e as palavras de carimbo ("identidade", "conferida", "ok"...). Se
-- sobrar pouco, a referencia nao identifica conferencia nenhuma.
-- O MESMO algoritmo existe em lib/importacao/regularizacao.ts
-- (`substanciaDaReferencia`), e um teste os compara.
create or replace function public.regularizacao_substancia(
  p_texto text, p_email text, p_nome text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
  w text;
  v_saida text := '';
  v_carimbo text[] := array[
    'identidade','conferida','conferido','confirmada','confirmado','verificada',
    'verificado','checada','checado','validada','validado','ok','okay','sim',
    'pelo','pela','operador','operadora','foi','esta','e','a','o','as','os',
    'de','da','do','das','dos','com','ja','tudo','certo','pessoa','mesma',
    'aluno','aluna','jovem','participante','email','e-mail','nome','formulario'
  ];
  v_nome_tokens text[];
begin
  v := pg_catalog.lower(pg_catalog.btrim(coalesce(p_texto, '')));
  v := pg_catalog.translate(v, 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn');
  if p_email is not null and pg_catalog.btrim(p_email) <> '' then
    v := pg_catalog.replace(v, pg_catalog.lower(pg_catalog.btrim(p_email)), ' ');
  end if;
  v := pg_catalog.regexp_replace(v, '[^a-z0-9]+', ' ', 'g');
  v_nome_tokens := pg_catalog.regexp_split_to_array(
    pg_catalog.regexp_replace(
      pg_catalog.translate(pg_catalog.lower(coalesce(p_nome, '')),
        'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
      '[^a-z0-9]+', ' ', 'g'),
    ' ');
  foreach w in array pg_catalog.regexp_split_to_array(pg_catalog.btrim(v), ' ')
  loop
    if w = '' or w = any (v_carimbo) or w = any (v_nome_tokens) then
      continue;
    end if;
    v_saida := v_saida || w || ' ';
  end loop;
  return pg_catalog.btrim(v_saida);
end;
$$;

comment on function public.regularizacao_substancia(text, text, text) is
  'O que a referencia da conferencia diz ALEM de carimbo ("identidade conferida") e alem do nome/e-mail da propria submissao. Menos de 15 caracteres = referencia recusada.';

-- ===========================================================================
-- 8. REGULARIZAR: ligar a segunda resposta a pessoa CONFIRMADA
-- ===========================================================================
-- A ORDEM, e nenhuma etapa e dispensavel:
--   1. so administrador (is_admin(): service_role do servidor, ou admin);
--   2. entrada: fonte no vocabulario fechado; referencia e motivo com substancia;
--   3. TRAVA a linha da submissao (for update): dois operadores nao resolvem a
--      mesma submissao em destinos diferentes -- o segundo espera e, ao entrar,
--      encontra a submissao ja decidida;
--   4. a submissao e a que o operador VIU (atualizado_em igual) e ainda esta em
--      conflito -- senao RECUSA registrada;
--   5. o PLANO corresponde a submissao preservada, byte a byte nas respostas, e
--      nao promove o e-mail;
--   6. o DESTINO:
--        vincular -> participante do evento, SEM resposta, SEM submissao ativa,
--                    SEM documento, e que nao e o dono da primeira resposta;
--        criar    -> so se NAO existe cadastro com aquele e-mail nem com aquele
--                    nome no evento; o participante nasce sem user_id;
--   7. as respostas entram por importacao_externa_aplicar (022/024), DENTRO de
--      uma subtransacao: se a revalidacao da 024 recusar, tudo desta decisao e
--      desfeito (inclusive a criacao) e a recusa fica no livro;
--   8. confere o que ficou gravado (identidade_via = decisao_do_operador,
--      email_verificado = false) e registra no livro e no historico.
create or replace function public.formulario_publico_regularizar(
  p_submission_id uuid,
  p_atualizado_em_visto timestamptz,
  p_operador uuid,
  p_operador_email text,
  p_modo text,
  p_participant_id uuid,
  p_novo_nome text,
  p_novo_email text,
  p_novo_telefone text,
  p_convidado_id uuid,
  p_fonte_tipo text,
  p_referencia text,
  p_motivo text,
  p_plano jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_sub public.external_submissions%rowtype;
  v_antes jsonb;
  v_primeira uuid;
  v_recusa text;
  v_recusa_det jsonb := '{}'::jsonb;
  v_s jsonb;
  v_part record;
  v_conv record;
  v_email text;
  v_nome text;
  v_existente uuid;
  v_res jsonb;
  v_recusa_aplicacao jsonb;
  v_depois record;
  v_total_etapas int;
  v_respondidas int;
  v_concluido boolean := false;
  v_ato text;
  v_registro uuid;
begin
  -- 1. QUEM
  if not public.is_admin() then
    raise exception 'formulario_publico_regularizar: apenas administrador.'
      using errcode = '42501';
  end if;
  if p_operador is null then
    raise exception 'formulario_publico_regularizar: operador responsavel ausente. Nada foi gravado.'
      using errcode = '22023';
  end if;

  -- 2. A ENTRADA
  if p_modo is null or p_modo not in ('vincular', 'criar') then
    raise exception 'REGULARIZACAO_RECUSADA:modo_invalido' using errcode = '22023';
  end if;
  if p_fonte_tipo is null or p_fonte_tipo not in
       ('lista_oficial_previa', 'confirmacao_presencial', 'contato_previamente_conhecido') then
    raise exception 'REGULARIZACAO_RECUSADA:fonte_fora_do_vocabulario (%). Aceitas: lista_oficial_previa, confirmacao_presencial, contato_previamente_conhecido.',
      coalesce(p_fonte_tipo, 'nula')
      using errcode = '22023';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) < 20 then
    raise exception 'REGULARIZACAO_RECUSADA:motivo_insuficiente' using errcode = '22023';
  end if;
  if p_participant_id is null then
    raise exception 'REGULARIZACAO_RECUSADA:participante_ausente' using errcode = '22023';
  end if;

  -- 3. A TRAVA DA SUBMISSAO
  select * into v_sub from public.external_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'REGULARIZACAO_RECUSADA:submissao_inexistente' using errcode = 'P0002';
  end if;
  -- O ESCOPO: a segunda resposta do formulario publico. Depois de regularizada,
  -- a aplicacao do plano troca o `bloqueio` da linha -- e o livro e quem ainda
  -- diz que ela era uma segunda resposta. Sem isso, o segundo operador de uma
  -- corrida leria "fora do escopo" em vez de "ja decidida".
  if v_sub.formulario_id <> 'formulario-publico'
     or (coalesce(v_sub.bloqueio ->> 'codigo', '') <> 'SEGUNDA_RESPOSTA_MESMO_EMAIL'
         and not exists (select 1 from public.external_identity_resolutions r
                          where r.submission_id = v_sub.id and r.resultado = 'confirmado')) then
    raise exception 'REGULARIZACAO_RECUSADA:fora_do_escopo (so a segunda resposta do formulario publico se regulariza aqui)'
      using errcode = '22023';
  end if;
  if p_referencia is null
     or length(btrim(p_referencia)) < 20
     or length(public.regularizacao_substancia(p_referencia, v_sub.email_coletado, v_sub.nome_declarado)) < 15 then
    raise exception 'REGULARIZACAO_RECUSADA:referencia_sem_substancia. A referencia tem de identificar a conferencia (qual lista/linha, quem confirmou, quando, por qual contato ja conhecido), e nao pode ser so "identidade conferida" nem o nome/e-mail do proprio formulario.'
      using errcode = '22023';
  end if;

  v_primeira := nullif(v_sub.bloqueio ->> 'participante_com_resposta', '')::uuid;
  v_antes := jsonb_build_object(
    'estado', v_sub.estado,
    'participant_id', v_sub.participant_id,
    'identidade_via', v_sub.identidade_via,
    'email_coletado', v_sub.email_coletado,
    'email_verificado', v_sub.email_verificado,
    'nome_declarado', v_sub.nome_declarado,
    'bloqueio', v_sub.bloqueio,
    'importado_por', v_sub.importado_por,
    'importado_por_email', v_sub.importado_por_email,
    'atualizado_em', v_sub.atualizado_em,
    'respostas_coletadas', (select count(*) from jsonb_object_keys(v_sub.respostas_brutas)));
  v_ato := case p_modo when 'vincular' then 'regularizar_vinculo' else 'regularizar_criacao' end;

  -- 4. A SUBMISSAO AINDA E A QUE O OPERADOR VIU?
  if v_sub.estado <> 'conflito' then
    v_recusa := 'submissao_ja_decidida';
    v_recusa_det := jsonb_build_object('estado_atual', v_sub.estado);
  elsif v_sub.atualizado_em is distinct from p_atualizado_em_visto then
    v_recusa := 'submissao_mudou';
  end if;

  -- 5. O PLANO CORRESPONDE A SUBMISSAO PRESERVADA?
  if v_recusa is null then
    v_s := p_plano -> 'submissoes' -> 0;
    if p_plano is null
       or coalesce((p_plano ->> 'ok')::boolean, false) is not true
       or (p_plano ->> 'evento_id')::uuid is distinct from v_sub.event_id
       or jsonb_array_length(coalesce(p_plano -> 'submissoes', '[]'::jsonb)) <> 1
       or (p_plano -> 'origem' ->> 'formulario_id') is distinct from v_sub.formulario_id
       or (v_s ->> 'submissao_id') is distinct from v_sub.submissao_id
       or nullif(v_s ->> 'participant_id', '')::uuid is distinct from p_participant_id
       or (v_s ->> 'estado') not in ('importavel', 'incompativel')
       or (v_s -> 'proveniencia' ->> 'identidade_via') is distinct from 'decisao_do_operador'
       -- O e-mail digitado e de OUTRA pessoa: nao e "o e-mail pelo qual esta
       -- identidade foi reconciliada". A proveniencia nao pode dizer que e.
       or (v_s -> 'proveniencia' ->> 'email_reconciliado') is not null
       or coalesce((v_s -> 'coleta' ->> 'email_verificado')::boolean, false) is true
       or (v_s -> 'coleta' ->> 'email') is distinct from v_sub.email_coletado
       or (v_s -> 'coleta' -> 'respostas_brutas') is distinct from v_sub.respostas_brutas
       or (p_plano ->> 'quiz_version')::int is distinct from v_sub.quiz_version
       or (p_plano ->> 'questionario_impressao') is distinct from v_sub.questionario_impressao then
      v_recusa := 'plano_nao_corresponde';
    end if;
  end if;

  if v_recusa is null and p_participant_id = v_primeira then
    v_recusa := 'alvo_e_o_dono_da_primeira';
  end if;

  -- 6. O DESTINO
  if v_recusa is null and p_modo = 'vincular' then
    perform pg_advisory_xact_lock(public.participante_lock_key(p_participant_id));
    select p.id, p.event_id, p.email, p.full_name into v_part
      from public.participants p where p.id = p_participant_id;
    if not found then
      v_recusa := 'alvo_inexistente';
    elsif v_part.event_id <> v_sub.event_id then
      v_recusa := 'alvo_de_outro_evento';
    elsif exists (select 1 from public.quiz_responses r where r.participant_id = p_participant_id) then
      -- A trava que importa: NUNCA sobrescrever resposta canonica existente.
      v_recusa := 'alvo_tem_respostas';
      v_recusa_det := jsonb_build_object('respostas_existentes',
        (select count(*) from public.quiz_responses r where r.participant_id = p_participant_id));
    elsif exists (select 1 from public.external_submissions es
                   where es.participant_id = p_participant_id
                     and es.estado in ('importavel', 'incompativel')) then
      v_recusa := 'alvo_tem_submissao_ativa';
    elsif exists (select 1 from public.prognostics g where g.participant_id = p_participant_id) then
      v_recusa := 'alvo_tem_documento';
    end if;
    v_email := lower(btrim(coalesce(v_part.email, '')));
  elsif v_recusa is null and p_modo = 'criar' then
    v_email := lower(btrim(coalesce(p_novo_email, '')));
    v_nome := regexp_replace(btrim(coalesce(p_novo_nome, '')), '\s+', ' ', 'g');
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_nome) < 3 then
      raise exception 'REGULARIZACAO_RECUSADA:cadastro_incompleto (criar exige nome e e-mail de cadastro validos)'
        using errcode = '22023';
    end if;
    -- Duas criacoes concorrentes com o mesmo e-mail: a segunda espera e enxerga a
    -- primeira, em vez de estourar a chave unica no meio do caminho.
    perform pg_advisory_xact_lock(hashtextextended(
      'fort.regularizacao.email:' || v_sub.event_id::text || ':' || v_email, 0));
    perform pg_advisory_xact_lock(public.participante_lock_key(p_participant_id));

    if v_email = lower(btrim(coalesce(v_sub.email_coletado, ''))) then
      v_recusa := 'email_e_o_digitado';
    else
      select p.id into v_existente from public.participants p
       where p.event_id = v_sub.event_id and lower(btrim(p.email)) = v_email limit 1;
      if v_existente is not null then
        v_recusa := 'email_ja_cadastrado';
        v_recusa_det := jsonb_build_object('participante_existente', v_existente);
      else
        select p.id into v_existente from public.participants p
         where p.event_id = v_sub.event_id
           and lower(regexp_replace(btrim(p.full_name), '\s+', ' ', 'g')) = lower(v_nome)
         limit 1;
        if v_existente is not null then
          v_recusa := 'nome_ja_cadastrado';
          v_recusa_det := jsonb_build_object('participante_existente', v_existente);
        elsif exists (select 1 from public.participants p where p.id = p_participant_id) then
          v_recusa := 'plano_nao_corresponde';
        elsif exists (select 1 from public.event_people ep
                       where ep.event_id = v_sub.event_id and lower(ep.email) = v_email
                         and ep.participant_id is not null) then
          v_recusa := 'email_ja_cadastrado';
        end if;
      end if;
    end if;
  end if;

  -- O convidado da lista DENTRO do sistema, quando o operador o apontou.
  if v_recusa is null and p_convidado_id is not null then
    select ep.id, ep.event_id, ep.participant_id, ep.email into v_conv
      from public.event_people ep where ep.id = p_convidado_id;
    if not found or v_conv.event_id <> v_sub.event_id then
      v_recusa := 'convidado_inexistente';
    elsif v_conv.participant_id is not null and v_conv.participant_id <> p_participant_id then
      v_recusa := 'convidado_de_outra_pessoa';
    elsif v_conv.email is not null and lower(btrim(v_conv.email)) <> v_email then
      v_recusa := 'convidado_com_outro_email';
    end if;
  end if;

  -- RECUSA DECIDIDA: o conjunto de escrita e SO o registro no livro.
  if v_recusa is not null then
    insert into public.external_identity_resolutions (
      event_id, submission_id, submissao_id, ato, resultado, recusa_codigo,
      pessoa_participant_id, pessoa_criada, primeira_participant_id, convidado_id,
      fonte_tipo, referencia, motivo, estado_anterior, efeito, operador, operador_email
    ) values (
      v_sub.event_id, v_sub.id, v_sub.submissao_id, v_ato, 'recusado', v_recusa,
      p_participant_id, false, v_primeira, p_convidado_id,
      p_fonte_tipo, btrim(p_referencia), btrim(p_motivo), v_antes, v_recusa_det,
      p_operador, p_operador_email
    ) returning id into v_registro;
    return jsonb_build_object('ok', false, 'codigo', v_recusa, 'detalhes', v_recusa_det,
      'registro', v_registro, 'submission_id', v_sub.id);
  end if;

  -- 7. A ESCRITA, numa subtransacao.
  perform set_config('fort.regularizacao', 'on', true);
  begin
    if p_modo = 'criar' then
      -- Nasce SEM user_id: o cadastro nao e conta e nao abre sessao. O e-mail e
      -- o que a organizacao tem para a pessoa, e continua NAO verificado.
      insert into public.participants (id, event_id, full_name, email, phone)
      values (p_participant_id, v_sub.event_id, v_nome, v_email,
              nullif(btrim(coalesce(p_novo_telefone, '')), ''));
    end if;
    if p_convidado_id is not null then
      update public.event_people set participant_id = p_participant_id
       where id = p_convidado_id and participant_id is null;
    end if;

    v_res := public.importacao_externa_aplicar(p_plano);
    if coalesce((v_res ->> 'ok')::boolean, false) is not true then
      v_recusa_aplicacao := v_res;
      raise exception 'fort: revalidacao recusou' using errcode = 'FR409';
    end if;
  exception when sqlstate 'FR409' then
    null;  -- tudo desta decisao foi desfeito; a recusa vai para o livro abaixo
  end;

  if v_recusa_aplicacao is not null then
    perform set_config('fort.regularizacao', 'off', true);
    insert into public.external_identity_resolutions (
      event_id, submission_id, submissao_id, ato, resultado, recusa_codigo,
      pessoa_participant_id, pessoa_criada, primeira_participant_id, convidado_id,
      fonte_tipo, referencia, motivo, estado_anterior, efeito, operador, operador_email
    ) values (
      v_sub.event_id, v_sub.id, v_sub.submissao_id, v_ato, 'recusado', 'recusada_na_revalidacao',
      p_participant_id, false, v_primeira, p_convidado_id,
      p_fonte_tipo, btrim(p_referencia), btrim(p_motivo), v_antes,
      jsonb_build_object('aplicacao', v_recusa_aplicacao), p_operador, p_operador_email
    ) returning id into v_registro;
    return jsonb_build_object('ok', false, 'codigo', 'recusada_na_revalidacao',
      'detalhes', jsonb_build_object('recusadas_na_revalidacao', v_recusa_aplicacao -> 'recusadas_na_revalidacao'),
      'registro', v_registro, 'submission_id', v_sub.id);
  end if;

  -- 8. CONFERE O QUE FICOU GRAVADO. Qualquer desvio desfaz tudo.
  select es.participant_id, es.estado, es.identidade_via, es.email_verificado, es.apto_para_pontuar
    into v_depois
    from public.external_submissions es where es.id = v_sub.id;
  if v_depois.participant_id is distinct from p_participant_id
     or v_depois.estado not in ('importavel', 'incompativel')
     or v_depois.identidade_via is distinct from 'decisao_do_operador'
     or v_depois.email_verificado is not false then
    raise exception 'formulario_publico_regularizar: o que ficou gravado nao e o que foi decidido (submissao %). Nada foi gravado.',
      v_sub.submissao_id;
  end if;

  -- A CONCLUSAO, com a disciplina do formulario publico: conferida NO BANCO
  -- (toda etapa da versao tem linha), so para dado APTO, e condicional. Sem ela
  -- a pessoa nao entra na geracao -- e e para ela ter documento que isto existe.
  -- ENTREGA e outra coisa: continua bloqueada (gatilho da secao 10).
  select count(*) into v_total_etapas from public.quiz_stages qs where qs.quiz_version = v_sub.quiz_version;
  select count(distinct r.stage_id) into v_respondidas
    from public.quiz_responses r
    join public.quiz_stages qs on qs.id = r.stage_id and qs.quiz_version = v_sub.quiz_version
   where r.participant_id = p_participant_id;
  if v_depois.estado = 'importavel' and v_total_etapas > 0 and v_respondidas = v_total_etapas then
    update public.participants set completed_at = now()
     where id = p_participant_id and completed_at is null;
    v_concluido := true;
  end if;

  perform set_config('fort.regularizacao', 'off', true);

  insert into public.external_identity_resolutions (
    event_id, submission_id, submissao_id, ato, resultado, recusa_codigo,
    pessoa_participant_id, pessoa_criada, primeira_participant_id, convidado_id,
    fonte_tipo, referencia, motivo, estado_anterior, efeito, operador, operador_email
  ) values (
    v_sub.event_id, v_sub.id, v_sub.submissao_id, v_ato, 'confirmado', null,
    p_participant_id, p_modo = 'criar', v_primeira, p_convidado_id,
    p_fonte_tipo, btrim(p_referencia), btrim(p_motivo), v_antes,
    jsonb_build_object(
      'aplicacao', v_res,
      'estado_depois', v_depois.estado,
      'apto_para_pontuar', v_depois.apto_para_pontuar,
      'identidade_via', v_depois.identidade_via,
      'email_verificado', v_depois.email_verificado,
      'conclusao_marcada', v_concluido,
      'identidade', 'confirmada_pela_organizacao',
      'destinatario', 'nao_confirmado',
      'entrega', 'bloqueada_ate_confirmar_destinatario'),
    p_operador, p_operador_email
  ) returning id into v_registro;

  insert into public.external_submission_events (
    submission_id, acao, operador, operador_email, justificativa, detalhes
  ) values (
    v_sub.id, 'regularizada_pelo_operador', p_operador, p_operador_email, btrim(p_motivo),
    jsonb_build_object('registro', v_registro, 'ato', v_ato, 'pessoa', p_participant_id,
      'fonte_tipo', p_fonte_tipo, 'antes', v_antes)
  );

  return jsonb_build_object(
    'ok', true,
    'registro', v_registro,
    'submission_id', v_sub.id,
    'ato', v_ato,
    'participant_id', p_participant_id,
    'pessoa_criada', p_modo = 'criar',
    'estado', v_depois.estado,
    'conclusao_marcada', v_concluido,
    'linhas_de_resposta_gravadas', coalesce((v_res ->> 'linhas_de_resposta_gravadas')::int, 0),
    'itens_registrados', coalesce((v_res ->> 'itens_registrados')::int, 0),
    'destinatario', 'nao_confirmado'
  );
end;
$$;

comment on function public.formulario_publico_regularizar(uuid, timestamptz, uuid, text, text, uuid, text, text, text, uuid, text, text, text, jsonb) is
  'Liga a segunda resposta do formulario publico (SEGUNDA_RESPOSTA_MESMO_EMAIL) a pessoa confirmada pela organizacao (fonte em vocabulario fechado), vinculando a cadastro existente sem resposta ou criando cadastro quando nao ha correspondente. Grava pelas respostas pela importacao atomica (022/024). Nunca sobrescreve resposta canonica, nunca marca e-mail como verificado, nunca libera entrega.';

-- ===========================================================================
-- 9. DESCONSIDERAR: a primeira e a valida; a segunda fica como registro
-- ===========================================================================
create or replace function public.formulario_publico_desconsiderar(
  p_submission_id uuid,
  p_atualizado_em_visto timestamptz,
  p_operador uuid,
  p_operador_email text,
  p_fonte_tipo text,
  p_referencia text,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_sub public.external_submissions%rowtype;
  v_antes jsonb;
  v_primeira uuid;
  v_recusa text;
  v_recusa_det jsonb := '{}'::jsonb;
  v_registro uuid;
begin
  if not public.is_admin() then
    raise exception 'formulario_publico_desconsiderar: apenas administrador.'
      using errcode = '42501';
  end if;
  if p_operador is null then
    raise exception 'formulario_publico_desconsiderar: operador responsavel ausente.' using errcode = '22023';
  end if;
  if p_fonte_tipo is null or p_fonte_tipo not in
       ('lista_oficial_previa', 'confirmacao_presencial', 'contato_previamente_conhecido') then
    raise exception 'REGULARIZACAO_RECUSADA:fonte_fora_do_vocabulario (%)', coalesce(p_fonte_tipo, 'nula')
      using errcode = '22023';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) < 20 then
    raise exception 'REGULARIZACAO_RECUSADA:motivo_insuficiente' using errcode = '22023';
  end if;

  select * into v_sub from public.external_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'REGULARIZACAO_RECUSADA:submissao_inexistente' using errcode = 'P0002';
  end if;
  if v_sub.formulario_id <> 'formulario-publico'
     or (coalesce(v_sub.bloqueio ->> 'codigo', '') <> 'SEGUNDA_RESPOSTA_MESMO_EMAIL'
         and not exists (select 1 from public.external_identity_resolutions r
                          where r.submission_id = v_sub.id and r.resultado = 'confirmado')) then
    raise exception 'REGULARIZACAO_RECUSADA:fora_do_escopo' using errcode = '22023';
  end if;
  if p_referencia is null
     or length(btrim(p_referencia)) < 20
     or length(public.regularizacao_substancia(p_referencia, v_sub.email_coletado, v_sub.nome_declarado)) < 15 then
    raise exception 'REGULARIZACAO_RECUSADA:referencia_sem_substancia' using errcode = '22023';
  end if;

  v_primeira := nullif(v_sub.bloqueio ->> 'participante_com_resposta', '')::uuid;
  v_antes := jsonb_build_object(
    'estado', v_sub.estado, 'participant_id', v_sub.participant_id,
    'email_coletado', v_sub.email_coletado, 'email_verificado', v_sub.email_verificado,
    'nome_declarado', v_sub.nome_declarado, 'bloqueio', v_sub.bloqueio,
    'atualizado_em', v_sub.atualizado_em,
    'respostas_coletadas', (select count(*) from jsonb_object_keys(v_sub.respostas_brutas)));

  if v_sub.estado <> 'conflito' then
    v_recusa := 'submissao_ja_decidida';
    v_recusa_det := jsonb_build_object('estado_atual', v_sub.estado);
  elsif v_sub.atualizado_em is distinct from p_atualizado_em_visto then
    v_recusa := 'submissao_mudou';
  elsif v_primeira is null
     or not exists (select 1 from public.quiz_responses r where r.participant_id = v_primeira) then
    -- Desconsiderar a segunda quando a primeira ja nao existe deixaria a pessoa
    -- sem resposta nenhuma. Nao e esta decisao que se toma as cegas.
    v_recusa := 'primeira_resposta_ausente';
  end if;

  if v_recusa is not null then
    insert into public.external_identity_resolutions (
      event_id, submission_id, submissao_id, ato, resultado, recusa_codigo,
      pessoa_participant_id, primeira_participant_id,
      fonte_tipo, referencia, motivo, estado_anterior, efeito, operador, operador_email
    ) values (
      v_sub.event_id, v_sub.id, v_sub.submissao_id, 'desconsiderar', 'recusado', v_recusa,
      v_primeira, v_primeira,
      p_fonte_tipo, btrim(p_referencia), btrim(p_motivo), v_antes, v_recusa_det,
      p_operador, p_operador_email
    ) returning id into v_registro;
    return jsonb_build_object('ok', false, 'codigo', v_recusa, 'detalhes', v_recusa_det,
      'registro', v_registro, 'submission_id', v_sub.id);
  end if;

  perform set_config('fort.regularizacao', 'on', true);
  -- So o ESTADO muda. Payload cru, e-mail digitado, nome, bloqueio original:
  -- tudo fica. A linha sai da fila de conflitos ativos e passa a ser imutavel.
  update public.external_submissions
     set estado = 'desconsiderada', atualizado_em = now()
   where id = v_sub.id;
  perform set_config('fort.regularizacao', 'off', true);

  insert into public.external_identity_resolutions (
    event_id, submission_id, submissao_id, ato, resultado, recusa_codigo,
    pessoa_participant_id, primeira_participant_id,
    fonte_tipo, referencia, motivo, estado_anterior, efeito, operador, operador_email
  ) values (
    v_sub.event_id, v_sub.id, v_sub.submissao_id, 'desconsiderar', 'confirmado', null,
    v_primeira, v_primeira,
    p_fonte_tipo, btrim(p_referencia), btrim(p_motivo), v_antes,
    jsonb_build_object('estado_depois', 'desconsiderada', 'primeira_intacta', true,
                       'submissao_preservada', true),
    p_operador, p_operador_email
  ) returning id into v_registro;

  insert into public.external_submission_events (
    submission_id, acao, operador, operador_email, justificativa, detalhes
  ) values (
    v_sub.id, 'desconsiderada_pelo_operador', p_operador, p_operador_email, btrim(p_motivo),
    jsonb_build_object('registro', v_registro, 'primeira', v_primeira,
      'fonte_tipo', p_fonte_tipo, 'antes', v_antes)
  );

  return jsonb_build_object('ok', true, 'registro', v_registro, 'submission_id', v_sub.id,
    'ato', 'desconsiderar', 'primeira', v_primeira, 'estado', 'desconsiderada');
end;
$$;

-- ===========================================================================
-- 10. O SEGUNDO FATO, e a trava da ENTREGA
-- ===========================================================================
create or replace function public.formulario_publico_confirmar_destinatario(
  p_participant_id uuid,
  p_operador uuid,
  p_operador_email text,
  p_canal_tipo text,
  p_referencia text,
  p_email_destinatario text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_part record;
  v_email text := lower(btrim(coalesce(p_email_destinatario, '')));
  v_registro uuid;
begin
  if not public.is_admin() then
    raise exception 'formulario_publico_confirmar_destinatario: apenas administrador.'
      using errcode = '42501';
  end if;
  if p_operador is null then
    raise exception 'formulario_publico_confirmar_destinatario: operador ausente.' using errcode = '22023';
  end if;
  if p_canal_tipo is null or p_canal_tipo not in ('confirmacao_presencial', 'contato_previamente_conhecido') then
    raise exception 'DESTINATARIO_RECUSADO:canal_fora_do_vocabulario (%). Aceitos: confirmacao_presencial, contato_previamente_conhecido.',
      coalesce(p_canal_tipo, 'nulo') using errcode = '22023';
  end if;

  select p.id, p.event_id, lower(btrim(p.email)) as email, p.full_name into v_part
    from public.participants p where p.id = p_participant_id for update;
  if not found then
    raise exception 'DESTINATARIO_RECUSADO:participante_inexistente' using errcode = 'P0002';
  end if;
  if p_referencia is null or length(btrim(p_referencia)) < 20
     or length(public.regularizacao_substancia(p_referencia, v_part.email, v_part.full_name)) < 15 then
    raise exception 'DESTINATARIO_RECUSADO:referencia_sem_substancia' using errcode = '22023';
  end if;
  if not exists (select 1 from public.external_identity_resolutions r
                  where r.pessoa_participant_id = p_participant_id
                    and r.resultado = 'confirmado'
                    and r.ato in ('regularizar_vinculo', 'regularizar_criacao')) then
    raise exception 'DESTINATARIO_RECUSADO:sem_regularizacao (este registro e o segundo fato de uma regularizacao)'
      using errcode = '22023';
  end if;
  if v_email <> v_part.email then
    raise exception 'DESTINATARIO_RECUSADO:email_nao_e_o_do_cadastro' using errcode = '22023';
  end if;

  insert into public.external_recipient_confirmations (
    event_id, participant_id, email_destinatario, canal_tipo, referencia, operador, operador_email
  ) values (
    v_part.event_id, p_participant_id, v_email, p_canal_tipo, btrim(p_referencia), p_operador, p_operador_email
  ) returning id into v_registro;

  return jsonb_build_object('ok', true, 'registro', v_registro, 'participant_id', p_participant_id,
    'email_destinatario', v_email, 'email_verificado', false);
end;
$$;

-- A ENTREGA de documento de pessoa regularizada exige o segundo fato, para o
-- endereco que o cadastro tem AGORA. Gatilho, nao convencao: vale para o painel,
-- para o PostgREST e para quem mais escrever em `prognostics`.
create or replace function public.prognostics_destinatario_da_regularizacao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if new.status <> 'delivered' or (tg_op = 'UPDATE' and old.status = 'delivered') then
    return new;
  end if;
  if not exists (select 1 from public.external_identity_resolutions r
                  where r.pessoa_participant_id = new.participant_id
                    and r.resultado = 'confirmado'
                    and r.ato in ('regularizar_vinculo', 'regularizar_criacao')) then
    return new;
  end if;
  select pg_catalog.lower(pg_catalog.btrim(p.email)) into v_email
    from public.participants p where p.id = new.participant_id;
  if not exists (select 1 from public.external_recipient_confirmations c
                  where c.participant_id = new.participant_id
                    and c.email_destinatario = v_email) then
    raise exception
      'Entrega recusada: a identidade deste participante foi confirmada por regularizacao, mas o DESTINATARIO (%) nao foi confirmado por canal independente.',
      v_email
      using errcode = 'check_violation',
            hint = 'Registre a confirmacao do destinatario (formulario_publico_confirmar_destinatario) antes de entregar.';
  end if;
  return new;
end;
$$;

drop trigger if exists prognostics_destinatario_da_regularizacao on public.prognostics;
create trigger prognostics_destinatario_da_regularizacao
  before insert or update on public.prognostics
  for each row
  execute function public.prognostics_destinatario_da_regularizacao();

-- ===========================================================================
-- 11. QUEM EXECUTA
-- ===========================================================================
-- So o servidor (service_role), e dentro das funcoes is_admin() confere de
-- novo. Participante e anonimo nao executam -- nem chegam a entrar.
revoke all on function public.formulario_publico_regularizar(uuid, timestamptz, uuid, text, text, uuid, text, text, text, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.formulario_publico_desconsiderar(uuid, timestamptz, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.formulario_publico_confirmar_destinatario(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.prognostics_destinatario_da_regularizacao() from public, anon, authenticated;
grant execute on function public.formulario_publico_regularizar(uuid, timestamptz, uuid, text, text, uuid, text, text, text, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.formulario_publico_desconsiderar(uuid, timestamptz, uuid, text, text, text, text) to service_role;
grant execute on function public.formulario_publico_confirmar_destinatario(uuid, uuid, text, text, text, text) to service_role;
