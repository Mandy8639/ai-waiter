// @vitest-environment node
//
// Batch 5's order engine: submit_order() (see
// supabase/migrations/20260823100600_submit_order_function.sql) is the
// single entry point from a cart to an order. These tests exercise it
// against real Postgres semantics (via PGlite — see setup.ts) rather than
// assuming the SQL is correct: pricing/tax/service-charge calculation,
// price/modifier snapshotting, stale-cart revalidation, idempotency,
// order-number allocation, RLS-based order access, and the explicit
// hostile-customer scenarios from the spec.
//
// A note on "concurrency" tests: this harness's PGlite instance is a
// single connection (see setup.ts's own header comment) — there is no way
// to make two transactions genuinely overlap from this test file. What IS
// tested: (1) the *logical* idempotency guarantee — two sequential calls
// with the same key produce one order, not two — which is what actually
// matters for the "double-tap" scenario the spec describes, and (2) that
// the underlying `orders_unique_idempotency_per_session` /
// `orders_unique_order_number_per_restaurant` unique constraints exist and
// reject a duplicate even via a raw admin-level insert, independent of
// submit_order()'s own idempotency handling — that constraint is the real
// backstop under true concurrent load on a real Postgres server, which
// Postgres's row-level locking guarantees regardless of what this
// single-connection harness can directly exercise.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addCartItemModifier,
  addMember,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createModifier,
  createModifierOption,
  createRestaurant,
  createTable,
  fullCustomerFixture,
  submitOrder,
  type Role,
} from "./helpers";

describe("submit_order() happy path", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("creates an order from a cart with correct totals, an order number, and a status-history row", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        quantity: 2,
        unitPrice: 9.99,
      },
    );

    const order = await submitOrder(db, fx.userId, "order-1");

    expect(order.status).toBe("pending");
    expect(order.order_number).toBe(1);
    expect(Number(order.subtotal)).toBeCloseTo(19.98, 2);
    expect(Number(order.total)).toBeCloseTo(19.98, 2);
    expect(order.currency).toBe("USD");

    const { rows: history } = await db.admin.query<{
      status: string;
      actor_type: string;
      actor_id: string;
    }>(
      "select status, actor_type, actor_id from public.order_status_history where order_id = $1;",
      [order.id],
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "pending",
      actor_type: "customer",
      actor_id: fx.userId,
    });
  });

  it("computes tax and service charge from the restaurant's current rates", async () => {
    const fx = await fullCustomerFixture(db);
    await db.admin.query(
      "update public.restaurants set tax_rate = 0.08, service_charge = 0.10 where id = $1;",
      [fx.restaurantId],
    );
    // submit_order() always re-reads the menu item's CURRENT price rather
    // than the cart's cached one, so the underlying menu_items row (not
    // just the cart_items snapshot) has to reflect the $100 price.
    await db.admin.query(
      "update public.menu_items set price = 100 where id = $1;",
      [fx.menuItemId],
    );
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        unitPrice: 100,
      },
    );

    const order = await submitOrder(db, fx.userId, "order-tax");

    expect(Number(order.subtotal)).toBeCloseTo(100, 2);
    expect(Number(order.tax)).toBeCloseTo(8, 2);
    expect(Number(order.service_charge)).toBeCloseTo(10, 2);
    expect(Number(order.total)).toBeCloseTo(118, 2);
  });

  it("prices modifiers into the order and snapshots their names", async () => {
    const fx = await fullCustomerFixture(db);
    const modifierId = await createModifier(
      db,
      fx.restaurantId,
      fx.menuItemId,
      "Size",
    );
    const optionId = await createModifierOption(db, modifierId, {
      name: "Large",
      priceAdjustment: 2.5,
    });
    const cartItemId = await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      { unitPrice: 9.99, modifiersPrice: 2.5 },
    );
    await addCartItemModifier(
      db,
      fx.userId,
      cartItemId,
      fx.restaurantId,
      modifierId,
      optionId,
      { name: "Large", priceAdjustment: 2.5 },
    );

    const order = await submitOrder(db, fx.userId, "order-modifier");
    expect(Number(order.subtotal)).toBeCloseTo(12.49, 2);

    const { rows: items } = await db.admin.query<{
      id: string;
      modifier_total: number;
    }>(
      "select id, modifier_total from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(Number(items[0].modifier_total)).toBeCloseTo(2.5, 2);

    const { rows: modifiers } = await db.admin.query<{
      modifier_group_name: string;
      modifier_option_name: string;
      price_adjustment: number;
    }>(
      "select modifier_group_name, modifier_option_name, price_adjustment from public.order_item_modifiers where order_item_id = $1;",
      [items[0].id],
    );
    expect(modifiers).toHaveLength(1);
    expect(modifiers[0].modifier_group_name).toBe("Size");
    expect(modifiers[0].modifier_option_name).toBe("Large");
    expect(Number(modifiers[0].price_adjustment)).toBeCloseTo(2.5, 2);
  });

  it("clears the submitted cart's items but keeps the carts row itself", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);

    await submitOrder(db, fx.userId, "order-clear");

    const { rows: items } = await db.admin.query(
      "select id from public.cart_items where cart_id = $1;",
      [fx.cartId],
    );
    expect(items).toHaveLength(0);

    const { rows: cart } = await db.admin.query(
      "select id from public.carts where id = $1;",
      [fx.cartId],
    );
    expect(cart).toHaveLength(1);
  });

  it("a second cart round after ordering can be submitted as a new order", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const first = await submitOrder(db, fx.userId, "order-round-1");

    // Customer keeps browsing and orders dessert.
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        quantity: 1,
      },
    );
    const second = await submitOrder(db, fx.userId, "order-round-2");

    expect(second.id).not.toBe(first.id);
    expect(second.order_number).toBe(first.order_number + 1);
  });
});

