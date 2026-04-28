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
          <div className="fixed top-4 left-4 z-30">
            <Logo size="sm" />
          </div>
          <AdminLogoutButton />
        </>
      )}
      {children}
    </>
  );
}
