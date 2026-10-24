# Proposta: o envio do formulário público como uma única transação no banco

Status: proposta de arquitetura, sem código e sem migration. Nada aqui autoriza aplicar ou publicar.
Data: 24/10/2026. Base: `origin/main` (commit `0ab0dc4`).
Origem: exceção conhecida 3 de `docs/aplicar/MANIFESTO-DO-PACOTE.md` ("O envio do formulário não é uma transação única").

Este documento descreve o que existe hoje (com arquivo e linha), o contrato que o envio deve cumprir, a forma proposta, os riscos, o plano de migration e os testes. Não contém SQL nem TypeScript de implementação. Onde aparece o nome de uma função futura, é só um rótulo para a discussão.

## 0. Resumo para quem tem pouco tempo

1. Hoje o envio é uma sequência de oito chamadas separadas ao PostgREST, cada uma em transação própria (autocommit). Falhar no meio deixa estado parcial, e o que protege o resultado é a releitura e o reenvio, não o banco.
2. Além do defeito já declarado no manifesto, a análise achou um defeito maior que ele: a verificação "este e-mail já respondeu?" e a gravação são passos separados, então dois envios simultâneos do mesmo e-mail podem sobrescrever um ao outro e misturar nome com respostas de outra pessoa (seção 1.4).
3. O upsert de participante (`receber-formulario.ts:725`) reescreve nome e telefone de quem já existe e ainda não respondeu, inclusive apagando o telefone quando o novo envio não traz um. O contrato proposto proíbe isso.
4. A "validação das 52 respostas" de hoje confere presença e tipo, não faixa, não alternativa válida e não tamanho. Um valor fora de faixa é gravado e só estoura na segunda-feira, ao gerar o documento (seção 1.4, item E).
5. A recomendação é uma função de banco única, chamada só pelo servidor com `service_role`, preferindo `SECURITY INVOKER` (o precedente `importacao_externa_aplicar`, migrations 022 e 024, já é assim) e usando `SECURITY DEFINER` apenas se uma razão concreta for demonstrada. Qualquer que seja a escolha, exige revisão de segurança dedicada antes de implementar (seção 4).

---

## 1. Fluxo atual, passo a passo

Convenção: `rf` é `app/api/formulario-publico/receber-formulario.ts`; `route` é `app/api/formulario-publico/route.ts`. Todas as chamadas ao banco saem do servidor com a chave de serviço (`lib/supabase/admin.ts`, `createAdminClient`, usado em `route:90`). A chave de serviço passa por cima da RLS; é por isso que as policies de `participants` e `quiz_responses` (002, 010, 014) não são avaliadas aqui.

### 1.1 A porta HTTP

| # | O que acontece | Onde |
|---|---|---|
| H1 | Lê o corpo JSON. Corpo ilegível devolve 400. | `route:70-76` |
| H2 | Valida o formato com zod: `event_code` até 40; `full_name` de 2 a 200; `email` válido até 320; `phone` até 40; `respostas` como mapa plano com no máximo 400 chaves. Os valores aceitos são string, lista de strings ou número finito, **sem limite de tamanho por valor**. | `route:37-54` |
| H3 | Cria o cliente de serviço e chama `receberFormulario`. Não há limite de frequência, captcha ou chave de idempotência nesta rota. | `route:90-98` |
| H4 | Traduz o desfecho em status HTTP: `ok` 200, `segunda_resposta_guardada` 200, evento ausente 404, encerrado 409, prazo 409, prazo indeterminado 503, questionário indisponível 503, faltam obrigatórias 422, resposta inválida 400, falha de gravação 503 `PUBLIC_FORM_WRITE_UNAVAILABLE`, erro 500. | `route:100-215`; código em `lib/erros/codigos.ts:287` |

### 1.2 A recepção (`receberFormulario`)

Cada linha com "chamada" é uma ida separada ao banco, em transação própria.

| # | Passo | Chamada ao banco | Onde |
|---|---|---|---|
| R0 | Normaliza e-mail (minúsculas), nome, telefone (vazio vira nulo) e código do evento (maiúsculas). | nenhuma | `rf:557-560` |
| R1 | Lê o evento pelo código. | **1.** `events` select (`id, status, quiz_version, mode, form_closes_at`) | `rf:563-570` |
| R2 | Decide a situação do formulário uma única vez, com o relógio do servidor Node (`agora()`, padrão `new Date()`). Estados `completed` e `processing` recusam; prazo `>=` `form_closes_at` recusa; assíncrono sem prazo legível recusa. | nenhuma | `rf:576-577`; regras em `rf:290-313` |
| R3 | Lê as etapas da versão do evento, ordena, e recusa se a lista não for 1 a N sem buraco. | **2.** `quiz_stages` select | `rf:581-594`; critério em `rf:352-367` |
| R4 | Separa as respostas por etapa. Ignora ids que não pertencem ao questionário. Confere formato por tipo (`formatoCompativel`) e obrigatoriedade (`obrigatoriasEmFalta`). Recusa antes de qualquer escrita. | nenhuma | `rf:600-625`; `rf:324-344`; `lib/quiz/obrigatorias.ts:86-175` |
| R5 | Procura participante do mesmo e-mail no evento. | **3.** `participants` select | `rf:637-646` |
| R6 | Se existe, lê as respostas dele. Erro de leitura recusa em vez de apostar. | **4.** `quiz_responses` select | `rf:648-661` |
| R7 | Reenvio idêntico: mesmo nome (sem diferenciar caixa) e mesmas respostas em todas as etapas. Confere e conclui sem reescrever nada. | **5.** `quiz_responses` select, **6.** `participants` update condicional, **7.** `event_logs` insert (ver R11) | `rf:672-701`; `rf:510-546` |
| R8 | Segunda resposta: participante tem resposta e o envio é diferente. Guarda na mesa de decisão e não toca em `participants` nem em `quiz_responses`. | Monta o manifesto (impressão SHA-256) em TypeScript e faz **`external_submissions` insert** com estado `conflito`, e depois **`event_logs` insert** | `rf:703-713`; `rf:809-924` (manifesto `rf:853`; insert `rf:866-886`; log `rf:902-915`) |
| R9 | Caminho feliz: upsert do participante por `event_id,email`. O payload tem nome, e-mail e telefone, sem `user_id`. | **`participants` upsert** | `rf:725-737` |
| R10 | Upsert de uma linha por etapa em `quiz_responses`, por `participant_id,stage_id`. É **um único comando** de várias linhas, portanto atômico entre as etapas. | **`quiz_responses` upsert** | `rf:743-751` |
| R11 | Conferência e conclusão: relê `quiz_responses` do participante, confere que **cada etapa tem linha**, e só então `participants.completed_at = new Date()` do Node, com `completed_at is null` como condição. | **`quiz_responses` select** e **`participants` update** | `rf:754` e `rf:510-546` (update em `rf:539-543`) |
| R12 | Procedência: insere em `event_logs` a ação `formulario_publico_recebido` (só metadados). Falha aqui não desfaz nada. | **`event_logs` insert** | `rf:761-778`; função `rf:419-447` |
| R13 | Em qualquer falha de gravação: insere `formulario_publico_envio_nao_gravado` em `event_logs` (fase e código do banco) e devolve `gravacao_indisponivel`. | **`event_logs` insert** | `rf:464-484` |

