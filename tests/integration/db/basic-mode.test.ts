// @vitest-environment node
//
// Basic mode, and Tableside is free
// (supabase/migrations/20261125090000_basic_mode.sql).
//
// A basic restaurant is a QR menu, the AI waiter and the kitchen: the
// diner orders, the server brings the bill as they always have. Every way
// of taking money must be closed, not just hidden, and a restaurant can't
// switch itself out of basic mode or out of being free.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, createRestaurant, fullOrderFixture } from "./helpers";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

async function setBasic(restaurantId: string, basic: boolean) {
  await db.admin.query(
    "update public.restaurants set basic_mode = $2 where id = $1;",
    [restaurantId, basic],
  );
}

/** Card payments switched on and a Stripe account that can charge. */
async function enableCardPayments(restaurantId: string) {
  await db.admin.query(
    "update public.restaurant_settings set accept_card = true where restaurant_id = $1;",
    [restaurantId],
  );
  await db.admin.query(
    `insert into public.restaurant_payment_accounts
       (restaurant_id, stripe_account_id, charges_enabled)
     values ($1, $2, true);`,
    [restaurantId, `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`],
  );
}

async function canTakeCard(restaurantId: string): Promise<boolean> {
  const { rows } = await db.admin.query<{ can_take_card: boolean }>(
    "select can_take_card from public.get_public_payment_settings($1);",
    [restaurantId],
  );
  return rows[0].can_take_card;
}

function insertPayment(restaurantId: string, method: string) {
  return db.admin.query(
    `insert into public.order_payments
       (restaurant_id, method, amount, currency, status)
     values ($1, $2, 0, 'USD', 'pending');`,
    [restaurantId, method],
  );
}

describe("basic mode", () => {
  it("is how every new restaurant starts, free", async () => {
    const owner = await db.createAuthUser();
    const { rows } = await db.asUser(owner, (c) =>
      c.query<{ id: string }>(
        "select id from public.create_restaurant('Saffron Basic', $1);",
        [`saffron-basic-${Date.now()}`],
      ),
    );
    const restaurantId = rows[0].id;
    const { rows: flags } = await db.admin.query<{
      basic_mode: boolean;
      billing_exempt: boolean;
      fee: number;
      billing_ok: boolean;
    }>(
      `select r.basic_mode, r.billing_exempt,
              public.platform_fee_minor_units(r.id, 10000) as fee,
              public.restaurant_billing_ok(r.id) as billing_ok
       from public.restaurants r where r.id = $1;`,
      [restaurantId],
    );
    expect(flags[0]).toEqual({
      basic_mode: true,
      billing_exempt: true,
      fee: 0,
      billing_ok: true,
    });
  });

  it("shows diners no way to pay, even with card payments set up", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(f.restaurantId);
    expect(await canTakeCard(f.restaurantId)).toBe(true);

    await setBasic(f.restaurantId, true);
    expect(await canTakeCard(f.restaurantId)).toBe(false);
  });

  it("refuses every payment, whatever the method, but still records a comp", async () => {
    const f = await fullOrderFixture(db);
    await setBasic(f.restaurantId, true);

    for (const method of ["card", "cash", "card_terminal"]) {
      await expect(insertPayment(f.restaurantId, method)).rejects.toThrow(
        /PAYMENTS_OFF/,
      );
    }
    await insertPayment(f.restaurantId, "comp");
  });

  it("refuses the diner's own card payment through the real start function", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(f.restaurantId);
    await setBasic(f.restaurantId, true);

    await expect(
      db.asUser(f.customerUserId, (c) =>
        c.query("select * from public.start_order_payment($1, 0);", [
          f.orderId,
        ]),
      ),
    ).rejects.toThrow(/PAYMENTS_OFF|CARD/);
  });

  it("still takes orders", async () => {
    const restaurantId = await createRestaurant(db, { basicMode: true });
    const { rows } = await db.admin.query<{ accepting_orders: boolean }>(
      "select accepting_orders from public.get_public_order_settings($1);",
      [restaurantId],
    );
    expect(rows[0].accepting_orders).toBe(true);
  });

  it("can't be switched off, or billing switched on, by the restaurant itself", async () => {
    const restaurantId = await createRestaurant(db, { basicMode: true });
    const owner = await db.createAuthUser();
    await addMember(db, restaurantId, owner, "owner");

    for (const sql of [
      "update public.restaurants set basic_mode = false where id = $1;",
      "update public.restaurants set billing_exempt = not billing_exempt where id = $1;",
    ]) {
      await expect(
        db.asUser(owner, (c) => c.query(sql, [restaurantId])),
      ).rejects.toThrow(/RESTAURANT_BILLING_COLUMNS_READ_ONLY/);
    }
  });
});
