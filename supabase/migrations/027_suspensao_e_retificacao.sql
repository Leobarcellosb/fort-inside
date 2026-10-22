-- 027_suspensao_e_retificacao.sql
-- SUSPENDER UM DOCUMENTO JÁ ENTREGUE, E CORRIGI-LO POR NOVA REVISÃO APROVADA.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 024, a 025 e a 026.
-- O banco que serve o evento de sábado não é tocado por esta unidade, nem para
-- leitura.
--
-- Migration NOVA, sobre a 015, a 025 e a 026, e SEM DESFAZER NADA das três: a
-- máquina de estados segue recusando regressão entre os seis estados dela, o
-- selo de aprovação segue sendo o único portão da entrega, e o histórico do
-- conteúdo entregue segue append-only e escrito só por gatilho.
--
-- ---------------------------------------------------------------
-- O PRINCÍPIO QUE GOVERNA ESTE ARQUIVO, nas palavras da revisão
-- ---------------------------------------------------------------
--   "Um erro num documento entregue precisa poder ser corrigido. Mas a correção
--    NÃO PODE APAGAR O ERRO DA HISTÓRIA, nem deixar o jovem EXPOSTO AO CONTEÚDO
--    INCORRETO enquanto a organização trabalha na nova versão."
--
-- São DUAS exigências que puxam para lados diferentes, e as duas têm de valer:
--
--   não apagar o erro       -> nada é sobrescrito e nada é removido. O conteúdo
--                              suspenso continua em `prognostics.final_content`,
--                              continua em `prognostic_delivery_history` (026) com
--                              a impressão digital e a data em que passou a valer,
--                              e o ato de suspender entra num livro-razão próprio
--                              que ninguém altera nem apaga.
--   não deixar exposto      -> a SUSPENSÃO é um ato só, imediato, que não depende
--                              de a correção estar pronta: o estado sai de
--                              `delivered` e a página do participante deixa de
--                              renderizar o texto. Suspender TIRA DO AR; não
--                              reescreve o passado.
--
-- A ordem de prioridade, também da revisão: "suspensão segura e retificação
-- versionada, NESSA ORDEM". Este arquivo entrega as duas, nessa ordem.
--
-- ---------------------------------------------------------------
-- O IMPASSE DE HOJE, medido
-- ---------------------------------------------------------------
-- Um documento `delivered` não pode ser corrigido por caminho nenhum:
--   1. o gatilho da 015 recusa `delivered -> reviewed` (é regressão de estado);
--   2. sem voltar a `reviewed` com `reviewed_at` novo, o gatilho da 025 não
--      refaz o selo -- e sem selo sobre o texto novo a reentrega é recusada.
-- As duas travas, juntas, fecham o caminho. Isso NÃO é defeito: são as MESMAS
-- travas que tornam impossível entregar conteúdo não aprovado, e a revisão foi
-- explícita em não reabrir a porta.
--
-- ---------------------------------------------------------------
-- O DESENHO: um caminho PARA A FRENTE, não uma regressão permitida
-- ---------------------------------------------------------------
-- O que falta não é "poder voltar". É um caminho que passe por SUSPENSO e
-- chegue a entregue de novo sem nunca andar para trás:
--
--     delivered  ->  suspended  ->  in_review / reviewed  ->  delivered
--                    (tira do ar)   (nova revisão =          (selo novo exigido
--                                    nova aprovação, 025)     pela 025, como sempre)
--
-- E o detalhe que faz isso caber sem afrouxar nada: `suspended` fica FORA do
-- vetor de ordem do gatilho da 015. Lá está escrito, no próprio gatilho:
--
--     if pos_antiga is null or pos_nova is null then return new; end if;
--
-- isto é, a 015 só opina sobre transições entre os SEIS estados que ela ordena.
-- Com `suspended` fora daquele vetor, `delivered -> suspended` e
-- `suspended -> reviewed` passam pela 015 intocadas, e a garantia dela continua
-- exatamente a mesma: `delivered -> reviewed` DIRETO segue recusado, e nenhum dos
-- seis estados regride. Nenhuma linha da 015 é reescrita, nenhum gatilho dela é
-- desligado, e não existe transição nova entre os seis.
--
-- O preço disso, declarado: a 015 deixa de ser a ÚNICA autoridade sobre o estado
-- do documento, porque ela não governa o sétimo valor. Então o sétimo valor
-- ganha a cerca dele AQUI, no gatilho `prognostics_suspensao`, e a cerca é
-- fechada nas duas pontas:
--   - para dentro de `suspended`: SÓ de `delivered`. Suspender é tirar do ar o
--     que alguém está lendo; documento que ninguém leu não tem o que suspender,
--     e o portão da entrega (025) já cuida de quem nunca foi aprovado.
--   - para fora de `suspended`: SÓ para `in_review` ou `reviewed`. NÃO para
--     `delivered` -- reentregar direto, sem nova revisão, devolveria ao ar o
--     mesmo texto errado (o selo da 025 bateria, porque o conteúdo não mudou), e
--     é exatamente isso que a suspensão existe para impedir.
--   - nascer suspenso é recusado no INSERT: um documento que ninguém entregou
--     não pode aparecer no livro-razão como tendo saído do ar.
--
-- ALTERNATIVAS CONSIDERADAS E RECUSADAS, para quem vier depois:
--   (a) Permitir `delivered -> reviewed` no gatilho da 015 (afrouxar a
--       regressão). É a porta que a revisão mandou manter fechada, e ela
--       reabriria junto o caminho de regeração que apagava trabalho de revisão
--       -- o defeito que a 015 nasceu para fechar.
--   (b) Coluna de versão em `prognostics` + regressão permitida quando a versão
--       avança. Move a decisão para o chamador, que é onde o defeito da 025
--       nasceu ("uma tabela de versões move a decisão para o chamador").
--   (c) Um sétimo estado DEPOIS de `delivered` para a reentrega (`redelivered`).
--       Quebraria em silêncio tudo o que hoje pergunta `status = 'delivered'`:
--       o CHECK da 025, o gatilho do histórico da 026, a policy de leitura do
--       participante da 002 e a consulta da página pública. Cada um desses
--       precisaria de um segundo CHECK, um segundo gatilho e uma segunda
--       policy -- duas maneiras de dizer o mesmo fato, que é como invariantes
--       deixam de valer.
--   O desenho adotado não precisa de nenhum segundo CHECK: ao voltar a
--   `delivered`, a entrega é a MESMA entrega de sempre, com o MESMO portão.
--
-- ---------------------------------------------------------------
-- A SUSPENSÃO É ATO DE OPERADOR: quem, quando e POR QUÊ
-- ---------------------------------------------------------------
-- Mesmo padrão de auditoria do resto do projeto, com as duas metades que os dois
-- precedentes deste repositório já estabeleceram:
--
--   da 022 (`external_submission_events`): ato de operador sem justificativa não
--     é ato registrado -- `check (... justificativa is not null and length(btrim(...)) >= 3)`.
--     Aqui o motivo é exigido por CHECK na PRÓPRIA LINHA do documento: não existe
--     `status = 'suspended'` sem operador e sem motivo. Não é desencorajado: é
--     impossível, como o selo da 025.
--   da 026 (`prognostic_delivery_history`): o livro é escrito SOMENTE por gatilho,
--     e INSERT, UPDATE, DELETE e TRUNCATE são revogados de anon, authenticated e
--     service_role. A aplicação não consegue registrar uma suspensão que não
--     aconteceu, nem ESQUECER de registrar uma que aconteceu -- e o segundo caso
--     é o pior, porque falha em silêncio.
--
-- A divisão de trabalho entre aplicação e banco, explícita:
--   a APLICAÇÃO informa o que só ela sabe -- QUEM (a sessão do administrador, lida
--     no servidor, nunca vinda do corpo do pedido) e POR QUÊ (o motivo escrito);
--   o BANCO carimba QUANDO (`now()`, nunca o relógio de quem chamou, como na 026),
--     torna os três imutáveis enquanto a suspensão durar, e registra o ato.
--
-- ---------------------------------------------------------------
-- O QUE A SUSPENSÃO NÃO FAZ, declarado
-- ---------------------------------------------------------------
-- 1. Não apaga, não move e não reescreve conteúdo. `final_content` fica onde
--    está; `prognostic_delivery_history` fica como está; o selo da 025 fica como
--    está (ele é imutável fora do ato de aprovação, e segue dizendo a verdade
--    sobre qual texto foi aprovado).
-- 2. Não revoga o `public_share_token`. O link na mão do jovem continua sendo o
--    dele e volta a funcionar sozinho quando a nova versão é entregue. O
--    problema que a suspensão resolve é de CONTEÚDO, não de ACESSO -- e punir o
--    link é punir quem não errou. Se algum dia o problema for de acesso (o link
--    chegou à pessoa errada), isso é outro ato, com outra decisão de produto, e
--    esta migration não o cobre.
-- 3. Não apaga o PDF do Storage. O que ela faz é zerar `pdf_url` na linha, para
--    que nem a página nem a rota de status voltem a oferecer o arquivo do texto
--    suspenso. O objeto em si continua no bucket: remover arquivo de Storage é
--    operação de outra camada e apagar é justamente o que esta migration não faz.
-- 4. Não decide o que o participante LÊ na página. Ela torna o fato consultável
--    (`status = 'suspended'`); o texto que o jovem vê é da aplicação
--    (`components/features/prognostic/documento-suspenso.ts`), onde ele pode ser
--    lido, revisado e provado por quem escreve para adolescente.
-- 5. Não registra QUEM reentregou. O livro-razão fecha a suspensão com o ato
--    "reentregue" -- data e impressão digital do texto que entrou no ar --, mas a
--    entrega não passa por rota (a tela grava direto no banco, com a sessão do
--    administrador), e o livro não inventa autor para um ato cujo autor ele não
--    recebeu. Quem APROVOU o texto novo está em `prognostics.aprovado_em` (025);
--    quem suspendeu está nomeado aqui.
-- 6. Não muda `v_historico_do_conteudo_entregue` (026). `vigente` ali significa
--    "é o texto vigente desta linha", não "está no ar": quem responde se está no
--    ar é `prognostics.status` e este livro-razão. Reescrever aquela view para
--    acrescentar colunas tornaria a 026 não-reaplicável (um
--    `create or replace view` não derruba coluna), e o projeto exige migrations
--    reaplicáveis.
--
-- ---------------------------------------------------------------
-- SOBRE O CHECK DO STATUS, declarado
-- ---------------------------------------------------------------
-- O sétimo valor entra pelo MESMO nome de constraint da 015
-- (`prognostics_status_check`), drop + add, como a 015 já faz com ele. Logo:
-- reaplicar a 015 DEPOIS da 027 estreita o CHECK de volta para seis valores e,
-- se existir documento suspenso, a validação ABORTA a reaplicação em vez de
-- passar e deixar linha fora do vocabulário. As migrations rodam em ordem
-- crescente, então isso só acontece se alguém reaplicar a 015 à mão -- e, se
-- acontecer, o banco recusa em voz alta.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- 1. O SÉTIMO VALOR no vocabulário de estado
-- ---------------------------------------------------------------------------
-- Mesma guarda da 015: VERIFICA antes de restringir e ABORTA listando o que
-- encontrou, em vez de inventar mapeamento (isso é decisão de produto).
do $$
declare
  desconhecidos text;
