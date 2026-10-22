# Teste de jornada completa (ponta a ponta, com um participante de verdade)

```bash
npm run db:local:up          # Supabase local com as 17 migrations
bash scripts/test-jornada.sh # exit 0 só se TODAS as verificações passarem
```

Não precisa de reset entre rodadas. Cada rodada cria dados com sufixo único e
remove tudo ao final; duas execuções seguidas passam.

## Por que esta suíte existe, se as unidades já passam

As peças deste fluxo têm teste de unidade e passam isoladamente. O defeito que
motivou esta suíte nasceu no **vão** entre elas: duas correções individualmente
corretas que, juntas, pararam o produto, e nenhuma suíte pegou.

O caso concreto, que esta jornada mede: a tela grava o **texto** da alternativa
situacional (`"A. Organizar o problema ..."`) e o motor de pontuação só aceita a
**letra** (`"A"`). Cada lado está certo. Se a normalização de borda
(`lib/scoring/achatar-respostas.ts`) falhar, o motor devolve `null`, trata como
"não respondido" e **metade do instrumento de 4 eixos desaparece sem erro
nenhum**: nenhuma exceção, nenhum 5xx, nenhum log vermelho. O documento só sai
mais pobre. É esse tipo de falha que só uma jornada inteira enxerga.

## O que a jornada percorre

| Etapa | O que acontece | Caminho exercitado |
|---|---|---|
| 0 | pré-condições | servidor vivo, canário enxerga, 17 migrations, seed v2 (52 perguntas), o app lê o mesmo banco |
| 1 | convidado pede o código | `POST /api/entrar/solicitar`; nenhuma credencial chega ao chamador; quem só pediu segue anônimo |
| 2 | obtém o código e autentica | `POST /auth/v1/admin/generate_link` (devolve `email_otp`, sem SMTP) + `POST /api/entrar/verificar` |
| 3 | responde as 5 etapas / 52 perguntas | upsert em `quiz_responses` pelo PostgREST com a chave anônima + JWT do participante, `on_conflict=participant_id,stage_id` — **o mesmo caminho da tela**, não insert por service_role |
| 4 | conclusão | `POST /api/complete-quiz`, que confere etapa por etapa no banco |
| 5 | pontuação e briefing | lê de volta o que **ficou gravado**, achata, pontua e monta o texto |
| 6 | fila | `POST /api/jobs/enfileirar` (admin) + ticks até drenar, pela sessão de admin e pela porta do agendador |
| 7 | entrega | o que o participante vê (`/api/prognostic-status`, `/prognostic/<token>`) e o que o host vê (`/api/jobs/status`, tela de revisão), incluindo a entrega pelo botão "Entregar" |

Uma pessoa, do convite ao documento. Cada etapa aparece nomeada na saída, com
ator, ação, o que se esperava e o que se obteve.

## As regras de veredito (e por quê)

**Toda negativa tem controle positivo ao lado, no mesmo ambiente.** "Tudo
negado" não é aprovação: pode ser o ambiente negando até o fluxo legítimo. Cada
recusa verificada aqui diz, no próprio texto, qual é o seu controle:

| Negativa | Controle positivo |
|---|---|
| escrita em `quiz_responses` sem JWT é recusada | a mesma escrita, com a sessão provada, grava (etapa 3) |
| código errado não autentica e não cria sessão | o código certo autentica e cria sessão (etapa 2) |
| escrita no `participant_id` do vizinho é recusada | as 5 escritas legítimas do dono |
| conclusão em nome de outro dá 403 | o dono conclui com 200 |
| participante não enfileira job (403) e anônimo não aciona tick (401) | o admin enfileira e aciona |
| participante não lê o prognóstico em `generated` | o mesmo token lê as 5 respostas dele; e depois da entrega, lê o documento |
| anônimo é redirecionado da tela de revisão | o admin recebe 200 com o nome do participante |

**Nada de falso verde.** Servidor fora do ar, exceção de rede, 5xx: falha. Etapa
que não produziu nenhuma verificação: falha (aparece no resumo). A jornada é
sequencial: se uma etapa não acontecer, ela para ali e diz qual e por quê — não
há `try/catch` que engula.

