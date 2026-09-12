// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";

/**
 * A diner who scans a table's QR code is a real authenticated user
 * (Supabase Anonymous Auth), and that identity does not expire on its own.
 *
 * create_restaurant() used to check only that auth.uid() was not null, and
 * `grant execute ... to authenticated` covers anonymous identities — so a
 * diner who reached /onboarding could create a real restaurant owned by a
 * guest session that disappears when they clear their browser. Nobody
 * could ever sign in to claim it.
 *
 * The middleware now keeps diners off /onboarding, but that is a door, not
 * a lock: this function is callable by anyone holding an anonymous token.
 */

const create = (db: TestDb, userId: string, slug: string) =>
  db.asUser(userId, (c) =>
    c.query("select * from public.create_restaurant($1, $2);", [
      "Test Restaurant",
      slug,
    ]),
  );

describe("create_restaurant() and guest sessions", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("refuses a diner's anonymous identity", async () => {
    const diner = await db.createAnonymousAuthUser();

    await expect(create(db, diner, "diner-attempt")).rejects.toThrow(
      /RESTAURANT_ANONYMOUS_CALLER/,
    );
  });

  it("creates nothing at all when it refuses", async () => {
    const diner = await db.createAnonymousAuthUser();

    await expect(create(db, diner, "diner-attempt-2")).rejects.toThrow();

    const { rows } = await db.admin.query(
      "select id from public.restaurants where slug = $1;",
      ["diner-attempt-2"],
    );
    expect(rows).toHaveLength(0);
  });

  it("still lets a real account create a restaurant and own it", async () => {
    const owner = await db.createAuthUser();

    const { rows } = await create(db, owner, "real-account");
    expect(rows).toHaveLength(1);

    const { rows: membership } = await db.admin.query<{ role: string }>(
      `select ru.role
         from public.restaurant_users ru
         join public.restaurants r on r.id = ru.restaurant_id
        where r.slug = $1 and ru.user_id = $2;`,
      ["real-account", owner],
    );
    expect(membership).toEqual([{ role: "owner" }]);
  });

  it("still refuses a caller with no identity at all", async () => {
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.create_restaurant($1, $2);", [
          "Test Restaurant",
          "no-identity",
        ]),
      ),
    ).rejects.toThrow(/requires an authenticated user|permission denied/i);
  });
});
