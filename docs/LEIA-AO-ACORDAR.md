# Leia ao acordar: sábado, 24/10

Uma página. Quinze minutos. Ao final dela, você terá decidido o que vai ao ar e saberá se a
IA responde. Nada aqui gera documento de verdade nem fala com participante.

Este é um roteiro proposto, não algo que já foi feito. Cada passo diz o que você deve ver e
o que fazer se aparecer outra coisa.

---

## Os primeiros 15 minutos

### 1. Entrar no painel publicado (3 min)

1. Abra **https://marcozero-gp.vercel.app/admin/login** e entre com o seu e-mail (senha ou
   "Entrar com link no e-mail").
2. Abra **Eventos** e depois o Marco Zero.

**Esperado:** você entra, vê a lista de eventos e o painel do Marco Zero abre.

**Se der diferente:** não tente trocar papel nem senha às cegas. Anote a mensagem exata da
tela (ou tire um print) e pare aqui. É a primeira coisa a resolver, porque sem ela nada de
segunda acontece.

### 1b. Fechar o cadastro de conta nova: FEITO (24/10 08h53)

"Allow new users to sign up" desligado e salvo; conferido de novo depois de recarregar a
página. Contas existentes: só uma (a do Leonardo, criada em 22/10); nenhuma desconhecida. O
"10 users (estimated)" do Supabase é estimativa do banco, não contagem.

Isso desliga a entrada antiga por código no e-mail (/join), que o Marco Zero não usa. Religar
não é automático: antes, os achados A1, A2 e A4 precisam ser corrigidos ou aceitos
(docs/AUDITORIA-DA-CONCLUSAO.md).

### 2. Testar a IA (2 min)

1. No painel do Marco Zero, procure o quadro **"Teste da IA antes de processar"**.
2. Clique em **Testar a IA** e depois em **Sim, testar**. É uma chamada real, com dados
   fictícios. Custa centavos e não grava nada.

**Esperado:** "A IA respondeu. Modelo ..., servidor api.anthropic.com, em ... s."

**Se der diferente:** a própria tela diz a causa (chave recusada, sem crédito, limite,
instabilidade). Não processe nada. Se for crédito ou chave, isso é com quem paga a conta da
IA: resolva e teste de novo. Esse é o maior risco de segunda, e é por isso que vem antes do
resto.

### 3. Olhar o painel novo, no preview (7 min)

O preview usa **o mesmo banco** do app publicado (conferido esta noite). Olhar é seguro só
enquanto a fila estiver vazia (docs/AUDITORIA-DO-PREVIEW.md). Por isso, um protocolo curto
(CTO, Rodada 88):

1. **Antes de abrir:** cole docs/aplicar/fila-vazia.sql no editor SQL do Supabase e rode.
   Precisa dar nenhum job "pending" nem "running" e nenhum evento "processing". Se der,
   **não abra o preview**: eu mando capturas de tela.
2. Ninguém gera, revisa ou mexe em documento enquanto você olha.
3. Abra **https://fort-inside-6u1fgaw0h-infinityexpertsoficial-2370s-projects.vercel.app/admin/login**
   (é o commit 85ddb16, conferido pelo registro de deploy do GitHub). Ele pede login da
   **Vercel** antes; depois, entre no app com **senha** (o link no e-mail leva para o app
   publicado).
4. **Pode:** entrar, navegar pelos quatro passos, abrir as seções, ver no celular e no
   computador, abrir a revisão.
5. **Não pode:** Gerar, Reprocessar, Salvar, Enviar, Disponibilizar, Tirar do ar,
   Regularizar ou **Testar a IA** (o teste da IA é no app publicado, passo 2).
6. Se, enquanto você olha, alguém começar a gerar: **feche o preview na hora.**
7. **Ao terminar:** feche **todas** as abas do preview (não basta trocar de página) e rode
   fila-vazia.sql de novo. Deve dar as mesmas contagens, e nada em "mudou na última hora" que
   você não tenha feito pelo app publicado.

O que conferir:

- O painel do Marco Zero mostra **4 passos**: Coleta, Testar a IA, Gerar, Revisar e enviar.
- Cada passo diz se está **Feito**, **Agora**, **Depois** ou **Atenção**.
- **Materiais do encontro** e **Ferramentas** continuam acessíveis no fim da página.
- **Abrir revisão e envio** leva à fila de revisão, com os filtros no topo.

**Se algo impedir o uso** (botão sumiu, tela quebrada, texto que confunde de verdade): não
autorize. Anote o que viu. Segunda funciona com o painel que já está no ar.

O preview **nunca** fica aberto durante a operação de segunda.

### 4. Decidir a publicação (3 min)

Escolha uma das duas e me diga no chat:

- **"Publica o painel depois das atividades de hoje."** Eu junto no main em janela
  combinada e confiro o app publicado logo em seguida. Se algo quebrar, volto para a
  versão de hoje.
