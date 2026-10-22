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
-- lib/importacao/provas/corrida-aplicacao.test.ts: plano montado com a pessoa
-- sem respostas, resposta do aplicativo inserida DEPOIS da montagem, funcao
-- executada -- e a resposta do aplicativo desaparecia, sem erro, sem conflito e
-- sem linha no livro-razao.
--
-- A impressao digital da previa NAO cobre isso, e nao poderia: ela amarra a
-- previa ao PLANO, e o plano nao mudou. O que mudou foi o banco. Dito como a
-- revisao disse: um hash correto nao pode autorizar uma operacao que deixou de
-- ser segura.
--
-- ===========================================================================
-- A CORRECAO: uma REGRA ESTRUTURAL, revalidada DENTRO da transacao
-- ===========================================================================
-- Nao se compara contagem com contagem (contagem e justamente o numero que
-- envelheceu). A regra e sobre a PROCEDENCIA da linha que existe:
--
--   A importacao NUNCA sobrescreve uma resposta canonica que nao tenha sido
--   escrita POR ESTA MESMA SUBMISSAO EXTERNA.
--
-- Reimportar uma submissao externa e atualizacao legitima -- e o caso de uso
-- real: a correspondencia e corrigida e o lote entra de novo. Passar por cima
-- do que a pessoa respondeu no aplicativo nunca e. E linha existente vinda de
-- OUTRA submissao externa tambem nao e atualizacao: e conflito, porque significa
-- que duas coletas diferentes afirmam ser a resposta da mesma pessoa, e escolher
-- uma em silencio e a decisao que nao cabe a um `do update`.
--
-- Revalidado dentro da transacao, por submissao, ANTES de qualquer escrita dela:
--   (a) IDENTIDADE      o participante do plano ainda existe, ainda e deste
--                       evento, e -- quando a identidade veio de e-mail
--                       verificado -- ainda tem aquele e-mail;
--   (b) DUPLICIDADE     nao existe OUTRA submissao externa ativa
--                       (importavel/incompativel) do mesmo participante neste
--                       evento. Sem esta checagem o indice unico parcial
--                       `external_submissions_participante_ativo_idx` estouraria
--                       e derrubaria o lote inteiro, em vez de retido um;
--   (c) LOTE            duas submissoes do mesmo plano nao gravam no mesmo
--                       participante (cinto e suspensorio do planejador);
--   (d) RESPOSTA EXISTENTE  nenhuma das etapas a gravar tem linha de
--                       `quiz_responses` que nao seja desta submissao.
--
-- ===========================================================================
-- A DECISAO SOBRE ATOMICIDADE, declarada
-- ===========================================================================
-- Duas leituras da ordem "gravar tudo atomicamente ou nao gravar nada" tem
-- defesa: derrubar a transacao inteira, ou RETER a submissao em conflito e
-- deixar as outras passarem. Esta funcao faz a SEGUNDA, e a unidade de
-- atomicidade e A SUBMISSAO: ou ela entra inteira (todas as etapas), ou nao
-- entra nada dela. Nenhuma submissao fica pela metade.
--
-- O que decide e o livro-razao. A ordem tambem diz que a submissao em conflito
-- deve ser recusada COMO CONFLITO -- um desfecho previsto e REGISTRADO, nao um
-- erro -- e que o recusado tem de aparecer em `external_submission_events`.
-- `raise exception` faria rollback da transacao inteira, inclusive da linha do
-- livro-razao: a recusa desapareceria exatamente no lugar onde foi mandado que
-- ela aparecesse. Nao existe transacao autonoma em plpgsql para contornar isso.
-- Entao: a submissao e retida, com estado proprio, bloqueio proprio, acao
-- propria no historico, e nomeada no resumo que volta para o operador.
--
-- O que o operador ve, sem precisar abrir o banco:
--   - `importacao_externa_aplicar` devolve `recusadas_na_revalidacao`, com
--     submissao, codigo, motivo, participante pretendido e etapas envolvidas;
--   - `por_estado` conta o estado FINAL (a recusada conta como conflito ou
--     pendente, nao como importavel), e por isso a conferencia que a tela ja faz
--     (`conferirPreviaContraGravado`) ACUSA divergencia em vez de dizer "pronto";
--   - a linha da submissao guarda `bloqueio.motivo` e `bloqueio.codigo`;
--   - `v_aptidao_pontuacao_externa` passa a devolver o codigo
--     'RECUSADA_NA_REVALIDACAO', que nao se confunde com identidade nao
--     resolvida.
--
-- NADA e descartado: o payload cru, a proveniencia e os itens pergunta-por-
-- pergunta continuam gravados. Dado coletado de uma pessoa nao se joga fora; o
-- que se recusa e SOBRESCREVER a resposta dela.

