// @vitest-environment node
//
// Payments phase 3, step 1 — paying a whole tab
// (supabase/migrations/20260902090000_tab_payments.sql).
//
// A tab is every unpaid order in one customer session, settled by a single
// charge. That required payment→order to become one-to-many, so these
// tests lean on the two things that change: coverage is now its own table,
// and "at most one succeeded payment per order" is a trigger rather than a
// unique index.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  createCart,
  fullOrderFixture,
  submitOrder,
} from "./helpers";

/** helpers.ts keeps its own `unique` private, so this test has its own. */
const idempotencyKey = () => `tab-order-${crypto.randomUUID()}`;

async function enableCardPayments(db: TestDb, restaurantId: string) {
  await db.admin.query(
    `update public.restaurant_settings
     set accept_card = true, tipping_enabled = true where restaurant_id = $1;`,
    [restaurantId],
  );
  await db.admin.query(
    `insert into public.restaurant_payment_accounts
       (restaurant_id, stripe_account_id, charges_enabled)
     values ($1, $2, true)
     on conflict (restaurant_id) do update set charges_enabled = true;`,
    [restaurantId, `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`],
  );
}

interface TabRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  currency: string;
  stripe_account_id: string;
  order_count: number;
}

function startTab(db: TestDb, userId: string, tip = 0): Promise<TabRow[]> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<TabRow>(
      "select * from public.start_tab_payment($1);",
      [tip],
    );
    return rows;
  });
}

/**
 * Adds a second order to an existing customer session. A session has at
 * most one cart (carts_customer_session_id_key), so the existing one is
 * refilled rather than a second created.
 */
async function addAnotherOrder(
  db: TestDb,
  f: Awaited<ReturnType<typeof fullOrderFixture>>,
) {
  const { rows } = await db.admin.query<{ id: string }>(
    "select id from public.carts where customer_session_id = $1;",
    [f.sessionId],
  );
  const cartId =
    rows[0]?.id ?? (await createCart(db, f.restaurantId, f.sessionId));
  await addCartItem(db, f.customerUserId, cartId, f.restaurantId, f.menuItemId);
  return submitOrder(db, f.customerUserId, idempotencyKey());
}

