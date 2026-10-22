// Canário da Anthropic: servidor HTTP local que ocupa o lugar de api.anthropic.com.
//
// O app sob teste sobe com ANTHROPIC_BASE_URL apontando para cá e com uma
// ANTHROPIC_API_KEY falsa. Então:
//   - nenhuma requisição ao modelo sai da máquina (o SDK só fala com este processo);
//   - cada requisição que CHEGA aqui é registrada. "Nenhuma chamada ao modelo"
//     passa a ser um número verificável (contagem == 0), não uma suposição.
//
// Quando uma requisição de verdade chega (fluxo legítimo), respondemos com um
// stream SSE válido contendo um prognóstico sintético, para o fluxo completo
// funcionar sem gastar um token.
//
// Endpoints de controle (usados pela suíte):
//   GET  /__canario/contagem -> { total, requisicoes: [...] }
//   POST /__canario/zerar
//
// Falha sob demanda: se o corpo da requisição contiver MARCADOR_FALHA (o nome do
// participante vai no prompt), o canário responde 400 invalid_request_error, que o
// SDK NÃO repete. Serve para provar que uma falha real de geração aparece como
// `failed` no lote, sem depender de rede nem de gastar token. A requisição é
// contada como qualquer outra.
//
// Uso: node canario-anthropic.mjs <arquivo-onde-gravar-a-porta>

import http from "node:http";
import { writeFileSync } from "node:fs";

const MARCADOR_FALHA = "FALHAR-CANARIO";
const requisicoes = [];

const PROGNOSTICO_SINTETICO = {
  analise_geral: "Prognóstico sintético do canário. Nenhum modelo foi chamado.",
  areas_chave: [
    // O nome NAO pode ser "Visão": desde que a saida do modelo passou a ser
    // validada contra o catalogo fechado de dimensoes, qualquer radical de
    // rotulo em texto livre e recusado como variacao_de_rotulo -- e um canario
    // usando um nome de dimensao como dado sintetico fazia a jornada inteira
    // falhar na etapa da fila, com o veto funcionando exatamente como deveria.
    { nome: "Area sintetica", diagnostico: "sintético", risco: "sintético", movimento: "sintético" },
  ],
  plano_30_dias: [
    {
      titulo: "Semana 1",
      objetivos: ["sintético"],
      acao: "sintético",
      resultado_esperado: "sintético",
    },
  ],
  praticas: [{ nome: "Prática", descricao: "sintético" }],
  frase_ativacao: {
    frase: "sintético",
    contexto: "sintético",
    aplicacao: "sintético",
    pergunta_pratica: "sintético",
  },
  trilha_recomendada: "Exploração",
  justificativa_trilha: "sintético",
};

function sse(evento, dados) {
  return `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://canario.local");

  if (url.pathname === "/__canario/contagem") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total: requisicoes.length, requisicoes }));
    return;
  }
  if (url.pathname === "/__canario/zerar" && req.method === "POST") {
    requisicoes.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    let json = null;
    try {
      json = JSON.parse(corpo);
    } catch {
      /* corpo não-JSON: só registra */
    }
    requisicoes.push({
      quando: new Date().toISOString(),
      metodo: req.method,
      caminho: url.pathname,
      modelo: json?.model ?? null,
      max_tokens: json?.max_tokens ?? null,
    });

    if (req.method === "POST" && url.pathname === "/v1/messages" && corpo.includes(MARCADOR_FALHA)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "canario: falha provocada" } }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const texto = JSON.stringify(PROGNOSTICO_SINTETICO);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_canario",
            type: "message",
            role: "assistant",
            model: json?.model ?? "canario",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      );
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: texto },
        })
      );
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        })
      );
      res.end(sse("message_stop", { type: "message_stop" }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "canario" } }));
  });
});

servidor.listen(0, "127.0.0.1", () => {
  const porta = servidor.address().port;
  const arquivo = process.argv[2];
  if (arquivo) writeFileSync(arquivo, String(porta));
  console.log(`[canario] ouvindo em http://127.0.0.1:${porta}`);
});
