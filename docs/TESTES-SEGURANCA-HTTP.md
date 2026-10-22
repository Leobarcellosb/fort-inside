# Testes de segurança da camada HTTP

Suíte de regressão que prova, por requisição HTTP real, que as rotas historicamente
vulneráveis recusam quem não deve passar **e** que o administrador e o participante
legítimos continuam funcionando. Complementa a suíte de RLS (que testa o banco): esta
testa o app.

As cinco falhas que motivaram a suíte foram corrigidas à mão e verificadas por requisição
manual. Isso prova que estavam fechadas naquele momento, não que continuam. Esta suíte é
o que impede alguém de reabri-las sem ver o teste ficar vermelho.

## Como rodar

Pré-requisito: stack Supabase local no ar com as migrations aplicadas (`npm run db:local:up`).
Não precisa de reset entre rodadas: cada rodada cria dados com sufixo único e apaga tudo ao fim.

```bash
bash scripts/test-seguranca-http.sh            # suíte completa (~30 s). Exit 0 só se tudo passar.
bash scripts/test-seguranca-http.sh 1,5        # só os cenários 1 e 5 (o cenário 0 sempre roda)
bash scripts/test-seguranca-http-sensibilidade.sh        # teste de sensibilidade (~1,5 min)
bash scripts/test-seguranca-http-sensibilidade.sh m1 m5  # só algumas mutações
```

Com os scripts npm sugeridos (ver fim do documento): `npm run test:seguranca-http` e
`npm run test:seguranca-http:sensibilidade`.

`SEG_HTTP_MANTER=1` preserva o diretório de trabalho (logs de build e do app) para depurar.

## O que o harness faz

1. Clona o working tree para um diretório temporário **sem `.env*`**. O `.env.local` do projeto
   aponta para o Supabase de produção e para a chave real da Anthropic; o clone nunca os vê.
2. Faz `next build` + `next start` (modo de produção) do clone, com o ambiente injetado
   explicitamente: Supabase **local**, `ANTHROPIC_API_KEY` **falsa** e `ANTHROPIC_BASE_URL`
   apontando para o canário (abaixo). Nunca toca o `.next` nem a porta do dev server de quem
   está desenvolvendo.
3. Prova o isolamento antes de testar: uma sonda carregada dentro do processo do servidor
   (`tests/seguranca-http/sonda-ambiente.cjs`) grava o ambiente real do app e o script aborta se
   o Supabase não for local ou se a chave não for a falsa. Exemplo de saída:
   `[isolamento] ambiente real do processo do app: SUPABASE_URL=http://127.0.0.1:54731 | ANTHROPIC_BASE_URL=http://127.0.0.1:54923 | ANTHROPIC_API_KEY=sk-ant-FALSA-segur...`
4. Roda `tests/seguranca-http/suite.mjs`, que recusa rodar se `SUPA_URL` não for localhost.
5. Mata só os processos que subiu (PIDs rastreados) e apaga o clone.

### Canário da Anthropic: como se prova que nenhum token foi gasto

`tests/seguranca-http/canario-anthropic.mjs` é um servidor local que faz o papel de
`api.anthropic.com`. O SDK só fala com ele (`ANTHROPIC_BASE_URL`), então nada sai da máquina, e
cada requisição que chega é contada. "Nenhuma chamada ao modelo" vira um número verificável:

- **Cenários 3 e 4 (negativos):** a contagem do canário tem que ser **0**. A vítima do cenário 4
  é um participante com as 6 etapas do quiz completas; qualquer brecha de autorização chegaria
  de fato ao modelo e o canário contaria. Ou seja, o 0 prova que a recusa vem **antes** do
  trabalho caro.
- **Controle positivo (cenário 0):** um POST direto no canário tem que contar 1, senão a
  contagem 0 dos outros cenários não valeria nada.
- **Cenário 6 (legítimo):** o participante dono gerando o próprio prognóstico, e o admin
  processando o lote, têm que contar exatamente 1 cada. O canário responde com um stream SSE
  válido, então o fluxo roda ponta a ponta sem custo.
