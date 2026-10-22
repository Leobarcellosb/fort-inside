# Testes de segurança da camada de banco

Suíte de regressão que prova, contra o Postgres **local**, que as falhas de segurança já
corrigidas continuam fechadas e que o fluxo legítimo do participante continua funcionando.
As correções anteriores foram verificadas à mão: isto as transforma em teste que roda sempre.

## Como rodar

```bash
npm run db:local:up        # banco local no ar (127.0.0.1:54732)
npm run db:security        # a suíte; exit 0 só se TODOS os cenários passarem
```

Exit code: `0` tudo passou; `1` alguma verificação falhou (a saída nomeia cenário, papel e o
que era esperado); `2` BLOCKED (ambiente inadequado, nada foi testado).

Não precisa de reset entre execuções: cada cenário roda em transação com `ROLLBACK`, e no fim
a suíte compara uma impressão digital do banco (contagens, policies, grants, funções) antes e
depois. Alvo diferente do padrão: `DB_SECURITY_URL=postgresql://...@127.0.0.1:PORTA/postgres`.

Recusas (exit 2): host que não seja `127.0.0.1`/`localhost`/`[::1]` (inclusive via `?host=`),
existência de `supabase/.temp/project-ref` (checkout linkado), banco sem o schema das migrations.
Nunca usa `--linked`.

## O que cobre

Papéis e claims são reproduzidos como o PostgREST faz (`set local role` + `request.jwt.claims`).

| # | Cenário | Papel | Esperado |
|---|---------|-------|----------|
| 1 | Base de conhecimento | `anon` | select/insert/update/delete em `knowledge_base` negados (inclusive sem claim algum) |
| 2 | NPS por fora da API | `anon`, `authenticated` comum | insert direto em `nps_responses` negado (volta da policy `"Anyone can submit NPS"`); `service_role` ainda grava |
| 3 | Recursos administrativos | `authenticated` sem `app_metadata.role=admin` | não lê respostas/prognóstico/pontuação de outro participante, não escreve em `events` nem `knowledge_base`, não lê NPS; `user_metadata.role=admin` não vale; admin real ainda consegue |
| 4 | `delete_event_cascade(uuid)` | `anon`, `authenticated` | camada (a) privilégio: sem EXECUTE (catálogo); camada (b) corpo: com GRANT simulado, ainda recusa com 42501 |
| 5 | View `participant_profiles` | `anon` | sem SELECT; `security_invoker=on`; com GRANT simulado a RLS ainda barra; participante só vê o próprio perfil |
| 6 | Participante legítimo | `authenticated` (participante) | lê as próprias respostas, insere etapa liberada, reenvia (UPDATE e upsert); NÃO insere etapa não liberada; passa a poder quando o evento libera |

O cenário 0 é um autoteste do próprio harness.

## Por que não dá falso verde

Toda negativa é classificada: `NEGADO (42501)` ou `NEGADO (0 linhas)` passam; `PERMITIDO` falha;
**qualquer outro erro (sintaxe, coluna inexistente, constraint) é `INCONCLUSIVO` e também falha**.
Cada sonda roda em sub-transação, então um erro nunca aborta a transação do cenário. Toda
negativa tem um **controle**: o mesmo comando como `service_role` precisa afetar >= 1 linha
(senão "0 linhas" poderia ser só tabela vazia). O cenário 0 prova esses mecanismos.

## O que NÃO cobre

- **Camada HTTP**: rate limit de `/api/nps`, autorização das rotas do Next, cookies/sessão, CORS.
  É outra unidade.
- Produção. Roda só no banco local, construído das migrations; drift de produção é o
  `npm run db:drift`.
- Policies de `events`/`participants` além do que os cenários tocam, o modo `async`
  (janela `form_opens_at`/`form_closes_at`) e o PostgREST em si (só o Postgres por baixo dele).
- Chamada **real** de função sem EXECUTE: no Postgres 17.6 do stack local (aarch64) isso derruba o
  servidor com SIGSEGV, então a camada (a) do cenário 4 é verificada pelo catálogo e a suíte nunca faz essa chamada.

## Acrescentando um cenário

Crie `scripts/db-security/cenario-N-*.sql` (copie um existente: `begin; \ir _lib.sql; \ir _seed.sql; ...; rollback;`)
e registre-o na lista `SCENARIOS` de `scripts/test-db-security.sh`. Use `pg_temp.negar(...)`,
`pg_temp.permitir(...)` e `pg_temp.afirmar(...)`; a massa de dados está em `_seed.sql`.
