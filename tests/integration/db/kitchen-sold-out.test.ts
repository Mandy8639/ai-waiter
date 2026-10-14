// @vitest-environment node
//
// Kitchen mode: the kitchen account marks dishes and add-ons sold out
// (supabase/migrations/20261013120000_kitchen_sold_out.sql) — and can
// change nothing else about them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createCategory,
  createMenuItem,
  createModifier,
  createModifierOption,
  createRestaurant,
  type Role,
} from "./helpers";

describe("kitchen sold-out switches", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function fixture() {
    const restaurantId = await createRestaurant(db);
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId, {
      price: 12,
    });
    const groupId = await createModifier(db, restaurantId, dishId);
    const optionId = await createModifierOption(db, groupId, {
      priceAdjustment: 2,
    });
    const member = async (role: Role) => {
      const userId = await db.createAuthUser();
      await addMember(db, restaurantId, userId, role);
      return userId;
    };
    return { restaurantId, dishId, optionId, member };
  }

  const setDish = (userId: string, dishId: string, available: boolean) =>
    db.asUser(userId, (c) =>
      c.query("select public.set_menu_item_availability($1, $2);", [
        dishId,
        available,
      ]),
    );
  const setOption = (userId: string, optionId: string, available: boolean) =>
    db.asUser(userId, (c) =>
      c.query("select public.set_modifier_option_availability($1, $2);", [
        optionId,
        available,
      ]),
    );

  async function dishAvailable(dishId: string) {
    const { rows } = await db.admin.query<{ is_available: boolean }>(
      "select is_available from public.menu_items where id = $1;",
      [dishId],
    );
    return rows[0].is_available;
  }
  async function optionAvailable(optionId: string) {
    const { rows } = await db.admin.query<{ is_available: boolean }>(
      "select is_available from public.modifier_options where id = $1;",
      [optionId],
    );
    return rows[0].is_available;
  }

  it.each<Role>(["kitchen", "manager", "owner"])(
    "lets %s mark a dish sold out and bring it back",
    async (role) => {
      const f = await fixture();
      const user = await f.member(role);

      await setDish(user, f.dishId, false);
      expect(await dishAvailable(f.dishId)).toBe(false);
      await setDish(user, f.dishId, true);
      expect(await dishAvailable(f.dishId)).toBe(true);
    },
  );

  it("lets the kitchen mark one add-on sold out, leaving the dish on", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");

    await setOption(cook, f.optionId, false);
    expect(await optionAvailable(f.optionId)).toBe(false);
    expect(await dishAvailable(f.dishId)).toBe(true);
  });

  it("refuses front-of-house staff: the switch belongs to the kitchen", async () => {
    const f = await fixture();
    const waiter = await f.member("staff");

    await expect(setDish(waiter, f.dishId, false)).rejects.toThrow(
      /SOLD_OUT_FORBIDDEN/,
    );
    await expect(setOption(waiter, f.optionId, false)).rejects.toThrow(
      /SOLD_OUT_FORBIDDEN/,
    );
    expect(await dishAvailable(f.dishId)).toBe(true);
  });

  it("refuses another restaurant's kitchen", async () => {
    const f = await fixture();
    const other = await fixture();
    const outsider = await other.member("kitchen");

    await expect(setDish(outsider, f.dishId, false)).rejects.toThrow(
      /SOLD_OUT_FORBIDDEN/,
    );
    await expect(setOption(outsider, f.optionId, false)).rejects.toThrow(
      /SOLD_OUT_FORBIDDEN/,
    );
  });

  it("still gives the kitchen no way to change a price", async () => {
    // The switch is the whole of what it gets: the menu rows themselves
    // stay owner/manager-only to edit.
    const f = await fixture();
    const cook = await f.member("kitchen");

    await db.asUser(cook, (c) =>
      c.query("update public.menu_items set price = 1 where id = $1;", [
        f.dishId,
      ]),
    );
    const { rows } = await db.admin.query<{ price: string }>(
      "select price from public.menu_items where id = $1;",
      [f.dishId],
    );
    expect(Number(rows[0].price)).toBe(12);
  });

  it("says so for a dish or option that doesn't exist, or a missing value", async () => {
    const f = await fixture();
    const cook = await f.member("kitchen");

    await expect(setDish(cook, crypto.randomUUID(), false)).rejects.toThrow(
      /SOLD_OUT_NOT_FOUND/,
    );
    await expect(setOption(cook, crypto.randomUUID(), false)).rejects.toThrow(
      /SOLD_OUT_NOT_FOUND/,
    );
    await expect(
      db.asUser(cook, (c) =>
        c.query("select public.set_menu_item_availability($1, null);", [
          f.dishId,
        ]),
      ),
    ).rejects.toThrow(/SOLD_OUT_INVALID/);
  });
});
