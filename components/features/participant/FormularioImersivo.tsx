"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import type { MapaDeRespostas, ValorDeResposta } from "@/lib/quiz/obrigatorias";
import type { QuizQuestion } from "@/types/database";
import {
  ATRASO_DO_AVANCO_MS,
  IDENTIFICACAO_VAZIA,
  contarRespondidas,
  ehLikert,
  erroDeIdentificacao,
  estimarMinutos,
  indiceDaPergunta,
  indiceDaTela,
  motivoDaFalta,
  montarRoteiro,
  primeiraTelaIncompleta,
  primeiroNome,
  respondida,
  telaCompleta,
  type EtapaImersiva,
  type Identificacao,
  type Tela,
} from "./formulario-imersivo/roteiro";
import {
  PRAZO_DO_RASCUNHO_DIAS,
  apagarRascunho,
  esquecerEnvio,
  gravarRascunho,
  lerEnvio,
  lerRascunho,
  registrarEnvio,
  type Rascunho,
} from "./formulario-imersivo/rascunho";
import {
  Escala,
  Escolha,
  TextoAberto,
  TextoCurto,
  opcoesDaPergunta,
  type CampoDeTextoHandle,
} from "./formulario-imersivo/controles";
import { ehToque, useViewportVisivel } from "./formulario-imersivo/viewport-visivel";

/*
 * O FORMULARIO IMERSIVO -- a versao "uma coisa de cada vez" do formulario
 * publico, servida em /formulario/[eventCode].
 *
 * MESMO CONTRATO DE ENVIO da versao simples (FormularioPublico.tsx): POST
 * /api/formulario-publico com { event_code, full_name, email, phone?, respostas }.
 * Nada de servidor muda; obrigatorias, e-mail repetido e o resto sao do servidor.
 *
 * O DESENHO (revisao tecnica), e onde cada decisao mora:
 *   - quais perguntas dividem tela e quais avancam sozinhas: roteiro.ts;
 *   - o que fica no aparelho, por quanto tempo, e a importacao do rascunho da
 *     versao simples: rascunho.ts;
 *   - os controles (escala, cartoes A-D, texto): controles.tsx;
 *   - o rodape acima do teclado virtual: viewport-visivel.ts.
 *
 * HISTORICO DO NAVEGADOR: cada avanco empilha uma entrada com `{ fi: <tela> }` no
 * `history.state` -- e SO o numero da tela. A URL nao muda nunca (nada de nome,
 * e-mail ou resposta em URL). O voltar do navegador dispara `popstate` e a tela
 * volta uma pergunta; recarregar le o `history.state` e reabre na mesma tela.
 * O `fi` e acrescentado ao estado que ja existe (`...history.state`): o roteador
 * do Next guarda la a arvore dele (`__NA`), e um estado sem ela faz o Next
 * recarregar a pagina no `popstate`.
 *
 * NENHUM atributo `title` neste arquivo: o que falta e escrito NA TELA, ao lado
 * da pergunta (regra do projeto, tests/contrato/explicacao-nao-fica-no-hover).
 */

interface Props {
  eventCode: string;
  eventName: string;
  /** Data do evento ja formatada no servidor (evita divergencia de fuso/locale). */
  dataDoEvento: string | null;
  etapas: EtapaImersiva[];
}

type Desfecho = null | "ok" | "segunda";

interface EstadoDoHistorico {
  fi?: number;
}

const TEMPO_LIMITE_DO_ENVIO_MS = 30_000;

