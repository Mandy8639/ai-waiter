// @vitest-environment node
//
// Voids, comps and discounts (20261113090000): who may, what they do to an
// order's totals, how payments then charge the new total, and the $0 comp
// payment that settles an order brought to nothing.
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

interface Totals {
  subtotal: string;
  discount_total: string;
  tax: string;
  service_charge: string;
  total: string;
}

describe("order adjustments", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /** Three $10 dishes at 10% tax: subtotal 30, tax 3, total 33. */
  async function orderFixture(role: Role = "manager") {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set tax_rate = 0.10, service_charge = 0 where id = $1;",
      [restaurantId],
    );
    await db.admin.query(
      "update public.restaurant_settings set accept_cash = true where restaurant_id = $1;",
      [restaurantId],
    );
    const managerId = await db.createAuthUser();
    await addMember(db, restaurantId, managerId, role);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId, {
      price: 10,
    });
    const { userId: customerId, sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const cartId = await createCart(db, restaurantId, sessionId);
    await addCartItem(db, customerId, cartId, restaurantId, menuItemId, {
      quantity: 3,
      unitPrice: 10,
    });
    const order = await submitOrder(db, customerId, crypto.randomUUID());
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.order_items where order_id = $1;",
      [order.id],
    );
    return {
      restaurantId,
      managerId,
      customerId,
      orderId: order.id,
      itemId: rows[0].id,
    };
  }

  const totals = async (orderId: string) =>
    (
      await db.admin.query<Totals>(
        "select subtotal, discount_total, tax, service_charge, total from public.orders where id = $1;",
        [orderId],
      )
    ).rows[0];

  const adjust = (
    userId: string,
    args: {
      orderId: string;
      kind: "void" | "comp" | "discount";
      reason?: string;
      itemId?: string | null;
      quantity?: number | null;
      percent?: number | null;
      amount?: number | null;
    },
  ) =>
    db
      .asUser(userId, (c) =>
        c.query<{ id: string }>(
          "select public.adjust_order($1, $2, $3, $4, $5, $6, $7) as id;",
          [
            args.orderId,
            args.kind,
            args.reason ?? "Quality issue",
            args.itemId ?? null,
            args.quantity ?? null,
            args.percent ?? null,
            args.amount ?? null,
          ],
        ),
      )
      .then((r) => r.rows[0].id);

  const compPayments = async (orderId: string) =>
    (
      await db.admin.query<{ status: string; amount: string }>(
        `select p.status, p.amount from public.order_payments p
         join public.payment_orders po on po.payment_id = p.id
         where po.order_id = $1 and p.method = 'comp' order by p.created_at;`,
        [orderId],
      )
    ).rows;

  it("comps a dish and rescales the tax to what's left", async () => {
    const f = await orderFixture();
    expect(await totals(f.orderId)).toMatchObject({
      subtotal: "30.00",
      tax: "3.00",
      total: "33.00",
    });
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "comp",
      itemId: f.itemId,
      quantity: 1,
    });
    expect(await totals(f.orderId)).toMatchObject({
      subtotal: "30.00",
      discount_total: "10.00",
      tax: "2.00",
      total: "22.00",
    });
  });

  it("takes a percentage or an amount off what's left, never more", async () => {
    const f = await orderFixture();
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "void",
      itemId: f.itemId,
      quantity: 1,
      reason: "Entered by mistake",
    });
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "discount",
      percent: 10,
      reason: "Regular guest",
    });
    // 10% of the $20 left.
    expect(await totals(f.orderId)).toMatchObject({
      discount_total: "12.00",
      tax: "1.80",
      total: "19.80",
    });
    await expect(
      adjust(f.managerId, {
        orderId: f.orderId,
        kind: "discount",
        amount: 18.01,
      }),
    ).rejects.toThrow(/ADJUST_INVALID/);
    await expect(
      adjust(f.managerId, {
        orderId: f.orderId,
        kind: "comp",
        itemId: f.itemId,
        quantity: 3,
      }),
    ).rejects.toThrow(/only 2 of that dish left/);
  });

  it("is for owners and managers only", async () => {
    const f = await orderFixture();
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const outsider = await db.createAuthUser();
    for (const user of [waiter, outsider, f.customerId]) {
      await expect(
        adjust(user, { orderId: f.orderId, kind: "discount", percent: 50 }),
      ).rejects.toThrow(/ADJUST_FORBIDDEN/);
    }
  });

  it("is what a payment then charges", async () => {
    const f = await orderFixture();
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "discount",
      amount: 5,
      reason: "Service recovery",
    });
    const { rows } = await db.asUser(f.managerId, (c) =>
      c.query<{ id: string }>(
        "select public.record_in_person_payment($1, 'cash', 0) as id;",
        [[f.orderId]],
      ),
    );
    const { rows: paid } = await db.admin.query<{ amount: string }>(
      "select amount from public.order_payments where id = $1;",
      [rows[0].id],
    );
    // (30 - 5) + 10% tax.
    expect(paid[0].amount).toBe("27.50");
  });

  it("can't change an order a payment has started on or finished", async () => {
    const f = await orderFixture();
    await db.asUser(f.managerId, (c) =>
      c.query("select public.record_in_person_payment($1, 'cash', 0);", [
        [f.orderId],
      ]),
    );
    await expect(
      adjust(f.managerId, {
        orderId: f.orderId,
        kind: "discount",
        percent: 10,
      }),
    ).rejects.toThrow(/ADJUST_PAYMENT_STARTED/);
  });

  it("settles an order brought to nothing with a $0 comp payment, and undoing reverses it", async () => {
    const f = await orderFixture();
    const id = await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "discount",
      percent: 100,
      reason: "Walked out",
    });
    expect((await totals(f.orderId)).total).toBe("0.00");
    expect(await compPayments(f.orderId)).toEqual([
      { status: "succeeded", amount: "0.00" },
    ]);
    // Nothing left to take: the order already counts as paid.
    await expect(
      db.asUser(f.managerId, (c) =>
        c.query("select public.record_in_person_payment($1, 'cash', 0);", [
          [f.orderId],
        ]),
      ),
    ).rejects.toThrow();

    await db.asUser(f.managerId, (c) =>
      c.query("select public.remove_order_adjustment($1);", [id]),
    );
    expect((await totals(f.orderId)).total).toBe("33.00");
    expect(await compPayments(f.orderId)).toEqual([
      { status: "reversed", amount: "0.00" },
    ]);
    const { rows } = await db.admin.query<{ removed_at: string | null }>(
      "select removed_at from public.order_adjustments where id = $1;",
      [id],
    );
    expect(rows[0].removed_at).not.toBeNull();
  });

  it("still won't let anyone else rewrite an order's totals", async () => {
    const f = await orderFixture();
    await expect(
      db.admin.query("update public.orders set total = 1 where id = $1;", [
        f.orderId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.query(
        "update public.orders set discount_total = 5 where id = $1;",
        [f.orderId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.asUser(f.managerId, (c) =>
        c.query("select public.recalculate_order_totals($1);", [f.orderId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("shows staff the adjustments, and gives Square comped dishes at no charge", async () => {
    const f = await orderFixture();
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "comp",
      itemId: f.itemId,
      quantity: 1,
    });
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "discount",
      amount: 2,
      reason: "Promotion",
    });
    const waiter = await db.createAuthUser();
    await addMember(db, f.restaurantId, waiter, "staff");
    const { rows: seen } = await db.asUser(waiter, (c) =>
      c.query<{ kind: string }>(
        "select kind from public.order_adjustments where order_id = $1 order by created_at;",
        [f.orderId],
      ),
    );
    expect(seen.map((r) => r.kind)).toEqual(["comp", "discount"]);

    const { rows: payment } = await db.admin.query<{ id: string }>(
      `insert into public.order_payments (restaurant_id, status, method, amount, tip_amount, currency)
       select restaurant_id, 'pending', 'card', total, 0, currency from public.orders where id = $1
       returning id;`,
      [f.orderId],
    );
    await db.admin.query(
      `insert into public.payment_orders (payment_id, order_id, restaurant_id, amount)
       select $1, id, restaurant_id, total from public.orders where id = $2;`,
      [payment[0].id, f.orderId],
    );
    const { rows: lines } = await db.asUser(waiter, (c) =>
      c.query<{
        item_name: string;
        quantity: number;
        line_total: string;
        order_discount: string;
      }>(
        "select item_name, quantity, line_total, order_discount from public.payment_bill_lines($1);",
        [payment[0].id],
      ),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ quantity: 2, line_total: "20.00" });
    expect(lines[1].item_name).toMatch(/\(comped\)$/);
    expect(lines[1]).toMatchObject({ quantity: 1, line_total: "0.00" });
    expect(lines[0].order_discount).toBe("2.00");
  });

  it("lists only unpaid orders on Settle up, and only to the restaurant's people", async () => {
    const f = await orderFixture();
    const list = (userId: string) =>
      db
        .asUser(userId, (c) =>
          c.query<{ id: string; discount_total: string }>(
            "select id, discount_total from public.settle_up_orders($1, now() - interval '1 day');",
            [f.restaurantId],
          ),
        )
        .then((r) => r.rows);
    expect((await list(f.managerId)).map((r) => r.id)).toEqual([f.orderId]);
    const outsider = await db.createAuthUser();
    expect(await list(outsider)).toEqual([]);
    await adjust(f.managerId, {
      orderId: f.orderId,
      kind: "comp",
      itemId: f.itemId,
      quantity: 3,
    });
    // Comped to nothing: settled, so gone.
    expect(await list(f.managerId)).toEqual([]);
  });
});
