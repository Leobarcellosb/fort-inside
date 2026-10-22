# Boletim da coleta: quinta e sexta, até 23h59

Para quem acompanha a coleta do Marco Zero. Só leitura: nada aqui altera o banco,
e nada mostra nome, e-mail, telefone ou resposta de ninguém.

## Como tirar o boletim

1. Supabase do projeto do Marco Zero, **SQL Editor**, nova consulta.
2. Cole e rode primeiro: `set default_transaction_read_only = on;`
   (garante que nada vai ser escrito, mesmo por engano).
3. Cole o **bloco 1** de `docs/aplicar/boletim-da-coleta.sql` e rode.
4. Copie a célula `boletim` e mande no grupo da equipe.

Se o bloco 1 não devolver nenhuma linha, o código do evento está errado.
Os blocos 2 a 6 são detalhe, para quando o boletim acender algum alerta (`<<`).

## Os quatro momentos

| Quando | O que confirmar |
|---|---|
| Quinta, depois do disparo da Malu | "Último questionário recebido" com horário depois do disparo, e "Questionários completos" subindo. |
| Sexta, 12h | "Erros de gravação" e "Conflitos aguardando" em zero ou com tempo de resolver. |
| Sexta, 18h | Lembretes: ver abaixo. |
| Sexta, 22h30 | Último recebido recente, nenhum erro novo, prazo confere com sexta 23h59. |

## O que cada linha quer dizer

- **Convidados informados (50):** o número que a organização passou. Não é contado
  no banco. Não dá para tirar porcentagem de resposta a partir dele.
- **Questionários completos:** pessoas com as 52 respostas obrigatórias **gravadas no
  banco**. A tela de agradecimento sozinha não prova isso; esta linha prova.
- **Concluídos com resposta faltando:** deve ser 0. Se não for, avise a equipe técnica.
- **Conflitos de identidade aguardando:** o mesmo e-mail respondeu duas vezes com
  conteúdo diferente. A segunda resposta está guardada; a equipe decide qual vale
  antes de segunda.
- **Nomes iguais em cadastros diferentes:** pode ser a mesma pessoa com dois e-mails.
  Conferir com a lista oficial antes de gerar documento.
- **Erros de gravação:** envios que o banco não confirmou (a pessoa viu aviso para
  tentar de novo). Se o banco inteiro cair, nem esse registro entra: nesse caso o
  sinal é o log da Vercel, respostas 503 em `/api/formulario-publico`.
- **Último questionário recebido:** muitas horas sem nada no meio da tarde de sexta
  pode ser formulário fora do ar. Abrir o link do formulário no celular e conferir.
- **Prazo:** precisa dizer "23/10 23:59 em São Paulo (confere com sexta 23h59)".

## Lembretes de sexta, 18h

Quem falta é decidido pela **lista oficial da organização**, não pela ausência do
e-mail no banco. O jovem pode ter digitado outro e-mail, ou um erro de digitação.

- Não mande "você não respondeu" para ninguém com base só no banco.
- Mande um lembrete geral para a lista ("se ainda não respondeu, o prazo é hoje
  às 23h59") ou, para um nome específico, confirme antes com a pessoa.

## O que continua pendente

- **Isolamento:** o bloco 6 mostra que as tabelas estão com proteção ligada. Isso
  prova a configuração, não o acesso. A prova de que um visitante não consegue ler
  respostas no ambiente publicado ainda **não foi feita**: registrar como pendência.
