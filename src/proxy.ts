import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/supabase/database.types";
import { decideRouteAccess, PROTECTED_PREFIXES } from "@/lib/auth/route-access";

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

  const decision = decideRouteAccess(request.nextUrl.pathname, {
    signedIn: Boolean(user),
    // `is_anonymous` is optional in the SDK's type, so anything not
    // explicitly anonymous counts as a real account — the same
    // conservative reading the QR route handler uses.
    isAnonymous: user?.is_anonymous === true,
  });

  if (decision.type === "redirect") {
    const redirectUrl = new URL(decision.to, request.url);
    if (decision.redirectTo) {
      redirectUrl.searchParams.set("redirectTo", decision.redirectTo);
    }
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
