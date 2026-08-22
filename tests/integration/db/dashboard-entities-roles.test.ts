// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { createModifier, fullRestaurantFixture, type Role } from "./helpers";

/**
 * Batch 2's role tests covered categories/menu_items/restaurants/
 * restaurant_settings. This batch's dashboard also writes to
 * modifier_options, ingredients, and allergens directly — this file closes
 * that coverage gap, using the same RLS policy pattern (owner/manager
 * write, kitchen/staff read-only) applied to those specific tables.
 */
describe("role authorization: modifiers, ingredients, allergens", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe.each<Role>(["owner", "manager"])(
    "%s can manage modifier options",
    (role) => {
      it(`${role} can create a modifier option`, async () => {
        const fx = await fullRestaurantFixture(db, role);
        const modifierId = await createModifier(
          db,
          fx.restaurantId,
          fx.menuItemId,
        );

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "insert into public.modifier_options (modifier_id, name, price_adjustment) values ($1, 'Large', 2.00);",
            [modifierId],
          ),
        );

        expect(result.affectedRows).toBe(1);
      });
    },
  );

  describe.each<Role>(["kitchen", "staff"])(
    "%s cannot manage modifier options",
    (role) => {
      it(`${role} cannot create a modifier option`, async () => {
        const fx = await fullRestaurantFixture(db, role);
        const modifierId = await createModifier(
          db,
          fx.restaurantId,
          fx.menuItemId,
        );

        await expect(
          db.asUser(fx.userId, (c) =>
            c.query(
              "insert into public.modifier_options (modifier_id, name, price_adjustment) values ($1, 'Large', 2.00);",
              [modifierId],
            ),
          ),
        ).rejects.toThrow(/row-level security/i);
      });

      it(`${role} can still read modifier options`, async () => {
        const fx = await fullRestaurantFixture(db, role);
        const modifierId = await createModifier(
          db,
          fx.restaurantId,
          fx.menuItemId,
        );
        await db.admin.query(
          "insert into public.modifier_options (modifier_id, name) values ($1, 'Regular');",
          [modifierId],
        );

        const { rows } = await db.asUser(fx.userId, (c) =>
          c.query(
            "select id from public.modifier_options where modifier_id = $1;",
            [modifierId],
          ),
        );

        expect(rows).toHaveLength(1);
      });
    },
  );

  describe.each<Role>(["owner", "manager"])(
    "%s can manage ingredients",
    (role) => {
      it(`${role} can create, update, and delete an ingredient`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const insertResult = await db.asUser(fx.userId, (c) =>
          c.query<{ id: string }>(
            "insert into public.ingredients (restaurant_id, name) values ($1, 'Cardamom') returning id;",
            [fx.restaurantId],
          ),
        );
        expect(insertResult.rows).toHaveLength(1);
        const ingredientId = insertResult.rows[0].id;

        const updateResult = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.ingredients set description = 'Aromatic spice' where id = $1;",
            [ingredientId],
          ),
        );
        expect(updateResult.affectedRows).toBe(1);

        const deleteResult = await db.asUser(fx.userId, (c) =>
          c.query("delete from public.ingredients where id = $1;", [
            ingredientId,
          ]),
        );
        expect(deleteResult.affectedRows).toBe(1);
      });
    },
  );

  describe.each<Role>(["kitchen", "staff"])(
    "%s cannot manage ingredients",
    (role) => {
      it(`${role} cannot create an ingredient`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        await expect(
          db.asUser(fx.userId, (c) =>
            c.query(
              "insert into public.ingredients (restaurant_id, name) values ($1, 'Cardamom');",
              [fx.restaurantId],
            ),
          ),
        ).rejects.toThrow(/row-level security/i);
      });
    },
  );

  describe.each<Role>(["owner", "manager"])(
    "%s can manage allergens",
    (role) => {
      it(`${role} can create, update, and delete an allergen`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const insertResult = await db.asUser(fx.userId, (c) =>
          c.query<{ id: string }>(
            "insert into public.allergens (restaurant_id, name) values ($1, 'Dairy') returning id;",
            [fx.restaurantId],
          ),
        );
        expect(insertResult.rows).toHaveLength(1);
        const allergenId = insertResult.rows[0].id;

        const updateResult = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.allergens set description = 'Milk-based' where id = $1;",
            [allergenId],
          ),
        );
        expect(updateResult.affectedRows).toBe(1);

        const deleteResult = await db.asUser(fx.userId, (c) =>
          c.query("delete from public.allergens where id = $1;", [allergenId]),
        );
        expect(deleteResult.affectedRows).toBe(1);
      });
    },
  );

  describe.each<Role>(["kitchen", "staff"])(
    "%s cannot manage allergens",
    (role) => {
      it(`${role} cannot create an allergen`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        await expect(
          db.asUser(fx.userId, (c) =>
            c.query(
              "insert into public.allergens (restaurant_id, name) values ($1, 'Dairy');",
              [fx.restaurantId],
            ),
          ),
        ).rejects.toThrow(/row-level security/i);
      });
    },
  );

  describe("cross-tenant isolation for the new dashboard entities", () => {
    it("Restaurant A cannot read Restaurant B's modifier options while the parent menu item is UNAVAILABLE", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      const bModifierId = await createModifier(
        db,
        b.restaurantId,
        b.menuItemId,
      );
      await db.admin.query(
        "insert into public.modifier_options (modifier_id, name) values ($1, 'Large');",
        [bModifierId],
      );
      await db.admin.query(
        "update public.menu_items set is_available = false where id = $1;",
        [b.menuItemId],
      );

      const { rows } = await db.asUser(a.userId, (c) =>
        c.query(
          "select id from public.modifier_options where modifier_id = $1;",
          [bModifierId],
        ),
      );

      // As of Batch 4, an available item's modifier options are
      // intentionally public (the public storefront needs to show them) —
      // see the header comment in rls-tenant-isolation.test.ts. Making the
      // parent item unavailable here is what keeps this a meaningful
      // isolation check rather than a stale assumption.
      expect(rows).toHaveLength(0);
    });

    it("Restaurant A cannot modify Restaurant B's ingredient", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      const { rows: bIngredient } = await db.admin.query<{ id: string }>(
        "insert into public.ingredients (restaurant_id, name) values ($1, 'Saffron') returning id;",
        [b.restaurantId],
      );

      const result = await db.asUser(a.userId, (c) =>
        c.query(
          "update public.ingredients set name = 'Hacked' where id = $1;",
          [bIngredient[0].id],
        ),
      );

      expect(result.affectedRows ?? 0).toBe(0);
    });

    it("Restaurant A cannot delete Restaurant B's allergen", async () => {
      const a = await fullRestaurantFixture(db);
      const b = await fullRestaurantFixture(db);
      const { rows: bAllergen } = await db.admin.query<{ id: string }>(
        "insert into public.allergens (restaurant_id, name) values ($1, 'Shellfish') returning id;",
        [b.restaurantId],
      );

      const result = await db.asUser(a.userId, (c) =>
        c.query("delete from public.allergens where id = $1;", [
          bAllergen[0].id,
        ]),
      );

      expect(result.affectedRows ?? 0).toBe(0);
      const { rows } = await db.admin.query(
        "select id from public.allergens where id = $1;",
        [bAllergen[0].id],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("hostile security review: self-promotion", () => {
    it("a manager cannot promote themselves to owner", async () => {
      const fx = await fullRestaurantFixture(db, "manager");

      const result = await db.asUser(fx.userId, (c) =>
        c.query(
          "update public.restaurant_users set role = 'owner' where user_id = $1 and restaurant_id = $2;",
          [fx.userId, fx.restaurantId],
        ),
      );
      expect(result.affectedRows ?? 0).toBe(0);

      const { rows } = await db.admin.query<{ role: string }>(
        "select role from public.restaurant_users where user_id = $1 and restaurant_id = $2;",
        [fx.userId, fx.restaurantId],
      );
      expect(rows[0].role).toBe("manager");
    });

    it("a kitchen user cannot promote themselves to manager", async () => {
      const fx = await fullRestaurantFixture(db, "kitchen");

      const result = await db.asUser(fx.userId, (c) =>
        c.query(
          "update public.restaurant_users set role = 'manager' where user_id = $1 and restaurant_id = $2;",
          [fx.userId, fx.restaurantId],
        ),
      );
      expect(result.affectedRows ?? 0).toBe(0);
    });
  });
});
