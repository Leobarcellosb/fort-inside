import { describe, expect, it } from "vitest";
import {
  MINIMO_DO_MOTIVO,
  ROTULO_SUSPENDER,
  TEXTO_CAMINHO_DA_RETIFICACAO,
  TEXTO_DA_CONFIRMACAO,
  TEXTO_JA_ESTA_FORA_DO_AR,
  TEXTO_MOTIVO_CURTO,
  TEXTO_MOTIVO_OBRIGATORIO,
  TEXTO_SO_ENTREGUE_SUSPENDE,
  idDaRazaoDaSuspensao,
  situacaoDaSuspensao,
  validarMotivoDaSuspensao,
} from "./suspensao-do-documento";
import { idDaRazao, situacaoDaEntrega } from "./entrega-do-documento";

describe("situacaoDaSuspensao: o ato só existe onde ele faz sentido", () => {
  it("documento ENTREGUE: o ato está disponível (é o único que alguém está lendo)", () => {
    expect(situacaoDaSuspensao({ status: "delivered" })).toEqual({ disponivel: true });
  });

  it("documento JÁ fora do ar: não acontece de novo, e a razão diz o que o jovem vê", () => {
    const s = situacaoDaSuspensao({ status: "suspended" });
    expect(s.disponivel).toBe(false);
    if (s.disponivel) throw new Error("inalcançável");
    expect(s.motivo).toBe("ja_suspenso");
    expect(s.texto).toBe(TEXTO_JA_ESTA_FORA_DO_AR);
  });

  it("qualquer estado ANTES da entrega: não há o que tirar do ar", () => {
    for (const status of ["pending", "generating", "generated", "in_review", "reviewed"]) {
      const s = situacaoDaSuspensao({ status });
      expect(s.disponivel).toBe(false);
      if (s.disponivel) throw new Error("inalcançável");
      expect(s.motivo).toBe("nao_entregue");
      expect(s.texto).toBe(TEXTO_SO_ENTREGUE_SUSPENDE);
    }
  });

  it("linha sem status (undefined ou null) não libera o ato", () => {
    expect(situacaoDaSuspensao({}).disponivel).toBe(false);
    expect(situacaoDaSuspensao({ status: null }).disponivel).toBe(false);
  });
});

describe("validarMotivoDaSuspensao: ato de operador sem motivo não é ato registrado", () => {
  it("vazio: recusa, e o texto diz que o registro fica guardado como ato dele", () => {
    const v = validarMotivoDaSuspensao("");
    expect(v.valido).toBe(false);
    if (v.valido) throw new Error("inalcançável");
    expect(v.problema).toBe("ausente");
    expect(v.texto).toBe(TEXTO_MOTIVO_OBRIGATORIO);
  });

  it("nulo e ausente contam como vazio", () => {
    expect(validarMotivoDaSuspensao(null).valido).toBe(false);
    expect(validarMotivoDaSuspensao(undefined).valido).toBe(false);
  });

  it("só espaços não é motivo: mede DEPOIS do trim, igual ao btrim do banco", () => {
    const v = validarMotivoDaSuspensao("                         ");
    expect(v.valido).toBe(false);
    if (v.valido) throw new Error("inalcançável");
    // Espaço nenhum sobrevive ao trim, então o problema é "ausente", não "curto":
    // dizer "escreva mais" sobre um campo em branco manda fazer a coisa errada.
    expect(v.problema).toBe("ausente");
  });

  it("curto: recusa com o piso nomeado no texto", () => {
    const v = validarMotivoDaSuspensao("erro");
    expect(v.valido).toBe(false);
    if (v.valido) throw new Error("inalcançável");
    expect(v.problema).toBe("curto");
    expect(v.texto).toBe(TEXTO_MOTIVO_CURTO);
    expect(TEXTO_MOTIVO_CURTO).toContain(String(MINIMO_DO_MOTIVO));
  });

  it("a FRONTEIRA do piso, nos dois lados", () => {
    // O MESMO piso que o CHECK da migration 027 impõe. Se a tela aceitasse um a
    // menos, o operador escreveria o motivo e perderia o texto na recusa do banco.
    expect(validarMotivoDaSuspensao("a".repeat(MINIMO_DO_MOTIVO - 1)).valido).toBe(false);
    expect(validarMotivoDaSuspensao("a".repeat(MINIMO_DO_MOTIVO)).valido).toBe(true);
  });

  it("aceito: devolve o motivo JÁ sem as pontas, que é o que vai para o banco", () => {
    const v = validarMotivoDaSuspensao("   a trilha saiu trocada no texto   ");
    expect(v.valido).toBe(true);
    if (!v.valido) throw new Error("inalcançável");
    expect(v.motivo).toBe("a trilha saiu trocada no texto");
  });
});