**Zero chamada à Anthropic, provado por contador.** O app sobe com
`ANTHROPIC_API_KEY` falsa e `ANTHROPIC_BASE_URL` apontando para o canário local
(`tests/seguranca-http/canario-anthropic.mjs`), e uma sonda dentro do processo
confere o ambiente real antes de a suíte começar (`seg_prova_isolamento`). O
canário tem **controle positivo** na etapa 0: um POST direto nele tem de elevar
a contagem para 1. Instrumento cego não vale como prova. Na etapa 6 a jornada
exige o contrário: a geração **tem** de ter chamado o canário, com
`model=claude-opus-5` no corpo — ou seja, foi o caminho de produção que rodou.

## Nova tentativa: onde é permitida, e por quê

Uma rodada morreu com `504 The upstream server is timing out` criando o usuário
admin — Kong/GoTrue do stack local engasgando, nada a ver com o produto. A
jornada falhou alto, o que é o comportamento certo, mas uma fixture instável não
pode fazer a suíte piscar no CI.

Regra adotada: **nova tentativa só nas chamadas que o harness faz por conta
própria** (semear fixture e inspecionar o banco com `service_role`,
`generate_link`, login por senha do admin), **só em 5xx ou exceção de rede**, no
máximo 3 vezes, e **cada tentativa é anunciada na saída** (`[aviso] ... nova
tentativa 2/3`). Nenhuma requisição do fluxo sob teste é repetida: lá, 5xx é
veredito e falha — é exatamente o que a jornada precisa enxergar. Ambiente
instável aparece na saída em vez de se esconder atrás de um verde.

Há um segundo caso, mais interessante. Noutra rodada, `GET /api/jobs/status`
respondeu **403 "Não autorizado"** com a mesma sessão de admin que, um segundo
antes, tinha sido aceita por `POST /api/jobs/enfileirar`. A causa é de produto:
`getAdminUser()` descarta o erro de `supabase.auth.getUser()`, então qualquer
engasgo do GoTrue vira `user === null` e a rota responde 403 — "não consegui
verificar" vestido de "não autorizado". Para a operação, indisponibilidade de
Auth fica indistinguível de falta de permissão.

A jornada trata isso pelo critério "uma recusa que não se repete depois de
renovar a sessão é ambiente; uma que se repete é veredito": as chamadas de admin
feitas pelo harness passam por `httpComoAdmin`, que em 401/403/5xx renova a
sessão e tenta **uma** vez. Se a segunda também recusar, a recusa chega inteira à
asserção e a jornada falha. Quando é absorvida, aparece como `[aviso]`, vira
ACHADO e é contada na linha `[ambiente]` do resumo. As negativas (participante,
anônimo) nunca passam por esse caminho: recusa esperada mede-se de primeira.

## Três categorias na saída, e a diferença entre elas

- **PASS/FAIL** — veredito. Define o exit code.
- **PENDÊNCIA** — peça que o produto **não tem**. Declarada com nome; a jornada
  não a simula nem finge sucesso. Hoje: one-pager, DNA coletivo, PDF (Storage
  desligado no stack local) e o briefing do Marco Zero não estar ligado ao
  documento gerado.
- **ACHADO** — fato **medido** nesta rodada que pede decisão humana e **não** é
  veredito, tipicamente porque depende da configuração do ambiente.
  Transformá-lo em falha faria a suíte medir o ambiente em vez do código.

O exemplo que justifica a terceira categoria: depois de `POST
/api/entrar/solicitar`, existe **1 linha em `auth.sessions`** para o convidado,
antes de qualquer código ser verificado. Medido: `admin.createUser` não cria
sessão; `/auth/v1/otp` cria sessão + refresh token quando
`GOTRUE_MAILER_AUTOCONFIRM` está ligado — que é o caso do stack local, onde não
há SMTP. A rota não entrega nada disso a quem chamou (verificado: sem
`Set-Cookie`, sem chave de credencial, sem nenhum JWT nos bytes da resposta, e a
requisição seguinte continua anônima), mas a linha existe no servidor. Então a
asserção dura é sobre **o que o chamador tem** e sobre o **delta** de sessões
(código errado: delta zero; código certo: delta ≥ 1), e a contagem absoluta é
registrada como achado.