- Como a chave do app é falsa, uma recusa que viesse do SDK seria um erro de autenticação da
  Anthropic. O cenário 4 verifica que todas as recusas têm o corpo `{"error":"Não autorizado"}`
  do próprio app.

## Cenários

Cada linha da saída traz `ator`, `ação`, `esperado` e `obtido`. Formato:

```
[PASS] C2.05 | ator: PARTICIPANTE-A (...) | ação: GET /api/knowledge-base (ler) | esperado: recusa de autorização (401/403) e corpo sem o conteúdo protegido | obtido: recusa 403 ("Não autorizado")
```

**Identidades**, todas reais (login com senha, cookie no formato do `@supabase/ssr`):

| Identidade | Como é criada |
|---|---|
| ANÔNIMO | sem cookie |
| PARTICIPANTE-A / B | pelo fluxo real `POST /api/join-event` + login com a senha devolvida |
| FORJADOR | usuário logado com `user_metadata.role=admin` e **sem** `app_metadata` (o papel que um usuário consegue se atribuir sozinho) |
| ADMIN | `app_metadata.role=admin`, criado via GoTrue admin |
| ADMIN-VÍTIMA | outro admin, alvo do ataque de join-event |

| # | O que prova |
|---|---|
| 0 | Pré-condições anti falso verde: servidor responde 200 em `/admin/login`; canário conta; o app escreve no banco local; as 4 sessões existem. |
| 1 | ANÔNIMO, PARTICIPANTE-A e FORJADOR em 8 caminhos de `/admin/*` recebem redirect para `/admin/login`, nunca a página. Seguir o redirect cai no login com 200 (sem laço). |
| 2 | ANÔNIMO, PARTICIPANTE-A e FORJADOR em GET, POST (JSON e multipart) e DELETE de `/api/knowledge-base`: 401/403, corpo sem o conteúdo protegido, e **verificação no banco** de que a linha sentinela não foi apagada nem alterada e nenhuma linha invasora foi criada. |
| 3 | `/api/batch-process` recusado para os três; evento continua `live`; canário em 0. Extras: `DELETE /api/admin/events/:id` (com o código de confirmação correto) e `PATCH /api/prognostics/:id` recusados, com verificação de que nada mudou no banco. |
| 4 | `/api/generate-prognostic` (vítima com quiz completo) e `/api/generate-pdf` com `prognostic_id`: ANÔNIMO, PARTICIPANTE-B (de outro participante) e FORJADOR recusados; canário em 0; prognóstico da vítima inalterado. |
| 5 | `POST /api/join-event` com o e-mail de um admin (exato e em caixa alta, com o `event_code` público): 403 sem campo `password`; login com a senha **original** continua 200; `updated_at` do usuário no GoTrue idêntico antes e depois; `app_metadata.role` preservado; nenhum participante criado com aquele e-mail. |
| 6 | **Fluxo legítimo.** ADMIN: 7 páginas `/admin/*` com 200; CRUD da base de conhecimento (com efeito verificado no banco); PATCH de prognóstico; DELETE de evento descartável; `generate-pdf`; lote ponta a ponta (`total=1 succeeded=1`, 1 chamada ao canário). PARTICIPANTE: gerar o próprio prognóstico (200, 1 chamada ao canário), NPS, status do PDF, reentrar com o mesmo e-mail, novo e-mail inédito entrando e logando, e continuar sem acesso a `/admin`. |

### Regra de veredito

Numa checagem negativa, **só** vale como aprovação uma recusa de autorização: 401/403 em API, ou
redirect para `/admin/login` em página. Qualquer outra resposta é falha, e a saída nomeia o
tipo: `ACESSO CONCEDIDO 2xx`, `ERRO DE SERVIDOR 5xx (não é recusa de autorização)` ou
`resposta 4xx` diferente. Servidor fora do ar, build quebrado, exceção de rede ou cenário sem
nenhuma verificação também terminam em exit ≠ 0.

## Teste de sensibilidade

`scripts/test-seguranca-http-sensibilidade.sh` prova que a suíte detecta regressão, e não só que
hoje está verde. É um alvo separado da suíte normal.

1. **Controle:** roda a suíte completa no clone intacto. Se não passar, aborta (o resultado das
   mutações não seria interpretável).
