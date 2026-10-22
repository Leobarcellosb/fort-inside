"use client";

// A TELA DA SEGUNDA RESPOSTA DO FORMULARIO PUBLICO.
//
// A ordem na tela e a ordem dos fatos:
//   1. POR QUE o conflito existe (o e-mail digitado ja tinha resposta) e de quem
//      e a PRIMEIRA resposta, que fica intacta em qualquer decisao;
//   2. os CADASTROS CANDIDATOS, com o motivo de cada um poder ou nao receber, e
//      a lista oficial no sistema quando houver;
//   3. o EFEITO de cada decisao, escrito antes do clique;
//   4. o FUNDAMENTO: uma das tres fontes aceitas (vocabulario fechado), a
//      referencia que identifica a conferencia e o motivo;
//   5. so entao confirmar.
//
// E, separado, o SEGUNDO FATO: quem foi regularizado e ainda nao teve o
// destinatario confirmado -- e por isso NAO pode receber o documento.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CANAIS_DO_DESTINATARIO,
  FONTES_ACEITAS,
  MINIMO_DO_MOTIVO,
  referenciaSuficiente,
  type CanalDoDestinatario,
  type CasoDeSegundaResposta,
  type FonteAceita,
  type MesaDaRegularizacao,
} from "@/lib/importacao/regularizacao";
import {
  confirmarDestinatario,
  desconsiderar,
  pedirMesaDaSegundaResposta,
  regularizar,
  type DesfechoDaSegundaResposta,
} from "./regularizar-segunda-resposta";

type Decisao = "vincular" | "criar" | "desconsiderar";

function Aviso({ d }: { d: DesfechoDaSegundaResposta }) {
  if (d.tipo === "mesa" || d.tipo === "gravado") return null;
  return (
    <div className="rounded-md border border-amber-600/50 bg-amber-600/10 p-3">
      <p className="text-xs leading-relaxed text-foreground">{d.mensagem}</p>
    </div>
  );
}

