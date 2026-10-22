# Fila de jobs (geração de prognóstico)

Camada de execução sobre a migration `018_fila_jobs.sql`. Existe para que a
geração dos prognósticos deixe de depender da sobrevivência de **uma** requisição
HTTP de cinco minutos.

Ela fica **ao lado** de `app/api/batch-process/route.ts`, que continua existindo e
não foi alterado. Nada no app usa a fila automaticamente ainda; ver
[Caminho de migração](#caminho-de-migração).

---

## O problema que isto resolve

`/api/batch-process` gera tudo dentro de uma requisição, em ondas de 10, com
`maxDuration = 300`. O comentário do próprio arquivo declara o alvo: *"com ~63s
por prognóstico, 10 por onda entrega 20 participantes em ~2 min"*. Foi
dimensionado para 20.

Com 50 participantes são 5 ondas de geração (~315s, já acima do teto) e depois 5
ondas de PDF, na mesma requisição. E 63s é a mediana de **uma** medição: como a
onda dura o tempo do mais lento dela, 315s é otimista.

Pior que a lentidão é o modo de falha. O evento recebe `processing` na primeira
linha e `completed` na última. Cortada no meio: alguns prognósticos ficam
gravados, outros não existem, a resposta nunca chega, o evento fica preso em
`processing` para sempre e o log morre junto com a função — não sobra registro de
quem falhou. **Já aconteceu em produção**: existe um evento de teste preso em
`processing` que a interface não consegue apagar.

---

## Dois estados diferentes, que não se misturam

| | estado do **documento** | estado do **job** |
|---|---|---|
| onde vive | `prognostics.status` (migration 015) | `jobs.status` (migration 018) |
| valores | `pending → generating → generated → in_review → reviewed → delivered` | `pending`, `running`, `succeeded`, `failed`, `skipped`, `canceled` |
| regride? | **nunca** (gatilho no banco recusa, inclusive para `service_role`) | **o tempo todo** (`running → pending` quando a tentativa falha e sobra retentativa) |
| quem escreve | `generatePrognostic`, painel do admin | as funções `jobs_*`, chamadas pelo worker |

Confundir os dois é o erro clássico aqui: "a tentativa falhou" não é "o documento
voltou atrás". São máquinas separadas, em tabelas separadas, de propósito.

### Máquina de estados do job

```
                         jobs_enfileirar
                                │
                                ▼
          ┌──────────────── pending ◄──────────────┐
          │                     │                  │
          │       jobs_reivindicar (attempts++,    │ jobs_falhar, com tentativa
          │        run_token novo, lease)          │ restante (+ backoff)
          │                     ▼                  │
          │                 running ───────────────┘
          │                  │ │ │
          │                  │ │ └── jobs_falhar, sem tentativa ──► failed
          │                  │ │     jobs_recuperar_expirados,
          │                  │ │     sem tentativa ──────────────► failed
          │                  │ │
          │                  │ └──── jobs_recuperar_expirados,
          │                  │       com tentativa ─────────────► pending
          │                  │
          │                  └────── jobs_concluir ──► succeeded | skipped | canceled
          │
          └── jobs_reenfileirar (manual; exige p_forcar para desfazer sucesso)

      jobs_cancelar: pending | running | failed ──► canceled
```

- **`skipped` não é falha.** É o 409 de `generatePrognostic`: o documento avançou
  para `in_review`/`reviewed`/`delivered` e regerar foi recusado **de propósito**
  pela 015. Contar como falha inflaria o número em todo reprocessamento e
  esconderia as falhas reais. Mesmo tratamento que o lote de hoje dá.
- **`canceled` não é falha.** Não foi o trabalho que falhou, foi a decisão de não
  fazer.
- **`attempts` incrementa na reivindicação, não no desfecho.** É o que torna o
  contador honesto: uma tentativa que morreu sem gravar nada continua aparecendo.
  Como toda tentativa de `prognostico` chama o modelo, `attempts` é também o
  **piso de chamadas de IA potencialmente cobradas** para aquele participante.

---

## Como a reivindicação é exclusiva

Três camadas, dentro de `jobs_reivindicar` (todas no banco, Postgres puro, sem
extensão):

1. **`pg_advisory_xact_lock` por `kind`** — serializa a janela em que as vagas
   globais são contadas e consumidas. Sem ele, dois workers leriam "0 em
   execução" ao mesmo tempo e cada um levaria o teto inteiro. O lock morre no
   commit, no rollback e na queda da conexão: não existe destravamento manual.
2. **`for update skip locked`** na seleção dos candidatos.
3. **O próprio `UPDATE` só casa linhas em `pending`** (ou `running` com lease
   vencido): depois dele, o estado da linha já exclui o concorrente.

`p_concorrencia_max` é **teto global de jobs com lease vivo**, não teto por
processo. Por isso ticks sobrepostos **somam** para o mesmo teto em vez de
multiplicá-lo — medido de duas formas: 8 reivindicadores simultâneos pedindo 5
cada (teto 3, 20 pendentes) levam **3**; e dois ticks de verdade sobrepostos no
tempo, cada um com seu pool de 3 vagas, mantêm **no máximo 3 jobs com lease
vivo** em 207 amostras do banco — nunca 6.

**O que esse teto NÃO é.** Ele limita *lease vivo*, e por isso é uma garantia de
controle do banco — **não** um limite absoluto de chamadas ao modelo. Se um lease
vence no meio do trabalho, o banco libera a vaga e outro worker começa enquanto o
antigo **ainda está rodando**. Medido: 3 leases vivos, **4** trabalhos em
execução. O fencing descarta o resultado do antigo; os tokens que ele gastou, não.
Quem fecha esse buraco são as quatro medidas de
[Limite real de chamadas ao modelo](#limite-real-de-chamadas-ao-modelo).

### Lease + token de execução (fencing)

Reivindicar grava `lease_expires_at` e um `run_token` **novo, gerado pelo banco**.
O worker renova o lease enquanto trabalha (a cada 1/3 do lease). Se a função for
cortada, o lease vence e outro worker reivindica — com um `run_token` novo.

Quando o worker antigo volta do limbo, todo `UPDATE` dele exige
`run_token = <o token dele>`. O token mudou, nenhuma linha casa, e o resultado
velho é **descartado** em vez de sobrescrever o da tentativa mais recente.
`jobs_concluir`, `jobs_falhar` e `jobs_renovar_lease` devolvem `false`/`aplicado
= false` nesse caso, e o worker **registra que foi descartado** em vez de achar
que gravou (`RelatorioJob.descartado`).

---

## Acionamento do worker

A rota é **`/api/jobs/tick`** (`GET` e `POST` fazem o mesmo). Cada chamada é
independente e idempotente: **não existe "a requisição que precisa sobreviver"**.

Um tick:

1. chama `jobs_recuperar_expirados` — retoma o que ficou para trás;
2. reivindica e executa em **pool rolante** de `JOBS_CONCURRENCY` vagas (cada
   vaga pega o próximo job assim que termina o anterior, então um prognóstico
   lento não segura os outros — diferente das ondas do lote atual);
3. **para de reivindicar** quando acaba o orçamento de tempo (240s), o teto de
   jobs por tick, ou a fila — note que o orçamento limita o *início* de novos
   jobs, não interrompe os que já estão em voo; um job que passe do teto da
   função é cortado e recuperado pelo lease, ao custo de uma tentativa;
4. varre os eventos em `processing` e chama `jobs_fechar_evento_se_concluido` em
   cada um.

**A decisão: um agendador burro, batendo na rota de minuto em minuto.**

- Não uma requisição longa que processa tudo: com 50 participantes, concorrência
  3 e ~63s por prognóstico, o trabalho passa de 15 minutos. Não cabe em
  **nenhum** teto de função. Tem de ser fatiado, e a fatia tem de poder morrer.
- Não auto-chamada em cadeia (o tick chamando o próximo): a cadeia quebra no
  primeiro elo que falhar e ninguém a reinicia. O cron é burro, e é por isso que
  é confiável.
- O fechamento do evento é varredura, não "a última linha da requisição":
  **qualquer** tick fecha **qualquer** evento já concluído. É o que mata o estado
  indefinido.

Além do cron, `/api/jobs/enfileirar` dá um **empurrão imediato** (um tick via
`after()` do Next, depois da resposta) para a operação não esperar o próximo
minuto. Isso é otimização, não garantia: se a invocação morrer, o cron assume.

### Estado de hoje: a fila anda pela TELA, e isso é visível

O cron **não está configurado**. O painel do admin empurra `/api/jobs/tick` a
cada 45s enquanto está aberto, então hoje **a fila só progride enquanto alguém
mantém a página aberta** — feche o navegador e o trabalho pendente para onde
está (não se perde: fica `pending` com estado gravado, e o próximo tick, de
qualquer origem, continua).

Esse estado foi aceito, **mas não pode ficar invisível**: é exatamente o que o
indicador 1 e a regra de alerta abaixo expõem. Com a página fechada e trabalho
pendente, `/api/jobs/saude` acende `alerta.ativo` em até
`JOBS_ALERT_NO_PROGRESS_SECONDS`. Duas consequências práticas:

- o limiar precisa ser **maior que 45s** (o padrão de 180s dá folga de quatro
  empurrões perdidos antes de alertar);
- enquanto o cron não existir, o alerta aceso significa "ninguém está com o
  painel aberto", e não necessariamente "o sistema quebrou". Quando o cron
  entrar, passa a significar "o agendador não está executando".

### O que precisa ser configurado na Vercel — NÃO configurado por mim

Nada disto foi aplicado: a unidade não configura produção.

1. **`vercel.json` na raiz** (o arquivo não existe hoje):

   ```json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "crons": [{ "path": "/api/jobs/tick", "schedule": "* * * * *" }]
   }
   ```

   O cron só passa a existir no **próximo deploy de produção**, e só dispara em
   produção. `* * * * *` (de minuto em minuto) depende do plano — confira
   `vercel crons ls` e a página de *usage and pricing* de Cron Jobs antes de
   contar com essa frequência. Em plano que não permita o minuto, a fila
   continua correta, só anda mais devagar; e `vercel crons run /api/jobs/tick`
   dispara à mão.

2. **Variável de ambiente `CRON_SECRET`** (Project Settings → Environment
   Variables). O Vercel Cron manda `Authorization: Bearer $CRON_SECRET`, e a rota
   compara em tempo constante. **Sem `CRON_SECRET` configurado, a porta do
   agendador simplesmente não existe** — só admin autenticado aciona. O contrário
   (aceitar qualquer chamada quando o segredo não está configurado)
   transformaria um deploy incompleto em endpoint aberto que gasta Opus.

3. **`JOBS_CONCURRENCY`** (opcional; padrão 3). Mantenha **um valor só por
   ambiente**: o teto efetivo é o que o worker passa na reivindicação, então dois
   deploys divergentes dariam o teto do que reivindicou (limitação 3 da 018).

### Configuração

| variável | padrão | o que é |
|---|---|---|
| `JOBS_CONCURRENCY` | `3` | teto **global** de jobs em execução por `kind` |
| `JOBS_LEASE_SECONDS` | `180` | validade do lease; o heartbeat renova a cada 1/3 |
| `JOBS_BACKOFF_SECONDS` | `30` | espera antes de a tentativa seguinte ficar elegível |
| `JOBS_TICK_BUDGET_MS` | `240000` | quanto um tick trabalha antes de devolver (cabe nos 300s da rota) |
| `JOBS_MAX_PER_TICK` | `12` | teto de jobs por tick, **duro** (reservado antes de reivindicar) |
| `JOBS_MAX_RECOVER_PER_TICK` | `100` | teto de linhas varridas pela recuperação |
| `JOBS_ALERT_NO_PROGRESS_SECONDS` | `180` | limiar do alerta de saúde (os 3 minutos da regra inicial) |
| `JOBS_HEALTH_FAILURE_WINDOW_HOURS` | `24` | janela da contagem de falhas do painel de saúde |
| `JOBS_ATTEMPT_TIMEOUT_MS` | `lease - renovação` (120000) | teto de UMA tentativa; ao estourar, a chamada ao modelo é **abortada** |
| `JOBS_BUDGET_CALLS_PER_TICK` | `JOBS_MAX_PER_TICK` | teto duro de chamadas ao modelo que um tick pode **iniciar** |
| `JOBS_BUDGET_ATTEMPTS_PER_EVENT` | `0` (desligado) | disjuntor: tentativas acumuladas por evento |
| `JOBS_SCHEDULER_INTERVAL_SECONDS` | `60` | intervalo em que se espera que o agendador dispare |

Valor inválido **estoura** no carregamento em vez de virar padrão silencioso: um
teto de concorrência que ninguém escolheu é o tipo de configuração invisível que
esta fila existe para eliminar.

**Sobre a concorrência 3:** é a decisão inicial, para ser calibrada **depois** de
medir (a) o limite de requisições/tokens por minuto da organização na Anthropic,
(b) a distribuição real de latência por prognóstico e (c) a taxa de erro sob
paralelismo. **Até essa medição existir, nenhum prazo de conclusão para 50
participantes pode ser prometido.**

---

---

## Saúde e alerta

```
GET /api/jobs/saude      (admin, ou Authorization: Bearer $CRON_SECRET)
```

Três indicadores, todos lidos do banco — nenhum depende dos logs da Vercel nem
de uma requisição viva:

| # | Indicador | Campo | O que revela |
|---|---|---|---|
| 1 | Último progresso do worker | `ultimoProgressoDoWorker` | se o agendador está realmente executando |
| 2 | Idade do job mais antigo na fila | `jobMaisAntigoNaFila` | se o processamento está progredindo |
| 3 | Expirados, travados e falhos | `recuperacao` | se há necessidade de recuperação |

O indicador 2 mede a idade **desde a criação**, não desde a última tentativa: se
medisse desde a tentativa, o job que mais retenta pareceria o mais novo —
justamente o que não sai do lugar. O indicador 3 separa `expirados` (lease
vencido, esperando retomada) de `emVoo` (lease vivo, trabalho de verdade),
`aguardandoBackoff`, `prontosParaPegar` e `semTentativaRestante`, e conta
`failed` **dentro de uma janela** (padrão 24h): um contador que nunca zera deixa
de ser sinal e vira ruído.

### A regra de alerta

Dispara quando **as três** condições valem (devolvidas separadas em
`alerta.condicoes`, para a regra não ser caixa-preta):

1. existe job pendente;
2. o job mais antigo já espera **mais** que o limiar (carência — nos primeiros
   segundos depois do enfileiramento nenhum worker teve tempo ainda);
3. o worker não dá sinal de progresso dentro do limiar, **ou nunca deu**.

A condição 3 sozinha não serve: 3 jobs em voo renovando lease mantêm o sinal
fresco enquanto 47 esperam, e isso é progresso de verdade. A 2 sozinha também
não: uma fila grande legitimamente leva muito mais que o limiar para escoar. O
alerta é a conjunção — há trabalho, ele está velho, e ninguém está mexendo nele.

"Nunca deu sinal" conta como **alerta**, nunca como silêncio tranquilizador. E
erro de leitura devolve **500 sem números**, nunca indicadores zerados: zero
pendente e zero expirado parecem saúde.

O limiar é `JOBS_ALERT_NO_PROGRESS_SECONDS` (padrão 180s), para ser reavaliado
conforme a frequência efetiva do agendador. Ele **tem de ser maior que**
`JOBS_BACKOFF_SECONDS`, e a configuração estoura se não for: uma fila esperando
legitimamente o backoff não escreve nada no banco, e com limiar abaixo do backoff
todo reprocessamento normal acenderia o alerta.

A rota devolve **200 mesmo em alerta**, com `alerta.ativo` explícito. Um 5xx
faria um monitor confundir "a fila está parada" (dado verdadeiro) com "a rota
está quebrada" (nenhum dado). Monitore por `alerta.ativo`.

### Indicador 1: registrado (019) ao lado do derivado

`saudeDoAgendador` vem do marcador **registrado** por
`supabase/migrations/019_heartbeat_worker.sql` (`jobs_worker_heartbeat`, uma linha
por `kind`, sobrescrita). Quem grava é `jobs_registrar_tick_ok`, chamada na
**última linha** de `rodarTick` — um tick que estoura antes disso nunca a
alcança, e é exatamente essa a diferença entre "a rota foi chamada" e "o tick
teve sucesso".

`veredito` tem **três** estados, porque "não consegui verificar" não é "está tudo
bem":

| veredito | quando | o campo `ultimoTickOkEm` |
|---|---|---|
| `ok` | marcador dentro do limiar | o instante registrado |
| `alerta` | marcador velho, **ou** nenhum tick jamais terminou | o instante, ou `null` |
| `indisponivel` | 019 não aplicada, ou a leitura falhou | **`null`, nunca aproximado** |

**Os dois sinais coexistem, e o derivado continua se declarando derivado.**
Enquanto a 019 não estiver aplicada **e** o cron não estiver configurado, o
painel informa que só tem sinal derivado (`tickRegistrado: false`,
`fonte: "derivado de max(jobs.updated_at)"`,
`registroLiteralEm: "saudeDoAgendador.ultimoTickOkEm"`) e **não apresenta
horário fictício** de último tick bem-sucedido. O campo derivado nunca vira o
campo registrado por aproximação.

Por que os dois: são **propriedades diferentes**, e a primeira não substitui a
segunda.

- **Saúde do processamento** (derivado de `jobs`): há trabalho avançando.
- **Saúde do agendador** (019): o cron executou, o handler **concluiu**, e novas
  execuções continuam chegando no intervalo esperado (`ticksOk` é monotônico, e
  `disparosEsperadosPerdidos` traduz a idade do marcador em disparos de
  `JOBS_SCHEDULER_INTERVAL_SECONDS`).

O derivado **não consegue** responder a segunda: com a fila vazia — o caso normal
na maior parte do tempo — `jobs` não tem rastro algum de tick, e um tick que
reivindica e morre em seguida deixa `jobs.updated_at` fresco e parece saudável
por até um lease. Medido nas provas `[019-3]` (tick cortado não move o marcador,
mas o trabalho que ele fez **fica persistido**) e `[019-4]` (agendador parado é
detectado com a fila vazia, quando nenhum sinal derivado detectaria).

A 019 **não está aplicada em produção**. Enquanto não estiver,
`heartbeatRegistrado` vem `false` no tick, o veredito é `indisponivel`, e o
processamento segue funcionando normalmente: um marcador de saúde ausente não
pode derrubar a geração de prognósticos.

---

## Limite real de chamadas ao modelo

O teto de 3 leases é garantia de **controle do banco**. Ele **não** é anunciado
como limite absoluto de chamadas ao modelo, porque não é: o fencing impede que um
worker antigo **persista** um resultado depois de perder o lease, e não impede
que ele **continue consumindo tokens**. Quatro medidas fecham isso.

**1. Timeout por tentativa, abaixo do horizonte seguro do lease.**
`JOBS_ATTEMPT_TIMEOUT_MS` tem padrão `lease - intervalo de renovação`
(120s com os padrões) e a configuração **estoura** se for maior que isso. A
chamada morre antes de o lease poder vencer com ela viva, em vez do contrário.
Ao estourar, a tentativa vira falha com `last_error_code = 'timeout_da_tentativa'`
— rastreável, não desaparecimento.

**2. Renovação ativa, ligada por padrão.** O heartbeat renova o lease a cada 1/3
do lease enquanto o trabalho legítimo roda, então o trabalho honesto **não**
perde o lease por demora. `lerConfigFila()` sempre devolve
`renovarCadaMs = lease/3`: não há caminho de produção com heartbeat desligado.
As provas que o desligam (`renovarCadaMs: 0`) fazem isso **de propósito**, para
forçar a expiração, e dizem isso no comentário — não refletem produção.

**3. Cancelamento ao perder o lease: aborto de verdade da chamada HTTP.** Quando
uma renovação é **recusada pelo banco**, o executor aborta o `AbortSignal` da
tentativa. `lib/jobs/aborto.ts` amarra esse signal a **todo `fetch` feito dentro
da tentativa** (via `AsyncLocalStorage` + um invólucro de `globalThis.fetch`),
então a conexão do SDK da Anthropic cai e a geração para.

Foi preciso fazer assim porque `generatePrognostic` **não aceita** `AbortSignal` e
`lib/ai/**` está fora do escopo desta unidade; e porque uma flag não resolveria:
uma chamada de streaming de ~63s não tem ponto de checagem entre o pedido e a
resposta. Fora do contexto de uma tentativa o `fetch` é o original, e as chamadas
do próprio executor (`jobs_concluir`, `jobs_falhar`, renovação) ficam **fora** do
contexto de propósito — elas precisam sobreviver ao aborto para registrar o
desfecho. O signal do chamador, quando existe, é **combinado**, nunca substituído.

**4. Orçamento de consumo — ITEM INFERIDO** (o texto original cortou neste item;
está aqui para confirmação, e nada além disto foi inventado):

- `JOBS_BUDGET_CALLS_PER_TICK` (padrão = `JOBS_MAX_PER_TICK`): teto **duro** de
  chamadas que um tick pode **iniciar**. É reservado **antes** da reivindicação e
  devolvido se nada foi reivindicado — antes, as `concorrencia` vagas passavam
  juntas pela checagem e o teto podia ser estourado em até `concorrencia - 1`.
- `JOBS_BUDGET_ATTEMPTS_PER_EVENT` (padrão **100**) e
  `JOBS_BUDGET_ATTEMPTS_PER_PARTICIPANT` (padrão **3**): o disjuntor, agora
  **ligado**. Ver [Disjuntor de consumo](#disjuntor-de-consumo-externo-migration-021).
  Os números são decisão do responsável técnico para o evento de **24/10/2026 com
  50 elegíveis**: são **limite operacional inicial, não teto monetário em
  dólares**, e devem ser recalibrados com a distribuição real de custo e duração.

### Três propriedades distintas, que o painel não mistura

| Propriedade | Onde se lê | Quem garante |
|---|---|---|
| trabalho **persistido** | `jobs.status`, `result`, `jobs_resumo_evento` | reivindicação exclusiva + fencing |
| trabalho **executado** | `attempts`, `last_duration_ms`, `total_duration_ms` | lease + recuperação de expirados |
| trabalho executado **dentro dos limites de consumo** | `abortadas`, `codigo = timeout_da_tentativa` / `lease_perdido_abortado`, `recusados_por_orcamento` | timeout + renovação + aborto + orçamento |

`abortadas` (consumo **cortado**) é distinto de `descartados` (consumo **gasto** e
resultado recusado). Confundir os dois esconderia justamente o custo que as
quatro medidas existem para reduzir.

---

## Disjuntor de consumo externo (migration 021)

Teto inicial: **100 tentativas externas por evento** (50 elegíveis), **3 por
participante**. Limite **operacional**, não monetário.

### O que conta como tentativa externa

| situação | conta? | por quê |
|---|---|---|
| requisição despachada e respondida | **sim** | chegou ao provedor |
| requisição despachada e **abortada** no meio (timeout / lease perdido) | **sim** | já chegou, já custou; o fencing recusa o resultado, não a cobrança |
| aborto chegou **antes** do despacho | **não** | não abriu conexão |
| requisição a outro destino (Supabase) | **não** | não é o provedor que cobra |

Quem observa o despacho é o invólucro de `fetch` de `lib/jobs/aborto.ts`, que já
existia para abortar e agora também **conta**. A contagem é no **despacho**, não
na resposta: uma requisição que saiu e falhou na conexão é contada — escolha
conservadora, porque superestimar consumo é erro seguro e subestimar é teto que
não morde.

### Por que NÃO dá para contar com `jobs.attempts`

Duas razões, e cada uma já bastaria:

1. `attempts` conta **reivindicações**, não chegadas ao provedor. Uma tentativa
   recusada pelo próprio disjuntor, ou que perdeu o lease antes da chamada,
   incrementa `attempts` sem ter custado nada.
2. **`jobs_reenfileirar(p_forcar => true)` ZERA `attempts`.** Um teto por
   participante lido de lá seria **decorativo**: bastaria reprocessar à força
   para o contador voltar a zero.

Por isso o registro é um **livro-razão append-only** (`jobs_consumo_externo`),
em tabela própria, com chave em (evento, participante) e **independente do ciclo
de vida da linha de `jobs`**. Medido: depois de 3 tentativas e de um
`reenfileirar` forçado que levou `attempts` de 3 para **0**, o livro-razão
continuou com **3** e o disjuntor recusou a quarta.

### Teto persistente e liberação auditada

O teto efetivo é a linha persistida do evento (`jobs_orcamento_evento`) e, antes
da primeira liberação, o padrão da configuração — assim não há número mágico
escondido no banco antes de alguém decidir.

**A única porta de alteração é `jobs_orcamento_liberar`**, que exige **quem** e
**por quê** (o banco recusa motivo com menos de 10 caracteres), grava a trilha
**antes** de mexer no teto, e registra o teto anterior, o novo e **quanto já
havia sido gasto** no momento. Pela rota:

```
GET  /api/jobs/orcamento?event_id=<uuid>[&participant_id=<uuid>]   -> medição
POST /api/jobs/orcamento  { event_id, teto_evento, teto_participante, motivo }
```

`liberado_por` **não** vem do corpo da requisição: vem da sessão do admin. Um
campo de autoria enviado pelo cliente seria auditoria escrita pelo auditado.

`jobs_consumo_externo` e `jobs_orcamento_liberacoes` são **append-only**: UPDATE
é barrado por gatilho (para qualquer papel, inclusive `service_role`) e DELETE
por **privilégio**. A distinção não é estética — ver a seção de limitações
abaixo.

### Se a medição não estiver disponível: FALHA FECHADA, e ruidosa

**Sem teto verificável, não se gasta.** Decisão do CTO, revertendo a minha
escolha anterior (eu havia optado por falhar aberto, argumentando que travar a
fila no dia do evento era pior; a decisão foi a oposta e vale).

O risco de falhar fechado é o que este projeto inteiro persegue: uma fila que
simplesmente não anda é, no painel, **idêntica** a uma fila vazia e a um
agendador morto. Por isso a recusa é nomeada em três lugares:

| onde | o que aparece |
|---|---|
| `POST/GET /api/jobs/tick` | **503** com `codigo`, `error`, `mensagem_para_a_operacao` e `nada_foi_gasto: true` |
| `GET /api/jobs/saude` | `saudeDoOrcamento.veredito: "bloqueado"`, `processamentoBloqueado: true`, `alertaAtivo: true` |
| log do worker | `[jobs] TICK BLOQUEADO: não consegui verificar o consumo de IA` |

Dois códigos, porque as causas pedem ações diferentes — a mesma distinção que
`lib/erros/falha-de-fila.ts` já faz para a 018:

| código | significa | o que a operação lê |
|---|---|---|
| `BUDGET_MEASUREMENT_MISSING` | as funções de orçamento **não existem**: migration 021 ausente | "falta aplicar a atualização do banco do orçamento (**migration 021**)" |
| `BUDGET_MEASUREMENT_UNAVAILABLE` | existem, mas não responderam (rede, timeout) | "aguarde alguns instantes… se persistir, avise a equipe técnica" — **não** manda aplicar migration |

As duas mensagens terminam dizendo o que a situação **não** é: *"Isto NÃO é fila
vazia e NÃO é orçamento esgotado."* Três estados distintos, três respostas
distintas:

- **não consegui verificar o consumo** → bloqueio (acima);
- **não há nada a processar** → `pendentes: 0`, sem bloqueio e sem alerta;
- **o orçamento acabou** → job vira `canceled` com `recusado_por_orcamento` e o
  motivo citando o teto; o processamento dos outros eventos continua.

**A sonda vem antes de reivindicar**, e isso não é detalhe: reivindicar já
incrementa `attempts`. Se o portão fechasse depois do claim, um ambiente sem a
021 queimaria as 3 tentativas de **todos** os jobs sem ter chamado o provedor
uma vez — "falta migration" viraria "todos os participantes falharam". Medido:
com a 021 ausente, os jobs ficam intactos em `pending` com `attempts = 0`.

**Um tick bloqueado NÃO registra `tick ok`** (019). Um tick que se recusou a
trabalhar não é prova de agendador saudável — e assim o painel mostra as duas
coisas: o agendador envelhecendo e a causa real nomeada ao lado.

Se a medição cair **no meio** do tick (a sonda passou e a verificação de um job
falhou), o comportamento é o mesmo: o job volta à fila com
`last_error_code = BUDGET_MEASUREMENT_*`, o tick para de reivindicar, e nada é
gasto. Se cair **depois** de uma tentativa já paga, o desfecho é gravado (jogar
o trabalho fora não devolve o dinheiro) e o tick para de iniciar gasto novo.

> Os códigos canônicos moram em `lib/erros/codigos.ts` e
> `lib/erros/mensagens-host.ts`, que são de outra unidade e estão fora do meu
> escopo — lá `MENSAGENS` é `Record<CodigoDeErro, …>` e um código novo sem
> mensagem não compila, de propósito. Por isso estes dois nascem em
> `lib/jobs/orcamento-indisponivel.ts`, no mesmo estilo, aguardando adoção.

### Limitações do disjuntor, declaradas

1. **Teto de início, não de término.** A verificação é antes da tentativa, então
   duas vagas que verificam ao mesmo tempo podem ambas passar: o teto pode ser
   estourado em até `JOBS_CONCURRENCY - 1` tentativas (2 em 100 = 2%). Fechar
   isso exigiria serializar a verificação com um advisory lock por evento.
2. **Janela de não-contabilização.** Se a função morrer entre o despacho e o
   lançamento no livro-razão, aquele consumo não é contado. É o mesmo limite da
   entrega "ao menos uma vez": não há commit atômico entre a cobrança do
   provedor e o commit do Postgres. O lançamento é feito imediatamente após a
   tentativa para encurtar a janela.
3. **Tentativas × requisições.** Os tetos contam **tentativas** (linhas com
   `chamadas > 0`), como pedido. O SDK da Anthropic tenta de novo por conta
   própria em falha de rede, então `requisicoes_despachadas` pode ser **maior**
   que `tentativas_externas`. As duas ficam persistidas; se o teto tiver de ser
   em requisições, é trocar `count(*)` por `sum(chamadas)` em
   `jobs_orcamento_verificar` — decisão de produto.
4. **DELETE é barrado por privilégio, não por gatilho, e isto foi um erro meu
   corrigido.** A primeira versão barrava DELETE por gatilho, o que **quebrava
   `on delete cascade`**: apagar um evento (operação real do admin) passou a
   falhar. Uma tabela de auditoria que impede apagar o evento auditado não
   protege nada, só trava o produto. Hoje: `service_role` não tem DELETE (42501
   medido), a cascata de `events` passa, e o **dono** da tabela pode apagar —
   como em qualquer tabela de auditoria.
5. **O `revoke` explícito para `service_role` é obrigatório.** A imagem do
   Supabase concede a tabela inteira a `service_role` por *default privileges*.
   Sem revogar, `service_role` **apagava** o livro-razão (medido: apagou), e o
   "append-only" existiria só no comentário. Mesma lição da 014.

---

## Garantias REAIS

O que o sistema garante:

1. **Visibilidade sem depender dos logs da Vercel.** Duração (`last_duration_ms`,
   `total_duration_ms`), tentativas (`attempts`/`max_attempts`), falhas
   (`last_error`, `last_error_code`), quem estava com o job (`claimed_by`) e o
   resultado (`result`) ficam **persistidos na tabela**. A resposta continua
   correta depois de a função que fez o trabalho ter morrido.
2. **Recuperação.** Execução expirada é reivindicada por outro worker, e o token
   de execução impede que um worker antigo sobrescreva o resultado de uma
   tentativa mais recente.
3. **Preservação.** Job finalizado (`succeeded`/`skipped`) não é refeito por
   causa da falha de outro, nem por um segundo clique em "Processar"
   (`on conflict do nothing`). Reprocessar sucesso exige `p_forcar = true`,
   explicitamente.
4. **Isolamento entre participantes.** A falha de um não impede nem refaz o job
   de outro. Medido: dois jobs em `failed` com `attempts 3/3` ao lado de dois em
   `succeeded` com `attempts 1/3`.
5. **O evento não fica em estado indefinido.** Qualquer tick fecha qualquer
   evento cujos jobs já são todos terminais.
6. **Nenhuma falha invisível.** Erro de RPC vira exceção com o nome da função;
   exceção do trabalho vira `failed` com código `excecao`; desfecho recusado pelo
   fencing é relatado como `descartado`; falha ao gravar o desfecho é relatada e
   deixada para o lease retomar.
7. **Participante não enxerga job nenhum** (nem o próprio); admin **lê** mas não
   escreve nem aciona a fila; só `service_role` escreve e executa as funções.
8. **Teto de consumo externo por evento e por participante**, contado em
   tentativas que chegaram ao provedor, persistido, e alterável só por
   liberação auditada — ver
   [Disjuntor de consumo](#disjuntor-de-consumo-externo-migration-021). O teto
   por participante **sobrevive** ao `jobs_reenfileirar` forçado.
9. **Sem medição de consumo, não se gasta** (falha fechada), e o bloqueio é
   **nomeado** no tick, no painel e no log — nunca uma fila que só para de
   andar.

### O que o sistema explicitamente NÃO garante

1. **Entrega exatamente uma vez. É AO MENOS UMA VEZ.** Um worker pode terminar o
   trabalho e morrer **antes** de gravar o desfecho; o lease vence, outro worker
   reivindica e **refaz**. Não existe commit atômico entre "a Anthropic cobrou" e
   "o Postgres gravou", e nenhuma fila resolve isso. **Uma tentativa interrompida
   PODE ter consumido crédito de IA sem deixar resultado** — as quatro medidas de
   [Limite real de chamadas](#limite-real-de-chamadas-ao-modelo) reduzem esse
   desperdício (a chamada é abortada em vez de seguir até o fim), mas **não o
   eliminam**: o que já foi gerado até o aborto foi cobrado. O que se garante é a
   idempotência dos **efeitos**: `prognostics` tem `UNIQUE` em `participant_id`, a
   015 recusa regeração fora dos estados regeráveis, e o PDF é por participante.
2. **Prazo.** Ver a nota sobre concorrência 3 acima.
3. **Consumo de IA medido.** `ai_usage` nasce e permanece `NULL`:
   `generatePrognostic` devolve apenas `{ok, prognosticId, trail}` e descarta o
   `message.usage` da Anthropic. O proxy de custo é `attempts`. A coluna existe
   para o dia em que aquela função passar a devolver `usage`, sem precisar de
   migration nova.
4. **Contabilidade perfeita de tempo.** Quando `jobs_reivindicar` retoma
   **diretamente** uma linha de lease vencido, ele reescreve `attempt_started_at`
   sem somar o tempo da tentativa abandonada em `total_duration_ms` — a duração
   daquela tentativa é perdida. Pelo caminho de `jobs_recuperar_expirados` a soma
   está correta, e é por isso que o tick **recupera antes de reivindicar**.
   `attempts` é honesto nos dois caminhos, então o custo não é subestimado, só o
   tempo. (Achado, não corrigido — exigiria mexer na 018.)
5. **Falha permanente não encurta as tentativas.** Um `404` (participante
   inexistente) é retentado até `max_attempts` como qualquer outro. Não custa
   crédito de IA (`generatePrognostic` recusa antes do modelo), mas ocupa vaga.
   Marcar uma falha como definitiva exigiria um parâmetro novo em `jobs_falhar`.
6. **Renderização de PDF.** A fila de hoje só faz `kind = 'prognostico'`. O
   `kind = 'pdf'` está declarado na 018 mas **não tem executor**: não enfileire
   jobs de `pdf` antes de existir um, ou eles ficam `pending` para sempre.

---

## Como operar

Tudo abaixo exige admin autenticado (ou `service_role`, por psql).

### Inspecionar

```
GET /api/jobs/status?event_id=<uuid>
```

Devolve o resumo do evento, a lista completa de jobs e uma seção `atencao` com o
que falhou ou estourou lease. Para a saúde da fila como um todo (e o alerta),
`GET /api/jobs/saude` — ver [Saúde e alerta](#saúde-e-alerta). Por SQL:

```sql
-- "o evento acabou?"
select * from public.jobs_resumo_evento('<event_id>', 'prognostico');

-- quem falhou e por quê
select participant_id, status, attempts || '/' || max_attempts as tentativas,
       last_error_code, last_error, total_duration_ms, claimed_by
from public.jobs
where event_id = '<event_id>' and kind = 'prognostico' and status = 'failed';

-- o que está em voo agora (e se o lease ainda está vivo)
select participant_id, claimed_by, attempts, lease_expires_at,
       lease_expires_at > now() as lease_vivo
from public.jobs where kind = 'prognostico' and status = 'running';
```

### Enfileirar

```
POST /api/jobs/enfileirar   { "event_id": "<uuid>" }
```

Cria um job por participante marcado como concluído (`completed_at`), **qualquer
que seja a origem da resposta**: digitada no aplicativo ou importada de coleta
externa. A fila não sabe nem precisa saber de onde a resposta veio; ela trabalha
sobre `participants` + `prognostics`. Idempotente: clique duplo não
duplica trabalho pago nem ressuscita job terminal. Marca o evento como
`processing` só se houver trabalho pendente de verdade **e** o evento ainda
estiver em `live`: um reprocessamento depois de o evento ter fechado roda o job
sem reabrir o evento, de propósito (quem controla o estado do evento é o painel,
e `jobs_fechar_evento_se_concluido` nunca volta de `completed`).

### Reprocessar e destravar

```
POST /api/jobs/operacao   { "job_id": "<uuid>", "acao": "reenfileirar" }
POST /api/jobs/operacao   { "job_id": "<uuid>", "acao": "reenfileirar", "forcar": true }
POST /api/jobs/operacao   { "job_id": "<uuid>", "acao": "cancelar", "motivo": "..." }
```

- **`reenfileirar`** devolve o job à fila com `attempts = 0`. Recusa job em
  `running` com lease vivo (espere o lease vencer ou cancele) e recusa desfazer
  `succeeded`/`skipped` sem `forcar`.
- **`forcar`** não é bypass da 015: um prognóstico já `delivered` será recusado de
  novo e o job terminará em `skipped`, sem apagar nada.
- **`cancelar`** tira o job da fila sem fingir que deu certo, e zera o
  `run_token`: a tentativa em voo terá o resultado recusado quando voltar.

**Job preso em `running`:** não existe job preso. O lease vence e o tick seguinte
o retoma (ou o encerra em `failed`, se as tentativas acabaram). Se quiser antes
da hora: `cancelar`.

**Evento preso em `processing` sem jobs** (o caso que está em produção hoje, do
lote antigo): `jobs_fechar_evento_se_concluido` devolve `false` de propósito
quando o evento não tem job nenhum — fechar ali transformaria um enfileiramento
que falhou em evento completo. Aquele evento precisa de um `UPDATE` manual, com
autorização:

```sql
update public.events set status = 'completed' where id = '<event_id>' and status = 'processing';
```

Com a fila em uso, essa situação não se repete: o evento ou tem jobs (e algum
tick o fecha) ou nunca saiu de `live`.

---

## Caminho de migração

A fila está construída **ao lado** do lote, que segue intocado. A migração
recomendada, em quatro passos, cada um reversível:

1. **Aplicar a 018, a 019 e a 021** no ambiente de destino (as três estão
   validadas contra Postgres descartável e **não aplicadas em produção**).
   Depois de aplicar, recarregar o cache de schema do PostgREST
   (`notify pgrst, 'reload schema'`), senão as RPCs respondem 404. As duas
   últimas são independentes da 018: sem a 019 a fila funciona igual e só a
   saúde do agendador fica `indisponivel`; sem a 021 a fila funciona igual e só
   o disjuntor de consumo fica inerte (declarando-se inerte).
2. **Ligar o acionamento**: `vercel.json` com o cron e `CRON_SECRET`. Nesse ponto
   a fila existe, anda, e ninguém a usa — o lote continua sendo o caminho de
   produção. Dá para validar com um evento de teste chamando
   `/api/jobs/enfileirar` à mão.
3. **Trocar o botão**: `LiveControlPanel` passa a chamar `/api/jobs/enfileirar`
   em vez de `/api/batch-process`, e o painel passa a ler
   `/api/jobs/status?event_id=...` para mostrar progresso real por participante
   (hoje o painel não tem como mostrar isso: a informação só existe enquanto a
   requisição vive). O lote fica no código como rota de emergência.
4. **Mover o PDF para a fila**: criar o executor de `kind = 'pdf'`
   (`renderAndStorePdf`), enfileirar um job de `pdf` quando o de `prognostico`
   termina em `succeeded`, e trocar o `and j.kind = p_kind` de
   `jobs_fechar_evento_se_concluido` por `and j.kind = any(p_kinds)` — é a
   limitação 4 da própria 018, e exige **migration nova**, não alteração da 018.
   Só depois disso o lote pode ser removido.

O que **não** recomendo: migrar o lote por dentro (fazer `/api/batch-process`
enfileirar e esperar). Isso recria a requisição longa que precisa sobreviver, que
é exatamente o defeito.

---

## Arquivos

| arquivo | papel |
|---|---|
| `lib/jobs/config.ts` | configuração por ambiente, com validação que estoura |
| `lib/jobs/fila.ts` | invólucro fino das funções da 018; erro de RPC vira exceção |
| `lib/jobs/executor.ts` | um job: heartbeat de lease, desfecho, detecção de descarte |
| `lib/jobs/worker.ts` | um tick: recuperar, pool rolante, fechar evento |
| `lib/jobs/trabalho-prognostico.ts` | adaptador de `generatePrognostic` (409 → `skipped`) |
| `lib/jobs/autorizacao.ts` | `CRON_SECRET` em tempo constante, ou sessão de admin |
| `app/api/jobs/tick/route.ts` | aciona o worker (cron ou admin) |
| `app/api/jobs/enfileirar/route.ts` | cria os jobs de um evento + empurrão inicial |
| `lib/jobs/saude.ts` | os três indicadores, a regra de alerta e a saúde do agendador |
| `lib/jobs/aborto.ts` | aborto real da chamada externa e contagem do que foi despachado |
| `lib/jobs/orcamento-indisponivel.ts` | os dois códigos de bloqueio e a mensagem que a operação lê |
| `app/api/jobs/status/route.ts` | inspeção para a operação |
| `app/api/jobs/saude/route.ts` | painel de saúde (admin ou monitor externo) |
| `app/api/jobs/orcamento/route.ts` | medição por evento e liberação auditada |
| `supabase/migrations/019_heartbeat_worker.sql` | marcador do tick bem-sucedido (**não aplicada em produção**) |
| `supabase/migrations/021_orcamento_consumo_externo.sql` | livro-razão, teto persistente e trilha de auditoria (**não aplicada em produção**) |
| `app/api/jobs/operacao/route.ts` | reprocessar / cancelar um job |

## Como reproduzir as provas

Unitárias (sem banco, entram no `npx vitest run` normal):
`lib/jobs/fila.test.ts`, `executor.test.ts`, `worker.test.ts`, `config.test.ts`,
`saude.test.ts`, `aborto.test.ts`.

`aborto.test.ts` prova duas coisas com o mesmo instrumento: que a chamada
externa é **abortada** (e não só deixada de esperar) e que a **contagem** de
consumo inclui a tentativa abortada e exclui a que nunca abriu conexão. Ele
sobe um servidor HTTP **local**: ele sobe um servidor HTTP **local** que imita um endpoint de
modelo em streaming e **conta** os tokens que emitiu. Ao perder o lease (ou ao
estourar o teto da tentativa), o contador do servidor **congela**; um controle
negativo, sem aborto, mostra a mesma chamada passando de 30 tokens. Nenhuma
chamada à Anthropic — é proibido gastar token aqui.

Contra Postgres real, com a 018 aplicada:

```bash
nome=prova018
url=$(bash scripts/drift/reference-db.sh up --name "$nome" | cut -f2)
JOBS_PROVA_URL="$url" npx vitest run --reporter=verbose lib/jobs/provas/fila-postgres.test.ts
docker rm -f "$nome"
```

Sem `JOBS_PROVA_URL` o arquivo é **pulado** (`npx vitest run` continua verde em
máquina sem docker). O trabalho caro é **simulado com espera** — chamar a
Anthropic ali gastaria crédito, e o que está sob prova é a fila, não o conteúdo
do slot. A sonda de RLS é `lib/jobs/provas/rls-jobs.sql`, que reusa o ferramental
de `scripts/db-security`.

### Armadilha do ambiente, medida aqui

Na imagem descartável do `reference-db.sh` (supabase/postgres 17.6.1.106, com
`pgaudit` em `shared_preload_libraries`), **chamar uma função cujo EXECUTE foi
revogado derruba o backend com SIGSEGV** em vez de devolver 42501. Vale para
qualquer função, inclusive a `delete_event_cascade` da 005 — não é defeito da
018. É por isso que a sonda verifica EXECUTE pelo catálogo
(`has_function_privilege`) e só chama a função **depois** de conceder o EXECUTE
de propósito, para medir a segunda camada (o privilégio de tabela revogado). É o
mesmo desenho do cenário 4 de `scripts/db-security`. Quem escrever sonda nova:
não chame função revogada nesse banco.
