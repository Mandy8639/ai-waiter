// @vitest-environment node
//
// Three small things restaurants hit every week
// (supabase/migrations/20261019090000_service_features.sql): a dish sold out
// until the next opening, holiday and special hours, and the database side
// of both.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createCategory,
  createMenuItem,
  createRestaurant,
  fullCustomerFixture,
  submitOrder,
  type Role,
} from "./helpers";

describe("service features", () => {
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
    const categoryId = await createCategory(db, restaurantId);
    const dishId = await createMenuItem(db, restaurantId, categoryId);
    const member = async (role: Role) => {
      const userId = await db.createAuthUser();
      await addMember(db, restaurantId, userId, role);
      return userId;
    };
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.menus where restaurant_id = $1 and is_default;",
      [restaurantId],
    );
    return { restaurantId, categoryId, dishId, member, menuId: rows[0].id };
  }

  /** Today's date in the restaurant's timezone, as the database sees it. */
  const today = `(select (now() at time zone coalesce(r.timezone, 'UTC'))::date
                  from public.restaurants r where r.id = $1)`;

  const closeToday = (restaurantId: string, note: string | null = null) =>
    db.admin.query(
      `insert into public.restaurant_special_hours (restaurant_id, day, closed, note)
       values ($1, ${today}, true, $2);`,
      [restaurantId, note],
    );

  const hoursToday = (restaurantId: string, opens: string, closes: string) =>
    db.admin.query(
      `insert into public.restaurant_special_hours (restaurant_id, day, opens_at, closes_at)
       values ($1, ${today}, $2, $3)
       on conflict (restaurant_id, day) do update
         set closed = false, opens_at = excluded.opens_at, closes_at = excluded.closes_at;`,
      [restaurantId, opens, closes],
    );

  const menuOnNow = async (menuId: string) =>
    (
      await db.admin.query<{ on: boolean }>(
        "select public.menu_on_now($1) as on;",
        [menuId],
      )
    ).rows[0].on;

  /** A window today that doesn't include the current (UTC) time. */
  const windowNotNow = () =>
    new Date().getUTCHours() < 12 ? ["13:00", "14:00"] : ["01:00", "02:00"];

  describe("holiday and special hours", () => {
    it("closes ordering for the whole day, and says why to diners", async () => {
      const f = await fullCustomerFixture(db);
      await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
      await closeToday(f.restaurantId, "Diwali");

      const { rows } = await db.asAnon((c) =>
        c.query("select * from public.get_special_hours_today($1);", [
          f.restaurantId,
        ]),
      );
      expect(rows).toEqual([
        { closed: true, opens_at: null, closes_at: null, note: "Diwali" },
      ]);

      const menus = await db.asAnon((c) =>
        c.query<{ public_menu_on_now: boolean }>(
          "select public_menu_on_now from public.get_public_menus($1);",
          [f.restaurantId],
        ),
      );
      expect(menus.rows.map((m) => m.public_menu_on_now)).toEqual([false]);

      await expect(
        submitOrder(db, f.userId, crypto.randomUUID()),
      ).rejects.toThrow(/ORDER_ITEM_NOT_SERVED_NOW/);

      // Taking the day off the calendar reopens straight away.
      await db.admin.query(
        "delete from public.restaurant_special_hours where restaurant_id = $1;",
        [f.restaurantId],
      );
      await submitOrder(db, f.userId, crypto.randomUUID());
    });

    it("limits the day to the special hours", async () => {
      const r = await restaurant();
      expect(await menuOnNow(r.menuId)).toBe(true);

      const [opens, closes] = windowNotNow();
      await hoursToday(r.restaurantId, opens, closes);
      expect(await menuOnNow(r.menuId)).toBe(false);

      await hoursToday(r.restaurantId, "00:00", "24:00");
      expect(await menuOnNow(r.menuId)).toBe(true);

      const { rows } = await db.asAnon((c) =>
        c.query("select * from public.get_special_hours_today($1);", [
          r.restaurantId,
        ]),
      );
      expect(rows).toEqual([
        { closed: false, opens_at: "00:00", closes_at: "24:00", note: null },
      ]);
    });

    it("leaves other days and other restaurants alone", async () => {
      const r = await restaurant();
      const other = await restaurant();
      await db.admin.query(
        `insert into public.restaurant_special_hours (restaurant_id, day, closed)
         values ($1, ${today} + 1, true);`,
        [r.restaurantId],
      );
      await closeToday(other.restaurantId);
      expect(await menuOnNow(r.menuId)).toBe(true);
      expect(await menuOnNow(other.menuId)).toBe(false);
      const { rows } = await db.asAnon((c) =>
        c.query("select * from public.get_special_hours_today($1);", [
          r.restaurantId,
        ]),
      );
      expect(rows).toEqual([]);
    });

    it("lets owners and managers set them; the rest of the team only sees them", async () => {
      const r = await restaurant();
      const insert = (userId: string, day: string) =>
        db.asUser(userId, (c) =>
          c.query(
            "insert into public.restaurant_special_hours (restaurant_id, day, closed) values ($1, $2, true);",
            [r.restaurantId, day],
          ),
        );

      await insert(await r.member("owner"), "2030-12-25");
      await insert(await r.member("manager"), "2030-12-26");
      for (const role of ["kitchen", "staff"] as const) {
        const userId = await r.member(role);
        await expect(insert(userId, "2030-12-27")).rejects.toThrow(
          /row-level security/i,
        );
        const { rows } = await db.asUser(userId, (c) =>
          c.query("select day from public.restaurant_special_hours;"),
        );
        expect(rows).toHaveLength(2);
      }

      const stranger = await (await restaurant()).member("owner");
      await expect(insert(stranger, "2030-12-28")).rejects.toThrow(
        /row-level security/i,
      );
      const { rows } = await db.asUser(stranger, (c) =>
        c.query(
          "select day from public.restaurant_special_hours where restaurant_id = $1;",
          [r.restaurantId],
        ),
      );
      expect(rows).toEqual([]);
    });

    it("refuses nonsense: times on a closed day, closing before opening, two rows a day", async () => {
      const r = await restaurant();
      const bad = [
        "insert into public.restaurant_special_hours (restaurant_id, day, closed, opens_at, closes_at) values ($1, '2030-01-01', true, '10:00', '12:00');",
        "insert into public.restaurant_special_hours (restaurant_id, day, opens_at, closes_at) values ($1, '2030-01-01', '12:00', '10:00');",
        "insert into public.restaurant_special_hours (restaurant_id, day) values ($1, '2030-01-01');",
        "insert into public.restaurant_special_hours (restaurant_id, day, closed, note) values ($1, '2030-01-01', true, repeat('x', 81));",
      ];
      for (const sql of bad) {
        await expect(db.admin.query(sql, [r.restaurantId])).rejects.toThrow(
          /check constraint/i,
        );
      }
      await closeToday(r.restaurantId);
      await expect(closeToday(r.restaurantId)).rejects.toThrow(
        /restaurant_special_hours_one_per_day/,
      );
    });
  });

  describe("when is the next opening", () => {
    const NY = "America/New_York";
    // 2026-11-03 is a Tuesday, after the clocks went back on November 1.
    const nextOpening = async (restaurantId: string, localFrom: string) =>
      (
        await db.admin.query<{ at: string }>(
          `select to_char(public.next_opening_after($1, ($2::timestamp at time zone $3)) at time zone $3,
                          'Dy YYYY-MM-DD HH24:MI') as at;`,
          [restaurantId, localFrom, NY],
        )
      ).rows[0].at;

    const addHours = (
      r: { restaurantId: string; menuId: string },
      day: number,
      opens: string,
      closes: string,
    ) =>
      db.admin.query(
        "insert into public.menu_hours (menu_id, restaurant_id, day_of_week, opens_at, closes_at) values ($1, $2, $3, $4, $5);",
        [r.menuId, r.restaurantId, day, opens, closes],
      );

    it("is 4am tomorrow for a restaurant with no hours set", async () => {
      const r = await restaurant(NY);
      expect(await nextOpening(r.restaurantId, "2026-11-03 21:00")).toBe(
        "Wed 2026-11-04 04:00",
      );
      // Just after midnight is still last night's service.
      expect(await nextOpening(r.restaurantId, "2026-11-04 00:30")).toBe(
        "Wed 2026-11-04 04:00",
      );
    });

    it("is the next day's first menu opening, in the restaurant's timezone", async () => {
      const r = await restaurant(NY);
      await addHours(r, 2, "11:00", "22:00"); // Tue
      await addHours(r, 3, "17:00", "22:00"); // Wed: dinner only
      await addHours(r, 4, "11:00", "15:00"); // Thu lunch
      await addHours(r, 4, "17:00", "22:00"); // Thu dinner
      expect(await nextOpening(r.restaurantId, "2026-11-03 21:00")).toBe(
        "Wed 2026-11-04 17:00",
      );
      // A lunch sell-out still means tomorrow, not tonight's dinner.
      expect(await nextOpening(r.restaurantId, "2026-11-05 14:00")).toBe(
        "Tue 2026-11-10 11:00",
      );
    });

    it("skips a closed holiday, and waits for late special hours", async () => {
      const r = await restaurant(NY);
      for (const day of [0, 1, 2, 3, 4, 5, 6]) {
        await addHours(r, day, "11:00", "22:00");
      }
      await db.admin.query(
        `insert into public.restaurant_special_hours (restaurant_id, day, closed, opens_at, closes_at) values
           ($1, '2026-11-04', true, null, null),
           ($1, '2026-11-05', false, '15:00', '20:00');`,
        [r.restaurantId],
      );
      expect(await nextOpening(r.restaurantId, "2026-11-03 21:00")).toBe(
        "Thu 2026-11-05 15:00",
      );
    });

    it("ignores the hours of menus that aren't published", async () => {
      const r = await restaurant(NY);
      await addHours(r, 3, "17:00", "22:00");
      const { rows } = await db.admin.query<{ id: string }>(
        "insert into public.menus (restaurant_id, name, is_published) values ($1, 'Brunch', false) returning id;",
        [r.restaurantId],
      );
      await addHours(
        { restaurantId: r.restaurantId, menuId: rows[0].id },
        3,
        "09:00",
        "12:00",
      );
      expect(await nextOpening(r.restaurantId, "2026-11-03 21:00")).toBe(
        "Wed 2026-11-04 17:00",
      );
    });
  });

  describe("sold out until the next opening", () => {
    const soldOutUntilTomorrow = (userId: string, dishId: string) =>
      db.asUser(userId, (c) =>
        c.query<{ back: string }>(
          "select public.set_menu_item_sold_out_until_next_opening($1) as back;",
          [dishId],
        ),
      );

    const dish = async (dishId: string) =>
      (
        await db.admin.query<{
          is_available: boolean;
          available_again_at: Date | null;
        }>(
          "select is_available, available_again_at from public.menu_items where id = $1;",
          [dishId],
        )
      ).rows[0];

    it("lets the kitchen or a manager mark it, and says when it comes back", async () => {
      const r = await restaurant();
      for (const role of ["kitchen", "manager", "owner"] as const) {
        const userId = await r.member(role);
        const { rows } = await soldOutUntilTomorrow(userId, r.dishId);
        const back = new Date(rows[0].back);
        expect(back.getTime()).toBeGreaterThan(Date.now());
        expect(await dish(r.dishId)).toEqual({
          is_available: false,
          available_again_at: back,
        });
      }
    });

    it("refuses front-of-house staff and other restaurants", async () => {
      const r = await restaurant();
      const staff = await r.member("staff");
      await expect(soldOutUntilTomorrow(staff, r.dishId)).rejects.toThrow(
        /SOLD_OUT_FORBIDDEN/,
      );
      const stranger = await (await restaurant()).member("kitchen");
      await expect(soldOutUntilTomorrow(stranger, r.dishId)).rejects.toThrow(
        /SOLD_OUT_FORBIDDEN/,
      );
      expect((await dish(r.dishId)).is_available).toBe(true);
    });

    it("drops the timer when someone switches it by hand", async () => {
      const r = await restaurant();
      const kitchen = await r.member("kitchen");
      const set = (available: boolean) =>
        db.asUser(kitchen, (c) =>
          c.query("select public.set_menu_item_availability($1, $2);", [
            r.dishId,
            available,
          ]),
        );

      await soldOutUntilTomorrow(kitchen, r.dishId);
      await set(true);
      expect(await dish(r.dishId)).toEqual({
        is_available: true,
        available_again_at: null,
      });

      // Sold out "until further notice" means no timer either.
      await soldOutUntilTomorrow(kitchen, r.dishId);
      await set(false);
      expect(await dish(r.dishId)).toEqual({
        is_available: false,
        available_again_at: null,
      });

      // And an owner editing the dish back on clears it too.
      await soldOutUntilTomorrow(kitchen, r.dishId);
      await db.asUser(await r.member("owner"), (c) =>
        c.query(
          "update public.menu_items set is_available = true where id = $1;",
          [r.dishId],
        ),
      );
      expect((await dish(r.dishId)).available_again_at).toBeNull();
    });

    it("comes back by itself once its time has come, and not before", async () => {
      const r = await restaurant();
      const later = await createMenuItem(db, r.restaurantId, r.categoryId);
      const forever = await createMenuItem(db, r.restaurantId, r.categoryId);
      await db.admin.query(
        `update public.menu_items set is_available = false,
           available_again_at = case id when $1 then now() - interval '1 minute'
                                        when $2 then now() + interval '1 hour' end
         where id in ($1, $2, $3);`,
        [r.dishId, later, forever],
      );

      const { rows } = await db.admin.query<{ n: number }>(
        "select public.restore_menu_items_due() as n;",
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
      expect(await dish(r.dishId)).toEqual({
        is_available: true,
        available_again_at: null,
      });
      expect((await dish(later)).is_available).toBe(false);
      expect((await dish(forever)).is_available).toBe(false);
    });

    it("can't be triggered or probed from outside", async () => {
      const r = await restaurant();
      const owner = await r.member("owner");
      for (const sql of [
        "select public.restore_menu_items_due();",
        `select public.next_opening_after('${r.restaurantId}', now());`,
        `select public.special_hours_allow_now('${r.restaurantId}');`,
      ]) {
        await expect(db.asAnon((c) => c.query(sql))).rejects.toThrow(
          /permission denied/i,
        );
        await expect(
          db.asUser(owner, (c) => c.query(sql), "aal2"),
        ).rejects.toThrow(/permission denied/i);
      }
    });
  });
});