begin
  select string_agg(distinct coalesce(status, '<NULL>') || ' (' || n || ')', ', ')
    into desconhecidos
  from (
    select status, count(*) as n
    from public.prognostics
    where status is null
       or status not in ('pending', 'generating', 'generated', 'in_review',
                         'reviewed', 'delivered', 'suspended')
    group by status
  ) x;

  if desconhecidos is not null then
    raise exception
      '027: prognostics.status tem valores fora dos sete estados aprovados: %. Decisao de produto necessaria antes de restringir; nenhuma linha foi alterada.',
      desconhecidos
      using errcode = 'check_violation';
  end if;
end
$$;

-- NOT VALID + VALIDATE, como na 015 e na 025: o ADD direto segura lock
-- exclusivo enquanto varre a tabela.
alter table public.prognostics
  drop constraint if exists prognostics_status_check;

alter table public.prognostics
  add constraint prognostics_status_check
  check (status in ('pending', 'generating', 'generated', 'in_review',
                    'reviewed', 'delivered', 'suspended'))
  not valid;

alter table public.prognostics
  validate constraint prognostics_status_check;

-- ---------------------------------------------------------------------------
-- 2. QUEM, QUANDO e POR QUÊ, na própria linha do documento
-- ---------------------------------------------------------------------------
alter table public.prognostics
  add column if not exists suspenso_em timestamptz,
  add column if not exists suspenso_por uuid,
  add column if not exists suspenso_por_email text,
  add column if not exists suspensao_motivo text;

