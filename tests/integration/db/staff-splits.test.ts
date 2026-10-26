// @vitest-environment node
//
// Staff splits on Settle up (20261115090000): splitting a table's orders,
// paying parts in cash, on the card machine or a Square Terminal, and the
// orders counting as paid only once every part is.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createRestaurant,
  createTable,
  submitOrder,
  type Role,
} from "./helpers";

interface Unit {
  id: string;
  label: string;
  amount: string;
  status: string;
}

describe("staff splits", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /**
   * One order at 10% tax: 2 × $10 dish and 1 × $5 dish. Subtotal 25,
   * tax 2.50, total 27.50.
   */
  async function fixture(role: Role = "staff") {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set tax_rate = 0.10, service_charge = 0 where id = $1;",
      [restaurantId],
    );
    await db.admin.query(
      `update public.restaurant_settings
       set accept_cash = true, accept_card_terminal = true, tipping_enabled = true
       where restaurant_id = $1;`,
      [restaurantId],
    );
    const staffId = await db.createAuthUser();
    await addMember(db, restaurantId, staffId, role);
    const managerId = await db.createAuthUser();
    await addMember(db, restaurantId, managerId, "manager");
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const curry = await createMenuItem(db, restaurantId, categoryId, {
      name: "Curry",
      slug: `curry-${crypto.randomUUID().slice(0, 6)}`,
      price: 10,
    });
    const lassi = await createMenuItem(db, restaurantId, categoryId, {
      name: "Lassi",
      slug: `lassi-${crypto.randomUUID().slice(0, 6)}`,
      price: 5,
    });
    const { userId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const cartId = await createCart(db, restaurantId, sessionId);
    await addCartItem(db, userId, cartId, restaurantId, curry, {
      quantity: 2,
      unitPrice: 10,
    });
    await addCartItem(db, userId, cartId, restaurantId, lassi, {
      quantity: 1,
      unitPrice: 5,
    });
    const order = await submitOrder(db, userId, crypto.randomUUID());
    return { restaurantId, staffId, managerId, orderId: order.id };
  }

  const split = (
    userId: string,
    orderIds: string[],
    mode: "equal" | "by_dish",
    shares: number | null = null,
  ) =>
    db
      .asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select public.create_staff_split($1, $2, $3) as id;",
          [orderIds, mode, shares],
        ),
      )
      .then((r) => r.rows[0].id);

  const units = async (splitId: string) =>
    (
      await db.admin.query<Unit>(
        "select id, label, amount, status from public.tab_split_units where split_id = $1 order by position;",
        [splitId],
      )
    ).rows;

  const pay = (
    userId: string,
    splitId: string,
    unitIds: string[],
    method: "cash" | "card_terminal" = "cash",
    tip = 0,
  ) =>
    db
      .asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select public.pay_split_in_person($1, $2, $3, $4) as id;",
          [splitId, unitIds, method, tip],
        ),
      )
      .then((r) => r.rows[0].id);

  const unpaid = async (userId: string, restaurantId: string) =>
    (
      await db.asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select id from public.settle_up_orders($1, now() - interval '1 day');",
          [restaurantId],
        ),
      )
    ).rows.map((r) => r.id);

  it("splits three ways to the cent, and the orders count as paid only with the last part", async () => {
    const f = await fixture();
    const id = await split(f.staffId, [f.orderId], "equal", 3);
    const parts = await units(id);
    expect(parts.map((u) => u.amount)).toEqual(["9.17", "9.17", "9.16"]);

    await pay(f.staffId, id, [parts[0].id], "cash", 1);
    await pay(f.staffId, id, [parts[1].id], "card_terminal");
    expect(await unpaid(f.staffId, f.restaurantId)).toEqual([f.orderId]);

    await pay(f.staffId, id, [parts[2].id]);
    expect(await unpaid(f.staffId, f.restaurantId)).toEqual([]);

    // Coverage adds up: each payment's rows to what it charged, the
    // order's rows to its total.
    const { rows } = await db.admin.query<{ sum: string }>(
      "select sum(amount) as sum from public.payment_orders where order_id = $1;",
      [f.orderId],
    );
    expect(rows[0].sum).toBe("27.50");
    const { rows: s } = await db.admin.query<{ status: string }>(
      "select status from public.tab_splits where id = $1;",
      [id],
    );
    expect(s[0].status).toBe("paid");
  });

  it("splits by dish after a comp and a discount, with every part positive and the sum exact", async () => {
    const f = await fixture();
    const { rows: items } = await db.admin.query<{
      id: string;
      item_name: string;
    }>(
      "select id, item_name from public.order_items where order_id = $1 order by item_name;",
      [f.orderId],
    );
    const curry = items.find((i) => i.item_name === "Curry")!;
    await db.asUser(f.managerId, (c) =>
      c.query(
        "select public.adjust_order($1, 'comp', 'Long wait', $2, 1, null, null);",
        [f.orderId, curry.id],
      ),
    );
    // $3 off is more than the tax left, so the order adds less than its
    // dishes: the case that used to make a part negative.
    await db.asUser(f.managerId, (c) =>
      c.query(
        "select public.adjust_order($1, 'discount', 'Promotion', null, null, null, 3);",
        [f.orderId],
      ),
    );
    const { rows: order } = await db.admin.query<{ total: string }>(
      "select total from public.orders where id = $1;",
      [f.orderId],
    );
    // (25 - 10 - 3) = 12, tax 1.20: 13.20.
    expect(order[0].total).toBe("13.20");

    const id = await split(f.staffId, [f.orderId], "by_dish");
    const parts = await units(id);
    expect(parts.map((u) => u.label)).toEqual(["Curry", "Lassi"]);
    expect(parts.every((u) => Number(u.amount) > 0)).toBe(true);
    expect(parts.reduce((s, u) => s + Number(u.amount), 0)).toBeCloseTo(
      13.2,
      2,
    );
  });

  it("keeps every other payment off the orders while the split is open, and cancels only an untouched one", async () => {
    const f = await fixture();
    const id = await split(f.staffId, [f.orderId], "equal", 2);
    await expect(
      db.asUser(f.staffId, (c) =>
        c.query("select public.record_in_person_payment($1, 'cash', 0);", [
          [f.orderId],
        ]),
      ),
    ).rejects.toThrow();
    await expect(split(f.staffId, [f.orderId], "equal", 2)).rejects.toThrow(
      /SPLIT_ALREADY_OPEN/,
    );

    const parts = await units(id);
    await pay(f.staffId, id, [parts[0].id]);
    const cancel = () =>
      db.asUser(f.staffId, (c) =>
        c.query("select public.cancel_staff_split($1);", [id]),
      );
    await expect(cancel()).rejects.toThrow(/SPLIT_STARTED/);
    await expect(pay(f.staffId, id, [parts[0].id])).rejects.toThrow(
      /SPLIT_PART_TAKEN/,
    );

    const other = await fixture();
    const fresh = await split(other.staffId, [other.orderId], "equal", 2);
    await db.asUser(other.staffId, (c) =>
      c.query("select public.cancel_staff_split($1);", [fresh]),
    );
    // The orders are free to pay normally again.
    await db.asUser(other.staffId, (c) =>
      c.query("select public.record_in_person_payment($1, 'cash', 0);", [
        [other.orderId],
      ]),
    );
  });

  it("is front of house only, and shows the split to the restaurant's people", async () => {
    const f = await fixture("kitchen");
    await expect(split(f.staffId, [f.orderId], "equal", 2)).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );
    const outsider = await db.createAuthUser();
    await expect(split(outsider, [f.orderId], "equal", 2)).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );

    const id = await split(f.managerId, [f.orderId], "equal", 2);
    const list = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query<{ s: { id: string; by_staff: boolean }[] }>(
            "select public.settle_up_splits($1) as s;",
            [f.restaurantId],
          ),
        )
        .then((r) => r.rows[0].s);
    expect(await list(f.staffId)).toMatchObject([{ id, by_staff: true }]);
    expect(await list(outsider)).toEqual([]);
  });

  it("pays parts on a Square Terminal, settled by Square like any Terminal payment", async () => {
    const f = await fixture();
    await db.admin.query(
      "update public.restaurant_settings set accept_card = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, is_enabled, payments_enabled)
       values ($1, 'square', 'LOC1', true, true);`,
      [f.restaurantId],
    );
    await db.admin.query(
      `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
       values ($1, 'square', 'M1', 'v1.a.b.c');`,
      [f.restaurantId],
    );
    const id = await split(f.staffId, [f.orderId], "equal", 2);
    const parts = await units(id);

    const start = () =>
      db
        .asUser(f.staffId, (c) =>
          c.query<{ payment_id: string; amount: string; label: string }>(
            "select * from public.start_split_terminal_payment($1, $2);",
            [id, [parts[0].id]],
          ),
        )
        .then((r) => r.rows[0]);

    // Cancelled on the Terminal: the part is free again.
    const first = await start();
    expect(first).toMatchObject({ amount: "13.75", label: "Share 1 of 2" });
    await db.asUser(f.staffId, (c) =>
      c.query("select public.cancel_square_terminal_payment($1);", [
        first.payment_id,
      ]),
    );
    expect((await units(id))[0].status).toBe("open");

    // Paid with a $2 tip added on the device.
    const second = await start();
    await db.asUser(f.staffId, (c) =>
      c.query("select public.attach_square_terminal_checkout($1, $2, $3);", [
        second.payment_id,
        "SQORDER1",
        "TC1",
      ]),
    );
    const { rows } = await db.admin.query<{ r: string }>(
      "select public.settle_square_payment('SQORDER1', 'SQPAY1', 1575, 200, 'USD') as r;",
    );
    expect(rows[0].r).toBe("settled");
    expect((await units(id))[0].status).toBe("paid");
  });
});
