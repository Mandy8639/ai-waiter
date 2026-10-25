// @vitest-environment node
//
// Square, phase 2 (20261110090000): diners pay through Square. The safety
// properties of card payments stay where they were; only the provider
// check changes, and Square settlement goes through its own service-role
// function.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { createCustomerSession, fullOrderFixture } from "./helpers";

type Fixture = Awaited<ReturnType<typeof fullOrderFixture>>;

interface TabRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  currency: string;
  stripe_account_id: string | null;
  order_count: number;
}

describe("Square card payments", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function acceptCard(restaurantId: string) {
    await db.admin.query(
      "update public.restaurant_settings set accept_card = true, tipping_enabled = true where restaurant_id = $1;",
      [restaurantId],
    );
  }

  /** Connected to Square with a location, payments switched on, no Stripe account at all. */
  async function squareRestaurant(f: Fixture, paymentsOn = true) {
    await acceptCard(f.restaurantId);
    await db.admin.query(
      `insert into public.restaurant_pos_integrations
         (restaurant_id, provider, external_location_id, is_enabled, payments_enabled)
       values ($1, 'square', 'LOC1', true, $2);`,
      [f.restaurantId, paymentsOn],
    );
    await db.admin.query(
      `insert into public.pos_credentials (restaurant_id, provider, merchant_id, access_token_enc)
       values ($1, 'square', 'M1', 'v1.a.b.c');`,
      [f.restaurantId],
    );
  }

  const provider = async (restaurantId: string) =>
    (
      await db.admin.query<{ p: string }>(
        "select public.restaurant_card_provider($1) as p;",
        [restaurantId],
      )
    ).rows[0].p;

  const startTab = (userId: string, tip = 0) =>
    db.asUser(userId, (c) =>
      c.query<TabRow>("select * from public.start_tab_payment($1);", [tip]),
    );

  it("is Stripe unless Square is connected, enabled, switched on and has a token", async () => {
    const f = await fullOrderFixture(db);
    expect(await provider(f.restaurantId)).toBe("stripe");
    await squareRestaurant(f, false);
    expect(await provider(f.restaurantId)).toBe("stripe");
    await db.admin.query(
      "update public.restaurant_pos_integrations set payments_enabled = true where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(await provider(f.restaurantId)).toBe("square");
    // Disconnected: the token is gone, so payments fall back.
    await db.admin.query(
      "delete from public.pos_credentials where restaurant_id = $1;",
      [f.restaurantId],
    );
    expect(await provider(f.restaurantId)).toBe("stripe");
  });

  it("can't switch payments on without an enabled connection", async () => {
    const f = await fullOrderFixture(db);
    await expect(
      db.admin.query(
        `insert into public.restaurant_pos_integrations (restaurant_id, provider, is_enabled, payments_enabled)
         values ($1, 'square', false, true);`,
        [f.restaurantId],
      ),
    ).rejects.toThrow(/payments_need_enabled/);
  });

  it("shows diners a card button with no Stripe account", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f);
    const { rows } = await db.asUser(f.customerUserId, (c) =>
      c.query<{ can_take_card: boolean }>(
        "select * from public.get_public_payment_settings($1);",
        [f.restaurantId],
      ),
    );
    expect(rows[0].can_take_card).toBe(true);
  });

  it("starts a tab payment priced from the orders, with no Stripe account", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f);
    const { rows } = await startTab(f.customerUserId, 2);
    expect(rows[0].stripe_account_id).toBeNull();
    expect(rows[0].order_count).toBe(1);
    expect(Number(rows[0].tip_amount)).toBe(2);
    const { rows: order } = await db.admin.query<{ total: string }>(
      "select total from public.orders where id = $1;",
      [f.orderId],
    );
    expect(Number(rows[0].amount)).toBe(Number(order[0].total));
  });

  it("still requires a Stripe account when Square payments are off", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f, false);
    await expect(startTab(f.customerUserId)).rejects.toThrow(
      /PAYMENT_ACCOUNT_NOT_READY/,
    );
  });

  it("gives the diner their itemised bill, and nobody else", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f);
    const { rows: tab } = await startTab(f.customerUserId);
    const lines = await db.asUser(f.customerUserId, (c) =>
      c.query<{
        item_name: string;
        quantity: number;
        unit_amount: string;
        line_total: string;
      }>("select * from public.payment_bill_lines($1);", [tab[0].payment_id]),
    );
    expect(lines.rows).toHaveLength(1);
    expect(lines.rows[0].quantity).toBe(1);
    expect(Number(lines.rows[0].unit_amount)).toBe(
      Number(lines.rows[0].line_total),
    );

    const stranger = await createCustomerSession(db, f.restaurantId, f.tableId);
    await expect(
      db.asUser(stranger.userId, (c) =>
        c.query("select * from public.payment_bill_lines($1);", [
          tab[0].payment_id,
        ]),
      ),
    ).rejects.toThrow(/PAYMENT_NOT_YOUR_ORDER/);
  });

  it("records the Square checkout once, for the payment's own diner", async () => {
    const f = await fullOrderFixture(db);
    await squareRestaurant(f);
    const { rows: tab } = await startTab(f.customerUserId);
    const attach = (userId: string, orderId: string) =>
      db.asUser(userId, (c) =>
        c.query("select public.attach_square_checkout($1, $2, $3);", [
          tab[0].payment_id,
          orderId,
          "https://square.link/u/abc",
        ]),
      );
    await attach(f.customerUserId, "SQ_ORDER_1");
    // Replaying the same checkout is fine; a different one is not.
    await attach(f.customerUserId, "SQ_ORDER_1");
    await expect(attach(f.customerUserId, "SQ_ORDER_2")).rejects.toThrow(
      /PAYMENT_NOT_PENDING/,
    );
    const stranger = await createCustomerSession(db, f.restaurantId, f.tableId);
    await expect(attach(stranger.userId, "SQ_ORDER_1")).rejects.toThrow(
      /PAYMENT_NOT_YOUR_ORDER/,
    );
  });

  describe("settlement", () => {
    async function pendingSquarePayment() {
      const f = await fullOrderFixture(db);
      await squareRestaurant(f);
      const { rows: tab } = await startTab(f.customerUserId, 1);
      const squareOrderId = `SQ_${crypto.randomUUID()}`;
      await db.asUser(f.customerUserId, (c) =>
        c.query("select public.attach_square_checkout($1, $2, $3);", [
          tab[0].payment_id,
          squareOrderId,
          "https://square.link/u/x",
        ]),
      );
      const totalMinor = Math.round(Number(tab[0].total_amount) * 100);
      return { f, payment: tab[0], squareOrderId, totalMinor };
    }

    const settle = (squareOrderId: string, minor: number, currency = "USD") =>
      db.admin
        .query<{ r: string }>(
          "select public.mark_square_payment_succeeded($1, $2, $3, $4) as r;",
          [squareOrderId, `PAY_${squareOrderId}`, minor, currency],
        )
        .then((r) => r.rows[0].r);

    it("settles a matching payment once, then reports a replay", async () => {
      const { payment, squareOrderId, totalMinor } =
        await pendingSquarePayment();
      expect(await settle(squareOrderId, totalMinor)).toBe("settled");
      expect(await settle(squareOrderId, totalMinor)).toBe("already");
      const { rows } = await db.admin.query<{
        status: string;
        paid_at: string | null;
      }>("select status, paid_at from public.order_payments where id = $1;", [
        payment.payment_id,
      ]);
      expect(rows[0].status).toBe("succeeded");
      expect(rows[0].paid_at).not.toBeNull();
    });

    it("refuses an amount or currency that doesn't match, and an unknown order", async () => {
      const { payment, squareOrderId, totalMinor } =
        await pendingSquarePayment();
      expect(await settle(squareOrderId, totalMinor - 1)).toBe("mismatch");
      expect(await settle(squareOrderId, totalMinor, "CAD")).toBe("mismatch");
      expect(await settle("SQ_NOPE", totalMinor)).toBe("unknown");
      const { rows } = await db.admin.query<{ status: string }>(
        "select status from public.order_payments where id = $1;",
        [payment.payment_id],
      );
      expect(rows[0].status).toBe("pending");
    });

    it("can't be called by a diner or an owner", async () => {
      const { f, squareOrderId, totalMinor } = await pendingSquarePayment();
      for (const userId of [f.customerUserId, f.staffUserId]) {
        await expect(
          db.asUser(userId, (c) =>
            c.query(
              "select public.mark_square_payment_succeeded($1, $2, $3, 'USD');",
              [squareOrderId, "PAY_X", totalMinor],
            ),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    });
  });
});