comment on column public.prognostics.suspenso_em is
  'Instante em que o documento saiu do ar. Escrito SOMENTE pelo gatilho prognostics_suspensao, com now() do banco: o relogio de quem chamou nao entra aqui.';
comment on column public.prognostics.suspenso_por is
  'Administrador que suspendeu, lido da SESSAO no servidor (app/api/prognostics/[id]/suspender). Nunca vem do corpo do pedido.';
comment on column public.prognostics.suspenso_por_email is
  'E-mail do administrador que suspendeu, como estava na sessao. Fica junto do uuid para o livro-razao seguir legivel se a conta mudar.';
comment on column public.prognostics.suspensao_motivo is
  'POR QUE o documento saiu do ar, escrito pelo operador. Obrigatorio por CHECK: nao existe documento suspenso sem motivo. Nunca e mostrado ao participante.';

-- ---------------------------------------------------------------------------
-- 3. O LIVRO-RAZÃO DA SUSPENSÃO (append-only, escrito só por gatilho)
-- ---------------------------------------------------------------------------
create table if not exists public.prognostic_suspension_events (
  id uuid primary key default gen_random_uuid(),

  -- `on delete cascade` nos dois, igual ao que a 026 faz e pela mesma razão
  -- declarada lá: append-only governa quem pode REESCREVER a história de uma
  -- pessoa que existe, e não é promessa de guardar o registro de alguém depois
  -- de um pedido de exclusão.
  prognostic_id uuid not null
    references public.prognostics(id) on delete cascade,
  participant_id uuid not null
    references public.participants(id) on delete cascade,

  -- A ORDEM, independente de relógio (mesma razão da 026): dois registros na
  -- mesma transação empatariam em `em`, e aí "qual veio depois" não teria
  -- resposta.
  sequencia bigint generated always as identity,

  acao text not null,

  -- QUEM. Nulo é permitido só em 'reentregue' (ver "o que a suspensão não faz",
  -- item 5); em 'suspenso' o CHECK abaixo o exige.
  operador uuid,
  operador_email text,

  -- POR QUÊ. Exigido em 'suspenso' pelo CHECK abaixo.
  motivo text,

  -- A IMPRESSÃO DIGITAL do texto que saiu do ar ('suspenso') ou que entrou no ar
  -- ('reentregue'). Mesmo algoritmo e mesma forma da 025 e da 026, de propósito:
  -- "era o que foi aprovado?" e "é o mesmo que ele leu antes?" se respondem
  -- comparando impressões, sem reler texto nenhum.
  conteudo_hash text not null,

  em timestamptz not null
);

