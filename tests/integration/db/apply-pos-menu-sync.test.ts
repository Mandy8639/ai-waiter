// @vitest-environment node
//
// apply_pos_menu_sync() and pos_credentials (20261109090000): importing a
// Square menu, re-importing it, and keeping OAuth tokens away from every
// signed-in role.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createRestaurant,
  type Role,
} from "./helpers";

interface Summary {
  categories_created: number;
  items_created: number;
  items_updated: number;
  items_hidden: number;
}

const menu = (
  overrides: { items?: unknown[]; categories?: unknown[] } = {},
) => ({
  categories: overrides.categories ?? [
    { external_id: "CAT_MAINS", name: "Mains", display_order: 0 },
  ],
  items: overrides.items ?? [
    {
      external_id: "VAR_BIRYANI",
      category_external_id: "CAT_MAINS",
      name: "Chicken Biryani",
      description: "Dum style",
      price: 16,
      is_available: true,
      display_order: 0,
      groups: [
        {
          external_id: "ml:SPICE:ITEM_BIRYANI",
          name: "Spice",
          is_required: true,
          min_selections: 1,
          max_selections: 1,
          display_order: 0,
          options: [
            {
              external_id: "MOD_MILD",
              name: "Mild",
              price_adjustment: 0,
              is_available: true,
              display_order: 0,
            },
            {
              external_id: "MOD_HOT",
              name: "Hot",
              price_adjustment: 0.5,
              is_available: true,
              display_order: 1,
            },
          ],
        },
      ],
    },
    {
      external_id: "ITEM_LASSI",
      category_external_id: "CAT_MAINS",
      name: "Mango Lassi",
      description: null,
      price: 5,
      is_available: true,
      display_order: 1,
      groups: [],
    },
  ],
});

