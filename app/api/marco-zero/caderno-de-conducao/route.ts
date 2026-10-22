import { NextResponse } from "next/server";
import { verificarAdmin } from "../../../../lib/auth/require-admin";
import { erroHttp, respostaDeRecusa } from "../../../../lib/erros/resposta";
import {
  cadernoDeConducao,
  paginaImprimivelDoCaderno,
} from "../../../../lib/marco-zero/caderno-de-conducao";

/**
 * O CAMINHO OPERACIONAL do CADERNO DE CONDUCAO -- o terceiro artefato do Marco
 * Zero, e o unico que existe com ZERO resposta digital.
 *
 * O QUE ESTA ROTA NAO FAZ, e e a razao de ela ser curta: nao abre cliente de
 * banco, nao le respostas de questionario, nao le participantes, nao le
 * cobertura, nao consulta estado de publicacao do DNA e nao chama o gerador do
 * Guia. Compare com a rota irma (app/api/marco-zero/guia-facilitador/route.ts),
 * que faz seis leituras: ali o artefato AFIRMA coisas sobre participacao e por
 * isso precisa dos dados; aqui o artefato diz COMO CONDUZIR, e a conducao nao
 * depende de ninguem ter respondido nada.
 *
 * NAO HA event_id. De proposito. O Caderno nao e por evento: ele e montado da
 * entrada estatica versionada do roteiro oficial do Marco Zero de 24/10/2026
 * (lib/marco-zero/roteiro-oficial.ts). Pedir um event_id sugeriria que ha
 * leitura de banco, e nao ha -- o corpo do pedido, se vier, e IGNORADO por
 * inteiro. E essa ausencia que faz o Caderno sair identico com o banco vazio.
 *
 * SO OPERADOR HABILITADO, pelos mesmos tres desfechos da rota irma, que esta
 * rota tambem nao colapsa: 401 quando o servico de login respondeu que nao ha
 * sessao, 403 quando a sessao e valida e nao e de administrador, 503 quando o
 * servico de login nao respondeu -- bloqueia igual e NAO e falta de permissao.
 * O Caderno traz o planejamento interno do dia e os nomes de quem e responsavel
 * por cada pendencia: nao e material publico.
 *
 * POST e nao GET porque o material e interno e nao deve virar URL compartilhavel
 * nem resposta cacheada.
 *
 * O CORPO traz as DUAS formas de levar para o papel, porque o requisito e uso
 * sem internet: `texto` (o Caderno em texto corrido, para arquivo e impressao
 * simples) e `html` (pagina autocontida, sem script e sem recurso de rede, que
 * abre e imprime offline depois de baixada).
 */

export async function POST() {
  try {
    // A porta de seguranca fica a vista no arquivo da rota, como nas demais.
    const admin = await verificarAdmin();
    if (!admin.autorizado) {
      return respostaDeRecusa(admin);
    }

    const { caderno, conteudoSha256, texto, versao } = cadernoDeConducao();

    return NextResponse.json({
      ok: true,
      versao,
      conteudo_sha256: conteudoSha256,
      contagem: caderno.contagem,
      momentos: caderno.momentos.map((m) => ({
        id: m.id,
        numero: m.numero,
        titulo: m.titulo,
        contagem: m.contagem,
      })),
      lacunas: caderno.lacunas.map((l) => ({
        momento: l.momento,
        momento_numero: l.momentoNumero,
        rotulo: l.rotulo,
        falta: l.falta,
        de_quem: l.deQuem,
        classe: l.classe,
      })),
      texto,
      html: paginaImprimivelDoCaderno(caderno),
    });
  } catch (err) {
    // O Caderno so falha por BUG: a entrada e estatica e o montador e puro.
    // Em particular, o varredor recusando uma frase cai aqui -- e deve cair.
    return erroHttp("INTERNAL_ERROR", { causa: err });
  }
}