do $$
begin
  alter table public.prognostic_suspension_events
    drop constraint if exists prognostic_suspension_events_acao_check;
  alter table public.prognostic_suspension_events
    add constraint prognostic_suspension_events_acao_check
    check (acao in (
      'suspenso',    -- saiu do ar por ato de operador, com motivo
      'reentregue'   -- a versao corrigida entrou no ar e fechou a suspensao
    ));

  -- Mesma regra da 022, na forma dela: ato de operador sem justificativa não é
  -- ato registrado. Aqui o piso é 10 caracteres, e não 3: "erro" cabe em 3 e não
  -- diz nada a quem for ler isso na segunda-feira com um jovem na frente.
  alter table public.prognostic_suspension_events
    drop constraint if exists prognostic_suspension_events_motivo_check;
  alter table public.prognostic_suspension_events
    add constraint prognostic_suspension_events_motivo_check
    check (
      acao <> 'suspenso'
      or (motivo is not null and length(btrim(motivo)) >= 10 and operador is not null)
    );
end $$;

-- A pergunta é "o que aconteceu com o documento DESTA PESSOA, e em que ordem".
create index if not exists prognostic_suspension_events_participante_idx
  on public.prognostic_suspension_events (participant_id, sequencia);
create index if not exists prognostic_suspension_events_documento_idx
  on public.prognostic_suspension_events (prognostic_id, sequencia);

comment on table public.prognostic_suspension_events is
  'APPEND-ONLY. Livro-razao da suspensao de documento individual: quem tirou do ar, quando, POR QUE, e com qual impressao digital de conteudo; e quando a versao corrigida entrou no ar. Escrita SOMENTE pelo gatilho prognostics_livro_da_suspensao; sem insert, update, delete ou truncate para anon, authenticated e service_role.';
