"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  obrigatoriasEmFalta,
  textoDaFalta,
  type MapaDeRespostas,
  type PerguntaEmFalta,
  type ValorDeResposta,
} from "@/lib/quiz/obrigatorias";
import type { QuizQuestion } from "@/types/database";

/*
 * O FORMULARIO PUBLICO -- o link que vai por WhatsApp.
 *
 * TRES DECISOES DE DESENHO, E A RAZAO DE CADA UMA
 * -----------------------------------------------
 *
 * 1. EM PASSOS, NAO NUMA ROLAGEM SO. Sao 52 perguntas. Num celular, uma pagina
 *    unica com as 52 e uma barra de rolagem de varios metros: a pessoa nao sabe
 *    onde esta, nao sabe quanto falta, e um toque errado no "voltar" do navegador
 *    custa tudo. Em passos (identificacao + as 5 etapas) cada tela cabe na mao e
 *    a barra de progresso diz onde ela esta.
 *
 * 2. O PROGRESSO NAO SE PERDE. Voltar um passo e so trocar de tela: o que foi
 *    respondido vive no estado do componente e continua la. E porque adolescente
 *    perde a aba, recebe ligacao e troca de app no meio, tudo e espelhado no
 *    `localStorage` por codigo de evento -- fechar e abrir de novo volta no passo
 *    em que estava, com o que ja estava escrito. Toda leitura e escrita do
 *    armazenamento esta dentro de try/catch: em aba privativa ele lanca, e o
 *    formulario tem de continuar funcionando (so sem a rede de seguranca).
 *
 * 3. O BOTAO NUNCA FICA CINZA SEM EXPLICACAO. Esta e regra firme deste projeto
 *    (tests/contrato/explicacao-nao-fica-no-hover.test.ts): a razao de um envio
 *    ser recusado e CONTEUDO DA TELA. Entao o botao continua CLICAVEL mesmo com
 *    obrigatoria em branco -- ao toca-lo, a tela escreve QUAIS perguntas faltam,
 *    com numero e enunciado, leva o foco para a primeira e marca cada campo. Um
 *    botao desabilitado nao teria como dizer nada disso, e num celular nao existe
 *    hover para um `title` aparecer. NENHUM atributo `title` neste arquivo.
 */

export interface EtapaDoFormulario {
  id: number;
  numero: number;
  titulo: string;
  ambiente: string;
  descricao: string | null;
  questions: QuizQuestion[];
}

interface Props {
  eventCode: string;
  eventName: string;
  /** Data do evento ja formatada no servidor (evita divergencia de fuso/locale). */
  dataDoEvento: string | null;
  etapas: EtapaDoFormulario[];
}

interface Identificacao {
  nome: string;
  email: string;
  telefone: string;
}

const VAZIA: Identificacao = { nome: "", email: "", telefone: "" };

/** Mesma validacao de e-mail do zod `.email()`, o suficiente para avisar antes de enviar. */
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function chaveDoRascunho(eventCode: string) {
  return `fort_formulario_${eventCode}`;
}

/**
 * OS ROTULOS DAS DUAS PONTAS DE UMA ESCALA, POR FAIXA.
 *
 * POR QUE POR FAIXA, e nao por etapa: num celular, a etapa 3 tem 24 perguntas de
 * 1 a 5 seguidas. Quem esta na pergunta 20 ja rolou a legenda do topo para fora
 * da tela, e um "3" sem ponta nomeada nao quer dizer nada -- se a pessoa inverter
 * o sentido no meio, o perfil sai invertido e o documento de segunda-feira
 * tambem. Amarrar o rotulo ao NUMERO DA ETAPA quebraria no dia em que a ordem
 * das etapas mudasse; amarrar a FAIXA da pergunta (min/max) nao quebra.
 *
 * Os textos sao os do documento original do dono, palavra por palavra.
 *
 * Isto e so a RESERVA: quando a propria pergunta traz `min_label`/`max_label`
 * (como traz hoje no questionario v2), sao os dela que aparecem. A reserva
 * garante que a ponta esteja nomeada mesmo numa pergunta cadastrada sem rotulo,
 * em vez de a tela mostrar numeros nus.
 */
const ROTULOS_POR_FAIXA: Record<string, readonly [string, string]> = {
  "1-5": ["Discordo totalmente", "Concordo totalmente"],
  "0-10": ["Totalmente insatisfeito", "Plenamente satisfeito"],
};