- **"Não publica antes de segunda."** A operação de segunda roda com o painel atual. O
  roteiro OPERACAO-SEGUNDA.md vale para os dois.

---

## Decisões que podem esperar a tarde, mas precisam acontecer antes de segunda

1. **Os 3 cadastros de teste** (você, eu e o Carlos). Rode docs/aplicar/cadastros-de-teste.sql
   no editor SQL do Supabase (só leitura) e responda no chat, para cada linha, "remove <id>"
   ou "mantém <id>". Eu não consegui rodar essa consulta esta noite: ela lê nome e e-mail de
   produção, e a trava de segurança bloqueou, com razão. Sem a sua decisão, a geração cria
   documento para eles.
2. **Administrador substituto:** nome e e-mail de quem entra no painel se você não puder.
3. **Revisores de segunda:** quem lê, ajusta e envia, e em que horário.
4. **Cinco documentos fictícios cronometrados** com quem vai revisar de verdade (o kit está
   em docs/ensaios/REVISAO-CRONOMETRADA.md).
5. **Links de posse:** o link do documento abre para quem tiver o endereço. Você aceita esse
   risco para segunda, ou não.
6. **Conferir as respostas e quem vai ser gerado** (condição 8 da folha abaixo). Depois de
   decidir os 3 testes e antes de Gerar, rode no editor SQL do Supabase (nenhuma grava nada):
   - docs/aplicar/conferencia-das-respostas.sql: esperado "pessoas_com_problema" igual a 0.
   - docs/aplicar/elegibilidade-antes-de-gerar.sql: esperado nenhum "ALERTA".
   
   Me mande as duas saídas.

---

## Liberação da operação de segunda (GO / NO-GO)

Marque só com evidência na mão. Se a conferência das respostas achar problema: não corrija a
resposta, não troque por zero e não tire a pessoa em silêncio. Me mande a saída. Caixa marcada não é autorização: o GO é você dizendo "pode
gerar" depois de olhar esta folha inteira.

| # | Condição | Evidência | Situação |
|---|---|---|---|
| 1 | Administrador titular entrou no painel publicado | Feito em 24/10 09h03: painel do Marco Zero aberto com a sessão do Leonardo (usada no teste da IA) | [x] |
| 2 | Administrador substituto confirmado e entrou uma vez | Nome, e-mail, print | [ ] |
| 3 | A IA respondeu no ambiente publicado | Feito em 24/10 08h50: "A IA respondeu. Modelo claude-opus-5, servidor api.anthropic.com, em 0.9 s." Repetir na segunda antes de Gerar | [x] |
| 4 | Os 3 cadastros de teste resolvidos | Feito em 24/10 09h03: Leonardo Borges e Teste Claude removidos (2 cadastros, 10 respostas, uma transação, auditoria em event_logs "remocao_cadastro_de_teste"); Carlos Vieira mantido por decisão do Leonardo. Restam 34 concluídos | [x] |
| 5 | Revisores e responsáveis definidos | Quadro de funções do OPERACAO-SEGUNDA.md preenchido | [ ] |
| 6 | Jornada fictícia aprovada no ambiente publicado | Um documento fictício gerado, revisado e liberado | [ ] |
| 7 | Entrega por link de posse aceita por você | Sua resposta no chat | [ ] |
| 8 | Respostas e elegibilidade conferidas (conferencia-das-respostas.sql e elegibilidade-antes-de-gerar.sql), depois de decidir os 3 testes e antes de Gerar | Rodado em 24/10 09h03: 34 conferidos, 0 problemas; 34 concluídos, nenhum ALERTA, todas as respostas do app. Rodar de novo na segunda, logo antes de Gerar | [x] |

**Pendências: 4** (2 admin substituto, 5 revisores, 6 jornada fictícia hospedada, 7 link de posse). Com qualquer item aberto, a resposta é **NO-GO**: não gere os
direcionamentos reais.

Um "quase pronto" numa manhã corrida não é autorização para gerar.

---

## Regras da revisão de segunda

Por que existem: com dois operadores no mesmo documento, o segundo pode apagar a edição do
primeiro sem aviso (reproduzido esta noite, docs/AUDITORIA-DO-PREVIEW.md).

- **Divisão nominal antes de começar:** cada participante tem um revisor, sem sobreposição.
  Preencha antes das 9h:

  | Revisor | Participantes (nome ou faixa alfabética) |
  |---|---|
  | | |
  | | |

  Sem garantir essa divisão, não ponha vários revisores na mesma lista ao mesmo tempo.
- Cada documento tem **um** revisor responsável por vez.
- Ninguém abre o mesmo documento em duas abas, nem dois operadores ao mesmo tempo.
- Ninguém mexe em conteúdo direto no banco durante a operação.
- **Recarregue a página antes de abrir um documento e antes de enviar**, e confira que o texto
  é o que você aprovou. Divergência: pare, revise de novo e salve.
