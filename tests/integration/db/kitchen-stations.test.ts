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
  transitionOrderStatus,
  type Role,
} from "./helpers";

/**
 * Phase I: kitchen stations. Routing (a line goes to its dish's station,
 * frozen at order time), who manages stations, and marking a station's
 * part done without touching the order's status.
 */
describe("kitchen stations", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function kitchen() {
    const restaurantId = await createRestaurant(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, restaurantId, ownerId, "owner");
    const categoryId = await createCategory(db, restaurantId);
    const burger = await createMenuItem(db, restaurantId, categoryId);
    const fries = await createMenuItem(db, restaurantId, categoryId);
    const salad = await createMenuItem(db, restaurantId, categoryId);
    return { restaurantId, ownerId, categoryId, burger, fries, salad };
  }

  async function station(userId: string, restaurantId: string, name: string) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "insert into public.kitchen_stations (restaurant_id, name) values ($1, $2) returning id;",
        [restaurantId, name],
      ),
    );
    return rows[0].id;
  }

  async function assign(
    userId: string,
    menuItemId: string,
    stationId: string | null,
  ) {
    await db.asUser(userId, (c) =>
      c.query("update public.menu_items set station_id = $1 where id = $2;", [
        stationId,
        menuItemId,
      ]),
    );
  }

  async function order(restaurantId: string, items: string[]) {
    const tableId = await createTable(db, restaurantId);
    const s = await createCustomerSession(db, restaurantId, tableId);
    const cartId = await createCart(db, restaurantId, s.sessionId);
    for (const item of items) {
      await addCartItem(db, s.userId, cartId, restaurantId, item);
    }
    return submitOrder(db, s.userId, crypto.randomUUID());
  }

  async function lineStations(orderId: string) {
    const { rows } = await db.admin.query<{
      menu_item_id: string;
      station_id: string | null;
    }>(
      "select menu_item_id, station_id from public.order_items where order_id = $1;",
      [orderId],
    );
    return new Map(rows.map((r) => [r.menu_item_id, r.station_id]));
  }

  async function member(restaurantId: string, role: Role) {
    const u = await db.createAuthUser();
    await addMember(db, restaurantId, u, role);
    return u;
  }

  async function markDone(
    userId: string,
    orderId: string,
    stationId: string,
    done = true,
  ) {
    await db.asUser(userId, (c) =>
      c.query("select public.set_order_station_done($1, $2, $3);", [
        orderId,
        stationId,
        done,
      ]),
    );
  }

  describe("routing", () => {
    it("sends each line to its dish's station when the order is placed", async () => {
      const k = await kitchen();
      const grill = await station(k.ownerId, k.restaurantId, "Grill");
      const fry = await station(k.ownerId, k.restaurantId, "Fry");
      await assign(k.ownerId, k.burger, grill);
      await assign(k.ownerId, k.fries, fry);

      const o = await order(k.restaurantId, [k.burger, k.fries, k.salad]);
      const lines = await lineStations(o.id);
      expect(lines.get(k.burger)).toBe(grill);
      expect(lines.get(k.fries)).toBe(fry);
      expect(lines.get(k.salad)).toBeNull(); // unassigned: shown everywhere
    });

    it("keeps tickets already placed where they were when a dish is reassigned", async () => {
      const k = await kitchen();
      const grill = await station(k.ownerId, k.restaurantId, "Grill");
      const fry = await station(k.ownerId, k.restaurantId, "Fry");
      await assign(k.ownerId, k.burger, grill);
      const before = await order(k.restaurantId, [k.burger]);
      await assign(k.ownerId, k.burger, fry);
      const after = await order(k.restaurantId, [k.burger]);

      expect((await lineStations(before.id)).get(k.burger)).toBe(grill);
      expect((await lineStations(after.id)).get(k.burger)).toBe(fry);
    });

    it("unassigns dishes and lines, not deletes them, when a station is removed", async () => {
      const k = await kitchen();
      const grill = await station(k.ownerId, k.restaurantId, "Grill");
      await assign(k.ownerId, k.burger, grill);
      const o = await order(k.restaurantId, [k.burger]);

      await db.asUser(k.ownerId, (c) =>
        c.query("delete from public.kitchen_stations where id = $1;", [grill]),
      );

      const { rows: dish } = await db.admin.query<{
        station_id: string | null;
        restaurant_id: string;
      }>(
        "select station_id, restaurant_id from public.menu_items where id = $1;",
        [k.burger],
      );
      expect(dish[0]).toEqual({
        station_id: null,
        restaurant_id: k.restaurantId,
      });
      expect((await lineStations(o.id)).get(k.burger)).toBeNull();
    });

    it("refuses a station from another restaurant", async () => {
      const k = await kitchen();
      const other = await kitchen();
      const theirs = await station(other.ownerId, other.restaurantId, "Grill");
      await expect(
        db.admin.query(
          "update public.menu_items set station_id = $1 where id = $2;",
          [theirs, k.burger],
        ),
      ).rejects.toThrow(/menu_items_station_same_restaurant/);
    });
  });

  describe("managing stations", () => {
    it("lets owners and managers create them, and everyone on staff see them", async () => {
      const k = await kitchen();
      const manager = await member(k.restaurantId, "manager");
      await station(manager, k.restaurantId, "Cold");

      for (const role of ["kitchen", "staff"] as const) {
        const u = await member(k.restaurantId, role);
        await expect(station(u, k.restaurantId, `By ${role}`)).rejects.toThrow(
          /row-level security/,
        );
        const { rows } = await db.asUser(u, (c) =>
          c.query(
            "select name from public.kitchen_stations where restaurant_id = $1;",
            [k.restaurantId],
          ),
        );
        expect(rows).toEqual([{ name: "Cold" }]);
      }
    });

    it("hides one restaurant's stations from another's staff", async () => {
      const k = await kitchen();
      await station(k.ownerId, k.restaurantId, "Grill");
      const stranger = await kitchen();
      const { rows } = await db.asUser(stranger.ownerId, (c) =>
        c.query(
          "select 1 from public.kitchen_stations where restaurant_id = $1;",
          [k.restaurantId],
        ),
      );
      expect(rows).toEqual([]);
    });

    it("refuses a duplicate or empty name", async () => {
      const k = await kitchen();
      await station(k.ownerId, k.restaurantId, "Grill");
      await expect(
        station(k.ownerId, k.restaurantId, " grill "),
      ).rejects.toThrow(/kitchen_stations_name_unique/);
      await expect(station(k.ownerId, k.restaurantId, "   ")).rejects.toThrow(
        /kitchen_stations_name_length/,
      );
    });
  });

  describe("a station's part done", () => {
    async function activeOrder() {
      const k = await kitchen();
      const grill = await station(k.ownerId, k.restaurantId, "Grill");
      const fry = await station(k.ownerId, k.restaurantId, "Fry");
      await assign(k.ownerId, k.burger, grill);
      await assign(k.ownerId, k.fries, fry);
      const o = await order(k.restaurantId, [k.burger, k.fries]);
      await transitionOrderStatus(db, k.ownerId, o.id, "confirmed");
      await transitionOrderStatus(db, k.ownerId, o.id, "preparing");
      return { ...k, grill, fry, orderId: o.id };
    }

    async function doneStations(orderId: string) {
      const { rows } = await db.admin.query<{ station_id: string }>(
        "select station_id from public.order_station_done where order_id = $1 order by station_id;",
        [orderId],
      );
      return rows.map((r) => r.station_id);
    }

    it("records a station done without changing the order's status", async () => {
      const a = await activeOrder();
      const cook = await member(a.restaurantId, "kitchen");
      await markDone(cook, a.orderId, a.grill);
      await markDone(cook, a.orderId, a.grill); // twice is still once

      expect(await doneStations(a.orderId)).toEqual([a.grill]);
      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.orders where id = $1;",
        [a.orderId],
      );
      expect(rows[0].status).toBe("preparing");
    });

    it("can be undone", async () => {
      const a = await activeOrder();
      await markDone(a.ownerId, a.orderId, a.grill);
      await markDone(a.ownerId, a.orderId, a.grill, false);
      expect(await doneStations(a.orderId)).toEqual([]);
    });

    it("touches the order so every kitchen screen refreshes", async () => {
      const a = await activeOrder();
      await db.admin.query(
        "update public.orders set updated_at = now() - interval '1 hour' where id = $1;",
        [a.orderId],
      );
      await markDone(a.ownerId, a.orderId, a.fry);
      const { rows } = await db.admin.query<{ recent: boolean }>(
        "select updated_at > now() - interval '1 minute' as recent from public.orders where id = $1;",
        [a.orderId],
      );
      expect(rows[0].recent).toBe(true);
    });

    it("is for the kitchen and its managers, not floor staff or diners", async () => {
      const a = await activeOrder();
      const floor = await member(a.restaurantId, "staff");
      await expect(markDone(floor, a.orderId, a.grill)).rejects.toThrow(
        /STATION_FORBIDDEN/,
      );
      const stranger = await kitchen();
      await expect(
        markDone(stranger.ownerId, a.orderId, a.grill),
      ).rejects.toThrow(/STATION_FORBIDDEN/);
    });

    it("only applies to an order being worked on", async () => {
      const k = await kitchen();
      const grill = await station(k.ownerId, k.restaurantId, "Grill");
      const o = await order(k.restaurantId, [k.burger]);
      await expect(markDone(k.ownerId, o.id, grill)).rejects.toThrow(
        /STATION_ORDER_NOT_ACTIVE/,
      );
    });

    it("refuses another restaurant's station", async () => {
      const a = await activeOrder();
      const other = await kitchen();
      const theirs = await station(other.ownerId, other.restaurantId, "Grill");
      await expect(markDone(a.ownerId, a.orderId, theirs)).rejects.toThrow(
        /STATION_NOT_FOUND/,
      );
    });

    it("cannot be written directly", async () => {
      const a = await activeOrder();
      await expect(
        db.asUser(a.ownerId, (c) =>
          c.query(
            "insert into public.order_station_done (order_id, station_id, restaurant_id) values ($1, $2, $3);",
            [a.orderId, a.grill, a.restaurantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});
