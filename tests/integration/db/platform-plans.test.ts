// @vitest-environment node
//
// Platform billing part 1
// (supabase/migrations/20260902210000_platform_plans.sql).
//
// The fee is taken from a real restaurant's real payment, so the
// arithmetic and the rounding direction matter more than anything else
// here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { endFreeMonth, fullRestaurantFixture } from "./helpers";

async function fee(db: TestDb, restaurantId: string, totalMinor: number) {
  const { rows } = await db.admin.query<{ platform_fee_minor_units: number }>(
    "select public.platform_fee_minor_units($1, $2);",
    [restaurantId, totalMinor],
  );
  return Number(rows[0].platform_fee_minor_units);
}

async function planId(db: TestDb, slug: string) {
  const { rows } = await db.admin.query<{ id: string }>(
    "select id from public.platform_plans where slug = $1;",
    [slug],
  );
  return rows[0].id;
}

describe("the launch price list", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("has exactly one default plan", async () => {
    // Two defaults would make which plan a new restaurant lands on depend
    // on row order, which is not a pricing decision anyone made.
    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.platform_plans where is_default;",
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("refuses a second default", async () => {
    await expect(
      db.admin.query(
        "update public.platform_plans set is_default = true where slug = 'pro';",
      ),
    ).rejects.toThrow();
  });

  it("refuses a fee above the sanity ceiling", async () => {
    // 1000 bps is 10%. Anything higher is far likelier to be a typo than a
    // decision, and it would overcharge every diner at that restaurant.
    await expect(
      db.admin.query(
        "insert into public.platform_plans (slug, name, monthly_price_cents, fee_bps) values ('bad', 'Bad', 0, 5000);",
      ),
    ).rejects.toThrow();
  });

  it("refuses a negative fee or price", async () => {
    await expect(
      db.admin.query(
        "insert into public.platform_plans (slug, name, monthly_price_cents, fee_bps) values ('neg', 'Neg', 0, -1);",
      ),
    ).rejects.toThrow();
    await expect(
      db.admin.query(
        "insert into public.platform_plans (slug, name, monthly_price_cents, fee_bps) values ('neg2', 'Neg2', -1, 0);",
      ),
    ).rejects.toThrow();
  });
});

describe("platform_fee_minor_units", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("uses the default plan when a restaurant has chosen none", async () => {
    // Starter is 100 bps = 1%. $19.99 -> 1999 minor -> 19. (After the
    // free month; inside it the fee is 0, tested below.)
    const f = await fullRestaurantFixture(db);
    await endFreeMonth(db, f.restaurantId);
    expect(await fee(db, f.restaurantId, 1999)).toBe(19);
  });

  it("uses the restaurant's own plan once assigned", async () => {
    // Pro is 25 bps = 0.25%. 1999 * 0.0025 = 4.9975 -> 4.
    const f = await fullRestaurantFixture(db);
    await endFreeMonth(db, f.restaurantId);
    await db.admin.query(
      "insert into public.restaurant_plans (restaurant_id, plan_id) values ($1, $2);",
      [f.restaurantId, await planId(db, "pro")],
    );
    expect(await fee(db, f.restaurantId, 1999)).toBe(4);
  });

  it("rounds down, never in the platform's favour", async () => {
    // A fee is a share of someone else's money. 1 minor unit at 1% is
    // 0.01 — rounding that up would take a cent that was not earned.
    const f = await fullRestaurantFixture(db);
    await endFreeMonth(db, f.restaurantId);
    expect(await fee(db, f.restaurantId, 1)).toBe(0);
    expect(await fee(db, f.restaurantId, 99)).toBe(0);
    expect(await fee(db, f.restaurantId, 100)).toBe(1);
  });

  it("takes nothing during a restaurant's free first month", async () => {
    const f = await fullRestaurantFixture(db);
    expect(await fee(db, f.restaurantId, 100_000)).toBe(0);
  });

  it("takes nothing from a zero payment", async () => {
    const f = await fullRestaurantFixture(db);
    expect(await fee(db, f.restaurantId, 0)).toBe(0);
  });

  it("charges nothing when the price list has no default at all", async () => {
    // A misconfigured price list must under-charge, not guess. Guessing
    // here means taking money from a restaurant on a rate nobody set.
    const f = await fullRestaurantFixture(db);
    await db.admin.query(
      "update public.platform_plans set is_default = false;",
    );
    expect(await fee(db, f.restaurantId, 100_000)).toBe(0);
  });
});

describe("who can read the price list", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("lets any signed-in user read plans, since a prospect needs the prices", async () => {
    const stranger = await db.createAuthUser();
    const rows = await db.asUser(stranger, async (c) => {
      const r = await c.query("select slug from public.platform_plans;");
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows a restaurant's assignment only to its own members", async () => {
    const f = await fullRestaurantFixture(db);
    const outsider = await db.createAuthUser();
    await db.admin.query(
      "insert into public.restaurant_plans (restaurant_id, plan_id) values ($1, $2);",
      [f.restaurantId, await planId(db, "standard")],
    );

    const mine = await db.asUser(
      f.userId,
      async (c) =>
        (
          await c.query(
            "select restaurant_id from public.restaurant_plans where restaurant_id = $1;",
            [f.restaurantId],
          )
        ).rows,
    );
    const theirs = await db.asUser(
      outsider,
      async (c) =>
        (
          await c.query(
            "select restaurant_id from public.restaurant_plans where restaurant_id = $1;",
            [f.restaurantId],
          )
        ).rows,
    );

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
