# Prazo rígido v2 no banco (migration 032)

Trabalho pós-segunda. **Não faz parte do pacote de 24/10** e não foi aplicado em lugar
nenhum além de Postgres descartável. Aplicar ou reverter depende de autorização nominal do
proprietário.

- Migration: `supabase/migrations/032_prazo_rigido_v2.sql`
- Reversão: `docs/aplicar/032-reverter.sql`
- Prova: `supabase/provas/prazo-032.test.ts` (executor: `supabase/provas/rodar-032.sh`)

## O problema

A migration 010 deu ao fluxo com login uma tolerância de envio no modo assíncrono: quem abriu
a etapa até `form_closes_at - 15min` grava resposta até `form_closes_at + 15min`. Nenhuma
migration posterior (011 a 031) alterou as policies `quiz_responses_own_insert` e
`quiz_responses_own_update`, então essa era a regra vigente. O formulário público, sem login,
já recusa a partir de `form_closes_at` pelo relógio do servidor. Para o mesmo evento v2, um
caminho fechava no prazo e o outro continuava aberto por mais 15 minutos. É a exceção
conhecida 1 de `docs/aplicar/MANIFESTO-DO-PACOTE.md`.

## Inventário das escritas autorizadas

Levantado lendo as migrations 001 a 031 em ordem (sem a 030, reservada, e com a 028 fora do
pacote, que não mexe nestas tabelas) e conferido no catálogo de um banco descartável. A prova
`criterio 1` falha se o catálogo divergir desta tabela.

Participante = papel `authenticated` sem `app_metadata.role = admin`, que é o que o navegador
usa. Admin = `authenticated` com `is_admin()`. Servidor = `service_role`, que ignora RLS.

| Tabela | Operação | Quem consegue hoje (010 a 031) | Com a 032 |
|---|---|---|---|
| `quiz_responses` | INSERT | Participante, no próprio cadastro. Live: `stage_number <= current_stage`. Async: sessão aberta e `now() <= form_closes_at + 15min`. Versão da etapa igual à do evento. | Async v2 com prazo: recusa quando `now() >= form_closes_at`. Resto igual. |
| `quiz_responses` | UPDATE (e o ramo de update do upsert do app) | Participante, linha própria, mesma regra do INSERT na linha nova. | Async v2 com prazo: recusa a partir do prazo, olhando a linha antiga e a nova. |
| `quiz_responses` | DELETE | Ninguém pelo navegador (não há policy). Servidor apaga (exclusão de evento, revogação de importação). | Igual. |
| `participant_stage_sessions` | INSERT | Participante, só colunas `event_id, participant_id, stage_id, quiz_version`, no próprio evento. Async: até `form_closes_at - 15min`. Live: etapa liberada. Admin também (policy de admin). | Igual (já fecha antes do prazo). |
| `participant_stage_sessions` | UPDATE, DELETE | Ninguém pelo navegador (sem privilégio). `started_at` vem só do banco. | Igual. |
| `participants` | INSERT | Qualquer usuário autenticado, com `user_id` próprio, em **qualquer evento** e com **qualquer coluna**, inclusive `completed_at`. | Recusado em evento async v2 depois do prazo. Antes do prazo continua (achado A1). |
| `participants` | UPDATE | Participante, só `full_name, phone, course_or_moment` da própria linha. | Igual (não é admissão e não entra na impressão digital do processamento). |
| `participants` | DELETE | Só admin (apaga as respostas em cascata). | Igual. |
| `events` | INSERT, UPDATE, DELETE | Só admin (`events_admin_write`). Participante não move o prazo. | Igual. |
| `prognostics`, `participant_scores`, `event_logs`, `knowledge_base`, `nps_responses` | escrita | Só admin. | Igual. |
| `quiz_stages` | escrita | Ninguém pelo navegador (sem policy de escrita). | Igual. |
| Tabelas das migrations 018 a 029 (fila, presença, importação, livros) | escrita | Ninguém pelo navegador: privilégio revogado de `anon` e `authenticated`. | Igual. |
| Funções `importacao_externa_aplicar` e `importacao_externa_revogar` | EXECUTE | Executáveis por `authenticated` (SECURITY INVOKER, sem revoke), mas falham fechadas: o participante não tem privilégio nas tabelas externas (provado, 42501). | Igual. |
| Servidor (`service_role`) | tudo acima | Formulário público, `/api/complete-quiz`, entrada por e-mail, importação, regularização, fila, prognóstico. | Igual: não é alcançado pela RLS. |
| Funções SECURITY DEFINER do dono `postgres` | escrita | Gatilho da sessão (010), início do processamento (023), regularização (029), exclusão de evento. | Igual: o dono das tabelas ignora RLS e não há FORCE. |

