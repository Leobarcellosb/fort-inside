"use client";

// A TELA DA DECISAO DO OPERADOR sobre identidade.
//
// O que ela existe para fazer: o operador VE O QUE ESTA AFIRMANDO antes de
// afirmar. Reconciliar a mao e dizer "esta submissao e desta pessoa" sem que o
// sistema tenha verificado -- e poder sobre dado de outra pessoa. Entao a ordem na
// tela e a ordem dos fatos, e nao e negociavel:
//
//   1. a MESA: o que espera decisao e o que pode ser revogado;
//   2. a SUBMISSAO: o que a coleta trouxe -- qual submissao, qual e-mail
//      declarado, se o formulario verificou esse e-mail, qual nome, e por que a
//      reconciliacao automatica NAO decidiu;
//   3. o PARTICIPANTE escolhido, e a FICHA dele: a afirmacao em primeira pessoa,
//      O QUE NAO BATE item por item, e o que o clique vai gravar;
//   4. a JUSTIFICATIVA, escrita;
//   5. so entao CONFIRMAR -- e so sobre a ficha que esta na tela.
//
// O botao de confirmar nao existe antes da ficha, fica DESABILITADO enquanto a
// ficha tiver impedimento ou a justificativa nao estiver escrita, e a rota recusa
// (IMPORT_DECISION_STALE) se a ficha tiver mudado desde que a tela a recebeu. Uma
// tela que oferece o botao errado ja mentiu.
//
// NENHUM NUMERO INVENTADO APARECE AQUI. A consequencia da reconciliacao vem do
// plano que seria gravado; o que a revogacao REMOVE e contado no banco. Quando
// nao da para afirmar, a tela diz que nao da -- em vez de mostrar zero.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  MINIMO_DA_JUSTIFICATIVA,
  TITULO_DO_CODIGO,
  conferirFichaContraGravado,
  justificativaSuficiente,
  pedirMesa,
  reconciliarSubmissao,
  resumoDaMesa,
  resumoDoAto,
  revogarSubmissao,
  type DesfechoDaMesa,
  type DesfechoDoAto,
} from "./decidir-identidade";
import { TITULO_DO_ESTADO_INCERTO } from "./importar-respostas";
import type {
  FichaDeReconciliacao,
  FichaDeRevogacao,
  MesaDeDecisao,
  Reversibilidade as ReversibilidadeDoContrato,
} from "@/lib/importacao/decisao-do-operador";

interface Props {
  eventId: string;
}

const ROTULO_DA_ACAO: Record<string, string> = {
  corrigir_planilha: "Corrija a planilha e confira de novo.",
  corrigir_coleta: "Corrija a coleta (o formulário ou a versão) e confira de novo.",
  refazer_previa: "Gere a prévia outra vez.",
  refazer_ficha: "Recarregue a mesa de decisões e confirme a partir da ficha que ela mostra.",
  escolher_outro_alvo: "Escolha outro participante, ou revogue antes a reconciliação que ocupa esse participante.",
  entrar_de_novo: "Entre de novo como administrador.",
  aguardar: "Aguarde alguns instantes e tente de novo.",
  conferir_o_que_esta_gravado:
    "Antes de tentar outra vez: abra este evento e confira o que está registrado para esta pessoa. Avise a equipe técnica com o número da ocorrência.",
  instalar_no_banco: "Avise a equipe técnica: falta instalar a atualização do banco.",
  falar_com_equipe: "Avise a equipe técnica.",
};

type Falha = Extract<
  DesfechoDoAto | DesfechoDaMesa,
  | { tipo: "recusado" }
  | { tipo: "nao_verificado" }
  // A gravacao desta tela passa pela MESMA funcao da importacao, entao a resposta
  // contraditoria do banco chega aqui tambem -- e nao pode ser mostrada com um
  // titulo que afirme "nada foi alterado".
  | { tipo: "estado_incerto" }
  | { tipo: "recurso_ausente" }
  | { tipo: "erro_inesperado" }
  | { tipo: "sem_conexao" }
>;

