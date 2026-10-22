# Aplicar as correções de segurança em produção (011 a 014)

Quatro migrations estão **escritas, validadas localmente e não aplicadas**. Este
documento é o procedimento para aplicá-las, e existe porque o caminho óbvio
(`supabase db push`) está **proibido** neste repositório agora — ver a seção
"A armadilha do push".

Quem autoriza é o dono do produto. Aprovação técnica não substitui essa
autorização, e nenhuma destas etapas deve ser executada sem ela.

## O que cada migration corrige

| Migration | Falha | Alcançável por |
|---|---|---|
| `011_fix_privilegio_anon.sql` | `delete_event_cascade` com `EXECUTE` aberto para `PUBLIC` e sem checagem de papel no corpo; view `participant_profiles` sem `security_invoker` e legível por `anon` | cliente anônimo, via PostgREST |
| `012_is_admin_sem_claim.sql` | `is_admin()` estourava erro de parse de JSON em vez de devolver `false` sem claim | qualquer caminho sem JWT; falha fechado, não é brecha |
| `013_delete_event_search_path.sql` | 7 referências não qualificadas dentro de função `SECURITY DEFINER` | quem puder criar objeto num schema que resolva antes |
| `014_participants_colunas_travadas.sql` | participante troca o próprio `event_id` e `completed_at`, contornando a trava de etapa e entrando na fila de geração de IA | qualquer participante autenticado, via PostgREST |

A `011` e a `014` são as que estão explorando hoje pela API normal. A `012` e a
`013` são endurecimento.

## Pré-requisito que ainda não foi cumprido

**Nada aqui está confirmado em produção.** As falhas foram confirmadas no banco
construído a partir das migrations, não no banco real. O primeiro passo é rodar o
guard de drift contra produção:

```bash
PGPASSWORD='<senha>' npm run db:drift -- --target 'postgresql://<usuario>@<host>:5432/postgres'
```

Três resultados possíveis, e eles mudam o plano:

- **PASS** — produção bate com as migrations. Então as quatro falhas estão lá,
  exatamente como descritas, e este procedimento vale como está.
- **FAIL** — existe algo em produção que as migrations não declaram. **Pare.**
  Triar o que é antes de aplicar qualquer coisa: pode haver policy criada à mão
  que este procedimento apagaria ou que mudaria o efeito das correções.
- **BLOCKED** — não deu para inspecionar. Isto **não** é um atestado de
  integridade. Resolva o acesso antes de seguir.

Esperar ruído no primeiro PASS/FAIL: objetos que a plataforma Supabase gerencia
sozinha podem aparecer como não declarados. Triar uma vez e registrar o que é
esperado.

## A armadilha do push

`supabase db push` aplica **todas** as migrations pendentes. Como a
`010_programas.sql` está pendente de propósito e **não autorizada para
produção**, um push levaria a 010 junto com as correções. É por isso que o
procedimento abaixo aplica SQL revisado diretamente e só depois acerta o
histórico.

`supabase migration repair` altera apenas o registro de histórico; ele não
executa SQL. Serve para marcar a 011 a 014 como aplicadas **sem** marcar a 010.

## Procedimento

Com backup restaurável confirmado antes de começar. Não é backup "existe", é
backup que já foi restaurado em algum lugar e funcionou.

1. **Guard antes.** Rodar o comando da seção anterior e guardar a saída. É o
   retrato de "como produção estava".

2. **Aplicar o SQL revisado, em transação, uma migration por vez, nesta ordem:**
   `011` → `012` → `013` → `014`.

   ```bash
   psql "$PRODUCAO_DB_URL" --single-transaction -v ON_ERROR_STOP=1 \
     -f supabase/migrations/011_fix_privilegio_anon.sql
   ```

   A ordem importa: a `013` redefine a mesma função da `011` (qualificando os
   nomes), então aplicar `013` antes da `011` faria a `011` desfazer a
   qualificação.

