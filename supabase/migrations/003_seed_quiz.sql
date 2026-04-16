-- Fort Inside — seed das 5 etapas do quiz

insert into quiz_stages (id, title, ambient_name, description, questions) values

(1, 'Seu ponto de partida', 'Entrada / Recepção', 'O que te trouxe até aqui e onde você está hoje.', '[
  {
    "id": "q1",
    "type": "select",
    "text": "Hoje, em que momento da sua jornada você sente que está?",
    "options": [
      "Início de construção",
      "Fase de exploração",
      "Busca por direção",
      "Aceleração inicial",
      "Transição para um novo nível"
    ]
  },
  {
    "id": "q2",
    "type": "select",
    "text": "O que mais te trouxe até aqui hoje?",
    "options": [
      "Interesse pelo mercado imobiliário",
      "Clareza de carreira",
      "Aproximação com o ecossistema",
      "Desenvolvimento e visão",
      "Curiosidade sobre investimentos",
      "Outro"
    ]
  },
  {
    "id": "q3",
    "type": "select",
    "text": "O que você sente que mais precisa neste momento?",
    "options": [
      "Clareza",
      "Direção",
      "Ambiente",
      "Repertório",
      "Posicionamento",
      "Coragem de avançar"
    ]
  },
  {
    "id": "q4",
    "type": "text",
    "text": "Se você sair daqui com uma única resposta, qual gostaria que fosse?"
  }
]'::jsonb),

(2, 'Sua visão atual', 'Sala Principal', 'Como você enxerga sua trajetória e o que está construindo.', '[
  {
    "id": "q1",
    "type": "select",
    "text": "Hoje, você sente que está construindo sua trajetória com intenção ou apenas reagindo ao que aparece?",
    "options": [
      "Totalmente com intenção",
      "Mais com intenção do que reação",
      "Mais reagindo do que construindo",
      "Ainda sem clareza"
    ]
  },
  {
    "id": "q2",
    "type": "select",
    "text": "Você tem clareza de onde quer estar nos próximos 3 anos?",
    "options": [
      "Muito clara",
      "Parcialmente clara",
      "Pouco clara",
      "Ainda não sei"
    ]
  },
  {
    "id": "q3",
    "type": "text",
    "text": "O que mais falta hoje para sua construção ganhar força?"
  },
  {
    "id": "q4",
    "type": "text",
    "text": "Em que área da sua vida ou carreira você sente que está abaixo da ambição que carrega?"
  }
]'::jsonb),

(3, 'Seu posicionamento e construção', 'Cozinha / Gourmet', 'Como você se posiciona e o que te impede de crescer.', '[
  {
    "id": "q1",
    "type": "select",
    "text": "Hoje, como você avalia seu nível de posicionamento?",
    "options": [
      "Ainda muito inicial",
      "Em construção",
      "Já tenho alguma base",
      "Estou começando a me diferenciar"
    ]
  },
  {
    "id": "q2",
    "type": "text",
    "text": "Qual é sua principal força hoje?"
  },
  {
    "id": "q3",
    "type": "text",
    "text": "Qual é seu principal gargalo hoje?"
  },
  {
    "id": "q4",
    "type": "select",
    "text": "O que mais te impede de crescer no ritmo que gostaria?",
    "options": [
      "Falta de direção",
      "Falta de ambiente",
      "Falta de repertório",
      "Insegurança",
      "Falta de disciplina",
      "Pouca vivência prática"
    ]
  }
]'::jsonb),

(4, 'Seu ecossistema e sua alavanca', 'Varanda / Área Externa', 'O ambiente que você vive e o que precisa mudar.', '[
  {
    "id": "q1",
    "type": "select",
    "text": "O ambiente atual em que você está te aproxima ou te afasta do futuro que deseja?",
    "options": [
      "Me aproxima claramente",
      "Me ajuda parcialmente",
      "Me limita mais do que ajuda",
      "Ainda não sei avaliar"
    ]
  },
  {
    "id": "q2",
    "type": "text",
    "text": "Quem você precisa se tornar para operar em outro nível?"
  },
  {
    "id": "q3",
    "type": "text",
    "text": "De que tipo de ambiente você sente falta hoje?"
  },
  {
    "id": "q4",
    "type": "text",
    "text": "O que você precisa parar de adiar imediatamente?"
  }
]'::jsonb),

(5, 'Sua direção', 'Suíte / Escritório', 'O que você vai fazer com tudo que descobriu aqui.', '[
  {
    "id": "q1",
    "type": "text",
    "text": "Qual é o principal movimento que você precisa fazer nos próximos 30 dias?"
  },
  {
    "id": "q2",
    "type": "text",
    "text": "Qual risco você corre se continuar como está?"
  },
  {
    "id": "q3",
    "type": "select",
    "text": "Em qual trilha você sente que deveria caminhar agora?",
    "options": [
      "Exploração",
      "Direção",
      "Aproximação",
      "Aceleração",
      "Sessão privada"
    ]
  },
  {
    "id": "q4",
    "type": "text",
    "text": "O que você gostaria que eu percebesse sobre você ao ler sua jornada?"
  }
]'::jsonb);
