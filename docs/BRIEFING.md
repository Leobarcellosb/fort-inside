# Fort Inside → Marco Zero — briefing completo

Documento de transferência de contexto. Escrito para outro modelo/pessoa assumir o
projeto sem precisar reconstruir o raciocínio.

> **Credenciais e dados pessoais foram deliberadamente omitidos.** Chaves de API,
> service role key, nomes e e-mails de participantes e feedback nominal não entram
> aqui. Números agregados sim.

---

## 1. O produto

**Fort Inside** é uma imersão presencial conduzida por Yuri Fortes. Grupo pequeno
(8 a 20 pessoas), percurso físico por uma casa — Portão, Entrada, Sala, Cozinha,
Varanda, Suíte — e em cada cômodo o host libera uma etapa de um quiz no celular do
participante. No fim, uma IA gera um documento personalizado, o *Mapa da Sua Próxima
Construção*, revisado pelo host antes de ser entregue por link e PDF.

**Marco Zero** (Movimento Geração Preparada) é a **evolução** desse produto, não um
produto paralelo. Mudanças estruturais:

- Formulário **pré-evento assíncrono**: abre 2 dias antes, janela de 24h, autopreenchido.
- Dois instrumentos embutidos: **perfil comportamental de 4 eixos** e os **7 Elementos
  da Vida Plena**.
- Três entregáveis: one-pager por participante, documento de **DNA coletivo** para o
  host, e um documento de direcionamento pós-evento.
- Atividades manuscritas durante o evento (sem celular), escaneadas depois — o *Mural
  do Futuro*.
- Escala maior: ~50 participantes.
- Identidade visual própria (Geração Preparada, não Yuri Fortes).

---

## 2. Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack). **Atenção:** nesta versão `middleware.ts` virou `proxy.ts`, exportando `proxy` e `proxyConfig`. |
| Linguagem | TypeScript strict |
| Banco / Auth | Supabase (Postgres + RLS + Auth) |
| UI | Tailwind v4, shadcn/ui (19 componentes), Base UI, Radix |
| IA | `@anthropic-ai/sdk` direto (não AI SDK), modelo `claude-opus-5` |
| PDF | `@react-pdf/renderer`, render server-side |
| Deploy | Vercel |
| Testes | vitest (introduzido agora, só cobre o motor de scoring) |

Sem ESLint configurado — `next lint` foi removido no Next 16 e nada substituiu.

### Mapa do código

```
app/(participant)/   join/[eventCode], quiz/[stageId], waiting, prognostic/[token]
app/(admin)/         events, events/new, events/[id], .../dashboard, .../review,
                     nps, settings, login
app/api/             join-event, generate-prognostic, batch-process, generate-pdf,
                     prognostic-status/[token], nps, knowledge-base,
                     prognostics/[id], admin/events/[eventId], admin/logout
lib/ai/              generate-prognostic.ts (núcleo), prognostic-prompt.ts
lib/pdf/             render-prognostic-pdf.ts
lib/scoring/         marco-zero.ts + testes (novo)
lib/supabase/        client.ts (anon), server.ts (SSR), admin.ts (service role)
lib/auth/            require-admin.ts
supabase/migrations/ 001 a 010
```

Tabelas: `events`, `participants`, `quiz_stages`, `quiz_responses`, `prognostics`,
`event_logs`, `knowledge_base`, `nps_responses`, `participant_scores`.

---

## 3. O que os dados reais dizem

Esta é a parte mais valiosa do documento. Tudo abaixo foi **medido** no evento real
(FORT26, 12 inscritos, 10 concluíram), não estimado.

### O quiz era longo demais

| | |
|---|---|
| Perguntas dissertativas | 13 de 14 |
| Caracteres obrigatórios somados | 1.140 |
| Escrita mediana por participante | ~2.760 caracteres (~460 palavras) |
| Duração do quiz, 1º ao último envio | **mediana 140 min**, mais lento 158 min |

Numa imersão de 4 horas, o quiz consumia mais da metade do tempo do host.

### Havia fadiga mensurável

