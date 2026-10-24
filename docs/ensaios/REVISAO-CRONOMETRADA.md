# Revisão cronometrada: cinco documentos fictícios

Para medir quanto tempo quem vai revisar na segunda leva, com documentos que se parecem com
os de verdade. Serve para dimensionar a equipe, não para julgar a qualidade do texto da IA.

Tudo roda no banco local deste computador. Nenhum participante real, nenhuma chamada à IA.

## Quem participa

- **Quem conduz:** prepara o banco, cronometra e roda o passo do caso 5. Lê o gabarito no
  fim desta página. O revisor não lê.
- **Quem revisa:** a pessoa que vai revisar na segunda. Faz tudo pela tela, como faria de
  verdade. Nada de aprovar direto no banco.

## Preparar (quem conduz, 5 minutos)

1. Banco local ligado (docs/AMBIENTE-LOCAL.md) e o app local aberto em
   http://127.0.0.1:3000.
2. Carregar os cinco documentos (pode rodar de novo para recomeçar do zero):

   ```bash
   docker exec -i -e PGOPTIONS='-c kit.banco_local=sim' supabase_db_fort-inside psql -U postgres -v ON_ERROR_STOP=1 < docs/ensaios/revisao-cronometrada.sql
   ```

   O arquivo se recusa a rodar sem essa opção, então colado no Supabase de produção ele para
   antes de gravar qualquer coisa.
3. Entrar no painel local com o administrador de teste, abrir **Revisão cronometrada (5
   fictícios)** e depois **Abrir revisão e envio**.

## O que o revisor faz em cada documento

1. **Ler:** abre em **Revisar** e lê o documento inteiro.
2. **Corrigir:** ajusta o que achar necessário.
3. **Aprovar:** **Salvar alterações**.
4. **Preparar o envio:** **Enviar**, confere o nome, marca a conferência do contato e clica em
   **Disponibilizar documento**. Para no "Copiar mensagem": nada vai para o WhatsApp.

## Folha de tempo

Quem conduz marca o relógio quando cada etapa começa e termina. Anote em minutos e
segundos.

| Caso | Ler | Corrigir | Aprovar | Preparar envio | Total | Erros que o revisor achou |
|---|---|---|---|---|---|---|
| 1 Simples | | | | | | |
| 2 Longo | | | | | | |
| 3 Corrigir | | | | | | |
| 4 Cuidado | | | | | | |
| 5 Selo | | | | | | |

**Conta de segunda:** some os cinco totais e divida por 5. Com 33 documentos (ou o número final do boletim), multiplique a
média por 36 e divida pelo número de revisores. Se passar das horas disponíveis, a equipe
precisa crescer ou o horário precisa mudar.

## O passo do caso 5 (quem conduz)

Depois que o revisor salvar o caso 5, e antes de ele clicar em Enviar:

1. Rode o bloco **ALTERAR-DEPOIS-DA-APROVACAO** do fim de `revisao-cronometrada.sql`. Ele
   troca o texto do caso 5 direto no banco, como se alguém tivesse mexido depois da
   aprovação.
2. Peça ao revisor para **recarregar a página** e só então clicar em **Enviar**.
3. **Esperado:** "Entrega recusada: o texto deste documento não é o que foi revisado e
   aprovado..." O revisor deve abrir de novo, ler o texto como está agora, salvar e enviar.
   Cronometre esse retrabalho na mesma linha.

**Por que recarregar:** sem recarregar, a tela ainda guarda o texto aprovado e libera
**esse** texto. O banco confere que o que foi liberado é exatamente o que foi aprovado, então
o participante nunca vê um texto sem aprovação. Mas a mudança feita depois da aprovação some
sem aviso. Visto no ensaio desta noite; está anotado para o CTO.

---

## Gabarito (só quem conduz)

- **Caso 1, Simples:** nada a corrigir. Mede o piso: ler e aprovar.
- **Caso 2, Longo:** nada a corrigir. Mede leitura de documento grande.
- **Caso 3, Corrigir:** dois erros.
  1. A análise chama a pessoa de **"Mariana"**, que não é o nome dela.
  2. A justificativa fala da **trilha de Aceleração**, mas a trilha recomendada é **Direção**.
- **Caso 4, Cuidado:** a pessoa contou uma perda recente e nervosismo em provas. O texto
  gerado:
  - diagnostica ("quadro claro de ansiedade", "ansiosa demais");
  - culpa a pessoa ("só depende de você", "quem quer, supera", "por que eu ainda não
    superei?");
  - manda esquecer o luto ("parar de pensar no que aconteceu", "deixe o passado para trás").
  
  O revisor deve reescrever sem diagnóstico e sem culpa, ou marcar para conversa com o Yuri
  (a trilha já é Sessão Privada). Aprovar como está conta como erro.
- **Caso 5, Selo:** nada a corrigir no texto. Testa a recusa da entrega depois de mudança
  pós-aprovação.
