/**
 * Creates a Stripe Product and recurring Price for each paid plan, then
 * writes the price ids back to platform_plans.
 *
 * A separate script rather than part of a migration or a deploy, because
 * it writes to a live Stripe account. Creating products is harmless, but
 * "the deploy silently made things in my Stripe account" is not a
 * surprise anyone should get.
 *
 * Idempotent: a plan that already has a stripe_price_id is left alone, so
 * running it twice does not create duplicate products or repoint an
 * existing subscription's price.
 *
 *   npx tsx --env-file=.env.local scripts/setup-stripe-prices.ts
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

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
      console.log(
        `${plan.slug}: already has ${plan.stripe_price_id} — skipped`,
      );
      continue;
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
