// @vitest-environment node
//
// Payments phase 3, step 3 — refunds
// (supabase/migrations/20260902110000_refunds.sql).
//
// This is the first code that moves money outward, so the failure these
// tests are built around is the mirror of phase 2's double charge:
// refunding more than was ever taken.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

/** A settled card payment of `amount`, ready to be refunded. */
async function settledCardPayment(
  db: TestDb,
  restaurantId: string,
  orderId: string,
  amount = 20,
): Promise<string> {
  const { rows } = await db.admin.query<{ id: string }>(
    `insert into public.order_payments
       (restaurant_id, status, method, amount, currency, paid_at,
        stripe_checkout_session_id, stripe_payment_intent_id)
     values ($1, 'succeeded', 'card', $2, 'GBP', now(), $3, $4)
     returning id;`,
    [
      restaurantId,
      amount,
      `cs_${crypto.randomUUID().slice(0, 12)}`,
      `pi_${crypto.randomUUID().slice(0, 12)}`,
    ],
  );
  await db.admin.query(
    `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
     values ($1, $2, $3, $4);`,
    [rows[0].id, orderId, restaurantId, amount],
  );
  return rows[0].id;
}

interface RefundRow {
  refund_id: string;
  amount: string;
  currency: string;
  stripe_payment_intent_id: string;
  stripe_account_id: string;
}

function startRefund(
  db: TestDb,
  userId: string,
  paymentId: string,
  amount: number | null,
  reason = "dish returned",
): Promise<RefundRow[]> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<RefundRow>(
      "select * from public.start_refund($1, $2, $3);",
      [paymentId, amount, reason],
    );
    return rows;
  });
}

async function withAccount(db: TestDb, restaurantId: string) {
  await db.admin.query(
    `insert into public.restaurant_payment_accounts
       (restaurant_id, stripe_account_id, charges_enabled)
     values ($1, $2, true)
     on conflict (restaurant_id) do update set charges_enabled = true;`,
    [restaurantId, `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`],
  );
}

