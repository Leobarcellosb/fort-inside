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

## O risco número um: a segunda-feira trava em silêncio

**Se o código for para o ar sem a alteração 025, os 50 documentos não são entregues. Nenhum.**

Não é um erro visível. É pior: na tela de revisão, o botão "Entregar" aparece desligado nos
50 cartões, com a frase *"Este documento ainda não tem revisão salva. Abra em Editar, revise
o texto e salve: a entrega é liberada em seguida."*

**Essa frase passa a ser mentira nessa situação.** A pessoa abre, revisa, salva — e o botão
continua desligado. Para sempre, porque o que gravaria a aprovação é justamente a alteração
que não foi aplicada. Não existe nada que ela possa clicar para destravar, e nada na tela
diz o que está acontecendo. Ela fica num laço, seguindo uma instrução que não pode funcionar.

Por isso a regra é simples: **nunca publique o código sem aplicar o banco.** Se for fazer só
uma das duas coisas, faça **só o banco**.

*(Uma versão anterior deste documento dizia que "telas procuram colunas que não existem",
sugerindo um erro alto e visível. Uma auditoria mostrou que não é assim: as telas pedem
todas as colunas de uma vez, então nada estoura — a falha é silenciosa. Corrigido.)*

### E na direção contrária?

Banco novo com código antigo é bem mais seguro, com **uma exceção que eu nomeio**: a
alteração **028** recusa uma operação que o painel antigo faz. Se alguém abrir o painel ao
vivo num evento de cinco etapas e clicar "liberar etapa 6", o banco recusa e o painel antigo
não sabe traduzir a recusa — aparece um erro cru. Está certo recusar (a etapa 6 não existe),
mas é feio no meio de um evento.

---

## As cinco alterações, uma a uma

| | O que faz | Aplicar na véspera? |
|---|---|---|
| **024** | Impede a importação de sobrescrever a resposta de quem respondeu pelo app | **Sim.** Só recusa o que hoje destrói dado |
| **025** | Amarra a aprovação ao texto aprovado | **Sim, e combine o procedimento antes.** Não aplicar é pior: trava a segunda inteira |
| **026** | Guarda o que cada jovem leu e quando | **Sim, mas só depois da 025** — veja abaixo |
| **027** | Permite tirar do ar e corrigir um documento entregue | **Sim, de preferência depois da 026** |
| **028** | Impede gravar etapa que não existe no evento | **Confira o evento primeiro** — é a única com ressalva |

### A ordem não é detalhe: fora de ordem, a 026 quebra tudo

Aplicar a **026 antes da 025** falha no meio — e **deixa estrago**. Ela alcança a criar a
tabela e o gatilho antes de abortar, e aquele gatilho fica vivo e quebrado: a partir daí
**nenhum documento pode ser entregue**, e não se desfaz sozinho — precisa de limpeza manual
no banco.

Então a 026 não é "baixo risco" como este documento dizia antes. O risco dela é **a ordem**,
não o conteúdo. Em ordem crescente, tudo bem.

### Sobre a 028

É a única que eu **não aplicaria sem conferir antes** se o evento de sábado é "ao vivo" e
quantas etapas o questionário dele tem. Se for assíncrono (que é o caso previsto), ela nem
chega a ser exercitada — e aí pode esperar até depois do evento. **É a que sábado menos usa.**

---

## O que eu recomendaria

**Aplicar 024, 025, 026 e 027, em ordem crescente.** Adiar a 028 até alguém confirmar o modo
e a versão do evento real. **Publicar o código só depois disso** — nunca antes.

E, antes da segunda, **combinar com uma pessoa, por escrito, que os 50 documentos serão
abertos e salvos um por um.** É isso que a 025 passa a exigir, e é a diferença entre cumprir
a promessa de revisão humana e ter uma segunda-feira travada.

---

## Uma armadilha que eu encontrei e fechei

O arquivo que documenta como aplicar o banco — `docs/aplicar/marco-zero-banco-completo.sql`
— **vai até a 023 e para ali**. Ele não inclui nenhuma das cinco alterações desta
madrugada, e não tinha marcação nenhuma dizendo até onde ia.

Quem seguisse o procedimento documentado aplicaria aquele arquivo e ficaria **sem as cinco
proteções, acreditando ter aplicado tudo**. Pus um aviso no topo do arquivo listando o que
falta nele e apontando para o caminho certo: aplicar `supabase/migrations/024` a `028`, em
ordem crescente.

Registro como isso apareceu, porque é instrutivo: duas unidades diferentes declararam, como
limitação menor, "não atualizei o arquivo consolidado". Cada declaração estava certa e era
pequena. Somadas ao fato de que aquele arquivo é o caminho documentado, viravam uma
armadilha. Ninguém estava lendo as limitações declaradas **juntas**.

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
conferida por quem tem acesso — e existe ferramenta no próprio projeto para isso
(`scripts/guard-drift.sh`), que compara o banco real contra os arquivos e diz o que falta.
**Vale rodar antes de aplicar qualquer coisa**, porque o registro interno de migrations não
é confiável: no ambiente local ele diz que parou na 018, quando na verdade há coisas da 025
aplicadas.

**4. `npm test` não roda as provas de banco.** Ele mostra 1.363 testes verdes e zero
falhas — mas os 219 "pulados" são justamente **toda a evidência contra Postgres de verdade**.
Elas existem, são boas, e eu rodei várias à mão esta noite. Mas quem rodar só o comando
padrão vê verde e conclui que as garantias de banco estão provadas, quando o que rodou
foram as funções puras.

**5. Uma dívida com prova anexada, que não bloqueia o release.** O livro de registro de
recusas da importação pode ser apagado inteiro em um comando pelo mesmo papel que as telas
de administração usam. Os outros dois livros feitos esta noite estão corretos; esse ficou
fora do padrão da casa. Não impede nada hoje, e precisa ser corrigido depois.

---

## O que continua sem solução, e não é código

- **O e-mail.** Sem ele ninguém entra, e nada do que está acima muda isso.
- **O conteúdo do Mural e do pacto**, que vence na gráfica.
- **Os gabaritos públicos** no site do evento.
- **O agendador de segunda** — sem ele, a fila dos 50 documentos só anda com alguém
  mantendo o painel aberto.