const CLASSES_DA_FALHA: Record<Falha["tipo"], string> = {
  // CONFERI E NAO PERMITI -> ha o que corrigir.
  recusado: "border-amber-600/50 bg-amber-600/10",
  // NAO CONSEGUI VERIFICAR -> nada foi decidido. Nao e culpa de ninguem.
  nao_verificado: "border-sky-600/50 bg-sky-600/10",
  // NAO DA PARA AFIRMAR O QUE FOI GRAVADO -> conferir antes de tentar de novo.
  estado_incerto: "border-orange-600/60 bg-orange-600/10",
  // NAO ESTA INSTALADO -> nem o operador nem a espera resolvem.
  recurso_ausente: "border-violet-600/50 bg-violet-600/10",
  erro_inesperado: "border-destructive/50 bg-destructive/10",
  sem_conexao: "border-destructive/50 bg-destructive/10",
};

const TITULO_DA_FALHA: Record<Falha["tipo"], string> = {
  recusado: "Conferido e não autorizado — nada foi alterado",
  nao_verificado: "Não foi possível verificar — nada foi alterado",
  // Sem "nada foi alterado": e isso que esta em duvida. O titulo por codigo
  // (TITULO_DO_CODIGO) e o que aparece, e ele vem da tela da importacao.
  estado_incerto: TITULO_DO_ESTADO_INCERTO,
  recurso_ausente: "O recurso não está instalado neste ambiente — nada foi alterado",
  erro_inesperado: "Algo inesperado — nada foi alterado",
  sem_conexao: "Sem conexão — nada foi alterado",
};

function ehFalha(d: DesfechoDoAto | DesfechoDaMesa | null): Falha | null {
  if (d === null) return null;
  return d.tipo === "mesa" || d.tipo === "reconciliado" || d.tipo === "revogado" ? null : (d as Falha);
}

function Aviso({ falha }: { falha: Falha }) {
  const codigo = "codigo" in falha ? falha.codigo : null;
  const titulo = (codigo && TITULO_DO_CODIGO[codigo]) || TITULO_DA_FALHA[falha.tipo];
  const acao = "acao" in falha ? ROTULO_DA_ACAO[falha.acao] : null;
  return (
    <div className={`rounded-md border p-4 ${CLASSES_DA_FALHA[falha.tipo]}`}>
      <p className="text-sm font-medium text-foreground">{titulo}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{falha.mensagem}</p>
      {acao && <p className="mt-2 text-xs font-medium text-foreground">{acao}</p>}
    </div>
  );
}

/**
 * O CONTRATO DE REVERSIBILIDADE, mostrado PREVIAMENTE e por submissao.
 *
 * Nao e um aviso igual em toda a tela: um aviso que aparece sempre nao informa
 * nada. Os tres estados tem textos, cores e consequencias diferentes, e o
 * operador le o DESTA submissao antes de clicar nela.
 */
