// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createRestaurant,
  type Role,
} from "./helpers";

/**
 * Phase M: nutrition. The rule is the allergen rule — nothing reaches a
 * diner until a person confirms it — plus refusing numbers that can't be
 * right.
 */

describe("menu nutrition", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function dish() {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, ownerId, categoryId, dishId };
  }

  async function save(
    userId: string,
    dishId: string,
    values: [number, number, number, number] = [520, 18, 64, 21],
    source = "ai",
  ) {
    await db.asUser(userId, (c) =>
      c.query(
        "select public.save_menu_item_nutrition($1, $2, $3, $4, $5, $6);",
        [dishId, ...values, source],
      ),
    );
  }

  async function confirm(userId: string, dishId: string) {
    await db.asUser(userId, (c) =>
      c.query("select public.confirm_menu_item_nutrition($1);", [dishId]),
    );
  }

  /** What a diner sees: anonymous, through RLS. */
  async function dinerSees(dishId: string) {
    const { rows } = await db.asAnon((c) =>
      c.query<{ calories: number }>(
        "select calories from public.menu_item_nutrition where menu_item_id = $1;",
        [dishId],
      ),
    );
    return rows;
  }

  describe("nothing reaches a diner unconfirmed", () => {
    it("hides a draft, and shows the values once a person confirms them", async () => {
      const d = await dish();
      await save(d.ownerId, d.dishId);
      expect(await dinerSees(d.dishId)).toEqual([]);
      await confirm(d.ownerId, d.dishId);
      expect(await dinerSees(d.dishId)).toEqual([{ calories: 520 }]);
    });

    it("takes confirmed numbers back to draft when they're changed", async () => {
      const d = await dish();
      await save(d.ownerId, d.dishId);
      await confirm(d.ownerId, d.dishId);
      await save(d.ownerId, d.dishId, [610, 20, 70, 25], "owner");
      expect(await dinerSees(d.dishId)).toEqual([]);
      const { rows } = await db.admin.query<{
        confirmed_at: string | null;
        source: string;
      }>(
        "select confirmed_at, source from public.menu_item_nutrition where menu_item_id = $1;",
        [d.dishId],
      );
      expect(rows[0]).toEqual({ confirmed_at: null, source: "owner" });
    });

    it("hides confirmed values for a dish diners can't see", async () => {
      const d = await dish();
      await save(d.ownerId, d.dishId);
      await confirm(d.ownerId, d.dishId);
      await db.admin.query(
        "update public.menu_items set is_available = false where id = $1;",
        [d.dishId],
      );
      expect(await dinerSees(d.dishId)).toEqual([]);
    });
  });

  describe("impossible numbers are refused", () => {
    it("refuses a serving over 5,000 kcal or a macronutrient over 500 g", async () => {
      const d = await dish();
      await expect(
        save(d.ownerId, d.dishId, [52000, 18, 64, 21]),
      ).rejects.toThrow(/menu_item_nutrition_calories_range/);
      await expect(
        save(d.ownerId, d.dishId, [520, 18, 640, 21]),
      ).rejects.toThrow(/menu_item_nutrition_macros_range/);
      await expect(save(d.ownerId, d.dishId, [-1, 0, 0, 0])).rejects.toThrow(
        /menu_item_nutrition_calories_range/,
      );
    });
  });

  describe("who can do what", () => {
    it("lets owners and managers save and confirm, and nobody else", async () => {
      const d = await dish();
      const manager = await db.createAuthUser();
      await addMember(db, d.restaurantId, manager, "manager");
      await save(manager, d.dishId);
      await confirm(manager, d.dishId);

      for (const role of ["kitchen", "staff"] as Role[]) {
        const u = await db.createAuthUser();
        await addMember(db, d.restaurantId, u, role);
        await expect(save(u, d.dishId)).rejects.toThrow(/NUTRITION_FORBIDDEN/);
        await expect(confirm(u, d.dishId)).rejects.toThrow(
          /NUTRITION_FORBIDDEN/,
        );
      }
      const stranger = await dish();
      await expect(save(stranger.ownerId, d.dishId)).rejects.toThrow(
        /NUTRITION_FORBIDDEN/,
      );
    });

    it("can't be written directly, so nobody can mark their own numbers confirmed", async () => {
      const d = await dish();
      await expect(
        db.asUser(d.ownerId, (c) =>
          c.query(
            `insert into public.menu_item_nutrition
               (menu_item_id, restaurant_id, calories, protein_g, carbs_g, fat_g, source, confirmed_at)
             values ($1, $2, 500, 10, 10, 10, 'owner', now());`,
            [d.dishId, d.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("lets staff see drafts, and is gone with the dish", async () => {
      const d = await dish();
      await save(d.ownerId, d.dishId);
      const staff = await db.createAuthUser();
      await addMember(db, d.restaurantId, staff, "staff");
      const { rows } = await db.asUser(staff, (c) =>
        c.query(
          "select 1 from public.menu_item_nutrition where menu_item_id = $1;",
          [d.dishId],
        ),
      );
      expect(rows).toHaveLength(1);

      await db.admin.query("delete from public.menu_items where id = $1;", [
        d.dishId,
      ]);
      const { rows: after } = await db.admin.query(
        "select 1 from public.menu_item_nutrition where menu_item_id = $1;",
        [d.dishId],
      );
      expect(after).toEqual([]);
    });
  });
});