Escrita mediana por etapa: 520 → **587** → 415 → 405 → **349**. Queda de 40% do pico
até a última etapa — que é justamente a que alimenta o plano de 30 dias do
entregável. O input mais importante chegava mais exausto.

### O mínimo de caracteres nunca puxou profundidade

Em **todas** as etapas as pessoas escreveram 2 a 3 vezes o mínimo exigido (etapa 3:
587 escritos contra 180 exigidos). Conclusão: o piso não aumentava profundidade — ele
transformava uma resposta curta e honesta em erro vermelho na tela e cobrava pedágio
de quem já tinha dito o que tinha a dizer. **Removido.**

### A única múltipla escolha era vazia

Pergunta: "o que você sente que mais precisa?" com opções abstratas.

```
"Direção"       5x  →  trilhas atribuídas: Direção×4, Exploração×1
"Clareza"       3x  →  Direção×2, Exploração×1
"Ambiente"      0x  →  (e a trilha "Aproximação" foi atribuída 0x)
```

Dois achados: a pergunta praticamente **escolhia a trilha** em vez de diagnosticar, e
"Ambiente" nunca foi marcada porque admitir que precisa de ambiente é admitir
publicamente que não se tem rede. Custo social alto demais. Resultado: uma das cinco
trilhas do produto nunca foi usada.

A correção foi trocar rótulos abstratos por **comportamento observável**: "a última
pessoa relevante que você conheceu nos últimos 6 meses — como aconteceu?" mede a mesma
coisa sem obrigar ninguém a se declarar sem rede.

### As trilhas colapsaram

10 prognósticos: Direção×7, Exploração×2, Aceleração×1, **Aproximação 0, Sessão
Privada 0**. Uma taxonomia de 5 funcionando como 1,5. Causa provável: a IA escolhia a
trilha lendo prosa, e prosa de 12 jovens no mesmo contexto soa parecida.

### NPS (n=4, todos 10/10)

O que marcou: 2 de 4 citaram **a casa / o imóvel**, 2 de 4 citaram **o Yuri**. Zero
citaram o quiz, o prognóstico ou o Mapa — o entregável que todo o app existe para
produzir não foi lembrado espontaneamente por ninguém.

O que melhorar: 3 de 4 falaram de **tempo e clareza de expectativa**, não de conteúdo.
Um comentário relata que *pessoas não foram ao evento por não entenderem o que era*.

Implicação estratégica: havia uma proposta de reposicionar o produto removendo o
mercado imobiliário do centro. Os dados contradizem: **6 de 10 participantes citaram
explicitamente o mercado imobiliário ou a Fort como o motivo de terem ido**, e zero
citaram "clareza de carreira". O imóvel é o gancho de aquisição; a direção é o payoff.
Remover o gancho porque o payoff foi o que importou é erro de leitura.

### Profundidade do output da IA

Medida em 11 prognósticos: **mediana 1.268 palavras** (análise 215, áreas-chave 346,
plano 30 dias 244, práticas 225, frase de ativação 98, justificativa 108).

O prompt pedia "350 a 550 palavras". Era ignorado por 2,5×.

---

## 4. Decisões técnicas e o porquê

### Pontuar em código, não com IA

O questionário do Marco Zero já é um instrumento de 4 eixos bem formado:

- **24 itens Likert (q16–q39)**, exatamente 6 por eixo, escala 1–5 → 6 a 30 pontos
- **6 situacionais (q40–q45)** onde cada alternativa A/B/C/D pertence a um eixo
  diferente → 0 a 6 escolhas por eixo

Mapa situacional (verificado, cada questão cobre os 4 eixos):

```
q40: A=visao       B=execucao    C=relacao      D=integridade
q41: A=relacao     B=integridade C=visao        D=execucao
q42: A=execucao    B=visao       C=integridade  D=relacao
q43: A=integridade B=execucao    C=relacao      D=visao
q44: A=visao       B=relacao     C=execucao     D=integridade
q45: A=relacao     B=execucao    C=integridade  D=visao
```

Isso dá **duas medidas independentes**: como a pessoa *se avalia* (Likert) e como ela
*age sob pressão* (situacionais). O diagnóstico mais forte não é nenhuma das duas — é
a **divergência**. Quem se pontua alto em Execução mas escolhe sempre a alternativa de
Relação tem autoimagem desalinhada da prática.

