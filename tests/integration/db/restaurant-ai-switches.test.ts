// @vitest-environment node
//
// Admin Phase 6 (20261030090000_restaurant_ai_switches.sql): the switches
// and their history are server-only, keep their shape, and go when the
// restaurant does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant } from "./helpers";

describe("restaurant AI switches", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("can't be read or written by anyone signed in, even the restaurant's owner", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    await db.admin.query(
      "insert into public.restaurant_ai_switches (restaurant_id, feature, reason) values ($1, 'waiter', 'cost');",
      [restaurantId],
    );

    // Invisible: refused outright in production (no grants), and with
    // RLS on and no policy, never a row even where a grant lingers.
    for (const table of [
      "restaurant_ai_switches",
      "restaurant_ai_switch_history",
    ]) {
      const asOwner = await db
        .asUser(owner, (c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(asOwner.rows, table).toEqual([]);
      const asAnon = await db
        .asAnon((c) => c.query(`select * from public.${table};`))
        .catch(() => ({ rows: [] }));
      expect(asAnon.rows, table).toEqual([]);
    }
    // Unwritable: an owner can't switch their own AI back on, or off.
    await db
      .asUser(owner, (c) =>
        c.query(
          "delete from public.restaurant_ai_switches where restaurant_id = $1;",
          [restaurantId],
        ),
      )
      .catch(() => null);
    await expect(
      db.asUser(owner, (c) =>
        c.query(
          "insert into public.restaurant_ai_switches (restaurant_id, feature) values ($1, 'owner_tools');",
          [restaurantId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/);
    const { rows } = await db.admin.query<{ feature: string }>(
      "select feature from public.restaurant_ai_switches where restaurant_id = $1;",
      [restaurantId],
    );
    expect(rows).toEqual([{ feature: "waiter" }]);
  });

  it("keeps its shape: known features, one row each, short reasons", async () => {
    const restaurantId = await createRestaurant(db);
    const insert = (feature: string, reason: string | null = null) =>
      db.admin.query(
        "insert into public.restaurant_ai_switches (restaurant_id, feature, reason) values ($1, $2, $3);",
        [restaurantId, feature, reason],
      );
    await insert("owner_tools");
    await expect(insert("owner_tools")).rejects.toThrow(/duplicate key/i);
    await expect(insert("everything")).rejects.toThrow(/check constraint/i);
    await expect(insert("waiter", "x".repeat(201))).rejects.toThrow(
      /check constraint/i,
    );
    await expect(
      db.admin.query(
        "insert into public.restaurant_ai_switch_history (restaurant_id, feature, action) values ($1, 'waiter', 'maybe');",
        [restaurantId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("goes when the restaurant is deleted", async () => {
    const restaurantId = await createRestaurant(db);
    await db.admin.query(
      "insert into public.restaurant_ai_switches (restaurant_id, feature) values ($1, 'waiter');",
      [restaurantId],
    );
    await db.admin.query(
      "insert into public.restaurant_ai_switch_history (restaurant_id, feature, action) values ($1, 'waiter', 'off');",
      [restaurantId],
    );
    await db.admin.query("delete from public.restaurants where id = $1;", [
      restaurantId,
    ]);
    const { rows } = await db.admin.query<{ n: number }>(
      `select (select count(*) from public.restaurant_ai_switches where restaurant_id = $1)
            + (select count(*) from public.restaurant_ai_switch_history where restaurant_id = $1) as n;`,
      [restaurantId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