describe("submit_order() price/availability revalidation (stale cart)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("uses the CURRENT menu price, not the price cached in the cart at add-time", async () => {
    const fx = await fullCustomerFixture(db);
    // Cart item was added when the price was $8 — see cart_items.unit_price.
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        unitPrice: 8,
      },
    );
    // The restaurant has since raised the price to $10.
    await db.admin.query(
      "update public.menu_items set price = 10 where id = $1;",
      [fx.menuItemId],
    );

    const order = await submitOrder(db, fx.userId, "order-stale-price");
    expect(Number(order.subtotal)).toBeCloseTo(10, 2);

    const { rows: items } = await db.admin.query<{ unit_price: number }>(
      "select unit_price from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(Number(items[0].unit_price)).toBeCloseTo(10, 2);
  });

  it("fails safely (no order created) when an item became unavailable after being added to the cart", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [fx.menuItemId],
    );

    await expect(
      submitOrder(db, fx.userId, "order-unavailable"),
    ).rejects.toThrow(/ORDER_ITEM_UNAVAILABLE/);

    const { rows: orders } = await db.admin.query(
      "select id from public.orders where customer_session_id = $1;",
      [fx.sessionId],
    );
    expect(orders).toHaveLength(0);
    // The cart is untouched — a failed submission doesn't corrupt it.
    const { rows: items } = await db.admin.query(
      "select id from public.cart_items where cart_id = $1;",
      [fx.cartId],
    );
    expect(items).toHaveLength(1);
  });

  it("fails safely when the item's category was deactivated", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await db.admin.query(
      "update public.categories set is_active = false where id = $1;",
      [fx.categoryId],
    );

    await expect(
      submitOrder(db, fx.userId, "order-cat-inactive"),
    ).rejects.toThrow(/ORDER_ITEM_UNAVAILABLE/);
  });

  it("fails safely when a selected modifier option became unavailable", async () => {
    const fx = await fullCustomerFixture(db);
    const modifierId = await createModifier(db, fx.restaurantId, fx.menuItemId);
    const optionId = await createModifierOption(db, modifierId, {
      name: "Extra Chutney",
    });
    const cartItemId = await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
    );
    await addCartItemModifier(
      db,
      fx.userId,
      cartItemId,
      fx.restaurantId,
      modifierId,
      optionId,
    );

    await db.admin.query(
      "update public.modifier_options set is_available = false where id = $1;",
      [optionId],
    );

    await expect(
      submitOrder(db, fx.userId, "order-modifier-gone"),
    ).rejects.toThrow(/ORDER_MODIFIER_UNAVAILABLE/);
  });

  it("fails safely when a modifier group became required after the cart was built (invalid selection count)", async () => {
    const fx = await fullCustomerFixture(db);
    // Optional group, nothing selected at add-time — valid then.
    const modifierId = await createModifier(
      db,
      fx.restaurantId,
      fx.menuItemId,
      "Add-ons",
    );
    await createModifierOption(db, modifierId);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);

    // The restaurant makes it required after the fact.
    await db.admin.query(
      "update public.menu_item_modifiers set is_required = true, min_selections = 1 where id = $1;",
      [modifierId],
    );

    await expect(
      submitOrder(db, fx.userId, "order-modifier-now-required"),
    ).rejects.toThrow(/ORDER_MODIFIER_INVALID/);
  });
});