Pontuar em código garante consistência entre participantes, que é o que torna o DNA
coletivo possível: "7 pessoas com perfil X" vira `count()`, não palpite do modelo. A IA
entra só para **narrar**, nunca para pontuar.

Cuidado herdado: resposta faltante conta 0 e entra num array `incompleto`. Numericamente
quem pulou 6 itens fica igual a quem respondeu 1 em tudo. **A camada de narrativa tem
que ler `incompleto`** antes de afirmar qualquer coisa — dizer "você pontuou 0 em
Integridade" para quem não respondeu seria falso com cara de diagnóstico.

### Versionamento de quiz

`quiz_stages` era **global**: os ids 1–6 são do Fort Inside e `quiz_responses.stage_id`
tem FK para eles. Trocar o conteúdo da tabela reinterpreta todo o histórico — isso
aconteceu em produção e embaralhou as respostas de um participante, que passaram a ser
pareadas com perguntas diferentes das que ele viu.

Solução: `quiz_version` em `events` e `quiz_stages` + `stage_number` (ordem dentro da
versão) + **`questions_snapshot`** em `quiz_responses`, que congela o enunciado exibido.
Fort Inside é a v1, Marco Zero será a v2 com ids a partir de 101.

### RLS: a armadilha menos óbvia do repositório

As policies de `quiz_responses` cravavam `stage_id <= current_stage`. Funcionava **por
acidente**, porque os ids 1–6 também são a ordem das etapas. Com ids 101+ nenhum envio
passaria, e no modo assíncrono não existe etapa liberada.

Detalhe crítico: **quem grava é o browser com a chave anônima**, não o service role. O
RLS governa esse caminho de verdade, não é rede de segurança decorativa.

A trava virou condicional: `live` mantém o portão comparando `stage_number`; `async` só
confere a janela temporal. Em ambos, o `quiz_version` da etapa tem de bater com o do
evento. `stage_number` nulo nega a escrita (NULL derruba o `exists`).

### Modelo e parâmetros da IA

Medido no mesmo participante real, mesmo prompt, mesmo schema:

| | Tempo | Palavras | Tokens de saída |
|---|---|---|---|
| `effort: high` | 147s | 1.303 | 10.749 |
| `effort: medium` | **63s** | 1.280 | 3.931 |

2,3× mais rápido com a mesma profundidade. O `high` gastava ~8.700 tokens de
raciocínio que não apareciam no texto. Custo por participante: ~$0,37 → ~$0,15.

Fast mode (`speed: "fast"`) foi testado e **descartado**: retorna 429, tem pool de rate
limit próprio sem capacidade na organização.

Configuração atual: `claude-opus-5`, `thinking: adaptive`, `effort: medium`,
`max_tokens: 32000` com streaming, structured outputs, system prompt cacheado
(`cache_control: ephemeral` — ganho grande no lote, já que o prompt é idêntico entre
participantes).

### Cardinalidade de array não é imposta pelos structured outputs