export function FormularioImersivo({ eventCode, eventName, dataDoEvento, etapas }: Props) {
  const roteiro = useMemo(() => montarRoteiro(etapas), [etapas]);
  const minutos = useMemo(() => estimarMinutos(etapas), [etapas]);
  const indiceDaRevisao = roteiro.length - 1;

  const [indice, setIndice] = useState(0);
  const [direcao, setDirecao] = useState<"frente" | "tras">("frente");
  const [identificacao, setIdentificacao] = useState<Identificacao>(IDENTIFICACAO_VAZIA);
  const [respostas, setRespostas] = useState<MapaDeRespostas>({});
  const [pronto, setPronto] = useState(false);
  const [rascunhoAchado, setRascunhoAchado] = useState<Rascunho | null>(null);
  const [envioAnterior, setEnvioAnterior] = useState<number | null>(null);
  const [confirmandoApagar, setConfirmandoApagar] = useState(false);
  const [mostrarFaltas, setMostrarFaltas] = useState(false);
  /** Recado no topo da tela, quando a pessoa foi LEVADA ate ela (envio recusado). */
  const [recado, setRecado] = useState<string | null>(null);
  /** Veio da revisao para corrigir: o proximo avanco volta para a revisao. */
  const [corrigindo, setCorrigindo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroDeEnvio, setErroDeEnvio] = useState<string | null>(null);
  const [desfecho, setDesfecho] = useState<Desfecho>(null);
  /**
   * O envio NAO foi confirmado pelo servidor (gravacao indisponivel, erro
   * interno, resposta ilegivel, ou a rede caiu). O rascunho fica, nada e
   * apagado, a tela NAO diz que recebeu, e o botao reenvia o mesmo conteudo.
   */
  const [falhaNoEnvio, setFalhaNoEnvio] = useState<
    { tipo: "servidor" | "rede"; ocorrencia: string | null } | null
  >(null);
  const [salvoNoAparelho, setSalvoNoAparelho] = useState(true);

  const respostasRef = useRef(respostas);
  const indiceRef = useRef(indice);
  const corrigindoRef = useRef(corrigindo);
  const emEnvio = useRef(false);
  const temporizador = useRef<number | null>(null);
  const bufferDeDigito = useRef<{ digito: string; timer: number } | null>(null);
  /** Quantas entradas ESTE documento empilhou acima da tela atual (para o Voltar da tela). */
  const pilha = useRef<number[]>([]);
  const titulo = useRef<HTMLHeadingElement>(null);
  const campo = useRef<CampoDeTextoHandle>(null);
  const palco = useRef<HTMLDivElement>(null);

  const area = useViewportVisivel();

  useEffect(() => {
    respostasRef.current = respostas;
  }, [respostas]);
  useEffect(() => {
    indiceRef.current = indice;
  }, [indice]);
  useEffect(() => {
    corrigindoRef.current = corrigindo;
  }, [corrigindo]);

  const tela: Tela = roteiro[Math.min(indice, roteiro.length - 1)];

  /**
   * O que a REVISAO confere: as respostas LIDAS DE VOLTA do rascunho gravado neste
   * aparelho, nao uma contagem paralela da tela. Lido na renderizacao da revisao
   * (so no cliente: a revisao nunca e a primeira tela renderizada). Sem
   * armazenamento disponivel, confere o que esta na tela e diz isso.
   */
  function lerConferencia(): { respostas: MapaDeRespostas; doAparelho: boolean } {
    try {
      const lido = lerRascunho(localStorage, eventCode, Date.now());
      if (lido && lido.origem === "imersivo") return { respostas: lido.respostas, doAparelho: true };
    } catch {
      // sem armazenamento
    }
    return { respostas: respostasRef.current, doAparelho: false };
  }
  const conferencia =
    pronto && tela.tipo === "revisao" ? lerConferencia() : { respostas, doAparelho: false };
  const { respondidas, total } = contarRespondidas(etapas, respostas);

  // ---------------------------------------------------------------------------
  // Leitura do rascunho e posicao inicial -- DEPOIS da primeira renderizacao,
  // para o HTML do servidor e o do cliente nao divergirem.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let r: Rascunho | null = null;
    let enviado: number | null = null;
    try {
      r = lerRascunho(localStorage, eventCode, Date.now());
      enviado = lerEnvio(localStorage, eventCode, Date.now());
    } catch {
      setSalvoNoAparelho(false);
    }
    let inicial = 0;
    if (r) {
      setIdentificacao(r.identificacao);
      setRespostas(r.respostas);
      respostasRef.current = r.respostas;
      setRascunhoAchado(r);
      // Recarregar a pagina (ou voltar do navegador para ela) traz o
      // `history.state` desta aba: reabre na mesma tela, sem passar pelas
      // boas-vindas. Quem abre o link de novo, do zero, cai nas boas-vindas com
      // o caminho de retomada a vista.
      const doHistorico = (window.history.state as EstadoDoHistorico | null)?.fi;
      if (typeof doHistorico === "number" && doHistorico > 0 && doHistorico < roteiro.length) {
        inicial = doHistorico;
      }
    }
    setEnvioAnterior(enviado);
    setIndice(inicial);
    indiceRef.current = inicial;
    try {
      window.history.replaceState({ ...(window.history.state ?? {}), fi: inicial }, "");
    } catch {
      // Sem historico manipulavel: o Voltar da tela continua funcionando.
    }
    setPronto(true);
  }, [eventCode, roteiro.length]);

  // Grava a cada resposta e a cada mudanca de tela. Nas boas-vindas NAO grava:
  // la a pessoa ainda nao escolheu retomar, e gravar ali trocaria a posicao
  // salva pela tela de boas-vindas.
  useEffect(() => {
    if (!pronto || desfecho || indice === 0) return;
    let ok = false;
    try {
      ok = gravarRascunho(
        localStorage,
        eventCode,
        { identificacao, respostas, telaId: roteiro[indice]?.id ?? null },
        Date.now(),
      );
    } catch {
      ok = false;
    }
    setSalvoNoAparelho(ok);
  }, [pronto, desfecho, indice, identificacao, respostas, eventCode, roteiro]);

  // ---------------------------------------------------------------------------
  // Navegacao
  // ---------------------------------------------------------------------------
  const cancelarAvanco = useCallback(() => {
    if (temporizador.current !== null) {
      window.clearTimeout(temporizador.current);
      temporizador.current = null;
    }
  }, []);

  const mostrar = useCallback((novo: number, sentido: "frente" | "tras") => {
    setDirecao(sentido);
    setMostrarFaltas(false);
    setIndice(novo);
    indiceRef.current = novo;
  }, []);

  /** Vai para uma tela EMPILHANDO no historico (o voltar do navegador desfaz). */
  const irPara = useCallback(
    (novo: number) => {
      cancelarAvanco();
      const atual = indiceRef.current;
      if (novo === atual) return;
      try {
        window.history.pushState({ ...(window.history.state ?? {}), fi: novo }, "");
        pilha.current.push(atual);
      } catch {
        // Sem historico: segue so na tela.
      }
      mostrar(novo, novo > atual ? "frente" : "tras");
    },
    [cancelarAvanco, mostrar],
  );

  // Voltar do NAVEGADOR: volta uma tela, nunca sai do formulario no meio dele.
  useEffect(() => {
    const aoVoltar = (e: PopStateEvent) => {
      const fi = (e.state as EstadoDoHistorico | null)?.fi;
      if (typeof fi !== "number" || desfecho) return;
      cancelarAvanco();
      setRecado(null);
      setErroDeEnvio(null);
      const atual = indiceRef.current;
      // A pilha deste documento acompanha o historico: um passo para tras nela.
      if (pilha.current.length > 0 && pilha.current[pilha.current.length - 1] === fi) {
        pilha.current.pop();
      }
      if (fi === indiceDaRevisao) setCorrigindo(false);
      mostrar(Math.max(0, Math.min(fi, roteiro.length - 1)), fi < atual ? "tras" : "frente");
    };
    window.addEventListener("popstate", aoVoltar);
    return () => window.removeEventListener("popstate", aoVoltar);
  }, [cancelarAvanco, mostrar, roteiro.length, indiceDaRevisao, desfecho]);

  /** Voltar da TELA: se a entrada anterior do historico e a tela anterior, usa o historico. */
  const voltar = useCallback(() => {
    cancelarAvanco();
    setRecado(null);
    setErroDeEnvio(null);
    const atual = indiceRef.current;
    if (atual === 0) return;
    if (corrigindoRef.current) {
      // Corrigindo a partir da revisao: voltar e voltar para a revisao.
      setCorrigindo(false);
      irPara(indiceDaRevisao);
      return;
    }
    const anterior = atual - 1;
    const topo = pilha.current[pilha.current.length - 1];
    if (topo === anterior) {
      window.history.back();
      return;
    }
    try {
      window.history.replaceState({ ...(window.history.state ?? {}), fi: anterior }, "");
    } catch {
      // idem
    }
    mostrar(anterior, "tras");
  }, [cancelarAvanco, irPara, mostrar, indiceDaRevisao]);

  /** Avanca SE a tela atual estiver completa; senao escreve o que falta. */
  const avancar = useCallback(() => {
    cancelarAvanco();
    setRecado(null);
    const atual = indiceRef.current;
    const t = roteiro[atual];
    if (!telaCompleta(t, respostasRef.current, identificacaoRef.current)) {
      setMostrarFaltas(true);
      // Leva o primeiro aviso para a vista (bloco Likert pode ter o item que
      // falta abaixo da dobra).
      requestAnimationFrame(() => {
        const aviso = palco.current?.querySelector<HTMLElement>("[data-aviso]");
        aviso?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return;
    }
    if (corrigindoRef.current && t.tipo !== "revisao") {
      setCorrigindo(false);
      irPara(indiceDaRevisao);
      return;
    }
    if (atual < roteiro.length - 1) irPara(atual + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelarAvanco, irPara, roteiro, indiceDaRevisao]);

  const identificacaoRef = useRef(identificacao);
  useEffect(() => {
    identificacaoRef.current = identificacao;
  }, [identificacao]);

  function responder(id: string, valor: ValorDeResposta) {
    const novo = { ...respostasRef.current, [id]: valor };
    respostasRef.current = novo;
    setRespostas(novo);
    setRecado(null);
  }

  /** Escolha que avanca sozinha: marca, mostra, e sai depois de ~400 ms. */
  function escolherEAvancar(q: QuizQuestion, valor: ValorDeResposta) {
    responder(q.id, valor);
    cancelarAvanco();
    const t = roteiro[indiceRef.current];
    if (t.tipo !== "perguntas" || !t.avancaSozinha) return;
    temporizador.current = window.setTimeout(() => {
      temporizador.current = null;
      avancar();
    }, ATRASO_DO_AVANCO_MS);
  }

  function mudarIdentificacao(campoId: keyof Identificacao, v: string) {
    const nova = { ...identificacaoRef.current, [campoId]: v };
    identificacaoRef.current = nova;
    setIdentificacao(nova);
  }

  // ---------------------------------------------------------------------------
  // Retomar / apagar
  // ---------------------------------------------------------------------------
  function retomar() {
    const r = rascunhoAchado;
    let destino = -1;
    if (r?.telaId) destino = indiceDaTela(roteiro, r.telaId);
    if (destino <= 0) {
      destino = primeiraTelaIncompleta(roteiro, respostasRef.current, identificacaoRef.current);
    }
    destino = Math.max(1, destino);
    // A entrada das boas-vindas vira "a tela anterior a de retomada": assim o
    // voltar do navegador, logo depois de retomar, volta UMA pergunta (e nao
    // para as boas-vindas). Uma entrada so e empilhada, no proprio toque.
    try {
      window.history.replaceState({ ...(window.history.state ?? {}), fi: destino - 1 }, "");
    } catch {
      // idem
    }
    indiceRef.current = destino - 1;
    irPara(destino);
  }

  function apagarTudo() {
    try {
      apagarRascunho(localStorage, eventCode);
    } catch {
      // nada a apagar
    }
    setIdentificacao(IDENTIFICACAO_VAZIA);
    identificacaoRef.current = IDENTIFICACAO_VAZIA;
    setRespostas({});
    respostasRef.current = {};
    setRascunhoAchado(null);
    setConfirmandoApagar(false);
    setRecado(null);
    setErroDeEnvio(null);
    setFalhaNoEnvio(null);
    setCorrigindo(false);
  }

  function corrigir(destino: number) {
    setCorrigindo(true);
    corrigindoRef.current = true;
    irPara(destino);
  }

  // ---------------------------------------------------------------------------
  // Envio -- idempotente do lado da tela: um envio por vez, nunca dois.
  // ---------------------------------------------------------------------------
  async function enviar() {
    if (emEnvio.current || desfecho) return;

    // Reconferencia de TUDO: leva direto para a primeira coisa que faltar.
    const pendente = primeiraTelaIncompleta(
      roteiro,
      respostasRef.current,
      identificacaoRef.current,
    );
    if (pendente !== indiceDaRevisao) {
      setRecado("Antes de enviar, falta responder esta.");
      setCorrigindo(true);
      corrigindoRef.current = true;
      irPara(pendente);
      requestAnimationFrame(() => setMostrarFaltas(true));
      return;
    }

    emEnvio.current = true;
    setEnviando(true);
    setErroDeEnvio(null);
    setFalhaNoEnvio(null);

    // O que vai e o que foi CONFERIDO: grava o estado atual e envia o que se le
    // de volta do aparelho. Sem armazenamento, vai o que esta na tela.
    let respostasDoEnvio = respostasRef.current;
    try {
      gravarRascunho(
        localStorage,
        eventCode,
        { identificacao: identificacaoRef.current, respostas: respostasRef.current, telaId: "revisao" },
        Date.now(),
      );
      const lido = lerRascunho(localStorage, eventCode, Date.now());
      if (lido && lido.origem === "imersivo") respostasDoEnvio = lido.respostas;
    } catch {
      // segue com o que esta na tela
    }
    const controle = new AbortController();
    const limite = window.setTimeout(() => controle.abort(), TEMPO_LIMITE_DO_ENVIO_MS);
    try {
      const id = identificacaoRef.current;
      const res = await fetch("/api/formulario-publico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controle.signal,
        body: JSON.stringify({
          event_code: eventCode,
          full_name: id.nome,
          email: id.email,
          phone: id.telefone || undefined,
          respostas: respostasDoEnvio,
        }),
      });

      const corpo = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        code?: string;
        ocorrencia?: string;
        codigo?: string;
        na_mesa_de_decisao?: boolean;
        faltando?: { etapa: number; titulo: string; faltando: { id: string }[] }[];
      } | null;

      if (!res.ok) {
        // O servidor reconfere com o MESMO modulo da tela. Se ele recusar, a tela
        // leva a pessoa direto para a pergunta apontada.
        const idQueFalta = corpo?.faltando?.[0]?.faltando?.[0]?.id;
        if (res.status === 422 && idQueFalta) {
          const destino = indiceDaPergunta(roteiro, idQueFalta);
          if (destino > 0) {
            setRecado(corpo?.error ?? "Antes de enviar, falta responder esta.");
            setCorrigindo(true);
            corrigindoRef.current = true;
            irPara(destino);
            requestAnimationFrame(() => setMostrarFaltas(true));
            return;
          }
        }
        // NAO GRAVOU (503 com codigo proprio), erro interno (500) ou resposta que
        // nem e JSON: o servidor nao confirmou nada. Mesmo criterio da versao
        // simples. Rascunho fica; a tela pede para tentar de novo.
        if (corpo?.code === "PUBLIC_FORM_WRITE_UNAVAILABLE" || res.status === 500 || corpo === null) {
          setFalhaNoEnvio({ tipo: "servidor", ocorrencia: corpo?.ocorrencia ?? null });
          return;
        }
        setErroDeEnvio(
          corpo?.error ??
            "Não conseguimos enviar agora. Suas respostas continuam salvas neste aparelho: toque em enviar de novo em alguns segundos.",
        );
        return;
      }

      // O QUE CONTA COMO RECEBIDO -- o mesmo criterio da versao simples, e nada
      // alem dele: resposta oficial (`success === true` sem codigo) ou segunda
      // resposta CONFIRMADA na mesa (`codigo` + `na_mesa_de_decisao === true`).
      // Qualquer outro 200 nao e confirmacao: rascunho fica, sem "recebemos".
      const naMesa =
        corpo?.success === true &&
        corpo.codigo === "segunda_resposta_guardada" &&
        corpo.na_mesa_de_decisao === true;
      const oficial = corpo?.success === true && corpo.codigo === undefined;
      if (!naMesa && !oficial) {
        setFalhaNoEnvio({ tipo: "servidor", ocorrencia: null });
        return;
      }

      // Confirmado. So agora o rascunho sai do aparelho.
      try {
        registrarEnvio(localStorage, eventCode, Date.now());
      } catch {
        // A tela final ja e a verdade desta sessao.
      }
      setDesfecho(naMesa ? "segunda" : "ok");
    } catch {
      // A resposta nao voltou: pode ter gravado ou nao, e a tela nao afirma
      // nenhum dos dois. Reenviar e seguro -- o servidor reconhece o mesmo
      // conteudo, do mesmo nome, como o mesmo envio.
      setFalhaNoEnvio({ tipo: "rede", ocorrencia: null });
    } finally {
      window.clearTimeout(limite);
      emEnvio.current = false;
      setEnviando(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Foco a cada tela: campo de texto no computador; no celular, o titulo (o
  // teclado so abre quando a pessoa toca no campo, depois de ler a pergunta).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!pronto) return;
    palco.current?.scrollTo({ top: 0 });
    const quadro = requestAnimationFrame(() => {
      if (campo.current && !ehToque()) campo.current.focar();
      else titulo.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(quadro);
  }, [indice, pronto, desfecho]);

  // ---------------------------------------------------------------------------
  // Atalhos de teclado (computador) -- so com o foco FORA de campo de texto.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (desfecho || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.isContentEditable)) {
        return;
      }
      const t = roteiro[indiceRef.current];

      if (e.key === "Enter") {
        // Enter num botao focado e o clique do proprio botao.
        if (alvo && alvo.tagName === "BUTTON") return;
        // Na revisao, Enter NAO envia: o envio e so por toque/clique explicito.
        if (t.tipo === "revisao" || t.tipo === "boas-vindas") return;
        e.preventDefault();
        avancar();
        return;
      }
      if (t.tipo !== "perguntas") return;

      const q = t.perguntas[0];
      if (t.perguntas.length === 1 && (q.type === "select" || q.type === "dilemma")) {
        const opcoes = opcoesDaPergunta(q);
        const i = e.key.toUpperCase().charCodeAt(0) - 65;
        if (e.key.length === 1 && i >= 0 && i < opcoes.length) {
          e.preventDefault();
          escolherEAvancar(q, opcoes[i]);
        }
        return;
      }

      if (/^[0-9]$/.test(e.key)) {
        // Escala: no bloco Likert, o numero responde a primeira afirmacao ainda
        // sem resposta; na escala sozinha, a propria pergunta.
        const alvoQ =
          t.perguntas.find((p) => p.type === "scale" && !respondida(p, respostasRef.current[p.id])) ??
          (t.perguntas.length === 1 ? q : undefined);
        if (!alvoQ || alvoQ.type !== "scale") return;
        e.preventDefault();
        const menor = alvoQ.min ?? 0;
        const maior = alvoQ.max ?? 10;
        const escolher = (n: number) => {
          if (n < menor || n > maior) return;
          if (t.avancaSozinha) escolherEAvancar(alvoQ, n);
          else responder(alvoQ.id, n);
        };
        // "10" sao duas teclas: o 1 espera um instante por um 0.
        const b = bufferDeDigito.current;
        if (b && b.digito === "1" && e.key === "0" && maior >= 10) {
          window.clearTimeout(b.timer);
          bufferDeDigito.current = null;
          escolher(10);
          return;
        }
        if (e.key === "1" && maior >= 10) {
          if (b) window.clearTimeout(b.timer);
          bufferDeDigito.current = {
            digito: "1",
            timer: window.setTimeout(() => {
              bufferDeDigito.current = null;
              escolher(1);
            }, 450),
          };
          return;
        }
        escolher(Number(e.key));
      }
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  });

  useEffect(() => () => cancelarAvanco(), [cancelarAvanco]);

  // O fundo do DOCUMENTO acompanha o da casca enquanto o formulario esta aberto:
  // no iPhone, durante a animacao do teclado, a area fora da casca aparece por um
  // instante, e com o fundo padrao do app ela pisca em branco.
  const cascaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cascaRef.current;
    if (!el) return;
    const raiz = document.documentElement;
    const anterior = { html: raiz.style.backgroundColor, body: document.body.style.backgroundColor };
    const cor = getComputedStyle(el).backgroundColor;
    raiz.style.backgroundColor = cor;
    document.body.style.backgroundColor = cor;
    return () => {
      raiz.style.backgroundColor = anterior.html;
      document.body.style.backgroundColor = anterior.body;
    };
  }, [pronto]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const casca = (
    conteudo: React.ReactNode,
    opcoes?: { cabecalho?: boolean; rodape?: React.ReactNode; cheia?: boolean },
  ) => (
    <div
      ref={cascaRef}
      className="fixed inset-x-0 top-0 flex flex-col bg-background text-foreground overscroll-none"
      style={{
        fontFamily: "var(--font-marco-zero), system-ui, sans-serif",
        height: area ? `${area.altura}px` : "100dvh",
        transform: area && area.topo ? `translateY(${area.topo}px)` : undefined,
      }}
    >
      {opcoes?.cabecalho && <Cabecalho tela={tela} totalDeEtapas={etapas.length} respondidas={respondidas} total={total} />}
      <div ref={palco} className="flex-1 overflow-y-auto overscroll-contain">
        {/* `cheia`: a capa ocupa o palco de borda a borda, sem a coluna de leitura. */}
        {opcoes?.cheia ? (
          conteudo
        ) : (
          <div className="min-h-full w-full max-w-xl mx-auto px-6 flex flex-col justify-center py-10">
            {conteudo}
          </div>
        )}
      </div>
      {opcoes?.rodape}
    </div>
  );

  if (desfecho === "segunda") {
    return casca(<TelaDeSegundaResposta nome={identificacao.nome} eventName={eventName} />);
  }
  if (desfecho === "ok") {
    return casca(
      <TelaFinal nome={identificacao.nome} eventName={eventName} dataDoEvento={dataDoEvento} />,
    );
  }

  if (!pronto) {
    // Antes de ler o rascunho, a casca vazia: evita piscar as boas-vindas para
    // quem esta retomando no meio.
    return casca(<div aria-busy="true" className="h-10" />);
  }

  // --- Boas-vindas ----------------------------------------------------------
  if (tela.tipo === "boas-vindas") {
    return casca(
      <BoasVindas
        tituloRef={titulo}
        eventName={eventName}
        dataDoEvento={dataDoEvento}
        totalDePerguntas={total}
        totalDeEtapas={etapas.length}
        minutos={minutos}
        rascunho={rascunhoAchado}
        respondidas={respondidas}
        envioAnterior={envioAnterior}
        confirmandoApagar={confirmandoApagar}
        salvoNoAparelho={salvoNoAparelho}
        onComecar={() => {
          try {
            esquecerEnvio(localStorage, eventCode);
          } catch {
            // nada
          }
          irPara(1);
        }}
        onRetomar={retomar}
        onPedirApagar={() => setConfirmandoApagar(true)}
        onCancelarApagar={() => setConfirmandoApagar(false)}
        onApagar={apagarTudo}
      />,
      { cheia: true },
    );
  }

  const completa = telaCompleta(tela, respostas, identificacao);

  /** Leva ao que falta SEGUNDO O QUE ESTA GRAVADO -- a mesma fonte que a revisao mostra. */
  function irParaOQueFalta() {
    let destino = primeiraTelaIncompleta(roteiro, conferencia.respostas, identificacaoRef.current);
    if (destino === indiceDaRevisao) {
      destino = primeiraTelaIncompleta(roteiro, respostasRef.current, identificacaoRef.current);
    }
    if (destino !== indiceDaRevisao) corrigir(destino);
  }
  const rotuloPrincipal =
    tela.tipo === "revisao"
      ? enviando
        ? "Enviando…"
        : contarRespondidas(etapas, conferencia.respostas).respondidas < total ||
            erroDeIdentificacao("nome", identificacao) ||
            erroDeIdentificacao("email", identificacao)
          ? "Ir para o que falta"
          : falhaNoEnvio
            ? "Enviar de novo"
            : "Confirmar e enviar"
      : corrigindo && tela.tipo !== "abertura"
        ? "Salvar e voltar ao resumo"
        : tela.tipo === "abertura"
          ? "Começar"
          : tela.tipo === "dado" && tela.campo === "telefone" && !identificacao.telefone.trim()
            ? "Pular"
            : "Continuar";

  const rodape = (
    <Rodape
      onVoltar={voltar}
      onPrincipal={
        tela.tipo !== "revisao"
          ? avancar
          : rotuloPrincipal === "Ir para o que falta"
            ? irParaOQueFalta
            : () => void enviar()
      }
      rotulo={rotuloPrincipal}
      ocupado={enviando}
      destacado={completa}
      dica={
        tela.tipo === "perguntas" && tela.perguntas.length === 1 && tela.perguntas[0].type === "text"
          ? null
          : tela.tipo === "revisao"
            ? null
            : "Enter"
      }
    />
  );

  // Transicao: deslizar + esmaecer entre telas; entre uma afirmacao Likert e a
  // seguinte, so um esmaecer curto -- "sequencia continua e leve, nao 24 telas
  // cerimoniais". Com prefers-reduced-motion, nenhuma animacao.
  const sequenciaLikert =
    tela.tipo === "perguntas" && ehLikert(tela.perguntas[0]) && tela.primeiroNumero > 1;
  const animacao = sequenciaLikert
    ? "animate-in fade-in-0 duration-150 ease-out motion-reduce:animate-none"
    : cn(
        "animate-in fade-in-0 duration-300 ease-out motion-reduce:animate-none",
        direcao === "frente" ? "slide-in-from-bottom-4" : "slide-in-from-top-4",
      );

  let conteudo: React.ReactNode = null;

  if (tela.tipo === "dado") {
    const erro = erroDeIdentificacao(tela.campo, identificacao);
    const idDoAviso = `aviso-${tela.campo}`;
    const conf = {
      nome: {
        pergunta: "Para começar, qual é o seu nome completo?" as React.ReactNode,
        apoio: null as string | null,
        tipo: "text" as const,
        auto: "name",
        modo: "text" as const,
        placeholder: "Nome e sobrenome",
      },
      email: {
        pergunta: (
          <>
            {primeiroNome(identificacao.nome) ? `${primeiroNome(identificacao.nome)}, qual` : "Qual"} é o seu{" "}
            <span className="whitespace-nowrap">e-mail?</span>
          </>
        ) as React.ReactNode,
        apoio: "É por ele que reconhecemos suas respostas se você responder de novo.",
        tipo: "email" as const,
        auto: "email",
        modo: "email" as const,
        placeholder: "nome@exemplo.com",
      },
      telefone: {
        pergunta: "Quer deixar um telefone?" as React.ReactNode,
        apoio: "Opcional. Se preferir, é só pular.",
        tipo: "tel" as const,
        auto: "tel",
        modo: "tel" as const,
        placeholder: "(11) 99999-0000",
      },
    }[tela.campo];
    conteudo = (
      <section key={tela.id} className={cn("space-y-8", animacao)}>
        <div className="space-y-3">
          <h2
            ref={titulo}
            id="enunciado-dado"
            tabIndex={-1}
            className="text-[26px] sm:text-[30px] leading-tight font-semibold tracking-tight outline-none"
          >
            {conf.pergunta}
          </h2>
          {conf.apoio && <p className="text-[15px] leading-relaxed text-muted-foreground">{conf.apoio}</p>}
        </div>
        <TextoCurto
          ref={campo}
          id={`campo-${tela.campo}`}
          valor={identificacao[tela.campo]}
          idDoEnunciado="enunciado-dado"
          idDoAviso={mostrarFaltas && erro ? idDoAviso : undefined}
          invalido={mostrarFaltas && !!erro}
          tipo={conf.tipo}
          autoComplete={conf.auto}
          inputMode={conf.modo}
          placeholder={conf.placeholder}
          onChange={(v) => mudarIdentificacao(tela.campo, v)}
          onEnter={avancar}
        />
        {mostrarFaltas && erro && <Aviso id={idDoAviso}>{erro}</Aviso>}
      </section>
    );
  } else if (tela.tipo === "abertura") {
    const e = tela.etapa;
    conteudo = (
      <section key={tela.id} className={cn("space-y-6", animacao)}>
        <p className="text-[13px] font-medium tracking-wide text-primary">
          Etapa {e.numero} de {etapas.length}
        </p>
        <h2
          ref={titulo}
          tabIndex={-1}
          className="text-[32px] sm:text-[40px] leading-[1.1] font-semibold tracking-tight outline-none"
        >
          {e.titulo}
        </h2>
        {/* A instrucao do dono, palavra por palavra (quiz_stages.description). */}
        {e.descricao && (
          <p className="text-[17px] leading-relaxed text-foreground/80 whitespace-pre-line">{e.descricao}</p>
        )}
        <p className="text-[14px] text-muted-foreground">
          {e.questions.length} {e.questions.length === 1 ? "pergunta" : "perguntas"}
        </p>
      </section>
    );
  } else if (tela.tipo === "perguntas") {
    conteudo = (
      <TelaDePerguntas
        key={tela.id}
        className={animacao}
        tela={tela}
        respostas={respostas}
        mostrarFaltas={mostrarFaltas}
        recado={recado}
        tituloRef={titulo}
        campoRef={campo}
        alturaMaximaDoTexto={area ? Math.max(160, Math.round(area.altura * 0.42)) : null}
        onEscolherEAvancar={escolherEAvancar}
        onResponder={responder}
        onAvancar={avancar}
        proximaNaCorrecao={
          corrigindo &&
          roteiro[indice + 1]?.tipo === "perguntas" &&
          (roteiro[indice + 1] as Extract<Tela, { tipo: "perguntas" }>).etapa.numero === tela.etapa.numero
            ? () => {
                if (!telaCompleta(tela, respostasRef.current, identificacaoRef.current)) {
                  setMostrarFaltas(true);
                  return;
                }
                irPara(indice + 1);
              }
            : null
        }
      />
    );
  } else if (tela.tipo === "revisao") {
    conteudo = (
      <Revisao
        key={tela.id}
        className={animacao}
        tituloRef={titulo}
        etapas={etapas}
        conferidas={conferencia.respostas}
        conferidoNoAparelho={conferencia.doAparelho}
        identificacao={identificacao}
        erroDeEnvio={erroDeEnvio}
        falhaNoEnvio={falhaNoEnvio}
        eventName={eventName}
        onRever={(etapa) => {
          // Leva a primeira pergunta que falta NA ETAPA; completa, a primeira dela.
          const pendente = etapa.questions.find((q) => !respondida(q, conferencia.respostas[q.id]));
          const destino = indiceDaPergunta(roteiro, (pendente ?? etapa.questions[0]).id);
          if (destino > 0) corrigir(destino);
        }}
        onCorrigirDado={(telaId) => corrigir(indiceDaTela(roteiro, telaId))}
        onApagar={() => setConfirmandoApagar(true)}
        confirmandoApagar={confirmandoApagar}
        onCancelarApagar={() => setConfirmandoApagar(false)}
        onConfirmarApagar={() => {
          apagarTudo();
          irPara(0);
        }}
      />
    );
  }

  return casca(conteudo, { cabecalho: true, rodape });
}

