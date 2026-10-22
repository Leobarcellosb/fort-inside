-- 017_quiz_v2_seed.sql
-- Seed do questionario do Marco Zero (quiz_version = 2): 5 etapas, 52 perguntas.
-- Idempotente (upsert por id, nunca delete) e restrito aos ids 101..105. Nao
-- toca nas etapas 1..6 do Fort Inside (versao 1), cujo conteudo e o gabarito
-- das respostas ja gravadas. Seguro rodar duas vezes seguidas.
--
-- DEPENDE DA 010: usa quiz_stages.quiz_version e quiz_stages.stage_number.
--
-- POR QUE NAO HA delete: quiz_responses.stage_id tem FK para quiz_stages(id)
-- sem ON DELETE. Apagar etapa quebra com qualquer resposta gravada, e ja
-- quebrou neste projeto. Por isso upsert, como a 003.
--
-- FONTE DO CONTEUDO: questionario preparatorio "Marco Zero | Geracao Preparada"
-- do dono do produto, 52 perguntas numeradas. O texto das perguntas e das
-- alternativas e copiado como esta; so foram removidos os marcadores de negrito
-- (**) e o numero inicial ("7. "), que a interface mostra como "Pergunta X de N"
-- e que o id da pergunta ja carrega.
--
-- IDS: o id da pergunta e "q" + o numero da pergunta na fonte, e o motor de
-- pontuacao (lib/scoring/marco-zero.ts) le exatamente estes ids:
--   q7..q13   os 7 Elementos da Vida Plena (escala 0..10)
--   q16..q39  24 itens Likert, 6 por eixo (escala 1..5)
--   q40..q45  6 situacionais (A/B/C/D, cada alternativa pertence a um eixo)
-- As demais (q1..q6 contexto pessoal, q14/q15 e q46..q52 abertas) nao sao
-- consumidas pelo motor; seus ids nao colidem com os acima. Os ids sao unicos
-- no questionario inteiro (nao so dentro de cada etapa), para que as respostas
-- das 5 etapas possam ser achatadas num unico mapa id -> valor.
--
-- AGRUPAMENTO: uma etapa por secao da fonte, nada alem.
--   101 Sobre voce                          q1..q6    (6)
--   102 Os 7 Elementos da Vida Plena        q7..q15   (9)
--   103 Perfil comportamental               q16..q39  (24)
--   104 Como voce reage na pratica          q40..q45  (6)
--   105 Sua preparacao para o Marco Zero    q46..q52  (7)
--
-- SEM PISO DE CARACTERES: a fonte nao especifica minimo, entao nenhuma pergunta
-- aberta tem min_chars > 0 (o 0 explicito segue a convencao da 009). Medicao do
-- evento anterior: todos escreveram 2 a 3x o minimo exigido, ou seja, o piso
-- nunca produziu profundidade, so atrito. `required` exige apenas nao-vazio.
-- Os unicos tetos (max_chars) estao em respostas curtas de uma linha (nome,
-- idade, cidade, organizacao, papel, "tres palavras"): sao limite superior de
-- campo de uma linha, nao exigencia de escrita.
--
-- ALTERNATIVAS SITUACIONAIS: o tipo `select` da interface grava o TEXTO da
-- opcao escolhida, nao a letra. As opcoes mantem o prefixo da fonte ("A. ...")
-- para que a letra seja recuperavel do proprio valor gravado. Quem achatar as
-- respostas para o motor precisa extrair a letra (o motor le "A".."D").
--
-- `description` guarda a instrucao da secao exatamente como esta na fonte. A
-- tela do participante ainda nao a exibe; o prompt do prognostico a usa como
-- "Contexto" da etapa.
--
-- `ambient_name` e NOT NULL e a fonte nao tem nome de ambiente: usa-se o nome
-- do produto. Pode ser trocado aqui e a migration reaplicada.

insert into quiz_stages
  (id, title, ambient_name, description, quiz_version, stage_number, questions)
values

