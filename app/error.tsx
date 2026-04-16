"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="text-center space-y-4 max-w-sm">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Algo deu errado</p>
        <h1 className="font-display text-2xl text-foreground">Erro inesperado</h1>
        <p className="text-muted-foreground text-sm">
          {error.message || "Ocorreu um erro. Tente novamente."}
        </p>
        <Button
          onClick={reset}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Tentar novamente
        </Button>
      </div>
    </main>
  );
}
