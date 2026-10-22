-- 026_historico_do_conteudo_entregue.sql
-- O HISTÓRICO DO CONTEÚDO QUE JÁ ESTEVE ENTREGUE.
--
-- NÃO APLICAR EM PRODUÇÃO sem autorização nominal. Fica escrita e validada
-- contra Postgres descartável, como a 011, a 014, a 015, a 024 e a 025. O banco
-- que serve o evento de sábado não é tocado por esta unidade, nem para leitura.
--
-- Migration NOVA, sobre a 025 e sem desfazer nada dela: o selo de aprovação,
-- o CHECK da entrega e o gatilho que escreve o selo continuam exatamente como
-- estão. Esta acrescenta a peça que a 025 declarou NÃO entregar.
--
-- ---------------------------------------------------------------
-- A exigência que sobrou da revisão
-- ---------------------------------------------------------------
-- A 025 escolheu impressão digital em vez de versionamento, declarou o custo
-- ("o que esta migration NÃO entrega, declarado: histórico") e a revisão aceitou
-- a proteção E manteve a exigência: "proteção por hash aprovada; preservar
-- histórico do conteúdo entregue continua necessário."
--
-- O que falta hoje, medido: `prognostics` tem UMA linha por participante. Depois
-- de uma segunda revisão, o texto anterior é sobrescrito e não fica guardado em
-- lugar nenhum. Se um documento é entregue, depois corrigido e reentregue,
-- ninguém consegue reconstruir o que o jovem leu da primeira vez -- nem mesmo a
-- impressão digital dele, porque o gatilho da 025 reescreve o selo no ato da
-- nova aprovação.
--
-- ---------------------------------------------------------------
-- QUEM LÊ ISTO, E PARA QUÊ -- a pergunta que o desenho tem de responder
-- ---------------------------------------------------------------
-- Quem lê é quem tem de responder por um documento já lido: o host, na segunda,
-- diante de um jovem que diz "o meu falava outra coisa"; e quem audita a cadeia
-- depois. A pergunta real, nessa ordem de palavras, é:
--
--       "o que ESTA PESSOA leu, e QUANDO?"
--
-- Um histórico que guarda tudo e não responde isso não serve. Então o desenho é
-- governado por essa frase e não pela conveniência de guardar:
--
--   1. a linha é indexada pela PESSOA, não só pelo documento. `participant_id`
--      fica na própria linha do histórico, escrito pelo gatilho. Não é
--      desnormalização por desempenho: é a chave da pergunta. Depender de um
--      JOIN com `prognostics` faria o histórico responder "o que este DOCUMENTO
--      continha", que é outra pergunta e cuja resposta se perde se a linha de
--      `prognostics` mudar de mãos.
--   2. guarda-se o CONTEÚDO, não um resumo e não um diff. O que a pessoa leu é
--      o texto, byte a byte, e um histórico que obriga a reconstruir o texto
--      aplicando diferenças é um histórico que ninguém usa às pressas.
--   3. guarda-se a IMPRESSÃO DIGITAL ao lado, e um CHECK garante que ela é a do
--      conteúdo da própria linha. É o que liga o histórico ao vocabulário da
--      025: a pergunta "o que ela leu era o que foi aprovado?" se responde
--      comparando duas impressões, sem reler texto nenhum.
--   4. guarda-se o INSTANTE em que aquele texto passou a valer, e guarda-se
--      também o instante da APROVAÇÃO que o cobria (`aprovado_em` da 025, como
--      estava naquele momento) -- porque "quando" tem dois sentidos aqui e
--      confundi-los é o erro que o histórico deveria impedir.
--   5. o "até quando" NÃO é uma coluna. Ele é derivado, na view
--      `v_historico_do_conteudo_entregue`, pelo `passou_a_valer_em` da linha
--      SEGUINTE. Guardá-lo em coluna exigiria UPDATE na linha anterior a cada
--      reentrega -- isto é, exigiria privilégio de alteração sobre o histórico,
--      que é exatamente o que não pode existir. A view é quem responde "de
--      quando a quando", e a tabela segue sem nunca ser reescrita.
--
-- ---------------------------------------------------------------
-- APPEND-ONLY DE VERDADE, com o precedente que este projeto já tem
-- ---------------------------------------------------------------
-- O precedente é `external_submission_events` (migration 022): "APPEND-ONLY DE
-- VERDADE, nao por convencao: sem UPDATE e sem DELETE para ninguem alem do dono
-- da tabela. Historico que da para reescrever nao e historico." Esta tabela
-- copia aquilo e vai um passo além, porque o que ela guarda não é um ato que
-- alguém declarou -- é o TEXTO que uma pessoa leu:
--
--   sem UPDATE, sem DELETE e sem TRUNCATE para anon, authenticated e
--   service_role (a 016 já tira TRUNCATE de anon e authenticated por default
--   privilege; service_role não está nela, então sai nomeado aqui);
--   e sem INSERT TAMBÉM. Ninguém escreve nesta tabela à mão.
--
-- Por que INSERT também é revogado, o que o precedente da 022 não faz: ali a
-- aplicação é quem registra o ato do operador, então ela precisa de INSERT. Aqui
-- o histórico é um FATO DO BANCO -- "este conteúdo esteve entregue" --, e quem
-- sabe esse fato é o próprio banco, no mesmo instante em que a entrega passa
-- pelo portão da 025. Se a aplicação pudesse inserir, ela poderia registrar uma
-- entrega que não aconteceu, ou esquecer de registrar uma que aconteceu; e o
-- segundo caso é pior, porque falha em silêncio. Então existe UM caminho de
-- escrita: o gatilho `prognostics_historico_do_entregue`, SECURITY DEFINER, pelo
-- mesmo motivo que o selo da 025 tem um escritor único.
--
-- O que ainda contorna isto, declarado em vez de disfarçado: ser DONO da tabela
-- (DDL -- `alter table ... disable trigger`, `drop`, ou UPDATE direto como
-- `postgres`). É o mesmo teto dos gatilhos da 015 e da 025 e é a condição que
-- este projeto já aceita como "procedimento excepcional": não existe GUC nem
-- parâmetro de sessão que desligue nada disto, de propósito.
--
-- ---------------------------------------------------------------
-- O QUE ESTA MIGRATION NÃO ENTREGA, declarado
-- ---------------------------------------------------------------
-- 1. Não guarda texto que NUNCA esteve entregue. Rascunho de revisão
--    sobrescrito antes de qualquer entrega continua se perdendo. É deliberado: a
--    exigência da revisão é sobre o conteúdo ENTREGUE -- o que alguém leu -- e
--    guardar todo rascunho significaria guardar, por tempo indeterminado, texto
--    sobre a vida de um jovem que ninguém aprovou e ninguém leu.
-- 2. Não ressuscita o passado. As linhas já entregues antes desta migration
--    entram no histórico com o conteúdo que está entregue AGORA (ver o
--    backfill); as versões anteriores a hoje, se houve alguma, já não existem em
--    lugar nenhum e esta migration não as inventa.
-- 3. Não dá ao participante acesso ao próprio histórico. Só `is_admin()` lê.
--    Expor a um jovem as versões anteriores do documento dele é decisão de
--    produto, não efeito colateral de uma correção de auditoria.
-- 4. Não torna possível corrigir um documento JÁ ENTREGUE pelo caminho comum.
--    Isso continua recusado pelo gatilho da 015 (`delivered` não regride para
--    `reviewed`), e esta migration não mexe na máquina de estados. Corrigir e
--    reentregar segue exigindo o procedimento excepcional de quem é dono da
--    tabela -- e é justamente nesse procedimento que o texto anterior
--    desaparecia. Agora ele não desaparece: o histórico é escrito pelo gatilho,
--    que não participa da máquina de estados e continua de pé durante ele.
--
-- Idempotente: pode rodar duas vezes, inclusive sobre banco com dados.

