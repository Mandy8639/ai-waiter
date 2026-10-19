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
  "record_in_person_payment",
  "set_menu_item_availability",
  "set_menu_item_sold_out_until_next_opening",
  "set_modifier_option_availability",
  "pause_new_orders",
  "resume_new_orders",
  "set_kitchen_busy",
  // A restaurant's own billing state (20261018120000); checks membership.
  "get_restaurant_billing",
  // Pickup ordering (20261022090000). The first two read and write the
  // caller's own session's cart; the third checks restaurant membership.
  "get_pickup_options",
  "set_cart_pickup",
  "change_pickup_time",
  // Reviewed 2026-10-17 and revoked from anon by
  // 20261017090000_revoke_anon_from_signed_in_functions.sql. Each checks
  // its caller inside or is a small helper; no signed-out page calls them.
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
  "create_reservation",
  "create_restaurant",
  "current_restaurant_role",
  "get_best_selling_items",
  "get_kitchen_queue_ahead",
  "get_payment_history",
  "get_public_payment_settings",
  "get_takings_by_method",
  "get_takings_summary",
  "is_restaurant_manager_or_owner",
  "is_restaurant_member",
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
  "submit_order",
  "sync_restaurant_payment_account_status",
  "transition_reservation_status",
  "transition_ticket_group_status",
  "update_reservation_details",
];

/**
 * Functions anon is MEANT to call, each with a decision behind it. Distinct
 * from the pending-review list below, which is a backlog: this list is the
 * reviewed answer, and it is expected to stay small.
 *
 * - get_staff_invitation_preview: the person following a staff invitation
 *   link has no account yet by definition, so the page that tells them what
 *   they have been invited to runs signed out. Read-only, returns the
 *   restaurant name / role / state and nothing else, and the token is the
 *   authorization — the same trust model as get_table_by_token. See
 *   20260926090000_staff_invitations.sql.
 * - get_tab_split, start_split_payment, attach_split_checkout_session,
 *   get_split_payment_checkout: a guest paying their part of a split bill
 *   opens a link on their own phone and may never have scanned the table's
 *   QR code, so they are signed out. The split's token is the
 *   authorization; what it allows is reading the bill and PAYING part of
 *   it, which takes nothing from anyone. No function a signed-out caller
 *   can reach releases a claim or marks anything paid — only Stripe's
 *   signed webhook does. See 20261002090000_split_bill.sql.
 * - get_menu_translations, get_menu_languages: the menu is public — a
 *   diner reads it before (or without) scanning a table — so its approved
 *   translations are too. Read-only, approved and current rows only, for
 *   active restaurants only. See 20261003090000_menu_translations.sql.
 * - get_public_menus: which of a restaurant's published menus are on now,
 *   their hours and sections — the public menu page needs it before any
 *   QR scan. Read-only; drafts and inactive restaurants are excluded. See
 *   20261004090000_multiple_menus.sql.
 * - get_kitchen_status: whether new orders are paused and how much longer
 *   food is taking, shown on every diner page before anyone orders —
 *   including signed-out visitors browsing the menu. Two values, nothing
 *   else; expired ones read as off. See 20261015090000_kitchen_busy_mode.sql.
 * - get_table_by_token, count_recent_sessions_for_table: the QR scan route
 *   (src/app/r/[restaurantSlug]/table/[token]/route.ts) runs both before
 *   the anonymous sign-in. The table's token is the authorization; the
 *   count is the per-table session rate limit and returns a number only.
 * - get_public_order_settings: whether the restaurant takes orders and
 *   allows notes or AI suggestions, shown on the public menu and dish pages
 *   before any scan. Four booleans.
 * - get_special_hours_today: whether the restaurant is closed today or on
 *   special hours (a holiday), with the owner's short public note, shown
 *   on the public menu before any scan. Today's row only, active
 *   restaurants only. See 20261019090000_service_features.sql.
 * - is_menu_item_publicly_visible, is_restaurant_publicly_active: called
 *   by the {anon, authenticated} SELECT policies on the menu tables, so the
 *   public menu cannot load without them. Each returns one boolean about
 *   whether something is published.
 *
 * Every other public function is refused to anon (reviewed 2026-10-17).
 * Never add to this list without the same kind of reason.
 */
const ANON_BY_DESIGN = [
  "get_kitchen_status",
  "get_staff_invitation_preview",
  "get_tab_split",
  "start_split_payment",
  "attach_split_checkout_session",
  "get_split_payment_checkout",
  "get_menu_translations",
  "get_menu_languages",
  "get_public_menus",
  "get_table_by_token",
  "count_recent_sessions_for_table",
  "get_public_order_settings",
  "get_special_hours_today",
  "is_menu_item_publicly_visible",
  "is_restaurant_publicly_active",
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
      (name) => !ANON_BY_DESIGN.includes(name),
    );
    expect(unexpected).toEqual([]);
  });

  it.each(ANON_BY_DESIGN)(
    "%s is anon-callable on purpose, and still is",
    async (name) => {
      // The mirror of the honesty test below: if a later migration revokes
      // anon from a by-design entry, that is a deliberate change of mind and
      // this list should say so rather than quietly disagreeing.
      const row = (await grants()).find((r) => r.name === name);
      expect(row).toBeDefined();
      expect(row).toMatchObject({ anon: true });
    },
  );

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
    // From the 2026-10-17 review: a staff report and order submission.
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.get_takings_summary($1, now(), now());", [
          crypto.randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.asAnon((c) =>
        c.query("select public.current_restaurant_role($1);", [
          crypto.randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
