// @vitest-environment node
//
// Live updates by Broadcast (supabase/migrations/20261127090000_realtime_broadcast.sql).
//
// PGlite has no Realtime, so delivery itself is checked against the
// disposable project (.sim/broadcast-check.mjs). What CAN be checked here
// is the part that decides privacy: who may join which topic, which must
// match who may read the rows it's about. And that every table a live
// screen depends on sends its pings.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, fullOrderFixture } from "./helpers";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

async function canJoin(userId: string, topic: string): Promise<boolean> {
  return db.asUser(userId, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      "select public.can_receive_broadcast($1) as ok;",
      [topic],
    );
    return rows[0].ok;
  });
}

describe("who may join a topic", () => {
  it("a restaurant's members hear its orders and table requests; nobody else does", async () => {
    const f = await fullOrderFixture(db, "kitchen");
    const stranger = await db.createAuthUser();
    for (const topic of [
      `orders:restaurant:${f.restaurantId}`,
      `requests:restaurant:${f.restaurantId}`,
    ]) {
      expect(await canJoin(f.staffUserId, topic)).toBe(true);
      expect(await canJoin(stranger, topic)).toBe(false);
      // A diner is not a member: they follow their own order only.
      expect(await canJoin(f.customerUserId, topic)).toBe(false);
    }
  });

  it("bookings are front of house only, like reading them", async () => {
    const restaurantId = await createRestaurant(db);
    const roles = ["owner", "manager", "staff", "kitchen"] as const;
    const users: Record<string, string> = {};
    for (const role of roles) {
      users[role] = await db.createAuthUser();
      await addMember(db, restaurantId, users[role], role);
    }
    const topic = `reservations:restaurant:${restaurantId}`;
    expect(await canJoin(users.owner, topic)).toBe(true);
    expect(await canJoin(users.manager, topic)).toBe(true);
    expect(await canJoin(users.staff, topic)).toBe(true);
    expect(await canJoin(users.kitchen, topic)).toBe(false);
  });

  it("a diner follows their own order, and only theirs", async () => {
    const mine = await fullOrderFixture(db);
    const theirs = await fullOrderFixture(db);
    expect(
      await canJoin(mine.customerUserId, `orders:order:${mine.orderId}`),
    ).toBe(true);
    expect(
      await canJoin(mine.customerUserId, `orders:order:${theirs.orderId}`),
    ).toBe(false);
    // The restaurant's staff may follow it too, as they may read it.
    expect(
      await canJoin(mine.staffUserId, `orders:order:${mine.orderId}`),
    ).toBe(true);
    expect(
      await canJoin(theirs.staffUserId, `orders:order:${mine.orderId}`),
    ).toBe(false);
  });

  it.each([
    "orders:restaurant:not-a-uuid",
    "orders:restaurant",
    "orders:restaurant:00000000-0000-0000-0000-000000000000:extra",
    "anything:else:00000000-0000-0000-0000-000000000000",
    "",
  ])("refuses the malformed or unknown topic %j", async (topic) => {
    const f = await fullOrderFixture(db);
    expect(await canJoin(f.staffUserId, topic)).toBe(false);
  });
});

describe("what sends pings", () => {
  it("every table a live screen depends on has its trigger", async () => {
    const { rows } = await db.admin.query<{ table: string; trigger: string }>(
      `select c.relname as table, t.tgname as trigger
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgname like '%broadcast%'
       order by 1;`,
    );
    expect(rows.map((r) => r.table)).toEqual([
      "order_payments",
      "orders",
      "reservations",
      "table_requests",
    ]);
  });

  it("an order still goes through where there's no Realtime (sending never blocks a write)", async () => {
    // fullOrderFixture places an order and the kitchen moves it: both fire
    // the triggers, which do nothing in PGlite rather than fail.
    const f = await fullOrderFixture(db);
    await db.admin.query(
      "update public.orders set customer_note = 'extra napkins' where id = $1;",
      [f.orderId],
    );
    const { rows } = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from public.orders where id = $1;",
      [f.orderId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("can't be called to send a message by anyone signed in", async () => {
    const f = await fullOrderFixture(db);
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.broadcast_change('orders:restaurant:x', '{}');"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
