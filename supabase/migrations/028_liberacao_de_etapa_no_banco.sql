-- 028_liberacao_de_etapa_no_banco.sql
-- A TRAVA DA LIBERACAO DE ETAPA, NO BANCO.
--
-- Idempotente (create or replace + drop trigger if exists) e sem nenhuma
-- alteracao destrutiva: nao cria coluna, nao apaga nada, nao reescreve linha
-- nenhuma. Seguro rodar em producao com dados e duas vezes seguidas.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO, MEDIDO
-- ---------------------------------------------------------------------------
-- A unidade anterior isolou o painel ao vivo (components/features/admin/
-- etapas-do-painel.ts): num evento cujas etapas nao sao numeradas de 1 a N ele
-- deixou de OFERECER "liberar etapa", deixou de mostrar nome de etapa errado e
-- deixou de exibir contagem falsa. A revisao aprovou a contencao visual e pediu
-- mais, nominalmente: "verificar expressamente o bloqueio por MODO no
-- ENDPOINT".
--
-- Foi medido, e a revisao tinha razao. Tres fatos:
--
--   1. O painel NAO passa por rota de API para liberar etapa. Ele grava DIRETO
--      na tabela pelo cliente do navegador (LiveControlPanel.tsx, update de
--      `current_stage` e `status` em `events`).
--   2. Existe `app/api/etapa/proxima`, e ela ate le modo e versao do
--      questionario -- mas ela responde ao PARTICIPANTE do modo assincrono
--      ("para onde eu vou agora"). Ela nao e, e nunca foi, o caminho de
--      liberacao do host. Reforcar a verificacao dela nao travaria nada.
--   3. Nao havia gatilho, CHECK nem restricao nenhuma sobre `current_stage`.
--      O unico gatilho de `events` era `events_updated_at` (001) e o unico
--      CHECK era o de `mode` (010).
--
-- Consequencia medida num Postgres descartavel, com sessao `authenticated`
-- carregando claim de administrador -- exatamente a sessao do navegador do
-- host, nao superusuario:
--
--   update events set current_stage = 6  -- evento v2, de CINCO etapas  -> UPDATE 1
--   update events set current_stage = 3  -- evento ASSINCRONO           -> UPDATE 1
--   update events set current_stage = 99 -- absurdo puro                -> UPDATE 1
--   update events set current_stage = -4 -- absurdo puro                -> UPDATE 1
--
-- Ou seja: a contencao conferida na tela era SO DE INTERFACE. A tela parou de
-- OFERECER a operacao; o sistema nao parou de ACEITA-LA. Qualquer sessao de
-- administrador -- a interface de dados do Supabase, um `curl` para o
-- PostgREST, uma aba antiga do painel com codigo velho em cache -- gravava
-- etapa inexistente sem encontrar resistencia.
--
-- Parar de oferecer nao e impedir. O resto deste projeto foi construido em
-- garantia estrutural: o selo que so o gatilho escreve (025), o historico onde
-- ninguem insere (026), a revalidacao dentro da transacao (024). Aqui havia
-- disciplina. Esta migration troca a disciplina por garantia.
--
-- ---------------------------------------------------------------------------
-- O QUE "INVALIDO" SIGNIFICA -- A DECISAO, DECLARADA
-- ---------------------------------------------------------------------------
--
-- (A) A ETAPA TEM DE EXISTIR PARA AQUELE EVENTO.
--     O criterio e o MESMO do resto do sistema: `events.current_stage` e um
--     ORDINAL, comparado com `quiz_stages.stage_number` dentro da
--     `quiz_version` do evento (migration 010, secoes 5 e 6). Entao a etapa
--     existe quando existe a LINHA com aquele `stage_number` naquela versao.
--     Nao se compara com uma constante 6 nem com o `id` da linha -- foi
--     justamente confundir ordinal com id que produziu "liberar etapa 6" num
--     evento de cinco.
--
-- (B) O MODO. ESTA E A PARTE DECIDIDA, E A DECISAO E: RECUSA POR MODO.
--     O modo `async` nao tem liberacao de etapa nenhuma. Isso nao e opiniao
--     desta migration; e premissa escrita do projeto, em dois lugares:
--       - lib/quiz/etapas-do-evento.ts: "Nenhum host libera etapa no modo
--         assincrono, entao `current_stage` fica parado e o criterio do live
--         recusaria PARA SEMPRE";
--       - lib/erros/mensagens-host.ts, mensagem de COLLECTION_OPEN, que o host
--         le: "Nao ha etapa para liberar neste modo."
--     As policies de escrita da 010 confirmam pelo comportamento: no `async` a
--     permissao vem da janela da coleta e da sessao de etapa, e `current_stage`
--     e literalmente IGNORADO.
--
--     Por que recusar, entao, se o valor e ignorado? Porque `current_stage`
--     nao e lido apenas pelas policies: ele e EXIBIDO. O painel mostra "o
--     evento esta na etapa N", `app/(participant)/waiting` o le, a timeline o
--     cita, e `EVENT_INCOMPLETE` o devolve em `detalhes.etapa_atual`. Gravar 3
--     no evento de sabado nao libera nada -- cria uma AFIRMACAO FALSA sobre o
--     evento, que depois alguem le e acredita. Numero que nao corresponde a
--     fato nenhum e o defeito que esta familia de correcoes existe para
--     eliminar, e o modo e o que diz se o numero pode corresponder a algo.
--
--     A recusa por modo e, portanto, uma recusa VERIFICADA, nao uma
--     indisponibilidade: o banco leu o modo e concluiu que a operacao nao se
--     aplica aquele evento.
--
--     Modo ausente ou fora do vocabulario tambem recusa (falha FECHADA), pela
--     mesma razao que `modoIndeterminado()` bloqueia em etapas-do-evento.ts:
--     nao saber o modo nao e saber que e ao vivo. Hoje isso e inalcancavel
--     (`mode` e `not null` com CHECK, migration 010); a condicao esta escrita
--     para o dia em que o CHECK for afrouxado por DDL.
--
-- (C) A ETAPA ZERO E SEMPRE ACEITA, EM QUALQUER MODO.
--     Zero nao e uma etapa: e o default da coluna (001) e significa "nenhuma
--     etapa liberada". Aceitar zero sempre (1) nao permite afirmacao falsa
--     nenhuma, porque zero nao afirma etapa; e (2) deixa ABERTO o caminho de
--     REPARO -- uma linha que ja esteja com etapa invalida de antes pode ser
--     zerada. Uma trava que fechasse o reparo obrigaria a mexer no banco por
--     fora para consertar o estrago que ela mesma passou a apontar.
--
-- O QUE ESTA TRAVA NAO FAZ, DE PROPOSITO:
--
--   - NAO exige monotonia. Voltar de 4 para 3 continua permitido. O defeito
--     medido e etapa INEXISTENTE, nao etapa que retrocede, e o painel so avanca.
--     Proibir o retrocesso seria regra nova, nao verificada em tela nenhuma, com
--     risco de travar um reparo legitimo durante um evento ao vivo.
--
--   - NAO dispara no INSERT. Ver a secao "POR QUE SO NO UPDATE", abaixo.
--
--   - NAO valida as linhas que JA existem. Nao ha `not valid`/`validate` aqui:
--     a trava e um gatilho de escrita, e nenhuma linha existente se torna
--     inatualizavel por causa dela (o gatilho so acorda quando `current_stage`
--     muda; mexer em qualquer outra coluna de um evento ja torto continua
--     passando). Isso e deliberado: aplicar a 028 em producao NAO PODE falhar
--     por causa de dado antigo.
--
--   - NAO existe CHECK de reforco, como o da 025. Nao e escolha: um CHECK nao
--     pode consultar outra tabela, e o fato "esta etapa existe nesta versao"
--     vive em `quiz_stages`. O gatilho e a unica forma de dizer isso no banco.
--     Se alguem desligar este gatilho por DDL, a trava cai -- e e por isso que
--     `scripts/drift` existe.
--
-- ---------------------------------------------------------------------------
-- NAO QUEBRAR O QUE FUNCIONA (a propriedade que importa mais que a trava)
-- ---------------------------------------------------------------------------
-- Uma trava que impede o caminho bom e pior que a ausencia dela. Evento da
-- versao antiga, ao vivo, com etapas 1..6, tem de continuar liberando etapa
-- normalmente -- e o proximo evento ao vivo pode depender disso.
--
-- Por construcao ele continua: as 6 etapas da v1 receberam `stage_number = id`
-- no backfill da 010, entao para um evento `mode='live'`, `quiz_version=1`, as
-- etapas 1,2,3,4,5,6 EXISTEM e todas passam. A trava nao introduz constante
-- nenhuma: ela conta linhas. Uma v3 futura com N etapas passa do mesmo jeito,
-- sem tocar neste arquivo.
--
-- ---------------------------------------------------------------------------
-- POR QUE SO NO UPDATE, E NAO NO INSERT
-- ---------------------------------------------------------------------------
-- Escolha conservadora, declarada como limitacao. Tres razoes:
--
--   1. A operacao que a revisao mandou travar e "liberar etapa", que e um
--      UPDATE. Criar evento nao libera etapa: `NewEventForm.tsx` insere
--      `current_stage: 0`.
--   2. INSERT e tambem o caminho de SEMEADURA e de RESTAURACAO DE DUMP. Um
--      gatilho de INSERT recusaria restaurar uma linha historica torta, e
--      recusaria semear um evento antes de a sua versao de questionario
--      existir -- transformando esta trava numa armadilha de ordem de carga.
--   3. Ha prova no proprio repositorio de que `current_stage` nao-zero em linha
--      `async` e usado como dado inerte na semeadura:
--      lib/importacao/provas/corrida-aplicacao.test.ts insere um evento
--      `async`, v2, com `current_stage = 5` para provar uma corrida que nada
--      tem a ver com etapa. Travar o INSERT quebraria uma prova boa.
--
-- O furo que sobra, nomeado: quem puder INSERIR em `events` pode criar um
-- evento ja nascido com etapa invalida. Sobrou de propósito; fecha-lo exige
-- decidir antes o que fazer com dump e semeadura, e essa decisao nao e desta
-- unidade.
--
-- ---------------------------------------------------------------------------
-- COMO A RECUSA CHEGA A QUEM LE
-- ---------------------------------------------------------------------------
-- A regra que nao se negocia neste projeto: a recusa tem de dizer QUAL e o
-- fato. "Nao consegui verificar", "verifiquei e recusei" e "o recurso nao esta
-- instalado" sao fatos diferentes. Esta trava emite TRES fatos, e nunca os
-- colapsa:
--
--   modo_nao_libera_etapa            CONFERIDO e NAO PERMITIDO: o evento nao e
--                                    ao vivo, e liberar etapa nao se aplica a
--                                    ele. Nada a corrigir -- a operacao nao
--                                    existe neste evento.
--   etapa_fora_da_versao_do_evento   CONFERIDO e NAO PERMITIDO: a lista de
--                                    etapas da versao esta coerente, e esta
--                                    etapa nao esta nela. A tela esta
--                                    desatualizada; recarregar resolve.
--   versao_sem_etapas_utilizaveis    NAO DEU PARA VERIFICAR: a versao do
--                                    questionario deste evento nao tem lista de
--                                    etapas utilizavel (nenhuma linha,
--                                    `stage_number` nulo, repetido ou com
--                                    buraco). Problema de configuracao do
--                                    questionario; tentar de novo nao resolve.
--
-- O nome do fato vai no campo DETAIL da excecao, e nao na prosa da MESSAGE: o
-- PostgREST entrega DETAIL em `error.details`, entao a tela le um NOME FECHADO
-- em vez de interpretar texto de banco em portugues. O vocabulario em
-- TypeScript que espelha estes tres nomes esta em lib/erros/codigos.ts
-- (`FatoDaLiberacaoDeEtapa`), e um teste compara as duas listas com o SQL deste
-- arquivo para que elas nao divirjam em silencio -- mesma disciplina que a 024.
--
-- A MESSAGE existe para quem le o log cru ou a interface de dados do Supabase, e
-- e escrita em frase inteira. Ela NAO e exibida ao host: o texto que o operador
-- le nasce em lib/erros/mensagens-host.ts, e diz que a operacao nao se aplica
-- aquele evento -- nunca que o sistema quebrou.
--
-- O errcode e `check_violation` (23514), como na 025 e na 015: o PostgREST o
-- traduz em HTTP 400, que e a classe certa ("o pedido viola uma regra"), e
-- nunca 500.

