# Presença, convites e o denominador oficial da cobertura

Migration: `supabase/migrations/020_presenca_convites.sql`.
Provas: `supabase/provas/020-rls-presenca.sql`, `supabase/provas/020-cobertura.sql`,
runner `supabase/provas/rodar-020.sh`.

**Não aplicada em produção nem no banco local do projeto.** Escrita e validada
contra Postgres descartável, como a 011, a 014, a 015, a 018 e a 019.

## A decisão que o modelo implementa

Uma coluna `participants.is_present` foi recusada: **alguém pode comparecer
fisicamente sem ter criado conta e sem ter respondido ao questionário, e essa
pessoa precisa entrar no denominador de presença.** `participants` é a tabela de
quem entrou no aplicativo; quem chegou na porta e não abriu o app não tem linha
lá, e criar uma linha falsa contaminaria tudo que conta participantes (fila de
geração, custo de IA, listagens do painel).

Daí três entidades distintas:

| Tabela | O que é | Dono do fato |
|---|---|---|
| `event_people` | cadastro da **pessoa** vinculada ao evento; `participant_id` é **opcional** | operação |
| `event_invitations` | **uma linha por envio** de convite, com estado e autor | operação |
| `event_checkins` | **presença física**, um único registro ATIVO por pessoa e evento | host / operação |

Mais três que existem porque "total" e "encerrado" são fatos com data, autor e
versão — não consultas feitas na hora:

| Tabela | O que é |
|---|---|
| `event_invite_snapshots` + `_people` | a **fotografia** da lista no encerramento do período de convites |
| `event_checkin_closures` | o **encerramento formal** do check-in pelo administrador |
| `event_dna_invalidations` | o **ponto único** onde a invalidação da aprovação/hash do DNA é disparada |

## O denominador

```
Cobertura = (presentes com questionário válido e completo
             / total de presentes confirmados) × 100
```

Caso canônico: **50 compareceram, 45 responderam validamente → 90%**. Quem
compareceu e não preencheu **continua no denominador**.

Total de convidados **não** é o denominador. Ele vem da fotografia versionada e
aparece ao lado, como participação. No cenário da prova: 48 convidados (50
envios, porque uma pessoa foi convidada três vezes) e 50 presentes — dois
walk-ins fazem os presentes passarem dos convidados.

### A função

```sql
select * from public.marco_zero_cobertura('<event_id>');
```

Devolve uma linha. Campos que importam:

- `status` — `ok` ou `indisponivel`; `motivo` — `checkin_aberto`,
  `sem_presentes` ou `quiz_sem_etapas`
- `presentes`, `presentes_avulsos`, `respondentes_validos`, `presentes_sem_resposta`
- `cobertura_percentual` — `numeric` exato, **NULL** quando não é oficial
- `convidados` + `motivo_convidados` (`sem_snapshot_de_convites`,
  `snapshot_inconsistente`), `convite_snapshot_versao`
- `checkin_fechado`, `fechado_em`, `fechado_por`, `closure_versao`
- `aprovacao_invalidada`, `invalidado_em`, `invalidacoes_pendentes`
- `gate_minimo_respostas`, `gate_cobertura`, e os parâmetros
  `minimo_respostas` (30), `cobertura_minima_percentual` (90), `piso_supressao` (5)

### "Não consegui verificar" ≠ "reprovado"

O projeto separa as duas coisas, e a função respeita isso:

| Situação | Resultado |
|---|---|
| cobertura 43/48 = 89,58% | `status=ok`, percentual presente, `gate_cobertura=false` — **reprovado** |
| 10 presentes, 10 válidos | `status=ok`, cobertura 100, `gate_minimo_respostas=false` — **reprovado por volume** |
| check-in ainda aberto | `status=indisponivel`, `motivo=checkin_aberto`, percentual **NULL** (contagens saem exatas) |
| 0 presentes | `status=indisponivel`, `motivo=sem_presentes` — 0/0 não é 0% nem 100% |
| versão de quiz sem etapas | `status=indisponivel`, `motivo=quiz_sem_etapas`, `respondentes_validos` **NULL** |
| evento inexistente | **levanta** `P0002` — não devolve linha de zeros |
| fotografia com total divergente | `convidados` **NULL**, `motivo_convidados=snapshot_inconsistente` |

Nenhum desses casos devolve número aproximado.

### O que é "válido e completo"

Regra única, em `marco_zero_respostas_validas(event_id)`:

- **completo**: existe resposta para **todas** as etapas da `quiz_version`
  vigente do evento (`events.quiz_version` → `quiz_stages.quiz_version`);
- **válido**: completo, todas as respostas são objeto JSON **não vazio**, e o
  participante tem `completed_at`.

Pessoa sem participante vinculado é, por construção, não-respondente — e
continua no denominador.

## O que o participante não consegue fazer

Isto é **privilégio**, não só política — política se reabre com uma policy nova,
privilégio não. Em todas as sete tabelas: `revoke all` de `anon` e
`authenticated` primeiro (privilégio de coluna **não** subtrai de privilégio de
tabela: a lição da 014), depois `grant select` só a `authenticated` (recortado
pela policy `is_admin()`) e escrita só a `service_role`. Não existe policy de
INSERT/UPDATE/DELETE em nenhuma delas.