## Como a jornada carrega o motor de pontuação

O `scripts/test-jornada.sh` compila `lib/scoring/{marco-zero,achatar-respostas,
briefing-marco-zero}.ts` **do mesmo clone que o app sob teste usa**, para
CommonJS num diretório temporário, e a jornada os carrega com `require`. É o
código de produção, não uma cópia: sabotar `lib/scoring` quebra esta suíte.

CommonJS de propósito — o fonte usa import relativo sem extensão
(`"./marco-zero"`), que o ESM do Node não resolve e o `require` resolve. A
alternativa seria reimplementar a pontuação dentro do teste, e aí ele não
estaria provando o código que roda.

## Prova de que a suíte detecta quebra

Sabotagem usada (a falha **silenciosa**, que é a perigosa): desligar o ramo de
normalização situacional em `achatarRespostas`, de forma que o texto da
alternativa chegue cru ao motor.

```diff
-      if (IDS_SITUACIONAIS.has(id)) {
+      if (false && IDS_SITUACIONAIS.has(id)) {
```

Resultado: **exit 1**, com 6 falhas, todas na etapa 5 e todas no ponto certo —
`incompleto = q40..q45`, contagens `visao=0 execucao=0 relacao=0 integridade=0`
(soma 0 de 6), eixo destacado nulo, cruzamento inconclusivo. Nada estourou em
nenhum outro lugar: o briefing continuou saindo, só encurtou de 1270 para 652
caracteres e passou a dizer "Nenhuma das seis situações foi respondida". É
exatamente o defeito que nenhum log denuncia. Restaurado o arquivo, verde de
novo.

## Rodar no CI

A suíte não exige interação humana: um comando, exit code. O job equivalente aos
que já existem em `.github/workflows/ci.yml` (não foi adicionado lá nesta
unidade de trabalho, para não mexer em arquivo fora do escopo):

```yaml
  jornada:
    name: Jornada completa (ponta a ponta)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      # inbucket NÃO é excluído: a jornada não depende de caixa de entrada (usa
      # generate_link), mas o GoTrue precisa subir inteiro.
      - name: Subir Postgres local e aplicar migrations
        run: supabase start --exclude storage-api,realtime,studio,imgproxy,edge-runtime,logflare,vector,supavisor
      - name: Jornada completa
        run: bash scripts/test-jornada.sh
```

Pré-requisitos do ambiente: `psql` no PATH (a jornada consulta o schema `auth`,
que o PostgREST não expõe) e `node_modules` instalado. O runner recusa rodar se
`SUPA_URL`/`DB_URL` não forem `127.0.0.1`/`localhost`, se o checkout estiver
linkado a projeto remoto (`supabase/.temp/project-ref`) ou se o ambiente real do
processo do app não apontar para o canário.

## O que a jornada NÃO cobre (declarado, não escondido)

- **One-pager e DNA coletivo**: não existem no código (só em `docs/BRIEFING.md`).
  A jornada entrega o documento que existe (`PrognosticView` via
  `/prognostic/<token>`) e declara a ausência dos outros dois.
- **PDF**: `/api/generate-pdf` depende de Storage, desligado no stack local
  (`supabase/config.toml`). A jornada confere `pdf_url` nulo e para aí.
- **E-mail de verdade**: o código vem de `generate_link`, não de uma caixa de
  entrada. Entrega de e-mail (Resend, domínio verificado) não é exercitada.
- **Modo `async` do evento** (`participant_stage_sessions`, janela de 24h): a
  jornada roda em `mode='live'`.
- **Mais de um participante**, concorrência de ticks e retomada por lease: isso
  tem prova própria em `lib/jobs/provas/fila-postgres.test.ts`. Aqui a fila é
  exercitada com um job real, de ponta a ponta.
- **Qualidade do texto gerado pela IA**: o conteúdo vem do canário, sintético e
  fixo. O que se prova é o encanamento (prompt montado, chamada feita, saída
  validada, documento gravado e entregue), não o que o modelo escreve.
- **A tela**: a jornada fala HTTP e PostgREST pelos mesmos caminhos que o
  navegador usa, e confere que as respostas passariam pela validação da própria
  tela (`problemasPelaRegraDaInterface`), mas não renderiza React nem clica.
