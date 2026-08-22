// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createModifier,
  createModifierOption,
  createRestaurant,
  createTable,
  fullCustomerFixture,
  getTablePublicToken,
} from "./helpers";

describe("table QR tokens", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("generates a unique public_token per table by default", async () => {
    const restaurantId = await createRestaurant(db);
    const tableAId = await createTable(db, restaurantId);
    const tableBId = await createTable(db, restaurantId);

    const tokenA = await getTablePublicToken(db, tableAId);
    const tokenB = await getTablePublicToken(db, tableBId);

    expect(tokenA).not.toBe(tokenB);
  });

  it("get_table_by_token resolves a valid active token", async () => {
    const restaurantId = await createRestaurant(db, { slug: "resolve-test" });
    const tableId = await createTable(db, restaurantId, "5");
    const token = await getTablePublicToken(db, tableId);

    const { rows } = await db.admin.query<{
      table_id: string;
      restaurant_slug: string;
      table_number: string;
    }>("select * from public.get_table_by_token($1);", [token]);

    expect(rows).toHaveLength(1);
    expect(rows[0].table_id).toBe(tableId);
    expect(rows[0].restaurant_slug).toBe("resolve-test");
    expect(rows[0].table_number).toBe("5");
  });

  it("get_table_by_token returns nothing for an unknown/random token", async () => {
    const { rows } = await db.admin.query(
      "select * from public.get_table_by_token('00000000-0000-0000-0000-000000000000');",
    );
    expect(rows).toHaveLength(0);
  });

  it("get_table_by_token returns nothing for an INACTIVE table", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const token = await getTablePublicToken(db, tableId);
    await db.admin.query(
      "update public.tables set is_active = false where id = $1;",
      [tableId],
    );

    const { rows } = await db.admin.query(
      "select * from public.get_table_by_token($1);",
      [token],
    );
    expect(rows).toHaveLength(0);
  });

  it("get_table_by_token returns nothing when the RESTAURANT is inactive, even if the table itself is active", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const token = await getTablePublicToken(db, tableId);
    await db.admin.query(
      "update public.restaurants set is_active = false where id = $1;",
      [restaurantId],
    );

    const { rows } = await db.admin.query(
      "select * from public.get_table_by_token($1);",
      [token],
    );
    expect(rows).toHaveLength(0);
  });

  it("is callable by anon (no session at all) — this is the whole point of the function", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const token = await getTablePublicToken(db, tableId);

    const { rows } = await db.asAnon((c) =>
      c.query("select * from public.get_table_by_token($1);", [token]),
    );
    expect(rows).toHaveLength(1);
  });

  it("regenerating a table's token invalidates the old one immediately", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const oldToken = await getTablePublicToken(db, tableId);

    await db.admin.query(
      "update public.tables set public_token = gen_random_uuid() where id = $1;",
      [tableId],
    );
    const newToken = await getTablePublicToken(db, tableId);

    expect(newToken).not.toBe(oldToken);

    const oldLookup = await db.admin.query(
      "select * from public.get_table_by_token($1);",
      [oldToken],
    );
    expect(oldLookup.rows).toHaveLength(0);

    const newLookup = await db.admin.query(
      "select * from public.get_table_by_token($1);",
      [newToken],
    );
    expect(newLookup.rows).toHaveLength(1);
  });

  it("there is no general SELECT policy exposing tables' tokens in bulk to anon", async () => {
    const restaurantId = await createRestaurant(db);
    await createTable(db, restaurantId);

    const { rows } = await db.asAnon((c) =>
      c.query(
        "select public_token from public.tables where restaurant_id = $1;",
        [restaurantId],
      ),
    );
    // anon has no SELECT policy on `tables` at all — the token lookup only
    // works through get_table_by_token(), never a direct table read.
    expect(rows).toHaveLength(0);
  });
});