No caminho feliz de uma pessoa nova são oito idas ao banco: R1, R3, R5, R9, R10, R11 (duas) e R12.

### 1.3 O cliente

| O que acontece | Onde |
|---|---|
| O navegador guarda rascunho em `localStorage` e só o apaga ao receber confirmação (`success` sem código, ou segunda resposta confirmada). | `components/features/participant/FormularioPublico.tsx:176-186`, `:356-361` |
| Falha de rede: o `catch` não sabe se gravou, não afirma nada, e oferece reenviar o mesmo conteúdo. | `FormularioPublico.tsx:370-374` |
| A tela imersiva usada pela página pública envia pela mesma rota. | `components/features/participant/FormularioImersivo.tsx:454`; página `app/(public)/formulario/[eventCode]/page.tsx` |

Não existe chave de idempotência. O reenvio é reconhecido por **igualdade de conteúdo** (R7).

### 1.4 Achados da análise, em ordem de gravidade

**A. Não há transação, e o estado parcial é real.** Entre R9 e R11 existem janelas em que o banco guarda: participante sem respostas (depois de R9); respostas sem conclusão (depois de R10). O reenvio cura os dois casos, e o boletim os conta (`docs/aplicar/boletim-da-coleta.sql:69,93`, "registrados sem conclusão"). A cura depende de a pessoa reenviar e de o rascunho ainda existir no aparelho.

**B. Dois envios simultâneos do mesmo e-mail se atropelam (defeito não declarado no manifesto).** R5 e R6 decidem "esta pessoa não tem resposta" e R9 e R10 escrevem, em chamadas separadas, sem trava entre elas. Se A e B passam por R5 e R6 antes de qualquer um gravar, os dois seguem pelo caminho feliz: o upsert de R9 reescreve nome e telefone (vale o último), o upsert de R10 reescreve as respostas (vale o último), e ambos recebem `ok`. Pode sobrar o nome de B com as respostas de A, e a regra central do arquivo ("a segunda resposta não apaga a primeira", `rf:37-75`) é violada sem aviso. O gatilho `quiz_responses_serializa_participante` (024) só serializa cada comando de escrita, não o conjunto do envio.

**C. O upsert de participante reescreve dados de quem já existe.** O payload de R9 inclui `full_name` e `phone` (`rf:728`). Em conflito, o PostgREST sobrescreve exatamente as colunas enviadas. Para um participante que já existe e ainda não respondeu (por exemplo, entrou pelo `/join`, ou ficou como resto de um envio parcial), qualquer pessoa que digite o e-mail dele troca o nome e, se não informar telefone, **apaga o telefone** (`phone: null`). O comentário de `rf:50-53` declara o oposto como regra para quem já respondeu, mas o critério "tem resposta" deixa de fora quem ainda não tem.

**D. Prazo e conclusão usam o relógio do Node; o resto do sistema usa o do banco.** O prazo é decidido uma vez em R2 (`rf:576`) e `completed_at` sai de `new Date()` do Node (`rf:541`). A migration 023 decide o início do processamento pelo relógio do banco (`clock_timestamp()`, `referencia_temporal_do_banco`) e garante que o conjunto de respostas é estável olhando transações abertas em `pg_stat_activity` (`023_processamento_assincrono.sql:42-98`, quiescência). Um envio do formulário público entre R2 e R11 **não é uma transação aberta**: está entre comandos autocommit, invisível a essa checagem. O próprio cabeçalho da 023 já registra o resíduo: "`participants.completed_at` é gravado ... com o relógio do Node, depois do último envio".

**E. A validação "das 52 obrigatórias" confere presença e tipo, não conteúdo válido.** `formatoCompativel` (`rf:324-344`) aceita qualquer número finito para `scale`, qualquer string para `select`, `short_text` e `text`; `obrigatoriasEmFalta` (`lib/quiz/obrigatorias.ts:97-135`) para `scale` só pergunta se é número. Não se confere faixa (0 a 10, 1 a 5), alternativa dentro de `options`, nem `max_chars`. O motor de pontuação, ao contrário, é estrito e **lança** diante de valor presente e ilegível (`lib/scoring/achatar-respostas.ts:1-30`): um 99 numa escala é gravado hoje e vira erro na geração do documento. A conclusão (R11) também só confere que cada etapa tem uma linha, não que as 52 respostas estão lá.

**F. A segunda resposta duplica quando a rede falha.** O identificador da submissão na mesa é `publico:` mais um UUID novo a cada chamada (`rf:832`). Se o cliente reenvia uma segunda resposta cuja primeira tentativa já gravou, nasce uma segunda linha em `external_submissions` para o mesmo conteúdo. O índice único natural da 022 (`external_submissions_natural_idx`, `022:162`) não protege, porque o id é sempre novo. O teste `receber-formulario.test.ts:521` fixa que duas submissões **diferentes** viram duas linhas; nada fixa o que acontece com a **mesma** submissão repetida.

**G. Superfície de abuso.** Sem limite de frequência; valores sem teto de tamanho (`route:37-41`); a segunda resposta guarda o mapa cru da requisição, incluindo chaves que não pertencem ao questionário (`rf:709`, `rf:874`); não há limite de segundas respostas por e-mail; a resposta `segunda_resposta_guardada` revela que o e-mail já respondeu (decisão consciente, `route:111-118`).

### 1.5 Tabelas, funções, gatilhos e policies tocados

Tabelas escritas ou lidas pelo envio:

| Tabela | Uso | Restrições relevantes |
|---|---|---|
| `events` | leitura (R1) | `event_code` único (001); `form_closes_at`, `form_opens_at`, `mode`, `quiz_version` (010) |
| `quiz_stages` | leitura (R3) | `unique(quiz_version, stage_number)` (010:432) |
| `participants` | leitura, upsert, update | `unique(event_id, email)` (001:27); `user_id` nunca escrito aqui |
| `quiz_responses` | leitura, upsert | `unique(participant_id, stage_id)` (001:44); `origem` em `app`/`externo` (022:346-357) |
| `external_submissions` | insert (só segunda resposta) | índice natural `(event_id, formulario_id, submissao_id)` (022:162); CHECK de estado e identidade (029:71-86); impressão SHA-256 (022:150) |
| `event_logs` | insert | `participant_id` com `on delete set null` (001) |

