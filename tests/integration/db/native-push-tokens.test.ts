// @vitest-environment node
//
// iOS app kitchen alerts: native_push_tokens and its two functions
// (20261011090000_native_push_tokens.sql). Same rules as web push
// subscriptions: members only, your own rows only, the same phone taking
// its row over, and gone with the membership.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullRestaurantFixture } from "./helpers";

const token = (c: string) => c.repeat(64);

describe("native push tokens", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function save(userId: string, restaurantId: string, t: string) {
    return db.asUser(userId, (c) =>
      c.query("select public.save_native_push_token($1, $2);", [
        restaurantId,
        t,
      ]),
    );
  }

  async function rows(restaurantId: string) {
    const { rows } = await db.admin.query<{ user_id: string; token: string }>(
      "select user_id, token from public.native_push_tokens where restaurant_id = $1 order by token;",
      [restaurantId],
    );
    return rows;
  }

  it("lets any member turn alerts on for their phone, stored lower-case", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    const cook = await db.createAuthUser();
    await addMember(db, restaurantId, cook, "kitchen");
    await save(cook, restaurantId, token("A"));
    expect(await rows(restaurantId)).toEqual([
      { user_id: cook, token: token("a") },
    ]);
  });

  it("refuses someone who isn't a member, and a diner", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    const stranger = await db.createAuthUser();
    const diner = await db.createAnonymousAuthUser();
    for (const user of [stranger, diner]) {
      await expect(save(user, restaurantId, token("b"))).rejects.toThrow(
        /PUSH_NOT_A_MEMBER/,
      );
    }
    expect(await rows(restaurantId)).toEqual([]);
  });

  it("can't be called signed out", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    await expect(
      db.asAnon((c) =>
        c.query("select public.save_native_push_token($1, $2);", [
          restaurantId,
          token("c"),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("rejects anything that isn't an APNs token", async () => {
    const { userId, restaurantId } = await fullRestaurantFixture(db, "owner");
    for (const bad of ["", "abc", "z".repeat(64), "a".repeat(201)]) {
      await expect(save(userId, restaurantId, bad), bad).rejects.toThrow();
    }
  });

  it("lets the same phone, signed in as someone else, take its row over", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const waiter = await db.createAuthUser();
    await addMember(db, restaurantId, waiter, "staff");
    await save(owner, restaurantId, token("d"));
    await save(waiter, restaurantId, token("d"));
    expect(await rows(restaurantId)).toEqual([
      { user_id: waiter, token: token("d") },
    ]);
  });

  it("shows each member only their own phones", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const cook = await db.createAuthUser();
    await addMember(db, restaurantId, cook, "kitchen");
    await save(owner, restaurantId, token("e"));
    await save(cook, restaurantId, token("f"));
    const seen = await db.asUser(cook, (c) =>
      c.query<{ token: string }>(
        "select token from public.native_push_tokens;",
      ),
    );
    expect(seen.rows.map((r) => r.token)).toEqual([token("f")]);
    // No write policies: a direct insert is refused even for a member.
    await expect(
      db.asUser(cook, (c) =>
        c.query(
          "insert into public.native_push_tokens (restaurant_id, user_id, token) values ($1, $2, $3);",
          [restaurantId, cook, token("9")],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("turns alerts off only for the caller's own phone", async () => {
    const { userId: owner, restaurantId } = await fullRestaurantFixture(
      db,
      "owner",
    );
    const cook = await db.createAuthUser();
    await addMember(db, restaurantId, cook, "kitchen");
    await save(owner, restaurantId, token("1"));
    await db.asUser(cook, (c) =>
      c.query("select public.delete_native_push_token($1);", [token("1")]),
    );
    expect(await rows(restaurantId)).toHaveLength(1);
    await db.asUser(owner, (c) =>
      c.query("select public.delete_native_push_token($1);", [token("1")]),
    );
    expect(await rows(restaurantId)).toEqual([]);
  });

  it("goes when the member leaves the team, or deletes their account", async () => {
    const { restaurantId } = await fullRestaurantFixture(db, "owner");
    const cook = await db.createAuthUser();
    const waiter = await db.createAuthUser();
    await addMember(db, restaurantId, cook, "kitchen");
    await addMember(db, restaurantId, waiter, "staff");
    await save(cook, restaurantId, token("2"));
    await save(waiter, restaurantId, token("3"));

    await db.admin.query(
      "delete from public.restaurant_users where user_id = $1 and restaurant_id = $2;",
      [cook, restaurantId],
    );
    await db.asUser(waiter, (c) =>
      c.query("select public.delete_my_account();"),
    );

    expect(await rows(restaurantId)).toEqual([]);
  });
});
