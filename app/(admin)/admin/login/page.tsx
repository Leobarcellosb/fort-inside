"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/Logo";
import { MARCA } from "@/lib/marca";
import {
  PAGINA_DE_NOVA_SENHA,
  TEXTO_LINK_ENVIADO,
  TEXTO_LINK_INVALIDO,
  destinoSeguro,
  enderecoDeRetorno,
} from "@/lib/auth/retorno-do-email";

// Tres jeitos de entrar no painel, todos na mesma conta do Supabase Auth:
//   senha    -> signInWithPassword (como sempre foi);
//   link     -> signInWithOtp, um link de acesso no e-mail, SEM criar conta nova;
//   esqueci  -> resetPasswordForEmail, o link leva a /admin/login/nova-senha.
// Os dois links voltam por /admin/login/confirmar. Ter sessao nao e ser admin: o
// proxy continua exigindo app_metadata.role = "admin" para abrir o painel.

type Modo = "senha" | "link" | "esqueci";

const campo =
  "bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0";

export default function AdminLoginPage() {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("senha");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [destino, setDestino] = useState(destinoSeguro(null));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setDestino(destinoSeguro(params.get("next")));
    if (params.get("link") === "invalido") setError(TEXTO_LINK_INVALIDO);
  }, []);

  function trocarModo(novo: Modo) {
    setModo(novo);
    setError(null);
    setAviso(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setAviso(null);
    const supabase = createClient();

    if (modo === "senha") {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setError("Credenciais inválidas.");
        setLoading(false);
        return;
      }
      router.push(destino);
      router.refresh();
      return;
    }

    const origem = window.location.origin;
    const { error: envioError } =
      modo === "link"
        ? await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false, emailRedirectTo: enderecoDeRetorno(origem, destino) },
          })
        : await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: enderecoDeRetorno(origem, PAGINA_DE_NOVA_SENHA),
          });

    // Limite de envio e o unico erro dito como tal. Qualquer outro, inclusive
    // "conta nao existe", vira a mesma frase de sucesso: a tela nao revela quem
    // tem acesso ao painel.
    if (envioError && envioError.status === 429) {
      setError("Muitos pedidos seguidos. Espere um minuto e tente de novo.");
    } else {
      if (envioError) console.error("[login-por-email] envio", envioError.status, envioError.name);
      setAviso(TEXTO_LINK_ENVIADO);
    }
    setLoading(false);
  }

  const rotuloDoBotao =
    modo === "senha"
      ? loading
        ? "Entrando..."
        : "Entrar"
      : loading
        ? "Enviando..."
        : modo === "link"
          ? "Enviar link de acesso"
          : "Enviar link para nova senha";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center text-center space-y-4">
          <Logo size="lg" />
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-display">{MARCA}</p>
            <h1 className="font-display text-2xl text-foreground font-bold">
              {modo === "esqueci" ? "Redefinir senha" : "Acesso restrito"}
            </h1>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">E-mail</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className={campo}
            />
          </div>

          {modo === "senha" && (
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Senha</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className={campo}
              />
            </div>
          )}

          {modo !== "senha" && (
            <p className="text-xs text-muted-foreground">
              {modo === "link"
                ? "Vamos mandar um link de acesso para o seu e-mail. Não precisa de senha."
                : "Vamos mandar um link para você criar uma senha nova."}
            </p>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
          {aviso && <p className="text-xs text-foreground">{aviso}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] mt-2"
          >
            {rotuloDoBotao}
          </Button>
        </form>

        <div className="flex flex-col items-center gap-2 text-xs">
          {modo !== "senha" && (
            <button type="button" onClick={() => trocarModo("senha")} className="text-muted-foreground underline">
              Entrar com senha
            </button>
          )}
          {modo !== "link" && (
            <button type="button" onClick={() => trocarModo("link")} className="text-muted-foreground underline">
              Entrar com link no e-mail
            </button>
          )}
          {modo !== "esqueci" && (
            <button type="button" onClick={() => trocarModo("esqueci")} className="text-muted-foreground underline">
              Esqueci minha senha
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