comment on column public.prognostic_suspension_events.motivo is
  'POR QUE o operador tirou do ar, nas palavras dele. Minimo de 10 caracteres uteis por CHECK. E registro interno: a pagina do participante nunca o exibe.';
comment on column public.prognostic_suspension_events.conteudo_hash is
  'SHA-256 (hex) do conteudo que saiu do ar (acao suspenso) ou que entrou no ar (acao reentregue). Compara-se com prognostic_delivery_history.conteudo_hash (026) e com prognostics.conteudo_aprovado_hash (025).';
comment on column public.prognostic_suspension_events.em is
  'Instante do ato, carimbado pelo banco (now() ou a data que a propria linha registra), nunca o relogio de quem chamou.';

-- ---------------------------------------------------------------------------
-- 4. A CERCA DO SÉTIMO ESTADO (e o escritor único de quando/imutabilidade)
-- ---------------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE, sem `of coluna`: a cerca tem de ser reavaliada em
-- TODA escrita, pelo mesmo motivo que a 025 não repetiu o `of status` da 015.
--
-- Ordem de disparo entre os gatilhos BEFORE desta tabela é alfabética:
--   prognostics_selo_de_aprovacao (025) -> prognostics_status_sem_regressao (015)
--   -> prognostics_suspensao (este).
-- Isto importa em um caso e está declarado: numa tentativa de
-- `suspended -> delivered` com conteúdo inalterado, o selo da 025 BATE (o texto é
-- o mesmo) e portanto a 025 não recusa; quem recusa é este gatilho, com mensagem
-- própria. Se o conteúdo tiver mudado, a 025 recusa primeiro, com a dela. As duas
-- recusas são corretas e nenhuma delas deixa o texto errado voltar ao ar.
--
-- search_path vazio: tudo qualificado, nada resolvível por schema plantado.
create or replace function public.prognostics_suspensao()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- ---------------------------------------------------------------- INSERT
  if tg_op = 'INSERT' then
    if new.status = 'suspended' then
      raise exception
        'Suspensao recusada: um documento nao nasce suspenso. Suspender e tirar do ar um documento ENTREGUE.'
        using errcode = 'check_violation',
              hint = 'Insira o documento no estado em que ele nasce (generated) e suspenda depois de entregue, se preciso.';
    end if;
    -- Linha nova nunca carrega marca de suspensao.
    new.suspenso_em := null;
    new.suspenso_por := null;
    new.suspenso_por_email := null;
    new.suspensao_motivo := null;
    return new;
  end if;

  -- -------------------------------------------------- ENTRANDO em suspended
  if new.status = 'suspended' and old.status is distinct from 'suspended' then
    if old.status <> 'delivered' then
      raise exception
        'Suspensao recusada: so um documento ENTREGUE pode ser suspenso, e este esta em "%".',
        old.status
        using errcode = 'check_violation',
              hint = 'Suspender e tirar do ar o que o participante esta lendo. Documento nao entregue ninguem leu, e entregar conteudo nao aprovado ja e impossivel.';
    end if;

    if new.suspenso_por is null then
      raise exception
        'Suspensao recusada: falta QUEM suspendeu. Ato de operador sem autor nao e ato registrado.'
        using errcode = 'check_violation',
              hint = 'A rota de suspensao le o administrador da sessao no servidor; o corpo do pedido nunca informa o autor.';
    end if;

    if new.suspensao_motivo is null
       or pg_catalog.length(pg_catalog.btrim(new.suspensao_motivo)) < 10 then
      raise exception
        'Suspensao recusada: falta POR QUE o documento saiu do ar (minimo de 10 caracteres uteis).'
        using errcode = 'check_violation',
              hint = 'Escreva o motivo: quem ler isso na segunda-feira precisa saber o que estava errado, e "erro" nao diz nada.';
    end if;

    -- QUANDO e do banco, sempre. O relogio de quem chamou nao entra (026).
    new.suspenso_em := pg_catalog.now();

    -- TIRA DO AR tambem o arquivo: `pdf_url` aponta para um PDF do texto
    -- suspenso, e o link dele pode estar na mao do jovem. Zerar o ponteiro nao
    -- apaga o objeto no Storage (ver "o que a suspensao nao faz", item 3).
    new.pdf_url := null;

    -- `final_content`, `conteudo_aprovado_hash` e `aprovado_em` NAO sao tocados:
    -- suspender tira do ar, nao reescreve o passado.
    return new;
  end if;

  -- ------------------------------------------------- SEGUINDO em suspended
  if new.status = 'suspended' and old.status = 'suspended' then
    -- Os tres fatos do ato sao IMUTAVEIS enquanto a suspensao durar: o que a
    -- aplicacao tentar escrever neles e descartado, como o selo da 025.
    new.suspenso_em := old.suspenso_em;
    new.suspenso_por := old.suspenso_por;
    new.suspenso_por_email := old.suspenso_por_email;
    new.suspensao_motivo := old.suspensao_motivo;
    return new;
  end if;

  -- ---------------------------------------------------- SAINDO de suspended
  if old.status = 'suspended' and new.status is distinct from 'suspended' then
    if new.status not in ('in_review', 'reviewed') then
      raise exception
        'Transicao recusada: de "suspended" o documento segue para nova revisao (in_review ou reviewed), nunca para "%".',
        new.status
        using errcode = 'check_violation',
              hint = 'A retificacao e PARA A FRENTE: nova revisao, nova aprovacao, nova entrega. Reentregar sem nova revisao devolveria ao ar o mesmo texto errado.';
    end if;
    -- A marca de suspensao sai da linha porque ela significa "esta fora do ar
    -- AGORA". O ato nao se perde: ele esta no livro-razao, que ninguem altera.
    new.suspenso_em := null;
    new.suspenso_por := null;
    new.suspenso_por_email := null;
    new.suspensao_motivo := null;
    return new;
  end if;

  -- ------------------------------------- nem entra, nem sai, nem esta suspenso
  -- Fora da suspensao as quatro colunas nao existem para a aplicacao: o que ela
  -- puser nelas e descartado. E o que torna o CHECK da secao 5 um invariante e
  -- nao uma esperanca.
  new.suspenso_em := null;
  new.suspenso_por := null;
  new.suspenso_por_email := null;
  new.suspensao_motivo := null;
  return new;
