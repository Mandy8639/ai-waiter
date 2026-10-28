// @vitest-environment node
//
// Pricing from 2026-10-18 (20261018120000_free_month_then_starter.sql): a
// free first month with no platform fee, then Starter at $19/month. New QR
// orders pause only after 7 more days without a subscription Stripe is
// collecting on; one failed card never pauses anything; restaurants from
// before the change are exempt; and nobody can extend their own trial.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import {
  addCartItem,
  addMember,
  createRestaurant,
  endFreeMonth,
  fullCustomerFixture,
  submitOrder,
} from "./helpers";

describe("free month, then Starter", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const fee = async (restaurantId: string, minor: number) =>
    Number(
      (
        await db.admin.query<{ f: number }>(
          "select public.platform_fee_minor_units($1, $2) as f;",
          [restaurantId, minor],
        )
      ).rows[0].f,
    );

  const acceptingOrders = async (restaurantId: string) =>
    (
      await db.asAnon((c) =>
        c.query<{ accepting_orders: boolean }>(
          "select accepting_orders from public.get_public_order_settings($1);",
          [restaurantId],
        ),
      )
    ).rows[0].accepting_orders;

  const billingState = async (userId: string, restaurantId: string) =>
    (
      await db.asUser(userId, (c) =>
        c.query<{ state: string }>(
          "select state from public.get_restaurant_billing($1);",
          [restaurantId],
        ),
      )
    ).rows[0].state;

  const subscribe = async (
    restaurantId: string,
    status: string,
    periodEndDaysFromNow: number | null = 30,
  ) => {
    const { rows } = await db.admin.query<{ id: string }>(
      "select id from public.platform_plans where slug = 'starter';",
    );
    await db.admin.query(
      `insert into public.restaurant_subscriptions
         (restaurant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       values ($1, $2, 'cus_test', $3, $4,
               case when $5::int is null then null else now() + make_interval(days => $5::int) end)
       on conflict (restaurant_id) do update
         set status = excluded.status, current_period_end = excluded.current_period_end;`,
      [
        restaurantId,
        rows[0].id,
        `sub_${restaurantId}`,
        status,
        periodEndDaysFromNow,
      ],
    );
  };

  /** A diner with one item in their cart, ready to order. */
  const dinerReadyToOrder = async () => {
    const f = await fullCustomerFixture(db);
    await addCartItem(db, f.userId, f.cartId, f.restaurantId, f.menuItemId);
    return f;
  };

  it("starts every new restaurant on a free month: no fee, orders open", async () => {
    const f = await dinerReadyToOrder();
    const { rows } = await db.admin.query<{ days: number; exempt: boolean }>(
      `select round(extract(epoch from trial_ends_at - now()) / 86400)::int as days,
              billing_exempt as exempt
       from public.restaurants where id = $1;`,
      [f.restaurantId],
    );
    expect(rows[0]).toEqual({ days: 30, exempt: false });
    expect(await fee(f.restaurantId, 10_000)).toBe(0);
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it("charges 1% after the free month, and keeps orders open for 7 days of grace", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 3);
    expect(await fee(f.restaurantId, 10_000)).toBe(100);
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it("pauses new QR orders once grace has run out with no subscription", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 8);
    expect(await acceptingOrders(f.restaurantId)).toBe(false);
    await expect(
      submitOrder(db, f.userId, crypto.randomUUID()),
    ).rejects.toThrow(/ORDER_RESTAURANT_UNAVAILABLE/);
  });

  it("subscribing turns ordering back on", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 20);
    await subscribe(f.restaurantId, "active");
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it("never pauses for a failed card Stripe is still retrying (past_due)", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 20);
    await subscribe(f.restaurantId, "past_due", -10);
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
  });

  it("keeps a cancelled subscription working for 7 days past its paid period", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 60);
    await subscribe(f.restaurantId, "canceled", -3);
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
    await subscribe(f.restaurantId, "canceled", -10);
    expect(await acceptingOrders(f.restaurantId)).toBe(false);
  });

  it("never pauses an exempt restaurant, and takes no fee from it", async () => {
    const f = await dinerReadyToOrder();
    await endFreeMonth(db, f.restaurantId, 100);
    await db.admin.query(
      "update public.restaurants set billing_exempt = true, trial_ends_at = null where id = $1;",
      [f.restaurantId],
    );
    expect(await acceptingOrders(f.restaurantId)).toBe(true);
    // Tableside is free (20261125090000): exempt means no fee at all.
    expect(await fee(f.restaurantId, 10_000)).toBe(0);
    await submitOrder(db, f.userId, crypto.randomUUID());
  });

  it("tells the restaurant's own staff where they stand, and nobody else", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");
    expect(await billingState(owner, restaurantId)).toBe("trial");

    await endFreeMonth(db, restaurantId, 2);
    expect(await billingState(owner, restaurantId)).toBe("grace");

    await endFreeMonth(db, restaurantId, 9);
    expect(await billingState(owner, restaurantId)).toBe("lapsed");

    await subscribe(restaurantId, "past_due");
    expect(await billingState(owner, restaurantId)).toBe("past_due");

    await subscribe(restaurantId, "active");
    expect(await billingState(owner, restaurantId)).toBe("subscribed");

    const stranger = await db.createAuthUser();
    await expect(billingState(stranger, restaurantId)).rejects.toThrow(
      /BILLING_FORBIDDEN/,
    );
    await expect(
      db.asAnon((c) =>
        c.query("select * from public.get_restaurant_billing($1);", [
          restaurantId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an owner can't extend their own free month or exempt themselves", async () => {
    const restaurantId = await createRestaurant(db);
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");

    for (const sql of [
      "update public.restaurants set trial_ends_at = now() + interval '10 years' where id = $1;",
      "update public.restaurants set billing_exempt = true where id = $1;",
    ]) {
      await expect(
        db.asUser(owner, (c) => c.query(sql, [restaurantId])),
      ).rejects.toThrow(/RESTAURANT_BILLING_COLUMNS_READ_ONLY/);
    }

    // Everything else about their restaurant is still theirs to edit.
    await db.asUser(owner, (c) =>
      c.query(
        "update public.restaurants set description = 'Updated' where id = $1;",
        [restaurantId],
      ),
    );
  });

  it("Starter costs $19 a month now", async () => {
    const { rows } = await db.admin.query<{ monthly_price_cents: number }>(
      "select monthly_price_cents from public.platform_plans where slug = 'starter';",
    );
    expect(rows[0].monthly_price_cents).toBe(1900);
  });
});