(101, 'Sobre você', 'Marco Zero', null, 2, 1, $json$[
  {
    "id": "q1",
    "type": "short_text",
    "required": true,
    "text": "Qual é seu nome completo?",
    "max_chars": 120
  },
  {
    "id": "q2",
    "type": "short_text",
    "required": true,
    "text": "Qual é sua idade?",
    "max_chars": 3
  },
  {
    "id": "q3",
    "type": "short_text",
    "required": true,
    "text": "Em qual cidade e estado você mora?",
    "max_chars": 120
  },
  {
    "id": "q4",
    "type": "short_text",
    "required": true,
    "text": "Qual organização, empresa, entidade ou comunidade você representa?",
    "max_chars": 160
  },
  {
    "id": "q5",
    "type": "short_text",
    "required": true,
    "text": "Qual é seu papel atual nessa organização?",
    "max_chars": 160
  },
  {
    "id": "q6",
    "type": "text",
    "required": true,
    "text": "Em quais ambientes você mais exerce influência ou liderança hoje?",
    "min_chars": 0
  }
]$json$::jsonb),

(102, 'Os 7 Elementos da Vida Plena', 'Marco Zero', 'Pensando no seu momento atual, responda de 0 a 10, sendo 0 “totalmente insatisfeito” e 10 “plenamente satisfeito”.', 2, 2, $json$[
  {
    "id": "q7",
    "type": "scale",
    "required": true,
    "text": "Desenvolvimento intelectual: quanto você está satisfeito com seu aprendizado, seu repertório e o desenvolvimento de suas capacidades?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q8",
    "type": "scale",
    "required": true,
    "text": "Saúde e energia: quanto você está satisfeito com sua saúde, sua disposição e o cuidado com seu corpo?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q9",
    "type": "scale",
    "required": true,
    "text": "Equilíbrio emocional: quanto você está satisfeito com sua capacidade de compreender suas emoções e lidar com pressões e desafios?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q10",
    "type": "scale",
    "required": true,
    "text": "Recursos financeiros: quanto você está satisfeito com sua organização financeira e com os recursos disponíveis para sustentar sua vida e seus projetos?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q11",
    "type": "scale",
    "required": true,
    "text": "Contribuição social: quanto você está satisfeito com a contribuição que oferece às pessoas, à sua comunidade e à sociedade?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q12",
    "type": "scale",
    "required": true,
    "text": "Realização e propósito: quanto você está satisfeito com o sentido, a direção e a realização que encontra na sua vida?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q13",
    "type": "scale",
    "required": true,
    "text": "Hobbies e diversão: quanto você está satisfeito com o espaço que dedica ao lazer, ao descanso e às atividades que fazem você se sentir bem?",
    "min": 0,
    "max": 10,
    "min_label": "Totalmente insatisfeito",
    "max_label": "Plenamente satisfeito"
  },
  {
    "id": "q14",
    "type": "text",
    "required": true,
    "text": "Qual desses sete elementos mais precisa da sua atenção neste momento? Por quê?",
    "min_chars": 0
  },
  {
    "id": "q15",
    "type": "text",
    "required": true,
    "text": "Qual mudança concreta nessa área faria mais diferença na sua vida nos próximos 90 dias?",
    "min_chars": 0
  }
]$json$::jsonb),

