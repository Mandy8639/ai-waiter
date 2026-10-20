import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStripeConfigured } from "@/lib/payments/stripe";
import { stripeKeyMode, type StripeMode } from "@/lib/payments/stripe-mode";

/** Admin Phase 8 reads: plans with their subscribers, the free month, and the change history. */

export interface AdminPlan {
  id: string;
  slug: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  feeBps: number;
  stripePriceId: string | null;
  isDefault: boolean;
  /** Subscriptions Stripe is billing for this plan right now. */
  subscribers: number;
}

export interface PlanHistoryRow {
  planName: string | null;
  change: "monthly_price" | "fee" | "free_month";
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
}

export interface PlansAdminData {
  plans: AdminPlan[];
  freeMonthDays: number;
  history: PlanHistoryRow[];
  stripeMode: StripeMode | "none";
  liveApproved: boolean;
}

type Rows = Promise<{ data: unknown[] | null; error: unknown }>;
type Store = {
  from: (t: string) => {
    select: (c: string) => Rows & {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => Rows & {
        limit: (n: number) => Rows;
      };
      in: (c: string, v: string[]) => Rows;
    };
  };
};

export async function getPlansForAdmin(): Promise<PlansAdminData | null> {
  try {
    const store = createAdminClient() as unknown as Store;
    const [plans, settings, history, subs] = await Promise.all([
      store
        .from("platform_plans")
        .select(
          "id, slug, name, monthly_price_cents, currency, fee_bps, stripe_price_id, is_default",
        )
        .order("monthly_price_cents", { ascending: true }),
      store.from("platform_billing_settings").select("free_month_days"),
      store
        .from("platform_plan_history")
        .select("plan_id, change, old_value, new_value, changed_at")
        .order("changed_at", { ascending: false })
        .limit(20),
      store
        .from("restaurant_subscriptions")
        .select("plan_id, status")
        .in("status", ["trialing", "active", "past_due"]),
    ]);
    if (plans.error) return null;
    const subscribers = new Map<string, number>();
    for (const s of (subs.data ?? []) as { plan_id: string }[]) {
      subscribers.set(s.plan_id, (subscribers.get(s.plan_id) ?? 0) + 1);
    }
    const planRows = (
      plans.data as Array<{
        id: string;
        slug: string;
        name: string;
        monthly_price_cents: number;
        currency: string;
        fee_bps: number;
        stripe_price_id: string | null;
        is_default: boolean;
      }>
    ).map((p): AdminPlan => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      monthlyPriceCents: p.monthly_price_cents,
      currency: p.currency,
      feeBps: p.fee_bps,
      stripePriceId: p.stripe_price_id,
      isDefault: p.is_default,
      subscribers: subscribers.get(p.id) ?? 0,
    }));
    const names = new Map(planRows.map((p) => [p.id, p.name]));
    const key = process.env.STRIPE_SECRET_KEY;
    return {
      plans: planRows,
      freeMonthDays:
        ((settings.data ?? [])[0] as { free_month_days?: number } | undefined)
          ?.free_month_days ?? 30,
      history: (
        (history.data ?? []) as Array<{
          plan_id: string | null;
          change: PlanHistoryRow["change"];
          old_value: string | null;
          new_value: string | null;
          changed_at: string;
        }>
      ).map((h) => ({
        planName: h.plan_id ? (names.get(h.plan_id) ?? null) : null,
        change: h.change,
        oldValue: h.old_value,
        newValue: h.new_value,
        changedAt: h.changed_at,
      })),
      stripeMode: isStripeConfigured() && key ? stripeKeyMode(key) : "none",
      liveApproved: process.env.ADMIN_LIVE_PRICE_CHANGES === "1",
    };
  } catch {
    return null;
  }
}
