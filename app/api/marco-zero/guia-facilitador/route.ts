import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verificarAdmin } from "@/lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "@/lib/erros/resposta";
import type { CodigoDeErro } from "@/lib/erros/codigos";
import {
  ehUuid,
  prepararEntradaDoGuia,
  type ClienteDoGuia,
} from "@/lib/marco-zero/entrada-do-guia";
import {
  gerarGuiaDoFacilitador,
  textoDoGuia,
  type MotivoSemGuia,
} from "@/components/features/marco-zero/guia-facilitador-modelo";

/**
 * O CAMINHO OPERACIONAL do Guia de Preparação do Facilitador.
 *
 * Antes desta rota o gerador existia e não havia como produzi-lo: a contingência
 * estava no código e não na operação. Esta rota é quem fala com o banco --
 * convidados, presença, respostas, veredito do volume e estado de publicação do
 * DNA -- e chama o gerador, que continua puro.
 *
 * SÓ OPERADOR HABILITADO. `verificarAdmin()` devolve três desfechos e esta rota
 * não os colapsa: 401 quando o serviço de login respondeu que não há sessão
 * (é o caso do anônimo), 403 quando a sessão é válida e não é de administrador
 * (é o caso do participante), e 503 quando o serviço de login não respondeu --
 * que bloqueia igual, mas não é falta de permissão. Participante e anônimo
 * recebem negativa efetiva: nenhum dos dois chega a tocar o banco.
 *
 * O GUIA É MATERIAL RESTRITO AO FACILITADOR. Ele traz identificadores de quem
 * liberou a leitura individual, fora do texto, e por isso a rota nunca é pública
 * e nunca responde a quem não foi verificado como administrador.
 *
 * QUANDO O GUIA É RECUSADO, a resposta diz QUAL dos motivos previstos, com o
 * código do vocabulário compartilhado (lib/erros/codigos.ts):
 *
 *   dna_publicado                -> GUIDE_DNA_PUBLISHED            400
 *   estado_do_dna_indeterminado  -> GUIDE_DNA_STATE_UNVERIFIABLE   503
 *   dados_inconsistentes         -> GUIDE_DATA_INCONSISTENT        400
 *
 * A diferença entre o 400 e o 503 do meio é a que atravessa este projeto: "há
 * DNA publicado" é um veredito; "não deu para saber" é indisponibilidade. As
 * duas bloqueiam o guia, e mandam investigar coisas diferentes.
 */

const CODIGO_DA_RECUSA: Record<MotivoSemGuia, CodigoDeErro> = {
  dna_publicado: "GUIDE_DNA_PUBLISHED",
  estado_do_dna_indeterminado: "GUIDE_DNA_STATE_UNVERIFIABLE",
  dados_inconsistentes: "GUIDE_DATA_INCONSISTENT",
};

export async function POST(req: NextRequest) {
  try {
    return await gerar(req);
  } catch (err) {
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}

async function gerar(req: NextRequest) {
  // A porta de segurança fica à vista no arquivo da rota, como nas demais.
  const admin = await verificarAdmin();
  if (!admin.autorizado) {
    return respostaDeRecusa(admin);
  }

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return erroHttp("INVALID_REQUEST");
  }
  const eventId = (bruto as { event_id?: unknown } | null)?.event_id;
  if (!ehUuid(eventId)) return erroHttp("INVALID_REQUEST");

  const supabase = createAdminClient();
  const preparo = await prepararEntradaDoGuia(
    supabase as unknown as ClienteDoGuia,
    eventId,
  );
  if (!preparo.ok) return erroHttp(preparo.codigo, { causa: preparo.causa });

  const resultado = gerarGuiaDoFacilitador(preparo.entrada);

  if (resultado.tipo === "guia_nao_gerado") {
    // O motivo previsto, nomeado, com o código correspondente. Os parágrafos do
    // gerador vão no corpo para quem lê o log; a tela mostra a mensagem do
    // código (lib/erros/mensagens-host.ts).
    return erroHttp(CODIGO_DA_RECUSA[resultado.motivo] ?? "INTERNAL_ERROR", {
      causa: `guia_nao_gerado motivo=${resultado.motivo}: ${resultado.paragrafos.join(" ")}`,
    });
  }

  const { guia, conteudoSha256 } = resultado;
  return NextResponse.json({
    ok: true,
    event_id: eventId,
    conteudo_sha256: conteudoSha256,
    motivo_sem_dna: guia.motivoSemDna,
    populacoes: guia.populacoes,
    // Ids FORA do texto, como no modelo: o varredor recusaria identificador
    // dentro do guia, e é por identificador que o facilitador abre a leitura.
    acesso_individual: guia.acessoIndividual,
    texto: textoDoGuia(guia),
  });
}
