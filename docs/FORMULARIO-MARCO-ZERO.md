# Marco Zero — as 52 perguntas do formulário pré-evento

Gerado do banco, da versão 2 do quiz (`quiz_stages`, `quiz_version = 2`), em 2026-10-22.

**Não reescreva enunciado, alternativa nem escala.** O motor de pontuação casa a resposta com o texto exato da alternativa; mudar uma palavra faz a pergunta deixar de pontuar, em silêncio. Se precisar mudar alguma coisa, mude aqui no sistema primeiro e gere este documento de novo.

## Impressão digital do questionário

```
859d5aeb9bf590ae0fd4fbd1b28b3bb143f5b6fca180ba03ad76a9b6f5169d4b
```

É o SHA-256 das 52 perguntas na ordem canônica, cobrindo enunciado, tipo, obrigatoriedade,
alternativas, escalas e rótulos — tudo que muda o significado de uma resposta.

Serve para uma coisa só, e é a que importa: quando as respostas voltarem do formulário
para o sistema, a importação confere este número. Se alguém reescreveu uma pergunta ou
uma alternativa, os números não batem e a importação **recusa antes de pontuar**, em vez
de pontuar errado em silêncio.

O conteúdo exato que gerou este número está em `docs/questionario-v2-canonico.json`.
Para conferir depois de qualquer mudança no banco, gere os dois de novo.

Configuração do formulário, conforme decidido: respondentes restritos à lista de convidados (nunca "qualquer pessoa com o link"), e-mail verificado, uma resposta por conta, respostas e exportação sob acesso restrito.

| Seção | Perguntas |
|---|---|
| 1. Sobre você | 6 |
| 2. Os 7 Elementos da Vida Plena | 9 |
| 3. Perfil comportamental | 24 |
| 4. Como você reage na prática | 6 |
| 5. Sua preparação para o Marco Zero | 7 |
| **Total** | **52** |


---

## Seção 1 — Sobre você

### 1. Qual é seu nome completo?

*Resposta curta (até 120 caracteres) · **Obrigatória***  
`q1`

### 2. Qual é sua idade?

*Resposta curta (até 3 caracteres) · **Obrigatória***  
`q2`

### 3. Em qual cidade e estado você mora?

*Resposta curta (até 120 caracteres) · **Obrigatória***  
`q3`

### 4. Qual organização, empresa, entidade ou comunidade você representa?

*Resposta curta (até 160 caracteres) · **Obrigatória***  
`q4`

### 5. Qual é seu papel atual nessa organização?

*Resposta curta (até 160 caracteres) · **Obrigatória***  
`q5`

### 6. Em quais ambientes você mais exerce influência ou liderança hoje?

*Parágrafo · **Obrigatória***  
`q6`

---

## Seção 2 — Os 7 Elementos da Vida Plena

### 7. Desenvolvimento intelectual: quanto você está satisfeito com seu aprendizado, seu repertório e o desenvolvimento de suas capacidades?

*Escala linear de 0 a 10 · **Obrigatória***  
`q7`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 8. Saúde e energia: quanto você está satisfeito com sua saúde, sua disposição e o cuidado com seu corpo?

*Escala linear de 0 a 10 · **Obrigatória***  
`q8`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 9. Equilíbrio emocional: quanto você está satisfeito com sua capacidade de compreender suas emoções e lidar com pressões e desafios?

*Escala linear de 0 a 10 · **Obrigatória***  
`q9`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 10. Recursos financeiros: quanto você está satisfeito com sua organização financeira e com os recursos disponíveis para sustentar sua vida e seus projetos?

*Escala linear de 0 a 10 · **Obrigatória***  
`q10`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 11. Contribuição social: quanto você está satisfeito com a contribuição que oferece às pessoas, à sua comunidade e à sociedade?

*Escala linear de 0 a 10 · **Obrigatória***  
`q11`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 12. Realização e propósito: quanto você está satisfeito com o sentido, a direção e a realização que encontra na sua vida?

