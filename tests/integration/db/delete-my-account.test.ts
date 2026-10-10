// @vitest-environment node
//
// Self-service account deletion (20261010090000_delete_my_account.sql).
//
// Google Play requires it for an app with sign-up, and the privacy policy
// promises it. The rules: a signed-in member deletes their own account and
// nothing else; what the restaurant owns stays (authorship goes null); a
// restaurant's only owner is refused with a readable reason rather than the
// last-owner trigger's raw error; a diner's anonymous visit is not an
// account; and nobody can call it without signing in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addMember,
  createAllergen,
  createRestaurant,
  fullRestaurantFixture,
} from "./helpers";

async function userExists(db: TestDb, userId: string): Promise<boolean> {
  const { rows } = await db.admin.query<{ n: number }>(
    "select count(*)::int as n from auth.users where id = $1;",
    [userId],
  );
  return rows[0].n === 1;
}

async function deleteMyAccount(db: TestDb, userId: string) {
  return db.asUser(userId, (c) =>
    c.query("select public.delete_my_account();"),
  );
}

describe("delete_my_account()", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("deletes a staff member's account, their membership and their devices", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    const cook = await db.createAuthUser();
    await addMember(db, restaurantId, cook, "kitchen");
    await db.admin.query(
      "insert into public.push_subscriptions (restaurant_id, user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5);",
      [
        restaurantId,
        cook,
        `https://push.example/${cook}`,
        "B".repeat(87),
        "A".repeat(22),
      ],
    );

    await deleteMyAccount(db, cook);

    expect(await userExists(db, cook)).toBe(false);
    const memberships = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from public.restaurant_users where user_id = $1;",
      [cook],
    );
    expect(memberships.rows[0].n).toBe(0);
    const devices = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from public.push_subscriptions where user_id = $1;",
      [cook],
    );
    expect(devices.rows[0].n).toBe(0);
  });

  it("keeps the restaurant's records the person worked on, without their name on them", async () => {
    const { restaurantId, menuItemId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const manager = await db.createAuthUser();
    await addMember(db, restaurantId, manager, "manager");
    const allergenId = await createAllergen(db, restaurantId);
    await db.admin.query(
      `insert into public.menu_item_allergens
         (restaurant_id, menu_item_id, allergen_id, confirmed_at, confirmed_by)
       values ($1, $2, $3, now(), $4);`,
      [restaurantId, menuItemId, allergenId, manager],
    );

    await deleteMyAccount(db, manager);

    const { rows } = await db.admin.query<{
      confirmed_at: string | null;
      confirmed_by: string | null;
    }>(
      "select confirmed_at, confirmed_by from public.menu_item_allergens where menu_item_id = $1 and allergen_id = $2;",
      [menuItemId, allergenId],
    );
    // The confirmation is the restaurant's fact and survives; who made it
    // doesn't.
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed_at).not.toBeNull();
    expect(rows[0].confirmed_by).toBeNull();
  });

  it("lets a co-owner leave, and the restaurant keeps its other owner", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const coOwner = await db.createAuthUser();
    await addMember(db, restaurantId, coOwner, "owner");

    await deleteMyAccount(db, coOwner);

    expect(await userExists(db, coOwner)).toBe(false);
    const { rows } = await db.admin.query<{ user_id: string }>(
      "select user_id from public.restaurant_users where restaurant_id = $1 and role = 'owner';",
      [restaurantId],
    );
    expect(rows.map((r) => r.user_id)).toEqual([owner]);
  });

  it("refuses a restaurant's only owner with SOLE_OWNER and changes nothing", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const waiter = await db.createAuthUser();
    await addMember(db, restaurantId, waiter, "staff");

    await expect(deleteMyAccount(db, owner)).rejects.toThrow(/SOLE_OWNER/);

    expect(await userExists(db, owner)).toBe(true);
    const { rows } = await db.admin.query<{ n: number }>(
      "select count(*)::int as n from public.restaurant_users where restaurant_id = $1;",
      [restaurantId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("refuses an owner who is the only owner of just one of their restaurants", async () => {
    const owner = await db.createAuthUser();
    const shared = await createRestaurant(db);
    const solo = await createRestaurant(db);
    const partner = await db.createAuthUser();
    await addMember(db, shared, owner, "owner");
    await addMember(db, shared, partner, "owner");
    await addMember(db, solo, owner, "owner");

    await expect(deleteMyAccount(db, owner)).rejects.toThrow(/SOLE_OWNER/);
    expect(await userExists(db, owner)).toBe(true);
  });

  it("deletes an account that never created a restaurant", async () => {
    const newcomer = await db.createAuthUser();
    await deleteMyAccount(db, newcomer);
    expect(await userExists(db, newcomer)).toBe(false);
  });

  it("refuses a diner's anonymous visit", async () => {
    const diner = await db.createAnonymousAuthUser();
    await expect(deleteMyAccount(db, diner)).rejects.toThrow(
      /ANONYMOUS_SESSION/,
    );
    expect(await userExists(db, diner)).toBe(true);
  });

  it("only ever deletes the caller", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const coOwner = await db.createAuthUser();
    await addMember(db, restaurantId, coOwner, "owner");
    const bystander = await db.createAuthUser();

    await deleteMyAccount(db, coOwner);

    expect(await userExists(db, owner)).toBe(true);
    expect(await userExists(db, bystander)).toBe(true);
  });

  it("can't be called without signing in", async () => {
    await expect(
      db.asAnon((c) => c.query("select public.delete_my_account();")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("get_my_sole_owned_restaurants()", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("lists only the restaurants where the caller is the one owner, by name", async () => {
    const owner = await db.createAuthUser();
    const solo = await createRestaurant(db, { name: "Rasoi" });
    const shared = await createRestaurant(db, { name: "Dhaba" });
    const managed = await createRestaurant(db, { name: "Chaat Corner" });
    const partner = await db.createAuthUser();
    await addMember(db, solo, owner, "owner");
    await addMember(db, shared, owner, "owner");
    await addMember(db, shared, partner, "owner");
    await addMember(db, managed, partner, "owner");
    await addMember(db, managed, owner, "manager");

    const { rows } = await db.asUser(owner, (c) =>
      c.query<{ id: string; name: string }>(
        "select id, name from public.get_my_sole_owned_restaurants();",
      ),
    );
    expect(rows).toEqual([{ id: solo, name: "Rasoi" }]);
  });

  it("is empty for staff and for an account with no restaurant", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    const waiter = await db.createAuthUser();
    await addMember(db, restaurantId, waiter, "staff");
    const newcomer = await db.createAuthUser();

    for (const user of [waiter, newcomer]) {
      const { rows } = await db.asUser(user, (c) =>
        c.query("select * from public.get_my_sole_owned_restaurants();"),
      );
      expect(rows).toEqual([]);
    }
  });

  it("can't be called without signing in", async () => {
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.get_my_sole_owned_restaurants();"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
