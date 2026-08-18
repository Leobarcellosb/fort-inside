-- Fort Inside — seed das 6 etapas do quiz
-- Gerado a partir do banco de produção. O seed anterior tinha 5 etapas com
-- títulos diferentes, o que deixava o gate de 6 etapas da geração de
-- prognóstico impossível de satisfazer num deploy limpo.

-- Upsert em vez de delete+insert: quiz_responses.stage_id tem FK para
-- quiz_stages(id) sem ON DELETE, então apagar as etapas quebra com qualquer
-- resposta já gravada. Assim a migration roda tanto num banco novo quanto
-- num banco com histórico.
insert into quiz_stages (id, title, ambient_name, description, questions) values

(1, 'Seu Ponto de Partida', 'Portão', null, '[
  {
    "id": "q1",
    "text": "Hoje, em que momento da sua jornada você sente que está?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Responde com sinceridade. Sem pressa."
  },
  {
    "id": "q2",
    "text": "O que mais te trouxe até aqui hoje?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Pode ser específico. Pode ser geral. O que vier."
  },
  {
    "id": "q3",
    "text": "O que você sente que mais precisa neste momento?",
    "type": "select",
    "options": [
      "Clareza",
      "Direção",
      "Ambiente",
      "Repertório",
      "Posicionamento",
      "Coragem"
    ],
    "required": true
  },
  {
    "id": "q4",
    "text": "Se você sair daqui com uma única resposta, qual gostaria que fosse?",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Pensa antes de escrever. Só uma."
  }
]'::jsonb),

(2, 'A Chegada', 'Entrada', null, '[
  {
    "id": "q_main",
    "text": "Você sente que está construindo alguma coisa ou só está seguindo o que parece certo de seguir?",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "O que você faria nos próximos 5 anos se ninguém tivesse opinião sobre isso? Nem família, nem amigos, nem mercado. Ninguém. Só você.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(3, 'A Força que Sustenta', 'Sala', null, '[
  {
    "id": "q_main",
    "text": "Tem uma coisa que você entrega melhor que a maioria do seu ciclo de convívio. Qual é? E não me responde ''eu sou dedicado'', ''sou esforçado''. Isso não diz nada, é o mínimo. Me conta algo concreto: algo que alguém já te falou, ou que você consegue provar.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "A força que te sustenta, ela vem de onde? Talento natural, necessidade da vida, ou teimosia? É importante saber a raiz, é ela que vai dizer se essa força aguenta crescer junto com você.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(4, 'A Fricção Invisível', 'Cozinha', null, '[
  {
    "id": "q_main",
    "text": "Tem alguma decisão que você sabe que precisa tomar há meses, e está empurrando? Pode ser sair de algum lugar. Falar com alguém. Começar alguma coisa. Terminar outra. Me fala qual é.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "O que essa decisão adiada está protegendo? Não é à toa que você não toma. Tem algo que você perde no momento que decidir. Me fala o que é.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(5, 'O Horizonte Visível', 'Varanda', null, '[
  {
    "id": "q_main",
    "text": "Imagina uma construção sua daqui 10 anos. Construção sua mesmo, algo que você irá construir. Pode ser empresa, pode ser marca, pode ser carreira, pode ser o que for. Me descreve ela em 3 frases. O que tem ali que não tem em nenhuma outra? Essa é a pergunta.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "Pra essa construção existir, qual versão sua precisa deixar de existir? Quem você precisa parar de ser? Não é fácil responder, eu sei. Mas responde.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb),

(6, 'A Decisão que Arrisca', 'Suíte', null, '[
  {
    "id": "q_main",
    "text": "Saindo daqui hoje, o que você vai fazer diferente nos próximos 30 dias? Não me dá lista. Me dá UMA coisa. A primeira. A que você sabe que vai fazer.",
    "type": "text",
    "required": true,
    "min_chars": 100,
    "placeholder": "Responde com o que vier à mente. Sem a resposta pronta."
  },
  {
    "id": "q_deep",
    "text": "Pra você não recuar na primeira semana, o que precisa estar no lugar? Pessoas ao seu redor, regra interna, ambiente, compromisso público. O que é que segura você quando o impulso de voltar bater? Porque ele vai bater. Conto com você pra pensar nisso.",
    "type": "text",
    "required": true,
    "min_chars": 80,
    "placeholder": "Vai mais fundo. Pensa antes de escrever."
  }
]'::jsonb)
on conflict (id) do update set
  title = excluded.title,
  ambient_name = excluded.ambient_name,
  description = excluded.description,
  questions = excluded.questions;
