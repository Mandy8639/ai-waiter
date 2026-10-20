import "server-only";
import { getStripe } from "@/lib/payments/stripe";

/**
 * Admin Phase 8: a new monthly Stripe price for a plan. Stripe prices
 * can't be edited, so a price change is a new price on the plan's existing
 * product (or a new product, the first time a plan becomes paid), and
 * existing subscriptions stay on their old price. The old price is left
 * active: those subscriptions keep billing on it.
 */
export async function createPlanPrice(plan: {
  slug: string;
  name: string;
  currency: string;
  monthlyPriceCents: number;
  currentPriceId: string | null;
}): Promise<string> {
  const stripe = getStripe();
  let productId: string | null = null;
  if (plan.currentPriceId) {
    try {
      const current = await stripe.prices.retrieve(plan.currentPriceId);
      productId =
        typeof current.product === "string"
          ? current.product
          : current.product.id;
    } catch {
      // The stored price isn't usable with this key (another Stripe mode):
      // start a product of its own below.
      productId = null;
    }
  }
  if (!productId) {
    const product = await stripe.products.create({
      name: `Tableside — ${plan.name}`,
      metadata: { plan_slug: plan.slug },
    });
    productId = product.id;
  }
  const price = await stripe.prices.create({
    product: productId,
    currency: plan.currency.toLowerCase(),
    unit_amount: plan.monthlyPriceCents,
    recurring: { interval: "month" },
    metadata: { plan_slug: plan.slug, set_on: "admin" },
  });
  return price.id;
}
