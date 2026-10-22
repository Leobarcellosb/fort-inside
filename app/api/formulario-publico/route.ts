import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFINICOES_DE_ERRO, novaOcorrencia } from "@/lib/erros/codigos";
import {
  receberFormulario,
  type ClienteDeRecepcao,
} from "./receber-formulario";

/*
 * A PORTA DO FORMULARIO PUBLICO. Sem autenticacao, de proposito.
 *
 * A decisao e as suas consequencias estao escritas no topo de
 * receber-formulario.ts, que e onde vive toda a logica (e onde os testes a
 * provam). Este arquivo e so a borda HTTP: valida o formato do corpo, chama, e
 * traduz o desfecho em status.
 *
 * O QUE ESTA ROTA NAO VERIFICA, E POR QUE
 * ---------------------------------------
 * `events.max_participants`. A pagina /join barra quando o evento esta cheio, e
 * aqui NAO se barra. Nao e esquecimento:
 *
 *   - `max_participants` e limitado a 20 por `createEventSchema`, e o link
 *     publico vai para cerca de 50 pessoas. Barrar no 21o faria o formulario
 *     parar de funcionar no meio da divulgacao, calado, e o dono so descobriria
 *     pelos que reclamassem;
 *   - a instrucao desta entrega e explicita em nao exigir configuracao nova do
 *     dono: o formulario tem de funcionar com o evento que JA esta no ar;
 *   - o limite nunca existiu no banco (nenhum CHECK, nenhum gatilho): ele e
 *     tamanho de sala para o dia do evento, nao integridade de dado.
 *
 * O que se aceita em troca: o evento pode acumular mais participantes do que
 * `max_participants` diz, e quem olhar esse numero no painel nao tera a
 * contagem real. A contagem real esta na tabela, e o painel a mostra.
 */

const valorDeResposta = z.union([
  z.string(),
  z.array(z.string()),
  z.number().finite(),
]);

const bodySchema = z.object({
  event_code: z.string().min(1).max(40),
  full_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres").max(200),
  email: z.string().email("E-mail inválido").max(320),
  phone: z.string().max(40).optional(),
  // Mapa PLANO id da pergunta -> valor, das 5 etapas juntas. Um teto de chaves
  // para que o corpo nao seja um vetor de carga: o questionario tem 52.
  respostas: z.record(z.string().max(120), valorDeResposta).refine(
    (r) => Object.keys(r).length <= 400,
    "Respostas em excesso"
  ),
});

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(status: number, corpo: Record<string, unknown>) {
  return NextResponse.json(corpo, { status, headers: NO_STORE });
}

/**
 * O texto que a pessoa LE quando o sistema falha do nosso lado. Diz que as
 * respostas NAO foram perdidas do ponto de vista dela (ela ainda tem a tela
 * preenchida) e o que fazer. Nunca mostra erro cru de banco.
 */