describe("paying a tab", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("covers every unpaid order in the session with one payment", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await addAnotherOrder(db, f);

    const tab = await startTab(db, f.customerUserId);
    expect(tab).toHaveLength(1);
    expect(tab[0].order_count).toBe(2);

    // One payment row, two coverage rows.
    const { rows: covered } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.payment_orders where payment_id = $1;",
      [tab[0].payment_id],
    );
    expect(covered[0].count).toBe("2");
  });

  it("charges the sum of the covered orders, computed in the database", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await addAnotherOrder(db, f);

    const tab = await startTab(db, f.customerUserId);

    const { rows } = await db.admin.query<{ matches: boolean }>(
      `select (p.amount = (
         select sum(po.amount) from public.payment_orders po where po.payment_id = p.id
       )) as matches
       from public.order_payments p where p.id = $1;`,
      [tab[0].payment_id],
    );
    // Compared in SQL against numeric — asserting this in JavaScript would
    // reintroduce the float drift money.ts exists to keep out of money.
    expect(rows[0].matches).toBe(true);
  });

  it("excludes cancelled orders", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const second = await addAnotherOrder(db, f);
    await db.admin.query(
      "update public.orders set status = 'cancelled', cancelled_at = now() where id = $1;",
      [second.id],
    );

    const tab = await startTab(db, f.customerUserId);
    expect(tab[0].order_count).toBe(1);
  });

  it("excludes orders already paid for individually", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await addAnotherOrder(db, f);

    // Settle the first order on its own, then open the tab.
    const single = await db.asUser(f.customerUserId, async (c) => {
      const { rows } = await c.query<{ payment_id: string }>(
        "select payment_id from public.start_order_payment($1, 0);",
        [f.orderId],
      );
      return rows[0].payment_id;
    });
    await db.admin.query(
      `update public.order_payments set status = 'succeeded', paid_at = now(),
       stripe_checkout_session_id = 'cs_tab_single' where id = $1;`,
      [single],
    );

    const tab = await startTab(db, f.customerUserId);
    expect(tab[0].order_count).toBe(1);
  });

  it("refuses when nothing is owed", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await db.admin.query(
      "update public.orders set status = 'cancelled', cancelled_at = now() where id = $1;",
      [f.orderId],
    );

    await expect(startTab(db, f.customerUserId)).rejects.toThrow(
      /PAYMENT_NOTHING_TO_PAY/,
    );
  });

  it("derives the session from auth.uid(), never from a parameter", async () => {
    // A session id parameter would be a way to pay for — or read the total
    // of — a neighbouring table. Each diner gets only their own tab.
    const mine = await fullOrderFixture(db);
    const theirs = await fullOrderFixture(db);
    await enableCardPayments(db, mine.restaurantId);
    await enableCardPayments(db, theirs.restaurantId);

    const tab = await startTab(db, mine.customerUserId);

    const { rows } = await db.admin.query<{ count: string }>(
      `select count(*)::text as count
       from public.payment_orders po
       join public.orders o on o.id = po.order_id
       where po.payment_id = $1 and o.customer_session_id = $2;`,
      [tab[0].payment_id, theirs.sessionId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("reuses a tab payment already in flight rather than charging twice", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await addAnotherOrder(db, f);

    const first = await startTab(db, f.customerUserId, 3);
    const second = await startTab(db, f.customerUserId, 3);
    expect(second[0].payment_id).toBe(first[0].payment_id);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.order_payments where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(rows[0].count).toBe("1");
  });

  it("refuses reuse when the tip changed", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    await startTab(db, f.customerUserId, 2);

    await expect(startTab(db, f.customerUserId, 6)).rejects.toThrow(
      /PAYMENT_IN_PROGRESS/,
    );
  });

  it("refuses a tab that mixes currencies", async () => {
    // Orders freeze their own currency, so a restaurant changing currency
    // mid-session could produce one. A single Stripe charge cannot span
    // currencies, so refusing is honest — per-order payment still works.
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);

    // An order's currency cannot be edited — trg_orders_enforce_immutable_fields
    // refuses it. The only way a session ends up mixed is the restaurant
    // changing its own currency between orders, which submit_order then
    // freezes onto the new one. That is the scenario reproduced here.
    await db.admin.query(
      "update public.restaurants set currency = 'EUR' where id = $1;",
      [f.restaurantId],
    );
    await addAnotherOrder(db, f);

    await expect(startTab(db, f.customerUserId)).rejects.toThrow(
      /PAYMENT_MIXED_CURRENCY/,
    );
  });

  describe("the one-succeeded-payment-per-order guarantee", () => {
    it("refuses to settle a tab overlapping an already-paid order", async () => {
      // The invariant moved from a unique index to a trigger when coverage
      // moved tables. It must still hold across a tab and a single order.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await addAnotherOrder(db, f);

      const tab = await startTab(db, f.customerUserId);

      // Settle f.orderId independently, behind the tab's back.
      const { rows: solo } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments (restaurant_id, status, amount, currency)
         values ($1, 'pending', 5, 'GBP') returning id;`,
        [f.restaurantId],
      );
      await db.admin.query(
        `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
         values ($1, $2, $3, 5);`,
        [solo[0].id, f.orderId, f.restaurantId],
      );
      await db.admin.query(
        "update public.order_payments set status = 'succeeded', paid_at = now() where id = $1;",
        [solo[0].id],
      );

      await expect(
        db.admin.query(
          "update public.order_payments set status = 'succeeded', paid_at = now() where id = $1;",
          [tab[0].payment_id],
        ),
      ).rejects.toThrow(/PAYMENT_ORDER_ALREADY_SETTLED/);
    });

    it("still allows a tab to settle when nothing overlaps", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await addAnotherOrder(db, f);
      const tab = await startTab(db, f.customerUserId);

      await expect(
        db.admin.query(
          "update public.order_payments set status = 'succeeded', paid_at = now() where id = $1;",
          [tab[0].payment_id],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("visibility", () => {
    it("shows the tab to its diner and to staff, but not to another table", async () => {
      const mine = await fullOrderFixture(db);
      const theirs = await fullOrderFixture(db);
      await enableCardPayments(db, mine.restaurantId);
      await startTab(db, mine.customerUserId);

      const asDiner = await db.asUser(mine.customerUserId, async (c) => {
        const { rows } = await c.query(
          "select order_id from public.payment_orders;",
        );
        return rows.length;
      });
      const asStaff = await db.asUser(mine.staffUserId, async (c) => {
        const { rows } = await c.query(
          "select order_id from public.payment_orders;",
        );
        return rows.length;
      });
      const asStranger = await db.asUser(theirs.customerUserId, async (c) => {
        const { rows } = await c.query(
          "select order_id from public.payment_orders;",
        );
        return rows.length;
      });

      expect(asDiner).toBeGreaterThan(0);
      expect(asStaff).toBeGreaterThan(0);
      expect(asStranger).toBe(0);
    });
  });
});