function Caso({ eventId, caso, aoDecidir }: { eventId: string; caso: CasoDeSegundaResposta; aoDecidir: () => void }) {
  const [decisao, setDecisao] = useState<Decisao | null>(null);
  const [alvo, setAlvo] = useState<string>("");
  const [convidado, setConvidado] = useState<string>("");
  const [nome, setNome] = useState(caso.submissao.nome_declarado ?? "");
  const [email, setEmail] = useState("");
  const [fonte, setFonte] = useState<FonteAceita | "">("");
  const [referencia, setReferencia] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<DesfechoDaSegundaResposta | null>(null);

  const vinculaveis = caso.candidatos.filter((c) => c.vinculavel);
  const referenciaOk = referenciaSuficiente(referencia, caso.submissao.email_digitado, caso.submissao.nome_declarado);
  const fundamentoOk = fonte !== "" && referenciaOk && motivo.trim().length >= MINIMO_DO_MOTIVO;
  const destinoOk =
    decisao === "desconsiderar" ||
    (decisao === "vincular" && alvo !== "") ||
    (decisao === "criar" && nome.trim().length >= 3 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()));
  const pode = decisao !== null && caso.consequencia !== null && fundamentoOk && destinoOk && !enviando;

  async function confirmar() {
    if (!pode) return;
    setEnviando(true);
    const fundamento = { fonte_tipo: fonte, referencia, motivo };
    const d =
      decisao === "desconsiderar"
        ? await desconsiderar({ eventId, caso, ...fundamento })
        : await regularizar({
            eventId,
            caso,
            ...fundamento,
            convidado_id: convidado === "" ? null : convidado,
            destino:
              decisao === "vincular"
                ? { tipo: "vincular", participant_id: alvo }
                : { tipo: "criar", nome: nome.trim(), email: email.trim().toLowerCase(), telefone: null },
          });
    setResultado(d);
    setEnviando(false);
    if (d.tipo === "gravado") aoDecidir();
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          Segunda resposta com o e-mail <span className="font-mono">{caso.submissao.email_digitado ?? "—"}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nome declarado: <strong>{caso.submissao.nome_declarado ?? "—"}</strong> · {caso.submissao.respostas_coletadas} respostas
          preservadas · recebida em {caso.submissao.recebida_em ?? "—"} · resultado: <strong>{caso.resultado}</strong>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <strong>Por que está aqui:</strong> {caso.porque.texto}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <strong>Procedência:</strong> {caso.procedencia}
        </p>
        {caso.primeira && (
          <p className="mt-1 text-xs text-muted-foreground">
            <strong>Primeira resposta (fica intacta):</strong> {caso.primeira.nome} &lt;{caso.primeira.email}&gt; —{" "}
            {caso.primeira.respostas_canonicas} etapa(s) gravada(s).
          </p>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-foreground">Cadastros do evento</p>
        <ul className="mt-1 space-y-1">
          {caso.candidatos.slice(0, 12).map((c) => (
            <li key={c.id} className="text-xs text-muted-foreground">
              <span className={c.vinculavel ? "text-foreground" : ""}>
                {c.nome} &lt;{c.email}&gt;
              </span>
              {c.semelhanca_do_nome > 0 && <> · nome parecido ({Math.round(c.semelhanca_do_nome * 100)}%)</>}
              {c.convidado && <> · na lista oficial do sistema</>}
              {c.impedimento ? <> · <em>não pode receber: {c.impedimento}</em></> : <> · pode receber</>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Lista oficial dentro do sistema: {caso.lista_oficial_no_sistema} pessoa(s)
          {caso.lista_oficial_no_sistema === 0 &&
            " — a conferência é feita na lista ou contato que a organização mantém fora daqui, e você registra qual."}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Decisão</p>
        {(
          [
            ["vincular", "Vincular a um cadastro existente", caso.efeitos.vincular, vinculaveis.length > 0],
            ["criar", "Criar cadastro (pessoa confirmada, sem cadastro no evento)", caso.efeitos.criar, true],
            ["desconsiderar", "Desconsiderar a segunda submissão — identidade conferida", caso.efeitos.desconsiderar, true],
          ] as [Decisao, string, string, boolean][]
        ).map(([valor, rotulo, efeito, disponivel]) => (
          <label key={valor} className={`block rounded-md border p-2 ${disponivel ? "" : "opacity-50"}`}>
            <input
              type="radio"
              name={`decisao-${caso.submissao.id}`}
              disabled={!disponivel}
              checked={decisao === valor}
              onChange={() => setDecisao(valor)}
            />{" "}
            <span className="text-xs font-medium text-foreground">{rotulo}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{efeito}</span>
          </label>
        ))}
      </div>

      {decisao === "vincular" && (
        <div className="space-y-1">
          <Label className="text-xs">Cadastro</Label>
          <select className="w-full rounded-md border bg-background p-2 text-xs" value={alvo} onChange={(e) => setAlvo(e.target.value)}>
            <option value="">— escolha —</option>
            {vinculaveis.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome} &lt;{c.email}&gt;
              </option>
            ))}
          </select>
        </div>
      )}
      {decisao === "criar" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Nome no cadastro</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">E-mail que a organização tem para a pessoa (continua não verificado)</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {caso.convidados_sem_cadastro.length > 0 && (
            <div className="sm:col-span-2">
              <Label className="text-xs">Convidado da lista oficial no sistema (opcional)</Label>
              <select className="w-full rounded-md border bg-background p-2 text-xs" value={convidado} onChange={(e) => setConvidado(e.target.value)}>
                <option value="">— nenhum —</option>
                {caso.convidados_sem_cadastro.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome} {c.email ? `<${c.email}>` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {decisao !== null && (
        <div className="space-y-2">
          <div>
            <Label className="text-xs">Fonte independente consultada</Label>
            <select
              className="w-full rounded-md border bg-background p-2 text-xs"
              value={fonte}
              onChange={(e) => setFonte(e.target.value as FonteAceita | "")}
            >
              <option value="">— escolha —</option>
              {(Object.keys(FONTES_ACEITAS) as FonteAceita[]).map((f) => (
                <option key={f} value={f}>
                  {FONTES_ACEITAS[f]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Não valem sozinhos: o nome e o e-mail escritos no próprio formulário, pertencer a grupo de WhatsApp, ou
              escrever só “identidade conferida”.
            </p>
          </div>
          <div>
            <Label className="text-xs">Referência da conferência (qual lista e linha, quem confirmou e quando, por qual contato)</Label>
            <Textarea value={referencia} onChange={(e) => setReferencia(e.target.value)} rows={2} />
            {referencia.trim() !== "" && !referenciaOk && (
              <p className="mt-1 text-xs text-amber-700">A referência ainda não identifica a conferência.</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Não anexe conversa, foto de documento nem dado sensível: só o que identifica a fonte.
            </p>
          </div>
          <div>
            <Label className="text-xs">Motivo (a divergência deste caso)</Label>
            <Textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} />
          </div>
          <Button size="sm" disabled={!pode} onClick={confirmar}>
            {enviando ? "Registrando…" : "Confirmar e registrar com o meu nome"}
          </Button>
        </div>
      )}

      {resultado && <Aviso d={resultado} />}
    </div>
  );
}

function Destinatario({ eventId, p, aoConfirmar }: { eventId: string; p: MesaDaRegularizacao["aguardando_destinatario"][number]; aoConfirmar: () => void }) {
  const [canal, setCanal] = useState<CanalDoDestinatario | "">("");
  const [referencia, setReferencia] = useState("");
  const [resultado, setResultado] = useState<DesfechoDaSegundaResposta | null>(null);
  const pode = canal !== "" && referenciaSuficiente(referencia, p.email_do_cadastro, p.nome);

  async function confirmar() {
    if (canal === "") return;
    const d = await confirmarDestinatario({
      event_id: eventId,
      participant_id: p.participant_id,
      canal_tipo: canal,
      referencia,
      email_destinatario: p.email_do_cadastro,
    });
    setResultado(d);
    if (d.tipo === "gravado") aoConfirmar();
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs text-foreground">
        {p.nome} &lt;{p.email_do_cadastro}&gt; — identidade confirmada pela organização ({p.fonte_tipo}).{" "}
        <strong>Entrega bloqueada</strong> até confirmar que a pessoa controla este endereço.
      </p>
      <select className="w-full rounded-md border bg-background p-2 text-xs" value={canal} onChange={(e) => setCanal(e.target.value as CanalDoDestinatario | "")}>
        <option value="">— canal independente —</option>
        {(Object.keys(CANAIS_DO_DESTINATARIO) as CanalDoDestinatario[]).map((c) => (
          <option key={c} value={c}>
            {CANAIS_DO_DESTINATARIO[c]}
          </option>
        ))}
      </select>
      <Textarea value={referencia} onChange={(e) => setReferencia(e.target.value)} rows={2} placeholder="Quem confirmou, quando, por qual contato previamente conhecido" />
      <Button size="sm" disabled={!pode} onClick={confirmar}>
        Confirmar destinatário
      </Button>
      {resultado && <Aviso d={resultado} />}
    </div>
  );
}

export function RegularizarSegundaResposta({ eventId }: { eventId: string }) {
  const [estado, setEstado] = useState<DesfechoDaSegundaResposta | null>(null);

  const carregar = useCallback(async () => {
    setEstado(await pedirMesaDaSegundaResposta(eventId));
  }, [eventId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (estado === null) return <p className="text-xs text-muted-foreground">Carregando segundas respostas…</p>;
  if (estado.tipo !== "mesa") return <Aviso d={estado} />;
  const mesa = estado.mesa;
  const pendentesDeDestinatario = mesa.aguardando_destinatario.filter((p) => !p.destinatario_confirmado);

  return (
    <section className="mb-10 space-y-4">
      <div>
        <h2 className="text-lg text-foreground">Segunda resposta com o mesmo e-mail</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {mesa.casos.length === 0
            ? "Nenhuma segunda resposta do formulário público espera decisão."
            : `${mesa.casos.length} segunda(s) resposta(s) esperam decisão.`}{" "}
          {mesa.desconsideradas.length > 0 && `${mesa.desconsideradas.length} desconsiderada(s), preservada(s) como registro.`}
        </p>
      </div>
      {mesa.casos.map((c) => (
        <Caso key={c.impressao_do_caso} eventId={eventId} caso={c} aoDecidir={carregar} />
      ))}
      {pendentesDeDestinatario.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm text-foreground">Destinatário a confirmar antes da entrega</h3>
          {pendentesDeDestinatario.map((p) => (
            <Destinatario key={p.participant_id} eventId={eventId} p={p} aoConfirmar={carregar} />
          ))}
        </div>
      )}
    </section>
  );
}
