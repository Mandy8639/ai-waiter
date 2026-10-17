/**
 * Two-step verification (a 6-digit code from an authenticator app), the
 * rules shared by the proxy, the sign-in action and the pages. No
 * server-only import and no Supabase client, so it is unit-tested directly.
 *
 * Optional: anyone with an account can turn it on from /account. Once a
 * person has a verified factor, a session that has only passed the password
 * step (aal1) is sent to TWO_FACTOR_PATH before any operator page. The
 * database enforces the same rule (20261018090000_two_factor_login.sql).
 */

export const TWO_FACTOR_PATH = "/login/verify";

interface FactorLike {
  factor_type: string;
  status: string;
}

/** Whether the account has a finished (verified) authenticator-app setup. */
export function hasVerifiedTwoFactor(
  factors: readonly FactorLike[] | null | undefined,
): boolean {
  return (factors ?? []).some(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
}

/**
 * Whether this session still owes the code step: the account has a
 * verified factor and the session's assurance level isn't aal2 yet.
 */
export function isTwoFactorPending(
  factors: readonly FactorLike[] | null | undefined,
  currentLevel: string | null | undefined,
): boolean {
  return hasVerifiedTwoFactor(factors) && currentLevel !== "aal2";
}

/**
 * The 6 digits from what was typed, or null. People paste codes with a
 * space in the middle ("123 456"), as most authenticator apps display them.
 */
export function normalizeTwoFactorCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** The secret in groups of four, easier to read and type by hand. */
export function formatSetupKey(secret: string): string {
  return (
    secret
      .replace(/\s/g, "")
      .match(/.{1,4}/g)
      ?.join(" ") ?? ""
  );
}