Gatilhos que disparam durante o envio (todos continuam valendo dentro de uma transação única):

| Gatilho | Efeito | Onde |
|---|---|---|
| `quiz_responses_serializa_participante` (antes de insert/update) | trava consultiva por participante (`pg_advisory_xact_lock`), liberada no fim da **transação**; hoje a transação é cada comando | `024:299-316` |
| `quiz_responses_proveniencia_do_app` (antes de update, só se `origem = 'externo'`) | devolve a linha à origem `app` | `024:345-371` |
| `quiz_responses_marca_sessao` (depois de insert/update) | função `SECURITY DEFINER` que atualiza `participant_stage_sessions` | `010:395-421` |
| `external_submissions_guarda_formulario_publico` (antes de insert/update/delete) | proíbe `email_verificado = true` e `identidade_via = 'email_verificado'` no formulário público | `029:312-386` |
| `events_updated_at` | atualiza `updated_at` do evento | `001:85-100` |

Policies: nenhuma é avaliada, porque o servidor usa `service_role`. As que existem e que a mudança **não** deve enfraquecer: `participants_own_*` (002; `UPDATE` restrito a colunas pela 014), `quiz_responses_own_*` (002, 010), `event_logs_admin` (002), `external_submissions_admin` (022:759). Funções auxiliares já existentes e relevantes: `is_admin()` (012, `SECURITY DEFINER`, `search_path` vazio), `participante_lock_key(uuid)` (024), `jobs_iniciar_assincrono` e `referencia_temporal_do_banco` (023).

---

## 2. Inventário de dependências

Para cada dependência: onde vive hoje, o que o envio transacional precisa dela, e a decisão proposta. "Servidor" é o código Next.js; "banco" é a função proposta.

| Dependência | Onde vive hoje | O que a função precisa | Decisão proposta |
|---|---|---|---|
| **Identidade** (autodeclarada) | Nome e e-mail digitados; e-mail em minúsculas (`rf:557`); nunca `user_id`, nunca `email_verificado` (`rf:21-30`, `rf:78-87`; gatilho 029 em `029:312-386`) | Receber nome, e-mail e telefone já aparados; reaplicar minúsculas e aparar no banco; **nunca** escrever `user_id`; manter `email_verificado = false` e `identidade_via` nula na mesa | Banco normaliza de novo (não confia no chamador) e tem como invariante a ausência de `user_id`. Teste negativo dedicado |
| **Criação do participante** | Upsert `event_id,email` (`rf:725`), que reescreve nome e telefone | Criar se não existir. Se existir, **não sobrescrever nome nem telefone** (achado C) | Inserir; em conflito não alterar dados pessoais. Pergunta aberta Q3 sobre preencher apenas campos vazios |
| **Conflito de e-mail** | Leitura de resposta anterior (`rf:637-661`), comparação (`rf:672-701`) e mesa (`rf:809-924`) | Decidir dentro da transação, sob trava, com o estado confirmado (não um estado lido antes) | Trava por `(evento, e-mail)` antes de ler `participants`; lógica de decisão idêntica à atual |
| **Persistência das 52 respostas** | Upsert de 5 linhas em um comando (`rf:743-751`); conferência por etapa (`rf:516-534`) | Gravar todas as etapas e a conclusão na **mesma** transação; conferir contagem de etapas e das obrigatórias a partir de `quiz_stages.questions` da versão do evento | Validação estrutural em SQL como defesa em profundidade (seção 3, linha 7). Pergunta aberta Q2 sobre faixa e alternativas |
| **Autorização pública** | Rota sem login; `service_role` no servidor (`route:90`); cabeçalho `rf:3-35` | Só o servidor pode chamar a função; `anon` e `authenticated` não | `revoke` de `public`, `anon`, `authenticated`; `grant execute` só a `service_role` (seção 4) |
| **Concorrência** | Nenhuma entre R5 e R10 (achado B); trava por participante só por comando (024) | Serializar por pessoa (evento e e-mail) durante todo o envio; serializar com a mudança de estado do evento | Trava consultiva de transação por `(evento, e-mail)` antes da primeira leitura, mais bloqueio compartilhado da linha do evento; ordem de travas documentada (seção 3) |
| **Prazo** (`form_closes_at`) | `prazoDoFormulario` e `situacaoDoFormulario` (`rf:290-313`), relógio do Node, decidido uma vez (`rf:576`; teste `receber-formulario.test.ts:921`) | **Primeiro instante recusado** (`agora >= form_closes_at` recusa), decidido **uma vez, no recebimento**, sem tolerância; assíncrono sem prazo legível recusa; relógio do **banco** | Mover a decisão para dentro da função com o relógio do banco, lido uma vez no início. Mesma tabela de verdade da Rodada 78 (`receber-formulario.test.ts:864`). Ganho: um só relógio para prazo, conclusão e a quiescência da 023 |
| **Estado do evento** | `ESTADOS_SEM_COLETA = completed, processing` (`rf:301`); evento inexistente | Recusar sem escrever; garantir que a mudança de estado feita pelo painel e um envio em curso se ordenem | Ler a linha do evento com bloqueio compartilhado, para que o painel espere os envios em voo e os envios novos já vejam o estado novo |
| **Auditoria e `event_logs`** | Três ações: `formulario_publico_recebido`, `formulario_publico_segunda_resposta`, `formulario_publico_envio_nao_gravado` (`rf:419-447`, `rf:464-484`); só metadados, nunca conteúdo pessoal (`rf:89-114`); varredura em `receber-formulario.test.ts:1116` | Mesmas ações e mesmas chaves de payload, porque o boletim e o painel as leem (`boletim-da-coleta.sql:74,79,80,139`). Sucesso registrado na mesma transação; falha **não pode** ser registrada pela transação que foi desfeita | Procedência de sucesso dentro da transação. Registro de falha continua fora, no servidor, como hoje. Pergunta aberta Q5 |
| **Impressão digital do questionário** | `montarManifesto` em TypeScript, com `createHash` do Node, e serialização canônica específica (`lib/importacao/manifesto-questionario.ts`) | A mesa exige `questionario_impressao` SHA-256 (`022:150`) | O banco **não consegue reproduzir** esse JSON canônico com segurança. O servidor calcula e passa; o banco só confere o formato. Fronteira de confiança explícita (pergunta aberta Q6) |
| **Consumidores do contrato da mesa** | `lib/importacao/regularizacao.ts:12,75` lê `bloqueio.codigo = SEGUNDA_RESPOSTA_MESMO_EMAIL`, `participante_com_resposta`, `etapas_ja_respondidas`; as funções da 029 dependem disso | A linha da mesa deve nascer **idêntica** à de hoje | Teste de equivalência byte a byte do `bloqueio` e das colunas (seção 6) |
| **Processamento assíncrono** | `jobs_iniciar_assincrono` decide por `clock_timestamp()` e olha transações abertas (`023:92-165`) | O envio passa a ser uma transação visível a essa checagem | Efeito desejado; incluir teste de corrida com a quiescência (seção 6) |
| **Boletim e operação** | `docs/aplicar/boletim-da-coleta.sql`, `OPERACAO-SEGUNDA.md` | Métricas e textos que mencionam "registrados sem conclusão" | Revisar o texto do boletim: depois da mudança, esse número diferente de zero deixa de ser "esperado" e vira alarme |
| **Guard de drift e manifesto de migrations** | `scripts/guard-drift.sh`, `scripts/manifesto-migrations.sh`, `docs/GUARD-DRIFT.md` | A função nova entra na referência (assinatura, `SECURITY DEFINER`/`INVOKER`, `search_path`, hash do corpo, grants) | Nenhuma exceção ao guard; `grant` a `PUBLIC` é `[CRITICO]` por desenho |
| **Pacote de aplicação** | `docs/aplicar/marco-zero-banco-completo.sql`, `supabase/setup.sql` | Incluir a 033 se o pacote for regenerado | Decisão do dono; o pacote atual está congelado |

