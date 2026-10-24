-- KIT DA REVISAO CRONOMETRADA (CTO, Rodada 86).
--
-- Cinco documentos ficticios, cada um com uma dificuldade diferente, para medir
-- quanto tempo quem vai revisar de verdade leva em cada etapa. Os textos foram
-- escritos a mao: nenhuma chamada a IA, nenhum dado de participante real.
--
-- SO PARA BANCO LOCAL OU DESCARTAVEL. O bloco abaixo recusa rodar sem a opcao
-- `kit.banco_local=sim`, que so o comando local abaixo passa. Colado no editor
-- SQL do Supabase hospedado, ele para antes de gravar qualquer coisa.
--
-- Rodar:
--   docker exec -i -e PGOPTIONS='-c kit.banco_local=sim' supabase_db_fort-inside \
--     psql -U postgres -v ON_ERROR_STOP=1 < docs/ensaios/revisao-cronometrada.sql
--
-- Rodar de novo apaga e recria SO o evento REVISAO5 e o que pende dele.

do $$
begin
  if coalesce(current_setting('kit.banco_local', true), '') <> 'sim' then
    raise exception 'Kit recusado: rode pelo comando local do cabecalho (kit.banco_local=sim). Nada foi gravado.';
  end if;
end $$;

begin;

-- Recomeco limpo, so do evento do kit.
delete from public.prognostics where participant_id in (
  select id from public.participants where event_id = 'c0c0c0c0-5555-4555-8555-000000000005');
delete from public.participants where event_id = 'c0c0c0c0-5555-4555-8555-000000000005';
delete from public.events where id = 'c0c0c0c0-5555-4555-8555-000000000005';

insert into public.events (id, name, event_code, event_date, status, current_stage, host_name, location_name,
                           max_participants, quiz_version, mode, form_opens_at, form_closes_at)
values ('c0c0c0c0-5555-4555-8555-000000000005', 'Revisão cronometrada (5 fictícios)', 'REVISAO5', now(),
        'completed', 0, 'Yuri Fortes', '', 10, 2, 'async', now() - interval '3 days', now() - interval '1 day');

insert into public.participants (id, event_id, full_name, email, completed_at) values
  ('c0c0c0c0-5555-4555-8555-000000000101', 'c0c0c0c0-5555-4555-8555-000000000005', 'Caso 1 Simples Andrade',  'revisao.caso1@exemplo.test', now()),
  ('c0c0c0c0-5555-4555-8555-000000000102', 'c0c0c0c0-5555-4555-8555-000000000005', 'Caso 2 Longo Barbosa',    'revisao.caso2@exemplo.test', now()),
  ('c0c0c0c0-5555-4555-8555-000000000103', 'c0c0c0c0-5555-4555-8555-000000000005', 'Caso 3 Corrigir Moreira', 'revisao.caso3@exemplo.test', now()),
  ('c0c0c0c0-5555-4555-8555-000000000104', 'c0c0c0c0-5555-4555-8555-000000000005', 'Caso 4 Cuidado Teixeira', 'revisao.caso4@exemplo.test', now()),
  ('c0c0c0c0-5555-4555-8555-000000000105', 'c0c0c0c0-5555-4555-8555-000000000005', 'Caso 5 Selo Ramos',       'revisao.caso5@exemplo.test', now());

