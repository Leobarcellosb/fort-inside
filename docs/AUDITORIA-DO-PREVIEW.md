# Auditoria: abrir o preview mexe na produção?

Madrugada de 24/10, a pedido do CTO (Rodada 87). O preview do ramo `painel-marco-zero`
(commit 85ddb16) usa **o mesmo banco de produção**: a URL do Supabase no código do preview é a
de produção. A pergunta é se só navegar, sem apertar botão, pode escrever nesse banco ou pôr
a IA para trabalhar.

## Resposta curta

**Hoje, não.** Nenhuma tela que o dono vai abrir grava nada no carregamento. O único efeito
automático do painel, o empurrão da fila, só dispara quando já existe alguém "em andamento"
ou o evento está "gerando documentos". Às 02h de 24/10, a produção tinha **zero jobs** e
**nenhum evento em processamento** (consulta só de leitura, contagem por estado).

**Condição:** isso vale enquanto a fila estiver vazia. Depois que alguém apertar **Gerar
direcionamentos**, não abra o painel pelo preview. O empurrão roda o processador com o código
do preview, e o processador é global: pega jobs de qualquer evento e chama a IA.

## Por tela

| Tela | No carregamento | Automático depois | Só com clique |
|---|---|---|---|
| Login `/admin/login` | Leitura | Nada | Entrar (cria a sessão, igual ao app publicado) |
| Lista de eventos `/admin/events` | Leitura | Nada | Nada que grave |
| Painel do evento `/admin/events/[id]` | Leitura | Releitura a cada 30 s (5 s com trabalho em curso) por `GET /api/jobs/status` e consultas. **`POST /api/jobs/tick` só se houver alguém em andamento, evento "processing" ou ação local em curso** | Gerar, Reprocessar, Testar a IA (com confirmação), liberar etapa (só evento ao vivo) |
| Revisão `/admin/events/[id]/review` | Leitura | Assinatura de tempo real (inerte: nenhuma tabela publica mudanças) | Salvar alterações, Enviar, Tirar do ar; depois de Enviar, gera o PDF |
| Documento do jovem `/prognostic/[token]` | Leitura | Consulta periódica do PDF (leitura) | Gerar o PDF |

As páginas do servidor (lista, painel, revisão, documento) não fazem `insert`, `update`,
`upsert`, `delete` nem `rpc` ao montar. Conferido no código do ramo.

## Dois achados que vieram junto

1. **O tempo real da revisão não funciona.** O código assina mudanças em `prognostics`, mas
   nenhuma migration põe tabela na publicação de tempo real (conferido no banco local; a
   produção segue as mesmas migrations). A tela de revisão só sabe o que mudou quando é
   recarregada.
2. **Dois operadores no mesmo documento perdem trabalho, só com as telas normais.**
   Reproduzido em duas abas, no build de produção local:
   - A abre o caso 1, edita e salva.
   - B, com a página aberta desde antes, abre o mesmo caso: o editor mostra o texto **sem** a
     edição de A.
   - B salva sem mexer: a edição de A some, e o banco registra uma aprovação nova do texto
     antigo.
   
   Se B, em vez de editar, clicar em Enviar, o banco recusa (o selo não bate). A perda está
   no **Salvar**, não no Enviar.

## Regras para a revisão de segunda (CTO, Rodada 87)

- Cada documento tem **um** revisor responsável por vez.
- Ninguém abre o mesmo documento em duas abas, nem dois operadores ao mesmo tempo.
- Ninguém mexe em conteúdo direto no banco durante a operação.
- **Recarregue a página antes de abrir um documento e antes de enviar.** Confira que o texto
  é o que você aprovou.
- Divergência? Pare, revise de novo e salve uma aprovação nova.

Recarregar diminui o risco, mas não é trava. A correção de verdade (controle de versão na
gravação) fica para depois de segunda.
