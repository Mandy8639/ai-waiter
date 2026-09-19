// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";

/**
 * Who may EXECUTE which database function, checked against the catalog.
 *
 * The harness (setup.ts) applies Supabase's default function privileges —
 * EXECUTE to anon, authenticated and service_role on every new public
 * function — before running the migrations. So these assertions see what
 * the live project sees. That gap is how the Stripe webhook functions were
 * callable by anyone with the anon key until
 * 20260919090000_revoke_anon_from_server_functions.sql.
 */

/** Only the Stripe webhooks (service_role) may call these. No caller check inside — the grant IS the protection. */
const WEBHOOK_ONLY = [
  "mark_order_payment_succeeded",
  "mark_order_payment_failed",
  "mark_refund_settled",
  "record_restaurant_subscription",
];

/** Signed-in callers only; each checks its caller inside as well. */
const SIGNED_IN_ONLY = [
  "count_recent_orders_for_session",
  "transition_order_status",
  "get_restaurant_staff",
];

/**
 * Functions still executable by anon, as found on 2026-09-19 after the
 * hotfix. NOT an endorsement: each is pending a per-function review (some,
 * like get_table_by_token for the QR scan, may genuinely need anon; most
 * check their caller inside and refuse anon anyway).
 *
 * The point of listing them is the test below: any function that becomes
 * anon-callable and is NOT on this list fails the suite, so a new migration
 * can no longer expose a function to signed-out callers by forgetting a
 * revoke. Shrink this list as the review proceeds; never grow it without
 * deciding that anon really should call the function.
 */
const ANON_EXECUTABLE_PENDING_REVIEW = [
  "add_restaurant_staff_by_email",
  "assert_can_view_reports",
  "attach_payment_checkout_session",
  "attach_refund_stripe_id",
  "cancel_pending_refund",
  "cart_belongs_to_caller",
  "commit_menu_import",
  "confirm_menu_item_allergens",
  "confirm_reservation_request",
  "confirmed_allergen_ids",
  "count_recent_reservation_requests",
  "count_recent_sessions_for_table",
  "create_reservation",
  "create_restaurant",
  "current_restaurant_role",
  "get_best_selling_items",
  "get_kitchen_queue_ahead",
  "get_payment_history",
  "get_public_order_settings",
  "get_public_payment_settings",
  "get_table_by_token",
  "get_takings_by_method",
  "get_takings_summary",
  "is_menu_item_publicly_visible",
  "is_restaurant_manager_or_owner",
  "is_restaurant_member",
  "is_restaurant_publicly_active",
  "is_valid_order_status_transition",
  "is_valid_reservation_status_transition",
  "link_restaurant_payment_account",
  "merge_orders_into_ticket",
  "order_belongs_to_caller",
  "order_status_rank",
  "payment_refunded_total",
  "platform_fee_for_payment",
  "platform_fee_minor_units",
  "recompute_order_status_from_groups",
  "record_cash_payment",
  "request_reservation",
  "reverse_cash_payment",
  "role_can_transition_order",
  "split_order_into_tickets",
  "start_order_payment",
  "start_refund",
  "start_tab_payment",
  "submit_order",
  "sync_restaurant_payment_account_status",
  "transition_reservation_status",
  "transition_ticket_group_status",
  "update_reservation_details",
];

describe("function EXECUTE grants", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function grants() {
    const { rows } = await db.admin.query<{
      name: string;
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
    }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prorettype <> 'trigger'::regtype;`,
    );
    return rows;
  }

  it.each(WEBHOOK_ONLY)("%s is callable by service_role only", async (name) => {
    const row = (await grants()).find((r) => r.name === name);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it.each(SIGNED_IN_ONLY)(
    "%s is refused to anon and allowed to signed-in callers",
    async (name) => {
      const row = (await grants()).find((r) => r.name === name);
      expect(row).toBeDefined();
      expect(row).toMatchObject({ anon: false, authenticated: true });
    },
  );

  it("never lets anon call a function that signed-in users cannot", async () => {
    // A function withheld from authenticated is server-only by intent; if
    // anon can still reach it, a revoke was forgotten.
    const leaked = (await grants())
      .filter((r) => r.anon && !r.authenticated)
      .map((r) => r.name);
    expect(leaked).toEqual([]);
  });

  it("exposes no new function to anon beyond the reviewed list", async () => {
    const anonCallable = (await grants())
      .filter((r) => r.anon)
      .map((r) => r.name);
    const unexpected = anonCallable.filter(
      (name) => !ANON_EXECUTABLE_PENDING_REVIEW.includes(name),
    );
    expect(unexpected).toEqual([]);
  });

  it("keeps the pending-review list honest: every entry still exists and is still anon-callable", async () => {
    // When a later migration revokes anon from one of these, this fails
    // until the entry is removed — so the list only ever shrinks.
    const anonCallable = new Set(
      (await grants()).filter((r) => r.anon).map((r) => r.name),
    );
    const stale = ANON_EXECUTABLE_PENDING_REVIEW.filter(
      (name) => !anonCallable.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("really refuses anon at call time, not just in the catalog", async () => {
    await expect(
      db.asAnon((c) =>
        c.query(
          "select public.mark_order_payment_succeeded('cs_test_x', null);",
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.asAnon((c) =>
        c.query(
          "select public.record_restaurant_subscription($1, $2, 'cus', 'sub', 'active', now(), false);",
          [crypto.randomUUID(), crypto.randomUUID()],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
