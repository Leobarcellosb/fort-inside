import { createClient } from "@/lib/supabase/server";
import { AdminLogoutButton } from "@/components/features/admin/AdminLogoutButton";

// Admin group layout — mounts a floating logout button on every page
// within /admin/* when the user has an active session.
// Hidden on /admin/login (no session) so the login form renders clean.

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
      {session && <AdminLogoutButton />}
      {children}
    </>
  );
}