## O que a 032 muda

Três policies **restritivas** (combinadas com AND sobre as permissivas, então só tiram acesso,
nunca dão). Valem quando o evento tem `mode = 'async'`, `quiz_version >= 2` e
`form_closes_at` definido:

1. `quiz_responses_prazo_rigido_insert`: resposta nova recusada a partir de `form_closes_at`.
2. `quiz_responses_prazo_rigido_update`: reescrita recusada a partir de `form_closes_at`. Como
   olha a linha antiga e a nova, também impede tirar uma resposta do evento encerrado mudando
   `participant_id` para o cadastro da mesma pessoa em outro evento (isso passava antes).
3. `participants_prazo_rigido_insert`: autocadastro pelo navegador num evento v2 encerrado.

O relógio é `now()` do Postgres. `form_closes_at` é o primeiro instante recusado, a mesma regra
do formulário público (`agora >= form_closes_at`). Nenhum horário enviado pelo cliente entra
na decisão.

O que **não** muda, de propósito:

- A espera de 15 minutos antes do processamento (`jobs_iniciar_assincrono`, 900 segundos, e a
  quiescência da 023). Proibir admissão nova e drenar operação em voo são problemas
  diferentes: um envio do formulário público aceito antes do prazo pode terminar de gravar
  depois dele, e a espera continua existindo para isso.
- As policies permissivas da 010. Com elas, eventos live (qualquer versão) e async v1
  continuam exatamente como antes, inclusive a tolerância de 15 minutos do async v1.
- A abertura de etapa, que já recusa a partir de `form_closes_at - 15min`.
- Evento async v2 sem `form_closes_at`: o banco continua tratando como janela sem fim.

## Evidência (prova em Postgres descartável)

Imagem `public.ecr.aws/supabase/postgres:17.6.1.106`, a mesma do `scripts/drift/reference-db.sh`,
com as migrations 001 a 031 (sem a 028) e a 032. Resultado: **24 de 24 passaram**, e de novo
24 de 24 com a 028 aplicada (`--com-028`).

| Critério | Testes |
|---|---|
| 1. Inventário | `criterio 1`: policies de escrita vigentes iguais à tabela acima; a 032 só acrescenta restritivas e as permissivas da 010 ainda contêm os 15 minutos; privilégios por coluna; idempotência. |
| 2 e 4. Prazo pelo relógio do banco | um microssegundo antes grava e no prazo recusa (INSERT, UPDATE, upsert); fronteira igual à de `prazoDoFormulario`; janela antiga: **antes da 032** gravava em T+1us, T+5min, T+14min59s e T+15min e recusava em T+15min+1us, **depois da 032** recusa nos quatro; sessão aberta 2h antes conclui na reta final e a partir do prazo não grava, não reescreve e não reabre; horários do cliente (`submitted_at`, `started_at`, prazo do evento, claims inventados, fuso) não mudam nada; relógio real com prazo comitado 5 minutos atrás. |
| 3. v1 preservado | live v1 com `form_closes_at` vencido continua gravando a etapa liberada; async v1 mantém a tolerância (T+5min e T+15min gravam, T+15min+1us recusa); live v2 segue `current_stage`; v2 dentro do prazo abre, envia e corrige. |
| 5. Resposta alheia e outro evento | A não insere, não reescreve, não faz upsert e não apaga a resposta de B (com controle positivo); não abre sessão em evento alheio nem em nome de B; não muda o próprio `event_id`; mover resposta do evento encerrado para outro evento passava antes e não passa depois; autocadastro em evento v2 encerrado passava antes e não passa depois; funções de importação falham fechadas. |
| 6. Servidor e processamento | catálogo: `service_role` e o dono ignoram RLS, sem FORCE, funções SECURITY DEFINER pertencem ao dono; depois do prazo o servidor grava, corrige, cadastra e conclui, e o gatilho da sessão continua marcando `submitted`; as policies novas estão só em `quiz_responses` e `participants`. |
| 7. Espera de 15 minutos | em T+5min a escrita do participante já é recusada e `jobs_iniciar_assincrono` ainda responde `coleta_aberta` com limite T+15min; a assinatura continua com 900 segundos; depois de T+15min enfileira os dois participantes. |

Regressão das provas existentes contra banco com a 032: `lib/erros/provas/corrida-fechamento`
13 de 13; `lib/importacao/provas/importacao-externa` e `corrida-aplicacao` 25 de 25 (banco
novo). Falhas que já existem **sem** a 032, idênticas no banco de comparação: `fila-postgres`
critério 6 (a semente de `scripts/db-security/_seed.sql` entrega prognóstico sem
`final_content`, recusado pela 025), `regularizacao-http` (11) e `decisao-http` (1), cujas
sementes usam um prazo de formulário que já passou na data de hoje.

