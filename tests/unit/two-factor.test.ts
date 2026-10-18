import { describe, expect, it } from "vitest";
import { decideRouteAccess } from "@/lib/auth/route-access";
import {
  formatSetupKey,
  hasVerifiedTwoFactor,
  isTwoFactorPending,
  normalizeTwoFactorCode,
  TWO_FACTOR_PATH,
} from "@/lib/auth/two-factor-core";

/**
 * Two-step verification, the app half: who is sent to the code step and
 * who is let through. The database half is
 * tests/integration/db/two-factor-login.test.ts.
 */

const verified = { factor_type: "totp", status: "verified" };
const unverified = { factor_type: "totp", status: "unverified" };

describe("hasVerifiedTwoFactor / isTwoFactorPending", () => {
  it("counts only a finished authenticator setup", () => {
    expect(hasVerifiedTwoFactor([verified])).toBe(true);
    expect(hasVerifiedTwoFactor([unverified])).toBe(false);
    expect(
      hasVerifiedTwoFactor([{ factor_type: "phone", status: "verified" }]),
    ).toBe(false);
    expect(hasVerifiedTwoFactor(undefined)).toBe(false);
    expect(hasVerifiedTwoFactor([])).toBe(false);
  });

  it("is pending until the session reaches aal2", () => {
    expect(isTwoFactorPending([verified], "aal1")).toBe(true);
    expect(isTwoFactorPending([verified], null)).toBe(true);
    expect(isTwoFactorPending([verified], "aal2")).toBe(false);
    expect(isTwoFactorPending([unverified], "aal1")).toBe(false);
    expect(isTwoFactorPending(undefined, "aal1")).toBe(false);
  });
});

describe("normalizeTwoFactorCode", () => {
  it("takes 6 digits, with the space or dash apps show", () => {
    expect(normalizeTwoFactorCode("123456")).toBe("123456");
    expect(normalizeTwoFactorCode("123 456")).toBe("123456");
    expect(normalizeTwoFactorCode(" 123-456 ")).toBe("123456");
    expect(normalizeTwoFactorCode("012345")).toBe("012345");
  });

  it("refuses anything else", () => {
    for (const input of ["12345", "1234567", "12a456", "", null, 123456]) {
      expect(normalizeTwoFactorCode(input), String(input)).toBeNull();
    }
  });
});

describe("formatSetupKey", () => {
  it("groups the key in fours", () => {
    expect(formatSetupKey("ABCDEFGHIJKLMN")).toBe("ABCD EFGH IJKL MN");
  });
});

describe("routing with two-step verification", () => {
  const owner = { signedIn: true, isAnonymous: false };
  const pending = { ...owner, twoFactorPending: true };

  it("sends a session that owes a code to the code step from every operator page", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/orders",
      "/onboarding",
      "/account",
    ]) {
      expect(decideRouteAccess(path, pending), path).toEqual({
        type: "redirect",
        to: TWO_FACTOR_PATH,
        redirectTo: path,
      });
    }
  });

  it("sends it from the sign-in pages to the code step, not the dashboard", () => {
    expect(decideRouteAccess("/login", pending)).toEqual({
      type: "redirect",
      to: TWO_FACTOR_PATH,
    });
  });

  it("shows the code step only to someone who owes a code", () => {
    expect(decideRouteAccess(TWO_FACTOR_PATH, pending)).toEqual({
      type: "continue",
    });
    expect(decideRouteAccess(TWO_FACTOR_PATH, owner)).toEqual({
      type: "redirect",
      to: "/dashboard",
    });
    expect(
      decideRouteAccess(TWO_FACTOR_PATH, {
        signedIn: false,
        isAnonymous: false,
      }),
    ).toEqual({ type: "redirect", to: "/login" });
    // A diner's anonymous identity is not an account with a code to enter.
    expect(
      decideRouteAccess(TWO_FACTOR_PATH, {
        signedIn: true,
        isAnonymous: true,
        twoFactorPending: true,
      }),
    ).toEqual({ type: "redirect", to: "/login" });
  });

  it("changes nothing for accounts without it, or diner pages", () => {
    expect(decideRouteAccess("/dashboard", owner)).toEqual({
      type: "continue",
    });
    expect(decideRouteAccess("/r/some-place/menu", pending)).toEqual({
      type: "continue",
    });
  });
});