function Reversibilidade({ r }: { r: ReversibilidadeDoContrato }) {
  const classe =
    r.estado === "procedimento_excepcional"
      ? "border-destructive/60 bg-destructive/10"
      : r.estado === "operacao_controlada"
        ? "border-amber-600/50 bg-amber-600/5"
        : "border-emerald-600/40 bg-emerald-600/5";
  const titulo =
    r.estado === "procedimento_excepcional"
      ? "Desfazer NÃO é ação simples aqui"
      : r.estado === "operacao_controlada"
        ? "Desfazer é possível, por operação controlada"
        : "Desfazer é correção simples";
  return (
    <div className={`rounded border p-3 ${classe}`}>
      <p className="text-xs font-medium text-foreground">{titulo}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.texto}</p>
      {r.efeitos_nao_reversiveis.length > 0 && (
        <ul className="mt-2 space-y-1">
          {r.efeitos_nao_reversiveis.map((e) => (
            <li key={e} className="text-xs leading-relaxed text-destructive">
              Não volta por ação simples: {e}.
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Em qualquer dos casos, o registro original da submissão é preservado: corrigir identidade nunca
        apaga a evidência necessária para reconstruir o que aconteceu.
      </p>
    </div>
  );
}

/** A FICHA: o que esta sendo afirmado, e com base em que. */
function Ficha({ ficha }: { ficha: FichaDeReconciliacao }) {
  const c = ficha.consequencia;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
      <p className="text-xs font-medium leading-relaxed text-foreground">{ficha.afirmacao}</p>

      <div>
        <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">O que não bate</p>
        {ficha.divergencias.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Nada a apontar além do que já está acima: mesmo assim, a verificação não foi feita pelo sistema.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {ficha.divergencias.map((d) => (
              <li key={d.codigo} className="text-xs leading-relaxed text-foreground">
                <span className="font-mono text-[11px] text-muted-foreground">{d.codigo}</span> — {d.texto}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">O que a confirmação grava</p>
        {c === null ? (
          <p className="mt-1 text-xs leading-relaxed text-amber-600">
            Não dá para afirmar o que seria gravado: o questionário que esta pessoa respondeu não confere
            com o do sistema, ou não foi possível conferi-lo. Nada será gravado enquanto isso não for
            resolvido.
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-foreground">
            <li>
              {c.etapas_a_gravar} etapa(s) de resposta e {c.itens_a_registrar} item(ns) de resposta, com
              procedência de <strong>decisão do operador</strong> (não de e-mail verificado).
            </li>
            <li>
              {c.apto_para_pontuar ? (
                "A submissão fica apta a pontuar."
              ) : (
                <span className="text-amber-600">
                  A submissão NÃO fica apta a pontuar: há DADO INCOMPATÍVEL
                  {c.bloqueio ? ` em ${c.bloqueio.perguntas.length} pergunta(s) pontuada(s)` : ""}. Isso não
                  é pontuação zero, e fica registrado como incompatível.
                </span>
              )}
            </li>
            <li>
              {c.reversivel ? (
                "Reversível: nenhuma resposta existente é sobrescrita, e revogar devolve o estado anterior."
              ) : (
                <span className="text-destructive">
                  NÃO reversível: {c.respostas_sobrescritas} resposta(s) deste participante seriam
                  sobrescritas, e revogar depois não as devolveria.
                </span>
              )}
            </li>
          </ul>
        )}
      </div>

      {ficha.reversibilidade && <Reversibilidade r={ficha.reversibilidade} />}

      {ficha.impedimento && (
        <p className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs leading-relaxed text-foreground">
          <strong>Não é possível confirmar:</strong> {ficha.impedimento.texto}.
        </p>
      )}
    </div>
  );
}

export function ResolverIdentidadesExternas({ eventId }: Props) {
  const [mesa, setMesa] = useState<MesaDeDecisao | null>(null);
  const [desfecho, setDesfecho] = useState<DesfechoDoAto | DesfechoDaMesa | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [escolha, setEscolha] = useState<Record<string, string>>({});
  const [razao, setRazao] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    const d = await pedirMesa(eventId);
    if (d.tipo === "mesa") {
      setMesa(d.mesa);
      // A mesa nova NAO apaga o aviso do ato anterior: o operador precisa ler o
      // que acabou de acontecer. Ela apaga so o aviso de falha DA LEITURA.
      setDesfecho((atual) => (atual !== null && atual.tipo === "mesa" ? null : atual));
    } else {
      // Mesa que nao chegou NAO e mesa vazia: a tela nao diz "nada a decidir".
      setMesa(null);
      setDesfecho(d);
    }
    setCarregando(false);
  }, [eventId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const falha = useMemo(() => ehFalha(desfecho), [desfecho]);
  const ato = desfecho !== null && (desfecho.tipo === "reconciliado" || desfecho.tipo === "revogado") ? desfecho : null;
  const conferencia =
    ato !== null && ato.tipo === "reconciliado" ? conferirFichaContraGravado(ato.ficha, ato.gravado) : null;

  async function confirmar(ficha: FichaDeReconciliacao) {
    const justificativa = razao[ficha.submissao.id] ?? "";
    if (!ficha.permitida || !justificativaSuficiente(justificativa)) return;
    setOcupado(ficha.submissao.id);
    const r = await reconciliarSubmissao({ eventId, ficha, justificativa });
    setDesfecho(r);
    setOcupado(null);
    if (r.tipo === "reconciliado") {
      setRazao((a) => ({ ...a, [ficha.submissao.id]: "" }));
    }
    // Recarrega sempre: depois de uma recusa de ficha vencida, o operador tem de
    // ver a ficha NOVA, nao apenas ler que a antiga venceu.
    await carregar();
  }

  async function revogar(ficha: FichaDeRevogacao) {
    const justificativa = razao[`rev-${ficha.submissao.id}`] ?? "";
    if (!ficha.permitida || !justificativaSuficiente(justificativa)) return;
    setOcupado(`rev-${ficha.submissao.id}`);
    const r = await revogarSubmissao({ eventId, ficha, justificativa });
    setDesfecho(r);
    setOcupado(null);
    if (r.tipo === "revogado") {
      setRazao((a) => ({ ...a, [`rev-${ficha.submissao.id}`]: "" }));
    }
    await carregar();
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
              Mesa de decisões de identidade
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {mesa === null
                ? carregando
                  ? "Lendo a mesa…"
                  : "A mesa não foi lida. O que está escrito abaixo não é “nada a decidir”: é que não deu para ler."
                : resumoDaMesa(mesa)}
            </p>
          </div>
          <Button variant="outline" onClick={() => void carregar()} disabled={carregando}>
            {carregando ? "Lendo…" : "Recarregar a mesa"}
          </Button>
        </div>

        {mesa !== null && (
          <p className="text-xs text-muted-foreground">
            Submissões por estado:{" "}
            {Object.entries(mesa.por_estado).length === 0
              ? "nenhuma submissão externa neste evento."
              : Object.entries(mesa.por_estado)
                  .map(([e, n]) => `${e}: ${n}`)
                  .join(" · ")}
          </p>
        )}
      </section>

      {falha && <Aviso falha={falha} />}

      {ato && (
        <div className="rounded-md border border-emerald-600/40 bg-emerald-600/10 p-4">
          <p className="text-sm font-medium text-foreground">
            {ato.tipo === "reconciliado" ? "Decisão registrada e efetivada" : "Reconciliação revogada"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{resumoDoAto(ato)}</p>
          {conferencia && !conferencia.bate && (
            <ul className="mt-2 space-y-1">
              {conferencia.divergencias.map((d) => (
                <li key={d} className="text-xs text-destructive">
                  A ficha e o que foi gravado não batem — {d}. Avise a equipe técnica.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ------------------------------------------- esperam decisao humana */}
      {mesa !== null && (
        <section className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
              Esperam decisão humana
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              A reconciliação automática é por e-mail verificado do formulário. Quem não casou ficou aqui:
              nunca criado em silêncio, nunca descartado em silêncio. Atribuir uma destas submissões a um
              participante é um <strong>ato seu</strong>, registrado com a sua justificativa e reversível.
            </p>
          </div>

          {mesa.a_decidir.length === 0 && (
            <p className="rounded-md border border-border p-4 text-xs text-muted-foreground">
              Nenhuma submissão externa deste evento espera decisão de identidade.
            </p>
          )}

          {mesa.a_decidir.map((grupo) => {
            const id = grupo.submissao.id;
            const escolhido = escolha[id] ?? "";
            const ficha = grupo.candidatos.find((c) => c.participante.id === escolhido) ?? null;
            const justificativa = razao[id] ?? "";
            return (
              <div key={id} className="space-y-4 rounded-md border border-border p-4">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-foreground">{grupo.submissao.submissao_id}</p>
                  <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="inline text-muted-foreground">E-mail declarado: </dt>
                      <dd className="inline text-foreground">
                        {grupo.submissao.email_coletado ?? "— nenhum —"}{" "}
                        {grupo.submissao.email_verificado ? (
                          <span className="text-emerald-600">(verificado pelo formulário)</span>
                        ) : (
                          <span className="text-amber-600">(NÃO verificado pelo formulário)</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Nome declarado: </dt>
                      <dd className="inline text-foreground">{grupo.submissao.nome_declarado ?? "— nenhum —"}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Estado: </dt>
                      <dd className="inline text-foreground">{grupo.submissao.estado}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">Respostas coletadas: </dt>
                      <dd className="inline text-foreground">{grupo.submissao.respostas_coletadas}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="inline text-muted-foreground">Formulário: </dt>
                      <dd className="inline text-foreground">
                        {grupo.submissao.formulario_nome ?? grupo.submissao.formulario_id}
                      </dd>
                    </div>
                  </dl>
                  {grupo.identidade_automatica.motivo && (
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      <strong className="text-foreground">Por que não decidiu sozinho:</strong>{" "}
                      {grupo.identidade_automatica.motivo}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`alvo-${id}`}>De quem é esta submissão?</Label>
                  <select
                    id={`alvo-${id}`}
                    value={escolhido}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    onChange={(e) => setEscolha((a) => ({ ...a, [id]: e.target.value }))}
                  >
                    <option value="">— escolha um participante deste evento —</option>
                    {grupo.candidatos.map((c) => (
                      <option key={c.participante.id} value={c.participante.id}>
                        {c.participante.nome} ({c.participante.email || "sem e-mail"})
                        {c.permitida ? "" : " — não é possível: já tem resposta ou submissão ativa"}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Nenhum participante é sugerido por semelhança de nome ou de e-mail: “João Silva” e “joão
                    silva” podem ser duas pessoas.
                  </p>
                </div>

                {ficha && <Ficha ficha={ficha} />}

                {ficha && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`razao-${id}`}>
                      Por que você afirma que esta submissão é dessa pessoa?
                    </Label>
                    <Textarea
                      id={`razao-${id}`}
                      value={justificativa}
                      rows={2}
                      placeholder="Ex.: conferido com a lista de inscritos no credenciamento; a pessoa respondeu com o e-mail pessoal."
                      onChange={(e) => setRazao((a) => ({ ...a, [id]: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Fica gravada no histórico, com o seu nome e a data. Mínimo de {MINIMO_DA_JUSTIFICATIVA}{" "}
                      caracteres — isto será lido por quem precisar entender a decisão depois.
                    </p>
                  </div>
                )}

                {ficha && (
                  <Button
                    onClick={() => void confirmar(ficha)}
                    disabled={
                      ocupado !== null || !ficha.permitida || !justificativaSuficiente(justificativa)
                    }
                  >
                    {ocupado === id
                      ? "Registrando e gravando…"
                      : `Confirmar: esta submissão é de ${ficha.participante.nome}`}
                  </Button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* --------------------------------------------------- revogaveis */}
      {mesa !== null && (
        <section className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-sm font-medium uppercase tracking-[0.1em] text-foreground">
              Reconciliações registradas — podem ser revogadas
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Revogar não apaga o passado: é um ato novo, que se soma ao histórico. A submissão continua
              registrada, com tudo o que a pessoa respondeu. O que sai são as respostas canônicas que
              nasceram dela — porque elas afirmavam ser respostas daquela pessoa, e isso deixou de ser
              verdade.
            </p>
          </div>

          {mesa.revogaveis.length === 0 && (
            <p className="rounded-md border border-border p-4 text-xs text-muted-foreground">
              Nenhuma reconciliação registrada neste evento.
            </p>
          )}

          {mesa.revogaveis.map((ficha) => {
            const chave = `rev-${ficha.submissao.id}`;
            const justificativa = razao[chave] ?? "";
            return (
              <div key={ficha.submissao.id} className="space-y-4 rounded-md border border-border p-4">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-foreground">{ficha.submissao.submissao_id}</p>
                  <p className="text-xs text-foreground">
                    Hoje atribuída a <strong>{ficha.participante.nome}</strong> (
                    {ficha.participante.email || "sem e-mail"}), por{" "}
                    {ficha.identidade_via === "decisao_do_operador"
                      ? "decisão do operador"
                      : ficha.identidade_via === "email_verificado"
                        ? "e-mail verificado pelo formulário"
                        : "procedência não registrada"}
                    .
                  </p>
                  <ul className="mt-2 space-y-1">
                    {ficha.avisos.map((a) => (
                      <li
                        key={a}
                        className={`text-xs leading-relaxed ${a.startsWith("ATENCAO") ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>

                <Reversibilidade r={ficha.reversibilidade} />

                {/* O INVENTARIO: de quem era cada registro que sai. A reversao
                    demonstra titularidade em vez de somar linhas, e este mesmo
                    inventario vai para o histórico junto da sua justificativa. */}
                <div>
                  <p className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
                    Registros que seriam removidos
                  </p>
                  {ficha.registros.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nenhum registro canônico nasceu desta submissão: não há o que remover.
                    </p>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {ficha.registros.map((r) => (
                        <li key={r.stage_id} className="font-mono text-[11px] text-foreground">
                          etapa {r.stage_id} · {ficha.participante.nome} · origem {r.origem}
                          {r.submetida_em ? ` · ${r.submetida_em}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={`razao-${chave}`}>Por que esta reconciliação deve ser desfeita?</Label>
                  <Textarea
                    id={`razao-${chave}`}
                    value={justificativa}
                    rows={2}
                    placeholder="Ex.: era outra pessoa — o e-mail pertence a um homônimo da turma."
                    onChange={(e) => setRazao((a) => ({ ...a, [chave]: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Fica gravada no histórico, junto do ato anterior, que continua lá. Mínimo de{" "}
                    {MINIMO_DA_JUSTIFICATIVA} caracteres.
                  </p>
                </div>

                <Button
                  variant="destructive"
                  onClick={() => void revogar(ficha)}
                  disabled={ocupado !== null || !ficha.permitida || !justificativaSuficiente(justificativa)}
                >
                  {ocupado === chave
                    ? "Revogando…"
                    : `Revogar e remover ${ficha.respostas_canonicas_a_remover} resposta(s)`}
                </Button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