end;
$$;

drop trigger if exists prognostics_suspensao on public.prognostics;

create trigger prognostics_suspensao
  before insert or update on public.prognostics
  for each row
  execute function public.prognostics_suspensao();

-- A funcao do gatilho nao e chamavel por API (mesma regra da 015, 025 e 026).
revoke all on function public.prognostics_suspensao() from public;
revoke all on function public.prognostics_suspensao() from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. O CHECK: o invariante, independente do gatilho
-- ---------------------------------------------------------------------------
-- Mesma divisão de trabalho da 025: o gatilho é o único ESCRITOR e dá mensagem
-- própria; o CHECK impõe o INVARIANTE em toda escrita, inclusive se o gatilho
-- for desligado por DDL. Sem ele, o único caminho que sobra (ser dono da tabela)
-- poderia deixar um documento suspenso sem dizer por quem nem por quê.
alter table public.prognostics
  drop constraint if exists prognostics_suspensao_tem_autor_e_motivo;

alter table public.prognostics
  add constraint prognostics_suspensao_tem_autor_e_motivo
  check (
    case
      when status = 'suspended' then
        suspenso_em is not null
        and suspenso_por is not null
        and suspensao_motivo is not null
        and length(btrim(suspensao_motivo)) >= 10
      else
        -- Fora da suspensão as quatro colunas são nulas: elas significam "está
        -- fora do ar AGORA", e uma marca que sobra depois mentiria na tela.
        suspenso_em is null
        and suspenso_por is null
        and suspenso_por_email is null
        and suspensao_motivo is null
    end
  )
  not valid;

alter table public.prognostics
  validate constraint prognostics_suspensao_tem_autor_e_motivo;

-- ---------------------------------------------------------------------------
-- 6. O GATILHO QUE ESCREVE O LIVRO-RAZÃO (e só ele escreve)
-- ---------------------------------------------------------------------------
-- AFTER, não BEFORE, pela mesma razão da 026: o livro registra o que de fato
-- PASSOU pela cerca e pelos CHECKs. Um BEFORE registraria a intenção, e intenção
-- recusada não é ato de ninguém.
--
-- SECURITY DEFINER: é o que permite revogar INSERT de todo mundo e ainda assim
-- registrar. A alternativa seria dar INSERT a quem escreve em `prognostics` --
-- ou seja, permitir a mão humana ali -- e o livro voltaria a ser convenção.
create or replace function public.prognostics_livro_da_suspensao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  impressao text;
  ultima_acao text;
  entrou_agora boolean := false;
