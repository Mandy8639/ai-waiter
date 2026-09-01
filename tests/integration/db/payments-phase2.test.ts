// @vitest-environment node
//
// Payments phase 2 — charging a card for an order
// (supabase/migrations/20260831140000_payments_phase2.sql).
//
// This is the first code in the project that moves money, so these tests
// are weighted towards the ways money goes wrong rather than the happy
// path: a caller naming its own price, an order being charged twice, a
// diner paying for someone else's table, and a browser claiming a payment
// succeeded when Stripe never said so.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullOrderFixture } from "./helpers";

/** Puts a restaurant in the state where card payment is actually possible. */
async function enableCardPayments(
  db: TestDb,
  restaurantId: string,
  opts: { tipping?: boolean; chargesEnabled?: boolean } = {},
) {
  const { tipping = true, chargesEnabled = true } = opts;
  await db.admin.query(
    `update public.restaurant_settings
     set accept_card = true, tipping_enabled = $2
     where restaurant_id = $1;`,
    [restaurantId, tipping],
  );
  await db.admin.query(
    `insert into public.restaurant_payment_accounts
       (restaurant_id, stripe_account_id, charges_enabled)
     values ($1, $2, $3)
     on conflict (restaurant_id) do update
       set charges_enabled = excluded.charges_enabled;`,
    [
      restaurantId,
      `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`,
      chargesEnabled,
    ],
  );
}

/**
 * attach_payment_checkout_session authorizes its caller, so it must run as
 * the diner who owns the order — exactly as the server action does. Calling
 * it as the table owner has no auth.uid() and is correctly refused.
 */
function attachSession(
  db: TestDb,
  userId: string,
  paymentId: string,
  sessionId: string,
) {
  return db.asUser(userId, (c) =>
    c.query("select public.attach_payment_checkout_session($1, $2);", [
      paymentId,
      sessionId,
    ]),
  );
}

interface StartRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  currency: string;
  stripe_account_id: string;
}

function startPayment(
  db: TestDb,
  userId: string,
  orderId: string,
  tip = 0,
): Promise<StartRow[]> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<StartRow>(
      "select * from public.start_order_payment($1, $2);",
      [orderId, tip],
    );
    return rows;
  });
}

