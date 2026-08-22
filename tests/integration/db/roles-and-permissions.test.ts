// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createIngredient,
  fullRestaurantFixture,
  type Role,
} from "./helpers";

describe("role-based authorization", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe.each<Role>(["owner", "manager"])(
    "%s can manage menu data",
    (role) => {
      it(`${role} can insert a category`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "insert into public.categories (restaurant_id, name) values ($1, 'New Category');",
            [fx.restaurantId],
          ),
        );

        expect(result.affectedRows).toBe(1);
      });

      it(`${role} can update a menu item`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query("update public.menu_items set price = 5.00 where id = $1;", [
            fx.menuItemId,
          ]),
        );

        expect(result.affectedRows).toBe(1);
      });

      it(`${role} can delete a category`, async () => {
        const fx = await fullRestaurantFixture(db, role);
        const extraCategoryId = await createCategory(db, fx.restaurantId);

        const result = await db.asUser(fx.userId, (c) =>
          c.query("delete from public.categories where id = $1;", [
            extraCategoryId,
          ]),
        );

        expect(result.affectedRows).toBe(1);
      });

      it(`${role} can update the restaurant profile`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.restaurants set description = 'Updated' where id = $1;",
            [fx.restaurantId],
          ),
        );

        expect(result.affectedRows).toBe(1);
      });

      it(`${role} can update restaurant settings`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.restaurant_settings set accepting_orders = false where restaurant_id = $1;",
            [fx.restaurantId],
          ),
        );

        expect(result.affectedRows).toBe(1);
      });
    },
  );

  describe.each<Role>(["kitchen", "staff"])(
    "%s is read-only on menu data",
    (role) => {
      it(`${role} can read menu items`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const { rows } = await db.asUser(fx.userId, (c) =>
          c.query("select id from public.menu_items where id = $1;", [
            fx.menuItemId,
          ]),
        );

        expect(rows).toHaveLength(1);
      });

      it(`${role} cannot insert a category`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        await expect(
          db.asUser(fx.userId, (c) =>
            c.query(
              "insert into public.categories (restaurant_id, name) values ($1, 'Nope');",
              [fx.restaurantId],
            ),
          ),
        ).rejects.toThrow(/row-level security/i);
      });

      it(`${role} cannot update a menu item`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query("update public.menu_items set price = 1.00 where id = $1;", [
            fx.menuItemId,
          ]),
        );

        expect(result.affectedRows ?? 0).toBe(0);
      });

      it(`${role} cannot delete a menu item`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query("delete from public.menu_items where id = $1;", [
            fx.menuItemId,
          ]),
        );
        expect(result.affectedRows ?? 0).toBe(0);

        const { rows } = await db.admin.query(
          "select id from public.menu_items where id = $1;",
          [fx.menuItemId],
        );
        expect(rows).toHaveLength(1);
      });

      it(`${role} cannot update the restaurant profile`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.restaurants set description = 'Nope' where id = $1;",
            [fx.restaurantId],
          ),
        );

        expect(result.affectedRows ?? 0).toBe(0);
      });

      it(`${role} cannot update restaurant settings`, async () => {
        const fx = await fullRestaurantFixture(db, role);

        const result = await db.asUser(fx.userId, (c) =>
          c.query(
            "update public.restaurant_settings set accepting_orders = false where restaurant_id = $1;",
            [fx.restaurantId],
          ),
        );

        expect(result.affectedRows ?? 0).toBe(0);
      });
    },
  );

  describe("privilege escalation is blocked", () => {
    it("staff cannot change their own role to owner", async () => {
      const fx = await fullRestaurantFixture(db, "staff");

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
      expect(rows[0].role).toBe("staff");
    });

    it("manager cannot grant owner to a new member", async () => {
      const fx = await fullRestaurantFixture(db, "manager");
      const newUserId = await db.createAuthUser();

      await expect(
        db.asUser(fx.userId, (c) =>
          c.query(
            "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'owner');",
            [fx.restaurantId, newUserId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("manager can add a new staff member (non-owner role)", async () => {
      const fx = await fullRestaurantFixture(db, "manager");
      const newUserId = await db.createAuthUser();

      const result = await db.asUser(fx.userId, (c) =>
        c.query(
          "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'staff');",
          [fx.restaurantId, newUserId],
        ),
      );

      expect(result.affectedRows).toBe(1);
    });

    it("manager cannot change an existing member's role", async () => {
      const fx = await fullRestaurantFixture(db, "manager");
      const staffUserId = await db.createAuthUser();
      await addMember(db, fx.restaurantId, staffUserId, "staff");

      const result = await db.asUser(fx.userId, (c) =>
        c.query(
          "update public.restaurant_users set role = 'manager' where user_id = $1 and restaurant_id = $2;",
          [staffUserId, fx.restaurantId],
        ),
      );

      expect(result.affectedRows ?? 0).toBe(0);
    });

    it("manager cannot remove a member", async () => {
      const fx = await fullRestaurantFixture(db, "manager");
      const staffUserId = await db.createAuthUser();
      await addMember(db, fx.restaurantId, staffUserId, "staff");

      const result = await db.asUser(fx.userId, (c) =>
        c.query(
          "delete from public.restaurant_users where user_id = $1 and restaurant_id = $2;",
          [staffUserId, fx.restaurantId],
        ),
      );

      expect(result.affectedRows ?? 0).toBe(0);
    });

    it("a user cannot create a membership for themselves at a restaurant they don't belong to", async () => {
      const outsiderId = await db.createAuthUser();
      const b = await fullRestaurantFixture(db);

      await expect(
        db.asUser(outsiderId, (c) =>
          c.query(
            "insert into public.restaurant_users (restaurant_id, user_id, role) values ($1, $2, 'staff');",
            [b.restaurantId, outsiderId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("a user cannot submit another restaurant's id to write into their own restaurant's scope", async () => {
      const a = await fullRestaurantFixture(db, "owner");
      const b = await fullRestaurantFixture(db);

      await expect(
        db.asUser(a.userId, (c) =>
          c.query(
            "insert into public.categories (restaurant_id, name) values ($1, 'Injected');",
            [b.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("an owner cannot attach another restaurant's category to their own menu item, even though they own the item's restaurant_id", async () => {
      const a = await fullRestaurantFixture(db, "owner");
      const b = await fullRestaurantFixture(db);

      // restaurant_id = A (passes the RLS WITH CHECK, they manage A) but
      // category_id = B's category — this is the case RLS alone can't
      // catch, because RLS only ever inspects restaurant_id. The composite
      // foreign key (docs/database.md) is what actually stops it.
      await expect(
        db.asUser(a.userId, (c) =>
          c.query(
            "insert into public.menu_items (restaurant_id, category_id, name, slug, price) values ($1, $2, 'Hack', 'hack', 1.00);",
            [a.restaurantId, b.categoryId],
          ),
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it("an owner cannot attach another restaurant's ingredient to their own menu item", async () => {
      const a = await fullRestaurantFixture(db, "owner");
      const b = await fullRestaurantFixture(db);
      const bIngredientId = await createIngredient(db, b.restaurantId);

      await expect(
        db.asUser(a.userId, (c) =>
          c.query(
            "insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values ($1, $2, $3);",
            [a.restaurantId, a.menuItemId, bIngredientId],
          ),
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });
});
