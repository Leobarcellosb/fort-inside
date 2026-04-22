import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/admin/logout
// Signs the admin out via @supabase/ssr. signOut() writes empty tokens via the
// cookie adapter, clearing sb-<ref>-auth-token cookies on the response.

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ success: true });
}
