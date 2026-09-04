/**
 * Pure helpers for reasoning about which Stripe *mode* (live or test) a key
 * and a stored object id belong to. Deliberately free of `import
 * "server-only"` and of any Stripe client construction so it's directly
 * unit-testable — same split as src/lib/observability/sourcemap-upload.ts,
 * whose thin script wrapper lives in scripts/.
 *
 * Why this exists: Stripe ids are mode-scoped. A `price_...`, `acct_...`,
 * `cus_...` or `sub_...` created in test mode does not exist in live mode,
 * and this application stores all four in Postgres. Switching keys without
 * resetting those rows leaves a database full of ids the live account has
 * never heard of, and the failures arrive one at a time while a real
 * customer waits. See scripts/check-stripe-mode.ts and
 * docs/security.md#payments.
 */

export type StripeMode = "live" | "test" | "unknown";

/**
 * Both `sk_` (secret) and `rk_` (restricted) keys carry the mode in their
 * prefix. Anything else is reported as unknown rather than guessed at — a
 * wrong guess here would tell an operator they're in test mode while real
 * money moves.
 */
export function stripeKeyMode(secretKey: string): StripeMode {
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) {
    return "live";
  }
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) {
    return "test";
  }
  return "unknown";
}

/**
 * True when an error means "this id isn't usable with the current key",
 * which is what a cross-mode id looks like.
 *
 * Two distinct shapes, both verified against the real API rather than
 * assumed:
 *   - v1 resources (prices, subscriptions) -> 404 `resource_missing`
 *   - v2 core accounts -> **403 `forbidden`**, not a 404
 *
 * That second case is the important one: the Connect account is the row
 * most likely to be stale at cutover, and treating its 403 as a hard error
 * would have reported the single most consequential mismatch as a script
 * bug instead of as the finding it is.
 *
 * A 403 can also mean a genuinely under-permissioned restricted key, which
 * is why the caller's wording says "does not exist or is not accessible in
 * this mode" rather than asserting the object is absent. The remedy is the
 * same either way: this key cannot use this id.
 */
export function isUnusableWithThisKey(error: unknown): boolean {
  const candidate = error as
    { code?: string; statusCode?: number; type?: string } | null | undefined;
  if (!candidate) return false;
  if (candidate.code === "resource_missing" || candidate.code === "forbidden") {
    return true;
  }
  return candidate.statusCode === 404 || candidate.statusCode === 403;
}