// ===========================================================================
// Pecas
// ===========================================================================

function Cabecalho({
  tela,
  totalDeEtapas,
  respondidas,
  total,
}: {
  tela: Tela;
  totalDeEtapas: number;
  respondidas: number;
  total: number;
}) {
  // O progresso conta PERGUNTAS RESPONDIDAS, nao telas visitadas: abertura de
  // etapa nao enche a barra, e voltar nao a esvazia.
  const pct = total > 0 ? (respondidas / total) * 100 : 0;
  const onde =
    tela.tipo === "dado"
      ? "Seus dados"
      : tela.tipo === "perguntas"
        ? `Etapa ${tela.etapa.numero} de ${totalDeEtapas}`
        : tela.tipo === "revisao"
          ? "Revisão"
          : "";
  return (
    <header className="shrink-0">
      <div
        className="h-[3px] w-full bg-foreground/[0.07]"
        role="progressbar"
        aria-label="Perguntas respondidas"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={respondidas}
        aria-valuetext={`${respondidas} de ${total} perguntas respondidas`}
      >
        <div
          className="h-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="max-w-xl mx-auto px-6 pt-3 flex items-baseline justify-between text-[12px] text-muted-foreground">
        <span className="font-medium tracking-wide">{onde}</span>
        <span className="tabular-nums" aria-hidden="true">
          {respondidas} de {total}
        </span>
      </div>
    </header>
  );
}

