# Guard de drift de schema

Compara o que `supabase/migrations/` declara com o que um banco alvo realmente tem.

**Por que existe:** uma policy de INSERT anônimo em `nps_responses` foi criada à mão no
dashboard, direto em produção, e nunca esteve nos arquivos. Teste contra banco local
confirma as migrations, não o banco real, então a suíte ficava verde com produção aberta.

## Resultados

| Resultado | Exit code | Significado |
|-----------|-----------|-------------|
| `PASS`    | 0 | Alvo igual à referência construída das migrations. |
| `FAIL`    | 1 | Há diferença. Policy/grant para `anon`, `authenticated` ou `PUBLIC` não declarado aparece como `[CRITICO]` e nomeia policy e tabela. |
| `BLOCKED` | 2 | Alvo ou referência inacessível, inspeção incompleta, erro de uso ou erro interno. **Não é um atestado de integridade**: trate como pendência, nunca como verde. |

A última linha da saída é sempre `GUARD-DRIFT: PASS|FAIL|BLOCKED`.

## O que cobre

Por schema (`public` por padrão, `--schemas a,b` ou `DRIFT_SCHEMAS`):
tabelas/views/sequences, colunas (tipo, nullability, default, identity/generated),
RLS ligado/forçado por tabela, grants em tabelas, colunas, funções e schema, default
privileges, funções (assinatura, retorno, linguagem, `SECURITY DEFINER`, `search_path`
e hash do corpo).

Em **todos** os schemas de usuário: policies (nome, comando, permissiva/restritiva, papéis,
`USING`, `WITH CHECK`). Uma policy manual em `storage.objects` é tão grave quanto em `public`.

Papéis `anon`, `authenticated`, `service_role` e `authenticator`: atributos
(`BYPASSRLS`, superuser...) e memberships.

Diferença nos dois sentidos conta como FAIL: algo a mais no alvo (não declarado) e algo
declarado que sumiu (migration pendente ou objeto removido).

## Como funciona

1. A referência é um Postgres do Supabase descartável (Docker), onde as migrations são
   aplicadas em ordem. Ou você passa `--reference <url>` de um banco já construído assim.
2. `scripts/drift/introspect.sql` roda nos dois bancos e emite uma linha por objeto
   (via `pg_catalog`). As saídas são ordenadas e comparadas.
3. **Somente leitura no alvo:** a única coisa executada nele é esse arquivo, dentro de
   `BEGIN READ ONLY` (o servidor recusa escrita), só com `SELECT`, terminando em
   `ROLLBACK`. Nunca `--linked`, nunca `db reset`, nunca DDL.
4. Saída truncada, sem tabelas ou sem o sentinela final vira `BLOCKED`, não `PASS`.
   A URL com credenciais nunca é impressa.

## Como rodar

```bash
# Prova que o guard funciona (PASS, FAIL, BLOCKED e não-escrita). Só bancos locais.
npm run db:drift:test

# Contra um banco qualquer, com referência construída das migrations (precisa de Docker):
npm run db:drift -- --target "postgresql://usuario@host:5432/postgres"
```

### Contra produção, quando houver credencial

1. Copie a connection string de **Project Settings > Database** do Supabase
   (use a do *session pooler* se a direta for só IPv6).
2. Passe a senha por `PGPASSWORD` e a URL **sem** senha, para ela não aparecer na lista
   de processos nem no histórico:
   ```bash
   read -rs PGPASSWORD; export PGPASSWORD
   npm run db:drift -- --target "postgresql://postgres.<ref>@<host>:5432/postgres"
   ```
3. Não grave a URL em arquivo versionado nem em `.env.local`. O guard também aceita
   `DRIFT_TARGET_URL` e `DRIFT_REFERENCE_URL`.
4. **Primeira execução em produção:** espere ruído da plataforma (objetos que o Supabase
   gerencia e o Postgres local não tem). Triage cada linha: o que for legítimo e
   gerenciado vira filtro no guard; o que for manual e perigoso vira migration
   (`drop policy ...`) ou correção no dashboard. Só depois use como gate.
5. Rode antes de cada deploy de migration e periodicamente (cron/CI): drift acontece
   entre deploys, no dashboard.

Variáveis: `DRIFT_SCHEMAS`, `DRIFT_CONNECT_TIMEOUT` (8s), `DRIFT_RUN_TIMEOUT` (120s),
`DRIFT_PG_IMAGE` (imagem da referência efêmera).

## O que NÃO cobre

- **Estado declarado mas inseguro.** O guard prova "banco == migrations", não "migrations
  são seguras". Ver achados abaixo.
- Dados (linhas), índices, constraints, triggers, extensões, publications, tipos,
  donos (`OWNER`) de objetos, grants em objetos de outros schemas que não os escolhidos
  em `--schemas`.
- Buckets e configuração do Storage, Auth (providers, templates, JWT), Edge Functions,
  secrets, Realtime, settings do projeto: não são schema Postgres.
- Roles além dos quatro vigiados, `ALTER ROLE ... SET`, `pg_hba`.
- Postgres de versão major diferente entre referência e alvo pode deparsar expressões
  de policy diferente e gerar diferença espúria (o guard avisa). Use a imagem de
  `DRIFT_PG_IMAGE` na mesma major de produção.
- Mudança que acontece depois da inspeção (é um retrato, não um monitor contínuo).

## Achados da referência (fora do escopo do guard, mas relevantes)

Verificados no banco local construído das migrations 001 a 010, com `set role anon`:

- `delete_event_cascade(uuid)` é `SECURITY DEFINER`, sem checagem de papel no corpo, e
  `anon` tem `EXECUTE` (o `GRANT ... TO service_role` da 005 não revoga o `PUBLIC`/default
  do Supabase). Ela apaga evento, participantes e `auth.users` do evento.
- `participant_profiles` é view sem `security_invoker`, com `SELECT` para `anon`:
  expõe nome e status de prognóstico contornando o RLS.

Como estão declarados, o guard dá PASS; quem fecha isso é uma migration nova
(`revoke execute ... from public, anon, authenticated` e `security_invoker = true`).