describe("refunds", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("opens a pending refund and returns what Stripe needs", async () => {
    const f = await fullOrderFixture(db);
    await withAccount(db, f.restaurantId);
    const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

    const r = await startRefund(db, f.staffUserId, pay, 5);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(5);
    // The refund must go back through the account the charge came from.
    expect(r[0].stripe_account_id).toMatch(/^acct_/);
    expect(r[0].stripe_payment_intent_id).toMatch(/^pi_/);
  });

  it("treats a null amount as whatever is left", async () => {
    const f = await fullOrderFixture(db);
    await withAccount(db, f.restaurantId);
    const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

    await startRefund(db, f.staffUserId, pay, 8);
    const rest = await startRefund(db, f.staffUserId, pay, null);
    expect(Number(rest[0].amount)).toBe(12);
  });

  describe("never gives back more than was taken", () => {
    it("refuses a refund larger than the payment", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

      await expect(startRefund(db, f.staffUserId, pay, 25)).rejects.toThrow(
        /REFUND_EXCEEDS_PAYMENT/,
      );
    });

    it("refuses partial refunds that together exceed the payment", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

      await startRefund(db, f.staffUserId, pay, 12);
      await startRefund(db, f.staffUserId, pay, 6);
      await expect(startRefund(db, f.staffUserId, pay, 5)).rejects.toThrow(
        /REFUND_EXCEEDS_PAYMENT/,
      );
    });

    it("counts a pending refund as committed", async () => {
      // A refund already asked of Stripe must not be refundable again just
      // because it has not settled yet.
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

      await startRefund(db, f.staffUserId, pay, 20);
      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.payment_refunds where payment_id = $1;",
        [pay],
      );
      expect(rows[0].status).toBe("pending");

      await expect(startRefund(db, f.staffUserId, pay, 1)).rejects.toThrow(
        /REFUND_NOTHING_LEFT|REFUND_EXCEEDS_PAYMENT/,
      );
    });

    it("enforces the limit even on a direct write", async () => {
      // The trigger is the guarantee; start_refund's own check is only for
      // a clearer message. Bypass the function entirely.
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);

      await expect(
        db.admin.query(
          `insert into public.payment_refunds
             (payment_id, restaurant_id, amount, currency, reason)
           values ($1, $2, 999, 'GBP', 'direct write');`,
          [pay, f.restaurantId],
        ),
      ).rejects.toThrow(/REFUND_EXCEEDS_PAYMENT/);
    });

    it("frees the amount again when a refund fails", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);
      const r = await startRefund(db, f.staffUserId, pay, 20);
      await db.admin.query(
        "update public.payment_refunds set status = 'failed' where id = $1;",
        [r[0].refund_id],
      );

      await expect(
        startRefund(db, f.staffUserId, pay, 20),
      ).resolves.toBeDefined();
    });
  });

  describe("who may refund", () => {
    it("allows a manager", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);

      await expect(startRefund(db, manager, pay, 5)).resolves.toBeDefined();
    });

    it("refuses a plain staff member", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const waiter = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);

      await expect(startRefund(db, waiter, pay, 5)).rejects.toThrow(
        /REFUND_FORBIDDEN/,
      );
    });

    it("refuses someone from another restaurant", async () => {
      const f = await fullOrderFixture(db);
      const other = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);

      await expect(startRefund(db, other.staffUserId, pay, 5)).rejects.toThrow(
        /REFUND_FORBIDDEN/,
      );
    });
  });

  describe("what can be refunded", () => {
    it("refuses a cash payment — that is a reversal", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const { rows } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments
           (restaurant_id, status, method, amount, currency, paid_at)
         values ($1, 'succeeded', 'cash', 10, 'GBP', now()) returning id;`,
        [f.restaurantId],
      );

      await expect(
        startRefund(db, f.staffUserId, rows[0].id, 5),
      ).rejects.toThrow(/REFUND_NOT_CARD/);
    });

    it("refuses a payment that never settled", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const { rows } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments
           (restaurant_id, status, method, amount, currency)
         values ($1, 'pending', 'card', 10, 'GBP') returning id;`,
        [f.restaurantId],
      );

      await expect(
        startRefund(db, f.staffUserId, rows[0].id, 5),
      ).rejects.toThrow(/REFUND_PAYMENT_NOT_SETTLED/);
    });

    it("requires a reason", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);

      await expect(
        startRefund(db, f.staffUserId, pay, 5, "  "),
      ).rejects.toThrow(/REFUND_REASON_REQUIRED/);
    });
  });

  describe("settling", () => {
    it("links the Stripe refund and marks it succeeded", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);
      const r = await startRefund(db, f.staffUserId, pay, 5);

      await db.asUser(f.staffUserId, (c) =>
        c.query("select public.attach_refund_stripe_id($1, $2, true);", [
          r[0].refund_id,
          "re_test_1",
        ]),
      );

      const { rows } = await db.admin.query<{
        status: string;
        refunded_at: string | null;
        stripe_refund_id: string;
      }>(
        "select status, refunded_at, stripe_refund_id from public.payment_refunds where id = $1;",
        [r[0].refund_id],
      );
      expect(rows[0].status).toBe("succeeded");
      expect(rows[0].refunded_at).not.toBeNull();
      expect(rows[0].stripe_refund_id).toBe("re_test_1");
    });

    it("refuses to repoint a refund at a different Stripe refund", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);
      const r = await startRefund(db, f.staffUserId, pay, 5);

      await db.asUser(f.staffUserId, (c) =>
        c.query("select public.attach_refund_stripe_id($1, $2, false);", [
          r[0].refund_id,
          "re_first",
        ]),
      );

      await expect(
        db.asUser(f.staffUserId, (c) =>
          c.query("select public.attach_refund_stripe_id($1, $2, false);", [
            r[0].refund_id,
            "re_second",
          ]),
        ),
      ).rejects.toThrow(/REFUND_ALREADY_LINKED/);
    });

    it("settles from a webhook and is idempotent", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);
      const r = await startRefund(db, f.staffUserId, pay, 5);
      await db.asUser(f.staffUserId, (c) =>
        c.query("select public.attach_refund_stripe_id($1, $2, false);", [
          r[0].refund_id,
          "re_async",
        ]),
      );

      const { rows: first } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_refund_settled($1, $2) as ok;",
        ["re_async", "succeeded"],
      );
      expect(first[0].ok).toBe(true);

      const { rows: at } = await db.admin.query<{ refunded_at: string }>(
        "select refunded_at from public.payment_refunds where id = $1;",
        [r[0].refund_id],
      );

      const { rows: again } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_refund_settled($1, $2) as ok;",
        ["re_async", "succeeded"],
      );
      expect(again[0].ok).toBe(true);

      const { rows: still } = await db.admin.query<{ refunded_at: string }>(
        "select refunded_at from public.payment_refunds where id = $1;",
        [r[0].refund_id],
      );
      expect(still[0].refunded_at).toEqual(at[0].refunded_at);
    });

    it("never downgrades a succeeded refund", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);
      const r = await startRefund(db, f.staffUserId, pay, 5);
      await db.asUser(f.staffUserId, (c) =>
        c.query("select public.attach_refund_stripe_id($1, $2, true);", [
          r[0].refund_id,
          "re_settled",
        ]),
      );

      await db.admin.query("select public.mark_refund_settled($1, $2);", [
        "re_settled",
        "failed",
      ]);

      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.payment_refunds where id = $1;",
        [r[0].refund_id],
      );
      expect(rows[0].status).toBe("succeeded");
    });

    it("reports an unknown refund rather than raising", async () => {
      // A 500 here would make Stripe retry the event forever.
      const { rows } = await db.admin.query<{ ok: boolean }>(
        "select public.mark_refund_settled($1, $2) as ok;",
        ["re_never_seen", "succeeded"],
      );
      expect(rows[0].ok).toBe(false);
    });
  });

  describe("the payment's own record", () => {
    it("stays succeeded after a full refund", async () => {
      // It DID succeed. Rewriting that would lose the difference between
      // "never paid" and "paid then refunded".
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId, 20);
      await startRefund(db, f.staffUserId, pay, 20);

      const { rows } = await db.admin.query<{
        status: string;
        refunded: string;
      }>(
        `select p.status, public.payment_refunded_total(p.id)::text as refunded
         from public.order_payments p where p.id = $1;`,
        [pay],
      );
      expect(rows[0].status).toBe("succeeded");
      expect(Number(rows[0].refunded)).toBe(20);
    });
  });

  describe("visibility", () => {
    it("is staff-only — the diner does not see refund reasons", async () => {
      const f = await fullOrderFixture(db);
      await withAccount(db, f.restaurantId);
      const pay = await settledCardPayment(db, f.restaurantId, f.orderId);
      await startRefund(db, f.staffUserId, pay, 5, "suspected card fraud");

      const asStaff = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query(
          "select id from public.payment_refunds;",
        );
        return rows.length;
      });
      const asDiner = await db.asUser(f.customerUserId, async (c) => {
        const { rows } = await c.query(
          "select id from public.payment_refunds;",
        );
        return rows.length;
      });

      expect(asStaff).toBe(1);
      expect(asDiner).toBe(0);
    });
  });
});
