"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/Logo";
import { DESTINO_PADRAO } from "@/lib/auth/retorno-do-email";

// NOVA SENHA, depois do link de redefinicao. O link ja abriu uma sessao (rota
// /admin/login/confirmar); aqui so se troca a senha dessa sessao. Sem sessao, o
// link venceu ou foi aberto em outro navegador, e a tela manda pedir outro.

const MINIMO = 8;

const campo =
  "bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary px-0";

export default function NovaSenhaPage() {
  const router = useRouter();
  const [temSessao, setTemSessao] = useState<boolean | null>(null);
  const [senha, setSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setTemSessao(!!data.user));
  }, []);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (senha.length < MINIMO) return setErro(`A senha precisa ter pelo menos ${MINIMO} caracteres.`);
    if (senha !== repetida) return setErro("As duas senhas não são iguais.");

    setSalvando(true);
    const { error } = await createClient().auth.updateUser({ password: senha });
    if (error) {
      setErro("Não foi possível trocar a senha. Peça um novo link e tente de novo.");
      setSalvando(false);
      return;
    }
    router.push(DESTINO_PADRAO);
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center text-center space-y-4">
          <Logo size="lg" />
          <h1 className="font-display text-2xl text-foreground font-bold">Nova senha</h1>
        </div>

        {temSessao === false ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              O link de redefinição não vale mais. Peça um novo na tela de entrada.
            </p>
            <Button onClick={() => router.push("/admin/login")} className="w-full h-12">
              Voltar para a entrada
            </Button>
          </div>
        ) : (
          <form onSubmit={salvar} className="space-y-5">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Nova senha</Label>
              <Input
                type="password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                autoComplete="new-password"
                required
                className={campo}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-[0.1em] text-muted-foreground">Repita a senha</Label>
              <Input
                type="password"
                value={repetida}
                onChange={(e) => setRepetida(e.target.value)}
                autoComplete="new-password"
                required
                className={campo}
              />
            </div>
            {erro && <p className="text-xs text-destructive">{erro}</p>}
            <Button
              type="submit"
              disabled={salvando || temSessao === null}
              className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 uppercase tracking-[0.08em] mt-2"
            >
              {salvando ? "Salvando..." : "Salvar nova senha"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
