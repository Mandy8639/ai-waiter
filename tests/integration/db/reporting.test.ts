// @vitest-environment node
//
// Reporting (supabase/migrations/20260902140000_reporting.sql).
//
// The failure mode here is not a crash — it is a confidently wrong number
// that someone reconciles a bank statement against. So most of these tests
// are about what must NOT be counted: abandoned checkouts, declined cards,
// cash reversed by a manager, refunded money, and another restaurant's
// takings entirely.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

const FROM = "2000-01-01T00:00:00Z";
const TO = "2100-01-01T00:00:00Z";

interface Summary {
  gross: string;
  refunded: string;
  refunds_pending: string;
  net: string;
  tips: string;
  payment_count: number;
  order_count: number;
  average_order_value: string;
}

function summary(db: TestDb, userId: string, restaurantId: string) {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<Summary>(
      "select * from public.get_takings_summary($1, $2, $3);",
      [restaurantId, FROM, TO],
    );
    return rows[0];
  });
}

/** A payment in a given state, covering one order. */
async function payment(
  db: TestDb,
  restaurantId: string,
  orderId: string,
  opts: {
    amount?: number;
    tip?: number;
    status?: string;
    method?: string;
    paid?: boolean;
  } = {},
): Promise<string> {
  const {
    amount = 20,
    tip = 0,
    status = "succeeded",
    method = "card",
    paid = status === "succeeded" || status === "reversed",
  } = opts;
  const { rows } = await db.admin.query<{ id: string }>(
    // reversed_at is required when status is 'reversed' — a reversal must
    // record when it happened (20260902100000).
    `insert into public.order_payments
       (restaurant_id, status, method, amount, tip_amount, currency, paid_at,
        stripe_payment_intent_id, reversed_at, reversal_reason)
     values ($1, $2, $3, $4, $5, 'GBP', case when $6 then now() else null end, $7,
             case when $2 = 'reversed' then now() else null end,
             case when $2 = 'reversed' then 'recorded in error' else null end)
     returning id;`,
    [
      restaurantId,
      status,
      method,
      amount,
      tip,
      paid,
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

describe("reporting", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe("what counts as taken", () => {
    it("counts a settled payment, with its tip", async () => {
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, { amount: 20, tip: 3 });

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.gross)).toBe(23);
      expect(Number(s.tips)).toBe(3);
      expect(Number(s.net)).toBe(23);
      expect(s.payment_count).toBe(1);
      expect(s.order_count).toBe(1);
    });

    it("ignores an abandoned checkout", async () => {
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, { status: "pending" });

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.gross)).toBe(0);
    });

    it("ignores a declined card", async () => {
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, { status: "failed" });

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.gross)).toBe(0);
    });

    it("ignores cash a manager reversed", async () => {
      // The trap: a reversed payment keeps its amount AND its paid_at, so
      // a report filtering on "has been paid" rather than on status would
      // count money the restaurant never had.
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, {
        method: "cash",
        status: "reversed",
        amount: 50,
      });

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.gross)).toBe(0);
    });

    it("never counts another restaurant's takings", async () => {
      const mine = await fullOrderFixture(db);
      const theirs = await fullOrderFixture(db);
      await payment(db, mine.restaurantId, mine.orderId, { amount: 10 });
      await payment(db, theirs.restaurantId, theirs.orderId, { amount: 999 });

      const s = await summary(db, mine.staffUserId, mine.restaurantId);
      expect(Number(s.gross)).toBe(10);
    });
  });

  describe("refunds", () => {
    it("deducts a settled refund from net but not from gross", async () => {
      const f = await fullOrderFixture(db);
      const pay = await payment(db, f.restaurantId, f.orderId, { amount: 20 });
      await db.admin.query(
        `insert into public.payment_refunds
           (payment_id, restaurant_id, amount, currency, reason, status, refunded_at)
         values ($1, $2, 5, 'GBP', 'dish returned', 'succeeded', now());`,
        [pay, f.restaurantId],
      );

      const s = await summary(db, f.staffUserId, f.restaurantId);
      // Gross is what was taken; net is what was kept. Both are reported
      // so neither has to be inferred.
      expect(Number(s.gross)).toBe(20);
      expect(Number(s.refunded)).toBe(5);
      expect(Number(s.net)).toBe(15);
    });

    it("shows a pending refund separately rather than in net", async () => {
      const f = await fullOrderFixture(db);
      const pay = await payment(db, f.restaurantId, f.orderId, { amount: 20 });
      await db.admin.query(
        `insert into public.payment_refunds
           (payment_id, restaurant_id, amount, currency, reason, status)
         values ($1, $2, 8, 'GBP', 'in flight', 'pending');`,
        [pay, f.restaurantId],
      );

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.refunds_pending)).toBe(8);
      expect(Number(s.refunded)).toBe(0);
      // Not yet deducted — the money has not actually gone.
      expect(Number(s.net)).toBe(20);
    });

    it("ignores a failed refund entirely", async () => {
      const f = await fullOrderFixture(db);
      const pay = await payment(db, f.restaurantId, f.orderId, { amount: 20 });
      await db.admin.query(
        `insert into public.payment_refunds
           (payment_id, restaurant_id, amount, currency, reason, status)
         values ($1, $2, 5, 'GBP', 'failed at stripe', 'failed');`,
        [pay, f.restaurantId],
      );

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.refunded)).toBe(0);
      expect(Number(s.net)).toBe(20);
    });
  });

  describe("tabs", () => {
    it("counts one payment covering several orders once, and its orders separately", async () => {
      const f = await fullOrderFixture(db);
      const second = await db.admin.query<{ id: string }>(
        `insert into public.orders
           (restaurant_id, table_id, customer_session_id, order_number,
            status, subtotal, total, currency, idempotency_key)
         values ($1, $2, $3, 99, 'served', 15, 15, 'GBP', $4)
         returning id;`,
        [f.restaurantId, f.tableId, f.sessionId, crypto.randomUUID()],
      );

      const { rows } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments
           (restaurant_id, status, method, amount, currency, paid_at)
         values ($1, 'succeeded', 'card', 35, 'GBP', now()) returning id;`,
        [f.restaurantId],
      );
      await db.admin.query(
        `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
         values ($1, $2, $3, 20), ($1, $4, $3, 15);`,
        [rows[0].id, f.orderId, f.restaurantId, second.rows[0].id],
      );

      const s = await summary(db, f.staffUserId, f.restaurantId);
      expect(Number(s.gross)).toBe(35);
      expect(s.payment_count).toBe(1);
      // Two orders settled by one payment — counted distinctly.
      expect(s.order_count).toBe(2);
    });
  });

  describe("by payment method", () => {
    it("splits card and cash", async () => {
      const f = await fullOrderFixture(db);
      const other = await db.admin.query<{ id: string }>(
        `insert into public.orders
           (restaurant_id, table_id, customer_session_id, order_number,
            status, subtotal, total, currency, idempotency_key)
         values ($1, $2, $3, 98, 'served', 30, 30, 'GBP', $4)
         returning id;`,
        [f.restaurantId, f.tableId, f.sessionId, crypto.randomUUID()],
      );
      await payment(db, f.restaurantId, f.orderId, { amount: 20 });
      await payment(db, f.restaurantId, other.rows[0].id, {
        amount: 30,
        method: "cash",
      });

      const rows = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query<{
          method: string;
          gross: string;
          net: string;
        }>("select * from public.get_takings_by_method($1, $2, $3);", [
          f.restaurantId,
          FROM,
          TO,
        ]);
        return rows;
      });

      expect(rows.map((r) => r.method)).toEqual(["card", "cash"]);
      expect(Number(rows[0].gross)).toBe(20);
      expect(Number(rows[1].gross)).toBe(30);
    });
  });

  describe("payment history", () => {
    it("includes failed attempts — that is what the question usually is", async () => {
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, { status: "failed" });

      const rows = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query<{ status: string }>(
          "select * from public.get_payment_history($1, $2, $3);",
          [f.restaurantId, FROM, TO],
        );
        return rows;
      });
      expect(rows.map((r) => r.status)).toContain("failed");
    });

    it("carries the order numbers a payment settled", async () => {
      const f = await fullOrderFixture(db);
      await payment(db, f.restaurantId, f.orderId, { amount: 20 });

      const rows = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query<{ order_numbers: number[] }>(
          "select * from public.get_payment_history($1, $2, $3);",
          [f.restaurantId, FROM, TO],
        );
        return rows;
      });
      expect(rows[0].order_numbers.length).toBe(1);
    });

    it("refuses an absurd page size", async () => {
      const f = await fullOrderFixture(db);
      await expect(
        db.asUser(f.staffUserId, (c) =>
          c.query("select * from public.get_payment_history($1, $2, $3, $4);", [
            f.restaurantId,
            FROM,
            TO,
            5000,
          ]),
        ),
      ).rejects.toThrow(/REPORT_INVALID_LIMIT/);
    });
  });

  describe("best sellers", () => {
    it("counts served orders regardless of payment", async () => {
      // A dish served is a dish sold; menu decisions should not wait on
      // the till.
      const f = await fullOrderFixture(db);
      const rows = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query<{
          item_name: string;
          quantity_sold: string;
        }>("select * from public.get_best_selling_items($1, $2, $3);", [
          f.restaurantId,
          FROM,
          TO,
        ]);
        return rows;
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(Number(rows[0].quantity_sold)).toBeGreaterThan(0);
    });

    it("excludes cancelled orders — nothing was sold", async () => {
      const f = await fullOrderFixture(db);
      await db.admin.query(
        "update public.orders set status = 'cancelled', cancelled_at = now() where id = $1;",
        [f.orderId],
      );

      const rows = await db.asUser(f.staffUserId, async (c) => {
        const { rows } = await c.query(
          "select * from public.get_best_selling_items($1, $2, $3);",
          [f.restaurantId, FROM, TO],
        );
        return rows;
      });
      expect(rows.length).toBe(0);
    });
  });

  describe("who may see takings", () => {
    it("allows an owner and a manager", async () => {
      const f = await fullOrderFixture(db);
      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");

      await expect(
        summary(db, f.staffUserId, f.restaurantId),
      ).resolves.toBeDefined();
      await expect(summary(db, manager, f.restaurantId)).resolves.toBeDefined();
    });

    it("refuses a waiter and the kitchen", async () => {
      const f = await fullOrderFixture(db);
      const waiter = await db.createAuthUser();
      const kitchen = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");
      await addMember(db, f.restaurantId, kitchen, "kitchen");

      await expect(summary(db, waiter, f.restaurantId)).rejects.toThrow(
        /REPORT_FORBIDDEN/,
      );
      await expect(summary(db, kitchen, f.restaurantId)).rejects.toThrow(
        /REPORT_FORBIDDEN/,
      );
    });

    it("refuses someone from another restaurant", async () => {
      const mine = await fullOrderFixture(db);
      const theirs = await fullOrderFixture(db);

      await expect(
        summary(db, theirs.staffUserId, mine.restaurantId),
      ).rejects.toThrow(/REPORT_FORBIDDEN/);
    });

    it("raises rather than returning nothing, so a permissions problem is not a quiet day", async () => {
      const f = await fullOrderFixture(db);
      const waiter = await db.createAuthUser();
      await addMember(db, f.restaurantId, waiter, "staff");
      await payment(db, f.restaurantId, f.orderId, { amount: 20 });

      // The distinction that matters: not "gross = 0", but an error.
      await expect(summary(db, waiter, f.restaurantId)).rejects.toThrow(
        /REPORT_FORBIDDEN/,
      );
    });
  });

  describe("time ranges", () => {
    it("is half-open, so consecutive days never double-count", async () => {
      const f = await fullOrderFixture(db);
      const pay = await payment(db, f.restaurantId, f.orderId, { amount: 20 });
      await db.admin.query(
        "update public.order_payments set paid_at = '2026-06-15T00:00:00Z' where id = $1;",
        [pay],
      );

      const read = (from: string, to: string) =>
        db.asUser(f.staffUserId, async (c) => {
          const { rows } = await c.query<Summary>(
            "select * from public.get_takings_summary($1, $2, $3);",
            [f.restaurantId, from, to],
          );
          return Number(rows[0].gross);
        });

      const dayBefore = await read(
        "2026-06-14T00:00:00Z",
        "2026-06-15T00:00:00Z",
      );
      const theDay = await read("2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z");

      // Lands exactly on the boundary: counted once, by the later day.
      expect(dayBefore).toBe(0);
      expect(theDay).toBe(20);
    });
  });
});