describe("payments phase 2 — order_payments", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe("starting a payment", () => {
    it("derives the amount from the order, not from the caller", async () => {
      // The caller supplies only a tip. If the amount were ever accepted
      // as a parameter, a diner could pay 1p for a 100 pound meal — so the
      // charged amount must equal the order's own total, always.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);

      const { rows: orderRows } = await db.admin.query<{
        total: string;
        currency: string;
      }>("select total, currency from public.orders where id = $1;", [
        f.orderId,
      ]);

      const rows = await startPayment(db, f.customerUserId, f.orderId, 2.5);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].amount)).toBe(Number(orderRows[0].total));
      expect(Number(rows[0].tip_amount)).toBe(2.5);
      expect(Number(rows[0].total_amount)).toBe(
        Number(orderRows[0].total) + 2.5,
      );
      expect(rows[0].currency).toBe(orderRows[0].currency);
      expect(rows[0].stripe_account_id).toMatch(/^acct_/);
    });

    it("computes total_amount in the database, not in application code", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const rows = await startPayment(db, f.customerUserId, f.orderId, 3);

      // Generated column: even a direct write of the components cannot
      // make the charged total disagree with them.
      await db.admin.query(
        "update public.order_payments set tip_amount = 7 where id = $1;",
        [rows[0].payment_id],
      );
      const { rows: after } = await db.admin.query<{
        consistent: boolean;
        tip_amount: string;
      }>(
        `select (total_amount = amount + tip_amount) as consistent, tip_amount
         from public.order_payments where id = $1;`,
        [rows[0].payment_id],
      );
      // Compared in SQL against numeric, not in JS — asserting this with
      // JavaScript addition would reintroduce the float drift that
      // src/lib/payments/money.ts exists to keep out of money.
      expect(after[0].consistent).toBe(true);
      expect(Number(after[0].tip_amount)).toBe(7);
    });

    it("refuses a negative tip", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await expect(
        startPayment(db, f.customerUserId, f.orderId, -5),
      ).rejects.toThrow(/negative/i);
    });

    it("refuses a tip when the restaurant has tipping switched off", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId, { tipping: false });
      await expect(
        startPayment(db, f.customerUserId, f.orderId, 5),
      ).rejects.toThrow(/PAYMENT_TIPPING_DISABLED/);
    });

    it("refuses when the restaurant does not accept card", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await db.admin.query(
        "update public.restaurant_settings set accept_card = false where restaurant_id = $1;",
        [f.restaurantId],
      );
      await expect(
        startPayment(db, f.customerUserId, f.orderId),
      ).rejects.toThrow(/PAYMENT_CARD_NOT_ACCEPTED/);
    });

    it("refuses when the connected account cannot yet take charges", async () => {
      // Onboarding started but not finished. Sending a diner to Checkout
      // here would fail at Stripe with a much worse error.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId, { chargesEnabled: false });
      await expect(
        startPayment(db, f.customerUserId, f.orderId),
      ).rejects.toThrow(/PAYMENT_ACCOUNT_NOT_READY/);
    });

    it("refuses to pay for a cancelled order", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await db.admin.query(
        "update public.orders set status = 'cancelled', cancelled_at = now() where id = $1;",
        [f.orderId],
      );
      await expect(
        startPayment(db, f.customerUserId, f.orderId),
      ).rejects.toThrow(/PAYMENT_ORDER_CANCELLED/);
    });
  });

  describe("authorization", () => {
    it("refuses a diner paying for someone else's order", async () => {
      // SECURITY DEFINER bypasses RLS, so the function's own ownership
      // check is the entire access control here.
      const mine = await fullOrderFixture(db);
      const theirs = await fullOrderFixture(db);
      await enableCardPayments(db, theirs.restaurantId);

      await expect(
        startPayment(db, mine.customerUserId, theirs.orderId),
      ).rejects.toThrow(/PAYMENT_NOT_YOUR_ORDER/);
    });

    it("does not let a diner read another restaurant's payments", async () => {
      const mine = await fullOrderFixture(db);
      const theirs = await fullOrderFixture(db);
      await enableCardPayments(db, theirs.restaurantId);
      await startPayment(db, theirs.customerUserId, theirs.orderId);

      const visible = await db.asUser(mine.customerUserId, async (c) => {
        const { rows } = await c.query("select id from public.order_payments;");
        return rows.length;
      });
      expect(visible).toBe(0);
    });

    it("lets the paying diner and the restaurant's staff read the payment", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      await startPayment(db, f.customerUserId, f.orderId);

      const asDiner = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query("select id from public.order_payments;");
        return rows.length;
      });
      const asStaff = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query("select id from public.order_payments;");
        return rows.length;
      });
      expect(asDiner).toBe(1);
      expect(asStaff).toBe(1);
    });

    it("gives no client any write path to money", async () => {
      // Not even an owner. The only writers are the SECURITY DEFINER
      // functions and the webhook's service_role.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const rows = await startPayment(db, f.customerUserId, f.orderId);

      // With no UPDATE policy, RLS makes the row invisible to the
      // statement rather than raising: it silently matches nothing. That
      // is the actual protection, so assert it directly.
      await db.asUser(f.staffUserId, (c) =>
        c.query(
          "update public.order_payments set status = 'succeeded', paid_at = now() where id = $1;",
          [rows[0].payment_id],
        ),
      );

      const { rows: check } = await db.admin.query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [rows[0].payment_id],
      );
      expect(check[0].status).toBe("pending");
    });
  });

  describe("an order can never be paid twice", () => {
    it("rejects a second succeeded payment at the database level", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const first = await startPayment(db, f.customerUserId, f.orderId);
      await db.admin.query(
        `update public.order_payments set status = 'succeeded', paid_at = now(),
         stripe_checkout_session_id = 'cs_first' where id = $1;`,
        [first[0].payment_id],
      );

      // Bypassing every function and writing directly as the table owner —
      // the partial unique index must still refuse it.
      await expect(
        db.admin.query(
          `insert into public.order_payments
             (restaurant_id, order_id, status, amount, currency, paid_at)
           values ($1, $2, 'succeeded', 10, 'GBP', now());`,
          [f.restaurantId, f.orderId],
        ),
      ).rejects.toThrow(
        /order_payments_one_succeeded_per_order|duplicate key/i,
      );
    });

    it("refuses to start a new payment once one has succeeded", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const first = await startPayment(db, f.customerUserId, f.orderId);
      await db.admin.query(
        `update public.order_payments set status = 'succeeded', paid_at = now(),
         stripe_checkout_session_id = 'cs_paid_already' where id = $1;`,
        [first[0].payment_id],
      );

      await expect(
        startPayment(db, f.customerUserId, f.orderId),
      ).rejects.toThrow(/PAYMENT_ALREADY_PAID/);
    });

    it("still allows retrying after a failed attempt", async () => {
      // Declines are normal. Failed attempts must be able to accumulate,
      // which is why the uniqueness is partial rather than plain.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const first = await startPayment(db, f.customerUserId, f.orderId);
      await db.admin.query(
        `update public.order_payments set status = 'failed',
         stripe_checkout_session_id = 'cs_declined' where id = $1;`,
        [first[0].payment_id],
      );

      const second = await startPayment(db, f.customerUserId, f.orderId);
      expect(second).toHaveLength(1);
      expect(second[0].payment_id).not.toBe(first[0].payment_id);
    });
  });

  describe("settling from the webhook", () => {
    it("marks a payment succeeded and records when", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const p = await startPayment(db, f.customerUserId, f.orderId, 1.5);
      await attachSession(db, f.customerUserId, p[0].payment_id, "cs_ok_1");

      const { rows } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_order_payment_succeeded($1, $2) as ok;",
        ["cs_ok_1", "pi_ok_1"],
      );
      expect(rows[0].ok).toBe(true);

      const { rows: after } = await db.admin.query<{
        status: string;
        paid_at: string | null;
        stripe_payment_intent_id: string;
      }>(
        "select status, paid_at, stripe_payment_intent_id from public.order_payments where id = $1;",
        [p[0].payment_id],
      );
      expect(after[0].status).toBe("succeeded");
      expect(after[0].paid_at).not.toBeNull();
      expect(after[0].stripe_payment_intent_id).toBe("pi_ok_1");
    });

    it("is idempotent under webhook replay", async () => {
      // Stripe retries. A repeat must be a no-op returning success, not an
      // error — an error would make Stripe retry again, forever.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const p = await startPayment(db, f.customerUserId, f.orderId);
      await attachSession(db, f.customerUserId, p[0].payment_id, "cs_replay");

      await db.admin.query(
        "select public.mark_order_payment_succeeded($1, $2);",
        ["cs_replay", "pi_replay"],
      );
      const { rows: firstPaidAt } = await db.admin.query<{ paid_at: string }>(
        "select paid_at from public.order_payments where id = $1;",
        [p[0].payment_id],
      );

      const { rows: second } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_order_payment_succeeded($1, $2) as ok;",
        ["cs_replay", "pi_replay"],
      );
      expect(second[0].ok).toBe(true);

      const { rows: stillPaidAt } = await db.admin.query<{ paid_at: string }>(
        "select paid_at from public.order_payments where id = $1;",
        [p[0].payment_id],
      );
      // Not re-stamped: the first settlement time is the real one.
      expect(stillPaidAt[0].paid_at).toEqual(firstPaidAt[0].paid_at);

      const { rows: count } = await db.admin.query<{ count: string }>(
        "select count(*)::text as count from public.order_payments where order_id = $1;",
        [f.orderId],
      );
      expect(count[0].count).toBe("1");
    });

    it("reports an unknown session rather than throwing", async () => {
      // A webhook for a session this database has never seen must not 500,
      // or Stripe will retry it indefinitely.
      const { rows } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_order_payment_succeeded($1, $2) as ok;",
        ["cs_never_seen", "pi_never_seen"],
      );
      expect(rows[0].ok).toBe(false);
    });

    it("never downgrades a succeeded payment to failed", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const p = await startPayment(db, f.customerUserId, f.orderId);
      await attachSession(db, f.customerUserId, p[0].payment_id, "cs_settled");
      await db.admin.query(
        "select public.mark_order_payment_succeeded($1, $2);",
        ["cs_settled", "pi_settled"],
      );

      // An expiry event arriving late, after the payment already settled.
      await db.admin.query("select public.mark_order_payment_failed($1, $2);", [
        "cs_settled",
        "cancelled",
      ]);

      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [p[0].payment_id],
      );
      expect(rows[0].status).toBe("succeeded");
    });

    it("marks an abandoned checkout cancelled so the diner can retry", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const p = await startPayment(db, f.customerUserId, f.orderId);
      await attachSession(
        db,
        f.customerUserId,
        p[0].payment_id,
        "cs_abandoned",
      );

      await db.admin.query("select public.mark_order_payment_failed($1, $2);", [
        "cs_abandoned",
        "cancelled",
      ]);

      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [p[0].payment_id],
      );
      expect(rows[0].status).toBe("cancelled");
    });

    it("refuses a settlement status that is not a real terminal state", async () => {
      await expect(
        db.admin.query("select public.mark_order_payment_failed($1, $2);", [
          "cs_whatever",
          "succeeded",
        ]),
      ).rejects.toThrow(/Invalid terminal payment status/);
    });
  });

  describe("the public payment-settings read path", () => {
    it("says a card can be taken only when Stripe can actually charge it", async () => {
      // accept_card is what the restaurant switched on; charges_enabled is
      // whether Stripe agrees. Offering a Pay button on the first alone
      // would send diners to a checkout that can only fail.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId, { chargesEnabled: false });

      const before = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query<{ can_take_card: boolean }>(
          "select can_take_card from public.get_public_payment_settings($1);",
          [f.restaurantId],
        );
        return rows[0].can_take_card;
      });
      expect(before).toBe(false);

      await db.admin.query(
        "update public.restaurant_payment_accounts set charges_enabled = true where restaurant_id = $1;",
        [f.restaurantId],
      );
      const after = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query<{ can_take_card: boolean }>(
          "select can_take_card from public.get_public_payment_settings($1);",
          [f.restaurantId],
        );
        return rows[0].can_take_card;
      });
      expect(after).toBe(true);
    });

    it("is false for a restaurant with no connected account at all", async () => {
      const f = await fullOrderFixture(db);
      await db.admin.query(
        "update public.restaurant_settings set accept_card = true where restaurant_id = $1;",
        [f.restaurantId],
      );
      const rows = await db.asAnon(async (c) => {
        const { rows } = await c.query<{ can_take_card: boolean }>(
          "select can_take_card from public.get_public_payment_settings($1);",
          [f.restaurantId],
        );
        return rows;
      });
      expect(rows[0].can_take_card).toBe(false);
    });

    it("never exposes the connected account to a diner", async () => {
      // The function's whole purpose is to answer the question without
      // handing over the account, which is owner/manager-gated.
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);

      const cols = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query(
          "select * from public.get_public_payment_settings($1);",
          [f.restaurantId],
        );
        return Object.keys(rows[0] as Record<string, unknown>);
      });
      expect(cols.sort()).toEqual(["can_take_card", "tipping_enabled"]);

      const leaked = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query(
          "select stripe_account_id from public.restaurant_payment_accounts;",
        );
        return rows.length;
      });
      expect(leaked).toBe(0);
    });
  });

  describe("integrity constraints", () => {
    it("cannot mark a payment succeeded without recording when", async () => {
      const f = await fullOrderFixture(db);
      await enableCardPayments(db, f.restaurantId);
      const p = await startPayment(db, f.customerUserId, f.orderId);

      await expect(
        db.admin.query(
          "update public.order_payments set status = 'succeeded' where id = $1;",
          [p[0].payment_id],
        ),
      ).rejects.toThrow(/paid_at_matches_status/);
    });

    it("cannot attach a payment to another restaurant's order", async () => {
      const a = await fullOrderFixture(db);
      const b = await fullOrderFixture(db);
      await expect(
        db.admin.query(
          `insert into public.order_payments
             (restaurant_id, order_id, amount, currency)
           values ($1, $2, 10, 'GBP');`,
          [a.restaurantId, b.orderId],
        ),
      ).rejects.toThrow(/order_payments_order_same_restaurant/);
    });

    it("rejects two payments sharing a Stripe checkout session", async () => {
      const a = await fullOrderFixture(db);
      const b = await fullOrderFixture(db);
      await enableCardPayments(db, a.restaurantId);
      await enableCardPayments(db, b.restaurantId);
      const pa = await startPayment(db, a.customerUserId, a.orderId);
      const pb = await startPayment(db, b.customerUserId, b.orderId);

      await attachSession(db, a.customerUserId, pa[0].payment_id, "cs_shared");
      await expect(
        db.admin.query(
          "update public.order_payments set stripe_checkout_session_id = $2 where id = $1;",
          [pb[0].payment_id, "cs_shared"],
        ),
      ).rejects.toThrow(/checkout_session_key|duplicate key/i);
    });
  });
});
