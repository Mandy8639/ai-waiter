// @vitest-environment node
//
// Tap to Pay (20261105090000): staff take a card-present payment in the
// staff app. Only the server, after reading the PaymentIntent from Stripe,
// may settle it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./setup";
import { addMember, fullOrderFixture, transitionOrderStatus } from "./helpers";

async function enableCardPayments(db: TestDb, restaurantId: string) {
  await db.admin.query(
    `update public.restaurant_settings
     set accept_card = true, tipping_enabled = true where restaurant_id = $1;`,
    [restaurantId],
  );
  await db.admin.query(
    `insert into public.restaurant_payment_accounts
       (restaurant_id, stripe_account_id, charges_enabled)
     values ($1, $2, true)
     on conflict (restaurant_id) do update set charges_enabled = true;`,
    [restaurantId, `acct_${restaurantId.replace(/-/g, "").slice(0, 16)}`],
  );
}

interface StartRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  stripe_account_id: string;
  terminal_location_id: string | null;
}

describe("Tap to Pay", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const start = (userId: string, orderIds: string[], tip = 0) =>
    db.asUser(userId, (c) =>
      c.query<StartRow>(
        "select * from public.start_tap_to_pay_payment($1::uuid[], $2);",
        [orderIds, tip],
      ),
    );
  const attach = (userId: string, paymentId: string, pi: string) =>
    db.asUser(userId, (c) =>
      c.query("select public.attach_tap_to_pay_intent($1, $2);", [
        paymentId,
        pi,
      ]),
    );
  const payment = async (id: string) =>
    (
      await db.admin.query<{
        status: string;
        method: string;
        card_present: boolean;
        recorded_by: string;
        paid_at: string | null;
      }>(
        "select status, method, card_present, recorded_by, paid_at from public.order_payments where id = $1;",
        [id],
      )
    ).rows[0];

  it("opens a pending card-present payment taken by the member, for the order's total plus tip", async () => {
    const f = await fullOrderFixture(db, "staff");
    await enableCardPayments(db, f.restaurantId);
    const { rows } = await start(f.staffUserId, [f.orderId], 2);
    expect(Number(rows[0].tip_amount)).toBe(2);
    expect(Number(rows[0].total_amount)).toBe(Number(rows[0].amount) + 2);
    expect(rows[0].stripe_account_id).toMatch(/^acct_/);
    expect(await payment(rows[0].payment_id)).toMatchObject({
      status: "pending",
      method: "card",
      card_present: true,
      recorded_by: f.staffUserId,
    });
  });

  it("settles only through the server's Stripe-confirmed call, idempotently", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const { rows } = await start(f.staffUserId, [f.orderId]);
    await attach(f.staffUserId, rows[0].payment_id, "pi_test123");

    // A member can't mark it paid themselves.
    await expect(
      db.asUser(f.staffUserId, (c) =>
        c.query("select public.mark_tap_to_pay_succeeded('pi_test123');"),
      ),
    ).rejects.toThrow();

    const settle = () =>
      db.admin.query<{ ok: boolean }>(
        "select public.mark_tap_to_pay_succeeded('pi_test123') as ok;",
      );
    expect((await settle()).rows[0].ok).toBe(true);
    expect((await settle()).rows[0].ok).toBe(true);
    const settled = await payment(rows[0].payment_id);
    expect(settled.status).toBe("succeeded");
    expect(settled.paid_at).not.toBeNull();

    // And the order can't be paid again.
    await expect(start(f.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_ALREADY_PAID/,
    );
    // An unknown intent is not an error (another integration's payment).
    const { rows: unknown } = await db.admin.query<{ ok: boolean }>(
      "select public.mark_tap_to_pay_succeeded('pi_unknown') as ok;",
    );
    expect(unknown[0].ok).toBe(false);
  });

  it("closes an earlier unfinished tap for the same orders when tapping again", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const first = (await start(f.staffUserId, [f.orderId])).rows[0];
    const second = (await start(f.staffUserId, [f.orderId])).rows[0];
    expect((await payment(first.payment_id)).status).toBe("cancelled");
    expect((await payment(second.payment_id)).status).toBe("pending");
  });

  it("lets the member cancel a pending tap, never a settled one", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const p = (await start(f.staffUserId, [f.orderId])).rows[0];
    const cancel = () =>
      db.asUser(f.staffUserId, (c) =>
        c.query<{ ok: boolean }>(
          "select public.cancel_tap_to_pay_payment($1) as ok;",
          [p.payment_id],
        ),
      );
    expect((await cancel()).rows[0].ok).toBe(true);
    expect((await payment(p.payment_id)).status).toBe("cancelled");
  });

  it("refuses outsiders, card switched off, an account that can't charge, and cancelled orders", async () => {
    const f = await fullOrderFixture(db);
    // Card not accepted yet.
    await expect(start(f.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_CARD_NOT_ACCEPTED/,
    );
    await enableCardPayments(db, f.restaurantId);
    // The diner and another restaurant's member are not members here.
    await expect(start(f.customerUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );
    const other = await fullOrderFixture(db);
    await expect(start(other.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_FORBIDDEN/,
    );
    // Stripe account switched off.
    await db.admin.query(
      "update public.restaurant_payment_accounts set charges_enabled = false where restaurant_id = $1;",
      [f.restaurantId],
    );
    await expect(start(f.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_ACCOUNT_NOT_READY/,
    );
    await enableCardPayments(db, f.restaurantId);
    await transitionOrderStatus(db, f.staffUserId, f.orderId, "cancelled");
    await expect(start(f.staffUserId, [f.orderId])).rejects.toThrow(
      /PAYMENT_ORDER_CANCELLED/,
    );
  });

  it("only attaches a real PaymentIntent id, once, to a pending tap", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const p = (await start(f.staffUserId, [f.orderId])).rows[0];
    await expect(
      attach(f.staffUserId, p.payment_id, "not-an-id"),
    ).rejects.toThrow(/PAYMENT_BAD_INTENT/);
    await attach(f.staffUserId, p.payment_id, "pi_abc");
    await expect(attach(f.staffUserId, p.payment_id, "pi_def")).rejects.toThrow(
      /PAYMENT_NOT_PENDING/,
    );
  });

  it("stores the restaurant's Terminal location, server-only", async () => {
    const f = await fullOrderFixture(db);
    await enableCardPayments(db, f.restaurantId);
    const staff = await db.createAuthUser();
    await addMember(db, f.restaurantId, staff, "owner");
    await expect(
      db.asUser(staff, (c) =>
        c.query("select public.set_terminal_location($1, 'tml_abc');", [
          f.restaurantId,
        ]),
      ),
    ).rejects.toThrow();
    await db.admin.query(
      "select public.set_terminal_location($1, 'tml_abc');",
      [f.restaurantId],
    );
    const p = (await start(f.staffUserId, [f.orderId])).rows[0];
    expect(p.terminal_location_id).toBe("tml_abc");
  });
});