*Escala linear de 0 a 10 · **Obrigatória***  
`q12`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 13. Hobbies e diversão: quanto você está satisfeito com o espaço que dedica ao lazer, ao descanso e às atividades que fazem você se sentir bem?

*Escala linear de 0 a 10 · **Obrigatória***  
`q13`

- 0 = Totalmente insatisfeito
- 10 = Plenamente satisfeito

### 14. Qual desses sete elementos mais precisa da sua atenção neste momento? Por quê?

*Parágrafo · **Obrigatória***  
`q14`

### 15. Qual mudança concreta nessa área faria mais diferença na sua vida nos próximos 90 dias?

*Parágrafo · **Obrigatória***  
`q15`

---

## Seção 3 — Perfil comportamental

### 16. Consigo definir prioridades quando existem muitas possibilidades.

*Escala linear de 1 a 5 · **Obrigatória***  
`q16`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 17. Costumo conectar as decisões de hoje aos seus efeitos de longo prazo.

*Escala linear de 1 a 5 · **Obrigatória***  
`q17`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 18. Questiono as premissas antes de aceitar a primeira explicação.

*Escala linear de 1 a 5 · **Obrigatória***  
`q18`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 19. Percebo padrões e oportunidades antes que fiquem evidentes para o grupo.

*Escala linear de 1 a 5 · **Obrigatória***  
`q19`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 20. Quando o grupo está sem direção, costumo ajudar a encontrar um caminho.

*Escala linear de 1 a 5 · **Obrigatória***  
`q20`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 21. Consigo tomar decisões mesmo sem ter todas as informações.

*Escala linear de 1 a 5 · **Obrigatória***  
`q21`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 22. Transformo ideias em passos, responsáveis e prazos.

*Escala linear de 1 a 5 · **Obrigatória***  
`q22`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 23. Mantenho o ritmo mesmo quando a motivação inicial diminui.

*Escala linear de 1 a 5 · **Obrigatória***  
`q23`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 24. Costumo concluir o que começo.

*Escala linear de 1 a 5 · **Obrigatória***  
`q24`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 25. Cumpro meus combinados mesmo quando ninguém está cobrando.

*Escala linear de 1 a 5 · **Obrigatória***  
`q25`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 26. Sob pressão, consigo concentrar energia no que precisa ser entregue.

*Escala linear de 1 a 5 · **Obrigatória***  
`q26`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 27. Divido objetivos grandes em ações que podem ser executadas.

*Escala linear de 1 a 5 · **Obrigatória***  
`q27`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 28. Escuto para compreender antes de defender meu ponto de vista.

*Escala linear de 1 a 5 · **Obrigatória***  
`q28`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 29. Adapto minha comunicação a pessoas e contextos diferentes.

*Escala linear de 1 a 5 · **Obrigatória***  
`q29`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 30. Consigo envolver outras pessoas em torno de uma ideia.

*Escala linear de 1 a 5 · **Obrigatória***  
`q30`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 31. Procuro incluir pessoas que ainda não tiveram espaço para falar.

*Escala linear de 1 a 5 · **Obrigatória***  
`q31`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 32. Conecto pessoas que podem gerar valor juntas.

*Escala linear de 1 a 5 · **Obrigatória***  
`q32`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 33. Consigo lidar com divergências preservando a relação.

*Escala linear de 1 a 5 · **Obrigatória***  
`q33`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 34. Preservo meus princípios mesmo quando isso torna uma decisão mais difícil.

*Escala linear de 1 a 5 · **Obrigatória***  
`q34`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 35. Avalio os riscos antes de assumir compromissos importantes.

*Escala linear de 1 a 5 · **Obrigatória***  
`q35`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 36. As pessoas sabem que podem contar comigo.

*Escala linear de 1 a 5 · **Obrigatória***  
`q36`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 37. Procuro preservar a qualidade mesmo quando existe pressão por velocidade.

*Escala linear de 1 a 5 · **Obrigatória***  
`q37`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 38. Considero o impacto das minhas decisões sobre outras pessoas.

*Escala linear de 1 a 5 · **Obrigatória***  
`q38`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

### 39. Costumo me preparar antes de entrar em situações importantes.

