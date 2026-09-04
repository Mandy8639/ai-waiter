/**
 * Reports whether every Stripe id stored in the database actually resolves
 * against the currently configured STRIPE_SECRET_KEY.
 *
 * Exists because the live-mode cutover is not a config change. Stripe ids
 * are mode-scoped: a `price_...`, `acct_...`, `cus_...` or `sub_...`
 * created in test mode simply does not exist in live mode, and this
 * application stores all four in Postgres. Flipping the keys without
 * resetting those rows leaves a database full of ids that the live account
 * has never heard of — and the failures surface one at a time, at the
 * worst moment, as "No such price" while a real customer waits.
 *
 * Read-only: this script never writes to Stripe or to the database.
 *
 *   npm run billing:preflight
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import {
  stripeKeyMode,
  isUnusableWithThisKey,
  type StripeMode,
} from "../src/lib/payments/stripe-mode";

interface Row {
  label: string;
  id: string;
  resolve: (stripe: Stripe, id: string) => Promise<unknown>;
  /** What the operator must do when this id doesn't resolve. */
  remedy: string;
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

  const mode: StripeMode = stripeKeyMode(stripeKey);
  const db = createClient(url, key);
  const stripe = new Stripe(stripeKey);

  console.log(`Stripe key mode: ${mode.toUpperCase()}`);
  if (mode === "unknown") {
    console.log(
      "  (unrecognised key prefix — continuing, but check this is the key you meant)",
    );
  }
  console.log("");

  const rows: Row[] = [];

  const { data: plans } = await db
    .from("platform_plans")
    .select("slug, stripe_price_id")
    .not("stripe_price_id", "is", null);
  for (const plan of plans ?? []) {
    rows.push({
      label: `platform_plans[${plan.slug}].stripe_price_id`,
      id: plan.stripe_price_id as string,
      resolve: (s, id) => s.prices.retrieve(id),
      remedy:
        "clear it (UPDATE platform_plans SET stripe_price_id = NULL) then run npm run billing:setup-prices",
    });
  }

  const { data: accounts } = await db
    .from("restaurant_payment_accounts")
    .select("restaurant_id, stripe_account_id")
    .not("stripe_account_id", "is", null);
  for (const account of accounts ?? []) {
    rows.push({
      label: `restaurant_payment_accounts[${(account.restaurant_id as string).slice(0, 8)}].stripe_account_id`,
      id: account.stripe_account_id as string,
      // Connect accounts here are created via POST /v2/core/accounts, so
      // they're retrieved the same way — see src/lib/payments/actions.ts.
      resolve: (s, id) => s.v2.core.accounts.retrieve(id),
      remedy:
        "delete the row and have the restaurant complete Connect onboarding again in this mode",
    });
  }

  const { data: subs } = await db
    .from("restaurant_subscriptions")
    .select("restaurant_id, status, stripe_subscription_id")
    .not("stripe_subscription_id", "is", null);
  for (const sub of subs ?? []) {
    rows.push({
      label: `restaurant_subscriptions[${(sub.restaurant_id as string).slice(0, 8)}].stripe_subscription_id (${sub.status})`,
      id: sub.stripe_subscription_id as string,
      resolve: (s, id) => s.subscriptions.retrieve(id),
      remedy:
        "delete the row — otherwise this restaurant keeps its paid plan's fee rate with no real subscription behind it",
    });
  }

  if (rows.length === 0) {
    console.log("No Stripe ids stored in the database. Nothing to check.");
    return;
  }

  const stale: Row[] = [];
  for (const row of rows) {
    try {
      await row.resolve(stripe, row.id);
      console.log(`  OK      ${row.label}\n          ${row.id}`);
    } catch (error) {
      if (!isUnusableWithThisKey(error)) {
        console.log(
          `  ERROR   ${row.label}\n          ${row.id}\n          ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        continue;
      }
      stale.push(row);
      console.log(
        `  STALE   ${row.label}\n          ${row.id} does not exist or is not accessible in ${mode} mode`,
      );
    }
  }

  console.log("");
  if (stale.length === 0) {
    console.log(
      `All ${rows.length} stored Stripe id(s) resolve in ${mode} mode.`,
    );
    return;
  }

  console.log(
    `${stale.length} of ${rows.length} stored Stripe id(s) do NOT exist in ${mode} mode.`,
  );
  console.log("Each one needs the following before this mode can be used:\n");
  for (const row of stale) {
    console.log(`  ${row.label}\n    -> ${row.remedy}\n`);
  }
  process.exitCode = 1;
}

main();
