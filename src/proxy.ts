import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/supabase/database.types";
import { decideRouteAccess, PROTECTED_PREFIXES } from "@/lib/auth/route-access";
import { PATHNAME_HEADER } from "@/lib/dashboard/access-core";
import {
  hasVerifiedTwoFactor,
  isTwoFactorPending,
} from "@/lib/auth/two-factor-core";
import {
  APP_SHELL_COOKIE,
  APP_SHELL_QUERY,
  appShellFrom,
  appShellRedirect,
  parseAppShell,
} from "@/lib/app-shell/core";

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
  // App mode (src/lib/app-shell/core.ts): the store apps open their start
  // URL with ?app=android|ios. Remembered in a cookie on every response
  // from that request, so the pages after it know they're in an app too.
  const announcedShell = parseAppShell(
    request.nextUrl.searchParams.get(APP_SHELL_QUERY),
  );
  const shell = appShellFrom({
    query: announcedShell,
    cookie: request.cookies.get(APP_SHELL_COOKIE)?.value,
    userAgent: request.headers.get("user-agent"),
  });
  const remember = (response: NextResponse) => {
    if (announcedShell) {
      response.cookies.set(APP_SHELL_COOKIE, announcedShell, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
      });
    }
    return response;
  };

  const appRedirect = appShellRedirect(request.nextUrl.pathname, shell);
  if (appRedirect) {
    return remember(NextResponse.redirect(new URL(appRedirect, request.url)));
  }

  // The path being rendered, for the dashboard's per-role page rule
  // (src/lib/dashboard/access-core.ts): a page can't otherwise know its
  // own URL on the server. Always overwritten, so a client can't send it.
  // Rebuilt on every call so cookies refreshed below are carried along.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set(PATHNAME_HEADER, request.nextUrl.pathname);
    return NextResponse.next({ request: { headers } });
  };

  let supabaseResponse = forward();

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
      return remember(NextResponse.redirect(new URL("/login", request.url)));
    }
    return remember(supabaseResponse);
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
          supabaseResponse = forward();
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

  // Two-step verification: the factors come from the user getUser() just
  // fetched, not the cookie's copy, so a setup finished on another device
  // counts at once. The session's level is read only when it matters.
  let twoFactorPending = false;
  if (
    user &&
    user.is_anonymous !== true &&
    hasVerifiedTwoFactor(user.factors)
  ) {
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    twoFactorPending = isTwoFactorPending(user.factors, aal?.currentLevel);
  }

  const decision = decideRouteAccess(request.nextUrl.pathname, {
    signedIn: Boolean(user),
    // `is_anonymous` is optional in the SDK's type, so anything not
    // explicitly anonymous counts as a real account — the same
    // conservative reading the QR route handler uses.
    isAnonymous: user?.is_anonymous === true,
    twoFactorPending,
  });

  if (decision.type === "redirect") {
    const redirectUrl = new URL(decision.to, request.url);
    if (decision.redirectTo) {
      redirectUrl.searchParams.set("redirectTo", decision.redirectTo);
    }
    return remember(NextResponse.redirect(redirectUrl));
  }

  return remember(supabaseResponse);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
