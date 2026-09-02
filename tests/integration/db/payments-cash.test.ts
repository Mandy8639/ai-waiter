// @vitest-environment node
//
// Payments phase 3, step 2 — recording cash
// (supabase/migrations/20260902100000_cash_payments.sql).
//
// Cash is the one payment kind a person asserts rather than a processor
// confirms, so these tests concentrate on who may assert it, who may undo
// it, and what survives the undoing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createCart,
  fullOrderFixture,
  submitOrder,
} from "./helpers";

/** A session holds at most one cart, so the existing one is refilled. */
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
  return submitOrder(db, f.customerUserId, `cash-order-${crypto.randomUUID()}`);
}

async function acceptCash(db: TestDb, restaurantId: string, on = true) {
  await db.admin.query(
    "update public.restaurant_settings set accept_cash = $2 where restaurant_id = $1;",
    [restaurantId, on],
  );
}

async function allowTipping(db: TestDb, restaurantId: string, on: boolean) {
  await db.admin.query(
    "update public.restaurant_settings set tipping_enabled = $2 where restaurant_id = $1;",
    [restaurantId, on],
  );
}

function recordCash(
  db: TestDb,
  userId: string,
  orderIds: string[],
  tip = 0,
): Promise<string> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<{ record_cash_payment: string }>(
      "select public.record_cash_payment($1::uuid[], $2);",
      [orderIds, tip],
    );
    return rows[0].record_cash_payment;
  });
}

function reverseCash(
  db: TestDb,
  userId: string,
  paymentId: string,
  reason = "recorded by mistake",
) {
  return db.asUser(userId, (c) =>
    c.query("select public.reverse_cash_payment($1, $2);", [paymentId, reason]),
  );
}

