import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";
import { DEMO_RESTAURANT_SLUG } from "./content";

/**
 * A table link into the demo restaurant, for the public /demo page.
 *
 * The waiter and ordering only exist inside a table session, so the demo
 * has to open a table's QR destination (/r/<slug>/table/<token>), not the
 * bare menu. One of the demo's tables is picked at random: each table
 * allows a limited number of new guest sessions per few minutes
 * (src/lib/customer/rate-limit.ts), and spreading visitors keeps a busy
 * day from locking everyone out.
 *
 * The admin client is used because diners can't list tables. It reads
 * one fixed, fictional restaurant's table tokens — the same tokens its
 * printed QR codes would carry — and nothing else. Returns null when the
 * demo doesn't exist or can't be reached, so the page can say so.
 */
export async function getDemoTablePath(): Promise<string | null> {
  try {
    const db = createAdminClient();
    const { data: restaurant } = await db
      .from("restaurants")
      .select("id")
      .eq("slug", DEMO_RESTAURANT_SLUG)
      .eq("is_active", true)
      .maybeSingle();
    if (!restaurant) return null;

    const { data: tables } = await db
      .from("tables")
      .select("public_token")
      .eq("restaurant_id", restaurant.id)
      .eq("is_active", true);
    if (!tables || tables.length === 0) return null;

    const table = tables[Math.floor(Math.random() * tables.length)]!;
    return `/r/${DEMO_RESTAURANT_SLUG}/table/${table.public_token}`;
  } catch (error) {
    reportError(error, { scope: "marketing.demo-table" });
    return null;
  }
}