describe("submit_order() snapshot immutability", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("order_items.item_name/unit_price never change when the menu item is later renamed/repriced", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        unitPrice: 9.99,
      },
    );
    const order = await submitOrder(db, fx.userId, "order-immutable");

    await db.admin.query(
      "update public.menu_items set name = 'Renamed Item', price = 999 where id = $1;",
      [fx.menuItemId],
    );

    const { rows: items } = await db.admin.query<{
      item_name: string;
      unit_price: number;
    }>(
      "select item_name, unit_price from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(items[0].item_name).not.toBe("Renamed Item");
    expect(Number(items[0].unit_price)).toBeCloseTo(9.99, 2);
  });

  it("order_items.menu_item_id is nulled (not the row itself) if the menu item is later deleted, and the snapshot survives", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(
      db,
      fx.userId,
      fx.cartId,
      fx.restaurantId,
      fx.menuItemId,
      {
        unitPrice: 9.99,
      },
    );
    const order = await submitOrder(db, fx.userId, "order-item-deleted");

    await db.admin.query("delete from public.menu_items where id = $1;", [
      fx.menuItemId,
    ]);

    const { rows: items } = await db.admin.query<{
      menu_item_id: string | null;
      item_name: string;
      unit_price: number;
    }>(
      "select menu_item_id, item_name, unit_price from public.order_items where order_id = $1;",
      [order.id],
    );
    expect(items).toHaveLength(1);
    expect(items[0].menu_item_id).toBeNull();
    expect(Number(items[0].unit_price)).toBeCloseTo(9.99, 2);
  });

  it("no client role can UPDATE an order (status/total/etc. are immutable in this batch)", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "order-no-update");

    // With no UPDATE policy at all, RLS doesn't raise an error here — the
    // row simply isn't updatable, so the statement matches zero rows
    // (the same way an UPDATE ... WHERE matching nothing would behave).
    // What actually matters, and what this asserts, is that the total is
    // provably unchanged afterward.
    const result = await db.asUser(fx.userId, (c) =>
      c.query("update public.orders set total = 0 where id = $1;", [order.id]),
    );
    expect(result.affectedRows).toBe(0);

    const { rows } = await db.admin.query<{ total: number }>(
      "select total from public.orders where id = $1;",
      [order.id],
    );
    expect(Number(rows[0].total)).toBeCloseTo(Number(order.total), 2);
    expect(Number(rows[0].total)).not.toBe(0);
  });

  it("no client role can INSERT an order directly (only submit_order() can)", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.orders (restaurant_id, table_id, customer_session_id, order_number, currency, idempotency_key) values ($1, $2, $3, 999, 'USD', 'forged');",
          [fx.restaurantId, fx.tableId, fx.sessionId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe("submit_order() idempotency", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("a repeated call with the same idempotency key returns the SAME order instead of creating a second one", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);

    const first = await submitOrder(db, fx.userId, "double-tap-key");
    // The cart is now empty — a naive retry re-running full validation
    // would fail with ORDER_CART_EMPTY. The idempotency fast path must
    // short-circuit before that.
    const second = await submitOrder(db, fx.userId, "double-tap-key");

    expect(second.id).toBe(first.id);
    expect(second.order_number).toBe(first.order_number);

    const { rows: orders } = await db.admin.query(
      "select id from public.orders where customer_session_id = $1 and idempotency_key = $2;",
      [fx.sessionId, "double-tap-key"],
    );
    expect(orders).toHaveLength(1);
  });

  it("the unique constraint backing idempotency rejects a duplicate (session, key) even via a raw insert — the real concurrency backstop", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "constraint-backstop");

    await expect(
      db.admin.query(
        "insert into public.orders (restaurant_id, table_id, customer_session_id, order_number, currency, idempotency_key) values ($1, $2, $3, $4, 'USD', 'constraint-backstop');",
        [fx.restaurantId, fx.tableId, fx.sessionId, order.order_number + 100],
      ),
    ).rejects.toThrow(/unique/i);
  });

  it("different customer sessions may reuse the same idempotency key text — the constraint is scoped per session", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);
    await addCartItem(db, a.userId, a.cartId, a.restaurantId, a.menuItemId);
    await addCartItem(db, b.userId, b.cartId, b.restaurantId, b.menuItemId);

    const orderA = await submitOrder(db, a.userId, "shared-key");
    const orderB = await submitOrder(db, b.userId, "shared-key");

    expect(orderA.id).not.toBe(orderB.id);
  });
});