*Escala linear de 1 a 5 · **Obrigatória***  
`q39`

- 1 = Discordo totalmente
- 5 = Concordo totalmente

---

## Seção 4 — Como você reage na prática

### 40. Um projeto importante está pouco claro e o prazo está próximo. O que você tende a fazer primeiro?

*Múltipla escolha — uma só · **Obrigatória***  
`q40`

- A. Organizar o problema e definir a prioridade antes de avançar.
- B. Começar pelo próximo passo mais concreto para recuperar o movimento.
- C. Reunir as pessoas envolvidas e alinhar expectativas e compromissos.
- D. Revisar os critérios, os riscos e as responsabilidades.

### 41. Duas pessoas importantes do grupo entram em conflito e o trabalho começa a parar. Qual tende a ser sua reação?

*Múltipla escolha — uma só · **Obrigatória***  
`q41`

- A. Escutar os dois lados e ajudar a reconstruir o diálogo.
- B. Relembrar os acordos e os limites que precisam ser preservados.
- C. Identificar a causa do conflito e propor uma direção comum.
- D. Reorganizar as tarefas para que o trabalho volte a avançar.

### 42. Surge uma oportunidade relevante, mas com riscos e informações incompletas. Qual é seu primeiro movimento?

*Múltipla escolha — uma só · **Obrigatória***  
`q42`

- A. Testar rapidamente uma versão pequena da oportunidade.
- B. Comparar a oportunidade com meus objetivos de longo prazo.
- C. Verificar os riscos e os impactos sobre as pessoas envolvidas.
- D. Conversar com pessoas de confiança e buscar apoio.

### 43. Você percebe que um projeto do grupo está atrasado. O que tende a fazer primeiro?

*Múltipla escolha — uma só · **Obrigatória***  
`q43`

- A. Verificar o que precisa ser preservado para não comprometer a qualidade.
- B. Reorganizar o plano, definir responsáveis e marcar a próxima entrega.
- C. Conversar com o time para recuperar energia e compromisso.
- D. Rever as prioridades e eliminar o que está desviando o foco.

### 44. Uma decisão sua recebe uma crítica pública. Como você tende a reagir primeiro?

*Múltipla escolha — uma só · **Obrigatória***  
`q44`

- A. Identificar o ponto central da crítica e avaliar o que precisa mudar.
- B. Ouvir a pessoa e procurar compreender sua perspectiva.
- C. Assumir o que me cabe e apresentar uma ação concreta.
- D. Verificar os fatos e as responsabilidades antes de responder.

### 45. Depois de uma experiência inspiradora, como você costuma transformar uma intenção em compromisso?

*Múltipla escolha — uma só · **Obrigatória***  
`q45`

- A. Compartilho com alguém e crio uma rede de apoio.
- B. Coloco na agenda, estabeleço um prazo e começo a executar.
- C. Defino critérios e limites para sustentar o compromisso.
- D. Conecto a intenção à minha visão de futuro e escolho uma prioridade.

---

## Seção 5 — Sua preparação para o Marco Zero

### 46. Em três palavras, quem você deseja se tornar nos próximos anos?

*Resposta curta (até 80 caracteres) · **Obrigatória***  
`q46`

### 47. Qual comportamento seu mais ajuda você a avançar? Conte um exemplo.

*Parágrafo · **Obrigatória***  
`q47`

### 48. Qual comportamento seu mais atrapalha seu desenvolvimento? Em quais situações ele aparece?

*Parágrafo · **Obrigatória***  
`q48`

### 49. Qual responsabilidade ou decisão importante você vem adiando?

*Parágrafo · **Obrigatória***  
`q49`

### 50. O que você pode oferecer ao grupo durante e depois do Marco Zero?

*Parágrafo · **Obrigatória***  
`q50`

### 51. O que você precisa encontrar ou receber desse grupo para avançar?

*Parágrafo · **Obrigatória***  
`q51`

### 52. O que precisa acontecer para você sair do Marco Zero sentindo que essa experiência valeu a pena?

*Parágrafo · **Obrigatória***  
`q52`
