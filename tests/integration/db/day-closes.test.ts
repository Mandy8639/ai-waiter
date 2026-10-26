// @vitest-environment node
//
// End of day (20261116090000): what the drawer should hold, the closing
// report frozen at close, who may close, and printing it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

interface Summary {
  payments: {
    count: number;
    sales: number;
    tips: number;
    refunds: number;
    net: number;
  };
  by_method: { method: string; count: number; net: number }[];
  cash: { taken: number; refunded: number };
  adjustments: { discount: { count: number; amount: number } };
  staff: { email: string; count: number; cash: number }[];
}

describe("end of day", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /** A manager, a waiter, cash and card machine on; one order. */
  async function fixture() {
    const f = await fullOrderFixture(db, "manager");
    await db.admin.query(
      `update public.restaurant_settings
       set accept_cash = true, accept_card_terminal = true, tipping_enabled = true
       where restaurant_id = $1;`,
      [f.restaurantId],
    );
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    return { ...f, managerId: f.staffUserId, waiter };
  }

  const preview = (userId: string, restaurantId: string) =>
    db
      .asUser(userId, (c) =>
        c.query<{ p: { summary: Summary; last_float: string | null } }>(
          "select public.preview_day_close($1) as p;",
          [restaurantId],
        ),
      )
      .then((r) => r.rows[0].p);

  const close = (
    userId: string,
    restaurantId: string,
    float: number,
    counted: number,
  ) =>
    db
      .asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select public.close_day($1, $2, $3, 'Busy night') as id;",
          [restaurantId, float, counted],
        ),
      )
      .then((r) => r.rows[0].id);

  it("works out the drawer from the float, cash taken and cash handed back", async () => {
    const f = await fixture();
    const { rows: order } = await db.admin.query<{ total: string }>(
      "select total from public.orders where id = $1;",
      [f.orderId],
    );
    const total = Number(order[0].total);
    // The waiter takes cash with a $2 tip...
    const { rows: pay } = await db.asUser(f.waiter, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1, 'cash', 2) as id;",
        [[f.orderId]],
      ),
    );
    // ...and the manager hands $1 back.
    await db.asUser(f.managerId, (c) =>
      c.query("select * from public.start_refund($1, 1, 'Short a naan');", [
        pay[0].id,
      ]),
    );
    // A $0 comp payment is never sales.
    await db.admin.query(
      `insert into public.order_payments (restaurant_id, status, method, amount, currency, paid_at)
       values ($1, 'succeeded', 'comp', 0, 'USD', now());`,
      [f.restaurantId],
    );

    const live = await preview(f.managerId, f.restaurantId);
    expect(live.summary.cash).toEqual({ taken: total + 2, refunded: 1 });
    expect(live.summary.payments).toMatchObject({
      count: 1,
      tips: 2,
      refunds: 1,
    });
    expect(live.summary.staff).toHaveLength(1);
    expect(live.summary.staff[0]).toMatchObject({ count: 1, cash: total + 2 });

    const id = await close(f.managerId, f.restaurantId, 100, 100 + total);
    const { rows } = await db.admin.query<{
      expected_cash: string;
      over_short: string;
      note: string;
    }>(
      "select expected_cash, over_short, note from public.day_closes where id = $1;",
      [id],
    );
    // Expected 100 + total + 2 - 1; counted 100 + total: $1 short.
    expect(Number(rows[0].expected_cash)).toBeCloseTo(101 + total, 2);
    expect(rows[0].over_short).toBe("-1.00");
    expect(rows[0].note).toBe("Busy night");

    // The next day starts where this one ended, with the float remembered.
    const next = await preview(f.managerId, f.restaurantId);
    expect(next.summary.payments.count).toBe(0);
    expect(Number(next.last_float)).toBe(100);
  });

  it("keeps a closed day's report as it was", async () => {
    const f = await fixture();
    const { rows: pay } = await db.asUser(f.waiter, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1, 'cash', 0) as id;",
        [[f.orderId]],
      ),
    );
    const id = await close(f.managerId, f.restaurantId, 0, 0);
    // A refund the day after doesn't touch the closed day.
    await db.asUser(f.managerId, (c) =>
      c.query("select * from public.start_refund($1, 1, 'Late complaint');", [
        pay[0].id,
      ]),
    );
    const { rows } = await db.admin.query<{ summary: Summary }>(
      "select summary from public.day_closes where id = $1;",
      [id],
    );
    expect(rows[0].summary.payments.refunds).toBe(0);
  });

  it("is for owners and managers only, and so are past closes", async () => {
    const f = await fixture();
    await expect(close(f.waiter, f.restaurantId, 0, 0)).rejects.toThrow(
      /CLOSE_FORBIDDEN/,
    );
    await expect(preview(f.waiter, f.restaurantId)).rejects.toThrow(
      /CLOSE_FORBIDDEN/,
    );
    await close(f.managerId, f.restaurantId, 0, 0);
    const seen = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query(
            "select id from public.day_closes where restaurant_id = $1;",
            [f.restaurantId],
          ),
        )
        .then((r) => r.rows.length);
    expect(await seen(f.managerId)).toBe(1);
    expect(await seen(f.waiter)).toBe(0);
  });

  it("prints a close on the receipt printer, for managers", async () => {
    const f = await fixture();
    await db.asUser(f.managerId, (c) =>
      c.query(
        "select * from public.create_printer($1, 'Front', 'receipt', null, false);",
        [f.restaurantId],
      ),
    );
    const id = await close(f.managerId, f.restaurantId, 0, 0);
    const print = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query<{ n: number }>(
            "select public.request_print($1, 'day_close', null, null, null, $2) as n;",
            [f.restaurantId, id],
          ),
        )
        .then((r) => r.rows[0].n);
    expect(await print(f.managerId)).toBe(1);
    await expect(print(f.waiter)).rejects.toThrow(/PRINT_FORBIDDEN/);
    const { rows } = await db.admin.query<{
      kind: string;
      day_close_id: string;
    }>(
      "select kind, day_close_id from public.print_jobs where restaurant_id = $1 and kind = 'day_close';",
      [f.restaurantId],
    );
    expect(rows).toEqual([{ kind: "day_close", day_close_id: id }]);
  });
});