-- ===========================================================================
-- 1. O HISTORICO GANHA A ACAO PROPRIA DA RECUSA
-- ===========================================================================
-- Append-only: a recusa nao e um estado que substitui outro, e uma linha nova.
-- Sem este nome, a recusa teria de se disfarcar de 'retida_conflito' -- que diz
-- "o planejador viu conflito de identidade", coisa diferente de "o plano estava
-- certo quando foi montado e deixou de estar".
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
                                   -- aplicacao. NADA desta submissao foi gravado
                                   -- como resposta canonica.
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
-- 2. A PROCEDENCIA DA LINHA CANONICA PARA DE MENTIR
-- ===========================================================================
-- A regra estrutural do item (d) so vale se `origem = 'externo'` com
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
-- "mesma submissao -> atualizacao legitima" ficaria sendo uma porta aberta: a
-- reimportacao passaria por cima da resposta dela achando que estava
-- atualizando a propria linha.
--
-- Este gatilho e o rastro. Ele dispara SO em linha que hoje e 'externo' (toda a
-- escrita normal do aplicativo, que e a maioria absoluta, nao passa por aqui) e
-- SO quando a escrita nao veio desta funcao de importacao. O efeito e dizer a
-- verdade: a linha passou a ser a resposta da pessoa, e a proveniencia externa
-- sai dela. A submissao externa continua inteira na sua propria tabela, com o
-- payload cru -- nada e perdido, e a reimportacao pode ser refeita (e, agora,
-- sera RECUSADA como conflito, que e o desfecho certo).
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
-- 3. A APLICACAO DO PLANO, com a revalidacao DENTRO da transacao
-- ===========================================================================
-- Substitui a funcao da 022. O que ela continua NAO fazendo: nao escolhe
-- participante, nao cria participante, nao pontua, nao reconcilia identidade --
-- isso e do planejador. O que ela passa a fazer: CONFERIR, no momento da
-- escrita, que o que o plano autorizou continua verdade; e recusar, com nome, o
-- que deixou de ser.
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
  v_resumo jsonb := '{}'::jsonb;
  v_por_estado jsonb := '{}'::jsonb;
  -- --- revalidacao (024) ---
  v_recusa_codigo text;
  v_recusa_motivo text;
  v_bloqueio jsonb;
  v_revalidacao jsonb;
  v_evento_do_part uuid;
  v_email_part text;
  v_email_plano text;
  v_outra uuid;
  v_etapas_conflito text[];
  v_n_app int;
  v_n_ext int;
  v_participantes_no_lote uuid[] := '{}'::uuid[];
  v_recusadas jsonb := '[]'::jsonb;
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

  -- A marca que o gatilho da secao 2 le: daqui para a frente, nesta transacao, as
  -- escritas em quiz_responses SAO da importacao e podem carregar proveniencia
  -- externa. Local da transacao: nao vaza para outra conexao, nao sobrevive ao
  -- commit.
  perform set_config('fort.importacao_externa', 'on', true);

  for s in select * from jsonb_array_elements(plano -> 'submissoes')
  loop
    v_estado := s ->> 'estado';
    v_participant := nullif(s ->> 'participant_id', '')::uuid;
    v_apto := coalesce((s ->> 'apto_para_pontuar')::boolean, false);
    v_recusa_codigo := null;
    v_recusa_motivo := null;
    v_bloqueio := null;
    v_revalidacao := null;
    v_etapas_conflito := null;

    -- Cinto e suspensorio: o check da tabela ja proibiria, mas a mensagem daqui
    -- diz qual submissao, e e ela que o operador vai ler.
    if v_apto and v_estado <> 'importavel' then
      raise exception
        'importacao_externa_aplicar: submissao % pede apto_para_pontuar com estado %. Recusado.',
        s ->> 'submissao_id', v_estado;
    end if;

    -- A linha desta submissao, se ela ja existe. E a chave da regra estrutural:
    -- "escrita por ESTA submissao" quer dizer `external_submission_id` igual a
    -- este id. Submissao nova (id nulo) nao escreveu nada antes -- logo
    -- QUALQUER linha existente nas etapas dela e de outra procedencia.
    select es.id into v_sub_existente
      from public.external_submissions es
     where es.event_id = v_event_id
       and es.formulario_id = v_form_id
       and es.submissao_id = s ->> 'submissao_id';

    -- =====================================================================
    -- REVALIDACAO (024), para quem vai gravar resposta canonica
    -- =====================================================================
    if v_participant is not null and v_estado in ('importavel', 'incompativel') then
      -- (a) IDENTIDADE
      select p.event_id, lower(btrim(coalesce(p.email, '')))
        into v_evento_do_part, v_email_part
        from public.participants p
       where p.id = v_participant;

      v_email_plano := lower(btrim(coalesce(s -> 'proveniencia' ->> 'email_reconciliado', '')));

      if v_evento_do_part is null then
        v_recusa_codigo := 'participante_inexistente';
        v_recusa_motivo := format(
          'RECUSADA NA REVALIDACAO: o participante %s que o plano reconciliou nao existe mais. Nada foi gravado desta submissao.',
          v_participant);
      elsif v_evento_do_part <> v_event_id then
        v_recusa_codigo := 'participante_fora_do_evento';
        v_recusa_motivo := format(
          'RECUSADA NA REVALIDACAO: o participante %s nao e deste evento (%s). Nada foi gravado desta submissao.',
          v_participant, v_event_id);
      elsif (s -> 'proveniencia' ->> 'identidade_via') = 'email_verificado'
            and v_email_plano <> ''
            and v_email_part <> v_email_plano then
        -- A identidade foi estabelecida POR E-MAIL. Se o e-mail da pessoa mudou
        -- depois da previa, a correspondencia que autorizou isto nao existe mais.
        v_recusa_codigo := 'email_do_participante_mudou';
        v_recusa_motivo := format(
          'RECUSADA NA REVALIDACAO: a identidade veio de e-mail verificado (%s) e o participante agora tem outro e-mail. Nada foi gravado desta submissao.',
          v_email_plano);
      end if;

      -- (b) OUTRA SUBMISSAO EXTERNA ATIVA do mesmo participante
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
            'RECUSADA NA REVALIDACAO: a submissao externa %s ja esta ativa para este participante. Duas coletas para a mesma pessoa e CONFLITO, nao atualizacao. Nada foi gravado desta submissao.',
            v_outra);
        end if;
      end if;

      -- (c) DUPLICIDADE DENTRO DO LOTE
      if v_recusa_codigo is null and v_participant = any (v_participantes_no_lote) then
        v_recusa_codigo := 'duplicidade_no_lote';
        v_recusa_motivo :=
          'RECUSADA NA REVALIDACAO: outra submissao DESTE MESMO plano ja gravou para este participante. A segunda nao passa por cima da primeira. Nada foi gravado desta submissao.';
      end if;

      -- (d) RESPOSTA EXISTENTE QUE NAO E DESTA SUBMISSAO
      --     A REGRA: nunca sobrescrever resposta cuja procedencia nao seja ESTA
      --     submissao externa. 'app' = a pessoa respondeu no aplicativo;
      --     'externo' de outro id = outra coleta. As duas sao conflito.
      if v_recusa_codigo is null then
        select count(*) filter (where r.origem <> 'externo'),
               count(*) filter (where r.origem = 'externo'),
               array_agg(r.stage_id::text order by r.stage_id)
          into v_n_app, v_n_ext, v_etapas_conflito
          from public.quiz_responses r
         where r.participant_id = v_participant
           and r.stage_id in (
             select (x ->> 'stage_id')::int
               from jsonb_array_elements(coalesce(s -> 'etapas', '[]'::jsonb)) x
           )
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
              'RECUSADA NA REVALIDACAO: o participante respondeu PELO APLICATIVO nas etapas %s depois que esta previa foi montada. A resposta dele fica; a importacao e recusada como CONFLITO. Nada foi gravado desta submissao.',
              array_to_string(v_etapas_conflito, ', '));
          else
            v_recusa_codigo := 'outra_submissao_externa';
            v_recusa_motivo := format(
              'RECUSADA NA REVALIDACAO: as etapas %s ja tem resposta de OUTRA submissao externa. Trocar uma coleta por outra em silencio nao e atualizacao: e CONFLITO. Nada foi gravado desta submissao.',
              array_to_string(v_etapas_conflito, ', '));
          end if;
        end if;
      end if;

      -- O DESFECHO DA RECUSA. 'conflito' quando ha dois dados disputando a mesma
      -- resposta; 'pendente' quando a identidade deixou de se sustentar -- os dois
      -- exigem participant_id nulo (check da 022), e e por isso que o participante
      -- pretendido fica registrado dentro de `bloqueio`, nomeado, em vez de
      -- perdido.
      if v_recusa_codigo is not null then
        v_revalidacao := jsonb_build_object(
          'codigo', v_recusa_codigo,
          'participante_pretendido', v_participant,
          'identidade_via_do_plano', s -> 'proveniencia' ->> 'identidade_via',
          'email_reconciliado_do_plano', s -> 'proveniencia' ->> 'email_reconciliado',
          'estado_do_plano', v_estado,
          'etapas_em_conflito', coalesce(to_jsonb(v_etapas_conflito), '[]'::jsonb),
          'etapas_nao_gravadas', jsonb_array_length(coalesce(s -> 'etapas', '[]'::jsonb)),
          -- O bloqueio que o plano tinha (ex.: DADO INCOMPATIVEL) nao se perde ao
          -- ser substituido pelo da recusa.
          'bloqueio_do_plano', coalesce(nullif(s -> 'bloqueio', 'null'::jsonb), 'null'::jsonb));

        v_bloqueio := jsonb_build_object(
          'motivo', v_recusa_motivo,
          'codigo', v_recusa_codigo,
          'perguntas', '[]'::jsonb,
          'revalidacao', v_revalidacao);

        v_estado := case
          when v_recusa_codigo in ('participante_inexistente',
                                   'participante_fora_do_evento',
                                   'email_do_participante_mudou')
            then 'pendente'
          else 'conflito'
        end;
        v_participant := null;
        v_apto := false;

        v_recusadas := v_recusadas || jsonb_build_array(jsonb_build_object(
          'submissao_id', s ->> 'submissao_id',
          'codigo', v_recusa_codigo,
          'motivo', v_recusa_motivo,
          'estado', v_estado,
          'participante_pretendido', v_revalidacao -> 'participante_pretendido',
          'etapas_em_conflito', v_revalidacao -> 'etapas_em_conflito',
          'etapas_nao_gravadas', v_revalidacao -> 'etapas_nao_gravadas'));
      end if;
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
      -- Recusada: a identidade nao autoriza mais nada, e o check da 022 nao
      -- aceitaria 'via' com participante nulo fazendo sentido. O que o plano
      -- afirmava fica em `bloqueio.revalidacao`.
      case when v_recusa_codigo is null then s -> 'proveniencia' ->> 'identidade_via' else null end,
      s -> 'proveniencia' ->> 'email_reconciliado',
      v_estado, v_apto,
      case when v_recusa_codigo is null then nullif(s -> 'bloqueio', 'null'::jsonb) else v_bloqueio end,
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
    -- mistura o antigo com o novo. Gravados TAMBEM quando a submissao e recusada:
    -- eles descrevem a COLETA, nao a resposta canonica, e jogar fora o que a
    -- pessoa respondeu porque a gravacao foi recusada seria perder dado dela.
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

    -- As respostas canonicas. SO com participante reconciliado, SO com os
    -- valores COMPATIVEIS que o plano montou (nenhum zero, nenhum placeholder) e
    -- -- desde a 024 -- SO quando a revalidacao nao recusou. `v_recusa_codigo`
    -- nulo aqui e a unica porta: recusada nao grava etapa nenhuma, nem as etapas
    -- que por si nao conflitariam. A unidade de atomicidade e a submissao.
    if v_recusa_codigo is null and v_participant is not null
       and v_estado in ('importavel', 'incompativel') then
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
      v_participantes_no_lote := v_participantes_no_lote || v_participant;
    end if;

    v_acao := case
      when v_recusa_codigo is not null then 'recusada_na_revalidacao'
      when v_estado = 'importavel'   then 'importada'
      when v_estado = 'incompativel' then 'retida_incompativel'
      when v_estado = 'pendente'     then 'retida_pendente'
      when v_estado = 'conflito'     then 'retida_conflito'
      else 'retida_pendente'
    end;
    insert into public.external_submission_events (
      submission_id, acao, operador, operador_email, justificativa, detalhes
    ) values (
      v_sub_id, v_acao, v_operador, v_operador_email,
      case when v_recusa_codigo is not null then v_recusa_motivo
           else s -> 'bloqueio' ->> 'motivo' end,
      jsonb_build_object(
        'estado', v_estado,
        'contagens', s -> 'contagens',
        'etapas_gravadas', case
          when v_recusa_codigo is not null then 0
          else jsonb_array_length(coalesce(s -> 'etapas', '[]'::jsonb))
        end,
        'questionario_impressao', v_impressao,
        'revalidacao', v_revalidacao
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
    'importado_por', v_operador,
    -- O operador tem de saber EXATAMENTE o que nao entrou, e por que. Vazio
    -- quando nada foi recusado: lista vazia e uma afirmacao, nao uma omissao.
    'recusadas_na_revalidacao', v_recusadas,
    'recusas_na_revalidacao', jsonb_array_length(v_recusadas)
  );
  return v_resumo;
end;
$$;

comment on function public.importacao_externa_aplicar(jsonb) is
  'Grava um plano de importacao externa numa transacao e REVALIDA dentro dela (identidade, duplicidade, respostas existentes). Nunca sobrescreve resposta canonica que nao tenha sido escrita por ESTA submissao externa: resposta do aplicativo ou de outra coleta vira recusa como conflito, registrada em external_submission_events com acao propria. Nao decide identidade nem pontuacao (isso e lib/importacao/*).';

-- ===========================================================================
-- 4. A VISAO DE APTIDAO APRENDE O NOVO DESFECHO
-- ===========================================================================
-- Sem isto, uma submissao recusada na revalidacao apareceria como
-- 'IDENTIDADE_NAO_RESOLVIDA' -- que e falso: a identidade estava resolvida; o
-- que aconteceu e que a resposta canonica passou a ter outro dono. Codigo novo,
-- nome proprio, nenhum nome reaproveitado dizendo outra coisa. As colunas e os
-- tipos sao os mesmos da 022 (requisito de `create or replace view`).
create or replace view public.v_aptidao_pontuacao_externa as
select
  es.event_id,
  es.participant_id,
  es.id            as submission_id,
  es.estado,
  es.apto_para_pontuar as pode_pontuar,
  case
    when es.apto_para_pontuar then null
    when es.bloqueio ->> 'codigo' in (
      'resposta_do_aplicativo', 'outra_submissao_externa',
      'outra_submissao_ativa_do_participante', 'duplicidade_no_lote',
      'participante_inexistente', 'participante_fora_do_evento',
      'email_do_participante_mudou'
    ) then 'RECUSADA_NA_REVALIDACAO'
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
  'Pode pontuar as respostas externas deste participante? Quatro desfechos: apto, DADO_INCOMPATIVEL (respondeu e nao casou -- nunca zero), RECUSADA_NA_REVALIDACAO (o plano envelheceu: alguem respondeu no aplicativo ou outra coleta ja ocupa a linha) ou identidade/aptidao nao verificada.';

revoke all on public.v_aptidao_pontuacao_externa from anon, authenticated;
