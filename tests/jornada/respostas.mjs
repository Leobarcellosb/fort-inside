// Plano de respostas de UM participante real do Marco Zero (quiz_version 2).
//
// POR QUE ISTO EXISTE EM VEZ DE 52 LITERAIS SOLTOS
// -----------------------------------------------
// As perguntas NAO sao escritas aqui: elas vem do banco, da migration 017, lidas
// pelo mesmo caminho que a tela do participante usa (versao do evento +
// stage_number). Este modulo so decide O QUE RESPONDER para cada pergunta que o
// banco apresentar, e RECUSA responder uma pergunta que nao reconhece. Se a 017
// mudar (pergunta nova, tipo novo, alternativa renomeada), a jornada falha aqui,
// dizendo qual id ela nao soube responder -- em vez de gravar um objeto
// silenciosamente incompleto e deixar o motor achar que a pessoa "nao respondeu".
//
// A ARMADILHA QUE ESTE PLANO EXERCITA DE PROPOSITO
// ------------------------------------------------
// As 6 situacionais (q40..q45) sao do tipo `select`, e a interface grava o TEXTO
// da alternativa ("A. Organizar o problema ..."), nao a letra. O motor
// (lib/scoring/marco-zero.ts) le so a letra. Este plano escolhe a letra e grava
// o TEXTO correspondente, exatamente como a tela faz: e esse formato que obriga
// `achatarRespostas` a existir e funcionar. Gravar a letra aqui tornaria a
// jornada verde com a normalizacao quebrada -- ou seja, inutil.
//
// AS CONTAGENS SAO ESCOLHIDAS, NAO SORTEADAS
// ------------------------------------------
// As letras foram escolhidas para que:
//   - os QUATRO eixos recebam contagem > 0 (nenhum eixo some);
//   - a soma seja exatamente 6 (as seis situacionais reconhecidas);
//   - haja eixo destacado com margem >= MARGEM_MINIMA_SITUACIONAL (2), para o
//     briefing produzir texto de destaque e nao so "sem destaque".
// O Likert foi escolhido para destacar o MESMO eixo, de forma que o cruzamento
// dos dois autorrelatos caia em "convergencia" e o briefing exercite esse ramo.
// As notas dos 7 elementos sao todas distintas: ha maior unico e menor unico, que
// e a unica condicao em que o briefing apresenta esses dois trechos.

/** Letra escolhida em cada situacional. Ver MAPA_SITUACIONAL em marco-zero.ts. */
export const LETRAS_SITUACIONAIS = Object.freeze({
  q40: "A", // visao
  q41: "C", // visao
  q42: "A", // execucao
  q43: "A", // integridade
  q44: "A", // visao
  q45: "A", // relacao
});

/** Contagem por eixo que o motor TEM de produzir a partir das letras acima. */
export const CONTAGEM_SITUACIONAL_ESPERADA = Object.freeze({
  visao: 3,
  execucao: 1,
  relacao: 1,
  integridade: 1,
});

/** Eixo destacado esperado nas situacionais (3 contra 1 => margem 3). */
export const EIXO_SITUACIONAL_ESPERADO = "visao";

/** Eixo destacado esperado no Likert: as somas abaixo dao visao 28 x relacao 23. */
export const EIXO_LIKERT_ESPERADO = "visao";

/** Likert 1..5, 24 itens (q16..q39): 6 por eixo, na ordem de ITENS_LIKERT. */
export const VALORES_LIKERT = Object.freeze({
  // visao (soma 28)
  q16: 5, q17: 5, q18: 4, q19: 5, q20: 4, q21: 5,
  // execucao (soma 19)
  q22: 3, q23: 3, q24: 4, q25: 3, q26: 3, q27: 3,
  // relacao (soma 23)
  q28: 4, q29: 4, q30: 3, q31: 4, q32: 4, q33: 4,
  // integridade (soma 22)
  q34: 4, q35: 3, q36: 4, q37: 4, q38: 3, q39: 4,
});

