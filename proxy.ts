import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect admin routes (not login)
  if (!pathname.startsWith("/admin") || pathname.startsWith("/admin/login")) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Being signed in is NOT enough: every participant gets a Supabase session
  // when they join an event, so a bare `!user` check let them reach /admin/*
  // — including /admin/nps, which reads with service_role and bypasses RLS.
  // Require the same claim the is_admin() RLS helper checks.
  const isAdmin = user?.app_metadata?.role === "admin";

  if (!isAdmin) {
    const loginUrl = new URL("/admin/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    // Propagate cookies set/cleared by Supabase during the session refresh attempt.
    // Without this, a failed refresh leaves stale tokens in the browser and can
    // trigger a login <-> admin redirect loop.
    response.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  return response;
}

export const proxyConfig = {
  matcher: ["/admin/:path*"],
};
