/**
 * Where a subscription's current period actually ends.
 *
 * Pure and free of `server-only` so it is directly testable — the same
 * extract-the-core convention as src/lib/payments/tip.ts.
 *
 * Stripe moved this. On API version 2026-08-26.dahlia a subscription has
 * no top-level `current_period_end`; the period lives on each subscription
 * ITEM. Reading only the old location does not fail — it yields
 * `undefined`, stores null, and produces a subscription with no renewal
 * date, which looks like missing data rather than a bug.
 *
 * Both locations are read, newest first, so this keeps working across the
 * version change in either direction rather than pinning to whichever
 * happens to be current.
 */

interface PeriodBearing {
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> };
}

/**
 * The period end as an ISO string, or null when genuinely absent — an
 * incomplete subscription has no period at all, and that is a real state
 * rather than a lookup failure.
 *
 * When several items disagree, the LATEST wins: it is the point at which
 * the restaurant has definitely paid up to, and understating that would
 * show someone as lapsed while they are still covered.
 */
export function resolvePeriodEnd(subscription: unknown): string | null {
  if (typeof subscription !== "object" || subscription === null) return null;
  const sub = subscription as PeriodBearing;

  const candidates: number[] = [];

  for (const item of sub.items?.data ?? []) {
    if (typeof item.current_period_end === "number") {
      candidates.push(item.current_period_end);
    }
  }

  // The pre-dahlia location, kept as a fallback rather than removed.
  if (typeof sub.current_period_end === "number") {
    candidates.push(sub.current_period_end);
  }

  if (candidates.length === 0) return null;

  const latest = Math.max(...candidates);
  // A non-finite or nonsensical timestamp would become "Invalid Date" and
  // throw on toISOString(); null is the honest answer.
  if (!Number.isFinite(latest) || latest <= 0) return null;

  return new Date(latest * 1000).toISOString();
}
