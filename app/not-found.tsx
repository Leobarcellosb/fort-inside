import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="text-center space-y-4 max-w-sm">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">404</p>
        <h1 className="font-display text-2xl text-foreground">Página não encontrada</h1>
        <p className="text-muted-foreground text-sm">
          Este link pode estar incorreto ou ter expirado.
        </p>
        <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
          <Link href="/">Voltar ao início</Link>
        </Button>
      </div>
    </main>
  );
}