-- ---------------------------------------------------------------------------
-- 1. A tabela do histórico
-- ---------------------------------------------------------------------------
create table if not exists public.prognostic_delivery_history (
  id uuid primary key default gen_random_uuid(),

  -- `on delete cascade` nos dois, igual ao que `prognostics` já faz com
  -- `participants`. Declarado: apagar o participante apaga o histórico dele.
  -- Append-only governa quem pode REESCREVER a história de uma pessoa que
  -- existe; não é promessa de guardar o texto de alguém depois de um pedido de
  -- exclusão, e deixar `restrict` aqui quebraria a exclusão de participante e
  -- de evento que já existe hoje.
  prognostic_id uuid not null
    references public.prognostics(id) on delete cascade,
  participant_id uuid not null
    references public.participants(id) on delete cascade,

  -- A ORDEM, independente de relógio. Dois registros no mesmo instante (mesma
  -- transação) empatariam em `passou_a_valer_em`, e aí "qual veio depois" não
  -- teria resposta -- justamente o que a view precisa para dizer "até quando".
  sequencia bigint generated always as identity,

  -- O TEXTO, byte a byte, como a página de entrega o renderizou.
  conteudo jsonb not null,
  -- A impressão digital DELE. Mesmo algoritmo e mesma forma da 025.
  conteudo_hash text not null,

  -- Quando este texto passou a ser o entregue.
  passou_a_valer_em timestamptz not null,
  -- O instante da aprovação que cobria este texto (`prognostics.aprovado_em`
  -- como estava neste momento). "Quando foi aprovado" e "quando passou a ser
  -- lido" são duas datas diferentes, e o histórico guarda as duas.
  aprovado_em timestamptz
);

