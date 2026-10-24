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

Abra no celular e no computador:
**https://fort-inside-6u1fgaw0h-infinityexpertsoficial-2370s-projects.vercel.app/admin/login**

- O preview pede login da **Vercel** antes de abrir: use a conta que enxerga o projeto.
- Depois, entre no app com **senha**. O "link no e-mail" leva para o app publicado, não para
  o preview.
- O preview usa **o mesmo banco** do app publicado (conferido esta noite). Olhe, mas **não
  aperte Gerar, Enviar nem Tirar do ar** lá.
- **Só olhe o preview antes de qualquer Gerar.** Hoje a fila está vazia e abrir o painel não
  dispara nada (docs/AUDITORIA-DO-PREVIEW.md). Com a fila andando, o painel do preview
  passaria a empurrar o processador com o código do preview.

O que conferir:

- O painel do Marco Zero mostra **4 passos**: Coleta, Testar a IA, Gerar, Revisar e enviar.
- Cada passo diz se está **Feito**, **Agora**, **Depois** ou **Atenção**.
- **Materiais do encontro** e **Ferramentas** continuam acessíveis no fim da página.
- **Abrir revisão e envio** leva à fila de revisão, com os filtros no topo.

**Se algo impedir o uso** (botão sumiu, tela quebrada, texto que confunde de verdade): não
autorize. Anote o que viu. Segunda funciona com o painel que já está no ar.

### 4. Decidir a publicação (3 min)

Escolha uma das duas e me diga no chat:

- **"Publica o painel depois das atividades de hoje."** Eu junto no main em janela
  combinada e confiro o app publicado logo em seguida. Se algo quebrar, volto para a
  versão de hoje.
- **"Não publica antes de segunda."** A operação de segunda roda com o painel atual. O
  roteiro OPERACAO-SEGUNDA.md vale para os dois.

---

## Decisões que podem esperar a tarde, mas precisam acontecer antes de segunda

1. **Os 3 cadastros de teste** (você, eu e o Carlos). Eu mostro cada identificador e você
   responde sim ou não para cada um. Sem isso, a geração cria documento para eles.
2. **Administrador substituto:** nome e e-mail de quem entra no painel se você não puder.
3. **Revisores de segunda:** quem lê, ajusta e envia, e em que horário.
4. **Cinco documentos fictícios cronometrados** com quem vai revisar de verdade (o kit está
   em docs/ensaios/REVISAO-CRONOMETRADA.md).
5. **Links de posse:** o link do documento abre para quem tiver o endereço. Você aceita esse
   risco para segunda, ou não.
6. **Conferir as respostas antes de gerar** (condição 8 da folha abaixo): cole docs/aplicar/conferencia-das-respostas.sql
   no editor SQL do Supabase e rode. Não grava nada. Esperado: "pessoas_com_problema" igual
   a 0. Cada linha de problema é um documento que falharia na segunda; me mande a saída.

---

## Liberação da operação de segunda (GO / NO-GO)

Marque só com evidência na mão. Se a conferência das respostas achar problema: não corrija a
resposta, não troque por zero e não tire a pessoa em silêncio. Me mande a saída. Caixa marcada não é autorização: o GO é você dizendo "pode
gerar" depois de olhar esta folha inteira.

| # | Condição | Evidência | Situação |
|---|---|---|---|
| 1 | Administrador titular entrou no painel publicado | Print do painel aberto | [ ] |
| 2 | Administrador substituto confirmado e entrou uma vez | Nome, e-mail, print | [ ] |
| 3 | A IA respondeu no ambiente publicado | Texto "A IA respondeu ... api.anthropic.com" | [ ] |
| 4 | Os 3 cadastros de teste resolvidos | Sim/não por identificador, e o boletim depois | [ ] |
| 5 | Revisores e responsáveis definidos | Quadro de funções do OPERACAO-SEGUNDA.md preenchido | [ ] |
| 6 | Jornada fictícia aprovada no ambiente publicado | Um documento fictício gerado, revisado e liberado | [ ] |
| 7 | Entrega por link de posse aceita por você | Sua resposta no chat | [ ] |
| 8 | Respostas de quem vai ser gerado conferidas (docs/aplicar/conferencia-das-respostas.sql), depois de decidir os 3 testes e antes de Gerar | "pessoas_com_problema" = 0. Consulta que falhou não é zero | [ ] |

**Pendências: 8.** Com qualquer item aberto, a resposta é **NO-GO**: não gere os
direcionamentos reais.

Um "quase pronto" numa manhã corrida não é autorização para gerar.

---

## Regras da revisão de segunda

Por que existem: com dois operadores no mesmo documento, o segundo pode apagar a edição do
primeiro sem aviso (reproduzido esta noite, docs/AUDITORIA-DO-PREVIEW.md).

- Cada documento tem **um** revisor responsável por vez.
- Ninguém abre o mesmo documento em duas abas, nem dois operadores ao mesmo tempo.
- Ninguém mexe em conteúdo direto no banco durante a operação.
- **Recarregue a página antes de abrir um documento e antes de enviar**, e confira que o texto
  é o que você aprovou. Divergência: pare, revise de novo e salve.