---

## 3. Contrato futuro: situação e garantia exigida

Princípio: **a mesma regra de negócio de hoje, com garantia de banco no lugar de disciplina de código.** Nada nesta tabela muda o que a pessoa vê, exceto onde dito.

Forma de organização proposta (alto nível, sem código):

- Uma única função de banco recebe: código do evento, nome, e-mail, telefone, o mapa plano de respostas, e a impressão digital do questionário calculada pelo servidor. Devolve um objeto com desfecho de **vocabulário fechado** (os mesmos nomes de `ResultadoDaRecepcao`, `rf:209-243`).
- Recusas esperadas (evento inexistente, encerrado, prazo, obrigatórias, resposta inválida) voltam como desfecho **sem erro e sem escrita**, no padrão de `jobs_iniciar_assincrono` (`023`: "recusas esperadas voltam como `{ ok: false, motivo }` sem erro; inconsistência levanta exceção").
- Qualquer condição inesperada **levanta exceção**, e a transação inteira é desfeita. O servidor traduz exceção em `gravacao_indisponivel`, como hoje.
- O servidor continua fazendo: validação do corpo, mensagens humanas de "o que falta" (`resumoDoQueFalta`), cálculo da impressão digital, mapeamento para HTTP e o registro da falha. A função de banco é a única que escreve.
- Alternativas consideradas e rejeitadas: (i) transação aberta pelo próprio Next por conexão direta ao Postgres: exige novo segredo, pool e superfície, e o cliente Supabase usado aqui não oferece transação; (ii) manter chamadas separadas com "compensação" (apagar o que foi gravado): não é atômico, exige `DELETE` em dado de adolescente e deixa janela de leitura inconsistente; (iii) mover **toda** a validação para SQL: duplica `obrigatorias.ts` e as mensagens, e piora a recusa dita em linguagem humana. Escolhida: validação humana no servidor e validação estrutural **também** no banco.

Ordem de travas proposta, para evitar impasse (deadlock): (1) leitura do evento com bloqueio compartilhado; (2) trava consultiva de transação por `(evento, e-mail)`; (3) travas por participante que o gatilho `quiz_responses_serializa_participante` já pede e que são reentrantes na mesma sessão. As funções de regularização da 029 e a importação da 024 pegam travas por participante em ordem de id e nunca a trava de e-mail; portanto o grafo de espera não fecha ciclo. Isso precisa ser **provado** com teste de duas sessões (seção 6), não só argumentado.

| # | Situação | Garantia exigida |
|---|---|---|
| 1 | **Falha em qualquer passo** (erro de constraint, gatilho, queda, timeout, exceção em qualquer ponto) | Tudo ou nada: nenhum participante novo sem respostas, nenhuma resposta sem conclusão, nenhuma conclusão sem as respostas, nenhuma linha de procedência de sucesso sem os dados. Após a falha, o banco é idêntico ao estado anterior ao envio. Vale também para a segunda resposta: ou a linha da mesa e sua procedência entram, ou nenhuma entra |
| 2 | **E-mail já usado** por participante que tem resposta, com conteúdo diferente | A primeira resposta, o nome e o telefone ficam **intactos** (nenhuma escrita em `participants` nem `quiz_responses`). O envio novo fica preservado como `conflito` em `external_submissions`, com `participant_id` nulo, `email_verificado = false`, `identidade_via` nula, `bloqueio.codigo = SEGUNDA_RESPOSTA_MESMO_EMAIL`, nas mesmas colunas e formato de hoje. A decisão é tomada **sob trava**, não sobre leitura antiga |
| 3 | **Reenvio após falha de rede** (cliente não sabe se gravou) | Idempotente: mesmo evento, e-mail, nome (aparado, sem diferenciar caixa) e mesmas respostas em todas as etapas devolvem `ok` sem reescrever respostas, nome, telefone nem `completed_at` (`completed_at` só muda quando está nulo). Reenvio de segunda resposta não cria segunda linha na mesa: o identificador da submissão passa a ser derivado do conteúdo, e o índice natural da 022 absorve a repetição. Nunca duplica participante, resposta ou linha de procedência de sucesso |
| 4 | **Dois envios simultâneos** (mesmo e-mail) | Serializados por pessoa. Exatamente um vira resposta oficial; o outro é reenvio idêntico (se o conteúdo é igual) ou segunda resposta (se é diferente). Nenhuma resposta perdida, nenhuma troca de identidade: nome, telefone e respostas oficiais saem sempre de **um só** envio. Nenhum impasse, nenhum erro 500 por violação de unicidade |
| 4b | **Dois envios simultâneos de e-mails diferentes** | Não se bloqueiam entre si (a trava é por pessoa). Sem impasse sob 50 envios simultâneos |
| 5 | **Usuário anônimo** | Não executa a função diretamente: `anon`, `authenticated` e `PUBLIC` sem `EXECUTE`. Pelo PostgREST, chamar a função com a chave pública recebe negativa de privilégio. Pela rota HTTP, a única coisa devolvida é o desfecho de escrita: nunca respostas já gravadas, nome, lista de inscritos ou prognóstico (`rf:31-34`). A existência de uma resposta anterior continua sendo o único dado revelado, como decidido em `route:111-118` |
| 6 | **Participante já existente** (cadastro prévio, com ou sem `user_id`) | Nome e telefone nunca são sobrescritos nem apagados. `user_id` nunca é escrito. Quem tem resposta é protegido pela linha 2. Quem não tem resposta recebe as respostas, mas o cadastro mantém os dados que já tinha (pergunta aberta Q3: preencher só campos vazios ou não tocar em nada) |
| 7 | **Conclusão** | `completed_at` só é marcado se, **dentro da mesma transação** e lendo `quiz_stages` da versão do evento: a lista de etapas é utilizável (1 a N sem buraco, cada uma com perguntas, mesmo critério de `rf:352-367` e da migration 028); existe linha de resposta para cada etapa; e **todas as obrigatórias** (52 na versão 2) estão presentes e não vazias, com formato compatível com o tipo. Se uma única faltar, nada é gravado e o desfecho é `faltam_obrigatorias`. O instante é o do banco, gravado no mesmo commit das respostas |
| 8 | **Prazo** | `agora >= form_closes_at` recusa, `agora < form_closes_at` aceita, sem tolerância, com o relógio do banco, lido **uma vez** no início. Um envio aceito antes do limite termina de gravar mesmo que a transação atravesse o limite. Assíncrono sem prazo legível recusa com `prazo_indeterminado`, sem dizer que o prazo terminou. Não escreve nada ao recusar |
| 9 | **Estado do evento** | `completed` e `processing` recusam sem escrever. Um envio em curso e a mudança de estado feita pelo painel se ordenam: ou o envio termina antes e conta, ou começa depois e é recusado. Nunca um envio "no meio" |
| 10 | **Vocabulário e compatibilidade** | Mesmos desfechos, mesmos códigos HTTP, mesmas chaves de `event_logs` (`formulario_publico_recebido` com `etapas_gravadas`, `primeira_resposta`, `reenvio_identico`; `formulario_publico_segunda_resposta`; `formulario_publico_envio_nao_gravado` com `fase`, `codigo_do_banco`), mesma ausência de nome, e-mail, telefone e conteúdo nos logs |
| 11 | **Entrada abusiva** | Corpo, número de chaves, tamanho de cada valor, profundidade e caracteres inválidos (como NUL) são limitados antes de qualquer escrita e devolvem `resposta_invalida`, nunca erro 500. O banco ignora chaves que não pertencem ao questionário e **não** as guarda (nem na mesa) |
| 12 | **Isolamento da mudança** | Nenhuma tabela, coluna, policy ou gatilho existente é alterado. A migration só acrescenta a função e os privilégios. O caminho antigo continua disponível por flag até a retirada planejada, e os dois produzem linhas idênticas |

