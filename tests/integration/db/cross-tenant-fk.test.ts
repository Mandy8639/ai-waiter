// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createAllergen,
  createIngredient,
  createModifier,
  fullRestaurantFixture,
} from "./helpers";

/**
 * These run through `db.admin` (bypasses RLS) deliberately — the composite
 * tenant-scoped foreign keys (see docs/database.md) must reject cross-tenant
 * links at the constraint level, independent of who's asking. If these
 * passed only under RLS, a privileged/service-role write path would be able
 * to corrupt tenant boundaries.
 */
describe("cross-tenant foreign key rejection", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("rejects a menu item whose category belongs to a different restaurant", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    await expect(
      db.admin.query(
        "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Cross Tenant Item', 'cross-tenant-item', 1.00);",
        [a.restaurantId, b.categoryId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts a menu item whose category belongs to the same restaurant", async () => {
    const a = await fullRestaurantFixture(db);

    await expect(
      db.admin.query(
        "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Same Tenant Item', 'same-tenant-item', 1.00);",
        [a.restaurantId, a.categoryId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an ingredient link where the ingredient belongs to a different restaurant than the menu item", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bIngredientId = await createIngredient(db, b.restaurantId);

    await expect(
      db.admin.query(
        "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, bIngredientId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects an ingredient link where the menu item belongs to a different restaurant than the row's own restaurant_id", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const aIngredientId = await createIngredient(db, a.restaurantId);

    await expect(
      db.admin.query(
        "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
        [a.restaurantId, b.menuItemId, aIngredientId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts an ingredient link where menu item, ingredient, and restaurant all agree", async () => {
    const a = await fullRestaurantFixture(db);
    const aIngredientId = await createIngredient(db, a.restaurantId);

    await expect(
      db.admin.query(
        "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, aIngredientId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an allergen link where the allergen belongs to a different restaurant", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);
    const bAllergenId = await createAllergen(db, b.restaurantId);

    await expect(
      db.admin.query(
        "insert into public.menu_item_allergens (restaurant_id, menu_item_id, allergen_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, bAllergenId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts an allergen link where menu item, allergen, and restaurant all agree", async () => {
    const a = await fullRestaurantFixture(db);
    const aAllergenId = await createAllergen(db, a.restaurantId);

    await expect(
      db.admin.query(
        "insert into public.menu_item_allergens (restaurant_id, menu_item_id, allergen_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, aAllergenId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a modifier group whose menu item belongs to a different restaurant", async () => {
    const a = await fullRestaurantFixture(db);
    const b = await fullRestaurantFixture(db);

    await expect(
      db.admin.query(
        "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name) values ($1, $2, 'Size');",
        [a.restaurantId, b.menuItemId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("accepts a modifier group whose menu item belongs to the same restaurant", async () => {
    const a = await fullRestaurantFixture(db);

    await expect(
      db.admin.query(
        "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name) values ($1, $2, 'Size');",
        [a.restaurantId, a.menuItemId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a modifier option whose modifier group belongs to a different restaurant's item — via the modifier's own item scoping", async () => {
    // modifier_options has no restaurant_id of its own (see
    // 20260821131000_modifier_options.sql) — its tenant is fully
    // determined by modifier_id, so there's nothing cross-tenant to
    // *insert* incorrectly. What we can and do verify: an option for
    // restaurant B's modifier is invisible to restaurant A under RLS —
    // covered in rls-tenant-isolation.test.ts's modifier_options coverage
    // via the same is_restaurant_member(mim.restaurant_id) join. This test
    // instead confirms the modifier_id FK itself still rejects a bogus id.
    await expect(
      db.admin.query(
        "insert into public.modifier_options (modifier_id, name) values ($1, 'Bogus');",
        ["00000000-0000-0000-0000-000000000000"],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects a duplicate ingredient link (same menu item, same ingredient)", async () => {
    const a = await fullRestaurantFixture(db);
    const aIngredientId = await createIngredient(db, a.restaurantId);

    await db.admin.query(
      "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
      [a.restaurantId, a.menuItemId, aIngredientId],
    );

    await expect(
      db.admin.query(
        "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, aIngredientId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("rejects a duplicate allergen link (same menu item, same allergen)", async () => {
    const a = await fullRestaurantFixture(db);
    const aAllergenId = await createAllergen(db, a.restaurantId);

    await db.admin.query(
      "insert into public.menu_item_allergens (restaurant_id, menu_item_id, allergen_id) values ($1, $2, $3);",
      [a.restaurantId, a.menuItemId, aAllergenId],
    );

    await expect(
      db.admin.query(
        "insert into public.menu_item_allergens (restaurant_id, menu_item_id, allergen_id) values ($1, $2, $3);",
        [a.restaurantId, a.menuItemId, aAllergenId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("createModifier helper itself produces a usable same-tenant modifier (sanity check)", async () => {
    const a = await fullRestaurantFixture(db);
    const modifierId = await createModifier(db, a.restaurantId, a.menuItemId);
    const { rows } = await db.admin.query(
      "select id from public.menu_item_modifiers where id = $1;",
      [modifierId],
    );
    expect(rows).toHaveLength(1);
  });
});