Camadas adicionais em `event_checkins`, que valem **inclusive para
`service_role`**, porque são gatilhos:

1. `registrado_em` é **atribuído** pelo servidor na inserção (o valor informado
   é descartado) e não pode ser alterado em UPDATE;
2. o FATO é imutável: em UPDATE só `estado`, `motivo`, `corrigido_em` e
   `corrigido_por` podem mudar — correção se faz com **registro novo**;
3. ninguém confirma a própria presença (`confirmado_por_uid` não pode ser o
   `user_id` do participante daquela pessoa);
4. `estado` não volta para `ativo`;
5. um único ATIVO por (evento, pessoa), por índice único parcial.

As funções de **escrita** não são `SECURITY DEFINER` de propósito: se alguém
conceder `execute` a `authenticated` amanhã, o privilégio de tabela revogado
barra de novo, por baixo. As duas de **leitura** são definidoras, porque uma
contagem filtrada por RLS devolveria "zero respondentes" — um número errado em
vez de um erro.

## Fluxo de uso (tudo por `service_role`)

```sql
-- cadastro e convites
select * from marco_zero_pessoa_registrar(:evento, 'Nome', 'email@x', null, 'lista_convite');
select * from marco_zero_convite_registrar(:pessoa, 'email', 'email@x', 'Operação');

-- encerramento do período de convites: a fotografia (total oficial)
select * from marco_zero_convites_encerrar(:evento, 'Administrador');

-- presença
select * from marco_zero_checkin_registrar(:evento, :pessoa, 'Yuri Fortes', 'host');
select * from marco_zero_checkin_avulso(:evento, 'Quem chegou na porta', 'Yuri Fortes');  -- walk-in

-- correção auditada (preserva o registro anterior) e anulação
select * from marco_zero_checkin_corrigir(:checkin, 'motivo', 'Administrador');
select * from marco_zero_checkin_anular(:checkin, 'não compareceu', 'Administrador');

-- encerramento do check-in e, se preciso, reabertura
select * from marco_zero_checkin_encerrar(:evento, 'Administrador');
select * from marco_zero_checkin_reabrir(:evento, 'Administrador', 'motivo');

-- mudança de ELEGIBILIDADE, que esta unidade não observa, avisa aqui
select * from marco_zero_invalidar_dna(:evento, 'elegibilidade', 'detalhe');
```

## Invalidação da aprovação do DNA

Qualquer correção de presença **depois** do encerramento — INSERT, UPDATE de
estado ou DELETE em `event_checkins` — dispara, por gatilho:

1. uma linha em `event_dna_invalidations` (origem, detalhe, pessoa, check-in);
2. `invalidado_em` / `invalidado_motivo` no fechamento vigente.

`marco_zero_cobertura` expõe isso em `aprovacao_invalidada` e
`invalidacoes_pendentes`. Os **números seguem exatos e atuais** — o que caducou é
a aprovação e o hash daquele fechamento, não a contagem. Quem registrar a nova
aprovação preenche `reconhecido_em`.

O DNA Coletivo em si é outra unidade
(`components/features/marco-zero/dna-coletivo-*`). Esta migration entrega os
números e o sinal; não publica nada.

## Como rodar a prova

```bash
bash supabase/provas/rodar-020.sh            # container próprio, 001 -> 020, as duas sondas
bash supabase/provas/rodar-020.sh --manter   # deixa o container de pé para inspeção
```

O runner **sobe um container exclusivo** e o remove no fim; recusa reaproveitar
um container com o mesmo nome (pode ser de outra unidade em voo) e nunca aponta
para o banco local do projeto — que é compartilhado e já derrubou uma suíte que
conta linhas.

## Pendências declaradas

1. **O gate de 30 só existe no banco.** Medido no TypeScript do DNA:
   `COBERTURA_MINIMA_PERCENTUAL = 90` e `PISO_DE_EXIBICAO = 5` batem com a view
   `marco_zero_parametros_dna`; o mínimo de 30 questionários **não existe lá** (o
   `K` de `passaBase` é o piso de supressão, 5). Quem publicar o DNA tem de ler
   `gate_minimo_respostas` desta função, senão aquele gate não existe em ponto
   algum do caminho.
2. **Validade é estrutural**, não semântica (ver acima). Se o motor de scoring
   reprovar respostas que o banco aceita, o numerador daqui fica maior que o
   dele — e a regra muda num lugar só: `marco_zero_respostas_validas`.
3. **Elegibilidade não é observável** daqui: quem a altera tem de chamar
   `marco_zero_invalidar_dna`. É contrato entre unidades, não trava de banco.
4. **As sondas não estão registradas** em `scripts/test-db-security.sh` (arquivo
   de outra unidade). Para entrarem na suíte `npm run db:security`, basta
   acrescentá-las à lista `SCENARIOS` de lá — mas elas precisam da 020 aplicada
   no banco alvo.
5. `tests/jornada/jornada.mjs` tem `MIGRATIONS_ESPERADAS` até a **018**: a 019 e
   a 020 não estão naquela lista. É arquivo de outra unidade e não foi tocado.
