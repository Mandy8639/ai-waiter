"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRestaurantSubscription } from "./subscription";
import { cancelControlsFor } from "./subscription-cancel-core";
import { resolvePeriodEnd } from "./subscription-period";
import { headers } from "next/headers";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { getStripe, isStripeConfigured } from "@/lib/payments/stripe";
import { reportError } from "@/lib/observability/report";
import { canSellPlans } from "@/lib/app-shell/core";
import { getAppShell } from "@/lib/app-shell/server";
import { getRestaurantBilling } from "@/lib/billing/trial-queries";
import { stripeTrialEnd } from "@/lib/billing/trial-core";

/**
 * Subscribing a restaurant to a paid plan.
 *
 * The opposite direction to every other charge in this app. Order
 * payments are DIRECT charges on the restaurant's connected account — the
 * diner pays the restaurant — so they pass `stripeAccount`. Here the
 * restaurant pays the platform, so there is deliberately no
 * `stripeAccount` option: the customer and subscription belong to the
 * platform account. Passing one would put the platform's own revenue on
 * the restaurant's books.
 */

export interface SubscribeState {
  error?: string;
}

export async function startSubscriptionCheckout(
  restaurantId: string,
  planSlug: string,
  _prevState: SubscribeState,
  _formData: FormData,
): Promise<SubscribeState> {
  // Owner and manager only. Committing a restaurant to a recurring bill is
  // a commercial decision, not day-to-day floor work — the same boundary
  // the Payments settings page draws.
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  // The store apps never show this button (src/lib/app-shell/core.ts);
  // refuse there too rather than open a Stripe checkout inside an app.
  if (!canSellPlans(await getAppShell())) {
    return { error: "Plans can't be changed in this app." };
  }

  if (!isStripeConfigured()) {
    return { error: "Stripe isn't configured, so plans can't be changed yet." };
  }

  const { data: plan } = await auth.context.supabase
    .from("platform_plans")
    .select("id, slug, name, stripe_price_id, monthly_price_cents")
    .eq("slug", planSlug)
    .maybeSingle();

  if (!plan) return { error: "That plan doesn't exist." };

  if (plan.monthly_price_cents === 0) {
    return {
      error: "That plan is free — there's nothing to subscribe to.",
    };
  }

  // The check the database deliberately does not make: a paid plan has no
  // price id until scripts/setup-stripe-prices.ts has run, and opening a
  // checkout without one fails inside Stripe with a message meant for a
  // developer rather than for the person clicking Subscribe.
  if (!plan.stripe_price_id) {
    reportError(new Error(`Plan ${plan.slug} has no stripe_price_id`), {
      scope: "billing.subscribe.missing_price",
      extra: { restaurantId, planSlug },
    });
    return {
      error: "That plan isn't ready to subscribe to yet. Please try later.",
    };
  }

  // Founding restaurants keep the free Starter: nothing to subscribe to.
  const billing = await getRestaurantBilling(restaurantId);
  if (billing?.state === "exempt" && plan.slug === "starter") {
    return { error: "Starter is already free for your restaurant." };
  }
  // Subscribing during the free month doesn't cut it short.
  const trialEnd =
    billing?.state === "trial"
      ? stripeTrialEnd(billing.trialEndsAt)
      : undefined;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const settingsUrl = `${proto}://${host}/dashboard/payments`;

  let checkoutUrl: string;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${settingsUrl}?subscribed=1`,
      cancel_url: `${settingsUrl}?subscribe_cancelled=1`,
      // Carried back on the webhook event. Without these the handler would
      // have to guess which restaurant a subscription belongs to, and a
      // wrong guess bills the wrong business.
      client_reference_id: restaurantId,
      metadata: { restaurant_id: restaurantId, plan_id: plan.id },
      subscription_data: {
        metadata: { restaurant_id: restaurantId, plan_id: plan.id },
        ...(trialEnd && { trial_end: trialEnd }),
      },
    });

    if (!session.url) {
      return { error: "Stripe didn't return a checkout page. Please retry." };
    }
    checkoutUrl = session.url;
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "billing.subscribe.stripe",
      extra: { restaurantId, planSlug },
    });
    return { error: "Couldn't reach Stripe. Please try again." };
  }

  // Outside the try: redirect() signals by throwing.
  redirect(checkoutUrl);
}

export interface CancelPlanResult {
  ok: boolean;
  error?: string;
}

/**
 * "Cancel plan" and "Keep my plan" on the Payments page: sets Stripe's
 * cancel_at_period_end on the restaurant's subscription (on the platform
 * account, like the checkout above), then records what Stripe returned at
 * once instead of waiting for the webhook, which writes the same row.
 */
export async function setPlanCancellation(
  restaurantId: string,
  cancel: boolean,
): Promise<CancelPlanResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!canSellPlans(await getAppShell())) {
    return { ok: false, error: "Plans can't be changed in this app." };
  }
  if (!isStripeConfigured()) {
    return { ok: false, error: "Stripe isn't configured." };
  }

  const current = await getRestaurantSubscription(restaurantId);
  const controls = cancelControlsFor(current);
  if (!current || controls.kind === "none") {
    return { ok: false, error: "There's no active plan to change." };
  }
  if (cancel === (controls.kind === "ending")) {
    return { ok: true }; // already as asked
  }

  try {
    const updated = await getStripe().subscriptions.update(
      current.stripeSubscriptionId,
      { cancel_at_period_end: cancel },
    );
    const restaurantMeta = updated.metadata?.restaurant_id;
    const planId = updated.metadata?.plan_id;
    if (restaurantMeta !== restaurantId || !planId) {
      throw new Error(`Subscription ${updated.id} metadata mismatch`);
    }
    const admin = createAdminClient();
    const { error } = await admin.rpc("record_restaurant_subscription", {
      p_restaurant_id: restaurantId,
      p_plan_id: planId,
      p_stripe_customer_id: String(updated.customer),
      p_stripe_subscription_id: updated.id,
      p_status: updated.status,
      p_current_period_end: resolvePeriodEnd(updated),
      p_cancel_at_period_end: updated.cancel_at_period_end ?? false,
    });
    // Stripe has the change either way; the webhook will record it if
    // this write failed, so it's reported rather than shown as a failure.
    if (error) {
      reportError(error, {
        scope: "billing.cancel.record",
        extra: { restaurantId },
      });
    }
  } catch (error) {
    reportError(error, {
      scope: cancel ? "billing.cancel" : "billing.resume",
      extra: { restaurantId },
    });
    return {
      ok: false,
      error: "Couldn't reach Stripe to change your plan. Please try again.",
    };
  }
  revalidatePath("/dashboard/payments");
  return { ok: true };
}
