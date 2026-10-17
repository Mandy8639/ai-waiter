/**
 * Where the middleware should send a request, given who is asking.
 *
 * Extracted from src/proxy.ts with no `server-only` import and no Supabase
 * dependency, so the routing rules can be unit-tested directly — the
 * middleware itself is only exercised by Playwright specs, which CI does
 * not run.
 */

import { TWO_FACTOR_PATH } from "@/lib/auth/two-factor-core";

export const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/account"];
export const AUTH_PAGES = ["/login", "/signup"];

export interface RouteVisitor {
  /** Null when nobody is signed in at all. */
  signedIn: boolean;
  /**
   * True for a Supabase Anonymous Auth identity — a diner who scanned a
   * table's QR code. Treated as "not really signed in" for routing.
   */
  isAnonymous: boolean;
  /**
   * The account has two-step verification on and this session hasn't
   * entered a code yet (see src/lib/auth/two-factor-core.ts).
   */
  twoFactorPending?: boolean;
}

export type RouteDecision =
  { type: "continue" } | { type: "redirect"; to: string; redirectTo?: string };

/**
 * The two audiences are separated by URL, not by identity: diners live
 * under /r/… and never sign in on purpose, while owners and staff arrive
 * at the site to reach /login, /signup and /dashboard.
 *
 * The anonymous check is what keeps those apart. A diner who scans a table
 * code gets a real Supabase Anonymous Auth user, and that identity does
 * not expire on its own — so on 2026-09-12, tapping "Sign in" on the
 * landing page sent them to /dashboard, which then said "Create your
 * restaurant", because the middleware saw *a* user and skipped the login
 * form as if they were staff.
 *
 * Anonymous identities therefore get no shortcut: they see the sign-in
 * form like a signed-out visitor, and signing in replaces the diner
 * identity with the real account. This mirrors the QR route handler, which
 * already refuses to overwrite a staff session with a diner one
 * (src/app/r/[restaurantSlug]/table/[token]/route.ts) — the same
 * distinction, in the other direction.
 *
 * Protected routes apply the same rule: a diner who types /dashboard or
 * /onboarding is sent to /login, exactly as a signed-out visitor is. That
 * matters beyond tidiness — the dashboard used to offer them "Create your
 * restaurant", and create_restaurant() would have accepted it, leaving a
 * restaurant owned by a guest session that nobody could ever sign in to
 * claim. The database now refuses that too
 * (20260912100000_restaurants_need_a_real_account.sql); this is the door,
 * that is the lock.
 */
export function decideRouteAccess(
  pathname: string,
  visitor: RouteVisitor,
): RouteDecision {
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
  // A diner's anonymous identity is not an operator's session, so the
  // owner-facing routes treat it exactly as signed-out.
  const isOperator = visitor.signedIn && !visitor.isAnonymous;

  const twoFactorPending = isOperator && visitor.twoFactorPending === true;

  // The code step: only for an operator who still owes it.
  if (pathname === TWO_FACTOR_PATH) {
    if (!isOperator) return { type: "redirect", to: "/login" };
    if (!twoFactorPending) return { type: "redirect", to: "/dashboard" };
    return { type: "continue" };
  }

  if (isProtected && !isOperator) {
    return { type: "redirect", to: "/login", redirectTo: pathname };
  }

  // A password alone isn't enough once two-step verification is on. The
  // database refuses such a session too (20261018090000_two_factor_login).
  if (isProtected && twoFactorPending) {
    return { type: "redirect", to: TWO_FACTOR_PATH };
  }

  if (AUTH_PAGES.includes(pathname) && isOperator) {
    return {
      type: "redirect",
      to: twoFactorPending ? TWO_FACTOR_PATH : "/dashboard",
    };
  }

  return { type: "continue" };
}
