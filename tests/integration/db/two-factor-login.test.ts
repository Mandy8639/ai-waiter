// @vitest-environment node
//
// Two-step verification, the database half (20261018090000_two_factor_login.sql).
//
// Optional for everyone. Once a person has a verified factor, a token that
// has only passed the password step (aal1) gets nothing staff-only: the app
// sends it to /login/verify, and this is the lock behind that door, for
// anyone calling the API directly with a stolen password.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullOrderFixture, fullRestaurantFixture } from "./helpers";

describe("two-step verification in the database", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const role = (userId: string, restaurantId: string, aal?: "aal1" | "aal2") =>
    db.asUser(
      userId,
      async (c) => {
        const { rows } = await c.query<{ role: string | null }>(
          "select public.current_restaurant_role($1) as role;",
          [restaurantId],
        );
        return rows[0].role;
      },
      aal,
    );

  const visibleRestaurants = (
    userId: string,
    restaurantId: string,
    aal?: "aal1" | "aal2",
  ) =>
    db.asUser(
      userId,
      async (c) => {
        const { rows } = await c.query(
          "select 1 from public.restaurant_settings where restaurant_id = $1;",
          [restaurantId],
        );
        return rows.length;
      },
      aal,
    );

  it("changes nothing for someone who hasn't turned it on", async () => {
    const f = await fullRestaurantFixture(db);
    expect(await role(f.userId, f.restaurantId)).toBe("owner");
    expect(await visibleRestaurants(f.userId, f.restaurantId)).toBe(1);
  });

  it("with it on, a password-only token is no longer a member", async () => {
    const f = await fullRestaurantFixture(db);
    await db.addVerifiedTwoFactor(f.userId);

    expect(await role(f.userId, f.restaurantId, "aal1")).toBeNull();
    // RLS built on the membership helpers hides the restaurant's rows.
    expect(await visibleRestaurants(f.userId, f.restaurantId, "aal1")).toBe(0);
  });

  it("with it on, a token that passed the code step is a member again", async () => {
    const f = await fullRestaurantFixture(db);
    await db.addVerifiedTwoFactor(f.userId);

    expect(await role(f.userId, f.restaurantId, "aal2")).toBe("owner");
    expect(await visibleRestaurants(f.userId, f.restaurantId, "aal2")).toBe(1);
  });

  it("refuses staff actions to a password-only token", async () => {
    const f = await fullOrderFixture(db);
    await db.addVerifiedTwoFactor(f.staffUserId);

    await expect(
      db.asUser(
        f.staffUserId,
        (c) =>
          c.query("select public.transition_order_status($1, 'confirmed');", [
            f.orderId,
          ]),
        "aal1",
      ),
    ).rejects.toThrow();

    await db.asUser(
      f.staffUserId,
      (c) =>
        c.query("select public.transition_order_status($1, 'confirmed');", [
          f.orderId,
        ]),
      "aal2",
    );
    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.orders where id = $1;",
      [f.orderId],
    );
    expect(rows[0].status).toBe("confirmed");
  });

  it("an unfinished setup (unverified factor) doesn't count", async () => {
    const f = await fullRestaurantFixture(db);
    await db.admin.query(
      "insert into auth.mfa_factors (user_id, status) values ($1, 'unverified');",
      [f.userId],
    );
    expect(await role(f.userId, f.restaurantId, "aal1")).toBe("owner");
  });

  it("a password-only token can't delete the account", async () => {
    const f = await fullRestaurantFixture(db, "manager");
    await db.addVerifiedTwoFactor(f.userId);

    await expect(
      db.asUser(
        f.userId,
        (c) => c.query("select public.delete_my_account();"),
        "aal1",
      ),
    ).rejects.toThrow(/TWO_FACTOR_REQUIRED/);

    await db.asUser(
      f.userId,
      (c) => c.query("select public.delete_my_account();"),
      "aal2",
    );
    const { rows } = await db.admin.query(
      "select 1 from auth.users where id = $1;",
      [f.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it("only the database itself can call the check", async () => {
    const f = await fullRestaurantFixture(db);
    await expect(
      db.asUser(f.userId, (c) =>
        c.query("select public.caller_passed_two_factor();"),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.asAnon((c) => c.query("select public.caller_passed_two_factor();")),
    ).rejects.toThrow(/permission denied/i);
  });
});