2. Para cada mutação em `tests/seguranca-http/mutacoes.mjs`, remove **uma** verificação de
   autorização **no clone** (o checkout real nunca é tocado), refaz o build e roda o cenário
   correspondente. Ele **tem** que falhar. Se passar, a suíte está cega e o script sai com 1.
3. Uma mutação que não altera o arquivo, ou que não compila, aborta com erro e **não** conta
   como detecção.
4. Compara `git status` do checkout real antes e depois.

| Mutação | Cenário | O que remove |
|---|---|---|
| m1 | 1 | `proxy.ts`: passa a aceitar qualquer usuário autenticado em `/admin/*` (falha original 1) |
| m2 | 2 | guarda de admin dos 3 handlers de `knowledge-base` (falha original 2) |
| m3 | 3 | guarda de admin de `batch-process` (falha original 4) |
| m4 | 4 | checagem de dono do `participant_id` em `generate-prognostic` |
| m4b | 4 | guarda de admin do ramo `{prognostic_id}` de `generate-pdf` |
| m5 | 5 | recusa de admin existente em `join-event` (falha original 3) |

Resultado da última execução: as seis foram **DETECTADAS**, e o `git status` do checkout real ficou
idêntico antes e depois. Em m4 o canário registrou `1 chamadas` ao modelo (participante B gerando o
prognóstico de A): a mutação que "autoriza tarde" é pega pelo contador, não só pelo status.

## O que esta suíte NÃO cobre

- **Storage e Realtime estão desligados neste ambiente** (o Docker da máquina não sustentou os
  health checks). Consequência assumida: o cenário do PDF cobre a **autorização** da rota, não a
  gravação do arquivo. O render até o `upload` roda, o `upload` falha com `StorageApiError 503`, e o
  teste aceita isso explicitamente (C6.14, rotulado "só autorização - gravação NÃO validada"). Não
  se valida: PDF gravado no bucket `documents`, `pdf_url` público, nem a remoção de PDFs em
  `DELETE /api/admin/events/:id`. Nada de Realtime (presença, avanço de etapa ao vivo) é exercitado.
  Ligar Storage/Realtime só para inflar cobertura é proibido; quando o ambiente aguentar, a
  extensão natural é um passo no cenário 6 que valide o PDF no bucket.
- **Anthropic simulada.** Prova-se autorização e fluxo de dados, não a qualidade, o schema real nem o
  custo do modelo. O canário devolve um prognóstico sintético.
- **Modo de produção, instância única.** Rate limits em memória por instância
  (`generate-prognostic`, `nps`) não são testados entre instâncias.
- **Só a camada HTTP.** RLS direto no PostgREST é da suíte `scripts/db-security`. Também fora: XSS/CSRF,
  cabeçalhos de segurança, enumeração de IDs, rate limiting como defesa, o ramo público
  `{token}` de `generate-pdf` além de "token inexistente = 404", e as páginas do participante
  (`/quiz`, `/prognostic/[token]`).
- **Rotas não listadas.** Uma rota nova não entra sozinha na suíte: toda rota que gasta crédito,
  escreve com `service_role` ou lê dado de outro usuário precisa ganhar cenário (e uma mutação).

## Arquivos

```
scripts/test-seguranca-http.sh                  suíte normal
scripts/test-seguranca-http-sensibilidade.sh    teste de sensibilidade
scripts/_seguranca-http-common.sh               clone, build, start, isolamento (compartilhado)
tests/seguranca-http/suite.mjs                  os cenários
tests/seguranca-http/canario-anthropic.mjs      substituto local da API da Anthropic
tests/seguranca-http/mutacoes.mjs               mutações do teste de sensibilidade
tests/seguranca-http/sonda-ambiente.cjs         prova do ambiente real do servidor
```

Os testes ficam fora do `vitest` de propósito (extensões `.mjs`/`.cjs`; o vitest só inclui
`**/*.test.ts`): precisam de banco e servidor, e não devem quebrar `npm test`.

## Scripts npm sugeridos

```json
"test:seguranca-http": "bash scripts/test-seguranca-http.sh",
"test:seguranca-http:sensibilidade": "bash scripts/test-seguranca-http-sensibilidade.sh"
```
