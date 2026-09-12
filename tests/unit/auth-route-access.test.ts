import { describe, expect, it } from "vitest";
import {
  AUTH_PAGES,
  PROTECTED_PREFIXES,
  decideRouteAccess,
} from "@/lib/auth/route-access";

/**
 * On 2026-09-12, tapping "Sign in" on the landing page sent a diner to
 * /dashboard, which answered "Create your restaurant".
 *
 * A diner who scans a table's QR code is signed in as a real Supabase
 * Anonymous Auth user, and that identity does not expire on its own. The
 * middleware saw *a* user on /login and skipped the form as if they were
 * staff. The two audiences are separated by URL, not identity: diners live
 * under /r/… and never sign in on purpose.
 *
 * The middleware has no other automated coverage — the Playwright specs
 * that touch it are deliberately not run by CI.
 */

const diner = { signedIn: true, isAnonymous: true };
const owner = { signedIn: true, isAnonymous: false };
const visitor = { signedIn: false, isAnonymous: false };

describe("decideRouteAccess", () => {
  describe("a diner carrying an anonymous session", () => {
    it.each(AUTH_PAGES)("sees the real form at %s", (page) => {
      expect(decideRouteAccess(page, diner)).toEqual({ type: "continue" });
    });

    it("is never sent to the dashboard from the landing page's Sign in link", () => {
      const decision = decideRouteAccess("/login", diner);
      expect(decision).not.toMatchObject({ to: "/dashboard" });
    });

    it("is left alone on the diner's own routes", () => {
      expect(decideRouteAccess("/r/my-restaurant/menu", diner)).toEqual({
        type: "continue",
      });
      expect(decideRouteAccess("/", diner)).toEqual({ type: "continue" });
    });
  });

  describe("a signed-in owner or staff member", () => {
    it.each(AUTH_PAGES)("skips %s and goes to the dashboard", (page) => {
      expect(decideRouteAccess(page, owner)).toEqual({
        type: "redirect",
        to: "/dashboard",
      });
    });

    it.each(PROTECTED_PREFIXES)("reaches %s", (prefix) => {
      expect(decideRouteAccess(prefix, owner)).toEqual({ type: "continue" });
    });
  });

  describe("a signed-out visitor", () => {
    it.each(AUTH_PAGES)("sees %s", (page) => {
      expect(decideRouteAccess(page, visitor)).toEqual({ type: "continue" });
    });

    it.each(PROTECTED_PREFIXES)(
      "is sent to sign in from %s, keeping where they were headed",
      (prefix) => {
        expect(decideRouteAccess(prefix, visitor)).toEqual({
          type: "redirect",
          to: "/login",
          redirectTo: prefix,
        });
      },
    );

    it("keeps the full path, not just the prefix", () => {
      expect(decideRouteAccess("/dashboard/kitchen", visitor)).toEqual({
        type: "redirect",
        to: "/login",
        redirectTo: "/dashboard/kitchen",
      });
    });

    it("leaves the landing page and the diner flow alone", () => {
      expect(decideRouteAccess("/", visitor)).toEqual({ type: "continue" });
      expect(decideRouteAccess("/r/my-restaurant/menu", visitor)).toEqual({
        type: "continue",
      });
    });
  });

  describe("the owner-facing routes are closed to a diner", () => {
    it.each(PROTECTED_PREFIXES)(
      "sends a diner at %s to sign in, like a signed-out visitor",
      (prefix) => {
        expect(decideRouteAccess(prefix, diner)).toEqual({
          type: "redirect",
          to: "/login",
          redirectTo: prefix,
        });
      },
    );

    it("keeps a diner out of /onboarding specifically", () => {
      // The route that mattered: the dashboard offered "Create your
      // restaurant", and create_restaurant() would have accepted a guest
      // session, leaving a restaurant nobody could sign in to claim.
      expect(decideRouteAccess("/onboarding", diner)).toEqual({
        type: "redirect",
        to: "/login",
        redirectTo: "/onboarding",
      });
    });
  });
});
