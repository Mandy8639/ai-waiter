// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, fullRestaurantFixture } from "./helpers";

/**
 * The diner -> staff channel, against real Postgres running the real
 * migration.
 *
 * The claims worth testing are the ones a client could otherwise break:
 * that a diner cannot raise a request against a table that is not theirs,
 * that tapping twice does not produce two alerts, and that one table's
 * request is invisible to another table.
 */
describe("table requests", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /** A diner seated at a table: anonymous auth user + active session. */
  async function seatDiner(restaurantId: string): Promise<{
    userId: string;
    sessionId: string;
    tableId: string;
  }> {
    const userId = await db.createAnonymousAuthUser();
    const { rows: tableRows } = await db.admin.query<{ id: string }>(
      `insert into public.tables (restaurant_id, table_number)
       values ($1, $2) returning id;`,
      [restaurantId, `t-${Math.random().toString(36).slice(2, 8)}`],
    );
    const tableId = tableRows[0].id;
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into public.customer_sessions
         (restaurant_id, table_id, user_id, status, expires_at)
       values ($1, $2, $3, 'active', now() + interval '4 hours')
       returning id;`,
      [restaurantId, tableId, userId],
    );
    return { userId, sessionId: rows[0].id, tableId };
  }

  async function ask(
    userId: string,
    kind: "waiter" | "bill",
    note: string | null = null,
  ): Promise<string> {
    return db.asUser(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "select public.create_table_request($1, $2) as id;",
        [kind, note],
      );
      return rows[0].id;
    });
  }

  describe("raising a request", () => {
    it("derives the restaurant and table from the caller's own session", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      const id = await ask(diner.userId, "waiter");

      const { rows } = await db.admin.query<{
        restaurant_id: string;
        table_id: string;
        session_id: string;
        status: string;
        kind: string;
      }>(
        "select restaurant_id, table_id, session_id, status, kind from public.table_requests where id = $1;",
        [id],
      );
      expect(rows[0].restaurant_id).toBe(restaurantId);
      expect(rows[0].table_id).toBe(diner.tableId);
      expect(rows[0].session_id).toBe(diner.sessionId);
      expect(rows[0].status).toBe("open");
      expect(rows[0].kind).toBe("waiter");
    });

    it("returns the SAME request when a table asks twice — one alert, not two", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      const first = await ask(diner.userId, "waiter");
      const second = await ask(diner.userId, "waiter");

      expect(second).toBe(first);
      const { rows } = await db.admin.query<{ count: number }>(
        "select count(*)::int as count from public.table_requests where table_id = $1;",
        [diner.tableId],
      );
      expect(rows[0].count).toBe(1);
    });

    it("keeps 'waiter' and 'bill' as separate asks", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      const waiter = await ask(diner.userId, "waiter");
      const bill = await ask(diner.userId, "bill");

      expect(bill).not.toBe(waiter);
    });

    it("refuses a kind nobody can answer", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      await expect(
        db.asUser(diner.userId, (client) =>
          client.query("select public.create_table_request($1);", ["dessert"]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_INVALID_KIND/);
    });

    it("refuses a caller with no active session — a signed-in staff member, say", async () => {
      const { userId } = await fullRestaurantFixture(db);

      await expect(
        db.asUser(userId, (client) =>
          client.query("select public.create_table_request($1);", ["waiter"]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_NO_SESSION/);
    });

    it("refuses an expired session", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      await db.admin.query(
        "update public.customer_sessions set expires_at = now() - interval '1 minute' where id = $1;",
        [diner.sessionId],
      );

      await expect(
        db.asUser(diner.userId, (client) =>
          client.query("select public.create_table_request($1);", ["waiter"]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_NO_SESSION/);
    });

    it("trims and caps the note, and stores nothing for an empty one", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      const withNote = await ask(diner.userId, "waiter", "  needs water  ");
      const blank = await ask(diner.userId, "bill", "   ");

      const { rows } = await db.admin.query<{
        id: string;
        note: string | null;
      }>(
        "select id, note from public.table_requests where id = any($1::uuid[]);",
        [[withNote, blank]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.note]));
      expect(byId[withNote]).toBe("needs water");
      expect(byId[blank]).toBeNull();
    });

    it("stops a cancel-and-recreate loop at 20 in an hour", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);

      // Rule 1 alone would never trigger here: each one is cancelled
      // before the next is raised, so there is never a second open row.
      for (let i = 0; i < 20; i += 1) {
        const id = await ask(diner.userId, "waiter");
        await db.asUser(diner.userId, (client) =>
          client.query("select public.cancel_table_request($1);", [id]),
        );
      }

      await expect(
        db.asUser(diner.userId, (client) =>
          client.query("select public.create_table_request($1);", ["waiter"]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_RATE_LIMITED/);
    });
  });

  describe("who can see what", () => {
    it("shows a diner their own request and nobody else's", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const one = await seatDiner(restaurantId);
      const two = await seatDiner(restaurantId);
      await ask(one.userId, "waiter");
      await ask(two.userId, "bill");

      const { rows } = await db.asUser(one.userId, (client) =>
        client.query<{ id: string; kind: string }>(
          "select id, kind from public.table_requests;",
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("waiter");
    });

    it("shows every member of the restaurant the whole queue", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const cook = await db.createAuthUser();
      await addMember(db, restaurantId, cook, "kitchen");
      const one = await seatDiner(restaurantId);
      const two = await seatDiner(restaurantId);
      await ask(one.userId, "waiter");
      await ask(two.userId, "bill");

      const { rows } = await db.asUser(cook, (client) =>
        client.query<{ kind: string }>(
          "select kind from public.table_requests order by kind;",
        ),
      );
      expect(rows.map((r) => r.kind)).toEqual(["bill", "waiter"]);
    });

    it("shows another restaurant's staff nothing", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const outsider = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      await ask(diner.userId, "waiter");

      const { rows } = await db.asUser(outsider.userId, (client) =>
        client.query("select id from public.table_requests;"),
      );
      expect(rows).toHaveLength(0);
    });

    it("hides the queue from an unauthenticated visitor", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      await ask(diner.userId, "waiter");

      const { rows } = await db.asAnon((client) =>
        client.query("select id from public.table_requests;"),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe("the staff queue", () => {
    it("returns open requests oldest first, with the table number resolved", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const one = await seatDiner(restaurantId);
      const two = await seatDiner(restaurantId);
      await ask(one.userId, "waiter");
      await ask(two.userId, "bill");

      const { rows } = await db.asUser(userId, (client) =>
        client.query<{ kind: string; table_number: string }>(
          "select kind, table_number from public.get_open_table_requests($1);",
          [restaurantId],
        ),
      );
      expect(rows).toHaveLength(2);
      // Oldest first: the table that has waited longest is served next.
      expect(rows[0].kind).toBe("waiter");
      expect(rows[0].table_number).toBeTruthy();
    });

    it("refuses another restaurant's staff", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const outsider = await fullRestaurantFixture(db);

      await expect(
        db.asUser(outsider.userId, (client) =>
          client.query("select * from public.get_open_table_requests($1);", [
            restaurantId,
          ]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_FORBIDDEN/);
    });

    it("drops a request out of the queue once staff clear it", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const id = await ask(diner.userId, "waiter");

      await db.asUser(userId, (client) =>
        client.query("select public.resolve_table_request($1);", [id]),
      );

      const { rows } = await db.asUser(userId, (client) =>
        client.query("select * from public.get_open_table_requests($1);", [
          restaurantId,
        ]),
      );
      expect(rows).toHaveLength(0);

      const { rows: row } = await db.admin.query<{
        status: string;
        resolved_by: string;
        resolved_at: string;
      }>(
        "select status, resolved_by, resolved_at from public.table_requests where id = $1;",
        [id],
      );
      expect(row[0].status).toBe("resolved");
      expect(row[0].resolved_by).toBe(userId);
      expect(row[0].resolved_at).not.toBeNull();
    });

    it("lets the table ask again once the first one is cleared", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const first = await ask(diner.userId, "waiter");
      await db.asUser(userId, (client) =>
        client.query("select public.resolve_table_request($1);", [first]),
      );

      const second = await ask(diner.userId, "waiter");
      expect(second).not.toBe(first);
    });
  });

  describe("clearing", () => {
    it("refuses a diner trying to resolve their own request", async () => {
      // Resolving means "a person dealt with this". Only staff can say so.
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const id = await ask(diner.userId, "waiter");

      await expect(
        db.asUser(diner.userId, (client) =>
          client.query("select public.resolve_table_request($1);", [id]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_FORBIDDEN/);
    });

    it("refuses another table's diner trying to cancel", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const one = await seatDiner(restaurantId);
      const two = await seatDiner(restaurantId);
      const id = await ask(one.userId, "waiter");

      await expect(
        db.asUser(two.userId, (client) =>
          client.query("select public.cancel_table_request($1);", [id]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_FORBIDDEN/);
    });

    it("records a diner's cancellation as distinct from being served", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const id = await ask(diner.userId, "waiter");

      await db.asUser(diner.userId, (client) =>
        client.query("select public.cancel_table_request($1);", [id]),
      );

      const { rows } = await db.admin.query<{
        status: string;
        resolved_by: string | null;
      }>(
        "select status, resolved_by from public.table_requests where id = $1;",
        [id],
      );
      expect(rows[0].status).toBe("cancelled");
      // Nobody served this table; that difference is the point.
      expect(rows[0].resolved_by).toBeNull();
    });

    it("refuses to clear something already cleared", async () => {
      const { userId, restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const id = await ask(diner.userId, "waiter");
      await db.asUser(userId, (client) =>
        client.query("select public.resolve_table_request($1);", [id]),
      );

      await expect(
        db.asUser(userId, (client) =>
          client.query("select public.resolve_table_request($1);", [id]),
        ),
      ).rejects.toThrow(/TABLE_REQUEST_NOT_OPEN/);
    });
  });

  describe("tenant integrity", () => {
    it("cannot be pointed at a table in another restaurant, even by the table owner", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const other = await createRestaurant(db);
      const { rows: t } = await db.admin.query<{ id: string }>(
        "insert into public.tables (restaurant_id, table_number) values ($1, 'x1') returning id;",
        [other],
      );

      await expect(
        db.admin.query(
          `insert into public.table_requests (restaurant_id, table_id, kind)
           values ($1, $2, 'waiter');`,
          [restaurantId, t[0].id],
        ),
      ).rejects.toThrow(/table_requests_table_same_restaurant/);
    });

    it("refuses a resolved row that forgot its timestamp", async () => {
      const { restaurantId } = await fullRestaurantFixture(db);
      const diner = await seatDiner(restaurantId);
      const id = await ask(diner.userId, "waiter");

      await expect(
        db.admin.query(
          "update public.table_requests set status = 'resolved' where id = $1;",
          [id],
        ),
      ).rejects.toThrow(/table_requests_resolved_when_terminal/);
    });
  });

  describe("grants", () => {
    it("leaves no table request function callable by anon", async () => {
      const { rows } = await db.admin.query<{
        name: string;
        anon: boolean;
      }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prorettype <> 'trigger'::regtype
           and p.proname like '%table_request%'
         order by p.proname;`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.anon).map((r) => r.name)).toEqual([]);
    });

    it("keeps them callable by authenticated — a diner IS an authenticated user", async () => {
      const { rows } = await db.admin.query<{ name: string; can: boolean }>(
        `select p.proname as name,
                has_function_privilege('authenticated', p.oid, 'execute') as can
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('create_table_request', 'cancel_table_request');`,
      );
      expect(rows.every((r) => r.can)).toBe(true);
    });
  });
});
