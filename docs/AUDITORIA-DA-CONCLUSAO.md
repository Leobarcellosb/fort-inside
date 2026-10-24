# Auditoria: alguém consegue virar "concluído" no Marco Zero por fora do formulário?

Madrugada de 24/10, CTO Rodada 89. Só leitura de código e de configuração; nenhuma tentativa
em produção. As provas de banco vêm do ramo `pos-segunda/prazo-da-010` (contêiner
descartável, 24/24).

## Resposta curta

**Sim, por um caminho, e ele está aberto para fora.**

- A produção **permite cadastro de conta nova** (Authentication, "Allow new users to sign
  up": ligado; "Confirm email": ligado). Conferido no painel do Supabase.
- Com uma conta confirmada, a permissão do banco deixa a pessoa criar um cadastro em
  **qualquer** evento, já com `completed_at` preenchido (achado A1, provado no banco
  descartável).
- Depois do prazo, ela **não consegue** gravar respostas (a etapa só abre até 15 minutos
  antes do prazo). Então o que dá para criar hoje é um "concluído" **sem nenhuma resposta**.
- Na segunda, a geração pega todo mundo com `completed_at`. Esse cadastro entraria na fila.

Nada disso aparece no app: nenhuma tela faz isso. Exige alguém usando a API direto.

## /api/complete-quiz (achado A2)

| Pergunta | Resposta no código |
|---|---|
| Quem chama | Só quem tem sessão; sem sessão, 401 |
| Quem pode concluir | Só o cadastro cujo `user_id` é o da sessão; outro id dá 403, com a mesma mensagem para "não existe" e "é de outro" |
| De onde vem o id | Do corpo, mas a titularidade é conferida pela sessão |
| Confere o prazo | **Não** |
| Confere as respostas | Só que cada etapa do questionário do evento tem uma linha gravada; não confere o conteúdo |
| Para que usa service_role | Para gravar `completed_at`, depois das conferências acima |

Quem respondeu pelo formulário público **não tem** `user_id`, então não usa esta rota. Ela
só alcança cadastro criado por sessão com login. Para concluir depois do prazo por aqui, a
pessoa precisaria ter gravado todas as etapas antes do prazo pelo fluxo com login.

## Proveniência (achado A4)

Uma sessão com login consegue escrever `origem`, `external_submission_id` e `importacao` nas
próprias respostas, dentro da mesma janela em que pode responder. Essas colunas **não são
prova** de onde a resposta veio.

## O que protege a segunda

Nada técnico novo antes de segunda (CTO). A proteção é conferir **antes de Gerar**:

- docs/aplicar/elegibilidade-antes-de-gerar.sql (só leitura, só identificadores) marca, para
  cada concluído do Marco Zero:
  - se tem login;
  - se entrou ou concluiu depois do prazo;
  - quantas das 5 etapas respondeu;
  - se há resposta depois do prazo;
  - a origem das respostas.
- Esperado: nenhum alerta. Testado no banco local: um cadastro plantado com login, concluído e
  sem respostas aparece com "ALERTA com login" e "ALERTA 0 de 5 etapas".
- Limite: o banco não guarda histórico de cada alteração. A consulta não prova quem respondeu
  nem que uma resposta válida não foi trocada por outra válida.

## Decisão que é do dono

**Desligar "Allow new users to sign up"** no Supabase fecha o caminho de fora (contas novas).
O administrador reserva continua possível pelo próprio painel do Supabase ("Add user").
Não mexi: é configuração de produção e a decisão é sua.