/** Elementos da Vida Plena, 0..10 (q7..q13). Todos distintos, de proposito. */
export const VALORES_ELEMENTOS = Object.freeze({
  q7: 8,  // desenvolvimento_intelectual
  q8: 5,  // saude_energia
  q9: 7,  // equilibrio_emocional
  q10: 4, // recursos_financeiros
  q11: 9, // contribuicao_social  <- maior unico
  q12: 6, // realizacao_proposito
  q13: 3, // hobbies_diversao     <- menor unico
});

/** Soma bruta esperada por eixo no Likert (6 itens de 1 a 5 => faixa 6..30). */
export const SOMAS_LIKERT_ESPERADAS = Object.freeze({
  visao: 28,
  execucao: 19,
  relacao: 23,
  integridade: 22,
});

// Respostas abertas e curtas. Texto de gente, nao "lorem ipsum": o prompt do
// prognostico recebe isto, e uma resposta vazia ou de uma palavra mudaria o que
// esta sendo exercitado. O nome vem de fora (o do participante da rodada).
const CURTAS = {
  q2: "41",
  q3: "Belo Horizonte, MG",
  q4: "Instituto Marco Zero",
  q5: "Diretor de operacoes",
  q46: "presente, inteiro, util",
};

const ABERTAS = {
  q6:
    "Na diretoria de operacoes, onde conduzo tres gerencias, e no conselho de " +
    "uma associacao de bairro em que ajudo a organizar os projetos do ano.",
  q14:
    "Hobbies e diversao. Nos ultimos dois anos eu tirei isso da agenda inteira " +
    "para dar conta do trabalho, e hoje percebo que chego no fim de semana sem " +
    "nada que seja meu.",
  q15:
    "Recuperar duas tardes por semana sem compromisso de trabalho e voltar a " +
    "jogar bola com os amigos de domingo, que era o que me devolvia energia.",
  q47:
    "Organizar. Quando o cenario esta confuso eu consigo separar o que e urgente " +
    "do que e importante e isso destrava o grupo. No ultimo trimestre reescrevi o " +
    "plano de uma area travada em uma tarde e a equipe voltou a andar.",
  q48:
    "Assumir trabalho que nao e meu. Quando vejo algo parado eu puxo para mim em " +
    "vez de cobrar de quem e responsavel, e termino sobrecarregado e sem formar " +
    "ninguem.",
  q49:
    "Que decisao difícil eu estou adiando porque e mais confortavel resolver as " +
    "tarefas dos outros do que enfrentar a minha.",
  q50:
    "Sair da operacao do dia a dia e conseguir pensar o medio prazo sem culpa de " +
    "nao estar apagando incendio.",
  q51:
    "Clareza sobre o que eu posso soltar e coragem para sustentar essa escolha " +
    "diante da equipe.",
  q52:
    "Chegar em dezembro com a area funcionando sem depender de mim para cada " +
    "decisao, e com tempo meu de volta na semana.",
};

const ABERTA_PADRAO =
  "Respondo com o que vivo hoje: o trabalho ocupa quase todo o espaco e estou " +
  "tentando reorganizar prioridades sem abandonar o que construi.";

class ErroDePlano extends Error {}

function exigeTexto(valor, pergunta) {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new ErroDePlano(
      `pergunta ${pergunta.id} (${pergunta.type}) ficou sem resposta no plano`,
    );
  }
  return valor;
}

/**
 * Texto da alternativa correspondente a letra escolhida, lido das `options` que
 * vieram do banco. NAO monta o texto: se a alternativa nao existir com o
 * prefixo esperado, lanca. E assim que a jornada percebe que a 017 mudou.
 */
export function textoDaAlternativa(pergunta, letra) {
  const opcoes = Array.isArray(pergunta.options) ? pergunta.options : [];
  const prefixo = `${letra}. `;
  const achada = opcoes.find((o) => typeof o === "string" && o.startsWith(prefixo));
  if (!achada) {
    throw new ErroDePlano(
      `pergunta ${pergunta.id}: nenhuma alternativa comeca com "${prefixo}" ` +
        `(opcoes no banco: ${JSON.stringify(opcoes)})`,
    );
  }
  if (achada.trim().length <= prefixo.length) {
    throw new ErroDePlano(`pergunta ${pergunta.id}: alternativa "${achada}" sem texto`);
  }
  return achada;
}

