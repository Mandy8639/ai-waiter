/**
 * One-off: puts the billing tables back to the state captured in a backup
 * file, so test mode works again after a live-mode cutover was started and
 * then paused.
 *
 * Step 2 of docs/going-live.md deliberately clears every sandbox Stripe id
 * from the database. That is correct when the cutover runs to completion.
 * Paused halfway, it leaves the app unable to take payments in EITHER mode:
 * the sandbox Connect accounts and subscription are gone, and
 * platform_plans holds live price ids a test key cannot see.
 *
 * Restores exactly four things, from the backup, and nothing else:
 *   platform_plans.stripe_price_id, restaurant_payment_accounts,
 *   restaurant_subscriptions, restaurant_plans
 *
 *   npx tsx --env-file=.env.local scripts/restore-sandbox-billing-state.ts <backup.json>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: ... restore-sandbox-billing-state.ts <backup.json>");
    process.exitCode = 1;
    return;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.");
    process.exitCode = 1;
    return;
  }

  const db = createClient(url, key);
  const backup = JSON.parse(readFileSync(file, "utf8"));

  // Worth keeping: the live prices created during the paused cutover, so
  // resuming can paste them back rather than creating duplicate products.
  const { data: current } = await db
    .from("platform_plans")
    .select("slug, stripe_price_id");
  console.log(
    "Live price ids currently stored (note them before they're overwritten):",
  );
  for (const p of current ?? []) {
    if ((p as { stripe_price_id: string | null }).stripe_price_id) {
      console.log(
        `  ${(p as { slug: string }).slug}: ${(p as { stripe_price_id: string }).stripe_price_id}`,
      );
    }
  }
  console.log("");

  for (const row of backup.data.platform_plans ?? []) {
    const { error } = await db
      .from("platform_plans")
      .update({ stripe_price_id: row.stripe_price_id })
      .eq("id", row.id);
    if (error) console.error(`platform_plans ${row.slug}: ${error.message}`);
  }
  console.log(`platform_plans: price ids restored`);

  for (const table of [
    "restaurant_payment_accounts",
    "restaurant_subscriptions",
    "restaurant_plans",
  ]) {
    const rows = backup.data[table] ?? [];
    if (rows.length === 0) {
      console.log(`${table}: nothing in the backup`);
      continue;
    }
    const { error } = await db.from(table).insert(rows);
    console.log(
      error
        ? `${table}: ERR ${error.message}`
        : `${table}: ${rows.length} row(s) restored`,
    );
  }
}

main();
