"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { joinEventSchema, type JoinEventInput } from "@/lib/schemas";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  eventId: string;
  eventCode: string;
}

// Espera minima antes de pedir outro codigo. Acompanha o intervalo padrao do
// Supabase Auth por usuario (60 s); pedir antes disso so geraria recusa.
const REENVIO_SEGUNDOS = 60;

// Leitura tolerante do corpo de erro das rotas /api/entrar/*: so usamos o texto
// que NOSSA rota escreve; qualquer outra coisa vira mensagem generica.
async function leResposta(res: Response) {
  const json = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    codigo?: unknown;
    participant_id?: unknown;
    event_id?: unknown;
  };
  return {
    erro: typeof json.error === "string" ? json.error : null,
    codigo: typeof json.codigo === "string" ? json.codigo : null,
    participantId: typeof json.participant_id === "string" ? json.participant_id : null,
    eventId: typeof json.event_id === "string" ? json.event_id : null,
  };
}

export function JoinForm({ eventId, eventCode }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // "dados": nome/e-mail; "codigo": digitar o codigo enviado ao e-mail.
  const [etapa, setEtapa] = useState<"dados" | "codigo">("dados");
  const [codigo, setCodigo] = useState("");
  const [erroCodigo, setErroCodigo] = useState<string | null>(null);
  const [espera, setEspera] = useState(0);
  const codigoRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<JoinEventInput>({
    resolver: zodResolver(joinEventSchema),
  });

  // Contagem regressiva do "reenviar codigo".
  useEffect(() => {
    if (espera <= 0) return;
    const t = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  useEffect(() => {
    if (etapa === "codigo") codigoRef.current?.focus();
  }, [etapa]);

  // Pede o codigo. A resposta e a mesma exista a conta ou nao: a tela nunca
  // diz se o e-mail ja tinha cadastro. NAO ha sessao nem senha aqui; a sessao
  // so nasce em /api/entrar/verificar, depois de a pessoa provar o e-mail.
  async function pedirCodigo(email: string): Promise<boolean> {
    const res = await fetch("/api/entrar/solicitar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, event_id: eventId, event_code: eventCode }),
    });
    if (res.ok) {
      setEspera(REENVIO_SEGUNDOS);
      return true;
    }
    const r = await leResposta(res);
    const mensagem = r.erro ?? "Não foi possível enviar o código agora.";
    if (res.status === 503 || res.status === 429) {
      setAviso(mensagem);
      return false;
    }
    throw new Error(mensagem);
  }

  async function verificar(data: JoinEventInput) {
    const res = await fetch("/api/entrar/verificar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.email,
        token: codigo,
        event_id: eventId,
        event_code: eventCode,
        full_name: data.full_name,
        phone: data.phone || undefined,
        course_or_moment: data.course_or_moment || undefined,
      }),
    });
    const r = await leResposta(res);

    if (!res.ok || !r.participantId || !r.eventId) {
      if (res.status === 401) {
        setErroCodigo(r.erro ?? "Código inválido ou expirado.");
        return;
      }
      if (res.status === 429 || res.status === 503 || res.status === 409) {
        setAviso(r.erro ?? "Não foi possível entrar agora.");
        return;
      }
      throw new Error(r.erro ?? "Não foi possível entrar agora.");
    }

    // A sessao ja esta nos cookies (Set-Cookie da rota). As telas
    // quiz/[stageId] e waiting leem estas duas chaves do localStorage; sem
    // elas a pessoa autentica e volta para "/". Se ESTE navegador guardava
    // outra pessoa, as respostas em rascunho dela (fort_answers_N) nao podem
    // aparecer para quem acabou de entrar.
    try {
      const anterior = localStorage.getItem("fort_participant_id");
      if (anterior && anterior !== r.participantId) {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith("fort_answers_")) localStorage.removeItem(k);
        }
      }
      localStorage.setItem("fort_participant_id", r.participantId);
      localStorage.setItem("fort_event_id", r.eventId);
    } catch {
      throw new Error(
        "Seu navegador bloqueou o armazenamento local. Saia da aba privativa ou libere o armazenamento do site e tente de novo."
      );
    }

    router.push("/waiting");
  }

  async function onSubmit(data: JoinEventInput) {
    setLoading(true);
    setAviso(null);
    setErroCodigo(null);
    try {
      if (etapa === "dados") {
        if (await pedirCodigo(data.email)) {
          setCodigo("");
          setEtapa("codigo");
        }
        return;
      }

      const digitos = codigo.replace(/\D/g, "");
      if (digitos.length < 6) {
        setErroCodigo("Digite o código que enviamos para o seu e-mail.");
        return;
      }
      await verificar(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }

  async function reenviar() {
    setLoading(true);
    setAviso(null);
    setErroCodigo(null);
    try {
      if (await pedirCodigo(getValues("email"))) {
        toast.success("Enviamos um novo código.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }

  function trocarEmail() {
    setEtapa("dados");
    setCodigo("");
    setAviso(null);
    setErroCodigo(null);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className={etapa === "dados" ? "space-y-5" : "hidden"}>
      <div className="space-y-1.5">
        <Label htmlFor="full_name" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Nome completo
        </Label>
        <Input
          id="full_name"
          placeholder="Seu nome"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("full_name")}
        />
        {errors.full_name && (
          <p className="text-xs text-destructive">{errors.full_name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          E-mail
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="seu@email.com"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phone" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          Telefone <span className="normal-case text-muted-foreground/60">(opcional)</span>
        </Label>
        <Input
          id="phone"
          type="tel"
          placeholder="(11) 99999-0000"
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("phone")}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="course_or_moment" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
          O que te trouxe até aqui? <span className="normal-case text-muted-foreground/60">(opcional)</span>
        </Label>
        <Input
          id="course_or_moment"
          placeholder="Ex: empresário em transição, investidor, em construção de carreira..."
          className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors"
          {...register("course_or_moment")}
        />
      </div>

      </div>

      {etapa === "codigo" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Se o e-mail <span className="text-foreground">{getValues("email")}</span> estiver
            correto, enviamos um código de uso único para ele. Digite o código abaixo. Confira
            também a caixa de spam.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="codigo" className="text-xs uppercase tracking-[0.1em] text-muted-foreground">
              Código
            </Label>
            <Input
              id="codigo"
              ref={codigoRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              placeholder="000000"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              aria-invalid={erroCodigo ? true : undefined}
              className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0 transition-colors tracking-[0.3em] text-lg"
            />
            {erroCodigo && <p className="text-xs text-destructive">{erroCodigo}</p>}
          </div>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={reenviar}
              disabled={loading || espera > 0}
              className="underline underline-offset-4 text-muted-foreground disabled:no-underline disabled:opacity-60"
            >
              {espera > 0 ? `Reenviar código em ${espera}s` : "Reenviar código"}
            </button>
            <button
              type="button"
              onClick={trocarEmail}
              disabled={loading}
              className="underline underline-offset-4 text-muted-foreground"
            >
              Usar outro e-mail
            </button>
          </div>
        </div>
      )}

      {aviso && (
        <p
          role="status"
          className="text-sm text-center bg-secondary border border-border rounded-md px-4 py-3"
        >
          {aviso}
        </p>
      )}

      <Button
        type="submit"
        disabled={loading}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-display uppercase tracking-[0.08em] text-sm h-12 mt-2"
      >
        {etapa === "dados"
          ? loading
            ? "Enviando código..."
            : "Enviar código"
          : loading
            ? "Entrando..."
            : "Entrar na imersão"}
      </Button>
    </form>
  );
}