function Rodape({
  onVoltar,
  onPrincipal,
  rotulo,
  ocupado,
  destacado,
  dica,
}: {
  onVoltar: () => void;
  onPrincipal: () => void;
  rotulo: string;
  ocupado: boolean;
  destacado: boolean;
  dica: string | null;
}) {
  return (
    <footer
      className="shrink-0 border-t border-foreground/[0.06] bg-background/95 backdrop-blur"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}
    >
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onVoltar}
          disabled={ocupado}
          className="h-12 pl-2 pr-4 inline-flex items-center gap-1.5 rounded-xl text-[15px] text-foreground/80 hover:text-foreground hover:bg-foreground/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12.5 15l-5-5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Voltar
        </button>
        <div className="flex-1" />
        {dica && (
          <span className="hidden [@media(pointer:fine)]:inline text-[12px] text-muted-foreground" aria-hidden="true">
            ou tecle <kbd className="font-semibold">{dica}</kbd>
          </span>
        )}
        {/* NUNCA desabilitado por pendencia: tocar com algo faltando ESCREVE o
            que falta na tela. Desabilitado so durante o envio, e o proprio
            rotulo ("Enviando…") diz por que. */}
        <button
          type="button"
          onClick={onPrincipal}
          disabled={ocupado}
          aria-busy={ocupado || undefined}
          className={cn(
            "h-12 px-6 rounded-xl text-[15px] font-semibold inline-flex items-center gap-2 whitespace-nowrap",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "transition-[background-color,opacity,transform] duration-150 motion-reduce:transition-none active:scale-[0.98]",
            "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-70",
            !destacado && "bg-primary/85",
          )}
        >
          {rotulo}
          {!ocupado && (
            <svg aria-hidden="true" viewBox="0 0 20 20" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </footer>
  );
}

