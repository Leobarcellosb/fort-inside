# Manifesto do pacote de domingo, 25/10

O que entra, o que fica de fora, o que está provado e o que é exceção conhecida. Atualizado
em 22/10. Nenhum item aqui autoriza publicar ou aplicar nada: isso continua dependendo do
preflight real e da autorização do proprietário.

## Entra

- **Migrations 024, 025, 026, 027 e 029**, nesta ordem, depois do preflight. A 029 não
  depende da 028.
- **Código do main** publicado (o que já está no ar).
- **Trava de prazo do formulário**, que ainda **não** está no main. Entra junto, num só
  commit: rota, página, mensagem do Processar e testes. Só depois de o proprietário confirmar
  o estado do evento e escolher o valor de `form_closes_at`.

## Fica de fora

- **Migration 028** (liberação de etapa no banco): não faz parte deste pacote.
- **Migration 030 e o disjuntor da IA**: guardados no ramo `disjuntor-030`. O código
  publicado funciona inteiro sem eles.

## O prazo do formulário

- `form_closes_at` é o **primeiro instante recusado**.
- Recomendado: `2026-10-24 03:00:00+00`, meia-noite em São Paulo. O minuto 23h59 de sexta
  fica aberto.
- Alternativa: `2026-10-24 02:59:00+00` fecha no início do minuto 23h59.
- A escolha é do proprietário. O código é o mesmo nos dois casos.
- Evento assíncrono sem prazo legível recusa envios (HTTP 503) e não diz que o prazo terminou.
- Os estados `completed` e `processing` recusam mesmo dentro do prazo.
- O estado `draft` segue o prazo; se o Marco Zero estiver em `draft`, isso é conferido antes
  de publicar.
- O prazo é decidido uma vez, no recebimento, pelo relógio do servidor. Um envio aceito antes
  do prazo termina de gravar mesmo que a gravação passe do limite.

## Exceções conhecidas

1. **O fluxo antigo com login ainda grava depois do prazo.** Pela política do banco
   (migration 010), quem entrou com login e abriu a etapa até 15 minutos antes do prazo pode
   gravar respostas até 15 minutos depois dele. Para o Marco Zero esse caminho é, na prática,
   inalcançável, porque o código de entrada por e-mail não é entregue. Mas ele não está
   bloqueado por desenho. **O encerramento do formulário público não proíbe toda escrita no
   banco.** Fechar isso exige migration, e não haverá migration nova antes de segunda. O bloco
   7 do boletim conta as gravações feitas depois do prazo.
2. **A tela de revisão não compara o selo antes de ligar o botão Entregar.** Se o texto mudar
   depois da aprovação, quem recusa é o banco, com mensagem clara. O que fazer está em
   OPERACAO-SEGUNDA.md.
3. **O envio do formulário não é uma transação única.** Se uma gravação falha no meio, o
   cadastro pode existir sem respostas e sem conclusão. Isso aparece no boletim como
   "registrados sem conclusão", e o mesmo envio repetido conclui. As respostas de todas as
   etapas são gravadas num único comando: provado em Postgres, um comando de duas linhas com
   uma inválida grava zero. A conclusão só é marcada depois de reler tudo no banco.
4. **A correspondência entre documento e pessoa não foi provada pelo conteúdo** no ensaio,
   porque o simulador devolve o mesmo texto para todos. Ela foi provada pela estrutura e por
   uma amostra do pedido.
5. **O editor de revisão quebra com documento de conteúdo vazio** (só em dado de teste
   antigo). Fica para depois de segunda.

## Testes

- **Comando padrão** (`npx vitest run`): 1562 executados e aprovados, 230 pulados.
- **Pulados, porque exigem banco ou provedor apontado por variável:**
  - cadeia pós-coleta (39);
  - corrida de fechamento (13);
  - erros HTTP (66);
  - canário do prognóstico (12);
  - fila em Postgres (16);
  - duas sessões (9);
  - borda do Guia (12);
  - importação externa, em cinco suítes (63).
- **Executado à parte, sem somar ao comando padrão:** borda do Guia, 12/12, em Postgres
  descartável.
- **Ensaio local da segunda** (docs/ensaios/ENSAIO-SEGUNDA-2026-10-22.md):
  - 50 de 50 documentos;
  - ataques A, B e C;
  - zero chamadas pagas.
  
  Esse ensaio não mede a qualidade do texto nem o tempo humano de revisão.

## Pendente de execução humana

- Preflight do proprietário.
- Valor de `form_closes_at`.
- Estado do evento.
- Publicação da trava e homologação dela no ambiente publicado.
- Teste real da IA.
- Gabaritos públicos.
- Decisão do Mural.
- Quadro de funções.
- Ensaio de sábado.
- Cronometragem da revisão com quem vai revisar.