describe("os textos INSTRUEM, e dizem as duas metades do princípio", () => {
  it("o caminho da retificação nomeia a ação, o passo que aprova e a entrega", () => {
    expect(TEXTO_CAMINHO_DA_RETIFICACAO).toContain("Editar");
    expect(TEXTO_CAMINHO_DA_RETIFICACAO).toContain("salve");
    expect(TEXTO_CAMINHO_DA_RETIFICACAO).toContain("entrega é liberada");
  });

  it("o caminho da retificação diz que a versão anterior NÃO é reaberta nem perdida", () => {
    // As duas metades do princípio da revisão, na mesma frase: não reabrir a
    // versão anterior, e não apagar o erro da história.
    expect(TEXTO_CAMINHO_DA_RETIFICACAO).toContain("não é reaberta");
    expect(TEXTO_CAMINHO_DA_RETIFICACAO).toContain("histórico");
  });

  it("a confirmação diz o que acontece com o JOVEM e que nada é apagado", () => {
    expect(TEXTO_DA_CONFIRMACAO).toContain("imediatamente");
    expect(TEXTO_DA_CONFIRMACAO).toContain("Nada é apagado");
    expect(TEXTO_DA_CONFIRMACAO).toContain("histórico");
  });

  it("o rótulo do botão fala do documento, não da coluna do banco", () => {
    // "Suspender" é o nome do estado; "Tirar do ar" é o que acontece com quem
    // estava lendo -- e é isso que o operador está decidindo.
    expect(ROTULO_SUSPENDER).toBe("Tirar do ar");
    expect(ROTULO_SUSPENDER.toLowerCase()).not.toContain("suspend");
  });

  it("são frases de verdade, não rótulos de três palavras", () => {
    for (const texto of [
      TEXTO_CAMINHO_DA_RETIFICACAO,
      TEXTO_DA_CONFIRMACAO,
      TEXTO_JA_ESTA_FORA_DO_AR,
      TEXTO_SO_ENTREGUE_SUSPENDE,
      TEXTO_MOTIVO_OBRIGATORIO,
    ]) {
      expect(texto.length).toBeGreaterThan(80);
    }
  });
});

describe("idDaRazaoDaSuspensao: dois botões no mesmo cartão, duas razões", () => {
  it("documentos diferentes têm identificadores diferentes", () => {
    expect(idDaRazaoDaSuspensao("doc-a")).not.toBe(idDaRazaoDaSuspensao("doc-b"));
  });

  it("NÃO colide com o id da razão da entrega do mesmo documento", () => {
    // Um id só faria o leitor de tela anunciar a razão do OUTRO botão -- os dois
    // podem existir no mesmo cartão e falam de atos diferentes.
    expect(idDaRazaoDaSuspensao("doc-a")).not.toBe(idDaRazao("doc-a"));
  });
});

describe("a entrega de um documento FORA DO AR fica bloqueada, e com o texto certo", () => {
  it("documento suspenso COM selo: a entrega NÃO é liberada", () => {
    // Esta é a asserção que o desenho exige. O selo da 025 é imutável fora do ato
    // de aprovação, então um documento suspenso CONTINUA com selo -- e sem esta
    // conferência `situacaoDaEntrega` responderia "liberada" e a tela ofereceria
    // um botão que só pode falhar, sobre o texto errado.
    const s = situacaoDaEntrega({ status: "suspended", conteudo_aprovado_hash: "a3f9c1" });
    expect(s.liberada).toBe(false);
    if (s.liberada) throw new Error("inalcançável");
    expect(s.motivo).toBe("suspenso_aguardando_nova_revisao");
    expect(s.texto).toBe(TEXTO_CAMINHO_DA_RETIFICACAO);
  });

  it("suspenso SEM selo também é bloqueado, e pelo motivo da suspensão", () => {
    // A suspensão é conferida ANTES do selo: o fato que manda é "está fora do
    // ar", e a instrução é a mesma (corrigir e salvar).
    const s = situacaoDaEntrega({ status: "suspended", conteudo_aprovado_hash: null });
    expect(s.liberada).toBe(false);
    if (s.liberada) throw new Error("inalcançável");
    expect(s.motivo).toBe("suspenso_aguardando_nova_revisao");
  });

  it("CONTROLE POSITIVO: o mesmo selo num documento NÃO suspenso libera a entrega", () => {
    // Sem isto, o teste acima poderia estar medindo "entrega quebrada para todo
    // mundo" em vez de "bloqueada porque está fora do ar".
    expect(situacaoDaEntrega({ status: "reviewed", conteudo_aprovado_hash: "a3f9c1" })).toEqual({
      liberada: true,
    });
  });

  it("depois da nova revisão o documento sai de suspenso e a entrega é liberada", () => {
    // O caminho inteiro, em três estados: entregue -> fora do ar -> revisado.
    expect(situacaoDaEntrega({ status: "delivered", conteudo_aprovado_hash: "aa" }).liberada).toBe(true);
    expect(situacaoDaEntrega({ status: "suspended", conteudo_aprovado_hash: "aa" }).liberada).toBe(false);
    expect(situacaoDaEntrega({ status: "reviewed", conteudo_aprovado_hash: "bb" }).liberada).toBe(true);
  });
});
