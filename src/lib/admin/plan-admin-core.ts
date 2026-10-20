import type { StripeMode } from "@/lib/payments/stripe-mode";

/**
 * Admin Phase 8 (docs/admin.md): the rules for changing plan prices, card
 * fees and the free month, with no I/O. No `server-only`: unit-tested.
 */

/** The same bounds the database enforces (platform_plans, platform_billing_settings). */
export const PRICE_CENTS_MAX = 100_000; // $1,000 a month
export const FEE_BPS_MAX = 1_000; // 10%
export const FREE_MONTH_DAYS_MAX = 90;

/** "$49.00" → 4900; "49" → 4900; "" or nonsense → null. Whole cents only. */
export function parseDollars(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents >= 0 && cents <= PRICE_CENTS_MAX ? cents : null;
}

/** "1" → 100; "0.5%" → 50; "0.25" → 25. Whole basis points only. */
export function parsePercent(input: string): number | null {
  const s = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 0 && bps <= FEE_BPS_MAX ? bps : null;
}

export function validFreeMonthDays(days: number): boolean {
  return Number.isInteger(days) && days >= 0 && days <= FREE_MONTH_DAYS_MAX;
}

/**
 * Whether /admin may create a Stripe price on this key. Test mode always;
 * live mode only once the owner has approved it by setting
 * ADMIN_LIVE_PRICE_CHANGES=1 in Vercel, after trying it in test mode.
 * An unknown key never.
 */
export function priceChangesAllowed(
  mode: StripeMode,
  liveApproved: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "test") return { ok: true };
  if (mode === "live" && liveApproved === "1") return { ok: true };
  if (mode === "live") {
    return {
      ok: false,
      reason:
        "Price changes on live Stripe are locked. Try one in Stripe test mode first; to unlock live, set ADMIN_LIVE_PRICE_CHANGES=1 in Vercel.",
    };
  }
  return {
    ok: false,
    reason: "Stripe isn't set up here, so prices can't be changed.",
  };
}

/** What the free-month and plan reminders say about Starter, from the real plan. */
export function starterTermsLine(plan: {
  monthlyPriceCents: number;
  feeBps: number;
  currency: string;
}): string {
  const fee = `${Number((plan.feeBps / 100).toFixed(2))}%`;
  if (plan.monthlyPriceCents === 0) {
    return `Starter is free, plus ${fee} of card payments.`;
  }
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: plan.currency,
    minimumFractionDigits: plan.monthlyPriceCents % 100 === 0 ? 0 : 2,
  }).format(plan.monthlyPriceCents / 100);
  return `Starter is ${price}/month plus ${fee} of card payments.`;
}

export interface PublicPlan {
  slug: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  feeBps: number;
}

/** "Your first month is free" for 30 days, "Your first 14 days are free" otherwise; null for none. */
export function freePeriodPhrase(days: number): string | null {
  if (days <= 0) return null;
  if (days === 30) return "Your first month is free";
  return `Your first ${days} ${days === 1 ? "day is" : "days are"} free`;
}

/**
 * The note under each plan on the landing page. A plan with a higher price
 * and a lower fee than the one before it pays off past some card volume,
 * worked out from the real numbers so it stays true when prices change.
 */
export function planNote(plans: readonly PublicPlan[], index: number): string {
  const plan = plans[index];
  const prev = plans[index - 1];
  if (!prev) return "Everything included. Cash payments are never charged.";
  const extraMonthly = plan.monthlyPriceCents - prev.monthlyPriceCents;
  const feeSaved = prev.feeBps - plan.feeBps;
  if (extraMonthly > 0 && feeSaved > 0) {
    // Card volume (in dollars) where the fee saved covers the extra monthly price.
    const breakEven = Math.round(extraMonthly / feeSaved) * 100;
    const rounded =
      breakEven >= 1000 ? Math.round(breakEven / 500) * 500 : breakEven;
    return `Cheaper than ${prev.name} once card payments pass roughly $${rounded.toLocaleString("en-US")} a month.`;
  }
  return "Everything included.";
}