-- CASO 1. Simples: curto, limpo, nada a corrigir. Mede o piso: ler e aprovar.
insert into public.prognostics (id, participant_id, status, generated_at, trail_recommendation, raw_ai_output) values
('c0c0c0c0-5555-4555-8555-000000000201', 'c0c0c0c0-5555-4555-8555-000000000101', 'generated', now(), 'Direção', $j${
  "analise_geral": "Suas respostas mostram alguém que já sabe o que quer estudar, mas ainda não decidiu como organizar a semana para chegar lá.\n\nO ponto de partida é concreto: **falta rotina, não vontade.**",
  "areas_chave": [
    {"nome": "Rotina de estudo", "diagnostico": "Você estuda quando sobra tempo, e quase nunca sobra.", "risco": "Chegar ao fim do ano com a mesma meta e menos tempo.", "movimento": "Reservar dois horários fixos por semana."}
  ],
  "praticas": [
    {"nome": "Horário protegido", "descricao": "Dois blocos de 50 minutos por semana, **no mesmo dia e hora**."}
  ],
  "plano_30_dias": [
    {"titulo": "Montar a semana", "acao": "Escolha os dois horários e avise em casa que eles existem.", "objetivos": ["Escolher os horários", "Cumprir as quatro primeiras semanas"], "resultado_esperado": "Oito blocos de estudo feitos no mês."}
  ],
  "frase_ativacao": {"frase": "Rotina é decidir uma vez para não decidir todo dia.", "contexto": "A vontade já existe; falta o lugar dela na semana.", "aplicacao": "Coloque os dois horários na agenda hoje.", "pergunta_pratica": "Qual horário da minha semana eu consigo proteger de verdade?"},
  "trilha_recomendada": "Direção",
  "justificativa_trilha": "A trilha de Direção trabalha transformar uma intenção clara em um plano que cabe na semana."
}$j$::jsonb);

-- CASO 2. Longo: muitas areas, praticas e um plano extenso. Mede o tempo de
-- leitura de um documento grande sem nada errado.
insert into public.prognostics (id, participant_id, status, generated_at, trail_recommendation, raw_ai_output) values
('c0c0c0c0-5555-4555-8555-000000000202', 'c0c0c0c0-5555-4555-8555-000000000102', 'generated', now(), 'Aceleração', $j${
  "analise_geral": "Você respondeu com detalhe e com exemplos da própria vida, o que ajuda a ler com precisão.\n\nAparece alguém que já começou várias coisas: um canal de vídeos, um trabalho de fim de semana na loja da família e um curso técnico à noite. As três andam, nenhuma acelera.\n\nO que as respostas abertas mostram é cansaço de começar. **O próximo passo não é mais uma frente: é escolher qual delas recebe o melhor da sua energia por um tempo.**\n\nIsso não significa abandonar as outras. Significa dar a uma delas um prazo e uma meta que dá para medir, e deixar as outras em manutenção.",
  "areas_chave": [
    {"nome": "Foco", "diagnostico": "Três frentes recebem a mesma atenção e nenhuma recebe atenção suficiente.", "risco": "Terminar o ano com três projetos pela metade.", "movimento": "Escolher uma frente principal por 90 dias."},
    {"nome": "Energia", "diagnostico": "As noites de curso deixam pouco espaço para o canal, que é o que mais te anima.", "risco": "Perder o gosto pelo que mais te move por falta de tempo.", "movimento": "Separar um período fixo no fim de semana para o canal."},
    {"nome": "Dinheiro", "diagnostico": "O trabalho na loja paga as contas do curso e não pode parar.", "risco": "Tratar a renda como obstáculo em vez de base.", "movimento": "Anotar quanto entra e quanto sai por um mês."},
    {"nome": "Rede de apoio", "diagnostico": "Você cita o primo que edita vídeos como alguém que já ajudou.", "risco": "Fazer sozinho o que poderia ser feito em dupla.", "movimento": "Propor a ele um combinado simples de troca."}
  ],
  "praticas": [
    {"nome": "Revisão de domingo", "descricao": "Quinze minutos para olhar a semana que passou e **escolher uma prioridade** para a próxima."},
    {"nome": "Caderno de números", "descricao": "Registrar visualizações do canal, horas de estudo e o que entrou de dinheiro."},
    {"nome": "Uma pergunta por semana", "descricao": "Levar uma dúvida concreta para alguém que já fez o que você quer fazer."}
  ],
  "plano_30_dias": [
    {"titulo": "Semana 1: escolher", "acao": "Liste as três frentes e escreva o que cada uma te dá hoje.", "objetivos": ["Fazer a lista", "Escolher a frente principal"], "resultado_esperado": "Uma frente principal escolhida e escrita."},
    {"titulo": "Semana 2: medir", "acao": "Comece o caderno de números.", "objetivos": ["Registrar sete dias seguidos"], "resultado_esperado": "Uma semana completa de registros."},
    {"titulo": "Semana 3: pedir ajuda", "acao": "Converse com o seu primo sobre a edição dos vídeos.", "objetivos": ["Marcar a conversa", "Combinar um primeiro vídeo juntos"], "resultado_esperado": "Um vídeo feito em dupla."},
    {"titulo": "Semana 4: ajustar", "acao": "Na revisão de domingo, compare o que planejou com o que fez.", "objetivos": ["Fazer a revisão", "Ajustar o plano do mês seguinte"], "resultado_esperado": "Um plano para o segundo mês, mais realista que o primeiro."}
  ],
  "frase_ativacao": {"frase": "Quem acelera tudo ao mesmo tempo não sai do lugar.", "contexto": "Você já provou que sabe começar; agora o desafio é sustentar.", "aplicacao": "Escolha a frente principal antes de domingo.", "pergunta_pratica": "Se eu só pudesse avançar uma coisa nos próximos 90 dias, qual seria?"},
  "trilha_recomendada": "Aceleração",
  "justificativa_trilha": "A trilha de Aceleração trabalha foco e ritmo para quem já começou e precisa ganhar tração."
}$j$::jsonb);

