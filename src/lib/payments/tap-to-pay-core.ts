/**
 * Tap to Pay in the staff app: the decisions that don't need Stripe or the
 * database, so they're unit-tested directly (no `server-only`).
 */

/** The address Stripe needs for a Terminal Location, or what's missing. */
export function terminalLocationAddress(r: {
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}):
  | {
      ok: true;
      address: {
        line1: string;
        city: string;
        state: string;
        postal_code: string;
        country: string;
      };
    }
  | { ok: false; missing: string[] } {
  const fields = {
    line1: r.address?.trim() ?? "",
    city: r.city?.trim() ?? "",
    state: r.state?.trim() ?? "",
    postal_code: r.postal_code?.trim() ?? "",
    country: r.country?.trim() ?? "",
  };
  const labels: Record<keyof typeof fields, string> = {
    line1: "street address",
    city: "city",
    state: "state",
    postal_code: "ZIP code",
    country: "country",
  };
  const missing = (Object.keys(fields) as (keyof typeof fields)[])
    .filter((k) => !fields[k])
    .map((k) => labels[k]);
  if (missing.length > 0) return { ok: false, missing };
  // Stripe wants an ISO 3166-1 alpha-2 country; the profile may say "USA".
  const country = /^(us|usa|united states( of america)?)$/i.test(fields.country)
    ? "US"
    : fields.country.toUpperCase();
  return { ok: true, address: { ...fields, country } };
}

/** What the staff app should do with a PaymentIntent's status. */
export type TapOutcome = "paid" | "waiting" | "failed";

export function tapOutcome(stripeStatus: string): TapOutcome {
  if (stripeStatus === "succeeded") return "paid";
  if (stripeStatus === "canceled") return "failed";
  // requires_payment_method after a decline, requires_confirmation /
  // processing while the tap is in flight: the same intent can be retried.
  return "waiting";
}

/** The app talks to a simulated reader with test keys, a real one with live keys. */
export function isTestModeKey(secretKey: string | undefined): boolean {
  return Boolean(
    secretKey?.startsWith("sk_test_") || secretKey?.startsWith("rk_test_"),
  );
}