---

## 4. Riscos de `SECURITY DEFINER` (e a pergunta anterior: precisa ser definer?)

**Esta proposta precisa de revisão de segurança dedicada antes de qualquer implementação.** O que segue é o levantamento para essa revisão, não a revisão.

### 4.1 A primeira pergunta é se o `SECURITY DEFINER` é necessário

O servidor já escreve em todas as seis tabelas como `service_role`, com a RLS ignorada. O precedente mais próximo do repositório, `importacao_externa_aplicar` (022 e 024), é **`SECURITY INVOKER` de propósito**: "a RLS vale, e isto não é um caminho para escrever onde quem chamou não podia" (`024:382-385`). As funções da 029 são `SECURITY DEFINER` porque escrevem em livros onde `service_role` **não** tem `INSERT`; esse motivo não existe aqui. A função da 023 é `DEFINER` porque precisa de `pg_read_all_stats`; também não é o caso.

Recomendação: começar por `SECURITY INVOKER`, chamada como `service_role`. Isso elimina por construção a classe inteira de riscos desta seção que decorre de executar com o dono da migration. Só adotar `DEFINER` se a revisão apontar uma razão concreta (por exemplo, retirar de `service_role` a escrita direta em `quiz_responses` para que só a função possa escrever; isso afetaria outras rotas e exige análise própria). Pergunta aberta Q1.

### 4.2 Se for `DEFINER` (ou mesmo `INVOKER`), os pontos a revisar

| Risco | O que examinar | Mitigação exigida |
|---|---|---|
| **Privilégios de execução** | Funções nascem com `EXECUTE` para `PUBLIC`; `CREATE OR REPLACE` preserva o que já havia. Foi exatamente a falha da `delete_event_cascade` (migration 011), que o PostgREST expunha ao anônimo | `revoke` de `public`, `anon` e `authenticated` **depois** de criar; `grant execute` somente a `service_role`; teste que consulta `has_function_privilege` para os quatro papéis. Nenhuma sobrecarga (`overload`) da função: uma assinatura antiga esquecida mantém os privilégios antigos. Sem `GRANT` a `authenticated`: participante logado não deve poder gravar pelo PostgREST com a própria sessão |
| **`search_path`** | A 029 usou `pg_catalog, public` nas funções `DEFINER` (`029:487-488`), enquanto o padrão do repositório (011, 012, 028) é `search_path` **vazio** com tudo qualificado | Fixar `search_path` vazio, todos os objetos qualificados por schema, inclusive operadores e tipos usados em consulta. Se a 029 deve ser alinhada é decisão separada, fora desta proposta |
| **Funções chamadas por dentro** | Gatilhos de `quiz_responses` (024, um deles sem `search_path` fixo, `024:299-310`), `marcar_sessao_de_etapa_enviada` (`DEFINER`, 010), `participante_lock_key` (024, sem `search_path`), funções de `pg_catalog` (`pg_advisory_xact_lock`, hash, `jsonb_*`, `clock_timestamp`) | Listar e fixar todas as chamadas; chamar só funções de `pg_catalog` e `public` já conhecidas; nenhuma função dinâmica; nenhum SQL dinâmico (`EXECUTE`); revisar se um gatilho `DEFINER` herdado muda de comportamento quando disparado de dentro da função |
| **Validação de entrada** | `jsonb` de tamanho e forma arbitrários vindo de um endpoint público, mesmo que intermediado pelo servidor; NUL em texto; e-mail e nome com tamanhos além do zod se o servidor mudar; tipos errados em chaves | Revalidar no banco: tamanho máximo do corpo e de cada valor, número de chaves, tipo por pergunta, e-mail e nome com limites iguais ou menores que os do zod. Falha de validação vira desfecho `resposta_invalida`, não exceção |
| **Mensagens de erro** | `RAISE` com valores interpolados pode devolver dado de um participante a quem chamou | Mensagens fixas, só com nomes de fase e códigos fechados; nunca nome, e-mail, resposta. O servidor também nunca ecoa a mensagem do banco (`rf:449-456`) |
| **Superfície de abuso e DoS** | Sem limite de frequência hoje (`route:90`); cada chamada pega travas e escreve até 5 linhas; segundas respostas ilimitadas por e-mail; crescimento de `event_logs`; envio que segura trava e fila de espera atrás de uma escrita do painel na linha do evento | `lock_timeout` e `statement_timeout` locais à função; teto de segundas respostas por `(evento, e-mail)` (Q8); limite de tamanho; limite de frequência por IP no servidor ou na borda (fora da função, mas dependência da revisão); medir o tempo de espera do bloqueio compartilhado do evento sob escrita do painel |
| **Oráculo de existência** | O desfecho `segunda_resposta_guardada` diz que o e-mail já respondeu | Já aceito (`route:111-118`). A função não pode ampliar: nada de nome, hora ou conteúdo |
| **Dono da função** | O dono padrão das migrations é `postgres`, com privilégios amplos no Supabase | Registrar o dono; teste do guard de drift; se `DEFINER`, o dono não deve ser superusuário e não deve ter mais privilégio do que o necessário |
| **Exposição pelo PostgREST** | Toda função em `public` com `EXECUTE` aparece em `/rpc/...` | Confirmar o comportamento com a chave `anon` e com JWT `authenticated` (negativa) e com `service_role` (positivo); considerar o schema exposto e o cache de esquema |