const ERRO_INTERNO =
  "Não conseguimos registrar suas respostas agora. Elas continuam aqui na tela: toque em enviar de novo em alguns segundos. Se continuar, avise a equipe do evento.";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Dados inválidos" });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    // Os erros de formato do corpo que a PESSOA pode causar sao nome curto e
    // e-mail invalido, e a tela ja os mostra campo a campo antes de enviar. O
    // resto seria pedido forjado, e nada do que foi enviado e ecoado de volta.
    return json(400, {
      error:
        "Confira o nome e o e-mail: o nome precisa de ao menos 2 letras e o e-mail precisa ser válido.",
    });
  }

  const dados = parsed.data;
  const supabase = createAdminClient() as unknown as ClienteDeRecepcao;

  const r = await receberFormulario(supabase, {
    eventCode: dados.event_code,
    fullName: dados.full_name,
    email: dados.email,
    phone: dados.phone,
    respostas: dados.respostas,
  });

  switch (r.tipo) {
    case "ok":
      return json(200, { success: true, participant_id: r.participantId });

    case "segunda_resposta_guardada":
      // 200, e nao erro: NADA falhou. O envio foi GRAVADO na mesa de decisao --
      // este desfecho so existe depois de o insert em `external_submissions`
      // voltar sem erro (ver receber-formulario.ts). O que ele nao fez foi apagar
      // a resposta que ja existia, que e o ponto. `na_mesa_de_decisao` e sempre
      // `true` aqui; a tela so diz "guardamos" quando le esse `true`.
      //
      // O QUE ESTA RESPOSTA REVELA, declarado: ela diz a quem enviou que aquele
      // e-mail ja tinha resposta neste evento. Isso e mais do que o silencio
      // anterior entregava, e e deliberado -- a pessoa precisa saber que o envio
      // dela nao virou a resposta oficial, senao ela vai embora acreditando que
      // virou. O que NAO vai na resposta, e nao pode passar a ir: o nome de quem
      // respondeu antes, quando respondeu, ou qualquer parte das respostas dela.
      // Quem quisesse usar isto para sondar e-mails teria de preencher 52
      // perguntas por tentativa, e colheria apenas "alguem usou este endereço".
      return json(200, {
        success: true,
        codigo: "segunda_resposta_guardada",
        na_mesa_de_decisao: true,
      });

    case "evento_nao_encontrado":
      return json(404, {
        error:
          "Não encontramos este evento. Confira se o link está completo, igual ao que você recebeu.",
      });

    case "evento_encerrado":
      return json(409, {
        error:
          "Esta imersão já foi concluída, então o questionário não recebe mais respostas. Fale com a equipe do evento.",
      });

    case "prazo_encerrado":
      // Nada foi gravado. O formulario mostra esta frase e mantem o rascunho no
      // aparelho (so 200 confirmado apaga o rascunho).
      return json(409, {
        error:
          "O prazo para responder o questionário terminou. Suas respostas continuam salvas neste aparelho. Se ainda precisa enviar, fale com a equipe do evento.",
      });

    case "prazo_indeterminado":
      // Configuracao do evento, nao da pessoa: nao se diz que o prazo passou,
      // porque isso nao foi verificado. Nada foi gravado.
      return json(503, {
        error:
          "O questionário está indisponível no momento. Suas respostas continuam salvas neste aparelho. Fale com a equipe do evento.",
      });

    case "questionario_indisponivel": {
      // Problema de CONFIGURACAO do questionario, nao da pessoa, e tentar de novo
      // nao resolve. O detalhe tecnico fica no log; a tela recebe o fato.
      const ocorrencia = novaOcorrencia();
      console.error("[formulario-publico] questionario indisponivel", {
        ocorrencia,
        detalhe: r.detalhe,
      });
      return json(503, {
        error:
          "O questionário deste evento não está disponível para resposta agora. Isso não é problema com os seus dados. Avise a equipe do evento.",
        ocorrencia,
      });
    }

    case "faltam_obrigatorias":
      // 422: o corpo esta bem formado, o CONTEUDO e que nao atende a regra do
      // questionario. O corpo leva a lista por etapa e pergunta, para a tela
      // marcar cada campo -- e nao so um aviso generico no topo.
      return json(422, {
        error: r.resumo,
        codigo: "faltam_obrigatorias",
        faltando: r.etapas,
      });

    case "resposta_invalida":
      // Alcancavel so por pedido forjado: a tela nunca monta um valor de formato
      // incompativel com o tipo da pergunta.
      return json(400, {
        error: "Uma das respostas veio em formato inesperado. Recarregue a página e tente de novo.",
        codigo: "resposta_invalida",
      });

    case "gravacao_indisponivel": {
      // NAO CONSEGUI GRAVAR. Nem "gravei" (200) nem "recusei" (4xx): o
      // armazenamento proprio nao confirmou, e nada foi guardado em outro lugar.
      // A frase que o adolescente le mora na tela, traduzida pelo `code`; o
      // `error` e o texto curto e estavel do vocabulario (lib/erros/codigos.ts).
      const codigo = "PUBLIC_FORM_WRITE_UNAVAILABLE" as const;
      const ocorrencia = novaOcorrencia();
      console.error("[formulario-publico] gravacao nao confirmada", {
        ocorrencia,
        codigo,
        fase: r.fase,
        causa: r.causa,
      });
      return json(DEFINICOES_DE_ERRO[codigo].status, {
        error: DEFINICOES_DE_ERRO[codigo].error,
        code: codigo,
        ocorrencia,
      });
    }

    case "erro":
    default: {
      const ocorrencia = novaOcorrencia();
      console.error("[formulario-publico] falha ao registrar", {
        ocorrencia,
        causa: r.tipo === "erro" ? r.causa : r,
      });
      return json(500, { error: ERRO_INTERNO, code: "INTERNAL_ERROR", ocorrencia });
    }
  }
}
