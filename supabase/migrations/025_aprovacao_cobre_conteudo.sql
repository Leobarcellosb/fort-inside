-- 025_aprovacao_cobre_conteudo.sql
-- A APROVAÇÃO HUMANA PASSA A COBRIR O CONTEÚDO QUE SERÁ ENTREGUE.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015 e a 024. O banco que
-- serve o evento de sábado não é tocado por esta unidade, nem para leitura.
--
-- ---------------------------------------------------------------
-- O defeito, medido
-- ---------------------------------------------------------------
-- `prognostics` tem UMA linha por participante, sem coluna de versão e sem
-- tabela de histórico. O único gatilho que existia (migration 015) é
-- `before update OF STATUS` e só recusa REGRESSÃO de estado -- trocar apenas o
-- CONTEÚDO não o dispara.
--
-- A cadeia pós-coleta mediu o seguinte: com o documento já em `reviewed`, um
-- UPDATE que troca só `edited_content` passou. O status continuou `reviewed`, a
-- `reviewed_at` não mudou, e a página de entrega mostrou ao participante
-- exatamente o texto que NINGUÉM aprovou. Em uma frase: o selo de revisão
-- humana estava SOLTO do conteúdo que ele carimba.
--
-- ---------------------------------------------------------------
-- O desenho: impressão digital do conteúdo APROVADO
-- ---------------------------------------------------------------
-- Entre amarrar a aprovação a uma impressão digital do conteúdo e versionar a
-- tabela, esta migration faz o primeiro, por três razões:
--   1. o que o produto precisa garantir é uma frase sobre o PRESENTE -- "o que
--      será entregue é o que foi aprovado" -- e a impressão digital a garante
--      diretamente, sem depender de ninguém escolher a versão certa na hora de
--      entregar (uma tabela de versões move a decisão para o chamador, que é
--      exatamente onde o defeito de hoje nasceu);
--   2. ela é menor e cabe no tempo que falta para segunda-feira;
--   3. o histórico de versões continua possível depois, por cima desta, sem
--      desfazer nada: a coluna de impressão é o que uma tabela de versões usaria
--      para dizer qual versão foi aprovada.
-- O que esta migration NÃO entrega, declarado: histórico. Depois de uma segunda
-- revisão, o texto anterior não fica guardado em lugar nenhum.
--
-- DUAS PEÇAS, porque cada uma cobre o que a outra não cobre:
--
--   1. CHECK `prognostics_entrega_cobre_aprovacao`: o INVARIANTE, imposto em
--      toda escrita, inclusive se o gatilho abaixo for desligado por DDL --
--      status `delivered` exige `final_content` presente E com a mesma
--      impressão digital registrada em `conteudo_aprovado_hash`. Um CHECK não
--      sabe COMO a impressão foi registrada, e é por isso que ele não basta.
--
--   2. Gatilho `prognostics_selo_de_aprovacao`: é o ÚNICO que ESCREVE
--      `conteudo_aprovado_hash`. Ele sobrescreve, em toda escrita, o que a
--      aplicação tenha tentado pôr ali -- então nenhuma rota, nenhum script e
--      nenhum service_role distraído consegue registrar uma aprovação que não
--      aconteceu. Sem ele, o CHECK seria contornável escrevendo o hash do
--      próprio texto novo junto com o texto novo.
--
-- O ATO DE APROVAÇÃO, definido: um UPDATE (ou INSERT) que deixa a linha em
-- `status = 'reviewed'` com `reviewed_at` NOVO. É exatamente o que a rota de
-- revisão (`app/api/prognostics/[id]`) escreve quando o revisor salva, e é o
-- único caminho em que um humano afirma "li este texto e ele pode ir". Salvar
-- a revisão É o ato de aprovar; o selo passa a cobrir o texto daquele instante.
--
-- ---------------------------------------------------------------
-- A DECISÃO DE PRODUTO que esta migration toma, declarada
-- ---------------------------------------------------------------
-- "O revisor aprova e depois corrige uma vírgula: isso invalida a aprovação?"
--   SIM. A aprovação vale para o texto aprovado, não para o texto que ocupar o
--   lugar dele. Depois da vírgula, a impressão digital do conteúdo deixa de
--   bater com o selo e a ENTREGA É RECUSADA pelo banco.
--   O que torna isso honesto em vez de irritante: a própria correção, quando
--   feita pelo caminho da revisão, É uma nova aprovação -- a rota grava
--   `status='reviewed'` com `reviewed_at` novo e o selo é refeito sobre o texto
--   corrigido, no mesmo ato, sem segunda viagem para o revisor. O que NÃO
--   reaprova é mudar o conteúdo por qualquer outro caminho (SQL à mão, script,
--   outra rota): aí o selo fica para trás, a entrega é recusada, e alguém tem
--   de abrir e salvar a revisão do texto como ele está agora.
--   A porta não fica entreaberta: não existe conteúdo entregue sem aprovação
--   com a mesma impressão digital.
--
-- CONSEQUÊNCIA ADICIONAL, também declarada: entregar um documento que NUNCA foi
-- revisado deixa de ser possível. Antes passava (medido: `generated` ->
-- `delivered` direto, com `reviewed_at` nulo). Um documento sem revisão é o
-- caso extremo de "conteúdo não aprovado", e o desenho pedido era aquele em que
-- entregar conteúdo não aprovado é IMPOSSÍVEL, não desencorajado. Quem entrega
-- 50 documentos na segunda passa a precisar salvar a revisão de cada um.
--
-- ---------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------
-- As linhas que já estão em `reviewed` ou `delivered` não têm selo, e sem
-- backfill o CHECK novo reprovaria a próxima escrita qualquer sobre um
-- documento JÁ ENTREGUE (gravar `pdf_url`, por exemplo) -- quebrando documento
-- histórico por causa de uma regra nova. O backfill registra como aprovado o
-- conteúdo QUE JÁ ESTÁ LÁ, e nada mais:
--   - `delivered`: a impressão é a de `coalesce(final_content, raw_ai_output)`,
--     byte a byte o que a página de entrega já renderiza hoje
--     (`final_content ?? raw_ai_output`), e `final_content` é preenchido com
--     esse mesmo valor para a linha passar a registrar o que foi entregue.
--     NÃO se usa `edited_content` aqui: se ele existir e `final_content` for
--     nulo, o que o participante vê hoje é o CRU, e o selo tem de dizer a
--     verdade sobre o que foi entregue, não sobre o que se preferiria.
--   - `reviewed`: a impressão é a de `coalesce(edited_content, raw_ai_output)`,
--     o conteúdo que a revisão deixou pronto.
-- O backfill NÃO afirma que um humano aprovou: ele afirma o status quo, para que
-- a regra nova não reescreva o passado. `aprovado_em` recebe `reviewed_at` (ou
-- `delivered_at`, ou nulo) -- a data que o banco tem, nunca `now()`.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- 1. As colunas do selo
-- ---------------------------------------------------------------------------
alter table public.prognostics
  add column if not exists conteudo_aprovado_hash text,
  add column if not exists aprovado_em timestamptz;

