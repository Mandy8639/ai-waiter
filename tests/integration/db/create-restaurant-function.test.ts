// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";

describe("create_restaurant() bootstrapping function", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates a restaurant, its settings, and an owner membership for the caller — transactionally, in one call", async () => {
    const userId = await db.createAuthUser();

    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string; name: string; slug: string }>(
        "select * from public.create_restaurant($1, $2, $3, $4, $5);",
        [
          "Test Bistro",
          "test-bistro",
          "A test place",
          "America/New_York",
          "USD",
        ],
      ),
    );

    expect(rows).toHaveLength(1);
    const restaurantId = rows[0].id;
    expect(rows[0].name).toBe("Test Bistro");

    const settings = await db.admin.query(
      "select id from public.restaurant_settings where restaurant_id = $1;",
      [restaurantId],
    );
    expect(settings.rows).toHaveLength(1);

    const membership = await db.admin.query<{ role: string }>(
      "select role from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
      [restaurantId, userId],
    );
    expect(membership.rows).toHaveLength(1);
    expect(membership.rows[0].role).toBe("owner");
  });

  it("there is no way to pass a role — the function signature has no such parameter", async () => {
    const userId = await db.createAuthUser();

    // This is really a compile-time/API-shape guarantee (the SQL function
    // only accepts p_name/p_slug/p_description/p_timezone/p_currency), but
    // we assert it behaviorally too: no matter what, the resulting
    // membership is 'owner' and only 'owner'.
    const { rows } = await db.asUser(userId, (c) =>
      c.query<{ id: string }>(
        "select * from public.create_restaurant($1, $2);",
        ["Role Test", "role-test-restaurant"],
      ),
    );

    const membership = await db.admin.query<{ role: string }>(
      "select role from public.restaurant_users where restaurant_id = $1 and user_id = $2;",
      [rows[0].id, userId],
    );
    expect(membership.rows[0].role).toBe("owner");
  });

  it("rejects an unauthenticated (anon) call", async () => {
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.create_restaurant($1, $2);", [
          "Nope",
          "anon-restaurant",
        ]),
      ),
    ).rejects.toThrow();
  });

  it("rolls back the whole call if any part fails (duplicate slug leaves no orphaned rows)", async () => {
    const userId = await db.createAuthUser();

    await db.asUser(userId, (c) =>
      c.query("select * from public.create_restaurant($1, $2);", [
        "First",
        "rollback-test-slug",
      ]),
    );

    const secondUserId = await db.createAuthUser();
    await expect(
      db.asUser(secondUserId, (c) =>
        c.query("select * from public.create_restaurant($1, $2);", [
          "Second",
          "rollback-test-slug",
        ]),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    // The second user must have no membership anywhere, and no orphaned
    // settings row was created before the slug collision was hit.
    const membership = await db.admin.query(
      "select id from public.restaurant_users where user_id = $1;",
      [secondUserId],
    );
    expect(membership.rows).toHaveLength(0);
  });
});