3. **Verificar cada correção**, com as mesmas sondas usadas na validação local:

   ```sql
   -- 011/013: privilégio e autorização interna
   select has_function_privilege('anon','public.delete_event_cascade(uuid)','execute');        -- false
   select has_function_privilege('authenticated','public.delete_event_cascade(uuid)','execute'); -- false
   select proconfig from pg_proc where proname = 'delete_event_cascade';                       -- search_path=""

   -- 011: view
   select has_table_privilege('anon','participant_profiles','select');                          -- false
   select reloptions from pg_class where relname = 'participant_profiles';                      -- security_invoker=on

   -- 012: is_admin sem claim devolve false, não estoura
   select is_admin();                                                                           -- false

   -- 014: colunas travadas
   select privilege_type, column_name from information_schema.column_privileges
    where grantee = 'authenticated' and table_name = 'participants' and privilege_type = 'UPDATE';
   -- esperado: apenas full_name, phone, course_or_moment
   ```

4. **Testar o fluxo legítimo de verdade**, não só as negativas: excluir um evento
   descartável pelo painel administrativo, e um participante corrigir o próprio
   nome. Endurecer segurança que quebra o produto não é correção.

5. **Reconciliar o histórico** de `011` a `014`, sem declarar a `010`.

6. **Guard depois.** Rodar o guard de novo. O resultado esperado é PASS contra uma
   referência que inclui `011` a `014` — e aqui mora uma pegadinha: enquanto a
   `010` estiver pendente, a referência construída das migrations CONTÉM a 010 e
   produção não, então o guard vai acusar os objetos da 010 como ausentes no
   alvo. Isso é FAIL legítimo e esperado, não regressão. Trate como tal até a
   010 ser aplicada, e prefira comparar contra a saída do passo 1.

## Plano de reversão

Cada migration é revertível por SQL próprio. Reverter uma correção de segurança
só se justifica se ela quebrou o produto — e nesse caso a prioridade é consertar
o fluxo legítimo, não ficar sem a correção.

| Migration | Reversão |
|---|---|
| `014` | `grant update on participants to authenticated;` e recriar `participants_own_update` sem `with check` (volta ao estado da 002 — **reabre o desvio de etapa**) |
| `013` | reaplicar a função da `011` (volta `search_path` a `public` e as referências a não qualificadas) |
| `012` | reaplicar `is_admin()` como está na `002` (volta a estourar sem claim) |
| `011` | reaplicar a função da `005`, `grant execute ... to public`, `alter view participant_profiles reset (security_invoker)`, `grant select on participant_profiles to anon` — **reabre as duas falhas críticas** |

Reverter a `011` devolve ao estado em que um cliente anônimo apaga eventos,
participantes e linhas de `auth.users`. Não faça isso sem motivo maior que isso.

## O que este procedimento NÃO resolve

- **Tomada de conta de participante pelo `join-event`.** A rota redefine a senha
  de qualquer usuário não administrador e devolve a senha nova no corpo da
  resposta. Com o QR público do evento e o e-mail de um participante, assume-se a
  conta dele. A guarda atual protege apenas contas com
  `app_metadata.role = 'admin'`. Isso **não** é corrigível por migration: o reset
  é proposital, para o participante voltar de outro aparelho só com o e-mail.
  Fechar exige trocar como ele reautentica (link mágico, OTP ou token por
  participante), o que é decisão de produto.
- **Enumeração de e-mails de administrador** pelo mesmo `join-event`: 403 com
  texto próprio para admin, 200 para e-mail comum.
- **Regeneração de prognóstico pelo próprio participante**, revertendo um
  `reviewed`/`delivered` do administrador e consumindo crédito de modelo.
- `TRUNCATE` concedido a `anon` e `authenticated` em todas as tabelas de
  `public` — TRUNCATE ignora RLS. Não exposto pelo PostgREST hoje, mas é
  endurecimento pendente.
