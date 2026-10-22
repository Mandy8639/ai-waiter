// @vitest-environment node
//
// "House favorites" and "Most ordered this month" on the diner menu
// (20261106090000).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createMenuItem, fullRestaurantFixture } from "./helpers";

describe("house favorites and most ordered", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  /** Pretends `ordered` orders of a dish happened `daysAgo` days ago. */
  async function orders(
    restaurantId: string,
    menuItemId: string,
    ordered: number,
    daysAgo = 1,
  ) {
    await db.admin.query(
      `insert into public.dish_daily_stats (restaurant_id, menu_item_id, day, ordered)
       values ($1, $2, current_date - $3::int, $4)
       on conflict (restaurant_id, menu_item_id, day)
       do update set ordered = public.dish_daily_stats.ordered + excluded.ordered;`,
      [restaurantId, menuItemId, daysAgo, ordered],
    );
  }

  const mostOrdered = (restaurantId: string) =>
    db.asAnon((c) =>
      c.query<{ menu_item_id: string; rank: number }>(
        "select * from public.get_most_ordered_dishes($1);",
        [restaurantId],
      ),
    );

  it("ranks dishes by orders this month, ids and rank only", async () => {
    const f = await fullRestaurantFixture(db);
    const b = await createMenuItem(db, f.restaurantId, f.categoryId);
    const c = await createMenuItem(db, f.restaurantId, f.categoryId);
    await orders(f.restaurantId, f.menuItemId, 5);
    await orders(f.restaurantId, b, 12);
    await orders(f.restaurantId, c, 4);
    const { rows } = await mostOrdered(f.restaurantId);
    expect(rows).toEqual([
      { menu_item_id: b, rank: 1 },
      { menu_item_id: f.menuItemId, rank: 2 },
      { menu_item_id: c, rank: 3 },
    ]);
    // Never the counts themselves.
    expect(Object.keys(rows[0]).sort()).toEqual(["menu_item_id", "rank"]);
  });

  it("shows nothing until the restaurant has 20 orders this month", async () => {
    const f = await fullRestaurantFixture(db);
    await orders(f.restaurantId, f.menuItemId, 19);
    expect((await mostOrdered(f.restaurantId)).rows).toEqual([]);
    // Older than 30 days doesn't count.
    await orders(f.restaurantId, f.menuItemId, 50, 45);
    expect((await mostOrdered(f.restaurantId)).rows).toEqual([]);
    await orders(f.restaurantId, f.menuItemId, 1);
    expect((await mostOrdered(f.restaurantId)).rows).toHaveLength(1);
  });

  it("leaves out dishes with fewer than 3 orders, sold-out dishes, and caps at 6", async () => {
    const f = await fullRestaurantFixture(db);
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await createMenuItem(db, f.restaurantId, f.categoryId);
      ids.push(id);
      await orders(f.restaurantId, id, 10 + i);
    }
    const rare = await createMenuItem(db, f.restaurantId, f.categoryId);
    await orders(f.restaurantId, rare, 2);
    await db.admin.query(
      "update public.menu_items set is_available = false where id = $1;",
      [ids[7]],
    );
    const { rows } = await mostOrdered(f.restaurantId);
    expect(rows).toHaveLength(6);
    const shown = rows.map((r) => r.menu_item_id);
    expect(shown).not.toContain(ids[7]); // sold out
    expect(shown).not.toContain(rare); // only 2 orders
    expect(shown[0]).toBe(ids[6]); // the most ordered still visible
  });

  it("lets owners and managers star a dish, not kitchen or floor staff", async () => {
    const f = await fullRestaurantFixture(db);
    const star = (userId: string) =>
      db.asUser(userId, (c) =>
        c.query(
          "update public.menu_items set is_house_favorite = true where id = $1 returning id;",
          [f.menuItemId],
        ),
      );
    expect((await star(f.userId)).rows).toHaveLength(1);
    for (const role of ["kitchen", "staff"] as const) {
      await db.admin.query(
        "update public.menu_items set is_house_favorite = false where id = $1;",
        [f.menuItemId],
      );
      const member = await db.createAuthUser();
      await addMember(db, f.restaurantId, member, role);
      const result = await star(member).catch(() => ({ rows: [] }));
      expect(result.rows).toHaveLength(0);
    }
  });
});
