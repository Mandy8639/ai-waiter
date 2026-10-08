// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createCart,
  createCategory,
  createCustomerSession,
  createMenuItem,
  createRestaurant,
  createTable,
  submitOrder,
  type Role,
} from "./helpers";

/**
 * Phase L: multiple menus. First, that nothing changes for a restaurant
 * that never touches menus; then, that a dish is only orderable while one
 * of its menus is on, in the restaurant's own timezone.
 */

interface PublicMenu {
  public_menu_id: string;
  public_menu_name: string;
  public_menu_on_now: boolean;
  public_menu_hours: Array<{ day: number; opens: string; closes: string }>;
  public_menu_category_ids: string[];
}

describe("multiple menus", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function restaurant(timezone = "UTC") {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set timezone = $2 where id = $1;",
      [restaurantId, timezone],
    );
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, ownerId, categoryId, dishId };
  }

  async function menus(restaurantId: string) {
    const { rows } = await db.asAnon((c) =>
      c.query<PublicMenu>("select * from public.get_public_menus($1);", [
        restaurantId,
      ]),
    );
    return rows;
  }

  async function onNow(categoryId: string) {
    const { rows } = await db.admin.query<{ on: boolean }>(
      "select public.category_on_now($1) as on;",
      [categoryId],
    );
    return rows[0].on;
  }

  async function newMenu(
    userId: string,
    restaurantId: string,
    name: string,
    published = true,
  ) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.menus (restaurant_id, name, is_published) values ($1, $2, $3) returning id;",
        [restaurantId, name, published],
      ),
    );
    return rows[0].id;
  }

  async function setHours(
    userId: string,
    restaurantId: string,
    menuId: string,
    windows: Array<[number, string, string]>,
  ) {
    await db.asUser(userId, async (c) => {
      await c.query("delete from public.menu_hours where menu_id = $1;", [
        menuId,
      ]);
      for (const [day, opens, closes] of windows) {
        await c.query(
          "insert into public.menu_hours (menu_id, restaurant_id, day_of_week, opens_at, closes_at) values ($1, $2, $3, $4, $5);",
          [menuId, restaurantId, day, opens, closes],
        );
      }
    });
  }

  async function moveSection(
    userId: string,
    restaurantId: string,
    categoryId: string,
    fromMenuId: string,
    toMenuId: string,
  ) {
    await db.asUser(userId, async (c) => {
      await c.query(
        "insert into public.menu_sections (menu_id, category_id, restaurant_id) values ($1, $2, $3);",
        [toMenuId, categoryId, restaurantId],
      );
      await c.query(
        "delete from public.menu_sections where menu_id = $1 and category_id = $2;",
        [fromMenuId, categoryId],
      );
    });
  }

  /** The local day/time "now" in a zone, and an hours window that includes or excludes it. */
  async function localNow(timezone: string) {
    const { rows } = await db.admin.query<{ dow: number; t: string }>(
      "select extract(dow from now() at time zone $1)::int as dow, to_char(now() at time zone $1, 'HH24:MI') as t;",
      [timezone],
    );
    return rows[0];
  }

  const defaultMenuId = async (restaurantId: string) =>
    (
      await db.admin.query<{ id: string }>(
        "select id from public.menus where restaurant_id = $1 and is_default;",
        [restaurantId],
      )
    ).rows[0].id;

  describe("nothing changes for a restaurant that never touches menus", () => {
    it("gives every restaurant one default menu, always on, holding every section", async () => {
      const r = await restaurant();
      const second = await createCategory(db, r.restaurantId);
      const [menu, ...others] = await menus(r.restaurantId);
      expect(others).toEqual([]);
      expect(menu.public_menu_name).toBe("Menu");
      expect(menu.public_menu_on_now).toBe(true);
      expect(menu.public_menu_hours).toEqual([]);
      expect([...menu.public_menu_category_ids].sort()).toEqual(
        [r.categoryId, second].sort(),
      );
      expect(await onNow(r.categoryId)).toBe(true);
    });

    it("still takes orders exactly as before", async () => {
      const r = await restaurant();
      const tableId = await createTable(db, r.restaurantId);
      const s = await createCustomerSession(db, r.restaurantId, tableId);
      const cartId = await createCart(db, r.restaurantId, s.sessionId);
      await addCartItem(db, s.userId, cartId, r.restaurantId, r.dishId);
      await expect(
        submitOrder(db, s.userId, crypto.randomUUID()),
      ).resolves.toBeTruthy();
    });

    it("won't let the default menu be unpublished, deleted or demoted", async () => {
      const r = await restaurant();
      const id = await defaultMenuId(r.restaurantId);
      await expect(
        db.asUser(r.ownerId, (c) =>
          c.query(
            "update public.menus set is_published = false where id = $1;",
            [id],
          ),
        ),
      ).rejects.toThrow(/menus_default_is_published/);
      await expect(
        db.asUser(r.ownerId, (c) =>
          c.query("update public.menus set is_default = false where id = $1;", [
            id,
          ]),
        ),
      ).rejects.toThrow(/MENU_DEFAULT_FIXED/);
      await db.asUser(r.ownerId, (c) =>
        c.query("delete from public.menus where id = $1;", [id]),
      );
      expect(await menus(r.restaurantId)).toHaveLength(1); // RLS: nothing deleted
    });

    it("still lets the whole restaurant be deleted", async () => {
      const r = await restaurant();
      await db.admin.query("delete from public.restaurants where id = $1;", [
        r.restaurantId,
      ]);
      const { rows } = await db.admin.query(
        "select 1 from public.menus where restaurant_id = $1;",
        [r.restaurantId],
      );
      expect(rows).toEqual([]);
    });
  });

  describe("hours", () => {
    it("serves a menu only within its hours, in the restaurant's own timezone", async () => {
      // Kolkata is UTC+5:30, far from UTC, so a timezone mix-up shows.
      const r = await restaurant("Asia/Kolkata");
      const lunch = await newMenu(r.ownerId, r.restaurantId, "Lunch");
      await moveSection(
        r.ownerId,
        r.restaurantId,
        r.categoryId,
        await defaultMenuId(r.restaurantId),
        lunch,
      );
      const now = await localNow("Asia/Kolkata");

      // A window covering the restaurant's current local minute: on.
      await setHours(r.ownerId, r.restaurantId, lunch, [
        [now.dow, "00:00", "24:00"],
      ]);
      expect(await onNow(r.categoryId)).toBe(true);

      // Same hours, but on a different day: off.
      await setHours(r.ownerId, r.restaurantId, lunch, [
        [(now.dow + 1) % 7, "00:00", "24:00"],
      ]);
      expect(await onNow(r.categoryId)).toBe(false);
      const [, lunchMenu] = (await menus(r.restaurantId)).sort((a) =>
        a.public_menu_name === "Lunch" ? 1 : -1,
      );
      expect(lunchMenu.public_menu_on_now).toBe(false);
      expect(lunchMenu.public_menu_hours).toEqual([
        { day: (now.dow + 1) % 7, opens: "00:00", closes: "24:00" },
      ]);
    });

    it("keeps a section on while any one of its menus is on", async () => {
      const r = await restaurant();
      const now = await localNow("UTC");
      const lunch = await newMenu(r.ownerId, r.restaurantId, "Lunch");
      await setHours(r.ownerId, r.restaurantId, lunch, [
        [(now.dow + 1) % 7, "11:00", "15:00"],
      ]);
      // On Lunch (off now) and still on the default menu (always on).
      await db.asUser(r.ownerId, (c) =>
        c.query(
          "insert into public.menu_sections (menu_id, category_id, restaurant_id) values ($1, $2, $3);",
          [lunch, r.categoryId, r.restaurantId],
        ),
      );
      expect(await onNow(r.categoryId)).toBe(true);
    });

    it("never serves a draft menu, and hides an inactive section", async () => {
      const r = await restaurant();
      const draft = await newMenu(r.ownerId, r.restaurantId, "Dinner", false);
      await moveSection(
        r.ownerId,
        r.restaurantId,
        r.categoryId,
        await defaultMenuId(r.restaurantId),
        draft,
      );
      expect(await onNow(r.categoryId)).toBe(false);
      expect(
        (await menus(r.restaurantId)).map((m) => m.public_menu_name),
      ).toEqual(["Menu"]);

      await db.asUser(r.ownerId, (c) =>
        c.query("update public.menus set is_published = true where id = $1;", [
          draft,
        ]),
      );
      expect(await onNow(r.categoryId)).toBe(true);
      await db.admin.query(
        "update public.categories set is_active = false where id = $1;",
        [r.categoryId],
      );
      expect(await onNow(r.categoryId)).toBe(false);
    });

    it("refuses a window that closes before it opens", async () => {
      const r = await restaurant();
      const lunch = await newMenu(r.ownerId, r.restaurantId, "Lunch");
      await expect(
        setHours(r.ownerId, r.restaurantId, lunch, [[1, "22:00", "02:00"]]),
      ).rejects.toThrow(/menu_hours_window_valid/);
    });
  });

  describe("a dish whose menu isn't on can't be ordered", () => {
    it("refuses the order, naming the dish, even from a cart filled earlier", async () => {
      const r = await restaurant();
      const tableId = await createTable(db, r.restaurantId);
      const s = await createCustomerSession(db, r.restaurantId, tableId);
      const cartId = await createCart(db, r.restaurantId, s.sessionId);
      await addCartItem(db, s.userId, cartId, r.restaurantId, r.dishId);

      // Lunch ends: the section moves to a menu that isn't on.
      const now = await localNow("UTC");
      const lunch = await newMenu(r.ownerId, r.restaurantId, "Lunch");
      await setHours(r.ownerId, r.restaurantId, lunch, [
        [(now.dow + 1) % 7, "11:00", "15:00"],
      ]);
      await moveSection(
        r.ownerId,
        r.restaurantId,
        r.categoryId,
        await defaultMenuId(r.restaurantId),
        lunch,
      );

      await expect(
        submitOrder(db, s.userId, crypto.randomUUID()),
      ).rejects.toThrow(/ORDER_ITEM_NOT_SERVED_NOW/);
    });
  });

  describe("who can do what", () => {
    it("lets owners and managers manage menus, and everyone on staff see them", async () => {
      const r = await restaurant();
      const manager = await db.createAuthUser();
      await addMember(db, r.restaurantId, manager, "manager");
      await newMenu(manager, r.restaurantId, "Brunch");

      for (const role of ["kitchen", "staff"] as Role[]) {
        const u = await db.createAuthUser();
        await addMember(db, r.restaurantId, u, role);
        await expect(newMenu(u, r.restaurantId, `By ${role}`)).rejects.toThrow(
          /row-level security/,
        );
        const { rows } = await db.asUser(u, (c) =>
          c.query("select name from public.menus where restaurant_id = $1;", [
            r.restaurantId,
          ]),
        );
        expect(rows.length).toBe(2);
      }
    });

    it("won't let anyone create a second default menu", async () => {
      const r = await restaurant();
      await expect(
        db.asUser(r.ownerId, (c) =>
          c.query(
            "insert into public.menus (restaurant_id, name, is_default, is_published) values ($1, 'Another', true, true);",
            [r.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("keeps one restaurant's sections off another's menus", async () => {
      const r = await restaurant();
      const other = await restaurant();
      await expect(
        db.admin.query(
          "insert into public.menu_sections (menu_id, category_id, restaurant_id) values ($1, $2, $3);",
          [
            await defaultMenuId(r.restaurantId),
            other.categoryId,
            r.restaurantId,
          ],
        ),
      ).rejects.toThrow(/menu_sections_category_same_restaurant/);
    });

    it("shows no menus for an inactive restaurant", async () => {
      const r = await restaurant();
      await db.admin.query(
        "update public.restaurants set is_active = false where id = $1;",
        [r.restaurantId],
      );
      expect(await menus(r.restaurantId)).toEqual([]);
    });
  });
});
