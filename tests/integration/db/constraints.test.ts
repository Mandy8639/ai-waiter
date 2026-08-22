// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  createCategory,
  createRestaurant,
  fullRestaurantFixture,
} from "./helpers";

describe("database constraints", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe("price and numeric constraints", () => {
    it("rejects a negative menu item price", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Bad', 'bad-price', -1.00);",
          [a.restaurantId, a.categoryId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects a negative preparation_time", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.menu_items (restaurant_id, category_id, name, slug, price, preparation_time) values ($1, $2, 'Bad', 'bad-prep', 5.00, -5);",
          [a.restaurantId, a.categoryId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects an out-of-range tax_rate", async () => {
      await expect(
        db.admin.query(
          "insert into public.restaurants (name, slug, tax_rate) values ('X', 'tax-test', 1.5);",
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects a negative tax_rate", async () => {
      await expect(
        db.admin.query(
          "insert into public.restaurants (name, slug, tax_rate) values ('X', 'tax-test-2', -0.01);",
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects an out-of-range service_charge", async () => {
      await expect(
        db.admin.query(
          "insert into public.restaurants (name, slug, service_charge) values ('X', 'svc-test', 2.0);",
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects a menu_item_modifiers group where max_selections < min_selections", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, min_selections, max_selections) values ($1, $2, 'Bad', 3, 1);",
          [a.restaurantId, a.menuItemId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects a negative min_selections on a modifier group", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, min_selections, max_selections) values ($1, $2, 'Bad', -1, 1);",
          [a.restaurantId, a.menuItemId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("allows a negative price_adjustment on a modifier option (discount)", async () => {
      const a = await fullRestaurantFixture(db);
      const { rows } = await db.admin.query<{ id: string }>(
        "insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name) values ($1, $2, 'Cheese') returning id;",
        [a.restaurantId, a.menuItemId],
      );

      await expect(
        db.admin.query(
          "insert into public.modifier_options (modifier_id, name, price_adjustment) values ($1, 'No Cheese', -1.00);",
          [rows[0].id],
        ),
      ).resolves.toBeDefined();
    });

    it("rejects an invalid restaurant_users role", async () => {
      const a = await fullRestaurantFixture(db);
      const newUserId = await db.createAuthUser();

      await expect(
        db.admin.query(
          "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'superadmin');",
          [a.restaurantId, newUserId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects an invalid spice_level", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.menu_items (restaurant_id, category_id, name, slug, price, spice_level) values ($1, $2, 'Bad', 'bad-spice', 5.00, 'nuclear');",
          [a.restaurantId, a.categoryId],
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("data integrity", () => {
    it("rejects a duplicate restaurant slug", async () => {
      await createRestaurant(db, { slug: "dupe-slug-test" });

      await expect(
        createRestaurant(db, { slug: "dupe-slug-test" }),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("rejects a duplicate restaurant membership (same user, same restaurant)", async () => {
      const a = await fullRestaurantFixture(db);

      await expect(
        db.admin.query(
          "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'staff');",
          [a.restaurantId, a.userId],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("rejects a duplicate table number within the same restaurant", async () => {
      const a = await fullRestaurantFixture(db);
      await db.admin.query(
        "insert into public.tables (restaurant_id, table_number) values ($1, '1');",
        [a.restaurantId],
      );

      await expect(
        db.admin.query(
          "insert into public.tables (restaurant_id, table_number) values ($1, '1');",
          [a.restaurantId],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("allows the same table number across different restaurants", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await db.admin.query(
        "insert into public.tables (restaurant_id, table_number) values ($1, '1');",
        [a.restaurantId],
      );

      await expect(
        db.admin.query(
          "insert into public.tables (restaurant_id, table_number) values ($1, '1');",
          [b.restaurantId],
        ),
      ).resolves.toBeDefined();
    });

    it("rejects a duplicate category name within the same restaurant", async () => {
      const a = await fullRestaurantFixture(db);
      await createCategory(db, a.restaurantId, "Starters");

      await expect(
        createCategory(db, a.restaurantId, "Starters"),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("allows the same category name across different restaurants", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await createCategory(db, a.restaurantId, "Starters");

      await expect(
        createCategory(db, b.restaurantId, "Starters"),
      ).resolves.toBeDefined();
    });

    it("rejects a duplicate menu item slug within the same restaurant", async () => {
      const a = await fullRestaurantFixture(db);
      await db.admin.query(
        "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'One', 'shared-slug', 5.00);",
        [a.restaurantId, a.categoryId],
      );

      await expect(
        db.admin.query(
          "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Two', 'shared-slug', 6.00);",
          [a.restaurantId, a.categoryId],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it("allows the same menu item slug across different restaurants", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      await db.admin.query(
        "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'One', 'shared-slug-2', 5.00);",
        [a.restaurantId, a.categoryId],
      );

      await expect(
        db.admin.query(
          "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Two', 'shared-slug-2', 6.00);",
          [b.restaurantId, b.categoryId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("updated_at trigger", () => {
    it("automatically bumps updated_at on UPDATE without the app setting it", async () => {
      const a = await fullRestaurantFixture(db);
      const before = await db.admin.query<{ updated_at: string }>(
        "select updated_at from public.categories where id = $1;",
        [a.categoryId],
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      await db.admin.query(
        "update public.categories set name = 'Renamed' where id = $1;",
        [a.categoryId],
      );

      const after = await db.admin.query<{ updated_at: string }>(
        "select updated_at from public.categories where id = $1;",
        [a.categoryId],
      );

      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].updated_at).getTime(),
      );
    });
  });
});
