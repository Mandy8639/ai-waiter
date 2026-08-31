import "server-only";
import Stripe from "stripe";

/**
 * The single place STRIPE_SECRET_KEY is read.
 *
 * Validated lazily, at the one call site that needs it, rather than in
 * src/lib/env.ts — the same contract the AI providers already follow (see
 * docs/security.md#server-only-secrets). A restaurant that never touches
 * payments, and a build with no Stripe key configured at all, must both
 * work exactly as they do today; unset means "payments are not offered",
 * never a crash.
 */
let client: Stripe | undefined;

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not configured — payments are unavailable. See .env.example.",
    );
  }
  // Deliberately no pinned apiVersion: the installed SDK's own default is
  // the version its types were generated against, so pinning a different
  // string here would let the types and the wire format drift apart.
  client ??= new Stripe(secretKey);
  return client;
}

/** Reset between tests; never called from application code. */
export function __resetStripeClientForTests(): void {
  client = undefined;
}