do $$
begin
  -- A impressão digital não é um campo de texto livre: ela É a do conteúdo
  -- desta linha, imposto em toda escrita. Mesmo um UPDATE de quem é dono da
  -- tabela não consegue trocar o texto e manter a impressão antiga -- a única
  -- coisa que o histórico afirma sobre si mesmo fica verdadeira por construção.
  alter table public.prognostic_delivery_history
    drop constraint if exists prognostic_delivery_history_hash_do_conteudo;
  alter table public.prognostic_delivery_history
    add constraint prognostic_delivery_history_hash_do_conteudo
    check (
      conteudo_hash = encode(sha256(convert_to(conteudo::text, 'UTF8')), 'hex')
    );
end $$;

-- A pergunta é "o que ESTA PESSOA leu": o índice é o da pergunta.
create index if not exists prognostic_delivery_history_participante_idx
  on public.prognostic_delivery_history (participant_id, sequencia);
create index if not exists prognostic_delivery_history_documento_idx
  on public.prognostic_delivery_history (prognostic_id, sequencia);

comment on table public.prognostic_delivery_history is
  'APPEND-ONLY. Todo conteudo que JA ESTEVE ENTREGUE, com a impressao digital dele e com quando passou a valer. Escrita SOMENTE pelo gatilho prognostics_historico_do_entregue; sem insert, update, delete ou truncate para anon, authenticated e service_role. Responde "o que esta pessoa leu, e quando" -- use a view v_historico_do_conteudo_entregue, que deriva o "ate quando".';
comment on column public.prognostic_delivery_history.participant_id is
  'A PESSOA de quem este texto foi o documento entregue. E a chave da pergunta que o historico existe para responder, nao desnormalizacao por desempenho.';
comment on column public.prognostic_delivery_history.conteudo is
  'O texto entregue, byte a byte: o `final_content` que a pagina de entrega renderizou.';
comment on column public.prognostic_delivery_history.conteudo_hash is
  'SHA-256 (hex) do conteudo DESTA linha, imposto por CHECK. Compara-se com prognostics.conteudo_aprovado_hash (migration 025) para responder se o que foi lido era o que foi aprovado.';
comment on column public.prognostic_delivery_history.passou_a_valer_em is
  'Quando este texto passou a ser o conteudo entregue. O "ate quando" NAO e coluna: e o passou_a_valer_em da linha seguinte (view v_historico_do_conteudo_entregue), porque guarda-lo exigiria UPDATE no historico.';
comment on column public.prognostic_delivery_history.aprovado_em is
  'O instante da aprovacao humana que cobria este texto (prognostics.aprovado_em neste momento). Outra data que passou_a_valer_em, de proposito.';
comment on column public.prognostic_delivery_history.sequencia is
  'Ordem de registro, independente de relogio: dois registros no mesmo instante empatariam em passou_a_valer_em e a view nao saberia qual veio depois.';

-- ---------------------------------------------------------------------------
-- 2. O gatilho que ESCREVE o histórico (e só ele escreve)
-- ---------------------------------------------------------------------------
-- AFTER, não BEFORE: o histórico só registra o que de fato PASSOU pelo portão
-- da entrega da 025 (que é BEFORE) e pelo CHECK do invariante. Um BEFORE
-- registraria a intenção, e a intenção recusada não é leitura de ninguém.
--
-- SECURITY DEFINER: é o que permite revogar INSERT de todo mundo e ainda assim
-- registrar. A alternativa seria conceder INSERT a quem escreve em
-- `prognostics` -- ou seja, permitir a mão humana ali -- e aí o histórico
-- voltaria a ser uma convenção.
--
-- search_path vazio: tudo qualificado, nada resolvível por schema plantado.
create or replace function public.prognostics_historico_do_entregue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  impressao text;
  ultima_impressao text;
  instante timestamptz;