comment on column public.prognostics.conteudo_aprovado_hash is
  'SHA-256 (hex) do conteudo que a ultima revisao humana aprovou. Escrita SOMENTE pelo gatilho prognostics_selo_de_aprovacao; o que a aplicacao puser aqui e sobrescrito.';
comment on column public.prognostics.aprovado_em is
  'Instante do ato de aprovacao a que conteudo_aprovado_hash se refere. Escrita somente pelo gatilho.';

-- ---------------------------------------------------------------------------
-- 2. O gatilho que ESCREVE o selo (e so ele escreve)
-- ---------------------------------------------------------------------------
-- search_path vazio: tudo qualificado, nada resolvivel por schema plantado.
-- Por isso `pg_catalog.sha256`, `pg_catalog.convert_to` e `pg_catalog.encode`.
create or replace function public.prognostics_selo_de_aprovacao()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- O conteudo que a revisao humana enxerga e aprova. `raw_ai_output` e NOT
  -- NULL no schema, entao este coalesce nunca da nulo.
  conteudo_em_revisao jsonb := coalesce(new.edited_content, new.raw_ai_output);
  impressao_em_revisao text;
  impressao_a_entregar text;
  aprovou boolean;
begin
  impressao_em_revisao := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(conteudo_em_revisao::text, 'UTF8')),
    'hex');

  -- O ATO DE APROVACAO: a linha fica em `reviewed` com `reviewed_at` NOVO.
  aprovou :=
    new.status = 'reviewed'
    and new.reviewed_at is not null
    and (tg_op = 'INSERT' or new.reviewed_at is distinct from old.reviewed_at);

  if aprovou then
    -- O selo nasce aqui, sobre o texto DESTE instante.
    new.conteudo_aprovado_hash := impressao_em_revisao;
    new.aprovado_em := new.reviewed_at;
  elsif tg_op = 'INSERT' then
    -- Documento nasce sem aprovacao. Nenhum insert se aprova a si mesmo.
    new.conteudo_aprovado_hash := null;
    new.aprovado_em := null;
  else
    -- Fora do ato de aprovacao, o selo e IMUTAVEL: o que a aplicacao tentou
    -- escrever nestas duas colunas e descartado. Ele segue dizendo a verdade
    -- ("a ultima aprovacao cobriu ESTE conteudo") mesmo depois de alguem trocar
    -- o texto -- e e justamente por isso que a troca passa a bloquear a
    -- entrega, em vez de passar em silencio.
    new.conteudo_aprovado_hash := old.conteudo_aprovado_hash;
    new.aprovado_em := old.aprovado_em;
  end if;

  -- O PORTAO DA ENTREGA. Recusa com mensagem propria, para o chamador saber o
  -- que aconteceu; o CHECK logo abaixo garante o mesmo invariante caso este
  -- gatilho seja desligado por DDL.
  if new.status = 'delivered' then
    if new.final_content is null then
      raise exception
        'Entrega recusada: final_content esta nulo, entao a linha nao registra qual texto foi entregue.'
        using errcode = 'check_violation',
              hint = 'Grave final_content com o conteudo aprovado no mesmo UPDATE que entrega.';
    end if;

    impressao_a_entregar := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(new.final_content::text, 'UTF8')),
      'hex');

    if new.conteudo_aprovado_hash is null then
      raise exception
        'Entrega recusada: este documento nao tem aprovacao humana vigente (conteudo_aprovado_hash nulo).'
        using errcode = 'check_violation',
              hint = 'Salve a revisao do documento (status reviewed com reviewed_at novo) antes de entregar.';
    end if;

    if impressao_a_entregar is distinct from new.conteudo_aprovado_hash then
      raise exception
        'Entrega recusada: o conteudo a entregar nao e o conteudo aprovado (impressao a entregar % difere da aprovada %).',
        pg_catalog.left(impressao_a_entregar, 12), pg_catalog.left(new.conteudo_aprovado_hash, 12)
        using errcode = 'check_violation',
              hint = 'O texto mudou depois da aprovacao. Revise o texto como ele esta agora e salve a revisao; so entao a entrega e liberada.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists prognostics_selo_de_aprovacao on public.prognostics;