describe("customer session creation and isolation", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("a customer can create their own session", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const userId = await db.createAuthUser();

    const result = await db.asUser(userId, (c) =>
      c.query(
        "insert into public.customer_sessions (restaurant_id, table_id, user_id, expires_at) values ($1, $2, $3, now() + interval '4 hours');",
        [restaurantId, tableId, userId],
      ),
    );
    expect(result.affectedRows).toBe(1);
  });

  it("a customer cannot create a session claiming to be a DIFFERENT user", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const userId = await db.createAuthUser();
    const otherUserId = await db.createAuthUser();

    await expect(
      db.asUser(userId, (c) =>
        c.query(
          "insert into public.customer_sessions (restaurant_id, table_id, user_id, expires_at) values ($1, $2, $3, now() + interval '4 hours');",
          [restaurantId, tableId, otherUserId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("rejects a session whose table doesn't belong to its own restaurant_id (composite FK)", async () => {
    const a = await createRestaurant(db);
    const b = await createRestaurant(db);
    const bTableId = await createTable(db, b);

    await expect(
      db.admin.query(
        "insert into public.customer_sessions (restaurant_id, table_id, user_id, expires_at) values ($1, $2, $3, now() + interval '4 hours');",
        [a, bTableId, await db.createAuthUser()],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a customer cannot read another customer's session", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { sessionId } = await createCustomerSession(
      db,
      restaurantId,
      tableId,
    );
    const otherUserId = await db.createAuthUser();

    const { rows } = await db.asUser(otherUserId, (c) =>
      c.query("select id from public.customer_sessions where id = $1;", [
        sessionId,
      ]),
    );
    expect(rows).toHaveLength(0);
  });

  it("a customer cannot relocate their session to a different table (relocation-prevention trigger)", async () => {
    const restaurantId = await createRestaurant(db);
    const tableAId = await createTable(db, restaurantId);
    const tableBId = await createTable(db, restaurantId);
    const { userId } = await createCustomerSession(db, restaurantId, tableAId);

    await expect(
      db.asUser(userId, (c) =>
        c.query(
          "update public.customer_sessions set table_id = $1 where user_id = $2;",
          [tableBId, userId],
        ),
      ),
    ).rejects.toThrow(/cannot change after creation/i);
  });

  it("a customer cannot relocate their session to a different restaurant", async () => {
    const restaurantAId = await createRestaurant(db);
    const restaurantBId = await createRestaurant(db);
    const tableAId = await createTable(db, restaurantAId);
    const { userId } = await createCustomerSession(db, restaurantAId, tableAId);

    await expect(
      db.asUser(userId, (c) =>
        c.query(
          "update public.customer_sessions set restaurant_id = $1 where user_id = $2;",
          [restaurantBId, userId],
        ),
      ),
    ).rejects.toThrow(/cannot change after creation/i);
  });

  it("a customer CAN update their own last_active_at/status (non-relocating fields)", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const { userId } = await createCustomerSession(db, restaurantId, tableId);

    const result = await db.asUser(userId, (c) =>
      c.query(
        "update public.customer_sessions set last_active_at = now() where user_id = $1;",
        [userId],
      ),
    );
    expect(result.affectedRows).toBe(1);
  });
});

describe("public menu retrieval (customer browsing)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("an anonymous customer can read an active restaurant's available menu items", async () => {
    const restaurantId = await createRestaurant(db);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);

    const { rows } = await db.asAnon((c) =>
      c.query("select id from public.menu_items where id = $1;", [menuItemId]),
    );
    expect(rows).toHaveLength(1);
  });

  it("an anonymous customer cannot read an UNAVAILABLE menu item", async () => {
    const restaurantId = await createRestaurant(db);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [menuItemId],
    );

    const { rows } = await db.asAnon((c) =>
      c.query("select id from public.menu_items where id = $1;", [menuItemId]),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("cart price calculation and validation (DB-level constraints)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("a customer can add a correctly-priced item to their own cart", async () => {
    const fx = await fullCustomerFixture(db);

    const result = await db.asUser(fx.userId, (c) =>
      c.query(
        "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 2, 9.99, 19.98);",
        [fx.cartId, fx.restaurantId, fx.menuItemId],
      ),
    );
    expect(result.affectedRows).toBe(1);
  });

  it("rejects a zero quantity", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 0, 9.99, 0);",
          [fx.cartId, fx.restaurantId, fx.menuItemId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a quantity above the sanity cap (99)", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 100, 9.99, 999);",
          [fx.cartId, fx.restaurantId, fx.menuItemId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a negative unit_price (a malicious client trying to submit price = 0.01 style tampering)", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, -5, 0);",
          [fx.cartId, fx.restaurantId, fx.menuItemId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a negative line_total", async () => {
    const fx = await fullCustomerFixture(db);
    await expect(
      db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, 5, -5);",
          [fx.cartId, fx.restaurantId, fx.menuItemId],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("allows a negative modifier price_adjustment (a discount modifier)", async () => {
    const fx = await fullCustomerFixture(db);
    const modifierId = await createModifier(db, fx.restaurantId, fx.menuItemId);
    const optionId = await createModifierOption(db, modifierId, {
      priceAdjustment: -2,
    });

    const { rows: cartItemRows } = await db.asUser(fx.userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, modifiers_price, line_total) values ($1, $2, $3, 1, 9.99, -2, 7.99) returning id;",
        [fx.cartId, fx.restaurantId, fx.menuItemId],
      ),
    );

    const result = await db.asUser(fx.userId, (c) =>
      c.query(
        "insert into public.cart_item_modifiers (cart_item_id, restaurant_id, modifier_id, modifier_option_id, name, price_adjustment) values ($1, $2, $3, $4, 'No Cheese', -2);",
        [cartItemRows[0].id, fx.restaurantId, modifierId, optionId],
      ),
    );
    expect(result.affectedRows).toBe(1);
  });
});

describe("cross-tenant cart attacks", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("Restaurant A's customer cannot read Restaurant B's cart", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.carts where id = $1;", [b.cartId]),
    );
    expect(rows).toHaveLength(0);
  });

  it("a customer session for Table 1 cannot see the cart of a session for Table 2 at the SAME restaurant", async () => {
    const restaurantId = await createRestaurant(db);
    const table1Id = await createTable(db, restaurantId, "1");
    const table2Id = await createTable(db, restaurantId, "2");
    const session1 = await createCustomerSession(db, restaurantId, table1Id);
    const session2 = await createCustomerSession(db, restaurantId, table2Id);
    const cart2Id = await createCart(db, restaurantId, session2.sessionId);

    const { rows } = await db.asUser(session1.userId, (c) =>
      c.query("select id from public.carts where id = $1;", [cart2Id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects a cart_item whose menu_item belongs to a different restaurant than the cart", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);

    await expect(
      db.asUser(a.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, 9.99, 9.99);",
          [a.cartId, a.restaurantId, b.menuItemId],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects a cart_item_modifier whose modifier group belongs to a different restaurant", async () => {
    const a = await fullCustomerFixture(db);
    const b = await fullCustomerFixture(db);
    const bModifierId = await createModifier(db, b.restaurantId, b.menuItemId);
    const bOptionId = await createModifierOption(db, bModifierId);

    const { rows: cartItemRows } = await db.asUser(a.userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, 9.99, 9.99) returning id;",
        [a.cartId, a.restaurantId, a.menuItemId],
      ),
    );

    await expect(
      db.asUser(a.userId, (c) =>
        c.query(
          "insert into public.cart_item_modifiers (cart_item_id, restaurant_id, modifier_id, modifier_option_id, name, price_adjustment) values ($1, $2, $3, $4, 'X', 0);",
          [cartItemRows[0].id, a.restaurantId, bModifierId, bOptionId],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a customer cannot insert a cart_item into another customer's cart even within the same restaurant", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    const session1 = await createCustomerSession(db, restaurantId, tableId);
    const session2 = await createCustomerSession(db, restaurantId, tableId);
    const cart2Id = await createCart(db, restaurantId, session2.sessionId);

    await expect(
      db.asUser(session1.userId, (c) =>
        c.query(
          "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, 9.99, 9.99);",
          [cart2Id, restaurantId, menuItemId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("unavailable menu item revalidation", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("an item already in a cart is untouched (not corrupted) when it later becomes unavailable, but a live join can no longer see it", async () => {
    const fx = await fullCustomerFixture(db);
    await db.asUser(fx.userId, (c) =>
      c.query(
        "insert into public.cart_items (cart_id, restaurant_id, menu_item_id, quantity, unit_price, line_total) values ($1, $2, $3, 1, 9.99, 9.99);",
        [fx.cartId, fx.restaurantId, fx.menuItemId],
      ),
    );

    // The restaurant makes the item unavailable after it was added.
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [fx.menuItemId],
    );

    // The cart_item row itself is untouched (not corrupted) — quantity,
    // price snapshot, everything as it was when added.
    const { rows: cartItems } = await db.asUser(fx.userId, (c) =>
      c.query<{ id: string; quantity: number }>(
        "select id, quantity from public.cart_items where cart_id = $1;",
        [fx.cartId],
      ),
    );
    expect(cartItems).toHaveLength(1);
    expect(cartItems[0].quantity).toBe(1);

    // A live join from the CUSTOMER's own RLS-scoped connection can no
    // longer see the now-unavailable item at all — the public storefront
    // policy hides it, the same as it would from the menu page. This is
    // exactly why src/lib/cart/get-cart.ts treats a missing join result as
    // `stillAvailable: false` (via `menuItemById.get(...)?.is_available ??
    // false`) rather than assuming a flag it could read.
    const { rows: joined } = await db.asUser(fx.userId, (c) =>
      c.query<{ is_available: boolean }>(
        "select mi.is_available from public.cart_items ci join public.menu_items mi on mi.id = ci.menu_item_id where ci.id = $1;",
        [cartItems[0].id],
      ),
    );
    expect(joined).toHaveLength(0);

    // The admin view confirms the underlying data: still there, just flagged unavailable.
    const { rows: adminView } = await db.admin.query<{ is_available: boolean }>(
      "select is_available from public.menu_items where id = $1;",
      [fx.menuItemId],
    );
    expect(adminView[0].is_available).toBe(false);
  });
});