begin
  -- Só interessa o que está ENTREGUE. Documento em geração, em revisão ou
  -- aprovado e ainda não entregue não foi lido por ninguém.
  if new.status <> 'delivered' then
    return null;
  end if;

  -- `delivered` com `final_content` nulo é recusado pelo CHECK da 025, então
  -- este caminho não deveria existir. Ele está aqui porque, se algum dia
  -- existir, o certo é NÃO registrar (não há texto a guardar) em vez de
  -- derrubar a escrita e gravar uma linha com conteúdo inventado.
  if new.final_content is null then
    return null;
  end if;

  impressao := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(new.final_content::text, 'UTF8')),
    'hex');

  -- DEDUPLICAÇÃO contra a ÚLTIMA linha, não contra todas. Uma linha entregue
  -- recebe outras escritas depois (gravar `pdf_url`, por exemplo) e cada uma
  -- dispara este gatilho; sem isto o histórico encheria de repetições do mesmo
  -- texto. Contra a última, e não contra o conjunto, de propósito: entregar A,
  -- corrigir para B, e depois VOLTAR para A são três leituras diferentes, e a
  -- terceira tem de aparecer.
  select h.conteudo_hash
    into ultima_impressao
    from public.prognostic_delivery_history h
   where h.prognostic_id = new.id
   order by h.sequencia desc
   limit 1;

  if ultima_impressao = impressao then
    return null;
  end if;

  -- O INSTANTE em que este texto passou a valer. `delivered_at` é a data que a
  -- própria linha registra para a entrega: quando ela é escrita nesta mesma
  -- operação, é ela. Quando o conteúdo troca sem `delivered_at` se mexer, a
  -- data da entrega anterior não serve para o texto novo, e o instante é o do
  -- banco -- nunca o relógio de quem chamou.
  if tg_op = 'UPDATE'
     and new.delivered_at is not null
     and new.delivered_at is distinct from old.delivered_at then
    instante := new.delivered_at;
  elsif tg_op = 'INSERT' and new.delivered_at is not null then
    instante := new.delivered_at;
  else
    instante := pg_catalog.now();
  end if;

  insert into public.prognostic_delivery_history
    (prognostic_id, participant_id, conteudo, conteudo_hash,
     passou_a_valer_em, aprovado_em)
  values
    (new.id, new.participant_id, new.final_content, impressao,
     instante, new.aprovado_em);

  return null;
end;
$$;

drop trigger if exists prognostics_historico_do_entregue on public.prognostics;

-- AFTER INSERT OR UPDATE, sem `of coluna`: a entrega acontece em escritas de
-- formas diferentes (status mudando, conteúdo trocando, linha nascendo já
-- entregue no backfill de um restore), e um `of status` perderia justamente a
-- troca de conteúdo -- o mesmo defeito que a 015 teve e a 025 não repetiu.
create trigger prognostics_historico_do_entregue
  after insert or update on public.prognostics
  for each row
  execute function public.prognostics_historico_do_entregue();

-- A função do gatilho não é chamável por API (mesma regra da 015 e da 025), e
-- aqui isso importa mais: ela é SECURITY DEFINER.
revoke all on function public.prognostics_historico_do_entregue() from public;
revoke all on function public.prognostics_historico_do_entregue() from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. A view que responde "o que esta pessoa leu, e quando"
-- ---------------------------------------------------------------------------
-- O "até quando" nasce aqui, do `passou_a_valer_em` da linha seguinte do MESMO
-- documento. Nulo em `leu_ate` significa "é o texto vigente", não "não se
-- sabe": a linha vigente é a que não tem sucessora.
--
-- `security_invoker = on`: a view é lida com os privilégios e a RLS de QUEM
-- consulta, não do dono. Sem isso ela seria uma porta lateral para o histórico
-- inteiro, aberta a qualquer papel que tivesse SELECT nela.
create or replace view public.v_historico_do_conteudo_entregue
with (security_invoker = on) as
select
  h.id,
  h.participant_id,
  h.prognostic_id,
  h.sequencia,
  h.conteudo,
  h.conteudo_hash,
  h.aprovado_em,
  h.passou_a_valer_em as leu_a_partir_de,
  lead(h.passou_a_valer_em) over (
    partition by h.prognostic_id order by h.sequencia
  ) as leu_ate,
  lead(h.id) over (
    partition by h.prognostic_id order by h.sequencia
  ) is null as vigente