---

## 5. Plano de migration

### 5.1 Numeração

- 030: reservada (disjuntor da IA, ramo `disjuntor-030`; `docs/aplicar/MANIFESTO-DO-PACOTE.md`, "Fica de fora").
- 031: usada (`031_sem_truncate_nos_registros.sql`).
- 032: em uso por outro ramo.
- **Proposta: 033**, nome sugerido `033_formulario_publico_transacional.sql`. Antes de criar o arquivo, repetir a checagem do próximo número livre contra `origin/main` e os ramos abertos, porque a numeração é disputada (cabeçalho da 023 conta esse problema).

### 5.2 O que a 033 contém (descrição, não código)

1. A função de recepção (e, se a revisão pedir, uma função auxiliar interna de validação), com `search_path` vazio, `comment` descrevendo o contrato e o espelho em TypeScript.
2. Revogação de `public`, `anon`, `authenticated` e concessão a `service_role` (seção 4).
3. Nenhuma tabela nova, nenhuma coluna nova, nenhuma policy nova, nenhum gatilho novo, nenhuma alteração em objeto existente. Reaplicável (idempotente) como as demais, e **aditiva**: aplicá-la não muda comportamento nenhum enquanto a flag estiver desligada.
4. Possível acréscimo, só se a pergunta Q4 pedir chave de idempotência por envio: uma tabela de recibos. A recomendação inicial é **não** incluir; a igualdade de conteúdo já é a regra de hoje.

Itens de repositório que acompanham a migration: tipagem de `types/database.ts` para a função; teste do guard de drift (referência passa a conter a função); entrada no manifesto de migrations; decisão do dono sobre regenerar `docs/aplicar/marco-zero-banco-completo.sql` e atualizar `docs/aplicar/MANIFESTO-DO-PACOTE.md` (a exceção 3 passa a "fechada" apenas quando a flag estiver ligada em produção e o caminho antigo retirado).

### 5.3 Rollout atrás de flag

| Etapa | O que acontece | Critério para avançar |
|---|---|---|
| 0 | Banco descartável (`scripts/drift/reference-db.sh up`) e depois ambiente de homologação recebem a 033. Suíte da seção 6 inteira | Todas as provas passam, incluindo controles negativos e mutações |
| 1 | Aplicar a 033 em produção. Como é aditiva, o sistema continua igual. Publicar o código com a flag **desligada** | `scripts/manifesto-migrations.sh` e o guard de drift em PASS |
| 2 | Ligar a flag só para um evento de teste (lista de códigos de evento permitidos por variável de ambiente, não por interruptor global). Enviar de verdade 10 a 20 formulários, incluindo um reenvio, um e-mail repetido e uma recusa por prazo | Linhas idênticas às do caminho antigo (comparação por consulta); boletim coerente |
| 3 | Ligar globalmente | Uma semana sem diferença entre contagens do boletim e de `event_logs` |
| 4 | Retirar o caminho antigo e a flag (commit separado, sem migration) | Decisão do dono |

A flag fica no servidor (variável de ambiente lida pela rota), nunca no banco e nunca no corpo da requisição. O momento do rollout **não** deve coincidir com uma janela de coleta aberta nem com o processamento de um evento real: o pacote do Marco Zero está congelado e a coleta tem prazo (`MANIFESTO-DO-PACOTE.md`, "O prazo do formulário"). Aplicar só depois do encerramento do evento atual, ou em ambiente separado.

### 5.4 Plano de reversão

- **Reverter o uso**: desligar a flag. É imediato, não exige migration e não perde dado, porque os dois caminhos escrevem as mesmas tabelas no mesmo formato (contrato da linha 12 e teste de equivalência da seção 6).
- **Reverter a migration**: a função fica sem uso e sem privilégio para os papéis públicos; mantê-la é inofensivo. Remoção (`drop function` da assinatura exata) é uma migration posterior e separada, nunca uma edição da 033 (regra do repositório: não se edita migration aplicada).
- **O que não se reverte**: dados já gravados pela função. Por serem idênticos aos do caminho antigo, nada precisa ser migrado de volta.
- Critério para reverter às pressas: aumento de `PUBLIC_FORM_WRITE_UNAVAILABLE`, qualquer divergência de colunas entre os dois caminhos, ou qualquer teste de privilégio vermelho.

---

## 6. Matriz de testes

Padrão do repositório a seguir: banco Postgres descartável por contêiner com a imagem do Supabase (`scripts/drift/reference-db.sh up`), prova HTTP real com PostgREST e papéis reais (`lib/importacao/provas/regularizacao-http.test.ts`, `vitest.prova.config.ts`, URL por variável de ambiente, guarda de alvo só local), e **mutações** que sabotam uma cópia da função para provar que cada teste mede o que diz (`lib/erros/provas/rodar-banco.sh`, `ERROS_MUTACAO_SQL`). Os testes novos devem ser pulados sem a variável de banco, como os existentes.

Para falhar "no meio" de forma controlada, o teste instala, **só no banco descartável**, um gatilho de teste que levanta exceção em uma etapa escolhida (por exemplo, ao gravar a etapa 105, ou ao atualizar `completed_at`). Para forçar entrelaçamento, o teste usa duas conexões reais e pausas injetadas pelo mesmo mecanismo. Nada disso entra na migration.

