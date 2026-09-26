// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, createTable, type Role } from "./helpers";

/**
 * Phase F, email half: the database pieces behind the daily summary and
 * the payment alerts.
 *
 * Two things matter most and get the most tests: whose email addresses a
 * caller can get (nobody's, unless they are the service role), and whether
 * "yesterday" means the restaurant's yesterday or the server's.
 */

describe("owner email", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function restaurant(timezone = "America/New_York") {
    const id = await createRestaurant(db);
    await db.admin.query(
      "update public.restaurants set timezone = $1 where id = $2;",
      [timezone, id],
    );
    return id;
  }

  async function member(restaurantId: string, role: Role, email?: string) {
    const userId = await db.createAuthUser(email);
    await addMember(db, restaurantId, userId, role);
    return userId;
  }

  /** An order placed at a precise instant, with items, bypassing submit_order. */
  async function orderAt(
    restaurantId: string,
    at: string,
    items: Array<{ name: string; quantity: number }>,
    opts: { status?: string; total?: number } = {},
  ) {
    const tableId = await createTable(db, restaurantId);
    const { rows: s } = await db.admin.query<{ id: string }>(
      `insert into public.customer_sessions (restaurant_id, table_id, user_id, status, expires_at)
       values ($1, $2, $3, 'active', now() + interval '4 hours') returning id;`,
      [restaurantId, tableId, await db.createAuthUser()],
    );
    const { rows: n } = await db.admin.query<{ n: number }>(
      "select coalesce(max(order_number), 0) + 1 as n from public.orders where restaurant_id = $1;",
      [restaurantId],
    );
    const { rows: o } = await db.admin.query<{ id: string }>(
      `insert into public.orders
         (restaurant_id, table_id, customer_session_id, order_number, status, subtotal, total, currency, idempotency_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $6, 'USD', $7, $8) returning id;`,
      [
        restaurantId,
        tableId,
        s[0].id,
        n[0].n,
        opts.status ?? "served",
        opts.total ?? 10,
        crypto.randomUUID(),
        at,
      ],
    );
    for (const item of items) {
      await db.admin.query(
        `insert into public.order_items (restaurant_id, order_id, item_name, quantity, unit_price, line_total)
         values ($1, $2, $3, $4, 5, $4 * 5);`,
        [restaurantId, o[0].id, item.name, item.quantity],
      );
    }
    return o[0].id;
  }

  async function summary(restaurantId: string, day: string) {
    const { rows } = await db.asServiceRole((c) =>
      c.query<{
        restaurant_name: string;
        order_count: number;
        order_value: string;
        cancelled_count: number;
        table_request_count: number;
        top_items: Array<{ name: string; quantity: number }>;
      }>("select * from public.get_daily_summary($1, $2);", [
        restaurantId,
        day,
      ]),
    );
    return rows[0];
  }

  describe("preferences", () => {
    it("defaults both emails on for every member", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      const { rows } = await db.admin.query<{ email_daily_summary: boolean }>(
        "select email_daily_summary, email_payment_alerts from public.restaurant_users where user_id = $1;",
        [owner],
      );
      expect(rows[0]).toEqual({
        email_daily_summary: true,
        email_payment_alerts: true,
      });
    });

    it("lets a member change their own preferences", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      await db.asUser(owner, (c) =>
        c.query("select public.set_my_email_preferences($1, false, true);", [
          r,
        ]),
      );
      const { rows } = await db.admin.query(
        "select email_daily_summary, email_payment_alerts from public.restaurant_users where user_id = $1;",
        [owner],
      );
      expect(rows[0]).toEqual({
        email_daily_summary: false,
        email_payment_alerts: true,
      });
    });

    it("never changes another owner's inbox", async () => {
      // restaurant_users_update_owner lets an owner edit any member row;
      // this function deliberately does not.
      const r = await restaurant();
      const a = await member(r, "owner");
      const b = await member(r, "owner");
      await db.asUser(a, (c) =>
        c.query("select public.set_my_email_preferences($1, false, false);", [
          r,
        ]),
      );
      const { rows } = await db.admin.query<{ email_daily_summary: boolean }>(
        "select email_daily_summary from public.restaurant_users where user_id = $1;",
        [b],
      );
      expect(rows[0].email_daily_summary).toBe(true);
    });

    it("refuses someone who is not a member", async () => {
      const r = await restaurant();
      const stranger = await db.createAuthUser();
      await expect(
        db.asUser(stranger, (c) =>
          c.query("select public.set_my_email_preferences($1, false, false);", [
            r,
          ]),
        ),
      ).rejects.toThrow(/EMAIL_PREFS_NOT_A_MEMBER/);
    });
  });

  describe("recipients", () => {
    it("returns opted-in owners and their addresses", async () => {
      const r = await restaurant();
      const owner = await member(
        r,
        "owner",
        `owner-${crypto.randomUUID()}@example.com`,
      );
      const { rows } = await db.asServiceRole((c) =>
        c.query<{ user_id: string; email: string }>(
          "select * from public.get_owner_email_recipients($1, 'daily_summary');",
          [r],
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(owner);
      expect(rows[0].email).toMatch(/@example\.com$/);
    });

    it("leaves out managers, kitchen and staff", async () => {
      const r = await restaurant();
      await member(r, "manager");
      await member(r, "kitchen");
      await member(r, "staff");
      const { rows } = await db.asServiceRole((c) =>
        c.query(
          "select * from public.get_owner_email_recipients($1, 'payment_alert');",
          [r],
        ),
      );
      expect(rows).toEqual([]);
    });

    it("respects each kind's opt-out separately", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      await db.asUser(owner, (c) =>
        c.query("select public.set_my_email_preferences($1, false, true);", [
          r,
        ]),
      );
      const get = (kind: string) =>
        db.asServiceRole((c) =>
          c.query("select * from public.get_owner_email_recipients($1, $2);", [
            r,
            kind,
          ]),
        );
      expect((await get("daily_summary")).rows).toEqual([]);
      expect((await get("payment_alert")).rows).toHaveLength(1);
    });

    it("gives owners' addresses to nobody but the service role", async () => {
      // A list of owners' email addresses is not something any client
      // should be able to ask for — including an owner of the same place.
      const r = await restaurant();
      const owner = await member(r, "owner");
      await expect(
        db.asUser(owner, (c) =>
          c.query(
            "select * from public.get_owner_email_recipients($1, 'daily_summary');",
            [r],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.asAnon((c) =>
          c.query(
            "select * from public.get_owner_email_recipients($1, 'daily_summary');",
            [r],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("the daily summary", () => {
    it("counts orders, their value and the top dishes", async () => {
      const r = await restaurant("UTC");
      await orderAt(
        r,
        "2026-09-28T09:00:00Z",
        [{ name: "Dosa", quantity: 2 }],
        { total: 12 },
      );
      await orderAt(
        r,
        "2026-09-28T13:00:00Z",
        [
          { name: "Chai", quantity: 3 },
          { name: "Dosa", quantity: 1 },
        ],
        { total: 18.5 },
      );

      const s = await summary(r, "2026-09-28");
      expect(s.order_count).toBe(2);
      expect(Number(s.order_value)).toBe(30.5);
      expect(s.top_items).toEqual([
        { name: "Chai", quantity: 3 },
        { name: "Dosa", quantity: 3 },
      ]);
    });

    it("leaves cancelled orders out of the value but reports them", async () => {
      const r = await restaurant("UTC");
      await orderAt(
        r,
        "2026-09-28T10:00:00Z",
        [{ name: "Dosa", quantity: 1 }],
        { total: 10 },
      );
      await orderAt(
        r,
        "2026-09-28T11:00:00Z",
        [{ name: "Dosa", quantity: 5 }],
        { total: 50, status: "cancelled" },
      );

      const s = await summary(r, "2026-09-28");
      expect(s.order_count).toBe(1);
      expect(Number(s.order_value)).toBe(10);
      expect(s.cancelled_count).toBe(1);
      expect(s.top_items).toEqual([{ name: "Dosa", quantity: 1 }]);
    });

    it("uses the restaurant's own day, not UTC's", async () => {
      // 23:30 in New York on the 28th is 03:30 UTC on the 29th. It belongs
      // to the New York restaurant's 28th.
      const r = await restaurant("America/New_York");
      await orderAt(r, "2026-09-29T03:30:00Z", [
        { name: "Late dosa", quantity: 1 },
      ]);

      expect((await summary(r, "2026-09-28")).order_count).toBe(1);
      expect((await summary(r, "2026-09-29")).order_count).toBe(0);
    });

    it("keeps Mumbai's dinner service in one day", async () => {
      // 22:00 in Mumbai on the 28th is 16:30 UTC on the 28th; 00:30 in
      // Mumbai on the 29th is 19:00 UTC on the 28th — a different local day.
      const r = await restaurant("Asia/Kolkata");
      await orderAt(r, "2026-09-28T16:30:00Z", [
        { name: "Thali", quantity: 1 },
      ]);
      await orderAt(r, "2026-09-28T19:00:00Z", [{ name: "Chai", quantity: 1 }]);

      expect((await summary(r, "2026-09-28")).order_count).toBe(1);
      expect((await summary(r, "2026-09-29")).order_count).toBe(1);
    });

    it("counts table requests from the same day", async () => {
      const r = await restaurant("UTC");
      const tableId = await createTable(db, r);
      await db.admin.query(
        "insert into public.table_requests (restaurant_id, table_id, kind, created_at) values ($1, $2, 'bill', '2026-09-28T12:00:00Z');",
        [r, tableId],
      );
      expect((await summary(r, "2026-09-28")).table_request_count).toBe(1);
    });

    it("reports zero, not nothing, for a quiet day", async () => {
      const r = await restaurant("UTC");
      const s = await summary(r, "2026-09-28");
      expect(s.order_count).toBe(0);
      expect(Number(s.order_value)).toBe(0);
      expect(s.top_items).toEqual([]);
    });

    it("never mixes in another restaurant's orders", async () => {
      const a = await restaurant("UTC");
      const b = await restaurant("UTC");
      await orderAt(b, "2026-09-28T12:00:00Z", [
        { name: "Not ours", quantity: 9 },
      ]);
      expect((await summary(a, "2026-09-28")).order_count).toBe(0);
    });

    it("is for the service role only", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      await expect(
        db.asUser(owner, (c) =>
          c.query("select * from public.get_daily_summary($1, '2026-09-28');", [
            r,
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("once only", () => {
    async function claim(
      restaurantId: string,
      kind: string,
      key: string,
      userId: string,
    ) {
      const { rows } = await db.asServiceRole((c) =>
        c.query(
          `insert into public.email_dispatches (restaurant_id, kind, dedupe_key, recipient_user_id)
           values ($1, $2, $3, $4)
           on conflict (kind, dedupe_key, recipient_user_id) do nothing
           returning id;`,
          [restaurantId, kind, key, userId],
        ),
      );
      return rows.length === 1;
    }

    it("lets a daily summary be claimed once per owner per day", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      expect(await claim(r, "daily_summary", "2026-09-28", owner)).toBe(true);
      expect(await claim(r, "daily_summary", "2026-09-28", owner)).toBe(false);
      expect(await claim(r, "daily_summary", "2026-09-29", owner)).toBe(true);
    });

    it("treats each owner separately", async () => {
      const r = await restaurant();
      const a = await member(r, "owner");
      const b = await member(r, "owner");
      expect(await claim(r, "daily_summary", "2026-09-28", a)).toBe(true);
      expect(await claim(r, "daily_summary", "2026-09-28", b)).toBe(true);
    });

    it("is invisible to owners", async () => {
      const r = await restaurant();
      const owner = await member(r, "owner");
      await claim(r, "daily_summary", "2026-09-27", owner);
      const { rows } = await db.asUser(owner, (c) =>
        c.query("select * from public.email_dispatches;"),
      );
      expect(rows).toEqual([]);
    });
  });
});
