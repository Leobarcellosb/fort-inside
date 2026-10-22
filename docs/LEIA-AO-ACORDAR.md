# Leia ao acordar — 23 de outubro

Duas coisas têm prazo **hoje ou amanhã**, e nenhuma das duas é código.

---

## 1. A gráfica fecha e falta conteúdo para dois materiais

O roteiro oficial do evento tem uma lista chamada **"Produzir até sexta, 23/10"**. Dois
itens dela **não têm conteúdo escrito em lugar nenhum**:

| Material | O que falta | De quem |
|---|---|---|
| **50 Murais do Futuro** impressos | as instruções e o conteúdo da folha | Carlos (envia ao Yuri e à Malu) |
| **Pacto** em tamanho grande para assinatura | o texto do pacto e o formato da assinatura | Yuri e Carlos |

Não é possível imprimir 50 folhas de um material cujo conteúdo ninguém escreveu. Se
isso não sair hoje, sábado acontece sem o Mural — e o Mural é a entrada do
direcionamento individual prometido para segunda.

Eu **não escrevi** esses conteúdos de propósito: formular o Mural e o pacto é
planejamento pedagógico, não é meu. O que eu fiz foi deixar a falta nomeada, com
responsável, dentro do Caderno de Condução.

## 2. O Forms pré-evento deveria sair hoje, e o e-mail continua travado

O próprio roteiro oficial diz: **"Quinta 22 ou sexta 23: Forms pré-evento, enviado entre
48h e 24h antes, respostas até sexta — Carlos e Léo montam, Malu valida e envia."**

O app está no ar e funciona: **https://fort-inside.vercel.app/join/MARCOZERO**

O que não funciona é a entrega do código de acesso por e-mail, e a causa é uma só, já
descrita abaixo. Sem ela, ninguém entra.

---

## O bloqueio do e-mail, inalterado

O Supabase manda **2 e-mails por hora** no plano free, e o campo é **desabilitado**. Com
SMTP próprio sobe para **30/hora**, que cobre os 50 com folga. E só com SMTP próprio dá
para **editar o template** — sem ele o Supabase manda link em vez de código, que foi o
que você recebeu no teste. Os dois sintomas têm a mesma causa.

**Plano A — verificar um domínio seu no Resend.** Resend → Domains → Add domain → copiar
os registros DNS → colar no provedor do domínio. Depois disso eu termino em minutos.

**Plano B — SMTP de conta institucional** (Google Workspace, com senha de aplicativo).
O CTO foi explícito: conta institucional autorizada, **não** conta pessoal improvisada.

| Campo | Valor |
|---|---|
| Servidor | `smtp.gmail.com` |
| Porta | 465 (SSL) ou 587 (STARTTLS) |
| Usuário | o e-mail da conta autorizada |
| Senha | **senha de aplicativo**, não a senha normal |

**NO-GO do CTO:** se nenhum funcionar, **não** trocar o código por e-mail digitado, link
compartilhável ou autenticação simulada.

---

## O que ficou pronto esta noite

**Caderno de Condução** — o roteiro operacional do sábado, que não existia. Montado do
roteiro oficial do site, com **proveniência item por item**: 44 itens `[OFICIAL]` com a
fonte ao lado, 21 `[OPERAÇÃO]` (conferência de material, guarda, digitalização, o que
fazer sem internet) e **18 `[FALTA]`** nomeadas com responsável. Imprime, funciona sem
internet, e tem versão e hash para se saber depois qual versão estava na mão de quem
conduziu. O Yuri consegue conduzir o dia inteiro com **zero respostas digitais**.

As 18 lacunas são a lista de cobrança antes de sábado. As duas da gráfica estão nela.

**Guia de Preparação do Facilitador** — agora com caminho para pedir (rota e botão no
painel); antes o gerador existia e ninguém conseguia produzir o documento.

**Importação de respostas de fora** — a tela de resolver pendências e conflitos de
identidade, que antes exigia SQL na mão. E uma correção de integridade: a importação
decidia fora da transação e gravava dentro dela, então se alguém respondesse pelo app
nesse intervalo, **a resposta dele era sobrescrita em silêncio**. Agora o banco recusa.

**Dois defeitos que eu achei medindo, não lendo relatório:**
- o gate de 30 respostas aprovava publicação com até 20 participantes contados
  diferente pelo banco e pelo gerador, sem ruído nenhum;
- o piso de privacidade e a supressão de células pequenas são **a mesma constante** hoje,
  fazendo dois trabalhos diferentes. Separar é decisão de metodologia, não minha.

---

## Duas dívidas que eu declaro

1. **Nenhuma tela foi vista em navegador.** Importação, decisões de identidade, Caderno e
   Guia estão cobertos por teste de lógica contra as rotas de verdade e por Postgres real,
   mas layout e interação precisam de olho humano antes de sábado. Vale abrir o
   `.html` do Caderno e dar Ctrl+P uma vez.

2. **O DNA Coletivo não sai para este evento.** Faltam três peças: não há código que o
   gere a partir do banco, não há caminho para publicá-lo, e não há onde o banco guarde
   o estado de publicação. O Guia é o que existe, e ele é suficiente para conduzir.