| Garantia (seção 3) | Teste concreto | Camada | Controle negativo (deve falhar se a proteção for removida) |
|---|---|---|---|
| **1. Tudo ou nada** | Para cada ponto de falha injetado (antes do participante, depois dele, na 3a etapa, na conclusão, na procedência): chamar a função e verificar `count` de `participants`, `quiz_responses` e `event_logs` para o par (evento, e-mail) igual ao de antes. Repetir para o caminho de segunda resposta (falha na mesa e na procedência) | SQL direto como `service_role` e HTTP | Mutação "sem exceção": a cópia da função engole o erro e continua; o teste deve ficar vermelho. Comparar com o caminho antigo, que **deixa** o participante (prova do defeito) |
| **2. E-mail já usado** | Pessoa A responde. Pessoa B envia mesmo e-mail com outro nome. Verificar: nome, telefone e 5 linhas de A idênticos byte a byte; uma linha em `external_submissions` com `estado = conflito`, `participant_id` nulo, `email_verificado = false`, `identidade_via` nula, `bloqueio.codigo`, `participante_com_resposta`, `etapas_ja_respondidas`; `event_logs` com a ação certa e sem dado pessoal (reaproveitar a varredura de `receber-formulario.test.ts:1116`) | SQL e HTTP | Mutação "upsert incondicional": a cópia sobrescreve; teste vermelho. Equivalência do `bloqueio` com o que `lib/importacao/regularizacao.ts` consome (rodar a prova `regularizacao-http.test.ts` contra linhas criadas pela função) |
| **3a. Reenvio idêntico** | Enviar o mesmo conteúdo duas vezes (e uma terceira com telefone diferente): segunda e terceira devolvem `ok` com `etapas_gravadas = 0`; `completed_at` e `submitted_at` iguais aos da primeira; sem novas linhas | SQL e HTTP | Mutação "sem comparação": reenvio vira segunda resposta; teste vermelho |
| **3b. Reenvio de segunda resposta** | Enviar duas vezes o **mesmo** conteúdo conflitante: uma única linha na mesa, mesmo `submissao_id`. Enviar dois conteúdos **diferentes**: duas linhas (preserva `receber-formulario.test.ts:521`) | SQL | Mutação "id aleatório": nascem duas linhas para o mesmo conteúdo; teste vermelho |
| **3c. Rede falha depois do commit** | Cliente HTTP que descarta a resposta depois que o servidor confirmou, e reenvia. Resultado final: uma pessoa, 5 linhas, uma conclusão, uma procedência de sucesso | HTTP | Contra o caminho antigo, mesmo cenário com falha injetada entre passos: mostra o estado parcial que a função elimina |
| **4. Dois envios simultâneos, mesmo e-mail** | Duas sessões reais disparadas juntas, 200 rodadas, com e sem pausa injetada entre a decisão e a escrita. Invariantes por rodada: exatamente uma resposta oficial; o par (nome, respostas) oficial vem do **mesmo** envio; o outro envio está na mesa ou foi reconhecido como idêntico; zero erro 500, zero violação de unicidade, zero impasse | SQL com duas conexões | Mutação "sem trava de e-mail": o teste precisa encontrar troca de identidade ou resposta perdida (hoje isso acontece no caminho antigo, e esse teste deve **reproduzi-lo** como controle positivo do defeito) |
| **4b. Envios simultâneos de pessoas diferentes** | 50 envios em paralelo com e-mails distintos: todos oficiais, sem impasse, tempo total dentro de um orçamento definido | HTTP | Mutação "trava global": a latência estoura o orçamento; teste vermelho |
| **4c. Concorrência com regularização e importação** | A função em paralelo com `formulario_publico_regularizar` (029) e `importacao_externa_aplicar` (024) sobre o mesmo participante: sem impasse e com o estado final explicável | SQL, duas sessões | Inverter a ordem de travas numa cópia deve produzir impasse detectado |
| **5. Anônimo** | (a) `has_function_privilege` falso para `public`, `anon`, `authenticated`; verdadeiro para `service_role`. (b) Chamada `/rpc/...` pelo PostgREST com a chave `anon`: negada. (c) Idem com JWT `authenticated` de um participante: negada. (d) Com `service_role`: aceita (controle positivo). (e) Pela rota HTTP: a resposta nunca contém respostas, nome ou lista de inscritos | SQL e HTTP | Mutação "grant a anon": (b) deve ficar vermelho. Rodar o guard de drift: grant a `PUBLIC` deve sair como `[CRITICO]` |
| **6. Participante existente** | (a) Participante com `user_id` e sem resposta; enviar com outro nome e sem telefone: nome, telefone e `user_id` intactos; respostas gravadas. (b) Participante com telefone e sem resposta; envio sem telefone: telefone preservado. (c) Participante com resposta: linha 2. (d) `user_id` e `email_verificado` nulos/falsos em todo envio público | SQL | Mutação "upsert com nome e telefone": (a) e (b) ficam vermelhos. Controle positivo no caminho antigo, que **apaga** o telefone |
| **7. Conclusão só com as 52** | Para cada uma das 52 perguntas, enviar um pedido sem aquela resposta (e outro com valor vazio, outro com texto abaixo de `min_chars`, outro com ranking parcial): sempre `faltam_obrigatorias`, zero escrita. Pedido com 52 válidas: conclui. Versão sem etapas, com buraco e com `stage_number` nulo: `questionario_indisponivel`, zero escrita | SQL | Mutação "conclui sem conferir": pedido incompleto passa; vermelho. **Paridade SQL e TypeScript**: rodar o mesmo corpus de casos de `lib/quiz/obrigatorias.test.ts` contra a validação do banco e exigir o mesmo veredito (equivalente ao teste de espelho da 028) |
| **7b. Valor fora de faixa ou alternativa inválida** (depende da decisão Q2) | Escala 99, alternativa que não existe, texto acima de `max_chars`: recusa com `resposta_invalida`. Valida o cenário que hoje só estoura na segunda-feira | SQL | Mutação "sem faixa": vermelho. Rodar `achatarRespostas` e `calcularMarcoZero` sobre tudo que a função aceitou, exigindo zero exceção (fecha o achado E) |
| **8. Prazo** | Tabela da Rodada 78 em horário de São Paulo (`receber-formulario.test.ts:864-890`) executada contra o banco: 1 s antes aceita; exatamente no instante recusa; 1 s depois recusa; 6 minutos depois recusa. Transação lenta (pausa injetada) que atravessa o limite depois de aceita: termina. Assíncrono sem prazo: `prazo_indeterminado` e zero escrita. Relógio do Node adulterado no servidor: sem efeito, porque o banco decide | SQL e HTTP | Mutação "tolerância": aceita 5 minutos depois; vermelho. Mutação "decide duas vezes": a pausa faz recusar um envio já aceito; vermelho |
| **9. Estado do evento** | Evento em `completed` e em `processing`: recusa. Corrida: painel muda para `processing` enquanto um envio está em voo (pausa injetada): o envio ou conta inteiro ou é recusado inteiro; depois da mudança, nenhum envio novo entra | SQL, duas sessões | Mutação "sem bloqueio do evento": o envio entra depois da mudança; vermelho |
| **9b. Corrida com a quiescência da 023** | `jobs_iniciar_assincrono` em paralelo com envios que começam antes do limite: ou a função recusa por `snapshot_instavel` ou o envio já está confirmado e incluído na fotografia | SQL, duas sessões | Reaproveitar as mutações `semquiescencia` e `semvalidacao` de `lib/erros/provas/rodar-banco.sh` |
| **10. Compatibilidade** | Mesmo conjunto de cenários executado pelos dois caminhos (antigo e função) e comparação das linhas de `participants`, `quiz_responses`, `external_submissions` e `event_logs` por coluna (exceto ids e instantes). Suíte de contrato parametrizada: os testes de `receber-formulario.test.ts` passam a rodar também contra a função | HTTP | Introduzir diferença deliberada numa coluna da mesa: o comparador deve acusar |
| **11. Entrada abusiva** | Corpo com valor gigante, 10 mil chaves, NUL no texto, profundidade excessiva, tipo errado, chaves fora do questionário: sempre desfecho de recusa, nunca 500, nada gravado, e as chaves estranhas **não** aparecem em `respostas_brutas` | HTTP | Mutação "sem teto": o teste de tamanho fica vermelho |
| **12. Isolamento** | Comparar o esquema antes e depois da 033 (guard de drift e introspecção): a única diferença é a função e seus privilégios. Rodar a suíte existente inteira (`npx vitest run`) sem alteração de resultado | SQL | Se a migration tocar qualquer outro objeto, o diff de introspecção acusa |
| **Segurança da função** | Verificar `search_path` vazio e ausência de SQL dinâmico na definição; teste de "função plantada": criar em outro schema um objeto de mesmo nome que alguma função/operador chamado e provar que não é resolvido | SQL | Mutação "search_path com public": o teste de função plantada fica vermelho |
| **Desempenho e esgotamento** | Latência p95 da função com 50 envios simultâneos; tempo de espera do bloqueio do evento sob escrita concorrente do painel; efeito de `lock_timeout` | HTTP | Orçamentos definidos antes (Q9) |