(103, 'Perfil comportamental', 'Marco Zero', 'Responda considerando como você costuma agir no dia a dia. Utilize a escala: 1 — Discordo totalmente | 2 — Discordo | 3 — Nem concordo nem discordo | 4 — Concordo | 5 — Concordo totalmente', 2, 3, $json$[
  {
    "id": "q16",
    "type": "scale",
    "required": true,
    "text": "Consigo definir prioridades quando existem muitas possibilidades.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q17",
    "type": "scale",
    "required": true,
    "text": "Costumo conectar as decisões de hoje aos seus efeitos de longo prazo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q18",
    "type": "scale",
    "required": true,
    "text": "Questiono as premissas antes de aceitar a primeira explicação.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q19",
    "type": "scale",
    "required": true,
    "text": "Percebo padrões e oportunidades antes que fiquem evidentes para o grupo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q20",
    "type": "scale",
    "required": true,
    "text": "Quando o grupo está sem direção, costumo ajudar a encontrar um caminho.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q21",
    "type": "scale",
    "required": true,
    "text": "Consigo tomar decisões mesmo sem ter todas as informações.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q22",
    "type": "scale",
    "required": true,
    "text": "Transformo ideias em passos, responsáveis e prazos.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q23",
    "type": "scale",
    "required": true,
    "text": "Mantenho o ritmo mesmo quando a motivação inicial diminui.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q24",
    "type": "scale",
    "required": true,
    "text": "Costumo concluir o que começo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q25",
    "type": "scale",
    "required": true,
    "text": "Cumpro meus combinados mesmo quando ninguém está cobrando.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q26",
    "type": "scale",
    "required": true,
    "text": "Sob pressão, consigo concentrar energia no que precisa ser entregue.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q27",
    "type": "scale",
    "required": true,
    "text": "Divido objetivos grandes em ações que podem ser executadas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q28",
    "type": "scale",
    "required": true,
    "text": "Escuto para compreender antes de defender meu ponto de vista.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q29",
    "type": "scale",
    "required": true,
    "text": "Adapto minha comunicação a pessoas e contextos diferentes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q30",
    "type": "scale",
    "required": true,
    "text": "Consigo envolver outras pessoas em torno de uma ideia.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q31",
    "type": "scale",
    "required": true,
    "text": "Procuro incluir pessoas que ainda não tiveram espaço para falar.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q32",
    "type": "scale",
    "required": true,
    "text": "Conecto pessoas que podem gerar valor juntas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q33",
    "type": "scale",
    "required": true,
    "text": "Consigo lidar com divergências preservando a relação.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q34",
    "type": "scale",
    "required": true,
    "text": "Preservo meus princípios mesmo quando isso torna uma decisão mais difícil.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q35",
    "type": "scale",
    "required": true,
    "text": "Avalio os riscos antes de assumir compromissos importantes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q36",
    "type": "scale",
    "required": true,
    "text": "As pessoas sabem que podem contar comigo.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q37",
    "type": "scale",
    "required": true,
    "text": "Procuro preservar a qualidade mesmo quando existe pressão por velocidade.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q38",
    "type": "scale",
    "required": true,
    "text": "Considero o impacto das minhas decisões sobre outras pessoas.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  },
  {
    "id": "q39",
    "type": "scale",
    "required": true,
    "text": "Costumo me preparar antes de entrar em situações importantes.",
    "min": 1,
    "max": 5,
    "min_label": "Discordo totalmente",
    "max_label": "Concordo totalmente"
  }
]$json$::jsonb),

(104, 'Como você reage na prática', 'Marco Zero', 'Em cada situação, escolha apenas a alternativa que mais se aproxima da sua primeira reação habitual.', 2, 4, $json$[
  {
    "id": "q40",
    "type": "select",
    "required": true,
    "text": "Um projeto importante está pouco claro e o prazo está próximo. O que você tende a fazer primeiro?",
    "options": [
      "A. Organizar o problema e definir a prioridade antes de avançar.",
      "B. Começar pelo próximo passo mais concreto para recuperar o movimento.",
      "C. Reunir as pessoas envolvidas e alinhar expectativas e compromissos.",
      "D. Revisar os critérios, os riscos e as responsabilidades."
    ]
  },
  {
    "id": "q41",
    "type": "select",
    "required": true,
    "text": "Duas pessoas importantes do grupo entram em conflito e o trabalho começa a parar. Qual tende a ser sua reação?",
    "options": [
      "A. Escutar os dois lados e ajudar a reconstruir o diálogo.",
      "B. Relembrar os acordos e os limites que precisam ser preservados.",
      "C. Identificar a causa do conflito e propor uma direção comum.",
      "D. Reorganizar as tarefas para que o trabalho volte a avançar."
    ]
  },
  {
    "id": "q42",
    "type": "select",
    "required": true,
    "text": "Surge uma oportunidade relevante, mas com riscos e informações incompletas. Qual é seu primeiro movimento?",
    "options": [
      "A. Testar rapidamente uma versão pequena da oportunidade.",
      "B. Comparar a oportunidade com meus objetivos de longo prazo.",
      "C. Verificar os riscos e os impactos sobre as pessoas envolvidas.",
      "D. Conversar com pessoas de confiança e buscar apoio."
    ]
  },
  {
    "id": "q43",
    "type": "select",
    "required": true,
    "text": "Você percebe que um projeto do grupo está atrasado. O que tende a fazer primeiro?",
    "options": [
      "A. Verificar o que precisa ser preservado para não comprometer a qualidade.",
      "B. Reorganizar o plano, definir responsáveis e marcar a próxima entrega.",
      "C. Conversar com o time para recuperar energia e compromisso.",
      "D. Rever as prioridades e eliminar o que está desviando o foco."
    ]
  },
  {
    "id": "q44",
    "type": "select",
    "required": true,
    "text": "Uma decisão sua recebe uma crítica pública. Como você tende a reagir primeiro?",
    "options": [
      "A. Identificar o ponto central da crítica e avaliar o que precisa mudar.",
      "B. Ouvir a pessoa e procurar compreender sua perspectiva.",
      "C. Assumir o que me cabe e apresentar uma ação concreta.",
      "D. Verificar os fatos e as responsabilidades antes de responder."
    ]
  },
  {
    "id": "q45",
    "type": "select",
    "required": true,
    "text": "Depois de uma experiência inspiradora, como você costuma transformar uma intenção em compromisso?",
    "options": [
      "A. Compartilho com alguém e crio uma rede de apoio.",
      "B. Coloco na agenda, estabeleço um prazo e começo a executar.",
      "C. Defino critérios e limites para sustentar o compromisso.",
      "D. Conecto a intenção à minha visão de futuro e escolho uma prioridade."
    ]
  }
]$json$::jsonb),

(105, 'Sua preparação para o Marco Zero', 'Marco Zero', null, 2, 5, $json$[
  {
    "id": "q46",
    "type": "short_text",
    "required": true,
    "text": "Em três palavras, quem você deseja se tornar nos próximos anos?",
    "max_chars": 80
  },
  {
    "id": "q47",
    "type": "text",
    "required": true,
    "text": "Qual comportamento seu mais ajuda você a avançar? Conte um exemplo.",
    "min_chars": 0
  },
  {
    "id": "q48",
    "type": "text",
    "required": true,
    "text": "Qual comportamento seu mais atrapalha seu desenvolvimento? Em quais situações ele aparece?",
    "min_chars": 0
  },
  {
    "id": "q49",
    "type": "text",
    "required": true,
    "text": "Qual responsabilidade ou decisão importante você vem adiando?",
    "min_chars": 0
  },
  {
    "id": "q50",
    "type": "text",
    "required": true,
    "text": "O que você pode oferecer ao grupo durante e depois do Marco Zero?",
    "min_chars": 0
  },
  {
    "id": "q51",
    "type": "text",
    "required": true,
    "text": "O que você precisa encontrar ou receber desse grupo para avançar?",
    "min_chars": 0
  },
  {
    "id": "q52",
    "type": "text",
    "required": true,
    "text": "O que precisa acontecer para você sair do Marco Zero sentindo que essa experiência valeu a pena?",
    "min_chars": 0
  }
]$json$::jsonb)
on conflict (id) do update set
  title        = excluded.title,
  ambient_name = excluded.ambient_name,
  description  = excluded.description,
  quiz_version = excluded.quiz_version,
  stage_number = excluded.stage_number,
  questions    = excluded.questions;

-- ---------------------------------------------------------------
-- Guarda de integridade. Falha a migration (em vez de semear em silencio algo
-- que o motor nao consegue ler) se, na versao 2:
--   - faltar algum id que o motor espera, ou houver id de pergunta repetido;
--   - houver caractere de encoding corrompido (licao da 008: UTF-8 lido como
--     MacRoman gravou lixo no lugar de cedilha).
-- ---------------------------------------------------------------
do $$
declare
  faltando text;
  repetidos text;
  lixo int;
begin
  select string_agg(esperado, ', ' order by esperado) into faltando
  from (
    select 'q' || g as esperado
    from generate_series(7, 13) g
    union all select 'q' || g from generate_series(16, 45) g
  ) e
  where esperado not in (
    select q ->> 'id'
    from quiz_stages s, jsonb_array_elements(s.questions) q
    where s.quiz_version = 2
  );
  if faltando is not null then
    raise exception '017: ids que o motor espera nao existem na versao 2: %', faltando;
  end if;

  select string_agg(id, ', ' order by id) into repetidos
  from (
    select q ->> 'id' as id
    from quiz_stages s, jsonb_array_elements(s.questions) q
    where s.quiz_version = 2
    group by 1
    having count(*) > 1
  ) d;
  if repetidos is not null then
    raise exception '017: ids de pergunta duplicados na versao 2: %', repetidos;
  end if;

  select count(*) into lixo
  from quiz_stages s
  where s.quiz_version = 2
    and (s.title || coalesce(s.description, '') || s.questions::text)
        ~ ('[Ã√' || chr(65533) || ']');
  if lixo > 0 then
    raise exception '017: % etapa(s) da versao 2 com encoding corrompido', lixo;
  end if;
end;
$$;
