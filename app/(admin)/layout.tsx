import { createClient } from "@/lib/supabase/server";
import { AdminLogoutButton } from "@/components/features/admin/AdminLogoutButton";
import { Logo } from "@/components/ui/Logo";

// Admin group layout — Yuri Fortes brand logo top-left + floating logout button
// top-right when authenticated. Hidden on /admin/login (no session).

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return (
    <>
      {session && (
        <>
          <header className="fixed top-0 inset-x-0 h-14 bg-background border-b border-border z-30 flex items-center px-4 lg:px-8">
            <Logo size="sm" />
          </header>
          <AdminLogoutButton />
        </>
      )}
      <div className={session ? "pt-14" : ""}>{children}</div>
    </>
  );
}