describe("submit_order() input and state validation", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("rejects a caller with no active customer session", async () => {
    const userId = await db.createAuthUser();
    await expect(submitOrder(db, userId, "no-session")).rejects.toThrow(
      /ORDER_NO_SESSION/,
    );
  });

  it("rejects an empty cart", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(submitOrder(db, fx.userId, "empty-cart")).rejects.toThrow(
      /ORDER_CART_EMPTY/,
    );
  });

  it("rejects when the restaurant is inactive", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await db.admin.query(
      "update public.restaurants set is_active = false where id = $1;",
      [fx.restaurantId],
    );

    await expect(
      submitOrder(db, fx.userId, "restaurant-inactive"),
    ).rejects.toThrow(/ORDER_RESTAURANT_UNAVAILABLE/);
  });

  it("rejects when the restaurant has paused accepting orders", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await db.admin.query(
      "update public.restaurant_settings set accepting_orders = false where restaurant_id = $1;",
      [fx.restaurantId],
    );

    await expect(submitOrder(db, fx.userId, "not-accepting")).rejects.toThrow(
      /ORDER_RESTAURANT_UNAVAILABLE/,
    );
  });

  it("rejects a blank idempotency key", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await expect(submitOrder(db, fx.userId, "   ")).rejects.toThrow(
      /ORDER_INVALID_INPUT/,
    );
  });

  it("rejects an idempotency key over 100 characters", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await expect(submitOrder(db, fx.userId, "x".repeat(101))).rejects.toThrow(
      /ORDER_INVALID_INPUT/,
    );
  });

  it("rejects a customer note over 500 characters", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    await expect(
      submitOrder(db, fx.userId, "order-long-note", "x".repeat(501)),
    ).rejects.toThrow(/ORDER_INVALID_INPUT/);
  });
});

describe("submit_order() customer notes policy", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("stores a customer note when the restaurant allows notes", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);

    const order = await submitOrder(
      db,
      fx.userId,
      "order-note",
      "Extra spicy please.",
    );
    expect(order.customer_note).toBe("Extra spicy please.");
  });

  it("silently drops a note when the restaurant has disabled customer notes, rather than failing the order", async () => {
    const fx = await fullCustomerFixture(db);
    await db.admin.query(
      "update public.restaurant_settings set allow_customer_notes = false where restaurant_id = $1;",
      [fx.restaurantId],
    );
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);

    const order = await submitOrder(
      db,
      fx.userId,
      "order-note-disabled",
      "Ignored note",
    );
    expect(order.customer_note).toBeNull();
  });
});

describe("order numbers", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("allocates sequential order numbers per restaurant, starting at 1", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const numbers: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { userId, sessionId } = await createCustomerSession(
        db,
        restaurantId,
        tableId,
      );
      const cartId = await createCart(db, restaurantId, sessionId);
      await addCartItem(db, userId, cartId, restaurantId, menuItemId);
      const order = await submitOrder(db, userId, `seq-${i}`);
      numbers.push(order.order_number);
    }

    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(numbers).size).toBe(5);
  });

  it("order numbers are independent per restaurant (restaurant B also starts at 1)", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);
    await addCartItem(db, a.userId, a.cartId, a.restaurantId, a.menuItemId);
    await addCartItem(db, b.userId, b.cartId, b.restaurantId, b.menuItemId);

    const orderA = await submitOrder(db, a.userId, "restaurant-a-first");
    const orderB = await submitOrder(db, b.userId, "restaurant-b-first");

    expect(orderA.order_number).toBe(1);
    expect(orderB.order_number).toBe(1);
  });

  it("the unique constraint prevents a duplicate order_number within the same restaurant, even via a raw insert", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "order-number-collision-a");

    await expect(
      db.admin.query(
        "insert into public.orders (restaurant_id, table_id, customer_session_id, order_number, currency, idempotency_key) values ($1, $2, $3, $4, 'USD', 'order-number-collision-b');",
        [fx.restaurantId, fx.tableId, fx.sessionId, order.order_number],
      ),
    ).rejects.toThrow(/unique/i);
  });
});

