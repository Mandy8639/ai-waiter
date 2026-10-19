// @vitest-environment node
//
// Pickup ordering (supabase/migrations/20261022090000_pickup_ordering.sql):
// an order placed at a counter must carry a real, open, not-yet-full pickup
// slot, and an order placed at a table never does.
//
// PGlite runs one connection, so two diners racing for the last place
// cannot be run truly in parallel here. What is tested is the rule the
// lock protects: the count is taken at insert time, inside the order's
// own transaction, so a diner whose cart was set before the slot filled
// is still refused when they press "Place order".
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
} from "./helpers";

interface Options {
  is_counter: boolean;
  timezone?: string;
  chosen_at?: string | null;
  chosen_name?: string | null;
  slots?: { at: string; places_left: number }[];
}

describe("pickup ordering", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function restaurant(capacity = 6) {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurant_settings set pickup_slot_capacity = $2 where restaurant_id = $1;",
      [restaurantId, capacity],
    );
    const counterId = await createTable(db, restaurantId, "Pickup");
    await db.admin.query(
      "update public.tables set kind = 'counter' where id = $1;",
      [counterId],
    );
    const tableId = await createTable(db, restaurantId);
    const categoryId = await createCategory(db, restaurantId);
    const menuItemId = await createMenuItem(db, restaurantId, categoryId);
    const staffId = await db.createAuthUser();
    await addMember(db, restaurantId, staffId, "staff");

    /** A diner at the counter (or at a table), with one dish in their cart. */
    async function diner(at: "counter" | "table" = "counter") {
      const { userId, sessionId } = await createCustomerSession(
        db,
        restaurantId,
        at === "counter" ? counterId : tableId,
      );
      const cartId = await createCart(db, restaurantId, sessionId);
      await addCartItem(db, userId, cartId, restaurantId, menuItemId);
      return { userId, sessionId, cartId };
    }

    return { restaurantId, counterId, tableId, menuItemId, staffId, diner };
  }

  const options = async (userId: string): Promise<Options> => {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ get_pickup_options: Options }>(
        "select public.get_pickup_options();",
      ),
    );
    return rows[0].get_pickup_options;
  };

  const choose = (userId: string, at: string | Date, name = "Priya") =>
    db.asUser(userId, (c) =>
      c.query("select public.set_cart_pickup($1, $2);", [at, name]),
    );

  async function firstSlot(userId: string): Promise<string> {
    const o = await options(userId);
    expect(o.slots?.length).toBeGreaterThan(0);
    return o.slots![0].at;
  }

  async function orderRow(id: string) {
    const { rows } = await db.admin.query<{
      fulfillment: string;
      pickup_at: Date | null;
      pickup_name: string | null;
      ticket_release_at: Date | null;
    }>(
      "select fulfillment, pickup_at, pickup_name, ticket_release_at from public.orders where id = $1;",
      [id],
    );
    return rows[0];
  }

  it("tells a diner at a table that this isn't a pickup visit", async () => {
    const r = await restaurant();
    const d = await r.diner("table");
    expect(await options(d.userId)).toEqual({ is_counter: false });
  });

  it("offers slots on the 15-minute grid, at least the lead time away, at most 8 hours ahead", async () => {
    const r = await restaurant();
    const d = await r.diner();
    const o = await options(d.userId);

    expect(o.is_counter).toBe(true);
    expect(o.timezone).toBe("America/New_York");
    expect(o.slots!.length).toBeGreaterThanOrEqual(30);

    const now = Date.now();
    for (const slot of o.slots!) {
      const t = new Date(slot.at);
      expect(t.getUTCSeconds()).toBe(0);
      // New York is a whole-hour offset from UTC, so the local grid and
      // the UTC grid agree.
      expect(t.getUTCMinutes() % 15).toBe(0);
      expect(t.getTime()).toBeGreaterThanOrEqual(now + 20 * 60_000 - 5_000);
      expect(t.getTime()).toBeLessThanOrEqual(now + 8 * 3_600_000 + 5_000);
      expect(slot.places_left).toBe(6);
    }
  });

  it("refuses a counter order with no pickup time chosen", async () => {
    const r = await restaurant();
    const d = await r.diner();
    await expect(submitOrder(db, d.userId, "no-time")).rejects.toThrow(
      /ORDER_PICKUP: Choose a pickup time/,
    );
  });

  it("places a pickup order, starting the kitchen at the lead time when no dish has a prep time", async () => {
    const r = await restaurant();
    const d = await r.diner();
    const slot = await firstSlot(d.userId);
    await choose(d.userId, slot, "  Priya  ");

    expect((await options(d.userId)).chosen_name).toBe("Priya");

    const order = await submitOrder(db, d.userId, "pickup-1");
    const row = await orderRow(order.id);
    expect(row.fulfillment).toBe("pickup");
    expect(row.pickup_name).toBe("Priya");
    expect(row.pickup_at!.getTime()).toBe(new Date(slot).getTime());
    expect(row.ticket_release_at!.getTime()).toBe(
      new Date(slot).getTime() - 20 * 60_000,
    );

    // The next order in this visit chooses its own time.
    const { rows } = await db.admin.query<{ pickup_at: Date | null }>(
      "select pickup_at from public.carts where id = $1;",
      [d.cartId],
    );
    expect(rows[0].pickup_at).toBeNull();
  });

  it("starts the kitchen by the longest prep time, plus busy mode's extra", async () => {
    const r = await restaurant();
    await db.admin.query(
      "update public.menu_items set preparation_time = 12 where id = $1;",
      [r.menuItemId],
    );
    await db.admin.query(
      "update public.restaurant_settings set busy_extra_minutes = 10, busy_until = now() + interval '1 hour' where restaurant_id = $1;",
      [r.restaurantId],
    );
    const d = await r.diner();
    const slot = await firstSlot(d.userId);
    await choose(d.userId, slot);
    const order = await submitOrder(db, d.userId, "prep");
    const row = await orderRow(order.id);
    expect(row.ticket_release_at!.getTime()).toBe(
      new Date(slot).getTime() - 22 * 60_000,
    );
  });

  it("refuses a slot once it is full, and frees the place when an order is cancelled", async () => {
    const r = await restaurant(1);
    const first = await r.diner();
    const second = await r.diner();
    const slot = await firstSlot(first.userId);

    // Both choose while one place is left.
    await choose(first.userId, slot);
    await choose(second.userId, slot);

    const taken = await submitOrder(db, first.userId, "first");
    expect((await options(second.userId)).slots![0].places_left).toBe(0);

    // The second diner's earlier check is out of date; the insert re-checks.
    await expect(submitOrder(db, second.userId, "second")).rejects.toThrow(
      /ORDER_PICKUP: That pickup time just filled up/,
    );
    await expect(choose(second.userId, slot)).rejects.toThrow(/filled up/);

    await db.admin.query(
      "update public.orders set status = 'cancelled' where id = $1;",
      [taken.id],
    );
    await choose(second.userId, slot);
    const placed = await submitOrder(db, second.userId, "second-again");
    expect((await orderRow(placed.id)).fulfillment).toBe("pickup");
  });

  it("returns the original order on a retried submit, even after its slot filled", async () => {
    const r = await restaurant(1);
    const d = await r.diner();
    await choose(d.userId, await firstSlot(d.userId));
    const once = await submitOrder(db, d.userId, "same-key");
    const again = await submitOrder(db, d.userId, "same-key");
    expect(again.id).toBe(once.id);
  });

  it("refuses a time that is too soon, off the grid, too far ahead, or already past", async () => {
    const r = await restaurant();
    const d = await r.diner();
    const slot = new Date(await firstSlot(d.userId));

    await expect(
      choose(d.userId, new Date(slot.getTime() - 15 * 60_000)),
    ).rejects.toThrow(/too soon/);
    await expect(
      choose(d.userId, new Date(slot.getTime() + 7 * 60_000)),
    ).rejects.toThrow(/isn't one of the restaurant's times/);
    await expect(
      choose(d.userId, new Date(slot.getTime() + 9 * 3_600_000)),
    ).rejects.toThrow(/too far ahead/);
    await expect(
      choose(d.userId, new Date(slot.getTime() - 24 * 3_600_000)),
    ).rejects.toThrow(/too soon/);
  });

  it("offers no slot and refuses any time on a day marked closed", async () => {
    const r = await restaurant();
    const d = await r.diner();
    const slot = await firstSlot(d.userId);
    await db.admin.query(
      `insert into public.restaurant_special_hours (restaurant_id, day, closed)
       select r.id, d::date, true
       from public.restaurants r,
            generate_series(
              (now() at time zone r.timezone)::date,
              (now() at time zone r.timezone)::date + 1,
              interval '1 day') d
       where r.id = $1;`,
      [r.restaurantId],
    );
    expect((await options(d.userId)).slots).toEqual([]);
    await expect(choose(d.userId, slot)).rejects.toThrow(/closed at that time/);
  });

  it("refuses a name that is blank or too long", async () => {
    const r = await restaurant();
    const d = await r.diner();
    const slot = await firstSlot(d.userId);
    await expect(choose(d.userId, slot, "   ")).rejects.toThrow(
      /name we should call out/,
    );
    await expect(choose(d.userId, slot, "x".repeat(41))).rejects.toThrow(
      /40 characters/,
    );
  });

  it("keeps a table's order a dine-in order, and won't take a pickup time there", async () => {
    const r = await restaurant();
    const d = await r.diner("table");
    await expect(choose(d.userId, new Date())).rejects.toThrow(
      /only for orders placed at a pickup counter/,
    );
    const order = await submitOrder(db, d.userId, "dine-in");
    expect(await orderRow(order.id)).toEqual({
      fulfillment: "dine_in",
      pickup_at: null,
      pickup_name: null,
      ticket_release_at: null,
    });
  });

  it("lets staff move a pickup order to an open slot, recomputing when the kitchen starts", async () => {
    const r = await restaurant(1);
    const d = await r.diner();
    const slots = (await options(d.userId)).slots!;
    await choose(d.userId, slots[0].at);
    const order = await submitOrder(db, d.userId, "move-me");

    // Into the slot it already holds: its own place doesn't count against it.
    await db.asUser(r.staffId, (c) =>
      c.query("select public.change_pickup_time($1, $2);", [
        order.id,
        slots[0].at,
      ]),
    );
    await db.asUser(r.staffId, (c) =>
      c.query("select public.change_pickup_time($1, $2);", [
        order.id,
        slots[2].at,
      ]),
    );
    const row = await orderRow(order.id);
    expect(row.pickup_at!.getTime()).toBe(new Date(slots[2].at).getTime());
    expect(row.ticket_release_at!.getTime()).toBe(
      new Date(slots[2].at).getTime() - 20 * 60_000,
    );
  });

  it("refuses to move an order into a full slot, for a stranger, or once it's ready", async () => {
    const r = await restaurant(1);
    const a = await r.diner();
    const b = await r.diner();
    const slots = (await options(a.userId)).slots!;
    await choose(a.userId, slots[0].at);
    await choose(b.userId, slots[1].at);
    const orderA = await submitOrder(db, a.userId, "a");
    await submitOrder(db, b.userId, "b");

    const move = (userId: string, at: string) =>
      db.asUser(userId, (c) =>
        c.query("select public.change_pickup_time($1, $2);", [orderA.id, at]),
      );

    await expect(move(r.staffId, slots[1].at)).rejects.toThrow(/filled up/);

    const stranger = await db.createAuthUser();
    await expect(move(stranger, slots[3].at)).rejects.toThrow(
      /PICKUP_NOT_FOUND/,
    );

    await db.admin.query(
      "update public.orders set status = 'confirmed' where id = $1;",
      [orderA.id],
    );
    await db.admin.query(
      "update public.orders set status = 'preparing' where id = $1;",
      [orderA.id],
    );
    await db.admin.query(
      "update public.orders set status = 'ready' where id = $1;",
      [orderA.id],
    );
    await expect(move(r.staffId, slots[3].at)).rejects.toThrow(
      /isn't ready yet/,
    );
  });

  it("never lets an order's fulfilment or pickup name change after it is placed", async () => {
    const r = await restaurant();
    const d = await r.diner();
    await choose(d.userId, await firstSlot(d.userId));
    const order = await submitOrder(db, d.userId, "immutable");
    await expect(
      db.admin.query(
        "update public.orders set pickup_name = 'Someone else' where id = $1;",
        [order.id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("won't reserve a pickup counter", async () => {
    const r = await restaurant();
    await expect(
      db.admin.query(
        `insert into public.reservations
           (restaurant_id, table_id, customer_name, customer_phone, party_size, reservation_time)
         values ($1, $2, 'A Guest', '+15555550100', 2, now() + interval '1 day');`,
        [r.restaurantId, r.counterId],
      ),
    ).rejects.toThrow(/can't be reserved/);
  });
});