Teste de regressão obrigatório de todo o pacote: `npx vitest run` (comando padrão), a prova HTTP existente da regularização, e o guard de drift.

---

## 7. Perguntas abertas para o dono e o CTO

1. **Definer ou invoker (Q1).** Concordam em partir de `SECURITY INVOKER` (precedente 022 e 024) e só aceitar `SECURITY DEFINER` com razão concreta documentada? Se a intenção é, no futuro, retirar de `service_role` a escrita direta nas tabelas de resposta, isso muda a resposta e deve ser decidido agora.
2. **Quanto validar no banco (Q2).** A conclusão passa a exigir só presença e tipo (equivalente a hoje), ou também faixa de escala, alternativa dentro de `options` e `max_chars`? A segunda opção fecha o achado E, mas **recusa envios que hoje passam** e exige confirmar que nenhum questionário legítimo grava fora desses limites (por exemplo, a escala 0 a 10 do bloco 2 e a de 1 a 5 do bloco 3; o texto das situacionais como `A. ...`). Há também a pergunta de qual é a fonte da verdade: banco, servidor ou as duas com teste de paridade (recomendado).
3. **Participante existente sem resposta (Q3).** Para quem entrou pelo `/join` ou tem `user_id`, o formulário público: (a) não toca em nome e telefone; (b) preenche somente o que está vazio; ou (c) mantém o comportamento de hoje (sobrescreve)? A recomendação é (b), e (a) quando houver `user_id`.
4. **Chave de idempotência (Q4).** Basta a igualdade de conteúdo (regra de hoje), ou o dono quer um recibo por envio (UUID gerado no navegador, tabela própria)? A chave dá prova explícita de "mesmo envio", mas exige tabela, expiração e mudança de cliente.
5. **Procedência de sucesso na mesma transação (Q5).** Hoje a falha ao gravar `event_logs` não derruba o envio (`rf:411-418`). Dentro da transação, a falha do log desfaz tudo. Preferem esse "tudo ou nada" rígido, ou manter o log fora da transação com perda possível de procedência?
6. **Fronteira de confiança da impressão digital (Q6).** O banco não verifica a impressão do questionário calculada pelo servidor. Aceitam isso (a função só é chamável pelo servidor), ou querem guardar a impressão por versão numa tabela e conferir no banco, com a implementação do cálculo em SQL (risco de divergência com TypeScript)?
7. **Relógio do prazo (Q7).** Confirmam o relógio do banco como único, inclusive para `completed_at`? Isso muda o `completed_at` de "instante do Node" para "instante do commit da transação" (`now()`/`clock_timestamp()`; definir qual) e altera levemente a leitura de `docs/aplicar/boletim-da-coleta.sql`.
8. **Teto de segundas respostas (Q8).** Quantas submissões em conflito por `(evento, e-mail)` o sistema aceita antes de recusar? Hoje não há limite; um atacante com o código do evento enche a mesa de decisão.
9. **Limite de frequência (Q9).** A rota não tem nenhum (outras rotas do projeto têm um limitador em memória, `app/api/nps/route.ts:13`, ineficaz em ambiente sem estado). Há apetite para limite na borda (Vercel) ou por variável, como parte desta entrega ou em separado? Quais são os orçamentos de latência e de espera por trava que o dono aceita?
10. **Janela de rollout (Q10).** Em que evento e em que data a flag é ligada pela primeira vez, dado o congelamento do pacote e a coleta do Marco Zero? Quem autoriza a aplicação da 033 em produção (regra "nominal" do projeto)?
11. **Destino do caminho antigo (Q11).** Após quanto tempo sem divergência o caminho em TypeScript é retirado, e o que acontece com `receber-formulario.test.ts` (reaproveitar como suíte de contrato dos dois)?
12. **Exceção 1 do manifesto.** O fluxo antigo com login ainda grava depois do prazo. Esta proposta **não** o resolve; a função só fecha o formulário público. Querem tratar essa lacuna junto (exige policy ou gatilho próprio) ou manter separada?
13. **Texto do boletim (Q13).** Concordam em redefinir "registrados sem conclusão" como alarme após a mudança, e em acrescentar uma verificação de que nenhum participante criado pelo formulário público existe sem as cinco etapas?