describe("recording cash", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("settles immediately, with no Stripe object", async () => {
    // There is no processor to wait for: the money is already in the till.
    const f = await fullOrderFixture(db);
    await acceptCash(db, f.restaurantId);

    const id = await recordCash(db, f.staffUserId, [f.orderId]);

    const { rows } = await db.admin.query<{
      status: string;
      method: string;
      paid_at: string | null;
      stripe_checkout_session_id: string | null;
      recorded_by: string;
      amount: string;
    }>(
      `select status, method, paid_at, stripe_checkout_session_id, recorded_by, amount
       from public.order_payments where id = $1;`,
      [id],
    );
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].method).toBe("cash");
    expect(rows[0].paid_at).not.toBeNull();
    expect(rows[0].stripe_checkout_session_id).toBeNull();
    expect(rows[0].recorded_by).toBe(f.staffUserId);
  });

  it("sums the amount from the orders, never from the caller", async () => {
    const f = await fullOrderFixture(db);
    await acceptCash(db, f.restaurantId);
    const id = await recordCash(db, f.staffUserId, [f.orderId]);

    const { rows } = await db.admin.query<{ matches: boolean }>(
      `select (p.amount = (select o.total from public.orders o where o.id = $2)) as matches
       from public.order_payments p where p.id = $1;`,
      [id, f.orderId],
    );
    expect(rows[0].matches).toBe(true);
  });

  it("can settle a whole tab in one record", async () => {
    const f = await fullOrderFixture(db);
    await acceptCash(db, f.restaurantId);
    const second = await addAnotherOrder(db, f);

    const id = await recordCash(db, f.staffUserId, [f.orderId, second.id]);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.payment_orders where payment_id = $1;",
      [id],
    );
    expect(rows[0].count).toBe("2");

    // The charge is the sum of both, compared in SQL rather than JS.
    const { rows: sum } = await db.admin.query<{ matches: boolean }>(
      `select (p.amount = (
         select sum(o.total) from public.orders o where o.id = any($2::uuid[])
       )) as matches
       from public.order_payments p where p.id = $1;`,
      [id, [f.orderId, second.id]],
    );
    expect(sum[0].matches).toBe(true);
  });

  describe("who may record it", () => {
    it("allows any restaurant member, not just managers", async () => {
      // The person holding the notes is the waiter. Restricting this to
      // managers gets worked around by sharing a login, which is worse.
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const waiter = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");

      await expect(recordCash(db, waiter, [f.orderId])).resolves.toBeDefined();
    });

    it("refuses a non-member", async () => {
      const f = await fullOrderFixture(db);
      const other = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);

      await expect(
        recordCash(db, other.staffUserId, [f.orderId]),
      ).rejects.toThrow(/PAYMENT_FORBIDDEN/);
    });

    it("refuses orders from different restaurants in one call", async () => {
      // Otherwise a member of one restaurant settles another's order by
      // bundling it into the same array.
      const a = await fullOrderFixture(db);
      const b = await fullOrderFixture(db);
      await acceptCash(db, a.restaurantId);
      await acceptCash(db, b.restaurantId);

      await expect(
        recordCash(db, a.staffUserId, [a.orderId, b.orderId]),
      ).rejects.toThrow(/PAYMENT_MIXED_RESTAURANTS/);
    });

    it("refuses when the restaurant does not record cash", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId, false);

      await expect(recordCash(db, f.staffUserId, [f.orderId])).rejects.toThrow(
        /PAYMENT_CASH_NOT_ACCEPTED/,
      );
    });

    // 20260902180000_cash_tip_gate.sql. The card paths always enforced
    // tipping_enabled; cash silently accepted a tip anyway, so a
    // restaurant that had switched tipping off could still accumulate
    // tips against its cash takings.
    it("refuses a tip when the restaurant has tipping switched off", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      await allowTipping(db, f.restaurantId, false);

      await expect(
        recordCash(db, f.staffUserId, [f.orderId], 3),
      ).rejects.toThrow(/PAYMENT_TIPPING_DISABLED/);
    });

    it("still records a tipless cash payment when tipping is off", async () => {
      // The setting refuses tips, not cash. Refusing the whole payment
      // would leave staff unable to record money already in the till.
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      await allowTipping(db, f.restaurantId, false);

      const paymentId = await recordCash(db, f.staffUserId, [f.orderId], 0);
      expect(paymentId).toBeTruthy();
    });

    it("accepts a tip once tipping is switched on", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      await allowTipping(db, f.restaurantId, true);

      const paymentId = await recordCash(db, f.staffUserId, [f.orderId], 3);
      const { rows } = await db.admin.query<{ tip_amount: string }>(
        "select tip_amount from public.order_payments where id = $1;",
        [paymentId],
      );
      expect(Number(rows[0].tip_amount)).toBe(3);
    });

    it("refuses a cancelled order", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      await db.admin.query(
        "update public.orders set status = 'cancelled', cancelled_at = now() where id = $1;",
        [f.orderId],
      );

      await expect(recordCash(db, f.staffUserId, [f.orderId])).rejects.toThrow(
        /PAYMENT_ORDER_CANCELLED/,
      );
    });
  });

  describe("cash and card cannot both settle an order", () => {
    it("refuses cash for an order already paid by card", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const { rows: card } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments
           (restaurant_id, status, amount, currency, paid_at)
         values ($1, 'succeeded', 5, 'GBP', now()) returning id;`,
        [f.restaurantId],
      );
      await db.admin.query(
        `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
         values ($1, $2, $3, 5);`,
        [card[0].id, f.orderId, f.restaurantId],
      );

      await expect(recordCash(db, f.staffUserId, [f.orderId])).rejects.toThrow(
        /PAYMENT_ALREADY_PAID/,
      );
    });

    it("refuses a second cash record for the same order", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      await recordCash(db, f.staffUserId, [f.orderId]);

      await expect(recordCash(db, f.staffUserId, [f.orderId])).rejects.toThrow(
        /PAYMENT_ALREADY_PAID/,
      );
    });
  });

  describe("reversing", () => {
    it("lets an owner reverse, keeping the row and its paid_at", async () => {
      // A reversal is a correction with an audit trail, not a deletion —
      // erasing it would destroy the only evidence money was recorded.
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const id = await recordCash(db, f.staffUserId, [f.orderId]);

      await reverseCash(db, f.staffUserId, id, "guest actually paid by card");

      const { rows } = await db.admin.query<{
        status: string;
        paid_at: string | null;
        reversed_at: string | null;
        reversed_by: string;
        reversal_reason: string;
        amount: string;
      }>(
        `select status, paid_at, reversed_at, reversed_by, reversal_reason, amount
         from public.order_payments where id = $1;`,
        [id],
      );
      expect(rows[0].status).toBe("reversed");
      expect(rows[0].paid_at).not.toBeNull();
      expect(rows[0].reversed_at).not.toBeNull();
      expect(rows[0].reversed_by).toBe(f.staffUserId);
      expect(rows[0].reversal_reason).toBe("guest actually paid by card");
      expect(Number(rows[0].amount)).toBeGreaterThan(0);
    });

    it("frees the order to be paid again", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const id = await recordCash(db, f.staffUserId, [f.orderId]);
      await reverseCash(db, f.staffUserId, id);

      await expect(
        recordCash(db, f.staffUserId, [f.orderId]),
      ).resolves.toBeDefined();
    });

    it("refuses a plain staff member", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const waiter = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");
      const id = await recordCash(db, waiter, [f.orderId]);

      await expect(reverseCash(db, waiter, id)).rejects.toThrow(
        /PAYMENT_FORBIDDEN/,
      );
    });

    it("allows a manager", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");
      const id = await recordCash(db, f.staffUserId, [f.orderId]);

      await expect(reverseCash(db, manager, id)).resolves.toBeDefined();
    });

    it("refuses to reverse a card payment", async () => {
      // Undoing a card payment means moving money back through Stripe.
      // Doing it here would mark the order unpaid while the customer's
      // money stayed taken.
      const f = await fullOrderFixture(db);
      const { rows: card } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments
           (restaurant_id, status, method, amount, currency, paid_at)
         values ($1, 'succeeded', 'card', 5, 'GBP', now()) returning id;`,
        [f.restaurantId],
      );

      await expect(reverseCash(db, f.staffUserId, card[0].id)).rejects.toThrow(
        /PAYMENT_NOT_CASH/,
      );
    });

    it("refuses a reversal with no reason", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const id = await recordCash(db, f.staffUserId, [f.orderId]);

      await expect(reverseCash(db, f.staffUserId, id, "   ")).rejects.toThrow(
        /PAYMENT_REASON_REQUIRED/,
      );
    });

    it("refuses to reverse the same payment twice", async () => {
      const f = await fullOrderFixture(db);
      await acceptCash(db, f.restaurantId);
      const id = await recordCash(db, f.staffUserId, [f.orderId]);
      await reverseCash(db, f.staffUserId, id);

      await expect(reverseCash(db, f.staffUserId, id)).rejects.toThrow(
        /PAYMENT_NOT_REVERSIBLE/,
      );
    });
  });
});
