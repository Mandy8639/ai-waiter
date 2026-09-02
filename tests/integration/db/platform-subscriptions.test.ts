// @vitest-environment node
//
// Platform billing part 2
// (supabase/migrations/20260902220000_platform_subscriptions.sql).
//
// Stripe delivers subscription events out of order and more than once, so
// most of what matters here is that repeated and stale deliveries are
// harmless.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { fullRestaurantFixture } from "./helpers";

async function planId(db: TestDb, slug: string) {
  const { rows } = await db.admin.query<{ id: string }>(
    "select id from public.platform_plans where slug = $1;",
    [slug],
  );
  return rows[0].id;
}

function record(
  db: TestDb,
  restaurantId: string,
  plan: string,
  overrides: {
    subscriptionId?: string;
    status?: string;
    periodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
  } = {},
) {
  return db.asServiceRole((c) =>
    c.query(
      "select public.record_restaurant_subscription($1, $2, $3, $4, $5, $6::timestamptz, $7);",
      [
        restaurantId,
        plan,
        `cus_${restaurantId.slice(0, 8)}`,
        // Unique per restaurant unless a test overrides it:
        // stripe_subscription_id is UNIQUE, because one Stripe
        // subscription cannot belong to two restaurants.
        overrides.subscriptionId ?? `sub_${restaurantId.slice(0, 8)}`,
        overrides.status ?? "active",
        // `?? default` would swallow an explicit null, which is exactly
        // the case an incomplete subscription needs to express.
        "periodEnd" in overrides ? overrides.periodEnd : "2027-01-01T00:00:00Z",
        overrides.cancelAtPeriodEnd ?? false,
      ],
    ),
  );
}

describe("recording a subscription", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("records what Stripe says", async () => {
    const f = await fullRestaurantFixture(db);
    await record(db, f.restaurantId, await planId(db, "standard"));

    const { rows } = await db.admin.query<{
      status: string;
      stripe_subscription_id: string;
    }>(
      "select status, stripe_subscription_id from public.restaurant_subscriptions where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(rows[0].status).toBe("active");
    expect(rows[0].stripe_subscription_id).toBe(
      `sub_${f.restaurantId.slice(0, 8)}`,
    );
  });

  it("is idempotent, because Stripe delivers the same event twice", async () => {
    const f = await fullRestaurantFixture(db);
    const standard = await planId(db, "standard");
    await record(db, f.restaurantId, standard);
    await record(db, f.restaurantId, standard);

    const { rows } = await db.admin.query<{ count: string }>(
      "select count(*) from public.restaurant_subscriptions where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("takes the latest state on a status change", async () => {
    const f = await fullRestaurantFixture(db);
    const standard = await planId(db, "standard");
    await record(db, f.restaurantId, standard, { status: "active" });
    await record(db, f.restaurantId, standard, { status: "past_due" });

    const { rows } = await db.admin.query<{ status: string }>(
      "select status from public.restaurant_subscriptions where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(rows[0].status).toBe("past_due");
  });

  it("assigns the plan too, so the per-payment fee follows what is paid for", async () => {
    // Part 1's fee reads restaurant_plans. If subscribing did not update
    // it, a restaurant paying for Pro would still be charged Starter's 1%.
    const f = await fullRestaurantFixture(db);
    await record(db, f.restaurantId, await planId(db, "pro"));

    const { rows } = await db.admin.query<{ platform_fee_minor_units: number }>(
      "select public.platform_fee_minor_units($1, 1999);",
      [f.restaurantId],
    );
    // Pro is 25 bps: 1999 * 0.0025 = 4.99 -> 4, not Starter's 19.
    expect(Number(rows[0].platform_fee_minor_units)).toBe(4);
  });

  it("moves the plan assignment when the subscription changes plan", async () => {
    const f = await fullRestaurantFixture(db);
    await record(db, f.restaurantId, await planId(db, "standard"));
    await record(db, f.restaurantId, await planId(db, "pro"));

    const { rows } = await db.admin.query<{ slug: string }>(
      `select p.slug from public.restaurant_plans rp
       join public.platform_plans p on p.id = rp.plan_id
       where rp.restaurant_id = $1;`,
      [f.restaurantId],
    );
    expect(rows[0].slug).toBe("pro");
  });

  it("refuses a status Stripe would never send", async () => {
    const f = await fullRestaurantFixture(db);
    await expect(
      record(db, f.restaurantId, await planId(db, "standard"), {
        status: "definitely-not-a-stripe-status",
      }),
    ).rejects.toThrow();
  });

  it("accepts a null period end, which an incomplete subscription has", async () => {
    const f = await fullRestaurantFixture(db);
    await record(db, f.restaurantId, await planId(db, "standard"), {
      status: "incomplete",
      periodEnd: null,
    });

    const { rows } = await db.admin.query<{
      current_period_end: string | null;
    }>(
      "select current_period_end from public.restaurant_subscriptions where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(rows[0].current_period_end).toBeNull();
  });
});

describe("who can see a subscription", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("shows it to the restaurant's members", async () => {
    const f = await fullRestaurantFixture(db);
    await record(db, f.restaurantId, await planId(db, "standard"));

    const rows = await db.asUser(
      f.userId,
      async (c) =>
        (
          await c.query(
            "select restaurant_id from public.restaurant_subscriptions where restaurant_id = $1;",
            [f.restaurantId],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it("hides it from everyone else", async () => {
    const f = await fullRestaurantFixture(db);
    const outsider = await db.createAuthUser();
    await record(db, f.restaurantId, await planId(db, "standard"));

    const rows = await db.asUser(
      outsider,
      async (c) =>
        (
          await c.query(
            "select restaurant_id from public.restaurant_subscriptions where restaurant_id = $1;",
            [f.restaurantId],
          )
        ).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("gives no client any way to write one", async () => {
    // Subscription state is Stripe's to assert, so there is no write
    // policy at all and an owner cannot mark their own restaurant paid.
    //
    // INSERT under RLS raises rather than quietly affecting zero rows —
    // unlike SELECT and UPDATE, which filter. Asserting the throw is
    // asserting the real behaviour.
    const f = await fullRestaurantFixture(db);
    const pro = await planId(db, "pro");

    await expect(
      db.asUser(f.userId, (c) =>
        c.query(
          `insert into public.restaurant_subscriptions
             (restaurant_id, plan_id, stripe_customer_id, stripe_subscription_id, status)
           values ($1, $2, 'cus_x', 'sub_x', 'active');`,
          [f.restaurantId, pro],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("a free plan has no price", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("refuses a price id on a free plan", async () => {
    // A price on a free plan would make Subscribe offer a charge nobody
    // agreed to.
    await expect(
      db.admin.query(
        "update public.platform_plans set stripe_price_id = 'price_x' where slug = 'starter';",
      ),
    ).rejects.toThrow();
  });

  it("allows a paid plan to have none yet, since the script fills it in", async () => {
    const { rows } = await db.admin.query<{ stripe_price_id: string | null }>(
      "select stripe_price_id from public.platform_plans where slug = 'standard';",
    );
    expect(rows[0].stripe_price_id).toBeNull();
  });
});
