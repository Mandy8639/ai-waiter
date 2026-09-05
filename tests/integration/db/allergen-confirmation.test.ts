import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createRestaurant,
  addMember,
  createCategory,
  createMenuItem,
  createAllergen,
} from "./helpers";

/**
 * An unconfirmed allergen is a SUGGESTION — usually inferred from a dish
 * name during menu import — and must never be presented to a diner or
 * asserted by the AI.
 *
 * The asymmetry this protects: a missing allergen makes the app say "the
 * menu doesn't specify, check with staff", which is safe. A wrong one says
 * "no nuts" to someone with a nut allergy, who then eats it. These tests
 * exist because that difference is not recoverable.
 */
describe("allergen confirmation", () => {
  let db: TestDb;
  let restaurantId: string;
  let ownerId: string;
  let menuItemId: string;
  let nutsId: string;
  let dairyId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into auth.users (email) values ('owner-allergen@example.com') returning id;",
    );
    ownerId = rows[0].id;
    restaurantId = await createRestaurant(db);
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    menuItemId = await createMenuItem(db, restaurantId, categoryId);
    nutsId = await createAllergen(db, restaurantId, "Nuts");
    dairyId = await createAllergen(db, restaurantId, "Dairy");
  });

  afterAll(async () => {
    await db.admin.close();
  });

  async function suggest(allergenId: string) {
    await db.admin.query(
      `insert into public.menu_item_allergens
         (restaurant_id, menu_item_id, allergen_id, confirmed_at)
       values ($1, $2, $3, null)
       on conflict (menu_item_id, allergen_id) do update set confirmed_at = null;`,
      [restaurantId, menuItemId, allergenId],
    );
  }

  it("excludes an unconfirmed suggestion from what a diner can be told", async () => {
    await suggest(nutsId);
    const { rows } = await db.admin.query<{ allergen_id: string }>(
      "select * from public.confirmed_allergen_ids($1);",
      [menuItemId],
    );
    expect(rows).toHaveLength(0);
  });

  it("includes it once a human confirms it", async () => {
    await suggest(nutsId);
    await db.asUser(ownerId, (client) =>
      client.query("select public.confirm_menu_item_allergens($1, $2);", [
        menuItemId,
        [nutsId],
      ]),
    );
    const { rows } = await db.admin.query<{ confirmed_allergen_ids: string }>(
      "select * from public.confirmed_allergen_ids($1);",
      [menuItemId],
    );
    expect(rows).toHaveLength(1);
  });

  it("records who confirmed it — the restaurant is the only authority for this claim", async () => {
    const { rows } = await db.admin.query<{
      confirmed_by: string | null;
      confirmed_at: string | null;
    }>(
      "select confirmed_by, confirmed_at from public.menu_item_allergens where menu_item_id = $1 and allergen_id = $2;",
      [menuItemId, nutsId],
    );
    expect(rows[0].confirmed_by).toBe(ownerId);
    expect(rows[0].confirmed_at).not.toBeNull();
  });

  it("discards a suggestion the reviewer did not tick, rather than leaving it pending forever", async () => {
    await suggest(dairyId);
    await db.asUser(ownerId, (client) =>
      client.query("select public.confirm_menu_item_allergens($1, $2);", [
        menuItemId,
        [nutsId], // dairy deliberately not ticked
      ]),
    );
    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*)::text as count from public.menu_item_allergens where menu_item_id = $1 and allergen_id = $2;",
      [menuItemId, dairyId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("never lets a non-manager confirm an allergen", async () => {
    const { rows } = await db.admin.query<{ id: string }>(
      "insert into auth.users (email) values ('kitchen-allergen@example.com') returning id;",
    );
    const kitchenId = rows[0].id;
    await addMember(db, restaurantId, kitchenId, "kitchen");
    await suggest(dairyId);

    await expect(
      db.asUser(kitchenId, (client) =>
        client.query("select public.confirm_menu_item_allergens($1, $2);", [
          menuItemId,
          [dairyId],
        ]),
      ),
    ).rejects.toThrow(/ALLERGEN_FORBIDDEN/);
  });

  it("leaves a confirmed allergen confirmed when other suggestions are reviewed", async () => {
    // Confirming dish-by-dish must not quietly un-confirm earlier work.
    const { rows } = await db.admin.query<{ confirmed_at: string | null }>(
      "select confirmed_at from public.menu_item_allergens where menu_item_id = $1 and allergen_id = $2;",
      [menuItemId, nutsId],
    );
    expect(rows[0].confirmed_at).not.toBeNull();
  });
});