### Como rodar a prova

Container próprio, criado e removido pelo script:

```
bash supabase/provas/rodar-032.sh
bash supabase/provas/rodar-032.sh --com-028
```

Contra um banco local já preparado (001 a 031 sem a 028, mais a 032; nunca a porta 54732):

```
PRAZO_PROVA_URL="postgresql://postgres:SENHA@127.0.0.1:PORTA/postgres" \
  npx vitest run --config supabase/provas/vitest.prova.config.ts --reporter=verbose
```

Sem `PRAZO_PROVA_URL` o arquivo é pulado e `npx vitest run` continua verde.

## Plano de implantação

1. **Quando**: depois de segunda, fora de qualquer janela de coleta v2 aberta. `create policy`
   pega trava exclusiva curta em `quiz_responses` e `participants`; não aplicar nos minutos
   finais de uma coleta.
2. **Prova antes**: `bash supabase/provas/rodar-032.sh` (e `--com-028`, se a 028 tiver sido
   aplicada). Tem de terminar em `032: PROVADO`.
3. **Preflight no alvo**, só leitura: conferir que não existe policy restritiva nessas duas
   tabelas e que as permissivas são as do inventário.

   ```
   select tablename, policyname, permissive, cmd from pg_policies
    where schemaname = 'public' and tablename in ('quiz_responses', 'participants')
    order by 1, 2;
   ```

4. **Aplicar** `supabase/migrations/032_prazo_rigido_v2.sql` (uma transação, só DDL de policy,
   não toca dado, idempotente).
5. **Conferir**: a mesma consulta mostra as três policies `*_prazo_rigido_*` como
   `RESTRICTIVE`.
6. **Atualizar** a exceção conhecida 1 do manifesto, dizendo que o caminho com login passou a
   fechar no prazo para eventos async v2.

## Plano de reversão

1. Rodar `docs/aplicar/032-reverter.sql`. Apaga as três policies; as permissivas da 010 nunca
   foram alteradas, então o banco volta exatamente ao comportamento anterior. Não toca dado.
2. Conferir que a consulta do preflight não mostra mais nenhuma policy `*_prazo_rigido_*`.
3. Quando reverter: qualquer recusa no fluxo live, no async v1 ou no v2 **antes** do prazo. A
   prova já cobre esses casos; recusa ali indicaria diferença entre o alvo e o descartável.

A reversão foi exercitada na prova (dentro de transação, nos testes que comparam antes e
depois) e de verdade no banco descartável, com a 032 reaplicada em seguida.

## Achados fora do escopo (reportados, não corrigidos)

Fechar qualquer um destes muda contrato de produto ou de privilégio, então ficam para decisão.

- **A1. Autocadastro em evento alheio antes do prazo.** `participants_own_insert` só exige
  `user_id = auth.uid()`, e `authenticated` tem INSERT de tabela em `participants`, com todas
  as colunas. Um usuário autenticado se insere em qualquer evento, inclusive com
  `completed_at` preenchido, o que o coloca entre os elegíveis do processamento. Nenhum
  caminho do app usa isso (entrada e formulário gravam com `service_role`). Correção
  sugerida: migration própria revogando INSERT de `participants` para `anon` e
  `authenticated`. O teste `ACHADO` registra o estado atual e passa a falhar quando for
  corrigido.
- **A2. Conclusão depois do prazo.** `/api/complete-quiz` grava `completed_at` com
  `service_role` e relógio do Node, sem olhar o prazo. Quem já tinha todas as respostas antes
  do prazo consegue marcar a conclusão depois. Não é resposta nova, mas muda o conjunto de
  elegíveis (a 023 já registra que essa pessoa entra ao reprocessar). Fechar exige mudar a
  rota.
- **A3. A tela ainda descreve a tolerância para v2.** `components/features/participant/janela-da-etapa.ts`
  mantém a fase de tolerância de 15 minutos. Com a 032 o banco recusa nesse intervalo para v2;
  a tela trata a recusa sem erro cru, mas pode mostrar a fase errada antes de tentar.
- **A4.** `authenticated` tem INSERT e UPDATE nas colunas `origem`, `external_submission_id` e
  `importacao` de `quiz_responses` (privilégio padrão da plataforma).
- **A5.** Evento async v2 sem `form_closes_at` não fecha no banco, enquanto o formulário público
  recusa como prazo indeterminado.