/**
 * Monta o objeto `answers` de UMA etapa, no formato que a tela do participante
 * grava em quiz_responses.answers.
 *
 * Devolve tambem a lista de situacionais da etapa (id, letra escolhida, texto
 * gravado), que a jornada usa para provar que o que foi GRAVADO e o texto da
 * alternativa -- e nao a letra, que tornaria a prova da normalizacao vazia.
 */
export function montarRespostasDaEtapa(etapa, { nomeCompleto }) {
  const answers = {};
  const situacionais = [];

  for (const pergunta of etapa.questions) {
    const { id, type } = pergunta;

    if (type === "select") {
      const letra = LETRAS_SITUACIONAIS[id];
      if (!letra) {
        throw new ErroDePlano(
          `pergunta ${id} e do tipo select e o plano nao tem letra para ela ` +
            `(situacional nova na 017?)`,
        );
      }
      const texto = textoDaAlternativa(pergunta, letra);
      answers[id] = texto;
      situacionais.push({ id, letra, texto });
      continue;
    }

    if (type === "scale") {
      const min = pergunta.min;
      const max = pergunta.max;
      const valor =
        min === 0 && max === 10
          ? VALORES_ELEMENTOS[id]
          : min === 1 && max === 5
            ? VALORES_LIKERT[id]
            : undefined;
      if (valor === undefined) {
        throw new ErroDePlano(
          `pergunta ${id} e escala ${min}..${max} e o plano nao tem valor para ela`,
        );
      }
      if (valor < min || valor > max) {
        throw new ErroDePlano(
          `pergunta ${id}: valor ${valor} do plano esta fora da faixa ${min}..${max}`,
        );
      }
      answers[id] = valor;
      continue;
    }

    if (type === "short_text") {
      answers[id] = exigeTexto(id === "q1" ? nomeCompleto : CURTAS[id], pergunta);
      continue;
    }

    if (type === "text") {
      answers[id] = exigeTexto(ABERTAS[id] ?? ABERTA_PADRAO, pergunta);
      continue;
    }

    throw new ErroDePlano(
      `pergunta ${id}: tipo "${type}" nao previsto no plano da jornada`,
    );
  }

  return { answers, situacionais };
}

/**
 * Repete as regras que a TELA aplica antes de deixar enviar (`allValid` em
 * app/(participant)/quiz/[stageId]/page.tsx) sobre as respostas que o plano
 * produziu. Serve para a jornada nao gravar, por um caminho de servidor, algo
 * que a interface recusaria -- o que faria o teste medir um fluxo que nenhuma
 * pessoa consegue executar. Devolve a lista de problemas (vazia = passaria).
 */
export function problemasPelaRegraDaInterface(etapa, answers) {
  const problemas = [];
  for (const q of etapa.questions) {
    const val = answers[q.id];
    const texto = typeof val === "string" ? val : "";
    switch (q.type) {
      case "select":
      case "short_text":
      case "dilemma":
        if (q.required && texto.length === 0) problemas.push(`${q.id}: obrigatoria e vazia`);
        if (q.max_chars && texto.length > q.max_chars) {
          problemas.push(`${q.id}: ${texto.length} caracteres passa do max_chars ${q.max_chars}`);
        }
        break;
      case "text": {
        const min = q.min_chars ?? 0;
        if (min > 0 && texto.trim().length < min) {
          problemas.push(`${q.id}: ${texto.trim().length} caracteres abaixo do min_chars ${min}`);
        } else if (min === 0 && q.required && texto.trim().length === 0) {
          problemas.push(`${q.id}: obrigatoria e vazia`);
        }
        break;
      }
      case "scale":
        if (typeof val !== "number" && q.required) problemas.push(`${q.id}: escala sem numero`);
        break;
      case "multi_select":
      case "ranking":
        if (q.required) problemas.push(`${q.id}: tipo ${q.type} nao previsto no plano`);
        break;
      default:
        break;
    }
  }
  return problemas;
}