begin
  -- `old` só existe em UPDATE: em AFTER INSERT a referência a `old.status`
  -- levanta "record old is not assigned yet", e PL/pgSQL não garante curto-
  -- circuito dentro de uma expressão. Por isso o `tg_op` é testado em `if`
  -- aninhado, e não com `and` na mesma condição.
  if tg_op = 'UPDATE' then
    entrou_agora := new.status = 'suspended'
                    and old.status is distinct from 'suspended';
  end if;

  -- ENTROU em suspended: o ato do operador, com o texto que saiu do ar.
  if entrou_agora then
    -- `delivered` com `final_content` nulo é recusado pelo CHECK da 025, e só se
    -- suspende o que estava entregue; ainda assim, se algum dia existir, o certo
    -- é registrar o ato com a impressão do que a linha TEM, em vez de inventar
    -- texto ou derrubar a suspensão (que é a parte urgente).
    impressao := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        coalesce(new.final_content, new.raw_ai_output)::text, 'UTF8')),
      'hex');

    insert into public.prognostic_suspension_events
      (prognostic_id, participant_id, acao, operador, operador_email, motivo,
       conteudo_hash, em)
    values
      (new.id, new.participant_id, 'suspenso', new.suspenso_por,
       new.suspenso_por_email, new.suspensao_motivo, impressao, new.suspenso_em);

    return null;
  end if;

  -- VOLTOU ao ar: fecha a suspensão aberta, com o texto que entrou no ar.
  if new.status = 'delivered' and new.final_content is not null then
    -- Contra a ÚLTIMA linha, não contra o conjunto: um documento pode ser
    -- suspenso, retificado, e suspenso de novo, e cada ciclo tem o seu par. Se a
    -- última linha já é 'reentregue', não há suspensão aberta e nada é
    -- registrado -- é o que impede que cada escrita numa linha entregue
    -- (gravar `pdf_url`, por exemplo) empilhe 'reentregue' repetidos, do mesmo
    -- jeito que a 026 deduplica o histórico.
    select e.acao
      into ultima_acao
      from public.prognostic_suspension_events e
     where e.prognostic_id = new.id
     order by e.sequencia desc
     limit 1;

    if ultima_acao is distinct from 'suspenso' then
      return null;
    end if;

    impressao := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(new.final_content::text, 'UTF8')),
      'hex');

    insert into public.prognostic_suspension_events
      (prognostic_id, participant_id, acao, operador, operador_email, motivo,
       conteudo_hash, em)
    values
      (new.id, new.participant_id, 'reentregue', null, null, null, impressao,
       coalesce(new.delivered_at, pg_catalog.now()));

    return null;
  end if;

  return null;
end;
$$;

drop trigger if exists prognostics_livro_da_suspensao on public.prognostics;

create trigger prognostics_livro_da_suspensao
  after insert or update on public.prognostics
  for each row
  execute function public.prognostics_livro_da_suspensao();

-- A função não é chamável por API, e aqui isso importa mais: ela é
-- SECURITY DEFINER (mesma regra da 026).
revoke all on function public.prognostics_livro_da_suspensao() from public;
revoke all on function public.prognostics_livro_da_suspensao() from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. OS PRIVILÉGIOS: append-only conferível, não afirmado
-- ---------------------------------------------------------------------------
-- Mesma técnica e mesma razão da 026, inclusive `service_role` NOMEADO: ele não
-- é alcançado pela RLS (BYPASSRLS) nem pelos default privileges da 016, e é com
-- ele que as rotas de administração escrevem.
revoke insert, update, delete, truncate
  on public.prognostic_suspension_events
  from anon, authenticated, service_role;

grant select on public.prognostic_suspension_events to authenticated, service_role;

-- `anon` não tem nada aqui: por que o documento de um jovem saiu do ar não é
-- dado público, e o motivo é escrito para operador, não para ele.
revoke all on public.prognostic_suspension_events from anon;

alter table public.prognostic_suspension_events enable row level security;

-- SELECT para admin, e nenhuma policy de escrita: nem por descuido alguém abre
-- uma -- e, ainda que abrisse, o privilégio revogado acima continuaria recusando
-- (as duas camadas, como na 022 e na 026).
drop policy if exists prognostic_suspension_events_admin_select
  on public.prognostic_suspension_events;
create policy prognostic_suspension_events_admin_select
  on public.prognostic_suspension_events
  for select using (is_admin());
