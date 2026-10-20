import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PublicPlan } from "@/lib/admin/plan-admin-core";

/**
 * What the landing page and the dashboard's reminders say Tableside costs,
 * read from the plans and the free month as set on /admin (Phase 8), so a
 * price change there shows everywhere. A price list is public, but the
 * free month's setting is in a server-only table, hence the service role.
 * A failed read returns the prices as they were when this was written,
 * rather than an empty pricing section.
 */

export interface PublicPricing {
  plans: PublicPlan[];
  freeMonthDays: number;
}

const FALLBACK: PublicPricing = {
  plans: [
    {
      slug: "starter",
      name: "Starter",
      monthlyPriceCents: 1900,
      currency: "USD",
      feeBps: 100,
    },
    {
      slug: "standard",
      name: "Standard",
      monthlyPriceCents: 4900,
      currency: "USD",
      feeBps: 50,
    },
    {
      slug: "pro",
      name: "Pro",
      monthlyPriceCents: 14900,
      currency: "USD",
      feeBps: 25,
    },
  ],
  freeMonthDays: 30,
};

type Rows = Promise<{ data: unknown[] | null; error: unknown }>;
type Store = {
  from: (t: string) => {
    select: (c: string) => Rows & {
      order: (c: string, o: { ascending: boolean }) => Rows;
    };
  };
};

// Kept for a minute per server instance: every dashboard page reads it for
// the free-month banner, and prices change rarely.
const CACHE_MS = 60_000;
let cache: { at: number; value: PublicPricing } | null = null;

export async function getPublicPricing(): Promise<PublicPricing> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await readPricing();
  cache = { at: Date.now(), value };
  return value;
}

async function readPricing(): Promise<PublicPricing> {
  if (!process.env.SUPABASE_SECRET_KEY) return FALLBACK;
  try {
    const store = createAdminClient() as unknown as Store;
    const [plans, settings] = await Promise.all([
      store
        .from("platform_plans")
        .select("slug, name, monthly_price_cents, currency, fee_bps")
        .order("monthly_price_cents", { ascending: true }),
      store.from("platform_billing_settings").select("free_month_days"),
    ]);
    if (plans.error || !plans.data?.length) return FALLBACK;
    return {
      plans: (
        plans.data as Array<{
          slug: string;
          name: string;
          monthly_price_cents: number;
          currency: string;
          fee_bps: number;
        }>
      ).map((p) => ({
        slug: p.slug,
        name: p.name,
        monthlyPriceCents: p.monthly_price_cents,
        currency: p.currency,
        feeBps: p.fee_bps,
      })),
      freeMonthDays:
        ((settings.data ?? [])[0] as { free_month_days?: number } | undefined)
          ?.free_month_days ?? FALLBACK.freeMonthDays,
    };
  } catch {
    return FALLBACK;
  }
}