describe("apply_pos_menu_sync()", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function setup(role: Role = "owner") {
    const restaurantId = await createRestaurant(db);
    const userId = await db.createAuthUser();
    await addMember(db, restaurantId, userId, role);
    await db.admin.query(
      "insert into public.restaurant_pos_integrations (restaurant_id, provider) values ($1, 'square');",
      [restaurantId],
    );
    return { restaurantId, userId };
  }

  function sync(userId: string, restaurantId: string, payload: unknown) {
    return db.asUser(userId, (c) =>
      c.query<Summary>(
        "select * from public.apply_pos_menu_sync($1, $2::jsonb);",
        [restaurantId, JSON.stringify(payload)],
      ),
    );
  }

  it("imports sections, dishes, groups and options", async () => {
    const { restaurantId, userId } = await setup();
    const { rows } = await sync(userId, restaurantId, menu());
    expect(rows[0]).toMatchObject({
      categories_created: 1,
      items_created: 2,
      items_hidden: 0,
    });

    const { rows: items } = await db.admin.query<{
      name: string;
      price: string;
      slug: string;
    }>(
      "select name, price, slug from public.menu_items where restaurant_id = $1 order by display_order;",
      [restaurantId],
    );
    expect(items.map((i) => [i.name, Number(i.price), i.slug])).toEqual([
      ["Chicken Biryani", 16, "chicken-biryani"],
      ["Mango Lassi", 5, "mango-lassi"],
    ]);
    const { rows: options } = await db.admin.query<{
      name: string;
      price_adjustment: string;
    }>(
      `select o.name, o.price_adjustment from public.modifier_options o
       join public.menu_item_modifiers g on g.id = o.modifier_id
       where g.restaurant_id = $1 order by o.display_order;`,
      [restaurantId],
    );
    expect(options.map((o) => [o.name, Number(o.price_adjustment)])).toEqual([
      ["Mild", 0],
      ["Hot", 0.5],
    ]);

    const { rows: integration } = await db.admin.query<{
      menu_synced_at: string | null;
      last_sync_summary: Summary;
    }>(
      "select menu_synced_at, last_sync_summary from public.restaurant_pos_integrations where restaurant_id = $1;",
      [restaurantId],
    );
    expect(integration[0].menu_synced_at).not.toBeNull();
    expect(integration[0].last_sync_summary.items_created).toBe(2);
  });

  it("updates in place on a second import, keeping Tableside-only details", async () => {
    const { restaurantId, userId } = await setup();
    await sync(userId, restaurantId, menu());
    // Something added in Tableside on top of the Square dish.
    await db.admin.query(
      "update public.menu_items set is_vegetarian = true where restaurant_id = $1 and external_id = 'ITEM_LASSI';",
      [restaurantId],
    );

    const next = menu();
    (next.items[1] as { price: number }).price = 5.5;
    const { rows } = await sync(userId, restaurantId, next);
    expect(rows[0]).toMatchObject({
      categories_created: 0,
      items_created: 0,
      items_updated: 2,
    });

    const { rows: lassi } = await db.admin.query<{
      price: string;
      is_vegetarian: boolean;
    }>(
      "select price, is_vegetarian from public.menu_items where restaurant_id = $1 and external_id = 'ITEM_LASSI';",
      [restaurantId],
    );
    expect(Number(lassi[0].price)).toBe(5.5);
    expect(lassi[0].is_vegetarian).toBe(true);
  });

  it("hides what Square dropped and never touches hand-made dishes", async () => {
    const { restaurantId, userId } = await setup();
    const handMadeCategory = await createCategory(db, restaurantId, "Specials");
    const handMade = await createMenuItem(db, restaurantId, handMadeCategory, {
      price: 9,
    });
    await sync(userId, restaurantId, menu());

    const lessMenu = menu();
    lessMenu.items = [lessMenu.items[0]];
    // The Hot option and the whole Spice group are gone from Square too.
    (lessMenu.items[0] as { groups: unknown[] }).groups = [];
    const { rows } = await sync(userId, restaurantId, lessMenu);
    expect(rows[0].items_hidden).toBe(1);

    const { rows: lassi } = await db.admin.query<{ is_available: boolean }>(
      "select is_available from public.menu_items where restaurant_id = $1 and external_id = 'ITEM_LASSI';",
      [restaurantId],
    );
    expect(lassi[0].is_available).toBe(false);

    const { rows: group } = await db.admin.query<{
      is_required: boolean;
      min_selections: number;
    }>(
      "select is_required, min_selections from public.menu_item_modifiers where restaurant_id = $1;",
      [restaurantId],
    );
    // Kept (carts may point at its options) but no longer able to block an order.
    expect(group[0]).toEqual({ is_required: false, min_selections: 0 });
    const { rows: opts } = await db.admin.query<{ is_available: boolean }>(
      `select o.is_available from public.modifier_options o
       join public.menu_item_modifiers g on g.id = o.modifier_id where g.restaurant_id = $1;`,
      [restaurantId],
    );
    expect(opts.every((o) => !o.is_available)).toBe(true);

    const { rows: kept } = await db.admin.query<{ is_available: boolean }>(
      "select is_available from public.menu_items where id = $1;",
      [handMade],
    );
    expect(kept[0].is_available).toBe(true);
  });

  it("adopts a same-named section instead of duplicating it", async () => {
    const { restaurantId, userId } = await setup();
    await createCategory(db, restaurantId, "Mains");
    const { rows } = await sync(userId, restaurantId, menu());
    expect(rows[0].categories_created).toBe(0);
    const { rows: cats } = await db.admin.query<{ external_id: string | null }>(
      "select external_id from public.categories where restaurant_id = $1 and name = 'Mains';",
      [restaurantId],
    );
    expect(cats).toEqual([{ external_id: "CAT_MAINS" }]);
  });

  it("gives a clashing new dish the next free slug", async () => {
    const { restaurantId, userId } = await setup();
    const cat = await createCategory(db, restaurantId);
    await createMenuItem(db, restaurantId, cat, {
      name: "Mango Lassi",
      slug: "mango-lassi",
    });
    await sync(userId, restaurantId, menu());
    const { rows } = await db.admin.query<{ slug: string }>(
      "select slug from public.menu_items where restaurant_id = $1 and external_id = 'ITEM_LASSI';",
      [restaurantId],
    );
    expect(rows[0].slug).toBe("mango-lassi-2");
  });

  it.each(["staff", "kitchen"] as const)(
    "refuses a %s account",
    async (role) => {
      const { restaurantId, userId } = await setup(role);
      await expect(sync(userId, restaurantId, menu())).rejects.toThrow(
        /POS_SYNC_FORBIDDEN/,
      );
    },
  );

  it("refuses an owner of a different restaurant", async () => {
    const { userId } = await setup();
    const { restaurantId: other } = await setup();
    await expect(sync(userId, other, menu())).rejects.toThrow(
      /POS_SYNC_FORBIDDEN/,
    );
  });

  it("rolls back entirely when one dish points at an unknown section", async () => {
    const { restaurantId, userId } = await setup();
    const bad = menu();
    (bad.items[1] as { category_external_id: string }).category_external_id =
      "CAT_NOPE";
    await expect(sync(userId, restaurantId, bad)).rejects.toThrow(
      /POS_SYNC_UNKNOWN_CATEGORY/,
    );
    const { rows } = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from public.menu_items where restaurant_id = $1;",
      [restaurantId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("pos_credentials", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("can't be read or written by any signed-in role, owners included", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    await db.admin.query(
      `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
       values ($1, 'square', 'M1', 'v1.x.y.z');`,
      [restaurantId],
    );

    // The harness grants every table to signed-in roles on purpose (see
    // setup.ts), so this proves the protection that matters if a grant
    // ever comes back: RLS with no policy shows nothing and accepts nothing.
    // (In production the migration's REVOKE also removes the grant.)
    const read = await db.asUser(owner, (c) =>
      c.query("select * from public.pos_credentials;"),
    );
    expect(read.rows).toEqual([]);
    await expect(
      db.asUser(owner, (c) =>
        c.query(
          `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
           values ($1, 'square', 'M2', 'v1.a.b.c');`,
          [restaurantId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
  });
});