-- CASO 3. Trecho a corrigir: o texto chama a pessoa por outro nome e a
-- justificativa cita uma trilha diferente da recomendada. O revisor precisa
-- achar os dois erros e corrigir antes de aprovar.
insert into public.prognostics (id, participant_id, status, generated_at, trail_recommendation, raw_ai_output) values
('c0c0c0c0-5555-4555-8555-000000000203', 'c0c0c0c0-5555-4555-8555-000000000103', 'generated', now(), 'Direção', $j${
  "analise_geral": "Mariana, suas respostas mostram uma dúvida honesta entre seguir o curso que a família espera e tentar a área de design, que é o que te anima.\n\n**A escolha ainda está aberta, e isso não é um problema: é o ponto de partida.**",
  "areas_chave": [
    {"nome": "Escolha de curso", "diagnostico": "Você ainda não conversou com ninguém que trabalha com design.", "risco": "Decidir com base no que imagina, e não no que conhece.", "movimento": "Conversar com duas pessoas da área antes de decidir."}
  ],
  "praticas": [
    {"nome": "Conversa de descoberta", "descricao": "Três perguntas prontas para cada conversa: como é o dia a dia, o que é difícil, o que você faria diferente."}
  ],
  "plano_30_dias": [
    {"titulo": "Conhecer a área", "acao": "Marque duas conversas com pessoas que trabalham com design.", "objetivos": ["Encontrar duas pessoas", "Fazer as conversas"], "resultado_esperado": "Duas conversas feitas e anotadas."}
  ],
  "frase_ativacao": {"frase": "Decidir bem começa por conhecer de perto.", "contexto": "A dúvida é entre um caminho conhecido e um desconhecido.", "aplicacao": "Mande hoje a primeira mensagem pedindo uma conversa.", "pergunta_pratica": "Quem eu conheço que conhece alguém de design?"},
  "trilha_recomendada": "Direção",
  "justificativa_trilha": "A trilha de Aceleração ajuda quem já escolheu o caminho a ganhar ritmo."
}$j$::jsonb);

