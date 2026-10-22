# Leia ao acordar — 23 de outubro

O evento é **sábado 24**. A coleta pré-evento deveria começar **hoje**.

## O app está no ar e funciona

**https://fort-inside.vercel.app/join/MARCOZERO**

| | |
|---|---|
| Banco | `marco-zero`, 22 migrations, 29 tabelas, 52 perguntas, 36 policies |
| Evento | `MARCOZERO`, assíncrono, coleta até sexta 23h59 (Brasília) |
| RLS | verificada contra produção, com controle positivo |
| Código | `c35e327` no GitHub, deploy READY |
| Testes | 900 passando, build exit 0 |

## Uma coisa trava tudo: o e-mail

O participante entra digitando um **código de 6 dígitos** que chega por e-mail.
Hoje esse código **não chega**, e por um motivo só.

O Supabase manda **2 e-mails por hora** no plano free, e o campo é **desabilitado** —
não dá pra aumentar. Com SMTP próprio, sobe para **30/hora**, que cobre os 50 com folga.

Mas SMTP próprio precisa de um remetente que entregue de verdade. E tem uma
consequência a mais: **só com SMTP próprio dá pra editar o template do e-mail**.
Sem ele, o Supabase manda o template padrão, que envia **link em vez de código** —
foi o que você recebeu no teste.

Ou seja, os dois sintomas (não chega código, chega link) têm a mesma causa.

## Os dois caminhos, decididos pelo CTO

**Plano A — verificar um domínio seu no Resend.**
Resend → Domains → Add domain → copiar os registros DNS → colar no provedor do
domínio → aguardar confirmação. Depois disso eu termino a configuração em minutos.

**Plano B — SMTP de conta institucional (Google Workspace).**
Precisa de verificação em duas etapas e uma **senha de aplicativo**. O CTO foi
explícito: conta institucional autorizada, **não** conta pessoal improvisada.

| Campo | Valor |
|---|---|
| Servidor | `smtp.gmail.com` |
| Porta | 465 (SSL) ou 587 (STARTTLS) |
| Usuário | o e-mail da conta autorizada |
| Senha | **senha de aplicativo**, não a senha normal |
| Remetente | a própria conta |

**NO-GO do CTO:** se nenhum funcionar, **não** trocar o código por e-mail digitado,
link compartilhável ou autenticação simulada. Isso é decisão dele, não minha.

## O que eu quase fiz e desfiz

Cheguei a ligar o SMTP com uma conta pessoal do Gmail e preencher quase tudo.
Desfiz quando li a regra do CTO. **O SMTP está desligado e nada foi salvo** — porque
SMTP ligado com senha vazia é pior que não configurar: o Supabase para de usar o
envio nativo e passa a falhar. Trocaria um limite baixo por zero.

## O que você achou e eu não tinha visto

Três URLs apontando para `localhost`: Site URL do Supabase, Redirect URLs (vazio) e
`NEXT_PUBLIC_APP_URL` na Vercel. Já corrigidas.

A pior era o Site URL: ele **também alimenta os templates de e-mail**. Cada um dos 50
receberia um link que só funcionaria na máquina de quem configurou — e ninguém
descobriria antes do primeiro clicar.

Passei o dia caçando essa classe de defeito dentro do código, com teste e mutação.
Estava num painel, do lado de fora, onde eu não olhei.

## Se o e-mail não sair a tempo

O sábado acontece de qualquer jeito: é cartolina, matriz de SWOT e Mural em papel.
O que se perde é o formulário pré-evento e, com ele, a base do direcionamento
individual prometido para segunda.

O CTO foi direto sobre isso: a promessa de segunda **só pode ser confirmada** quando
importação, Mural, revisão e distribuição tiverem procedimento exercitável. Ajustar a
expectativa dos participantes **antes** de assumir o compromisso é decisão sua.

## Duas dívidas que eu declaro

1. **Privilégio em produção verificado por amostragem minha, não pela suíte.** A suíte
   escreve no banco, e a guarda de isolamento recusa alvo compartilhado — corretamente.
   O schema está conferido; o privilégio está verificado por amostra.

2. **A jornada completa não foi feita em produção.** Não consigo receber o código de
   entrada, que é justamente o que está bloqueado.