from public.prognostic_delivery_history h;

comment on view public.v_historico_do_conteudo_entregue is
  'O historico legivel: o que cada pessoa leu, de quando a quando. `leu_ate` nulo quer dizer "texto vigente" (a linha nao tem sucessora), nunca "nao se sabe". security_invoker=on: le com a RLS de quem consulta.';

-- ---------------------------------------------------------------------------
-- 4. Backfill, ANTES de fechar os privilégios
-- ---------------------------------------------------------------------------
-- As linhas que já estão `delivered` não têm histórico. O backfill registra o
-- conteúdo QUE ESTÁ ENTREGUE AGORA, e nada mais -- ele não afirma que esse foi
-- o único texto que a pessoa leu, porque isso não se sabe (ver "o que esta
-- migration não entrega", item 2). `passou_a_valer_em` recebe a data que o
-- banco tem (`delivered_at`), nunca `now()` quando existe a verdadeira.
--
-- A escrita é na tabela do histórico, não em `prognostics`, então o gatilho da
-- 025 não é tocado e nada é desligado aqui.
--
-- BEGIN/COMMIT explícito: `psql -f` roda cada comando em transação própria, e
-- sem este bloco uma falha nos privilégios da seção 5 deixaria o backfill
-- commitado pela metade.
begin;

insert into public.prognostic_delivery_history
  (prognostic_id, participant_id, conteudo, conteudo_hash,
   passou_a_valer_em, aprovado_em)
select
  p.id,
  p.participant_id,
  p.final_content,
  encode(sha256(convert_to(p.final_content::text, 'UTF8')), 'hex'),
  coalesce(p.delivered_at, p.reviewed_at, now()),
  p.aprovado_em
from public.prognostics p
where p.status = 'delivered'
  and p.final_content is not null
  -- Idempotência: nada é registrado se este mesmo texto já é o último do
  -- histórico daquele documento. Mesma regra do gatilho, e pela mesma razão.
  and not exists (
    select 1
      from public.prognostic_delivery_history h
     where h.prognostic_id = p.id
       and h.conteudo_hash = encode(sha256(convert_to(p.final_content::text, 'UTF8')), 'hex')
       and h.sequencia = (
         select max(h2.sequencia)
           from public.prognostic_delivery_history h2
          where h2.prognostic_id = p.id
       )
  );

-- ---------------------------------------------------------------------------
-- 5. OS PRIVILÉGIOS: append-only conferível, não afirmado
-- ---------------------------------------------------------------------------
-- Sem INSERT, sem UPDATE, sem DELETE e sem TRUNCATE para os três papéis que a
-- aplicação usa. `service_role` sai nomeado porque ele NÃO é alcançado pela
-- RLS (BYPASSRLS) nem pelos default privileges da 016 -- é justamente o papel
-- com que as rotas de administração escrevem.
revoke insert, update, delete, truncate
  on public.prognostic_delivery_history
  from anon, authenticated, service_role;

-- Ler, sim: o histórico existe para ser lido. A RLS abaixo é que decide por
-- quem.
grant select on public.prognostic_delivery_history to authenticated, service_role;
grant select on public.v_historico_do_conteudo_entregue to authenticated, service_role;

-- `anon` não tem nada aqui: documento individual de um jovem não é dado
-- público, nem a versão anterior dele.
revoke all on public.prognostic_delivery_history from anon;
revoke all on public.v_historico_do_conteudo_entregue from anon;

alter table public.prognostic_delivery_history enable row level security;

-- SELECT para admin. Não existe policy de insert, update ou delete: nem por
-- descuido alguém abre uma -- e, ainda que abrisse, o privilégio revogado acima
-- continuaria recusando (as duas camadas, como na 022).
drop policy if exists prognostic_delivery_history_admin_select
  on public.prognostic_delivery_history;
create policy prognostic_delivery_history_admin_select
  on public.prognostic_delivery_history
  for select using (is_admin());

commit;
