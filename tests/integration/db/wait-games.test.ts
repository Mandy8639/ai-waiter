// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

/** The while-you-wait games switch (20261202090000). */
describe("wait games switch", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const enabled = (userId: string, restaurantId: string) =>
    db.asUser(userId, async (c) => {
      const { rows } = await c.query<{ on: boolean }>(
        "select public.wait_games_enabled($1) as on;",
        [restaurantId],
      );
      return rows[0].on;
    });

  it("is on by default, and a guest can read it", async () => {
    const f = await fullOrderFixture(db);
    expect(await enabled(f.customerUserId, f.restaurantId)).toBe(true);
  });

  it("can be switched off by an owner but not by staff", async () => {
    const f = await fullOrderFixture(db, "owner");
    const staff = await db.createAuthUser();
    await addMember(db, f.restaurantId, staff, "staff");

    await db.asUser(staff, (c) =>
      c.query(
        "update public.restaurant_settings set show_wait_games = false where restaurant_id = $1;",
        [f.restaurantId],
      ),
    );
    expect(await enabled(f.customerUserId, f.restaurantId)).toBe(true);

    await db.asUser(f.staffUserId, (c) =>
      c.query(
        "update public.restaurant_settings set show_wait_games = false where restaurant_id = $1;",
        [f.restaurantId],
      ),
    );
    expect(await enabled(f.customerUserId, f.restaurantId)).toBe(false);
  });

  it("isn't callable by anon", async () => {
    const f = await fullOrderFixture(db);
    await expect(
      db.asAnon((c) =>
        c.query("select public.wait_games_enabled($1);", [f.restaurantId]),
      ),
    ).rejects.toThrow();
  });
});