-- BEFORE INSERT OR UPDATE, sem `of coluna`: o selo e o portao tem de ser
-- reavaliados em TODA escrita. O defeito de hoje existe justamente porque o
-- gatilho da 015 e `before update of status` e trocar so o conteudo nao o
-- dispara.
create trigger prognostics_selo_de_aprovacao
  before insert or update on public.prognostics
  for each row
  execute function public.prognostics_selo_de_aprovacao();

-- A funcao do gatilho nao e chamavel por API (mesma regra da 015).
revoke all on function public.prognostics_selo_de_aprovacao() from public;
revoke all on function public.prognostics_selo_de_aprovacao() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Backfill, ANTES do CHECK (senao ele reprovaria as linhas historicas)
-- ---------------------------------------------------------------------------
-- A escrita passa pelo gatilho acima, que sobrescreveria o selo -- por isso o
-- gatilho e desligado SO para este UPDATE e religado em seguida. Isto exige ser
-- dono da tabela, que e exatamente a condicao que se exige para contornar o
-- gatilho em qualquer outro lugar.
--
-- BEGIN/COMMIT explicito: `psql -f` roda cada comando em transacao propria, e
-- sem este bloco um CHECK reprovado na secao 4 deixaria o backfill da secao 3
-- COMMITADO. Ou as duas coisas acontecem, ou nenhuma.
begin;

alter table public.prognostics disable trigger prognostics_selo_de_aprovacao;

update public.prognostics
   set final_content = coalesce(final_content, raw_ai_output),
       conteudo_aprovado_hash = encode(
         sha256(convert_to(coalesce(final_content, raw_ai_output)::text, 'UTF8')), 'hex'),
       aprovado_em = coalesce(reviewed_at, delivered_at)
 where status = 'delivered'
   and conteudo_aprovado_hash is null;

update public.prognostics
   set conteudo_aprovado_hash = encode(
         sha256(convert_to(coalesce(edited_content, raw_ai_output)::text, 'UTF8')), 'hex'),
       aprovado_em = reviewed_at
 where status = 'reviewed'
   and conteudo_aprovado_hash is null;

alter table public.prognostics enable trigger prognostics_selo_de_aprovacao;

-- ---------------------------------------------------------------------------
-- 4. O CHECK: o invariante, independente do gatilho
-- ---------------------------------------------------------------------------
-- NOT VALID + VALIDATE, como na 015: o ADD direto segura lock exclusivo
-- enquanto varre a tabela. O backfill acima garante que a validacao passa; se
-- nao passar, a migration ABORTA e o backfill volta atras junto (mesma
-- transacao aberta na secao 3), em vez de inventar aprovacao para documento
-- nenhum.
alter table public.prognostics
  drop constraint if exists prognostics_entrega_cobre_aprovacao;

alter table public.prognostics
  add constraint prognostics_entrega_cobre_aprovacao
  check (
    status <> 'delivered'
    or (
      final_content is not null
      and conteudo_aprovado_hash is not null
      and conteudo_aprovado_hash = encode(
            sha256(convert_to(final_content::text, 'UTF8')), 'hex')
    )
  )
  not valid;

alter table public.prognostics
  validate constraint prognostics_entrega_cobre_aprovacao;

commit;
