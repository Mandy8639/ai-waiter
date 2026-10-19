import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { createRestaurant, addMember } from "./helpers";

/**
 * commit_menu_import() is the only path from a reviewed import into the
 * live menu, so its refusals are the safety property worth testing: it must
 * not run twice, must not run for someone who cannot write the price list,
 * and must never invent a price for a board that did not give one.
 */
describe("commit_menu_import", () => {
  let db: TestDb;
  let restaurantId: string;
  let ownerId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into auth.users (email) values ('owner@example.com') returning id;",
    );
    ownerId = rows[0].id;
    restaurantId = await createRestaurant(db);
    await addMember(db, restaurantId, ownerId, "owner");
  });

  afterAll(async () => {
    await db.admin.close();
  });

  async function newImport(
    items: Array<{ category: string; name: string; price: number | null }>,
    status = "review",
  ): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into public.menu_imports (restaurant_id, status) values ($1, $2) returning id;",
      [restaurantId, status],
    );
    const importId = rows[0].id;
    for (const [i, item] of items.entries()) {
      await db.admin.query(
        `insert into public.menu_import_items
           (import_id, restaurant_id, category_name, name, price, display_order)
         values ($1, $2, $3, $4, $5, $6);`,
        [importId, restaurantId, item.category, item.name, item.price, i],
      );
    }
    return importId;
  }

  it("creates categories and items, and reports what it created", async () => {
    const importId = await newImport([
      { category: "Chaat", name: "Pani Puri", price: 6.99 },
      { category: "Chaat", name: "Bhel Puri", price: 7.99 },
      { category: "Shakes", name: "Mango Shake", price: 4.99 },
    ]);

    const result = await db.asUser(ownerId, (client) =>
      client.query<{ categories_created: number; items_created: number }>(
        "select * from public.commit_menu_import($1);",
        [importId],
      ),
    );
    expect(result.rows[0].categories_created).toBe(2);
    expect(result.rows[0].items_created).toBe(3);

    const { rows: items } = await db.admin.query<{
      name: string;
      price: string;
    }>(
      "select name, price from public.menu_items where restaurant_id = $1 order by name;",
      [restaurantId],
    );
    expect(items.map((i) => i.name)).toEqual([
      "Bhel Puri",
      "Mango Shake",
      "Pani Puri",
    ]);
    expect(Number(items[0].price)).toBe(7.99);
  });

  it("keeps a dish named twice, in two sections, as two dishes", async () => {
    // From a real 249-dish import (2026-10-18): the board listed Chilli
    // Paneer as a $7 appetizer and a $17 entree, and the second collided
    // on the slug, rolling the whole import back.
    const importId = await newImport([
      { category: "Veg Appetizers", name: "Chilli Paneer", price: 7 },
      { category: "Veg Entrees", name: "Chilli Paneer", price: 17 },
      { category: "Rice", name: "Jeera Rice", price: 5 },
      { category: "Veg Rice & Biryani", name: "Jeera Rice", price: 14 },
      { category: "Rice", name: "चावल", price: 3 },
    ]);
    const result = await db.asUser(ownerId, (client) =>
      client.query<{ items_created: number }>(
        "select * from public.commit_menu_import($1);",
        [importId],
      ),
    );
    expect(result.rows[0].items_created).toBe(5);

    const { rows } = await db.admin.query<{ slug: string; price: string }>(
      `select slug, price from public.menu_items
       where restaurant_id = $1 and slug ~ '^(chilli-paneer|jeera-rice|item)'
       order by slug;`,
      [restaurantId],
    );
    expect(rows.map((r) => [r.slug, Number(r.price)])).toEqual([
      ["chilli-paneer", 7],
      ["chilli-paneer-2", 17],
      ["item", 3],
      ["jeera-rice", 5],
      ["jeera-rice-2", 14],
    ]);
  });

  it("imports onto a menu that already has a dish of that name", async () => {
    const first = await newImport([
      { category: "Chaat", name: "Dahi Puri", price: 7 },
    ]);
    const second = await newImport([
      { category: "Chaat", name: "Dahi Puri", price: 7.5 },
    ]);
    for (const id of [first, second]) {
      await db.asUser(ownerId, (client) =>
        client.query("select * from public.commit_menu_import($1);", [id]),
      );
    }
    const { rows } = await db.admin.query<{ slug: string }>(
      "select slug from public.menu_items where restaurant_id = $1 and name = 'Dahi Puri' order by slug;",
      [restaurantId],
    );
    expect(rows.map((r) => r.slug)).toEqual(["dahi-puri", "dahi-puri-2"]);
  });

  it("refuses an included row with no price rather than importing it at zero", async () => {
    // The whole reason menu_import_items.price is nullable. A board that
    // says "ask at counter" must not become a £0.00 item a diner can order.
    const importId = await newImport([
      { category: "Sweets", name: "Gulab Jamun", price: null },
    ]);

    await expect(
      db.asUser(ownerId, (client) =>
        client.query("select * from public.commit_menu_import($1);", [
          importId,
        ]),
      ),
    ).rejects.toThrow(/MENU_IMPORT_UNPRICED_ITEMS/);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.menu_items where restaurant_id = $1 and name = 'Gulab Jamun';",
      [restaurantId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("allows an unpriced row once it is excluded from the import", async () => {
    const importId = await newImport([
      { category: "Sweets", name: "Ras Malai", price: null },
      { category: "Sweets", name: "Rasgulla", price: 5.99 },
    ]);
    await db.admin.query(
      "update public.menu_import_items set include = false where import_id = $1 and price is null;",
      [importId],
    );

    const result = await db.asUser(ownerId, (client) =>
      client.query<{ items_created: number }>(
        "select * from public.commit_menu_import($1);",
        [importId],
      ),
    );
    expect(result.rows[0].items_created).toBe(1);
  });

  it("never commits the same import twice", async () => {
    const importId = await newImport([
      { category: "Soups", name: "Tomato Soup", price: 6.99 },
    ]);
    await db.asUser(ownerId, (client) =>
      client.query("select * from public.commit_menu_import($1);", [importId]),
    );

    await expect(
      db.asUser(ownerId, (client) =>
        client.query("select * from public.commit_menu_import($1);", [
          importId,
        ]),
      ),
    ).rejects.toThrow(/MENU_IMPORT_ALREADY_COMMITTED/);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.menu_items where restaurant_id = $1 and name = 'Tomato Soup';",
      [restaurantId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("refuses a caller who is not a manager or owner of that restaurant", async () => {
    // SECURITY DEFINER bypasses RLS, so this check is the only thing
    // standing between an outsider and rewriting a price list.
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into auth.users (email) values ('outsider@example.com') returning id;",
    );
    const outsiderId = rows[0].id;
    const importId = await newImport([
      { category: "Starters", name: "French Fries", price: 6.99 },
    ]);

    await expect(
      db.asUser(outsiderId, (client) =>
        client.query("select * from public.commit_menu_import($1);", [
          importId,
        ]),
      ),
    ).rejects.toThrow(/MENU_IMPORT_FORBIDDEN/);
  });

  it("refuses an import that has not been through review", async () => {
    const importId = await newImport(
      [{ category: "Soups", name: "Hot & Sour Soup", price: 6.99 }],
      "uploaded",
    );
    await expect(
      db.asUser(ownerId, (client) =>
        client.query("select * from public.commit_menu_import($1);", [
          importId,
        ]),
      ),
    ).rejects.toThrow(/MENU_IMPORT_NOT_READY/);
  });
});
