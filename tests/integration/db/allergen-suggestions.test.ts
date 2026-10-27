// @vitest-environment node
//
// Allergen suggestions from the menu knowledge graph (20261123090000):
// added to the review queue unconfirmed with a reason, never re-asked once
// rejected, and only by an owner or manager.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createRestaurant,
} from "./helpers";

describe("allergen suggestions", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function fixture() {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, ownerId, dishId };
  }

  const suggest = (
    userId: string,
    restaurantId: string,
    rows: { menu_item_id: string; allergen_name: string; reason: string }[],
  ) =>
    db
      .asUser(userId, (c) =>
        c.query<{ n: number }>(
          "select public.suggest_menu_allergens($1, $2::jsonb) as n;",
          [restaurantId, JSON.stringify(rows)],
        ),
      )
      .then((r) => r.rows[0].n);

  const confirm = (userId: string, dishId: string, names: string[]) =>
    db.asUser(userId, (c) =>
      c.query("select public.confirm_menu_item_allergens($1, $2);", [
        dishId,
        names,
      ]),
    );

  const onDish = (dishId: string) =>
    db.admin
      .query<{ name: string; confirmed: boolean; reason: string | null }>(
        `select a.name, mia.confirmed_at is not null as confirmed, mia.suggestion_reason as reason
         from public.menu_item_allergens mia join public.allergens a on a.id = mia.allergen_id
         where mia.menu_item_id = $1 order by a.name;`,
        [dishId],
      )
      .then((r) => r.rows);

  it("adds a suggestion unconfirmed, with its reason, once", async () => {
    const f = await fixture();
    const row = {
      menu_item_id: f.dishId,
      allergen_name: "Milk",
      reason: "its name mentions paneer",
    };
    expect(await suggest(f.ownerId, f.restaurantId, [row])).toBe(1);
    expect(await onDish(f.dishId)).toEqual([
      { name: "Milk", confirmed: false, reason: "its name mentions paneer" },
    ]);
    // Asking again adds nothing: it's already waiting.
    expect(await suggest(f.ownerId, f.restaurantId, [row])).toBe(0);
  });

  it("never re-asks a suggestion the reviewer turned down", async () => {
    const f = await fixture();
    const milk = {
      menu_item_id: f.dishId,
      allergen_name: "Milk",
      reason: "made with Ghee",
    };
    const wheat = {
      menu_item_id: f.dishId,
      allergen_name: "Wheat",
      reason: "its name mentions naan",
    };
    await suggest(f.ownerId, f.restaurantId, [milk, wheat]);

    // The owner confirms Wheat and leaves Milk unticked.
    await confirm(f.ownerId, f.dishId, ["Wheat"]);
    expect(await onDish(f.dishId)).toEqual([
      { name: "Wheat", confirmed: true, reason: "its name mentions naan" },
    ]);
    expect(await suggest(f.ownerId, f.restaurantId, [milk, wheat])).toBe(0);
    expect((await onDish(f.dishId)).map((r) => r.name)).toEqual(["Wheat"]);

    // Ticking Milk by hand later counts, and lifts the old rejection.
    await confirm(f.ownerId, f.dishId, ["Wheat", "Milk"]);
    const { rows } = await db.admin.query(
      "select 1 from public.allergen_dismissals where menu_item_id = $1;",
      [f.dishId],
    );
    expect(rows).toHaveLength(0);
  });

  it("only touches the restaurant's own dishes, and only for its managers", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(
      await suggest(f.ownerId, f.restaurantId, [
        { menu_item_id: other.dishId, allergen_name: "Milk", reason: "x" },
      ]),
    ).toBe(0);
    expect(await onDish(other.dishId)).toEqual([]);

    const server = await db.createAuthUser();
    await addMember(db, f.restaurantId, server, "staff");
    await expect(
      suggest(server, f.restaurantId, [
        { menu_item_id: f.dishId, allergen_name: "Milk", reason: "x" },
      ]),
    ).rejects.toThrow(/ALLERGEN_FORBIDDEN/);
    await expect(
      db.asUser(server, (c) =>
        c.query("select * from public.allergen_dismissals;", []),
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("is never shown to a diner until confirmed", async () => {
    const f = await fixture();
    await suggest(f.ownerId, f.restaurantId, [
      { menu_item_id: f.dishId, allergen_name: "Milk", reason: "x" },
    ]);
    const { rows } = await db.admin.query(
      "select * from public.confirmed_allergen_ids($1);",
      [f.dishId],
    );
    expect(rows).toEqual([]);
  });
});
