"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStripeConfigured } from "@/lib/payments/stripe";
import { stripeKeyMode } from "@/lib/payments/stripe-mode";
import { reportError } from "@/lib/observability/report";
import { platformAdminForAction } from "./access";
import {
  FEE_BPS_MAX,
  PRICE_CENTS_MAX,
  priceChangesAllowed,
  validFreeMonthDays,
} from "./plan-admin-core";
import { createPlanPrice } from "./plan-stripe";

/**
 * Admin Phase 8 (docs/admin.md): a plan's monthly price or card fee, and
 * the free month's length. Prices go through Stripe (a new price; existing
 * subscribers keep theirs) and are locked on live Stripe until
 * ADMIN_LIVE_PRICE_CHANGES=1. Every change is recorded.
 */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

type Result = { ok: true; message: string } | { ok: false; error: string };

type Store = {
  from: (t: "platform_plans") => {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
  rpc: (
    fn: "admin_update_plan" | "admin_set_free_month",
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
};

interface PlanRow {
  id: string;
  slug: string;
  name: string;
  currency: string;
  monthly_price_cents: number;
  stripe_price_id: string | null;
}

async function loadPlan(store: Store, planId: string): Promise<PlanRow | null> {
  const { data } = await store
    .from("platform_plans")
    .select("id, slug, name, currency, monthly_price_cents, stripe_price_id")
    .eq("id", planId)
    .maybeSingle();
  return (data as PlanRow | null) ?? null;
}

function refresh() {
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath("/dashboard/payments");
}

export async function changePlanPrice(
  planId: string,
  monthlyPriceCents: number,
): Promise<Result> {
  if (
    !z.uuid().safeParse(planId).success ||
    !Number.isInteger(monthlyPriceCents) ||
    monthlyPriceCents < 0 ||
    monthlyPriceCents > PRICE_CENTS_MAX
  ) {
    return { ok: false, error: "That price isn't valid." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const store = createAdminClient() as unknown as Store;
  const plan = await loadPlan(store, planId);
  if (!plan) return { ok: false, error: "That plan wasn't found." };
  if (plan.monthly_price_cents === monthlyPriceCents) {
    return { ok: false, error: "That's already the price." };
  }

  let stripePriceId: string | null = null;
  if (monthlyPriceCents > 0) {
    const key = process.env.STRIPE_SECRET_KEY;
    const allowed = priceChangesAllowed(
      isStripeConfigured() && key ? stripeKeyMode(key) : "unknown",
      process.env.ADMIN_LIVE_PRICE_CHANGES,
    );
    if (!allowed.ok) return { ok: false, error: allowed.reason };
    try {
      stripePriceId = await createPlanPrice({
        slug: plan.slug,
        name: plan.name,
        currency: plan.currency,
        monthlyPriceCents,
        currentPriceId: plan.stripe_price_id,
      });
    } catch (error) {
      reportError(error, {
        scope: "admin.plan_price.stripe",
        extra: { planId },
      });
      return {
        ok: false,
        error: "Stripe didn't accept the new price, so nothing was changed.",
      };
    }
  }

  const { error } = await store.rpc("admin_update_plan", {
    p_plan_id: planId,
    p_monthly_price_cents: monthlyPriceCents,
    p_stripe_price_id: stripePriceId,
    p_fee_bps: null,
    p_user: user.id,
  });
  if (error) {
    // The Stripe price exists but isn't used by anything: harmless, and
    // logged so it can be archived.
    reportError(error, {
      scope: "admin.plan_price.save",
      extra: { planId, stripePriceId },
    });
    return { ok: false, error: "Couldn't save. Please try again." };
  }
  console.info(
    JSON.stringify({
      event: "admin_plan_price_changed",
      planId,
      monthlyPriceCents,
      stripePriceId,
      by: user.id,
    }),
  );
  refresh();
  return {
    ok: true,
    message:
      "Saved. New subscribers pay the new price; existing ones keep the price they signed up to.",
  };
}

export async function changePlanFee(
  planId: string,
  feeBps: number,
): Promise<Result> {
  if (
    !z.uuid().safeParse(planId).success ||
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > FEE_BPS_MAX
  ) {
    return { ok: false, error: "That fee isn't valid." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const store = createAdminClient() as unknown as Store;
  const { error } = await store.rpc("admin_update_plan", {
    p_plan_id: planId,
    p_monthly_price_cents: null,
    p_stripe_price_id: null,
    p_fee_bps: feeBps,
    p_user: user.id,
  });
  if (error) {
    return {
      ok: false,
      error: error.message.includes("PLAN_NOT_FOUND")
        ? "That plan wasn't found."
        : "Couldn't save. Please try again.",
    };
  }
  console.info(
    JSON.stringify({
      event: "admin_plan_fee_changed",
      planId,
      feeBps,
      by: user.id,
    }),
  );
  refresh();
  return {
    ok: true,
    message:
      "Saved. Every restaurant on this plan pays the new fee from its next card payment.",
  };
}

export async function changeFreeMonth(days: number): Promise<Result> {
  if (!validFreeMonthDays(days)) {
    return { ok: false, error: "Choose 0 to 90 days." };
  }
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const store = createAdminClient() as unknown as Store;
  const { error } = await store.rpc("admin_set_free_month", {
    p_days: days,
    p_user: user.id,
  });
  if (error) return { ok: false, error: "Couldn't save. Please try again." };
  console.info(
    JSON.stringify({ event: "admin_free_month_changed", days, by: user.id }),
  );
  refresh();
  return {
    ok: true,
    message:
      "Saved. Restaurants that sign up from now get this free month; existing ones keep theirs.",
  };
}
