"use client";

// A TELA DA IMPORTACAO. O que ela existe para fazer: o operador VE o que vai
// acontecer ANTES de autorizar.
//
// A ordem na tela e a ordem dos fatos, e nao e negociavel:
//   1. de onde veio (formulario, impressao digital declarada, se o e-mail foi
//      verificado pelo formulario);
//   2. CONFERIR -- so le, nao grava nada;
//   3. a PREVIA: quantas entram, quantas ficam retidas por identidade e por que,
//      quantas tem DADO INCOMPATIVEL e EM QUAIS PERGUNTAS, e a cobertura
//      resultante por instrumento;
//   4. so entao CONFIRMAR, e so sobre a previa que esta na tela.
//
// O botao de confirmar nao existe antes da previa, e DESAPARECE quando qualquer
// campo muda depois dela: confirmar uma previa que ja nao descreve o pedido e
// exatamente o que a previa existe para impedir. E, mesmo que a tela errasse, a
// rota recusaria -- a impressao da previa viaja no corpo.
//
// NENHUMA PONTUACAO ZERO APARECE AQUI. Uma pergunta com DADO INCOMPATIVEL e
// mostrada como DADO INCOMPATIVEL, com o que a pessoa respondeu e o motivo, e a
// cobertura de uma base vazia e "—", nunca 0%.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  aplicarImportacao,
  conferirPreviaContraGravado,
  contarEstados,
  pedirPrevia,
  porcentagem,
  resumoDaPrevia,
  type Desfecho,
  type PedidoDaTela,
  type ResumoGravado,
} from "./importar-respostas";
import { identificarSubmissoes, lerCsv, SEPARADORES, type Separador } from "@/lib/importacao/csv";
import type { Previa } from "@/lib/importacao/borda";

interface Props {
  eventId: string;
}

/** O rotulo de cada acao sugerida. O texto da causa vem da mensagem do host. */
const ROTULO_DA_ACAO: Record<string, string> = {
  corrigir_planilha: "Corrija a planilha e confira de novo.",
  corrigir_coleta: "Corrija a coleta (o formulário ou a versão) e confira de novo.",
  refazer_previa: "Gere a prévia outra vez.",
  entrar_de_novo: "Entre de novo como administrador.",
  aguardar: "Aguarde alguns instantes e tente de novo.",
  instalar_no_banco: "Avise a equipe técnica: falta instalar a atualização do banco.",
  falar_com_equipe: "Avise a equipe técnica.",
};

const CLASSES_DO_AVISO: Record<Desfecho["tipo"], string> = {
  previa: "border-border bg-muted/40",
  aplicado: "border-emerald-600/40 bg-emerald-600/10",
  // CONFERI E NAO PERMITI -> ha o que corrigir.
  recusado: "border-amber-600/50 bg-amber-600/10",
  // NAO CONSEGUI VERIFICAR -> nada foi decidido. Nao e culpa de ninguem.
  nao_verificado: "border-sky-600/50 bg-sky-600/10",
  // NAO ESTA INSTALADO -> nem o operador nem a espera resolvem.
  recurso_ausente: "border-violet-600/50 bg-violet-600/10",
  erro_inesperado: "border-destructive/50 bg-destructive/10",
  sem_conexao: "border-destructive/50 bg-destructive/10",
};

const TITULO_DO_AVISO: Record<Desfecho["tipo"], string> = {
  previa: "Prévia",
  aplicado: "Importação gravada",
  recusado: "Conferido e não autorizado — nada foi gravado",
  nao_verificado: "Não foi possível verificar — nada foi gravado",
  recurso_ausente: "O recurso não está instalado neste ambiente — nada foi gravado",
  erro_inesperado: "Algo inesperado — nada foi gravado",
  sem_conexao: "Sem conexão — nada foi gravado",
};

