# Ensaio da operação de segunda: 22/10/2026, 17h38 às 17h50

Rodado localmente, contra o código candidato congelado (commit 78f706c, build de produção),
no banco local com as migrations do pacote de domingo (até 027 mais 029, sem 028 e sem 030).
A IA foi o simulador local: **zero chamadas pagas**. Nenhum dado real, nenhum WhatsApp real,
nenhuma conexão com produção.

O que este ensaio **não** prova: a qualidade dos textos (o simulador devolve o mesmo texto
para todos) e o tempo humano de leitura e revisão (quem operou foi o agente, não uma pessoa).

## Cenário principal: 50 fictícios, sem falha (evento ENSAIO50)

| Medição | Resultado |
|---|---|
| Participantes enviados pelo formulário público real | 50 envios, 50 respostas HTTP 200, 50 cadastros distintos |
| Completos no banco (boletim, bloco 1) | 50 com 52/52 respostas obrigatórias; 0 conflitos; 0 erros |
| Processar com a coleta aberta | Recusado na tela ("A coleta deste evento ainda não encerrou..."); 0 jobs, 0 documentos, 0 chamadas |
| Processar depois do prazo | "50 pessoas entraram na fila" |
| Processar de novo, com a fila andando | Continuou 50 jobs, um por pessoa |
| Tempo até 50 de 50 | cerca de 2 min 30 s, em 3 ciclos do painel |
| Documentos | 50, um por participante, 50 links distintos |
| Jobs | 50 concluídos, todos na 1ª tentativa, 0 pendentes |
| Livro de consumo | 50 registros = 50 chamadas ao simulador |
| Painel no fim | "50 de 50 com prognóstico" |

## Revisão e entrega na tela real

- Documento sem revisão: botão Entregar desligado na tela. Direto no banco, mesmo como
  superusuário, a entrega é recusada duas vezes: sem `final_content`, e com `final_content`
  forjado sem aprovação ("conteudo_aprovado_hash nulo").
- Ana: correção de um trecho, salvar; o banco grava a correção e o selo.

### Ataque A: operador cansado

- Ana: conferência marcada, cancelar. Bruno aberto em seguida: **conferência desmarcada**,
  Disponibilizar desligado.
- Bruno liberado: a mensagem traz o link **dele** (token conferido no banco).
- "Enviar de novo" no Bruno: abre **desmarcado**, Continuar desligado. Não contorna.

### Ataque C: texto mudado depois da aprovação

- O texto da Ana foi mudado no banco depois de aprovado, por fora da revisão.
- A tela ainda mostrava Entregar ligado (ela não compara o selo), mas ao Disponibilizar o
  banco recusou: "Entrega recusada: o texto deste documento não é o que foi revisado e
  aprovado...". Nenhuma mensagem nem link apareceu; o link da Ana continuou em 404.
- Controle positivo: revisado de novo e salvo, a entrega passou; a página da Ana mostra o
  nome e o texto dela, a do Bruno só o dele.

## Ataque B: falha no meio (evento ENSAIOB, 20 fictícios)

- 3 respostas da IA corrompidas de propósito, e o servidor derrubado logo depois de Processar.
- No momento da queda: 9 concluídos, 9 documentos, 11 na fila (3 com 1 tentativa gasta por
  "Falha ao parsear resposta da IA"), 12 registros de consumo = 12 chamadas. Nada órfão.
- Painel depois de religar: "9 de 20 com prognóstico · 11 em andamento".
- Retomada só pelo painel aberto: **20 de 20**, 20 documentos para 20 pessoas, 20 links
  distintos, **nenhum duplicado**. 23 chamadas = 23 registros de consumo; as 3 pessoas que
  falharam gastaram 2 tentativas cada (teto é 3).

## Correspondência documento e pessoa

Provada pela estrutura (um job por pessoa, documento com o `participant_id` do job, links
distintos, página de cada link mostra a pessoa certa) e numa amostra do pedido à IA: o último
pedido levava as respostas de **uma** pessoa só, a mesma do documento gravado. Não provada pelo
conteúdo: o simulador devolve o mesmo texto para todos e só expõe o último pedido. Fazer isso
exigiria mudar o simulador; fica registrado como limite.

## Achados para decidir (nenhum corrigido durante o ensaio)

1. Cartão do Caderno no painel tem um travessão antes de "nunca preenchido".
2. Ao salvar a revisão, o aviso diz "PDF será regenerado ao entregar", e este evento não tem PDF.
3. O editor diz "fica em negrito no PDF e no site"; também cita PDF.
4. O selo do evento mostra a palavra crua "active", e a seção "Controle de etapas" diz que a
   tela "não sabe ler as etapas deste evento". Para quem opera na segunda, é ruído.
5. A tela de revisão não avisa antes que o texto mudou depois da aprovação; só o banco recusa.

## O que falta medir com uma pessoa

Tempo de abrir e entender, de corrigir um trecho, de salvar e de conferir o destinatário e
copiar a mensagem: cronometrar com quem vai revisar na segunda, em pelo menos 5 documentos,
e só então fazer a conta de capacidade.
