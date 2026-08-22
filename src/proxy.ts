import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Refreshes the Supabase auth session on every request (required for SSR —
 * without this, tokens read in Server Components can silently go stale
 * since Server Components can't write cookies themselves) and enforces
 * route protection at the edge, before any page renders.
 *
 * This is the server-side enforcement the dashboard layout also re-checks
 * (defense in depth, same reasoning as RLS being the final authority on
 * data access — this is the final authority on route access).
 *
 * Reads only NEXT_PUBLIC_* vars directly (not src/lib/env.ts), so this
 * never needs SUPABASE_SECRET_KEY to run.
 */
const PROTECTED_PREFIXES = ["/dashboard", "/onboarding"];
const AUTH_PAGES = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    // Misconfigured environment. Fail closed on protected routes rather
    // than letting them through because auth couldn't even be checked.
    if (
      PROTECTED_PREFIXES.some((prefix) =>
        request.nextUrl.pathname.startsWith(prefix),
      )
    ) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return supabaseResponse;
  }

  const supabase = createServerClient<Database>(
    supabaseUrl,
    supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() (not getSession()) revalidates against the Auth server rather
  // than trusting whatever's in the cookie as-is.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    !user
  ) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (AUTH_PAGES.includes(pathname) && user) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