export function ImportarRespostasExternas({ eventId }: Props) {
  const [formularioId, setFormularioId] = useState("");
  const [formularioNome, setFormularioNome] = useState("");
  const [impressao, setImpressao] = useState("");
  const [emailVerificado, setEmailVerificado] = useState(false);
  const [separador, setSeparador] = useState<Separador>(",");
  const [arquivo, setArquivo] = useState<{ nome: string; conteudo: string } | null>(null);
  const [colunaDoId, setColunaDoId] = useState<string>("");
  const [erroDeLeitura, setErroDeLeitura] = useState<string | null>(null);

  const [previa, setPrevia] = useState<Previa | null>(null);
  const [gravado, setGravado] = useState<ResumoGravado | null>(null);
  const [aviso, setAviso] = useState<Desfecho | null>(null);
  const [ocupado, setOcupado] = useState<null | "previa" | "aplicar">(null);

  // A planilha lida. Se a leitura falhar, NAO ha pedido: nada e enviado meio lido.
  const planilha = useMemo(() => {
    if (arquivo === null) return null;
    const r = lerCsv(arquivo.conteudo, separador);
    return r;
  }, [arquivo, separador]);

  const cabecalhos = planilha?.ok ? planilha.cabecalhos : [];

  const pedido: PedidoDaTela | null = useMemo(() => {
    if (!planilha?.ok) return null;
    if (formularioId.trim() === "") return null;
    const indice = colunaDoId === "" ? null : cabecalhos.indexOf(colunaDoId);
    return {
      event_id: eventId,
      formulario_id: formularioId.trim(),
      formulario_nome: formularioNome.trim() === "" ? null : formularioNome.trim(),
      impressao_declarada: impressao.trim(),
      cabecalhos: planilha.cabecalhos,
      linhas: identificarSubmissoes(planilha.linhas, indice === -1 ? null : indice),
      email_verificado: emailVerificado,
    };
  }, [planilha, cabecalhos, colunaDoId, eventId, formularioId, formularioNome, impressao, emailVerificado]);

  // A ASSINATURA DO PEDIDO que gerou a previa na tela. Se o pedido mudar, a previa
  // deixa de descrever o que seria gravado, e o botao de confirmar sai do ar. A
  // rota tambem recusaria, mas uma tela que oferece o botao errado ja mentiu.
  const assinaturaDoPedido = pedido === null ? "" : JSON.stringify(pedido);
  const [assinaturaDaPrevia, setAssinaturaDaPrevia] = useState("");
  const previaDescreveOPedido =
    previa !== null && assinaturaDaPrevia !== "" && assinaturaDaPrevia === assinaturaDoPedido;

  async function carregarArquivo(f: File) {
    setErroDeLeitura(null);
    let conteudo: string;
    try {
      conteudo = await f.text();
    } catch {
      // Arquivo ilegivel: NAO se segue com o que deu para ler. Meia planilha lida
      // viraria resposta ausente para quem estava na outra metade.
      setArquivo(null);
      descartarPrevia();
      setErroDeLeitura(
        "Não foi possível ler este arquivo, então nada foi carregado. Exporte a planilha outra vez e selecione o arquivo de novo.",
      );
      return;
    }
    setArquivo({ nome: f.name, conteudo });
    descartarPrevia();
  }

  function descartarPrevia() {
    setPrevia(null);
    setGravado(null);
    setAssinaturaDaPrevia("");
    setAviso(null);
  }

  async function conferir() {
    if (pedido === null) return;
    setOcupado("previa");
    setGravado(null);
    const r = await pedirPrevia(pedido);
    setAviso(r);
    if (r.tipo === "previa") {
      setPrevia(r.previa);
      setAssinaturaDaPrevia(assinaturaDoPedido);
    } else {
      setPrevia(null);
      setAssinaturaDaPrevia("");
    }
    setOcupado(null);
  }

  async function confirmar() {
    if (pedido === null || previa === null || !previaDescreveOPedido) return;
    setOcupado("aplicar");
    const r = await aplicarImportacao(pedido, previa);
    setAviso(r);
    if (r.tipo === "aplicado") {
      setPrevia(r.previa);
      setGravado(r.gravado);
    } else if (r.tipo === "recusado" && r.codigo === "IMPORT_PREVIEW_STALE") {
      // A previa venceu: pede a nova NA HORA, para o operador ver o que mudou em
      // vez de so ler que venceu. Nada foi gravado neste caminho.
      const nova = await pedirPrevia(pedido);
      if (nova.tipo === "previa") {
        setPrevia(nova.previa);
        setAssinaturaDaPrevia(assinaturaDoPedido);
      } else {
        setPrevia(null);
        setAssinaturaDaPrevia("");
      }
    }
    setOcupado(null);
  }

  const conferencia = previa !== null && gravado !== null ? conferirPreviaContraGravado(previa, gravado) : null;
  const falha = aviso !== null && aviso.tipo !== "previa" && aviso.tipo !== "aplicado" ? aviso : null;

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------ 1. de onde veio */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
            1. De onde vieram estas respostas
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Sem formulário de origem identificado não há procedência, e sem procedência não se sabe de
            onde veio um dado que vai virar documento sobre uma pessoa. A impressão digital é a que o
            sistema exportou junto com o questionário: ela é conferida <strong>antes</strong> de qualquer
            resposta ser pontuada.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="imp-form-id">Identificador do formulário</Label>
            <Input
              id="imp-form-id"
              value={formularioId}
              placeholder="1FAIpQLSc..."
              onChange={(e) => {
                setFormularioId(e.target.value);
                descartarPrevia();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imp-form-nome">Nome do formulário (opcional)</Label>
            <Input
              id="imp-form-nome"
              value={formularioNome}
              placeholder="Marco Zero — pré-evento"
              onChange={(e) => {
                setFormularioNome(e.target.value);
                descartarPrevia();
              }}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imp-impressao">Impressão digital do questionário declarada pela coleta</Label>
          <Input
            id="imp-impressao"
            value={impressao}
            placeholder="SHA-256 de 64 dígitos"
            className="font-mono text-xs"
            onChange={(e) => {
              setImpressao(e.target.value);
              descartarPrevia();
            }}
          />
          <p className="text-xs text-muted-foreground">
            Se ela não estiver à mão, a conferência devolve <em>não foi possível conferir</em> — que não é
            a mesma coisa que <em>o questionário está errado</em>, e também bloqueia.
          </p>
        </div>

        <label className="flex items-start gap-3 rounded-md border border-border p-3">
          <input
            type="checkbox"
            checked={emailVerificado}
            className="mt-0.5"
            onChange={(e) => {
              setEmailVerificado(e.target.checked);
              descartarPrevia();
            }}
          />
          <span className="text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">O formulário confirmou a posse do e-mail</strong> (respondentes
            restritos, com e-mail verificado). Marque apenas se souber como o formulário foi configurado: um
            e-mail apenas digitado não identifica ninguém, e deixar desmarcado leva todas as submissões para{" "}
            <strong>pendente</strong> — visível e corrigível, nunca atribuído a quem não é.
          </span>
        </label>
      </section>

      {/* ------------------------------------------------ 2. a planilha */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
            2. O arquivo exportado pelo formulário
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            O cabeçalho de cada coluna é o enunciado da pergunta, copiado como está no formulário. A
            correspondência é por texto exato: nenhuma coluna é atribuída à pergunta mais parecida.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="imp-arquivo">Arquivo (CSV ou TSV)</Label>
            <Input
              id="imp-arquivo"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void carregarArquivo(f);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imp-separador">Separador de colunas</Label>
            <select
              id="imp-separador"
              value={separador}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              onChange={(e) => {
                setSeparador(e.target.value as Separador);
                descartarPrevia();
              }}
            >
              {SEPARADORES.map((s) => (
                <option key={s.valor} value={s.valor}>
                  {s.rotulo}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Declarado, nunca adivinhado: um palpite errado aqui leria respostas na coluna errada.
            </p>
          </div>
        </div>

        {erroDeLeitura && <p className="text-xs text-destructive">{erroDeLeitura}</p>}

        {planilha && !planilha.ok && (
          <div className="rounded-md border border-amber-600/50 bg-amber-600/10 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground">O arquivo não foi lido, e nada foi enviado.</p>
            <p className="mt-1 text-muted-foreground">{planilha.motivo}</p>
          </div>
        )}

        {planilha?.ok && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">{arquivo?.nome}</strong>: {planilha.cabecalhos.length} coluna(s),{" "}
              {planilha.linhas.length} submissão(ões).
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="imp-coluna-id">Coluna com o identificador da submissão</Label>
              <select
                id="imp-coluna-id"
                value={colunaDoId}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                onChange={(e) => {
                  setColunaDoId(e.target.value);
                  descartarPrevia();
                }}
              >
                <option value="">usar a posição na planilha (linha-N)</option>
                {planilha.cabecalhos.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                O formulário não exporta um id de resposta. Ele não é inventado: ou vem de uma coluna que você
                aponta (o carimbo de data/hora serve), ou fica registrado como a posição na planilha — e quem
                ler a procedência depois vê qual dos dois foi.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* ------------------------------------------------ 3. conferir */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void conferir()} disabled={pedido === null || ocupado !== null}>
            {ocupado === "previa" ? "Conferindo..." : "Conferir (não grava nada)"}
          </Button>
          {pedido === null && (
            <p className="text-xs text-muted-foreground">
              Informe o formulário de origem e carregue o arquivo para conferir.
            </p>
          )}
        </div>
      </section>

      {/* Os desfechos que NAO sao previa nem gravacao: cada classe com o seu
          proprio tratamento, porque "não consegui verificar", "verifiquei e não
          permiti" e "não está instalado" exigem reações diferentes de quem lê. */}
      {falha && (
        <div className={`rounded-md border p-4 text-sm ${CLASSES_DO_AVISO[falha.tipo]}`}>
          <p className="font-medium text-foreground">{TITULO_DO_AVISO[falha.tipo]}</p>
          <p className="mt-1.5 leading-relaxed text-muted-foreground">{falha.mensagem}</p>
          {"acao" in falha && (
            <p className="mt-2 text-xs font-medium text-foreground">{ROTULO_DA_ACAO[falha.acao]}</p>
          )}
          {"codigo" in falha && (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {falha.codigo}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ 4. a previa */}
      {previa && <BlocoDaPrevia previa={previa} gravado={gravado} />}

      {previa && gravado === null && (
        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
            4. Confirmar a importação
          </h2>
          {previaDescreveOPedido ? (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Vai gravar exatamente o que a prévia acima descreve. A procedência de cada submissão fica
                registrada com o formulário de origem, o identificador da submissão, a versão e a impressão do
                questionário, a identidade reconciliada e você como responsável. A reconciliação é reversível.
              </p>
              <Button onClick={() => void confirmar()} disabled={ocupado !== null}>
                {ocupado === "aplicar" ? "Gravando..." : "Confirmar e gravar"}
              </Button>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              Algo mudou desde esta prévia, então ela já não descreve o que seria gravado. Confira outra vez
              antes de confirmar.
            </p>
          )}
        </section>
      )}

      {/* --------------------------- 5. a previa bateu com o que foi gravado? */}
      {conferencia && (
        <div
          className={`rounded-md border p-4 text-sm ${
            conferencia.bate ? "border-emerald-600/40 bg-emerald-600/10" : "border-destructive/50 bg-destructive/10"
          }`}
        >
          <p className="font-medium text-foreground">
            {conferencia.bate
              ? "A prévia correspondeu ao que foi gravado."
              : "ATENÇÃO: o que foi gravado NÃO corresponde à prévia."}
          </p>
          {conferencia.bate ? (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {gravado?.linhas_de_resposta_gravadas} linha(s) de resposta e {gravado?.itens_registrados} item(ns)
              registrados, iguais aos da prévia, com os mesmos estados por submissão.
            </p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {conferencia.divergencias.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// A PREVIA, desenhada
// ===========================================================================

function BlocoDaPrevia({ previa, gravado }: { previa: Previa; gravado: ResumoGravado | null }) {
  const estados = contarEstados(previa);
  const retidas = previa.retidas_por_identidade;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
          3. O que {gravado ? "aconteceu" : "vai acontecer"}
        </h2>
        <p className="text-sm leading-relaxed text-foreground">{resumoDaPrevia(previa)}</p>
        <p className="font-mono text-[10px] text-muted-foreground">
          questionário {previa.questionario_impressao.slice(0, 16)}… · versão {previa.quiz_version} · prévia{" "}
          {previa.impressao_da_previa.slice(0, 16)}…
        </p>
      </div>

      {/* os quatro estados, nomeados */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Numero
          titulo="Entram"
          valor={estados.importavel}
          nota="identidade resolvida e nenhuma incompatibilidade em pergunta pontuada"
        />
        <Numero
          titulo="Dado incompatível"
          valor={estados.incompativel}
          nota="respondeu e a correspondência falhou; as respostas compatíveis são gravadas, a submissão NÃO pontua — não é zero"
        />
        <Numero
          titulo="Pendentes"
          valor={estados.pendente}
          nota="identidade não resolvida; espera decisão humana, nada é gravado como de ninguém"
        />
        <Numero
          titulo="Em conflito"
          valor={estados.conflito}
          nota="mais de um candidato de um dos lados; nunca resolvido por desempate automático"
        />
      </div>

      {/* a cobertura resultante */}
      <div className="space-y-2 rounded-md border border-border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-foreground">
            Cobertura pontuável resultante
          </h3>
          <span className="font-mono text-lg text-foreground">{porcentagem(previa.cobertura.geral)}</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Medida sobre as {previa.cobertura.base_de_submissoes} submissão(ões) com identidade resolvida, nas{" "}
          {previa.cobertura.perguntas_pontuadas} perguntas que o motor pontua. Submissão pendente não entra como
          cobertura zero: enquanto não se sabe de quem é, não há resultado para medir.
        </p>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1.5 font-medium">Instrumento</th>
              <th className="py-1.5 text-right font-medium">Perguntas</th>
              <th className="py-1.5 text-right font-medium">Compatíveis</th>
              <th className="py-1.5 text-right font-medium">Incompatíveis</th>
              <th className="py-1.5 text-right font-medium">Ausentes</th>
              <th className="py-1.5 text-right font-medium">Cobertura</th>
            </tr>
          </thead>
          <tbody>
            {previa.cobertura.por_instrumento.map((i) => (
              <tr key={i.instrumento} className="border-b border-border/50">
                <td className="py-1.5 text-foreground">{i.instrumento}</td>
                <td className="py-1.5 text-right tabular-nums">{i.perguntas}</td>
                <td className="py-1.5 text-right tabular-nums">{i.compativeis}</td>
                <td className={`py-1.5 text-right tabular-nums ${i.incompativeis > 0 ? "text-amber-700 dark:text-amber-400" : ""}`}>
                  {i.incompativeis}
                </td>
                <td className="py-1.5 text-right tabular-nums">{i.ausentes}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{porcentagem(i.cobertura)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* DADO INCOMPATIVEL, pergunta por pergunta */}
      {previa.com_dado_incompativel.perguntas.length > 0 && (
        <div className="space-y-3 rounded-md border border-amber-600/50 bg-amber-600/5 p-4">
          <div className="space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-foreground">
              Dado incompatível — em quais perguntas
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {previa.com_dado_incompativel.itens} resposta(s) foram respondidas e não correspondem à alternativa
              declarada no questionário do sistema, {previa.com_dado_incompativel.itens_pontuados} delas em
              perguntas que o motor pontua. Elas não entram na pontuação e <strong>não viram zero</strong>: zero
              parece resultado, e foi assim que um instrumento inteiro foi de 73% de cobertura a nada, em silêncio,
              neste projeto. Quase sempre é uma palavra trocada ao copiar a alternativa para o formulário.
            </p>
          </div>
          <ul className="space-y-3">
            {previa.com_dado_incompativel.perguntas.map((p) => (
              <li key={p.pergunta_id} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-foreground">{p.pergunta_id}</span>
                  {p.pontuada ? (
                    <span className="rounded bg-amber-600/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:text-amber-300">
                      pontuada · {p.instrumento}
                    </span>
                  ) : (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      não pontuada
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {p.submissoes} submissão(ões)
                  </span>
                </div>
                {p.enunciado && <p className="mt-1.5 text-xs leading-relaxed text-foreground">{p.enunciado}</p>}
                <ul className="mt-2 space-y-1">
                  {p.exemplos.map((e) => (
                    <li key={e.submissao_id} className="text-xs text-muted-foreground">
                      <span className="font-mono">{e.submissao_id}</span> respondeu{" "}
                      <span className="font-mono text-foreground">{JSON.stringify(e.respondido)}</span> — {e.motivo}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* identidade retida */}
      {retidas.submissoes.length > 0 && (
        <div className="space-y-3 rounded-md border border-border p-4">
          <div className="space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-[0.1em] text-foreground">
              Retidas por identidade — esperam decisão humana
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Nenhum participante é criado a partir de uma importação, e nenhuma destas submissões é descartada:
              as respostas ficam guardadas como foram coletadas, só não viram resposta canônica de ninguém até
              alguém decidir de quem são.
            </p>
          </div>
          <ul className="space-y-2">
            {retidas.submissoes.map((s) => (
              <li key={s.submissao_id} className="text-xs">
                <span className="font-mono text-foreground">{s.submissao_id}</span>{" "}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {s.estado}
                </span>{" "}
                {s.email && <span className="text-muted-foreground">{s.email}</span>}
                <p className="mt-0.5 leading-relaxed text-muted-foreground">{s.motivo}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* submissao por submissao */}
      <details className="rounded-md border border-border p-4">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.1em] text-foreground">
          Submissão por submissão ({previa.submissoes.length})
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Submissão</th>
                <th className="py-1.5 pr-3 font-medium">Estado</th>
                <th className="py-1.5 pr-3 font-medium">E-mail da coleta</th>
                <th className="py-1.5 pr-3 font-medium">Identidade</th>
                <th className="py-1.5 pr-3 text-right font-medium">Compat.</th>
                <th className="py-1.5 pr-3 text-right font-medium">Incompat.</th>
                <th className="py-1.5 pr-3 text-right font-medium">Ausentes</th>
                <th className="py-1.5 pr-3 text-right font-medium">Etapas</th>
                <th className="py-1.5 font-medium">Pontua?</th>
              </tr>
            </thead>
            <tbody>
              {previa.submissoes.map((s) => (
                <tr key={s.submissao_id} className="border-b border-border/50 align-top">
                  <td className="py-1.5 pr-3 font-mono text-foreground">{s.submissao_id}</td>
                  <td className="py-1.5 pr-3">{s.estado}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{s.email ?? "—"}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {s.participant_id ? `${s.identidade_via}` : (s.motivo_da_identidade ?? "—")}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.contagens.compativeis}</td>
                  <td
                    className={`py-1.5 pr-3 text-right tabular-nums ${s.contagens.incompativeis > 0 ? "text-amber-700 dark:text-amber-400" : ""}`}
                  >
                    {s.contagens.incompativeis}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.contagens.ausentes}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.etapas_a_gravar}</td>
                  <td className="py-1.5">
                    {s.apto_para_pontuar ? (
                      "sim"
                    ) : (
                      <span className="text-muted-foreground">
                        não — {s.bloqueio?.motivo.slice(0, 80) ?? "bloqueada"}
                        {s.bloqueio && s.bloqueio.perguntas.length > 0 && (
                          <> ({s.bloqueio.perguntas.join(", ")})</>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Numero({ titulo, valor, nota }: { titulo: string; valor: number; nota: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{titulo}</p>
      <p className="mt-0.5 font-mono text-2xl text-foreground tabular-nums">{valor}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{nota}</p>
    </div>
  );
}
