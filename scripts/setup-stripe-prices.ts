/**
 * Creates a Stripe Product and recurring Price for each paid plan, then
 * writes the price ids back to platform_plans.
 *
 * A separate script rather than part of a migration or a deploy, because
 * it writes to a live Stripe account. Creating products is harmless, but
 * "the deploy silently made things in my Stripe account" is not a
 * surprise anyone should get.
 *
 * Idempotent, but mode-aware: a plan whose stripe_price_id actually
 * resolves against the configured key is left alone, so running this twice
 * does not create duplicate products or repoint an existing subscription's
 * price. A stored id that does NOT resolve is treated as absent and
 * replaced.
 *
 * That distinction is the whole point at live-mode cutover. Stripe ids are
 * mode-scoped, so plans set up in test mode hold price ids that do not
 * exist in live mode. Skipping purely on "the column is non-empty" made
 * this script a silent no-op exactly when it was needed most: it would
 * report every plan as "already set up" while leaving test ids in place,
 * and the first real subscriber would hit "No such price".
 *
 *   npx tsx --env-file=.env.local scripts/setup-stripe-prices.ts
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import {
  stripeKeyMode,
  isUnusableWithThisKey,
} from "../src/lib/payments/stripe-mode";

/**
 * "usable" when the price exists for this key, "unusable" when it doesn't
 * (a cross-mode id, typically). Any other Stripe failure rethrows rather
 * than being quietly treated as "absent" — creating a duplicate product
 * because of a transient network error would be worse than stopping.
 */
async function resolvePrice(
  stripe: Stripe,
  priceId: string,
): Promise<"usable" | "unusable"> {
  try {
    await stripe.prices.retrieve(priceId);
    return "usable";
  } catch (error) {
    if (isUnusableWithThisKey(error)) return "unusable";
    throw error;
  }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!url || !key || !stripeKey) {
    console.error(
      "Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and STRIPE_SECRET_KEY.",
    );
    process.exitCode = 1;
    return;
  }

  const db = createClient(url, key);
  const stripe = new Stripe(stripeKey);
  const mode = stripeKeyMode(stripeKey);

  console.log(`Stripe key mode: ${mode.toUpperCase()}`);

  const { data: plans, error } = await db
    .from("platform_plans")
    .select("id, slug, name, monthly_price_cents, currency, stripe_price_id")
    .gt("monthly_price_cents", 0)
    .order("monthly_price_cents");

  if (error) {
    console.error(`Could not read plans: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const plan of plans ?? []) {
    if (plan.stripe_price_id) {
      const existing = await resolvePrice(stripe, plan.stripe_price_id);
      if (existing === "usable") {
        console.log(
          `${plan.slug}: already has ${plan.stripe_price_id} — skipped`,
        );
        continue;
      }
      // Not usable with this key: almost always a price from the other
      // mode. Replaced rather than skipped — see the header comment.
      console.log(
        `${plan.slug}: stored ${plan.stripe_price_id} does not exist in ${mode} mode — creating a replacement`,
      );
    }

    const product = await stripe.products.create({
      name: `AI Waiter — ${plan.name}`,
      metadata: { plan_slug: plan.slug },
    });

    const price = await stripe.prices.create({
      product: product.id,
      currency: plan.currency.toLowerCase(),
      unit_amount: plan.monthly_price_cents,
      recurring: { interval: "month" },
      metadata: { plan_slug: plan.slug },
    });

    const { error: updateError } = await db
      .from("platform_plans")
      .update({ stripe_price_id: price.id })
      .eq("id", plan.id);

    if (updateError) {
      // The Stripe objects exist but the database does not know about
      // them. Said loudly with the id, because the fix is to paste it in
      // rather than to run this again and create a second product.
      console.error(
        `${plan.slug}: created ${price.id} but FAILED to record it — ${updateError.message}`,
      );
      process.exitCode = 1;
      continue;
    }

    console.log(
      `${plan.slug}: ${price.id} (${plan.monthly_price_cents / 100} ${plan.currency}/month)`,
    );
  }
}

main();
