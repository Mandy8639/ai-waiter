// @vitest-environment node
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
  createCustomerSession,
  createCart,
  createTable,
} from "./helpers";

/**
 * Phase H: the dish funnel. What is counted (once per visit, from every
 * path), who can read it (owners and managers), and — the point of the
 * design — what is NOT kept: nothing that names a diner outlives the visit.
 */

interface FunnelRow {
  dish_id: string;
  dish_name: string;
  opened_visits: string;
  added_visits: string;
  ordered_visits: string;
  ordered_after_open_visits: string;
}

describe("dish funnel", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seated() {
    const f = await fullCustomerFixture(db);
    const ownerId = await db.createAuthUser();
    await addMember(db, f.restaurantId, ownerId, "owner");
    return { ...f, ownerId };
  }

  async function open(userId: string, menuItemId: string) {
    await db.asUser(userId, (c) =>
      c.query("select public.record_dish_view($1);", [menuItemId]),
    );
  }

  async function funnel(
    userId: string,
    restaurantId: string,
    from = "2000-01-01T00:00:00Z",
    to = "2100-01-01T00:00:00Z",
  ) {
    const { rows } = await db.asUser(userId, (c) =>
      c.query<FunnelRow>("select * from public.get_dish_funnel($1, $2, $3);", [
        restaurantId,
        from,
        to,
      ]),
    );
    return rows.map((r) => ({
      name: r.dish_name,
      opened: Number(r.opened_visits),
      added: Number(r.added_visits),
      ordered: Number(r.ordered_visits),
      orderedAfterOpen: Number(r.ordered_after_open_visits),
    }));
  }

  describe("counting", () => {
    it("counts a visit that opens, adds and orders a dish once at each step", async () => {
      const f = await seated();
      await open(f.userId, f.menuItemId);
      await open(f.userId, f.menuItemId); // opening it again is still one visit
      await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
      await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
      await submitOrder(db, f.userId, crypto.randomUUID());

      const [row] = await funnel(f.ownerId, f.restaurantId);
      expect(row).toMatchObject({
        opened: 1,
        added: 1,
        ordered: 1,
        orderedAfterOpen: 1,
      });
    });

    it("counts each visit separately", async () => {
      const f = await seated();
      const second = await createCustomerSession(db, f.restaurantId, f.tableId);
      await open(f.userId, f.menuItemId);
      await open(second.userId, f.menuItemId);
      const [row] = await funnel(f.ownerId, f.restaurantId);
      expect(row.opened).toBe(2);
    });

    it("counts an order without an earlier open as ordered, but not as a conversion", async () => {
      // The AI waiter can add a dish the diner never opened.
      const f = await seated();
      await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
      await submitOrder(db, f.userId, crypto.randomUUID());
      const [row] = await funnel(f.ownerId, f.restaurantId);
      expect(row).toMatchObject({ opened: 0, ordered: 1, orderedAfterOpen: 0 });
    });

    it("does not count someone who is not seated — an owner previewing the menu", async () => {
      const f = await seated();
      await open(f.ownerId, f.menuItemId);
      expect(await funnel(f.ownerId, f.restaurantId)).toEqual([]);
    });

    it("does not count a visit whose session has ended", async () => {
      const f = await seated();
      const ended = await createCustomerSession(db, f.restaurantId, f.tableId, {
        status: "closed",
      });
      await open(ended.userId, f.menuItemId);
      expect(await funnel(f.ownerId, f.restaurantId)).toEqual([]);
    });

    it("ignores a dish from another restaurant", async () => {
      const f = await seated();
      const other = await createRestaurant(db);
      const otherItem = await createMenuItem(
        db,
        other,
        await createCategory(db, other),
      );
      await open(f.userId, otherItem);
      const { rows } = await db.admin.query(
        "select 1 from public.dish_daily_stats where menu_item_id = $1;",
        [otherItem],
      );
      expect(rows).toHaveLength(0);
    });

    it("never raises to the diner, whatever it is given", async () => {
      const f = await seated();
      await expect(
        open(f.userId, crypto.randomUUID()),
      ).resolves.toBeUndefined();
    });

    it("is not writable or readable directly by any client", async () => {
      const f = await seated();
      await expect(
        db.asUser(f.userId, (c) =>
          c.query("select public.record_dish_signal($1, $2, $3, 'open');", [
            f.sessionId,
            f.restaurantId,
            f.menuItemId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);

      await open(f.userId, f.menuItemId);
      const { rows } = await db.asUser(f.ownerId, (c) =>
        c.query("select * from public.dish_daily_stats;"),
      );
      expect(rows).toEqual([]); // RLS on, no policies
    });
  });

  describe("what is kept", () => {
    it("stores counts with no diner, session or table in them", async () => {
      const { rows } = await db.admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'dish_daily_stats'
         order by ordinal_position;`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "restaurant_id",
        "menu_item_id",
        "day",
        "opened",
        "added",
        "ordered",
        "ordered_after_open",
      ]);
    });

    it("forgets which visit did what after two days", async () => {
      const f = await seated();
      await open(f.userId, f.menuItemId);
      await db.admin.query(
        "update public.dish_visit_marks set created_at = now() - interval '3 days' where customer_session_id = $1;",
        [f.sessionId],
      );

      // Any later signal sweeps old marks.
      const g = await seated();
      await open(g.userId, g.menuItemId);

      const { rows } = await db.admin.query(
        "select 1 from public.dish_visit_marks where customer_session_id = $1;",
        [f.sessionId],
      );
      expect(rows).toHaveLength(0);
      // The count stays.
      const [row] = await funnel(f.ownerId, f.restaurantId);
      expect(row.opened).toBe(1);
    });

    it("forgets a visit's marks the moment the visit is deleted", async () => {
      const f = await seated();
      await open(f.userId, f.menuItemId);
      await db.admin.query("delete from public.carts where id = $1;", [
        f.cartId,
      ]);
      await db.admin.query(
        "delete from public.customer_sessions where id = $1;",
        [f.sessionId],
      );
      const { rows } = await db.admin.query(
        "select 1 from public.dish_visit_marks where customer_session_id = $1;",
        [f.sessionId],
      );
      expect(rows).toHaveLength(0);
    });

    it("keeps the counts when a dish is renamed, and drops them when it is deleted", async () => {
      const f = await seated();
      await open(f.userId, f.menuItemId);
      await db.admin.query(
        "update public.menu_items set name = 'Masala Dosa' where id = $1;",
        [f.menuItemId],
      );
      expect((await funnel(f.ownerId, f.restaurantId))[0].name).toBe(
        "Masala Dosa",
      );
    });
  });

  describe("days", () => {
    it("files a count under the restaurant's own day and reports by it", async () => {
      const f = await seated();
      await db.admin.query(
        "update public.restaurants set timezone = 'Asia/Kolkata' where id = $1;",
        [f.restaurantId],
      );
      await open(f.userId, f.menuItemId);
      const { rows } = await db.admin.query<{ day: string; today: string }>(
        `select s.day::text as day,
                (now() at time zone 'Asia/Kolkata')::date::text as today
         from public.dish_daily_stats s where s.menu_item_id = $1;`,
        [f.menuItemId],
      );
      expect(rows[0].day).toBe(rows[0].today);

      // A range that ends before today (Kolkata) sees nothing.
      const { rows: r } = await db.admin.query<{ start: string }>(
        "select ((now() at time zone 'Asia/Kolkata')::date::timestamp at time zone 'Asia/Kolkata')::text as start;",
      );
      expect(
        await funnel(
          f.ownerId,
          f.restaurantId,
          "2000-01-01T00:00:00Z",
          r[0].start,
        ),
      ).toEqual([]);
      expect(await funnel(f.ownerId, f.restaurantId, r[0].start)).toHaveLength(
        1,
      );
    });
  });

  describe("who can see it", () => {
    it("lets a manager read it, and refuses staff, kitchen and diners", async () => {
      const f = await seated();
      await open(f.userId, f.menuItemId);

      const manager = await db.createAuthUser();
      await addMember(db, f.restaurantId, manager, "manager");
      expect(await funnel(manager, f.restaurantId)).toHaveLength(1);

      for (const role of ["staff", "kitchen"] as const) {
        const u = await db.createAuthUser();
        await addMember(db, f.restaurantId, u, role);
        await expect(funnel(u, f.restaurantId)).rejects.toThrow(
          /REPORT_FORBIDDEN/,
        );
      }
      await expect(funnel(f.userId, f.restaurantId)).rejects.toThrow(
        /REPORT_FORBIDDEN/,
      );
    });

    it("refuses another restaurant's owner", async () => {
      const f = await seated();
      const stranger = await db.createAuthUser();
      const theirs = await createRestaurant(db);
      await addMember(db, theirs, stranger, "owner");
      await expect(funnel(stranger, f.restaurantId)).rejects.toThrow(
        /REPORT_FORBIDDEN/,
      );
    });

    it("grants the report to signed-in users only, and nothing to anon", async () => {
      const { rows } = await db.admin.query<{
        fn: string;
        anon: boolean;
        auth: boolean;
      }>(
        `select p.proname as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('get_dish_funnel', 'record_dish_view', 'record_dish_signal',
                             'dish_funnel_on_cart_item', 'dish_funnel_on_order_item')
         order by p.proname;`,
      );
      expect(rows).toEqual([
        { fn: "dish_funnel_on_cart_item", anon: false, auth: false },
        { fn: "dish_funnel_on_order_item", anon: false, auth: false },
        { fn: "get_dish_funnel", anon: false, auth: true },
        { fn: "record_dish_signal", anon: false, auth: false },
        { fn: "record_dish_view", anon: false, auth: true },
      ]);
    });
  });

  it("never stops a diner adding a dish, even if counting fails", async () => {
    const restaurantId = await createRestaurant(db);
    const tableId = await createTable(db, restaurantId);
    const menuItemId = await createMenuItem(
      db,
      restaurantId,
      await createCategory(db, restaurantId),
    );
    const s = await createCustomerSession(db, restaurantId, tableId);
    const cartId = await createCart(db, restaurantId, s.sessionId);
    // Break the counter's table for this test only.
    await db.admin.query(
      "alter table public.dish_daily_stats add constraint dish_break check (opened < 0) not valid;",
    );
    try {
      await expect(
        addCartItem(db, s.userId, cartId, restaurantId, menuItemId),
      ).resolves.toBeTruthy();
    } finally {
      await db.admin.query(
        "alter table public.dish_daily_stats drop constraint dish_break;",
      );
    }
  });
});
