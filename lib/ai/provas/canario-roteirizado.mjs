// Canario ROTEIRIZAVEL da Anthropic, para provar a verificacao de saida do
// prognostico (lib/ai/gerar-com-veto.ts) sem gastar um token.
//
// Mesmo padrao de tests/seguranca-http/canario-anthropic.mjs (servidor local no
// lugar de api.anthropic.com, o app aponta ANTHROPIC_BASE_URL para ca, a chave e
// falsa, cada requisicao que chega e CONTADA), com uma diferenca: aquele devolve
// sempre o mesmo prognostico sintetico. Para plantar uma violacao na saida do
// modelo e preciso escolher o que a proxima resposta diz. Os arquivos de tests/
// nao foram alterados.
//
// Endpoints de controle:
//   GET  /__canario/contagem  -> { total, requisicoes: [...] } (com o corpo resumido)
//   GET  /__canario/ultima    -> o corpo cru da ultima requisicao /v1/messages
//   POST /__canario/zerar     -> zera contagem e roteiro
//   POST /__canario/roteiro   -> { "respostas": [ <objeto JSON | string>, ... ] }
//                                cada /v1/messages consome a proxima; fila vazia
//                                = resposta padrao limpa (ou, se o pedido for de
//                                correcao, uma correcao vazia de sentido).
//
// Uso: node canario-roteirizado.mjs <arquivo-onde-gravar-a-porta>

import http from "node:http";
import { writeFileSync } from "node:fs";

const requisicoes = [];
const corpos = [];
let roteiro = [];

const PROGNOSTICO_LIMPO = {
  analise_geral:
    "Nas situações respondidas, as escolhas ficaram espalhadas e não apontam uma preferência clara.\n\nA decisão adiada sobre a presidência da associação organiza o resto. **Adiar protege um papel que já pesa.**",
  areas_chave: [
    {
      nome: "Decisão adiada",
      diagnostico: "A presidência aparece como a pendência central. **O adiamento tem custo.**",
      risco: "O risco é gastar mais um semestre sustentando um papel que já não cabe.",
      movimento: "Marcar uma data para decidir.",
    },
  ],
  plano_30_dias: [
    {
      titulo: "Fechar a decisão",
      objetivos: ["Listar critérios", "Conversar com duas pessoas", "Registrar a decisão"],
      acao: "Escreva em uma página o que a presidência pede e o que devolve.",
      resultado_esperado: "Uma decisão registrada.",
    },
  ],
  praticas: [{ nome: "Registrar", descricao: "Anotar ao fim do dia **uma decisão tomada** e uma adiada." }],
  frase_ativacao: {
    frase: "Decisão adiada continua custando, só não aparece na conta.",
    contexto: "O adiamento pede um prazo, não mais reflexão.",
    aplicacao: "Escolha a pendência mais antiga e dê a ela uma data.",
    pergunta_pratica: "Qual decisão eu ainda trato como se não tivesse prazo?",
  },
  trilha_recomendada: "Direção",
  justificativa_trilha:
    "O que as respostas abertas mostram é uma pendência concreta. A trilha de Direção trabalha a capacidade de transformar intenção em critério.",
};

function sse(evento, dados) {
  return `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
}

function ehPedidoDeCorrecao(json) {
  return JSON.stringify(json?.output_config?.format ?? "").includes("correcoes");
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://canario.local");
  const json = (codigo, obj) => {
    res.writeHead(codigo, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/__canario/contagem") return json(200, { total: requisicoes.length, requisicoes });
  if (url.pathname === "/__canario/ultima") return json(200, corpos[corpos.length - 1] ?? null);
  if (url.pathname === "/__canario/zerar" && req.method === "POST") {
    requisicoes.length = 0;
    corpos.length = 0;
    roteiro = [];
    return json(200, { ok: true });
  }

  let corpo = "";
  req.on("data", (c) => (corpo += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(corpo);
    } catch {
      /* nao-JSON: so registra */
    }

    if (url.pathname === "/__canario/roteiro" && req.method === "POST") {
      roteiro = body?.respostas ?? [];
      return json(200, { ok: true, na_fila: roteiro.length });
    }

    const mensagens = body?.messages ?? [];
    requisicoes.push({
      quando: new Date().toISOString(),
      metodo: req.method,
      caminho: url.pathname,
      modelo: body?.model ?? null,
      max_tokens: body?.max_tokens ?? null,
      effort: body?.output_config?.effort ?? null,
      pedido_de_correcao: body ? ehPedidoDeCorrecao(body) : false,
      papeis: mensagens.map((m) => m.role),
    });
    corpos.push(body);

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      let resposta = roteiro.length > 0 ? roteiro.shift() : null;
      if (resposta === null) {
        resposta = ehPedidoDeCorrecao(body)
          ? { correcoes: [{ campo: "analise_geral", texto: "Texto corrigido pelo canário." }] }
          : PROGNOSTICO_LIMPO;
      }
      const texto = typeof resposta === "string" ? resposta : JSON.stringify(resposta);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_canario",
            type: "message",
            role: "assistant",
            model: body?.model ?? "canario",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto } }));
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }));
      res.end(sse("message_stop", { type: "message_stop" }));
      return;
    }
    json(404, { type: "error", error: { type: "not_found_error", message: "canario" } });
  });
});

servidor.listen(0, "127.0.0.1", () => {
  const porta = servidor.address().port;
  const arquivo = process.argv[2];
  if (arquivo) writeFileSync(arquivo, String(porta));
  console.log(`[canario-roteirizado] ouvindo em http://127.0.0.1:${porta}`);
});
