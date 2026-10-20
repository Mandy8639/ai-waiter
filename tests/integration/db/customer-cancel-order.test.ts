// @vitest-environment node
//
// customer_cancel_order() (20261104090000): a diner cancels their own order
// while it is still "Order received", the kitchen hasn't accepted it, and
// no card payment covers it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createCustomerSession,
  fullOrderFixture,
  transitionOrderStatus,
} from "./helpers";

describe("customer_cancel_order()", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  function cancel(userId: string, orderId: string) {
    return db.asUser(userId, (c) =>
      c.query<{ status: string }>(
        "select status from public.customer_cancel_order($1);",
        [orderId],
      ),
    );
  }

  it("cancels the diner's own order while it's waiting, recorded as theirs", async () => {
    const f = await fullOrderFixture(db);
    const { rows } = await cancel(f.customerUserId, f.orderId);
    expect(rows[0].status).toBe("cancelled");

    const { rows: history } = await db.admin.query<{
      previous_status: string;
      status: string;
      actor_type: string;
      actor_id: string;
    }>(
      `select previous_status, status, actor_type, actor_id
       from public.order_status_history
       where order_id = $1 and status = 'cancelled';`,
      [f.orderId],
    );
    expect(history).toEqual([
      {
        previous_status: "pending",
        status: "cancelled",
        actor_type: "customer",
        actor_id: f.customerUserId,
      },
    ]);
  });

  it("is too late once the kitchen has accepted it", async () => {
    const f = await fullOrderFixture(db);
    await transitionOrderStatus(db, f.staffUserId, f.orderId, "confirmed");
    await expect(cancel(f.customerUserId, f.orderId)).rejects.toThrow(
      /ORDER_CANCEL_TOO_LATE/,
    );
  });

  it("says so when it's already cancelled", async () => {
    const f = await fullOrderFixture(db);
    await cancel(f.customerUserId, f.orderId);
    await expect(cancel(f.customerUserId, f.orderId)).rejects.toThrow(
      /ORDER_CANCEL_ALREADY/,
    );
  });

  it("refuses another diner, even at the same table", async () => {
    const f = await fullOrderFixture(db);
    const other = await createCustomerSession(db, f.restaurantId, f.tableId);
    await expect(cancel(other.userId, f.orderId)).rejects.toThrow(
      /ORDER_CANCEL_NOT_FOUND/,
    );
    // And staff use transition_order_status, not this.
    await expect(cancel(f.staffUserId, f.orderId)).rejects.toThrow(
      /ORDER_CANCEL_NOT_FOUND/,
    );
  });

  it.each(["pending", "succeeded"])(
    "refuses an order with a %s card payment: that needs a refund",
    async (status) => {
      const f = await fullOrderFixture(db);
      const { rows: pay } = await db.admin.query<{ id: string }>(
        `insert into public.order_payments (restaurant_id, status, amount, currency)
         values ($1, 'pending', 5, 'USD') returning id;`,
        [f.restaurantId],
      );
      await db.admin.query(
        `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
         values ($1, $2, $3, 5);`,
        [pay[0].id, f.orderId, f.restaurantId],
      );
      if (status === "succeeded") {
        await db.admin.query(
          "update public.order_payments set status = 'succeeded', paid_at = now() where id = $1;",
          [pay[0].id],
        );
      }
      await expect(cancel(f.customerUserId, f.orderId)).rejects.toThrow(
        /ORDER_CANCEL_PAID/,
      );
    },
  );

  it("allows it again after a failed payment", async () => {
    const f = await fullOrderFixture(db);
    const { rows: pay } = await db.admin.query<{ id: string }>(
      `insert into public.order_payments (restaurant_id, status, amount, currency)
       values ($1, 'failed', 5, 'USD') returning id;`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
       values ($1, $2, $3, 5);`,
      [pay[0].id, f.orderId, f.restaurantId],
    );
    const { rows } = await cancel(f.customerUserId, f.orderId);
    expect(rows[0].status).toBe("cancelled");
  });
});