-- ---------------------------------------------------------------------------
-- 1. A funcao do gatilho
-- ---------------------------------------------------------------------------
-- security definer + search_path vazio, pelas mesmas duas razoes de is_admin()
-- (migration 012):
--   - search_path vazio: tudo qualificado, nada resolvivel por schema plantado;
--   - security definer: o VEREDITO nao pode depender do que o chamador
--     consegue ver. Hoje `quiz_stages` e de leitura publica
--     (`quiz_stages_public_read`, migration 002), entao definer e invoker
--     veriam o mesmo; se amanha essa policy for restringida, uma funcao
--     `invoker` leria zero linhas e passaria a responder "versao sem etapas
--     utilizaveis" para eventos perfeitamente validos -- uma trava que recusa o
--     caminho bom. Definer le a lista de etapas de verdade.
create or replace function public.events_valida_liberacao_de_etapa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- A lista de etapas da versao do evento, medida de uma vez.
  v_linhas    int;
  v_sem_numero int;
  v_distintos int;
  v_menor     int;
  v_maior     int;
begin
  -- (C) Etapa zero: "nenhuma etapa liberada". Nao afirma etapa nenhuma, entao
  -- nao pode ser uma afirmacao falsa -- e e o caminho de reparo. Passa sempre,
  -- em qualquer modo.
  if new.current_stage = 0 then
    return new;
  end if;

  -- (B) O MODO. Primeiro portao de proposito: num evento que nao libera etapa,
  -- a pergunta "a etapa N existe?" e irrelevante. Dizer "a etapa 3 nao existe"
  -- sobre o evento de sabado mandaria o operador conferir o questionario,
  -- quando o fato e que a operacao nao se aplica ao evento.
  if new.mode is distinct from 'live' then
    raise exception
      'Liberacao de etapa recusada: este evento esta no modo "%" e eventos que nao sao ao vivo nao liberam etapa (current_stage nao e lido neste modo).',
      coalesce(new.mode, '(ausente)')
      using errcode = 'check_violation',
            detail  = 'modo_nao_libera_etapa',
            hint    = 'Liberar etapa so existe no modo live. No modo async quem decide o acesso e a janela da coleta (form_opens_at/form_closes_at) com a sessao de etapa, e current_stage fica parado em 0.';
  end if;

  select count(*),
         count(*) filter (where s.stage_number is null),
         count(distinct s.stage_number),
         min(s.stage_number),
         max(s.stage_number)
    into v_linhas, v_sem_numero, v_distintos, v_menor, v_maior
    from public.quiz_stages s
   where s.quiz_version = new.quiz_version;

  -- A lista de etapas e utilizavel? MESMO criterio de `avaliarEtapas()` em
  -- lib/quiz/etapas-do-evento.ts ("sem etapas, stage_number nulo ou com
  -- buraco"): os numeros tem de ser exatamente 1..N. Sem isso, "a etapa N
  -- existe" nao e uma pergunta respondivel, e responder "nao existe" seria
  -- afirmar sobre a etapa um defeito que e da configuracao da versao.
  if v_linhas = 0
     or v_sem_numero > 0
     or v_distintos is distinct from v_linhas
     or v_menor is distinct from 1
     or v_maior is distinct from v_linhas
  then
    raise exception
      'Liberacao de etapa bloqueada: a versao % do questionario nao tem lista de etapas utilizavel (% linhas, % sem stage_number, numeracao de % a %); nao da para dizer se a etapa % existe.',
      new.quiz_version, v_linhas, v_sem_numero,
      coalesce(v_menor::text, 'nulo'), coalesce(v_maior::text, 'nulo'),
      new.current_stage
      using errcode = 'check_violation',
            detail  = 'versao_sem_etapas_utilizaveis',
            hint    = 'As etapas da versao do questionario do evento tem de ter stage_number 1..N, sem nulo, sem repetido e sem buraco (migration 010). Nenhuma etapa foi liberada.';
  end if;

  -- (A) A ETAPA EXISTE PARA ESTE EVENTO? A pergunta e feita na LINHA da etapa,
  -- contra `stage_number` dentro da `quiz_version` do evento -- nunca contra o
  -- `id` da linha e nunca contra a constante 6. Confundir ordinal com id foi o
  -- defeito original.
  if not exists (
    select 1
      from public.quiz_stages s
     where s.quiz_version = new.quiz_version
       and s.stage_number = new.current_stage
  ) then
    raise exception
      'Liberacao de etapa recusada: a etapa % nao existe na versao % do questionario deste evento, que tem % etapas (1 a %).',
      new.current_stage, new.quiz_version, v_linhas, v_maior
      using errcode = 'check_violation',
            detail  = 'etapa_fora_da_versao_do_evento',
            hint    = 'A etapa liberada tem de ser uma das etapas cadastradas da versao do questionario do evento. Nenhuma etapa foi liberada.';
  end if;

  return new;
end;
$$;

comment on function public.events_valida_liberacao_de_etapa() is
  'Trava estrutural da liberacao de etapa (migration 028): recusa gravar events.current_stage com etapa que nao existe na quiz_version do evento, e recusa qualquer etapa (diferente de 0) em evento que nao e mode=live, porque liberar etapa nao existe nesses modos. O nome do fato vai no DETAIL da excecao: modo_nao_libera_etapa, etapa_fora_da_versao_do_evento ou versao_sem_etapas_utilizaveis. Espelho em TypeScript: FatoDaLiberacaoDeEtapa, em lib/erros/codigos.ts.';

-- ---------------------------------------------------------------------------
-- 2. O gatilho
-- ---------------------------------------------------------------------------
drop trigger if exists events_liberacao_de_etapa on public.events;

-- BEFORE UPDATE, com `when (old.current_stage is distinct from new.current_stage)`:
--
--   - BEFORE, e nao AFTER: a escrita e recusada antes de acontecer, nao
--     desfeita depois.
--   - UPDATE e nao INSERT: ver "POR QUE SO NO UPDATE", acima.
--   - `when (...)`: o gatilho so acorda quando a etapa MUDA. Isso tem duas
--     consequencias que importam, e as duas sao desejadas. (1) Nenhuma linha
--     existente fica inatualizavel: um evento que ja esteja com etapa torta
--     continua aceitando mudanca de nome, de status, de prazo -- aplicar esta
--     migration em producao nao trava escrita nenhuma que hoje funciona.
--     (2) Mudar `mode` para async num evento que ja estava na etapa 5 NAO e
--     recusado, porque a etapa nao mudou; o valor que estava la foi gravado
--     quando era valido. Se o mesmo UPDATE mexer no modo E na etapa, o gatilho
--     acorda e julga pelo modo NOVO (`new.mode`), que e o modo que a linha vai
--     ter.
--     (3) Regravar o MESMO valor nao e mudanca, entao tambem nao acorda o
--     gatilho. Isso e deliberado e inofensivo: uma linha que ja dizia 3 nao
--     passa a afirmar nada de novo ao ser regravada com 3. O que a trava impede
--     e a AFIRMACAO NOVA, nao a repeticao de uma que ja esta la -- e a
--     repeticao, por definicao, nao muda o que o painel exibe.
--   - `of current_stage` NAO foi usado no lugar do `when`: `before update of
--     coluna` dispara quando a coluna e MENCIONADA na instrucao, ainda que com
--     o mesmo valor -- foi assim que o gatilho da 015 deixou de ver mudanca de
--     conteudo e precisou ser trocado na 025. O `when` compara VALOR.
create trigger events_liberacao_de_etapa
  before update on public.events
  for each row
  when (old.current_stage is distinct from new.current_stage)
  execute function public.events_valida_liberacao_de_etapa();

-- A funcao do gatilho nao e chamavel por API (mesma regra da 015 e da 025).
-- Funcoes que retornam trigger ja nao podem ser chamadas diretamente, mas o
-- Supabase concede EXECUTE por padrao e a suite de grants audita isso.
revoke all on function public.events_valida_liberacao_de_etapa() from public;
revoke all on function public.events_valida_liberacao_de_etapa() from anon, authenticated;