function Aviso({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" data-aviso className="flex items-start gap-2 text-[14px] leading-snug text-[#9B2C1F]">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor">
        <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm-.9 4h1.8l-.2 5.5H9.3L9.1 6zm.9 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

function TelaDePerguntas({
  className,
  tela,
  respostas,
  mostrarFaltas,
  recado,
  tituloRef,
  campoRef,
  alturaMaximaDoTexto,
  onEscolherEAvancar,
  onResponder,
  onAvancar,
  proximaNaCorrecao,
}: {
  className: string;
  tela: Extract<Tela, { tipo: "perguntas" }>;
  respostas: MapaDeRespostas;
  mostrarFaltas: boolean;
  recado: string | null;
  tituloRef: React.RefObject<HTMLHeadingElement | null>;
  campoRef: React.RefObject<CampoDeTextoHandle | null>;
  alturaMaximaDoTexto: number | null;
  onEscolherEAvancar: (q: QuizQuestion, v: ValorDeResposta) => void;
  onResponder: (id: string, v: ValorDeResposta) => void;
  onAvancar: () => void;
  proximaNaCorrecao: (() => void) | null;
}) {
  const totalNaEtapa = tela.etapa.questions.length;

  // --- Uma pergunta ----------------------------------------------------------
  const q = tela.perguntas[0];
  const valor = respostas[q.id];
  const falta = mostrarFaltas ? motivoDaFalta(q, valor) : null;
  const idDoEnunciado = `enunciado-${q.id}`;
  const idDoAviso = `aviso-${q.id}`;
  const texto = typeof valor === "string" ? valor : "";

  return (
    <section className={cn("space-y-8", className)}>
      <div className="space-y-4">
        <p className="text-[13px] font-medium tracking-wide text-muted-foreground tabular-nums">
          {tela.primeiroNumero}
          <span className="text-muted-foreground/60"> / {totalNaEtapa}</span>
        </p>
        <h2
          ref={tituloRef}
          id={idDoEnunciado}
          tabIndex={-1}
          className="text-[24px] sm:text-[28px] leading-[1.25] font-semibold tracking-tight outline-none"
        >
          <span className="sr-only">
            Pergunta {tela.primeiroNumero} de {totalNaEtapa}:{" "}
          </span>
          {q.text}
        </h2>
      </div>

      {recado && <Aviso id="recado">{recado}</Aviso>}

      {q.type === "scale" ? (
        <Escala
          question={q}
          valor={typeof valor === "number" ? valor : undefined}
          idDoEnunciado={idDoEnunciado}
          idDoAviso={falta ? idDoAviso : undefined}
          // Elemento 0-10 avanca ao tocar; Likert 1-5 so marca, e a pessoa toca
          // Continuar (revisao tecnica: selecao explicita seguida de Continuar).
          onEscolher={(n) => (tela.avancaSozinha ? onEscolherEAvancar(q, n) : onResponder(q.id, n))}
        />
      ) : q.type === "select" || q.type === "dilemma" ? (
        <Escolha
          question={q}
          valor={texto || undefined}
          idDoEnunciado={idDoEnunciado}
          idDoAviso={falta ? idDoAviso : undefined}
          onEscolher={(o) => onEscolherEAvancar(q, o)}
        />
      ) : q.type === "short_text" ? (
        <TextoCurto
          ref={campoRef}
          id={`campo-${q.id}`}
          valor={texto}
          idDoEnunciado={idDoEnunciado}
          idDoAviso={falta ? idDoAviso : undefined}
          invalido={!!falta}
          maxLength={q.max_chars}
          placeholder={q.placeholder}
          onChange={(v) => onResponder(q.id, v)}
          onEnter={onAvancar}
        />
      ) : q.type === "text" ? (
        <TextoAberto
          ref={campoRef}
          id={`campo-${q.id}`}
          valor={texto}
          idDoEnunciado={idDoEnunciado}
          idDoAviso={falta ? idDoAviso : undefined}
          invalido={!!falta}
          placeholder={q.placeholder}
          alturaMaxima={alturaMaximaDoTexto}
          onChange={(v) => onResponder(q.id, v)}
        />
      ) : (
        <p className="text-[15px] text-muted-foreground">
          Este tipo de pergunta ainda não é exibido nesta versão do formulário.
        </p>
      )}

      {falta && <Aviso id={idDoAviso}>{falta}</Aviso>}

      {proximaNaCorrecao && (
        <button
          type="button"
          onClick={proximaNaCorrecao}
          className="text-[14px] text-muted-foreground underline underline-offset-4 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          Rever a próxima desta etapa
        </button>
      )}
    </section>
  );
}

function BoasVindas(p: {
  tituloRef: React.RefObject<HTMLHeadingElement | null>;
  eventName: string;
  dataDoEvento: string | null;
  totalDePerguntas: number;
  totalDeEtapas: number;
  minutos: { de: number; ate: number };
  rascunho: Rascunho | null;
  respondidas: number;
  envioAnterior: number | null;
  confirmandoApagar: boolean;
  salvoNoAparelho: boolean;
  onComecar: () => void;
  onRetomar: () => void;
  onPedirApagar: () => void;
  onCancelarApagar: () => void;
  onApagar: () => void;
}) {
  const botao =
    "h-14 w-full sm:w-auto px-8 rounded-xl text-[16px] font-semibold inline-flex items-center justify-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0C0A] transition-[background-color,transform] duration-150 motion-reduce:transition-none active:scale-[0.98]";
  const nome = p.rascunho ? primeiroNome(p.rascunho.identificacao.nome) : "";

  // A CAPA. Escura e de borda a borda, so nesta tela: as perguntas continuam
  // claras, no fundo de leitura. No celular a foto ocupa a tela e o texto sobe
  // por cima da parte de baixo dela; a partir de lg a foto vai para a direita e
  // o texto fica numa coluna a esquerda.
  return (
    <section className="relative min-h-full overflow-hidden bg-[#0D0C0A] text-white">
      <div className="absolute inset-x-0 top-0 h-[74dvh] lg:bottom-0 lg:left-auto lg:h-auto lg:w-[58%]">
        <Image
          src="/marco-zero/capa-yuri.jpg"
          alt="Yuri Fortes"
          fill
          preload
          sizes="(min-width: 1024px) 58vw, 100vw"
          className="object-cover object-[50%_32%] animate-[capa-entra_2.4s_cubic-bezier(0.2,0.7,0.2,1)_both] motion-reduce:animate-none"
        />
        {/* Escurece de baixo para cima (celular) e da esquerda (lg), para o texto
            ler sobre a foto sem caixa nenhuma. */}
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(13,12,10,0.55)_0%,rgba(13,12,10,0)_22%,rgba(13,12,10,0)_38%,rgba(13,12,10,0.82)_68%,#0D0C0A_100%)] lg:bg-[linear-gradient(to_right,#0D0C0A_0%,rgba(13,12,10,0.55)_30%,rgba(13,12,10,0)_60%)]" />
      </div>

      <style>{`@keyframes capa-entra{from{transform:scale(1.08);opacity:0}to{transform:scale(1);opacity:1}}`}</style>

      {/* Primeira dobra: canto, foto e o bloco que leva ao botao. O aviso do
          rascunho fica logo abaixo dela, para o rosto nao sumir atras do texto. */}
      <div className="relative min-h-[100dvh] flex flex-col">
        <div className="w-full max-w-6xl mx-auto px-6 pt-6 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.28em] text-white/85">
          <span>Marco Zero</span>
          {p.dataDoEvento && <span className="tracking-[0.18em] text-white/60">{dataCurta(p.dataDoEvento)}</span>}
        </div>

        <div className="flex-1 min-h-[22svh] lg:min-h-0" />

        <div className="w-full max-w-6xl mx-auto px-6 pb-8 lg:pb-16">
          <div className="max-w-md space-y-6 animate-in fade-in-0 slide-in-from-bottom-3 duration-700 delay-300 fill-mode-both motion-reduce:animate-none">
            <div className="space-y-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.22em] text-[#D9C291]">
                Questionário de preparação
              </p>
              <h1
                ref={p.tituloRef}
                tabIndex={-1}
                className="text-[36px] sm:text-[52px] leading-[1.02] font-semibold tracking-[-0.02em] outline-none text-balance"
              >
                {p.eventName}
              </h1>
              <p className="text-[16px] leading-relaxed text-white/75">
                Algumas perguntas para o encontro ser sobre a sua vida, e não sobre um roteiro genérico.
              </p>
            </div>

            <dl className="grid grid-cols-3 gap-4 border-y border-white/15 py-4">
              <div>
                <dt className="text-[11px] uppercase tracking-[0.14em] text-white/50">Perguntas</dt>
                <dd className="mt-1 text-[22px] font-semibold tabular-nums">{p.totalDePerguntas}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.14em] text-white/50">Etapas</dt>
                <dd className="mt-1 text-[22px] font-semibold tabular-nums">{p.totalDeEtapas}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.14em] text-white/50">Minutos</dt>
                <dd className="mt-1 text-[22px] font-semibold tabular-nums">
                  {p.minutos.de} a {p.minutos.ate}
                </dd>
              </div>
            </dl>

            {p.rascunho ? (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <p className="text-[18px] font-semibold">
                    {nome ? `Que bom te ver de volta, ${nome}.` : "Que bom te ver de volta."}
                  </p>
                  <p className="text-[15px] leading-relaxed text-white/65">
                    Você já respondeu <span className="text-white font-medium tabular-nums">{p.respondidas} de {p.totalDePerguntas}</span>{" "}
                    perguntas neste aparelho. Dá para continuar exatamente de onde parou.
                  </p>
                </div>
                <button type="button" onClick={p.onRetomar} className={cn(botao, "bg-white text-[#0D0C0A] hover:bg-white/90")}>
                  Continuar de onde parei
                </button>
                {p.confirmandoApagar ? (
                  <div role="alert" className="rounded-xl border border-white/15 bg-white/[0.06] p-4 space-y-3 backdrop-blur-sm">
                    <p className="text-[15px] leading-relaxed">
                      Apagar as {p.respondidas} respostas salvas neste aparelho? Isso não tem volta, e você
                      começa do zero.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button type="button" onClick={p.onApagar} className="h-11 px-4 rounded-lg bg-[#9B2C1F] text-white text-[14px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D0C0A]">
                        Sim, apagar
                      </button>
                      <button type="button" onClick={p.onCancelarApagar} className="h-11 px-4 rounded-lg border border-white/25 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-white">
                        Manter minhas respostas
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={p.onPedirApagar}
                    className="block text-[14px] text-white/55 underline underline-offset-4 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white rounded"
                  >
                    Não é você, ou quer recomeçar? Apagar as respostas deste aparelho
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {p.envioAnterior && (
                  <p className="text-[15px] leading-relaxed text-white/65">
                    Este aparelho já enviou respostas para este encontro em{" "}
                    {new Date(p.envioAnterior).toLocaleDateString("pt-BR", { day: "numeric", month: "long" })}. Se
                    precisar corrigir alguma coisa, pode responder de novo: o novo envio{" "}
                    <span className="text-white font-medium">não apaga</span> o anterior, e a equipe
                    confirma qual vale antes do encontro.
                  </p>
                )}
                <button type="button" onClick={p.onComecar} className={cn(botao, "bg-white text-[#0D0C0A] hover:bg-white/90")}>
                  Começar
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="relative w-full max-w-6xl mx-auto px-6 pb-10">
        <div className="max-w-md">
          <p className="text-[12.5px] leading-relaxed text-white/45">
            {p.salvoNoAparelho
              ? `Enquanto você responde, o que escrever fica salvo só neste aparelho, por até ${PRAZO_DO_RASCUNHO_DIAS} dias, para você poder parar e continuar depois. Ao enviar, sai daqui. Se o aparelho for compartilhado, você pode apagar a qualquer momento.`
              : "Este navegador não deixa guardar o rascunho (aba privativa, talvez). Dá para responder normalmente, só não feche a página antes de enviar."}
          </p>
        </div>
      </div>
    </section>
  );
}

/** "sábado, 24 de outubro" -> "Sáb · 24.10", para o canto da capa. */
function dataCurta(data: string): string {
  const m = data.match(/^(\p{L}+)[^,]*, (\d{1,2}) de (\p{L}+)/u);
  if (!m) return data;
  const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const i = meses.indexOf(m[3].toLowerCase());
  if (i < 0) return data;
  return `${m[1].slice(0, 3)} · ${m[2].padStart(2, "0")}.${String(i + 1).padStart(2, "0")}`;
}

function Revisao(p: {
  className: string;
  tituloRef: React.RefObject<HTMLHeadingElement | null>;
  etapas: EtapaImersiva[];
  /** As respostas LIDAS DE VOLTA do rascunho gravado (ou as da tela, se o aparelho nao grava). */
  conferidas: MapaDeRespostas;
  conferidoNoAparelho: boolean;
  identificacao: Identificacao;
  erroDeEnvio: string | null;
  falhaNoEnvio: { tipo: "servidor" | "rede"; ocorrencia: string | null } | null;
  eventName: string;
  confirmandoApagar: boolean;
  onRever: (etapa: EtapaImersiva) => void;
  onCorrigirDado: (campo: "dado:nome" | "dado:email" | "dado:telefone") => void;
  onApagar: () => void;
  onCancelarApagar: () => void;
  onConfirmarApagar: () => void;
}) {
  const porEtapa = p.etapas.map((e) => {
    const faltam = e.questions.filter((q) => !respondida(q, p.conferidas[q.id])).length;
    return { etapa: e, faltam };
  });
  const faltamAoTodo = porEtapa.reduce((s, x) => s + x.faltam, 0);
  const erroNome = erroDeIdentificacao("nome", p.identificacao);
  const erroEmail = erroDeIdentificacao("email", p.identificacao);
  const tudoPronto = faltamAoTodo === 0 && !erroNome && !erroEmail;
  const linkCorrigir =
    "shrink-0 h-10 px-3 -mr-3 text-[14px] font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded";

  return (
    <section className={cn("space-y-8", p.className)}>
      <div className="space-y-3">
        <h2 ref={p.tituloRef} tabIndex={-1} className="text-[30px] leading-tight font-semibold tracking-tight outline-none">
          {tudoPronto ? "Tudo pronto para enviar" : "Quase lá"}
        </h2>
        <p className="text-[16px] leading-relaxed text-foreground/80">
          {tudoPronto
            ? "Confira seus dados antes de enviar. Se quiser rever alguma etapa, toque em Rever. Nada é enviado até você tocar em Confirmar e enviar."
            : `Ainda ${faltamAoTodo === 1 ? "falta 1 pergunta" : `faltam ${faltamAoTodo} perguntas`}. Toque em Rever na etapa marcada para ir direto a ela.`}
        </p>
      </div>

      {p.erroDeEnvio && <Aviso id="erro-envio">{p.erroDeEnvio}</Aviso>}

      {/* O ENVIO NAO FOI CONFIRMADO. Sem jargao, sem culpa, sem dizer que salvou
          no servidor. O que a pessoa precisa saber: nada se perdeu, e o que
          fazer -- o botao do rodape reenvia exatamente o mesmo conteudo. */}
      {p.falhaNoEnvio && (
        <div role="alert" data-aviso className="rounded-2xl border border-primary/40 bg-card px-4 py-5 space-y-3">
          <p className="text-[16px] font-semibold">
            {p.falhaNoEnvio.tipo === "rede"
              ? "Não tivemos confirmação de que suas respostas chegaram."
              : "Suas respostas ainda não chegaram até nós."}
          </p>
          <p className="text-[15px] leading-relaxed text-foreground/80">
            {p.falhaNoEnvio.tipo === "rede"
              ? "A conexão parece ter caído no meio do envio. Confira se a internet está funcionando."
              : "Tivemos um problema do nosso lado na hora de receber. Não foi nada que você fez."}
          </p>
          <p className="text-[15px] leading-relaxed text-foreground/80">
            Tudo o que você escreveu continua salvo neste aparelho, e você não precisa responder nada
            de novo. Espere alguns segundos e toque em Enviar de novo.
          </p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Se não der certo depois de algumas tentativas, avise a equipe do {p.eventName}
            {p.falhaNoEnvio.ocorrencia ? (
              <>
                {" "}e mostre este código:{" "}
                <span className="font-mono text-foreground">{p.falhaNoEnvio.ocorrencia}</span>
              </>
            ) : null}
            .
          </p>
        </div>
      )}

      <div className="space-y-3">
        <div className="rounded-2xl border border-foreground/[0.08] bg-card divide-y divide-foreground/[0.06]">
          {(
            [
              ["Nome", p.identificacao.nome, "dado:nome", erroNome],
              ["E-mail", p.identificacao.email, "dado:email", erroEmail],
              ["Telefone", p.identificacao.telefone || "Não informado", "dado:telefone", null],
            ] as const
          ).map(([rotulo, valor, telaId, erro]) => (
            <div key={telaId} className="pl-4 pr-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[12px] text-muted-foreground">{rotulo}</p>
                <p className="text-[16px] break-words">{valor || "Não informado"}</p>
                {erro && <p className="text-[13px] text-[#9B2C1F] pt-1">{erro}</p>}
              </div>
              <button type="button" className={linkCorrigir} onClick={() => p.onCorrigirDado(telaId)}>
                Corrigir
              </button>
            </div>
          ))}
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Essas informações serão usadas pela organização para identificar sua resposta e entrar em
          contato. Informá-las não significa que sua identidade foi verificada.
        </p>
      </div>

      <ul className="rounded-2xl border border-foreground/[0.08] bg-card divide-y divide-foreground/[0.06]">
        {porEtapa.map(({ etapa, faltam }) => (
          <li key={etapa.id} className="pl-4 pr-4 py-3.5 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] text-muted-foreground">Etapa {etapa.numero}</p>
              <p className="text-[16px] font-medium leading-snug">{etapa.titulo}</p>
              <p className={cn("text-[13px] pt-0.5", faltam === 0 ? "text-primary" : "text-[#9B2C1F] font-medium")}>
                {faltam === 0
                  ? `Completa · ${etapa.questions.length} de ${etapa.questions.length}`
                  : faltam === 1
                    ? "Falta 1 pergunta"
                    : `Faltam ${faltam} perguntas`}
              </p>
            </div>
            <button
              type="button"
              className={linkCorrigir}
              onClick={() => p.onRever(etapa)}
              aria-label={`Rever etapa ${etapa.numero}, ${etapa.titulo}`}
            >
              Rever
            </button>
          </li>
        ))}
      </ul>

      {!p.conferidoNoAparelho && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Este navegador não deixa guardar rascunho, então a conferência acima é do que está nesta
          tela. Não feche a página antes de enviar.
        </p>
      )}

      <div className="pt-2">
        {p.confirmandoApagar ? (
          <div role="alert" className="rounded-xl border border-foreground/15 bg-card p-4 space-y-3">
            <p className="text-[15px] leading-relaxed">
              Apagar todas as respostas salvas neste aparelho? Isso não tem volta.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={p.onConfirmarApagar} className="h-11 px-4 rounded-lg bg-[#9B2C1F] text-white text-[14px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
                Sim, apagar
              </button>
              <button type="button" onClick={p.onCancelarApagar} className="h-11 px-4 rounded-lg border border-foreground/20 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-primary">
                Manter
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={p.onApagar}
            className="text-[14px] text-muted-foreground underline underline-offset-4 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            Apagar as respostas deste aparelho
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Telas finais -- o texto da versao simples, que esta bom, sem mudanca de
// sentido. So a moldura muda.
// ---------------------------------------------------------------------------

function TelaFinal({ nome, eventName, dataDoEvento }: { nome: string; eventName: string; dataDoEvento: string | null }) {
  const n = primeiroNome(nome) || "tudo certo";
  return (
    <section className="space-y-8 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 motion-reduce:animate-none">
      <div className="space-y-4">
        <div className="w-12 h-12 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center" aria-hidden="true">
          <svg viewBox="0 0 20 20" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] font-medium tracking-wide text-primary">Recebemos</p>
        <h1 tabIndex={-1} className="text-[34px] leading-[1.1] font-semibold tracking-tight outline-none">
          Prontinho, {n}.
        </h1>
      </div>
      <div className="space-y-4 text-[16px] leading-relaxed text-foreground/80">
        <p>
          Suas respostas chegaram aqui inteiras. Você não precisa preencher nada de novo, nem
          guardar nenhum código: está tudo registrado no seu nome.
        </p>
        <p>
          <span className="text-foreground font-medium">O que acontece agora:</span> a equipe lê o
          que você escreveu antes do encontro. É isso que faz o {eventName} falar da sua vida e não
          de um roteiro genérico.
        </p>
        <p>
          {dataDoEvento ? (
            <>
              A gente se vê <span className="text-foreground font-medium">{dataDoEvento}</span>.
            </>
          ) : (
            <>A gente se vê no dia do encontro.</>
          )}{" "}
          Depois do encontro, você recebe um documento feito a partir das suas próprias respostas.
          Ele é seu, individual, e não um relatório de turma.
        </p>
        <p>
          Se precisar corrigir alguma coisa, você pode responder de novo neste mesmo link, com o
          mesmo e-mail. O novo envio <span className="text-foreground font-medium">não apaga este</span>:
          ele fica guardado ao lado, e a equipe confirma qual vale antes do encontro.
        </p>
      </div>
    </section>
  );
}

function TelaDeSegundaResposta({ nome, eventName }: { nome: string; eventName: string }) {
  const n = primeiroNome(nome) || "tudo certo";
  return (
    <section className="space-y-8 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 motion-reduce:animate-none">
      <div className="space-y-4">
        <p className="text-[13px] font-medium tracking-wide text-primary">Recebemos</p>
        <h1 tabIndex={-1} className="text-[30px] leading-[1.15] font-semibold tracking-tight outline-none">
          Seu envio está guardado, {n}.
        </h1>
      </div>
      <div className="space-y-4 text-[16px] leading-relaxed text-foreground/80">
        <p>
          Já existe um questionário respondido com este e-mail neste evento. Guardamos inteiro o que
          você respondeu agora.{" "}
          <span className="text-foreground font-medium">Nada do que você escreveu se perdeu</span>, e
          não colocamos nada por cima do que já estava aqui.
        </p>
        <p>
          <span className="text-foreground font-medium">Por que não substituímos:</span> pode ser você
          corrigindo o que respondeu antes, e pode ser que este e-mail seja de outra pessoa e tenha
          vindo com uma letra trocada. Pela tela não há como saber qual dos dois é, e apagar as
          respostas de alguém por engano não tem volta. Então nenhuma das duas é apagada.
        </p>
        <p>
          <span className="text-foreground font-medium">O que acontece agora:</span> alguém da
          equipe vê os dois envios e confirma qual é o seu antes do encontro. Você não precisa
          responder tudo de novo.
        </p>
        <p>
          Se o e-mail que você digitou tem algum erro de letra, ou se quiser contar qual dos envios é
          o certo, fale com a equipe do {eventName}: é o caminho mais rápido para o seu envio ser
          reconhecido como seu.
        </p>
      </div>
    </section>
  );
}