Armadilha que custou três falhas de 98 segundos em produção. A API **repassa**
`minItems`/`maxItems` ao modelo como dica mas **não os impõe** ("complex array
constraints" não são suportadas). Um `.min(3)` no schema Zod nunca produz mais itens —
só transforma uma geração pobre em geração nenhuma. Pisos foram para `min(1)`; o
tamanho desejado é pedido no prompt, que é onde funciona.

---

## 5. Falhas de segurança encontradas e corrigidas

Todas estavam exploráveis em produção e foram confirmadas por requisição HTTP real.

1. **Takeover de conta de admin via `/api/join-event`.** A senha era
   `` `${email}::${event_code}` `` — e o código do evento está num QR público. Pior:
   quando o e-mail já existia, a rota **resetava a senha** e a devolvia no corpo da
   resposta. Bastava digitar o e-mail do admin no formulário de entrada de qualquer
   evento. Corrigido: senha aleatória (`randomBytes(24)`), recusa de reset em conta com
   `role=admin`, e `listUsers` paginado (o default de 50 quebrava a partir do 51º
   usuário).

2. **`/api/knowledge-base` sem autenticação nenhuma.** GET/POST/DELETE rodavam com
   service role e o proxy só cobre `/admin/:path*`. A metodologia proprietária inteira
   era legível, gravável e apagável por requisição anônima.

3. **O proxy checava sessão, não papel.** Todo participante recebe sessão Supabase ao
   entrar numa imersão, então passava por `/admin/*` — incluindo `/admin/nps`, que lê
   com service role e ignora RLS. Corrigido com `app_metadata.role === 'admin'`.

4. **Rotas de IA sem auth.** `generate-prognostic` e `batch-process` gastavam créditos
   Anthropic sem barreira; `generate-pdf` aceitava qualquer `prognostic_id`. O rate
   limit era um `Map` em memória — inútil em serverless, onde cada instância tem o seu.

5. **`nps_responses` com policy de INSERT para anon**, criada fora de migration. A anon
   key é pública (vai no bundle), então dava para gravar direto no PostgREST ignorando
   o rate limit da API. Removida.

Correção estrutural que habilitou o resto: geração e renderização foram extraídas para
`lib/ai/generate-prognostic.ts` e `lib/pdf/render-prognostic-pdf.ts`. Antes as rotas
faziam **self-fetch HTTP** umas nas outras, o que forçava os endpoints a ficarem
abertos, gastava uma invocação extra por participante e produzia um falso negativo (o
lote reportava "0 de N gerados" ao colidir com o rate limit do disparo automático).

---

## 6. Estado atual

**Em produção:** código novo deployado, falhas fechadas (verificado: `/api/knowledge-base`
→ 403, `/api/batch-process` → 403, `/admin/nps` anônimo → 307). Banco com quiz v3.

**Pendente de aplicação:** migration `010` (versionamento + RLS condicional +
`participant_scores`). Escrita, idempotente, testada em Postgres descartável com 8
cenários de policy. **Ainda não aplicada no banco de produção.**

**Construído e não aplicado ao Marco Zero ainda:** motor de scoring (`lib/scoring/`,
45 testes verdes).

**Fila:** quiz do Marco Zero na v2, fluxo assíncrono com janela de 24h, one-pager
individual, DNA coletivo, OCR do Mural do Futuro.

### Problemas abertos

- **`fort-inside.vercel.app` retorna 404 em toda página que consulta o banco**,
  inclusive nas que usam service role (que ignora RLS). Isso elimina problema de
  permissão. Ou essa não é a URL de produção real, ou as variáveis na Vercel apontam
  para outro projeto Supabase. **Não diagnosticado.**
- Eventos de teste `TEST` (status `live`) e `QATEST` (status `processing`) estão presos
  em estados ativos. A interface só permite deletar eventos em `draft` ou `completed`,
  então nenhum dos dois é removível pela UI.
- A entrega de prognóstico editado dispara a regeneração do PDF, mas se falhar o
  participante cai num polling de 120s que não resolve — existe botão manual como
  fallback.
- Os 4 eixos usam chaves internas `visao`/`execucao`/`relacao`/`integridade`. Os nomes
  de exibição ainda não foram definidos pelo cliente.
- Identidade visual da Geração Preparada ainda não recebida.

### Armadilhas para quem continuar

- **Next 16**: é `proxy.ts`, não `middleware.ts`. Leia `node_modules/next/dist/docs/`
  antes de assumir API.
- **`quiz_stages` é global.** Nunca edite as perguntas sem versionar, ou você reescreve
  a interpretação do histórico.
- **Acentuação em migration via copiar/colar**: um paste de UTF-8 interpretado como
  MacRoman gravou mojibake em produção. A solução que funciona é mandar o payload em
  **base64** e deixar o Postgres decodificar com `convert_from(decode(...), 'UTF8')` —
  ASCII puro no transporte, imune ao caminho.
- **`types/database.ts`** não declarava `knowledge_base` nem `nps_responses`, o que
  forçava dezenas de casts `as unknown as` que desligam a checagem de tipo em toda
  escrita no banco. Foi corrigido para essas duas; o padrão de cast ainda existe em
  vários lugares do código.