describe("order access: customers", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("a customer can read their own order", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "own-order");

    const { rows } = await db.asUser(fx.userId, (c) =>
      c.query("select id from public.orders where id = $1;", [order.id]),
    );
    expect(rows).toHaveLength(1);
  });

  it("a customer can read their own order's items and modifiers", async () => {
    const fx = await fullCustomerFixture(db);
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "own-order-items");

    const { rows: items } = await db.asUser(fx.userId, (c) =>
      c.query("select id from public.order_items where order_id = $1;", [
        order.id,
      ]),
    );
    expect(items).toHaveLength(1);

    const { rows: history } = await db.asUser(fx.userId, (c) =>
      c.query(
        "select id from public.order_status_history where order_id = $1;",
        [order.id],
      ),
    );
    expect(history).toHaveLength(1);
  });

  it("a DIFFERENT customer (even at the same restaurant/table) cannot read someone else's order", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    const session1 = await createCustomerSession(db, restaurantId, tableId);
    const cart1 = await createCart(db, restaurantId, session1.sessionId);
    await addCartItem(db, session1.userId, cart1, restaurantId, menuItemId);
    const order = await submitOrder(db, session1.userId, "table-shared-order");

    const session2 = await createCustomerSession(db, restaurantId, tableId);

    const { rows } = await db.asUser(session2.userId, (c) =>
      c.query("select id from public.orders where id = $1;", [order.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("Restaurant A's customer cannot read Restaurant B's order (cross-tenant)", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);
    await addCartItem(db, b.userId, b.cartId, b.restaurantId, b.menuItemId);
    const orderB = await submitOrder(db, b.userId, "cross-tenant-order");

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.orders where id = $1;", [orderB.id]),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("order access: restaurant staff", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function fixtureWithStaff(role: Role) {
    const fx = await fullCustomerFixture(db);
    const staffUserId = await db.createAuthUser();
    await addMember(db, fx.restaurantId, staffUserId, role);
    return { ...fx, staffUserId };
  }

  it("an owner can read every order placed at their own restaurant", async () => {
    const fx = await fixtureWithStaff("owner");
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "staff-visible-order");

    const { rows } = await db.asUser(fx.staffUserId, (c) =>
      c.query("select id from public.orders where id = $1;", [order.id]),
    );
    expect(rows).toHaveLength(1);
  });

  it("kitchen and staff roles can also read orders (read access isn't owner/manager-only)", async () => {
    for (const role of ["kitchen", "staff"] as Role[]) {
      const fx = await fixtureWithStaff(role);
      await addCartItem(
        db,
        fx.userId,
        fx.cartId,
        fx.restaurantId,
        fx.menuItemId,
      );
      const order = await submitOrder(db, fx.userId, `role-${role}`);

      const { rows } = await db.asUser(fx.staffUserId, (c) =>
        c.query("select id from public.orders where id = $1;", [order.id]),
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("Restaurant A's staff cannot read Restaurant B's orders (cross-tenant staff attack)", async () => {
    const a = await fixtureWithStaff("owner");
    const b = await fullCustomerFixture(db);
    await addCartItem(db, b.userId, b.cartId, b.restaurantId, b.menuItemId);
    const orderB = await submitOrder(db, b.userId, "staff-cross-tenant");

    const { rows } = await db.asUser(a.staffUserId, (c) =>
      c.query("select id from public.orders where id = $1;", [orderB.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("no client role — customer or staff — can write to order_status_history directly", async () => {
    const fx = await fixtureWithStaff("owner");
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "status-history-locked");

    await expect(
      db.asUser(fx.staffUserId, (c) =>
        c.query(
          "insert into public.order_status_history (restaurant_id, order_id, status, actor_type, actor_id) values ($1, $2, 'confirmed', 'staff', $3);",
          [fx.restaurantId, order.id, fx.staffUserId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("even the order's OWN restaurant's staff (owner role) cannot UPDATE it — there is no UPDATE policy for anyone in this batch", async () => {
    const fx = await fixtureWithStaff("owner");
    await addCartItem(db, fx.userId, fx.cartId, fx.restaurantId, fx.menuItemId);
    const order = await submitOrder(db, fx.userId, "staff-no-update-either");

    const result = await db.asUser(fx.staffUserId, (c) =>
      c.query("update public.orders set status = 'confirmed' where id = $1;", [
        order.id,
      ]),
    );
    expect(result.affectedRows).toBe(0);

    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.orders where id = $1;",
      [order.id],
    );
    expect(rows[0].status).toBe("pending");
  });
});
