// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createIngredient,
  createModifier,
  createTable,
  fullRestaurantFixture,
} from "./helpers";

/**
 * As of Batch 4, ACTIVE/available restaurant data (categories, menu items,
 * ingredients, ...) is intentionally readable by anon and by any
 * authenticated user — including another restaurant's staff — via the
 * public-storefront policies in
 * 20260822090100_public_storefront_rls.sql. That's not a leak: it's the
 * same data any customer can already see by visiting that restaurant's
 * public menu, so "authenticated" gains no more than "anon" already had.
 * What's still fully isolated, and tested below: INACTIVE data (never
 * public regardless of caller), and every WRITE (unchanged from Batch 2/3
 * — see roles-and-permissions.test.ts).
 */
describe("RLS: tenant isolation", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("Restaurant A user can read Restaurant A categories", async () => {
    const a = await fullRestaurantFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.categories where id = $1;", [
        a.categoryId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot read Restaurant B's INACTIVE category", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    await db.admin.query(
      "update public.categories set is_active = false where id = $1;",
      [b.categoryId],
    );

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.categories where id = $1;", [
        b.categoryId,
      ]),
    );

    expect(rows).toHaveLength(0);
  });

  it("Restaurant A user CAN read Restaurant B's active category — the public storefront policy, not a leak (see file header)", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.categories where id = $1;", [
        b.categoryId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user can read Restaurant A menu items", async () => {
    const a = await fullRestaurantFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.menu_items where id = $1;", [
        a.menuItemId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot read Restaurant B's UNAVAILABLE menu item", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [b.menuItemId],
    );

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.menu_items where id = $1;", [
        b.menuItemId,
      ]),
    );

    expect(rows).toHaveLength(0);
  });

  it("Restaurant A user CAN read Restaurant B's available menu item — the public storefront policy, not a leak (see file header)", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.menu_items where id = $1;", [
        b.menuItemId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot modify Restaurant B menu items", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    const result = await db.asUser(a.userId, (c) =>
      c.query("update public.menu_items set price = 0.01 where id = $1;", [
        b.menuItemId,
      ]),
    );
    expect(result.affectedRows ?? 0).toBe(0);

    const { rows } = await db.admin.query<{ price: string }>(
      "select price from public.menu_items where id = $1;",
      [b.menuItemId],
    );
    expect(Number(rows[0].price)).not.toBe(0.01);
  });

  it("Restaurant A user cannot delete Restaurant B menu items", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    const result = await db.asUser(a.userId, (c) =>
      c.query("delete from public.menu_items where id = $1;", [b.menuItemId]),
    );
    expect(result.affectedRows ?? 0).toBe(0);

    const { rows } = await db.admin.query(
      "select id from public.menu_items where id = $1;",
      [b.menuItemId],
    );
    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot read Restaurant B's ingredients while Restaurant B is INACTIVE", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bIngredientId = await createIngredient(db, b.restaurantId);
    await db.admin.query(
      "update public.restaurants set is_active = false where id = $1;",
      [b.restaurantId],
    );

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.ingredients where id = $1;", [
        bIngredientId,
      ]),
    );

    expect(rows).toHaveLength(0);
  });

  it("Restaurant A user CAN read Restaurant B's ingredients while Restaurant B is active — ingredients have no availability flag of their own, so an active restaurant's whole catalog is public (see file header)", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bIngredientId = await createIngredient(db, b.restaurantId);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.ingredients where id = $1;", [
        bIngredientId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot read Restaurant B tables", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bTableId = await createTable(db, b.restaurantId);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query("select id from public.tables where id = $1;", [bTableId]),
    );

    expect(rows).toHaveLength(0);
  });

  it("Restaurant A user cannot insert a table for Restaurant B", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    await expect(
      db.asUser(a.userId, (c) =>
        c.query(
          "insert into public.tables (restaurant_id, table_number) values ($1, 'Nope');",
          [b.restaurantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("Restaurant A user cannot modify or delete Restaurant B's table", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bTableId = await createTable(db, b.restaurantId);

    const updateResult = await db.asUser(a.userId, (c) =>
      c.query("update public.tables set is_active = false where id = $1;", [
        bTableId,
      ]),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);

    const deleteResult = await db.asUser(a.userId, (c) =>
      c.query("delete from public.tables where id = $1;", [bTableId]),
    );
    expect(deleteResult.affectedRows ?? 0).toBe(0);

    const { rows } = await db.admin.query(
      "select id from public.tables where id = $1;",
      [bTableId],
    );
    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot insert a modifier group for Restaurant B's menu item", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    await expect(
      db.asUser(a.userId, (c) =>
        c.query(
          "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name) values ($1, $2, 'Nope');",
          [b.restaurantId, b.menuItemId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("Restaurant A user cannot modify or delete Restaurant B's modifier group", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bModifierId = await createModifier(db, b.restaurantId, b.menuItemId);

    const updateResult = await db.asUser(a.userId, (c) =>
      c.query(
        "update public.menu_item_modifiers set is_required = true where id = $1;",
        [bModifierId],
      ),
    );
    expect(updateResult.affectedRows ?? 0).toBe(0);

    const deleteResult = await db.asUser(a.userId, (c) =>
      c.query("delete from public.menu_item_modifiers where id = $1;", [
        bModifierId,
      ]),
    );
    expect(deleteResult.affectedRows ?? 0).toBe(0);

    const { rows } = await db.admin.query(
      "select id from public.menu_item_modifiers where id = $1;",
      [bModifierId],
    );
    expect(rows).toHaveLength(1);
  });

  it("Restaurant A user cannot access Restaurant B settings", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    const { rows } = await db.asUser(a.userId, (c) =>
      c.query(
        "select id from public.restaurant_settings where restaurant_id = $1;",
        [b.restaurantId],
      ),
    );

    expect(rows).toHaveLength(0);
  });

  it("an unauthenticated (anon) user cannot read an INACTIVE category", async () => {
    const a = await fullRestaurantFixture(db);
    await db.admin.query(
      "update public.categories set is_active = false where id = $1;",
      [a.categoryId],
    );

    const { rows } = await db.asAnon((c) =>
      c.query("select id from public.categories where id = $1;", [
        a.categoryId,
      ]),
    );

    expect(rows).toHaveLength(0);
  });

  it("an unauthenticated (anon) user CAN read an active category — this is the public storefront working as intended", async () => {
    const a = await fullRestaurantFixture(db);

    const { rows } = await db.asAnon((c) =>
      c.query("select id from public.categories where id = $1;", [
        a.categoryId,
      ]),
    );

    expect(rows).toHaveLength(1);
  });

  it("an unauthenticated (anon) user cannot read any restaurant's settings", async () => {
    const a = await fullRestaurantFixture(db);

    const { rows } = await db.asAnon((c) =>
      c.query(
        "select id from public.restaurant_settings where restaurant_id = $1;",
        [a.restaurantId],
      ),
    );

    expect(rows).toHaveLength(0);
  });

  it("an unauthenticated (anon) user cannot insert a category — blocked by RLS, not by a missing grant", async () => {
    const a = await fullRestaurantFixture(db);

    // anon has the same table-level INSERT grant as authenticated (see
    // setup.ts) — this proves the RLS policy itself (scoped `to
    // authenticated`) is what stops this, not an artificially narrow grant.
    await expect(
      db.asAnon((c) =>
        c.query(
          "insert into public.categories (restaurant_id, name) values ($1, 'Anon Category');",
          [a.restaurantId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
