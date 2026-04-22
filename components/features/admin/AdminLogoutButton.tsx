"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

export function AdminLogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/logout", { method: "POST" });
      if (!res.ok) throw new Error("Falha ao sair");
      router.push("/admin/login");
      router.refresh();
    } catch {
      toast.error("Erro ao sair. Tente novamente.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed top-4 right-4 z-40">
      <button
        type="button"
        onClick={handleLogout}
        disabled={loading}
        aria-label="Sair"
        className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-background/70 border border-border text-muted-foreground text-xs uppercase tracking-[0.12em] backdrop-blur-md hover:text-destructive/80 hover:border-destructive/40 transition-all shadow-lg disabled:opacity-50"
      >
        <LogOut className="w-4 h-4" />
        <span className="hidden sm:inline">{loading ? "Saindo..." : "Sair"}</span>
      </button>
    </div>
  );
}
