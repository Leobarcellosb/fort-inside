# Ambiente de banco local

Postgres local, descartável e reproduzível, criado **só a partir de `supabase/migrations/`**.
Não toca em produção: não há link com projeto remoto e os scripts recusam rodar se houver
`supabase/.temp/project-ref` (sinal de `supabase link`).

## Pré-requisitos

Docker rodando, Supabase CLI, `psql` (só para o `verify`). Docker com pelo menos 4 GB de RAM
é o ideal; com 2 GB e outros stacks Supabase rodando, o start fica lento (ver "Limitações").

## Como usar

```bash
scripts/db-local-up.sh       # sobe o stack e aplica as migrations 001..N em ordem
scripts/db-local-reset.sh    # destrói e recria o banco do zero (idempotente, pode rodar N vezes)
scripts/db-local-verify.sh   # conta tabelas, policies RLS e lista tabelas com RLS (somente leitura)
supabase stop --no-backup    # desliga e descarta os dados
```

Endereços (portas escolhidas para não colidir com o Next em 3000 nem com outros stacks locais):

| Serviço  | Endereço                         |
|----------|----------------------------------|
| API      | http://127.0.0.1:54731           |
| Postgres | 127.0.0.1:54732 (`supabase status` mostra a URL completa) |

Para apontar o app para este banco, use a URL e as chaves de `supabase status` num
`.env.local` seu. Este repositório nunca grava essas chaves.

## O que o stack sobe

Postgres, Auth (GoTrue), PostgREST e o gateway. Ficam **desligados** em `supabase/config.toml`:
Studio, Realtime, Storage, Edge Runtime, Analytics e Inbucket. Para ligar algum, mude
`enabled = true` na seção correspondente (cada um exige mais memória do Docker).

## O que este ambiente NÃO garante

- **Não reproduz produção.** O schema vem das migrations; produção pode ter drift (alterações
  feitas direto no painel, dados, extensões, configurações). Já houve necessidade de
  `006_sync_production.sql` por causa disso.
- **Não é staging.** Não tem dados reais nem dados de teste (não há `seed.sql`); só o que as
  migrations inserem (ex.: etapas do quiz).
- **Sem Storage, Realtime e Studio por padrão.** Funcionalidades do app que usam upload de PDF
  ou canais realtime não funcionam contra este banco até esses serviços serem ligados.
- **Sem e-mail** (Inbucket desligado): fluxos de login por link/OTP não completam localmente.
- Migrations "passarem" aqui não prova que passam em produção: o banco local começa vazio.

## Limitações conhecidas

- Em máquina com Docker de 2 CPU / 2 GB e vários stacks Supabase rodando, os health checks de
  Storage, Realtime e Studio estouraram o tempo e o `supabase start` abortou (as migrations
  aplicaram normalmente). Por isso vêm desligados.
- Se o `start` falhar, o CLI derruba e descarta os volumes do stack; basta rodar `up` de novo.

## `supabase/setup.sql`

Script legado (6 tabelas, 12 policies), anterior às migrations 004 a 010 (não tem `knowledge_base`,
`nps_responses`, `participant_scores`, versionamento de quiz etc.). Não é usado por nada aqui e
**não é fonte de verdade**; as migrations são.