function rotulosDaEscala(
  question: QuizQuestion,
  menor: number,
  maior: number,
): [string | null, string | null] {
  const reserva = ROTULOS_POR_FAIXA[`${menor}-${maior}`];
  return [
    question.min_label ?? reserva?.[0] ?? null,
    question.max_label ?? reserva?.[1] ?? null,
  ];
}

export function FormularioPublico({ eventCode, eventName, dataDoEvento, etapas }: Props) {
  // Passo 0 = identificacao; 1..N = etapas do questionario.
  const [passo, setPasso] = useState(0);
  const [identificacao, setIdentificacao] = useState<Identificacao>(VAZIA);
  const [respostas, setRespostas] = useState<MapaDeRespostas>({});
  const [faltando, setFaltando] = useState<PerguntaEmFalta[]>([]);
  const [errosDeIdentificacao, setErrosDeIdentificacao] = useState<Partial<Identificacao>>({});
  const [enviando, setEnviando] = useState(false);
  const [erroDeEnvio, setErroDeEnvio] = useState<string | null>(null);
  const [concluido, setConcluido] = useState(false);
  /**
   * O envio foi RECEBIDO E GUARDADO, mas nao virou a resposta oficial: ja havia
   * resposta gravada para este e-mail, e a primeira nao se sobrescreve. A tela
   * final e outra, porque o que aconteceu e outro -- dizer "prontinho" aqui
   * seria a tela mentindo.
   */
  const [segundaResposta, setSegundaResposta] = useState(false);
  /**
   * O envio NAO foi confirmado pelo servidor: ou ele respondeu que nao conseguiu
   * gravar (503 PUBLIC_FORM_WRITE_UNAVAILABLE, ou 500), ou a resposta nao chegou
   * (`rede`), ou chegou num formato que nao confirma nada. Em TODOS esses casos o
   * rascunho fica, nada e apagado, e a tela NAO diz que recebeu: ela pede para
   * tentar de novo, e o botao reenvia exatamente o mesmo conteudo.
   */
  const [falhaNoEnvio, setFalhaNoEnvio] = useState<
    { tipo: "servidor" | "rede"; ocorrencia: string | null } | null
  >(null);
  const falhaRef = useRef<HTMLDivElement>(null);
  const [rascunhoLido, setRascunhoLido] = useState(false);

  const topo = useRef<HTMLDivElement>(null);
  const avisoRef = useRef<HTMLDivElement>(null);

  const totalDePassos = etapas.length + 1;
  const etapaAtual = passo > 0 ? etapas[passo - 1] : null;

  // --- rascunho local ------------------------------------------------------
  // Lido DEPOIS da primeira renderizacao, de proposito: ler no estado inicial
  // faria o HTML do servidor e o do cliente divergirem (hydration mismatch).
  useEffect(() => {
    try {
      const salvo = localStorage.getItem(chaveDoRascunho(eventCode));
      if (salvo) {
        const d = JSON.parse(salvo) as {
          identificacao?: Identificacao;
          respostas?: MapaDeRespostas;
          passo?: number;
        };
        if (d.identificacao) setIdentificacao({ ...VAZIA, ...d.identificacao });
        if (d.respostas && typeof d.respostas === "object") setRespostas(d.respostas);
        if (typeof d.passo === "number" && d.passo >= 0 && d.passo < totalDePassos) {
          setPasso(d.passo);
        }
      }
    } catch {
      // Aba privativa ou armazenamento bloqueado: segue sem rascunho.
    }
    setRascunhoLido(true);
  }, [eventCode, totalDePassos]);

  useEffect(() => {
    // `segundaResposta` entra no guarda junto com `concluido` pelo mesmo motivo:
    // o envio chegou ao servidor e esta guardado. Sem isto, o efeito gravaria o
    // rascunho de volta depois de a tela final apaga-lo.
    if (!rascunhoLido || concluido || segundaResposta) return;
    try {
      localStorage.setItem(
        chaveDoRascunho(eventCode),
        JSON.stringify({ identificacao, respostas, passo }),
      );
    } catch {
      // Sem rascunho: o formulario continua funcionando nesta sessao.
    }
  }, [rascunhoLido, concluido, segundaResposta, eventCode, identificacao, respostas, passo]);

  const subir = useCallback(() => {
    topo.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  function responder(questionId: string, valor: ValorDeResposta) {
    setRespostas((atual) => ({ ...atual, [questionId]: valor }));
    // O aviso de pendencia envelhece a cada resposta dada: tira do aviso a
    // pergunta que acabou de ser respondida, em vez de deixar na tela a lista
    // velha (que diria que falta algo que a pessoa ja preencheu).
    setFaltando((atual) => (atual.length === 0 ? atual : atual.filter((f) => f.id !== questionId)));
  }

  function alternarLista(question: QuizQuestion, opcao: string, maximo?: number) {
    const atual = Array.isArray(respostas[question.id])
      ? (respostas[question.id] as string[])
      : [];
    if (atual.includes(opcao)) {
      responder(question.id, atual.filter((o) => o !== opcao));
      return;
    }
    if (maximo && atual.length >= maximo) return;
    responder(question.id, [...atual, opcao]);
  }

  function validarIdentificacao(): boolean {
    const erros: Partial<Identificacao> = {};
    if (identificacao.nome.trim().length < 2) {
      erros.nome = "Escreva seu nome completo (ao menos 2 letras).";
    }
    if (!EMAIL_VALIDO.test(identificacao.email.trim())) {
      erros.email = "Escreva um e-mail válido, como nome@exemplo.com.";
    }
    setErrosDeIdentificacao(erros);
    if (Object.keys(erros).length > 0) {
      subir();
      return false;
    }
    return true;
  }

  function avancar() {
    setErroDeEnvio(null);
    if (passo === 0) {
      if (!validarIdentificacao()) return;
      setPasso(1);
      subir();
      return;
    }
    const pendentes = obrigatoriasEmFalta(etapaAtual!.questions, respostas);
    if (pendentes.length > 0) {
      setFaltando(pendentes);
      // O foco vai para o aviso: num leitor de tela ele e lido, e num celular a
      // tela rola ate ele -- a pessoa nao fica procurando o que falta.
      requestAnimationFrame(() => avisoRef.current?.focus());
      return;
    }
    setFaltando([]);
    if (passo < etapas.length) {
      setPasso(passo + 1);
      subir();
      return;
    }
    void enviar();
  }

  function voltar() {
    setErroDeEnvio(null);
    setFalhaNoEnvio(null);
    setFaltando([]);
    setPasso((p) => Math.max(0, p - 1));
    subir();
  }

  function mostrarFalha(tipo: "servidor" | "rede", ocorrencia: string | null) {
    setErroDeEnvio(null);
    setFalhaNoEnvio({ tipo, ocorrencia });
    requestAnimationFrame(() => falhaRef.current?.focus());
  }

  async function enviar() {
    // Reconferencia de TUDO antes de mandar: a pessoa pode ter voltado e apagado
    // uma resposta de uma etapa anterior depois de ja ter passado por ela.
    for (const etapa of etapas) {
      const pendentes = obrigatoriasEmFalta(etapa.questions, respostas);
      if (pendentes.length > 0) {
        setPasso(etapa.numero);
        setFaltando(pendentes);
        setErroDeEnvio(
          `Antes de enviar, falta responder ${pendentes.length === 1 ? "uma pergunta" : `${pendentes.length} perguntas`} na etapa ${etapa.numero} (${etapa.titulo}). Elas estão marcadas abaixo.`,
        );
        requestAnimationFrame(() => avisoRef.current?.focus());
        return;
      }
    }

    setEnviando(true);
    setErroDeEnvio(null);
    setFalhaNoEnvio(null);
    try {
      const res = await fetch("/api/formulario-publico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_code: eventCode,
          full_name: identificacao.nome,
          email: identificacao.email,
          phone: identificacao.telefone || undefined,
          respostas,
        }),
      });

      const corpo = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        code?: string;
        ocorrencia?: string;
        codigo?: string;
        na_mesa_de_decisao?: boolean;
        faltando?: { etapa: number; titulo: string; faltando: PerguntaEmFalta[] }[];
      } | null;

      if (!res.ok) {
        // O servidor reconfere as obrigatorias com o MESMO modulo da tela. Se ele
        // recusar, a tela leva a pessoa para a etapa apontada e marca os campos --
        // em vez de repetir um erro que ela nao consegue localizar.
        if (res.status === 422 && corpo?.faltando?.length) {
          const primeira = corpo.faltando[0];
          setPasso(primeira.etapa);
          setFaltando(primeira.faltando);
          setErroDeEnvio(corpo.error ?? "Faltam perguntas obrigatórias.");
          requestAnimationFrame(() => avisoRef.current?.focus());
          return;
        }
        // NAO CONSEGUI GRAVAR (503 com o codigo proprio), erro interno (500) ou
        // uma resposta que nem e JSON (gateway, tempo esgotado): o servidor nao
        // confirmou nada. Rascunho fica, e a tela pede para tentar de novo.
        if (
          corpo?.code === "PUBLIC_FORM_WRITE_UNAVAILABLE" ||
          res.status === 500 ||
          corpo === null
        ) {
          mostrarFalha("servidor", corpo?.ocorrencia ?? null);
          return;
        }
        setErroDeEnvio(
          corpo?.error ??
            "Não conseguimos enviar agora. Suas respostas continuam aqui na tela: tente de novo em alguns segundos.",
        );
        subir();
        return;
      }

      // O QUE CONTA COMO "RECEBIDO", e nada alem disso:
      //   - segunda resposta: `codigo` da mesa E `na_mesa_de_decisao === true`.
      //     So entao a tela pode dizer "Guardamos inteiro o que voce respondeu";
      //   - resposta oficial: `success === true` sem codigo.
      // Qualquer outro 200 (corpo ilegivel, formato inesperado) NAO e
      // confirmacao, e a tela trata como falha: rascunho fica, sem "salvamos".
      const naMesa =
        corpo?.success === true &&
        corpo.codigo === "segunda_resposta_guardada" &&
        corpo.na_mesa_de_decisao === true;
      const oficial = corpo?.success === true && corpo.codigo === undefined;
      if (!naMesa && !oficial) {
        mostrarFalha("servidor", null);
        return;
      }

      // Recebido E confirmado. So agora o rascunho sai do navegador: ele existe
      // para não perder o preenchimento, e o preenchimento já chegou.
      try {
        localStorage.removeItem(chaveDoRascunho(eventCode));
      } catch {
        // Nao impede nada: a tela de recebimento ja e a verdade.
      }
      if (naMesa) {
        setSegundaResposta(true);
        subir();
        return;
      }
      setConcluido(true);
      subir();
    } catch {
      // A resposta nao voltou. Pode ter gravado ou nao -- a tela nao sabe, e
      // nao afirma nenhum dos dois. Reenviar e seguro: o mesmo conteudo, do
      // mesmo nome, e reconhecido pelo servidor como o mesmo envio.
      mostrarFalha("rede", null);
    } finally {
      setEnviando(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Recebemos, E JA HAVIA RESPOSTA COM ESTE E-MAIL
  // ---------------------------------------------------------------------------
  // O TEXTO TEM DE SERVIR PARA OS DOIS CASOS, porque a tela nao sabe qual e: a
  // mesma pessoa corrigindo o proprio envio, ou alguem que digitou o e-mail de
  // outra pessoa. Entao ele nao acusa ninguem, nao diz "este e-mail nao e seu",
  // nao mostra o nome de quem respondeu antes, e nao deixa duvida sobre o que
  // aconteceu com o que a pessoa acabou de escrever.
  // ESTA TELA SO APARECE DEPOIS DE O SERVIDOR CONFIRMAR a gravacao na mesa de
  // decisao (`na_mesa_de_decisao === true`, ver `enviar`). "Guardamos inteiro"
  // e uma afirmacao sobre o banco, e so pode ser dita com a confirmacao dele.
  if (segundaResposta) {
    return (
      <div ref={topo} className="px-6 py-16 max-w-md mx-auto space-y-6 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Recebemos</p>
        <h2 className="font-display text-3xl font-bold text-foreground leading-tight">
          Seu envio está guardado, {primeiroNome(identificacao.nome)}.
        </h2>
        <div className="space-y-4 text-[15px] leading-relaxed text-muted-foreground text-left">
          <p>
            Já existe um questionário respondido com este e-mail neste evento. Guardamos inteiro
            o que você respondeu agora.{" "}
            <span className="text-foreground font-medium">Nada do que você escreveu se perdeu</span>,{" "}
            e não colocamos nada por cima do que já estava aqui.
          </p>
          <p>
            <span className="text-foreground font-medium">Por que não substituímos:</span> pode ser
            você corrigindo o que respondeu antes, e pode ser que este e-mail seja de outra pessoa
            e tenha vindo com uma letra trocada. Pela tela não há como saber qual dos dois é, e
            apagar as respostas de alguém por engano não tem volta. Então nenhuma das duas é
            apagada.
          </p>
          <p>
            <span className="text-foreground font-medium">O que acontece agora:</span> alguém da
            equipe vê os dois envios e confirma qual é o seu antes do encontro. Você não precisa
            responder tudo de novo.
          </p>
          <p>
            Se o e-mail que você digitou tem algum erro de letra, ou se quiser contar qual dos
            envios é o certo, fale com a equipe do {eventName}: é o caminho mais rápido para o seu
            envio ser reconhecido como seu.
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Recebemos
  // ---------------------------------------------------------------------------
  if (concluido) {
    return (
      <div ref={topo} className="px-6 py-16 max-w-md mx-auto space-y-6 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Recebemos</p>
        <h2 className="font-display text-3xl font-bold text-foreground leading-tight">
          Prontinho, {primeiroNome(identificacao.nome)}.
        </h2>
        <div className="space-y-4 text-[15px] leading-relaxed text-muted-foreground text-left">
          <p>
            Suas respostas chegaram aqui inteiras. Você não precisa preencher nada de novo,
            nem guardar nenhum código: está tudo registrado no seu nome.
          </p>
          <p>
            <span className="text-foreground font-medium">O que acontece agora:</span> a equipe
            lê o que você escreveu antes do encontro. É isso que faz o {eventName} falar da sua
            vida e não de um roteiro genérico.
          </p>
          <p>
            {dataDoEvento ? (
              <>
                A gente se vê <span className="text-foreground font-medium">{dataDoEvento}</span>.
              </>
            ) : (
              <>A gente se vê no dia do encontro.</>
            )}{" "}
            Depois do encontro, você recebe um documento feito a partir das suas próprias
            respostas. Ele é seu, individual, e não um relatório de turma.
          </p>
          {/* A promessa ANTIGA desta tela era "o novo envio substitui o
              anterior". Ela saiu porque deixou de ser verdade, e por um bom
              motivo: substituir por e-mail digitado deixava qualquer pessoa
              apagar as respostas de outra errando uma letra. O que se promete
              agora e o que o sistema faz. */}
          <p>
            Se precisar corrigir alguma coisa, você pode responder de novo neste mesmo link, com
            o mesmo e-mail. O novo envio{" "}
            <span className="text-foreground font-medium">não apaga este</span>: ele fica guardado
            ao lado, e a equipe confirma qual vale antes do encontro.
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Formulario
  // ---------------------------------------------------------------------------
  const porcentagem = Math.round((passo / totalDePassos) * 100);
  const ultimoPasso = passo === etapas.length;
  const mapaDasFaltas = new Map(faltando.map((f) => [f.id, f]));

  return (
    <div className="pb-32">
      <div ref={topo} className="scroll-mt-4" />

      {/* Progresso. Fica no topo, sempre visivel: num celular e o que diz
          "quanto falta" sem a pessoa ter de rolar. */}
      <div className="px-6 pt-6 max-w-xl mx-auto">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            {passo === 0 ? "Seus dados" : `Etapa ${passo} de ${etapas.length}`}
          </p>
          <p className="text-[11px] text-muted-foreground" aria-hidden="true">
            {porcentagem}%
          </p>
        </div>
        <div
          className="h-1 w-full rounded-full bg-secondary overflow-hidden"
          role="progressbar"
          aria-valuenow={passo}
          aria-valuemin={0}
          aria-valuemax={totalDePassos}
          aria-label={`Passo ${passo + 1} de ${totalDePassos}`}
        >
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${Math.max(porcentagem, 4)}%` }}
          />
        </div>
      </div>

      <div className="px-6 py-8 max-w-xl mx-auto space-y-10">
        {/* O aviso do que falta. CONTEUDO da tela, com foco programatico e
            role=alert: nao e tooltip, nao e cor de borda, nao e hover. */}
        {/* O ENVIO NAO FOI CONFIRMADO. Quem le e um adolescente: sem jargao,
            sem culpa, sem dizer que salvou. O que ele precisa saber e que nada
            do que escreveu sumiu da tela e o que fazer -- e o botao daqui reenvia
            exatamente o mesmo conteudo. */}
        {falhaNoEnvio && (
          <div
            ref={falhaRef}
            tabIndex={-1}
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-primary/40 bg-card px-4 py-5 space-y-3 outline-none"
          >
            <p className="text-base font-medium text-foreground">
              {falhaNoEnvio.tipo === "rede"
                ? "Não tivemos confirmação de que suas respostas chegaram."
                : "Suas respostas ainda não chegaram até nós."}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {falhaNoEnvio.tipo === "rede"
                ? "A conexão parece ter caído no meio do envio. Confira se a internet está funcionando."
                : "Tivemos um problema do nosso lado na hora de receber. Não foi nada que você fez."}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Tudo o que você escreveu continua aqui, nesta tela, e você não precisa responder nada
              de novo. Espere alguns segundos e toque no botão abaixo para enviar outra vez.
            </p>
            <Button
              type="button"
              onClick={() => void enviar()}
              disabled={enviando}
              className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-xs"
            >
              {enviando ? "Enviando..." : "Tentar enviar de novo"}
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Se não der certo depois de algumas tentativas, avise a equipe do {eventName}
              {falhaNoEnvio.ocorrencia ? (
                <>
                  {" "}e mostre este código:{" "}
                  <span className="font-mono text-foreground">{falhaNoEnvio.ocorrencia}</span>
                </>
              ) : null}
              .
            </p>
          </div>
        )}

        {(faltando.length > 0 || erroDeEnvio) && (
          <div
            ref={avisoRef}
            tabIndex={-1}
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-4 space-y-2 outline-none"
          >
            <p className="text-sm font-medium text-foreground">
              {erroDeEnvio ??
                (faltando.length === 1
                  ? "Falta responder 1 pergunta obrigatória desta etapa:"
                  : `Faltam ${faltando.length} perguntas obrigatórias desta etapa:`)}
            </p>
            {faltando.length > 0 && (
              <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-5">
                {faltando.map((f) => (
                  <li key={f.id}>
                    <span className="text-foreground">Pergunta {f.numero}:</span> {f.texto}{" "}
                    <span className="block text-xs">{textoDaFalta(f)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {passo === 0 ? (
          <section className="space-y-8">
            <div className="space-y-2">
              <h2 className="font-display text-2xl font-bold text-foreground">
                Primeiro, quem é você
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                São {totalDeQuestoes(etapas)} perguntas, divididas em {etapas.length} etapas. Dá
                para parar e voltar depois: o que você escrever fica guardado neste aparelho.
              </p>
            </div>

            <CampoDeTexto
              id="nome"
              rotulo="Nome completo"
              valor={identificacao.nome}
              erro={errosDeIdentificacao.nome}
              autoComplete="name"
              placeholder="Seu nome"
              onChange={(v) => {
                setIdentificacao((i) => ({ ...i, nome: v }));
                setErrosDeIdentificacao((e) => ({ ...e, nome: undefined }));
              }}
            />

            <CampoDeTexto
              id="email"
              rotulo="E-mail"
              tipo="email"
              valor={identificacao.email}
              erro={errosDeIdentificacao.email}
              autoComplete="email"
              placeholder="seu@email.com"
              ajuda="É por ele que reconhecemos suas respostas se você responder de novo."
              onChange={(v) => {
                setIdentificacao((i) => ({ ...i, email: v }));
                setErrosDeIdentificacao((e) => ({ ...e, email: undefined }));
              }}
            />

            <CampoDeTexto
              id="telefone"
              rotulo="Telefone"
              opcional
              tipo="tel"
              valor={identificacao.telefone}
              autoComplete="tel"
              placeholder="(11) 99999-0000"
              onChange={(v) => setIdentificacao((i) => ({ ...i, telefone: v }))}
            />
          </section>
        ) : (
          <section className="space-y-10">
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.2em] text-primary">
                {etapaAtual!.ambiente}
              </p>
              <h2 className="font-display text-2xl font-bold text-foreground leading-tight">
                {etapaAtual!.titulo}
              </h2>
              {etapaAtual!.descricao && (
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {etapaAtual!.descricao}
                </p>
              )}
            </div>

            {etapaAtual!.questions.map((question, indice) => (
              <Pergunta
                key={question.id}
                question={question}
                numero={indice + 1}
                total={etapaAtual!.questions.length}
                valor={respostas[question.id]}
                falta={mapaDasFaltas.get(question.id)}
                onResponder={responder}
                onAlternarLista={alternarLista}
              />
            ))}
          </section>
        )}
      </div>

      {/* Barra de acao fixa: num celular o botao fica sempre ao alcance do
          polegar, sem rolar ate o fim de uma etapa de 24 perguntas. */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="max-w-xl mx-auto px-6 py-4 flex gap-3">
          {passo > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={voltar}
              disabled={enviando}
              className="h-12 px-5 uppercase tracking-[0.08em] text-xs"
            >
              Voltar
            </Button>
          )}
          <Button
            type="button"
            onClick={avancar}
            // SEM `disabled` por pendencia, de proposito: ver decisao 3 no topo.
            // Desabilitado so durante o envio, que e um fato que a propria
            // legenda do botao informa ("Enviando...").
            disabled={enviando}
            className="flex-1 h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] text-xs"
          >
            {enviando
              ? "Enviando..."
              : passo === 0
                ? "Começar"
                : ultimoPasso
                  ? falhaNoEnvio
                    ? "Tentar enviar de novo"
                    : "Enviar respostas"
                  : "Continuar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function primeiroNome(nome: string): string {
  const limpo = nome.trim().split(/\s+/)[0] ?? "";
  return limpo.length > 0 ? limpo : "tudo certo";
}

function totalDeQuestoes(etapas: readonly EtapaDoFormulario[]): number {
  return etapas.reduce((soma, e) => soma + e.questions.length, 0);
}

// ---------------------------------------------------------------------------

interface CampoProps {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
  tipo?: string;
  placeholder?: string;
  erro?: string;
  ajuda?: string;
  opcional?: boolean;
  autoComplete?: string;
}

function CampoDeTexto({
  id,
  rotulo,
  valor,
  onChange,
  tipo = "text",
  placeholder,
  erro,
  ajuda,
  opcional,
  autoComplete,
}: CampoProps) {
  const idDoErro = `${id}-erro`;
  const idDaAjuda = `${id}-ajuda`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
        {rotulo}
        {opcional && (
          <span className="normal-case text-muted-foreground/60"> (opcional)</span>
        )}
      </Label>
      <Input
        id={id}
        type={tipo}
        value={valor}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? idDoErro : ajuda ? idDaAjuda : undefined}
        onChange={(e) => onChange(e.target.value)}
        // 16px evita o zoom automatico do Safari no iOS ao focar o campo.
        className="h-[48px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground border-primary/40 focus-visible:border-primary focus-visible:ring-0"
      />
      {erro ? (
        <p id={idDoErro} className="text-xs text-destructive">
          {erro}
        </p>
      ) : ajuda ? (
        <p id={idDaAjuda} className="text-xs text-muted-foreground">
          {ajuda}
        </p>
      ) : null}
    </div>
  );
}

interface PerguntaProps {
  question: QuizQuestion;
  numero: number;
  total: number;
  valor: ValorDeResposta | undefined;
  falta: PerguntaEmFalta | undefined;
  onResponder: (id: string, valor: ValorDeResposta) => void;
  onAlternarLista: (q: QuizQuestion, opcao: string, maximo?: number) => void;
}

function Pergunta({
  question,
  numero,
  total,
  valor,
  falta,
  onResponder,
  onAlternarLista,
}: PerguntaProps) {
  const texto = typeof valor === "string" ? valor : "";
  const numerico = typeof valor === "number" ? valor : undefined;
  const lista = Array.isArray(valor) ? valor : [];
  const idDoAviso = `falta-${question.id}`;
  const obrigatoria = question.required === true || (question.min_chars ?? 0) > 0;

  const minimo = question.min_chars ?? 0;
  const escritos = texto.trim().length;
  const curta = minimo > 0 && escritos < minimo;

  const menor = question.min ?? 0;
  const maior = question.max ?? 10;
  const passos = Array.from({ length: Math.max(maior - menor + 1, 0) }, (_, i) => menor + i);
  const [rotuloMenor, rotuloMaior] = rotulosDaEscala(question, menor, maior);

  return (
    <div
      id={`pergunta-${question.id}`}
      className={cn(
        "space-y-3 scroll-mt-20",
        falta && "border-l-2 border-destructive pl-4 -ml-4 sm:-ml-[18px]",
      )}
    >
      <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        Pergunta {numero} de {total}
        {obrigatoria && <span className="text-primary"> · obrigatória</span>}
      </p>
      <p className="text-foreground text-[16px] leading-relaxed font-medium">{question.text}</p>

      <div aria-describedby={falta ? idDoAviso : undefined}>
        {question.type === "select" && question.options ? (
          <div className="space-y-2">
            {question.options.map((opcao) => (
              <Opcao
                key={opcao}
                rotulo={opcao}
                escolhida={texto === opcao}
                onClick={() => onResponder(question.id, opcao)}
              />
            ))}
          </div>
        ) : question.type === "multi_select" && question.options ? (
          <div className="space-y-3">
            <div className="space-y-2">
              {question.options.map((opcao) => {
                const escolhida = lista.includes(opcao);
                const noLimite =
                  !!question.max_choices && lista.length >= question.max_choices && !escolhida;
                return (
                  <Opcao
                    key={opcao}
                    rotulo={opcao}
                    escolhida={escolhida}
                    inativa={noLimite}
                    onClick={() => onAlternarLista(question, opcao, question.max_choices)}
                  />
                );
              })}
            </div>
            {question.max_choices && (
              <p className="text-xs text-primary/70" aria-live="polite">
                {lista.length} de {question.max_choices} escolhidos
                {lista.length >= question.max_choices
                  ? ". Toque em um escolhido para trocar."
                  : ""}
              </p>
            )}
          </div>
        ) : question.type === "ranking" && question.options ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Toque nas opções na ordem da sua prioridade. Para refazer, toque de novo em uma já
              numerada.
            </p>
            {question.options.map((opcao) => {
              const posicao = lista.indexOf(opcao);
              const escolhida = posicao !== -1;
              return (
                <button
                  key={opcao}
                  type="button"
                  onClick={() => onAlternarLista(question, opcao)}
                  aria-pressed={escolhida}
                  className={cn(
                    "w-full flex items-center gap-3 text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[48px]",
                    escolhida
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-primary/20 bg-card text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center w-7 h-7 rounded-full border text-xs font-semibold shrink-0",
                      escolhida
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-primary/30 text-muted-foreground",
                    )}
                  >
                    {escolhida ? posicao + 1 : ""}
                  </span>
                  {opcao}
                </button>
              );
            })}
          </div>
        ) : question.type === "dilemma" ? (
          <div className="flex flex-col gap-3">
            {[question.option_a, question.option_b].map((opcao, i) =>
              opcao ? (
                <Opcao
                  key={i}
                  rotulo={opcao}
                  escolhida={texto === opcao}
                  onClick={() => onResponder(question.id, opcao)}
                />
              ) : null,
            )}
          </div>
        ) : question.type === "scale" ? (
          <div className="space-y-2">
            <div className="grid grid-cols-6 sm:grid-cols-11 gap-2">
              {passos.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onResponder(question.id, p)}
                  aria-pressed={numerico === p}
                  className={cn(
                    "min-w-[48px] min-h-[48px] rounded-md border text-base transition-all",
                    numerico === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-primary/20 bg-card text-muted-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
            {/* As duas pontas, nomeadas, EM CADA pergunta de escala -- nao so
                uma vez no topo da etapa. `gap-3` e `text-right` existem para o
                celular: a 375px os dois rotulos cabem lado a lado, e se um dia
                um texto maior nao couber ele quebra AQUI, sem empurrar a linha
                dos numeros. */}
            {(rotuloMenor || rotuloMaior) && (
              <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                <span>{rotuloMenor}</span>
                <span className="text-right">{rotuloMaior}</span>
              </div>
            )}
          </div>
        ) : question.type === "short_text" ? (
          <Input
            value={texto}
            maxLength={question.max_chars}
            placeholder={question.placeholder ?? "Responda com suas palavras..."}
            aria-invalid={falta ? true : undefined}
            onChange={(e) => onResponder(question.id, e.target.value)}
            className="h-[48px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground border-primary/40 focus-visible:border-primary focus-visible:ring-0"
          />
        ) : (
          <Textarea
            value={texto}
            rows={5}
            placeholder={question.placeholder ?? "Responda com suas palavras..."}
            aria-invalid={falta ? true : undefined}
            onChange={(e) => onResponder(question.id, e.target.value)}
            className="min-h-[120px] text-[16px] bg-card text-foreground placeholder:text-muted-foreground border-primary/40 focus-visible:border-primary focus-visible:ring-0 resize-none"
          />
        )}
      </div>

      {question.type === "text" && minimo > 0 && (
        <p className={cn("text-xs", curta ? "text-destructive" : "text-primary/70")} aria-live="polite">
          {escritos}/{minimo} {curta ? "mínimo" : "caracteres"}
        </p>
      )}

      {/* A razao desta pergunta estar marcada, escrita ao lado dela. */}
      {falta && (
        <p id={idDoAviso} className="text-xs text-destructive">
          {textoDaFalta(falta)}
        </p>
      )}
    </div>
  );
}

function Opcao({
  rotulo,
  escolhida,
  inativa,
  onClick,
}: {
  rotulo: string;
  escolhida: boolean;
  inativa?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inativa}
      aria-pressed={escolhida}
      className={cn(
        "w-full text-left px-4 py-3.5 rounded-md border text-base transition-all min-h-[48px]",
        escolhida
          ? "border-primary bg-primary/10 text-foreground"
          : inativa
            ? "border-primary/10 bg-card text-muted-foreground/50"
            : "border-primary/20 bg-card text-muted-foreground",
      )}
    >
      {rotulo}
    </button>
  );
}
