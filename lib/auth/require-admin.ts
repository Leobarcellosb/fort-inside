import { createClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

// Single source of truth for "is this request an admin?".
// Mirrors the claim shape checked by is_admin() in the RLS policies
// (app_metadata.role === 'admin') and by proxy.ts.
export async function getAdminUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.app_metadata?.role !== "admin") return null;
  return user;
}

export function isAdminUser(user: { app_metadata?: { role?: string } } | null): boolean {
  return user?.app_metadata?.role === "admin";
}
