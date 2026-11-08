// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture } from "./helpers";

/**
 * The Google review link and its tap count (20261130090000), against the
 * real migration: only Google links are stored, a tap is recorded once per
 * order and only by someone who can see the order, it holds nothing about
 * the diner or their rating, and only owners and managers get the count.
 */
describe("google review link", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const setLink = (restaurantId: string, url: string | null) =>
    db.admin.query(
      "update public.restaurants set google_review_url = $2 where id = $1;",
      [restaurantId, url],
    );

  const tap = (userId: string, orderId: string) =>
    db.asUser(userId, (c) =>
      c.query("select public.record_google_review_tap($1);", [orderId]),
    );

  const count = async (userId: string, restaurantId: string) =>
    db.asUser(userId, async (c) => {
      const { rows } = await c.query<{ n: number | null }>(
        "select public.google_review_tap_count($1, 30) as n;",
        [restaurantId],
      );
      return rows[0].n;
    });

  it("stores only https links on Google's hosts", async () => {
    const f = await fullOrderFixture(db);
    await setLink(f.restaurantId, "https://g.page/r/abc/review");
    await setLink(f.restaurantId, null);
    await expect(
      setLink(f.restaurantId, "https://yelp.com/x"),
    ).rejects.toThrow();
    await expect(
      setLink(f.restaurantId, "http://g.page/r/abc"),
    ).rejects.toThrow();
    await expect(
      setLink(f.restaurantId, "https://g.page.evil.com/r/abc"),
    ).rejects.toThrow();
  });

  it("counts one tap per order, from the diner, with nothing about them", async () => {
    const f = await fullOrderFixture(db, "owner");
    await setLink(f.restaurantId, "https://g.page/r/abc/review");

    await tap(f.customerUserId, f.orderId);
    await tap(f.customerUserId, f.orderId);
    expect(await count(f.staffUserId, f.restaurantId)).toBe(1);

    const { rows } = await db.admin.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'google_review_taps'
       order by column_name;`,
    );
    expect(rows.map((r) => (r as { column_name: string }).column_name)).toEqual(
      ["created_at", "order_id", "restaurant_id"],
    );
  });

  it("ignores a tap from someone who can't see the order, or with no link set", async () => {
    const f = await fullOrderFixture(db, "owner");
    const stranger = await db.createAuthUser();

    await tap(f.customerUserId, f.orderId); // no link yet
    await setLink(f.restaurantId, "https://g.page/r/abc/review");
    await tap(stranger, f.orderId);

    expect(await count(f.staffUserId, f.restaurantId)).toBe(0);
  });

  it("gives the count to owners and managers only", async () => {
    const f = await fullOrderFixture(db, "owner");
    const staff = await db.createAuthUser();
    await addMember(db, f.restaurantId, staff, "staff");

    expect(await count(f.staffUserId, f.restaurantId)).toBe(0);
    expect(await count(staff, f.restaurantId)).toBeNull();
    await expect(
      db.asAnon((c) =>
        c.query("select public.google_review_tap_count($1, 30);", [
          f.restaurantId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("lets nobody read the tap rows directly", async () => {
    const f = await fullOrderFixture(db, "owner");
    await setLink(f.restaurantId, "https://g.page/r/abc/review");
    await tap(f.customerUserId, f.orderId);

    const seen = await db.asUser(f.staffUserId, async (c) => {
      const { rows } = await c.query(
        "select * from public.google_review_taps where restaurant_id = $1;",
        [f.restaurantId],
      );
      return rows;
    });
    expect(seen).toHaveLength(0);
  });
});