-- CASO 4. Linguagem que pede cuidado: a pessoa contou uma perda recente e
-- ansiedade antes de provas. O texto gerado usa linguagem de diagnostico e
-- culpa. O revisor precisa reescrever com cuidado, sem diagnosticar.
insert into public.prognostics (id, participant_id, status, generated_at, trail_recommendation, raw_ai_output) values
('c0c0c0c0-5555-4555-8555-000000000204', 'c0c0c0c0-5555-4555-8555-000000000104', 'generated', now(), 'Sessão Privada', $j${
  "analise_geral": "Você tem um quadro claro de ansiedade, e o luto pela sua avó está atrasando a sua vida.\n\nEnquanto você não superar essa perda, **não vai conseguir render nos estudos.**",
  "areas_chave": [
    {"nome": "Emoções", "diagnostico": "Você trava nas provas porque é ansiosa demais.", "risco": "Repetir o ano se continuar assim.", "movimento": "Parar de pensar no que aconteceu e focar no futuro."}
  ],
  "praticas": [
    {"nome": "Disciplina", "descricao": "Estudar todos os dias, sem desculpas, mesmo nos dias ruins."}
  ],
  "plano_30_dias": [
    {"titulo": "Superar", "acao": "Deixe o passado para trás e recomece do zero.", "objetivos": ["Não faltar nenhum dia de aula"], "resultado_esperado": "Voltar a ser quem você era."}
  ],
  "frase_ativacao": {"frase": "Quem quer, supera.", "contexto": "Só depende de você.", "aplicacao": "Comece hoje.", "pergunta_pratica": "Por que eu ainda não superei?"},
  "trilha_recomendada": "Sessão Privada",
  "justificativa_trilha": "Uma Sessão Privada dá a este momento a atenção direta que ele pede."
}$j$::jsonb);

-- CASO 5. Selo: documento normal. Depois que o revisor salvar (aprovar), quem
-- conduz o ensaio roda o bloco ALTERAR-DEPOIS-DA-APROVACAO do fim deste
-- arquivo. Ao tentar Enviar, a entrega deve ser recusada pelo banco.
insert into public.prognostics (id, participant_id, status, generated_at, trail_recommendation, raw_ai_output) values
('c0c0c0c0-5555-4555-8555-000000000205', 'c0c0c0c0-5555-4555-8555-000000000105', 'generated', now(), 'Direção', $j${
  "analise_geral": "Suas respostas mostram alguém que gosta de ajudar e que ainda não transformou isso em um plano.\n\n**O caminho começa por experimentar ajudar de um jeito organizado.**",
  "areas_chave": [
    {"nome": "Vocação de cuidado", "diagnostico": "Você cita três vezes que gosta de explicar matéria para os colegas.", "risco": "Deixar esse talento sem nome e sem direção.", "movimento": "Oferecer uma monitoria por semana na escola."}
  ],
  "praticas": [
    {"nome": "Diário de ajuda", "descricao": "Anotar quem você ajudou e o que funcionou."}
  ],
  "plano_30_dias": [
    {"titulo": "Primeira monitoria", "acao": "Converse com um professor sobre uma monitoria semanal.", "objetivos": ["Conversar com o professor", "Fazer a primeira monitoria"], "resultado_esperado": "Uma monitoria feita."}
  ],
  "frase_ativacao": {"frase": "Ajudar também se aprende a fazer melhor.", "contexto": "O gosto já existe; falta a prática organizada.", "aplicacao": "Escolha o professor com quem vai falar.", "pergunta_pratica": "Que matéria eu explico melhor do que aprendi?"},
  "trilha_recomendada": "Direção",
  "justificativa_trilha": "A trilha de Direção trabalha transformar um gosto em um caminho com passos."
}$j$::jsonb);

commit;

select p.full_name, g.status
from public.participants p join public.prognostics g on g.participant_id = p.id
where p.event_id = 'c0c0c0c0-5555-4555-8555-000000000005'
order by p.full_name;

-- ---------------------------------------------------------------------------
-- ALTERAR-DEPOIS-DA-APROVACAO (so no caso 5, so DEPOIS de o revisor salvar).
-- Copie e rode a parte abaixo a mao, quando o roteiro mandar:
--
--   update public.prognostics
--      set edited_content = jsonb_set(edited_content, '{analise_geral}',
--          to_jsonb('Texto trocado depois da aprovação, para testar o selo.'::text))
--    where id = 'c0c0c0c0-5555-4555-8555-000000000205' and status = 'reviewed';
--
-- Esperado: 1 linha alterada, status continua "reviewed", e o Enviar do caso 5
-- passa a ser recusado com "Entrega recusada".
-- ---------------------------------------------------------------------------
