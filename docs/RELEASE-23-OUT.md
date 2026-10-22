# O que você está autorizando — release de 23 de outubro

Dez commits entraram em `main` esta madrugada. **Nada foi para o ar.** O que está rodando
hoje é o código de antes de tudo isso.

Este documento existe para você decidir sabendo o que muda. São **duas autorizações
separadas**, e você pode dar uma sem a outra:

1. **Publicar o código** (push + deploy na Vercel)
2. **Aplicar as cinco alterações de banco** no projeto que serve sábado

A ordem importa, e está no fim.

---

## Tamanho

| | |
|---|---|
| Commits | 10 |
| Arquivos | 86 |
| Linhas acrescentadas | ~23.500 |
| Linhas removidas | 281 |
| Alterações de banco novas | 5 (024 a 028) |
| Testes | 1.363 passando (eram 900) |

Quase tudo é adição. As 281 remoções estão concentradas no painel ao vivo, que era onde
havia código errado a tirar.

---

## O que muda para quem usa

**Para o participante** — nada muda enquanto o e-mail não funcionar: ele continua sem
conseguir entrar. Depois que entrar, a única diferença visível é que um documento tirado
do ar passa a mostrar um aviso escrito para ele, em vez de uma página de erro.

**Para quem revisa e entrega os 50 documentos na segunda** — três mudanças reais:

- **Entregar sem revisar deixou de ser possível.** Antes passava. Agora é preciso abrir,
  revisar e salvar cada um. Mais trabalho, e é a promessa de revisão humana sendo cumprida.
- **Texto alterado depois de aprovado não chega ao participante.** A aprovação passou a
  valer para o texto aprovado, não para o que ocupar o lugar dele.
- **Documento entregue pode ser tirado do ar e corrigido**, o que antes não tinha caminho
  nenhum. O link do participante continua o mesmo.

**Para quem importa respostas de fora** — a tela passa a dizer *por que* um lote foi
recusado, em vez de mostrar uma divergência de números sem explicação. E resolver
pendências de identidade deixou de exigir SQL na mão.

**Para o host no painel do evento** — os nomes das salas da casa do Fort Inside saíram, e
o painel parou de mostrar "0 de 4 responderam" num evento onde todos responderam.

---

## O que pode quebrar, e é o risco número um

**O código e o banco são promovidos em momentos diferentes.** Se o código novo for para o
ar sem as alterações de banco, há telas que procuram colunas que ainda não existem.

Por isso a ordem recomendada é **banco primeiro, código depois** — e se você só quiser
fazer uma das duas coisas, faça **só o banco**, nunca só o código.

O inverso (banco novo com código antigo) é mais seguro: as travas novas recusam operações
que o código antigo não faz de qualquer forma — com uma exceção que está na tabela abaixo.

---

## As cinco alterações de banco, uma a uma

| | O que faz | Risco de aplicar na véspera |
|---|---|---|
| **024** | Impede a importação de sobrescrever a resposta de quem respondeu pelo app | **Baixo.** Só recusa o que hoje destrói dado |
| **025** | Amarra a aprovação ao texto aprovado | **Médio.** Passa a exigir revisão salva antes de entregar — muda o procedimento de segunda |
| **026** | Guarda o que cada jovem leu e quando | **Baixo.** Só grava; não impede nada |
| **027** | Permite tirar do ar e corrigir um documento entregue | **Baixo.** Só acrescenta um caminho que não existia |
| **028** | Impede gravar etapa que não existe no evento | **Baixo.** O caminho normal continua aberto |

A **025** é a única que muda como alguém trabalha. As outras quatro impedem coisas que
ninguém quer fazer.

---

## Três coisas que eu não consegui provar, e declaro

**1. Nenhuma tela nova foi vista em navegador, exceto as que eu olhei.** Eu abri o
aplicativo, entrei como administrador e conferi com o olho a tela de revisão e o painel do
evento. A tela de suspensão e a da decisão de identidade estão cobertas por teste de
lógica, não por olho. **Vale abrir o painel uma vez antes de segunda.**

**2. Os PDFs ficam num lugar que o repositório não controla.** O arquivo do documento vai
para um balde de armazenamento configurado à mão no painel do Supabase — não há migration
que o crie nem que defina quem pode lê-lo. Isso tem três consequências:

- não dá para saber, lendo o código, se esses PDFs são publicamente legíveis;
- se o balde não existir no projeto novo, **clicar em PDF vai falhar na segunda**;
- tirar um documento do ar **não apaga o PDF** que já tenha sido gerado. O arquivo só é
  substituído quando um PDF novo é gerado para o mesmo documento, e isso não é automático.

O endereço do arquivo contém um identificador aleatório, então não é adivinhável — mas é
permanente, e quem já o tiver continua abrindo.

**3. Não consegui medir o banco de produção.** Ele está fora do meu alcance até para
leitura, por uma regra que eu não contornei. A fronteira exata do que falta lá precisa ser
conferida por quem tem acesso.

---

## O que continua sem solução, e não é código

- **O e-mail.** Sem ele ninguém entra, e nada do que está acima muda isso.
- **O conteúdo do Mural e do pacto**, que vence na gráfica.
- **Os gabaritos públicos** no site do evento.
- **O agendador de segunda** — sem ele, a fila dos 50 documentos só anda com alguém
  mantendo o painel aberto.
